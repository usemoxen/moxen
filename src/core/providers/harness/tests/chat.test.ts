import { describe, expect, it } from "vitest";

import { DEFAULT_QUIRKS } from "../quirks.js";
import { ChatHttpError, ThinkTagSplitter, chatRequestBody, streamChat, type ChatRequest } from "../transport/chat.js";
import type { ModelEvent } from "../types.js";

/** An SSE response whose bytes are cut at the given offsets, to prove nothing depends on chunk boundaries. */
function sseResponse(events: readonly unknown[], cuts: readonly number[] = [], status = 200): Response {
  const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    parts.push(bytes.slice(from, cut));
    from = cut;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const request = (response: Response | (() => Response), overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  baseUrl: "http://localhost:8080",
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  quirks: DEFAULT_QUIRKS,
  fetch: (async () => (typeof response === "function" ? response() : response)) as unknown as typeof fetch,
  ...overrides,
});

async function collect(req: ChatRequest): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of streamChat(req)) out.push(event);
  return out;
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

describe("streamChat", () => {
  it("reads reasoning, text, a tool call whose arguments arrive in pieces, and usage, whatever the chunk boundaries", async () => {
    const events = [
      delta({ reasoning_content: "think " }),
      delta({ reasoning_content: "more" }),
      delta({ content: "Reading " }),
      delta({ content: "it.", tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"file_' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'path":"/x"}' } }] }, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
      "[DONE]",
    ];
    const whole = await collect(request(sseResponse(events)));
    const cut = await collect(request(sseResponse(events, [7, 90, 333, 640])));
    expect(cut).toEqual(whole);
    expect(whole).toEqual([
      { type: "reasoning.delta", text: "think " },
      { type: "reasoning.delta", text: "more" },
      { type: "text.delta", text: "Reading " },
      { type: "text.delta", text: "it." },
      { type: "tool.call", call: { id: "call_a", name: "read", arguments: '{"file_path":"/x"}' } },
      { type: "usage", usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: 0 } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("finishes as tool-calls when the server says stop but calls were made, and gives an unnamed id a generated one", async () => {
    const events = [delta({ tool_calls: [{ index: 0, function: { name: "bash", arguments: "" } }] }, "stop")];
    const out = await collect(request(sseResponse(events)));
    const call = out.find((event) => event.type === "tool.call");
    expect(call).toMatchObject({ call: { name: "bash", arguments: "{}" } });
    expect(call?.type === "tool.call" && call.call.id.startsWith("call_")).toBe(true);
    expect(out.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  it("reads llama.cpp's cache hit from timings and the alternate reasoning field names", async () => {
    const events = [
      delta({ reasoning: "r" }),
      delta({ content: "ok" }, "length"),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, timings: { cache_n: 8 } },
    ];
    const out = await collect(request(sseResponse(events)));
    expect(out).toContainEqual({ type: "reasoning.delta", text: "r" });
    expect(out).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, reasoningTokens: 0 } });
    expect(out.at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  it("classifies a too-long prompt as context overflow and a 503 as retryable", async () => {
    const overflow = new Response(JSON.stringify({ error: { message: "request (300000 tokens) exceeds the available context size (262144 tokens)" } }), { status: 400 });
    await expect(collect(request(overflow))).rejects.toMatchObject({ contextOverflow: true, retryable: false, status: 400 });
    const down = new Response("busy", { status: 503 });
    await expect(collect(request(down))).rejects.toMatchObject({ contextOverflow: false, retryable: true, status: 503 });
    await expect(collect(request(() => { throw new Error("ECONNRESET"); }))).rejects.toBeInstanceOf(ChatHttpError);
  });

  it("sends the key only as a bearer header and never in the body", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const fetchSpy = (async (_url: string, init: RequestInit) => {
      seen = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return sseResponse([delta({ content: "x" }, "stop")]);
    }) as unknown as typeof fetch;
    await collect(request(sseResponse([]), { apiKey: "secret-key", fetch: fetchSpy }));
    expect(seen!.headers.authorization).toBe("Bearer secret-key");
    expect(seen!.body).not.toContain("secret-key");
  });
});

describe("chatRequestBody", () => {
  it("passes sampling and template kwargs, and puts the effort where the server takes it", () => {
    const body = chatRequestBody({
      ...request(sseResponse([])),
      tools: [{ name: "read", description: "d", parameters: { type: "object" } }],
      sampling: { temperature: 1, topP: 0.95, topK: 20 },
      effort: "xhigh",
      quirks: { ...DEFAULT_QUIRKS, chatTemplateKwargs: { preserve_thinking: true }, effortKwarg: "reasoning_effort" },
    });
    expect(body).toMatchObject({
      stream: true,
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      tool_choice: "auto",
      chat_template_kwargs: { preserve_thinking: true, reasoning_effort: "xhigh" },
    });
    const qwen4Body = chatRequestBody({
      ...request(sseResponse([])),
      model: "qwen4-max-preview",
      effort: "xhigh",
      quirks: { ...DEFAULT_QUIRKS, effortParam: "reasoning_effort", images: "native" },
    });
    expect(qwen4Body.reasoning_effort).toBe("xhigh");
    expect(qwen4Body).not.toHaveProperty("chat_template_kwargs");
  });

  it("omits tool_choice for a server that rejects it", () => {
    const body = chatRequestBody({
      ...request(sseResponse([])),
      tools: [{ name: "read", description: "d", parameters: { type: "object" } }],
      quirks: { ...DEFAULT_QUIRKS, omitToolChoice: true },
    });
    expect(body).not.toHaveProperty("tool_choice");
  });
});

describe("ThinkTagSplitter", () => {
  it("separates think tags from text even when a tag is split across chunks", () => {
    const splitter = new ThinkTagSplitter();
    const pieces = [...splitter.push("Hello <thi"), ...splitter.push("nk>plan</th"), ...splitter.push("ink> done"), ...splitter.flush()];
    const join = (kind: string) => pieces.filter((piece) => piece.kind === kind).map((piece) => piece.text).join("");
    expect(join("text")).toBe("Hello  done");
    expect(join("reasoning")).toBe("plan");
  });

  it("does not hold back text that merely looks like a tag start once the stream ends", () => {
    const splitter = new ThinkTagSplitter();
    const pieces = [...splitter.push("a < b"), ...splitter.flush()];
    expect(pieces.map((piece) => piece.text).join("")).toBe("a < b");
  });
});

import { describe, expect, it } from "vitest";

import { buildAnthropicInput, portableToolId } from "../normalize-anthropic.js";
import { DEFAULT_QUIRKS, resolveQuirks, type ModelQuirks } from "../quirks.js";
import { anthropicRequestBody, streamAnthropic } from "../transport/anthropic.js";
import { ChatHttpError, type ChatRequest } from "../transport/chat.js";
import type { ModelEvent, ReasoningItem, TranscriptMessage } from "../types.js";

const quirks = (overrides: Partial<ModelQuirks> = {}): ModelQuirks => ({ ...DEFAULT_QUIRKS, images: "native", ...overrides });
const call = (id: string, name = "read", args = '{"file_path":"/a"}') => ({ id, name, arguments: args });
const signed: ReasoningItem = { format: "anthropic", item: { type: "thinking", thinking: "hmm", signature: "SIG" } };

function sse(events: ReadonlyArray<Record<string, unknown>>, status = 200): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

const request = (fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>, overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-secret",
  model: "claude-opus-5-5",
  messages: [],
  transcript: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
  format: "anthropic",
  tools: [],
  quirks: quirks(),
  fetch: (async (url: string, init: RequestInit) => await fetchImpl(url, init)) as unknown as typeof fetch,
  ...overrides,
});

async function collect(req: ChatRequest): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of streamAnthropic(req)) out.push(event);
  return out;
}

describe("buildAnthropicInput", () => {
  it("puts the system prompt apart, a round's tool results together in one user message, and later system text in the user turn", () => {
    const transcript: TranscriptMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "go" },
      { role: "assistant", content: "Looking.", toolCalls: [call("a"), call("b")] },
      { role: "tool", toolCallId: "a", name: "read", content: "one" },
      { role: "tool", toolCallId: "b", name: "read", content: "two", isError: true },
      { role: "system", content: "A background command ended." },
    ];
    const { system, messages } = buildAnthropicInput(transcript, quirks());
    expect(system).toBe("SYS");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "a", name: "read", input: { file_path: "/a" } },
      { type: "tool_use", id: "b", name: "read", input: { file_path: "/a" } },
    ]);
    // Results first, the reminder after them.
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "one" },
      { type: "tool_result", tool_use_id: "b", content: "two", is_error: true },
      { type: "text", text: "<system-reminder>\nA background command ended.\n</system-reminder>" },
    ]);
  });

  it("replays signed thinking first and only when allowed and from this format, and leaves out an assistant turn with nothing to say", () => {
    const foreign: ReasoningItem = { format: "responses", item: { type: "reasoning" } };
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", reasoningItems: [signed, foreign], toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read", content: "x" },
      { role: "assistant", content: "  " },
      { role: "user", content: "next" },
    ];
    const replayed = buildAnthropicInput(transcript, quirks()).messages;
    expect(replayed[1]!.content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "SIG" });
    expect(replayed[1]!.content).toHaveLength(3);
    // The empty assistant turn is gone and the user turns around it are one.
    expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(replayed[2]!.content.map((block) => block.type)).toEqual(["tool_result", "text"]);
    expect(buildAnthropicInput(transcript, quirks({ reasoningReplay: "none" })).messages[1]!.content.map((block) => block.type)).toEqual(["text", "tool_use"]);
    expect(buildAnthropicInput(transcript, quirks(), { replayReasoning: false }).messages[1]!.content.map((block) => block.type)).toEqual(["text", "tool_use"]);
  });

  it("sends pictures before the text, inside a tool result when a tool returned one, and names them when the model cannot see", () => {
    const picture = { name: "a.png", mimeType: "image/png", data: "AAAA" };
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "look", images: [picture] },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read", content: "an image", images: [picture] },
    ];
    const native = buildAnthropicInput(transcript, quirks()).messages;
    expect(native[0]!.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "look" }]);
    expect(native[2]!.content[0]).toMatchObject({ type: "tool_result", content: [{ type: "text", text: "an image" }, { type: "image" }] });
    const blind = buildAnthropicInput(transcript, quirks({ images: "none" })).messages;
    expect(blind[0]!.content).toEqual([{ type: "text", text: "look\n\n[Attached image: a.png]" }]);
    expect(blind[2]!.content[0]).toMatchObject({ content: "an image\n[Image not sent: a.png]" });
  });

  it("gives a call and its result the same id, one the API accepts", () => {
    expect(portableToolId("call_1-ok")).toBe("call_1-ok");
    const odd = portableToolId("call:1/with spaces");
    expect(odd).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(portableToolId("call:1/with spaces")).toBe(odd);
    const { messages } = buildAnthropicInput([{ role: "user", content: "x" }, { role: "assistant", content: "", toolCalls: [call("call:1/with spaces")] }, { role: "tool", toolCallId: "call:1/with spaces", name: "read", content: "r" }], quirks());
    expect(messages[1]!.content[0]!.id).toBe(odd);
    expect(messages[2]!.content[0]!.tool_use_id).toBe(odd);
  });
});

describe("anthropicRequestBody", () => {
  const tools = [{ name: "read", description: "Reads.", parameters: { type: "object", properties: {} } }];

  it("asks for adaptive thinking with the chosen effort, caching, and tools in the API's shape, and no sampling the user did not set", () => {
    const body = anthropicRequestBody(request(() => sse([]), { tools, effort: "high", maxTokens: 4000 }));
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      stream: true,
      system: "SYS",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      tools: [{ name: "read", description: "Reads.", input_schema: { type: "object", properties: {} } }],
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("falls back to a token budget for older models, to nothing when told, and drops caching for a proxy that rejects it", () => {
    const budget = anthropicRequestBody(request(() => sse([]), { quirks: quirks({ anthropicThinking: "budget", cacheControl: false }), effort: "low", maxTokens: 8000 }));
    expect(budget.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(budget).not.toHaveProperty("output_config");
    expect(budget).not.toHaveProperty("cache_control");
    expect(anthropicRequestBody(request(() => sse([]), { quirks: quirks({ anthropicThinking: "budget" }), maxTokens: 2000, effort: "max" })).thinking).toEqual({ type: "enabled", budget_tokens: 1999 });
    expect(anthropicRequestBody(request(() => sse([]), { quirks: quirks({ anthropicThinking: "off" }) }))).not.toHaveProperty("thinking");
  });

  it("omits Claude's adaptive thinking object for non-Claude model families on Anthropic gateways while still passing output_config.effort", () => {
    const qwenBody = anthropicRequestBody(request(() => sse([]), { model: "qwen4-max-preview", effort: "xhigh", maxTokens: 8000 }));
    expect(qwenBody).not.toHaveProperty("thinking");
    expect(qwenBody.output_config).toEqual({ effort: "xhigh" });
  });

  it("forbids tool calls for compaction without dropping the tool list, honours one-at-a-time, and leaves tool_choice out when the server rejects it", () => {
    expect(anthropicRequestBody(request(() => sse([]), { tools, toolChoice: "none" })).tool_choice).toEqual({ type: "none" });
    expect(anthropicRequestBody(request(() => sse([]), { tools, quirks: quirks({ parallelToolCalls: false }) })).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(anthropicRequestBody(request(() => sse([]), { tools, toolChoice: "none", quirks: quirks({ omitToolChoice: true }) }))).not.toHaveProperty("tool_choice");
  });

  it("treats a Claude model as vision-capable by default, whatever a proxy calls it", () => {
    expect(resolveQuirks({ modelId: "claude-sonnet-5-5" }).images).toBe("native");
    expect(resolveQuirks({ modelId: "my-proxy-model", family: "claude" }).images).toBe("native");
    expect(resolveQuirks({ modelId: "claude-sonnet-5-5", vision: false }).images).toBe("none");
  });
});

describe("streamAnthropic", () => {
  const stream = [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 1 } } },
    { type: "ping" },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "see." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'path":"/x"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "redacted_thinking", data: "ENC" } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ];

  it("reduces content blocks to reasoning (kept signed for replay), text, a tool call whose JSON arrives in pieces, usage with the cache split out, and the finish", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const events = await collect(
      request((url, init) => {
        seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return sse(stream);
      }),
    );
    expect(events).toEqual([
      { type: "reasoning.delta", text: "Let me " },
      { type: "reasoning.delta", text: "see." },
      { type: "reasoning.item", item: { format: "anthropic", item: { type: "thinking", thinking: "Let me see.", signature: "SIG" } } },
      { type: "text.delta", text: "Reading." },
      { type: "tool.call", call: { id: "toolu_1", name: "read", arguments: '{"file_path":"/x"}' } },
      { type: "reasoning.item", item: { format: "anthropic", item: { type: "redacted_thinking", data: "ENC" } } },
      { type: "usage", usage: { inputTokens: 95, outputTokens: 42, cachedInputTokens: 80, reasoningTokens: 0 } },
      { type: "finish", reason: "tool-calls" },
    ]);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers).toMatchObject({ "x-api-key": "sk-ant-secret", "anthropic-version": "2023-06-01" });
    expect(seen[0]!.headers).not.toHaveProperty("authorization");
  });

  it("maps the stop reasons, and reports a refusal as a filtered answer", async () => {
    const reply = (reason: string) => [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
    const finish = async (reason: string) => (await collect(request(() => sse(reply(reason))))).at(-1);
    expect(await finish("end_turn")).toEqual({ type: "finish", reason: "stop" });
    expect(await finish("max_tokens")).toEqual({ type: "finish", reason: "length" });
    expect(await finish("refusal")).toEqual({ type: "finish", reason: "filter" });
  });

  it("classifies HTTP failures and mid-stream errors for the loop, without the key or the address in the message", async () => {
    const overflow = collect(request(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }), { status: 400 })));
    await expect(overflow).rejects.toMatchObject({ status: 400, contextOverflow: true, retryable: false });
    await expect(collect(request(() => new Response("{}", { status: 529 })))).rejects.toMatchObject({ retryable: true });
    const overloaded = collect(request(() => sse([{ type: "message_start", message: { usage: {} } }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])));
    await expect(overloaded).rejects.toMatchObject({ retryable: true, message: "Overloaded" });
    await expect(collect(request(() => sse([{ type: "message_start", message: { usage: {} } }])))).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("before the reply was complete") });
    const unreachable = await collect(request(() => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1")))).catch((error: unknown) => error as ChatHttpError);
    expect(unreachable).toBeInstanceOf(ChatHttpError);
    for (const text of [(unreachable as Error).message]) {
      expect(text).not.toContain("sk-ant-secret");
      expect(text).not.toContain("api.anthropic.com");
    }
  });

  it("sends the conversation again without the signed thinking when the server refuses it, and only then", async () => {
    const transcript: TranscriptMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "ok", reasoningItems: [signed] }, { role: "user", content: "more" }];
    const bodies: Array<{ messages: Array<{ content: Array<{ type: string }> }> }> = [];
    const answers = [new Response(JSON.stringify({ error: { message: "messages.1.content.0: Invalid `signature` in `thinking` block" } }), { status: 400 }), sse([{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }])];
    const events = await collect(
      request(
        (_url, init) => {
          bodies.push(JSON.parse(String(init.body)) as (typeof bodies)[number]);
          return answers.shift()!;
        },
        { transcript },
      ),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.messages[1]!.content[0]!.type).toBe("thinking");
    expect(bodies[1]!.messages[1]!.content.map((block) => block.type)).toEqual(["text"]);
    // Some other 400 is not retried.
    await expect(collect(request(() => new Response(JSON.stringify({ error: { message: "max_tokens too large" } }), { status: 400 }), { transcript }))).rejects.toThrow(/max_tokens/);
  });

  it("retries without adaptive thinking when an Anthropic-compatible gateway rejects thinking.type adaptive", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const answers = [
      new Response(JSON.stringify({ error: { message: "thinking.type: Input should be 'enabled' or 'disabled'" } }), { status: 400 }),
      sse([{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]),
    ];
    const events = await collect(
      request(
        (_url, init) => {
          bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return answers.shift()!;
        },
        { model: "auto", effort: "high" },
      ),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(bodies[1]).not.toHaveProperty("thinking");
    expect(bodies[1]!.output_config).toEqual({ effort: "high" });
  });
});

import { describe, expect, it, vi } from "vitest";

import { buildResponsesInput } from "../normalize-responses.js";
import { DEFAULT_QUIRKS, type ModelQuirks } from "../quirks.js";
import type { ChatRequest } from "../transport/chat.js";
import { responsesRequestBody, streamResponses } from "../transport/responses.js";
import { ResponsesWsSession, responsesWsUrl, type ResponsesSocket } from "../transport/responses-ws.js";
import type { ModelEvent, ReasoningItem, TranscriptMessage } from "../types.js";

const quirks = (overrides: Partial<ModelQuirks> = {}): ModelQuirks => ({ ...DEFAULT_QUIRKS, images: "native", ...overrides });
const call = (id: string, name = "read", args = '{"file_path":"/a"}') => ({ id, name, arguments: args });
const sealed: ReasoningItem = { format: "responses", item: { type: "reasoning", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" } };

// Wire tests only need the IHDR dimensions; OpenAI does the decode and resize.
function pngHeader(width: number, height: number) {
  const header = Buffer.from("89504e470d0a1a0a0000000d494844520000000000000000", "hex");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return { name: "screenshot.png", mimeType: "image/png", data: header.toString("base64") };
}

function sse(events: ReadonlyArray<Record<string, unknown>>, status = 200): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

const request = (fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>, overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-secret",
  model: "gpt-x",
  messages: [],
  transcript: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
  format: "responses",
  tools: [],
  quirks: quirks(),
  fetch: (async (url: string, init: RequestInit) => await fetchImpl(url, init)) as unknown as typeof fetch,
  ...overrides,
});

async function collect(req: ChatRequest): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of streamResponses(req)) out.push(event);
  return out;
}

describe("buildResponsesInput", () => {
  it("builds items with no server-side ids: calls and results by call_id, reasoning replayed sealed", () => {
    const transcript: TranscriptMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "go" },
      { role: "assistant", content: "Looking.", reasoningItems: [sealed, { format: "anthropic", item: { type: "thinking" } }], toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read", content: "one" },
      { role: "system", content: "Reminder." },
    ];
    const { instructions, input } = buildResponsesInput(transcript, quirks());
    expect(instructions).toBe("SYS");
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" },
      { role: "assistant", content: "Looking." },
      { type: "function_call", call_id: "a", name: "read", arguments: '{"file_path":"/a"}' },
      { type: "function_call_output", call_id: "a", output: "one" },
      { role: "user", content: [{ type: "input_text", text: "<system-reminder>\nReminder.\n</system-reminder>" }] },
    ]);
    expect(buildResponsesInput(transcript, quirks({ reasoningReplay: "none" })).input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("sends pictures as input_image parts, in a tool result when a tool returned one, and names them for a model that cannot see", () => {
    const picture = { name: "a.png", mimeType: "image/png", data: "AAAA" };
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "look", images: [picture] },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read", content: "img", images: [picture] },
    ];
    const native = buildResponsesInput(transcript, quirks()).input;
    expect(native[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] });
    expect(native[2]).toMatchObject({ type: "function_call_output", output: [{ type: "input_text", text: "img" }, { type: "input_image" }] });
    const blind = buildResponsesInput(transcript, quirks({ images: "none" })).input;
    expect(blind[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "look\n\n[Attached image: a.png]" }] });
    expect(blind[2]).toMatchObject({ output: "img\n[Image not sent: a.png]" });
  });
});

describe("responsesRequestBody", () => {
  it("requests high detail for ChatGPT images above 30,000 patches, keeping in-limit images and other profiles unchanged", () => {
    // 175 × 209 patches reproduces the provider's 36,575-patch rejection.
    const oversized = pngHeader(5600, 6688);
    const atLimit = pngHeader(4800, 6400);
    const imagePart = (image: typeof oversized) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` });
    const transcript: TranscriptMessage[] = [{ role: "user", content: "compare", images: [oversized, atLimit] }];
    const req = request(() => sse([]), { model: "gpt-6.2-sol", transcript });
    const input = (chatgptOAuth: boolean) => responsesRequestBody({ ...req, quirks: quirks({ chatgptOAuth }) }).input;
    expect(input(true)).toEqual([{ role: "user", content: [
      { type: "input_text", text: "compare" }, { ...imagePart(oversized), detail: "high" }, imagePart(atLimit),
    ] }]);
    expect(input(false)).toEqual([{ role: "user", content: [
      { type: "input_text", text: "compare" }, imagePart(oversized), imagePart(atLimit),
    ] }]);
  });

  const tools = [{ name: "read", description: "Reads.", parameters: { type: "object", properties: {} } }];

  it("keeps nothing on the server, asks for the reasoning back sealed, and forbids tool calls without dropping the tool list", () => {
    const body = responsesRequestBody(request(() => sse([]), { tools, toolChoice: "none", effort: "high", maxTokens: 900 }));
    expect(body).toMatchObject({
      model: "gpt-x",
      stream: true,
      store: false,
      instructions: "SYS",
      max_output_tokens: 900,
      tool_choice: "none",
      reasoning: { summary: "auto", effort: "high" },
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "read", description: "Reads.", parameters: { type: "object", properties: {} }, strict: false }],
    });
  });

  it("leaves reasoning settings out for a model that is not a reasoning model, and the sealed replay out when replay is off", () => {
    expect(responsesRequestBody(request(() => sse([]), { quirks: quirks({ sendReasoning: false }) }))).not.toHaveProperty("reasoning");
    expect(responsesRequestBody(request(() => sse([]), { quirks: quirks({ reasoningReplay: "none" }) }))).not.toHaveProperty("include");
    expect(responsesRequestBody(request(() => sse([]), { quirks: quirks({ parallelToolCalls: false, omitToolChoice: true }), tools }))).toMatchObject({ parallel_tool_calls: false });
  });

  it("places static system prompt in a leading developer message for GPT-6.2+ and ChatGPT OAuth, and forwards prompt_cache_key", () => {
    const gpt62 = responsesRequestBody(
      request(() => sse([]), { model: "gpt-6.2-sol", promptCacheKey: "sess-123" }),
    );
    expect(gpt62.instructions).toBeUndefined();
    expect(gpt62.prompt_cache_key).toBe("sess-123");
    expect(gpt62.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "SYS" }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);

    const oauth = responsesRequestBody(
      request(() => sse([]), { model: "gpt-6.1-sol", quirks: quirks({ chatgptOAuth: true }), promptCacheKey: "sess-456" }),
    );
    expect(oauth.instructions).toBeUndefined();
    expect(oauth.prompt_cache_key).toBe("sess-456");
    expect((oauth.input as Array<{ role?: string }>)[0]?.role).toBe("developer");
  });
});

describe("streamResponses", () => {
  const completed = (extra: Record<string, unknown> = {}) => ({
    type: "response.completed",
    response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } }, ...extra },
  });

  it("reduces the event stream to reasoning, text, a finished function call, the sealed reasoning item without its id, usage, and the finish", async () => {
    const urls: string[] = [];
    const events = await collect(
      request((url) => {
        urls.push(url);
        return sse([
          { type: "response.created", response: {} },
          { type: "response.reasoning_summary_part.added", item_id: "rs_1" },
          { type: "response.reasoning_summary_text.delta", delta: "First." },
          { type: "response.reasoning_summary_part.added", item_id: "rs_1" },
          { type: "response.reasoning_summary_text.delta", delta: "Second." },
          { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", status: "completed", summary: [{ type: "summary_text", text: "First." }], encrypted_content: "ENC" } },
          { type: "response.output_text.delta", delta: "Reading " },
          { type: "response.output_text.delta", delta: "it." },
          { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"file_path":' },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"/x"}' },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
          completed(),
        ]);
      }),
    );
    expect(urls[0]).toBe("https://api.openai.com/v1/responses");
    expect(events).toEqual([
      { type: "reasoning.delta", text: "First." },
      { type: "reasoning.delta", text: "\n\n" },
      { type: "reasoning.delta", text: "Second." },
      { type: "reasoning.item", item: { format: "responses", item: { type: "reasoning", summary: [{ type: "summary_text", text: "First." }], encrypted_content: "ENC" } } },
      { type: "text.delta", text: "Reading " },
      { type: "text.delta", text: "it." },
      { type: "tool.call", call: { id: "call_1", name: "read", arguments: '{"file_path":"/x"}' } },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, reasoningTokens: 12 } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("maps an incomplete response to its reason, and a failure to an error the loop can read", async () => {
    const incomplete = await collect(request(() => sse([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])));
    expect(incomplete.at(-1)).toEqual({ type: "finish", reason: "length" });
    const failed = collect(request(() => sse([{ type: "response.failed", response: { error: { message: "context_length_exceeded: too long" } } }])));
    await expect(failed).rejects.toMatchObject({ contextOverflow: true });
    await expect(collect(request(() => sse([{ type: "error", message: "boom" }])))).rejects.toMatchObject({ message: "boom" });
    await expect(collect(request(() => sse([{ type: "response.output_text.delta", delta: "partial" }])))).rejects.toMatchObject({ retryable: true });
    await expect(collect(request(() => new Response("{}", { status: 429 })))).rejects.toMatchObject({ retryable: true });
  });

  it("sends the key as a bearer token only, and retries without the sealed reasoning when the server refuses it", async () => {
    const transcript: TranscriptMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "ok", reasoningItems: [sealed] }, { role: "user", content: "more" }];
    const sent: Array<{ headers: Record<string, string>; input: Array<{ type?: string }> }> = [];
    const answers = [new Response(JSON.stringify({ error: { message: "Item with id 'rs_1' not found. Items are not persisted when `store` is set to false." } }), { status: 400 }), sse([completed()])];
    const events = await collect(
      request(
        (_url, init) => {
          const body = JSON.parse(String(init.body)) as { input: Array<{ type?: string }> };
          sent.push({ headers: init.headers as Record<string, string>, input: body.input });
          return answers.shift()!;
        },
        { transcript },
      ),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers).toMatchObject({ authorization: "Bearer sk-secret" });
    expect(sent[0]!.input.some((item) => item.type === "reasoning")).toBe(true);
    expect(sent[1]!.input.some((item) => item.type === "reasoning")).toBe(false);
  });
});

class FakeResponsesSocket implements ResponsesSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  constructor(private readonly onSend: (payload: Record<string, unknown>, socket: FakeResponsesSocket) => void) {}

  addEventListener(type: string, listener: (...args: never[]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) (listener as (arg?: unknown) => void)(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  sendEvent(event: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(event) });
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(parsed);
    this.onSend(parsed, this);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

describe("ResponsesWsSession persistent WebSocket mode", () => {
  const wsQuirks = () => quirks({ chatgptOAuth: true, sendReasoning: true });

  it("maps HTTP(S) base URLs to WS(S) /responses", () => {
    expect(responsesWsUrl("https://api.openai.com/v1")).toBe("wss://api.openai.com/v1/responses");
    expect(responsesWsUrl("http://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/v1/responses");
  });

  it("reuses one WebSocket with previous_response_id incremental inputs, resets on compaction, and reconnects on token rotation", async () => {
    const sockets: Array<{ url: string; headers: Record<string, string>; socket: FakeResponsesSocket }> = [];
    let responseCounter = 0;

    const wsSession = new ResponsesWsSession({
      webSocketFactory: (url, headers) => {
        const socket = new FakeResponsesSocket((payload, self) => {
          responseCounter += 1;
          const id = `resp_${responseCounter}`;
          queueMicrotask(() => {
            if (responseCounter === 1) {
              self.sendEvent({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"file_path":"/a"}' } });
            } else {
              self.sendEvent({ type: "response.output_text.delta", delta: `reply-${responseCounter}` });
            }
            self.sendEvent({
              type: "response.completed",
              response: {
                id,
                usage: {
                  input_tokens: 1000,
                  input_tokens_details: { cached_tokens: payload.previous_response_id ? 900 : 0 },
                  output_tokens: 20,
                  output_tokens_details: { reasoning_tokens: 5 },
                },
              },
            });
          });
        });
        sockets.push({ url, headers, socket });
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const sys: TranscriptMessage = { role: "system", content: "SYS" };
    const u1: TranscriptMessage = { role: "user", content: "first" };
    const transcript: TranscriptMessage[] = [sys, u1];
    const tools = [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }];

    const run = async (apiKey = "at_1") =>
      await collect(
        request(() => { throw new Error("HTTP fallback should not run"); }, {
          apiKey,
          model: "gpt-6.2-sol",
          transcript,
          tools,
          quirks: wsQuirks(),
          promptCacheKey: "sess-1",
          responsesSession: wsSession,
        }),
      );

    // 1. First request opens socket and sends full developer + user input with no stream flag.
    const r1 = await run();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("wss://api.openai.com/v1/responses");
    expect(sockets[0]!.headers).toEqual({ authorization: "Bearer at_1" });
    expect(sockets[0]!.socket.sent[0]).toMatchObject({
      type: "response.create",
      model: "gpt-6.2-sol",
      store: false,
      prompt_cache_key: "sess-1",
    });
    expect(sockets[0]!.socket.sent[0]).not.toHaveProperty("stream");
    expect(sockets[0]!.socket.sent[0]).not.toHaveProperty("previous_response_id");
    expect(sockets[0]!.socket.sent[0]!.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "SYS" }] },
      { role: "user", content: [{ type: "input_text", text: "first" }] },
    ]);
    expect(r1.some((e) => e.type === "tool.call")).toBe(true);

    // 2. Next step sends only the tool output and previous_response_id on the same socket.
    // A width one pixel above 4800 adds a whole patch column, crossing the limit.
    const oversized = pngHeader(4801, 6400);
    transcript.push(
      { role: "assistant", content: "", toolCalls: [call("c1")] },
      { role: "tool", toolCallId: "c1", name: "read", content: "file-body", images: [oversized] },
    );
    const r2 = await run();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.socket.sent[1]).toMatchObject({
      type: "response.create",
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "c1", output: [
        { type: "input_text", text: "file-body" },
        { type: "input_image", detail: "high", image_url: `data:${oversized.mimeType};base64,${oversized.data}` },
      ] }],
    });
    expect(r2).toContainEqual({
      type: "usage",
      usage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 900, reasoningTokens: 5 },
    });

    // 3. Compaction replaces transcript prefix: stays on same socket, drops previous_response_id and sends full input.
    transcript.splice(0, transcript.length, sys, { role: "user", content: "compacted summary" });
    await run();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.socket.sent[2]).not.toHaveProperty("previous_response_id");
    expect(sockets[0]!.socket.sent[2]!.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "SYS" }] },
      { role: "user", content: [{ type: "input_text", text: "compacted summary" }] },
    ]);

    // 4. OAuth access token rotation closes the old socket and opens a new one with the fresh bearer token.
    transcript.push({ role: "assistant", content: "reply-3" }, { role: "user", content: "after refresh" });
    await run("at_2");
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.socket.closed).toBe(true);
    expect(sockets[1]!.headers).toEqual({ authorization: "Bearer at_2" });
    expect(sockets[1]!.socket.sent[0]).not.toHaveProperty("previous_response_id");

    wsSession.close();
    expect(sockets[1]!.socket.closed).toBe(true);
  });

  it("recovers from previous_response_not_found and websocket_connection_limit_reached without failing the turn", async () => {
    const sockets: FakeResponsesSocket[] = [];
    let attempt = 0;
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket((payload, self) => {
          attempt += 1;
          queueMicrotask(() => {
            if (attempt === 1) {
              self.sendEvent({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 50, output_tokens: 5 } } });
            } else if (attempt === 2) {
              expect(payload.previous_response_id).toBe("resp_1");
              self.sendEvent({
                type: "error",
                status: 400,
                error: { code: "previous_response_not_found", message: "Previous response not found" },
              });
            } else if (attempt === 3) {
              expect(payload.previous_response_id).toBeUndefined();
              self.sendEvent({
                type: "error",
                status: 400,
                error: { code: "websocket_connection_limit_reached", message: "60 minute limit reached" },
              });
            } else {
              expect(payload.previous_response_id).toBeUndefined();
              self.sendEvent({ type: "response.output_text.delta", delta: "recovered" });
              self.sendEvent({ type: "response.completed", response: { id: "resp_4", usage: { input_tokens: 80, output_tokens: 10 } } });
            }
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const transcript: TranscriptMessage[] = [{ role: "system", content: "SYS" }, { role: "user", content: "one" }];
    await collect(
      request(() => sse([]), {
        model: "gpt-6.2-sol",
        transcript,
        quirks: wsQuirks(),
        responsesSession: wsSession,
      }),
    );
    transcript.push({ role: "assistant", content: "done" }, { role: "user", content: "two" });
    const recovered = await collect(
      request(() => sse([]), {
        model: "gpt-6.2-sol",
        transcript,
        quirks: wsQuirks(),
        responsesSession: wsSession,
      }),
    );
    expect(recovered).toContainEqual({ type: "text.delta", text: "recovered" });
    // Each failed attempt ended without a terminal frame, so its socket was closed and
    // reset in the iterator's finally: the retries reconnect on fresh sockets (LOCAL-009),
    // while the request that completed terminally keeps its socket open for continuation.
    expect(sockets).toHaveLength(3);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[1]!.closed).toBe(true);
    expect(sockets[2]!.closed).toBe(false);
    wsSession.close();
    expect(sockets[2]!.closed).toBe(true);
  });

  it("falls back seamlessly to HTTP SSE when the WebSocket handshake fails", async () => {
    let httpCalls = 0;
    let wsAttempts = 0;
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        wsAttempts += 1;
        const socket = new FakeResponsesSocket(() => {});
        queueMicrotask(() => socket.emit("error"));
        return socket;
      },
    });

    const req = () =>
      request(
        () => {
          httpCalls += 1;
          return sse([
            { type: "response.output_text.delta", delta: "via-http" },
            { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
          ]);
        },
        {
          model: "gpt-6.2-sol",
          quirks: wsQuirks(),
          responsesSession: wsSession,
        },
      );

    const first = await collect(req());
    expect(first).toContainEqual({ type: "text.delta", text: "via-http" });
    expect(wsAttempts).toBe(1);
    expect(httpCalls).toBe(1);

    // Once disabled on upgrade failure, subsequent requests go straight to HTTP SSE without retrying WS.
    const second = await collect(req());
    expect(second).toContainEqual({ type: "text.delta", text: "via-http" });
    expect(wsAttempts).toBe(1);
    expect(httpCalls).toBe(2);
  });

  it("closes and resets the socket when the consumer abandons the stream before a terminal frame, so a late frame cannot leak into the next turn (LOCAL-009)", async () => {
    const sockets: FakeResponsesSocket[] = [];
    let sent = 0;
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket((_payload, self) => {
          sent += 1;
          queueMicrotask(() => {
            if (sent === 1) {
              // Turn 1 stalls after one delta: no terminal frame ever arrives.
              self.sendEvent({ type: "response.output_text.delta", delta: "turn-1 partial" });
            } else {
              self.sendEvent({ type: "response.output_text.delta", delta: "turn-2 reply" });
              self.sendEvent({ type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 10, output_tokens: 2 } } });
            }
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
    const req = () =>
      request(() => { throw new Error("HTTP fallback should not run"); }, {
        model: "gpt-6.2-sol",
        transcript,
        quirks: wsQuirks(),
        responsesSession: wsSession,
      });

    // The loop's repeat guard breaks out of the for-await before any terminal frame.
    const abandoned: ModelEvent[] = [];
    for await (const event of streamResponses(req())) {
      abandoned.push(event);
      break;
    }
    expect(abandoned).toEqual([{ type: "text.delta", text: "turn-1 partial" }]);
    expect(sockets[0]!.closed).toBe(true);

    // Turn 2 starts while the server is still streaming turn 1 on the old socket.
    const secondPromise = collect(req());
    await vi.waitFor(() => expect(sockets[sockets.length - 1]!.sent.length).toBeGreaterThanOrEqual(1));
    const turn2Socket = sockets[sockets.length - 1]!;
    expect(turn2Socket).not.toBe(sockets[0]);
    sockets[0]!.sendEvent({ type: "response.output_text.delta", delta: "turn-1 late frame" });
    sockets[0]!.sendEvent({ type: "response.completed", response: { id: "resp_1" } });
    const second = await secondPromise;
    expect(second).toContainEqual({ type: "text.delta", text: "turn-2 reply" });
    expect(second.some((event) => event.type === "text.delta" && event.text === "turn-1 late frame")).toBe(false);
    // The reset dropped the continuation chain: turn 2 sends a full body without previous_response_id.
    expect(turn2Socket.sent[0]).not.toHaveProperty("previous_response_id");
    wsSession.close();
  });

  it("never sends a second request on a stream that still has one in flight (LOCAL-009)", async () => {
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const stallFirst = sockets.length === 0;
        const socket = new FakeResponsesSocket((_payload, self) => {
          queueMicrotask(() => {
            if (stallFirst && socket.sent.length === 1) {
              // The first socket's first request stalls after one delta.
              self.sendEvent({ type: "response.output_text.delta", delta: "first partial" });
            } else {
              self.sendEvent({ type: "response.completed", response: { id: "resp_done", usage: { input_tokens: 1, output_tokens: 1 } } });
            }
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
    const req = () =>
      request(() => { throw new Error("HTTP fallback should not run"); }, {
        model: "gpt-6.2-sol",
        transcript,
        quirks: wsQuirks(),
        responsesSession: wsSession,
      });

    // The first stream starts, stalls mid-reply, and its iterator stays open (not abandoned).
    const firstIterator = streamResponses(req())[Symbol.asyncIterator]();
    const firstEvent = await firstIterator.next();
    expect(firstEvent.value).toEqual({ type: "text.delta", text: "first partial" });

    // A second stream on the same session queues behind the first owner: it must
    // not reset the first stream's socket or open a replacement while it is busy.
    const secondPromise = collect(req());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);

    // The first stream then finishes on its own socket (terminal frame), releasing ownership.
    sockets[0]!.sendEvent({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 } } });
    expect((await firstIterator.next()).value).toMatchObject({ type: "usage" });
    expect((await firstIterator.next()).value).toEqual({ type: "finish", reason: "stop" });
    expect((await firstIterator.next()).done).toBe(true);

    // Now the queued second stream runs (reusing the still-open socket) and completes.
    const second = await secondPromise;
    expect(second.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(sockets).toHaveLength(1);
    wsSession.close();
  });

  it("lets a paused stream process its queued close without closing the socket a later stream owns (LOCAL-009)", async () => {
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const stallFirst = sockets.length === 0;
        const socket = new FakeResponsesSocket((_payload, self) => {
          queueMicrotask(() => {
            if (stallFirst && socket.sent.length === 1) {
              // The first socket's first request stalls after one delta.
              self.sendEvent({ type: "response.output_text.delta", delta: "partial" });
            } else {
              self.sendEvent({ type: "response.output_text.delta", delta: "later reply" });
              self.sendEvent({ type: "response.completed", response: { id: "resp_later", usage: { input_tokens: 2, output_tokens: 2 } } });
            }
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
    const req = () =>
      request(() => { throw new Error("HTTP fallback should not run"); }, {
        model: "gpt-6.2-sol",
        transcript,
        quirks: wsQuirks(),
        responsesSession: wsSession,
      });

    // Stream A pauses after its first delta, still owning the session.
    const itA = streamResponses(req())[Symbol.asyncIterator]();
    expect((await itA.next()).value).toEqual({ type: "text.delta", text: "partial" });

    // Stream B starts while A is paused: it queues behind A instead of stealing the socket.
    const itB = streamResponses(req())[Symbol.asyncIterator]();
    const bPromise = (async () => {
      const out: ModelEvent[] = [];
      for (;;) {
        const step = await itB.next();
        if (step.done) return out;
        out.push(step.value);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets).toHaveLength(1);

    // A advances and processes its queued close: its reset must be scoped to its
    // own socket, so B's later socket is never closed underneath it.
    sockets[0]!.emit("close", { code: 1006, reason: "dropped" });
    const aOutcome = await Promise.race([
      itA.next().then(() => "next", (error: unknown) => (error as Error).message),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(typeof aOutcome).toBe("string");

    const second = await bPromise;
    expect(second.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(second).toContainEqual({ type: "text.delta", text: "later reply" });
    expect(sockets.every((socket) => !socket.closed || socket === sockets[0])).toBe(true);
    wsSession.close();
  });

  it("serializes two cold concurrent streams into one socket (LOCAL-009)", async () => {
    const sockets: FakeResponsesSocket[] = [];
    let counter = 0;
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket((_payload, self) => {
          counter += 1;
          const id = `resp_${counter}`;
          queueMicrotask(() => {
            self.sendEvent({ type: "response.output_text.delta", delta: `reply-${id}` });
            self.sendEvent({ type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1 } } });
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
    const req = () =>
      request(() => { throw new Error("HTTP fallback should not run"); }, {
        model: "gpt-6.2-sol",
        transcript,
        quirks: wsQuirks(),
        responsesSession: wsSession,
      });

    const drain = async (iterator: AsyncIterator<ModelEvent>): Promise<ModelEvent[]> => {
      const out: ModelEvent[] = [];
      for (;;) {
        const step = await iterator.next();
        if (step.done) return out;
        out.push(step.value);
      }
    };

    // Start both streams before either handshake resolves.
    const itA = streamResponses(req())[Symbol.asyncIterator]();
    const itB = streamResponses(req())[Symbol.asyncIterator]();
    const aPromise = drain(itA);
    const bPromise = drain(itB);
    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(a.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(b.at(-1)).toEqual({ type: "finish", reason: "stop" });
    // Two requests, one socket: the second stream waited for the first to finish.
    expect(sockets).toHaveLength(1);
    wsSession.close();
  });

  it("does not send the request when aborted between the open event and the handshake resuming (LOCAL-009)", async () => {
    const controller = new AbortController();
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket(() => {
          // Never answers.
        });
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          // Abort synchronously right after `open` fires, before the handshake promise resumes.
          controller.abort();
        });
        return socket;
      },
    });

    const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
    const req = request(() => { throw new Error("HTTP fallback should not run"); }, {
      model: "gpt-6.2-sol",
      transcript,
      quirks: wsQuirks(),
      responsesSession: wsSession,
      signal: controller.signal,
    });

    const outcome = await Promise.race([
      collect(req).then(
        () => "completed",
        (error: unknown) => (error as Error).name ?? String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(outcome).toBe("AbortError");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(0);
    expect(sockets[0]!.closed).toBe(true);
    wsSession.close();
  });
});

describe("ResponsesWsSession stream ownership round 3 (LOCAL-009)", () => {
  const wsQuirks = () => quirks({ chatgptOAuth: true, sendReasoning: true });
  const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
  const req = (
    wsSession: ResponsesWsSession,
    overrides: Partial<ChatRequest> = {},
  ) =>
    request(() => { throw new Error("HTTP fallback should not run"); }, {
      model: "gpt-6.2-sol",
      transcript,
      quirks: wsQuirks(),
      responsesSession: wsSession,
      ...overrides,
    });

  it("rejects a queued stream immediately when its request aborts, and releases the owner when a suspended stream's request aborts (LOCAL-009)", async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket((_payload, self) => {
          queueMicrotask(() => {
            if (sockets.length === 1 && socket.sent.length === 1) {
              // The first socket's first request stalls after one delta.
              self.sendEvent({ type: "response.output_text.delta", delta: "A partial" });
            } else {
              self.sendEvent({ type: "response.completed", response: { id: "resp_c", usage: { input_tokens: 1, output_tokens: 1 } } });
            }
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    // Stream A starts, emits one delta, then stays suspended while owning the stream.
    const itA = streamResponses(req(wsSession, { signal: controllerA.signal }))[Symbol.asyncIterator]();
    expect((await itA.next()).value).toEqual({ type: "text.delta", text: "A partial" });

    // Stream B queues behind A, then aborts while queued: it must reject with
    // AbortError at once instead of waiting for the owner to exit.
    const bPromise = collect(req(wsSession, { signal: controllerB.signal })).then(
      () => "completed",
      (error: unknown) => (error as Error).name ?? String(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    controllerB.abort();
    const bOutcome = await Promise.race([
      bPromise,
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(bOutcome).toBe("AbortError");
    expect(sockets).toHaveLength(1);

    // Aborting A while its generator is suspended must release the owner token,
    // so a later stream is not starved.
    controllerA.abort();
    const c = await collect(req(wsSession));
    expect(c.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(sockets).toHaveLength(2);
    wsSession.close();
  });

  it("closes a connecting socket and never sends after close() runs during the handshake (LOCAL-009)", async () => {
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket(() => {
          // Never answers.
        });
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          // close() synchronously right after `open` fires, before the handshake
          // continuation runs.
          wsSession.close();
        });
        return socket;
      },
    });

    const outcome = await Promise.race([
      collect(req(wsSession)).then(
        () => "completed",
        (error: unknown) => (error as Error).name ?? String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(outcome).toBe("AbortError");
    expect(sockets).toHaveLength(1);
    // The connecting socket was shut down: nothing was sent on it.
    expect(sockets[0]!.sent).toHaveLength(0);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("serializes the payload before the final cancellation check, so an aborting toJSON() prevents the send (LOCAL-009)", async () => {
    const controller = new AbortController();
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket(() => {
          // Never answers.
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    // The config key is serialized once up front; the payload is serialized again
    // immediately before send. Abort only on the second serialization.
    let serializations = 0;
    const abortingParameters = {
      type: "object",
      toJSON() {
        serializations += 1;
        if (serializations >= 2) controller.abort();
        return { type: "object" };
      },
    };
    const tools = [{ name: "read", description: "Reads.", parameters: abortingParameters }];

    const outcome = await Promise.race([
      collect(req(wsSession, { tools, signal: controller.signal })).then(
        () => "completed",
        (error: unknown) => (error as Error).name ?? String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(outcome).toBe("AbortError");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(0);
    wsSession.close();
  });
});

describe("ResponsesWsSession stream ownership round 4 (LOCAL-009)", () => {
  const wsQuirks = () => quirks({ chatgptOAuth: true, sendReasoning: true });
  const transcript: TranscriptMessage[] = [{ role: "user", content: "one" }];
  const req = (
    wsSession: ResponsesWsSession,
    overrides: Partial<ChatRequest> = {},
  ) =>
    request(() => { throw new Error("HTTP fallback should not run"); }, {
      model: "gpt-6.2-sol",
      transcript,
      quirks: wsQuirks(),
      responsesSession: wsSession,
      ...overrides,
    });
  const outcomeOf = (run: Promise<unknown>, ms = 300) =>
    Promise.race([
      run.then(
        () => "completed",
        (error: unknown) => (error as Error).name ?? String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), ms)),
    ]);

  it("classifies an abort during the handshake as cancellation and keeps WebSockets enabled (LOCAL-009)", async () => {
    const controller = new AbortController();
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        // A socket that never opens, and dispatches `close` synchronously.
        const socket = new FakeResponsesSocket(() => {});
        sockets.push(socket);
        // Abort while the handshake is still pending, before any open event.
        queueMicrotask(() => controller.abort());
        return socket;
      },
    });

    const outcome = await outcomeOf(collect(req(wsSession, { signal: controller.signal })));
    expect(outcome).toBe("AbortError");
    // The cancellation must not disable WebSockets for the rest of the session.
    expect(wsSession.isDisabled).toBe(false);
    expect(sockets[0]!.sent).toHaveLength(0);
    wsSession.close();
  });

  it("rejects a resumed stream with AbortError when its request aborted after a delta, not a transport failure (LOCAL-009)", async () => {
    const controller = new AbortController();
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket((_payload, self) => {
          queueMicrotask(() => {
            // The stream stalls after one delta and never finishes.
            self.sendEvent({ type: "response.output_text.delta", delta: "partial" });
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const it = streamResponses(req(wsSession, { signal: controller.signal }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: "text.delta", text: "partial" });
    // Abort while the iterator is suspended after a delta, then resume it.
    controller.abort();
    const resumed = await outcomeOf(it.next());
    expect(resumed).toBe("AbortError");
    expect(wsSession.isDisabled).toBe(false);
    // A later stream can still use a WebSocket (the owner token was freed).
    const socketsBefore = sockets.length;
    const second = await outcomeOf((async () => {
      const events: ModelEvent[] = [];
      for await (const event of streamResponses(req(wsSession))) events.push(event);
      return events.at(-1);
    })() as Promise<unknown>);
    // The fallback-when-disabled case would return "completed" via HTTP; here a
    // fresh WS attempt means ownership was released cleanly.
    expect(sockets.length).toBeGreaterThan(socketsBefore);
    wsSession.close();
  });

  it("never delivers a buffered terminal frame after the request aborted (LOCAL-009)", async () => {
    const controller = new AbortController();
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        const socket = new FakeResponsesSocket((_payload, self) => {
          queueMicrotask(() => {
            self.sendEvent({ type: "response.output_text.delta", delta: "partial" });
          });
        });
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const it = streamResponses(req(wsSession, { signal: controller.signal }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: "text.delta", text: "partial" });
    // The terminal frame arrives while the iterator is suspended, then the
    // request aborts: the buffered frame must not be consumed as a finish.
    sockets[0]!.sendEvent({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 } } });
    controller.abort();
    const resumed = await outcomeOf(it.next());
    expect(resumed).toBe("AbortError");
    wsSession.close();
  });

  it("frees an owner waiting for its first frame when the consumer calls return() without aborting (LOCAL-009)", async () => {
    const sockets: FakeResponsesSocket[] = [];
    const wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        // Opens, sends nothing: the endpoint stays silent.
        const socket = new FakeResponsesSocket(() => {});
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });

    const iterator = wsSession
      .stream(req(wsSession), () => ({ model: "gpt-6.2-sol", input: [] }), false);
    const first = iterator.next();
    await vi.waitFor(() => expect(sockets[0]!.sent.length).toBeGreaterThanOrEqual(1));

    // return() while the first next() is still waiting on a silent endpoint:
    // it must actively interrupt the read and release ownership, not queue
    // behind the unresolved next().
    const returned = await Promise.race([
      iterator.return!().then(() => "returned"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(returned).toBe("returned");
    expect(await outcomeOf(first)).toBe("AbortError");

    // A new stream acquires ownership at once (a stale owner would leave it
    // queued, silent forever): it opens its own socket and sends its request.
    const queued = (async () => {
      const out: ModelEvent[] = [];
      for await (const event of streamResponses(req(wsSession))) out.push(event);
      return out;
    })();
    await vi.waitFor(() => expect(sockets.at(-1)!.sent.length).toBeGreaterThanOrEqual(1), { timeout: 1_000 });
    expect(sockets.length).toBeGreaterThan(1);
    expect(sockets.at(-1)).not.toBe(sockets[0]);
    wsSession.close();
    await queued.catch(() => undefined);
  });

  it("closes the socket a factory returned after the factory itself closed the session (LOCAL-009)", async () => {
    let wsSession!: ResponsesWsSession;
    const sockets: FakeResponsesSocket[] = [];
    wsSession = new ResponsesWsSession({
      webSocketFactory: () => {
        // The factory closes the session synchronously before returning a
        // socket that never opens and never announces its death.
        const socket = new FakeResponsesSocket(() => {});
        sockets.push(socket);
        wsSession.close();
        return socket;
      },
    });

    const outcome = await outcomeOf(collect(req(wsSession)));
    expect(outcome).toBe("AbortError");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(0);
    expect(sockets[0]!.closed).toBe(true);
  });
});

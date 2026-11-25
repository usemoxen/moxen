/**
 * Persistent WebSocket transport for OpenAI Responses API (`wss://.../v1/responses`).
 *
 * Sign in with ChatGPT (`chatgpt.tokens.use.direct`) requires `store: false` and
 * forbids `previous_response_id` over HTTP, which prevents reliable prompt cache
 * reuse on stateless HTTP requests. Keeping one WebSocket per session lets
 * OpenAI retain connection-local state for `previous_response_id` continuation
 * (sending only newly appended user/tool items) and keeps the session pinned to
 * the same cache replica.
 *
 * Any upgrade failure disables WebSocket for that session and falls back
 * transparently to HTTP SSE; disconnects, 60-minute connection limits, token
 * rotations, compactions, and `previous_response_not_found` recover cleanly.
 *
 * One stream owns the session exclusively while it runs: a second concurrent
 * stream queues behind it instead of opening or stealing a socket. A stream
 * that ends without consuming a terminal response frame (the consumer
 * abandoned it, the connection dropped, or it is being retried) closes and
 * resets its own socket in its `finally` — conditional on still owning it —
 * so a late frame from an abandoned request can never be delivered as the
 * next turn's output, and the continuation chain restarts from a full input
 * on a fresh socket.
 */
import { responsesUrl } from "../profiles.js";
import { buildResponsesInput, type ResponsesItem } from "../normalize-responses.js";
import type { FinishReason, ModelEvent, ModelUsage, TranscriptMessage } from "../types.js";
import {
  asNumber,
  asRecord,
  ChatHttpError,
  OVERFLOW,
  SUBSCRIPTION_SHARING_LIMIT_CODE,
  type ChatRequest,
} from "./chat.js";

const WS_OPEN = 1;
const WS_CONNECT_TIMEOUT_MS = 10_000;
/** Proactively roll over before OpenAI's 60-minute WebSocket connection cap. */
const WS_MAX_CONNECTION_AGE_MS = 55 * 60_000;

const SUBSCRIPTION_SHARING_LIMIT_MESSAGE =
  "Your ChatGPT per-app weekly usage limit for Moxen was reached. Raise or manage it in ChatGPT → Settings → Usage → App limits.";

export interface ResponsesSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "close", listener: (event: { readonly code?: number; readonly reason?: string }) => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "close", listener: (event: { readonly code?: number; readonly reason?: string }) => void): void;
}

export type ResponsesWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => ResponsesSocket;

export class ResponsesWsUpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesWsUpgradeError";
  }
}

export function responsesWsUrl(baseUrl: string): string {
  const httpUrl = responsesUrl(baseUrl);
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  return httpUrl;
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): ResponsesSocket {
  const Ctor = globalThis.WebSocket as unknown as
    | (new (url: string, init?: { readonly headers?: Record<string, string> }) => ResponsesSocket)
    | undefined;
  if (typeof Ctor !== "function") {
    throw new ResponsesWsUpgradeError("WebSocket is not available in this runtime.");
  }
  return new Ctor(url, { headers });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function usageFrom(response: Record<string, unknown>): ModelUsage | null {
  const usage = asRecord(response.usage);
  if (!usage) return null;
  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cachedInputTokens: asNumber(asRecord(usage.input_tokens_details)?.cached_tokens),
    reasoningTokens: asNumber(asRecord(usage.output_tokens_details)?.reasoning_tokens),
  };
}

export function responsesEventError(event: Record<string, unknown>): {
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
} {
  const nested =
    asRecord(asRecord(event.response)?.error) ??
    asRecord(event.error) ??
    event;
  const status = typeof event.status === "number" && Number.isFinite(event.status) ? event.status : null;
  const rawCode = nested.code;
  const code = typeof rawCode === "string" && rawCode.trim() !== "" ? rawCode.trim() : null;
  const rawMessage = nested.message ?? event.message;
  const message =
    typeof rawMessage === "string" && rawMessage.trim() !== ""
      ? rawMessage.trim()
      : "The model endpoint reported an error.";
  return { status, code, message };
}

export function responsesErrorToChatError(info: {
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
}): ChatHttpError {
  if (info.code === SUBSCRIPTION_SHARING_LIMIT_CODE) {
    return new ChatHttpError(
      SUBSCRIPTION_SHARING_LIMIT_MESSAGE,
      info.status ?? 429,
      false,
      false,
      null,
      SUBSCRIPTION_SHARING_LIMIT_CODE,
    );
  }
  const retryable = info.status === 429 || (info.status !== null && info.status >= 500);
  return new ChatHttpError(
    info.message,
    info.status,
    OVERFLOW.test(info.message),
    retryable,
    null,
    info.code,
  );
}

/**
 * Shared stateful event reducer for OpenAI Responses API events (both HTTP SSE
 * and WebSocket frames).
 */
export class ResponsesEventReducer {
  private readonly streamedArguments = new Map<string, string>();
  private readonly yieldedCalls = new Set<string>();
  private sawCall = false;
  private summaryParts = 0;
  usage: ModelUsage | null = null;
  finish: FinishReason | null = null;
  responseId: string | null = null;
  completed = false;

  push(event: Record<string, unknown>): ModelEvent[] {
    const out: ModelEvent[] = [];
    const type = event.type;
    if (type === "response.created") {
      const id = asRecord(event.response)?.id;
      if (typeof id === "string" && id !== "") this.responseId = id;
    } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
      if (event.delta !== "") out.push({ type: "text.delta", text: event.delta });
    } else if (
      (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
      typeof event.delta === "string"
    ) {
      if (event.delta !== "") out.push({ type: "reasoning.delta", text: event.delta });
    } else if (type === "response.reasoning_summary_part.added") {
      if (this.summaryParts > 0) out.push({ type: "reasoning.delta", text: "\n\n" });
      this.summaryParts += 1;
    } else if (
      type === "response.function_call_arguments.delta" &&
      typeof event.item_id === "string" &&
      typeof event.delta === "string"
    ) {
      this.streamedArguments.set(event.item_id, `${this.streamedArguments.get(event.item_id) ?? ""}${event.delta}`);
    } else if (type === "response.output_item.done") {
      const item = asRecord(event.item);
      if (item?.type === "function_call" && typeof item.name === "string") {
        const id =
          typeof item.call_id === "string" && item.call_id !== ""
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : `call_${this.yieldedCalls.size}`;
        if (!this.yieldedCalls.has(id)) {
          this.yieldedCalls.add(id);
          this.sawCall = true;
          const args =
            typeof item.arguments === "string" && item.arguments.trim() !== ""
              ? item.arguments
              : (this.streamedArguments.get(typeof item.id === "string" ? item.id : "") ?? "");
          out.push({ type: "tool.call", call: { id, name: item.name, arguments: args.trim() === "" ? "{}" : args } });
        }
      } else if (
        item?.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content !== ""
      ) {
        out.push({
          type: "reasoning.item",
          item: {
            format: "responses",
            item: {
              type: "reasoning",
              summary: Array.isArray(item.summary) ? item.summary : [],
              encrypted_content: item.encrypted_content,
            },
          },
        });
        this.summaryParts = 0;
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const done = asRecord(event.response) ?? {};
      const id = done.id;
      if (typeof id === "string" && id !== "") this.responseId = id;
      this.usage = usageFrom(done) ?? this.usage;
      const reason = asRecord(done.incomplete_details)?.reason;
      this.finish =
        reason === "max_output_tokens"
          ? "length"
          : reason === "content_filter"
            ? "filter"
            : this.sawCall
              ? "tool-calls"
              : "stop";
      this.completed = type === "response.completed";
    } else if (type === "response.failed" || type === "error") {
      throw responsesErrorToChatError(responsesEventError(event));
    }
    return out;
  }
}

async function decodeSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return null;
}

export interface ResponsesWsSessionOptions {
  readonly webSocketFactory?: ResponsesWebSocketFactory | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxConnectionAgeMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** Stream iterator as returned by `ResponsesWsSession.stream`: `return()` frees a waiting owner at once. */
export interface ResponsesWsStream extends AsyncIterableIterator<ModelEvent> {
  next(...args: [] | [undefined]): Promise<IteratorResult<ModelEvent, unknown>>;
  return?(value?: unknown): Promise<IteratorResult<ModelEvent, unknown>>;
  throw?(error?: unknown): Promise<IteratorResult<ModelEvent, unknown>>;
}

/**
 * Iterator wrapper around one owned stream (LOCAL-009). `next()`/`throw()`
 * delegate to the underlying generator; `return()` first actively interrupts
 * the pending read (a generator's own `return()` is queued behind an
 * unresolved `next()`, so it cannot free an owner waiting on a silent
 * endpoint) and then finishes the generator. A stream that is still queued
 * (not the owner) relies on the caller's abort contract or the next ownership
 * handoff instead.
 */
class ResponsesWsStreamHandle implements ResponsesWsStream {
  constructor(
    private readonly session: ResponsesWsSession,
    private readonly inner: AsyncGenerator<ModelEvent>,
    private readonly owner: object,
  ) {}

  [Symbol.asyncIterator](): ResponsesWsStream {
    return this;
  }

  next(...args: [] | [undefined]): Promise<IteratorResult<ModelEvent, unknown>> {
    return this.inner.next(...args);
  }

  throw(error?: unknown): Promise<IteratorResult<ModelEvent, unknown>> {
    return this.inner.throw(error);
  }

  async return(value?: unknown): Promise<IteratorResult<ModelEvent, unknown>> {
    this.session.interruptOwnedRead(this.owner);
    return await this.inner.return(value);
  }
}

/**
 * Per-session persistent WebSocket connection to OpenAI's Responses API.
 * Owns one open socket and tracks the last completed `response.id` + transcript
 * prefix so subsequent steps send only newly appended items.
 */
export class ResponsesWsSession {
  private readonly factory: ResponsesWebSocketFactory;
  readonly hasCustomFactory: boolean;
  private readonly connectTimeoutMs: number;
  private readonly maxConnectionAgeMs: number;
  private readonly now: () => number;

  private socket: ResponsesSocket | null = null;
  /** Exclusive owner token of the stream currently running, if any. */
  private streamOwner: object | null = null;
  private readonly streamWaiters: Array<{ wake: () => void }> = [];
  /** Socket currently mid-handshake; closed by close()/owner-abort so it can never send after shutdown. */
  private connectingSocket: ResponsesSocket | null = null;
  /**
   * Rejects the owned stream's pending frame read, so an abandoned owner's
   * `return()` can interrupt a read that may never complete (LOCAL-009).
   */
  private readCancel: (() => void) | null = null;
  /**
   * Owners whose stream is being actively cancelled (a consumer `return()`):
   * marked BEFORE any socket is closed or handshake rejected, so close and
   * error handlers classify the shutdown as cancellation, not a transport
   * failure, and cleared when the cancelled stream finally settles
   * (LOCAL-009).
   */
  private readonly abandonedOwners: Set<object> = new Set();
  /**
   * Per-owner reject for the handshake currently awaiting its socket: an
   * abandoned owner's `return()` fails it directly instead of waiting on a
   * socket that may never open or dispatch close (LOCAL-009).
   */
  private readonly handshakeCancels: Map<object, () => void> = new Map();
  private connectedUrl: string | null = null;
  private connectedApiKey: string | undefined = undefined;
  private connectedAt = 0;
  private lastResponseId: string | null = null;
  private sentPrefix: readonly TranscriptMessage[] | null = null;
  private lastConfigKey: string | null = null;
  private disabled = false;
  private closed = false;

  constructor(options: ResponsesWsSessionOptions = {}) {
    this.hasCustomFactory = options.webSocketFactory !== undefined;
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? WS_CONNECT_TIMEOUT_MS;
    this.maxConnectionAgeMs = options.maxConnectionAgeMs ?? WS_MAX_CONNECTION_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  get isDisabled(): boolean {
    return this.disabled || this.closed;
  }

  /** Forget the continuation chain (e.g. after compaction or error) while keeping the socket open. */
  resetChain(): void {
    this.lastResponseId = null;
    this.sentPrefix = null;
    this.lastConfigKey = null;
  }

  /** Close the underlying WebSocket and clear all continuation state. */
  resetSocket(): void {
    this.resetChain();
    const current = this.socket;
    this.socket = null;
    this.connectedUrl = null;
    this.connectedApiKey = undefined;
    this.connectedAt = 0;
    if (current) {
      try {
        current.close(1000, "client reset");
      } catch {
        // Best-effort close.
      }
    }
  }

  /** Permanently close this session's WebSocket (called when the Harness session ends). */
  close(): void {
    this.closed = true;
    this.resetSocket();
    // A socket still mid-handshake must not be allowed to install itself or
    // send after shutdown: close it now; ensureOpen rechecks `closed` after the
    // handshake resolves and refuses to install it.
    const connecting = this.connectingSocket;
    this.connectingSocket = null;
    if (connecting) {
      try {
        connecting.close(1000, "session closed");
      } catch {
        // Best-effort.
      }
    }
    // Wake queued streams so they see the closed session instead of waiting forever.
    this.streamOwner = null;
    for (const entry of this.streamWaiters.splice(0)) entry.wake();
  }

  /** True when the given stream owner still owns the session's current socket. */
  private ownsSocket(owner: object, socket: ResponsesSocket): boolean {
    return this.streamOwner === owner && this.socket === socket;
  }

  private async ensureOpen(
    url: string,
    apiKey: string | undefined,
    signal?: AbortSignal,
    owner?: object,
  ): Promise<{ readonly socket: ResponsesSocket; readonly reused: boolean }> {
    if (this.closed) throw abortError();
    if (signal?.aborted) throw abortError();
    const abandoned = (): boolean => owner !== undefined && this.abandonedOwners.has(owner);
    const age = this.now() - this.connectedAt;
    if (
      this.socket !== null &&
      this.socket.readyState === WS_OPEN &&
      this.connectedUrl === url &&
      this.connectedApiKey === apiKey &&
      age < this.maxConnectionAgeMs
    ) {
      return { socket: this.socket, reused: true };
    }
    this.resetSocket();
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    let socket: ResponsesSocket;
    try {
      socket = this.factory(url, headers);
    } catch (cause) {
      this.disabled = true;
      throw new ResponsesWsUpgradeError(cause instanceof Error ? cause.message : String(cause));
    }

    // The factory itself may have run synchronously — a custom factory that
    // called close() (or observed the abort signal) before returning a socket
    // that never opens: recheck and close the returned socket right away,
    // without installing a handshake, so it cannot sit until the connect
    // timeout and the failure is classified as the cancellation it is
    // (LOCAL-009).
    if (this.closed || signal?.aborted || abandoned()) {
      try {
        socket.close();
      } catch {
        // Best-effort.
      }
      throw abortError();
    }

    // Track the connecting socket so close() and owner-abort can shut it down
    // even before the handshake continuation runs.
    this.connectingSocket = socket;
    try {
      await this.handshake(socket, signal, owner);
    } finally {
      if (this.connectingSocket === socket) this.connectingSocket = null;
    }

    // Recheck shutdown, abort and owner cancellation between the `open` event
    // and this continuation: close(), an abort, or this owner's return() may
    // have run in between, and the request must neither be installed on a
    // dead session nor sent on a socket a cancelled stream no longer owns.
    if (this.closed || signal?.aborted || abandoned()) {
      try {
        socket.close();
      } catch {
        // Best-effort.
      }
      throw abortError();
    }

    this.socket = socket;
    this.connectedUrl = url;
    this.connectedApiKey = apiKey;
    this.connectedAt = this.now();
    return { socket, reused: false };
  }

  private handshake(socket: ResponsesSocket, signal?: AbortSignal, owner?: object): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelled = (): boolean =>
        this.closed || signal?.aborted || (owner !== undefined && this.abandonedOwners.has(owner));
      // Register this owner's direct reject: interruptOwnedRead fires it so an
      // abandoned stream's handshake fails at once instead of waiting on a
      // socket that may never open, error, or dispatch close (LOCAL-009).
      const cancel = () => fail(abortError());
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (owner !== undefined && this.handshakeCancels.get(owner) === cancel) {
          this.handshakeCancels.delete(owner);
        }
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          // Best-effort.
        }
        // A shutdown, an abort, or this owner's active cancellation during
        // the handshake is a cancellation, not an endpoint failure.
        reject(cancelled() ? abortError() : err);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (cancelled()) {
          fail(abortError());
          return;
        }
        this.disabled = true;
        fail(new ResponsesWsUpgradeError("Could not open Responses WebSocket connection."));
      };
      const onClose = (event: { readonly code?: number; readonly reason?: string }) => {
        // A close dispatched while the request is being cancelled (the fake
        // in the tests, and some socket implementations, dispatch
        // asynchronously, after the cancelling return() already finished)
        // must not disable WebSockets for the session (LOCAL-009).
        if (cancelled()) {
          fail(abortError());
          return;
        }
        this.disabled = true;
        fail(new ResponsesWsUpgradeError(`Responses WebSocket closed during handshake (${event.code ?? 0}).`));
      };
      const onAbort = () => fail(abortError());
      timer = setTimeout(() => {
        if (cancelled()) {
          fail(abortError());
          return;
        }
        this.disabled = true;
        fail(new ResponsesWsUpgradeError("Timed out opening Responses WebSocket connection."));
      }, this.connectTimeoutMs);
      timer.unref?.();
      if (owner !== undefined) this.handshakeCancels.set(owner, cancel);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (socket.readyState === WS_OPEN) onOpen();
    });
  }

  private continuationDelta(
    transcript: readonly TranscriptMessage[],
    configKey: string,
  ): readonly TranscriptMessage[] | null {
    if (!this.lastResponseId || !this.sentPrefix || this.lastConfigKey !== configKey) return null;
    const prevLen = this.sentPrefix.length;
    // Expect `[...sentPrefix, assistantReply, ...newItems]` with at least one new non-assistant item.
    if (transcript.length <= prevLen + 1) return null;
    for (let i = 0; i < prevLen; i++) {
      if (transcript[i] !== this.sentPrefix[i]) return null;
    }
    if (transcript[prevLen]?.role !== "assistant") return null;
    const delta = transcript.slice(prevLen + 1);
    if (delta.length === 0 || delta.some((message) => message.role === "assistant")) return null;
    return delta;
  }

  /**
   * Start a stream on this session (exclusive while it runs; a second stream
   * queues behind it). The result is an async iterator whose `return()`
   * actively interrupts a pending read and releases ownership, so abandoning a
   * stream that is waiting for its first frame never starves the queue behind
   * it: an async generator's own `return()` would be queued behind its
   * unresolved `next()` and could not free the owner until the endpoint spoke
   * (LOCAL-009).
   */
  stream(
    request: ChatRequest,
    buildFullBody: (replayReasoning: boolean) => Record<string, unknown>,
    replayReasoning: boolean,
  ): ResponsesWsStream {
    const owner = {};
    const inner = this.runStream(owner, request, buildFullBody, replayReasoning);
    return new ResponsesWsStreamHandle(this, inner, owner);
  }

  private async *runStream(
    owner: object,
    request: ChatRequest,
    buildFullBody: (replayReasoning: boolean) => Record<string, unknown>,
    replayReasoning: boolean,
  ): AsyncGenerator<ModelEvent> {
    // Take exclusive stream ownership synchronously, before any socket work, so
    // two concurrent streams cannot both open sockets: the second queues until
    // the first releases. One stream therefore owns the session's socket for its
    // whole lifetime, and every reset / continuation write below is conditional
    // on that ownership. Acquisition is abortable: an aborted waiter leaves the
    // queue at once instead of waiting for the owner to exit.
    while (this.streamOwner !== null) {
      if (this.closed || request.signal?.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        let onAbort: (() => void) | undefined;
        const entry = {
          wake: () => {
            if (onAbort) request.signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        onAbort = () => {
          const index = this.streamWaiters.indexOf(entry);
          if (index !== -1) this.streamWaiters.splice(index, 1);
          reject(abortError());
        };
        this.streamWaiters.push(entry);
        request.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (this.closed || request.signal?.aborted) throw abortError();
    this.streamOwner = owner;
    // Explicit owner cleanup on request abort or session close even while the
    // generator is suspended: a dropped suspended iterator must not hold the
    // owner token and starve every queued stream.
    const onOwnerAbort = () => {
      if (this.streamOwner !== owner) return;
      this.resetSocket();
      const connecting = this.connectingSocket;
      this.connectingSocket = null;
      if (connecting) {
        try {
          connecting.close(1000, "client reset");
        } catch {
          // Best-effort.
        }
      }
      this.releaseStream(owner);
    };
    request.signal?.addEventListener("abort", onOwnerAbort, { once: true });
    try {
      yield* this.streamOwned(owner, request, buildFullBody, replayReasoning);
    } finally {
      request.signal?.removeEventListener("abort", onOwnerAbort);
      this.abandonedOwners.delete(owner);
      this.handshakeCancels.delete(owner);
      this.releaseStream(owner);
    }
  }

  /**
   * Actively interrupt the owned stream: mark the owner as being cancelled
   * BEFORE closing anything (per-owner, so a stream that takes over right
   * away never misreads the old owner's shutdown as its own cancellation),
   * reject its pending handshake and frame read, and release ownership
   * (LOCAL-009). Only `ResponsesWsStreamHandle` calls this, for the stream
   * it wraps.
   */
  interruptOwnedRead(owner: object): void {
    if (this.streamOwner !== owner) return;
    this.abandonedOwners.add(owner);
    const connecting = this.connectingSocket;
    this.resetSocket();
    this.connectingSocket = null;
    if (connecting) {
      try {
        connecting.close(1000, "client reset");
      } catch {
        // Best-effort.
      }
    }
    // Fail the owner's pending handshake directly: the socket above may
    // never dispatch open, error, or close (a wedged endpoint), and a
    // `return()` must free the stream and its queue without waiting for
    // the connect timeout (LOCAL-009).
    const handshakeCancel = this.handshakeCancels.get(owner);
    this.handshakeCancels.delete(owner);
    handshakeCancel?.();
    const readCancel = this.readCancel;
    this.readCancel = null;
    // The mark stays until the cancelled generator finally unwinds
    // (runStream's finally): it is keyed to this owner only, so a stream that
    // takes over right away never misreads the old owner's shutdown as its
    // own cancellation, while the interrupted stream's pending continuations
    // (a resolved-but-not-run handshake, a suspended frame read) still see
    // their cancellation on every recheck (LOCAL-009).
    this.releaseStream(owner);
    readCancel?.();
  }

  private releaseStream(owner: object): void {
    if (this.streamOwner !== owner) return;
    this.streamOwner = null;
    for (const entry of this.streamWaiters.splice(0)) entry.wake();
  }

  private ownsStream(owner: object): boolean {
    return this.streamOwner === owner;
  }

  private async *streamOwned(
    owner: object,
    request: ChatRequest,
    buildFullBody: (replayReasoning: boolean) => Record<string, unknown>,
    replayReasoning: boolean,
  ): AsyncGenerator<ModelEvent> {
    const url = responsesWsUrl(request.baseUrl);
    const transcript = request.transcript ?? [];
    const fullBody = buildFullBody(replayReasoning);
    // Strip HTTP-only `stream` flag for WebSocket `response.create`.
    const { stream: _stream, ...wsBase } = fullBody;
    const configKey = JSON.stringify({
      url,
      model: wsBase.model,
      effort: wsBase.reasoning,
      tools: wsBase.tools,
      toolChoice: wsBase.tool_choice,
      parallelToolCalls: wsBase.parallel_tool_calls,
      include: wsBase.include,
      promptCacheKey: wsBase.prompt_cache_key,
      replayReasoning,
    });

    let reconnectedAfterDrop = false;
    let retriedFullChain = false;

    for (;;) {
      if (request.signal?.aborted) throw abortError();
      const { socket, reused } = await this.ensureOpen(url, request.apiKey, request.signal, owner);
      // The signal may have aborted, the session closed, the owner returned,
      // or ownership changed between the open event and the handshake resuming:
      // never send a request on a dead signal, a closed session, or a socket
      // this stream no longer owns.
      if (request.signal?.aborted || this.closed || !this.ownsStream(owner) || this.abandonedOwners.has(owner)) {
        if (this.ownsSocket(owner, socket)) this.resetSocket();
        throw abortError();
      }
      const delta = reused ? this.continuationDelta(transcript, configKey) : null;
      let payload: Record<string, unknown>;
      let usedContinuation = false;

      if (delta !== null && this.lastResponseId !== null) {
        const deltaInput: ResponsesItem[] = buildResponsesInput(delta, request.quirks, {
          replayReasoning,
          leadingSystemAsReminder: true,
        }).input;
        if (deltaInput.length > 0) {
          const { instructions: _instructions, input: _fullInput, ...rest } = wsBase;
          payload = {
            type: "response.create",
            ...rest,
            previous_response_id: this.lastResponseId,
            input: deltaInput,
          };
          usedContinuation = true;
        } else {
          this.resetChain();
          payload = { type: "response.create", ...wsBase };
        }
      } else {
        this.resetChain();
        payload = { type: "response.create", ...wsBase };
      }

      const reducer = new ResponsesEventReducer();
      let emitted = false;
      type Frame =
        | { readonly kind: "message"; readonly data: unknown }
        | { readonly kind: "closed"; readonly message: string }
        | { readonly kind: "abort" };
      const queue: Frame[] = [];
      let wake: (() => void) | null = null;
      const enqueue = (frame: Frame) => {
        queue.push(frame);
        const fn = wake;
        wake = null;
        fn?.();
      };
      const onMessage = (event: { readonly data: unknown }) => enqueue({ kind: "message", data: event.data });
      const onError = () => enqueue({ kind: "closed", message: "The model endpoint dropped the WebSocket connection." });
      const onClose = (event: { readonly code?: number; readonly reason?: string }) => {
        const detail = event.reason ? ` (${event.code ?? 0}: ${event.reason})` : event.code ? ` (${event.code})` : "";
        enqueue({ kind: "closed", message: `The model endpoint closed the WebSocket connection${detail}.` });
      };
      const onAbort = () => enqueue({ kind: "abort" });

      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      let terminalConsumed = false;

      try {
        // Serialize first, then recheck cancellation and ownership immediately
        // before sending: a payload whose toJSON() aborts the request, or an
        // abort that landed while the listeners were being attached, must not
        // leave a request pending on the socket.
        const wire = JSON.stringify(payload);
        if (request.signal?.aborted || this.closed || !this.ownsStream(owner) || this.abandonedOwners.has(owner)) {
          if (this.ownsSocket(owner, socket)) this.resetSocket();
          throw abortError();
        }
        try {
          socket.send(wire);
        } catch (cause) {
          if (this.ownsSocket(owner, socket)) this.resetSocket();
          if (reused && !reconnectedAfterDrop) {
            reconnectedAfterDrop = true;
            continue;
          }
          throw new ChatHttpError(
            `Could not send Responses WebSocket request: ${cause instanceof Error ? cause.message : String(cause)}`,
            null,
            false,
            true,
          );
        }

        let retryReason: "reconnect" | "full-chain" | null = null;
        // Cancellation settled anywhere (an aborted request, a released owner
        // token, an active return()): no buffered frame — terminal or not — may
        // be consumed or yielded as this stream's output afterwards; the close
        // it triggered was this stream's own cancellation, never a transport
        // failure (LOCAL-009).
        const cancelled = (): boolean =>
          request.signal?.aborted === true || !this.ownsStream(owner) || this.abandonedOwners.has(owner);

        while (reducer.finish === null) {
          if (cancelled()) {
            if (this.ownsSocket(owner, socket)) this.resetSocket();
            throw abortError();
          }
          if (queue.length === 0) {
            await new Promise<void>((resolve, reject) => {
              wake = resolve;
              // An actively abandoned owner interrupts this read instead of
              // waiting for a socket that may never speak (LOCAL-009).
              this.readCancel = () => {
                this.readCancel = null;
                wake = null;
                reject(abortError());
              };
            });
            this.readCancel = null;
            // The interrupt (or one it synchronously closed) may have woken
            // this read with a buffered "closed" frame: never consume it as a
            // transport failure — cancellation wins.
            if (cancelled()) {
              if (this.ownsSocket(owner, socket)) this.resetSocket();
              throw abortError();
            }
          }
          const frame = queue.shift()!;
          if (frame.kind === "abort") {
            if (this.ownsSocket(owner, socket)) this.resetSocket();
            throw abortError();
          }
          if (frame.kind === "closed") {
            if (this.ownsSocket(owner, socket)) this.resetSocket();
            if (reused && !emitted && !reconnectedAfterDrop) {
              reconnectedAfterDrop = true;
              retryReason = "reconnect";
              break;
            }
            throw new ChatHttpError(frame.message, null, false, true);
          }
          const text = await decodeSocketData(frame.data);
          if (cancelled()) {
            if (this.ownsSocket(owner, socket)) this.resetSocket();
            throw abortError();
          }
          if (!text) continue;
          let event: Record<string, unknown> | null;
          try {
            event = asRecord(JSON.parse(text));
          } catch {
            continue;
          }
          if (!event) continue;

          try {
            const events = reducer.push(event);
            for (const modelEvent of events) {
              if (cancelled()) {
                if (this.ownsSocket(owner, socket)) this.resetSocket();
                throw abortError();
              }
              emitted = true;
              yield modelEvent;
            }
          } catch (error) {
            if (error instanceof ChatHttpError && !emitted) {
              if (error.errorCode === "previous_response_not_found" && usedContinuation && !retriedFullChain) {
                if (this.ownsStream(owner)) this.resetChain();
                retriedFullChain = true;
                retryReason = "full-chain";
                break;
              }
              if (error.errorCode === "websocket_connection_limit_reached" && !reconnectedAfterDrop) {
                if (this.ownsSocket(owner, socket)) this.resetSocket();
                reconnectedAfterDrop = true;
                retryReason = "reconnect";
                break;
              }
            }
            if (this.ownsStream(owner)) this.resetChain();
            throw error;
          }
        }

        // The while loop only falls through on a terminal response frame; every
        // break (retry, error, abort) leaves terminalConsumed false.
        terminalConsumed = reducer.finish !== null;

        if (retryReason !== null) continue;

        // A cancellation that raced the terminal frame (an abort after the
        // response completed, before the suspended consumer resumed) must not
        // deliver a buffered finish as this stream's output, and must not
        // record the continuation chain for a dead stream (LOCAL-009).
        if (cancelled()) {
          if (this.ownsStream(owner)) this.resetChain();
          throw abortError();
        }

        if (reducer.completed && reducer.responseId !== null) {
          // Continuation writes are conditional on ownership: a stream that lost
          // its socket must not record a chain it cannot continue.
          if (this.ownsSocket(owner, socket)) {
            this.lastResponseId = reducer.responseId;
            this.sentPrefix = transcript.slice();
            this.lastConfigKey = configKey;
          } else if (this.ownsStream(owner)) {
            this.resetChain();
          }
        } else if (this.ownsStream(owner)) {
          this.resetChain();
        }
        if (reducer.usage) yield { type: "usage", usage: reducer.usage };
        yield { type: "finish", reason: reducer.finish! };
        return;
      } finally {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        request.signal?.removeEventListener("abort", onAbort);
        // Unless a terminal response frame was consumed (the request completed
        // normally), close and reset the socket — but only while this stream
        // still owns it, so a stale iterator can never close a newer stream's
        // socket. Resetting also clears the previous_response_id chain, so the
        // next request on the fresh socket sends the full input again.
        if (!terminalConsumed && this.ownsSocket(owner, socket)) this.resetSocket();
      }
    }
  }
}

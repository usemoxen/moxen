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
  }

  private async ensureOpen(url: string, apiKey: string | undefined, signal?: AbortSignal): Promise<{ readonly socket: ResponsesSocket; readonly reused: boolean }> {
    if (this.closed) throw abortError();
    if (signal?.aborted) throw abortError();
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

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
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
        reject(err);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        this.disabled = true;
        fail(new ResponsesWsUpgradeError("Could not open Responses WebSocket connection."));
      };
      const onClose = (event: { readonly code?: number; readonly reason?: string }) => {
        this.disabled = true;
        fail(new ResponsesWsUpgradeError(`Responses WebSocket closed during handshake (${event.code ?? 0}).`));
      };
      const onAbort = () => fail(abortError());
      timer = setTimeout(() => {
        this.disabled = true;
        fail(new ResponsesWsUpgradeError("Timed out opening Responses WebSocket connection."));
      }, this.connectTimeoutMs);
      timer.unref?.();
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (socket.readyState === WS_OPEN) onOpen();
    });

    this.socket = socket;
    this.connectedUrl = url;
    this.connectedApiKey = apiKey;
    this.connectedAt = this.now();
    return { socket, reused: false };
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

  async *stream(
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
      const { socket, reused } = await this.ensureOpen(url, request.apiKey, request.signal);
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

      try {
        try {
          socket.send(JSON.stringify(payload));
        } catch (cause) {
          this.resetSocket();
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

        while (reducer.finish === null) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const frame = queue.shift()!;
          if (frame.kind === "abort") {
            this.resetSocket();
            throw abortError();
          }
          if (frame.kind === "closed") {
            this.resetSocket();
            if (reused && !emitted && !reconnectedAfterDrop) {
              reconnectedAfterDrop = true;
              retryReason = "reconnect";
              break;
            }
            throw new ChatHttpError(frame.message, null, false, true);
          }
          const text = await decodeSocketData(frame.data);
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
              emitted = true;
              yield modelEvent;
            }
          } catch (error) {
            if (error instanceof ChatHttpError && !emitted) {
              if (error.errorCode === "previous_response_not_found" && usedContinuation && !retriedFullChain) {
                this.resetChain();
                retriedFullChain = true;
                retryReason = "full-chain";
                break;
              }
              if (error.errorCode === "websocket_connection_limit_reached" && !reconnectedAfterDrop) {
                this.resetSocket();
                reconnectedAfterDrop = true;
                retryReason = "reconnect";
                break;
              }
            }
            this.resetChain();
            throw error;
          }
        }

        if (retryReason !== null) continue;

        if (reducer.completed && reducer.responseId !== null) {
          this.lastResponseId = reducer.responseId;
          this.sentPrefix = transcript.slice();
          this.lastConfigKey = configKey;
        } else {
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
      }
    }
  }
}

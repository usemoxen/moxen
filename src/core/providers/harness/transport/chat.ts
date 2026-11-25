/**
 * OpenAI-compatible Chat Completions over SSE, reduced to `ModelEvent`s.
 *
 * Servers disagree on small things this file absorbs so the loop never sees
 * them: which field carries reasoning (`reasoning_content`, `reasoning`,
 * `reasoning_text`), whether reasoning arrives in a field or as `<think>` tags
 * inside the content, whether usage comes in the last chunk, how tool-call
 * arguments are split across chunks, and what `finish_reason` is spelled.
 * It sends the profile's credentials and nothing else about the user.
 */
import { CliError } from "../../../errors.js";
import type { HarnessApiFormat } from "../../../types.js";
import { chatCompletionsUrl } from "../profiles.js";
import type { ModelQuirks } from "../quirks.js";
import type { WireMessage } from "../normalize.js";
import type { ResponsesWsSession } from "./responses-ws.js";
import type { FinishReason, ModelEvent, ModelUsage, ToolCall, ToolDefinition, TranscriptMessage } from "../types.js";

export interface ChatRequest {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  /** Chat wire messages. Only the chat format reads them; the others build their own from `transcript`. */
  readonly messages: readonly WireMessage[];
  /** The conversation itself, for the formats that shape it differently (`transport/anthropic.ts`, `responses.ts`). */
  readonly transcript?: readonly TranscriptMessage[] | undefined;
  /** Which wire format the request goes out in; chat when absent. */
  readonly format?: HarnessApiFormat | undefined;
  readonly tools: readonly ToolDefinition[];
  readonly quirks: ModelQuirks;
  readonly sampling?: { temperature?: number; topP?: number; topK?: number; minP?: number } | undefined;
  readonly maxTokens?: number | undefined;
  /** The reasoning effort the user picked, sent through `quirks.effortParam` / `effortKwarg` when the server takes one. */
  readonly effort?: string | undefined;
  /**
   * "none": the tools are described to the server (so the prompt matches the
   * conversation's and its cache applies) but the model may not call one.
   */
  readonly toolChoice?: "none" | undefined;
  /** Stable per-session key sent as `prompt_cache_key` on OpenAI Responses requests to improve cache affinity. */
  readonly promptCacheKey?: string | undefined;
  /** Persistent per-session WebSocket connection for OpenAI Responses API continuation (`previous_response_id`). */
  readonly responsesSession?: ResponsesWsSession | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Sees each raw stream delta before it is reduced; the probe reads which reasoning field a server uses from it. */
  readonly onDelta?: ((delta: Record<string, unknown>) => void) | undefined;
}

export const SUBSCRIPTION_SHARING_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

/** A failed request, classified so the loop can decide between retrying, compacting and giving up. */
export class ChatHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The prompt did not fit the model's window. */
    readonly contextOverflow: boolean,
    readonly retryable: boolean,
    /** How long the server asked us to wait (`Retry-After`), when it did. */
    readonly retryAfterMs: number | null = null,
    /** Provider-specific machine error code when supplied (e.g. `subscription_sharing_usage_limit_exceeded`). */
    readonly errorCode: string | null = null,
  ) {
    super(message);
    this.name = "ChatHttpError";
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; `retry-after-ms` too, which some APIs send. Null when absent or unreadable. */
export function retryAfterOf(headers: Headers, now: number = Date.now()): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") !== null && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const MAX_RETRY_WAIT_MS = 120_000;

/** The wait before attempt `attempt + 1`: what the server asked for (capped), else exponential, with jitter so parallel sessions do not retry in step. */
export function retryDelayMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs + Math.round(random() * 250), MAX_RETRY_WAIT_MS);
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export const OVERFLOW = /context (?:length|window|size)|too (?:long|many tokens|large)|exceed(?:s|ed)? .*(?:context|token|limit)|maximum context|n_ctx|prompt is too long/i;

export function chatRequestBody(request: ChatRequest): Record<string, unknown> {
  const { quirks } = request;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (!quirks.omitToolChoice) body.tool_choice = request.toolChoice ?? "auto";
    if (!quirks.parallelToolCalls) body.parallel_tool_calls = false;
  }
  const { sampling } = request;
  if (sampling?.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling?.topP !== undefined) body.top_p = sampling.topP;
  if (sampling?.topK !== undefined) body.top_k = sampling.topK;
  if (sampling?.minP !== undefined) body.min_p = sampling.minP;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  const kwargs: Record<string, unknown> = { ...quirks.chatTemplateKwargs };
  if (request.effort) {
    if (quirks.effortKwarg) kwargs[quirks.effortKwarg] = request.effort;
    if (quirks.effortParam) body[quirks.effortParam] = request.effort;
  }
  if (Object.keys(kwargs).length > 0) body.chat_template_kwargs = kwargs;
  return body;
}

/** Splits `<think>…</think>` out of streamed content, tolerating tags cut across chunks. */
export class ThinkTagSplitter {
  #buffer = "";
  #inside = false;

  /** Feed a chunk; get back what is reasoning and what is answer text. */
  push(chunk: string): Array<{ kind: "reasoning" | "text"; text: string }> {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  flush(): Array<{ kind: "reasoning" | "text"; text: string }> {
    return this.#drain(true);
  }

  #drain(final: boolean): Array<{ kind: "reasoning" | "text"; text: string }> {
    const out: Array<{ kind: "reasoning" | "text"; text: string }> = [];
    const emit = (kind: "reasoning" | "text", text: string): void => {
      if (text !== "") out.push({ kind, text });
    };
    for (;;) {
      const tag = this.#inside ? "</think>" : "<think>";
      const at = this.#buffer.indexOf(tag);
      if (at >= 0) {
        emit(this.#inside ? "reasoning" : "text", this.#buffer.slice(0, at));
        this.#buffer = this.#buffer.slice(at + tag.length);
        this.#inside = !this.#inside;
        continue;
      }
      // Hold back a tail that could be the start of the tag until more text arrives.
      let keep = 0;
      if (!final) {
        for (let length = Math.min(tag.length - 1, this.#buffer.length); length > 0; length -= 1) {
          if (tag.startsWith(this.#buffer.slice(this.#buffer.length - length))) {
            keep = length;
            break;
          }
        }
      }
      emit(this.#inside ? "reasoning" : "text", this.#buffer.slice(0, this.#buffer.length - keep));
      this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
      return out;
    }
  }
}

/** The data payloads of an SSE stream, one per event, whatever the chunk boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const split = /\r?\n\r?\n/.exec(buffer);
        if (!split) break;
        const event = buffer.slice(0, split.index);
        buffer = buffer.slice(split.index + split[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data !== "") yield data;
      }
    }
    const rest = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (rest !== "") yield rest;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(chunk: Record<string, unknown>): ModelUsage | null {
  const usage = asRecord(chunk.usage);
  if (!usage) return null;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const timings = asRecord(chunk.timings);
  return {
    inputTokens: asNumber(usage.prompt_tokens),
    outputTokens: asNumber(usage.completion_tokens),
    // llama.cpp reports the prefix-cache hit as `cache_n` in `timings`; OpenAI as `cached_tokens`.
    cachedInputTokens: asNumber(promptDetails?.cached_tokens) || asNumber(timings?.cache_n),
    reasoningTokens: asNumber(completionDetails?.reasoning_tokens),
  };
}

function finishFrom(raw: unknown, hadToolCalls: boolean): FinishReason {
  if (hadToolCalls) return "tool-calls";
  switch (raw) {
    case "length":
      return "length";
    case "content_filter":
      return "filter";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    default:
      return "stop";
  }
}

function reasoningDelta(delta: Record<string, unknown>): string {
  for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
    const value = delta[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

export async function failureFrom(response: Response): Promise<ChatHttpError> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 2000);
  } catch {
    // The status is enough when the body cannot be read.
  }
  let detail = text;
  let errorCode: string | null = null;
  try {
    const parsed = asRecord(JSON.parse(text));
    const error = asRecord(parsed?.error);
    detail = typeof error?.message === "string" ? error.message : typeof parsed?.message === "string" ? parsed.message : text;
    if (typeof error?.code === "string" && error.code.trim() !== "") errorCode = error.code.trim();
    else if (typeof error?.type === "string" && error.type.trim() !== "") errorCode = error.type.trim();
    else if (typeof parsed?.code === "string" && parsed.code.trim() !== "") errorCode = parsed.code.trim();
  } catch {
    // Not JSON; keep the raw text.
  }
  if (
    response.status === 429 &&
    (errorCode === SUBSCRIPTION_SHARING_LIMIT_CODE ||
      text.includes(SUBSCRIPTION_SHARING_LIMIT_CODE) ||
      detail.includes(SUBSCRIPTION_SHARING_LIMIT_CODE))
  ) {
    return new ChatHttpError(
      "ChatGPT per-app weekly usage limit reached for Moxen (subscription_sharing_usage_limit_exceeded). Adjust Moxen's weekly allowance or extra credits in ChatGPT Settings → Usage → App limits. Your overall ChatGPT plan may still have remaining usage.",
      response.status,
      false,
      false,
      null,
      SUBSCRIPTION_SHARING_LIMIT_CODE,
    );
  }
  const overflow = (response.status === 400 || response.status === 413 || response.status === 422) && OVERFLOW.test(detail);
  const retryable = !overflow && (response.status === 408 || response.status === 429 || response.status >= 500);
  const message = `The model endpoint answered ${response.status}${detail ? `: ${detail.trim().slice(0, 500)}` : "."}`;
  return new ChatHttpError(message, response.status, overflow, retryable, retryable ? retryAfterOf(response.headers) : null, errorCode);
}

/**
 * One request, streamed. Tool calls are held until their arguments are
 * complete and sent after the text, in the order the model started them, then
 * usage, then `finish`. Throws `ChatHttpError` for HTTP failures and for a
 * dropped connection; an aborted signal ends the stream with an `AbortError`.
 */
export async function* streamChat(request: ChatRequest): AsyncGenerator<ModelEvent> {
  const doFetch = request.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
  let response: Response;
  try {
    response = await doFetch(chatCompletionsUrl(request.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(chatRequestBody(request)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new ChatHttpError(`Could not reach the model endpoint: ${(error as Error).message}`, null, false, true);
  }
  if (!response.ok) throw await failureFrom(response);
  if (!response.body) throw new ChatHttpError("The model endpoint sent no body.", response.status, false, true);

  const splitter = new ThinkTagSplitter();
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: ModelUsage | null = null;
  let rawFinish: unknown = null;

  try {
    for await (const data of sseData(response.body)) {
      if (data.trim() === "[DONE]") break;
      let chunk: Record<string, unknown> | null;
      try {
        chunk = asRecord(JSON.parse(data));
      } catch {
        continue; // keep-alive or a partial line; the next event carries on
      }
      if (!chunk) continue;
      const error = asRecord(chunk.error);
      if (error) {
        const message = typeof error.message === "string" ? error.message : "The model endpoint reported an error.";
        throw new ChatHttpError(message, null, OVERFLOW.test(message), false);
      }
      usage = usageFrom(chunk) ?? usage;
      const choice = asRecord(Array.isArray(chunk.choices) ? chunk.choices[0] : null);
      if (!choice) continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) rawFinish = choice.finish_reason;
      const delta = asRecord(choice.delta);
      if (!delta) continue;
      request.onDelta?.(delta);
      const reasoning = reasoningDelta(delta);
      if (reasoning !== "") yield { type: "reasoning.delta", text: reasoning };
      if (typeof delta.content === "string" && delta.content !== "") {
        for (const piece of splitter.push(delta.content)) {
          yield piece.kind === "reasoning" ? { type: "reasoning.delta", text: piece.text } : { type: "text.delta", text: piece.text };
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const entry = asRecord(raw);
          if (!entry) continue;
          const index = typeof entry.index === "number" ? entry.index : calls.size;
          const fn = asRecord(entry.function);
          const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof entry.id === "string" && entry.id !== "") existing.id = entry.id;
          if (typeof fn?.name === "string") existing.name += fn.name;
          if (typeof fn?.arguments === "string") existing.arguments += fn.arguments;
          calls.set(index, existing);
        }
      }
    }
  } catch (error) {
    if (request.signal?.aborted || error instanceof ChatHttpError) throw error;
    throw new ChatHttpError(`The model endpoint dropped the connection: ${(error as Error).message}`, null, false, true);
  }

  for (const piece of splitter.flush()) {
    yield piece.kind === "reasoning" ? { type: "reasoning.delta", text: piece.text } : { type: "text.delta", text: piece.text };
  }
  const finished: ToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call], position) => ({
      id: call.id !== "" ? call.id : `call_${position}_${Math.random().toString(36).slice(2, 10)}`,
      name: call.name,
      arguments: call.arguments === "" ? "{}" : call.arguments,
    }))
    .filter((call) => call.name !== "");
  for (const call of finished) yield { type: "tool.call", call };
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: finishFrom(rawFinish, finished.length > 0) };
}

/** Wrap a transport failure that reached the user as a plain error. */
export function chatErrorToCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ChatHttpError) {
    if (error.errorCode === SUBSCRIPTION_SHARING_LIMIT_CODE) {
      return new CliError("CHATGPT_APP_LIMIT_EXCEEDED", error.message, {
        details: { status: error.status, code: error.errorCode },
      });
    }
    return new CliError("HARNESS_REQUEST_FAILED", error.message, { details: { status: error.status } });
  }
  return new CliError("HARNESS_REQUEST_FAILED", (error as Error).message ?? String(error));
}

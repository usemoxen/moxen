/**
 * Anthropic Messages API over SSE, reduced to `ModelEvent`s. The request is
 * built from the transcript (`normalize-anthropic.ts`); the stream's content
 * blocks become text, reasoning (with the signed blocks kept for replay),
 * tool calls, usage and a finish reason. The key is read by the caller at
 * request time and sent only as `x-api-key`; nothing here puts a URL or a
 * header into an error message.
 */
import { anthropicMessagesUrl } from "../profiles.js";
import { anthropicTools, buildAnthropicInput } from "../normalize-anthropic.js";
import { detectQuirkFamily } from "../quirks.js";
import type { FinishReason, ModelEvent, ModelUsage } from "../types.js";
import { asNumber, asRecord, ChatHttpError, failureFrom, OVERFLOW, sseData, type ChatRequest } from "./chat.js";

export const ANTHROPIC_VERSION = "2023-06-01";
/** `max_tokens` is required by the API; this stands in when the model has no `maxOutput`. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16_000;

const BUDGETS: Readonly<Record<string, number>> = { low: 2048, medium: 8192, high: 16_000, xhigh: 32_000, max: 32_000 };

export function anthropicRequestBody(request: ChatRequest, replayReasoning = true, options?: { readonly omitAdaptiveThinking?: boolean }): Record<string, unknown> {
  const { quirks } = request;
  const { system, messages } = buildAnthropicInput(request.transcript ?? [], quirks, { replayReasoning });
  const maxTokens = request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = { model: request.model, max_tokens: maxTokens, stream: true, messages };
  if (system !== "") body.system = system;
  if (request.tools.length > 0) {
    body.tools = anthropicTools(request.tools);
    if (!quirks.omitToolChoice) {
      if (request.toolChoice === "none") body.tool_choice = { type: "none" };
      else if (!quirks.parallelToolCalls) body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }
  if (quirks.anthropicThinking === "adaptive") {
    const detected = detectQuirkFamily(request.model);
    if (!options?.omitAdaptiveThinking && (detected === "claude" || detected === "generic")) {
      body.thinking = { type: "adaptive", display: "summarized" };
    }
    if (request.effort) body.output_config = { effort: request.effort };
  } else if (quirks.anthropicThinking === "budget" && maxTokens > 1024) {
    // The budget has to stay under max_tokens and is at least 1024.
    body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(BUDGETS[request.effort ?? "medium"] ?? 8192, maxTokens - 1)) };
  }
  const { sampling } = request;
  if (sampling?.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling?.topP !== undefined) body.top_p = sampling.topP;
  if (sampling?.topK !== undefined) body.top_k = sampling.topK;
  if (quirks.cacheControl) body.cache_control = { type: "ephemeral" };
  return body;
}

function finishFrom(raw: unknown): FinishReason {
  switch (raw) {
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "filter";
    default:
      return "stop";
  }
}

interface OpenBlock {
  readonly kind: "text" | "thinking" | "redacted" | "tool" | "other";
  id: string;
  name: string;
  text: string;
  signature: string;
  json: string;
  data: string;
}

async function* once(request: ChatRequest, replayReasoning: boolean, options?: { readonly omitAdaptiveThinking?: boolean }): AsyncGenerator<ModelEvent> {
  const doFetch = request.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", "anthropic-version": ANTHROPIC_VERSION };
  if (request.apiKey) headers["x-api-key"] = request.apiKey;
  let response: Response;
  try {
    response = await doFetch(anthropicMessagesUrl(request.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicRequestBody(request, replayReasoning, options)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new ChatHttpError(`Could not reach the model endpoint: ${(error as Error).message}`, null, false, true);
  }
  if (!response.ok) throw await failureFrom(response);
  if (!response.body) throw new ChatHttpError("The model endpoint sent no body.", response.status, false, true);

  const open = new Map<number, OpenBlock>();
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let stopReason: unknown = null;
  let sawCall = false;
  let finished = false;

  try {
    for await (const data of sseData(response.body)) {
      let event: Record<string, unknown> | null;
      try {
        event = asRecord(JSON.parse(data));
      } catch {
        continue;
      }
      if (!event) continue;
      switch (event.type) {
        case "message_start": {
          const usage = asRecord(asRecord(event.message)?.usage);
          input = asNumber(usage?.input_tokens);
          cacheRead = asNumber(usage?.cache_read_input_tokens);
          cacheWrite = asNumber(usage?.cache_creation_input_tokens);
          output = asNumber(usage?.output_tokens);
          break;
        }
        case "content_block_start": {
          const index = asNumber(event.index);
          const block = asRecord(event.content_block);
          const type = block?.type;
          const kind: OpenBlock["kind"] = type === "text" ? "text" : type === "thinking" ? "thinking" : type === "redacted_thinking" ? "redacted" : type === "tool_use" ? "tool" : "other";
          open.set(index, {
            kind,
            id: typeof block?.id === "string" ? block.id : "",
            name: typeof block?.name === "string" ? block.name : "",
            text: "",
            signature: typeof block?.signature === "string" ? block.signature : "",
            json: "",
            data: typeof block?.data === "string" ? block.data : "",
          });
          // A block that starts with text (some servers) still counts.
          if (kind === "text" && typeof block?.text === "string" && block.text !== "") yield { type: "text.delta", text: block.text };
          break;
        }
        case "content_block_delta": {
          const entry = open.get(asNumber(event.index));
          const delta = asRecord(event.delta);
          if (!entry || !delta) break;
          if (delta.type === "text_delta" && typeof delta.text === "string") yield { type: "text.delta", text: delta.text };
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            entry.text += delta.thinking;
            if (delta.thinking !== "") yield { type: "reasoning.delta", text: delta.thinking };
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string") entry.signature += delta.signature;
          else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") entry.json += delta.partial_json;
          break;
        }
        case "content_block_stop": {
          const index = asNumber(event.index);
          const entry = open.get(index);
          open.delete(index);
          if (!entry) break;
          if (entry.kind === "thinking") {
            // Without a signature the server cannot verify the block, so it is not worth sending back.
            if (entry.signature !== "") yield { type: "reasoning.item", item: { format: "anthropic", item: { type: "thinking", thinking: entry.text, signature: entry.signature } } };
          } else if (entry.kind === "redacted" && entry.data !== "") {
            yield { type: "reasoning.item", item: { format: "anthropic", item: { type: "redacted_thinking", data: entry.data } } };
          } else if (entry.kind === "tool" && entry.name !== "") {
            sawCall = true;
            yield { type: "tool.call", call: { id: entry.id !== "" ? entry.id : `toolu_${index}_${Math.random().toString(36).slice(2, 10)}`, name: entry.name, arguments: entry.json.trim() === "" ? "{}" : entry.json } };
          }
          break;
        }
        case "message_delta": {
          const delta = asRecord(event.delta);
          if (delta && delta.stop_reason !== undefined && delta.stop_reason !== null) stopReason = delta.stop_reason;
          const usage = asRecord(event.usage);
          if (usage) {
            // Cumulative for the response; the fields a server leaves out keep what message_start said.
            if (usage.output_tokens !== undefined) output = asNumber(usage.output_tokens);
            if (usage.input_tokens !== undefined && asNumber(usage.input_tokens) > 0) input = asNumber(usage.input_tokens);
            if (usage.cache_read_input_tokens !== undefined) cacheRead = asNumber(usage.cache_read_input_tokens);
            if (usage.cache_creation_input_tokens !== undefined) cacheWrite = asNumber(usage.cache_creation_input_tokens);
          }
          break;
        }
        case "message_stop":
          finished = true;
          break;
        case "error": {
          const error = asRecord(event.error);
          const message = typeof error?.message === "string" ? error.message : "The model endpoint reported an error.";
          // An overloaded server says so in the stream; nothing has been used yet when it does so before output, which is the caller's call.
          throw new ChatHttpError(message, null, OVERFLOW.test(message), error?.type === "overloaded_error" || error?.type === "api_error");
        }
        default:
          break;
      }
      if (finished) break;
    }
  } catch (error) {
    if (request.signal?.aborted || error instanceof ChatHttpError) throw error;
    throw new ChatHttpError(`The model endpoint dropped the connection: ${(error as Error).message}`, null, false, true);
  }
  if (!finished && stopReason === null) throw new ChatHttpError("The model endpoint ended the stream before the reply was complete.", null, false, true);

  const usage: ModelUsage = { inputTokens: input + cacheRead + cacheWrite, outputTokens: output, cachedInputTokens: cacheRead, reasoningTokens: 0 };
  yield { type: "usage", usage };
  yield { type: "finish", reason: sawCall && stopReason !== "max_tokens" ? "tool-calls" : finishFrom(stopReason) };
}

/** Whether a refused request is the server rejecting reasoning blocks it was sent or Claude's adaptive thinking object. */
const THINKING_REJECTED = /thinking|signature|adaptive|display/i;
const ADAPTIVE_THINKING_REJECTED = /adaptive|display|thinking\.type/i;

export async function* streamAnthropic(request: ChatRequest): AsyncGenerator<ModelEvent> {
  const sentReasoning = (request.transcript ?? []).some((message) => message.role === "assistant" && (message.reasoningItems?.length ?? 0) > 0);
  // The server checks the signed blocks it is sent, and non-Claude Anthropic gateways may reject Claude's adaptive thinking object. If refused before output, retry without the rejected thinking field or replayed blocks.
  const iterator = once(request, true);
  let first = true;
  try {
    for await (const event of iterator) {
      first = false;
      yield event;
    }
  } catch (error) {
    if (first && error instanceof ChatHttpError && error.status === 400 && THINKING_REJECTED.test(error.message)) {
      const omitAdaptiveThinking = !sentReasoning || ADAPTIVE_THINKING_REJECTED.test(error.message);
      yield* once(request, false, omitAdaptiveThinking ? { omitAdaptiveThinking: true } : undefined);
      return;
    }
    throw error;
  }
}

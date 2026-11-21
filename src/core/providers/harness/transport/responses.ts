/**
 * OpenAI Responses API over SSE, reduced to `ModelEvent`s. Requests are
 * stateless (`store: false`): the whole conversation goes out each time, and
 * the model's encrypted reasoning comes back (`include`) to be replayed.
 * Servers that implement the Responses shape differ in which events they
 * send, so the parser is tolerant: a function call is taken from its
 * finished output item, falling back to the argument deltas.
 */
import { responsesUrl } from "../profiles.js";
import { buildResponsesInput, responsesTools } from "../normalize-responses.js";
import type { FinishReason, ModelEvent, ModelUsage } from "../types.js";
import { asNumber, asRecord, ChatHttpError, failureFrom, OVERFLOW, sseData, type ChatRequest } from "./chat.js";

export function responsesRequestBody(request: ChatRequest, replayReasoning = true): Record<string, unknown> {
  const { quirks } = request;
  const { instructions, input } = buildResponsesInput(request.transcript ?? [], quirks, { replayReasoning });
  const body: Record<string, unknown> = { model: request.model, input, stream: true, store: false };
  if (instructions !== "") body.instructions = instructions;
  if (request.tools.length > 0) {
    body.tools = responsesTools(request.tools);
    if (!quirks.omitToolChoice) body.tool_choice = request.toolChoice ?? "auto";
    if (!quirks.parallelToolCalls) body.parallel_tool_calls = false;
  }
  if (!quirks.chatgptOAuth && request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
  if (quirks.sendReasoning) {
    body.reasoning = { summary: "auto", ...(request.effort ? { effort: request.effort } : {}) };
    // Without the server keeping the conversation, the only way to give its reasoning back is the encrypted form.
    if (replayReasoning && quirks.reasoningReplay !== "none") body.include = ["reasoning.encrypted_content"];
  }
  const { sampling } = request;
  if (!quirks.chatgptOAuth) {
    if (sampling?.temperature !== undefined) body.temperature = sampling.temperature;
    if (sampling?.topP !== undefined) body.top_p = sampling.topP;
  }
  return body;
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

function failureMessage(value: unknown): string {
  const record = asRecord(value);
  const message = record?.message;
  return typeof message === "string" && message !== "" ? message : "The model endpoint reported an error.";
}

async function* once(request: ChatRequest, replayReasoning: boolean): AsyncGenerator<ModelEvent> {
  const doFetch = request.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
  let response: Response;
  try {
    response = await doFetch(responsesUrl(request.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(responsesRequestBody(request, replayReasoning)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new ChatHttpError(`Could not reach the model endpoint: ${(error as Error).message}`, null, false, true);
  }
  if (!response.ok) throw await failureFrom(response);
  if (!response.body) throw new ChatHttpError("The model endpoint sent no body.", response.status, false, true);

  /** Arguments streamed for a call, by output item id, in case the finished item does not carry them. */
  const streamedArguments = new Map<string, string>();
  const yieldedCalls = new Set<string>();
  let sawCall = false;
  let usage: ModelUsage | null = null;
  let finish: FinishReason | null = null;
  let summaryParts = 0;

  try {
    for await (const data of sseData(response.body)) {
      let event: Record<string, unknown> | null;
      try {
        event = asRecord(JSON.parse(data));
      } catch {
        continue;
      }
      if (!event) continue;
      const type = event.type;
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        if (event.delta !== "") yield { type: "text.delta", text: event.delta };
      } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof event.delta === "string") {
        if (event.delta !== "") yield { type: "reasoning.delta", text: event.delta };
      } else if (type === "response.reasoning_summary_part.added") {
        // Separate summary paragraphs the way a reader expects.
        if (summaryParts > 0) yield { type: "reasoning.delta", text: "\n\n" };
        summaryParts += 1;
      } else if (type === "response.function_call_arguments.delta" && typeof event.item_id === "string" && typeof event.delta === "string") {
        streamedArguments.set(event.item_id, `${streamedArguments.get(event.item_id) ?? ""}${event.delta}`);
      } else if (type === "response.output_item.done") {
        const item = asRecord(event.item);
        if (item?.type === "function_call" && typeof item.name === "string") {
          const id = typeof item.call_id === "string" && item.call_id !== "" ? item.call_id : typeof item.id === "string" ? item.id : `call_${yieldedCalls.size}`;
          if (!yieldedCalls.has(id)) {
            yieldedCalls.add(id);
            sawCall = true;
            const args = typeof item.arguments === "string" && item.arguments.trim() !== "" ? item.arguments : (streamedArguments.get(typeof item.id === "string" ? item.id : "") ?? "");
            yield { type: "tool.call", call: { id, name: item.name, arguments: args.trim() === "" ? "{}" : args } };
          }
        } else if (item?.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content !== "") {
          // The server-side id and status are left out: the next request does not store anything for them to point at.
          yield { type: "reasoning.item", item: { format: "responses", item: { type: "reasoning", summary: Array.isArray(item.summary) ? item.summary : [], encrypted_content: item.encrypted_content } } };
          summaryParts = 0;
        }
      } else if (type === "response.completed" || type === "response.incomplete") {
        const done = asRecord(event.response) ?? {};
        usage = usageFrom(done) ?? usage;
        const reason = asRecord(done.incomplete_details)?.reason;
        finish = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "filter" : sawCall ? "tool-calls" : "stop";
        break;
      } else if (type === "response.failed") {
        const message = failureMessage(asRecord(event.response)?.error);
        throw new ChatHttpError(message, null, OVERFLOW.test(message), false);
      } else if (type === "error") {
        const message = failureMessage(event);
        throw new ChatHttpError(message, null, OVERFLOW.test(message), false);
      }
    }
  } catch (error) {
    if (request.signal?.aborted || error instanceof ChatHttpError) throw error;
    throw new ChatHttpError(`The model endpoint dropped the connection: ${(error as Error).message}`, null, false, true);
  }
  if (finish === null) throw new ChatHttpError("The model endpoint ended the stream before the reply was complete.", null, false, true);
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: finish };
}

const REASONING_REJECTED = /reasoning|encrypted|item.*not found|not persisted/i;

export async function* streamResponses(request: ChatRequest): AsyncGenerator<ModelEvent> {
  const sentReasoning = (request.transcript ?? []).some((message) => message.role === "assistant" && (message.reasoningItems?.length ?? 0) > 0);
  if (!sentReasoning) {
    yield* once(request, true);
    return;
  }
  // If the server refuses the replayed reasoning (a different model wrote it, or the key changed), the conversation goes again without it.
  let first = true;
  try {
    for await (const event of once(request, true)) {
      first = false;
      yield event;
    }
  } catch (error) {
    if (first && error instanceof ChatHttpError && error.status === 400 && REASONING_REJECTED.test(error.message)) {
      yield* once(request, false);
      return;
    }
    throw error;
  }
}

/**
 * OpenAI Responses API over persistent WebSocket (when enabled for Sign in with
 * ChatGPT) or HTTP SSE, reduced to `ModelEvent`s. Requests are stateless
 * (`store: false`): over HTTP the whole conversation goes out each time with
 * sealed reasoning replayed; over WebSocket the connection retains in-memory
 * `previous_response_id` state so follow-up steps send only new items and keep
 * prompt-cache affinity.
 */
import { responsesUrl } from "../profiles.js";
import { buildResponsesInput, responsesTools } from "../normalize-responses.js";
import type { ModelEvent } from "../types.js";
import { asRecord, ChatHttpError, failureFrom, sseData, type ChatRequest } from "./chat.js";
import { ResponsesEventReducer, ResponsesWsUpgradeError } from "./responses-ws.js";

/** GPT-6.2+ appends top-level `instructions` after `input` uncached; put static instructions in a leading `developer` message instead. */
function usesDeveloperInstructions(request: ChatRequest): boolean {
  return request.quirks.chatgptOAuth || /^gpt-6\.2(?:[.\-]|$)/i.test(request.model.trim());
}

export function responsesRequestBody(request: ChatRequest, replayReasoning = true): Record<string, unknown> {
  const { quirks } = request;
  const developerInstructions = usesDeveloperInstructions(request);
  const { instructions, input } = buildResponsesInput(request.transcript ?? [], quirks, {
    replayReasoning,
    developerInstructions,
  });
  const body: Record<string, unknown> = { model: request.model, input, stream: true, store: false };
  if (instructions !== "") body.instructions = instructions;
  if (request.promptCacheKey && request.promptCacheKey.trim() !== "") {
    body.prompt_cache_key = request.promptCacheKey.trim();
  }
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

async function* onceHttp(request: ChatRequest, replayReasoning: boolean): AsyncGenerator<ModelEvent> {
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

  const reducer = new ResponsesEventReducer();

  try {
    for await (const data of sseData(response.body)) {
      let event: Record<string, unknown> | null;
      try {
        event = asRecord(JSON.parse(data));
      } catch {
        continue;
      }
      if (!event) continue;
      for (const modelEvent of reducer.push(event)) yield modelEvent;
      if (reducer.finish !== null) break;
    }
  } catch (error) {
    if (request.signal?.aborted || error instanceof ChatHttpError) throw error;
    throw new ChatHttpError(`The model endpoint dropped the connection: ${(error as Error).message}`, null, false, true);
  }
  if (reducer.finish === null) throw new ChatHttpError("The model endpoint ended the stream before the reply was complete.", null, false, true);
  if (reducer.usage) yield { type: "usage", usage: reducer.usage };
  yield { type: "finish", reason: reducer.finish };
}

async function* once(request: ChatRequest, replayReasoning: boolean): AsyncGenerator<ModelEvent> {
  const ws = request.responsesSession;
  const useWs =
    ws !== undefined &&
    !ws.isDisabled &&
    request.quirks.chatgptOAuth &&
    (!request.fetch || ws.hasCustomFactory);
  if (useWs) {
    try {
      yield* ws.stream(request, (replay) => responsesRequestBody(request, replay), replayReasoning);
      return;
    } catch (error) {
      if (!(error instanceof ResponsesWsUpgradeError)) throw error;
      // WebSocket upgrade unavailable on this endpoint/proxy: fall back cleanly to HTTP SSE.
    }
  }
  yield* onceHttp(request, replayReasoning);
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

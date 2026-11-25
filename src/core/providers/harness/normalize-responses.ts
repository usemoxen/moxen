/**
 * Transcript to OpenAI Responses API input. The conversation is sent whole on
 * every request (`store: false`), so nothing refers to an item the server
 * kept: replayed reasoning goes back as its encrypted content without the
 * server-side id, and messages and calls carry none. A round's tool calls are
 * `function_call` items and their results `function_call_output` items.
 */
import { imageDimensionsFromBase64 } from "../../attachments.js";
import { replaysReasoning, portableToolId } from "./normalize-anthropic.js";
import { wrapSystemReminder } from "./normalize.js";
import type { ModelQuirks } from "./quirks.js";
import type { ToolDefinition, TranscriptMessage } from "./types.js";

export type ResponsesItem = Record<string, unknown>;

function validJsonObjectText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? text : "{}";
  } catch {
    return "{}";
  }
}

export interface BuildResponsesInputOptions {
  readonly replayReasoning?: boolean | undefined;
  /**
   * Place leading system instructions as a leading `role: "developer"` message
   * inside `input` instead of top-level `instructions`. Required for prompt
   * caching on GPT-6.2+ (which appends top-level `instructions` after `input`
   * uncached) and keeps the system prompt inside the WebSocket continuation prefix.
   */
  readonly developerInstructions?: boolean | undefined;
  /**
   * Treat leading `system` messages as mid-conversation `<system-reminder>` user
   * items rather than extracting them into `instructions` (used for incremental
   * WebSocket `previous_response_id` continuation deltas).
   */
  readonly leadingSystemAsReminder?: boolean | undefined;
}

export function buildResponsesInput(
  transcript: readonly TranscriptMessage[],
  quirks: ModelQuirks,
  options: BuildResponsesInputOptions = {},
): { instructions: string; input: ResponsesItem[] } {
  const inputImage = (image: { mimeType: string; data: string }): ResponsesItem => {
    const item: ResponsesItem = { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` };
    if (quirks.chatgptOAuth) {
      const size = imageDimensionsFromBase64(image.data);
      // Auto can keep original resolution and reject an oversized image. High asks OpenAI to downsample it.
      if (size && Math.ceil(size.width / 32) * Math.ceil(size.height / 32) > 30_000) item.detail = "high";
    }
    return item;
  };
  const replay = options.replayReasoning !== false;
  const input: ResponsesItem[] = [];
  let index = 0;
  const lead: string[] = [];
  if (!options.leadingSystemAsReminder) {
    while (index < transcript.length && transcript[index]!.role === "system") {
      lead.push((transcript[index] as Extract<TranscriptMessage, { role: "system" }>).content);
      index += 1;
    }
  }
  const leadText = lead.join("\n\n");
  if (options.developerInstructions && leadText !== "") {
    input.push({ role: "developer", content: [{ type: "input_text", text: leadText }] });
  }
  for (; index < transcript.length; index += 1) {
    const message = transcript[index]!;
    switch (message.role) {
      case "system":
        input.push({ role: "user", content: [{ type: "input_text", text: wrapSystemReminder(message.content) }] });
        break;
      case "user": {
        const images = message.images ?? [];
        const mention = quirks.images === "native" || images.length === 0 ? "" : `\n\n${images.map((image) => `[Attached image: ${image.name}]`).join("\n")}`;
        const parts: ResponsesItem[] = [{ type: "input_text", text: `${message.content}${mention}` }];
        if (quirks.images === "native") parts.push(...images.map(inputImage));
        input.push({ role: "user", content: parts });
        break;
      }
      case "assistant": {
        if (replay) {
          for (const entry of message.reasoningItems ?? []) if (replaysReasoning(entry, "responses", quirks)) input.push({ ...entry.item });
        }
        if (message.content.trim() !== "") input.push({ role: "assistant", content: message.content });
        for (const call of message.toolCalls ?? []) {
          input.push({ type: "function_call", call_id: portableToolId(call.id, quirks.toolCallId), name: call.name, arguments: validJsonObjectText(call.arguments) });
        }
        break;
      }
      case "tool": {
        const pictures = message.images ?? [];
        const native = quirks.images === "native" && pictures.length > 0;
        const lost = pictures.length > 0 && !native ? `\n${pictures.map((image) => `[Image not sent: ${image.name}]`).join("\n")}` : "";
        const text = `${message.content}${lost}`.trim() === "" ? "(no output)" : `${message.content}${lost}`;
        input.push({
          type: "function_call_output",
          call_id: portableToolId(message.toolCallId, quirks.toolCallId),
          output: native ? [{ type: "input_text", text }, ...pictures.map(inputImage)] : text,
        });
        break;
      }
    }
  }
  return { instructions: options.developerInstructions ? "" : leadText, input };
}

export function responsesTools(tools: readonly ToolDefinition[]): ResponsesItem[] {
  return tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
}

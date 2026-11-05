/**
 * One-shot requests over a copy of a conversation: a side question (`/btw`)
 * and a session title. Both ask the model about the transcript without
 * changing it, with the tool list the conversation already carries and
 * `tool_choice: "none"` so the server's cache for the conversation applies.
 * The helpers here are pure; the driver sends the request.
 */
import { SIDE_QUESTION_RULES } from "../sidequestion.js";
import type { TranscriptMessage } from "./types.js";

export const SIDE_QUESTION_INSTRUCTION = SIDE_QUESTION_RULES;

export const SIDE_QUESTION_NO_CONTEXT = [
  "You are Moxen Harness, a coding agent. The user has a quick side question and there is no conversation to draw on.",
  "Answer in a few sentences. You have no tools for this reply, so do not offer to run commands or read files.",
].join(" ");

export const TITLE_INSTRUCTION = [
  "Write a title for this conversation: three to seven words naming what the user is working on, in the language they write in.",
  "No quotation marks, no trailing punctuation, no prefix such as \"Title:\". Reply with the title only; you have no tools for this reply.",
].join(" ");

const MAX_TITLE_LENGTH = 80;

/**
 * The transcript as a request could use it right now. A turn running beside
 * the request may have a tool call whose results are not in yet; a request
 * that carried it would be invalid, so the transcript stops before it.
 */
export function settledPrefix(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  let open: number | null = null;
  const waiting = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      open = index;
      waiting.clear();
      for (const call of message.toolCalls ?? []) waiting.add(call.id);
    } else if (message.role === "tool") {
      waiting.delete(message.toolCallId);
      if (waiting.size === 0) open = null;
    }
  }
  return messages.slice(0, open ?? messages.length);
}

/** A model's reply as a title: its first line, unquoted and unformatted, or null when nothing usable is left. */
export function cleanTitle(reply: string): string | null {
  const line = reply
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  if (line === undefined) return null;
  const cleaned = line
    .replace(/^#+\s*/, "")
    .replace(/^(?:\*\*|__)?title\s*:\s*(?:\*\*|__)?\s*/i, "")
    .replace(/^["'“”‘’`*_\s]+|["'“”‘’`*_\s]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .trim();
  if (cleaned === "") return null;
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : cleaned;
}

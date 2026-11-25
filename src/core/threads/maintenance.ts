/**
 * Which turns are Moxen maintenance (a bare `/compact`) rather than work the
 * user asked for: their reply is the provider's compaction output, so task
 * reports, notification headlines and hand-off documents read the last turn
 * that did real work instead.
 *
 * One helper for every reader — the thread envelope, the hand-off document and
 * the task-notification generation — so they cannot drift apart on what counts
 * as maintenance. A turn carries the marker when it started as a bare
 * `/compact`; turns written before the marker existed are recognised by the
 * prompt they actually sent, which is the whole of it, not just the first
 * message: a batched turn of several messages is a compaction only when the
 * lot of them is the bare command.
 */
import { isCompactCommand } from "../providers/spi.js";
import type { StoredMessage, StoredTurn } from "./types.js";

/**
 * What a turn sends, as prompt text: every user message on it, in order (a
 * batched turn carries several). Falls back to the primary message for a turn
 * whose rows never attached. Mirrors `turnPrompt` in `threads.ts`, which adds
 * the attachments.
 */
export function effectivePrompt(turn: StoredTurn, messages: readonly StoredMessage[]): string {
  const own = messages.filter((message) => message.turnId === turn.id && message.role === "user" && message.text.trim().length > 0);
  if (own.length > 0) return own.map((message) => message.text.trim()).join("\n\n");
  return messages.find((message) => message.id === turn.messageId)?.text ?? "";
}

/** Whether a turn is maintenance rather than work: marked as such, or its whole prompt is a bare `/compact`. */
export function isMaintenanceTurn(turn: StoredTurn, messages: readonly StoredMessage[]): boolean {
  return turn.maintenance === true || isCompactCommand(effectivePrompt(turn, messages));
}

/** The ids of the thread's maintenance turns, in ledger order. */
export function maintenanceTurnIds(turns: readonly StoredTurn[], messages: readonly StoredMessage[]): string[] {
  return turns.filter((turn) => isMaintenanceTurn(turn, messages)).map((turn) => turn.id);
}

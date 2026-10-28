/**
 * Compaction: what to do when the conversation no longer fits. Ask the model
 * to summarise the work and rebuild the transcript from the summary, the
 * user's own words and a recent tail kept as real messages; failing that, just
 * trim, so a summariser that is broken (or too small for the job) can never
 * leave a thread stuck.
 *
 * Everything here is a function of the transcript and a `summarise` callback;
 * it does not touch the transcript on disk, the session or the network. The
 * driver does that, so the rules can be tested with a fake model.
 */
import { messagesTokens, messageTokens } from "./context.js";
import { SUMMARY_FRAMING, SUMMARY_NUDGE, TRIMMED_FRAMING, parseSummary, summaryInstruction } from "./compactprompt.js";
import { INSTRUCTIONS_REMINDER_PREFIXES } from "./prompt.js";
import type { CompactionSettings } from "./compactsettings.js";
import { ChatHttpError } from "./transport/chat.js";
import type { CompactSummaryRecord, TranscriptMessage } from "./types.js";

export type CompactReason = "manual" | "threshold" | "mid-turn" | "overflow" | "length";

/** What the user's messages may take up in the message that replaces the history. */
const USER_MESSAGES_BUDGET = 20_000;
/** The share of the request that is tried on each retry after the server says it is too long (of the size first rejected). */
export const SHRINK_STEPS: readonly number[] = [0.7, 0.5, 0.35];
/** A compaction must leave the conversation at or under this share of the threshold, or it did not buy enough room to go on. */
const PROGRESS_SHARE = 0.8;
/** After this many compactions in a row that could not summarise or did not free room, automatic ones stop trying to summarise. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Whether a failed request means the prompt did not fit. A bare 413 is only believed when the prompt is nearly the whole window. */
export function isContextOverflow(error: unknown, requestTokens: number, contextWindow: number | null): boolean {
  if (!(error instanceof ChatHttpError)) return false;
  if (error.contextOverflow) return true;
  return error.status === 413 && contextWindow !== null && requestTokens >= contextWindow * 0.9;
}

// -- where to cut -----------------------------------------------------------------

/** Index of the first entry that is not part of the leading system prompt. */
export function leadLength(messages: readonly TranscriptMessage[]): number {
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") index += 1;
  return index;
}

/**
 * Where each group of entries that must stay together starts: an assistant
 * message with tool calls and the results that follow it count as one, so a
 * cut never separates a call from its result. Everything else stands alone.
 */
export function groupStarts(messages: readonly TranscriptMessage[], from: number): number[] {
  const starts: number[] = [];
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index]!;
    // A result with no call before it in the region belongs to whatever precedes it.
    if (message.role === "tool" && starts.length > 0) continue;
    starts.push(index);
  }
  return starts;
}

/**
 * The index the kept tail starts at: the oldest group boundary that still
 * leaves no more than `keepTokens` after it (the newest group at least). Null when there is nothing worth compacting
 * (the tail would be everything, or what would be dropped is only the earlier
 * summary).
 */
export function chooseCut(messages: readonly TranscriptMessage[], keepTokens: number): number | null {
  const lead = leadLength(messages);
  const starts = groupStarts(messages, lead);
  if (starts.length < 2) return null;
  const total = messagesTokens(messages.slice(lead));
  // A conversation smaller than the tail asked for is split in half instead of kept whole.
  const keep = Math.min(keepTokens, Math.floor(total / 2));
  // Whole groups from the newest back, as many as fit; the newest group is kept even when it alone is over.
  let kept = 0;
  let cut: number | null = null;
  for (let at = starts.length - 1; at >= 1; at -= 1) {
    const end = at === starts.length - 1 ? messages.length : starts[at + 1]!;
    const size = messagesTokens(messages.slice(starts[at]!, end));
    if (cut !== null && kept + size > keep) break;
    kept += size;
    cut = starts[at]!;
  }
  if (cut === null) return null;
  const droppable = messages.slice(lead, cut).filter((message) => !(message.role === "user" && message.compactSummary));
  return droppable.length > 0 ? cut : null;
}

// -- the message that replaces the history ----------------------------------------------

const clip = (text: string, tokens: number): string => (text.length <= tokens * 4 ? text : `${text.slice(0, tokens * 4)}\n[… ${text.length - tokens * 4} more characters of this message were cut]`);

/** The user's words, oldest first, newest kept when they do not all fit. */
function carryUsers(previous: CompactSummaryRecord | undefined, dropped: readonly TranscriptMessage[]): { users: string[]; omitted: number } {
  const all: string[] = [...(previous?.users ?? [])];
  for (const message of dropped) {
    if (message.role !== "user" || message.compactSummary) continue;
    const images = message.images?.length ?? 0;
    all.push(images > 0 ? `${message.content}\n[${images} image${images === 1 ? "" : "s"} attached]` : message.content);
  }
  const kept: string[] = [];
  let used = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const room = USER_MESSAGES_BUDGET - used;
    if (room <= 0) break;
    const text = clip(all[index]!, room);
    kept.unshift(text);
    used += Math.ceil(text.length / 4);
  }
  return { users: kept, omitted: (previous?.omittedUsers ?? 0) + all.length - kept.length };
}

export function renderSummaryMessage(record: CompactSummaryRecord, todos: string | null): string {
  const parts: string[] = [record.summary ? SUMMARY_FRAMING : TRIMMED_FRAMING];
  if (record.summary) parts.push(`<summary>\n${record.summary}\n</summary>`);
  if (todos) parts.push(`<checklist>\nThe checklist you were keeping:\n${todos}\n</checklist>`);
  const earlier = record.omittedUsers > 0 ? `${record.omittedUsers} of the earliest messages are not repeated here.\n` : "";
  parts.push(
    `<user-messages>\nEverything the user has written so far, oldest first, word for word.\n${earlier}${record.users.map((text, index) => `\n<message n="${index + 1}">\n${text}\n</message>`).join("")}\n</user-messages>`,
  );
  return parts.join("\n\n");
}

/** Reminders that describe how things stand now, which survive the compaction: the latest instruction update. */
function carriedReminders(dropped: readonly TranscriptMessage[], tail: readonly TranscriptMessage[]): TranscriptMessage[] {
  const inTail = (content: string): boolean => tail.some((message) => message.role === "system" && message.content === content);
  const carried: TranscriptMessage[] = [];
  const instructions = [...dropped].reverse().find((message) => message.role === "system" && INSTRUCTIONS_REMINDER_PREFIXES.some((prefix) => message.content.startsWith(prefix)));
  if (instructions && !inTail(instructions.content)) carried.push(instructions);
  return carried;
}

// -- running it -----------------------------------------------------------------------

export interface SummaryReply {
  readonly text: string;
  readonly finish: string;
}

/** Sends the messages (the last of which is the instruction) to the model without letting it call tools. */
export type Summarise = (messages: readonly TranscriptMessage[]) => Promise<SummaryReply>;

export interface CompactInput {
  readonly messages: readonly TranscriptMessage[];
  /** Which compaction of the session this is. */
  readonly n: number;
  readonly reason: CompactReason;
  readonly keepRecentTokens: number;
  readonly focus?: string | undefined;
  /** The context window, when the model's is known. */
  readonly contextWindow: number | null;
  /** The auto-compaction threshold, when there is one. */
  readonly threshold: number | null;
  /** What every request carries besides the messages (the tool definitions), in tokens. */
  readonly overheadTokens: number;
  /** Multiplies our character estimates into the server's token counts; 1 when it has not told us. */
  readonly scale: number;
  /** The checklist the model was keeping, as text. */
  readonly todos: string | null;
  /** Skip the model and only trim: the summariser has failed too often in a row to be worth asking. */
  readonly trimOnly: boolean;
  readonly summarise: Summarise;
  readonly signal?: AbortSignal | undefined;
}

export type CompactOutcome =
  | { readonly kind: "nothing"; readonly message: string }
  | {
      readonly kind: "compacted";
      /** The whole new transcript. */
      readonly messages: readonly TranscriptMessage[];
      /** What it no longer holds, for the archive (earlier summaries excluded). */
      readonly dropped: readonly TranscriptMessage[];
      readonly summary: string;
      /** `trimmed`: no summary was made; `failure` says why. */
      readonly method: "summary" | "trimmed";
      readonly failure: string | null;
      readonly beforeTokens: number;
      readonly afterTokens: number;
      /** The result is under the threshold's progress target (always true when there is no threshold to hold it to). */
      readonly madeProgress: boolean;
    }
  | { readonly kind: "failed"; readonly message: string };

class SummaryUnusable extends Error {}

/** One request, the nudge on a reply that ignored the template, then give up. */
async function summariseWithRetry(summarise: Summarise, base: readonly TranscriptMessage[], signal: AbortSignal | undefined): Promise<string> {
  const first = await summarise(base);
  const parsed = parseSummary(first.text);
  if (parsed !== null) return parsed;
  if (signal?.aborted) throw new SummaryUnusable("interrupted");
  const second = await summarise([...base, { role: "assistant", content: first.text }, { role: "user", content: SUMMARY_NUDGE }]);
  const again = parseSummary(second.text);
  if (again !== null) return again;
  throw new SummaryUnusable(second.finish === "length" ? "the summary ran out of output space" : "the model did not follow the summary format");
}

/** A tool result as the summariser sees it when the conversation had to be cut down: its start is enough to say what was done. */
const SHRUNK_RESULT_CHARS = 1250;
function capToolOutput(message: TranscriptMessage): TranscriptMessage {
  return message.role === "tool" && message.content.length > SHRUNK_RESULT_CHARS
    ? { ...message, content: `${message.content.slice(0, SHRUNK_RESULT_CHARS)}\n[… ${message.content.length - SHRUNK_RESULT_CHARS} more characters cut]` }
    : message;
}

function slicesToFit(messages: readonly TranscriptMessage[], lead: number, cut: number, budgetTokens: number): TranscriptMessage[] | null {
  const marker = messages[lead]?.role === "user" && (messages[lead] as { compactSummary?: unknown }).compactSummary ? [messages[lead]!] : [];
  const bodyFrom = lead + marker.length;
  const starts = groupStarts(messages, bodyFrom).filter((index) => index < cut);
  let used = messagesTokens(marker);
  let from = cut;
  for (let at = starts.length - 1; at >= 0; at -= 1) {
    const end = at === starts.length - 1 ? cut : starts[at + 1]!;
    const size = messagesTokens(messages.slice(starts[at]!, end));
    if (used + size > budgetTokens) break;
    used += size;
    from = starts[at]!;
  }
  if (from >= cut) return null;
  return [...marker, ...messages.slice(from, cut)];
}

export async function compact(input: CompactInput): Promise<CompactOutcome> {
  const { messages } = input;
  const lead = leadLength(messages);
  const scaled = (tokens: number): number => Math.ceil(tokens * input.scale);
  const sizeOf = (list: readonly TranscriptMessage[]): number => scaled(messagesTokens(list)) + input.overheadTokens;
  const beforeTokens = sizeOf(messages);
  const target = input.threshold !== null ? input.threshold * PROGRESS_SHARE : beforeTokens * PROGRESS_SHARE;

  const cut = chooseCut(messages, input.keepRecentTokens);
  if (cut === null) return { kind: "nothing", message: "The conversation is too short to compact." };
  const dropped = messages.slice(lead, cut).filter((message) => !(message.role === "user" && message.compactSummary));
  const tail = messages.slice(cut);
  const previous = (messages[lead]?.role === "user" ? (messages[lead] as { compactSummary?: CompactSummaryRecord }).compactSummary : undefined) ?? undefined;
  const instruction: TranscriptMessage = { role: "user", content: summaryInstruction({ hasPriorSummary: previous !== undefined, focus: input.focus }) };
  const instructionTokens = messageTokens(instruction);
  const window = input.contextWindow;

  let summary = "";
  let failure: string | null = null;
  if (!input.trimOnly) {
    // The whole conversation, unchanged, then the instruction: the server's cache of the conversation still applies.
    let rejectedAt: number | null = null;
    const fullSize = sizeOf(messages) + scaled(instructionTokens);
    try {
      if (window !== null && fullSize > window * 0.95) {
        // Not worth a request the server will refuse: shrink from the window, which is the size it is known to take.
        rejectedAt = window;
      } else {
        summary = await summariseWithRetry(input.summarise, [...messages, instruction], input.signal);
      }
    } catch (error) {
      if (input.signal?.aborted) return { kind: "failed", message: "Interrupted." };
      if (error instanceof ChatHttpError && isContextOverflow(error, fullSize, window)) rejectedAt = fullSize;
      else failure = error instanceof Error ? error.message : String(error);
    }
    // Too long for the model to summarise in one go: show it less, newest part first, from a copy with old tool output cleared.
    if (summary === "" && rejectedAt !== null) {
      const view = messages.map(capToolOutput);
      for (const share of SHRINK_STEPS) {
        const budget = Math.floor((rejectedAt * share - input.overheadTokens) / Math.max(input.scale, 0.01)) - instructionTokens;
        const slice = slicesToFit(view, lead, cut, budget);
        if (slice === null) {
          failure = "the conversation is too long to summarise, even in parts";
          break;
        }
        try {
          summary = await summariseWithRetry(input.summarise, [...view.slice(0, lead), ...slice, instruction], input.signal);
          failure = null;
          break;
        } catch (error) {
          if (input.signal?.aborted) return { kind: "failed", message: "Interrupted." };
          if (error instanceof ChatHttpError && isContextOverflow(error, rejectedAt * share, window)) {
            failure = "the conversation is too long to summarise, even in parts";
            continue;
          }
          failure = error instanceof Error ? error.message : String(error);
          break;
        }
      }
    }
  } else {
    failure = "automatic summaries are paused after repeated failures";
  }

  const method = summary !== "" ? "summary" : "trimmed";
  const { users, omitted } = carryUsers(previous, dropped);
  // A trimmed result keeps the last real summary rather than dropping what the model once knew.
  const kept = method === "summary" ? summary : (previous?.summary ?? "");
  const reminders = carriedReminders(dropped, tail);
  const record: CompactSummaryRecord = { n: input.n, summary: kept, users, omittedUsers: omitted, covers: reminders.length + tail.length };
  const body: TranscriptMessage = { role: "user", content: renderSummaryMessage(record, input.todos), compactSummary: record };
  const next: TranscriptMessage[] = [...messages.slice(0, lead), body, ...reminders, ...tail];
  const afterTokens = sizeOf(next);
  if (afterTokens >= beforeTokens) {
    return { kind: "failed", message: failure ? `Compacting would not make the conversation smaller (${failure}).` : "Compacting would not make the conversation smaller." };
  }
  return {
    kind: "compacted",
    messages: next,
    dropped,
    summary: kept,
    method,
    failure: method === "trimmed" ? (failure ?? "no summary was made") : null,
    beforeTokens,
    afterTokens,
    madeProgress: afterTokens <= target,
  };
}

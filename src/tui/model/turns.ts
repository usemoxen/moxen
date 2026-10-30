import { currentLanguage, t } from "../i18n/index.js";
import type { TimelineEntry } from "./thread.js";
import { describeActivity } from "./activity.js";
import { workingMs, type TurnWaits, type WaitSpan } from "./waits.js";

export interface TurnGroup {
  id: string;
  turnId: string | null;
  /** Prompts that opened the turn, then any sent while it ran (`nudges`). */
  prompts: TimelineEntry[];
  /**
   * The prompts that arrived once the turn was already working — a steer
   * sent mid-run, a delegated task's notification. A subset of `prompts`;
   * the expanded transcript places them where they landed in the work
   * instead of above it.
   */
  nudges: TimelineEntry[];
  /** Tool calls and intermediate replies, hidden until the group is expanded. */
  work: TimelineEntry[];
  /** The finished reply that closed the turn, always shown. */
  reply: TimelineEntry | null;
  /**
   * Streaming assistant text for the in-flight turn. Rendered as live
   * "working" text — never as the closing reply — until the final
   * non-streaming message for the same id lands.
   */
  live: TimelineEntry | null;
  diff: TimelineEntry | null;
  /** A plan proposed for this turn, if the thread ran in plan-approval mode. */
  proposedPlan: TimelineEntry | null;
  /** Working time: wall time from first to last entry, minus waits on the user. */
  durationMs: number;
  startedAt: string;
  /** Where the turn stood waiting on the user (a question, a permission prompt). */
  waits: readonly WaitSpan[];
  /**
   * A plan usage limit cut the turn off. Its last message is wherever the
   * work stopped, not an answer, so the transcript keeps the work open in
   * full instead of folding it under a closing reply.
   */
  limited: boolean;
}

function elapsed(entries: readonly TimelineEntry[], waits: readonly WaitSpan[]): { durationMs: number; startedAt: string } {
  const times = entries
    .map((entry) => Date.parse(entry.at))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right);
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined) return { durationMs: 0, startedAt: entries[0]?.at ?? "" };
  return { durationMs: workingMs(waits, first, last), startedAt: new Date(first).toISOString() };
}

/** Whether an entry is something the turn *did* — a tool call, a thought, a subagent, another message — rather than bookkeeping. */
function landsAfterText(entry: TimelineEntry): boolean {
  if (entry.kind === "assistant") return true;
  if (entry.kind !== "activity" || entry.activity === null) return false;
  const kind = entry.activity.kind;
  if (kind === "reasoning" || kind === "subagent") return true;
  const payload = entry.activity.payload as Record<string, unknown> | null | undefined;
  return typeof payload?.toolCallId === "string";
}

/**
 * The transcript keeps a turn's prompt and closing reply visible and folds
 * everything between them into one "worked for" row; this groups the flat
 * timeline the same way so a long turn does not bury the answer.
 */
export function groupTurns(entries: readonly TimelineEntry[], waits: TurnWaits = new Map()): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  // Live user prompts usually carry a null turnId — the server only assigns
  // the turn id once the turn starts, so the prompt that opened a turn
  // arrives (and stays) without one while its reply, tool calls, and
  // checkpoint all carry the real id. Buffer such prompts and flush them
  // into the group the next turnId'd entry opens: otherwise every prompt
  // orphans into its own reply-less group and the turn reads as prompt-less.
  let pendingPrompts: TimelineEntry[] = [];

  const open = (entry: TimelineEntry): TurnGroup => {
    const group: TurnGroup = {
      id: entry.turnId ?? entry.id,
      turnId: entry.turnId,
      prompts: [],
      nudges: [],
      work: [],
      reply: null,
      live: null,
      diff: null,
      proposedPlan: null,
      durationMs: 0,
      startedAt: entry.at,
      waits: [],
      limited: false,
    };
    if (pendingPrompts.length > 0) {
      group.prompts.unshift(...pendingPrompts);
      pendingPrompts = [];
    }
    groups.push(group);
    return group;
  };

  // A reply only counts as "closing" until a nudge sharing its turnId proves
  // the turn kept going — previously nothing demoted it in that case, so the
  // old reply rendered on, stale, next to the fresh "Worked for..." fold the
  // nudge's own follow-up work produced. The `at` check is a defensive
  // tie-breaker (real messages arrive in order already) rather than a load-
  // bearing one.
  const demoteStaleReply = (group: TurnGroup, incoming: TimelineEntry) => {
    const reply = group.reply;
    if (reply === null) return;
    const replyAt = Date.parse(reply.at);
    const incomingAt = Date.parse(incoming.at);
    if (!Number.isNaN(replyAt) && !Number.isNaN(incomingAt) && incomingAt <= replyAt) return;
    group.work.push(reply);
    group.reply = null;
  };

  for (const entry of entries) {
    // A turnId'd user prompt starts a new group unless it shares the open
    // group's turn id: a follow-up "nudge" sent while a turn is still running
    // carries the same turnId as the prompt that opened it, so merging it
    // here keeps the turn's elapsed clock anchored to the first prompt
    // instead of restarting on every nudge. A null-turnId prompt (the live
    // shape above) buffers for the next turn instead of opening a group the
    // turn's own entries would then refuse to join.
    if (entry.kind === "user") {
      if (entry.turnId === null) {
        pendingPrompts.push(entry);
        continue;
      }
      if (current === null || current.turnId === null || entry.turnId !== current.turnId) {
        current = open(entry);
      } else {
        demoteStaleReply(current, entry);
        // A message sent mid-turn comes after whatever was streaming: that
        // text stays where it was written, not under the new prompt.
        if (current.live !== null && current.live.id !== entry.id) {
          current.work.push(current.live);
          current.live = null;
        }
        if (current.work.length > 0 || current.reply !== null || current.live !== null) current.nudges.push(entry);
      }
      current.prompts.push(entry);
      continue;
    }
    if (current === null || (entry.turnId !== null && entry.turnId !== current.turnId)) {
      // A turnId'd entry always resolves to its own turn's group — buffered
      // null-turn prompts flush into it via `open` above. Entries with no
      // turnId of their own (system rows) still ride along.
      current = open(entry);
    }
    // Streaming text is the *last* thing the turn has shown. Once a tool call,
    // a thought or another message lands after it, the model has moved on and
    // the text is finished: it takes its place among the work instead of
    // staying pinned under it with a caret (the stored note replaces it, by
    // id, when it arrives).
    if (current.live !== null && entry.id !== current.live.id && !(entry.kind === "assistant" && entry.streaming) && landsAfterText(entry)) {
      current.work.push(current.live);
      current.live = null;
    }
    if (entry.kind === "turn-diff") {
      // A diff belongs to its own turn: a foreign group (e.g. one opened by
      // null-turnId system activities) must not absorb it, or the row
      // renders under the wrong turn — and no group carries the
      // checkpoint's turnId for jump lookups afterwards.
      if (current === null || current.turnId !== entry.turnId) current = open(entry);
      current.diff = entry;
      continue;
    }
    if (entry.kind === "proposed-plan") {
      if (current === null) current = open(entry);
      current.proposedPlan = entry;
      continue;
    }
    if (entry.kind === "assistant") {
      // Streaming text is live output, not the closing reply: it renders in
      // working style until the final message for the same id arrives, at
      // which point it is promoted and the live slot clears.
      if (entry.streaming) {
        current.live = entry;
        continue;
      }
      if (current.live?.id === entry.id) current.live = null;
      // The previous reply becomes work as soon as another one lands.
      if (current.reply !== null) current.work.push(current.reply);
      current.reply = entry;
      continue;
    }
    // Deliberately *not* `demoteStaleReply` here: an ordinary turn often
    // explains itself in text and then keeps working with no final wrap-up
    // sentence, and that explanation is still the meaningful thing to show —
    // folding it away just because *some* tool call came after it would
    // punish the common case. Only a nudge (above) or a genuinely new reply
    // (below) proves the old one was superseded.
    current.work.push(entry);
  }

  // Prompts the server never assigned a turn — the turn hasn't started yet,
  // or the snapshot landed mid-flight — keep their own group rather than
  // dropping them: `open` flushes the buffer into it.
  if (pendingPrompts.length > 0) {
    const first = pendingPrompts[0];
    if (first !== undefined) open(first);
  }

  for (const group of groups) {
    // A reply demoted into the work list when a newer one lands was pushed
    // at the end, after tool calls that came later than it; with notes
    // between tool calls that put each note one step late. Keep work in
    // the timeline's own chronological order.
    group.work = group.work
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => left.entry.at.localeCompare(right.entry.at) || left.index - right.index)
      .map(({ entry }) => entry);
    const all = [
      ...group.prompts,
      ...group.work,
      ...(group.reply === null ? [] : [group.reply]),
      ...(group.live === null ? [] : [group.live]),
    ];
    group.limited = group.work.some((entry) => entry.kind === "activity" && entry.activityKind === "usage.limit");
    group.waits = group.turnId === null ? [] : (waits.get(group.turnId) ?? []);
    const timing = elapsed(all, group.waits);
    group.durationMs = timing.durationMs;
    group.startedAt = timing.startedAt;
  }
  return groups;
}

export function formatDuration(durationMs: number): string {  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** How long a thought took: milliseconds under a second ("420ms"), `formatDuration` otherwise. */
export function thoughtDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.max(1, Math.floor(durationMs))}ms` : formatDuration(durationMs);
}

/** `359_000` → `"359k"`, `1_400_000` → `"1.4m"`, `1_000_000` → `"1m"`. */
export function formatTokenCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  const millions = Math.round((value / 1_000_000) * 10) / 10;
  return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`;
}

/** `0` → `"$0.00"`, `1.234` → `"$1.23"`, `0.0041` → `"$0.0041"` (small spends keep precision). */
export function formatUsd(value: number): string {
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

export interface ContextUsageDisplay {
  /** Null when the driver never reports a ceiling (usage still shown as a raw count). */
  percent: number | null;
  usedLabel: string;
  maxLabel: string | null;
  totalProcessedLabel: string | null;
  /** Running session cost; null when the driver reports none (non-Claude). */
  costLabel: string | null;
}

export function formatContextUsage(usage: {
  usedTokens: number;
  maxTokens: number | null;
  totalProcessedTokens: number | null;
  costUsd?: number | null;
}): ContextUsageDisplay {
  return {
    percent: usage.maxTokens === null || usage.maxTokens <= 0 ? null : Math.round((usage.usedTokens / usage.maxTokens) * 100),
    usedLabel: formatTokenCount(usage.usedTokens),
    maxLabel: usage.maxTokens === null ? null : formatTokenCount(usage.maxTokens),
    totalProcessedLabel: usage.totalProcessedTokens === null ? null : formatTokenCount(usage.totalProcessedTokens),
    costLabel: usage.costUsd === null || usage.costUsd === undefined ? null : formatUsd(usage.costUsd),
  };
}

// 2023-01-01 was a Sunday: a fixed week to ask Intl for the day names, in whatever language is set.
const weekdayLabel = (day: number): string => new Date(Date.UTC(2023, 0, 1 + day)).toLocaleDateString(currentLanguage(), { weekday: "short", timeZone: "UTC" });
const monthLabel = (month: number): string => new Date(Date.UTC(2023, month, 1)).toLocaleDateString(currentLanguage(), { month: "short", timeZone: "UTC" });

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Same calendar day as `now`: hour only. Within the last 6 days: weekday +
 * time. Older (or same-day clock skew that lands `value` in the future):
 * date + time — spelled out since a bare weekday alone is ambiguous past a
 * week.
 */
export function clockTime(value: string, now: number): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  const date = new Date(parsed);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const dayDiff = Math.round((startOfDay(now) - startOfDay(parsed)) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff < 7) return `${weekdayLabel(date.getDay())}, ${time}`;
  return `${String(date.getDate()).padStart(2, "0")} ${monthLabel(date.getMonth())}, ${time}`;
}

/**
 * One-line aggregate of a finished turn's tool calls: "Ran 3 commands,
 * read 2 files, asked 1 question". Counts every countable tool row across
 * the whole turn (never per-tool stacks), highest count first, first-seen
 * order breaking ties. Non-tool rows (notes, plan echoes) never count.
 * Returns null when there is nothing countable to say.
 */
export function summarizeWork(entries: readonly TimelineEntry[]): string | null {
  const counts = new Map<string, { count: number; seen: number }>();
  const bump = (key: string): void => {
    const slot = counts.get(key);
    if (slot === undefined) counts.set(key, { count: 1, seen: counts.size });
    else slot.count += 1;
  };
  for (const entry of entries) {
    if (entry.kind !== "activity" || entry.activity === null) continue;
    let view: ReturnType<typeof describeActivity>;
    try {
      view = describeActivity(entry.activity);
    } catch {
      continue;
    }
    switch (view.kind) {
      case "command":
        bump("command");
        break;
      case "file":
        // A creation computes its diff from nothing (`removed: null`); an
        // edit always counts both sides. Stripped rows carry neither, so
        // they read as updates — the honest fallback without input.
        bump(view.diff !== null && view.removed === null && (view.added ?? 0) > 0 ? "file-created" : "file-updated");
        break;
      case "read":
      case "list":
      case "image":
        bump("read");
        break;
      case "grep":
        bump("grep");
        break;
      case "web":
        bump("web");
        break;
      case "question":
        bump("question");
        break;
      case "task":
        bump("task");
        break;
      case "skill":
        bump("skill");
        break;
      case "memory":
        bump(`memory-${view.action}`);
        break;
      case "threads":
        bump(`thread-${view.action}`);
        break;
      case "tool":
        bump("tool");
        break;
      case "todos":
      case "note":
        break;
    }
  }
  if (counts.size === 0) return null;
  const ranked = [...counts].sort(
    ([keyA, a], [keyB, b]) => b.count - a.count || a.seen - b.seen,
  );
  const parts = ranked.map(([key, slot]) => summarizePart(key, slot.count));
  const [first, ...rest] = parts;
  if (first === undefined) return null;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(", ");
}

function summarizePart(key: string, count: number): string {
    switch (key) {
    case "command":
      return t("summary.command", { count });
    case "file-created":
      return t("summary.file_created", { count });
    case "file-updated":
      return t("summary.file_updated", { count });
    case "read":
      return t("summary.read", { count });
    case "grep":
      return t("summary.grep", { count });
    case "web":
      return t("summary.web", { count });
    case "question":
      return t("summary.question", { count });
    case "task":
      return t("summary.task", { count });
    case "skill":
      return t("summary.skill", { count });
    case "thread-search":
      return t("summary.thread_search", { count });
    case "thread-read":
      return t("summary.thread_read", { count });
    case "memory-read":
      return t("summary.memory_read", { count });
    case "memory-save":
      return t("summary.memory_save", { count });
    case "memory-edit":
      return t("summary.memory_edit", { count });
    case "memory-append":
      return t("summary.memory_append", { count });
    case "memory-delete":
      return t("summary.memory_delete", { count });
    case "tool":
      return t("summary.tool", { count });
    default:
      return t("summary.step", { count });
  }
}

/**
 * Scroll offset that puts group `index` of `total` at the top of a pane with
 * `scrollHeight` rows and a `viewportHeight`-row window. Clamped into the
 * real `[0, scrollHeight - viewportHeight]` range: a past-the-end target
 * would just rest on the bottom (invisible when already there) and keep a
 * sticky-bottom box engaged instead of marking a manual scroll.
 */
export function proportionalTarget(index: number, total: number, scrollHeight: number, viewportHeight: number): number {
  if (total <= 0) return 0;
  const maxTop = Math.max(0, scrollHeight - viewportHeight);
  return Math.max(0, Math.min(maxTop, Math.floor((index / total) * scrollHeight)));
}

export interface WorkSegment {
  /** Tool calls since the previous message (or the turn start). */
  tools: TimelineEntry[];
  /**
   * The assistant message closing this segment — an intermediate work
   * message, or the turn's closing reply (which still renders separately
   * below, so callers skip it here). Null while the segment is still open:
   * no message has landed after these tools yet.
   */
  message: TimelineEntry | null;
  /**
   * Folds behind a one-line summary. Summaries are there to backtrack
   * through the messages the agent wrote while it worked, so only a turn
   * with at least one such message folds its segments; one that only ran
   * tools before its reply shows them flat — the Worked fold already hid
   * them once, a second click to reach them says nothing.
   */
  folds: boolean;
}

/**
 * Splits a turn's work at every assistant message: each message closes the
 * tools before it into a summarizable segment, and the trailing tools stay
 * open (flat) until a message lands after them. A closing reply bounds the
 * trailing tools the same way without joining the segment list itself.
 */
export function segmentWork(
  work: readonly TimelineEntry[],
  closing: TimelineEntry | null,
): WorkSegment[] {
  const segments: WorkSegment[] = [];
  let tools: TimelineEntry[] = [];
  const flush = (message: TimelineEntry | null): void => {
    if (tools.length > 0 || message !== null) segments.push({ tools, message, folds: false });
    tools = [];
  };
  for (const entry of work) {
    if (entry.kind === "activity") tools.push(entry);
    else flush(entry);
  }
  flush(null);
  if (closing !== null) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.message === null && last.tools.length > 0) {
      last.message = closing;
    }
  }
  const interim = segments.some((segment) => segment.message !== null && segment.message !== closing);
  for (const segment of segments) segment.folds = interim && segment.message !== null;
  return segments;
}

/**
 * The open turn's thought still running, if any. It renders last, so the
 * newest thing the model is doing is always the last thing on screen.
 */
export function runningThought(group: TurnGroup): TimelineEntry | null {
  for (let index = group.work.length - 1; index >= 0; index -= 1) {
    const entry = group.work[index];
    if (entry?.kind !== "activity" || entry.activity === null) continue;
    const view = describeActivity(entry.activity);
    if (view.kind === "reasoning" && view.running) return entry;
  }
  return null;
}

/**
 * The end of a thought still streaming: its last `maxChars`, cut at a word
 * and led by an ellipsis when shortened, so the live row stays a few lines
 * tall while the reasoning runs on.
 */
export function thoughtTail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(trimmed.length - maxChars);
  const space = cut.search(/\s/u);
  return `…${(space === -1 || space > 24 ? cut : cut.slice(space)).trimStart()}`;
}

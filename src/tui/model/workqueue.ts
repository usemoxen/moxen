import type { QueryResults } from "../../server/protocol.js";
import { t, tx } from "../i18n/index.js";
import { clockTime } from "./turns.js";

type Entry = QueryResults["queue.read"]["entries"][number];
type Condition = Entry["policy"]["conditions"][number];

export type QueueWindow = "session" | "weekly" | "all";
type Limits = Readonly<Record<string, { readonly windows: readonly { readonly kind: string }[]; readonly unavailable: unknown }>>;

export function editableQueueSelection(entries: readonly Entry[], selected: readonly string[], activeId: string | undefined): Entry[] {
  return entries.filter((entry) => (selected.length ? selected.includes(entry.turnId) : entry.turnId === activeId) && (entry.status === "queued" || entry.policy.removed));
}

/** An automatic usage recovery: the turn Moxen queues for a thread it paused when an allowance ran out. */
export function isUsageRecovery(entry: Entry): boolean {
  return entry.policy.automatic === true && entry.policy.requestId?.startsWith("usage:") === true;
}

/** "codex" as a person reads it: "Codex". */
export const providerName = (provider: string): string => provider.charAt(0).toUpperCase() + provider.slice(1);

/** The entries by what is happening to them, in the order the list shows them. */
export interface QueueGroups {
  readonly running: readonly Entry[];
  /** Queued and not held: ready, or waiting for a condition. */
  readonly upNext: readonly Entry[];
  readonly held: readonly Entry[];
  readonly removed: readonly Entry[];
}

export function queueGroups(entries: readonly Entry[]): QueueGroups {
  const live = entries.filter((entry) => !entry.policy.removed);
  const waiting = live.filter((entry) => entry.status !== "running");
  return { running: live.filter((entry) => entry.status === "running"), upNext: waiting.filter((entry) => !entry.policy.held), held: waiting.filter((entry) => entry.policy.held), removed: entries.filter((entry) => entry.policy.removed) };
}

/**
 * How many one-place moves (the server's `up` / `down`) put an entry next to its neighbour in the list as
 * it is drawn: the nearest entry of its own group (held or not) in that direction. The server orders every
 * live entry together, so held ones sitting between two others count as places to cross. 0 when it is
 * already first or last in its group.
 */
export function queueMoveSteps(entries: readonly Entry[], entry: Entry, direction: "up" | "down"): number {
  const live = entries.filter((other) => !other.policy.removed);
  const from = live.findIndex((other) => other.turnId === entry.turnId);
  if (from < 0 || entry.status !== "queued") return 0;
  const step = direction === "up" ? -1 : 1;
  for (let at = from + step; at >= 0 && at < live.length; at += step) {
    const other = live[at]!;
    if (other.status === "queued" && !!other.policy.held === !!entry.policy.held) return Math.abs(at - from);
  }
  return 0;
}

/** The moment an entry is known to wait for: the latest date among its conditions and its schedule, if still ahead. */
export function queueReadyAt(entry: Entry, now: number): string | null {
  const times = [entry.scheduledFor, ...entry.policy.conditions.map((condition) => condition.type === "at" ? condition.at : condition.type === "reset" ? condition.resetsAt : null)]
    .filter((value): value is string => value !== null && Date.parse(value) > now);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** The one phrase for where an entry stands, as the row shows it; the usage banner says the same for a recovery. */
export function queueEntryState(entry: Entry, now = Date.now()): string {
  if (entry.policy.removed) return t("queue.removed");
  if (entry.policy.held) return t("queue.onHold");
  if (entry.status === "running") return t(isUsageRecovery(entry) ? "protection.resumed" : "queue.running");
  if (!entry.blocked.length) return t("queue.ready");
  const at = queueReadyAt(entry, now);
  return at === null ? t("queue.waiting") : t("queue.waitingAt", { at: clockTime(at, now) });
}

const windowName = (window: "session" | "weekly"): string => t(window === "session" ? "queue.windowSession" : "queue.windowWeekly");

/** A condition as a sentence; times use the TUI's clock format, relative to `now`. */
export function queueConditionText(condition: Condition, threads: readonly { id: string; title: string }[] = [], entries: readonly Entry[] = [], now = Date.now()): string {
  switch (condition.type) {
    case "at": return t("queue.at", { at: clockTime(condition.at, now) });
    case "usage": {
      const provider = providerName(condition.provider);
      return condition.minimum <= 0 ? t("queue.usageAny", { provider })
        : condition.window === "all" ? t("queue.usageAll", { provider, minimum: condition.minimum })
        : t("queue.usage", { provider, window: windowName(condition.window), minimum: condition.minimum });
    }
    case "reset": return condition.window === "all" ? t("queue.resetAll", { provider: providerName(condition.provider) }) : t("queue.reset", { provider: providerName(condition.provider), window: windowName(condition.window) });
    case "provider": return t(condition.mode === "after" ? "queue.afterProvider" : "queue.whileProvider", { provider: providerName(condition.provider), state: t(condition.state === "exhausted" ? "queue.exhausted" : "queue.protected") });
    case "thread": return t("queue.afterThread", { thread: threads.find((thread) => thread.id === condition.threadId)?.title ?? condition.threadId });
    case "entry": return t("queue.afterEntry", { entry: entries.find((entry) => entry.threadId === condition.threadId && entry.turnId === condition.turnId)?.title ?? condition.turnId });
  }
}

/** What can be done to an entry, in the order the keys read. Several selected entries offer what applies to all of them. */
export type QueueAction = "hold" | "release" | "conditions" | "options" | "remove" | "restore";

export function queueActions(entry: Entry, selected: readonly Entry[] = []): QueueAction[] {
  if (selected.length > 1) return [selected.some((other) => !other.policy.held) ? "hold" : "release", "conditions", "options", "remove"];
  if (entry.policy.removed) return ["restore"];
  if (entry.status !== "queued") return [];
  return [entry.policy.held ? "release" : "hold", "conditions", "options", "remove"];
}

/** One server blocking reason as the user reads it: dates and times in the TUI's format, the rest translated. */
export function queueBlockedText(reason: string, now: number): string {
  const until = /^(?:Scheduled for|Waiting until) (\d{4}-\d{2}-\d{2}T\S+)$/.exec(reason);
  return until ? t("queue.waitUntil", { at: clockTime(until[1]!, now) }) : tx(reason);
}

/** Why the entry is where it is, one sentence each. */
export function queueReasons(entry: Entry, now: number): string[] {
  if (entry.status === "running") return [t(isUsageRecovery(entry) ? "protection.resumedDetail" : "queue.runningNow")];
  const reasons = entry.blocked.map((reason) => queueBlockedText(reason, now));
  return reasons.length ? reasons : [t("queue.why.ready")];
}

/** What the entry will do, in words: never the prompt it carries. */
export function queueDescription(entry: Entry, now: number): string {
  if (isUsageRecovery(entry)) return t("queue.about.recovery");
  if (entry.status === "running") return t("queue.runningNow");
  if (entry.policy.continuation === "stored") return t("queue.about.stored");
  if (entry.policy.continuation === "model") return t("queue.about.model");
  if (entry.scheduledFor !== null) return t("queue.about.scheduled", { at: clockTime(entry.scheduledFor, now) });
  return t("queue.about.message");
}

/** The lines under the focused entry that say what it waits for: its conditions, or else the reasons it stands where it does. */
export function queueDetails(entry: Entry, threads: readonly { id: string; title: string }[], entries: readonly Entry[], now: number): string[] {
  if (entry.status === "running") return [];
  if (entry.policy.removed) return queueReasons(entry, now);
  const conditions = entry.policy.conditions.map((condition) => queueConditionText(condition, threads, entries, now));
  const held = entry.policy.held ? [t("queue.heldByYou")] : [];
  if (conditions.length) return [...held, ...conditions];
  return entry.policy.held ? held : queueReasons(entry, now);
}

/** The line above the list: what runs next and what it waits for; else what is running, or why nothing is. */
export function queueHeadline(entries: readonly Entry[], now: number): string {
  const groups = queueGroups(entries);
  const next = groups.upNext[0];
  if (next) {
    const at = queueReadyAt(next, now);
    return t("queue.headline.next", { title: next.title, why: at === null ? queueReasons(next, now)[0]! : t("queue.waitUntil", { at: clockTime(at, now) }) });
  }
  if (groups.running[0]) return t("queue.headline.running", { title: groups.running[0].title });
  return t(groups.held.length ? "queue.headline.held" : "queue.headline.nothing");
}

/** The providers a condition can name: the ones that report usage. Unknown limits offer the two that can. */
export function queueProviders(limits: Limits | null): string[] {
  const reporting = Object.entries(limits ?? {}).filter(([, value]) => value.unavailable === null && value.windows.length > 0).map(([provider]) => provider);
  return reporting.length ? reporting : ["claude", "codex"];
}

/** The windows a condition can wait on for one provider: each kind it reports (conditions know session and weekly), and all of them. */
export function queueWindows(limits: Limits | null, provider: string): QueueWindow[] {
  const kinds = limits?.[provider]?.windows.map((window) => window.kind) ?? ["session", "weekly"];
  return [...(kinds.includes("session") ? ["session" as const] : []), ...(kinds.includes("weekly") ? ["weekly" as const] : []), "all"];
}

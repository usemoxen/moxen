import type { QueryResults } from "../../server/protocol.js";
import { t, tx } from "../i18n/index.js";
import { clockTime } from "./turns.js";

type Entry = QueryResults["queue.read"]["entries"][number];
type Condition = Entry["policy"]["conditions"][number];

export type QueueAction = "first" | "up" | "down" | "last" | "hold" | "release" | "remove" | "restore";
export type QueueWindow = "session" | "weekly" | "all";
type Limits = Readonly<Record<string, { readonly windows: readonly { readonly kind: string }[]; readonly unavailable: unknown }>>;

export function editableQueueSelection(entries: readonly Entry[], selected: readonly string[], activeId: string | undefined): Entry[] {
  return entries.filter((entry) => (selected.length ? selected.includes(entry.turnId) : entry.turnId === activeId) && (entry.status === "queued" || entry.policy.removed));
}

/** An automatic usage recovery: the turn Moxen queues for a thread it paused when an allowance ran out. */
export function isUsageRecovery(entry: Entry): boolean {
  return entry.policy.automatic === true && entry.policy.requestId?.startsWith("usage:") === true;
}

/** The one word for where an entry stands; the usage banner says the same for a recovery. */
export function queueEntryState(entry: Entry): string {
  return entry.policy.removed ? t("queue.removed") : entry.policy.held ? t("queue.onHold")
    : entry.status === "running" ? t(isUsageRecovery(entry) ? "protection.resumed" : "queue.running")
    : entry.blocked.length ? t("queue.waiting") : t("queue.ready");
}

const windowName = (window: "session" | "weekly"): string => t(window === "session" ? "queue.windowSession" : "queue.windowWeekly");

/** A condition as a sentence; times use the TUI's clock format, relative to `now`. */
export function queueConditionText(condition: Condition, threads: readonly { id: string; title: string }[] = [], entries: readonly Entry[] = [], now = Date.now()): string {
  switch (condition.type) {
    case "at": return t("queue.at", { at: clockTime(condition.at, now) });
    case "usage":
      return condition.minimum <= 0 ? t("queue.usageAny", { provider: condition.provider })
        : condition.window === "all" ? t("queue.usageAll", { provider: condition.provider, minimum: condition.minimum })
        : t("queue.usage", { provider: condition.provider, window: windowName(condition.window), minimum: condition.minimum });
    case "reset": return condition.window === "all" ? t("queue.resetAll", { provider: condition.provider }) : t("queue.reset", { provider: condition.provider, window: windowName(condition.window) });
    case "provider": return t(condition.mode === "after" ? "queue.afterProvider" : "queue.whileProvider", { provider: condition.provider, state: t(condition.state === "exhausted" ? "queue.exhausted" : "queue.protected") });
    case "thread": return t("queue.afterThread", { thread: threads.find((thread) => thread.id === condition.threadId)?.title ?? condition.threadId });
    case "entry": return t("queue.afterEntry", { entry: entries.find((entry) => entry.threadId === condition.threadId && entry.turnId === condition.turnId)?.title ?? condition.turnId });
  }
}

/**
 * What can be done to the focused entry, in the order the buttons read. `index` counts among the live
 * entries (`count` of them); a selection of several offers only what applies to all of them.
 */
export function queueActions(entry: Entry, index: number, count: number, selected: readonly Entry[] = []): QueueAction[] {
  if (selected.length > 1) return [selected.some((other) => !other.policy.held) ? "hold" : null, selected.some((other) => other.policy.held) ? "release" : null, "remove"].filter((action): action is QueueAction => action !== null);
  if (entry.policy.removed) return ["restore"];
  if (entry.status !== "queued") return [];
  return [index > 1 ? "first" : null, index > 0 ? "up" : null, index < count - 1 ? "down" : null, index < count - 2 ? "last" : null,
    entry.policy.held ? "release" : "hold", "remove"].filter((action): action is QueueAction => action !== null);
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
  if (entry.policy.continuation === "stored") return t("queue.about.stored");
  if (entry.policy.continuation === "model") return t("queue.about.model");
  if (entry.scheduledFor !== null) return t("queue.about.scheduled", { at: clockTime(entry.scheduledFor, now) });
  return t("queue.about.message");
}

/** The line above the list: what is running, or what runs next and what it waits for. */
export function queueHeadline(entries: readonly Entry[], now: number): string {
  const live = entries.filter((entry) => !entry.policy.removed);
  const running = live.find((entry) => entry.status === "running");
  if (running) return t("queue.headline.running", { title: running.title });
  const queued = live.filter((entry) => entry.status === "queued");
  if (!queued.length) return t("queue.headline.nothing");
  const next = queued.find((entry) => !entry.policy.held);
  if (!next) return t("queue.headline.held");
  return t("queue.headline.next", { title: next.title, why: queueReasons(next, now)[0]! });
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

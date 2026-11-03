import type { QueryResults } from "../../server/protocol.js";
import { t } from "../i18n/index.js";
import { clockTime } from "./turns.js";

type Entry = QueryResults["queue.read"]["entries"][number];
type Condition = Entry["policy"]["conditions"][number];

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

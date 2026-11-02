import type { QueryResults } from "../../server/protocol.js";
import { t } from "../i18n/index.js";

type Entry = QueryResults["queue.read"]["entries"][number];
type Condition = Entry["policy"]["conditions"][number];

export function editableQueueSelection(entries: readonly Entry[], selected: readonly string[], activeId: string | undefined): Entry[] {
  return entries.filter((entry) => (selected.length ? selected.includes(entry.turnId) : entry.turnId === activeId) && (entry.status === "queued" || entry.policy.removed));
}

export function queueConditionText(condition: Condition, threads: readonly { id: string; title: string }[] = [], entries: readonly Entry[] = []): string {
  switch (condition.type) {
    case "at": return t("queue.at", { at: new Date(condition.at).toLocaleString() });
    case "usage": return t("queue.usage", { provider: condition.provider, window: t(condition.window === "session" ? "queue.windowSession" : condition.window === "weekly" ? "queue.windowWeekly" : "queue.windowAll"), minimum: condition.minimum });
    case "reset": return t("queue.reset", { provider: condition.provider, window: t(condition.window === "session" ? "queue.windowSession" : condition.window === "weekly" ? "queue.windowWeekly" : "queue.windowAll") });
    case "provider": return t(condition.mode === "after" ? "queue.afterProvider" : "queue.whileProvider", { provider: condition.provider, state: t(condition.state === "exhausted" ? "queue.exhausted" : "queue.protected") });
    case "thread": return t("queue.afterThread", { thread: threads.find((thread) => thread.id === condition.threadId)?.title ?? condition.threadId });
    case "entry": return t("queue.afterEntry", { entry: entries.find((entry) => entry.threadId === condition.threadId && entry.turnId === condition.turnId)?.title ?? condition.turnId });
  }
}

import type { ClientApi } from "../../server/api.js";
import type { QueueEntry } from "../features/queue/useWorkQueue.js";

const HOUR = 3_600_000;
const policy = (order: number, patch: Partial<QueueEntry["policy"]> = {}): QueueEntry["policy"] => ({ conditions: [], order, held: false, sequential: true, continuation: "same-thread", ...patch });

/** What the work queue draws, one entry of each kind. Times are ahead of the moment the file loads. */
export const ENTRY_RUNNING: QueueEntry = { threadId: "thread-windows", turnId: "turn-running", title: "Fix the Windows test", prompt: "Make the Windows path test pass", provider: "claude", status: "running", scheduledFor: null, policy: policy(0), blocked: [] };
export const ENTRY_NEXT: QueueEntry = { threadId: "thread-queue", turnId: "turn-queue", title: "Finish keyboard navigation", prompt: "Resume the unfinished task", provider: "codex", status: "queued", scheduledFor: null, policy: policy(1, { conditions: [{ type: "reset", provider: "codex", window: "session", resetsAt: new Date(Date.now() + 2 * HOUR).toISOString() }, { type: "usage", provider: "codex", window: "weekly", minimum: 5 }] }), blocked: ["codex: waiting for session reset"] };
export const ENTRY_READY: QueueEntry = { threadId: "thread-claude", turnId: "turn-claude", title: "Review the settings changes", prompt: "Review the changes after Codex stops", provider: "claude", status: "queued", scheduledFor: null, policy: policy(2), blocked: [] };
export const ENTRY_HELD: QueueEntry = { threadId: "thread-docs", turnId: "turn-docs", title: "Tidy the docs", prompt: "Tidy the docs folder", provider: "claude", status: "queued", scheduledFor: null, policy: policy(3, { held: true, continuation: "model" }), blocked: ["Held by you"] };
export const ENTRY_STOPPED: QueueEntry = { threadId: "thread-stopped", turnId: "turn-stopped", title: "Retry failed validation", prompt: "Finish validation", provider: "codex", status: "failed", scheduledFor: null, policy: policy(4, { removed: true }), blocked: ["Stopped before completion; add back held to retry"] };
export const ENTRY_LONG: QueueEntry = { threadId: "thread-long", turnId: "turn-long", title: "Rework the onboarding so each step shows one choice and the back button always lands where the person came from", prompt: "x", provider: "claude", status: "queued", scheduledFor: null, policy: policy(5, { conditions: [{ type: "at", at: new Date(Date.now() + 30 * HOUR).toISOString() }] }), blocked: [] };
export const QUEUE_ENTRIES: readonly QueueEntry[] = [ENTRY_RUNNING, ENTRY_NEXT, ENTRY_READY, ENTRY_HELD, ENTRY_STOPPED];

/** A running automatic usage recovery, as the server reports it once the reset has passed. */
export const RECOVERY_ENTRY: QueueEntry = { threadId: "thread-recovery", turnId: "turn-recovery", title: "review unreviewed commits", prompt: "The usage allowance has reset. Resume the unfinished task from your wrap-up", provider: "codex", status: "running", scheduledFor: null, policy: { conditions: [{ type: "usage", provider: "codex", window: "all", minimum: 0 }, { type: "at", at: "2026-11-03T21:50:50.000Z" }], order: 1, held: false, sequential: true, continuation: "same-thread", automatic: true, requestId: "usage:1" }, blocked: [] };

/** The threads the add picker and the thread conditions can name. */
export const QUEUE_THREADS: readonly { id: string; title: string }[] = [
  { id: "thread-queue", title: "Finish keyboard navigation" }, { id: "thread-claude", title: "Review the settings changes" }, { id: "thread-docs", title: "Tidy the docs" },
  { id: "thread-windows", title: "Fix the Windows test" }, { id: "thread-new", title: "Plan the next release" }, { id: "thread-spare", title: "Sketch the stats card" },
];

const LIMITS = { providers: {
  claude: { checkedAt: "2026-11-03T16:00:00Z", unavailable: null, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 20, resetsAt: null }, { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: null }] },
  codex: { checkedAt: "2026-11-03T16:00:00Z", unavailable: null, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 20, resetsAt: null }, { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: null }] },
} };

/** Why the server would block an entry, from what it holds: enough for the list to read as it does live. */
function blockedBy(entry: QueueEntry): string[] {
  if (entry.status === "running" || entry.policy.removed && entry.status !== "queued") return [...entry.blocked];
  if (entry.policy.held) return ["Held by you"];
  return entry.policy.conditions.flatMap((condition) => condition.type === "reset" ? [`${condition.provider}: waiting for ${condition.window} reset`] : condition.type === "at" ? [`Waiting until ${condition.at}`] : condition.type === "usage" ? [`${condition.provider}: needs ${condition.minimum}% ${condition.window} remaining`] : ["Waiting for a dependency"]);
}

/**
 * A queue that behaves like the server's for what the modal does: hold, release, remove, restore, move up
 * or down, edit the policy, and add a held entry for a thread. `commands` records what the client sent.
 */
export function queueFixture(initial: readonly QueueEntry[] = QUEUE_ENTRIES, titles: readonly { id: string; title: string }[] = QUEUE_THREADS) {
  type Mutable = { -readonly [K in keyof QueueEntry]: QueueEntry[K] };
  let entries: Mutable[] = structuredClone([...initial]);
  const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
  let added = 0;
  const client = {
    query: async (query: { type: string }) => query.type === "usage.limits" ? LIMITS : { entries: entries.map((entry) => ({ ...entry, blocked: blockedBy(entry) })).sort((a, b) => a.policy.order - b.policy.order) },
    dispatch: async (command: Parameters<ClientApi["dispatch"]>[0]) => {
      commands.push(command);
      if (command.type === "queue.edit") {
        const target = entries.find((entry) => entry.turnId === command.turnId);
        if (!target) throw new Error("QUEUE_ENTRY_NOT_WAITING");
        if (command.action === "up" || command.action === "down") {
          const group = entries.filter((entry) => !!entry.policy.removed === !!target.policy.removed).sort((a, b) => a.policy.order - b.policy.order);
          const at = group.findIndex((entry) => entry.turnId === target.turnId);
          const other = group[at + (command.action === "up" ? -1 : 1)];
          if (other) { const order = target.policy.order; target.policy = { ...target.policy, order: other.policy.order }; other.policy = { ...other.policy, order }; }
        } else if (command.action === "hold" || command.action === "release") target.policy = { ...target.policy, held: command.action === "hold" };
        else if (command.action === "remove") { target.policy = { ...target.policy, removed: true }; target.status = "interrupted"; }
        else if (command.action === "restore") { target.policy = { ...target.policy, removed: false, held: true }; target.status = "queued"; }
        else if (command.action === "edit" && command.policy) target.policy = { ...target.policy, ...command.policy };
      }
      if (command.type === "thread.turn.start" && command.queue) {
        added += 1;
        entries = [...entries, { threadId: command.threadId, turnId: `turn-added-${added}`, title: titles.find((thread) => thread.id === command.threadId)?.title ?? command.threadId, prompt: command.message.text, provider: "claude", status: "queued", scheduledFor: null, policy: { ...command.queue, order: Math.max(0, ...entries.map((entry) => entry.policy.order)) + 1 }, blocked: [] }];
      }
      return { accepted: true };
    },
  } as unknown as ClientApi;
  return { client, commands, read: () => structuredClone(entries) };
}

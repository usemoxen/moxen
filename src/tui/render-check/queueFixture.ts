import type { ClientApi } from "../../server/api.js";
import type { QueueEntry } from "../features/queue/useWorkQueue.js";

export const QUEUE_ENTRIES: readonly QueueEntry[] = [
  { threadId: "thread-queue", turnId: "turn-queue", title: "Finish keyboard navigation", prompt: "Resume the unfinished task", provider: "codex", status: "queued", scheduledFor: null, policy: { conditions: [{ type: "reset", provider: "codex", window: "session", resetsAt: null }, { type: "usage", provider: "codex", window: "weekly", minimum: 5 }], order: 1, held: false, sequential: true, continuation: "same-thread" }, blocked: ["codex: waiting for session reset"] },
  { threadId: "thread-claude", turnId: "turn-claude", title: "Review the settings changes", prompt: "Review the changes after Codex stops", provider: "claude", status: "queued", scheduledFor: null, policy: { conditions: [{ type: "provider", provider: "codex", state: "protected", mode: "after" }], order: 2, held: true, sequential: true, continuation: "model" }, blocked: ["Held by you"] },
  { threadId: "thread-stopped", turnId: "turn-stopped", title: "Retry failed validation", prompt: "Finish validation", provider: "codex", status: "failed", scheduledFor: null, policy: { conditions: [], order: 3, held: false, sequential: true, continuation: "same-thread", removed: true }, blocked: ["Stopped before completion; add back held to retry"] },
];

/** A running automatic usage recovery, as the server reports it once the reset has passed. */
export const RECOVERY_ENTRY: QueueEntry = { threadId: "thread-recovery", turnId: "turn-recovery", title: "review unreviewed commits", prompt: "The usage allowance has reset. Resume the unfinished task from your wrap-up", provider: "codex", status: "running", scheduledFor: null, policy: { conditions: [{ type: "usage", provider: "codex", window: "all", minimum: 0 }, { type: "at", at: "2026-11-03T21:50:50.000Z" }], order: 1, held: false, sequential: true, continuation: "same-thread", automatic: true, requestId: "usage:1" }, blocked: [] };

const LIMITS = { providers: {
  claude: { checkedAt: "2026-11-03T16:00:00Z", unavailable: null, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 20, resetsAt: null }, { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: null }] },
  codex: { checkedAt: "2026-11-03T16:00:00Z", unavailable: null, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 20, resetsAt: null }, { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: null }] },
} };

export function queueFixture(initial: readonly QueueEntry[] = QUEUE_ENTRIES) {
  let entries = structuredClone([...initial]);
  const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
  const client = {
    query: async (query: { type: string }) => query.type === "usage.limits" ? LIMITS : { entries },
    dispatch: async (command: Parameters<ClientApi["dispatch"]>[0]) => {
      commands.push(command);
      if (command.type === "queue.edit") entries = entries.map((entry) => entry.turnId !== command.turnId ? entry : {
        ...entry, ...(command.action === "restore" ? { status: "queued" } : {}), policy: { ...(command.policy ?? entry.policy), ...(command.action === "hold" || command.action === "release" ? { held: command.action === "hold" } : {}), ...(command.action === "restore" ? { removed: false, held: true } : {}) },
      });
      return { accepted: true };
    },
  } as unknown as ClientApi;
  return { client, commands };
}

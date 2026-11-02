import type { ClientApi } from "../../server/api.js";
import type { QueueEntry } from "../features/queue/useWorkQueue.js";

export const QUEUE_ENTRIES: readonly QueueEntry[] = [
  { threadId: "thread-queue", turnId: "turn-queue", title: "Finish keyboard navigation", prompt: "Resume the unfinished task", provider: "codex", status: "queued", scheduledFor: null, policy: { conditions: [{ type: "reset", provider: "codex", window: "session", resetsAt: null }, { type: "usage", provider: "codex", window: "weekly", minimum: 5 }], order: 1, held: false, sequential: true, continuation: "same-thread" }, blocked: ["codex: waiting for session reset"] },
  { threadId: "thread-claude", turnId: "turn-claude", title: "Review the settings changes", prompt: "Review the changes after Codex stops", provider: "claude", status: "queued", scheduledFor: null, policy: { conditions: [{ type: "provider", provider: "codex", state: "protected", mode: "after" }], order: 2, held: true, sequential: true, continuation: "model" }, blocked: ["Held by you"] },
  { threadId: "thread-stopped", turnId: "turn-stopped", title: "Retry failed validation", prompt: "Finish validation", provider: "codex", status: "failed", scheduledFor: null, policy: { conditions: [], order: 3, held: false, sequential: true, continuation: "same-thread", removed: true }, blocked: ["Stopped before completion; add back held to retry"] },
];

export function queueFixture() {
  let entries = structuredClone(QUEUE_ENTRIES);
  const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
  const client = {
    query: async () => ({ entries }),
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

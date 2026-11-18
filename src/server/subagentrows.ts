import type { ActivityEnvelope } from "../core/types.js";

export interface NativeSubagentRow {
  agentId: string;
  agentType: string;
  /** What it was asked to do: the `description` of the Agent call that spawned it. */
  description: string | null;
  running: boolean;
  lastMessage: string | null;
  /** When it started. */
  at: string;
  /** When it stopped, once it has. */
  stoppedAt: string | null;
}

/** Claude's Agent tool (once Task), and OpenCode's `subagent`. */
const AGENT_TOOLS = new Set(["Agent", "Task", "subagent"]);

/**
 * The provider's own subagents in this thread (Claude's Agent tool,
 * OpenCode's `subagent`), latest state per agent, newest first. OpenCode
 * names the description as the subagent starts; Claude's is paired below.
 *
 * The start hook names the agent type but not the call that spawned it, so
 * each subagent is paired with the Agent calls of its turn and type in
 * order: the first Explore started in a turn is that turn's first Explore
 * call. That is where its description comes from. A background subagent
 * is also a background task under the same id, whose start names the call
 * exactly and whose end is a second word on when it stopped — the stop
 * hook's row was lost for any agent that outlived its turn before the
 * session watcher recorded it.
 */
export function nativeSubagents(activities: readonly ActivityEnvelope[]): NativeSubagentRow[] {
  const byAgent = new Map<string, NativeSubagentRow>();
  // Agent calls per `turn|type`, oldest first, by call id — a call writes a
  // row as it starts and again as it ends, and counts once.
  const calls = new Map<string, Map<string, string | null>>();
  const claimed = new Map<string, number>();
  const descriptions = new Map<string, string | null>();
  const taskCalls = new Map<string, string>();
  const taskEnds = new Map<string, { at: string; summary: string | null }>();
  for (const activity of activities) {
    const payload = (activity.payload ?? {}) as Record<string, unknown>;
    if (activity.kind.startsWith("background.") && typeof payload.taskId === "string") {
      if (activity.kind === "background.started" && typeof payload.toolUseId === "string") taskCalls.set(payload.taskId, payload.toolUseId);
      if (activity.kind === "background.completed" || activity.kind === "background.failed" || activity.kind === "background.stopped") {
        taskEnds.set(payload.taskId, { at: activity.createdAt, summary: typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : null });
      }
      continue;
    }
    if (activity.kind !== "subagent") {
      const data = (payload.data ?? {}) as Record<string, unknown>;
      if (typeof data.tool !== "string" || !AGENT_TOOLS.has(data.tool) || typeof payload.toolCallId !== "string") continue;
      const input = (((data.state ?? {}) as Record<string, unknown>).input ?? {}) as Record<string, unknown>;
      const named = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : typeof input.agent === "string" && input.agent ? input.agent : null;
      const type = named ?? "general-purpose";
      const key = `${activity.turnId ?? ""}|${type}`;
      const byCall = calls.get(key) ?? new Map<string, string | null>();
      const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;
      byCall.set(payload.toolCallId, description);
      calls.set(key, byCall);
      descriptions.set(payload.toolCallId, description);
      continue;
    }
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    if (agentId === null) continue;
    const previous = byAgent.get(agentId);
    // Every spawned subagent starts. A stop with no start is one of Claude
    // Code's internal agents (a prompt suggestion, `/btw`), recorded before
    // the driver learned to drop them.
    if (previous === undefined && payload.status !== "started") continue;
    const agentType = typeof payload.agentType === "string" ? payload.agentType : (previous?.agentType ?? "agent");
    let description = previous?.description ?? (typeof payload.description === "string" && payload.description.trim() ? payload.description.trim() : null);
    if (previous === undefined && description === null) {
      const key = `${activity.turnId ?? ""}|${agentType}`;
      const index = claimed.get(key) ?? 0;
      claimed.set(key, index + 1);
      description = [...(calls.get(key)?.values() ?? [])][index] ?? null;
    }
    const running = payload.status !== "stopped";
    byAgent.set(agentId, {
      agentId,
      agentType,
      description,
      running,
      lastMessage: typeof payload.lastMessage === "string" ? payload.lastMessage : (previous?.lastMessage ?? null),
      at: previous?.at ?? activity.createdAt,
      stoppedAt: running ? null : activity.createdAt,
    });
  }
  for (const [agentId, row] of byAgent) {
    const call = taskCalls.get(agentId);
    const exact = call === undefined ? undefined : descriptions.get(call);
    const end = row.running ? taskEnds.get(agentId) : undefined;
    byAgent.set(agentId, {
      ...row,
      ...(exact ? { description: exact } : {}),
      ...(end === undefined ? {} : { running: false, stoppedAt: end.at, lastMessage: row.lastMessage ?? end.summary }),
    });
  }
  return [...byAgent.values()].sort((left, right) => right.at.localeCompare(left.at));
}

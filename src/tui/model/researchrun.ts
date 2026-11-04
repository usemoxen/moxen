import type { ThreadEnvelope } from "../../core/types.js";
import { RESEARCH_LENSES, type ResearchLens } from "../../core/threads/researchvocab.js";
import type { ResearchRole, ResearchSize, StoredResearchRun } from "../../server/api.js";

/**
 * What the run view shows, projected from what the server sends the shell:
 * the run record (its roles and chosen size) and the threads those roles
 * run in. Pure, so the view only draws.
 */

export type AgentState = "waiting" | "working" | "done" | "failed" | "stopped";

export type RunPhase = "planning" | "researching" | "reviewing" | "finalizing" | "finished" | "failed" | "stopped";

export const ROLES: readonly ResearchRole[] = ["researcher", "critic", "finalizer"];

export interface RunAgent {
  readonly role: ResearchRole;
  /** 1-based place among its role's agents. */
  readonly index: number;
  /** Null for a slot of the chosen size that has not started yet. */
  readonly threadId: string | null;
  readonly state: AgentState;
  readonly question: string | null;
  readonly thread: ThreadEnvelope | null;
  /** A critic's review: all three when the run has one critic, else its own. */
  readonly lens: ResearchLens | "all" | null;
}

export interface RunSummary {
  readonly run: StoredResearchRun;
  readonly leadThreadId: string;
  readonly title: string;
  readonly agents: Readonly<Record<ResearchRole, readonly RunAgent[]>>;
  readonly phase: RunPhase;
  /** True once the run is over, whatever the way. */
  readonly ended: boolean;
}

/** A reference to one agent in the roster, by role and 0-based place. */
export interface AgentRef {
  readonly role: ResearchRole;
  readonly index: number;
}

/** The run a lead thread has now: the newest it started. Null when it leads none. */
export function latestRunOf(runs: readonly StoredResearchRun[] | undefined, leadThreadId: string | null): StoredResearchRun | null {
  if (!runs || leadThreadId === null) return null;
  let latest: StoredResearchRun | null = null;
  for (const run of runs) {
    if (run.leadThreadId !== leadThreadId) continue;
    if (latest === null || Date.parse(run.createdAt) >= Date.parse(latest.createdAt)) latest = run;
  }
  return latest;
}

/** The threads that run a role of some run: they have no sidebar row of their own, the run has one. */
export function roleThreadIds(runs: readonly StoredResearchRun[] | undefined): Set<string> {
  return new Set((runs ?? []).flatMap((run) => run.roles.map((role) => role.threadId)));
}

/** The lead and run a role thread belongs to, or null. */
export function runOfRole(runs: readonly StoredResearchRun[] | undefined, threadId: string | null): StoredResearchRun | null {
  if (!runs || threadId === null) return null;
  return runs.find((run) => run.roles.some((role) => role.threadId === threadId)) ?? null;
}

export function agentStateOf(thread: ThreadEnvelope | null | undefined): AgentState {
  if (!thread) return "working";
  const session = thread.session?.status;
  if (session === "running" || session === "starting") return "working";
  const turn = thread.latestTurn;
  if (!turn) return "working";
  if (turn.state === "running") return "working";
  if (turn.state === "completed") return "done";
  if (turn.state === "error") return "failed";
  return "stopped";
}

export function lensOf(size: ResearchSize | undefined, index: number): ResearchLens | "all" {
  if ((size?.critics ?? 3) === 1) return "all";
  return RESEARCH_LENSES[index % RESEARCH_LENSES.length]!;
}

function slotsFor(role: ResearchRole, size: ResearchSize | undefined, started: number): number {
  if (role === "finalizer") return Math.max(1, started);
  return Math.max(started, role === "researcher" ? (size?.researchers ?? 8) : (size?.critics ?? 3));
}

export function summarizeRun(run: StoredResearchRun, threads: readonly ThreadEnvelope[]): RunSummary {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const lead = byId.get(run.leadThreadId) ?? null;
  const ended = run.endedAt !== undefined || run.state !== "running";
  const agents = Object.fromEntries(ROLES.map((role) => {
    const started = run.roles.filter((entry) => entry.role === role);
    // A run that is over starts nothing more: its unused slots are not waiting for anything.
    const slots = ended ? Math.max(1, started.length) : slotsFor(role, run.size, started.length);
    return [role, Array.from({ length: slots }, (_, index): RunAgent => {
      const entry = started[index];
      const thread = entry ? (byId.get(entry.threadId) ?? null) : null;
      return {
        role, index: index + 1,
        threadId: entry?.threadId ?? null,
        state: entry ? agentStateOf(thread) : "waiting",
        question: entry?.question ?? null,
        thread,
        lens: role === "critic" ? lensOf(run.size, index) : null,
      };
    })];
  })) as Record<ResearchRole, RunAgent[]>;
  const startedIn = (role: ResearchRole) => agents[role].some((agent) => agent.state !== "waiting");
  const phase: RunPhase = ended
    ? run.state === "failed" ? "failed" : run.state === "interrupted" ? "stopped" : "finished"
    : startedIn("finalizer") ? "finalizing"
    : startedIn("critic") ? "reviewing"
    : startedIn("researcher") ? "researching"
    : "planning";
  return { run, leadThreadId: run.leadThreadId, title: lead?.title === undefined ? "" : String(lead.title), agents, phase, ended };
}

/** How long the run has been going, or took: frozen once it ended. */
export function runElapsedMs(summary: RunSummary, now: number): number {
  const start = Date.parse(summary.run.createdAt);
  const end = summary.ended ? Date.parse(summary.run.endedAt ?? summary.run.updatedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function agentAt(summary: RunSummary, ref: AgentRef): RunAgent | null {
  const list = summary.agents[ref.role];
  return list[Math.min(Math.max(0, ref.index), list.length - 1)] ?? null;
}

/** The roster as one row: researchers, then critics, then the finalizer. */
export function rosterOf(summary: RunSummary): AgentRef[] {
  return ROLES.flatMap((role) => summary.agents[role].map((_, index): AgentRef => ({ role, index })));
}

/** One step through the roster, wrapping at the ends. */
export function stepAgent(summary: RunSummary, from: AgentRef, direction: 1 | -1): AgentRef {
  const roster = rosterOf(summary);
  const at = roster.findIndex((ref) => ref.role === from.role && ref.index === from.index);
  return roster[(Math.max(0, at) + direction + roster.length) % roster.length]!;
}

/** The role to step to from `role`, wrapping: the view's Tab. */
export function stepRole(role: ResearchRole, direction: 1 | -1): ResearchRole {
  return ROLES[(ROLES.indexOf(role) + direction + ROLES.length) % ROLES.length]!;
}

/**
 * The agent a column shows before anyone picked one: the one at work, else
 * the last one to finish, else the first slot.
 */
export function defaultAgentIndex(summary: RunSummary, role: ResearchRole): number {
  const list = summary.agents[role];
  const working = list.findIndex((agent) => agent.state === "working");
  if (working !== -1) return working;
  for (let at = list.length - 1; at >= 0; at -= 1) if (list[at]!.state !== "waiting") return at;
  return 0;
}

/** The role the phase is about: the column that is wide. */
export function focusRoleOf(summary: RunSummary): ResearchRole {
  switch (summary.phase) {
    case "planning":
    case "researching":
      return "researcher";
    case "reviewing":
      return "critic";
    case "finalizing":
      return "finalizer";
    default:
      return summary.agents.finalizer.some((agent) => agent.state !== "waiting") ? "finalizer" : summary.agents.critic.some((agent) => agent.state !== "waiting") ? "critic" : "researcher";
  }
}

/** Width of a column with nothing happening in it. */
export const SLIVER_WIDTH = 14;
/** The least a column with something to read gets. */
export const MIN_COLUMN_WIDTH = 24;
/** Below this width the view shows one column at a time. */
export const NARROW_BELOW = SLIVER_WIDTH * 2 + MIN_COLUMN_WIDTH + 14;

export type ColumnWidths = Readonly<Record<ResearchRole, number>>;

/**
 * Column widths for `total` cells: the phase's column is wide, the others
 * share what is left by how much they are doing, and a column nothing has
 * started in shrinks to a sliver. Null when the columns do not fit (narrow).
 */
export function columnWidths(summary: RunSummary, total: number): ColumnWidths | null {
  if (total < NARROW_BELOW) return null;
  const focus = focusRoleOf(summary);
  const started = (role: ResearchRole) => summary.agents[role].some((agent) => agent.state !== "waiting");
  const weight = (role: ResearchRole): number => {
    if (role === focus) return 5;
    return started(role) ? 3 : 0;
  };
  const roles = ROLES.filter((role) => weight(role) > 0);
  const slivers = ROLES.length - roles.length;
  const room = total - slivers * SLIVER_WIDTH;
  const sum = roles.reduce((all, role) => all + weight(role), 0);
  const widths: Record<string, number> = {};
  for (const role of ROLES) widths[role] = SLIVER_WIDTH;
  let left = room;
  roles.forEach((role, at) => {
    const share = at === roles.length - 1 ? left : Math.max(MIN_COLUMN_WIDTH, Math.floor((room * weight(role)) / sum));
    widths[role] = share;
    left -= share;
  });
  // Minimums can overdraw the last column: take it back from the widest.
  const over = ROLES.reduce((all, role) => all + widths[role]!, 0) - total;
  if (over > 0) {
    const widest = [...roles].sort((a, b) => widths[b]! - widths[a]!)[0];
    if (widest) widths[widest] = widths[widest]! - over;
  }
  return widths as ColumnWidths;
}

/** Whether a column is a sliver at these widths. */
export function isSliver(widths: ColumnWidths, role: ResearchRole): boolean {
  return widths[role] <= SLIVER_WIDTH;
}

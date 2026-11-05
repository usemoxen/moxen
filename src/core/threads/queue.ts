import { CliError } from "../errors.js";
import type { CliConfig } from "../types.js";
import { driverKindOfInstance } from "../types.js";
import { usageLimitsSnapshot, usageSignal } from "../usage/limits.js";
import type { StoredThread, StoredTurn } from "./types.js";

export const QUEUE_RESET_GRACE_MS = 5000;
export const QUEUE_ADMISSION_LOCK = "\0queue-admission";

function nextReset(provider: string, kind: "session" | "weekly" | "all", now = Date.now()): string | null {
  const windows = usageLimitsSnapshot(now)[provider]?.windows.filter((window) => kind === "all" || window.kind === kind) ?? [];
  if (!windows.length || windows.some((window) => window.resetsAt === null)) return null;
  return windows.map((window) => window.resetsAt!).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

export type QueueCondition =
  | { readonly type: "at"; readonly at: string }
  | { readonly type: "usage"; readonly provider: string; readonly window: "session" | "weekly" | "all"; readonly minimum: number }
  | { readonly type: "reset"; readonly provider: string; readonly window: "session" | "weekly" | "all"; readonly resetsAt: string | null }
  | { readonly type: "provider"; readonly provider: string; readonly state: "exhausted" | "protected"; readonly mode: "after" | "while" }
  | { readonly type: "thread"; readonly threadId: string }
  | { readonly type: "entry"; readonly threadId: string; readonly turnId: string };

export interface QueuePolicy {
  readonly conditions: readonly QueueCondition[];
  readonly held: boolean;
  readonly order: number;
  readonly sequential: boolean;
  readonly continuation: "same-thread" | "stored" | "model";
  /** Internal state: clients cannot declare events satisfied or bypass reserves. */
  readonly latched?: readonly number[];
  readonly automatic?: boolean;
  /** An automatic wake-up persisted while protection held its thread. */
  readonly wakeUp?: boolean;
  readonly requestId?: string;
  readonly summaryFor?: string;
  readonly eventAfter?: string;
  readonly removed?: boolean;
}

export interface QueueRow { readonly thread: StoredThread; readonly turns: readonly StoredTurn[] }
export interface WorkQueueEntry {
  readonly threadId: string; readonly turnId: string; readonly title: string; readonly prompt: string;
  readonly provider: string; readonly status: string; readonly policy: QueuePolicy;
  readonly blocked: readonly string[]; readonly scheduledFor: string | null;
}

export function parseQueuePolicy(value: unknown): QueuePolicy {
  const bad = (): never => { throw new CliError("INVALID_QUEUE", "Queue conditions or options are invalid."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.conditions) || r.conditions.length > 16) return bad();
  const conditions: QueueCondition[] = r.conditions.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") return bad();
    const c = raw as Record<string, unknown>;
    const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
    if (c.type === "at" && typeof c.at === "string" && Number.isFinite(Date.parse(c.at))) return { type: "at", at: new Date(c.at).toISOString() };
    if (c.type === "usage" && id(c.provider) && ["session", "weekly", "all"].includes(String(c.window)) && typeof c.minimum === "number" && Number.isFinite(c.minimum) && c.minimum >= 0 && c.minimum <= 100) return { type: "usage", provider: c.provider, window: c.window as "session" | "weekly" | "all", minimum: c.minimum };
    if (c.type === "reset" && id(c.provider) && (c.window === "session" || c.window === "weekly" || c.window === "all")) {
      if (c.resetsAt !== undefined && c.resetsAt !== null && (typeof c.resetsAt !== "string" || !Number.isFinite(Date.parse(c.resetsAt)))) return bad();
      return { type: "reset", provider: c.provider, window: c.window, resetsAt: typeof c.resetsAt === "string" ? c.resetsAt : nextReset(c.provider, c.window) };
    }
    if (c.type === "provider" && id(c.provider) && (c.state === "exhausted" || c.state === "protected") && (c.mode === "after" || c.mode === "while")) return { type: "provider", provider: c.provider, state: c.state, mode: c.mode };
    if (c.type === "thread" && id(c.threadId)) return { type: "thread", threadId: c.threadId };
    if (c.type === "entry" && id(c.threadId) && id(c.turnId)) return { type: "entry", threadId: c.threadId, turnId: c.turnId };
    return bad();
  });
  if (r.held !== undefined && typeof r.held !== "boolean") return bad();
  if (r.sequential !== undefined && typeof r.sequential !== "boolean") return bad();
  if (r.order !== undefined && (typeof r.order !== "number" || !Number.isFinite(r.order))) return bad();
  if (r.continuation !== undefined && !["same-thread", "stored", "model"].includes(String(r.continuation))) return bad();
  return { conditions, held: r.held === true, order: typeof r.order === "number" ? r.order : Date.now(), sequential: r.sequential !== false, continuation: (r.continuation ?? "same-thread") as QueuePolicy["continuation"] };
}

export function automaticUsageBlock(provider: string, config: CliConfig, now = Date.now()): string[] {
  const limits = usageLimitsSnapshot(now)[provider];
  // Providers without a quota feed retain their normal usage-limit behavior.
  return (limits?.windows ?? []).flatMap((window) => {
    const minimum = window.kind === "weekly" ? config.usageMinimumWeekly ?? 5 : window.kind === "session" ? config.usageMinimumSession ?? 3 : 0;
    return window.usedPercent >= 100 || 100 - window.usedPercent < minimum ? [`${provider}: ${window.label} needs ${minimum}% remaining`] : [];
  });
}

export function providerExhausted(provider: string, now = Date.now()): boolean {
  return usageLimitsSnapshot(now)[provider]?.windows.some((window) => window.usedPercent >= 100) === true;
}

function entryPending(rows: readonly QueueRow[], threadId: string, turnId: string): boolean {
  const seen = new Set<string>();
  let target = rows.find((row) => row.thread.id === threadId)?.turns.find((turn) => turn.id === turnId);
  while (target?.handoff) {
    if (seen.has(target.id)) return true;
    seen.add(target.id);
    const { destinationThreadId, requestId } = target.handoff;
    const destination = rows.find((row) => row.thread.id === destinationThreadId)?.turns.find((turn) => turn.queue?.requestId === `handoff:${requestId}`);
    if (!destination) break;
    target = destination;
  }
  return !target || target.status === "queued" || target.status === "running";
}

export function queueAdmission(row: QueueRow, turn: StoredTurn, rows: readonly QueueRow[], config: CliConfig, now = Date.now()): { blocked: string[]; latched: number[]; conditions: QueueCondition[] } {
  const policy = turn.queue;
  const blocked: string[] = [];
  const latched = [...(policy?.latched ?? [])];
  const conditions = [...(policy?.conditions ?? [])];
  if (row.thread.usagePause?.forced || row.thread.usagePause && row.thread.usagePause.phase !== "resuming" && row.thread.usagePause.recoveryTurnId !== turn.id && !policy?.summaryFor) blocked.push("Waiting for thread protection");
  if (policy?.wakeUp && row.turns.some((previous) => previous.id !== turn.id && previous.queue?.wakeUp && previous.status === "queued" && (previous.queue.order < policy.order || previous.queue.order === policy.order && row.turns.indexOf(previous) < row.turns.indexOf(turn)))) blocked.push("Waiting for preceding wake-up");
  if (policy?.held || policy?.removed) blocked.push(policy.removed ? "Removed from queue" : "Held by you");
  if (row.thread.archivedAt || row.thread.deletedAt || row.thread.settledAt || row.thread.snoozedUntil) blocked.push("Thread is not active");
  if (row.thread.hasPendingApprovals || row.thread.hasPendingUserInput) blocked.push("Waiting for your answer or approval");
  if (turn.scheduledFor && Date.parse(turn.scheduledFor) > now) blocked.push(`Scheduled for ${turn.scheduledFor}`);
  const provider = driverKindOfInstance((turn.modelSelection ?? row.thread.modelSelection).instanceId) ?? "unknown";
  if (policy?.automatic || turn.scheduleReason === "usage-reset" || turn.scheduleReason === "usage-hold") blocked.push(...automaticUsageBlock(provider, config, now));
  else if (providerExhausted(provider, now)) blocked.push(`${provider}: usage exhausted`);
  for (const [index, condition] of (policy?.conditions ?? []).entries()) {
    if (condition.type === "at") { if (Date.parse(condition.at) > now) blocked.push(`Waiting until ${condition.at}`); }
    else if (condition.type === "usage") {
      const windows = usageLimitsSnapshot(now)[condition.provider]?.windows.filter((w) => condition.window === "all" || w.kind === condition.window) ?? [];
      if (!windows.length) blocked.push(`${condition.provider}: usage unavailable`);
      else if (windows.some((w) => w.usedPercent >= 100 || 100 - w.usedPercent < condition.minimum)) blocked.push(`${condition.provider}: needs ${condition.minimum}% ${condition.window} remaining`);
    } else if (condition.type === "reset") {
      const resetsAt = condition.resetsAt ?? nextReset(condition.provider, condition.window, now);
      if (resetsAt && !condition.resetsAt) conditions[index] = { ...condition, resetsAt };
      if (!resetsAt || Date.parse(resetsAt) + QUEUE_RESET_GRACE_MS > now) blocked.push(`${condition.provider}: waiting for ${condition.window} reset`);
    } else if (condition.type === "provider") {
      const met = condition.state === "exhausted" ? usageLimitsSnapshot(now)[condition.provider]?.windows.some((w) => w.usedPercent >= 100) === true
        : rows.some((r) => r.thread.usagePause?.provider === condition.provider && r.thread.usagePause.phase !== "resuming");
      const signal = usageSignal(condition.provider, condition.state);
      const happened = signal !== null && Date.parse(signal) >= Date.parse(policy?.eventAfter ?? turn.createdAt);
      if (condition.mode === "after" && (met || happened) && !latched.includes(index)) latched.push(index);
      if (!(condition.mode === "after" ? latched.includes(index) : met)) blocked.push(`${condition.mode} ${condition.provider} is ${condition.state}`);
    } else {
      const dependency = rows.find((r) => r.thread.id === condition.threadId);
      if (!dependency) blocked.push("Dependency is unavailable");
      else if (condition.type === "entry" ? entryPending(rows, condition.threadId, condition.turnId) : dependency.turns.some((t) => t.status === "running" || t.status === "queued")) blocked.push(`Waiting for ${dependency.thread.title}`);
    }
  }
  if (rows.some((r) => r.thread.id === row.thread.id && r.turns.some((t) => t.status === "running" && t.id !== turn.id))) blocked.push("Thread is running");
  if (rows.some((r) => r.turns.some((t) => t.status === "running" && t.queue && (policy?.sequential || t.queue.sequential) && t.id !== turn.id && driverKindOfInstance((t.modelSelection ?? r.thread.modelSelection).instanceId) === provider))) blocked.push(`${provider}: preceding queue entry is running`);
  return { blocked, latched, conditions };
}

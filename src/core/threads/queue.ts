import { CliError } from "../errors.js";
import { antigravityUnsupportedUseAllowed, driverKindOfInstance, type CliConfig } from "../types.js";
import { usageKeyForInstance, usageSignal, usageWindowsForModel } from "../usage/limits.js";
import type { MessageOrigin, StoredMessage, StoredThread, StoredTurn } from "./types.js";

export const QUEUE_RESET_GRACE_MS = 5000;
export const QUEUE_ADMISSION_LOCK = "\0queue-admission";

/**
 * The reset a `reset` queue condition waits for: the reset of the window it
 * asked about. `all` covers every reported window, so it waits for the latest
 * reset across them — a session reset does not release work that also waits
 * on the weekly window. When `model` is given for a multi-pool provider
 * (Antigravity), only windows governing that model pool are considered.
 */
export function nextReset(
  provider: string,
  kind: "session" | "weekly" | "all",
  now = Date.now(),
  model?: string | null,
): string | null {
  const windows = usageWindowsForModel(provider, now, model).filter((window) => kind === "all" || window.kind === kind);
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

export interface ParseQueuePolicyOptions {
  readonly model?: string | null | undefined;
  /** Keep omitted `reset` timestamps null so the thread-aware caller can resolve them against the thread's model. */
  readonly deferReset?: boolean | undefined;
}

export function parseQueuePolicy(value: unknown, options?: ParseQueuePolicyOptions): QueuePolicy {
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
      const resetsAt = typeof c.resetsAt === "string"
        ? c.resetsAt
        : options?.deferReset === true
          ? null
          : nextReset(c.provider, c.window, Date.now(), options?.model);
      return { type: "reset", provider: c.provider, window: c.window, resetsAt };
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

/** Resolve any `reset` conditions whose `resetsAt` was deferred during decode, scoped to the turn's model pool. */
export function resolveQueueResetConditions(
  policy: QueuePolicy,
  selection: { readonly instanceId: string; readonly model?: string | null | undefined },
  now = Date.now(),
): QueuePolicy {
  if (!policy.conditions.some((c) => c.type === "reset" && c.resetsAt === null)) return policy;
  const threadProvider = usageKeyForInstance(selection.instanceId);
  const conditions = policy.conditions.map((condition) => {
    if (condition.type !== "reset" || condition.resetsAt !== null) return condition;
    const model = condition.provider === threadProvider ? selection.model : null;
    const resetsAt = nextReset(condition.provider, condition.window, now, model);
    return resetsAt === null ? condition : { ...condition, resetsAt };
  });
  return { ...policy, conditions };
}

export function automaticUsageBlock(provider: string, config: CliConfig, now = Date.now(), model?: string | null): string[] {
  const windows = usageWindowsForModel(provider, now, model);
  // Providers without a quota feed retain their normal usage-limit behavior.
  return windows.flatMap((window) => {
    const minimum = window.kind === "weekly" ? config.usageMinimumWeekly ?? 5 : window.kind === "session" ? config.usageMinimumSession ?? 3 : 0;
    return window.usedPercent >= 100 || 100 - window.usedPercent < minimum ? [`${provider}: ${window.label} needs ${minimum}% remaining`] : [];
  });
}

export function providerExhausted(provider: string, now = Date.now(), model?: string | null): boolean {
  return usageWindowsForModel(provider, now, model).some((window) => window.usedPercent >= 100);
}

/**
 * Mirrors `isSnoozed` in threads.ts (settled wins there; settled is checked
 * beside this here): a past-due snooze reads as active, not held.
 */
function snoozeActive(snoozedUntil: string | null, now: number): boolean {
  if (snoozedUntil === null) return false;
  const parsed = Date.parse(snoozedUntil);
  return Number.isFinite(parsed) && parsed > now;
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

/**
 * The ledger key one recovered turn origin lives under (`threadId`, `turnId`).
 */
export function turnOriginKey(threadId: string, turnId: string): string {
  return `${threadId}\0${turnId}`;
}

/**
 * Turn origins recovered from the message ledger, keyed as above: a turn
 * written before the turn row carried an origin has it only on its message,
 * and an absent turn origin there never means "the user wrote it". An entry
 * absent from the map means "not loaded", not "human" — recovery is how the
 * record is completed, and asking for an origin that was never loaded
 * answers nothing.
 */
export type TurnOrigins = ReadonlyMap<string, MessageOrigin | undefined>;

/**
 * Load the message-ledger origins for the Antigravity turns whose turn row
 * carries none: while automatic prompts are held (the off-by-default
 * `providers.antigravity.allowUnsupportedUse`) admission must be able to
 * tell an automatic turn from a user turn even for rows written before the
 * turn kept an origin. Nothing is loaded while the setting is on (no gate
 * consults it) or for turns that already say.
 */
export async function loadTurnOrigins(
  store: { readMessages(threadId: string): Promise<readonly StoredMessage[]> },
  rows: readonly QueueRow[],
  config: CliConfig,
): Promise<TurnOrigins> {
  const out = new Map<string, MessageOrigin | undefined>();
  if (antigravityUnsupportedUseAllowed(config)) return out;
  for (const row of rows) {
    const without = row.turns.filter((turn) => turn.origin === undefined
      && driverKindOfInstance((turn.modelSelection ?? row.thread.modelSelection).instanceId) === "antigravity");
    if (without.length === 0) continue;
    const messages = await store.readMessages(row.thread.id).catch(() => [] as readonly StoredMessage[]);
    for (const turn of without) {
      out.set(turnOriginKey(row.thread.id, turn.id), messages.find((message) => message.turnId === turn.id && message.origin !== undefined)?.origin);
    }
  }
  return out;
}

export function queueAdmission(row: QueueRow, turn: StoredTurn, rows: readonly QueueRow[], config: CliConfig, now = Date.now(), origins?: TurnOrigins): { blocked: string[]; latched: number[]; conditions: QueueCondition[] } {
  const policy = turn.queue;
  const blocked: string[] = [];
  const latched = [...(policy?.latched ?? [])];
  const conditions = [...(policy?.conditions ?? [])];
  if (row.thread.usagePause?.forced || row.thread.usagePause && row.thread.usagePause.phase !== "resuming" && row.thread.usagePause.recoveryTurnId !== turn.id && !policy?.summaryFor) blocked.push("Waiting for thread protection");
  if (policy?.wakeUp && row.turns.some((previous) => previous.id !== turn.id && previous.queue?.wakeUp && previous.status === "queued" && (previous.queue.order < policy.order || previous.queue.order === policy.order && row.turns.indexOf(previous) < row.turns.indexOf(turn)))) blocked.push("Waiting for preceding wake-up");
  if (policy?.held || policy?.removed) blocked.push(policy.removed ? "Removed from queue" : "Held by you");
  if (row.thread.archivedAt || row.thread.deletedAt || row.thread.settledAt || snoozeActive(row.thread.snoozedUntil, now)) blocked.push("Thread is not active");
  if (row.thread.hasPendingApprovals || row.thread.hasPendingUserInput) blocked.push("Waiting for your answer or approval");
  if (turn.scheduledFor && Date.parse(turn.scheduledFor) > now) blocked.push(`Scheduled for ${turn.scheduledFor}`);
  const selection = turn.modelSelection ?? row.thread.modelSelection;
  const provider = usageKeyForInstance(selection.instanceId);
  const model = selection.model;
  if (policy?.automatic || turn.scheduleReason === "usage-reset" || turn.scheduleReason === "usage-hold") blocked.push(...automaticUsageBlock(provider, config, now, model));
  else if (providerExhausted(provider, now, model)) blocked.push(`${provider}: usage exhausted`);
  // Antigravity with delegation off starts no automatic prompt on its own:
  // the entry waits for a genuine fresh user action (a user turn authored
  // after it was queued releases it, as ending a usage hold does) or for the
  // setting turning on. Task notices are held in their batch file upstream
  // and ride the user's send, so they are not this path. Provenance comes
  // from the turn row, made whole with the message ledger when the turn row
  // predates its own origin: an absent turn origin is never read as human.
  const origin = turn.origin ?? origins?.get(turnOriginKey(row.thread.id, turn.id));
  const automaticTurn = policy?.automatic === true || policy?.wakeUp === true
    || turn.scheduleReason === "usage-reset" || turn.scheduleReason === "usage-hold"
    || (origin !== undefined && origin !== "task-notification");
  if (automaticTurn && driverKindOfInstance(selection.instanceId) === "antigravity" && !antigravityUnsupportedUseAllowed(config)) {
    // Fresh consent is a manual user turn authored after this entry was
    // queued, dated by when the user submitted it (`createdAt`), never by
    // when its turn happened to start: a scheduled message that fires late
    // does not authorize work queued behind its timer, and a scheduled or
    // automatic turn is not consent at all.
    const userResumed = row.turns.some((other) => other.id !== turn.id
      && (other.origin ?? origins?.get(turnOriginKey(row.thread.id, other.id))) === undefined
      && other.queue?.automatic !== true && other.queue?.wakeUp !== true
      && !other.scheduledFor
      && other.scheduleReason !== "usage-reset" && other.scheduleReason !== "usage-hold"
      && (other.status === "running" || other.status === "completed")
      && Date.parse(other.createdAt) >= Date.parse(turn.createdAt));
    if (!userResumed) blocked.push("Antigravity automatic prompts are held: turn on providers.antigravity.allowUnsupportedUse");
  }
  for (const [index, condition] of (policy?.conditions ?? []).entries()) {
    if (condition.type === "at") { if (Date.parse(condition.at) > now) blocked.push(`Waiting until ${condition.at}`); }
    else if (condition.type === "usage") {
      const condModel = condition.provider === provider ? model : null;
      const windows = usageWindowsForModel(condition.provider, now, condModel).filter((w) => condition.window === "all" || w.kind === condition.window);
      if (!windows.length) blocked.push(`${condition.provider}: usage unavailable`);
      else if (windows.some((w) => w.usedPercent >= 100 || 100 - w.usedPercent < condition.minimum)) blocked.push(`${condition.provider}: needs ${condition.minimum}% ${condition.window} remaining`);
    } else if (condition.type === "reset") {
      const condModel = condition.provider === provider ? model : null;
      const resetsAt = condition.resetsAt ?? nextReset(condition.provider, condition.window, now, condModel);
      if (resetsAt && !condition.resetsAt) conditions[index] = { ...condition, resetsAt };
      if (!resetsAt || Date.parse(resetsAt) + QUEUE_RESET_GRACE_MS > now) blocked.push(`${condition.provider}: waiting for ${condition.window} reset`);
    } else if (condition.type === "provider") {
      const condModel = condition.provider === provider ? model : null;
      const met = condition.state === "exhausted" ? providerExhausted(condition.provider, now, condModel)
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
  if (rows.some((r) => r.turns.some((t) => t.status === "running" && t.queue && (policy?.sequential || t.queue.sequential) && t.id !== turn.id && usageKeyForInstance((t.modelSelection ?? r.thread.modelSelection).instanceId) === provider))) blocked.push(`${provider}: preceding queue entry is running`);
  return { blocked, latched, conditions };
}

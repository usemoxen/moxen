import { CliError } from "../errors.js";
import { antigravityUnsupportedUseAllowed, driverKindOfInstance, type CliConfig } from "../types.js";
import { usageKeyForInstance, usageSignal, usageWindowsForModel } from "../usage/limits.js";
import type { MessageOrigin, StoredMessage, StoredThread, StoredTurn } from "./types.js";

export const QUEUE_RESET_GRACE_MS = 5000;
export const QUEUE_ADMISSION_LOCK = "\0queue-admission";

/**
 * A provider key is data, never a JavaScript prototype member: `constructor`
 * or `__proto__` as a provider would otherwise resolve to an inherited value
 * and break the whole queue (`x?.windows.filter` on `undefined`). Unknown
 * providers stay allowed; they simply have no windows yet.
 */
function accountKey(provider: string): string | null {
  const key = usageKeyForInstance(provider);
  return key === "__proto__" || key === "prototype" || Object.hasOwn(Object.prototype, key) ? null : key;
}

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
  | {
      readonly type: "entry";
      readonly threadId: string;
      readonly turnId: string;
      /**
       * Identifies this condition as the wait a transfer's move machinery
       * wrote on its destination's handoff turn — the only condition a later
       * move replaces. `parseQueuePolicy` rebuilds conditions field for field
       * without it, so no client edit can forge it or keep it through an
       * echo; a row written before the mark carries none and keeps whatever
       * its entry conditions say.
       */
      readonly serverWait?: true;
    };

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
  /**
   * Internal state: how many user messages a moved entry must carry before it
   * may run. Only the transfer machinery writes it (clients cannot forge it
   * or keep it through an echo, since `parseQueuePolicy` rebuilds policies
   * without it), and rows written before it carry none and fall back to one:
   * a message that has landed and none required missing.
   */
  readonly transferMessages?: number;
  readonly requestId?: string;
  readonly summaryFor?: string;
  readonly eventAfter?: string;
  readonly removed?: boolean;
}

export interface QueueRow { readonly thread: StoredThread; readonly turns: readonly StoredTurn[] }

/**
 * A manual "Continue in a new thread" moves the source's pending ordinary
 * messages to the destination as Work queue entries. The source turn is
 * marked with `transfer:<source turn id>` (inert: interrupted and removed),
 * and the destination entry carries `handoff:transfer:<source turn id>` as
 * its queue request id — so entry conditions elsewhere that named the
 * source turn follow the handoff to the destination, the way
 * `entryPending` follows queue-handoff rows. Queue-selected model/stored
 * handoffs use their own `handoff` rows and never carry this prefix.
 */
export const TRANSFER_REQUEST_PREFIX = "transfer:";

export function transferRequestId(sourceTurnId: string): string {
  return `${TRANSFER_REQUEST_PREFIX}${sourceTurnId}`;
}

export function transferDestinationRequestId(sourceTurnId: string): string {
  return `handoff:${transferRequestId(sourceTurnId)}`;
}

/** Whether this turn was moved to a continuation by a manual continue (never a queue handoff). */
export function isTransferredTurn(turn: StoredTurn): boolean {
  return turn.handoff?.requestId?.startsWith(TRANSFER_REQUEST_PREFIX) === true;
}

/**
 * Whether this turn's move actually landed on the destination: staged claims
 * carry the marker without the flag, so only a completed markTransferMoved
 * counts. Entries elsewhere that follow the handoff keep waiting on a
 * landed move, never on a bare claim.
 */
export function isTransferLanded(turn: StoredTurn): boolean {
  return isTransferredTurn(turn) && turn.handoff?.landed === true;
}

/** Whether this queue request id is a manual-continue transfer's destination entry. */
export function isTransferDestinationRequestId(requestId: string | undefined): boolean {
  return requestId?.startsWith(`handoff:${TRANSFER_REQUEST_PREFIX}`) === true;
}

export interface WorkQueueEntry {
  readonly threadId: string; readonly turnId: string; readonly title: string; readonly prompt: string;
  readonly provider: string; readonly status: string; readonly policy: QueuePolicy;
  readonly blocked: readonly string[]; readonly scheduledFor: string | null;
  /** The agent thread that queued this entry with `message_queue`; only it may list or change it (MXN-401). */
  readonly agentThreadId?: string;
  /** Whether the turn reached the provider. A restored retry keeps this true even while queued. */
  readonly started?: boolean;
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
    if (c.type === "usage" && id(c.provider) && typeof c.window === "string" && ["session", "weekly", "all"].includes(c.window) && typeof c.minimum === "number" && Number.isFinite(c.minimum) && c.minimum >= 0 && c.minimum <= 100) {
      const provider = accountKey(c.provider);
      if (provider === null) return bad();
      return { type: "usage", provider, window: c.window as "session" | "weekly" | "all", minimum: c.minimum };
    }
    if (c.type === "reset" && id(c.provider) && (c.window === "session" || c.window === "weekly" || c.window === "all")) {
      if (c.resetsAt !== undefined && c.resetsAt !== null && (typeof c.resetsAt !== "string" || !Number.isFinite(Date.parse(c.resetsAt)))) return bad();
      const provider = accountKey(c.provider);
      if (provider === null) return bad();
      const resetsAt = typeof c.resetsAt === "string"
        ? c.resetsAt
        : options?.deferReset === true
          ? null
          : nextReset(provider, c.window, Date.now(), options?.model);
      return { type: "reset", provider, window: c.window, resetsAt };
    }
    if (c.type === "provider" && id(c.provider) && (c.state === "exhausted" || c.state === "protected") && (c.mode === "after" || c.mode === "while")) {
      const provider = accountKey(c.provider);
      if (provider === null) return bad();
      return { type: "provider", provider, state: c.state, mode: c.mode };
    }
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
 * Whether a thread is snoozed right now: its `snoozedUntil` still lies ahead,
 * or its snooze waits on conditions (`task_snooze`) a pass has yet to clear.
 * The one stored-thread rule, read by the store status, queue admission, usage
 * protection and the wake pass; `isSnoozedThread` in `views.ts` is the same
 * rule over a client's envelope. Settled is checked beside it, and settled
 * wins there.
 */
export function snoozeActive(thread: StoredThread, now: number = Date.now()): boolean {
  if (hasSnoozeConditions(thread)) return true;
  if (thread.snoozedUntil === null) return false;
  const parsed = Date.parse(thread.snoozedUntil);
  return Number.isFinite(parsed) && parsed > now;
}

/** Whether this thread's snooze ends on conditions rather than only on the clock. */
export function hasSnoozeConditions(thread: StoredThread): boolean {
  return (thread.snoozeConditions?.length ?? 0) > 0;
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
  config: Pick<CliConfig, "providers">,
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

/** The hold every gate reports for an automatic prompt Antigravity must not receive. */
export const ANTIGRAVITY_HELD_MESSAGE = "Antigravity automatic prompts are held: turn on providers.antigravity.allowUnsupportedUse";

/**
 * Whether dispatching `turn` as a turn of its own would send one of Moxen's
 * automatic prompts rather than a message the user wrote: the queue's own
 * flags, a usage schedule, or an origin. At the dispatch boundary every
 * origin says as much — a task or background notice is dispatched as its
 * own turn there too — with the one exception of `ridesUserTurn`: a notice
 * that queued behind a user turn may go out with that turn's completion.
 *
 * This is the one provenance decision the Antigravity gates share (`queueAdmission`,
 * promotion, recovery and the dispatch boundary itself): they must never
 * drift apart on what counts as automatic.
 */
export function automaticDispatchPrompt(turn: StoredTurn, origin: MessageOrigin | undefined, turns?: readonly StoredTurn[]): boolean {
  if (turn.queue?.automatic === true || turn.queue?.wakeUp === true) return true;
  if (turn.scheduleReason === "usage-reset" || turn.scheduleReason === "usage-hold") return true;
  if (origin === undefined) return false;
  if (origin !== "task-notification" && origin !== "background-notification") return true;
  return !(turns !== undefined && noticeRidesUserTurn(turns, turn));
}

/**
 * Whether a turn is one the user wrote: no origin, not marked as Moxen's own
 * dispatch, none of the queue's automatic flags, none of the usage
 * schedules, and not the generated hand-off opener. Moxen-written prompts never count, whatever their kind —
 * the one predicate every exception that needs "the user's own turn" shares.
 * A hand-off opener is a document Moxen authored, so it can never vouch for
 * an automatic entry as the user's own turn (LOCAL-034).
 */
export function userAuthoredTurn(turn: StoredTurn): boolean {
  return turn.origin === undefined
    && turn.automatic !== true
    && turn.handoffOpen !== true
    && turn.queue?.automatic !== true && turn.queue?.wakeUp !== true
    && turn.scheduleReason !== "usage-reset" && turn.scheduleReason !== "usage-hold";
}

/**
 * Whether a turn, once it runs, is the user's fresh consent for automatic
 * entries queued before it: one the user wrote and sent for then. A scheduled
 * message that fires late authorizes nothing queued behind its timer.
 * `origin` is the turn's, made whole with the message ledger for turns written
 * before the row carried one.
 */
export function userConsentTurn(turn: StoredTurn, origin: MessageOrigin | undefined): boolean {
  return origin === undefined && userAuthoredTurn(turn) && !turn.scheduledFor;
}

/**
 * Whether a notice turn still rides the user turn it was queued behind: the
 * nearest terminal turn before it completed as the user's own. The notice's
 * exception ends there — an interrupted or failed turn never carried it, and
 * a recovery that redelivers the notice standalone dispatches an automatic
 * prompt like any other. Turns still queued when it was filed never ran, so
 * the live turn it waited on is further back.
 */
function noticeRidesUserTurn(turns: readonly StoredTurn[], turn: StoredTurn): boolean {
  const index = turns.findIndex((candidate) => candidate.id === turn.id);
  if (index <= 0) return false;
  for (let at = index - 1; at >= 0; at -= 1) {
    const candidate = turns[at]!;
    if (candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "interrupted") continue;
    return candidate.status === "completed" && userAuthoredTurn(candidate);
  }
  return false;
}

/**
 * Whether fresh consent releases a held automatic entry: a manual user
 * turn authored after this entry was queued has run or completed, dated by
 * when the user submitted it (`createdAt`), never by when its turn happened
 * to start: a scheduled message that fires late does not authorize work
 * queued behind its timer, and a scheduled or automatic turn is not consent
 * at all. An equal timestamp is never proof of a later send on its own —
 * the generated handoff turn and a moved entry can be stamped in one
 * millisecond — so "later" leans on the ledger's durable append order
 * instead: the consent turn must have been written after this entry's row
 * (the handoff of a move is always written before the copy that waits on
 * it, so it can never vouch for it). Timestamps take over only when the row
 * is missing from this snapshot and there is no order to read.
 */
export function freshUserConsentReleases(turns: readonly StoredTurn[], turn: StoredTurn, threadId?: string, origins?: TurnOrigins): boolean {
  const queuedAt = turns.findIndex((candidate) => candidate.id === turn.id);
  return turns.some((other, index) => other.id !== turn.id
    && userConsentTurn(other, other.origin ?? (threadId !== undefined && origins !== undefined ? origins.get(turnOriginKey(threadId, other.id)) : undefined))
    && (other.status === "running" || other.status === "completed")
    && (queuedAt < 0
      ? Date.parse(other.createdAt) > Date.parse(turn.createdAt)
      : index > queuedAt && Date.parse(other.createdAt) >= Date.parse(turn.createdAt)));
}

/**
 * The one Antigravity dispatch gate, shared by every path that hands a
 * prompt to an Antigravity driver: while `allowUnsupportedUse` is off (the
 * default) an automatic prompt is held rather than dispatched. `providers`
 * is the setting in force at the moment of the decision — the dispatching
 * operation's config — never an earlier turn's snapshot.
 */
export function antigravityHoldsAutomaticDispatch(
  providers: Pick<CliConfig, "providers">["providers"],
  instanceId: string,
  turn: StoredTurn,
  origin: MessageOrigin | undefined,
  turns?: readonly StoredTurn[],
): boolean {
  return driverKindOfInstance(instanceId) === "antigravity"
    && providers?.antigravity?.allowUnsupportedUse !== true
    && automaticDispatchPrompt(turn, origin, turns);
}

/**
 * The dispatch boundary's decision, split from its facts so no caller can
 * pass a snapshot (LOCAL-034): the caller resolves every asynchronous fact
 * first (the turn's row, its provenance made whole with the message ledger,
 * the fresh consent that releases a held entry), then reads THIS
 * synchronously with the setting in force at the moment of dispatch — the
 * driver's send going out right after it, nothing awaited in between.
 */
export interface AntigravityDispatchGate {
  /** Whether the dispatch is denied: `providersInForce` is read at the call, not before. */
  holds(providersInForce: () => Pick<CliConfig, "providers">["providers"] | undefined): boolean;
}

/**
 * Resolve the dispatch decision's facts for a turn a runner is about to put
 * in front of a driver: whether Antigravity's gate holds it, decided as the
 * dispatch happens. `antigravityDispatchGate` resolves the facts; the
 * closure it returns reads the setting in force — never an earlier turn's
 * or operation's config snapshot.
 *
 * Null when nothing running could be denied (no turn row, not Antigravity,
 * not an automatic prompt, or fresh user consent releases it), so the
 * caller dispatches with no gate. Unreadable rows fail closed: the closure
 * holds regardless of the setting, so an unreadable ledger never sends. A
 * turn no longer running denies nothing, so a concurrent settle keeps its
 * own behavior.
 */
export async function antigravityDispatchGate(
  store: { readThreadRecord(threadId: string): Promise<StoredThread | null>; readTurns(threadId: string): Promise<readonly StoredTurn[]>; readMessages(threadId: string): Promise<readonly StoredMessage[]> },
  threadId: string,
  turnId: string,
): Promise<AntigravityDispatchGate | null> {
  const thread = await store.readThreadRecord(threadId).catch(() => null);
  if (!thread) return { holds: () => true };
  const turns = await store.readTurns(threadId).catch(() => null);
  if (turns === null) return { holds: () => true };
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.status !== "running") return null;
  if (driverKindOfInstance((turn.modelSelection ?? thread.modelSelection).instanceId) !== "antigravity") return null;
  // Provenance loads unconditionally: the facts cannot depend on a setting
  // the decision has not read yet.
  const origins = await loadTurnOrigins(store, [{ thread, turns }], {}).catch(() => null);
  if (origins === null) return { holds: (providersInForce) => providersInForce()?.antigravity?.allowUnsupportedUse !== true };
  const origin = turn.origin ?? origins.get(turnOriginKey(threadId, turnId));
  if (!automaticDispatchPrompt(turn, origin, turns)) return null;
  if (freshUserConsentReleases(turns, turn, threadId, origins)) return null;
  return { holds: (providersInForce) => providersInForce()?.antigravity?.allowUnsupportedUse !== true };
}

/**
 * The steer boundary's decision, split from its facts the same way
 * (LOCAL-034): the caller resolves the factual side — the target turn's row,
 * read after whatever it awaited to reach the boundary — then reads THIS
 * synchronously with the setting in force at the moment of the steer, the
 * driver's steer going out right after it, nothing awaited in between.
 */
export interface AntigravitySteerRefusal {
  /**
   * The turn the caller meant to ride is no longer the running one — it
   * settled, or another turn replaced it — so there is nothing left to
   * steer. That is a race, not a decision about the notice: the caller files
   * the notice as a turn of its own rather than keeping it for the user's
   * next message.
   */
  targetGone(): boolean;
  /**
   * The policy alone: an automatic steer into a turn the user did not write,
   * on Antigravity with `allowUnsupportedUse` off. A notice this refuses is
   * kept durable, never retried, never filed as a turn of its own.
   */
  policyRefuses(providersInForce: () => Pick<CliConfig, "providers">["providers"] | undefined): boolean;
  refuses(providersInForce: () => Pick<CliConfig, "providers">["providers"] | undefined, payloadAutomatic: boolean): boolean;
}

/**
 * Whether the steer the caller is about to hand a driver breaches the
 * Antigravity gate. The ride exception is narrow: an automatic prompt may
 * ride only a specific live turn the user wrote, and only one still running
 * when the steer leaves. A target that died, or a turn Moxen started,
 * refuses the steer so the caller keeps the notice durable instead — a
 * refused steer never dispatches one of its own. The user's own steer is
 * never held here, and an opted-in thread steers into any live turn.
 */
export async function antigravitySteerGate(
  store: { readThreadRecord(threadId: string): Promise<StoredThread | null>; readTurns(threadId: string): Promise<readonly StoredTurn[]> },
  threadId: string,
  expectedTurnId?: string,
): Promise<AntigravitySteerRefusal> {
  const thread = await store.readThreadRecord(threadId).catch(() => null);
  const turns = thread !== null ? await store.readTurns(threadId).catch(() => null) : null;
  const target = (turns ?? []).find((turn) => turn.status === "running") ?? null;
  const selection = target?.modelSelection ?? thread?.modelSelection ?? null;
  const targetAntigravity = selection !== null && driverKindOfInstance(selection.instanceId) === "antigravity";
  const targetGone = () => target === null || (expectedTurnId !== undefined && target.id !== expectedTurnId);
  const policyRefuses = (providersInForce: () => Pick<CliConfig, "providers">["providers"] | undefined) => {
    if (target !== null && userAuthoredTurn(target)) return false;
    return targetAntigravity && providersInForce()?.antigravity?.allowUnsupportedUse !== true;
  };
  return {
    targetGone,
    policyRefuses,
    refuses: (providersInForce, payloadAutomatic) => {
      if (!payloadAutomatic) return false;
      if (targetGone()) return true;
      return policyRefuses(providersInForce);
    },
  };
}

export function queueAdmission(row: QueueRow, turn: StoredTurn, rows: readonly QueueRow[], config: CliConfig, now = Date.now(), origins?: TurnOrigins): { blocked: string[]; latched: number[]; conditions: QueueCondition[] } {
  const policy = turn.queue;
  const blocked: string[] = [];
  if (row.thread.usagePause?.forced || row.thread.usagePause && row.thread.usagePause.phase !== "resuming" && row.thread.usagePause.recoveryTurnId !== turn.id && !policy?.summaryFor) blocked.push("Waiting for thread protection");
  if (policy?.wakeUp && row.turns.some((previous) => previous.id !== turn.id && previous.queue?.wakeUp && previous.status === "queued" && (previous.queue.order < policy.order || previous.queue.order === policy.order && row.turns.indexOf(previous) < row.turns.indexOf(turn)))) blocked.push("Waiting for preceding wake-up");
  if (policy?.held || policy?.removed) blocked.push(policy.removed ? "Removed from queue" : "Held by you");
  if (row.thread.archivedAt || row.thread.deletedAt || row.thread.settledAt || snoozeActive(row.thread, now)) blocked.push("Thread is not active");
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
  // setting turning on. Provenance comes from the turn row, made whole with
  // the message ledger when the turn row predates its own origin: an absent
  // turn origin is never read as human. What counts as automatic is the one
  // shared decision (`automaticDispatchPrompt`): a task notice queued
  // behind a live user turn still rides it, and one that no longer does —
  // held in its batch upstream, redelivered standalone — is held like any
  // other automatic prompt.
  const origin = turn.origin ?? origins?.get(turnOriginKey(row.thread.id, turn.id));
  const automaticTurn = automaticDispatchPrompt(turn, origin, row.turns);
  if (automaticTurn && driverKindOfInstance(selection.instanceId) === "antigravity" && !antigravityUnsupportedUseAllowed(config)) {
    if (!freshUserConsentReleases(row.turns, turn, row.thread.id, origins)) blocked.push(ANTIGRAVITY_HELD_MESSAGE);
  }
  const pass = conditionBlockers({
    conditions: policy?.conditions ?? [],
    since: policy?.eventAfter ?? turn.createdAt,
    provider,
    model,
    rows,
    now,
    latched: policy?.latched,
  });
  blocked.push(...pass.blocked);
  if (rows.some((r) => r.thread.id === row.thread.id && r.turns.some((t) => t.status === "running" && t.id !== turn.id))) blocked.push("Thread is running");
  if (rows.some((r) => r.turns.some((t) => t.status === "running" && t.queue && (policy?.sequential || t.queue.sequential) && t.id !== turn.id && usageKeyForInstance((t.modelSelection ?? r.thread.modelSelection).instanceId) === provider))) blocked.push(`${provider}: preceding queue entry is running`);
  return { blocked, latched: pass.latched, conditions: pass.conditions };
}

/** What a set of queue conditions needs to be judged against. */
export interface ConditionsPass {
  readonly conditions: readonly QueueCondition[];
  /**
   * When the waiting thing was created: a `provider … after` signal must have
   * come at or after this. A queued turn passes its own creation (or the
   * policy's `eventAfter`); a snooze passes when the snooze was set.
   */
  readonly since: string;
  /** The provider the waiting thread runs on (`usageKeyForInstance`), and its model. */
  readonly provider: string;
  readonly model?: string | null | undefined;
  readonly rows: readonly QueueRow[];
  readonly now: number;
  /** Indices of `provider … after` conditions whose event was already seen. */
  readonly latched?: readonly number[] | null | undefined;
}

/**
 * What these conditions still wait for, and the pass's own state back: a
 * `reset` condition learns the reset time it is waiting for (so the caller can
 * store it), and a `provider … after` condition latches once its event was
 * seen. Shared by queue admission and by a snooze that ends on conditions
 * (`task_snooze`), so a snoozed task and a queued message wait for exactly the
 * same things.
 */
export function conditionBlockers(pass: ConditionsPass): { blocked: string[]; latched: number[]; conditions: QueueCondition[] } {
  const { provider, model, rows, now, since } = pass;
  const blocked: string[] = [];
  const latched = [...(pass.latched ?? [])];
  const conditions = [...pass.conditions];
  for (const [index, condition] of conditions.entries()) {
    if (condition.type === "at") { if (Date.parse(condition.at) > now) blocked.push(`Waiting until ${condition.at}`); }
    else if (condition.type === "usage") {
      const canonical = accountKey(condition.provider);
      if (canonical === null) { blocked.push(`${condition.provider}: usage unavailable`); continue; }
      if (canonical !== condition.provider) conditions[index] = { ...condition, provider: canonical };
      const condModel = canonical === provider ? model : null;
      const windows = usageWindowsForModel(canonical, now, condModel).filter((w) => condition.window === "all" || w.kind === condition.window);
      if (!windows.length) blocked.push(`${canonical}: usage unavailable`);
      else if (windows.some((w) => w.usedPercent >= 100 || 100 - w.usedPercent < condition.minimum)) blocked.push(`${canonical}: needs ${condition.minimum}% ${condition.window} remaining`);
    } else if (condition.type === "reset") {
      const canonical = accountKey(condition.provider);
      if (canonical === null) { blocked.push(`${condition.provider}: usage unavailable`); continue; }
      if (canonical !== condition.provider) conditions[index] = { ...condition, provider: canonical };
      const condModel = canonical === provider ? model : null;
      // A window kind the provider still reports nothing for is a reset that
      // can never come: it was withdrawn (Google's separate Argon quota), and
      // a hold keyed on it would wait forever. A provider reporting no windows
      // at all keeps waiting — unavailable is not a reset.
      const reported = usageWindowsForModel(canonical, now, condModel);
      const withdrawn = condition.window !== "all" && reported.length > 0 && !reported.some((window) => window.kind === condition.window);
      if (!withdrawn) {
        const resetsAt = condition.resetsAt ?? nextReset(canonical, condition.window, now, condModel);
        if (canonical !== condition.provider || resetsAt && !condition.resetsAt) conditions[index] = { ...condition, ...(canonical !== condition.provider ? { provider: canonical } : {}), ...(resetsAt ? { resetsAt } : {}) };
        if (!resetsAt || Date.parse(resetsAt) + QUEUE_RESET_GRACE_MS > now) blocked.push(`${canonical}: waiting for ${condition.window} reset`);
      }
    } else if (condition.type === "provider") {
      const canonical = accountKey(condition.provider);
      if (canonical === null) { blocked.push(`${condition.provider}: usage unavailable`); continue; }
      if (canonical !== condition.provider) conditions[index] = { ...condition, provider: canonical };
      const condModel = canonical === provider ? model : null;
      const met = condition.state === "exhausted" ? providerExhausted(canonical, now, condModel)
        : rows.some((r) => r.thread.usagePause?.provider === canonical && r.thread.usagePause.phase !== "resuming");
      const signal = usageSignal(canonical, condition.state);
      const happened = signal !== null && Date.parse(signal) >= Date.parse(since);
      if (condition.mode === "after" && (met || happened) && !latched.includes(index)) latched.push(index);
      if (!(condition.mode === "after" ? latched.includes(index) : met)) blocked.push(`${condition.mode} ${canonical} is ${condition.state}`);
    } else {
      // A dependency condition a client wrote without the thread (or, for an
      // entry, without the turn) can never be judged: it is skipped rather than
      // waited on forever, which would wedge its queue entry and its snooze.
      const named = condition.type === "entry" ? condition.threadId && condition.turnId : condition.threadId;
      if (!named) continue;
      const dependency = rows.find((r) => r.thread.id === condition.threadId);
      if (!dependency) blocked.push("Dependency is unavailable");
      else if (condition.type === "entry" ? entryPending(rows, condition.threadId, condition.turnId) : dependency.turns.some((t) => t.status === "running" || t.status === "queued")) blocked.push(`Waiting for ${dependency.thread.title}`);
    }
  }
  return { blocked, latched, conditions };
}

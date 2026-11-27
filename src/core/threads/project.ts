/**
 * Ledger-local projection into the envelope shapes (`ThreadEnvelope`,
 * `MessageEnvelope`, …). The store owns the truth; this module renders it in
 * the shapes the CLI envelopes and the TUI projectors already speak, so
 * cutover repoints the transport without renegotiating behavior.
 *
 * Derivations (documented once, applied everywhere):
 * - `latestTurn`: latest non-queued turn (`queued` has no envelope state);
 *   `error` → `"error"`, everything else maps 1:1.
 * - `session`: `running` while a turn runs (activeTurnId set), else
 *   `idle`; provider from the thread's model selection.
 * - `branch`/`worktreePath` from `env` (`worktreePath` set only in
 *   worktree mode).
 * - messages carry `streaming: false`, `updatedAt = createdAt`
 *   (streaming state is a subscription-frame concern, not ledger state).
 * - activities default to tone `"info"`; plans are always `[]` (no
 *   plan capture is wired yet — empty, never invented).
 */
import type {
  CheckpointEnvelope,
  LatestTurnEnvelope,
  MessageEnvelope,
  ProposedPlanEnvelope,
  SessionEnvelope,
  ThreadEnvelope,
  ActivityEnvelope,
  TurnInteractionMode,
} from "../types.js";
import { maintenanceTurnIds } from "./maintenance.js";
import { isKnownTurnStatus } from "./problems.js";
import type {
  StoredActivity,
  StoredCheckpoint,
  StoredMessage,
  StoredThread,
  StoredTurn,
} from "./types.js";

/**
 * Whether this turn is one of the thread's turns as a reader sees them: it
 * left the queue and ran. A queued message that never started — still
 * waiting, interrupted before it ran, or handed off to a new thread — is not
 * a turn, and counting it would insert it among turns a reader already has
 * (and renumber them).
 *
 * `startedAt` is set whenever a queued turn is promoted; a turn that ran at
 * once started at its `createdAt`, and a queued turn that reached a terminal
 * status (completed or failed) ran even if an old row did not record when.
 * The exception is an entry the queue pass leaves this thread by preparing a
 * handoff: it settles the row (completed, or failed preparing) without a
 * start. A row that reserved a handoff carries that record — written before
 * any work that can fail, kept across an edit (unlike the queue policy's
 * `continuation`), and present since 644a414d, before the 2026-11-06 baseline.
 * A failure before the reservation is marked by the terminal `failed` write
 * itself (`handoffFailed`). `startedAt` still wins: an entry restored here and
 * then run is a turn. A preflight failure written by a build before that mark
 * existed is indistinguishable from a legacy run and keeps the fallback.
 */
function turnRan(turn: StoredTurn): boolean {
  if (turn.status === "queued") return false;
  if (turn.startedAt === undefined && (turn.handoff !== undefined || turn.handoffFailed === true)) return false;
  return !(turn.status === "interrupted" && turn.startedAt === undefined && turn.delivery === "queued");
}

function runAt(turn: StoredTurn): number {
  return Date.parse(turn.startedAt ?? turn.createdAt);
}

/**
 * The thread's turns in the order they ran: the numbering every reader shows.
 * Ledger row order is not that order — a message queued before a later turn
 * starts after it — so numbering by row would move turns a client has
 * already seen. Ties keep ledger order.
 */
export function ranTurns(turns: readonly StoredTurn[]): StoredTurn[] {
  return turns.filter(turnRan).sort((left, right) => runAt(left) - runAt(right));
}

/**
 * Each turn that ran, by id, to the ordinal every reader numbers it with
 * (1-based, `ranTurns` order). One projection for checkpoint counts, the
 * Markdown export and a handoff document, so none of them can number a row
 * that never ran or miss a turn whose checkpoint write failed.
 */
export function turnOrdinals(turns: readonly StoredTurn[]): Map<string, number> {
  return new Map(ranTurns(turns).map((turn, index) => [turn.id, index + 1] as const));
}

function latestMeaningfulTurn(turns: StoredTurn[]): StoredTurn | null {
  return ranTurns(turns).at(-1) ?? null;
}

function latestTurnOf(turns: StoredTurn[]): LatestTurnEnvelope | null {
  const latest = latestMeaningfulTurn(turns);
  if (!latest) return null;
  return {
    turnId: latest.id,
    state:
      latest.status === "running"
        ? "running"
        : latest.status === "interrupted"
          ? "interrupted"
          : latest.status === "failed"
            ? "error"
            : latest.status === "completed"
              ? "completed"
              : "unknown",
    requestedAt: latest.createdAt,
    // A turn that waited in the queue started when it was promoted, not
    // when it was asked for — its live clock must not count the wait.
    startedAt: latest.startedAt ?? latest.createdAt,
    completedAt: latest.completedAt,
    assistantMessageId: null,
  };
}

function sessionOf(thread: StoredThread, turns: StoredTurn[]): SessionEnvelope {
  // Live is running or stuck: a status no build writes never settles on its
  // own, so the session must not report idle while one is open.
  const running = turns.find((turn) => turn.status === "running" || !isKnownTurnStatus(turn.status)) ?? null;
  return {
    threadId: thread.id,
    status: running ? "running" : "idle",
    providerName: thread.modelSelection.instanceId,
    runtimeMode: thread.runtimeMode,
    activeTurnId: running?.id ?? null,
    lastError: null,
    updatedAt: thread.updatedAt,
  };
}

export function toMessageEnvelope(message: StoredMessage): MessageEnvelope {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    streaming: false,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.origin !== undefined ? { origin: message.origin, ...(message.notification ? { notification: message.notification } : {}) } : {}),
  };
}

export function toActivityEnvelope(activity: StoredActivity): ActivityEnvelope {
  return {
    id: activity.id,
    tone: "info",
    kind: activity.kind,
    summary: activity.summary,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
    // Tool rows only render as rich cards when their payload survives the
    // projection; without it every one degrades to a bare summary note.
    ...(activity.payload === undefined ? {} : { payload: activity.payload }),
  };
}

export function toCheckpointEnvelope(checkpoint: StoredCheckpoint, turnCount: number): CheckpointEnvelope {
  return {
    turnId: checkpoint.turnId,
    status: checkpoint.status,
    checkpointTurnCount: turnCount,
    ref: checkpoint.ref,
    baseRef: checkpoint.baseRef,
    ...(checkpoint.files === undefined ? {} : { files: checkpoint.files }),
  };
}

export interface ProjectThreadInput {
  readonly messages?: StoredMessage[] | undefined;
  readonly activities?: StoredActivity[] | undefined;
  readonly checkpoints?: StoredCheckpoint[] | undefined;
  readonly plans?: ProposedPlanEnvelope[] | undefined;
  /** The delegating thread, when this one is a delegated task. */
  readonly parentThreadId?: string | undefined;
  /** Include the canonical turn ordinals (turn id → run order) in the envelope. */
  readonly turnOrdinals?: boolean | undefined;
}

/** Ledger-local projection into the envelope thread shape. */
export function toThreadEnvelope(thread: StoredThread, turns: StoredTurn[], input: ProjectThreadInput = {}): ThreadEnvelope {
  const running = turns.find((turn) => turn.status === "running") ?? null;
  const latestUser = [...(input.messages ?? [])].reverse().find((message) => message.role === "user") ?? null;
  // `checkpointTurnCount` is how many turns the thread had once this one
  // finished — 1-based, as every consumer reads it (the TUI's revert target
  // is `count - 1`; `turnDiff(threadId, count)` reads `ranTurns()[count - 1]`).
  // Only turns that ran count: a queued or never-started message is not one of
  // them, so adding one cannot renumber checkpoints of turns already seen.
  const ordinals = turnOrdinals(turns);
  const queued = turns
    .filter((turn) => turn.status === "queued")
    .map((turn) => ({
      turnId: turn.id,
      messageId: turn.messageId,
      scheduledFor: turn.scheduledFor ?? null,
      scheduleReason: turn.scheduleReason ?? null,
    }));
  const turnModes: Record<string, TurnInteractionMode> = {};
  const turnUsagePauses = Object.fromEntries(turns.flatMap((turn) => turn.usagePause ? [[turn.id, turn.usagePause]] : []));
  // Maintenance turns are not work (see `maintenanceTurnIds`).
  const maintenanceTurns = maintenanceTurnIds(turns, input.messages ?? []);
  for (const turn of turns) {
    // A queued message that follows the thread takes its mode when it starts (MXN-223): until then it has none to show.
    if (turn.interactionMode === "default" || (turn.status === "queued" && turn.interactionModeExplicit !== true)) continue;
    turnModes[turn.id] = { mode: turn.interactionMode, ...(turn.interactionModeExplicit ? { oneOff: true as const } : {}) };
  }
  return {
    id: thread.id,
    projectId: thread.projectId,
    ...(thread.hidden === true ? { hidden: true } : {}),
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.env.branch,
    worktreePath: thread.env.mode === "worktree" ? thread.env.path : null,
    latestTurn: latestTurnOf(turns),
    session: sessionOf(thread, turns),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    // Only for a snooze that waits on conditions, so every other envelope stays byte-for-byte as it was.
    ...(thread.snoozeConditions ? { snoozeConditions: thread.snoozeConditions.map((condition) => ({ ...condition })) } : {}),
    latestUserMessageAt: latestUser?.createdAt ?? null,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    ...(input.messages ? { messages: input.messages.map(toMessageEnvelope) } : {}),
    ...(input.activities ? { activities: input.activities.map(toActivityEnvelope) } : {}),
    ...(input.checkpoints
      ? { checkpoints: input.checkpoints.map((checkpoint) => toCheckpointEnvelope(checkpoint, ordinals.get(checkpoint.turnId) ?? 0)) }
      : {}),
    proposedPlans: input.plans ?? [],
    ...(input.turnOrdinals ? { turnOrdinals: Object.fromEntries(ordinals) } : {}),
    turnModelSelections: Object.fromEntries(
      turns.flatMap((turn) => (turn.modelSelection ? [[turn.id, turn.modelSelection] as const] : [])),
    ),
    // Only when a turn ran outside Build, so older envelopes stay byte-for-byte as they were.
    ...(Object.keys(turnModes).length > 0 ? { turnInteractionModes: turnModes } : {}),
    ...(maintenanceTurns.length > 0 ? { maintenanceTurns } : {}),
    ...(Object.keys(turnUsagePauses).length > 0 ? { turnUsagePauses } : {}),
    ...(thread.usagePause && (thread.usagePause.forced || thread.usagePause.phase !== "resuming") ? { protection: {
      protected: true as const, forced: thread.usagePause.forced === true,
      waitingWakeUps: turns.filter((turn) => turn.status === "queued" && (turn.queue?.wakeUp || turn.scheduledFor) && !turn.queue?.removed && turn.id !== thread.usagePause!.recoveryTurnId).length,
    } } : {}),
    // Only when there are any, so envelopes of threads without a queue stay byte-for-byte as they were.
    ...(queued.length > 0 ? { queuedTurns: queued } : {}),
    // Likewise: only threads that ever ran a native subagent carry the list.
    ...(thread.nativeSubagents !== undefined && thread.nativeSubagents.length > 0
      ? { nativeSubagents: thread.nativeSubagents.map((entry) => ({ ...entry })) }
      : {}),
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
  };
}

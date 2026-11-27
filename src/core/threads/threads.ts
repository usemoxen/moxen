/**
 * Thread lifecycle ops over the JSONL store. These mirror the CLI-stable
 * semantics of `src/cli/threads/threads.ts` (status rules, busy policies,
 * error codes) so cutover repoints the transport without renegotiating
 * behavior — but execution is ledger-local: no dispatch-then-poll, no
 * snapshot preflights. A per-thread mutex enforces one active turn per
 * session. Provider drivers attach in Stage 2 via `completeTurn` /
 * `failTurn` / `trackRunning`. See docs/threads.md.
 */
import os from "node:os";
import { readFile } from "node:fs/promises";

import { imageSetError, type ImageAttachmentUpload } from "../attachments.js";
import { CliError } from "../errors.js";
import { isCompactCommand } from "../providers/spi.js";
import { captureUsageProtectionOverride, usageKeyForInstance, usageProtectionOverrideActive } from "../usage/limits.js";
import { antigravityHoldsAutomaticDispatch, automaticDispatchPrompt, hasSnoozeConditions, loadTurnOrigins, providerExhausted, snoozeActive, turnOriginKey, type QueueCondition, type TurnOrigins } from "./queue.js";
import { isMaintenanceTurn } from "./maintenance.js";
import { isDraining, serverDrainingError } from "./drain.js";
import { antigravityUnsupportedUseAllowed, driverKindOfInstance, type CliConfig, type InteractionMode, type ModelSelection, type RuntimeMode } from "../types.js";
import { ThreadStore } from "./store.js";
import { isKnownTurnStatus, type StoreProblem } from "./problems.js";
import { ranTurns } from "./project.js";
import type {
  CreateThreadInput,
  MessageOrigin,
  ReadView,
  SendDelivery,
  SendIfBusy,
  SendTurnInput,
  StoredAttachment,
  StoredDelegation,
  StoredMessage,
  StoredThread,
  StoredTurn,
  ThreadReadResult,
  TurnOwner,
  ThreadStatus,
  TurnDelivery,
  TurnUsage,
} from "./types.js";

const READ_VIEWS: readonly ReadView[] = [
  "messages",
  "turn-items",
  "plans",
  "checkpoints",
  "transfers",
];


function requireThreadId(threadId: string): string {
  const trimmed = threadId.trim();
  if (!trimmed) {
    throw new CliError("THREAD_ID_REQUIRED", "A non-empty thread id is required.", {
      exitCode: 2,
    });
  }
  return trimmed;
}

/**
 * A snooze ends in one of two ways: the clock runs past `snoozedUntil`, or a
 * pass (`wakeDueSnoozes`) sees the conditions it waits for met and clears the
 * mark. Either way the thread reads snoozed until then.
 */
function isSnoozed(thread: StoredThread, now: number): boolean {
  if (thread.settledAt != null) return false;
  return snoozeActive(thread, now);
}

/** Identical rule to the CLI `threadStatus`: settled wins, then snoozed. */
export function threadStatus(thread: StoredThread, now: number = Date.now()): ThreadStatus {
  if (thread.settledAt != null) return "settled";
  return isSnoozed(thread, now) ? "snoozed" : "active";
}

export function openTurn(turns: StoredTurn[]): StoredTurn | null {
  return turns.find((turn) => turn.status === "running") ?? null;
}

/**
 * The turn that makes the thread live: the running one, else one with a
 * status no build writes (it never settles on its own, so nothing may start
 * or promote past it). Ownerless running turns are running, so the first
 * branch covers them.
 */
export function liveTurn(turns: StoredTurn[]): StoredTurn | null {
  return openTurn(turns) ?? turns.find((turn) => !isKnownTurnStatus(turn.status)) ?? null;
}

/**
 * How long an unregistered continuation claim blocks admissions: a backstop
 * for claims no live handoff owns (a clear that failed to write, a reused
 * pid, a writer this process cannot see). A handoff running in this process
 * is registered below and never expires by age.
 */
export const CONTINUE_CLAIM_TTL_MS = 60_000;

/**
 * Claim tokens with a manual handoff running in this process. Production
 * keeps one server per store (`claimStore` refuses a second; the CLI always
 * dispatches to a server, never in-process), so the handoff and every
 * admission it races run here and a registered token is proof of life —
 * regardless of how long provider startup takes. A restart empties this
 * (and changes pid), so a leftover claim heals by pid below.
 */
const liveContinuations = new Set<string>();

/** Mark a manual handoff running here; admission blocks on its token until released. */
export function trackContinuation(token: string): void {
  liveContinuations.add(token);
}

/** Release a manual handoff that ended here; admission heals any leftover record on its own. */
export function untrackContinuation(token: string): void {
  liveContinuations.delete(token);
}

/**
 * Whether a manual continuation in flight forbids starting a turn on this
 * thread now. A claim whose handoff runs in this process blocks for as long
 * as it runs. Otherwise the owner is judged by pid (same host) or age
 * alone (another host, which production never writes — paired servers keep
 * their own stores): a dead or stale claim is cleared here so a crashed
 * handoff never wedges the thread, and a reused pid cannot block past the
 * TTL. Returns the thread as admission must see it (healed when it was
 * dead), since the caller holds the lock and writes its own copy back
 * afterwards. Caller must hold the thread lock.
 */
export async function continuationInFlight(store: ThreadStore, thread: StoredThread): Promise<{ blocked: boolean; thread: StoredThread }> {
  const claim = thread.continueClaim;
  if (!claim) return { blocked: false, thread };
  // The handoff runs here: effective for its whole life, however long
  // provider startup takes — never expired by age.
  if (liveContinuations.has(claim.token)) return { blocked: true, thread };
  // Same host, our own pid, but no live handoff owns the token: its cleanup
  // already ran (untrack precedes the record clear), so the record write
  // must have died with the handoff. Heal at once rather than stalling
  // until the TTL lapses.
  const ownDeadHandoff = claim.host === os.hostname() && claim.pid === process.pid;
  const fresh = Date.parse(claim.at) > Date.now() - CONTINUE_CLAIM_TTL_MS;
  const alive = claim.host === os.hostname() ? processAlive(claim.pid) : true;
  if (!ownDeadHandoff && alive && fresh) return { blocked: true, thread };
  const current = await store.readThreadRecord(thread.id);
  if (current?.continueClaim?.token !== claim.token) return { blocked: false, thread: current ?? thread };
  const healed = { ...current, continueClaim: null, updatedAt: store.nowIso() };
  await store.writeThreadRecord(healed);
  return { blocked: false, thread: healed };
}

/** A turns ledger problem hiding rows of this thread, if one is reported. */
export function hiddenTurnsProblem(store: ThreadStore, threadId: string): StoreProblem | null {
  const file = store.turnsFile(threadId);
  return store.storeProblems().find((problem) => problem.kind === "ledger-line" && problem.threadId === threadId && problem.file === file) ?? null;
}

/**
 * A problem hiding rows of the given ledger file of this thread, if one is
 * reported. A skipped row could be the row a transfer decision is looking
 * for, so absence on such a snapshot is unproven — never treat it as empty.
 */
export function hiddenLedgerProblem(store: ThreadStore, threadId: string, file: string): StoreProblem | null {
  return store.storeProblems().find((problem) => problem.kind === "ledger-line" && problem.threadId === threadId && problem.file === file) ?? null;
}

/**
 * A THREAD_BUSY refusal raised because a manual continuation owns the
 * checkout (see `continuationInFlight`), as opposed to one raised by a busy
 * turn. Catch sites that must yield only to a handoff — the usage wrap-up,
 * the queue pass — discriminate with `isContinuationBusy`, never on the
 * message and never by re-reading the claim (which may not be persisted
 * yet, or may already have cleared, when the refusal arrives).
 */
export function continuationBusyError(threadId: string): CliError {
  return new CliError("THREAD_BUSY", `Thread ${threadId} is being continued in a new thread. Retry when it lands.`, {
    exitCode: 4,
    details: { threadId, continued: true },
  });
}

/** Whether this failure is a manual-handoff contention refusal (see above). */
export function isContinuationBusy(cause: unknown): cause is CliError {
  return (
    cause instanceof CliError &&
    cause.code === "THREAD_BUSY" &&
    typeof cause.details === "object" &&
    cause.details !== null &&
    (cause.details as { continued?: unknown }).continued === true
  );
}

export function unreadableTurnsError(threadId: string, problem: StoreProblem): CliError {
  return new CliError(
    "TURNS_LEDGER_CORRUPT",
    `Thread ${threadId} may have an active turn hidden in an unreadable ledger line (${problem.file}${problem.line === undefined ? "" : `:${problem.line}`}). Move the bad line aside first — the TUI warning offers it, or remove the line by hand — then retry.`,
    { exitCode: 4, details: { threadId, problemId: problem.id } },
  );
}

/**
 * A thread's mode is fixed while a turn runs: a steer, an inject, a queued send or a one-off mode
 * on a send cannot change it, nor can the command that sets it. Once the turn stops it can again.
 */
function modeLocked(threadId: string): CliError {
  return new CliError("MODE_LOCKED_WHILE_RUNNING", "The mode cannot change while a turn is running: wait for it to finish, or stop it.", {
    exitCode: 4,
    details: { threadId },
  });
}

function normalizeIfBusy(raw: SendIfBusy | undefined): SendIfBusy {
  const ifBusy = raw ?? "reject";
  if (ifBusy !== "reject" && ifBusy !== "inject") {
    throw new CliError("INVALID_THREAD_OPTION", "ifBusy must be reject or inject.");
  }
  return ifBusy;
}

function normalizeDelivery(raw: SendDelivery | undefined): SendDelivery {
  const delivery = raw ?? "auto";
  if (delivery !== "auto" && delivery !== "steer" && delivery !== "restart" && delivery !== "queue") {
    throw new CliError("INVALID_THREAD_OPTION", "--delivery must be auto, steer, restart, or queue.", {
      exitCode: 2,
    });
  }
  return delivery;
}

function normalizeScheduledFor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const parsed = Date.parse(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw new CliError("INVALID_THREAD_OPTION", "The scheduled time must be an ISO date-time.", { exitCode: 2 });
  }
  return new Date(parsed).toISOString();
}

function normalizeSnoozeUntil(raw: string): string {
  const trimmed = raw.trim();
  const parsed = Date.parse(trimmed);
  if (!trimmed || !Number.isFinite(parsed)) {
    throw new CliError("SNOOZE_UNTIL_INVALID", "Use --until with a valid ISO-8601 datetime.", {
      exitCode: 2,
      details: { until: raw },
    });
  }
  return new Date(parsed).toISOString();
}

function requireStoredThread(thread: StoredThread | null, threadId: string): StoredThread {
  if (!thread) {
    throw new CliError("THREAD_NOT_FOUND", `No thread exists with id ${threadId}.`, {
      exitCode: 3,
      details: { threadId },
    });
  }
  return thread;
}

function requireNotArchived(thread: StoredThread, action: string): void {
  if (thread.archivedAt != null) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${thread.id} is archived and cannot ${action}.`, {
      exitCode: 4,
      details: { threadId: thread.id, archivedAt: thread.archivedAt },
    });
  }
}

function requireNotDeleted(thread: StoredThread): void {
  if (thread.deletedAt != null) {
    throw new CliError("THREAD_NOT_FOUND", "The thread does not exist.", {
      exitCode: 3,
      details: { threadId: thread.id },
    });
  }
}

export async function createThread(
  store: ThreadStore,
  input: CreateThreadInput,
): Promise<StoredThread> {
  const projectId = input.projectId.trim();
  if (!projectId) {
    throw new CliError("PROJECT_ID_REQUIRED", "A non-empty project id is required.", {
      exitCode: 2,
    });
  }
  const title = input.title.trim();
  if (!title) {
    throw new CliError("INVALID_THREAD_OPTION", "A non-empty thread title is required.", {
      exitCode: 2,
    });
  }
  const now = store.nowIso();
  const id = input.id?.trim() || store.newId();
  if (input.id?.trim() && (await store.readThreadRecord(id)) !== null) {
    throw new CliError("THREAD_ALREADY_EXISTS", `A thread already exists with id ${id}.`, {
      exitCode: 4,
      details: { threadId: id },
    });
  }
  const thread: StoredThread = {
    id,
    ...(input.hidden === true ? { hidden: true } : {}),
    projectId,
    title,
    ...(input.titleSource ? { titleSource: input.titleSource } : {}),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    env: {
      mode: input.env?.mode ?? "local",
      path: input.env?.path ?? "",
      branch: input.env?.branch ?? null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    unsettledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...(input.researchRun ? { researchRun: input.researchRun } : {}),
    ...(input.researchRole ? { researchRole: input.researchRole } : {}),
    ...(input.continuedFrom ? { continuedFrom: input.continuedFrom } : {}),
    ...(input.handoffFacts ? { handoffFacts: input.handoffFacts } : {}),
  };
  await store.writeThreadRecord(thread);
  store.emit(thread.id, "created");
  return thread;
}

export async function listThreads(
  store: ThreadStore,
  options: { status?: ThreadStatus | "all"; projectId?: string; includeArchived?: boolean } = {},
): Promise<StoredThread[]> {
  const status = options.status ?? "active";
  const now = Date.parse(store.nowIso());
  const threads: StoredThread[] = [];
  for (const id of await store.listThreadIds()) {
    const thread = await store.readThreadRecord(id);
    if (!thread || thread.deletedAt != null || (thread.archivedAt != null && !options.includeArchived)) continue;
    if (options.projectId !== undefined && thread.projectId !== options.projectId) continue;
    if (status !== "all" && threadStatus(thread, now) !== status) continue;
    threads.push(thread);
  }
  threads.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return threads;
}

export async function inspectThread(store: ThreadStore, rawThreadId: string): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  return requireStoredThread(await store.readThreadRecord(threadId), threadId);
}

export async function readThread(
  store: ThreadStore,
  rawThreadId: string,
  options: { view?: ReadView } = {},
): Promise<ThreadReadResult & { view: ReadView }> {
  const view = options.view ?? "messages";
  if (!READ_VIEWS.includes(view)) {
    throw new CliError(
      "INVALID_THREAD_OPTION",
      "--view must be messages, turn-items, plans, checkpoints, or transfers.",
      { exitCode: 2, details: { view: options.view } },
    );
  }
  const thread = await inspectThread(store, rawThreadId);
  const [turns, messages, activities, checkpoints] = await Promise.all([
    store.readTurns(thread.id),
    store.readMessages(thread.id),
    store.readActivities(thread.id),
    store.readCheckpoints(thread.id),
  ]);
  // plans/transfers have no store yet; they materialize at CLI cutover.
  return { thread, turns, messages, activities, checkpoints, view };
}

export interface SendTurnResult {
  readonly thread: StoredThread;
  readonly turn: StoredTurn;
  readonly messageId: string;
  readonly delivery: TurnDelivery;
}

export async function sendTurn(
  store: ThreadStore,
  rawThreadId: string,
  input: SendTurnInput,
  /** The config in force, when the caller has it: lets admission hold Antigravity automatic prompts while delegation is off. */
  config?: Pick<CliConfig, "providers">,
  guardNoticeSteer?: (target: StoredTurn) => void,
): Promise<SendTurnResult> {
  const threadId = requireThreadId(rawThreadId);
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new CliError("PROMPT_REQUIRED", "A non-empty thread message is required.", {
      exitCode: 2,
    });
  }
  const ifBusy = normalizeIfBusy(input.ifBusy);
  const scheduledFor = normalizeScheduledFor(input.scheduledFor);
  // A scheduled message is a queued one that also waits for its time.
  let delivery = scheduledFor === null && !input.queue ? normalizeDelivery(input.delivery) : "queue";
  if (scheduledFor !== null && (input.delivery === "steer" || input.delivery === "restart")) {
    throw new CliError("INVALID_THREAD_OPTION", "A scheduled message cannot steer or restart a turn.", { exitCode: 2 });
  }
  // The API's image limits, refused here in words rather than by the
  // provider mid-turn — whichever client sent them.
  const imageError = input.attachments?.length ? imageSetError(input.attachments) : null;
  if (imageError !== null) throw new CliError("INVALID_ATTACHMENT", `Cannot send: ${imageError}.`, { exitCode: 2 });
  // Saved before the lock: bytes on disk are harmless if the send is then
  // refused, and the lock is held only for ledger writes.
  const attachments = input.attachments?.length
    ? await Promise.all(input.attachments.map((upload) => store.saveAttachment(upload)))
    : [];
  const withAttachments = attachments.length > 0 ? { attachments } : {};
  const origin = input.origin;
  const automaticPrompt = origin !== undefined || input.scheduleReason === "usage-reset";
  const withOrigin = origin !== undefined ? { origin, ...(input.notification ? { notification: input.notification } : {}) } : {};

  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    let thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    requireNotDeleted(thread);
    requireNotArchived(thread, "receive a new turn");
    if ((origin === "usage-protection" || origin === "usage-continue" && input.queue?.requestId?.startsWith("usage:")) && thread.usageProtectionOverride && usageProtectionOverrideActive(thread.usageProtectionOverride, thread.usageProtectionOverride.provider, Date.parse(now))) {
      throw new CliError("USAGE_PROTECTION_OVERRIDDEN", "Usage protection is paused for this thread until the next allowance reset.");
    }
    const manualContinuation = thread.usagePause != null && thread.usagePause.phase !== "resuming" && !automaticPrompt && input.usageControl !== true && scheduledFor === null && !input.queue && delivery !== "queue";
    const usageHeld = thread.usagePause != null && thread.usagePause.phase !== "resuming" && input.usageControl !== true && !manualContinuation;
    // Antigravity with delegation off holds an automatic prompt the same way
    // a usage hold does: queued as a wake-up for the user's next message (or
    // the setting turning on), never started on its own. Task notices are
    // held upstream in their batch file and ride the user's send, so they
    // pass here. Usage-control maintenance (wrap-up, recovery) is Moxen's own
    // prompt too, so it holds for Antigravity like any other: the usage
    // exemption it keeps elsewhere skips usage pauses, not this gate.
    const autoHeld = config !== undefined && automaticPrompt && origin !== "task-notification"
      && driverKindOfInstance((input.modelSelection ?? thread.modelSelection).instanceId) === "antigravity"
      && !antigravityUnsupportedUseAllowed(config);
    if (usageHeld || autoHeld) delivery = "queue";

    let turns = await store.readTurns(threadId);

    if (threadStatus(thread, Date.parse(now)) === "settled" && !input.wakeSettled && !usageHeld && !autoHeld) {
      throw new CliError(
        "SETTLED_THREAD_CONFIRMATION_REQUIRED",
        `Thread ${threadId} is settled. Re-run with wakeSettled to send and wake it.`,
        { exitCode: 4, details: { threadId, settledAt: thread.settledAt } },
      );
    }
    // A manual continuation in flight owns the checkout: refuse a send that
    // would start a running turn — or release usage protection, wake a
    // settled thread, or touch a live turn — before it writes anything. The
    // unsettle and the usage-protection release below must not run for a
    // refused send (a refused send once destroyed protection and its
    // recovery turn, and once woke a settled thread it never started on).
    // Predicted from the same inputs the turn below is cut from: with no
    // live turn and no protection release, nothing between here and there
    // changes the outcome, so queued and scheduled sends pass through
    // untouched. Keep beside the status computation below; if that formula
    // changes, mirror it here.
    const live = liveTurn(turns);
    const duplicate = input.queue?.requestId ? turns.find((turn) => turn.queue?.requestId === input.queue!.requestId) : undefined;
    const joinsExisting = duplicate !== undefined && duplicate.status !== "running";
    const gateWaitingOut = scheduledFor === null && !openTurn(turns) && delivery !== "restart" ? usageHoldUntil(turns, Date.parse(now)) : null;
    const gateHoldUntil = gateWaitingOut ?? (scheduledFor !== null && Date.parse(scheduledFor) > Date.parse(now) ? scheduledFor : null);
    const gateHeldQueue = ((usageHeld || autoHeld) && !input.queue && automaticPrompt) || input.queue !== undefined;
    const gateHeldBehind =
      scheduledFor === null && !openTurn(turns) && !input.queue && !usageHeld && !autoHeld && !manualContinuation && (delivery === "auto" || delivery === "queue") &&
      turns.some((turn) => turn.status === "queued" && ((turn.heldAtSettle === true && !turn.queue) || (input.usageControl !== true && isDueHeldTurn(turn, Date.parse(now)))));
    const joinsWaitingReset = input.scheduleReason === "usage-reset" && turns.some((turn) => turn.status === "queued" && turn.scheduleReason === "usage-reset");
    const gateQueued =
      gateHeldQueue || usageHeld || autoHeld || gateHoldUntil !== null || gateHeldBehind || joinsWaitingReset || (delivery === "queue" && (openTurn(turns) !== null || isDraining()));
    // A restart's drain ends every turn eventually, so nothing new may start
    // while it waits: a send that would run now is refused before the ledger
    // is touched, from the same prediction the manual-continuation gate
    // below is cut from. What still goes through reaches work that is
    // already running — a steer, an injected message — or keeps as durable
    // rows that wait (queued, scheduled, including a queued send on an idle
    // thread, so no caller has to lose a copy to the drain) and run once
    // the server is back.
    if (
      isDraining() && !joinsExisting
      && (manualContinuation || (!gateQueued && !(openTurn(turns) !== null && (delivery === "auto" || delivery === "steer"))))
    ) {
      throw serverDrainingError();
    }
    if (joinsExisting ? false : live !== null || manualContinuation || !gateQueued) {
      const admission = await continuationInFlight(store, thread);
      thread = admission.thread;
      if (admission.blocked) {
        throw continuationBusyError(threadId);
      }
    }
    if (thread.settledAt != null && input.wakeSettled === true && !usageHeld && !autoHeld) {
      thread = {
        ...thread,
        settledAt: null,
        settledOverride: "active",
        unsettledAt: now,
        updatedAt: now,
      };
      await store.writeThreadRecord(thread);
      store.emit(threadId, "unsettle");
    }

    const hidden = hiddenTurnsProblem(store, threadId);
    if (hidden) throw unreadableTurnsError(threadId, hidden);
    if (input.queue?.requestId) {
      const existing = turns.find((turn) => turn.queue?.requestId === input.queue!.requestId);
      if (existing) {
        // The native task edge and its injected message share a run id. Keep
        // both payloads, once, on one queued turn rather than losing either.
        if (existing.status === "queued" && existing.queue?.wakeUp && input.queue.wakeUp && !(await store.readMessages(threadId)).some((message) => message.turnId === existing.id && message.text === prompt)) {
          await store.appendLedger(threadId, "messages", { id: store.newId(), threadId, turnId: existing.id, role: "user", text: prompt, createdAt: now, ...withOrigin });
          store.emit(threadId, "wake-up-updated");
        }
        return { thread, turn: existing, messageId: existing.messageId, delivery: existing.delivery };
      }
    }
    let running = openTurn(turns);
    const stuck = running === null ? liveTurn(turns) : null;
    if (stuck !== null) {
      throw new CliError(
        "THREAD_BUSY",
        `Thread ${threadId} has a turn that will never settle (status ${JSON.stringify(stuck.status)}). Stop it before sending.`,
        { exitCode: 4, details: { threadId, turnId: stuck.id } },
      );
    }
    // A message sent to a running turn does not carry a mode of its own (`/research` is for a prompt that starts one).
    if (running && !manualContinuation && input.interactionMode !== undefined) throw modeLocked(threadId);

    if (delivery === "auto" && running && !manualContinuation && ifBusy === "reject") {
      throw new CliError(
        "THREAD_BUSY",
        "The thread has an active turn. Retry when idle or use ifBusy inject.",
        { details: { threadId } },
      );
    }
    if ((delivery === "steer" || delivery === "restart") && !running) {
      throw new CliError(
        "THREAD_NOT_STEERABLE",
        `Thread ${threadId} has no active turn to ${delivery}. Send without delivery or with queue.`,
        { exitCode: 4, details: { threadId, delivery } },
      );
    }

    if (manualContinuation) {
      const pause = thread.usagePause!;
      // A user send must be a normal turn, never a steer into wrap-up.
      if (running) {
        await interruptTurnLocked(store, thread, running, now);
        running = null;
        turns = await store.readTurns(threadId);
      }
      const recovery = turns.find((turn) => (turn.id === pause.recoveryTurnId || turn.queue?.requestId === `usage:${pause.order}`) && turn.status === "queued");
      if (recovery) {
        await interruptTurnLocked(store, thread, recovery, now);
        if (recovery.queue) await store.updateTurn(threadId, recovery.id, { queue: { ...recovery.queue, removed: true } });
        turns = await store.readTurns(threadId);
      }
      // Only a hold that automatic protection placed is being overridden: ending
      // a purely manual /protect leaves automatic protection armed.
      const overridesAutomatic = !pause.forced || (pause.windows?.length ?? 0) > 0;
      thread = { ...thread, usagePause: null, usageProtectionOverride: overridesAutomatic ? captureUsageProtectionOverride(pause.provider, Date.parse(now)) : null, updatedAt: now };
      await store.writeThreadRecord(thread);
      store.emit(threadId, "usage-protection-overridden");
    }

    const runtimeMode: RuntimeMode = input.runtimeMode ?? thread.runtimeMode;
    const interactionMode: InteractionMode = input.interactionMode ?? thread.interactionMode;
    // The model this turn actually runs on, recorded on the turn itself. An
    // unset override used to store `null` ("whatever the thread says"),
    // which reads back as the thread's *current* model — so switching models
    // mid-conversation relabelled every earlier turn with the new one.
    const modelSelection: ModelSelection = input.modelSelection ?? thread.modelSelection;

    if (running && (delivery === "auto" || delivery === "steer")) {
      guardNoticeSteer?.(running);
      const messageId = store.newId();
      await store.appendLedger(threadId, "messages", {
        id: messageId,
        threadId,
        turnId: running.id,
        role: "user",
        text: prompt,
        createdAt: now,
        ...withAttachments,
        ...withOrigin,
      });
      const result: TurnDelivery = delivery === "steer" ? "steered" : "injected";
      await store.appendLedger(threadId, "activity", {
        id: store.newId(),
        threadId,
        turnId: running.id,
        kind: delivery === "steer" ? "turn.steered" : "message.injected",
        summary: prompt.slice(0, 120),
        // The message id the steer was filed under: steer confirmation and
        // redelivery match on this, never on text.
        payload: { messageId, ...(guardNoticeSteer ? { batchNotice: true } : {}) },
        createdAt: now,
      });
      if (input.handoffNote !== undefined && input.handoffNote.trim()) {
        await store.appendLedger(threadId, "activity", {
          id: store.newId(),
          threadId,
          turnId: running.id,
          kind: "handoff-note",
          summary: input.handoffNote.trim().slice(0, 500),
          createdAt: now,
        });
      }
      thread = { ...thread, updatedAt: now };
      await store.writeThreadRecord(thread);
      store.emit(threadId, result === "steered" ? "turn-steered" : "message-injected");
      return { thread, turn: running, messageId, delivery: result };
    }

    if (running && delivery === "restart") {
      await interruptTurnLocked(store, thread, running, now);
    }

    // One continue after a usage limit at a time: a second request (a double
    // click, a client and the automatic continue racing) gets the first.
    if (input.scheduleReason === "usage-reset") {
      const waiting = (await store.readTurns(threadId)).find((row) => row.status === "queued" && row.scheduleReason === "usage-reset");
      if (waiting) return { thread, turn: waiting, messageId: waiting.messageId, delivery: waiting.delivery };
    }

    // Held for later only while that time is still ahead; a past time runs now.
    // A plain send while a continue waits out a usage limit queues behind
    // it instead of running into the same wall: held to the same time, it
    // goes out once the continue has run.
    const waitingOut = scheduledFor === null && !running && delivery !== "restart" ? usageHoldUntil(turns, Date.parse(now)) : null;
    const holdUntil = waitingOut ?? (scheduledFor !== null && Date.parse(scheduledFor) > Date.parse(now) ? scheduledFor : null);
    // Order behind an older held turn: a plain send on an idle thread whose
    // older turn settle held for admission (snooze, settle, exhaustion) does
    // not run ahead of it. It queues behind, held for admission in turn, and
    // the admission path runs the older first. When the older cannot run yet
    // the new message waits behind it — visibly queued, never swallowed. A
    // message ending usage protection is the exception: it releases the hold
    // and runs first, as protection promises.
    //
    // The same oldest-first rule covers a due held turn (a continue set for
    // a usage-limit reset, or a message held behind one, whose time has
    // come): the new message queues behind it rather than overtaking it, and
    // rides along in its turn when model and mode match. Usage-control turns
    // (wrap-up and other maintenance) are exempt: they run past holds by design.
    const heldBehind = scheduledFor === null && !running && !input.queue && !usageHeld && !autoHeld && !manualContinuation && (delivery === "auto" || delivery === "queue")
      && turns.some((turn) => turn.status === "queued" && ((turn.heldAtSettle === true && !turn.queue) || (input.usageControl !== true && isDueHeldTurn(turn, Date.parse(now)))));
    // A snooze takes the task out of the active set, so the automatic work an
    // agent queues for it waits: the message queues held for the snooze, under
    // its own hold (`heldBySnooze`) rather than the oldest-first one, instead
    // of starting the work the snooze was set to keep from running. The two
    // holds differ in one thing: a direct send is the owning thread's own act,
    // and it keeps its own rule (it reaches the task, past the held message,
    // without releasing or batching it in).
    const snoozeHeld = scheduledFor === null && !running && origin === "agent-message" && snoozeActive(thread, Date.parse(now));
    const scheduleReason = waitingOut !== null ? ("usage-hold" as const) : (input.scheduleReason ?? "user");
    let heldQueue = (usageHeld || autoHeld) && !input.queue && automaticPrompt ? {
      conditions: [], held: false, order: Math.max(Date.parse(now), ...turns.filter((turn) => turn.queue?.wakeUp).map((turn) => turn.queue!.order + 1)),
      sequential: true, continuation: "same-thread" as const, automatic: true, wakeUp: true,
    } : input.queue;
    if ((usageHeld || autoHeld) && heldQueue && automaticPrompt && !heldQueue.requestId?.startsWith("usage:")) heldQueue = { ...heldQueue, automatic: true, wakeUp: true };
    if (heldQueue?.wakeUp) heldQueue = { ...heldQueue, order: Math.max(heldQueue.order, ...turns.filter((turn) => turn.queue?.wakeUp).map((turn) => turn.queue!.order + 1)) };
    // A queued send during a drain never starts, however idle the thread:
    // it is held for the admission path like any settle-held turn.
    const drainHeld = isDraining() && delivery === "queue";
    const status = heldQueue || usageHeld || autoHeld || holdUntil !== null || heldBehind || snoozeHeld || drainHeld || (delivery === "queue" && openTurn(await store.readTurns(threadId))) ? "queued" : "running";
    // The hard net behind the pre-flight gate above: the prediction can
    // drift, and a turn written `running` during the drain would start nowhere.
    if (status === "running" && isDraining()) throw serverDrainingError();
    // A manual continuation in flight owns the checkout now: no turn may
    // start beside its destination while it prepares. Queued and scheduled
    // turns are not starting, so they pass; the handoff clears the claim
    // when it lands, and a dead one heals here.
    if (status === "running") {
      const admission = await continuationInFlight(store, thread);
      thread = admission.thread;
      if (admission.blocked) {
        throw continuationBusyError(threadId);
      }
    }
    const executionSeq = status === "running" ? await allocateTurnSeqLocked(store, thread, turns) : undefined;
    const turn: StoredTurn = {
      id: store.newId(),
      threadId,
      status,
      ...(heldQueue ? { queue: heldQueue } : {}),
      ...(heldBehind || (drainHeld && !snoozeHeld) ? { heldAtSettle: true } : {}),
      ...(snoozeHeld ? { heldBySnooze: true } : {}),
      ...(status === "running" ? { owner: currentTurnOwner() } : {}),
      ...(executionSeq !== undefined ? { executionSeq } : {}),
      delivery:
        delivery === "queue" || waitingOut !== null || heldBehind || snoozeHeld ? (status === "queued" ? "queued" : "started")
        : delivery === "restart" ? "restarted"
        : "started",
      messageId: store.newId(),
      ...(isCompactCommand(prompt) ? { maintenance: true as const } : {}),
      runtimeMode,
      interactionMode,
      ...(input.interactionMode !== undefined ? { interactionModeExplicit: true as const } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(input.handoffOpen ? { handoffOpen: true as const } : {}),
      ...(input.handoffPending && input.handoffPending.length > 0 ? { handoffPending: input.handoffPending } : {}),
      ...(origin === "usage-continue" ? { usageRecoveryNotice: true as const } : {}),
      modelSelection,
      parentTurnId: delivery === "restart" && running ? running.id : null,
      ...(holdUntil !== null
        ? {
            scheduledFor: holdUntil,
            scheduleReason,
            ...(input.continueAttempt !== undefined ? { continueAttempt: input.continueAttempt } : {}),
          }
        : input.scheduleReason === "usage-reset" ? {
            scheduleReason: "usage-reset",
            ...(input.continueAttempt !== undefined ? { continueAttempt: input.continueAttempt } : {}),
          } : {}),
      error: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await store.appendLedger(threadId, "turns", turn);
    await store.appendLedger(threadId, "messages", {
      id: turn.messageId,
      threadId,
      turnId: turn.id,
      role: "user",
      text: prompt,
      createdAt: now,
      ...withAttachments,
      ...withOrigin,
      ...(origin === "task-notification" ? { queuedTaskNotice: true } : {}),
    });
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId: turn.id,
      kind: holdUntil !== null ? "turn.scheduled" : status === "queued" ? "turn.queued" : "turn.started",
      summary: prompt.slice(0, 120),
      ...(holdUntil !== null ? { payload: { scheduledFor: holdUntil, reason: scheduleReason } } : {}),
      createdAt: now,
    });
    if (input.handoffNote !== undefined && input.handoffNote.trim()) {
      await store.appendLedger(threadId, "activity", {
        id: store.newId(),
        threadId,
        turnId: turn.id,
        kind: "handoff-note",
        summary: input.handoffNote.trim().slice(0, 500),
        createdAt: now,
      });
    }
    thread = { ...thread, ...(executionSeq !== undefined ? { turnSeq: executionSeq } : {}), updatedAt: now };
    await store.writeThreadRecord(thread);
    store.emit(threadId, status === "queued" ? "turn-queued" : "turn-started");
    return { thread, turn, messageId: turn.messageId, delivery: turn.delivery };
  });
}

/** Caller must hold the thread lock. */
async function interruptTurnLocked(
  store: ThreadStore,
  thread: StoredThread,
  turn: StoredTurn,
  now: string,
  usagePause?: StoredTurn["usagePause"],
  reason?: string,
  usage?: StoredTurn["usage"],
): Promise<StoredTurn> {
  store.abortRunning(turn.id);
  store.untrackRunning(turn.id);
  // The interruption and its final observed usage commit as ONE row write
  // inside the thread lock, before the interruption event and any queue
  // promotion: rewriting the ledger outside the lock afterwards would erase a
  // turn admitted in between (LOCAL-009).
  const updated = await store.updateTurn(thread.id, turn.id, {
    status: "interrupted",
    ...(usagePause ? { usagePause } : {}),
    ...(reason ? { error: reason } : {}),
    ...(usage !== undefined ? { usage } : {}),
    updatedAt: now,
    completedAt: now,
  });
  await store.appendLedger(thread.id, "activity", {
    id: store.newId(),
    threadId: thread.id,
    turnId: turn.id,
    kind: "turn.interrupted",
    summary: reason ?? turn.id,
    // A queued or scheduled message taken back before it ran: clients drop
    // it from the transcript rather than show a turn that never happened.
    ...(turn.status === "queued" ? { payload: { beforeStart: true } } : {}),
    createdAt: now,
  });
  if (!updated) {
    throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turn.id}.`, {
      exitCode: 3,
      details: { threadId: thread.id, turnId: turn.id },
    });
  }
  return updated;
}

/** Caller must hold the thread lock. Promotes the oldest queued turn, if any. */
/**
 * Record a turn the provider started on its own (see `turn.started` with
 * `origin: "background"`): no prompt of ours, so no user message — an
 * activity row says what woke it. Claude Code starts such a turn the moment
 * the previous one ends, often while that turn's runner is still writing its
 * outcome, so this waits briefly for the thread to go idle first.
 */
export async function startBackgroundTurn(
  store: ThreadStore,
  rawThreadId: string,
  input: { readonly modelSelection: ModelSelection | null },
): Promise<StoredTurn> {
  const threadId = requireThreadId(rawThreadId);
  for (let wait = 0; wait < 150 && openTurn(await store.readTurns(threadId)); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    requireNotDeleted(thread);
    requireNotArchived(thread, "start a background turn");
    if (thread.usagePause && thread.usagePause.phase !== "resuming") {
      throw new CliError("USAGE_PROTECTED_BACKGROUND", "Usage protection is holding this thread's background work.");
    }
    if (threadStatus(thread, Date.parse(now)) === "settled") {
      throw new CliError(
        "SETTLED_THREAD_CONFIRMATION_REQUIRED",
        `Thread ${threadId} is settled and background work cannot wake it.`,
        { exitCode: 4, details: { threadId, settledAt: thread.settledAt } },
      );
    }
    // Re-checked inside the lock: the wait above runs before it, so two
    // concurrent starts (or a send that won the race) would otherwise both
    // record a running turn.
    const turns = await store.readTurns(threadId);
    const live = liveTurn(turns);
    if (live !== null && live.status === "running") {
      throw new CliError(
        "THREAD_BUSY",
        "The thread has an active turn. Retry when idle or use ifBusy inject.",
        { details: { threadId } },
      );
    }
    // A manual continuation in flight owns the checkout: a native wake-up
    // waits for the handoff rather than starting beside it. The healed
    // record is the one this turn is cut from, so a dead claim stays dead.
    const admission = await continuationInFlight(store, thread);
    const admitted = admission.thread;
    if (admission.blocked) {
      throw continuationBusyError(threadId);
    }
    const unreadable = hiddenTurnsProblem(store, threadId);
    if (unreadable) throw unreadableTurnsError(threadId, unreadable);
    if (live !== null) {
      throw new CliError(
        "THREAD_BUSY",
        `Thread ${threadId} has a turn that will never settle (status ${JSON.stringify(live.status)}). Stop it before starting background work.`,
        { exitCode: 4, details: { threadId, turnId: live.id } },
      );
    }
    const executionSeq = await allocateTurnSeqLocked(store, admitted, turns);
    const turn: StoredTurn = {
      id: store.newId(),
      threadId,
      status: "running",
      owner: currentTurnOwner(),
      executionSeq,
      delivery: "background",
      messageId: store.newId(),
      runtimeMode: admitted.runtimeMode,
      interactionMode: admitted.interactionMode,
      modelSelection: input.modelSelection ?? admitted.modelSelection,
      parentTurnId: null,
      error: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await store.appendLedger(threadId, "turns", turn);
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId: turn.id,
      kind: "turn.background",
      summary: "Woken by a background task",
      createdAt: now,
    });
    await store.writeThreadRecord({ ...admitted, turnSeq: executionSeq, updatedAt: now });
    store.emit(threadId, "turn-started");
    return turn;
  });
}

/**
 * Assign durable `executionSeq` values to any existing ran turns that predate
 * sequencing, in their legacy `ranTurns` order, before allocating a new
 * sequence on this thread. That locks pre-upgrade history strictly ahead of
 * post-upgrade turns even when the system clock steps backwards.
 *
 * Caller must hold the thread lock.
 */
async function seedLegacyExecutionSeqsLocked(
  store: ThreadStore,
  thread: StoredThread,
  turns: readonly StoredTurn[],
): Promise<{ highest: number; seeded: Map<string, number> }> {
  let highest = thread.turnSeq ?? 0;
  for (const turn of turns) {
    if (turn.executionSeq !== undefined && turn.executionSeq > highest) highest = turn.executionSeq;
  }
  const seeded = new Map<string, number>();
  const unsequenced = ranTurns(turns).filter((turn) => turn.executionSeq === undefined);
  for (const legacy of unsequenced) {
    highest += 1;
    await store.updateTurn(thread.id, legacy.id, { executionSeq: highest });
    seeded.set(legacy.id, highest);
  }
  return { highest, seeded };
}

/**
 * Next monotonic execution sequence for a turn becoming `running` on this
 * thread. Never decreases on revert, and seeds pre-upgrade ran turns first so
 * new sequenced work always orders after existing history.
 *
 * Caller must hold the thread lock.
 */
async function allocateTurnSeqLocked(
  store: ThreadStore,
  thread: StoredThread,
  turns: readonly StoredTurn[],
): Promise<number> {
  const { highest } = await seedLegacyExecutionSeqsLocked(store, thread, turns);
  return highest + 1;
}

/** This process, as the owner of the turns it starts or promotes. */
export function currentTurnOwner(): TurnOwner {
  return { pid: process.pid, host: os.hostname() };
}

/** Whether a process exists. EPERM means it does, just not ours to signal. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: string } | null)?.code === "EPERM";
  }
}

/**
 * What a thread's turns show that will never settle on their own: a status
 * no build writes (a hand edit, a newer build), or a running turn no
 * process owns and no live run holds. The fix for either is stopping the
 * turn; the poll reports them through `replaceTurnProblems`.
 */
export function turnProblems(store: ThreadStore, threadId: string, turns: StoredTurn[]): Array<Omit<StoreProblem, "id">> {
  const file = store.turnsFile(threadId);
  const problems: Array<Omit<StoreProblem, "id">> = [];
  for (const turn of turns) {
    if (!isKnownTurnStatus(turn.status)) {
      problems.push({
        kind: "turn-status",
        threadId,
        turnId: turn.id,
        file,
        message: `Turn ${turn.id} has a status no build writes (${JSON.stringify(turn.status)}): it shows as unknown and will never settle on its own. Stop the turn to clear it.`,
      });
    } else if (turn.status === "running" && !store.isTracked(turn.id) && !turn.owner) {
      problems.push({
        kind: "turn-ownerless",
        threadId,
        turnId: turn.id,
        file,
        message: `Turn ${turn.id} is running but no process owns it, so nothing will ever settle it. Stop the turn.`,
      });
    }
  }
  return problems;
}
/**
 * Whether nothing will ever settle this running turn: no run in this
 * process holds it, and the process that owned it — on this machine —
 * is gone (a crashed server, a killed CLI, a TUI closed mid-turn). A turn
 * owned on another host, or recorded before owners were, is never judged:
 * a live turn wrongly reaped would be far worse than a stuck one.
 */
function isOrphaned(store: ThreadStore, turn: StoredTurn): boolean {
  if (turn.status !== "running" || store.isTracked(turn.id)) return false;
  const owner = turn.owner;
  if (!owner || owner.host !== os.hostname() || owner.pid === process.pid) return false;
  return !processAlive(owner.pid);
}

/**
 * Interrupt the thread's running turn if its owner died, and promote the
 * next queued turn (now owned by this process). Returns the promoted turn,
 * which the caller must run; null when there was nothing to recover.
 */
export async function reconcileOrphanedTurn(
  store: ThreadStore,
  rawThreadId: string,
  gateProviders?: GateProviders,
): Promise<{ interrupted: StoredTurn; promoted: StoredTurn | null } | null> {
  const threadId = requireThreadId(rawThreadId);
  const peek = openTurn(await store.readTurns(threadId));
  if (!peek || !isOrphaned(store, peek)) return null;
  return await store.withThreadLock(threadId, async () => {
    const thread = await store.readThreadRecord(threadId);
    const running = openTurn(await store.readTurns(threadId));
    if (!thread || !running || !isOrphaned(store, running)) return null;
    const now = store.nowIso();
    const pid = running.owner?.pid;
    const interrupted =
      (await store.updateTurn(threadId, running.id, {
        status: "interrupted",
        error: `The process running this turn (pid ${pid}) exited before it finished.`,
        updatedAt: now,
        completedAt: now,
      })) ?? running;
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId: running.id,
      kind: "turn.orphaned",
      summary: `Turn ${running.id} was interrupted: its process (pid ${pid}) exited mid-turn.`,
      createdAt: now,
    });
    // A drain reconciles the orphan but starts nothing: a promotion taken
    // here would leave the lock already `running`, so the caller's runner
    // would dispatch it — around every start path's drain check. The queued
    // work is held for the admission path instead, and the next server runs
    // it, the same way a settle or an interrupt holds it.
    if (isDraining()) await holdQueuedForAdmission(store, threadId, Date.parse(now));
    else await promoteQueuedLocked(store, threadId, now, undefined, false, gateProviders);
    const promoted = (await store.readTurns(threadId)).find(
      (turn) => turn.status === "running" && turn.id !== running.id && !store.isTracked(turn.id),
    ) ?? null;
    const latestThread = (await store.readThreadRecord(threadId)) ?? thread;
    await store.writeThreadRecord({ ...latestThread, updatedAt: now });
    store.emit(threadId, "turn-interrupted");
    return { interrupted, promoted };
  });
}

/** A steer to send again, as named by a driver (`takeUnconfirmedSteers`) or an orphaned turn's ledger rows. */
export interface RedeliverSteer {
  /** The ledger message id the steer was filed under; null when unknown (a driver-minted id, or a row from before they were recorded). */
  readonly messageId: string | null;
  readonly text: string;
  /** Raw base64 images, used only when no ledger message carries them. */
  readonly images: ReadonlyArray<{ readonly name: string; readonly mimeType: string; readonly data: string }>;
}

/**
 * Send unconfirmed steers again, each as a queued turn of its own — the
 * at-least-once half of steer delivery. The provider confirmed whatever is
 * not listed; what is listed was pushed but never reached the conversation,
 * so it waits behind the running turn (or the thread, when idle) and runs
 * next. Metadata (origin, notification facts, images) is reread off the
 * recorded message, matched by id; a steer with no recorded message goes
 * out bare. Each send is marked (`steer.redelivered`), so a repeated
 * recovery never queues one twice. Never throws: a thread gone, settled
 * without a wake, or held simply keeps nothing. Returns the new turn ids.
 *
 * A runtime notice goes out again like anything else: a notice must never be
 * lost, and the report a duplicate leaves behind is cheaper than a parent kept
 * waiting on a task it never hears about.
 */
export async function redeliverUnconfirmedSteers(
  store: ThreadStore,
  rawThreadId: string,
  turnId: string,
  steers: readonly RedeliverSteer[],
  config?: Pick<CliConfig, "providers">,
): Promise<string[]> {
  if (steers.length === 0) return [];
  const threadId = requireThreadId(rawThreadId);
  const messages = await store.readMessages(threadId).catch(() => null);
  const activities = await store.readActivities(threadId).catch(() => null);
  if (!messages || !activities) return [];
  const redelivered = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "steer.redelivered") continue;
    const payload = activity.payload ?? {};
    if (typeof payload["messageId"] === "string") redelivered.add(payload["messageId"] as string);
    if (typeof payload["text"] === "string") redelivered.add(`text:${payload["text"] as string}`);
  }
  const copies: string[] = [];
  for (const steer of steers) {
    const original = steer.messageId !== null
      ? (messages.find((message) => message.id === steer.messageId && message.role === "user") ?? null)
      : (messages.find((message) => message.turnId === turnId && message.role === "user" && message.text === steer.text) ?? null);
    if (original && redelivered.has(original.id)) continue;
    if (!original && redelivered.has(`text:${steer.text}`)) continue;
    const text = original?.text ?? steer.text;
    if (!text.trim()) continue;
    const kept = original ? await uploadsOfAttachments(original.attachments ?? []) : uploadsOfImages(steer.images);
    // Images whose saved bytes are gone cannot go out again: the copy says
    // so on its marker, rather than looking complete.
    const dropped = (original?.attachments ?? []).filter((attachment) => !kept.some((upload) => upload.name === attachment.name)).map((attachment) => attachment.name);
    const uploads = kept;
    // A system message meant to wake (a task notification) keeps its wake;
    // anything else redelivers only onto a live thread, never waking one put away.
    const wakeSettled = original?.origin === "task-notification" || original?.origin === "background-notification";
    const sent = await sendTurn(store, threadId, {
      prompt: text,
      delivery: "queue",
      ...(original?.origin ? { origin: original.origin } : {}),
      ...(original?.notification ? { notification: original.notification } : {}),
      ...(uploads.length > 0 ? { attachments: uploads } : {}),
      ...(wakeSettled ? { wakeSettled: true } : {}),
    }, config).catch(() => null);
    if (!sent) continue;
    copies.push(sent.turn.id);
    redelivered.add(original ? original.id : `text:${steer.text}`);
    await store
      .appendLedger(threadId, "activity", {
        id: store.newId(),
        threadId,
        turnId: sent.turn.id,
        kind: "steer.redelivered",
        summary: dropped.length > 0
          ? `Steer sent again as its own turn without ${dropped.length} missing image${dropped.length === 1 ? "" : "s"}: ${text.slice(0, 120)}`
          : `Steer sent again as its own turn: ${text.slice(0, 120)}`,
        payload: { ...(original ? { messageId: original.id } : { text: steer.text }), ...(dropped.length > 0 ? { imagesDropped: dropped } : {}) },
        createdAt: store.nowIso(),
      })
      .catch(() => undefined);
  }
  return copies;
}

/**
 * The steers an orphaned turn never confirmed, for `redeliverUnconfirmedSteers`:
 * every message steered or injected into it, by exact message id off the
 * steer activity. Rows from before those ids were recorded match by text,
 * first unmatched first. The turn's own prompt is never one of them (it has
 * no steer activity), so an orphan's dropped prompt stays dropped — only
 * additions made mid-turn go out again.
 */
export function orphanedSteers(
  messages: readonly StoredMessage[],
  activities: readonly { readonly kind: string; readonly turnId: string | null; readonly summary: string; readonly payload?: Record<string, unknown> | undefined }[],
  turnId: string,
): RedeliverSteer[] {
  const accepted = new Set(activities.filter((row) => row.kind === "steer.accepted").map((row) => row.payload?.messageId));
  const confirmed = new Set(activities.filter((row) => row.kind === "steer.confirmed").map((row) => row.payload?.messageId));
  const used = new Set<string>();
  const steers: RedeliverSteer[] = [];
  for (const activity of activities) {
    if (activity.turnId !== turnId || (activity.kind !== "turn.steered" && activity.kind !== "message.injected")) continue;
    const messageId = typeof activity.payload?.["messageId"] === "string" ? (activity.payload["messageId"] as string) : null;
    // Until the driver accepts a batched notice, the durable batch owns
    // retries. In particular, a bare or refused steer cannot redeliver here.
    if (messageId !== null && (confirmed.has(messageId) || (activity.payload?.batchNotice === true && !accepted.has(messageId)))) continue;
    const original = messageId !== null
      ? (messages.find((message) => message.id === messageId && message.role === "user") ?? null)
      : (messages.find((message) => !used.has(message.id) && message.turnId === turnId && message.role === "user" && (message.text === activity.summary || message.text.startsWith(activity.summary))) ?? null);
    if (original) used.add(original.id);
    steers.push({ messageId: original?.id ?? null, text: original?.text ?? activity.summary, images: [] });
  }
  return steers;
}

/**
 * Send an orphaned turn's unconfirmed steers again (see
 * `redeliverUnconfirmedSteers`). Reads the activities first and the messages
 * only when a steer row names this turn, so a thread without steers pays
 * one ledger read and a recovery whose message read fails still fails where
 * it always did — in its runner's prompt build, not here. Returns the new
 * turn ids.
 */
export async function redeliverOrphanedSteers(store: ThreadStore, rawThreadId: string, turnId: string, config?: Pick<CliConfig, "providers">): Promise<string[]> {
  const threadId = requireThreadId(rawThreadId);
  const activities = await store.readActivities(threadId).catch(() => null);
  if (!activities) return [];
  if (!activities.some((activity) => activity.turnId === turnId && (activity.kind === "turn.steered" || activity.kind === "message.injected"))) return [];
  const messages = await store.readMessages(threadId).catch(() => null);
  if (!messages) return [];
  return await redeliverUnconfirmedSteers(store, threadId, turnId, orphanedSteers(messages, activities, turnId), config).catch(() => []);
}

/**
 * Promote the oldest promotable queued turn, for a runner that queued work
 * with no settle coming to promote it (a redelivery behind an already
 * terminal turn, an orphan recovery with nothing promoted). Null when a
 * turn is already running or nothing is promotable: admission owns those.
 * The caller claims and runs what comes back.
 */
export async function promoteQueuedTurn(store: ThreadStore, rawThreadId: string, gateProviders?: GateProviders): Promise<StoredTurn | null> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    if (openTurn(await store.readTurns(threadId))) return null;
    // A manual continuation in flight owns the checkout: leave queued work
    // queued. Admission retries once the handoff clears its claim.
    const record = await store.readThreadRecord(threadId);
    if (!record || (await continuationInFlight(store, record)).blocked) return null;
    await promoteQueuedLocked(store, threadId, now, undefined, false, gateProviders);
    return (await store.readTurns(threadId)).find((turn) => turn.status === "running" && !store.isTracked(turn.id)) ?? null;
  });
}

/**
 * Send a running turn with no runner back to queued, unowned, so the normal
 * promotion path can take it. Only touches turns this process owns and no
 * run tracks: redelivery copies a settle already missed, never live work.
 * Delivery goes back to `queued` with it: the copy was filed as `started`
 * when nothing was running, and the promotion scan only takes queued turns.
 */
export async function requeueUnownedTurn(store: ThreadStore, rawThreadId: string, turnId: string): Promise<boolean> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const turn = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
    if (!turn || turn.status !== "running" || store.isTracked(turnId)) return false;
    const owner = turn.owner;
    if (!owner || owner.host !== os.hostname() || owner.pid !== process.pid) return false;
    await store.updateTurn(threadId, turnId, { status: "queued", delivery: "queued", owner: null, updatedAt: store.nowIso() });
    return true;
  }).catch(() => false);
}

async function uploadsOfAttachments(attachments: readonly StoredAttachment[]): Promise<ImageAttachmentUpload[]> {
  const uploads: ImageAttachmentUpload[] = [];
  for (const attachment of attachments) {
    const bytes = await readFile(attachment.path).catch(() => null);
    if (bytes === null) continue;
    uploads.push({
      type: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: bytes.length,
      dataUrl: `data:${attachment.mimeType};base64,${bytes.toString("base64")}`,
    });
  }
  return uploads;
}

function uploadsOfImages(images: ReadonlyArray<{ readonly name: string; readonly mimeType: string; readonly data: string }>): ImageAttachmentUpload[] {
  return images.map((image) => ({
    type: "image" as const,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: Buffer.byteLength(image.data, "base64"),
    dataUrl: `data:${image.mimeType};base64,${image.data}`,
  }));
}

/** A queued turn still waiting for its scheduled time. */
/**
 * Put a promoted turn back in the queue, held until `until`.
 *
 * Settling a turn promotes the next queued one, and its runner starts it
 * at once. When the turn just settled ran into a usage limit, starting the
 * next one only runs it into the same wall — and the one after that, until
 * every queued message is a failed turn. The runner calls this instead, so
 * the message waits for the reset like a scheduled one.
 *
 * Only a turn still `running` with no provider run attached is moved: one
 * that has already started belongs to its run.
 */
export async function holdPromotedTurn(
  store: ThreadStore,
  rawThreadId: string,
  turnId: string,
  until: string,
): Promise<boolean> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const turn = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
    if (!turn || turn.status !== "running" || store.isTracked(turnId)) return false;
    const now = store.nowIso();
    await store.updateTurn(threadId, turnId, {
      status: "queued",
      scheduledFor: until,
      scheduleReason: "usage-hold",
      // Released: whoever runs it at the reset takes it then.
      owner: null,
      updatedAt: now,
    });
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId,
      kind: "turn.held",
      summary: "Held until the usage limit resets",
      payload: { until },
      createdAt: now,
    });
    store.emit(threadId, "turn-held");
    return true;
  });
}

/**
 * When a message sent now should go out instead: the time a continue after
 * a usage limit (or a message already held behind one) waits for, while it
 * is still ahead. Null when nothing is waiting out a limit.
 */
export function usageHoldUntil(turns: readonly StoredTurn[], now: number): string | null {
  let until: string | null = null;
  for (const turn of turns) {
    if (!isHeldTurn(turn, now)) continue;
    if (turn.scheduleReason !== "usage-reset" && turn.scheduleReason !== "usage-hold") continue;
    if (until === null || Date.parse(turn.scheduledFor!) > Date.parse(until)) until = turn.scheduledFor!;
  }
  return until;
}

export function isHeldTurn(turn: StoredTurn, now: number = Date.now()): boolean {
  return turn.status === "queued" && typeof turn.scheduledFor === "string" && Date.parse(turn.scheduledFor) > now;
}

/**
 * A held turn whose time has come (or that never had one): a continue set
 * for a usage-limit reset, or a message held behind one, now due. A new send
 * queues behind these oldest-first rather than overtaking them.
 */
function isDueHeldTurn(turn: StoredTurn, now: number): boolean {
  return (
    turn.status === "queued" &&
    (turn.scheduleReason === "usage-reset" || turn.scheduleReason === "usage-hold") &&
    !isHeldTurn(turn, now)
  );
}

function sameModel(left: StoredTurn, right: StoredTurn): boolean {
  return left.modelSelection?.instanceId === right.modelSelection?.instanceId && left.modelSelection?.model === right.modelSelection?.model;
}

function waitingInteractionMode(turn: StoredTurn, threadMode: InteractionMode): InteractionMode {
  return turn.interactionModeExplicit ? turn.interactionMode : threadMode;
}

/**
 * The Antigravity automatic-prompt setting in force when a decision is made:
 * `providers.antigravity.allowUnsupportedUse` as the deciding process read
 * it, never an earlier turn's config snapshot. Undefined means the caller
 * cannot know it, and the gate holds nothing (as before this field existed).
 */
export type GateProviders = Pick<CliConfig, "providers">["providers"];

/**
 * Fold every other queued message that could go now into `next`: queued
 * behind the same turn, or held for the same reset, they are sent together
 * as one turn — not one turn each, with the agent working through the first
 * before it even sees the second. Their turns never ran, so they are dropped
 * and their messages move onto `next`. A message for another model or mode, or one
 * still waiting for a later time, keeps its own turn.
 *
 * A turn the Antigravity gate (`gateProviders`) holds never folds either
 * way: folded into a user's turn the held text would ride a turn it is
 * forbidden to reach, and the user's own message folded into a held one
 * would be stranded with it. The eligibility decisions are made here,
 * before the ledger rewrite, so nothing is merged into a shape the gate
 * would hold.
 *
 * A continue set for a usage-limit reset batches the same way even though it
 * carries its automatic wait: that queue holds no conditions of its own, so
 * the folded messages ride the same reset. Any other queue-carrying turn (a
 * wake-up, a handoff, a held entry) keeps its own turn, as before.
 *
 * A maintenance turn (`/compact`) never folds either way: folded into an
 * ordinary follow-up it keeps the marker and hides the real reply, and an
 * ordinary message folded into it would send `/compact` as text no provider
 * runs as a compaction. It is also a batching boundary: only messages queued
 * on the same side of it travel with `next`, so nothing queued after a
 * `/compact` overtakes it. Each keeps its own turn.
 */
async function batchQueuedLocked(store: ThreadStore, threadId: string, next: StoredTurn, turns: readonly StoredTurn[], now: string, threadMode: InteractionMode, gated: ReadonlySet<string>, antigravity = false): Promise<void> {
  if (next.queue && next.scheduleReason !== "usage-reset") return;
  const nextAt = turns.findIndex((turn) => turn.id === next.id);
  const onwards = nextAt < 0 ? [] : turns.slice(nextAt + 1);
  const candidates = onwards.filter(
    (turn) =>
      turn.status === "queued" &&
      !turn.queue &&
      !gated.has(turn.id) &&
      (turn.scheduleReason !== "usage-hold" || next.scheduleReason === "usage-reset" || next.scheduleReason === "usage-hold") &&
      !isHeldTurn(turn, Date.parse(now)) &&
      turn.scheduleReason !== "usage-reset" &&
      turn.usageRecoveryNotice !== true &&
      waitingInteractionMode(turn, threadMode) === waitingInteractionMode(next, threadMode) &&
      sameModel(turn, next),
  );
  if (candidates.length === 0) return;
  const messages = await store.readMessages(threadId);
  if (isMaintenanceTurn(next, messages)) return;
  // On Antigravity, promotion folds only what shares the dispatch's
  // provenance: the setting can turn off between this batch and the send that
  // runs it, and a phase where the user's words live inside a turn the gate
  // would hold must never be reachable — in either queue order. A task
  // notice that rides stays a rider wherever it queued (shared decision,
  // `automaticDispatchPrompt`); a task or agent message keeps its own row
  // and runs after the user's message, alone.
  const automaticOf = (turn: StoredTurn): boolean =>
    automaticDispatchPrompt(turn, turn.origin ?? messages.find((message) => message.turnId === turn.id && message.origin !== undefined)?.origin, turns);
  // Everything after the first queued maintenance turn is on its far side.
  const boundary = onwards.findIndex((turn) => turn.status === "queued" && isMaintenanceTurn(turn, messages));
  const side = new Set((boundary < 0 ? onwards : onwards.slice(0, boundary)).map((turn) => turn.id));
  const batch = candidates.filter((turn) => side.has(turn.id) && !isMaintenanceTurn(turn, messages) && (!antigravity || automaticOf(turn) === automaticOf(next)));
  if (batch.length === 0) return;
  const folded = new Set(batch.map((turn) => turn.id));
  await store.rewriteLedger(threadId, "messages", messages.map((message) => (folded.has(message.turnId) ? { ...message, turnId: next.id } : message)));
  await store.rewriteLedger(threadId, "turns", turns.filter((turn) => !folded.has(turn.id)));
  await store.appendLedger(threadId, "activity", {
    id: store.newId(),
    threadId,
    turnId: next.id,
    kind: "turn.batched",
    summary: `${batch.length + 1} queued messages sent together`,
    payload: { turnIds: [...folded] },
    createdAt: now,
  });
}

/**
 * What a turn sends: every user message on it, in order — one, or several
 * queued messages batched into it — with all their images.
 */
export function turnPrompt(messages: readonly StoredMessage[], turn: StoredTurn): { text: string; attachments: StoredAttachment[] } | null {
  const own = messages.filter((message) => message.turnId === turn.id && message.role === "user" && message.text.trim().length > 0);
  if (own.length === 0) {
    const first = messages.find((message) => message.id === turn.messageId);
    return first?.text ? { text: first.text, attachments: [...(first.attachments ?? [])] } : null;
  }
  return {
    text: own.map((message) => message.text.trim()).join("\n\n"),
    attachments: own.flatMap((message) => message.attachments ?? []),
  };
}

/** Split only the primary prompt marked by the internal usage-recovery producer. */
export function usageNoticeParts(
  messages: readonly StoredMessage[],
  turn: StoredTurn,
): { readonly prompt: string; readonly notices: readonly string[] } | undefined {
  // Old `usage-continue` origins could be inferred from client scheduling metadata.
  if (turn.usageRecoveryNotice !== true) return undefined;
  const notice = messages.find((message) => message.id === turn.messageId && message.turnId === turn.id && message.role === "user")?.text.trim();
  if (!notice) return undefined;
  const prompt = messages.filter((message) => message.turnId === turn.id && message.role === "user" && message.id !== turn.messageId)
    .map((message) => message.text.trim()).filter(Boolean).join("\n\n");
  return { prompt, notices: [notice] };
}

/**
 * A held turn settle may start once its time has come: a continue set for a
 * usage-limit reset, or a message held behind one. Queue-carrying turns stay
 * owned by the admission path — their conditions, holds and sequence need
 * the queue's view — except a bare automatic wait: no conditions, not held
 * or removed, not sequential, running here rather than alongside other
 * entries. Anything else queued (a wake-up, a handoff, a held entry) waits
 * for admission like before.
 */
function settleStartsHeldTurn(turn: StoredTurn): boolean {
  if (turn.scheduleReason !== "usage-reset" && turn.scheduleReason !== "usage-hold") return false;
  const queue = turn.queue;
  if (!queue) return true;
  return (
    queue.automatic === true &&
    queue.wakeUp !== true &&
    queue.summaryFor === undefined &&
    queue.continuation === "same-thread" &&
    queue.held !== true &&
    queue.removed !== true &&
    queue.sequential !== true &&
    queue.conditions.length === 0
  );
}

/**
 * An automatic continue settle may cancel but never promote: a handoff
 * summary stays owned by the admission path, while a bare automatic wait due
 * here is stale when the work resumed. A wake-up may also carry a merged
 * notification — the riders check below decides that.
 */
function settleCancelsStaleTurn(turn: StoredTurn): boolean {
  if (turn.scheduleReason !== "usage-reset") return false;
  const queue = turn.queue;
  if (queue && (queue.automatic !== true || queue.summaryFor !== undefined)) return false;
  return true;
}

/**
 * Whether this queued turn is a stale automatic continue: due, and a turn
 * ran to completion at or after it came due, so the thread's work already resumed
 * and the scheduled nudge would fire as a pointless turn. Only a completed
 * turn counts — one that failed or was interrupted did not resume anything.
 * Wake-up riders are not considered here; callers check `wakeUpHasRiders`.
 */
export function isStaleContinueTurn(turns: readonly StoredTurn[], turn: StoredTurn, instant: number): boolean {
  if (turn.status !== "queued" || !settleCancelsStaleTurn(turn) || isHeldTurn(turn, instant)) return false;
  return continueStale(turns, turn, instant);
}

/**
 * Whether a stale-candidate wake-up turn carries another delivery's message:
 * a native task edge merges its report into the queued wake-up rather than
 * losing either. Cancelling that turn would drop the report, so a turn with
 * riders is never stale — it still has something to say.
 */
export function wakeUpHasRiders(messages: readonly StoredMessage[], turn: StoredTurn): boolean {
  return messages.some((message) => message.turnId === turn.id && message.id !== turn.messageId);
}

/**
 * Whether an automatic continue after a usage limit is stale: a turn ran to
 * completion at or after it came due, so the thread's work already resumed and the
 * scheduled nudge would fire as a pointless turn. Only a completed turn
 * counts — one that failed or was interrupted did not resume anything.
 */
function continueStale(turns: readonly StoredTurn[], turn: StoredTurn, instant: number): boolean {
  if (turn.scheduleReason !== "usage-reset") return false;
  // Due from its scheduled time, or from creation when it has none.
  const due = turn.scheduledFor !== undefined && turn.scheduledFor !== null ? Date.parse(turn.scheduledFor) : Date.parse(turn.createdAt);
  if (!Number.isFinite(due) || due > instant) return false;
  return turns.some(
    (other) =>
      other.id !== turn.id &&
      other.status === "completed" &&
      // At-or-after, not strictly after: ledger timestamps resolve to the
      // millisecond, so a turn sent after waiting for the due time can share
      // its millisecond — and that is still a resume (MXN-325). A strict `>`
      // missed the take-back there and fired the pointless turn.
      Date.parse(other.startedAt ?? other.createdAt) >= due,
  );
}

/** Caller must hold the thread lock. Take back a stale automatic continue before it runs. */
async function cancelStaleContinueLocked(store: ThreadStore, threadId: string, turn: StoredTurn, now: string): Promise<void> {
  await store.updateTurn(threadId, turn.id, { status: "interrupted", updatedAt: now, completedAt: now });
  await store.appendLedger(threadId, "activity", {
    id: store.newId(),
    threadId,
    turnId: turn.id,
    kind: "turn.interrupted",
    summary: turn.id,
    // Taken back before it ran: clients drop it from the transcript rather
    // than show a turn that never happened.
    payload: { beforeStart: true },
    createdAt: now,
  });
  store.emit(threadId, "turn-interrupted");
}

async function promoteQueuedLocked(store: ThreadStore, threadId: string, now: string, admittedId?: string, summary = false, gateProviders?: GateProviders): Promise<void> {
  const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
  const pause = thread.usagePause;
  if (pause && (pause.forced || !summary && pause.phase !== "resuming" && (admittedId === undefined || pause.recoveryTurnId !== admittedId))) return;
  let turns = await store.readTurns(threadId);
  // A live turn blocks promotion: a running one, an ownerless one, or one
  // with a status no build writes. So does a turns ledger hiding rows.
  if (liveTurn(turns) || hiddenTurnsProblem(store, threadId)) return;
  // Eligibility is decided here, before anything rewrites the queue: a
  // queued turn the Antigravity gate holds is never promoted as a runner's
  // follow-up and never batched into the turn that is, so its text and
  // metadata survive untouched for admission, which holds them with the
  // gate's reason until the setting turns on or a user turn releases them.
  const origins = gateProviders === undefined ? new Map<string, MessageOrigin | undefined>() : await loadTurnOrigins(store, [{ thread, turns }], { providers: gateProviders });
  const gateHolds = (turn: StoredTurn): boolean => {
    const selection = turn.modelSelection ?? thread.modelSelection;
    return antigravityHoldsAutomaticDispatch(gateProviders, selection.instanceId, turn, turn.origin ?? origins.get(turnOriginKey(threadId, turn.id)), turns);
  };
  const gated = new Set<string>();
  for (const turn of turns) {
    if (turn.status === "queued" && gateHolds(turn)) gated.add(turn.id);
  }
  // A scheduled turn waits for its time; ordinary queued turns go ahead of it.
  const instant = Date.parse(now);
  if (admittedId === undefined) {
    // A stale automatic continue never fires: the thread's work already
    // resumed, so the scheduled nudge is taken back before it runs. Done
    // before candidacy so batching below never folds a cancelled turn in.
    let stale = false;
    let messages: readonly StoredMessage[] | null = null;
    for (const turn of turns) {
      if (!isStaleContinueTurn(turns, turn, instant)) continue;
      if (turn.queue?.wakeUp === true) {
        messages ??= await store.readMessages(threadId);
        if (wakeUpHasRiders(messages, turn)) continue;
      }
      await cancelStaleContinueLocked(store, threadId, turn, now);
      stale = true;
    }
    if (stale) turns = await store.readTurns(threadId);
  }
  const threadHeld = admittedId === undefined && threadStatus(thread, instant) !== "active";
  const next = turns.find((turn) => {
    if (turn.status !== "queued" || isHeldTurn(turn, instant)) return false;
    if (admittedId) return turn.id === admittedId;
    // Held for admission instead of this runner: the gate keeps its turn row
    // intact, so nothing the user queued there is stranded by a merge.
    if (gated.has(turn.id)) return false;
    if (threadHeld) return false;
    // A held turn whose time has come starts after the running turn settles,
    // oldest first like any queued turn — but never while the limit stands.
    // (The usage-protection tick and the schedule timer admit queue-carrying
    // turns with their conditions; settle only takes bare automatic waits.)
    if (settleStartsHeldTurn(turn)) {
      const selection = turn.modelSelection ?? thread.modelSelection;
      return !providerExhausted(usageKeyForInstance(selection.instanceId), instant, selection.model);
    }
    if (turn.queue || turn.scheduleReason === "usage-reset" || turn.scheduleReason === "usage-hold") return false;
    // Plain turns never pass through the admission path, so their one
    // admission check lives here: `queueAdmission` — and the Work queue
    // display built on it — blocks any non-automatic turn on an exhausted
    // provider. Promoting regardless would start a turn the queue shows as
    // blocked, failing it into a hold instead of letting it wait.
    const selection = turn.modelSelection ?? thread.modelSelection;
    return !providerExhausted(usageKeyForInstance(selection.instanceId), instant, selection.model);
  });
  if (!next && admittedId === undefined) {
    // Settle starts nothing waiting here: hold every plain turn still queued
    // for the admission path — a snoozed or settled thread, or an exhausted
    // provider — so it can start them once nothing blocks them. Only turns
    // settle held back are marked, never an ordinary queue: a turn queued
    // behind a protection-interrupted turn keeps waiting for the next send
    // or settle.
    await holdQueuedForAdmission(store, threadId, instant);
  }
  if (admittedId === undefined && next !== undefined) {
    // A plain turn the gate held stays marked for the admission path even
    // while another turn runs: admission reports it with the gate's reason
    // in the Work queue instead of leaving it waiting for a settle that may
    // never come.
    for (const turn of turns) {
      if (turn.status === "queued" && !turn.queue && gated.has(turn.id) && turn.scheduleReason !== "usage-reset" && turn.scheduleReason !== "usage-hold" && !isHeldTurn(turn, instant) && !turn.heldAtSettle && !turn.heldBySnooze) {
        await store.updateTurn(threadId, turn.id, { heldAtSettle: true });
      }
    }
  }
  if (!next) return;
  const executionSeq = await allocateTurnSeqLocked(store, thread, turns);
  await store.writeThreadRecord({
    ...thread,
    turnSeq: executionSeq,
    ...(pause && pause.recoveryTurnId === next.id ? { usagePause: { ...pause, phase: "resuming" } } : {}),
  });
  await batchQueuedLocked(store, threadId, next, turns, now, thread.interactionMode, gated, driverKindOfInstance((next.modelSelection ?? thread.modelSelection).instanceId) === "antigravity");
  await store.updateTurn(threadId, next.id, { status: "running", executionSeq, interactionMode: waitingInteractionMode(next, thread.interactionMode), owner: currentTurnOwner(), startedAt: now, updatedAt: now, ...(next.heldAtSettle || next.heldBySnooze ? { heldAtSettle: undefined, heldBySnooze: undefined } : {}) });
  await store.appendLedger(threadId, "activity", {
    id: store.newId(),
    threadId,
    turnId: next.id,
    kind: "turn.promoted",
    summary: next.id,
    createdAt: now,
  });
  store.emit(threadId, "turn-promoted");
}

/**
 * Requeue a dispatch this process will not run, durably: back to queued,
 * marked for admission — which holds it with `reason` until the setting
 * turns on, a genuine fresh user turn releases it, or the next server admits
 * it — with the held activity recorded beside it. Used for a turn the
 * Antigravity gate denied and for a promotion or recovery a restart's drain
 * came under. The caller releases its claim first, so the lock below never
 * fights another runner; a turn that meanwhile settled or was claimed
 * elsewhere keeps whatever happened to it.
 */
export async function requeueHeldDispatch(store: ThreadStore, threadId: string, turnId: string, reason: string): Promise<void> {
  store.untrackRunning(turnId);
  await store.withThreadLock(threadId, async () => {
    const fresh = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
    if (!fresh || fresh.status !== "running" || store.isTracked(turnId)) return;
    const now = store.nowIso();
    await store.updateTurn(threadId, turnId, { status: "queued", heldAtSettle: true, owner: null, updatedAt: now });
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId,
      kind: "turn.held",
      summary: reason,
      createdAt: now,
    });
    store.emit(threadId, "turn-held");
  }).catch(() => undefined);
}

/**
 * Hold every plain turn still queued for the admission path, so it can start
 * them once nothing blocks them. The admission path only takes plain turns
 * settle marked this way; without the mark an idle thread's queued plain
 * turn would wait for a send or settle that never comes. A snooze-held turn
 * keeps its own mark: its hold ends with the snooze, not with the next
 * admissible moment.
 *
 * Caller must hold the thread lock.
 */
async function holdQueuedForAdmission(store: ThreadStore, threadId: string, instant: number): Promise<void> {
  for (const turn of await store.readTurns(threadId)) {
    if (turn.status === "queued" && !turn.queue && turn.scheduleReason !== "usage-reset" && turn.scheduleReason !== "usage-hold"
      && !isHeldTurn(turn, instant) && !turn.heldAtSettle && !turn.heldBySnooze) {
      await store.updateTurn(threadId, turn.id, { heldAtSettle: true });
    }
  }
}

/**
 * Re-queue a promotion no runner will ever take.
 *
 * A settle that ran with no live run behind it (a session that failed to
 * start) promotes the next queued turn to `running`, but nothing hands it to
 * a driver. The caller names the turns that were queued before the settle;
 * any of those now `running` with no run in this process goes back to the
 * queue, held for the admission path. Each turn is claimed first, so a runner
 * that took it concurrently wins.
 */
export async function holdStrandedPromotions(store: ThreadStore, rawThreadId: string, wasQueued: ReadonlySet<string>): Promise<void> {
  const threadId = requireThreadId(rawThreadId);
  for (const turnId of wasQueued) {
    const turn = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
    if (!turn || turn.status !== "running" || store.isTracked(turnId)) continue;
    const owner = turn.owner;
    if (!owner || owner.host !== os.hostname() || owner.pid !== process.pid) continue;
    if (!store.claimRun(turnId)) continue;
    try {
      await store.withThreadLock(threadId, async () => {
        const fresh = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
        if (!fresh || fresh.status !== "running") return;
        await store.updateTurn(threadId, turnId, { status: "queued", heldAtSettle: true, owner: null, updatedAt: store.nowIso() });
      });
    } finally {
      store.untrackRunning(turnId);
    }
  }
}

/**
 * Start the thread's scheduled turn that has come due, if the thread is free:
 * promoted to `running` (owned by this process) and returned for the caller
 * to run. Null when nothing is due, or a turn is already running — that
 * turn's settle promotes the due held turn instead (see `promoteQueuedLocked`).
 */
export async function promoteDueScheduledTurn(store: ThreadStore, rawThreadId: string, admittedId?: string, summary = false, gateProviders?: GateProviders): Promise<StoredTurn | null> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const turns = await store.readTurns(threadId);
    if (openTurn(turns)) return null;
    // A manual continuation in flight owns the checkout: a due turn waits
    // for the handoff to clear its claim rather than starting beside it.
    const record = await store.readThreadRecord(threadId);
    if (!record || (await continuationInFlight(store, record)).blocked) return null;
    const due = turns.find(
      (turn) => turn.status === "queued" && (admittedId ? turn.id === admittedId : typeof turn.scheduledFor === "string") && !isHeldTurn(turn, Date.parse(now)),
    );
    if (!due) return null;
    await promoteQueuedLocked(store, threadId, now, admittedId ?? due.id, summary, gateProviders);
    return (await store.readTurns(threadId)).find((turn) => turn.status === "running" && !store.isTracked(turn.id)) ?? null;
  });
}

export interface FinishTurnInput {
  /** Assistant text appended on completion; omitted for pure interrupts/failures. */
  readonly text?: string;
  readonly error?: string;
  readonly usage?: TurnUsage | null;
  readonly turnOutputTokens?: number;
  readonly generation?: { readonly characters: number; readonly durationMs: number };
}

async function finishTurn(
  store: ThreadStore,
  rawThreadId: string,
  rawTurnId: string,
  status: "completed" | "failed",
  input: FinishTurnInput = {},
  gateProviders?: GateProviders,
): Promise<{ thread: StoredThread; turn: StoredTurn }> {
  const threadId = requireThreadId(rawThreadId);
  const turnId = rawTurnId.trim();
  if (!turnId) {
    throw new CliError("TURN_ID_REQUIRED", "A non-empty turn id is required.", { exitCode: 2 });
  }
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    const turn = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
    if (!turn) {
      throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turnId}.`, {
        exitCode: 3,
        details: { threadId, turnId },
      });
    }
    if (turn.status !== "running") {
      throw new CliError("TURN_NOT_RUNNING", `Turn ${turnId} is ${turn.status}, not running.`, {
        exitCode: 4,
        details: { threadId, turnId, status: turn.status },
      });
    }
    if (status === "completed" && input.text !== undefined) {
      await store.appendLedger(threadId, "messages", {
        id: store.newId(),
        threadId,
        turnId,
        role: "assistant",
        text: input.text,
        createdAt: now,
      });
    }
    store.untrackRunning(turnId);
    const updated = await store.updateTurn(threadId, turnId, {
      status,
      ...(status === "failed" && input.error !== undefined ? { error: input.error } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.turnOutputTokens !== undefined ? { turnOutputTokens: input.turnOutputTokens } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      updatedAt: now,
      completedAt: now,
    });
    if (!updated) {
      throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turnId}.`, {
        exitCode: 3,
        details: { threadId, turnId },
      });
    }
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId,
      kind: status === "completed" ? "turn.completed" : "turn.failed",
      summary: status === "failed" ? (input.error ?? turnId) : turnId,
      createdAt: now,
    });
    // A settle during a drain promotes nothing: a promoted turn would start on
    // a server that is going away. Held for the admission path, it runs once
    // the next server is up.
    if (isDraining()) await holdQueuedForAdmission(store, threadId, Date.parse(now));
    else await promoteQueuedLocked(store, threadId, now, undefined, false, gateProviders);
    const latestThread = (await store.readThreadRecord(threadId)) ?? thread;
    const next = { ...latestThread, updatedAt: now };
    await store.writeThreadRecord(next);
    store.emit(threadId, status === "completed" ? "turn-completed" : "turn-failed");
    return { thread: next, turn: updated };
  });
}

/** Stage 2 drivers call this when the provider run finishes. */
export async function completeTurn(
  store: ThreadStore,
  threadId: string,
  turnId: string,
  input: FinishTurnInput = {},
  gateProviders?: GateProviders,
): Promise<{ thread: StoredThread; turn: StoredTurn }> {
  return await finishTurn(store, threadId, turnId, "completed", input, gateProviders);
}

/** Stage 2 drivers call this when the provider run errors. */
export async function failTurn(
  store: ThreadStore,
  threadId: string,
  turnId: string,
  input: FinishTurnInput = {},
  gateProviders?: GateProviders,
): Promise<{ thread: StoredThread; turn: StoredTurn }> {
  return await finishTurn(store, threadId, turnId, "failed", input, gateProviders);
}

export interface InterruptTurnResult {
  readonly thread: StoredThread;
  readonly turn: StoredTurn | null;
  readonly interrupted: boolean;
}

export async function interruptTurn(
  store: ThreadStore,
  rawThreadId: string,
  rawTurnId?: string,
  usagePause?: StoredTurn["usagePause"],
  options: {
    readonly reason?: string;
    readonly usage?: StoredTurn["usage"];
    /**
     * A reason to leave the turn alone, read under the thread lock at the
     * moment of the write. A caller that decided to stop the turn outside
     * the lock — a mid-turn compaction, whose reads take time — rechecks
     * here, so nothing that changed while it waited commits a stop it would
     * no longer make.
     */
    readonly holdIf?: () => boolean;
  } = {},
  gateProviders?: GateProviders,
): Promise<InterruptTurnResult> {
  const threadId = requireThreadId(rawThreadId);
  const turnId = rawTurnId?.trim() || undefined;
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    requireNotArchived(thread, "be interrupted");
    const turns = await store.readTurns(threadId);
    const target = turnId
      ? (turns.find((turn) => turn.id === turnId) ?? null)
      : liveTurn(turns);
    // A turn with a status no build writes is stuck by definition: stopping
    // it is the fix, so it stops like a running one.
    if (!target) {
      // The row is hidden in a skipped line, but this process runs the turn:
      // abort the run. Anything else is for the quarantine, not a stop.
      if (turnId !== undefined && store.isTracked(turnId)) {
        store.abortRunning(turnId);
        return { thread, turn: null, interrupted: true };
      }
      return { thread, turn: null, interrupted: false };
    }
    if (isKnownTurnStatus(target.status) && target.status !== "running" && target.status !== "queued") {
      return { thread, turn: target, interrupted: false };
    }
    // The last word before the write, read under the lock: a caller that
    // decided outside it takes back a stop whose reason no longer holds
    // (see `holdIf`). Nothing is mutated and nothing is promoted.
    if (options.holdIf?.() === true) {
      return { thread, turn: target, interrupted: false };
    }
    // Whether a run in this process will take the turn this promotes: the
    // stopped turn's own runner, when it settles, or the send still starting
    // it (which claims the turn below before its session starts). Read before
    // the interrupt releases the claim.
    // A legacy running turn predating `executionSeq` gets a durable boundary
    // now, under the lock, so cancelling and later reverting it still lets
    // subsequent sequenced turns clear the cancellation mark.
    let targetForStop = target;
    let threadForStop = thread;
    if (target.status !== "queued" && target.executionSeq === undefined) {
      const { highest, seeded } = await seedLegacyExecutionSeqsLocked(store, thread, turns);
      const legacySeq = seeded.get(target.id) ?? highest + 1;
      const nextHighest = Math.max(highest, legacySeq);
      threadForStop = { ...thread, turnSeq: nextHighest };
      await store.writeThreadRecord(threadForStop);
      if (!seeded.has(target.id)) {
        await store.updateTurn(threadId, target.id, { executionSeq: legacySeq });
      }
      targetForStop = { ...target, executionSeq: legacySeq };
    }
    const hasRunner = store.isTracked(targetForStop.id);
    const updated = await interruptTurnLocked(store, threadForStop, targetForStop, now, usagePause, options.reason, options.usage);
    if (hasRunner && !isDraining()) {
      await promoteQueuedLocked(store, threadId, now, undefined, false, gateProviders);
    } else {
      // No runner is alive to take a promotion (a dead runner, or a stop
      // from another process) — or a drain is stopping the server: a
      // promotion it took would start on the way out. Either way the queued
      // turns are held for the admission path instead of stranding one of
      // them `running` with an owner but no run.
      await holdQueuedForAdmission(store, threadId, Date.parse(now));
    }
    const latestThread = (await store.readThreadRecord(threadId)) ?? threadForStop;
    const next = { ...latestThread, updatedAt: now };
    await store.writeThreadRecord(next);
    store.emit(threadId, "turn-interrupted");
    return { thread: next, turn: updated, interrupted: true };
  });
}

/**
 * A thread's settlement family: itself and every live descendant (its
 * delegated tasks, and theirs). Settling a task never reaches up to its parent
 * or across to its siblings. Archived and deleted members are left out; the
 * requested thread is always in.
 */
export async function threadFamily(store: ThreadStore, threadId: string): Promise<string[]> {
  // The parent link lives in the delegations ledger, not on the thread record.
  const rows = await store.readDelegations().catch(() => []);
  const family = new Set([threadId]);
  const queue = [threadId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const row of rows) {
      if (row.parentThreadId !== current || family.has(row.childThreadId)) continue;
      const child = await store.readThreadRecord(row.childThreadId);
      if (child === null || child.archivedAt != null || child.deletedAt != null) continue;
      family.add(row.childThreadId);
      queue.push(row.childThreadId);
    }
  }
  return [...family];
}

/** Hold every listed thread's lock at once; ids are taken in sorted order, so concurrent family operations cannot deadlock. */
async function withThreadLocks<T>(store: ThreadStore, ids: readonly string[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...ids].sort();
  if (first === undefined) return await run();
  return await store.withThreadLock(first, () => withThreadLocks(store, rest, run));
}

export interface SettleOptions {
  /** Interrupt the family's running work instead of refusing to settle past it. */
  readonly stop?: boolean;
}

/**
 * Settling a thread settles it and all its live descendants, so a settled
 * parent never leaves active subthreads behind. A task settles on its own: its
 * parent and siblings are untouched.
 * If any member still has running/queued work or pending approvals or input,
 * nothing is settled — unless `stop` says to end that work first: every
 * running or queued turn in the family is interrupted (a run waiting on an
 * approval or an answer goes down with its turn), then the family settles.
 * Returns the requested thread's record.
 */
export async function settleThread(store: ThreadStore, rawThreadId: string, options: SettleOptions = {}): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  const family = await threadFamily(store, threadId);
  return await withThreadLocks(store, family, async () => {
    const now = store.nowIso();
    const members: StoredThread[] = [];
    const blocked: Array<{ id: string; running: boolean; thread: StoredThread }> = [];
    for (const id of family) {
      const thread = requireStoredThread(await store.readThreadRecord(id), id);
      if (id === threadId) requireNotArchived(thread, "change settlement state");
      if (thread.archivedAt != null || thread.deletedAt != null) continue;
      members.push(thread);
      const running = liveTurn(await store.readTurns(id)) !== null;
      if (running || thread.hasPendingApprovals || thread.hasPendingUserInput) blocked.push({ id, running, thread });
    }
    if (blocked.length > 0 && options.stop === true) {
      for (const entry of blocked) {
        // Every live turn, queued ones included: a queue left behind would start the moment the settled thread woke.
        for (const turn of await store.readTurns(entry.id)) {
          if (turn.status === "running" || turn.status === "queued" || !isKnownTurnStatus(turn.status)) {
            await interruptTurnLocked(store, entry.thread, turn, now, undefined, "The thread was settled, stopping its work.");
          }
        }
        const index = members.findIndex((member) => member.id === entry.id);
        if (index !== -1) members[index] = { ...members[index]!, hasPendingApprovals: false, hasPendingUserInput: false };
        store.emit(entry.id, "turn-interrupted");
      }
      blocked.length = 0;
    }
    if (blocked.length > 0) {
      const culprit = blocked.find((entry) => entry.id === threadId) ?? blocked[0]!;
      throw new CliError(
        "THREAD_SETTLE_BLOCKED",
        culprit.id === threadId
          ? `Thread ${threadId} still has active or blocked work.`
          : `Thread ${threadId} cannot settle: ${culprit.id} under it still has active or blocked work.`,
        {
          exitCode: 4,
          details: {
            threadId,
            hasActiveTurn: culprit.running,
            hasPendingApprovals: culprit.thread.hasPendingApprovals,
            hasPendingUserInput: culprit.thread.hasPendingUserInput,
            blockedThreadIds: blocked.map((entry) => entry.id),
          },
        },
      );
    }
    let result: StoredThread | null = null;
    for (const thread of members) {
      if (thread.id !== threadId && thread.settledAt != null) continue;
      // A forced hold ends on a message, settled threads refuse messages, and
      // the queue cannot cancel a forced hold — so one left behind would stick
      // forever. Settling ends it. An automatic hold stays: its recovery entry
      // is managed through the Work queue, and automatic input never unsettles
      // a settled thread while held.
      const next: StoredThread = { ...thread, settledAt: now, settledOverride: null, snoozedUntil: null, snoozeGeneration: null, snoozeConditions: null, snoozeLatched: null, updatedAt: now, ...(thread.usagePause?.forced ? { usagePause: null } : {}) };
      await store.writeThreadRecord(next);
      store.emit(thread.id, "settled");
      if (thread.id === threadId) result = next;
    }
    return result ?? members.find((thread) => thread.id === threadId)!;
  });
}

/** The mirror of `settleThread`: the thread and its descendants are woken; nothing can block it. Returns the requested thread's record. */
export async function unsettleThread(store: ThreadStore, rawThreadId: string): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  const family = await threadFamily(store, threadId);
  return await withThreadLocks(store, family, async () => {
    const now = store.nowIso();
    let result: StoredThread | null = null;
    for (const id of family) {
      const thread = requireStoredThread(await store.readThreadRecord(id), id);
      if (id === threadId) requireNotArchived(thread, "change settlement state");
      if (thread.archivedAt != null || thread.deletedAt != null) continue;
      const next: StoredThread = { ...thread, settledAt: null, settledOverride: "active", unsettledAt: now, updatedAt: now };
      await store.writeThreadRecord(next);
      store.emit(id, "unsettle");
      if (id === threadId) result = next;
    }
    return result!;
  });
}

/**
 * Snooze a thread until a time, or until conditions it waits for are met
 * (`task_snooze`): without `until` the snooze ends only when a wake pass
 * (`applySnoozeCheck`) clears it. Returns the requested thread's record.
 */
export async function snoozeThread(
  store: ThreadStore,
  rawThreadId: string,
  rawUntil: string | null,
  conditions: readonly QueueCondition[] = [],
): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  const snoozedUntil = rawUntil === null ? null : normalizeSnoozeUntil(rawUntil);
  if (snoozedUntil === null && conditions.length === 0) {
    throw new CliError("SNOOZE_UNTIL_INVALID", "A snooze needs a time or conditions to wait for.", { exitCode: 2 });
  }
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    requireNotArchived(thread, "be snoozed");
    // A snooze replaces the one before it whole: a latch its conditions earned
    // says nothing about these.
    const next: StoredThread = { ...thread, snoozedUntil, snoozedAt: now, snoozeGeneration: store.newId(), snoozeConditions: conditions.length === 0 ? null : conditions, snoozeLatched: null, updatedAt: now };
    await store.writeThreadRecord(next);
    store.emit(threadId, "snoozed");
    return next;
  });
}

export async function unsnoozeThread(store: ThreadStore, rawThreadId: string): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    requireNotArchived(thread, "be unsnoozed");
    const next: StoredThread = { ...thread, snoozedUntil: null, snoozeGeneration: null, snoozeConditions: null, snoozeLatched: null, updatedAt: now };
    await store.writeThreadRecord(next);
    store.emit(threadId, "unsnoozed");
    return next;
  });
}

/**
 * Identifies one snooze, so a pass that judged it can tell it from a newer one
 * set since: a wake that lands after a second `task_snooze` must not clear the
 * snooze it never looked at, nor write back what it learned about the old one.
 * The identity is the snooze's own generation, immutable while the snooze
 * lives — what passes learn into it (a latched provider event, a resolved
 * reset time) never changes whose snooze it is. A snooze stored before the
 * generation exists falls back to the fields it was set with.
 */
export function snoozeKey(thread: StoredThread): string {
  return thread.snoozeGeneration ?? JSON.stringify([thread.snoozedAt ?? null, thread.snoozedUntil ?? null, thread.snoozeConditions ?? null]);
}

/** What one wake pass learned about a thread's snooze. */
export interface SnoozeCheck {
  /** `snoozeKey` of the snooze the pass judged. */
  readonly key: string;
  /** Its conditions, with whatever the pass resolved into them (a reset time). */
  readonly conditions: readonly QueueCondition[];
  /** The `provider … after` events it saw, latched like the queue's own. */
  readonly latched: readonly number[];
  /** The time passed and every condition is met: clear the snooze. */
  readonly due: boolean;
}

/**
 * Record a wake pass's verdict, under the thread lock and only for the snooze
 * that pass judged (`snoozeKey`): a snooze set in between decides its own end,
 * and the stale verdict is dropped. Due clears the whole mark (the thread is
 * active again, no turn started); not due keeps what the pass learned — the
 * reset time it resolved, the provider event it saw — so the next pass does not
 * start over, the same way queue admission stores a turn's latched conditions.
 *
 * Two passes can judge the same snooze at once (the watch and an admission
 * pass, or a pass that lost a race to the lock), so a pass that read before
 * another stored must not unlearn what that other pass saw: what a check
 * carries is merged into the stored state under the lock — latched indices as
 * a union, and a reset the stored conditions already resolved keeps its time —
 * never replaced whole. Returns the record it wrote, or null when a newer
 * snooze took its place or there was nothing new to store.
 */
export async function applySnoozeCheck(store: ThreadStore, rawThreadId: string, check: SnoozeCheck): Promise<StoredThread | null> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    if (snoozeKey(thread) !== check.key) return null;
    const now = store.nowIso();
    if (check.due) {
      const next: StoredThread = { ...thread, snoozedUntil: null, snoozeGeneration: null, snoozeConditions: null, snoozeLatched: null, updatedAt: now };
      await store.writeThreadRecord(next);
      store.emit(threadId, "unsnoozed");
      return next;
    }
    // Merge under the lock: a sibling pass on the same snooze may have
    // learned a latch or a reset this pass did not see, and neither is ever
    // unlearned by the other's verdict.
    const storedConditions = thread.snoozeConditions ?? [];
    const conditions = check.conditions.map((condition, index) => {
      if (condition.type !== "reset" || condition.resetsAt != null) return condition;
      const stored = storedConditions[index];
      return stored?.type === "reset" && stored.resetsAt != null ? stored : condition;
    });
    const latched = [...new Set([...(thread.snoozeLatched ?? []), ...check.latched])].sort((left, right) => left - right);
    const unchanged = JSON.stringify(thread.snoozeConditions ?? null) === JSON.stringify(conditions)
      && JSON.stringify(thread.snoozeLatched ?? null) === JSON.stringify(latched.length === 0 ? null : latched);
    if (unchanged) return null;
    const next: StoredThread = { ...thread, snoozeConditions: conditions, snoozeLatched: latched.length === 0 ? null : latched, updatedAt: now };
    await store.writeThreadRecord(next);
    return next;
  });
}

export async function archiveThread(store: ThreadStore, rawThreadId: string, releaseCheckout?: (thread: StoredThread) => Promise<void>): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    if (thread.deletedAt != null) {
      throw new CliError("THREAD_ARCHIVED", `Thread ${threadId} is deleted and cannot be archived.`, {
        exitCode: 4,
        details: { threadId },
      });
    }
    const next: StoredThread = { ...thread, archivedAt: thread.archivedAt ?? now, updatedAt: now };
    await store.writeThreadRecord(next);
    await releaseCheckout?.(next);
    store.emit(threadId, "archived");
    return next;
  });
}

export async function restoreThread(store: ThreadStore, rawThreadId: string, restoreCheckout: (thread: StoredThread) => Promise<void>): Promise<void> {
  const threadId = requireThreadId(rawThreadId);
  await store.withThreadLock(threadId, async () => {
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    if (thread.deletedAt != null || thread.hidden === true) {
      throw new CliError("THREAD_ARCHIVED", `Thread ${threadId} cannot be restored.`, { exitCode: 4 });
    }
    if (thread.archivedAt == null) return;
    await restoreCheckout(thread);
    await store.writeThreadRecord({ ...thread, archivedAt: null, updatedAt: store.nowIso() });
    store.emit(threadId, "restored");
  });
}

export async function deleteThread(store: ThreadStore, rawThreadId: string): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    const next: StoredThread = { ...thread, deletedAt: now, updatedAt: now };
    await store.writeThreadRecord(next);
    store.emit(threadId, "deleted");
    return next;
  });
}

export interface UpdateThreadMetaInput {
  readonly title?: string;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
  readonly regenerateTitle?: boolean;
}

export async function updateThreadMeta(
  store: ThreadStore,
  rawThreadId: string,
  input: UpdateThreadMetaInput,
): Promise<StoredThread> {
  const threadId = requireThreadId(rawThreadId);
  return await store.withThreadLock(threadId, async () => {
    const now = store.nowIso();
    const thread = requireStoredThread(await store.readThreadRecord(threadId), threadId);
    requireNotArchived(thread, "be updated");
    if (input.interactionMode !== undefined && input.interactionMode !== thread.interactionMode && openTurn(await store.readTurns(threadId))) {
      throw modeLocked(threadId);
    }
    let title = thread.title;
    let titleSource = thread.titleSource;
    if (input.title !== undefined) {
      const trimmed = input.title.trim();
      if (!trimmed) {
        throw new CliError("INVALID_THREAD_OPTION", "A non-empty thread title is required.", { exitCode: 2 });
      }
      title = trimmed;
      titleSource = "user";
    } else if (input.regenerateTitle === true) {
      const messages = await store.readMessages(threadId);
      const firstUser = messages.find((message) => message.role === "user" && message.text.trim().length > 0);
      const seed = firstUser?.text.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, " ").trim() || thread.title;
      title = seed.length <= 80 ? seed : `${seed.slice(0, 79)}…`;
      titleSource = "seed";
    }
    const { researchPicker: _picker, ...kept } = thread;
    const switched = input.interactionMode !== undefined && input.interactionMode !== thread.interactionMode;
    const next: StoredThread = {
      ...(switched ? kept : thread),
      ...(switched && input.interactionMode === "research" ? { researchPicker: true } : {}),
      title,
      ...(titleSource ? { titleSource } : {}),
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      updatedAt: now,
    };
    await store.writeThreadRecord(next);
    store.emit(threadId, "meta-updated");
    return next;
  });
}

/**
 * Take the provider's native session title as the thread's. A title someone
 * chose (`titleSource: "user"`) stays unless `force` says the user asked for
 * the provider's (regenerate). Returns null when nothing changed.
 */
export async function adoptProviderTitle(
  store: ThreadStore,
  rawThreadId: string,
  rawTitle: string,
  options: { readonly force?: boolean } = {},
): Promise<StoredThread | null> {
  const threadId = requireThreadId(rawThreadId);
  const title = rawTitle.trim().replace(/\s+/gu, " ");
  if (!title) return null;
  return await store.withThreadLock(threadId, async () => {
    const thread = await store.readThreadRecord(threadId);
    if (thread === null || thread.archivedAt != null || thread.deletedAt != null) return null;
    if (thread.titleSource === "user" && options.force !== true) return null;
    if (thread.title === title && thread.titleSource === "provider") return null;
    const next: StoredThread = { ...thread, title, titleSource: "provider", updatedAt: store.nowIso() };
    await store.writeThreadRecord(next);
    store.emit(threadId, "meta-updated");
    return next;
  });
}

/** CLI `task-status`/`task-cancel` address delegations by child thread id. */
export async function delegationForChild(
  store: ThreadStore,
  parentThreadId: string,
  childThreadId: string,
): Promise<StoredDelegation | null> {
  const rows = await store.readDelegations();
  return rows.find((row) => row.parentThreadId === parentThreadId && row.childThreadId === childThreadId) ?? null;
}

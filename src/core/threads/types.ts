/**
 * Store-native thread model. This is ours — not the envelope shape.
 *
 * A thread carries its lifecycle flags (settled/snoozed/archived), its
 * model selection, and its environment; turns, messages, activity rows,
 * and checkpoint refs live in per-thread append-only JSONL ledgers.
 * The CLI projection to envelope shapes happens at the boundary, not here.
 * See docs/threads.md.
 */
import type { ImageAttachmentUpload } from "../attachments.js";
import type { ModelRequest } from "../catalog/selection.js";
import type { ReviewVerdict, TaskNotification } from "./notify.js";
import type { QueueCondition, QueuePolicy } from "./queue.js";
import type { UsageProtectionOverride } from "../usage/limits.js";
import type {
  InteractionMode,
  ModelSelection,
  RuntimeMode,
  TurnUsagePause,
} from "../types.js";

export type ThreadStatus = "active" | "settled" | "snoozed";
export type ThreadListStatus = ThreadStatus | "all";

export type ThreadEnvMode = "local" | "worktree";

export interface ThreadEnv {
  readonly mode: ThreadEnvMode;
  readonly path: string;
  readonly branch: string | null;
}

/**
 * Where a thread's title came from: `seed` is moxen's own (a placeholder or
 * the first message's line), `provider` the provider's native session title,
 * `user` an explicit name. A provider title never replaces a `user` one.
 */
export type ThreadTitleSource = "seed" | "provider" | "user";

export type ResearchRole = "researcher" | "critic" | "finalizer";

export interface ResearchSize {
  readonly researchers: number;
  readonly critics: number;
}


/** User-approved defaults for each role; omitted roles inherit the lead's model. */
export type ResearchModels = Readonly<Partial<Record<ResearchRole, ModelRequest>>>;

export interface ResearchPlan {
  readonly size: ResearchSize;
  readonly models?: ResearchModels;
}

export interface ResearchMessage {
  readonly id: string;
  readonly threadId: string;
  readonly kind: "handoff" | "report" | "verdict" | "followup" | "final";
  readonly text: string;
  readonly findings: number;
  readonly round?: number;
  readonly createdAt: string;
}

/** Kept atomically with the lead, while each role keeps its own turn and usage ledgers. */
export interface StoredResearchRun {
  readonly leadThreadId: string;
  readonly size?: ResearchSize;
  readonly models?: ResearchModels;
  readonly messages?: readonly ResearchMessage[];
  readonly roles: readonly { readonly threadId: string; readonly role: ResearchRole; readonly question: string }[];
  readonly state: "running" | "completed" | "failed" | "interrupted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly report?: string | null;
  /** Distinguishes approval from the first lead turn without comparing clocks. */
  readonly startedAfterTurnId?: string | null;
}

/** A manual `thread.continue` preparing this thread's continuation. While present, no turn may start here. */
export interface ContinueClaim {
  /** Matches the reservation's id, so clearing never lifts a newer claim. */
  readonly token: string;
  /** Who set it, so a dead handoff heals instead of wedging the thread. */
  readonly pid: number;
  readonly host: string;
  /** When it was set; a backstop when the owner cannot be judged. */
  readonly at: string;
}

/** Verbatim text a hand-off carries across continuations, cut at its cap with the ledger that holds the full text named. */
export interface HandoffText {
  /**
   * The text, already cut at its cap when it was carried: whatever the cut
   * replaced never returns, so the record stays bounded however many hops
   * the text survives. The cut, when there was one, says so within.
   */
  readonly text: string;
  /** The thread whose ledger holds the full text, for `thread_read`. */
  readonly sourceThreadId: string;
}

/**
 * One request the user queued that never ran: durable work, carried across
 * continuations until a thread of the chain owns it. The text is never
 * cut, and the identity and start condition survive every hop.
 */
export interface HandoffPendingRequest {
  readonly sourceThreadId: string;
  readonly turnId: string;
  readonly messageId: string;
  /** The request exactly as the user wrote it: untruncated work. */
  readonly text: string;
  /** The earliest instant the request may start, when it was scheduled. */
  readonly scheduledFor?: string | null;
  /**
   * The queue admission conditions the request was queued under, so a later
   * hop can keep it gated instead of dispatching it early. The internal
   * transfer wait is never carried (each hop re-attaches its own); everything
   * the user or the queue set travels with the request.
   */
  readonly conditions?: readonly QueueCondition[];
}

/**
 * The bounded facts a continued thread carries forward from the hand-off
 * that opened it, so a chain of continuations never nests whole hand-off
 * documents. Every field is structured data on the thread record — none
 * of it is parsed back out of a rendered document. Older records without
 * the field read with nothing carried.
 */
export interface HandoffFacts {
  /** The thread this hand-off document was built from: where anything cut or omitted still lives. */
  readonly sourceThreadId: string;
  /** The chain's original goal, as far as it was ever written down. */
  readonly goal: HandoffText | null;
  /** The latest user request that was already sent. */
  readonly lastRequest: HandoffText | null;
  /** The first thing to do, kept while no thread of the chain has answered. */
  readonly firstAction: HandoffText | null;
  /** The latest authored wrap-up of the chain's state. */
  readonly wrapUp: HandoffText | null;
  /** The checklist as the chain last recorded it, rows with omissions marked in-band. */
  readonly plan: readonly string[];
  /** Files the chain already changed, summed per path. */
  readonly files: readonly { readonly path: string; readonly additions: number; readonly deletions: number }[];
  /** Changed files omitted when the rows were capped. */
  readonly filesOmitted?: number;
  /** The chain's original image attachments, as saved attachment paths. */
  readonly images: readonly { readonly name: string; readonly path: string }[];
  /** Images omitted when the rows were capped. */
  readonly imagesOmitted?: number;
  /** The queued requests that never ran, oldest first. */
  readonly pending: readonly HandoffPendingRequest[];
}

export interface StoredThread {
  readonly researchRun?: StoredResearchRun;
  readonly pastResearchRuns?: readonly StoredResearchRun[];
  /** The user switched this thread into Research mode and has not been offered a run size yet; the next prompt offers it once. */
  readonly researchPicker?: boolean;
  readonly researchRole?: { readonly leadThreadId: string; readonly role: ResearchRole };
  /** The thread this one continued (`thread.continue`): its finished tasks are still this thread's to reach. */
  readonly continuedFrom?: string;
  /**
   * The bounded facts this thread carries forward from the hand-off that
   * opened it (`HandoffFacts`): what a chain of continuations may keep of
   * the threads behind it. Written by `continueThread` when it creates the
   * destination; absent on threads no hand-off opened and on threads stored
   * before the field existed — those read with nothing carried, and their
   * conversation is told as ordinary history.
   */
  readonly handoffFacts?: HandoffFacts;
  /**
   * A manual continuation in flight on this thread (`reserveContinuation`):
   * while present, admission starts no turn here, so the new worker never
   * runs beside one. Set and cleared under the thread lock around the
   * handoff; absent afterwards — a later send on the old thread is the
   * user's own choice. Absent on threads stored before claims existed, and
   * on threads no manual continue ever touched.
   */
  readonly continueClaim?: ContinueClaim | null;
  /** Durable account-quota queue. Only its coordinator may run while held. */
  readonly usagePause?: UsagePause | null;
  readonly usageProtectionOverride?: UsageProtectionOverride | null;
  readonly id: string;
  /** Internal tool tasks stay addressable by id but do not appear in thread lists. */
  readonly hidden?: boolean;
  readonly projectId: string;
  readonly title: string;
  /** Absent on threads stored before titles were tracked; read as `seed`. */
  readonly titleSource?: ThreadTitleSource;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly env: ThreadEnv;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly settledAt: string | null;
  readonly unsettledAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  /**
   * Identifies the one snooze a wake pass judged: set when the snooze is
   * (`snoozeThread`), never changed by a pass — only cleared with the rest of
   * the mark. So a check can tell the snooze it read from a replacement or a
   * stale sibling pass no matter what the passes learned into `snoozeConditions`
   * and `snoozeLatched` since. Absent on every thread stored before it: those
   * fall back to the snooze's own fields for identity (`snoozeKey`).
   */
  readonly snoozeGeneration?: string | null;
  /**
   * The queue conditions a snooze waits for (`task_snooze` with `conditions`):
   * while they are present the thread reads snoozed, and `wakeDueSnoozes`
   * unsnoozes it as soon as they are met. Absent for a snooze that ends on the
   * clock alone, and on every thread stored before a snooze could wait on
   * conditions.
   */
  readonly snoozeConditions?: readonly QueueCondition[] | null;
  /**
   * Indices of `snoozeConditions` whose `provider … after` event was already
   * seen (the queue's `QueuePolicy.latched`, kept beside the conditions for the
   * same reason): a provider that recovered since must not un-satisfy the wait
   * that event released. Absent for a snooze that ends on the clock alone.
   */
  readonly snoozeLatched?: readonly number[] | null;
  /** Set by drivers; settle is blocked while either is true. */
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /**
   * Native provider session handle per provider instance (Claude session
   * id, OpenCode session id), so a thread
   * resumes its provider-side history after the process that started the
   * session exits. Keyed by instance so switching providers and back
   * resumes rather than restarts. Absent on threads that never ran.
   */
  readonly providerSessions?: Readonly<Record<string, string>>;
  /**
   * The runtime instructions each provider's conversation was given, keyed
   * like `providerSessions`: `baseline` is what its change-tracked system
   * prompt carries — fixed when the conversation began, so every resume
   * rebuilds the same prompt and the provider's cached prefix stays valid —
   * and `delivered` is the latest the model has seen (the baseline, or the
   * last update appended after the history). `opening` is what a conversation
   * began with when that carried context the baseline does not (memory's
   * startup snapshot); absent for a conversation that began with the baseline,
   * and dropped when memory is turned off. See `planInstructions`.
   */
  readonly instructionState?: Readonly<
    Record<
      string,
      {
        readonly baseline: string;
        readonly delivered: string;
        readonly opening?: string;
        readonly baselineMeta?: {
          readonly builtInLength: number;
          readonly custom?: { readonly global?: string; readonly provider?: string; readonly project?: string };
        };
        readonly deliveredMeta?: {
          readonly builtInLength: number;
          readonly custom?: { readonly global?: string; readonly provider?: string; readonly project?: string };
        };
      }
    >
  >;
  /**
   * The mode each provider's conversation was last told about, keyed like
   * `providerSessions` (Claude and the Harness; OpenCode's driver keeps its
   * own). Absent means Build: nothing was said. See `threads/modes.ts`.
   */
  readonly modeState?: Readonly<Record<string, InteractionMode>>;
  /** The provider's own subagents, running and latest finished (`subagents.ts`). Absent until the first. */
  readonly nativeSubagents?: readonly StoredNativeSubagent[];
}

export interface UsagePause {
  /** Manual protection has no reset; only a user message releases it. */
  readonly forced?: boolean;
  readonly windows?: TurnUsagePause["windows"];
  readonly recoveryTurnId?: string;
  readonly provider: string;
  readonly phase: "pending" | "wrapping" | "waiting" | "resuming";
  readonly resetsAt: string | null;
  readonly order: number;
  readonly turnId?: string;
  /** Claude is already spending its provider-managed wrap-up allowance. */
  readonly native?: boolean;
  /** Written before starting a handoff, so recovery cannot create it twice. */
  readonly continuedThreadId?: string;
  readonly handoff: boolean;
  readonly error?: string;
}

/** One native subagent (Claude's Agent tool) as the thread record keeps it. */
export interface StoredNativeSubagent {
  readonly agentId: string;
  /** "Explore", "Plan", … ; "subagent" until its start hook names it. */
  readonly agentType: string;
  /** What it was asked to do (its Agent call's description), when known. */
  readonly description: string | null;
  readonly status: "running" | "completed" | "failed" | "stopped";
  readonly startedAt: string;
  readonly stoppedAt: string | null;
}

export type TurnStatus = "queued" | "running" | "completed" | "interrupted" | "failed" | "unknown";

/** `background`: a turn the provider started itself, woken by a finished background task or a Monitor event. */
export type TurnDelivery = "started" | "queued" | "steered" | "restarted" | "injected" | "background";

export interface StoredTurn {
  readonly usagePause?: TurnUsagePause;
  /**
   * The prompt Moxen generated to open this thread with a hand-off record:
   * provenance that a document was authored, not spoken by the user, so the
   * next hand-off recognizes it by data rather than by its text and never
   * retells it as history. Only the turn continueThread opens carries it.
   * Absent on turns stored before the field existed.
   */
  readonly handoffOpen?: true;
  /**
   * The message ids of the pending requests this hand-off opener carried as
   * part of its task (rendered into its prompt). Once the opener dispatches,
   * those requests count as sent: the next hand-off reconciles them away
   * instead of re-assigning them as never sent. Only a hand-off opener
   * carries it; absent elsewhere and on rows written before the field existed.
   */
  readonly handoffPending?: readonly string[];
  readonly queue?: QueuePolicy;
  /** The agent thread that queued this turn with `message_queue`; only it may list or change the entry (MXN-401). */
  readonly agentThreadId?: string;
  /**
   * Settle left this plain turn queued because the thread was settled or its
   * provider was exhausted — states the admission path reports as blocked —
   * or a settling runner on another provider's driver handed it back because
   * it could not take it. The admission path may start it once nothing blocks
   * it; cleared when it is promoted. Absent otherwise: an ordinary queued
   * turn still waits for the running turn's settle.
   */
  readonly heldAtSettle?: boolean | undefined;
  /**
   * The thread's snooze left this plain turn queued (an agent's
   * `message_queue` on a snoozed task): it waits for the snooze to end, and
   * the admission path starts it once the thread is active again. Kept apart
   * from `heldAtSettle` on purpose: a snooze holds automatic work only, so it
   * never makes a later direct send queue behind it — the oldest-first hold
   * does. Cleared when the turn is promoted.
   */
  readonly heldBySnooze?: boolean | undefined;
  readonly handoff?: {
    readonly requestId: string;
    readonly destinationThreadId: string;
    readonly summaryTurnId?: string;
    readonly summary?: string;
    readonly fallback?: boolean;
    /**
     * Set only when a manual-continue transfer actually landed its entry on
     * the destination. A staged claim carries no flag: staging marks, moving
     * lands.
     */
    readonly landed?: boolean;
  };
  readonly id: string;
  readonly threadId: string;
  readonly status: TurnStatus;
  readonly delivery: TurnDelivery;
  /**
   * A Moxen maintenance turn (a bare `/compact`), not work the user asked
   * for: its reply is the provider's compaction output, so task reports and
   * hand-off documents read the last turn that did real work instead. Turns
   * written before this field existed are recognised by their prompt.
   */
  readonly maintenance?: true;
  readonly messageId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  /** An explicit one-off mode; otherwise a waiting turn follows its thread at promotion. */
  readonly interactionModeExplicit?: true;
  /**
   * The model the turn ran on. Always set on new turns; `null` only on
   * turns written before the turn recorded it (read those as unknown).
   */
  readonly modelSelection: ModelSelection | null;
  /** Steer/restart chains reference the turn they superseded. */
  readonly parentTurnId: string | null;
  /**
   * A queued turn that waits for this instant before it may run — a message
   * scheduled for later, or a continue set for when a usage limit resets.
   * Absent on turns that run as soon as the thread is free.
   */
  readonly scheduledFor?: string | null;
  /**
   * Why it was scheduled: the user's own choice; a continue set for when a
   * usage limit resets; or `usage-hold` — a message the user queued that
   * came up while a limit still stood, held for the reset rather than sent
   * into the wall.
   */
  readonly scheduleReason?: "user" | "usage-reset" | "usage-hold" | null;
  /** For an automatic continue after a usage limit: which attempt in a row (1-based). */
  readonly continueAttempt?: number;
  /**
   * The prompt's origin, as on its message: absent for the user's own sends.
   * Recorded on the turn so admission can tell an automatic turn from a user
   * turn without reading the message ledger. Absent on turns written before
   * it existed.
   */
  readonly origin?: MessageOrigin;
  /** The primary prompt came from the internal usage-recovery producer, not scheduling metadata. */
  readonly usageRecoveryNotice?: true;
  readonly error: string | null;
  /**
   * The turn was the first the provider's conversation was given and it ended with no output (a usage limit).
   * The provider never read its prompt, so the next turn on that conversation sends it again.
   */
  readonly unanswered?: true;
  /** Tokens spent by the provider run; null when the driver reported none. */
  readonly usage: TurnUsage | null;
  /** Per-turn output when usage itself is a provider session total. */
  readonly turnOutputTokens?: number;
  /** Observed generated text and its streaming time, excluding tool execution. */
  readonly generation?: { readonly characters: number; readonly durationMs: number };
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When a queued or scheduled turn actually started; a turn that ran at once started at `createdAt`. */
  readonly startedAt?: string;
  readonly completedAt: string | null;
  /**
   * The process expected to run the turn, set when it becomes `running`.
   * A running turn whose owner has died is orphaned — nothing will ever
   * settle it — and is interrupted the next time the thread is touched
   * (`reconcileOrphanedTurn`). Absent on turns written before it existed.
   */
  readonly owner?: TurnOwner | null;
}

export interface TurnOwner {
  readonly pid: number;
  readonly host: string;
}

/** Token totals per turn (mirrors the provider SPI delta, kept local to avoid layer tangles). */
export interface TurnUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly output: number;
  readonly thinking: number;
  /** What the turn cost in USD when the provider says (an estimate, not a bill); absent when it reports none. */
  readonly costUsd?: number;
}

export type MessageRole = "user" | "assistant" | "system";

/** An image sent with a user message, saved under the store root. */
export interface StoredAttachment {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Absolute path of the saved bytes. */
  readonly path: string;
}

export interface StoredMessage {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments?: readonly StoredAttachment[];
  /** A message moxen wrote into the thread rather than the user (see `MessageOrigin`). */
  readonly origin?: MessageOrigin;
  /** The origin's structured facts (`task-notification`: the tasks), for a client to draw. */
  readonly notification?: { readonly tasks: readonly TaskNotification[] };
  /** Filed as a turn prompt, even if later folded into another queued turn. */
  readonly queuedTaskNotice?: true;
}

/** Internal inputs: task results, usage reset continuations, answer-panel replies, a message from the thread that delegated the task, and Moxen's own compaction prompts. `agent-message` is one an agent queued with `message_queue`, for itself or a task it delegated. */
export type MessageOrigin = "task-notification" | "background-notification" | "usage-continue" | "usage-protection" | "handoff-summary" | "compaction" | "question-answer" | "task-message" | "agent-message";

export interface StoredActivity {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly summary: string;
  /**
   * Structured detail for rows that have any — tool calls carry the
   * renderer's payload shape (`itemType`, `data.tool`, `data.state.input`,
   * …; see `toolactivity.ts`). Lifecycle rows carry none.
   */
  readonly payload?: Record<string, unknown> | undefined;
  readonly createdAt: string;
}

export interface StoredCheckpoint {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string;
  /** `available` when both pre/post worktree captures exist; else `unavailable`. */
  readonly status: string;
  /** Post-turn capture sha (diff head). */
  readonly ref: string | null;
  /** Pre-turn capture sha (diff base). */
  readonly baseRef: string | null;
  /**
   * What the turn changed, per file, recorded as it settles. Absent on rows
   * written before it was recorded (clients get it backfilled on read).
   */
  readonly files?: ReadonlyArray<CheckpointFileStat>;
  readonly createdAt: string;
}

export interface CheckpointFileStat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export type DelegationStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "waitTimedOut";

export interface StoredDelegation {
  readonly id: string;
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly prompt: string;
  /** The branch the child's own worktree was cut from; absent when it shares the parent's checkout. */
  readonly baseBranch?: string | null;
  /** The parent is told when the task settles for good, however many turns that takes (a usage-limit pause and its resume included). */
  readonly notify?: boolean;
  /** The thread this task continued in after a handoff; the parent hears from that thread, not this one. */
  readonly continuedIn?: string;
  /** The task id the parent first knew, when this row is a handoff's continuation. */
  readonly continuesTaskId?: string;
  /** The client's idempotency key for this delegation, when it passed one: a retry with the same key returns this row's task. */
  readonly idempotencyKey?: string;
  /**
   * `instance/model` on each side when the task started. The review
   * same-model check reads this, not the live records, so a parent that
   * moves on or changes model cannot rewrite who the reviewer shared a
   * model with. Absent on rows written before it existed.
   */
  readonly modelSnapshot?: { readonly parent?: string; readonly child?: string };
  /**
   * A settled review task's pinned outcome: the verdict and report of its
   * last settled turn. A follow-up turn that settles re-pins. Read paths
   * prefer this over the latest assistant text, so a conversational
   * follow-up cannot rewrite the settled verdict. Absent until the task
   * settles, and on rows written before it existed.
   */
  readonly review?: { readonly verdict: ReviewVerdict | null; readonly report: string | null };
  readonly status: DelegationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateThreadInput {
  /** Client-generated id (the TUI opens the thread before the store confirms); generated when omitted. */
  readonly id?: string;
  readonly hidden?: boolean;
  readonly projectId: string;
  readonly title: string;
  /** `user` for a title someone chose, which the provider's own title then leaves alone. */
  readonly titleSource?: ThreadTitleSource;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
  readonly env?: Partial<ThreadEnv>;
  readonly researchRun?: StoredResearchRun;
  readonly researchRole?: StoredThread["researchRole"];
  readonly continuedFrom?: string;
  /** The hand-off facts the new thread carries (see `HandoffFacts`); only the continue path passes them. */
  readonly handoffFacts?: HandoffFacts;
}

export type SendIfBusy = "reject" | "inject";
export type SendDelivery = "auto" | "steer" | "restart" | "queue";

export interface SendTurnInput {
  readonly queue?: QueuePolicy;
  /** Internal coordinator input; never accepted from the client protocol. */
  readonly usageControl?: boolean;
  /** The agent thread that queued this message with `message_queue`; only it may list or change the entry (MXN-401). */
  readonly agentThreadId?: string;
  readonly prompt: string;
  readonly ifBusy?: SendIfBusy;
  readonly delivery?: SendDelivery;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
  readonly modelSelection?: ModelSelection;
  /** Settled threads require an explicit wake before they accept turns. */
  readonly wakeSettled?: boolean;
  readonly handoffNote?: string;
  /** Images sent with the prompt; saved and recorded on the user message. */
  readonly attachments?: readonly ImageAttachmentUpload[];
  /**
   * Hold the message until this instant: it is queued, and runs once it is
   * due and the thread is free. A time already past means "now".
   */
  readonly scheduledFor?: string;
  readonly scheduleReason?: "user" | "usage-reset";
  /** Set by the automatic continue after a usage limit (which attempt in a row). */
  readonly continueAttempt?: number;
  /** A message moxen writes itself (with its facts), rather than the user. */
  readonly origin?: MessageOrigin;
  readonly notification?: { readonly tasks: readonly TaskNotification[] };
  /** Internal: the prompt is the generated hand-off that opens a continued thread, recorded as its provenance. */
  readonly handoffOpen?: true;
  /** Internal: the pending request message ids this hand-off opener carries as its task (see `StoredTurn.handoffPending`). */
  readonly handoffPending?: readonly string[];
}

export type ReadView = "messages" | "turn-items" | "plans" | "checkpoints" | "transfers";

export interface ThreadReadResult {
  readonly thread: StoredThread;
  readonly turns: StoredTurn[];
  readonly messages: StoredMessage[];
  readonly activities: StoredActivity[];
  readonly checkpoints: StoredCheckpoint[];
}

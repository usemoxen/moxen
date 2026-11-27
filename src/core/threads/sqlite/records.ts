/**
 * The one place a store record becomes a SQLite row and back (MXN-392).
 *
 * Columns hold what the code filters, sorts or patches on its own; everything
 * else is in `rest` as JSON and merged back here, so no caller has to know
 * which field went where.
 *
 * Exact scalar keys: `encodeScalar`/`decodeScalar` are one reversible TEXT
 * codec. A well-formed string that does not start with `~` is stored verbatim;
 * a string that starts with `~`, or contains a lone surrogate, is stored as
 * `~` plus four lowercase hex digits per UTF-16 code unit. SQL NULL stays NULL.
 * The reserved prefix makes the two forms collision-free. Any SQL predicate on
 * an encoded column binds `encodeScalar(value)`, never the raw value. Applied
 * to delegation `idempotency_key`/`base_branch`, thread `project_id`,
 * `model_instance`/`model_id`/`env_path`/`env_branch`, and turn
 * `queue_request_id`/`owner_host`, plus message ids (`messages.id` and the
 * `turns.message_id` that references them — provider ids are concatenated into
 * them by `noteMessageId`). Generated UUID ids and validated thread ids,
 * enums, ISO timestamps and JSON columns stay verbatim.
 *
 * Exact display text: title, message text, activity summary and delegation
 * prompt are stored well-formed for display, and the original string is kept
 * when the projection differs — `rest.originalText` for threads and
 * delegations, and the `original_text` / `original_summary` JSON-string columns
 * for messages and activities. Decode prefers the original, so a lone
 * surrogate from a code-unit slice survives exactly. Activity payloads are
 * untouched.
 *
 * Canonicalizations, all deliberate and pinned by `tests/records.test.ts`:
 * - `hidden: false`, `heldAtSettle: false` and `notify: false` decode as
 *   absent. Readers test `=== true` or truthiness, never `=== false`.
 * - `titleSource: "seed"` decodes as absent. Absent already reads as the seed
 *   title source, and readers compare against `"user"`/`"provider"`.
 * - An explicit `null` for `scheduledFor`, `scheduleReason`, `owner` or
 *   `baseBranch` decodes as absent. Every reader uses truthiness or optional
 *   chaining on them, so both forms mean the same thing; only `owner: null`
 *   is written today (clearing an owner).
 *
 * `usagePause` is the exception: it is a JSON column, so absent (SQL NULL) and
 * an explicit `null` (the JSON text `null`) stay distinct.
 *
 * Nothing inserts through these yet: the importer and readers land next (see
 * docs/sqlite-store.md).
 */
import { CliError } from "../../errors.js";
import type { InteractionMode, ModelSelection, RuntimeMode } from "../../types.js";
import type {
  StoredActivity,
  StoredAttachment,
  StoredCheckpoint,
  StoredDelegation,
  StoredMessage,
  StoredThread,
  StoredTurn,
} from "../types.js";

const utf8 = new TextEncoder();
const text = new TextDecoder();

export interface ThreadRow {
  id: string;
  project_id: string;
  title: string;
  title_source: string;
  hidden: number;
  interaction_mode: string;
  runtime_mode: string;
  model_instance: string;
  model_id: string;
  env_mode: string;
  env_path: string;
  env_branch: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  settled_at: string | null;
  settled_override: string | null;
  snoozed_until: string | null;
  snoozed_at: string | null;
  has_pending_approvals: number;
  has_pending_user_input: number;
  continued_from: string | null;
  usage_pause: string | null;
  rest: string;
}

export interface TurnRow {
  id: string;
  thread_id: string;
  message_id: string;
  status: string;
  delivery: string;
  scheduled_for: string | null;
  schedule_reason: string | null;
  held_at_settle: number;
  continue_attempt: number | null;
  queue_order: number | null;
  queue_removed: number | null;
  queue_automatic: number | null;
  queue_wake_up: number | null;
  queue_request_id: string | null;
  handoff_destination: string | null;
  owner_pid: number | null;
  owner_host: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  rest: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string;
  role: string;
  origin: string | null;
  created_at: string;
  text: string;
  /** JSON string of the original when the display projection differs; NULL otherwise. */
  original_text: string | null;
  attachments: string | null;
  notification: string | null;
  /** Moxen's own dispatch, not the user's (MXN-385); NULL on rows written before the flag. */
  automatic: number | null;
  /** A provider control command (MXN-385); NULL on rows written before the flag. */
  control: number | null;
}

export interface ActivityRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  kind: string;
  summary: string;
  /** JSON string of the original when the display projection differs; NULL otherwise. */
  original_summary: string | null;
  created_at: string;
  payload: Uint8Array | null;
  payload_encoding: string;
}

export interface CheckpointRow {
  id: string;
  thread_id: string;
  turn_id: string;
  status: string;
  ref: string | null;
  base_ref: string | null;
  created_at: string;
  files: string | null;
}

export interface DelegationRow {
  id: string;
  parent_thread_id: string;
  child_thread_id: string;
  status: string;
  notify: number;
  continued_in: string | null;
  continues_task_id: string | null;
  idempotency_key: string | null;
  base_branch: string | null;
  prompt: string;
  created_at: string;
  updated_at: string;
  rest: string;
}

/** JSON text, or SQL NULL for an absent value. `null` itself stays the JSON value `null`. */
function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

function flag(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/**
 * A string SQLite can store as UTF-8: each lone surrogate becomes U+FFFD.
 * Model output sliced by code unit (a summary cut at 120 characters can split
 * an emoji) can carry one; JSONL escaped it and kept it, SQLite cannot.
 */
function wellFormed(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]! + value[i + 1]!;
        i += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += value[i]!;
    }
  }
  return out;
}

/**
 * The reversible scalar codec (see the file header). A well-formed value
 * without the reserved prefix is stored as written; anything else becomes
 * `~` plus four lowercase hex digits per UTF-16 code unit.
 */
export function encodeScalar(value: string): string {
  if (!value.startsWith("~") && wellFormed(value) === value) return value;
  let out = "~";
  for (let i = 0; i < value.length; i += 1) out += value.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
}

/** The inverse of `encodeScalar`; a malformed encoded value is a corrupt row. */
export function decodeScalar(value: string): string {
  if (!value.startsWith("~")) return value;
  const hex = value.slice(1);
  if (hex.length % 4 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new CliError("INVALID_STORE_ROW", `A stored value is not a valid encoded scalar: ${JSON.stringify(value.slice(0, 32))}.`);
  }
  let out = "";
  for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return out;
}

function encodeNullableScalar(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : encodeScalar(value);
}

function decodeNullableScalar(value: string | null): string | null {
  return value === null ? null : decodeScalar(value);
}

function required(value: string | null, column: string, row: string): string {
  if (value === null) throw new CliError("INVALID_STORE_ROW", `A ${row} row is missing ${column}; the row cannot be read.`);
  return value;
}

function requiredNumber(value: number | null, column: string, row: string): number {
  if (value === null) throw new CliError("INVALID_STORE_ROW", `A ${row} row is missing ${column}; the row cannot be read.`);
  return value;
}

export function encodeThread(thread: StoredThread): ThreadRow {
  const rest: Record<string, unknown> = {};
  const title = wellFormed(thread.title);
  if (title !== thread.title) rest.originalText = thread.title;
  if (thread.researchRun !== undefined) rest.researchRun = thread.researchRun;
  if (thread.pastResearchRuns !== undefined) rest.pastResearchRuns = thread.pastResearchRuns;
  if (thread.researchRole !== undefined) rest.researchRole = thread.researchRole;
  if (thread.researchPicker !== undefined) rest.researchPicker = thread.researchPicker;
  if (thread.continueClaim !== undefined) rest.continueClaim = thread.continueClaim;
  if (thread.adoptingFrom !== undefined) rest.adoptingFrom = thread.adoptingFrom;
  if (thread.pendingContinuation !== undefined) rest.pendingContinuation = thread.pendingContinuation;
  if (thread.handoffFacts !== undefined) rest.handoffFacts = thread.handoffFacts;
  if (thread.usageNotices !== undefined) rest.usageNotices = thread.usageNotices;
  if (thread.usageProtectionOverride !== undefined) rest.usageProtectionOverride = thread.usageProtectionOverride;
  if (thread.providerSessions !== undefined) rest.providerSessions = thread.providerSessions;
  if (thread.instructionState !== undefined) rest.instructionState = thread.instructionState;
  if (thread.modeState !== undefined) rest.modeState = thread.modeState;
  if (thread.nativeSubagents !== undefined) rest.nativeSubagents = thread.nativeSubagents;
  if (thread.turnSeq !== undefined) rest.turnSeq = thread.turnSeq;
  if (thread.snoozeConditions !== undefined) rest.snoozeConditions = thread.snoozeConditions;
  if (thread.snoozeLatched !== undefined) rest.snoozeLatched = thread.snoozeLatched;
  if (thread.snoozeGeneration !== undefined) rest.snoozeGeneration = thread.snoozeGeneration;
  // Required on the record, but a thread written before versions may carry no
  // value: keep the key so the record reads back the way it was written.
  rest.unsettledAt = thread.unsettledAt ?? null;
  if (thread.modelSelection.options !== undefined) rest.modelSelection = { options: thread.modelSelection.options };

  return {
    id: thread.id,
    project_id: encodeScalar(thread.projectId),
    title,
    title_source: thread.titleSource ?? "seed",
    hidden: thread.hidden === true ? 1 : 0,
    interaction_mode: thread.interactionMode,
    runtime_mode: thread.runtimeMode,
    model_instance: encodeScalar(thread.modelSelection.instanceId),
    model_id: encodeScalar(thread.modelSelection.model),
    env_mode: thread.env.mode,
    env_path: encodeScalar(thread.env.path),
    env_branch: encodeNullableScalar(thread.env.branch),
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    archived_at: thread.archivedAt,
    deleted_at: thread.deletedAt,
    settled_at: thread.settledAt,
    settled_override: thread.settledOverride,
    snoozed_until: thread.snoozedUntil,
    snoozed_at: thread.snoozedAt,
    has_pending_approvals: thread.hasPendingApprovals ? 1 : 0,
    has_pending_user_input: thread.hasPendingUserInput ? 1 : 0,
    continued_from: thread.continuedFrom ?? null,
    usage_pause: jsonText(thread.usagePause),
    rest: JSON.stringify(rest),
  };
}

export function decodeThread(row: ThreadRow): StoredThread {
  const rest = JSON.parse(row.rest) as Record<string, unknown>;
  const options = (rest.modelSelection as { options?: ModelSelection["options"] } | undefined)?.options;
  return {
    id: row.id,
    projectId: decodeScalar(row.project_id),
    title: typeof rest.originalText === "string" ? rest.originalText : row.title,
    ...(row.title_source === "seed" ? {} : { titleSource: row.title_source as NonNullable<StoredThread["titleSource"]> }),
    ...(row.hidden === 0 ? {} : { hidden: true }),
    modelSelection:
      options === undefined
        ? { instanceId: decodeScalar(row.model_instance), model: decodeScalar(row.model_id) }
        : { instanceId: decodeScalar(row.model_instance), model: decodeScalar(row.model_id), options },
    runtimeMode: row.runtime_mode as RuntimeMode,
    interactionMode: row.interaction_mode as InteractionMode,
    env: { mode: row.env_mode as StoredThread["env"]["mode"], path: decodeScalar(row.env_path), branch: decodeNullableScalar(row.env_branch) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    settledAt: row.settled_at,
    unsettledAt: (rest.unsettledAt ?? null) as string | null,
    settledOverride: row.settled_override as StoredThread["settledOverride"],
    snoozedUntil: row.snoozed_until,
    snoozedAt: row.snoozed_at,
    hasPendingApprovals: row.has_pending_approvals !== 0,
    hasPendingUserInput: row.has_pending_user_input !== 0,
    ...(row.continued_from === null ? {} : { continuedFrom: row.continued_from }),
    ...(row.usage_pause === null ? {} : { usagePause: JSON.parse(row.usage_pause) as Exclude<StoredThread["usagePause"], undefined> }),
    ...(rest.researchRun === undefined ? {} : { researchRun: rest.researchRun as NonNullable<StoredThread["researchRun"]> }),
    ...(rest.pastResearchRuns === undefined ? {} : { pastResearchRuns: rest.pastResearchRuns as NonNullable<StoredThread["pastResearchRuns"]> }),
    ...(rest.researchRole === undefined ? {} : { researchRole: rest.researchRole as NonNullable<StoredThread["researchRole"]> }),
    ...(rest.researchPicker === undefined ? {} : { researchPicker: rest.researchPicker as NonNullable<StoredThread["researchPicker"]> }),
    ...(rest.continueClaim === undefined ? {} : { continueClaim: rest.continueClaim as NonNullable<StoredThread["continueClaim"]> }),
    ...(rest.adoptingFrom === undefined ? {} : { adoptingFrom: rest.adoptingFrom as Exclude<StoredThread["adoptingFrom"], undefined> }),
    ...(rest.pendingContinuation === undefined ? {} : { pendingContinuation: rest.pendingContinuation as NonNullable<StoredThread["pendingContinuation"]> }),
    ...(rest.handoffFacts === undefined ? {} : { handoffFacts: rest.handoffFacts as NonNullable<StoredThread["handoffFacts"]> }),
    ...(rest.usageNotices === undefined ? {} : { usageNotices: rest.usageNotices as NonNullable<StoredThread["usageNotices"]> }),
    ...(rest.usageProtectionOverride === undefined ? {} : { usageProtectionOverride: rest.usageProtectionOverride as NonNullable<StoredThread["usageProtectionOverride"]> }),
    ...(rest.providerSessions === undefined ? {} : { providerSessions: rest.providerSessions as NonNullable<StoredThread["providerSessions"]> }),
    ...(rest.instructionState === undefined ? {} : { instructionState: rest.instructionState as NonNullable<StoredThread["instructionState"]> }),
    ...(rest.modeState === undefined ? {} : { modeState: rest.modeState as NonNullable<StoredThread["modeState"]> }),
    ...(rest.nativeSubagents === undefined ? {} : { nativeSubagents: rest.nativeSubagents as NonNullable<StoredThread["nativeSubagents"]> }),
    ...(rest.turnSeq === undefined ? {} : { turnSeq: rest.turnSeq as number }),
    ...(rest.snoozeConditions === undefined ? {} : { snoozeConditions: rest.snoozeConditions as NonNullable<StoredThread["snoozeConditions"]> }),
    ...(rest.snoozeLatched === undefined ? {} : { snoozeLatched: rest.snoozeLatched as NonNullable<StoredThread["snoozeLatched"]> }),
    ...(rest.snoozeGeneration === undefined ? {} : { snoozeGeneration: rest.snoozeGeneration as string }),
  };
}

export function encodeTurn(turn: StoredTurn): TurnRow {
  const rest: Record<string, unknown> = {
    runtimeMode: turn.runtimeMode,
    interactionMode: turn.interactionMode,
    modelSelection: turn.modelSelection,
    parentTurnId: turn.parentTurnId,
    error: turn.error,
    usage: turn.usage,
  };
  if (turn.queue !== undefined) {
    const { order: _order, removed: _removed, automatic: _automatic, wakeUp: _wakeUp, requestId: _requestId, ...queue } = turn.queue;
    rest.queue = queue;
  }
  if (turn.handoff !== undefined) {
    const { destinationThreadId: _destination, ...handoff } = turn.handoff;
    rest.handoff = handoff;
  }
  if (turn.usagePause !== undefined) rest.usagePause = turn.usagePause;
  if (turn.handoffOpen !== undefined) rest.handoffOpen = turn.handoffOpen;
  if (turn.handoffPending !== undefined) rest.handoffPending = turn.handoffPending;
  if (turn.handoffFailed === true) rest.handoffFailed = true;
  if (turn.interactionModeExplicit !== undefined) rest.interactionModeExplicit = turn.interactionModeExplicit;
  if (turn.usageRecoveryNotice === true) rest.usageRecoveryNotice = true;
  if (turn.unanswered !== undefined) rest.unanswered = turn.unanswered;
  if (turn.generation !== undefined) rest.generation = turn.generation;
  if (turn.turnOutputTokens !== undefined) rest.turnOutputTokens = turn.turnOutputTokens;
  if (turn.startedAt !== undefined) rest.startedAt = turn.startedAt;
  if (turn.executionSeq !== undefined) rest.executionSeq = turn.executionSeq;
  if (turn.heldBySnooze !== undefined) rest.heldBySnooze = turn.heldBySnooze;
  if (turn.agentThreadId !== undefined) rest.agentThreadId = turn.agentThreadId;
  if (turn.automatic !== undefined) rest.automatic = turn.automatic;
  if (turn.consent !== undefined) rest.consent = turn.consent;
  if (turn.control !== undefined) rest.control = turn.control;
  if (turn.reviewHandoff === true) rest.reviewHandoff = true;
  if (turn.reviewDecision !== undefined) rest.reviewDecision = turn.reviewDecision;
  if (turn.parentNotice === true) rest.parentNotice = true;

  return {
    id: turn.id,
    thread_id: turn.threadId,
    message_id: encodeScalar(turn.messageId),
    status: turn.status,
    delivery: turn.delivery,
    scheduled_for: turn.scheduledFor ?? null,
    schedule_reason: turn.scheduleReason ?? null,
    held_at_settle: turn.heldAtSettle === true ? 1 : 0,
    continue_attempt: turn.continueAttempt ?? null,
    queue_order: turn.queue?.order ?? null,
    queue_removed: flag(turn.queue?.removed),
    queue_automatic: flag(turn.queue?.automatic),
    queue_wake_up: flag(turn.queue?.wakeUp),
    queue_request_id: encodeNullableScalar(turn.queue?.requestId),
    handoff_destination: turn.handoff?.destinationThreadId ?? null,
    owner_pid: turn.owner?.pid ?? null,
    owner_host: encodeNullableScalar(turn.owner?.host),
    created_at: turn.createdAt,
    updated_at: turn.updatedAt,
    completed_at: turn.completedAt,
    rest: JSON.stringify(rest),
  };
}

function turnQueue(row: TurnRow, rest: Record<string, unknown>): NonNullable<StoredTurn["queue"]> | undefined {
  const queue = rest.queue as NonNullable<StoredTurn["queue"]> | undefined;
  if (queue === undefined) return undefined;
  return {
    ...queue,
    order: requiredNumber(row.queue_order, "queue_order", "turns"),
    ...(row.queue_removed === null ? {} : { removed: row.queue_removed !== 0 }),
    ...(row.queue_automatic === null ? {} : { automatic: row.queue_automatic !== 0 }),
    ...(row.queue_wake_up === null ? {} : { wakeUp: row.queue_wake_up !== 0 }),
    ...(row.queue_request_id === null ? {} : { requestId: decodeScalar(row.queue_request_id) }),
  };
}

export function decodeTurn(row: TurnRow): StoredTurn {
  const rest = JSON.parse(row.rest) as Record<string, unknown>;
  const handoff = rest.handoff as Omit<NonNullable<StoredTurn["handoff"]>, "destinationThreadId"> | undefined;
  const queue = turnQueue(row, rest);
  const ownerPresent = row.owner_pid !== null || row.owner_host !== null;
  if (ownerPresent && (row.owner_pid === null || row.owner_host === null)) {
    throw new CliError("INVALID_STORE_ROW", "A turns row has half an owner (pid or host missing); the row cannot be read.");
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: decodeScalar(row.message_id),
    status: row.status as StoredTurn["status"],
    delivery: row.delivery as StoredTurn["delivery"],
    ...(row.scheduled_for === null ? {} : { scheduledFor: row.scheduled_for }),
    ...(row.schedule_reason === null ? {} : { scheduleReason: row.schedule_reason as NonNullable<StoredTurn["scheduleReason"]> }),
    ...(row.held_at_settle === 0 ? {} : { heldAtSettle: true }),
    ...(row.continue_attempt === null ? {} : { continueAttempt: row.continue_attempt }),
    ...(queue === undefined ? {} : { queue }),
    ...(handoff === undefined
      ? {}
      : { handoff: { ...handoff, destinationThreadId: required(row.handoff_destination, "handoff_destination", "turns") } }),
    ...(ownerPresent ? { owner: { pid: row.owner_pid as number, host: decodeScalar(row.owner_host as string) } } : {}),
    runtimeMode: rest.runtimeMode as RuntimeMode,
    interactionMode: rest.interactionMode as InteractionMode,
    ...(rest.interactionModeExplicit === undefined ? {} : { interactionModeExplicit: true as const }),
    ...(rest.heldBySnooze === undefined ? {} : { heldBySnooze: true }),
    ...(rest.automatic === undefined ? {} : { automatic: rest.automatic as boolean }),
    // Anything but a recorded fresh submission reads as replayed: an
    // unreadable value must never widen consent (LOCAL-023).
    ...(rest.consent === undefined ? {} : { consent: rest.consent === "fresh" ? "fresh" as const : "replayed" as const }),
    ...(rest.control === undefined ? {} : { control: rest.control as boolean }),
    modelSelection: (rest.modelSelection ?? null) as ModelSelection | null,
    parentTurnId: (rest.parentTurnId ?? null) as string | null,
    error: (rest.error ?? null) as string | null,
    usage: (rest.usage ?? null) as StoredTurn["usage"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    ...(rest.startedAt === undefined ? {} : { startedAt: rest.startedAt as string }),
    ...(rest.agentThreadId === undefined ? {} : { agentThreadId: rest.agentThreadId as string }),
    ...(rest.executionSeq === undefined ? {} : { executionSeq: rest.executionSeq as number }),
    ...(rest.usagePause === undefined ? {} : { usagePause: rest.usagePause as NonNullable<StoredTurn["usagePause"]> }),
    ...(rest.handoffOpen === undefined ? {} : { handoffOpen: true as const }),
    ...(rest.handoffPending === undefined ? {} : { handoffPending: rest.handoffPending as readonly string[] }),
    ...(rest.handoffFailed === true ? { handoffFailed: true as const } : {}),
    ...(rest.usageRecoveryNotice === true ? { usageRecoveryNotice: true as const } : {}),
    ...(rest.unanswered === undefined ? {} : { unanswered: true as const }),
    ...(rest.generation === undefined ? {} : { generation: rest.generation as NonNullable<StoredTurn["generation"]> }),
    ...(rest.turnOutputTokens === undefined ? {} : { turnOutputTokens: rest.turnOutputTokens as number }),
    ...(rest.reviewHandoff === true ? { reviewHandoff: true as const } : {}),
    ...(rest.reviewDecision === undefined ? {} : { reviewDecision: rest.reviewDecision as NonNullable<StoredTurn["reviewDecision"]> }),
    ...(rest.parentNotice === true ? { parentNotice: true as const } : {}),
  };
}

export function encodeMessage(message: StoredMessage): MessageRow {
  const body = wellFormed(message.text);
  return {
    id: encodeScalar(message.id),
    thread_id: message.threadId,
    turn_id: message.turnId,
    role: message.role,
    origin: message.origin ?? null,
    created_at: message.createdAt,
    text: body,
    original_text: body === message.text ? null : JSON.stringify(message.text),
    attachments: jsonText(message.attachments),
    notification: jsonText(message.notification),
    automatic: flag(message.automatic),
    control: flag(message.control),
  };
}

export function decodeMessage(row: MessageRow): StoredMessage {
  const attachments = parseJson<StoredAttachment[]>(row.attachments);
  const notification = parseJson<NonNullable<StoredMessage["notification"]>>(row.notification);
  return {
    id: decodeScalar(row.id),
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role as StoredMessage["role"],
    createdAt: row.created_at,
    text: row.original_text === null ? row.text : (JSON.parse(row.original_text) as string),
    ...(row.origin === null ? {} : { origin: row.origin as NonNullable<StoredMessage["origin"]> }),
    ...(attachments === undefined || attachments === null ? {} : { attachments }),
    ...(notification === undefined || notification === null ? {} : { notification }),
    ...(row.automatic === null || row.automatic === undefined ? {} : { automatic: row.automatic !== 0 }),
    ...(row.control === null || row.control === undefined ? {} : { control: row.control !== 0 }),
  };
}

export function encodeActivity(activity: StoredActivity): ActivityRow {
  const body = wellFormed(activity.summary);
  return {
    id: activity.id,
    thread_id: activity.threadId,
    turn_id: activity.turnId,
    kind: activity.kind,
    summary: body,
    original_summary: body === activity.summary ? null : JSON.stringify(activity.summary),
    created_at: activity.createdAt,
    payload: activity.payload === undefined ? null : utf8.encode(JSON.stringify(activity.payload)),
    payload_encoding: "json",
  };
}

export function decodeActivity(row: ActivityRow): StoredActivity {
  if (row.payload !== null && row.payload_encoding !== "json") {
    throw new CliError("UNKNOWN_PAYLOAD_ENCODING", `An activities row is encoded as ${row.payload_encoding}; this build reads only json.`);
  }
  const payload = row.payload === null ? undefined : (JSON.parse(text.decode(row.payload)) as Record<string, unknown>);
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    kind: row.kind,
    summary: row.original_summary === null ? row.summary : (JSON.parse(row.original_summary) as string),
    createdAt: row.created_at,
    ...(payload === undefined ? {} : { payload }),
  };
}

export function encodeCheckpoint(checkpoint: StoredCheckpoint): CheckpointRow {
  return {
    id: checkpoint.id,
    thread_id: checkpoint.threadId,
    turn_id: checkpoint.turnId,
    status: checkpoint.status,
    ref: checkpoint.ref,
    base_ref: checkpoint.baseRef,
    created_at: checkpoint.createdAt,
    files: jsonText(checkpoint.files),
  };
}

export function decodeCheckpoint(row: CheckpointRow): StoredCheckpoint {
  const files = parseJson<NonNullable<StoredCheckpoint["files"]>>(row.files);
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    status: row.status,
    ref: row.ref,
    baseRef: row.base_ref,
    createdAt: row.created_at,
    ...(files === undefined || files === null ? {} : { files }),
  };
}

export function encodeDelegation(delegation: StoredDelegation): DelegationRow {
  const rest: Record<string, unknown> = {};
  const prompt = wellFormed(delegation.prompt);
  if (prompt !== delegation.prompt) rest.originalText = delegation.prompt;
  if (delegation.modelSnapshot !== undefined) rest.modelSnapshot = delegation.modelSnapshot;
  if (delegation.review !== undefined) rest.review = delegation.review;
  if (delegation.cancelledTurnId !== undefined) rest.cancelledTurnId = delegation.cancelledTurnId;
  if (delegation.cancelledAfterSeq !== undefined) rest.cancelledAfterSeq = delegation.cancelledAfterSeq;
  if (delegation.cancelledGeneration !== undefined) rest.cancelledGeneration = delegation.cancelledGeneration;
  if (delegation.lastSettledTurnId !== undefined) rest.lastSettledTurnId = delegation.lastSettledTurnId;
  if (delegation.lastSettledSeq !== undefined) rest.lastSettledSeq = delegation.lastSettledSeq;
  if (delegation.reviewTask === true) rest.reviewTask = true;
  if (delegation.settleGeneration !== undefined) rest.settleGeneration = delegation.settleGeneration;
  if (delegation.reportedGeneration !== undefined) rest.reportedGeneration = delegation.reportedGeneration;
  return {
    id: delegation.id,
    parent_thread_id: delegation.parentThreadId,
    child_thread_id: delegation.childThreadId,
    status: delegation.status,
    notify: delegation.notify === true ? 1 : 0,
    continued_in: delegation.continuedIn ?? null,
    continues_task_id: delegation.continuesTaskId ?? null,
    idempotency_key: encodeNullableScalar(delegation.idempotencyKey),
    base_branch: encodeNullableScalar(delegation.baseBranch),
    prompt,
    created_at: delegation.createdAt,
    updated_at: delegation.updatedAt,
    rest: JSON.stringify(rest),
  };
}

export function decodeDelegation(row: DelegationRow): StoredDelegation {
  const rest = JSON.parse(row.rest) as Record<string, unknown>;
  return {
    id: row.id,
    parentThreadId: row.parent_thread_id,
    childThreadId: row.child_thread_id,
    prompt: typeof rest.originalText === "string" ? rest.originalText : row.prompt,
    ...(row.base_branch === null ? {} : { baseBranch: decodeScalar(row.base_branch) }),
    status: row.status as StoredDelegation["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.notify === 0 ? {} : { notify: true }),
    ...(row.continued_in === null ? {} : { continuedIn: row.continued_in }),
    ...(row.continues_task_id === null ? {} : { continuesTaskId: row.continues_task_id }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: decodeScalar(row.idempotency_key) }),
    ...(rest.modelSnapshot === undefined ? {} : { modelSnapshot: rest.modelSnapshot as NonNullable<StoredDelegation["modelSnapshot"]> }),
    ...(rest.review === undefined ? {} : { review: rest.review as NonNullable<StoredDelegation["review"]> }),
    ...(rest.cancelledTurnId === undefined ? {} : { cancelledTurnId: rest.cancelledTurnId as string }),
    ...(rest.cancelledAfterSeq === undefined ? {} : { cancelledAfterSeq: rest.cancelledAfterSeq as number }),
    ...(rest.cancelledGeneration === undefined ? {} : { cancelledGeneration: rest.cancelledGeneration as number }),
    ...(rest.lastSettledTurnId === undefined ? {} : { lastSettledTurnId: rest.lastSettledTurnId as string }),
    ...(rest.lastSettledSeq === undefined ? {} : { lastSettledSeq: rest.lastSettledSeq as number }),
    ...(rest.reviewTask === true ? { reviewTask: true as const } : {}),
    ...(typeof rest.settleGeneration === "number" && Number.isSafeInteger(rest.settleGeneration) && rest.settleGeneration >= 0
      ? { settleGeneration: rest.settleGeneration }
      : {}),
    ...(typeof rest.reportedGeneration === "number" && Number.isSafeInteger(rest.reportedGeneration) && rest.reportedGeneration >= 0
      ? { reportedGeneration: rest.reportedGeneration }
      : {}),
  };
}

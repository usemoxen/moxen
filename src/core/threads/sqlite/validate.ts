/**
 * What the importer needs from a legacy record before it can become a row
 * (MXN-393). The JSONL readers accept any JSON object with an id; the SQLite
 * columns do not. STRICT alone would not catch a wrong type (it converts a
 * number into a TEXT column) and a missing named parameter binds NULL, so each
 * field a column or codec reads is checked here. A record that fails is
 * quarantined with the reason; nothing is defaulted or invented. Each check
 * returns why the record cannot be imported, or null when it can.
 */

type Rule = readonly [field: string, ok: (value: unknown) => boolean];

const isString = (value: unknown): boolean => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optional = (ok: (value: unknown) => boolean) => (value: unknown): boolean => value === undefined || ok(value);
const nullable = (ok: (value: unknown) => boolean) => (value: unknown): boolean => value === undefined || value === null || ok(value);
const isBoolean = (value: unknown): boolean => typeof value === "boolean";
const isInteger = (value: unknown): boolean => Number.isSafeInteger(value);

function required(fields: readonly string[], ok: (value: unknown) => boolean = isString): Rule[] {
  return fields.map((field) => [field, ok]);
}

/** The first field that breaks its rule, named as `missing x` or `invalid x`. */
function check(record: Record<string, unknown>, rules: readonly Rule[], prefix = ""): string | null {
  for (const [field, ok] of rules) {
    const value = record[field];
    if (!ok(value)) return `${value === undefined || value === null ? "missing" : "invalid"} ${prefix}${field}`;
  }
  return null;
}

/** A nested object that must be there, with its own rules. */
function nested(record: Record<string, unknown>, field: string, rules: readonly Rule[]): string | null {
  const value = record[field];
  if (!isObject(value)) return `${value === undefined || value === null ? "missing" : "invalid"} ${field}`;
  return check(value, rules, `${field}.`);
}

const THREAD_RULES: readonly Rule[] = [
  ...required(["id", "projectId", "title", "runtimeMode", "interactionMode", "createdAt", "updatedAt"]),
  ...["archivedAt", "deletedAt", "settledAt", "settledOverride", "snoozedUntil", "snoozedAt", "continuedFrom"].map(
    (field): Rule => [field, nullable(isString)],
  ),
  ["titleSource", optional(isString)],
  ["hidden", optional(isBoolean)],
  ["hasPendingApprovals", optional(isBoolean)],
  ["hasPendingUserInput", optional(isBoolean)],
];

export function threadProblem(record: Record<string, unknown>): string | null {
  return (
    nested(record, "modelSelection", required(["instanceId", "model"])) ??
    nested(record, "env", [...required(["mode", "path"]), ["branch", nullable(isString)]]) ??
    check(record, THREAD_RULES)
  );
}

const TURN_RULES: readonly Rule[] = [
  ...required(["id", "messageId", "status", "delivery", "createdAt", "updatedAt"]),
  ["completedAt", nullable(isString)],
  ["scheduledFor", nullable(isString)],
  ["scheduleReason", nullable(isString)],
  ["heldAtSettle", nullable(isBoolean)],
  ["continueAttempt", optional(isInteger)],
];

const QUEUE_RULES: readonly Rule[] = [
  ["order", (value) => typeof value === "number" && Number.isFinite(value)],
  ["removed", optional(isBoolean)],
  ["automatic", optional(isBoolean)],
  ["wakeUp", optional(isBoolean)],
  ["requestId", nullable(isString)],
];

export function turnProblem(record: Record<string, unknown>): string | null {
  return (
    check(record, TURN_RULES) ??
    (record.queue === undefined ? null : nested(record, "queue", QUEUE_RULES)) ??
    (record.handoff === undefined ? null : nested(record, "handoff", required(["destinationThreadId"]))) ??
    (record.owner === undefined || record.owner === null ? null : nested(record, "owner", [["pid", isInteger], ["host", isString]]))
  );
}

const MESSAGE_RULES: readonly Rule[] = [
  ...required(["id", "turnId", "role", "text", "createdAt"]),
  ["origin", nullable(isString)],
  ["attachments", nullable(Array.isArray)],
  ["notification", nullable(isObject)],
  ["automatic", optional(isBoolean)],
  ["control", optional(isBoolean)],
  ["queuedTaskNotice", optional(isBoolean)],
];

export function messageProblem(record: Record<string, unknown>): string | null {
  return check(record, MESSAGE_RULES);
}

const ACTIVITY_RULES: readonly Rule[] = [
  ...required(["id", "kind", "summary", "createdAt"]),
  ["turnId", nullable(isString)],
  ["payload", nullable(isObject)],
];

export function activityProblem(record: Record<string, unknown>): string | null {
  return check(record, ACTIVITY_RULES);
}

const CHECKPOINT_RULES: readonly Rule[] = [
  ...required(["id", "turnId", "status", "createdAt"]),
  ["ref", nullable(isString)],
  ["baseRef", nullable(isString)],
  ["files", nullable(Array.isArray)],
];

export function checkpointProblem(record: Record<string, unknown>): string | null {
  return check(record, CHECKPOINT_RULES);
}

const DELEGATION_RULES: readonly Rule[] = [
  ...required(["id", "parentThreadId", "childThreadId", "prompt", "status", "createdAt", "updatedAt"]),
  ["notify", optional(isBoolean)],
  ["continuedIn", nullable(isString)],
  ["continuesTaskId", nullable(isString)],
  ["idempotencyKey", nullable(isString)],
  ["baseBranch", nullable(isString)],
];

export function delegationProblem(record: Record<string, unknown>): string | null {
  return check(record, DELEGATION_RULES);
}

/**
 * SQLite thread store, schema version 1 (MXN-392).
 *
 * One row per record: the columns are the fields the code filters, sorts or
 * patches on its own; everything else lives in the row's `rest` JSON and is
 * merged back on read by `records.ts`. `STRICT` everywhere, so a wrong type is
 * refused at write time instead of surfacing in a client.
 *
 * Targets the SQLite that macOS 13 ships (3.39): no `jsonb`, no `timediff()`.
 * Columns that hold JSON are TEXT; activity `payload` is a BLOB so compressing
 * it later is a data change, not a schema change.
 *
 * The DDL is pinned by `tests/schema-golden.sql`: change it on purpose or not
 * at all. A schema change is a new migration, never an edit to this one — see
 * docs/sqlite-store.md.
 */
export const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- engine=sqlite, schema=1, import_state=complete|running, imported_at, source_rows

CREATE TABLE threads (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  title                  TEXT NOT NULL,
  title_source           TEXT NOT NULL DEFAULT 'seed',
  hidden                 INTEGER NOT NULL DEFAULT 0,
  interaction_mode       TEXT NOT NULL,
  runtime_mode           TEXT NOT NULL,
  model_instance         TEXT NOT NULL,   -- modelSelection.instanceId
  model_id               TEXT NOT NULL,   -- modelSelection.model
  env_mode               TEXT NOT NULL,
  env_path               TEXT NOT NULL,
  env_branch             TEXT,
  created_at             TEXT NOT NULL,   -- ISO-8601, sorts lexically
  updated_at             TEXT NOT NULL,
  archived_at            TEXT,
  deleted_at             TEXT,
  settled_at             TEXT,
  settled_override       TEXT,
  snoozed_until          TEXT,
  snoozed_at             TEXT,
  has_pending_approvals  INTEGER NOT NULL DEFAULT 0,
  has_pending_user_input INTEGER NOT NULL DEFAULT 0,
  continued_from         TEXT,
  usage_pause            TEXT,            -- JSON: read and rewritten on every send
  rest                   TEXT NOT NULL    -- JSON: researchRun, pastResearchRuns, researchRole, researchPicker,
                                         -- continueClaim, providerSessions, instructionState, modeState,
                                         -- nativeSubagents, unsettledAt, usageProtectionOverride,
                                         -- modelSelection.options
) STRICT;
CREATE INDEX threads_created ON threads(deleted_at, archived_at, hidden, created_at);
CREATE INDEX threads_project ON threads(project_id, created_at);

CREATE TABLE turns (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL,
  thread_id        TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  delivery         TEXT NOT NULL,
  scheduled_for    TEXT,
  schedule_reason  TEXT,
  held_at_settle   INTEGER NOT NULL DEFAULT 0,
  continue_attempt INTEGER,
  queue_order      REAL,           -- queue.order: admission sorting; a handoff summary sorts at N - 0.5
  queue_removed    INTEGER,        -- queue.removed: excluded from the runnable set
  queue_automatic  INTEGER,
  queue_wake_up    INTEGER,
  queue_request_id TEXT,           -- queue.requestId: transfer idempotency key
  handoff_destination TEXT,        -- handoff.destinationThreadId
  owner_pid        INTEGER,
  owner_host       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT,
  rest             TEXT NOT NULL   -- JSON: queue minus order/removed/automatic/wakeUp/requestId,
                                   -- handoff minus destinationThreadId, modelSelection, usagePause,
                                   -- usage, error, parentTurnId, runtimeMode, interactionMode,
                                   -- interactionModeExplicit, startedAt, unanswered, generation,
                                   -- turnOutputTokens
) STRICT;
CREATE UNIQUE INDEX turns_id ON turns(thread_id, id);
CREATE INDEX turns_thread ON turns(thread_id, seq);
CREATE INDEX turns_open ON turns(status, thread_id) WHERE status IN ('queued','running');
CREATE INDEX turns_due ON turns(scheduled_for) WHERE status = 'queued';

CREATE TABLE messages (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  origin       TEXT,
  created_at   TEXT NOT NULL,
  text         TEXT NOT NULL,
  attachments  TEXT,               -- JSON array
  notification TEXT,               -- JSON: task/background notification facts
  UNIQUE (thread_id, id)
) STRICT;
CREATE INDEX messages_thread ON messages(thread_id, seq);
CREATE INDEX messages_turn ON messages(thread_id, turn_id);

CREATE TABLE activities (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_id      TEXT,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  payload      BLOB,               -- JSON text (zstd later behind payload_encoding)
  payload_encoding TEXT NOT NULL DEFAULT 'json',
  UNIQUE (thread_id, id)
) STRICT;
CREATE INDEX activities_thread ON activities(thread_id, seq);
CREATE INDEX activities_turn ON activities(thread_id, turn_id);

CREATE TABLE checkpoints (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_id    TEXT NOT NULL,
  status     TEXT NOT NULL,
  ref        TEXT,
  base_ref   TEXT,
  created_at TEXT NOT NULL,
  files      TEXT,                 -- JSON: CheckpointFileStat[]
  UNIQUE (thread_id, id)
) STRICT;
CREATE INDEX checkpoints_thread ON checkpoints(thread_id, seq);

CREATE TABLE delegations (
  id                TEXT PRIMARY KEY,
  parent_thread_id  TEXT NOT NULL,
  child_thread_id   TEXT NOT NULL,
  status            TEXT NOT NULL,
  notify            INTEGER NOT NULL DEFAULT 0,
  continued_in      TEXT,
  continues_task_id TEXT,           -- the task id the parent first knew
  idempotency_key   TEXT,
  base_branch       TEXT,
  prompt            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  rest              TEXT NOT NULL   -- JSON: modelSnapshot, review
) STRICT;
CREATE INDEX delegations_parent ON delegations(parent_thread_id, child_thread_id);
CREATE INDEX delegations_child ON delegations(child_thread_id);
-- Replay lookup is scoped to the caller's lineage, not global, and a replay
-- may leave several rows (the first one's child is gone, so the retry stores
-- another): a plain lookup index, never a uniqueness constraint.
CREATE INDEX delegations_idempotency ON delegations(parent_thread_id, idempotency_key);

-- The SQLite counterpart of <root>/quarantine: rows taken out of the live
-- tables instead of deleted, so a bad record can be inspected and put back.
CREATE TABLE quarantine (
  at TEXT NOT NULL, reason TEXT NOT NULL, table_name TEXT NOT NULL, row_json TEXT NOT NULL
) STRICT;
`;

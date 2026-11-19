-- Moxen thread store, schema v1 (PRAGMA user_version = 1).

-- table activities
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
) STRICT

-- index activities_thread
CREATE INDEX activities_thread ON activities(thread_id, seq)

-- index activities_turn
CREATE INDEX activities_turn ON activities(thread_id, turn_id)

-- table checkpoints
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
) STRICT

-- index checkpoints_thread
CREATE INDEX checkpoints_thread ON checkpoints(thread_id, seq)

-- table delegations
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
) STRICT

-- index delegations_child
CREATE INDEX delegations_child ON delegations(child_thread_id)

-- index delegations_idem
CREATE UNIQUE INDEX delegations_idem ON delegations(idempotency_key) WHERE idempotency_key IS NOT NULL

-- index delegations_parent
CREATE INDEX delegations_parent ON delegations(parent_thread_id, child_thread_id)

-- table messages
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
) STRICT

-- index messages_thread
CREATE INDEX messages_thread ON messages(thread_id, seq)

-- index messages_turn
CREATE INDEX messages_turn ON messages(thread_id, turn_id)

-- table meta
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT

-- table quarantine
CREATE TABLE quarantine (
  at TEXT NOT NULL, reason TEXT NOT NULL, table_name TEXT NOT NULL, row_json TEXT NOT NULL
) STRICT

-- index sqlite_autoindex_activities_1
(created by a table constraint)

-- index sqlite_autoindex_checkpoints_1
(created by a table constraint)

-- index sqlite_autoindex_delegations_1
(created by a table constraint)

-- index sqlite_autoindex_messages_1
(created by a table constraint)

-- index sqlite_autoindex_meta_1
(created by a table constraint)

-- index sqlite_autoindex_threads_1
(created by a table constraint)

-- table threads
CREATE TABLE threads (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  title                  TEXT NOT NULL,
  title_source           TEXT NOT NULL DEFAULT 'seed',
  hidden                 INTEGER NOT NULL DEFAULT 0,
  interaction_mode       TEXT NOT NULL,
  runtime_mode           TEXT NOT NULL,
  model_instance         TEXT,            -- modelSelection.instanceId
  model_id               TEXT,            -- modelSelection.model
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
) STRICT

-- index threads_created
CREATE INDEX threads_created ON threads(deleted_at, archived_at, hidden, created_at)

-- index threads_project
CREATE INDEX threads_project ON threads(project_id, created_at)

-- table turns
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
  queue_order      INTEGER,        -- queue.order: admission sorting
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
) STRICT

-- index turns_due
CREATE INDEX turns_due ON turns(scheduled_for) WHERE status = 'queued'

-- index turns_id
CREATE UNIQUE INDEX turns_id ON turns(thread_id, id)

-- index turns_open
CREATE INDEX turns_open ON turns(status, thread_id) WHERE status IN ('queued','running')

-- index turns_thread
CREATE INDEX turns_thread ON turns(thread_id, seq)

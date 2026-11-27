# The SQLite thread store

Moxen is moving the thread store from one JSONL ledger set per thread to one
SQLite database at the store root. This page holds the approved design
(MXN-378), trimmed to its decisions. The measurements stay because they are
what the performance budget is checked against. Until the cut-over, the JSONL
store is still the source of truth.

**Status:** step 1 (MXN-392) landed the connection, schema v1, the migration
runner and the row mapping under `src/core/threads/sqlite/`; step 2 (MXN-393)
landed the [importer](#importing-the-jsonl-store), run with
`moxen store import`. Nothing in production reads the database yet, and only
the importer writes it. The rollout is in [Rollout](#rollout).

## Why

The measured picture on a 573 MB store (983 threads, 378 k ledger rows,
macOS arm64, Bun 1.3.11):

| | JSONL | SQLite (same data) |
|---|---|---|
| sidebar list (983 threads) | 39–41 ms | 5.1 ms p50 (0.45–1.8 ms columns only) |
| transcript, largest thread (6,177 rows / 6.9 MB) | 12.1–12.5 ms parse | 4.1 ms fetch, 13.8 ms fetch + parse |
| patch one turn | 0.23–0.25 ms, grows with the ledger | 0.01 ms |
| one activity append | 0.03–0.06 ms | 0.02 ms p50, 0.28 ms p99 (`synchronous=NORMAL`) |
| queue pass over every thread | reads every turns ledger | 0.01 ms |
| open the store | ~1 ms + 983 folder checks | 2.5 ms open + pragmas |
| store-wide text search | 2.56 s, asynchronous | 666 ms **blocking** `LIKE`; not in scope |
| disk | 572 MB | 835 MB (523 MB with compressed payloads) |

The wins are not one thread's speed. They are the 983-file directory leaving
every list and poll, a "rewrite the whole ledger to change one field" becoming
one `UPDATE`, and real multi-row transactions replacing the staging, repair and
reconcile machinery in MXN-371 (about 510 lines become about 150).

## Runtime

`bun:sqlite`, no dependency. It is a Bun builtin, so it needs no build
`external` entry, and it works from source, in the `dist/` bundle and in the
compiled executable.

On macOS Bun does **not** link SQLite; it `dlopen`s the OS's
`libsqlite3.dylib` (Apple's build, no extension loading). The version the store
gets is therefore the user's macOS version, not Bun's. macOS 13 ships SQLite
3.39, which is the floor schema v1 targets: `STRICT` tables, partial indexes and
JSON1 are all available; `jsonb` (3.45) and `timediff()` (3.43) are not used.
`connection.ts` checks `sqlite_version()` against 3.39 and probes the features
on a TEMP table at open: below the floor it refuses with `SQLITE_TOO_OLD`, and
at or above the floor but missing STRICT tables, a partial index or JSON1 it
refuses with `SQLITE_FEATURES_MISSING`. Both name the loaded version and the
floor, because on macOS the loaded one is the user's. Linux and Windows builds
bundle Bun's own SQLite.

The API is synchronous: one connection per process owned by the daemon, and
query duration is event-loop stall. Queries on the request path stay small;
anything unbounded (store-wide search, `integrity_check`, `VACUUM`, the import)
runs in a worker or at idle. A write transaction must not span an `await`.

## Layout and identity

- `<store root>/store.db`, resolved absolutely at open (`resolveStoreRoot()`
  already returns an absolute path).
- `store.db`, `-wal` and `-shm` are one unit: never copy or delete the database
  without them. Backups use `VACUUM INTO`, never `cp`.
- `PRAGMA application_id` is `0x4d4f584e` (`"MOXN"`), so an unrelated SQLite
  file at that path is refused (`STORE_NOT_MOXEN`) instead of being read as a
  store. A hex dump and `moxen store path` agree about what the file is.
- `PRAGMA user_version` is the **schema** version, its own sequence from 1. A
  newer schema is refused with `FORMAT_TOO_NEW`, naming both numbers.
- `<store root>/store.db-open-lock` is the **setup gate**: a separate SQLite
  database whose write lock serializes opening, initializing and migrating a
  store across processes. It holds no rows, writes nothing, and is never
  deleted.
- `<store root>/store.json` stays the **engine** marker: format version 1 is
  the JSONL ledgers, 2 is `store.db`. That is what makes an older build refuse
  a cut-over store directly. `format.ts` still owns `config.json`, which is not
  moving.

Opening order: probe the runtime in memory; check an existing file read-only,
**before the gate is created**; take the gate; check again in a read
transaction; for an existing WAL store keep that transaction open while the
writable handle is opened and checked again under `BEGIN IMMEDIATE`; then apply
the pragmas and migrate.

What a **preflight refusal** guarantees — a newer schema or a file that is not
ours, detected by the read-only checks before any writable handle — is that an
existing store's main database file and WAL are left exactly as they were
(SQLite coordination files, `-shm` and an empty WAL, may be created or
rebuilt).

A failure later is not covered by that guarantee. The journal-mode change,
pragmas and migration run after the identity checks: a migration step that
throws rolls its own transaction back, so no schema or row from it survives,
but the WAL switch and header metadata may already have persisted — a
rollback-journal store switched to WAL before its first migration failed is
left as an empty, valid `store.db` in WAL mode, and a retry initializes it. A
hot-journal store is never reopened writable.

## Pragmas

| pragma | value | why |
|---|---|---|
| `journal_mode` | `WAL` | readers never block a writer; refused with `STORE_NOT_LOCAL` if the filesystem cannot do WAL (network or synced folder) |
| `busy_timeout` | `5000` | the only backstop behind a slow writer |
| `synchronous` | `NORMAL` | the documented safe pairing with WAL: one fsync per checkpoint, not per commit |
| `foreign_keys` | `ON` | `ON DELETE CASCADE` removes a thread's rows with it |
| `cache_size` | `-16000` | about 16 MB; the default is about 2 MB, small for transcripts |
| `application_id` | `0x4d4f584e` | identifies the file as ours |

Every write transaction uses `BEGIN IMMEDIATE`: a deferred transaction that
reads first and writes later cannot back off when another process commits in
between, even with a large `busy_timeout`. With `busy_timeout = 200` a writer
behind a 1 s transaction failed at 201 ms; with 3000 it succeeded at 1272 ms.
`PRAGMA wal_checkpoint` inside a write transaction fails: never checkpoint
there.

**Setup is serialized.** `<root>/store.db-open-lock` is opened, given the busy
timeout, and locked with `BEGIN IMMEDIATE` before any writable store handle is
opened; the first read-only preflight runs before the gate, and its handle is
closed before waiting for it.
it is rolled back and closed in `finally`. Two processes starting against a
fresh root initialize one schema instead of racing the DDL. There are no PID
files and no stale-owner cleanup.

**A refusal must not checkpoint.** An existing store is checked through a
read-only connection twice: before the gate and again in a read transaction
under it. For an existing WAL store that read transaction stays alive while
the writable handle is opened and identity and version are rechecked under
`BEGIN IMMEDIATE`; a rejected writable handle is rolled back and closed before
the reader is released, so its close cannot checkpoint the WAL into the
database file. For an accepted rollback-mode store the reader is released
before the journal-mode transition, and the gate is held through the
transition, validation and migration. An absent or zero-byte database is
created only under the gate. A newer schema committed only to the WAL, or
between two checks, is still detected and leaves the database and WAL byte for
byte unchanged.

The guarantee covers the main database file and the WAL. Read-only preflight
may create or rebuild `-shm`, or create an empty WAL; those coordination files
carry no committed data. A raw SQLite client that bypasses the gate, or a
process that replaces the database path, is outside the guarantee.

**Recovery is refused, not attempted.** A hot rollback journal
(`SQLITE_READONLY_ROLLBACK`) fails with `STORE_RECOVERY_REQUIRED`: this build
does not reopen writable to recover it, and does not suggest deleting the
journal. If permissions prevent SQLite from reading the WAL, the original
error is reported unchanged; `immutable` mode is never used to guess a
version.

WAL is unsupported on network filesystems and corruption is possible there —
all processes must be on one host. `STORE_ROOT` is user-settable, so a store on
a mapped drive is possible; the failure to enter WAL is refused rather than
silently running in rollback mode. Windows keeps the database file locked after
`close()` while the process lives (Bun issue #25964), so nothing deletes or
replaces `store.db` in a live process: "delete the store" and "restore a
backup" are next-start operations. `windows-latest` CI is where the Windows
behaviour is proven.

## Schema v1

Later migrations only add columns to `messages`: version 2 `automatic` and
`control` (MXN-385), version 3 `queued_task_notice` (MXN-393).

One row per record. A column holds what the code filters, sorts or patches on
its own; everything else is one `rest` JSON column, merged back on read in
`records.ts`. `STRICT` everywhere. Order comes from `seq INTEGER PRIMARY KEY`
(rowid), which an `UPDATE` keeps.

| table | key | columns that exist because code queries them | JSON |
|---|---|---|---|
| `threads` | `id` | project, title and source, hidden, modes, model (NOT NULL — a record without one is the importer's to quarantine), env, every timestamp, pending flags, `usage_pause` | research fields, sessions, instruction/mode state, subagents, overrides |
| `turns` | `seq`, indexed `(thread_id, id)` | status, delivery, schedule, `held_at_settle`, queue order/removed/automatic/wake-up/request id, handoff destination, owner | queue conditions, handoff text, model, usage, error, modes, generation |
| `messages` | `seq`, indexed `(thread_id, id)` | turn, role, origin, text + `original_text`, attachments, notification | — |
| `activities` | `seq`, indexed `(thread_id, id)` | turn, kind, summary + `original_summary`, `payload` BLOB + `payload_encoding` | payload JSON text |
| `checkpoints` | `seq`, indexed `(thread_id, id)` | turn, status, ref, base ref, files | — |
| `delegations` | `seq`, indexed `id` (not unique) | parent, child, status, notify, continue fields, idempotency key, base branch, prompt | model snapshot, review, `originalText` |
| `meta` | `key` | engine, schema, import state, imported at, source rows | — |
| `quarantine` | — | at, reason, table, row JSON — rows taken out of the live tables instead of deleted | — |

`turns.queue_order` is `REAL`: a model-handoff summary sorts just before the
turn it summarises, at `order - 0.5`.

`threads.model_instance` and `model_id` are `NOT NULL`: every `StoredThread`
carries a `modelSelection`. A pre-SQLite record without one is the importer's
problem (step 2): it quarantines the thread rather than inventing a model.

Indexes: `threads_created`, `threads_project`; `turns_id` on
`(thread_id, id)`, `turns_thread`, partial `turns_open` (queued/running) and
`turns_due` (queued with a time); `messages_id` on `(thread_id, id)`,
`messages_thread`, `messages_turn`; `activities_id`, `activities_thread`,
`activities_turn`; `checkpoints_id`, `checkpoints_thread`; `delegations_id`,
`delegations_parent`, `delegations_child`, and `delegations_idempotency` on
`(parent_thread_id, idempotency_key)` — all plain lookup indexes, never
uniqueness constraints on an id a legacy ledger may repeat.

### Duplicate ids in the legacy ledgers

`seq` is the row identity everywhere; uniqueness is kept only where the JSONL
format guarantees it.

| table | id constraint | does the legacy format guarantee it? | v1 |
|---|---|---|---|
| `threads` | `id PRIMARY KEY` | yes — one `thread.json` inside `threads/<id>/`; `threadDir` uses the id as the directory name (`store.ts:442`), so one record per id | keep the primary key |
| `meta` | `key PRIMARY KEY` | no legacy source; the SQLite-only table, written once by the importer | keep |
| `turns` | `(thread_id, id)` | no — `appendLedger` appends without an id check (`store.ts:746`) and `readLedger` returns every line (`store.ts:566`) | `seq`, `turns_id` index |
| `messages` | `(thread_id, id)` | no — real stores hold two rows with one id and different bodies (MXN-378 §7.3) | `seq`, `messages_id` index |
| `activities` | `(thread_id, id)` | no — same append/read path as turns | `seq`, `activities_id` index |
| `checkpoints` | `(thread_id, id)` | no — same append/read path | `seq`, `checkpoints_id` index |
| `delegations` | `id` | no — `appendDelegation` appends (`store.ts:806`) | `seq`, `delegations_id` index |
| `quarantine` | none | — | — |

**Which occurrence a reference sees.** The JSONL readers return every row
(`parseLedgerLines` does not deduplicate). A join by id uses `.find` or
`findIndex`, so it sees the **first** occurrence in append order —
`store.ts:771` for `updateTurn` and `operations.ts:240`, `:713`, `:1227` for
message joins. A ledger rewrite builds a `Map` keyed by id, so the last row
supplied for an id wins and is written onto every occurrence
(`mergeLedgerLines`, `store.ts:692`), and ids absent from the file are
appended. The importer therefore inserts every row in file order, and a
transcript returns all rows. A single-answer read must match the reader it
replaces: the cited message joins order by `seq` ascending and take the first;
delegation replay orders by `seq` descending and takes the newest match,
because the legacy replay scans the ledger from the end (`operations.ts:4043`)
and the oldest match could revisit a stale child instead of the task created on
the retry. A replay key is scoped to the caller's lineage, so two unrelated
parents may use one key, and a retry whose first child is gone stores a second
row for the same parent and key.

**Exact scalar keys.** `encodeScalar`/`decodeScalar` are one reversible TEXT
codec: a well-formed string that does not start with `~` is stored verbatim; a
string starting with `~`, or containing a lone surrogate, is stored as `~` plus
four lowercase hex digits per UTF-16 code unit, so it is collision-free and
exact. SQL NULL stays NULL. Any predicate on an encoded column binds the
encoded value. It covers delegation `idempotency_key` and `base_branch`; thread
`project_id`, `model_instance`, `model_id`, `env_path` and `env_branch`; turn
`queue_request_id`, `owner_host` and `message_id`; and `messages.id`, which a
provider's own message id is concatenated into (`noteMessageId`), so the two
sides of that reference are encoded alike. A custom project id is accepted by
the project registry, so both can carry arbitrary code units. Thread ids stay
verbatim: the JSONL writer validates them as ASCII (`THREAD_ID`), and a SQLite
writer must keep doing so. Turn, activity, checkpoint and delegation ids are
generated UUIDs; enums, ISO timestamps and JSON columns stay verbatim. This is
why two replay keys, project ids or message ids that would both become U+FFFD
cannot alias, and why `base_branch` matches `env_branch` on both sides of a
comparison.

**Exact display text.** Thread titles, message text, activity summaries and
delegation prompts are stored well-formed for display; when the projection
changes a string, the original is kept in row metadata — `rest.originalText`
for threads and delegations, and the JSON-string `original_text` /
`original_summary` columns for messages and activities. Decode prefers the
original, so a lone surrogate from a code-unit slice survives exactly. Activity
payloads are untouched.

Deliberate normalisations in the row mapping (`records.ts`): `hidden: false`,
`heldAtSettle: false` and `notify: false` read as absent, `titleSource: "seed"`
reads as absent, and a `null` for `scheduledFor`, `scheduleReason`, `owner` or
`baseBranch` reads as absent. Every reader tests `=== true`, truthiness, or
compares to `"user"`/`"provider"`, so the pairs are indistinguishable in
behaviour. `usagePause` is the exception — a JSON column, so SQL NULL (absent)
and the JSON text `null` stay distinct.

`payload` is a BLOB even though it holds JSON text, so compression later is a
data change rather than a schema change. Do not compress in the first
migration: zstd takes 447 MB of payload to 156 MB (2.87×, the whole store to
523 MB) but makes `moxen store sql` unreadable on payloads and adds a codec to
the transcript path. `payload_encoding` is there so it can land later.

`PRAGMA user_version` survives `VACUUM INTO`, so a restored backup keeps its
identity and version.

## Migrations

`PRAGMA user_version` plus numbered steps, oldest first. Each step runs in one
`BEGIN IMMEDIATE` with its version bump **inside** the transaction, so a
failure leaves the schema and the version untouched, and the version is read
again once the write lock is held: two processes that open the same store at
once do not both run the step, and an unexpected or newer version refuses
before any DDL. A database newer than the build is refused before anything is
written, with the store's `FORMAT_TOO_NEW` code so clients keep their
handling. The version is read once more after the last step commits: a newer
version forced into that gap refuses rather than being returned as the version
this build ran.

- A change is a new step, never an edit to an old one. The DDL of version 1 is
  pinned by a golden dump of `sqlite_master`; changing it is a deliberate act.
- A step's error says which step failed and that it was rolled back
  (`STORE_MIGRATION_FAILED`).
- The importer imports whatever a pre-SQLite store holds and quarantines what
  it cannot parse: there is no v0 → v1 migration.
- Field-level changes still need code: SQLite migrates columns, not the JSON
  inside `rest`.

The test suite runs under Node, where `bun:sqlite` does not exist, so the
SQLite tests skip there and run from `bun run test:sqlite`, which forces Bun.
`bun run check` includes it. The tests are a schema golden; the migration
runner (fresh, current, newer refused, a no-op step, a failing step rolling
back, two real processes racing, and a version forced before the final read);
the connection (pragmas, identity, an old runtime, a stripped one, two real
processes opening one fresh root, and the refusals — a newer schema in the WAL,
with a stale journal, with a missing `-shm`, in a foreign WAL database, and
forced between each pair of checks — with the database and WAL bytes compared);
a hot-journal fixture that fails closed with `STORE_RECOVERY_REQUIRED`; and a
round-trip invariant for every table, including exact scalar keys, a sliced
emoji kept through the display metadata, a half-step queue order, unicode
surrogates and nulls, and two rows with the same id in append order for each
table whose uniqueness is not guaranteed (turns, messages, activities,
checkpoints, delegations).

## Importing the JSONL store

`moxen store import` asks the server, which owns the store, to copy the JSONL
ledgers into `store.db` (`src/core/threads/sqlite/import.ts`). The ledgers and
`store.json` are only read.

**What it refuses.** `store.json` goes through the JSONL store's own gate before
anything is created: a newer version is `FORMAT_TOO_NEW` and an unreadable or
impossible one `INVALID_FORMAT_VERSION`. Once a later engine version means the
database is the source of truth, the importer refuses it (`STORE_NOT_JSONL`),
so the kept JSONL copy can never overwrite newer data. Data older than the
2026-11-06 compatibility baseline gets no migration: a missing marker does not
date a store, so old records are judged one by one and quarantined when they do
not have today's shape.

**One transaction per thread.** Each deletes the thread's rows and the
quarantine rows an earlier run made for it, then inserts every record in file
order. The delegations ledger is one more transaction under the same rules. A
last transaction removes threads the JSONL store no longer has. So resuming
after a crash and importing again are the same pass: it starts from the first
thread, skips nothing, and the database ends up mirroring the ledgers as they
are then.

**In a worker.** `bun:sqlite` is synchronous and verification reads the whole
database back, so the server runs the import, verification included, in a
worker thread (`import-job.ts`); only that thread touches `store.db`. Each
server has one import at a time, and a second request while it runs gets that
run's report. An abort is a flag in shared memory, which the importer reads
after planning each thread, before each transaction, and before and after
verification (`STORE_IMPORT_INTERRUPTED`). `close()` raises it before any other
teardown, and hands the store on only once the worker has exited. The worker is
never terminated; one that ends without a result is `STORE_IMPORT_FAILED`.

The worker starts from its own file, so `import-worker.ts` is an entry point in
both `scripts/build.ts` and `scripts/build-exe.ts`. A compiled executable
finds it by its path from `src/`, the entry points' shared folder.

**Imported or quarantined.** Every source record (one per thread record, one per
non-blank ledger line) becomes a live row or a `quarantine` row:

- Files are read as bytes, split at LF (a CR before it is part of the line
  ending), and each record is decoded as strict UTF-8. One that is not valid is
  quarantined, even where the JSONL readers would show U+FFFD and carry on.
- A line is a row by the JSONL readers' own rule (`parseLedgerLine`): torn,
  unparseable and id-less lines are quarantined. So is a row missing a field its
  columns need, or holding the wrong type (`validate.ts`; STRICT alone would
  convert a number into text), or naming another thread than its folder's.
  Nothing is defaulted to make a record fit. A removed interaction mode reads as
  Build, as the JSONL reader reads it.
- A thread whose record is missing, unparseable, or invalid (no
  `modelSelection`, say) has no thread row, so every one of its ledger lines is
  quarantined with it. A folder with no records at all is ignored.
- A file that exists but cannot be read is not a bad record: the import stops
  with `STORE_IMPORT_READ_FAILED`.

`quarantine.row_json` is `{origin: "jsonl-import", threadId, file, line}` plus
the record: `file` is relative to the store root and `line` is null for a thread
record. A record that is valid UTF-8 is `raw`, its text, which encodes back to
the same bytes; any other is `rawBase64`, its bytes. A line is kept without its
line ending, a thread record as the whole file. Re-importing replaces only rows
with that origin.

**Progress and verification.** `meta.import_state` is `running` from the first
transaction until the counts check out. Then every table's live row count must
equal what the pass imported, its quarantine rows what it set aside
(`STORE_IMPORT_MISMATCH`), and `PRAGMA quick_check` must answer `ok`
(`STORE_IMPORT_CORRUPT`). Only then do `import_state = 'complete'`,
`imported_at` and `source_rows` (per table: source, imported, quarantined) land
together.

The JSONL store keeps changing after an import, so `complete` describes the
store as it was read, not as it is now. The cut-over imports again with nothing
else writing. An import run beside live turns can quarantine a line caught half
written; the next run replaces it.

## Performance budget

| path | today | SQLite | p95 target |
|---|---|---|---|
| sidebar poll: threads + turns + queued counts | 39–41 ms | 5.1 ms list, 0.01 ms turns, 0.59 ms counts → ≤ 8 ms | 15 ms |
| open a thread, first paint (largest) | 12.1–12.5 ms | 4.1 ms fetch, 13.8 ms fetch + parse | 30 ms |
| append one activity mid-stream | 0.03–0.06 ms | 0.02 ms p50, 0.28 ms p99 | 2 ms at p99 |
| patch one turn | 0.23–0.25 ms | 0.01 ms | 1 ms |
| queue pass over all threads | reads every turns ledger | 0.01 ms | 10 ms |
| create a thread | one file write | 0.02 ms | 5 ms |
| open the store | ~1 ms | 2.5 ms open + pragmas | 20 ms |

The transcript path does not get much faster (`JSON.parse` dominates); its
gains are one consistent snapshot instead of four independent reads, and no
6.9 MB ledger read to answer "what is the latest turn". Store-wide search must
never run on the daemon's connection; an FTS5 index over messages, activity
summaries and tool names is the later search issue, not a `LIKE` here.

The import measured on the real store: 5.85–6.57 s for 377,943 rows in one
transaction (835 MB), 9.42 s per thread with `DELETE`/re-insert. Per-thread is
the choice: a bounded WAL (the single transaction wrote a 592 MB `-wal`),
resumability, and idempotence. Budget 30–60 s on a loaded Windows runner, once.

## Rollout

| # | Step |
|---|---|
| 1 | connection, pragmas, identity, schema v1, migration runner (**this issue**) |
| 2 | import the JSONL store (per-thread transaction, quarantine, idempotent re-import, counts, crash/resume) |
| 3 | read the thread record and transcript from SQLite |
| 4 | write turns, messages, activities and the thread record through SQLite |
| 5 | `transaction(fn)` with synchronous callbacks and deferred effects |
| 6 | collapse the manual-continue queue transfer into one transaction |
| 7 | delegations and research runs in SQLite |
| 8 | cut over, import on open, `FORMAT_TOO_NEW` for a newer schema, keep the legacy tree |
| 9 | `moxen store path/info/sql/dump/check/backup/prune-legacy` |
| 10 | later: FTS5 search and activity payload compression |

## Risks

- **Corruption is all-or-nothing.** JSONL skips a bad line and keeps the
  sidebar alive; a corrupt SQLite page fails queries. Mitigations: WAL with
  `synchronous=NORMAL`, `quick_check` after an abnormal exit, `VACUUM INTO`
  backups, the JSONL tree kept for a release, and `moxen store dump` as a
  rescue path. "Warn and continue" now covers semantic problems, not pages.
- **A slow query freezes the daemon.** Keep the budget; anything over 20 ms
  goes to a worker or idle time.
- **macOS uses the system SQLite.** The probe refuses an old one; the release
  notes should say a very old macOS may need an update.
- **Windows locks the file after close.** No delete or replace of `store.db` in
  a live process; see above.
- **A second writer.** Today only `server.lock` prevents it; SQLite serialises
  and detects it, with `busy_timeout` and `BEGIN IMMEDIATE` as the backstop.
  CLI store access is read-only (`query_only`).
- **The import is one-way.** It can lose rows that do not parse (a bad line, a
  record with no id); those are quarantined. Parseable rows with duplicate ids
  are neither lost nor collapsed: `seq` is the row identity, so the importer
  preserves every one (an idempotent resume replaces a thread's rows instead
  of inserting them twice — it is not source-ID deduplication). Counts,
  `quick_check`, the kept JSONL tree and `store dump` are the answer.

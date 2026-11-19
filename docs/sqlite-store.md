# The SQLite thread store

Moxen is moving the thread store from one JSONL ledger set per thread to one
SQLite database at the store root. This page holds the approved design
(MXN-378), trimmed to its decisions. The measurements stay because they are
what the performance budget is checked against. Until the cut-over, the JSONL
store is still the source of truth.

**Status:** step 1 (MXN-392) landed the connection, schema v1, the migration
runner and the row mapping under `src/core/threads/sqlite/`. Nothing in
production reads or writes the database yet. The rollout is in
[Rollout](#rollout).

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
- `<store root>/store.json` stays the **engine** marker: format version 1 is
  the JSONL ledgers, 2 is `store.db`. That is what makes an older build refuse
  a cut-over store directly. `format.ts` still owns `config.json`, which is not
  moving.

Opening order is identity, then the version check, then the pragmas and
migrations, so a refusal happens before the first write to the file.

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

An existing store is checked through a **read-only connection before it is
opened**: identity and schema version. (A hot rollback journal is the
exception: only a writable connection can recover it, and recovery finishes or
undoes an interrupted transaction rather than revealing new committed data.)
Opening a writable connection that is then closed checkpoints the WAL into the
database file, so a refusal — a newer schema, a file that is not ours — must
not do that. A newer schema committed only to the WAL by a writer that died is
still detected and still leaves the WAL, and the database file, byte for byte
unchanged.

WAL is unsupported on network filesystems and corruption is possible there —
all processes must be on one host. `STORE_ROOT` is user-settable, so a store on
a mapped drive is possible; the failure to enter WAL is refused rather than
silently running in rollback mode. Windows keeps the database file locked after
`close()` while the process lives (Bun issue #25964), so nothing deletes or
replaces `store.db` in a live process: "delete the store" and "restore a
backup" are next-start operations. `windows-latest` CI is where the Windows
behaviour is proven.

## Schema v1

One row per record. A column holds what the code filters, sorts or patches on
its own; everything else is one `rest` JSON column, merged back on read in
`records.ts`. `STRICT` everywhere. Order comes from `seq INTEGER PRIMARY KEY`
(rowid), which an `UPDATE` keeps.

| table | key | columns that exist because code queries them | JSON |
|---|---|---|---|
| `threads` | `id` | project, title and source, hidden, modes, model (NOT NULL — a record without one is the importer's to quarantine), env, every timestamp, pending flags, `usage_pause` | research fields, sessions, instruction/mode state, subagents, overrides |
| `turns` | `seq`, unique `(thread_id, id)` | status, delivery, schedule, `held_at_settle`, queue order/removed/automatic/wake-up/request id, handoff destination, owner | queue conditions, handoff text, model, usage, error, modes, generation |
| `messages` | `seq`, unique `(thread_id, id)` | turn, role, origin, text, attachments, notification | — |
| `activities` | `seq`, unique `(thread_id, id)` | turn, kind, summary, `payload` BLOB + `payload_encoding` | payload JSON text |
| `checkpoints` | `seq`, unique `(thread_id, id)` | turn, status, ref, base ref, files | — |
| `delegations` | `id` | parent, child, status, notify, continue fields, idempotency key, base branch, prompt | model snapshot, review |
| `meta` | `key` | engine, schema, import state, imported at, source rows | — |
| `quarantine` | — | at, reason, table, row JSON — rows taken out of the live tables instead of deleted | — |

`turns.queue_order` is `REAL`: a model-handoff summary sorts just before the
turn it summarises, at `order - 0.5`.

`threads.model_instance` and `model_id` are `NOT NULL`: every `StoredThread`
carries a `modelSelection`. A pre-SQLite record without one is the importer's
problem (step 2): it quarantines the thread rather than inventing a model.

Indexes: `threads_created`, `threads_project`; `turns_id` (unique),
`turns_thread`, partial `turns_open` (queued/running) and `turns_due`
(queued with a time); `messages_thread`, `messages_turn`; `activities_thread`,
`activities_turn`; `checkpoints_thread`; `delegations_parent`,
`delegations_child`, and `delegations_idempotency` on
`(parent_thread_id, idempotency_key)` — a plain lookup index, not a unique
one. A replay is scoped to the caller's lineage, so two unrelated parents may
use the same key; and a retry whose first child is gone stores a second row
for the same parent and key.

Deliberate normalisations in the row mapping (`records.ts`): `hidden: false`,
`heldAtSettle: false` and `notify: false` read as absent, `titleSource: "seed"`
reads as absent, and an explicit `null` for `scheduledFor`, `scheduleReason`,
`owner` or `baseBranch` reads as absent. Every reader tests `=== true`,
truthiness, or compares to `"user"`/`"provider"`, so the pairs are
indistinguishable in behaviour. `usagePause` is the exception — a JSON column,
so SQL NULL (absent) and the JSON text `null` stay distinct. Free text (title,
message text, activity summary, delegation prompt) is stored well-formed: a
lone surrogate from a code-unit slice becomes U+FFFD, because SQLite TEXT is
UTF-8; JSON columns keep one escaped and lossless.

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
handling.

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
`bun run check` includes it. The tests are a schema golden, the migration
runner (fresh, current, newer refused, a no-op step, a failing step rolling
back, and two real processes racing), the connection (pragmas, identity, an
old runtime, a stripped one, a newer schema refused without checkpointing the
WAL it lives in), and a round-trip invariant: every table's representative
record encodes, writes, reads and decodes back equal, unicode, large JSON and
nulls included, with the canonicalisations above and the lone-surrogate
normalisation pinned.

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
| 2 | import the JSONL store (per-thread transaction, quarantine, dedupe, counts, crash/resume) |
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
- **The import is one-way.** It can lose data that does not parse (two
  duplicate message ids already exist in real stores). Counts, `quick_check`,
  the kept JSONL tree and `store dump` are the answer.

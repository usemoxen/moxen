/**
 * Opening the SQLite thread store (MXN-392).
 *
 * The file is `<store root>/store.db`, resolved absolutely so a compiled
 * binary's working directory cannot move it (MXN-378 §3.3). Opening is
 * serialized through a separate SQLite gate, `<store root>/store.db-open-lock`,
 * so two Moxen processes starting together initialize one schema instead of
 * racing the DDL. Inside the gate the store is checked again read-only, then
 * opened writable and rechecked under `BEGIN IMMEDIATE` before any persistent
 * change.
 *
 * A refusal must not checkpoint: an open-and-close of a writable handle turns
 * the WAL into the database file. An existing WAL database therefore keeps a
 * read transaction open while the writable handle is checked and while pragmas
 * and migrations run, and a rejected writable handle is closed before that
 * reader is released.
 *
 * Nothing in production opens it yet: the JSONL ledgers are still the source
 * of truth until the cut-over issue. See docs/sqlite-store.md.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { Database } from "bun:sqlite";

import { CliError } from "../../errors.js";
import { migrateStoreSchema, readSchemaVersion, SCHEMA_VERSION, schemaTooNew, type SchemaMigration } from "./migrations.js";

const requireBun = createRequire(import.meta.url);

/**
 * `bun:sqlite` is loaded when a store is opened, not when this module is
 * imported: the test suite runs under Node, which has no such module, so the
 * SQLite tests skip there instead of failing to load the file. Production and
 * the Bun run of those tests get the real builtin.
 */
function createDatabase(file: string, options: { readonly?: boolean } = {}): Database {
  const { Database: BunDatabase } = requireBun("bun:sqlite") as typeof import("bun:sqlite");
  return options.readonly === true ? new BunDatabase(file, { readonly: true }) : new BunDatabase(file, { create: true });
}

/** The store database's file name under the store root. */
export const STORE_DATABASE_NAME = "store.db";

/**
 * The setup gate's file name: a separate SQLite database whose write lock
 * serializes opening, initializing and migrating a store across processes.
 * It holds no rows and is never deleted.
 */
export const STORE_OPEN_LOCK_NAME = "store.db-open-lock";

/**
 * `PRAGMA application_id`: `"MOXN"` as the big-endian integer SQLite stores in
 * the file header (0x4d4f584e), so a hex dump and `moxen store path` agree
 * about what the file is.
 */
export const STORE_APPLICATION_ID = 0x4d4f584e;

/**
 * The oldest SQLite schema v1 runs on. On macOS Bun dlopens the OS's
 * `libsqlite3.dylib` instead of its own, so this is the user's macOS version,
 * not Bun's: macOS 13 ships 3.39 (MXN-378 §2.2).
 */
export const MINIMUM_SQLITE_VERSION = "3.39.0";

/** How long a writer waits for another process's lock before `SQLITE_BUSY`. */
export const STORE_BUSY_TIMEOUT_MS = 5_000;

/** The database file for a store root, absolute and portable. */
export function storeDatabasePath(root: string): string {
  return path.join(path.resolve(root), STORE_DATABASE_NAME);
}

/** The setup gate for a store root, beside the database it guards. */
export function storeOpenLockPath(root: string): string {
  return path.join(path.resolve(root), STORE_OPEN_LOCK_NAME);
}

export interface OpenStoreDatabaseOptions {
  /** Milliseconds a writer waits for another process. Tests shorten it. */
  readonly busyTimeoutMs?: number;
  /** Migration steps to run. Production uses the registered ones; tests pass their own. */
  readonly migrations?: readonly SchemaMigration[];
  /** Test seam: the SQLite version string the probe judges instead of the runtime's own. */
  readonly sqliteVersion?: string;
  /**
   * Test seam: runs after the read-only preflight and before the step named.
   * Production never sets it; the tests use it to commit a newer schema in the
   * gap between two checks.
   */
  readonly onPreflight?: (phase: "before-gate" | "before-writable") => void;
}

/**
 * Open (creating when absent) the store database for `root`. In order: probe
 * the runtime in memory; preflight an existing file read-only; take the
 * setup gate; preflight again in a read transaction; open writable and
 * recheck under `BEGIN IMMEDIATE`; then apply the pragmas and migrate. Every
 * refusal happens before a persistent change and without checkpointing the
 * WAL that refusal is about.
 */
export function openStoreDatabase(root: string, options: OpenStoreDatabaseOptions = {}): Database {
  const file = storeDatabasePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const busyTimeoutMs = options.busyTimeoutMs ?? STORE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new CliError("INVALID_STORE_OPTION", `busy_timeout must be a whole number of milliseconds, not ${String(busyTimeoutMs)}.`);
  }

  // The runtime probe touches no file: an old or stripped SQLite fails before
  // this build creates a gate or a database.
  probeRuntimeInMemory(options.sqliteVersion);

  const existingBeforeGate = isNonEmptyFile(file);
  if (existingBeforeGate) {
    withReadOnlyDatabase(file, busyTimeoutMs, (db) => {
      assertMoxenFile(db, file);
      refuseNewerSchema(readSchemaVersion(db));
    });
  }
  options.onPreflight?.("before-gate");

  const gate = createDatabase(storeOpenLockPath(root));
  let gateOpen = false;
  let reader: Database | undefined;
  let store: Database | undefined;
  try {
    gate.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    gate.exec("BEGIN IMMEDIATE");
    gateOpen = true;

    // Recompute under the gate: another process may have initialized the
    // store while this one waited.
    const existing = isNonEmptyFile(file);
    if (existing) {
      reader = createDatabase(file, { readonly: true });
      reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      reader.exec("BEGIN");
      assertMoxenFile(reader, file);
      refuseNewerSchema(readSchemaVersion(reader));
    }
    const wal = reader?.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode === "wal";

    if (existing && wal) {
      options.onPreflight?.("before-writable");
      store = createDatabase(file);
      try {
        // The read transaction above is still open: if this connection is
        // refused and closed, it cannot checkpoint the WAL into the file.
        store.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        store.exec("BEGIN IMMEDIATE");
        assertMoxenFile(store, file);
        refuseNewerSchema(readSchemaVersion(store));
        store.exec("ROLLBACK");
      } catch (error) {
        try {
          store.exec("ROLLBACK");
        } catch {
          // The recheck may have failed before the transaction opened.
        }
        try {
          store.close();
        } catch {
          // Already unusable; the original error is the one worth reporting.
        }
        store = undefined;
        throw error;
      }
      // Keep the reader through pragmas and migration too: an error there
      // must not checkpoint a WAL this build did not validate.
      applyPragmas(store, file, busyTimeoutMs);
      migrateStoreSchema(store, migrationOptions(options));
    } else {
      if (reader !== undefined) {
        reader.exec("ROLLBACK");
        reader.close();
        reader = undefined;
      }
      store = createDatabase(file);
      applyPragmas(store, file, busyTimeoutMs);
      migrateStoreSchema(store, migrationOptions(options));
    }
    return store;
  } catch (error) {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // The original error is the one worth reporting.
      }
      store = undefined;
    }
    throw recoveryAware(error);
  } finally {
    if (reader !== undefined) {
      try {
        reader.exec("ROLLBACK");
      } catch {
        // Already rolled back or never started.
      }
      try {
        reader.close();
      } catch {
        // Nothing to recover from a close failure.
      }
    }
    if (gateOpen) {
      try {
        gate.exec("ROLLBACK");
      } catch {
        // A failed BEGIN IMMEDIATE leaves nothing to roll back.
      }
    }
    try {
      gate.close();
    } catch {
      // Nothing to recover from a close failure.
    }
  }
}

function migrationOptions(options: OpenStoreDatabaseOptions): { migrations?: readonly SchemaMigration[] } {
  return options.migrations === undefined ? {} : { migrations: options.migrations };
}

function isNonEmptyFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

/** A read-only handle, closed before the caller can wait on the gate. */
function withReadOnlyDatabase<T>(file: string, busyTimeoutMs: number, fn: (db: Database) => T): T {
  let db: Database | undefined;
  try {
    db = createDatabase(file, { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return fn(db);
  } catch (error) {
    throw recoveryAware(error);
  } finally {
    try {
      db?.close();
    } catch {
      // A read-only close has nothing to sync.
    }
  }
}

/**
 * A hot rollback journal needs SQLite's own recovery, which a read-only
 * connection cannot perform; this build fails closed instead of opening
 * writable and modifying a store it cannot validate first (docs/sqlite-store.md).
 * Any other read error is reported as it is: never guess the version.
 */
function recoveryAware(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code === "SQLITE_READONLY_ROLLBACK") {
    return new CliError(
      "STORE_RECOVERY_REQUIRED",
      "The thread store has an unfinished transaction that needs SQLite's crash recovery, and this build will not modify it. Nothing was changed. Restore the store from a backup, or update Moxen so a build that can recover it opens it first.",
      { cause: error },
    );
  }
  return error;
}

function probeRuntimeInMemory(reported: string | undefined): void {
  const db = createDatabase(":memory:");
  try {
    probeSqliteRuntime(db, reported);
  } finally {
    db.close();
  }
}

/**
 * Refuse a runtime whose SQLite is older than schema v1 needs, instead of
 * failing later with a syntax error somewhere in the DDL. The version check
 * names the floor in both versions; the probe proves the features the schema
 * actually uses (STRICT tables, a partial index, JSON1) on a TEMP table that
 * never touches the store's file. A build at or above the floor that lacks a
 * feature gets its own code: it is not an old version, it is a stripped
 * SQLite. Exported so a doctor check can run the same probe.
 */
export function probeSqliteRuntime(db: Database, reported?: string): void {
  const loaded = reported ?? db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ?? "unknown";
  if (!versionAtLeast(loaded, MINIMUM_SQLITE_VERSION)) {
    throw new CliError(
      "SQLITE_TOO_OLD",
      `The thread store needs SQLite ${MINIMUM_SQLITE_VERSION} or newer, but this runtime loaded SQLite ${loaded}. ${
        process.platform === "darwin"
          ? "On macOS Bun uses the system SQLite, so updating macOS raises it."
          : "Update Moxen to get a newer SQLite."
      }`,
      { details: { loaded, needed: MINIMUM_SQLITE_VERSION } },
    );
  }
  try {
    db.exec("CREATE TEMP TABLE moxen_schema_probe (value TEXT NOT NULL) STRICT");
    db.exec("CREATE INDEX moxen_schema_probe_value ON moxen_schema_probe(value) WHERE value IS NOT NULL");
    db.query("SELECT json_extract('{}', '$.a') AS value").get();
  } catch (error) {
    throw new CliError(
      "SQLITE_FEATURES_MISSING",
      `SQLite ${loaded} cannot run schema v1 even though this build needs only ${MINIMUM_SQLITE_VERSION}: ${
        error instanceof Error ? error.message : String(error)
      }. The runtime's SQLite build is missing STRICT tables, a partial index or JSON1.`,
      { cause: error, details: { loaded, needed: MINIMUM_SQLITE_VERSION } },
    );
  } finally {
    try {
      db.exec("DROP TABLE IF EXISTS temp.moxen_schema_probe");
    } catch {
      // The probe's own failure is the one worth reporting, not this cleanup.
    }
  }
}

/**
 * Refuse a SQLite file that is not ours: an `application_id` we did not set,
 * or a schema someone else created in a file without one. A store that has
 * ours passes; an empty file is ours to initialise.
 */
function assertMoxenFile(db: Database, file: string): void {
  const applicationId = db.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id ?? 0;
  if (applicationId === STORE_APPLICATION_ID) return;
  const objects = db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master").get()?.count ?? 0;
  if (applicationId === 0 && objects === 0) return;
  throw new CliError(
    "STORE_NOT_MOXEN",
    `${file} is a SQLite database that this build did not create (application_id ${applicationId}); refusing to open it as a Moxen store.`,
    { details: { file, applicationId } },
  );
}

function refuseNewerSchema(version: number): void {
  if (version > SCHEMA_VERSION) throw schemaTooNew(version);
}

/** The pragmas every connection runs with (MXN-378 §2.3 and §3.2). */
function applyPragmas(db: Database, file: string, busyTimeoutMs: number): void {
  // Integers interpolated here come from this file's own constants or a
  // validated option: PRAGMA values cannot be bound.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA foreign_keys = ON");
  // ~16 MB. The default is ~2 MB, which is small for transcripts.
  db.exec("PRAGMA cache_size = -16000");
  // NORMAL is the documented safe pairing with WAL: one fsync per checkpoint,
  // not per commit.
  db.exec("PRAGMA synchronous = NORMAL");

  // WAL is persistent in the file; setting it is idempotent. A filesystem that
  // cannot support it (a network or synced folder) answers with another mode,
  // and running there risks corruption, so refuse rather than continue
  // silently (MXN-378 §3.4).
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode;
  if (mode !== "wal") {
    throw new CliError(
      "STORE_NOT_LOCAL",
      `The thread store could not switch ${file} to WAL (SQLite answered "${mode ?? "unknown"}"). SQLite requires a local disk for WAL, so a store on a network or synced folder is refused rather than risked.`,
      { details: { file, journalMode: mode ?? null } },
    );
  }

  // Writing the header only when it is unset keeps every ordinary open a
  // read: the identity is already in the file.
  if ((db.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id ?? 0) === 0) {
    db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`);
  }
}

/** Compare dotted version strings ("3.54.0"); a non-numeric part never passes. */
function versionAtLeast(found: string, needed: string): boolean {
  const a = found.split(".");
  const b = needed.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = Number(a[i] ?? 0);
    const right = Number(b[i] ?? 0);
    if (!Number.isFinite(left)) return false;
    if (left !== right) return left > right;
  }
  return true;
}

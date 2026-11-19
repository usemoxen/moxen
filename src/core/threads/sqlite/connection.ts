/**
 * Opening the SQLite thread store (MXN-392).
 *
 * The file is `<store root>/store.db`, resolved absolutely so a compiled
 * binary's working directory cannot move it (MXN-378 §3.3). Every connection
 * opens in WAL, waits on a writer instead of failing at once, and is stamped
 * with an `application_id` so the file is recognisably Moxen's. Opening runs
 * the schema migrations, so a reader can assume the schema version it reads.
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
function createDatabase(file: string): Database {
  const { Database: BunDatabase } = requireBun("bun:sqlite") as typeof import("bun:sqlite");
  return new BunDatabase(file, { create: true });
}

/** The store database's file name under the store root. */
export const STORE_DATABASE_NAME = "store.db";

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

export interface OpenStoreDatabaseOptions {
  /** Milliseconds a writer waits for another process. Tests shorten it. */
  readonly busyTimeoutMs?: number;
  /** Migration steps to run. Production uses the registered ones; tests pass their own. */
  readonly migrations?: readonly SchemaMigration[];
  /** Test seam: the SQLite version string the probe judges instead of the runtime's own. */
  readonly sqliteVersion?: string;
}

/**
 * Open (creating when absent) the store database for `root`: check the
 * runtime and the file's identity, refuse a newer schema, apply the pragmas,
 * then migrate. Every check runs before the first write, so refusing leaves
 * the file as it was.
 */
export function openStoreDatabase(root: string, options: OpenStoreDatabaseOptions = {}): Database {
  const file = storeDatabasePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = createDatabase(file);
  try {
    probeRuntime(db, options.sqliteVersion);
    assertMoxenFile(db, file);
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion > SCHEMA_VERSION) throw schemaTooNew(schemaVersion);
    applyPragmas(db, file, options.busyTimeoutMs ?? STORE_BUSY_TIMEOUT_MS);
    migrateStoreSchema(db, options.migrations === undefined ? {} : { migrations: options.migrations });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Refuse a runtime whose SQLite is older than schema v1 needs, instead of
 * failing later with a syntax error somewhere in the DDL. The version check
 * names the floor; the probe proves the features the schema actually uses
 * (STRICT tables, a partial index, JSON1) on a TEMP table that never touches
 * the store's file.
 */
function probeRuntime(db: Database, reported: string | undefined): void {
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
      "SQLITE_TOO_OLD",
      `This runtime's SQLite ${loaded} cannot run schema v1: ${error instanceof Error ? error.message : String(error)}`,
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

/** The pragmas every connection runs with (MXN-378 §2.3 and §3.2). */
function applyPragmas(db: Database, file: string, busyTimeoutMs: number): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new CliError("INVALID_STORE_OPTION", `busy_timeout must be a whole number of milliseconds, not ${String(busyTimeoutMs)}.`);
  }
  // Integers interpolated here come from this file's own constants: PRAGMA
  // values cannot be bound.
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

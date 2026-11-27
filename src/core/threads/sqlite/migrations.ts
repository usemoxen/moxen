/**
 * Schema migrations for the SQLite thread store (MXN-392).
 *
 * `PRAGMA user_version` is the version, and every step runs in one
 * `BEGIN IMMEDIATE` with the version bump, so a failure leaves both the schema
 * and the version untouched. A database newer than this build knows is refused
 * before anything is written, with the store's own `FORMAT_TOO_NEW` error so
 * clients keep the handling they already have.
 *
 * A step is a new `user_version`, never an edit to an older one: the schema
 * golden pins what version 1 created. See docs/sqlite-store.md.
 */
import type { Database } from "bun:sqlite";

import { CliError } from "../../errors.js";
import { formatTooNew } from "../../format.js";
import { SCHEMA_V1 } from "./schema.js";

export interface SchemaMigration {
  /** The `user_version` this step leaves behind. Steps run in ascending order, one version at a time. */
  readonly version: number;
  /** Named in errors, so a failed step says which one it was. */
  readonly name: string;
  up(db: Database): void;
}

/** Every step this build knows, oldest first. */
export const MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, name: "create schema v1", up: (db) => db.exec(SCHEMA_V1) },
  {
    version: 2,
    name: "message usage-notice provenance flags (MXN-385)",
    up: (db) => db.exec("ALTER TABLE messages ADD COLUMN automatic INTEGER; ALTER TABLE messages ADD COLUMN control INTEGER;"),
  },
];

/** The schema version this build reads and writes: the last registered step. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function readSchemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/** A schema newer than this build knows about: refuse it, naming both numbers. */
export function schemaTooNew(found: number, current: number = SCHEMA_VERSION): CliError {
  return formatTooNew("The thread store schema", found, current);
}

export interface MigrateOptions {
  /** Steps to run. Production uses `MIGRATIONS`; tests pass their own to prove the runner. */
  readonly migrations?: readonly SchemaMigration[];
  /**
   * Test seam: runs after the last step commits and before the final version
   * is read. Production never sets it; the tests use it to force a newer
   * version into that gap.
   */
  readonly afterMigrations?: (db: Database) => void;
}

/**
 * Bring the database up to the registered schema version, or refuse what is
 * newer. Each step is one write transaction, and the version is read again
 * once the write lock is held: two processes opening a store at once do not
 * both run the same DDL. The loser sees the committed version and skips the
 * step the winner already applied; an unexpected or newer version refuses
 * before any DDL.
 */
export function migrateStoreSchema(db: Database, options: MigrateOptions = {}): number {
  const migrations = options.migrations ?? MIGRATIONS;
  // The registered target is the ceiling, so a test registry (a synthetic v2)
  // can finish above the build's schema version. Production registers only
  // SCHEMA_VERSION, so there it is the same number.
  const target = migrations[migrations.length - 1]?.version ?? 0;
  const ceiling = Math.max(SCHEMA_VERSION, target);
  const start = readSchemaVersion(db);
  if (start > ceiling) throw schemaTooNew(start);

  let version = start;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    // `PRAGMA user_version` cannot be bound, so the integer is interpolated:
    // it comes from this file's own registry, and a registry that is not a
    // whole positive version refuses rather than reaching SQL.
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new CliError("INVALID_SCHEMA_MIGRATION", `Schema migration "${migration.name}" has an invalid version: ${String(migration.version)}.`);
    }
    if (migration.version !== version + 1) throw missingMigration(version);
    // `BEGIN IMMEDIATE`: two processes that open a store at once serialise on
    // the write lock, and the loser honours busy_timeout instead of failing
    // on a stale read snapshot (MXN-378 §3.2). The version is re-read inside,
    // because the read above happened before this connection held the lock.
    const step = db.transaction(() => {
      const current = readSchemaVersion(db);
      if (current > ceiling) throw schemaTooNew(current);
      if (current >= migration.version) return;
      if (current !== migration.version - 1) throw missingMigration(current);
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    try {
      step.immediate();
    } catch (error) {
      // A refusal keeps its own code: it is the caller's contract, not a
      // failed migration.
      if (error instanceof CliError && (error.code === "FORMAT_TOO_NEW" || error.code === "FORMAT_MIGRATION_MISSING")) throw error;
      throw new CliError(
        "STORE_MIGRATION_FAILED",
        `Schema migration ${migration.version} (${migration.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    version = readSchemaVersion(db);
  }
  options.afterMigrations?.(db);
  // Read the version again after the last step: a writer that landed a newer
  // schema in the gap must refuse, not be reported as the version we ran.
  const final = readSchemaVersion(db);
  if (final > ceiling) throw schemaTooNew(final);
  if (final < target) {
    throw new CliError("STORE_MIGRATION_FAILED", `The thread store schema ended at version ${final}, but this build migrated to version ${target}.`);
  }
  return final;
}

function missingMigration(current: number): CliError {
  return new CliError(
    "FORMAT_MIGRATION_MISSING",
    `The thread store schema is version ${current}, and this build has no migration to version ${current + 1}.`,
  );
}

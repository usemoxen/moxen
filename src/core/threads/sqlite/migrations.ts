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
}

/**
 * Bring the database up to the registered schema version, or refuse what is
 * newer. Each step is one write transaction, so a throwing step leaves the
 * database at the version it started from.
 */
export function migrateStoreSchema(db: Database, options: MigrateOptions = {}): number {
  const migrations = options.migrations ?? MIGRATIONS;
  const current = readSchemaVersion(db);
  if (current > SCHEMA_VERSION) throw schemaTooNew(current);

  let version = current;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    // `PRAGMA user_version` cannot be bound, so the integer is interpolated:
    // it comes from this file's own registry, and a registry that is not a
    // whole positive version refuses rather than reaching SQL.
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new CliError("INVALID_SCHEMA_MIGRATION", `Schema migration "${migration.name}" has an invalid version: ${String(migration.version)}.`);
    }
    if (migration.version !== version + 1) {
      throw new CliError(
        "FORMAT_MIGRATION_MISSING",
        `The thread store schema is version ${version}, and this build has no migration to version ${version + 1}.`,
      );
    }
    // `BEGIN IMMEDIATE`: two processes that open a store at once serialise on
    // the write lock, and the loser honours busy_timeout instead of failing
    // on a stale read snapshot (MXN-378 §3.2).
    const step = db.transaction(() => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    try {
      step.immediate();
    } catch (error) {
      throw new CliError(
        "STORE_MIGRATION_FAILED",
        `Schema migration ${migration.version} (${migration.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    version = migration.version;
  }
  return version;
}

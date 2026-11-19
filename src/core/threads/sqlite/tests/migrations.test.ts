/**
 * The schema migration runner (MXN-392): `user_version` is the version, every
 * step is one write transaction, a no-op step proves the loop, and a database
 * newer than this build is refused with the store's own FORMAT_TOO_NEW.
 */
import { describe, expect, it } from "vitest";

import type { Database } from "bun:sqlite";

import { MIGRATIONS, SCHEMA_VERSION, migrateStoreSchema, readSchemaVersion, type SchemaMigration } from "../migrations.js";
import { storeDatabasePath } from "../connection.js";
import { closeForTest, openForTest, rawForTest, temporaryRoot, underBun } from "./support.js";

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

describe.skipIf(!underBun)("schema migrations", () => {
  it("creates schema v1 on a fresh database and records its version", () => {
    const db = openForTest(temporaryRoot("fresh"));
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual(["activities", "checkpoints", "delegations", "messages", "meta", "quarantine", "threads", "turns"]);
  });

  it("does not run a step on a database already at its version", () => {
    const db = openForTest(temporaryRoot("current"));
    let runs = 0;
    const counted: SchemaMigration = { version: 1, name: "counted", up: () => { runs += 1; } };
    expect(migrateStoreSchema(db, { migrations: [counted] })).toBe(1);
    expect(runs).toBe(0);
  });

  it("refuses a database newer than this build knows, naming both versions", () => {
    const root = temporaryRoot("newer");
    const db = rawForTest(storeDatabasePath(temporaryRoot("newer")));
    db.exec("PRAGMA user_version = 99");
    expect(() => migrateStoreSchema(db)).toThrow(
      expect.objectContaining({
        code: "FORMAT_TOO_NEW",
        message: expect.stringContaining("version 99"),
      }),
    );
    expect(tableNames(db)).toEqual([]);
    expect(readSchemaVersion(db)).toBe(99);
  });

  it("applies a no-op step and bumps user_version without changing the schema", () => {
    const plain = openForTest(temporaryRoot("plain"));
    const withNoop = rawForTest(storeDatabasePath(temporaryRoot("noop")));
    const version = migrateStoreSchema(withNoop, {
      migrations: [...MIGRATIONS, { version: 2, name: "nothing to do", up: () => {} }],
    });
    expect(version).toBe(2);
    expect(readSchemaVersion(withNoop)).toBe(2);
    expect(tableNames(withNoop)).toEqual(tableNames(plain));
  });

  it("rolls a failing step back, version and writes included", () => {
    const root = temporaryRoot("failing");
    const db = rawForTest(storeDatabasePath(root));
    const failing: SchemaMigration = {
      version: 2,
      name: "break things",
      up: (connection) => {
        connection.exec("CREATE TABLE scratch (value TEXT)");
        connection.exec("INSERT INTO meta (key, value) VALUES ('half', 'written')");
        throw new Error("boom");
      },
    };

    expect(() => migrateStoreSchema(db, { migrations: [...MIGRATIONS, failing] })).toThrow(
      expect.objectContaining({ code: "STORE_MIGRATION_FAILED", message: expect.stringContaining("2 (break things)") }),
    );

    expect(readSchemaVersion(db)).toBe(1);
    expect(tableNames(db)).not.toContain("scratch");
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM meta").get()).toEqual({ count: 0 });
    // Version 1 itself committed and is usable.
    expect(tableNames(db)).toContain("threads");
  });

  it("refuses a registry with a gap instead of guessing the shape", () => {
    const db = rawForTest(storeDatabasePath(temporaryRoot("gap")));
    expect(() =>
      migrateStoreSchema(db, { migrations: [{ version: 2, name: "out of order", up: () => {} }] }),
    ).toThrow(expect.objectContaining({ code: "FORMAT_MIGRATION_MISSING" }));
    expect(readSchemaVersion(db)).toBe(0);
  });

  it("keeps the schema on a database that is already current", () => {
    const root = temporaryRoot("again");
    const first = openForTest(root);
    const before = tableNames(first);
    closeForTest(first);
    const second = openForTest(root);
    expect(tableNames(second)).toEqual(before);
    expect(readSchemaVersion(second)).toBe(SCHEMA_VERSION);
  });
});

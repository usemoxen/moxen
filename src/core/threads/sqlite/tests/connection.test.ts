/**
 * Opening the SQLite store file (MXN-392): the path under the store root, the
 * pragmas every connection runs with, the runtime probe that refuses a SQLite
 * too old for schema v1, and the refusals that leave a file untouched.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MINIMUM_SQLITE_VERSION, STORE_APPLICATION_ID, openStoreDatabase, probeSqliteRuntime, storeDatabasePath } from "../connection.js";
import { closeForTest, openForTest, rawForTest, startChild, temporaryRoot, underBun, waitFor } from "./support.js";

/** Every file under the root and its bytes, so a refusal that rewrites one shows up. */
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => [name, createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")]),
  );
}

describe.skipIf(!underBun)("the SQLite store connection", () => {
  it("puts the database under the store root, resolved absolutely", () => {
    const root = temporaryRoot("path");
    expect(storeDatabasePath(root)).toBe(path.join(path.resolve(root), "store.db"));
    expect(storeDatabasePath("relative/root")).toBe(path.join(path.resolve("relative/root"), "store.db"));
    expect(path.isAbsolute(storeDatabasePath(root))).toBe(true);
  });

  it("creates the parent folders and works in a path with spaces and accents", () => {
    const root = path.join(temporaryRoot("spaces"), "dir with spaces", "ünïcode");
    const db = openForTest(root);
    expect(existsSync(storeDatabasePath(root))).toBe(true);
    db.exec("CREATE TABLE probe (value TEXT)");
    expect(db.query<{ value: string }, []>("SELECT value FROM probe").all()).toEqual([]);
  });

  it("opens in WAL with the store's pragmas and identity", () => {
    const root = temporaryRoot("pragmas");
    const db = openForTest(root);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.query<{ application_id: number }, []>("PRAGMA application_id").get()).toEqual({ application_id: STORE_APPLICATION_ID });
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query<{ cache_size: number }, []>("PRAGMA cache_size").get()).toEqual({ cache_size: -16_000 });
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    expect(db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version).toBeDefined();
  });

  it("takes a shorter busy timeout for tests and keeps it", () => {
    const db = openForTest(temporaryRoot("timeout"), { busyTimeoutMs: 1_234 });
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({ timeout: 1_234 });
  });

  it("reopens an existing store without changing its identity or data", () => {
    const root = temporaryRoot("reopen");
    const first = openForTest(root);
    first.exec("CREATE TABLE probe (value TEXT)");
    first.exec("INSERT INTO probe (value) VALUES ('kept')");
    closeForTest(first);

    const second = openForTest(root);
    expect(second.query<{ value: string }, []>("SELECT value FROM probe").all()).toEqual([{ value: "kept" }]);
    expect(second.query<{ application_id: number }, []>("PRAGMA application_id").get()).toEqual({ application_id: STORE_APPLICATION_ID });
  });

  it("names both versions when the runtime's SQLite is too old", () => {
    const db = rawForTest(storeDatabasePath(temporaryRoot("probe-old")));
    let error: unknown;
    try {
      probeSqliteRuntime(db, "3.36.0");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SQLITE_TOO_OLD", message: expect.stringContaining("3.36.0") });
    expect((error as Error).message).toContain(MINIMUM_SQLITE_VERSION);
  });

  it("calls a missing feature its own error, not an old version", () => {
    const db = rawForTest(storeDatabasePath(temporaryRoot("probe-feature")));
    // The probe's own TEMP table already exists, so its first statement fails:
    // a runtime at or above the floor that cannot run the schema's features.
    db.exec("CREATE TEMP TABLE moxen_schema_probe (value TEXT)");
    let error: unknown;
    try {
      probeSqliteRuntime(db, "3.54.0");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SQLITE_FEATURES_MISSING", message: expect.stringContaining("3.54.0") });
    expect((error as Error).message).toContain(MINIMUM_SQLITE_VERSION);
  });

  it("refuses a newer schema committed only in the WAL without checkpointing it", async () => {
    const root = temporaryRoot("wal-newer");
    const writer = startChild(path.join(__dirname, "fixtures", "wal-writer.ts"), [storeDatabasePath(root)]);
    let ready = false;
    try {
      await waitFor(() => writer.output().includes("ready"), "the writer to commit its schema");
      ready = true;
    } finally {
      writer.stop();
    }
    expect(ready).toBe(true);
    expect(await writer.exited).not.toBe(0);
    expect(Object.keys(snapshot(root))).toEqual(["store.db", "store.db-shm", "store.db-wal"]);
    const before = snapshot(root);
    const walBytes = statSync(path.join(root, "store.db-wal")).size;
    expect(walBytes).toBeGreaterThan(0);

    expect(() => openStoreDatabase(root)).toThrow(
      expect.objectContaining({ code: "FORMAT_TOO_NEW", message: expect.stringContaining("version 99") }),
    );

    // The preflight is read-only, so the WAL still holds the newer schema and
    // the main file is untouched: a build that refuses must not checkpoint.
    // The `-shm` is SQLite's shared-memory index and is rewritten by any open,
    // including a read-only one; it carries no committed data.
    const after = snapshot(root);
    expect(after["store.db"]).toBe(before["store.db"]);
    expect(after["store.db-wal"]).toBe(before["store.db-wal"]);
    expect(statSync(path.join(root, "store.db-wal")).size).toBe(walBytes);
  });

  it("recovers a hot rollback journal, which a read-only preflight cannot", async () => {
    const root = temporaryRoot("hot-journal");
    const file = storeDatabasePath(root);
    const writer = startChild(path.join(__dirname, "fixtures", "journal-writer.ts"), [file]);
    let ready = false;
    try {
      await waitFor(() => writer.output().includes("ready"), "the writer's open transaction");
      ready = true;
    } finally {
      writer.stop();
    }
    expect(ready).toBe(true);
    expect(await writer.exited).not.toBe(0);
    expect(existsSync(`${file}-journal`)).toBe(true);

    const db = openForTest(root);
    // SQLite rolled the interrupted transaction back and removed the journal.
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM meta WHERE key = 'half'").get()).toEqual({ count: 0 });
    expect(existsSync(`${file}-journal`)).toBe(false);
  });

  it("refuses an old runtime before touching the store's schema", () => {
    const root = temporaryRoot("old");
    expect(() => openStoreDatabase(root, { sqliteVersion: "3.36.0" })).toThrow(
      expect.objectContaining({ code: "SQLITE_TOO_OLD", message: expect.stringContaining(MINIMUM_SQLITE_VERSION) }),
    );
    const db = rawForTest(storeDatabasePath(root));
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master").get()).toEqual({ count: 0 });
  });

  it("refuses a SQLite file another application made, and leaves it alone", () => {
    const root = temporaryRoot("foreign");
    mkdirSync(root, { recursive: true });
    const foreign = rawForTest(storeDatabasePath(root));
    foreign.exec("CREATE TABLE other (value TEXT)");
    foreign.exec("PRAGMA application_id = 1234");
    foreign.exec("INSERT INTO other (value) VALUES ('kept')");
    closeForTest(foreign);

    expect(() => openStoreDatabase(root)).toThrow(expect.objectContaining({ code: "STORE_NOT_MOXEN" }));

    const check = rawForTest(storeDatabasePath(root));
    expect(check.query<{ application_id: number }, []>("PRAGMA application_id").get()).toEqual({ application_id: 1234 });
    expect(check.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(check.query<{ value: string }, []>("SELECT value FROM other").all()).toEqual([{ value: "kept" }]);
  });

  it("refuses a SQLite file with a schema but no Moxen identity", () => {
    const root = temporaryRoot("unidentified");
    const foreign = rawForTest(storeDatabasePath(root));
    foreign.exec("CREATE TABLE other (value TEXT)");
    closeForTest(foreign);

    expect(() => openStoreDatabase(root)).toThrow(expect.objectContaining({ code: "STORE_NOT_MOXEN" }));
  });

  it("refuses a schema newer than this build before the first write", () => {
    const root = temporaryRoot("newer");
    const newer = rawForTest(storeDatabasePath(root));
    newer.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`);
    newer.exec("PRAGMA user_version = 99");
    closeForTest(newer);

    expect(() => openStoreDatabase(root)).toThrow(
      expect.objectContaining({ code: "FORMAT_TOO_NEW", message: expect.stringContaining("version 99") }),
    );

    const check = rawForTest(storeDatabasePath(root));
    expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    // Still a rollback-journal file with no tables: the refusal came before
    // WAL or any DDL.
    expect(check.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(check.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master").get()).toEqual({ count: 0 });
  });
});

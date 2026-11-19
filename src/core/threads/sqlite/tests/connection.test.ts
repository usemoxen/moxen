/**
 * Opening the SQLite store file (MXN-392): the path, the pragmas and identity,
 * the runtime probe, the two-process setup gate, and the refusals that must
 * leave the database and its WAL byte for byte unchanged.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Database } from "bun:sqlite";

import {
  MINIMUM_SQLITE_VERSION,
  STORE_APPLICATION_ID,
  openStoreDatabase,
  probeSqliteRuntime,
  storeDatabasePath,
  storeOpenLockPath,
} from "../connection.js";
import { readSchemaVersion } from "../migrations.js";
import { SCHEMA_V1 } from "../schema.js";
import { closeForTest, openForTest, rawForTest, startChild, temporaryRoot, underBun, waitFor } from "./support.js";

/** Every file under the root and its bytes, so a refusal that rewrites one shows up. */
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => [name, createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")]),
  );
}

/** A clean WAL store with schema v1 (or a foreign one), checkpointed on close. */
function seedWalStore(root: string, options: { version?: number; applicationId?: number } = {}): void {
  const db = rawForTest(storeDatabasePath(root));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA application_id = ${options.applicationId ?? STORE_APPLICATION_ID}`);
  db.exec(options.applicationId === undefined ? SCHEMA_V1 : "CREATE TABLE other (value TEXT) STRICT");
  db.exec(`PRAGMA user_version = ${options.version ?? 1}`);
  closeForTest(db);
}

/** A writer that commits a newer schema to the WAL and is killed before any checkpoint. */
async function killedWalWriter(file: string): Promise<void> {
  const writer = startChild(path.join(__dirname, "fixtures", "wal-writer.ts"), [file]);
  let ready = false;
  try {
    await waitFor(() => writer.output().includes("ready"), "the writer to commit its schema");
    ready = true;
  } finally {
    writer.stop();
  }
  expect(ready).toBe(true);
  expect(await writer.exited).not.toBe(0);
}

describe.skipIf(!underBun)("the SQLite store connection", () => {
  it("puts the database under the store root, resolved absolutely", () => {
    const root = temporaryRoot("path");
    expect(storeDatabasePath(root)).toBe(path.join(path.resolve(root), "store.db"));
    expect(storeDatabasePath("relative/root")).toBe(path.join(path.resolve("relative/root"), "store.db"));
    expect(path.isAbsolute(storeDatabasePath(root))).toBe(true);
    expect(storeOpenLockPath(root)).toBe(path.join(path.resolve(root), "store.db-open-lock"));
  });

  it("creates the parent folders and works in a path with spaces and accents", () => {
    const root = path.join(temporaryRoot("spaces"), "dir with spaces", "ünïcode");
    const db = openForTest(root);
    expect(existsSync(storeDatabasePath(root))).toBe(true);
    db.exec("CREATE TABLE probe (value TEXT)");
    expect(db.query<{ value: string }, []>("SELECT value FROM probe").all()).toEqual([]);
  });

  it("opens in WAL with the store's pragmas and identity, behind an empty setup gate", () => {
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

    // The gate is a separate SQLite file whose write lock serializes setup; it
    // holds no schema or rows of its own.
    expect(existsSync(storeOpenLockPath(root))).toBe(true);
    const gate = rawForTest(storeOpenLockPath(root), { readonly: true });
    expect(gate.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master").get()).toEqual({ count: 0 });
    closeForTest(gate);
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
    await killedWalWriter(storeDatabasePath(root));
    expect(Object.keys(snapshot(root))).toEqual(["store.db", "store.db-shm", "store.db-wal"]);
    const before = snapshot(root);
    const walBytes = statSync(path.join(root, "store.db-wal")).size;
    expect(walBytes).toBeGreaterThan(0);

    expect(() => openStoreDatabase(root)).toThrow(
      expect.objectContaining({ code: "FORMAT_TOO_NEW", message: expect.stringContaining("version 99") }),
    );

    // The `-shm` is SQLite's shared-memory index and is rewritten by any open;
    // the database and the WAL that holds the newer schema must not change.
    const after = snapshot(root);
    expect(after["store.db"]).toBe(before["store.db"]);
    expect(after["store.db-wal"]).toBe(before["store.db-wal"]);
    expect(statSync(path.join(root, "store.db-wal")).size).toBe(walBytes);
  });

  it("refuses a newer schema even with a stale rollback journal beside it", async () => {
    const root = temporaryRoot("stale-journal");
    const file = storeDatabasePath(root);
    await killedWalWriter(file);
    // A journal that is not hot (no header) must not skip the preflight.
    writeFileSync(`${file}-journal`, "");
    const before = snapshot(root);

    expect(() => openStoreDatabase(root)).toThrow(
      expect.objectContaining({ code: "FORMAT_TOO_NEW", message: expect.stringContaining("version 99") }),
    );

    const after = snapshot(root);
    expect(after["store.db"]).toBe(before["store.db"]);
    expect(after["store.db-wal"]).toBe(before["store.db-wal"]);
    expect(after["store.db-journal"]).toBe(before["store.db-journal"]);
  });

  it("refuses a newer schema when the WAL's -shm is missing, and may rebuild it", async () => {
    const root = temporaryRoot("missing-shm");
    const file = storeDatabasePath(root);
    await killedWalWriter(file);
    rmSync(`${file}-shm`);
    const before = snapshot(root);

    expect(() => openStoreDatabase(root)).toThrow(expect.objectContaining({ code: "FORMAT_TOO_NEW" }));

    const after = snapshot(root);
    expect(after["store.db"]).toBe(before["store.db"]);
    expect(after["store.db-wal"]).toBe(before["store.db-wal"]);
    // Recreating the coordination file is allowed; it holds no committed data.
    expect(existsSync(`${file}-shm`)).toBe(true);
  });

  it("refuses a foreign WAL database without touching its database or WAL", () => {
    const root = temporaryRoot("foreign-wal");
    seedWalStore(root, { applicationId: 1234 });
    const before = snapshot(root);

    expect(() => openStoreDatabase(root)).toThrow(expect.objectContaining({ code: "STORE_NOT_MOXEN" }));

    const after = snapshot(root);
    expect(after["store.db"]).toBe(before["store.db"]);
    expect(after["store.db-wal"]).toBe(before["store.db-wal"]);
  });

  it("refuses a newer schema committed between the preflight and the gate", () => {
    const root = temporaryRoot("forced-before-gate");
    const file = storeDatabasePath(root);
    closeForTest(openForTest(root));
    const writer = rawForTest(file);
    let before: Record<string, string> | undefined;

    expect(() =>
      openStoreDatabase(root, {
        onPreflight: (phase) => {
          if (phase !== "before-gate") return;
          writer.exec("PRAGMA user_version = 99");
          before = snapshot(root);
        },
      }),
    ).toThrow(expect.objectContaining({ code: "FORMAT_TOO_NEW" }));

    const after = snapshot(root);
    expect(after["store.db"]).toBe(before!["store.db"]);
    expect(after["store.db-wal"]).toBe(before!["store.db-wal"]);
    closeForTest(writer);
  });

  it("refuses a newer schema committed between the gate check and the writable open", () => {
    const root = temporaryRoot("forced-before-writable");
    const file = storeDatabasePath(root);
    closeForTest(openForTest(root));
    const writer = rawForTest(file);
    let before: Record<string, string> | undefined;

    expect(() =>
      openStoreDatabase(root, {
        onPreflight: (phase) => {
          if (phase !== "before-writable") return;
          // The read transaction is still open; the held reader must keep the
          // rejected writable handle's close from checkpointing this commit.
          writer.exec("PRAGMA user_version = 99");
          before = snapshot(root);
        },
      }),
    ).toThrow(expect.objectContaining({ code: "FORMAT_TOO_NEW" }));

    const after = snapshot(root);
    expect(after["store.db"]).toBe(before!["store.db"]);
    expect(after["store.db-wal"]).toBe(before!["store.db-wal"]);
    closeForTest(writer);
  });

  it("fails closed on a hot rollback journal instead of recovering it", () => {
    const root = temporaryRoot("recovery");
    const file = storeDatabasePath(root);
    const fixture = path.join(__dirname, "fixtures", "hot-journal");
    copyFileSync(path.join(fixture, "store.db"), file);
    copyFileSync(path.join(fixture, "store.db-journal"), `${file}-journal`);
    const before = snapshot(root);

    // The frozen fixture is a real page spill: SQLite itself refuses it
    // read-only with SQLITE_READONLY_ROLLBACK.
    let rawError: unknown;
    let raw: Database | undefined;
    try {
      raw = rawForTest(file, { readonly: true });
      raw.query("PRAGMA user_version").get();
    } catch (caught) {
      rawError = caught;
    }
    if (raw !== undefined) closeForTest(raw);
    expect(rawError).toMatchObject({ code: "SQLITE_READONLY_ROLLBACK" });

    expect(() => openStoreDatabase(root)).toThrow(expect.objectContaining({ code: "STORE_RECOVERY_REQUIRED" }));

    const after = snapshot(root);
    expect(after["store.db"]).toBe(before["store.db"]);
    expect(after["store.db-journal"]).toBe(before["store.db-journal"]);
  });

  it("lets two processes open a fresh store at once", async () => {
    const root = temporaryRoot("open-race");
    const script = path.join(__dirname, "fixtures", "open-racer.ts");
    const children = ["0", "1"].map((id) => startChild(script, [root, root, id]));
    try {
      await waitFor(
        () => children.every((_, index) => existsSync(path.join(root, `${index}.ready`))),
        "both openers to be ready",
      );
      writeFileSync(path.join(root, "go"), "go");
      expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    } finally {
      for (const child of children) child.stop();
    }

    const db = openForTest(root);
    expect(readSchemaVersion(db)).toBe(1);
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'threads'").get()).toEqual({ name: "threads" });
  });

  it("takes over an accepted rollback-mode store under the gate", () => {
    const root = temporaryRoot("rollback-accepted");
    const seed = rawForTest(storeDatabasePath(root));
    seed.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`);
    seed.exec(SCHEMA_V1);
    seed.exec("PRAGMA user_version = 1");
    closeForTest(seed);

    const db = openForTest(root);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(readSchemaVersion(db)).toBe(1);
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'threads'").get()).toEqual({ name: "threads" });
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

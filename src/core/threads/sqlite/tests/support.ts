/**
 * Temporary store roots and the connections opened on them, for the SQLite
 * store tests (MXN-392). Every connection is closed before its folder is
 * removed: Windows refuses to delete a file a live process still holds, and
 * a closed WAL leaves its `-wal`/`-shm` beside the database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import type { Database } from "bun:sqlite";
import { afterEach } from "vitest";

import { openStoreDatabase, type OpenStoreDatabaseOptions } from "../connection.js";

const requireBun = createRequire(import.meta.url);

/**
 * The suite runs under Node, which has no `bun:sqlite`; these tests run from
 * `bun run test:sqlite`, which forces the Bun runtime. Elsewhere they skip.
 */
export const underBun = typeof (process.versions as { bun?: string }).bun === "string";

const roots: string[] = [];
const opened: Database[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A fresh temporary folder, removed after the test. */
export function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `moxen-sqlite-${label}-`));
  roots.push(root);
  return root;
}

/** The store database for a fresh root, opened through the production entry point. */
export function openForTest(root: string, options?: OpenStoreDatabaseOptions): Database {
  const db = openStoreDatabase(root, options);
  opened.push(db);
  return db;
}

/** A bare connection, for building a file the opener did not write (or reading one back). */
export function rawForTest(file: string, options: { create?: boolean } = {}): Database {
  const { Database: BunDatabase } = requireBun("bun:sqlite") as typeof import("bun:sqlite");
  const db = new BunDatabase(file, { create: options.create ?? true });
  opened.push(db);
  return db;
}

/** Close a connection before the test ends, and stop the cleanup closing it twice. */
export function closeForTest(db: Database): void {
  const index = opened.indexOf(db);
  if (index >= 0) opened.splice(index, 1);
  db.close();
}

/** Insert one encoded row by its named parameters (`$column`), returning its rowid. */
export function insertRow<R extends object>(db: Database, sql: string, row: R): number {
  const params: Record<string, string | number | bigint | boolean | null | Uint8Array> = {};
  for (const [key, value] of Object.entries(row)) params[`$${key}`] = value as string | number | bigint | boolean | null | Uint8Array;
  return Number(db.query(sql).run(params).lastInsertRowid);
}

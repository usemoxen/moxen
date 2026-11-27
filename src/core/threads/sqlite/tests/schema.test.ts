/**
 * Schema v1 is pinned (MXN-392): the DDL is dumped from `sqlite_master` and
 * compared to a checked-in golden, so any edit has to be intentional, and a
 * schema change is a new migration rather than a change to this file. Also
 * pins the cascade the design relies on: a thread's rows go with it.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Database } from "bun:sqlite";

import { MIGRATIONS, migrateStoreSchema } from "../migrations.js";
import { storeDatabasePath } from "../connection.js";
import {
  encodeActivity,
  encodeCheckpoint,
  encodeMessage,
  encodeThread,
  encodeTurn,
} from "../records.js";
import { INSERT_ACTIVITY, INSERT_CHECKPOINT, INSERT_MESSAGE, INSERT_THREAD, INSERT_TURN } from "../inserts.js";
import { activityWithoutPayload, completedTurn, sparseCheckpoint, sparseMessage, sparseThread } from "./fixtures.js";
import { insertRow, openForTest, rawForTest, temporaryRoot, underBun } from "./support.js";

/** Every object `sqlite_master` knows, in name order: the schema, verbatim. */
function schemaDump(db: Database): string {
  const rows = db
    .query<{ type: string; name: string; sql: string | null }, []>("SELECT type, name, sql FROM sqlite_master ORDER BY name")
    .all();
  const lines = ["-- Moxen thread store, schema v1 (PRAGMA user_version = 1)."];
  for (const row of rows) {
    lines.push("", `-- ${row.type} ${row.name}`, row.sql ?? "(created by a table constraint)");
  }
  return `${lines.join("\n")}\n`;
}

describe.skipIf(!underBun)("schema v1", () => {
  it("pins the DDL", async () => {
    const db = rawForTest(storeDatabasePath(temporaryRoot("golden")));
    migrateStoreSchema(db, { migrations: MIGRATIONS.slice(0, 1) });
    await expect(schemaDump(db)).toMatchFileSnapshot(path.join(__dirname, "fixtures", "schema-v1.sql"));
  });

  it("adds automatic and control columns to messages in schema v2", () => {
    const db = openForTest(temporaryRoot("v2-columns"));
    const columns = db
      .query<{ name: string; type: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((row) => [row.name, row.type]);
    expect(columns).toContainEqual(["automatic", "INTEGER"]);
    expect(columns).toContainEqual(["control", "INTEGER"]);
  });

  it("refuses a thread row with no model selection", () => {
    const db = openForTest(temporaryRoot("model"));
    const row = { ...encodeThread(sparseThread()), model_instance: null, model_id: null };
    expect(() => insertRow(db, INSERT_THREAD, row)).toThrow(/NOT NULL/);
  });

  it("removes a thread's rows with the thread (ON DELETE CASCADE)", () => {
    const db = openForTest(temporaryRoot("cascade"));
    const thread = sparseThread();
    insertRow(db, INSERT_THREAD, encodeThread(thread));
    insertRow(db, INSERT_TURN, encodeTurn({ ...completedTurn(), threadId: thread.id }));
    insertRow(db, INSERT_MESSAGE, encodeMessage({ ...sparseMessage(), threadId: thread.id, turnId: "turn-2" }));
    insertRow(db, INSERT_ACTIVITY, encodeActivity({ ...activityWithoutPayload(), threadId: thread.id }));
    insertRow(db, INSERT_CHECKPOINT, encodeCheckpoint({ ...sparseCheckpoint(), threadId: thread.id }));

    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 1 });
    db.query("DELETE FROM threads WHERE id = ?").run(thread.id);

    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 });
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 0 });
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 0 });
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM activities").get()).toEqual({ count: 0 });
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM checkpoints").get()).toEqual({ count: 0 });
  });
});

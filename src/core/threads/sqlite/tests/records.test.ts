/**
 * The column/`rest` invariant (MXN-392): a representative record for every
 * table is encoded, written, read back and decoded, and must equal what went
 * in — unicode and embedded newlines included, a large JSON payload, and the
 * fields that are genuinely null.
 */
import { describe, expect, it } from "vitest";

import type { Database } from "bun:sqlite";

import {
  decodeActivity,
  decodeCheckpoint,
  decodeDelegation,
  decodeMessage,
  decodeThread,
  decodeTurn,
  encodeActivity,
  encodeCheckpoint,
  encodeDelegation,
  encodeMessage,
  encodeThread,
  encodeTurn,
  type ActivityRow,
  type CheckpointRow,
  type DelegationRow,
  type MessageRow,
  type ThreadRow,
  type TurnRow,
} from "../records.js";
import {
  INSERT_ACTIVITY,
  INSERT_CHECKPOINT,
  INSERT_DELEGATION,
  INSERT_MESSAGE,
  INSERT_META,
  INSERT_THREAD,
  INSERT_TURN,
} from "./inserts.js";
import {
  activityWithPayload,
  activityWithoutPayload,
  completedTurn,
  fullCheckpoint,
  fullDelegation,
  fullMessage,
  fullThread,
  queuedTurn,
  sparseCheckpoint,
  sparseDelegation,
  sparseMessage,
  sparseThread,
} from "./fixtures.js";
import { insertRow, openForTest, temporaryRoot, underBun } from "./support.js";

/** A store with both thread fixtures, since every child row needs its thread. */
function storeWithThreads(): Database {
  const db = openForTest(temporaryRoot("roundtrip"));
  insertRow(db, INSERT_THREAD, encodeThread(fullThread()));
  insertRow(db, INSERT_THREAD, encodeThread(sparseThread()));
  return db;
}

describe.skipIf(!underBun)("row round trip", () => {
  it("reads a thread back with every field set, and one with none of the optional ones", () => {
    const db = storeWithThreads();
    const full = fullThread();
    const sparse = sparseThread();
    const read = (id: string) => decodeThread(db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id)!);
    expect(read(full.id)).toEqual(full);
    expect(read(sparse.id)).toEqual(sparse);
  });

  it("keeps turn order and every queue, handoff, owner and usage field", () => {
    const db = storeWithThreads();
    const completed = completedTurn();
    const queued = queuedTurn();
    insertRow(db, INSERT_TURN, encodeTurn(completed));
    insertRow(db, INSERT_TURN, encodeTurn(queued));

    const rows = db.query<TurnRow, []>("SELECT * FROM turns ORDER BY seq").all();
    expect(rows.map((row) => decodeTurn(row))).toEqual([completed, queued]);
  });

  it("reads messages back with unicode, newlines, attachments and notification facts", () => {
    const db = storeWithThreads();
    const full = fullMessage();
    const sparse = sparseMessage();
    insertRow(db, INSERT_MESSAGE, encodeMessage(full));
    insertRow(db, INSERT_MESSAGE, encodeMessage(sparse));

    const rows = db.query<MessageRow, []>("SELECT * FROM messages ORDER BY seq").all();
    expect(rows.map((row) => decodeMessage(row))).toEqual([full, sparse]);
  });

  it("reads an activity payload back, including a large one, and a row with none", () => {
    const db = storeWithThreads();
    const large = {
      ...activityWithPayload({
        tool: "write",
        state: { input: { path: "ünïcode.ts", content: "ü".repeat(60_000), lines: Array.from({ length: 40 }, (_, i) => `línea ${i}`) } },
      }),
      id: "act-3",
    };
    const small = { ...activityWithPayload(), id: "act-1" };
    const none = activityWithoutPayload();
    for (const activity of [small, large, none]) insertRow(db, INSERT_ACTIVITY, encodeActivity(activity));

    const rows = db.query<ActivityRow, []>("SELECT * FROM activities ORDER BY seq").all();
    expect(rows.map((row) => decodeActivity(row))).toEqual([small, large, none]);
    expect(db.query<{ type: string }, []>("SELECT typeof(payload) AS type FROM activities WHERE payload IS NOT NULL LIMIT 1").get()).toEqual({
      type: "blob",
    });
  });

  it("reads checkpoints back with and without files, refs and a base", () => {
    const db = storeWithThreads();
    const full = fullCheckpoint();
    const sparse = sparseCheckpoint();
    insertRow(db, INSERT_CHECKPOINT, encodeCheckpoint(full));
    insertRow(db, INSERT_CHECKPOINT, encodeCheckpoint(sparse));

    const rows = db.query<CheckpointRow, []>("SELECT * FROM checkpoints ORDER BY seq").all();
    expect(rows.map((row) => decodeCheckpoint(row))).toEqual([full, sparse]);
  });

  it("reads delegations back with and without the review, snapshot and continue fields", () => {
    const db = storeWithThreads();
    const full = fullDelegation();
    const sparse = sparseDelegation();
    insertRow(db, INSERT_DELEGATION, encodeDelegation(full));
    insertRow(db, INSERT_DELEGATION, encodeDelegation(sparse));

    const rows = db.query<DelegationRow, []>("SELECT * FROM delegations ORDER BY created_at, id").all();
    expect(rows.map((row) => decodeDelegation(row))).toEqual([full, sparse]);
  });

  it("stores and reads meta values", () => {
    const db = storeWithThreads();
    insertRow(db, INSERT_META, { key: "engine", value: "sqlite" });
    insertRow(db, INSERT_META, { key: "schema", value: "1" });
    expect(db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta ORDER BY key").all()).toEqual([
      { key: "engine", value: "sqlite" },
      { key: "schema", value: "1" },
    ]);
  });
});

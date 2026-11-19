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

  it("keeps a handoff summary's half-step queue order", () => {
    const db = storeWithThreads();
    insertRow(db, INSERT_TURN, encodeTurn(queuedTurn()));
    const row = db.query<TurnRow, []>("SELECT * FROM turns").get()!;
    expect(decodeTurn(row).queue?.order).toBe(7.5);
    expect(db.query<{ type: string }, []>("SELECT typeof(queue_order) AS type FROM turns").get()).toEqual({ type: "real" });
  });

  it("allows one replay key under two parents, and twice for one parent", () => {
    const db = storeWithThreads();
    const shared = (id: string, parentThreadId: string) => ({ ...fullDelegation(), id, parentThreadId, idempotencyKey: "shared" });
    for (const row of [shared("del-a", "thread-1"), shared("del-b", "thread-2"), shared("del-c", "thread-1")]) {
      insertRow(db, INSERT_DELEGATION, encodeDelegation(row));
    }
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM delegations").get()).toEqual({ count: 3 });
  });

  it("canonicalises explicit nulls, false flags and the seed title source", () => {
    const db = storeWithThreads();

    const thread = { ...sparseThread(), id: "thread-null", hidden: false, titleSource: "seed" as const };
    insertRow(db, INSERT_THREAD, encodeThread(thread));
    const { hidden: _hidden, titleSource: _titleSource, ...expectedThread } = thread;
    expect(decodeThread(db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(thread.id)!)).toEqual(expectedThread);

    const turn = { ...completedTurn(thread.id), id: "turn-null", scheduledFor: null, scheduleReason: null, owner: null, heldAtSettle: false };
    insertRow(db, INSERT_TURN, encodeTurn(turn));
    const { scheduledFor: _scheduledFor, scheduleReason: _scheduleReason, owner: _owner, heldAtSettle: _heldAtSettle, ...expectedTurn } = turn;
    expect(decodeTurn(db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?").get(turn.id)!)).toEqual(expectedTurn);

    const delegation = { ...sparseDelegation(), id: "del-null", baseBranch: null, notify: false };
    insertRow(db, INSERT_DELEGATION, encodeDelegation(delegation));
    const { baseBranch: _baseBranch, notify: _notify, ...expectedDelegation } = delegation;
    expect(decodeDelegation(db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE id = ?").get(delegation.id)!)).toEqual(
      expectedDelegation,
    );
  });

  it("stores free text as well-formed UTF-8 and keeps JSON payloads escaped", () => {
    const db = storeWithThreads();
    const cut = "before \uD83D";
    const message = { ...sparseMessage(), id: "msg-cut", text: cut };
    // Defined at the writer, not left to SQLite's UTF-8 conversion on read.
    expect(encodeMessage(message).text).toBe("before \uFFFD");
    insertRow(db, INSERT_MESSAGE, encodeMessage(message));
    expect(decodeMessage(db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(message.id)!).text).toBe("before \uFFFD");

    // JSON columns escape a lone surrogate, so they keep it exactly.
    const activity = { ...activityWithPayload({ note: cut }), id: "act-cut" };
    insertRow(db, INSERT_ACTIVITY, encodeActivity(activity));
    expect(decodeActivity(db.query<ActivityRow, [string]>("SELECT * FROM activities WHERE id = ?").get(activity.id)!).payload).toEqual({ note: cut });
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

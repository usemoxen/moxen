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
  decodeScalar,
  decodeThread,
  decodeTurn,
  encodeActivity,
  encodeCheckpoint,
  encodeDelegation,
  encodeMessage,
  encodeScalar,
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
  AT,
  MODEL,
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
import type { StoredTurn } from "../../types.js";
import { openThreadStore } from "../../store.js";
import { createThread } from "../../threads.js";
import { noteMessageId } from "../../views.js";

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
    const queued = { ...queuedTurn(), usageRecoveryNotice: true as const };
    insertRow(db, INSERT_TURN, encodeTurn(completed));
    insertRow(db, INSERT_TURN, encodeTurn(queued));

    const rows = db.query<TurnRow, []>("SELECT * FROM turns ORDER BY seq").all();
    expect(rows.map((row) => decodeTurn(row))).toEqual([completed, queued]);
  });

  it("keeps the failed-handoff mark on a turn that never started (MXN-382)", () => {
    const db = storeWithThreads();
    // The queue pass's terminal write for a preparation that failed before a
    // handoff record could be reserved: failed, unstarted, no handoff, marked.
    const failed: StoredTurn = {
      id: "turn-failed-handoff",
      threadId: "thread-1",
      messageId: "msg-failed-handoff",
      status: "failed",
      delivery: "queued",
      runtimeMode: "auto",
      interactionMode: "default",
      modelSelection: null,
      parentTurnId: null,
      handoffFailed: true,
      error: "Handoff preparation failed. Add the entry back to retry.",
      usage: null,
      createdAt: AT,
      updatedAt: AT,
      completedAt: AT,
    };
    insertRow(db, INSERT_TURN, encodeTurn(failed));
    const row = db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?").get(failed.id)!;
    expect(decodeTurn(row)).toEqual(failed);
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

    const rows = db.query<DelegationRow, []>("SELECT * FROM delegations ORDER BY seq").all();
    expect(rows.map((row) => decodeDelegation(row))).toEqual([full, sparse]);
  });

  it("round-trips the review flag and settle generations, and decodes rows without them", () => {
    const db = storeWithThreads();
    const withGenerations = { ...sparseDelegation(), id: "del-gen", reviewTask: true as const, settleGeneration: 3, reportedGeneration: 2 };
    const legacy = { ...sparseDelegation(), id: "del-legacy" };
    insertRow(db, INSERT_DELEGATION, encodeDelegation(withGenerations));
    insertRow(db, INSERT_DELEGATION, encodeDelegation(legacy));
    const read = (id: string) => decodeDelegation(db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE id = ?").get(id)!);
    expect(read(withGenerations.id)).toEqual(withGenerations);
    expect(read(legacy.id)).toEqual(legacy);
    // A row written before these fields carries none in its rest column.
    expect(JSON.parse(db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE id = ?").get(legacy.id)!.rest)).toEqual({});
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

  it("reads delegations in append order, not id order", () => {
    const db = storeWithThreads();
    // Same instant, and the first appended row sorts last by id: only `seq`
    // carries the JSONL order.
    const first = { ...fullDelegation(), id: "zzz-first", createdAt: AT, updatedAt: AT };
    const second = { ...fullDelegation(), id: "aaa-second", createdAt: AT, updatedAt: AT };
    insertRow(db, INSERT_DELEGATION, encodeDelegation(first));
    insertRow(db, INSERT_DELEGATION, encodeDelegation(second));

    expect(db.query<{ id: string }, []>("SELECT id FROM delegations ORDER BY seq").all()).toEqual([{ id: "zzz-first" }, { id: "aaa-second" }]);
    expect(db.query<{ id: string }, []>("SELECT id FROM delegations ORDER BY id").all()).toEqual([{ id: "aaa-second" }, { id: "zzz-first" }]);
    expect(db.query<DelegationRow, []>("SELECT * FROM delegations ORDER BY seq").all().map((row) => decodeDelegation(row))).toEqual([first, second]);
  });

  it("keeps exact scalar keys distinct and finds each by its encoded value", () => {
    const db = storeWithThreads();
    const lone = "a\uD83Db";
    const emoji = "a\u{1F462}b";
    const tilde = "~literal";
    for (const [id, key] of [["del-lone", lone], ["del-emoji", emoji], ["del-tilde", tilde]] as const) {
      insertRow(db, INSERT_DELEGATION, encodeDelegation({ ...sparseDelegation(), id, idempotencyKey: key }));
    }

    expect(encodeScalar(lone)).not.toBe(encodeScalar(emoji));
    const lookup = (key: string) =>
      db.query<{ id: string }, [string]>("SELECT id FROM delegations WHERE idempotency_key = ?").all(encodeScalar(key));
    expect(lookup(lone)).toEqual([{ id: "del-lone" }]);
    expect(lookup(emoji)).toEqual([{ id: "del-emoji" }]);
    expect(lookup(tilde)).toEqual([{ id: "del-tilde" }]);
    // A query with the raw value finds nothing once the value was encoded.
    expect(db.query<{ id: string }, [string]>("SELECT id FROM delegations WHERE idempotency_key = ?").all(lone)).toEqual([]);

    for (const [id, key] of [["del-lone", lone], ["del-emoji", emoji], ["del-tilde", tilde]] as const) {
      const row = db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE id = ?").get(id)!;
      expect(row.idempotency_key).not.toBeNull();
      expect(decodeScalar(row.idempotency_key!)).toBe(key);
      expect(decodeDelegation(row).idempotencyKey).toBe(key);
    }
  });

  it("round-trips model ids, env paths and request keys through the scalar codec", () => {
    const db = storeWithThreads();
    const thread = {
      ...sparseThread(),
      id: "thread-scalar",
      modelSelection: { instanceId: "inst\uD83D", model: "~model" },
      env: { mode: "local" as const, path: "C:\\pa\uD83Dth", branch: "feat~ure" },
    };
    insertRow(db, INSERT_THREAD, encodeThread(thread));
    const threadRow = db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(thread.id)!;
    expect(threadRow.model_id.startsWith("~")).toBe(true);
    expect(decodeThread(threadRow)).toEqual(thread);

    const base = queuedTurn(thread.id);
    const turn = {
      ...base,
      id: "turn-scalar",
      queue: { ...base.queue!, requestId: "req\uD83D" },
      owner: { pid: 7, host: "ho~st" },
    };
    insertRow(db, INSERT_TURN, encodeTurn(turn));
    expect(decodeTurn(db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?").get(turn.id)!)).toEqual(turn);
  });

  it("keeps a sliced emoji exact in display text while the SQL projection is well-formed", () => {
    const db = storeWithThreads();
    const cut = "café \uD83D";

    const message = { ...sparseMessage(), id: "msg-cut", text: cut };
    insertRow(db, INSERT_MESSAGE, encodeMessage(message));
    const messageRow = db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(message.id)!;
    expect(messageRow.text).toBe("café \uFFFD");
    expect(JSON.parse(messageRow.original_text!)).toBe(cut);
    expect(decodeMessage(messageRow).text).toBe(cut);

    const activity = { ...activityWithPayload({ note: "unchanged" }), id: "act-cut", summary: cut };
    insertRow(db, INSERT_ACTIVITY, encodeActivity(activity));
    const activityRow = db.query<ActivityRow, [string]>("SELECT * FROM activities WHERE id = ?").get(activity.id)!;
    expect(activityRow.summary).toBe("café \uFFFD");
    expect(JSON.parse(activityRow.original_summary!)).toBe(cut);
    const decodedActivity = decodeActivity(activityRow);
    expect(decodedActivity.summary).toBe(cut);
    // The payload shape is untouched.
    expect(decodedActivity.payload).toEqual({ note: "unchanged" });

    const thread = { ...sparseThread(), id: "thread-cut", title: cut };
    insertRow(db, INSERT_THREAD, encodeThread(thread));
    const threadRow = db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(thread.id)!;
    expect(threadRow.title).toBe("café \uFFFD");
    expect(JSON.parse(threadRow.rest).originalText).toBe(cut);
    expect(decodeThread(threadRow).title).toBe(cut);

    const delegation = { ...sparseDelegation(), id: "del-cut", prompt: cut };
    insertRow(db, INSERT_DELEGATION, encodeDelegation(delegation));
    const delegationRow = db.query<DelegationRow, [string]>("SELECT * FROM delegations WHERE id = ?").get(delegation.id)!;
    expect(delegationRow.prompt).toBe("café \uFFFD");
    expect(JSON.parse(delegationRow.rest).originalText).toBe(cut);
    expect(decodeDelegation(delegationRow).prompt).toBe(cut);
  });

  it("keeps two delegation rows with the same id in append order", () => {
    const db = storeWithThreads();
    // A legacy ledger can hold two parseable rows with the same id; seq is the
    // identity, and both rows must survive.
    const first = { ...fullDelegation(), id: "dup", childThreadId: "child-a", createdAt: AT, updatedAt: AT };
    const second = { ...fullDelegation(), id: "dup", childThreadId: "child-b", createdAt: AT, updatedAt: AT };
    insertRow(db, INSERT_DELEGATION, encodeDelegation(first));
    insertRow(db, INSERT_DELEGATION, encodeDelegation(second));

    const rows = db.query<DelegationRow, []>("SELECT * FROM delegations ORDER BY seq").all();
    expect(rows.map((row) => decodeDelegation(row))).toEqual([first, second]);
    expect(db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM delegations WHERE id = ?").all("dup")).toEqual([{ count: 2 }]);
  });

  it("keeps two turn rows with the same id in append order", () => {
    const db = storeWithThreads();
    const first = { ...completedTurn(), id: "dup-turn", messageId: "msg-a" };
    const second = { ...completedTurn(), id: "dup-turn", messageId: "msg-b" };
    insertRow(db, INSERT_TURN, encodeTurn(first));
    insertRow(db, INSERT_TURN, encodeTurn(second));

    const rows = db.query<TurnRow, [string, string]>("SELECT * FROM turns WHERE thread_id = ? AND id = ? ORDER BY seq").all(first.threadId, first.id);
    expect(rows.map((row) => decodeTurn(row))).toEqual([first, second]);
    expect(db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM turns WHERE thread_id = ? AND id = ?").all(first.threadId, first.id)).toEqual([
      { count: 2 },
    ]);
  });

  it("keeps two message rows with the same id and different bodies in append order", () => {
    const db = storeWithThreads();
    const first = { ...sparseMessage(), id: "dup-message", text: "note" };
    const second = { ...sparseMessage(), id: "dup-message", text: "different note" };
    insertRow(db, INSERT_MESSAGE, encodeMessage(first));
    insertRow(db, INSERT_MESSAGE, encodeMessage(second));

    const rows = db.query<MessageRow, [string, string]>("SELECT * FROM messages WHERE thread_id = ? AND id = ? ORDER BY seq").all(first.threadId, first.id);
    const decoded = rows.map((row) => decodeMessage(row));
    expect(decoded).toEqual([first, second]);
    expect(db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM messages WHERE thread_id = ? AND id = ?").all(first.threadId, first.id)).toEqual([
      { count: 2 },
    ]);
    // The JSONL reader returns both rows, and a consumer joining by id
    // (`messages.find`) resolves the first in append order.
    expect(decoded.find((message) => message.id === first.id)?.text).toBe("note");
  });

  it("keeps two activity rows with the same id in append order", () => {
    const db = storeWithThreads();
    const first = { ...activityWithoutPayload(), id: "dup-activity", summary: "first" };
    const second = { ...activityWithoutPayload(), id: "dup-activity", summary: "second" };
    insertRow(db, INSERT_ACTIVITY, encodeActivity(first));
    insertRow(db, INSERT_ACTIVITY, encodeActivity(second));

    const rows = db.query<ActivityRow, [string, string]>("SELECT * FROM activities WHERE thread_id = ? AND id = ? ORDER BY seq").all(first.threadId, first.id);
    expect(rows.map((row) => decodeActivity(row))).toEqual([first, second]);
    expect(db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM activities WHERE thread_id = ? AND id = ?").all(first.threadId, first.id)).toEqual([
      { count: 2 },
    ]);
  });

  it("keeps two checkpoint rows with the same id in append order", () => {
    const db = storeWithThreads();
    const first = { ...sparseCheckpoint(), id: "dup-checkpoint", turnId: "turn-a" };
    const second = { ...sparseCheckpoint(), id: "dup-checkpoint", turnId: "turn-b" };
    insertRow(db, INSERT_CHECKPOINT, encodeCheckpoint(first));
    insertRow(db, INSERT_CHECKPOINT, encodeCheckpoint(second));

    const rows = db.query<CheckpointRow, [string, string]>("SELECT * FROM checkpoints WHERE thread_id = ? AND id = ? ORDER BY seq").all(first.threadId, first.id);
    expect(rows.map((row) => decodeCheckpoint(row))).toEqual([first, second]);
    expect(db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM checkpoints WHERE thread_id = ? AND id = ?").all(first.threadId, first.id)).toEqual([
      { count: 2 },
    ]);
  });

  it("keeps a custom project id and provider message ids exact through the legacy writers", async () => {
    const root = temporaryRoot("legacy-ids");
    const legacy = await openThreadStore(root);
    const projectId = "train\uD83D";
    const thread = await createThread(legacy, { projectId, title: "Legacy", modelSelection: MODEL });
    // The real provider-note id: turn id + the provider's own message id.
    const messageIds = [noteMessageId("turn-1", "\uD800"), noteMessageId("turn-1", "\uD801")];
    for (const id of messageIds) {
      await legacy.appendLedger(thread.id, "messages", {
        id,
        threadId: thread.id,
        turnId: "turn-1",
        role: "assistant",
        text: "note",
        createdAt: AT,
      });
    }
    const record = await legacy.readThreadRecord(thread.id);
    const messages = await legacy.readMessages(thread.id);
    expect(record?.projectId).toBe(projectId);
    expect(messages.map((message) => message.id)).toEqual(messageIds);

    const db = openForTest(root);
    insertRow(db, INSERT_THREAD, encodeThread(record!));
    for (const message of messages) insertRow(db, INSERT_MESSAGE, encodeMessage(message));
    const turn = { ...completedTurn(thread.id), id: "turn-1", messageId: messageIds[0]! };
    insertRow(db, INSERT_TURN, encodeTurn(turn));

    const threadRow = db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(thread.id)!;
    expect(threadRow.project_id).not.toBe(projectId);
    expect(decodeScalar(threadRow.project_id)).toBe(projectId);
    expect(decodeThread(threadRow).projectId).toBe(projectId);
    expect(db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM threads WHERE project_id = ?").all(encodeScalar(projectId))).toEqual([
      { count: 1 },
    ]);
    expect(db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM threads WHERE project_id = ?").all(projectId)).toEqual([{ count: 0 }]);

    const rows = db.query<MessageRow, []>("SELECT * FROM messages ORDER BY seq").all();
    expect(rows.map((row) => decodeMessage(row).id)).toEqual(messageIds);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    for (const [index, id] of messageIds.entries()) {
      expect(decodeScalar(rows[index]!.id)).toBe(id);
      expect(db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE id = ?").all(encodeScalar(id))).toEqual([{ id: rows[index]!.id }]);
      // The exact original is not stored raw: a predicate on it finds nothing.
      expect(db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE id = ?").all(id)).toEqual([]);
    }

    const turnRow = db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?").get("turn-1")!;
    expect(decodeTurn(turnRow).messageId).toBe(messageIds[0]);
    const decodedMessages = rows.map((row) => decodeMessage(row));
    expect(decodedMessages.find((message) => message.id === decodeTurn(turnRow).messageId)?.id).toBe(messageIds[0]);
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

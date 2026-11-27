/**
 * The JSONL importer (MXN-393). The source is written by the production JSONL
 * writers (plus raw lines where a crash or a hand edit is the point), and what
 * lands is compared with what the JSONL readers return for the same files: the
 * import is faithful when SQLite answers like the store it replaces.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Database } from "bun:sqlite";

import { openThreadStore, type ThreadStore } from "../../store.js";
import { importJsonlStore, type ImportStep } from "../import.js";
import { storeDatabasePath } from "../connection.js";
import {
  decodeActivity,
  decodeCheckpoint,
  decodeDelegation,
  decodeMessage,
  decodeThread,
  decodeTurn,
  encodeScalar,
  type ActivityRow,
  type CheckpointRow,
  type DelegationRow,
  type MessageRow,
  type ThreadRow,
  type TurnRow,
} from "../records.js";
import {
  activityWithPayload,
  activityWithoutPayload,
  completedTurn,
  everyMessage,
  everyTurn,
  fullCheckpoint,
  fullDelegation,
  fullMessage,
  fullThread,
  sparseDelegation,
  sparseThread,
} from "./fixtures.js";
import { openForTest, startChild, temporaryRoot, underBun } from "./support.js";

const LONE = "\ud83e";
const IDS = ["thread-1", "thread-2", "thread-3", "thread-4"] as const;

/** A store with four threads, repeated ids, exact keys and sliced text. */
async function sourceStore(label: string): Promise<{ root: string; store: ThreadStore }> {
  const root = temporaryRoot(label);
  const store = await openThreadStore(root);
  await store.writeThreadRecord({ ...fullThread(), title: `sliced ${LONE}`, projectId: `custom ${LONE}` });
  await store.writeThreadRecord(sparseThread());
  for (const id of ["thread-3", "thread-4"]) await store.writeThreadRecord({ ...sparseThread(), id, title: id });

  await store.appendLedger("thread-1", "turns", everyTurn());
  await store.appendLedger("thread-1", "turns", completedTurn());
  // The JSONL writers never check ids: the same one, twice, with different bodies.
  await store.appendLedger("thread-1", "turns", { ...completedTurn(), delivery: "injected" });
  await store.appendLedger("thread-1", "messages", everyMessage());
  await store.appendLedger("thread-1", "messages", { ...fullMessage(), id: `msg-${LONE}`, text: `cut ${LONE}` });
  await store.appendLedger("thread-1", "messages", { ...fullMessage(), text: "first body" });
  await store.appendLedger("thread-1", "messages", { ...fullMessage(), text: "second body, same id" });
  await store.appendLedger("thread-1", "activity", { ...activityWithPayload(), summary: `sum ${LONE}` });
  await store.appendLedger("thread-1", "activity", activityWithoutPayload());
  await store.appendLedger("thread-1", "activity", activityWithoutPayload());
  await store.appendLedger("thread-1", "checkpoints", fullCheckpoint());
  await store.appendLedger("thread-1", "checkpoints", fullCheckpoint());
  for (const id of ["thread-2", "thread-3", "thread-4"]) {
    await store.appendLedger(id, "turns", { ...completedTurn(id), id: `turn-${id}` });
    await store.appendLedger(id, "messages", { ...fullMessage(), id: `msg-${id}`, threadId: id });
  }
  await store.appendDelegation({ ...fullDelegation(), idempotencyKey: `key ${LONE}` });
  await store.appendDelegation(sparseDelegation());
  await store.appendDelegation({ ...fullDelegation(), childThreadId: "thread-3", prompt: "the retry, same id" });
  return { root, store };
}

/** Every file of the JSONL store, byte for byte, with when it last changed. */
function jsonlTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (file: string): void => {
    out[path.relative(root, file)] = `${statSync(file).mtimeMs}:${readFileSync(file).toString("base64")}`;
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else add(path.join(dir, entry.name));
    }
  };
  walk(path.join(root, "threads"));
  add(path.join(root, "store.json"));
  add(path.join(root, "delegations.jsonl"));
  return out;
}

const open = (root: string): Database => openForTest(root);

function meta(db: Database): Record<string, string> {
  return Object.fromEntries(db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]));
}

function count(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count;
}

const TABLES = ["threads", "turns", "messages", "activities", "checkpoints", "delegations", "quarantine"] as const;
const counts = (db: Database): Record<string, number> => Object.fromEntries(TABLES.map((table) => [table, count(db, table)]));

/** Every row of every table in insert order, without what a re-run may change (row ids, quarantine times). */
function dump(db: Database): Record<string, unknown[]> {
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      db
        .query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY ${table === "threads" ? "id" : table === "quarantine" ? "table_name, row_json" : "seq"}`)
        .all()
        .map(({ seq: _seq, at: _at, ...row }) => row),
    ]),
  );
}

const rowsOf = <Row>(db: Database, table: string, threadId: string): Row[] =>
  db.query<Row, [string]>(`SELECT * FROM ${table} WHERE thread_id = ? ORDER BY seq`).all(threadId);

/** SQLite answers exactly what the JSONL readers answer, thread by thread, in append order. */
async function expectParity(db: Database, store: ThreadStore, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    expect(decodeThread(db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id)!)).toEqual(await store.readThreadRecord(id));
    expect(rowsOf<TurnRow>(db, "turns", id).map(decodeTurn)).toEqual(await store.readTurns(id));
    expect(rowsOf<MessageRow>(db, "messages", id).map(decodeMessage)).toEqual(await store.readMessages(id));
    expect(rowsOf<ActivityRow>(db, "activities", id).map(decodeActivity)).toEqual(await store.readActivities(id));
    expect(rowsOf<CheckpointRow>(db, "checkpoints", id).map(decodeCheckpoint)).toEqual(await store.readCheckpoints(id));
  }
}

const delegationsOf = (db: Database) => db.query<DelegationRow, []>("SELECT * FROM delegations ORDER BY seq").all().map(decodeDelegation);

const SOURCE_COUNTS = { threads: 4, turns: 6, messages: 7, activities: 3, checkpoints: 2, delegations: 3 };
const asTables = (live: Record<keyof typeof SOURCE_COUNTS, number>) =>
  Object.fromEntries(Object.entries(live).map(([table, value]) => [table, { source: value, imported: value, quarantined: 0 }]));

interface Quarantined {
  table_name: string;
  reason: string;
  row_json: string;
}

function quarantine(db: Database): Array<{ table: string; reason: string; origin: string; threadId: string | null; file: string; line: number | null; raw: string }> {
  return db
    .query<Quarantined, []>("SELECT table_name, reason, row_json FROM quarantine WHERE reason <> 'other' ORDER BY rowid")
    .all()
    .map((row) => ({ table: row.table_name, reason: row.reason, ...(JSON.parse(row.row_json) as { origin: string; threadId: string | null; file: string; line: number | null; raw: string }) }));
}

describe.skipIf(!underBun)("importing the JSONL store", () => {
  it("imports every record in append order, repeated ids included, and leaves the JSONL files alone", async () => {
    const { root, store } = await sourceStore("import-roundtrip");
    const before = jsonlTree(root);

    const report = await importJsonlStore(root, { clock: () => Date.parse("2026-11-27T10:00:00.000Z") });

    expect(report.tables).toEqual(asTables(SOURCE_COUNTS));
    expect(report.quarantined).toBe(0);
    expect(report.database).toBe(storeDatabasePath(root));
    expect(jsonlTree(root)).toEqual(before);
    expect(JSON.parse(readFileSync(path.join(root, "store.json"), "utf8"))).toEqual({ formatVersion: 1 });
    const db = open(root);
    expect(counts(db)).toEqual({ ...SOURCE_COUNTS, quarantine: 0 });
    await expectParity(db, store, IDS);
    expect(delegationsOf(db)).toEqual(await store.readDelegations());
    // Two rows, one id: both there, the first occurrence first.
    expect(rowsOf<MessageRow>(db, "messages", "thread-1").filter((row) => row.id === "msg-1").map((row) => row.text)).toEqual(["first body", "second body, same id"]);
    expect(db.query<{ child_thread_id: string }, []>("SELECT child_thread_id FROM delegations WHERE id = 'del-1' ORDER BY seq").all().map((row) => row.child_thread_id)).toEqual(["thread-2", "thread-3"]);
    // Exact scalar keys are found by their encoded form; display text is well formed and its original kept.
    expect(db.query<{ id: string }, [string]>("SELECT id FROM threads WHERE project_id = ?").get(encodeScalar(`custom ${LONE}`))).toEqual({ id: "thread-1" });
    expect(db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM delegations WHERE idempotency_key = ?").get(encodeScalar(`key ${LONE}`))).toEqual({ n: 1 });
    expect(db.query<{ title: string }, []>("SELECT title FROM threads WHERE id = 'thread-1'").get()).toEqual({ title: "sliced �" });
    expect(meta(db)).toMatchObject({ engine: "sqlite", import_state: "complete", imported_at: "2026-11-27T10:00:00.000Z" });
    expect(JSON.parse(meta(db).source_rows!)).toEqual(report.tables);
  });

  it("quarantines torn, unreadable and invalid records with their reason and bytes, and imports the rest", async () => {
    const { root, store } = await sourceStore("import-bad");
    const ledger = (id: string, name: string): string => path.join(root, "threads", id, name);
    const noStatus = JSON.stringify({ ...completedTurn("thread-2"), id: "turn-no-status", status: undefined });
    appendFileSync(ledger("thread-2", "turns.jsonl"), `not json\n{"threadId":"thread-2"}\n${noStatus}\n`);
    // A number where text belongs: a STRICT table would convert it, not refuse it.
    const numberText = JSON.stringify({ ...fullMessage(), id: "msg-number", threadId: "thread-2", text: 5 });
    const foreign = JSON.stringify({ ...fullMessage(), id: "msg-foreign", threadId: "thread-1" });
    appendFileSync(ledger("thread-2", "messages.jsonl"), `${numberText}\n${foreign}\n{"id":"torn`);
    appendFileSync(path.join(root, "delegations.jsonl"), `{"id":"del-bad"}\n{"id":"del-torn`);

    // A thread from before every record carried a model, ledgers and all.
    const { modelSelection: _model, ...old } = { ...sparseThread(), id: "old-thread" };
    const oldTurn = JSON.stringify({ ...completedTurn("old-thread"), id: "old-turn" });
    mkdirSync(path.dirname(ledger("old-thread", "x")), { recursive: true });
    writeFileSync(ledger("old-thread", "thread.json"), `${JSON.stringify(old)}\n`);
    writeFileSync(ledger("old-thread", "turns.jsonl"), `${oldTurn}\n`);
    mkdirSync(path.dirname(ledger("broken-thread", "x")), { recursive: true });
    writeFileSync(ledger("broken-thread", "thread.json"), "{ half a record");
    // Ledger lines with no record at all, and a folder with nothing in it.
    mkdirSync(path.dirname(ledger("orphan-thread", "x")), { recursive: true });
    writeFileSync(ledger("orphan-thread", "messages.jsonl"), `${foreign}\n`);
    mkdirSync(path.dirname(ledger("empty-thread", "x")), { recursive: true });
    const before = jsonlTree(root);

    const report = await importJsonlStore(root);

    expect(report.tables).toEqual({
      threads: { source: 7, imported: 4, quarantined: 3 },
      turns: { source: 10, imported: 6, quarantined: 4 },
      messages: { source: 11, imported: 7, quarantined: 4 },
      activities: { source: 3, imported: 3, quarantined: 0 },
      checkpoints: { source: 2, imported: 2, quarantined: 0 },
      delegations: { source: 5, imported: 3, quarantined: 2 },
    });
    expect(report.quarantined).toBe(13);
    expect(jsonlTree(root)).toEqual(before);
    const db = open(root);
    expect(counts(db)).toEqual({ ...SOURCE_COUNTS, quarantine: 13 });
    expect(meta(db).import_state).toBe("complete");
    const aside = quarantine(db);
    expect(aside.every((row) => row.origin === "jsonl-import")).toBe(true);
    expect(aside.map((row) => [row.file, row.line, row.table, row.reason])).toEqual([
      ["threads/broken-thread/thread.json", null, "threads", "thread.json is not valid JSON"],
      ["threads/old-thread/thread.json", null, "threads", "invalid thread record: missing modelSelection"],
      ["threads/old-thread/turns.jsonl", 1, "turns", "its thread record is quarantined"],
      ["threads/orphan-thread/thread.json", null, "threads", "thread has no thread.json"],
      ["threads/orphan-thread/messages.jsonl", 1, "messages", "its thread record is quarantined"],
      ["threads/thread-2/turns.jsonl", 2, "turns", "line is not valid JSON"],
      ["threads/thread-2/turns.jsonl", 3, "turns", "line has no row id"],
      ["threads/thread-2/turns.jsonl", 4, "turns", "invalid record: missing status"],
      ["threads/thread-2/messages.jsonl", 2, "messages", "invalid record: invalid text"],
      ["threads/thread-2/messages.jsonl", 3, "messages", "invalid record: its threadId does not match its thread folder"],
      ["threads/thread-2/messages.jsonl", 4, "messages", "line is not valid JSON"],
      ["delegations.jsonl", 4, "delegations", "invalid record: missing parentThreadId"],
      ["delegations.jsonl", 5, "delegations", "line is not valid JSON"],
    ]);
    expect(aside.find((row) => row.file === "threads/old-thread/turns.jsonl")!.raw).toBe(oldTurn);
    expect(aside.find((row) => row.line === 4 && row.table === "messages")!.raw).toBe('{"id":"torn');
    expect(JSON.parse(aside.find((row) => row.threadId === "old-thread" && row.line === null)!.raw)).toEqual(old);
    // The valid rows beside the bad ones are all there.
    expect(rowsOf<TurnRow>(db, "turns", "thread-2").map((row) => row.id)).toEqual(["turn-thread-2"]);
    expect(rowsOf<MessageRow>(db, "messages", "thread-2").map((row) => row.id)).toEqual(["msg-thread-2"]);
    await expectParity(db, store, ["thread-1", "thread-3", "thread-4"]);
    // The reader also returns the id-only row, which is not a delegation.
    expect(delegationsOf(db)).toEqual((await store.readDelegations()).filter((row) => row.id !== "del-bad"));
  });

  it("resumes after the process is killed inside a thread's transaction", async () => {
    const { root, store } = await sourceStore("import-crash");
    // A quarantined line in a thread that commits before the crash must not double on resume.
    appendFileSync(path.join(root, "threads", "thread-1", "turns.jsonl"), "not json\n");

    const crasher = startChild(path.join(__dirname, "fixtures", "import-crasher.ts"), [root, "thread-3"]);
    expect(await crasher.exited).not.toBe(0);

    const halfway = open(root);
    expect(meta(halfway)).toEqual({ engine: "sqlite", schema: expect.any(String), import_state: "running" });
    // Two whole threads; the third's open transaction left nothing, and the ledger never started.
    expect(halfway.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map((row) => row.id)).toEqual(["thread-1", "thread-2"]);
    expect(counts(halfway)).toEqual({ threads: 2, turns: 4, messages: 5, activities: 3, checkpoints: 2, delegations: 0, quarantine: 1 });
    halfway.close();

    const report = await importJsonlStore(root);

    expect(report.tables.turns).toEqual({ source: 7, imported: 6, quarantined: 1 });
    expect(report.quarantined).toBe(1);
    const db = open(root);
    expect(counts(db)).toEqual({ ...SOURCE_COUNTS, quarantine: 1 });
    expect(meta(db).import_state).toBe("complete");
    await expectParity(db, store, IDS);
    expect(delegationsOf(db)).toEqual(await store.readDelegations());
  });

  it("stays running when the delegations transaction fails, keeping none of it", async () => {
    const { root } = await sourceStore("import-delegations");
    const fail = (step: ImportStep): void => {
      if (step.phase === "before-commit" && step.threadId === null) throw new Error("disk went away");
    };
    await expect(importJsonlStore(root, { onStep: fail })).rejects.toThrow("disk went away");
    const db = open(root);
    expect(counts(db)).toEqual({ ...SOURCE_COUNTS, delegations: 0, quarantine: 0 });
    expect(meta(db).import_state).toBe("running");
  });

  it("stops between threads when aborted, and completes on the next run", async () => {
    const { root } = await sourceStore("import-abort");
    const abort = new AbortController();
    await expect(
      importJsonlStore(root, { signal: abort.signal, onStep: (step) => void (step.phase === "committed" && abort.abort()) }),
    ).rejects.toThrow(expect.objectContaining({ code: "STORE_IMPORT_INTERRUPTED" }));
    const db = open(root);
    expect(count(db, "threads")).toBe(1);
    expect(meta(db).import_state).toBe("running");
    db.close();
    expect((await importJsonlStore(root)).tables).toEqual(asTables(SOURCE_COUNTS));
  });

  it("is idempotent, and a later run mirrors what the JSONL store holds by then", async () => {
    const { root, store } = await sourceStore("import-again");
    const turns = path.join(root, "threads", "thread-2", "turns.jsonl");
    appendFileSync(turns, "not json\n");
    appendFileSync(path.join(root, "delegations.jsonl"), "also not json\n");
    const first = await importJsonlStore(root);
    const db = open(root);
    // A quarantine row the importer did not write is not its to replace.
    db.exec("INSERT INTO quarantine VALUES ('2026-11-27T00:00:00.000Z', 'other', 'turns', 'not even json')");
    const once = dump(db);

    const second = await importJsonlStore(root);

    // The foreign row is outside the importer's counts, so it does not fail verification either.
    expect(second.tables).toEqual(first.tables);
    expect(dump(db)).toEqual(once);

    // The bad line is repaired, a thread disappears, and another's record goes bad.
    writeFileSync(turns, `${readFileSync(turns, "utf8").split("\n")[0]}\n`);
    rmSync(path.join(root, "threads", "thread-3"), { recursive: true });
    writeFileSync(path.join(root, "threads", "thread-4", "thread.json"), "torn");
    const third = await importJsonlStore(root);

    expect(third.tables.threads).toEqual({ source: 3, imported: 2, quarantined: 1 });
    expect(counts(db)).toEqual({ threads: 2, turns: 4, messages: 5, activities: 3, checkpoints: 2, delegations: 3, quarantine: 5 });
    expect(quarantine(db).map((row) => [row.file, row.line])).toEqual([
      ["threads/thread-4/thread.json", null],
      ["threads/thread-4/turns.jsonl", 1],
      ["threads/thread-4/messages.jsonl", 1],
      ["delegations.jsonl", 4],
    ]);
    await expectParity(db, store, ["thread-1", "thread-2"]);
  });

  it("does not mark an import complete when the rows do not match what it read", async () => {
    const { root } = await sourceStore("import-mismatch");
    const lose = (step: ImportStep): void => {
      if (step.phase !== "committed" || step.threadId !== null) return;
      const other = openForTest(root);
      other.exec("DELETE FROM messages WHERE thread_id = 'thread-2'");
      other.close();
    };
    await expect(importJsonlStore(root, { onStep: lose })).rejects.toThrow(
      expect.objectContaining({ code: "STORE_IMPORT_MISMATCH", message: expect.stringContaining("messages: 6 rows, expected 7") }),
    );
    expect(meta(open(root)).import_state).toBe("running");
  });

  it("stops on a file it cannot read instead of quarantining what it never saw", async () => {
    const { root } = await sourceStore("import-unreadable");
    const file = path.join(root, "threads", "thread-3", "activity.jsonl");
    mkdirSync(file);
    await expect(importJsonlStore(root)).rejects.toThrow(expect.objectContaining({ code: "STORE_IMPORT_READ_FAILED", details: { file } }));
    expect(meta(open(root)).import_state).toBe("running");
  });

  it.each([
    ["a newer store, which is what a cut-over store will say", '{"formatVersion":2}', "FORMAT_TOO_NEW"],
    ["a version older than any the store ever had", '{"formatVersion":0}', "INVALID_FORMAT_VERSION"],
    ["an unreadable marker", "not json", "INVALID_FORMAT_VERSION"],
  ])("refuses %s before creating or changing a database", async (_what, marker, code) => {
    const { root } = await sourceStore("import-refused");
    writeFileSync(path.join(root, "store.json"), marker);
    await expect(importJsonlStore(root)).rejects.toThrow(expect.objectContaining({ code }));
    expect(readdirSync(root).filter((name) => name.startsWith("store.db"))).toEqual([]);
  });
});

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openThreadStore } from "../store.js";
import { createThread, completeTurn, inspectThread, interruptTurn, listThreads, sendTurn, turnProblems } from "../threads.js";

const MODEL = { instanceId: "claude", model: "test-model" };

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function testStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-store-problems-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await openThreadStore(root);
  return { root, store };
}

describe("bad store records", () => {
  it("skips a corrupt thread record when listing instead of failing the whole list", async () => {
    const { root, store } = await testStore();
    const good = await createThread(store, { projectId: "project-1", title: "Good", modelSelection: MODEL });
    const bad = await createThread(store, { projectId: "project-1", title: "Bad", modelSelection: MODEL });
    await writeFile(path.join(root, "threads", bad.id, "thread.json"), "{not json", "utf8");

    expect((await listThreads(store)).map((row) => row.id)).toEqual([good.id]);
    const problems = store.storeProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "thread-record", threadId: bad.id, file: path.join(root, "threads", bad.id, "thread.json") });
  });

  it("reads a corrupt thread record as missing", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Bad", modelSelection: MODEL });
    await writeFile(path.join(root, "threads", thread.id, "thread.json"), "{not json", "utf8");

    await expect(inspectThread(store, thread.id)).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect(store.storeProblems().map((problem) => problem.kind)).toEqual(["thread-record"]);
  });

  it("skips a bad ledger line and reports its file and line number", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Ledger", modelSelection: MODEL });
    await store.appendLedger(thread.id, "messages", { id: "m1", threadId: thread.id, turnId: "t1", role: "user", text: "hi", createdAt: store.nowIso() });
    await appendFile(path.join(root, "threads", thread.id, "messages.jsonl"), "{not json\n", "utf8");

    expect((await store.readMessages(thread.id)).map((message) => message.id)).toEqual(["m1"]);
    const problems = store.storeProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "ledger-line", threadId: thread.id, file: path.join(root, "threads", thread.id, "messages.jsonl"), line: 2 });
  });

  it("skips a bad delegation line instead of hiding every task", async () => {
    const { root, store } = await testStore();
    await store.appendDelegation({ id: "d1", parentThreadId: "p", childThreadId: "c", prompt: "do it", status: "running", createdAt: store.nowIso(), updatedAt: store.nowIso() });
    await appendFile(path.join(root, "delegations.jsonl"), "oops\n", "utf8");

    expect((await store.readDelegations()).map((row) => row.id)).toEqual(["d1"]);
    const problems = store.storeProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "delegation-line", file: path.join(root, "delegations.jsonl"), line: 2 });
  });

  it("reports the same bad record only once", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Bad", modelSelection: MODEL });
    await writeFile(path.join(root, "threads", thread.id, "thread.json"), "{not json", "utf8");

    await listThreads(store);
    await listThreads(store);
    expect(store.storeProblems()).toHaveLength(1);
  });

  it("rejects a thread record saved under the wrong id", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Swapped", modelSelection: MODEL });
    await mkdir(path.join(root, "threads", "other"), { recursive: true });
    await writeFile(path.join(root, "threads", "other", "thread.json"), JSON.stringify({ ...thread, id: thread.id }), "utf8");

    expect(await store.readThreadRecord("other")).toBeNull();
    expect(store.storeProblems().map((problem) => problem.kind)).toEqual(["thread-record"]);
  });

  it("moves a bad ledger line aside, keeping the rest and the original", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Ledger", modelSelection: MODEL });
    await store.appendLedger(thread.id, "messages", { id: "m1", threadId: thread.id, turnId: "t1", role: "user", text: "hi", createdAt: store.nowIso() });
    await appendFile(path.join(root, "threads", thread.id, "messages.jsonl"), "{not json\n", "utf8");
    await store.appendLedger(thread.id, "messages", { id: "m2", threadId: thread.id, turnId: "t1", role: "user", text: "yo", createdAt: store.nowIso() });
    expect((await store.readMessages(thread.id)).map((message) => message.id)).toEqual(["m1", "m2"]);
    const [problem] = store.storeProblems();
    expect(problem?.kind).toBe("ledger-line");

    const { movedTo } = await store.quarantineProblem(problem!.id);
    expect(movedTo.startsWith(path.join(root, "quarantine") + path.sep)).toBe(true);
    expect((await store.readMessages(thread.id)).map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(store.storeProblems()).toEqual([]);
  });

  it("moves a corrupt thread record aside so the thread reads as missing", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Bad", modelSelection: MODEL });
    await writeFile(path.join(root, "threads", thread.id, "thread.json"), "{not json", "utf8");
    await listThreads(store);
    const [problem] = store.storeProblems();

    await store.quarantineProblem(problem!.id);
    expect(await store.readThreadRecord(thread.id)).toBeNull();
    expect(store.storeProblems()).toEqual([]);
  });

  it("refuses a quarantine for a problem that is already fixed, and drops the warning", async () => {    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Fixed", modelSelection: MODEL });
    const file = path.join(root, "threads", thread.id, "thread.json");
    const saved = await readFile(file, "utf8");
    await writeFile(file, "{not json", "utf8");
    await listThreads(store);
    expect(store.storeProblems()).toHaveLength(1);
    // Fixed by hand since: quarantining reports stale and drops the warning.
    await writeFile(file, saved, "utf8");
    const [problem] = store.storeProblems();
    await expect(store.quarantineProblem(problem!.id)).rejects.toMatchObject({ code: "PROBLEM_STALE" });
    expect(store.storeProblems()).toEqual([]);
  });

  it("refuses a quarantine for a stuck turn and names the fix instead", async () => {
    const { store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Stuck", modelSelection: MODEL });
    store.noteProblem({ kind: "turn-ownerless", threadId: thread.id, turnId: "t", file: store.turnsFile(thread.id), message: "stuck" });
    const [problem] = store.storeProblems();
    await expect(store.quarantineProblem(problem!.id)).rejects.toMatchObject({ code: "PROBLEM_NOT_QUARANTINED" });
    await expect(store.quarantineProblem("no-such-id")).rejects.toMatchObject({ code: "PROBLEM_NOT_FOUND" });
  });

  it("spots a running turn no process owns, and clearing it when it stops", async () => {    const { store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Stuck", modelSelection: MODEL });
    const sent = await sendTurn(store, thread.id, { prompt: "one" });
    // A running turn the store never tracked and no process owns: nothing will settle it.
    await store.rewriteLedger(thread.id, "turns", (await store.readTurns(thread.id)).map((turn) => ({ ...turn, owner: undefined })));
    const found = turnProblems(store, thread.id, await store.readTurns(thread.id));
    expect(found.map((problem) => problem.kind)).toEqual(["turn-ownerless"]);
    store.replaceTurnProblems(thread.id, found);
    expect(store.storeProblems()).toHaveLength(1);
    await interruptTurn(store, thread.id, sent.turn.id);
    store.replaceTurnProblems(thread.id, turnProblems(store, thread.id, await store.readTurns(thread.id)));
    expect(store.storeProblems()).toEqual([]);
  });

  it("updateTurn keeps a bad turns line byte-for-byte", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Turns", modelSelection: MODEL });
    const sent = await sendTurn(store, thread.id, { prompt: "one" });
    const bad = "{not json\n";
    await appendFile(path.join(root, "threads", thread.id, "turns.jsonl"), bad, "utf8");
    await store.readTurns(thread.id);

    const updated = await store.updateTurn(thread.id, sent.turn.id, { error: "boom" });
    expect(updated?.error).toBe("boom");
    const raw = await readFile(path.join(root, "threads", thread.id, "turns.jsonl"), "utf8");
    expect(raw).toContain(bad.trim());
    expect(raw.split("\n").filter((line) => line === bad.trim())).toHaveLength(1);
    // The surviving bad line is still reported, at its line.
    expect(store.storeProblems()).toMatchObject([{ kind: "ledger-line", threadId: thread.id, line: 2 }]);
  });

  it("rewriteLedger keeps bad lines while dropping and updating good rows", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Rewrite", modelSelection: MODEL });
    const first = await sendTurn(store, thread.id, { prompt: "one" });
    const second = await sendTurn(store, thread.id, { prompt: "two", delivery: "queue" });
    const bad = "{oops\n";
    await appendFile(path.join(root, "threads", thread.id, "turns.jsonl"), bad, "utf8");
    await store.readTurns(thread.id);

    await store.rewriteLedger(thread.id, "turns", [{ ...second.turn, delivery: "started" as const }]);
    const raw = await readFile(path.join(root, "threads", thread.id, "turns.jsonl"), "utf8");
    expect(raw).toContain(bad.trim());
    expect(raw).not.toContain(first.turn.id);
    const rows = await store.readTurns(thread.id);
    expect(rows.map((turn) => turn.id)).toEqual([second.turn.id]);
    expect(rows[0]).toMatchObject({ delivery: "started" });
    expect(store.storeProblems()).toMatchObject([{ kind: "ledger-line", threadId: thread.id }]);
  });

  it("updateDelegation keeps a bad delegation line", async () => {
    const { root, store } = await testStore();
    await store.appendDelegation({ id: "d1", parentThreadId: "p", childThreadId: "c", prompt: "do it", status: "running", createdAt: store.nowIso(), updatedAt: store.nowIso() });
    const bad = "oops\n";
    await appendFile(path.join(root, "delegations.jsonl"), bad, "utf8");
    await store.appendDelegation({ id: "d2", parentThreadId: "p", childThreadId: "c2", prompt: "do that", status: "running", createdAt: store.nowIso(), updatedAt: store.nowIso() });
    await store.readDelegations();

    const updated = await store.updateDelegation("d1", { status: "completed" });
    expect(updated?.status).toBe("completed");
    const raw = await readFile(path.join(root, "delegations.jsonl"), "utf8");
    expect(raw).toContain(bad.trim());
    expect((await store.readDelegations()).map((row) => row.id)).toEqual(["d1", "d2"]);
    expect(store.storeProblems()).toMatchObject([{ kind: "delegation-line", file: path.join(root, "delegations.jsonl") }]);
  });

  it("updateDelegations keeps a bad delegation line", async () => {
    const { root, store } = await testStore();
    await store.appendDelegation({ id: "d1", parentThreadId: "p", childThreadId: "c", prompt: "do it", status: "running", createdAt: store.nowIso(), updatedAt: store.nowIso() });
    const bad = "oops\n";
    await appendFile(path.join(root, "delegations.jsonl"), bad, "utf8");
    await store.readDelegations();

    await store.updateDelegations([{ id: "d1", patch: { status: "failed" } }]);
    const raw = await readFile(path.join(root, "delegations.jsonl"), "utf8");
    expect(raw).toContain(bad.trim());
    expect((await store.readDelegations()).map((row) => row.status)).toEqual(["failed"]);
  });

  it("batching queued turns keeps a bad messages line", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Batch", modelSelection: MODEL });
    const running = await sendTurn(store, thread.id, { prompt: "work" });
    await sendTurn(store, thread.id, { prompt: "then a", delivery: "queue" });
    await sendTurn(store, thread.id, { prompt: "then b", delivery: "queue" });
    const bad = "{not json\n";
    await appendFile(path.join(root, "threads", thread.id, "messages.jsonl"), bad, "utf8");
    await store.readMessages(thread.id);

    await completeTurn(store, thread.id, running.turn.id, { text: "done" });
    // The batch ran (one running turn, no queued ones left) and the bad line survived it.
    const turns = await store.readTurns(thread.id);
    expect(turns.filter((turn) => turn.status === "running")).toHaveLength(1);
    expect(turns.filter((turn) => turn.status === "queued")).toHaveLength(0);
    const raw = await readFile(path.join(root, "threads", thread.id, "messages.jsonl"), "utf8");
    expect(raw).toContain(bad.trim());
    expect(store.storeProblems().some((problem) => problem.kind === "ledger-line")).toBe(true);
  });

  it("does not promote into a batch while the turns ledger has an unreadable line", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Batch", modelSelection: MODEL });
    const running = await sendTurn(store, thread.id, { prompt: "work" });
    await sendTurn(store, thread.id, { prompt: "then a", delivery: "queue" });
    await sendTurn(store, thread.id, { prompt: "then b", delivery: "queue" });
    const bad = "{not json\n";
    await appendFile(path.join(root, "threads", thread.id, "turns.jsonl"), bad, "utf8");
    await store.readTurns(thread.id);

    await completeTurn(store, thread.id, running.turn.id, { text: "done" });
    // Nothing promotes past the unreadable line: the queued turns wait, and the bad line survives.
    const turns = await store.readTurns(thread.id);
    expect(turns.some((turn) => turn.status === "running")).toBe(false);
    expect(turns.filter((turn) => turn.status === "queued")).toHaveLength(2);
    const raw = await readFile(path.join(root, "threads", thread.id, "turns.jsonl"), "utf8");
    expect(raw).toContain(bad.trim());
    expect(store.storeProblems().some((problem) => problem.kind === "ledger-line")).toBe(true);
  });

  it("a torn trailing line is not reported until it is still there on re-read", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Torn", modelSelection: MODEL });
    const file = path.join(root, "threads", thread.id, "messages.jsonl");
    await store.appendLedger(thread.id, "messages", { id: "m1", threadId: thread.id, turnId: "t1", role: "user", text: "hi", createdAt: store.nowIso() });
    // A crash mid-append: the last line never got its newline.
    await appendFile(file, '{"id": "m2", "threadId"', "utf8");

    expect(await store.readMessages(thread.id)).toHaveLength(1);
    expect(store.storeProblems()).toEqual([]);
    // Still there on the next read: now it is corruption, not a crash in flight.
    expect(await store.readMessages(thread.id)).toHaveLength(1);
    expect(store.storeProblems()).toMatchObject([{ kind: "ledger-line", threadId: thread.id, line: 2 }]);
  });

  it("rejects thread ids that escape the store", async () => {
    const { store } = await testStore();
    await expect(store.readThreadRecord("../evil")).rejects.toMatchObject({ code: "INVALID_THREAD_ID" });
    await expect(store.readTurns("..")).rejects.toMatchObject({ code: "INVALID_THREAD_ID" });
    expect(store.storeProblems()).toEqual([]);
  });

  it("refuses to move a record outside the store aside", async () => {
    const { store } = await testStore();
    const outside = path.join(os.tmpdir(), "moxen-outside.json");
    const noted = store.noteProblem({ kind: "ledger-line", threadId: "demo", file: outside, line: 1, message: "planted" });
    await expect(store.quarantineProblem(noted.id)).rejects.toMatchObject({ code: "INVALID_STORE_PATH" });
    expect(store.storeProblems().map((problem) => problem.id)).toContain(noted.id);
  });

  it("refuses to move a thread record aside while a turn is live", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Live", modelSelection: MODEL });
    await sendTurn(store, thread.id, { prompt: "work" });
    await writeFile(path.join(root, "threads", thread.id, "thread.json"), "{not json", "utf8");
    await listThreads(store);
    const [problem] = store.storeProblems();
    await expect(store.quarantineProblem(problem!.id)).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(store.storeProblems().map((p) => p.id)).toContain(problem!.id);
  });

  it("gives every quarantine a unique name", async () => {
    const { root, store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Two", modelSelection: MODEL });
    await store.appendLedger(thread.id, "messages", { id: "m1", threadId: thread.id, turnId: "t1", role: "user", text: "hi", createdAt: store.nowIso() });
    const file = path.join(root, "threads", thread.id, "messages.jsonl");
    await appendFile(file, "{bad one\n", "utf8");
    await appendFile(file, "{bad two\n", "utf8");
    await store.readMessages(thread.id);
    const [first] = store.storeProblems();
    const one = await store.quarantineProblem(first!.id);
    // The surviving bad line is re-reported at its new line number.
    const [rest] = store.storeProblems();
    expect(rest).toMatchObject({ kind: "ledger-line", line: 2 });
    const two = await store.quarantineProblem(rest!.id);
    expect(one.movedTo).not.toBe(two.movedTo);
    expect(await readFile(one.movedTo, "utf8")).toContain("{bad one");
    expect(await readFile(two.movedTo, "utf8")).toContain("{bad two");
    expect((await store.readMessages(thread.id)).map((message) => message.id)).toEqual(["m1"]);
  });
});

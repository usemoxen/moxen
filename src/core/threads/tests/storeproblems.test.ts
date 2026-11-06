import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openThreadStore } from "../store.js";
import { createThread, inspectThread, interruptTurn, listThreads, sendTurn, turnProblems } from "../threads.js";

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

  it("refuses a quarantine for a problem that is already fixed, and drops the warning", async () => {
    const { store } = await testStore();
    const thread = await createThread(store, { projectId: "project-1", title: "Fixed", modelSelection: MODEL });
    store.noteProblem({ kind: "thread-record", threadId: thread.id, file: store.turnsFile(thread.id), message: "stale" });
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

  it("spots a running turn no process owns, and clearing it when it stops", async () => {
    const { store } = await testStore();
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
});

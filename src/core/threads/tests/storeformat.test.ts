/**
 * The thread store's format version (MXN-311): today's shape is version 1,
 * carried in `store.json` at the store root. A store that predates markers
 * reads as version 1, today's records load under the new gate, and a build
 * refuses to open or write a store newer than it knows.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openThreadStore } from "../store.js";
import { createThread, listThreads } from "../threads.js";

const MODEL = { instanceId: "claude", model: "test-model" };

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-store-format-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A thread record as written today: version 1, before versions were stamped. */
function todayThread(id: string): Record<string, unknown> {
  return {
    id,
    projectId: "project-1",
    title: "Fixture",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    env: { mode: "local", path: "", branch: null },
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    unsettledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

describe("store format version", () => {
  it("stamps a store with no marker as version 1 on open", async () => {
    const root = await testRoot();
    await openThreadStore(root);
    expect(JSON.parse(await readFile(path.join(root, "store.json"), "utf8"))).toEqual({ formatVersion: 1 });
  });

  it("reads a store whose marker names no version as version 1", async () => {
    const root = await testRoot();
    await writeFile(path.join(root, "store.json"), "{}\n", "utf8");
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "project-1", title: "Marked", modelSelection: MODEL });
    expect((await listThreads(store)).map((row) => row.id)).toEqual([thread.id]);
  });

  it("refuses to open a store newer than it knows", async () => {
    const root = await testRoot();
    await writeFile(path.join(root, "store.json"), JSON.stringify({ formatVersion: 2 }), "utf8");
    await expect(openThreadStore(root)).rejects.toMatchObject({ code: "FORMAT_TOO_NEW" });
  });

  it("refuses a marker that is not a version instead of guessing", async () => {
    const root = await testRoot();
    await writeFile(path.join(root, "store.json"), JSON.stringify({ formatVersion: "2" }), "utf8");
    await expect(openThreadStore(root)).rejects.toMatchObject({ code: "INVALID_FORMAT_VERSION" });
    await writeFile(path.join(root, "store.json"), "{not json", "utf8");
    await expect(openThreadStore(root)).rejects.toMatchObject({ code: "INVALID_FORMAT_VERSION" });
  });

  it("refuses to write into a store that became newer under a running build", async () => {
    const root = await testRoot();
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "project-1", title: "Downgraded", modelSelection: MODEL });
    await writeFile(path.join(root, "store.json"), JSON.stringify({ formatVersion: 2 }), "utf8");

    await expect(store.writeThreadRecord(thread)).rejects.toMatchObject({ code: "FORMAT_TOO_NEW" });
    await expect(
      store.appendLedger(thread.id, "messages", { id: "m1", threadId: thread.id, turnId: "t1", role: "user", text: "hi", createdAt: store.nowIso() }),
    ).rejects.toMatchObject({ code: "FORMAT_TOO_NEW" });
    await expect(
      store.appendDelegation({ id: "d1", parentThreadId: thread.id, childThreadId: "c", prompt: "do it", status: "running", createdAt: store.nowIso(), updatedAt: store.nowIso() }),
    ).rejects.toMatchObject({ code: "FORMAT_TOO_NEW" });
    // Nothing was written past the refusal.
    expect(await store.readMessages(thread.id)).toEqual([]);
    expect(await store.readDelegations()).toEqual([]);
  });

  it("reads today's records on a store that predates markers as version 1", async () => {
    const root = await testRoot();
    const id = "fixture-thread-1";
    await mkdir(path.join(root, "threads", id), { recursive: true });
    await writeFile(path.join(root, "threads", id, "thread.json"), `${JSON.stringify(todayThread(id))}\n`, "utf8");
    await writeFile(
      path.join(root, "threads", id, "messages.jsonl"),
      `${JSON.stringify({ id: "m1", threadId: id, turnId: "t1", role: "user", text: "hi", createdAt: "2026-11-07T00:00:00.000Z" })}\n`,
      "utf8",
    );

    const store = await openThreadStore(root);
    expect((await listThreads(store)).map((row) => row.id)).toEqual([id]);
    expect((await store.readMessages(id)).map((message) => message.id)).toEqual(["m1"]);
    expect(store.storeProblems()).toEqual([]);
    // Opening stamped the store version 1 beside the records it read.
    expect(JSON.parse(await readFile(path.join(root, "store.json"), "utf8"))).toEqual({ formatVersion: 1 });
  });
});

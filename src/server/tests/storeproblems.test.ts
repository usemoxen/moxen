/**
 * Bad records through the server boundary: a corrupt thread record does
 * not blank the shell poll, a bad ledger line is reported with its
 * location and quarantined by id, and a config entry that failed to parse
 * rides on `config.read` and survives a `settings.set` that does not touch
 * it.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testHarness } from "../../core/testing/harness.js";
import { openThreadStore } from "../../core/threads/store.js";
import { createThread } from "../../core/threads/threads.js";
import { DirectConnection } from "../connection.js";

const MODEL = { instanceId: "claude", model: "test-model" };

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("bad records over the server", () => {
  it("lists past a corrupt thread record and reports it with its location", async () => {
    const harness = await testHarness();
      const store = await openThreadStore(harness.root);
      const good = await createThread(store, { projectId: "project-1", title: "Good", modelSelection: MODEL });
      const bad = await createThread(store, { projectId: "project-1", title: "Bad", modelSelection: MODEL });
      await writeFile(path.join(harness.root, "threads", bad.id, "thread.json"), "{not json", "utf8");
      const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
      try {
        const listed = await connection.query({ type: "threads.list" });
        expect(listed.threads.map((thread) => thread.id)).toContain(good.id);
        expect(listed.threads.map((thread) => thread.id)).not.toContain(bad.id);
        const { problems } = await connection.query({ type: "store.problems" });
        expect(problems.map((problem) => problem.kind)).toEqual(["thread-record"]);
        expect(problems[0]).toMatchObject({ threadId: bad.id, file: path.join(harness.root, "threads", bad.id, "thread.json") });
      } finally {
        await connection.close();
      }
  });

  it("quarantines a bad ledger line by id, keeping the rest", async () => {
    const harness = await testHarness();
      const store = await openThreadStore(harness.root);
      const thread = await createThread(store, { projectId: "project-1", title: "Ledger", modelSelection: MODEL });
      await store.appendLedger(thread.id, "messages", { id: "m1", threadId: thread.id, turnId: "t1", role: "user", text: "hi", createdAt: store.nowIso() });
      await appendFile(path.join(harness.root, "threads", thread.id, "messages.jsonl"), "{not json\n", "utf8");
      const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
      try {
        // The server's store reports what it reads: opening the thread parses the ledger.
        await connection.query({ type: "thread.read", threadId: thread.id, view: "messages" });
        const before = await connection.query({ type: "store.problems" });
        expect(before.problems.map((problem) => problem.kind)).toEqual(["ledger-line"]);
        const { movedTo } = await connection.dispatch({ type: "store.quarantine", id: before.problems[0]!.id });
        expect(movedTo.startsWith(path.join(harness.root, "quarantine") + path.sep)).toBe(true);
        expect((await store.readMessages(thread.id)).map((message) => message.id)).toEqual(["m1"]);
        expect((await connection.query({ type: "store.problems" })).problems).toEqual([]);
      } finally {
        await connection.close();
      }
  });

  it("reports a running turn no process owns once the shell poll sees it", async () => {
    const harness = await testHarness();
      const store = await openThreadStore(harness.root);
      const thread = await createThread(store, { projectId: "project-1", title: "Stuck", modelSelection: MODEL });
      const { sendTurn } = await import("../../core/threads/threads.js");
      const sent = await sendTurn(store, thread.id, { prompt: "one" });
      await store.rewriteLedger(thread.id, "turns", (await store.readTurns(thread.id)).map((turn) => ({ ...turn, owner: undefined })));
      const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config, shellPollMs: 25 });
      try {
        const stop = connection.subscribeShell({}, () => undefined, () => undefined);
        try {
          await waitFor("the ownerless turn to be reported", async () =>
            (await connection.query({ type: "store.problems" })).problems.some((problem) => problem.kind === "turn-ownerless"));
          await connection.dispatch({ type: "thread.turn.interrupt", threadId: thread.id, turnId: sent.turn.id });
          await waitFor("the stopped turn to clear its warning", async () =>
            (await connection.query({ type: "store.problems" })).problems.every((problem) => problem.kind !== "turn-ownerless"));
        } finally {
          stop();
        }
      } finally {
        await connection.close();
      }
  });

  it("reports a skipped config entry and carries it through an unrelated save", async () => {
    const harness = await testHarness();
      const file = path.join(harness.root, "bad-config.json");
      await writeFile(file, JSON.stringify({ provider: "mine", speedMode: "turbo" }), "utf8");
      const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, configPath: file });
      try {
        const read = await connection.query({ type: "config.read" });
        expect(read.problems).toMatchObject([{ path: "speedMode" }]);
        await connection.dispatch({ type: "settings.set", key: "provider", value: "theirs" });
        const reread = await connection.query({ type: "config.read" });
        expect(reread.problems).toMatchObject([{ path: "speedMode" }]);
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ provider: "theirs", speedMode: "turbo" });
        // Setting the bad key itself clears it instead of carrying it back.
        await connection.dispatch({ type: "settings.set", key: "speedMode", value: "fast" });
        expect((await connection.query({ type: "config.read" })).problems).toEqual([]);
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ speedMode: "fast" });
      } finally {
        await connection.close();
      }
  });

  it("removing a skipped profile by id clears it instead of carrying it back", async () => {    const harness = await testHarness();
    const file = path.join(harness.root, "profile-config.json");
    await writeFile(
      file,
      JSON.stringify({ providers: { harness: { profiles: [{ id: "broken" }] } } }),
      "utf8",
    );
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, configPath: file });
    try {
      expect((await connection.query({ type: "config.read" })).problems).toMatchObject([{ path: "providers.harness.profiles[broken]" }]);
      await connection.dispatch({ type: "settings.set", key: "providers.harness.profiles[broken]", value: "" });
      expect((await connection.query({ type: "config.read" })).problems).toEqual([]);
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(saved.providers).toBeUndefined();
      expect(saved.projectPolicy).toBe("create");
    } finally {
      await connection.close();
    }
  });

  it("awaiting an unknown-status turn answers at once with the unknown status in contract", async () => {
    const harness = await testHarness();
    const store = await openThreadStore(harness.root);
    const thread = await createThread(store, { projectId: "project-1", title: "Unknown", modelSelection: { instanceId: "claude", model: "test-model" } });
    const { sendTurn } = await import("../../core/threads/threads.js");
    const sent = await sendTurn(store, thread.id, { prompt: "one" });
    await store.rewriteLedger(thread.id, "turns", (await store.readTurns(thread.id)).map((turn) => ({ ...turn, status: "bogus" })));
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      const read = await connection.query({ type: "thread.read", threadId: thread.id, view: "messages" });
      expect(read.thread.latestTurn).toMatchObject({ turnId: sent.turn.id, state: "unknown" });
      await expect(connection.query({ type: "thread.turn.await", threadId: thread.id, turnId: sent.turn.id })).resolves.toMatchObject({ status: "unknown" });
    } finally {
      await connection.close();
    }
  });

  it("reverting keeps bad ledger lines in every ledger it rewrites", async () => {
    const harness = await testHarness();
    const store = await openThreadStore(harness.root);
    const thread = await createThread(store, { projectId: "project-1", title: "Revert", modelSelection: { instanceId: "claude", model: "test-model" } });
    const { completeTurn, sendTurn } = await import("../../core/threads/threads.js");
    const first = await sendTurn(store, thread.id, { prompt: "one" });
    await completeTurn(store, thread.id, first.turn.id, { text: "first reply" });
    const second = await sendTurn(store, thread.id, { prompt: "two" });
    await completeTurn(store, thread.id, second.turn.id, { text: "second reply" });
    const dir = path.join(harness.root, "threads", thread.id);
    const bad = "{bad\n";
    for (const name of ["turns", "messages", "activity", "checkpoints"] as const) {
      await appendFile(path.join(dir, `${name}.jsonl`), bad, "utf8");
    }
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      await connection.query({ type: "thread.read", threadId: thread.id, view: "messages" });
      expect((await connection.query({ type: "store.problems" })).problems).toHaveLength(4);
      await connection.dispatch({ type: "thread.conversation.revert", threadId: thread.id, turnCount: 1 });
      for (const name of ["turns", "messages", "activity", "checkpoints"] as const) {
        expect(await readFile(path.join(dir, `${name}.jsonl`), "utf8")).toContain(bad.trim());
      }
      // Turn two is gone, its rows dropped; the bad lines are still reported.
      const reread = await connection.query({ type: "thread.read", threadId: thread.id, view: "messages" });
      expect(reread.thread.messages?.map((message) => message.text)).toContain("first reply");
      expect(reread.thread.messages?.map((message) => message.text)).not.toContain("second reply");
      expect((await connection.query({ type: "store.problems" })).problems.map((problem) => problem.kind)).toEqual([
        "ledger-line",
        "ledger-line",
        "ledger-line",
        "ledger-line",
      ]);
    } finally {
      await connection.close();
    }
  });
});

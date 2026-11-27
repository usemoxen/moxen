/**
 * `store.import` on the server (MXN-393): requests are answered while the
 * import runs, and `close()` stops the import before the rest of its teardown
 * and hands the store on only once the worker is gone. It writes `store.db`,
 * so it needs `bun:sqlite`: under Node it skips, and `bun run test:sqlite`
 * runs it.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testHarness } from "../../core/testing/harness.js";
import { openForTest, underBun, waitFor } from "../../core/threads/sqlite/tests/support.js";
import { createThread } from "../../core/threads/threads.js";
import { DirectConnection } from "../connection.js";
import type { RemoteAccess } from "../transport/remoteaccess.js";

const HELD = path.join(__dirname, "..", "..", "core", "threads", "sqlite", "tests", "fixtures", "held-import-worker.ts");

/** A server on four threads whose import holds inside the second one until released. */
async function heldImport() {
  const harness = await testHarness();
  for (const id of ["thread-1", "thread-2", "thread-3", "thread-4"]) {
    await createThread(harness.store, {
      id,
      projectId: "project-1",
      title: id,
      modelSelection: { instanceId: "opencode", model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      env: { mode: "local", path: harness.work, branch: "main" },
    });
  }
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config, storeImportWorker: HELD });
  await connection.claimStore();
  const importing = connection.dispatch({ type: "store.import" });
  const outcome: { code?: string; done?: boolean } = {};
  void importing.then(
    () => (outcome.done = true),
    (error: { code?: string }) => (outcome.code = error.code ?? "unknown"),
  );
  await waitFor(() => existsSync(path.join(harness.root, "hold.reached")), "the import to reach its hold");
  const release = (): void => writeFileSync(path.join(harness.root, "hold.release"), "");
  const imported = () => {
    const db = openForTest(harness.root);
    return {
      threads: db.query<{ n: number }, []>("SELECT count(*) AS n FROM threads").get()!.n,
      state: db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'import_state'").get()!.value,
    };
  };
  return { harness, connection, importing, outcome, release, imported };
}

describe.skipIf(!underBun)("store.import on the server", () => {
  it("answers requests while the import's thread is blocked", async () => {
    const { connection, importing, outcome, release } = await heldImport();

    expect(await connection.query({ type: "projects.list" })).toEqual({ projects: [] });
    expect(outcome).toEqual({});
    release();

    expect((await importing).tables.threads.imported).toBe(4);
    await connection.close();
  });

  it("stops the import as close() begins, not after the rest of the teardown", async () => {
    const { connection, outcome, release, imported } = await heldImport();
    let finishTeardown!: () => void;
    const teardown = new Promise<void>((resolve) => (finishTeardown = resolve));
    // A part of the teardown that takes its time, ahead of where the import is awaited.
    await connection.attachRemoteAccess({ apply: async () => undefined, close: () => teardown } as unknown as RemoteAccess);

    const closing = connection.close();
    release();
    await waitFor(() => outcome.code !== undefined || outcome.done === true, "the import to end while close() is still tearing down");

    expect(outcome).toEqual({ code: "STORE_IMPORT_INTERRUPTED" });
    finishTeardown();
    await closing;
    expect(imported()).toEqual({ threads: 2, state: "running" });
  });

  it("keeps the store claimed until the import's worker has exited", async () => {
    const { harness, connection, outcome, release } = await heldImport();
    const lock = path.join(harness.root, "server.lock");
    let closed = false;

    const closing = connection.close().then(() => (closed = true));
    // Long enough for every other part of the teardown: only the held worker is left.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect({ closed, lock: existsSync(lock), outcome }).toEqual({ closed: false, lock: true, outcome: {} });
    release();
    await closing;

    expect(existsSync(lock)).toBe(false);
    expect(outcome).toEqual({ code: "STORE_IMPORT_INTERRUPTED" });
  });
});

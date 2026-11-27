/**
 * The import as a worker job (MXN-393): off the caller's thread, stopped by a
 * flag it reads even while it cannot take a message, and settled only once the
 * worker is gone. The server's side of this is in
 * `server/tests/storeimport.test.ts`.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openThreadStore } from "../../store.js";
import { startImportJob } from "../import-job.js";
import { sparseThread } from "./fixtures.js";
import { openForTest, temporaryRoot, underBun, waitFor } from "./support.js";

const HELD = path.join(__dirname, "fixtures", "held-import-worker.ts");

async function fourThreads(label: string): Promise<string> {
  const root = temporaryRoot(label);
  const store = await openThreadStore(root);
  for (const id of ["thread-1", "thread-2", "thread-3", "thread-4"]) await store.writeThreadRecord({ ...sparseThread(), id });
  return root;
}

const reached = (root: string): boolean => existsSync(path.join(root, "hold.reached"));
const release = (root: string): void => writeFileSync(path.join(root, "hold.release"), "");

function imported(root: string): { threads: number; state: string } {
  const db = openForTest(root);
  return {
    threads: db.query<{ n: number }, []>("SELECT count(*) AS n FROM threads").get()!.n,
    state: db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'import_state'").get()!.value,
  };
}

describe.skipIf(!underBun)("the import job", () => {
  it("leaves the caller's thread free while the import's own thread is blocked", async () => {
    const root = await fourThreads("job-free");
    let settled = false;
    const job = startImportJob(root, { workerEntry: HELD });
    void job.report.finally(() => (settled = true)).catch(() => undefined);

    // These timers fire on this thread while the importer sits in a synchronous wait.
    await waitFor(() => reached(root), "the import to reach its hold");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release(root);

    expect((await job.report).tables.threads).toEqual({ source: 4, imported: 4, quarantined: 0 });
    expect(imported(root)).toEqual({ threads: 4, state: "complete" });
  });

  it("is stopped by an abort it is told of while blocked, at the very next checkpoint", async () => {
    const root = await fourThreads("job-abort");
    const job = startImportJob(root, { workerEntry: HELD });
    await waitFor(() => reached(root), "the import to reach its hold");

    job.abort();
    release(root);

    await expect(job.report).rejects.toThrow(expect.objectContaining({ code: "STORE_IMPORT_INTERRUPTED" }));
    // The open transaction commits; no further one starts.
    expect(imported(root)).toEqual({ threads: 2, state: "running" });
  });

  it("fails with a code of its own when the worker ends without a result", async () => {
    const root = await fourThreads("job-lost");
    const job = startImportJob(root, { workerEntry: path.join(root, "no-such-worker.ts") });
    await expect(job.report).rejects.toThrow(expect.objectContaining({ code: "STORE_IMPORT_FAILED" }));
  });
});

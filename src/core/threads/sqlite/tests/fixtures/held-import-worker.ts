/**
 * An import worker the test can stop at a known point (MXN-393). Inside
 * thread-2's open transaction it says it is there, by creating `hold.reached`
 * in the store root, then blocks its own thread until `hold.release` appears.
 * Nothing else could run on a thread blocked like this, so whatever the test
 * does meanwhile proves the import is not on its thread.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workerData } from "node:worker_threads";

import { serveImportJob } from "../../import-job.js";

const { storeRoot } = workerData as { storeRoot: string };
const pause = new Int32Array(new SharedArrayBuffer(4));

await serveImportJob({
  onStep: (step) => {
    if (step.phase !== "before-commit" || step.threadId !== "thread-2") return;
    writeFileSync(path.join(storeRoot, "hold.reached"), "");
    const deadline = Date.now() + 15_000;
    while (!existsSync(path.join(storeRoot, "hold.release"))) {
      if (Date.now() > deadline) throw new Error("the test never released the held import");
      Atomics.wait(pause, 0, 0, 5);
    }
  },
});

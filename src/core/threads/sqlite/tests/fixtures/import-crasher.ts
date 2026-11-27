/**
 * An import that dies for real (MXN-393): the process kills itself inside the
 * open transaction of the thread named on the command line, after that thread's
 * rows are written and before they commit. `SIGKILL` runs no handler and no
 * `finally` (on Windows it is `TerminateProcess`), which is what a crash is.
 */
import { importJsonlStore } from "../../import.js";

const [root, victim] = process.argv.slice(2);
if (!root || !victim) throw new Error("import-crasher needs the store root and a thread id");

await importJsonlStore(root, {
  onStep: (step) => {
    if (step.phase === "before-commit" && step.threadId === victim) process.kill(process.pid, "SIGKILL");
  },
});

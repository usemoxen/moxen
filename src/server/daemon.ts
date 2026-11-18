/**
 * The detached server process: what a client's autostart runs (`./client.ts`).
 * Autostart ignores stdio, but callers that capture it can read startup errors.
 */
import { toCliError } from "../core/errors.js";
import { closeOnSignals, runServer } from "./main.js";

runServer().then(
  (handle) => {
    closeOnSignals(handle);
    void handle.closed.then(() => process.exit(0));
  },
  (cause: unknown) => {
    const error = toCliError(cause);
    process.stderr.write(`${error.message}\n`, () => process.exit(error.exitCode));
  },
);

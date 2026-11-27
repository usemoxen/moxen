/**
 * The JSONL import as a job in its own worker thread (MXN-393). `bun:sqlite`
 * is synchronous and the import ends by reading the whole database back, so
 * run on the server's thread it would stall every request far past the 20 ms
 * budget (docs/sqlite-store.md). Only the worker touches `store.db`.
 *
 * Both halves of the exchange live here: `startImportJob` on the caller's
 * side, `serveImportJob` inside the worker (`import-worker.ts`). The abort is
 * a flag in shared memory, not a message, so the importer sees it at its next
 * checkpoint even when it has not returned to its event loop. The worker is
 * never terminated: it stops itself between transactions and closes its
 * database.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort, Worker, workerData } from "node:worker_threads";

import { CliError, toCliError } from "../../errors.js";
import { isStandaloneExecutable } from "../../infra/standalone.js";
import { importJsonlStore, type ImportOptions, type StoreImportReport } from "./import.js";

interface ImportJobData {
  readonly storeRoot: string;
  /** One `Int32`: zero until the caller asks the import to stop. */
  readonly abort: SharedArrayBuffer;
}

/** A `CliError` does not survive the thread boundary as itself, so its parts travel. */
type ImportJobReply =
  | { readonly ok: true; readonly report: StoreImportReport }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly exitCode: number; readonly details?: unknown } };

export interface ImportJob {
  /** Settles only once the worker has exited, so nothing of the import still holds the store. */
  readonly report: Promise<StoreImportReport>;
  /** Ask the import to stop at its next checkpoint. `report` then rejects with `STORE_IMPORT_INTERRUPTED`. */
  abort(): void;
}

/**
 * The worker's entry, in each of the three ways Moxen runs. A compiled
 * executable holds only what `scripts/build-exe.ts` lists as an entry point,
 * found by its path from the shared source root. Otherwise it is
 * `./import-worker.ts` in the source tree, and
 * `core/threads/sqlite/import-worker.js` beside the bundle
 * (`scripts/build.ts`), where this code lives one folder down.
 */
function importWorkerEntry(): string {
  if (isStandaloneExecutable()) return "./core/threads/sqlite/import-worker.ts";
  const source = fileURLToPath(new URL("./import-worker.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("../core/threads/sqlite/import-worker.js", import.meta.url));
}

function workerFailed(why: string, cause?: unknown): CliError {
  return new CliError("STORE_IMPORT_FAILED", `The store import stopped without a result: ${why}. The JSONL store is unchanged; run the import again.`, { cause });
}

/** Import the store under `storeRoot` in a worker. `workerEntry` is for tests: an entry that holds the import at a chosen step. */
export function startImportJob(storeRoot: string, options: { readonly workerEntry?: string } = {}): ImportJob {
  const abort = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const report = new Promise<StoreImportReport>((resolve, reject) => {
    const data: ImportJobData = { storeRoot, abort };
    const worker = new Worker(options.workerEntry ?? importWorkerEntry(), { workerData: data });
    let reply: ImportJobReply | undefined;
    let failure: unknown;
    worker.on("message", (message: ImportJobReply) => {
      reply = message;
    });
    worker.on("error", (error) => {
      failure = error;
    });
    worker.on("exit", (code) => {
      if (reply?.ok === true) resolve(reply.report);
      else if (reply !== undefined) {
        const { code: errorCode, message, exitCode, details } = reply.error;
        reject(new CliError(errorCode, message, { exitCode, details }));
      } else {
        reject(workerFailed(failure instanceof Error ? failure.message : `its worker exited with code ${code}`, failure));
      }
    });
  });
  return {
    report,
    abort: () => void Atomics.store(new Int32Array(abort), 0, 1),
  };
}

/** The worker's side: run the import this worker was started for and send back what came of it. */
export async function serveImportJob(options: Pick<ImportOptions, "onStep"> = {}): Promise<void> {
  const port = parentPort;
  if (port === null) throw new CliError("STORE_IMPORT_FAILED", "The import worker was not started as a worker.");
  const { storeRoot, abort } = workerData as ImportJobData;
  const flag = new Int32Array(abort);
  let reply: ImportJobReply;
  try {
    const report = await importJsonlStore(storeRoot, {
      ...options,
      signal: {
        get aborted() {
          return Atomics.load(flag, 0) !== 0;
        },
      },
    });
    reply = { ok: true, report };
  } catch (error) {
    const { code, message, exitCode, details } = toCliError(error);
    reply = { ok: false, error: { code, message, exitCode, details } };
  }
  port.postMessage(reply);
}

/**
 * Replace a file by renaming a finished temp file over it. On Windows the
 * rename fails with EPERM/EBUSY/EACCES while anything else (a watcher, another
 * Moxen process) has the target open, which clears within moments, so it is
 * retried a few times before the error is allowed through.
 */
import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Finish a same-directory temporary file before replacing the original. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, text, "utf8");
  await renameReplacing(tmp, file);
}

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const ATTEMPTS = 12;

function retryable(error: unknown, attempt: number): boolean {
  return process.platform === "win32" && attempt < ATTEMPTS && RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

export async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!retryable(error, attempt)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt));
    }
  }
}

export function renameReplacingSync(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!retryable(error, attempt)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
    }
  }
}

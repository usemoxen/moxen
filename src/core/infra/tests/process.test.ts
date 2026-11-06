import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../../errors.js";
import { killProcessTree, runProcess } from "../process.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: string }).code === "EPERM";
  }
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-process-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function settleError(promise: Promise<unknown>): Promise<{ code: string | null; elapsed: number }> {
  const started = Date.now();
  return promise.then(
    () => ({ code: null, elapsed: Date.now() - started }),
    (error: unknown) => ({
      code: error instanceof CliError ? error.code : `unexpected: ${String(error)}`,
      elapsed: Date.now() - started,
    }),
  );
}

describe("runProcess", () => {
  it("resolves stdout of a command that exits cleanly", async () => {
    const result = await runProcess(process.execPath, ["-e", "console.log('hi')"], { timeoutMs: 10_000 });
    expect(result.stdout.trim()).toBe("hi");
    expect(result.exitCode).toBe(0);
  });

  it("rejects with PROCESS_FAILED when the command exits non-zero", async () => {
    const outcome = await settleError(runProcess(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10_000 }));
    expect(outcome.code).toBe("PROCESS_FAILED");
  });

  it("settles the timeout without waiting for a sleeping child", async () => {
    const outcome = await settleError(
      runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 300, forceKillAfterMs: 250 }),
    );
    expect(outcome.code).toBe("PROCESS_TIMEOUT");
    expect(outcome.elapsed).toBeLessThan(10_000);
  });

  it.skipIf(process.platform === "win32")(
    "settles the timeout without waiting for a child that ignores SIGTERM (Windows delivers kill as terminate, so no child can ignore it)",
    { timeout: 20_000 },
    async () => {
      const dir = await tempDir();
      const pidFile = path.join(dir, "pid");
      const outcome = settleError(
        runProcess(
          process.execPath,
          [
            "-e",
            `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000);`,
          ],
          { timeoutMs: 300, forceKillAfterMs: 500 },
        ),
      );
      const settled = await outcome;
      expect(settled.code).toBe("PROCESS_TIMEOUT");
      expect(settled.elapsed).toBeLessThan(10_000);
      // Escalation must still take the child down: the SIGTERM was ignored,
      // so only the forced kill ends it.
      await vi.waitFor(async () => {
        await stat(pidFile);
      }, { timeout: 10_000 });
      const pid = Number(await readFile(pidFile, "utf8"));
      try {
        await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
      } finally {
        if (alive(pid)) killProcessTree({ pid, kill: (signal) => process.kill(pid, signal) }, "SIGKILL");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "settles the timeout while a grandchild holds stdio open (Windows tree-kill reaps the grandchild, so close is never held there)",
    { timeout: 30_000 },
    async () => {
      const dir = await tempDir();
      const childScript = path.join(dir, "child.mjs");
      const grandchildScript = path.join(dir, "grandchild.mjs");
      const grandchildPid = path.join(dir, "grandchild.pid");
      await writeFile(
        grandchildScript,
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid)); setTimeout(() => {}, 30_000);`,
      );
      await writeFile(
        childScript,
        `import { spawn } from "node:child_process"; spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: ["ignore", "inherit", "inherit"], detached: true }); setTimeout(() => {}, 30_000);`,
      );
      const settled = await settleError(runProcess(process.execPath, [childScript], { timeoutMs: 300, forceKillAfterMs: 500 }));
      expect(settled.code).toBe("PROCESS_TIMEOUT");
      expect(settled.elapsed).toBeLessThan(10_000);
      await vi.waitFor(async () => {
        await stat(grandchildPid);
      }, { timeout: 10_000 });
      const pid = Number(await readFile(grandchildPid, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
    },
  );
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../../errors.js";
import { commandExists, killProcessTree, killProcessTreeAsync, resolveWindowsLaunch, runProcess } from "../process.js";

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

describe("Windows shim unwrapping and path commandExists (MXN-448)", () => {
  it("checks explicit Windows and POSIX file paths directly in commandExists without invoking where.exe", async () => {
    const files = new Set(["C:\\Users\\aaron\\.local\\bin\\agy.exe"]);
    expect(
      await commandExists("C:\\Users\\aaron\\.local\\bin\\agy.exe", {
        platform: "win32",
        isFile: (p) => files.has(p),
      }),
    ).toBe(true);
    expect(
      await commandExists("C:\\Users\\aaron\\.local\\bin\\missing.exe", {
        platform: "win32",
        isFile: (p) => files.has(p),
      }),
    ).toBe(false);
    expect(await commandExists(process.execPath)).toBe(true);
  });

  it("unwraps npx.cmd and npm .cmd/.ps1 shims on Windows without a shell", () => {
    const files = new Set([
      "C:\\Program Files\\nodejs\\npx.cmd",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
      "C:\\Users\\aaron\\AppData\\Roaming\\npm\\goose.cmd",
      "C:\\Users\\aaron\\AppData\\Roaming\\npm\\node_modules\\@goose\\cli\\bin\\goose.js",
      "C:\\Tools\\custom.bat",
      "C:\\Tools\\script.ps1",
    ]);
    const contents = new Map<string, string>([
      [
        "C:\\Users\\aaron\\AppData\\Roaming\\npm\\goose.cmd",
        '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@goose\\cli\\bin\\goose.js" %*\r\n',
      ],
      ["C:\\Tools\\custom.bat", "@echo off\r\necho custom\r\n"],
      ["C:\\Tools\\script.ps1", "Write-Host 'hi'\r\n"],
    ]);
    const env = {
      PATH: "C:\\Program Files\\nodejs;C:\\Users\\aaron\\AppData\\Roaming\\npm",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    };

    expect(
      resolveWindowsLaunch("npx", ["-y", "@zed-industries/claude-code-acp"], env, {
        platform: "win32",
        isFile: (p) => files.has(p),
        readText: (p) => contents.get(p) ?? null,
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
        "-y",
        "@zed-industries/claude-code-acp",
      ],
    });

    expect(
      resolveWindowsLaunch("goose", ["acp"], env, {
        platform: "win32",
        isFile: (p) => files.has(p),
        readText: (p) => contents.get(p) ?? null,
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\aaron\\AppData\\Roaming\\npm\\node_modules\\@goose\\cli\\bin\\goose.js", "acp"],
    });

    expect(
      resolveWindowsLaunch("C:\\Tools\\custom.bat", ["--flag", "two words"], env, {
        platform: "win32",
        isFile: (p) => files.has(p),
        readText: (p) => contents.get(p) ?? null,
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", "C:\\Tools\\custom.bat", "--flag", "two words"],
    });

    expect(
      resolveWindowsLaunch("C:\\Tools\\script.ps1", ["--acp"], env, {
        platform: "win32",
        isFile: (p) => files.has(p),
        readText: (p) => contents.get(p) ?? null,
      }),
    ).toEqual({
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Tools\\script.ps1", "--acp"],
    });
  });
});

/**
 * The async Windows reaper (`taskkill /T /F`) is what a caller uses when its
 * answer must not wait: MXN-402's credential probe reaps its child off the
 * response path. It must be bounded too, or a `taskkill` that never exits
 * holds the loop open, and it must say what happened instead of throwing.
 *
 * Driven through an injected spawn, so these run on every platform: only the
 * real `taskkill` binary is Windows-only.
 */
describe("killProcessTreeAsync on Windows (MXN-402)", () => {
  type Reaper = EventEmitter & { kill: (signal?: NodeJS.Signals) => void };

  /** A `taskkill` child whose exit the test decides. */
  function fakeReaper(killed: Array<NodeJS.Signals | undefined> = []): Reaper {
    return Object.assign(new EventEmitter(), {
      kill: (signal?: NodeJS.Signals) => {
        killed.push(signal);
      },
    });
  }

  const leader = () => ({ pid: 4242, kill: vi.fn() });

  it("resolves once taskkill exits, reaping the tree instead of the leader alone", async () => {
    const reaper = fakeReaper();
    const spawnReaper = vi.fn(() => reaper);
    const target = leader();
    const settled = killProcessTreeAsync(target, "SIGTERM", { platform: "win32", spawn: spawnReaper as never });
    expect(spawnReaper).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    reaper.emit("exit", 0);
    await expect(settled).resolves.toBe("reaped");
    expect(target.kill).not.toHaveBeenCalled();
  });

  it("reports a non-zero taskkill exit instead of throwing, and signals the leader", async () => {
    const reaper = fakeReaper();
    const target = leader();
    const settled = killProcessTreeAsync(target, "SIGTERM", { platform: "win32", spawn: (() => reaper) as never });
    reaper.emit("exit", 128);
    // A non-zero exit is not proof the tree died (access denied, or somehow
    // still there), so the leader is signalled rather than the cleanup being
    // silently given up on — and nothing is thrown.
    await expect(settled).resolves.toBe("signalled");
    expect(target.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to the leader's own kill when taskkill cannot be spawned", async () => {
    const reaper = fakeReaper();
    const target = leader();
    const settled = killProcessTreeAsync(target, "SIGKILL", { platform: "win32", spawn: (() => reaper) as never });
    reaper.emit("error", new Error("ENOENT"));
    await expect(settled).resolves.toBe("signalled");
    expect(target.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("bounds a taskkill that never exits: kills the reaper and signals the leader", async () => {
    const killed: Array<NodeJS.Signals | undefined> = [];
    const reaper = fakeReaper(killed);
    const target = leader();
    const settled = killProcessTreeAsync(target, "SIGTERM", {
      platform: "win32",
      spawn: (() => reaper) as never,
      timeoutMs: 20,
    });
    await expect(settled).resolves.toBe("signalled");
    // The hung reaper must not be left holding the loop open...
    expect(killed).toEqual(["SIGKILL"]);
    // ...and the cleanup must not be silently skipped because it hung.
    expect(target.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds a spawn that throws synchronously, without an unhandled rejection", async () => {
    const target = leader();
    const settled = killProcessTreeAsync(target, "SIGTERM", {
      platform: "win32",
      spawn: (() => {
        throw new Error("EINVAL");
      }) as never,
    });
    await expect(settled).resolves.toBe("signalled");
    expect(target.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("leaves the POSIX path alone: no taskkill, the group signal it always used", async () => {
    if (process.platform === "win32") return;
    const spawnReaper = vi.fn();
    // Its own pid is a live process group here, so the group signal succeeds.
    await killProcessTreeAsync({ pid: process.pid, kill: vi.fn() }, "SIGTERM", {
      platform: "linux",
      spawn: spawnReaper as never,
    });
    expect(spawnReaper).not.toHaveBeenCalled();
  });
});

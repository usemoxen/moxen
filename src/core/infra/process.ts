import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CliError } from "../errors.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  /** Grace from SIGTERM to SIGKILL after a timeout. Defaults to 2000; 0 kills immediately. */
  forceKillAfterMs?: number;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void): void => {
      clearTimeout(timeout);
      if (forceTimer !== null) {
        clearTimeout(forceTimer);
        forceTimer = null;
      }
      if (settled) return;
      settled = true;
      fn();
    };
    const timeout = setTimeout(() => {
      // A timeout settles on its own: 'close' also waits for stdio a
      // grandchild may hold, and the child may ignore the first kill.
      // Escalate like the provider transport (SIGTERM, then SIGKILL).
      try {
        killProcessTree(child, "SIGTERM");
      } catch {
        // Already gone.
      }
      // Release our side of the pipes so 'close' can still fire once the child ends.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(() => {
        reject(new CliError("PROCESS_TIMEOUT", `${command} timed out.`, { details: { command } }));
      });
      const grace = options.forceKillAfterMs ?? 2_000;
      if (grace <= 0) {
        try {
          killProcessTree(child, "SIGKILL");
        } catch {
          // Already gone.
        }
      } else {
        forceTimer = setTimeout(() => {
          forceTimer = null;
          try {
            killProcessTree(child, "SIGKILL");
          } catch {
            // Already gone.
          }
        }, grace);
        if (typeof (forceTimer as unknown as { unref?: unknown }).unref === "function") {
          (forceTimer as unknown as { unref(): void }).unref();
        }
      }
    }, options.timeoutMs ?? 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      settle(() => {
        reject(new CliError("PROCESS_START_FAILED", `Could not start ${command}.`, { cause }));
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        settle(() => {
          reject(
            new CliError("PROCESS_FAILED", `${command} exited with code ${exitCode}.`, {
              details: { command, exitCode, stderr: stderr.trim() },
            }),
          );
        });
        return;
      }
      settle(() => {
        resolve({ stdout, stderr, exitCode });
      });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runProcess(locator, [command], { allowFailure: true, timeoutMs: 5_000 }).catch(
    () => null,
  );
  return result?.exitCode === 0;
}

/** The file `name` resolves to on `PATH` (with `PATHEXT` on Windows), or null. */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE").split(";").filter((ext) => ext.length > 0)
    : [""];
  for (const dir of raw.split(delimiter).filter((entry) => entry.length > 0)) {
    for (const ext of process.platform === "win32" ? ["", ...exts] : exts) {
      const file = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Keep scanning.
      }
    }
  }
  return null;
}

/** Whether `name` resolves to an executable on `PATH` (with `PATHEXT` on Windows). */
export function binaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveOnPath(name, env) !== null;
}

/**
 * End a process and everything it started. On Windows a plain kill ends
 * only the direct child, and provider CLIs are often launched through a
 * shim (`opencode` on PATH starts `opencode-ai/bin/opencode.exe`): killing
 * the shim orphaned the real server, one per moxen process that used it.
 * `taskkill /T /F` takes the whole tree. Elsewhere, the signal as asked.
 */
export function killProcessTree(
  child: { readonly pid?: number | undefined; kill(signal?: NodeJS.Signals): unknown },
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status === 0) return;
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * End a process we only know by pid, and what it started, as a command a
 * server ran for the model: on Windows the whole tree, elsewhere its process
 * group (the command was started as the leader of its own). Quiet when it is
 * already gone.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      // Not a group leader, or gone: try the process itself, then give up.
    }
  }
}

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CliError } from "../errors.js";
import { isStandaloneExecutable } from "./standalone.js";

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

function defaultIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export async function commandExists(
  command: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly isFile?: (file: string) => boolean;
  } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // `where.exe` on Windows rejects full paths (`C:\...\agy.exe`), so check
  // explicit file paths directly before falling back to PATH lookup.
  if (trimmed.includes("/") || trimmed.includes("\\") || path.win32.isAbsolute(trimmed)) {
    if (options.isFile) return options.isFile(trimmed);
    try {
      if (!fs.statSync(trimmed).isFile()) return false;
      if (platform !== "win32") fs.accessSync(trimmed, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = await runProcess(locator, [trimmed], { allowFailure: true, timeoutMs: 5_000 }).catch(
    () => null,
  );
  return result?.exitCode === 0;
}

/** The file `name` resolves to on `PATH` (with `PATHEXT` on Windows), or null. */
export function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly isFile?: (file: string) => boolean;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const raw = env.PATH ?? env.Path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.join;
  const rawExts = platform === "win32"
    ? (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)
    : [""];
  const exts = platform === "win32"
    ? [...new Set(["", ...rawExts.flatMap((ext) => [ext, ext.toLowerCase()])])]
    : rawExts;
  for (const dir of raw.split(delimiter).filter((entry) => entry.length > 0)) {
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      if (isFile(file)) return file;
    }
  }
  return null;
}

export interface WindowsLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface WindowsLaunchOptions {
  readonly platform?: NodeJS.Platform;
  readonly isFile?: (file: string) => boolean;
  readonly readText?: (file: string) => string | null;
  readonly standalone?: boolean;
  readonly execPath?: string;
}

function defaultReadText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function resolveNodeForShim(
  shimDir: string,
  env: NodeJS.ProcessEnv,
  isFile: (file: string) => boolean,
  standalone: boolean,
  execPath: string,
): { command: string; env?: NodeJS.ProcessEnv } {
  const siblingNode = path.win32.join(shimDir, "node.exe");
  if (isFile(siblingNode)) return { command: siblingNode };
  const onPathNode = resolveOnPath("node", env, { platform: "win32", isFile });
  if (onPathNode && /\.exe$/i.test(onPathNode)) return { command: onPathNode };
  if (standalone) return { command: execPath, env: { BUN_BE_BUN: "1" } };
  return { command: execPath };
}

function extractShimTarget(shimPath: string, content: string, isFile: (file: string) => boolean): string | null {
  const dir = path.win32.dirname(shimPath);
  // Well-known Node/npm CLI shims (`npx.cmd`, `npm.cmd`) ship next to `node_modules\npm\bin\*-cli.js`.
  const base = path.win32.basename(shimPath).toLowerCase();
  if (base === "npx.cmd" || base === "npx.ps1") {
    const npxCli = path.win32.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    if (isFile(npxCli)) return npxCli;
  }
  if (base === "npm.cmd" || base === "npm.ps1") {
    const npmCli = path.win32.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (isFile(npmCli)) return npmCli;
  }
  // Standard npm/pnpm/yarn/bun `.cmd` (`%dp0%\...`, `%~dp0\...`) and `.ps1` (`$basedir/...`, `$PSScriptRoot/...`) shims.
  const pattern = /(?:%~?dp0%|\$basedir|\$PSScriptRoot)[\\/]([^"'\r\n]+?\.(?:cjs|mjs|js|exe|com))/giu;
  for (const match of content.matchAll(pattern)) {
    const rel = match[1]?.trim();
    if (!rel) continue;
    const candidate = path.win32.normalize(path.win32.join(dir, rel.replace(/\//gu, "\\")));
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve and unwrap Windows `.cmd`/`.bat`/`.ps1` launcher shims so callers
 * can spawn with `shell: false` (avoiding Node/Bun CVE-2024-27980 `EINVAL`
 * without ever joining shell command strings).
 */
export function resolveWindowsLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsLaunchOptions = {},
): WindowsLaunchCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args };
  const isFile = options.isFile ?? defaultIsFile;
  const readText = options.readText ?? defaultReadText;
  const standalone = options.standalone ?? isStandaloneExecutable();
  const execPath = options.execPath ?? process.execPath;

  const resolved = path.win32.isAbsolute(command) || command.includes("\\") || command.includes("/")
    ? command
    : (resolveOnPath(command, env, { platform: "win32", isFile }) ?? command);

  if (!/\.(cmd|bat|ps1)$/i.test(resolved)) {
    return { command: resolved, args };
  }

  const content = readText(resolved) ?? "";
  const target = extractShimTarget(resolved, content, isFile);
  if (target) {
    if (/\.(exe|com)$/i.test(target)) {
      return { command: target, args };
    }
    const runtime = resolveNodeForShim(path.win32.dirname(resolved), env, isFile, standalone, execPath);
    return {
      command: runtime.command,
      args: [target, ...args],
      ...(runtime.env ? { env: runtime.env } : {}),
    };
  }

  if (/\.ps1$/i.test(resolved)) {
    const ps = resolveOnPath("powershell.exe", env, { platform: "win32", isFile }) ?? "powershell.exe";
    return {
      command: ps,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
    };
  }

  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  return {
    command: comspec,
    args: ["/d", "/c", resolved, ...args],
  };
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
    const result = spawnSync("taskkill", taskkillArgs(child.pid), {
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
    spawnSync("taskkill", taskkillArgs(pid), { stdio: "ignore", windowsHide: true, timeout: 10_000 });
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

/** `taskkill /PID <pid> /T /F` as argv, never a shell string. */
function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/** How long the async Windows reaper may run before it is killed itself. */
export const TASKKILL_TIMEOUT_MS = 5_000;

export interface KillProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  /** The spawner the Windows reaper uses; tests inject a fake. */
  readonly spawn?: typeof spawn;
  /** Bound on the Windows reaper; default `TASKKILL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * What a cleanup achieved: `reaped` — the Windows tree was taken down by
 * `taskkill` — or `signalled`, the leader alone was signalled (POSIX, or the
 * Windows fallback). A cleanup never throws: a caller ending a process has
 * nothing to gain from an exception, and a leaked rejection would fail a turn.
 */
export type KillProcessTreeOutcome = "reaped" | "signalled";

/**
 * The async form of `killProcessTree`, for a caller whose answer must not wait
 * on the platform's reaper. On Windows `taskkill` runs as a child process —
 * never `spawnSync`, which would block the event loop for as long as the
 * reaper takes. On POSIX it signals the child's process group, so descendants
 * die with it even after the leader has exited.
 *
 * The Windows reaper is bounded: a `taskkill` that cannot start, exits
 * non-zero or hangs ends the wait at `timeoutMs` (a hung one is killed), and
 * the leader is signalled directly instead — so cleanup always finishes, and a
 * caller that has already answered learns whether the whole tree died or only
 * the leader was signalled, rather than waiting on it forever.
 */
export async function killProcessTreeAsync(
  child: { readonly pid?: number | undefined; kill(signal?: NodeJS.Signals): unknown },
  signal: NodeJS.Signals = "SIGTERM",
  options: KillProcessTreeOptions = {},
): Promise<KillProcessTreeOutcome> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    if (child.pid !== undefined && await taskkillAsync(child.pid, options.spawn ?? spawn, options.timeoutMs ?? TASKKILL_TIMEOUT_MS) === "reaped") {
      return "reaped";
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
    return "signalled";
  }
  // The probe runs detached, so its pid is its process-group id: signal the
  // group (-pid) and not just the leader, which may already be gone.
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return "signalled";
    } catch {
      // Not a group leader, or gone: fall back to the process itself.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
  return "signalled";
}

/**
 * `taskkill /T /F` on a pid, bounded by `timeoutMs`. `reaped` when `taskkill`
 * exited cleanly, so the tree is gone; `failed` when it could not start,
 * errored, exited non-zero or had to be killed for hanging — the caller then
 * signals the leader itself, so cleanup is bounded but never silently skipped.
 */
function taskkillAsync(pid: number, spawnImpl: typeof spawn, timeoutMs: number): Promise<"reaped" | "failed"> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killer: ReturnType<typeof spawn> | null = null;
    const finish = (outcome: "reaped" | "failed"): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(outcome);
    };
    try {
      killer = spawnImpl("taskkill", taskkillArgs(pid), { stdio: "ignore", windowsHide: true });
    } catch {
      finish("failed");
      return;
    }
    // The reaper and the timer are both referenced on purpose: an awaiting
    // caller must actually stay alive until cleanup finishes or is given up on.
    killer.once("error", () => finish("failed"));
    // A non-zero exit (access denied, or a tree that is somehow still there)
    // is not proof the tree died, so it takes the same fallback as a hang.
    killer.once("exit", (code: number | null) => finish(code === 0 ? "reaped" : "failed"));
    timer = setTimeout(() => {
      // Its own hang must not outlive the bound: kill the reaper, then let the
      // caller signal the leader so cleanup is not silently skipped.
      try {
        killer?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish("failed");
    }, timeoutMs);
  });
}

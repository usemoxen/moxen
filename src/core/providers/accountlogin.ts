/**
 * Cross-platform in-app CLI login sessions for isolated multi-account profiles:
 * - Claude Code (`claude/<id>`): `claude auth login` with `CLAUDE_CONFIG_DIR`
 * - Antigravity (`antigravity/<id>`): `agy acp --login` with isolated `HOME`/`USERPROFILE` + `--gemini-dir`
 * - ChatGPT Codex companion (`chatgpt/<id>`): `codex app-server` `account/login/start` (`type: "chatgpt"`)
 *   with isolated `CODEX_HOME`, returning `authUrl` and auto-probing the authenticated companion on completion.
 *
 * Security & cross-platform rules:
 * - Never shell-join commands; unwrap Windows `.cmd`/`.bat`/`.ps1` shims via `resolveWindowsLaunch`.
 * - Never copy or scrape credentials; each CLI writes its own login state into its isolated home directory.
 * - Never log tokens or credentials.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expandHome } from "../config.js";
import { CliError } from "../errors.js";
import { killProcessTree, resolveWindowsLaunch } from "../infra/process.js";
import type { AccountProviderKind } from "../types.js";
import { antigravityAccountEnv } from "./antigravity/config.js";
import { probeCodexCompanion, type CodexCompanionProbeResult } from "./chatgpt/companion.js";
import { makeClaudeEnv, resolveClaudeExecutable } from "./claude/config.js";
import { normalizeCodexSettings, tokenizeLaunchArgs } from "./codex/config.js";
import { asRecord, asString, CODEX_METHODS } from "./codex/protocol.js";
import { SpawnCodexTransport, type CodexTransport } from "./codex/transport.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const INITIAL_URL_WAIT_MS = 2_000;

// Strip ANSI CSI/OSC escape codes before scanning CLI output for login URLs.
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[ -/]*[@-~])/gu;
const HTTPS_URL_RE = /https:\/\/[^\s"'<>)\]]+/iu;

export function extractLoginUrl(output: string): string | null {
  const cleaned = output.replace(ANSI_RE, "");
  const match = HTTPS_URL_RE.exec(cleaned);
  if (!match) return null;
  const candidate = match[0].replace(/[.,;]+$/u, "");
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export interface ProviderAccountLoginCompletion {
  readonly kind: AccountProviderKind;
  readonly accountId: string;
  readonly homePath: string | null;
  readonly probed?: CodexCompanionProbeResult | undefined;
}

export interface ProviderAccountLoginSession {
  readonly sessionId: string;
  readonly kind: AccountProviderKind;
  readonly accountId: string;
  readonly homePath: string | null;
  readonly authorizationUrl: string | null;
  /** True when the client should open `authorizationUrl` in the system browser (Codex app-server does not open it). */
  readonly openBrowser: boolean;
  readonly message: string | null;
  waitForCompletion(timeoutMs?: number): Promise<ProviderAccountLoginCompletion>;
  cancel(): Promise<void>;
}

export interface ProviderAccountLoginInput {
  readonly kind: AccountProviderKind;
  readonly accountId: string;
  readonly homePath?: string | undefined;
  readonly binaryPath?: string | undefined;
  readonly launchArgs?: string | readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
}

export type LoginChildSpawner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface ProviderAccountLoginDeps {
  readonly spawnChild?: LoginChildSpawner | undefined;
  readonly codexTransport?: CodexTransport | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly urlWaitMs?: number | undefined;
  readonly ensureDir?: ((dirPath: string) => void) | undefined;
}

function defaultSpawnChild(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function defaultEnsureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildCliLaunch(
  input: ProviderAccountLoginInput,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ensureDir: (dirPath: string) => void,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly message: string;
} {
  const trimmedHome = input.homePath?.trim() || "";
  const resolvedHome = trimmedHome.length > 0 ? path.resolve(expandHome(trimmedHome)) : null;

  if (input.kind === "claude") {
    if (resolvedHome) ensureDir(resolvedHome);
    const mergedBase: NodeJS.ProcessEnv = { ...baseEnv, ...(input.env ?? {}) };
    const env = makeClaudeEnv({ homePath: trimmedHome }, mergedBase);
    const rawBinary = expandHome(input.binaryPath?.trim() || "claude");
    const resolvedBinary = resolveClaudeExecutable(rawBinary, env, { platform });
    const isJsEntry = /\.(?:cjs|mjs|js)$/iu.test(resolvedBinary);
    const launched = isJsEntry
      ? { command: process.execPath, args: [resolvedBinary, "auth", "login"] as readonly string[] }
      : resolveWindowsLaunch(resolvedBinary, ["auth", "login"], env, { platform });
    return {
      command: launched.command,
      args: launched.args,
      env: launched.env ? { ...env, ...launched.env } : env,
      message: resolvedHome
        ? `Complete Claude sign-in in your browser (saved to ${trimmedHome}).`
        : "Complete Claude sign-in in your browser.",
    };
  }

  // Antigravity (`agy acp --login`)
  if (resolvedHome) {
    ensureDir(resolvedHome);
    ensureDir(path.join(resolvedHome, ".gemini"));
  }
  const env = antigravityAccountEnv(trimmedHome || undefined, baseEnv, input.env);
  const rawBinary = expandHome(input.binaryPath?.trim() || "agy");
  const extraArgs =
    typeof input.launchArgs === "string"
      ? input.launchArgs.trim()
        ? tokenizeLaunchArgs(input.launchArgs.trim())
        : []
      : Array.isArray(input.launchArgs)
        ? [...input.launchArgs]
        : [];
  const dirArgs = resolvedHome ? ["--gemini-dir", path.join(resolvedHome, ".gemini")] : [];
  const rawArgs = ["acp", "--login", ...dirArgs, ...extraArgs];
  const launched = resolveWindowsLaunch(rawBinary, rawArgs, env, { platform });
  return {
    command: launched.command,
    args: launched.args,
    env: launched.env ? { ...env, ...launched.env } : env,
    message: resolvedHome
      ? `Complete Antigravity sign-in in your browser (saved to ${trimmedHome}).`
      : "Complete Antigravity sign-in in your browser.",
  };
}

async function startCliLoginSession(
  input: ProviderAccountLoginInput,
  deps: ProviderAccountLoginDeps,
): Promise<ProviderAccountLoginSession> {
  const normalizedId = input.accountId.trim().toLowerCase();
  const baseEnv = deps.baseEnv ?? process.env;
  const platform = deps.platform ?? process.platform;
  const ensureDir = deps.ensureDir ?? defaultEnsureDir;
  const spawner = deps.spawnChild ?? defaultSpawnChild;
  const cwd = input.cwd ?? process.cwd();
  const homePath = input.homePath?.trim() || null;

  const launch = buildCliLaunch(input, baseEnv, platform, ensureDir);
  const child = spawner(launch.command, launch.args, { cwd, env: launch.env });
  const sessionId = crypto.randomUUID();

  let combinedOutput = "";
  let foundUrl: string | null = null;
  let settled = false;
  let cancelled = false;
  let resolveUrlWait: (() => void) | null = null;

  let resolveDone!: (value: ProviderAccountLoginCompletion) => void;
  let rejectDone!: (error: unknown) => void;
  const donePromise = new Promise<ProviderAccountLoginCompletion>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  donePromise.catch(() => undefined);

  const onChunk = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    combinedOutput += text;
    if (combinedOutput.length > 32_768) {
      combinedOutput = combinedOutput.slice(-32_768);
    }
    if (foundUrl === null) {
      const url = extractLoginUrl(combinedOutput);
      if (url) {
        foundUrl = url;
        resolveUrlWait?.();
      }
    }
  };

  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  child.on("error", (cause) => {
    if (settled) return;
    settled = true;
    resolveUrlWait?.();
    rejectDone(
      new CliError(
        "PROVIDER_LOGIN_FAILED",
        `Could not start ${launch.command} for login: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  });

  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    resolveUrlWait?.();
    if (cancelled) {
      rejectDone(new CliError("PROVIDER_LOGIN_CANCELLED", "Account sign-in was cancelled."));
      return;
    }
    if (code === 0) {
      resolveDone({ kind: input.kind, accountId: normalizedId, homePath });
      return;
    }
    const detail = combinedOutput.replace(ANSI_RE, "").trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(" ").slice(0, 240);
    rejectDone(
      new CliError(
        "PROVIDER_LOGIN_FAILED",
        detail
          ? `${input.kind} sign-in exited with code ${code ?? 1}: ${detail}`
          : `${input.kind} sign-in exited with code ${code ?? 1}.`,
      ),
    );
  });

  // Give the CLI a brief window to print an OAuth URL (or fail immediately on ENOENT).
  const urlWaitMs = deps.urlWaitMs ?? INITIAL_URL_WAIT_MS;
  if (!settled && foundUrl === null && urlWaitMs > 0) {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        resolveUrlWait = null;
        resolve();
      };
      resolveUrlWait = done;
      timer = setTimeout(done, urlWaitMs);
      timer.unref?.();
    });
  }

  // If the child failed immediately during startup (e.g. ENOENT), surface that right away.
  if (settled) {
    try {
      await donePromise;
    } catch (error) {
      throw error;
    }
  }

  const cancel = async (): Promise<void> => {
    cancelled = true;
    if (!settled) {
      try {
        killProcessTree(child, "SIGTERM");
      } catch {
        // Already exited.
      }
      settled = true;
      rejectDone(new CliError("PROVIDER_LOGIN_CANCELLED", "Account sign-in was cancelled."));
    }
  };

  return {
    sessionId,
    kind: input.kind,
    accountId: normalizedId,
    homePath,
    authorizationUrl: foundUrl,
    // `claude auth login` and `agy acp --login` open the browser themselves and print the URL as fallback.
    openBrowser: false,
    message: launch.message,
    async waitForCompletion(timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS): Promise<ProviderAccountLoginCompletion> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          donePromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void cancel();
              reject(new CliError("PROVIDER_LOGIN_TIMEOUT", `Timed out waiting for ${input.kind} sign-in to complete.`));
            }, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cancel,
  };
}

async function startCodexCompanionLoginSession(
  input: ProviderAccountLoginInput,
  deps: ProviderAccountLoginDeps,
): Promise<ProviderAccountLoginSession> {
  const normalizedId = input.accountId.trim().toLowerCase();
  const baseEnv = deps.baseEnv ?? process.env;
  const ensureDir = deps.ensureDir ?? defaultEnsureDir;
  const transport = deps.codexTransport ?? new SpawnCodexTransport();
  const cwd = input.cwd ?? process.cwd();
  const trimmedHome = input.homePath?.trim() || "";
  const homePath = trimmedHome.length > 0 ? trimmedHome : null;
  if (homePath) {
    ensureDir(path.resolve(expandHome(homePath)));
  }
  const extraLaunch =
    typeof input.launchArgs === "string"
      ? input.launchArgs
      : Array.isArray(input.launchArgs)
        ? input.launchArgs.join(" ")
        : undefined;
  const settings = normalizeCodexSettings({
    ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    ...(homePath ? { homePath } : {}),
    ...(extraLaunch ? { launchArgs: extraLaunch } : {}),
  });
  const peer = transport.startPeer({
    settings,
    env: { ...baseEnv, ...(input.env ?? {}) },
    cwd,
  });

  const sessionId = crypto.randomUUID();
  let loginId: string | null = null;
  let closed = false;
  let settled = false;
  let resolveDone!: (value: ProviderAccountLoginCompletion) => void;
  let rejectDone!: (error: unknown) => void;
  const donePromise = new Promise<ProviderAccountLoginCompletion>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  donePromise.catch(() => undefined);

  const closePeer = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      peer.close();
    } catch {
      // Already closed.
    }
  };

  peer.onNotification((method, params) => {
    if (method !== CODEX_METHODS.accountLoginCompleted || settled) return;
    const record = asRecord(params);
    const notifLoginId = asString(record?.loginId);
    if (loginId && notifLoginId && notifLoginId !== loginId) return;
    settled = true;
    const ok = record?.success === true;
    if (!ok) {
      const errMsg = asString(record?.error) ?? "Codex companion sign-in failed.";
      void closePeer().finally(() => rejectDone(new CliError("PROVIDER_LOGIN_FAILED", errMsg)));
      return;
    }
    void probeCodexCompanion(peer)
      .then(async (probed) => {
        await closePeer();
        resolveDone({ kind: "chatgpt", accountId: normalizedId, homePath, probed });
      })
      .catch(async (cause: unknown) => {
        await closePeer();
        rejectDone(
          cause instanceof CliError
            ? cause
            : new CliError(
                "PROVIDER_LOGIN_FAILED",
                `Codex sign-in finished, but probing the companion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
        );
      });
  });

  peer.onExit((code) => {
    if (settled) return;
    settled = true;
    rejectDone(
      new CliError(
        "PROVIDER_LOGIN_FAILED",
        `Codex companion exited before login completed (code ${code ?? "null"}).`,
      ),
    );
  });

  let authUrl: string | null = null;
  try {
    await peer.request(
      CODEX_METHODS.initialize,
      { clientInfo: { name: "moxen", version: "0.0.0" }, capabilities: { experimentalApi: true } },
      10_000,
    );
    peer.notify(CODEX_METHODS.initialized, {});
    const started = asRecord(await peer.request(CODEX_METHODS.accountLoginStart, { type: "chatgpt" }, 15_000));
    authUrl = asString(started?.authUrl);
    loginId = asString(started?.loginId);
    if (!authUrl) {
      throw new CliError("PROVIDER_LOGIN_FAILED", "Codex app-server did not return an authUrl for ChatGPT login.");
    }
  } catch (error) {
    settled = true;
    await closePeer();
    throw error;
  }

  const cancel = async (): Promise<void> => {
    if (!settled) {
      settled = true;
      if (loginId && !closed) {
        await peer.request(CODEX_METHODS.accountLoginCancel, { loginId }, 3_000).catch(() => undefined);
      }
      rejectDone(new CliError("PROVIDER_LOGIN_CANCELLED", "Codex companion sign-in was cancelled."));
    }
    await closePeer();
  };

  return {
    sessionId,
    kind: "chatgpt",
    accountId: normalizedId,
    homePath,
    authorizationUrl: authUrl,
    // Codex app-server returns `authUrl` and expects the client to open the browser.
    openBrowser: true,
    message: homePath
      ? `Sign in to the Codex companion in your browser (saved to ${homePath}).`
      : "Sign in to the Codex companion in your browser.",
    async waitForCompletion(timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS): Promise<ProviderAccountLoginCompletion> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          donePromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void cancel();
              reject(new CliError("PROVIDER_LOGIN_TIMEOUT", "Timed out waiting for Codex companion sign-in."));
            }, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cancel,
  };
}

/**
 * Start an in-app CLI login session for a configured provider profile:
 * - `claude`: `claude auth login` (isolated via `CLAUDE_CONFIG_DIR`)
 * - `antigravity`: `agy acp --login` (isolated via `HOME`/`USERPROFILE` + `--gemini-dir`)
 * - `chatgpt`: Codex companion login via `codex app-server` `account/login/start` (isolated via `CODEX_HOME`)
 */
export async function startProviderAccountLoginSession(
  input: ProviderAccountLoginInput,
  deps: ProviderAccountLoginDeps = {},
): Promise<ProviderAccountLoginSession> {
  const normalizedId = input.accountId.trim().toLowerCase();
  if (!normalizedId) {
    throw new CliError("INVALID_CONFIG", "Account id is required to start sign-in.");
  }
  if (input.kind === "chatgpt") {
    return await startCodexCompanionLoginSession(input, deps);
  }
  return await startCliLoginSession(input, deps);
}

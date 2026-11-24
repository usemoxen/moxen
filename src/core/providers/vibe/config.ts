/**
 * Mistral Vibe settings + binary/home/auth helpers.
 *
 * Rules we keep: Moxen never reads, copies, or stores Mistral credentials.
 * Authentication stays owned by the `vibe` CLI (OS keyring or `~/.vibe/.env`).
 * Single-account semantics are preserved in line with Mistral Consumer Terms §1.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appEnv, expandHome } from "../../config.js";
import { binaryOnPath } from "../../infra/process.js";
import { tokenizeLaunchArgs } from "../codex/config.js";

export interface VibeSettings {
  readonly binaryPath: string;
  readonly vibeHome: string;
  /** Raw extra launch args string; tokenized for `vibe-app-server`. */
  readonly launchArgs: string;
}

/**
 * Sentinel meaning "whatever Mistral Vibe itself defaults to": sent as no
 * `model` override on `session/start`, so Vibe uses its own active default.
 */
export const VIBE_DEFAULT_MODEL_SLUG = "vibe-default";

/** The model alias to send, or null for Vibe's own default. */
export function resolveVibeModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim() ?? "";
  return !trimmed || trimmed === VIBE_DEFAULT_MODEL_SLUG ? null : trimmed;
}

export const DEFAULT_VIBE_SETTINGS: VibeSettings = {
  binaryPath: "vibe-app-server",
  vibeHome: "",
  launchArgs: "",
};

export function normalizeVibeSettings(raw: Partial<VibeSettings> = {}): VibeSettings {
  return {
    binaryPath: expandHome(raw.binaryPath?.trim() || DEFAULT_VIBE_SETTINGS.binaryPath),
    vibeHome: raw.vibeHome?.trim() ?? "",
    launchArgs: raw.launchArgs?.trim() ?? "",
  };
}

export function vibeAppServerArgs(
  launchArgs = "",
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = appEnv("VIBE_LAUNCH_ARGS", env)?.trim() || launchArgs.trim();
  return raw.length > 0 ? tokenizeLaunchArgs(raw) : [];
}

/** Explicit `vibeHome` → resolved dir, else `VIBE_HOME` env, else `~/.vibe`. */
export function resolveVibeHome(
  vibeHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = vibeHome.trim();
  if (trimmed.length > 0) return path.resolve(expandHome(trimmed));
  const fromEnv = env.VIBE_HOME?.trim() ?? "";
  if (fromEnv.length > 0) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), ".vibe");
}

/** Build the child environment for `vibe-app-server`, setting `VIBE_HOME` only when explicitly overridden. */
export function vibeProcessEnv(
  vibeHome: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const trimmed = vibeHome.trim();
  if (trimmed.length === 0) return baseEnv;
  return {
    ...baseEnv,
    VIBE_HOME: path.resolve(expandHome(trimmed)),
  };
}

function isExecutableFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Candidate user-local bin locations where `uv tool install mistral-vibe` or
 * Mistral's installer places `vibe-app-server` when a non-interactive daemon
 * inherits a minimal PATH.
 */
function fallbackUserBinCandidates(
  binaryName: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  if (!home) return [];
  const exe = platform === "win32" && !/\.(exe|cmd|bat)$/i.test(binaryName)
    ? `${binaryName}.exe`
    : binaryName;
  return [path.join(home, ".local", "bin", exe)];
}

/**
 * Resolve the configured `vibe-app-server` command: explicit path, PATH lookup,
 * or `~/.local/bin` fallback where `uv tool install` places Vibe.
 */
export function resolveVibeBinary(
  binaryPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly platform?: NodeJS.Platform; readonly isFile?: (file: string) => boolean } = {},
): { readonly command: string; readonly installed: boolean } {
  const platform = options.platform ?? process.platform;
  const checkFile = options.isFile ?? isExecutableFile;
  const configured = expandHome(binaryPath?.trim() || DEFAULT_VIBE_SETTINGS.binaryPath);
  if (path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
    return { command: configured, installed: checkFile(configured) };
  }
  if (binaryOnPath(configured, env)) {
    return { command: configured, installed: true };
  }
  for (const candidate of fallbackUserBinCandidates(configured, env, platform)) {
    if (checkFile(candidate)) {
      return { command: candidate, installed: true };
    }
  }
  return { command: configured, installed: false };
}

const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /missing\s+mistral_api_key/i,
  /invalid\s+api\s+key/i,
  /unauthorized/i,
  /not\s+authenticated/i,
  /authentication\s+required/i,
  /\b401\b/,
];

export function isVibeAuthErrorText(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function vibeSignedOutMessage(): string {
  return (
    "Mistral Vibe is not authenticated. Run `vibe` in a terminal to sign in with " +
    "your Mistral account or register your API key, then start a new thread."
  );
}

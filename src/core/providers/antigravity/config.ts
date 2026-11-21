/**
 * First-class Antigravity CLI (`agy`) provider configuration.
 *
 * Uses the official `agy` binary unmodified (`agy acp` over pinned ACP v1).
 * Launch arguments are tokenized into argv arrays and never shell-joined.
 *
 * Multi-account isolation: `agy` v1.5+ ignores `--gemini-dir` for OAuth login
 * lookup and resolves its auth store from the user's home directory, so extra
 * accounts with an explicit `homePath` set both `HOME` and `USERPROFILE` to
 * `homePath` alongside `--gemini-dir <homePath>/.gemini`. Default accounts
 * without `homePath` leave `HOME` and `USERPROFILE` untouched.
 */
import path from "node:path";

import { expandHome } from "../../config.js";
import type { AntigravityProviderConfig } from "../../types.js";
import { tokenizeLaunchArgs } from "../codex/config.js";
import type { AcpAgentLaunchSpec } from "../acp/transport.js";

export const ANTIGRAVITY_DEFAULT_MODEL_SLUG = "antigravity-default";

export interface AntigravityAccountLaunchOptions {
  readonly id?: string;
  readonly name?: string;
  readonly homePath?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
}

/**
 * Build the process environment for an Antigravity account. When `homePath` is
 * non-empty, isolates `agy`'s auth and state by pointing both `HOME` (POSIX)
 * and `USERPROFILE` (Windows) at the resolved directory. When unset, returns
 * `baseEnv` (with optional `extraEnv` merged) without touching `HOME`/`USERPROFILE`.
 */
export function antigravityAccountEnv(
  homePath: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const trimmed = homePath?.trim() ?? "";
  if (trimmed.length === 0 && (!extraEnv || Object.keys(extraEnv).length === 0)) {
    return baseEnv;
  }
  const merged: NodeJS.ProcessEnv = { ...baseEnv, ...(extraEnv ?? {}) };
  if (trimmed.length > 0) {
    const resolved = path.resolve(expandHome(trimmed));
    merged.HOME = resolved;
    merged.USERPROFILE = resolved;
  }
  return merged;
}

export function antigravityLaunchSpec(
  config: AntigravityProviderConfig | undefined,
  options?: AntigravityAccountLaunchOptions,
): AcpAgentLaunchSpec {
  const command = expandHome(config?.binaryPath?.trim() || "agy");
  const extra = config?.launchArgs?.trim() ? tokenizeLaunchArgs(config.launchArgs.trim()) : [];
  const trimmedHome = options?.homePath?.trim() ?? "";
  const resolvedHome = trimmedHome.length > 0 ? path.resolve(expandHome(trimmedHome)) : null;
  const dirArgs = resolvedHome !== null ? ["--gemini-dir", path.join(resolvedHome, ".gemini")] : [];
  const envOverrides: Record<string, string> = { ...(options?.env ?? {}) };
  if (resolvedHome !== null) {
    envOverrides.HOME = resolvedHome;
    envOverrides.USERPROFILE = resolvedHome;
  }
  return {
    id: options?.id?.trim().toLowerCase() || "antigravity",
    name: options?.name?.trim() || "Antigravity",
    command,
    args: ["acp", ...dirArgs, ...extra],
    ...(Object.keys(envOverrides).length > 0 ? { env: envOverrides } : {}),
  };
}

/**
 * First-class Antigravity CLI (`agy`) provider configuration.
 *
 * Uses the official `agy` binary unmodified (`agy acp` over pinned ACP v1).
 * Launch arguments are tokenized into argv arrays and never shell-joined.
 *
 * Multi-account isolation: `agy` v1.5+ ignores `--gemini-dir` for OAuth login
 * lookup and resolves its auth store from the user's home directory, so extra
 * accounts with an explicit `homePath` set `HOME` and `USERPROFILE` to
 * `homePath` alongside `--gemini-dir <homePath>/.gemini`. They also set
 * `SSH_CONNECTION` (when unset) so `agy`'s `composite_token_storage` uses its
 * built-in per-home file-based token storage instead of the OS keyring — this
 * prevents macOS `"Keychain Not Found"` dialogs when `HOME` is overridden and
 * prevents multiple isolated accounts from colliding in Windows Credential
 * Manager. Default accounts without `homePath` leave `HOME`, `USERPROFILE`,
 * and `SSH_CONNECTION` untouched.
 */
import path from "node:path";

import { expandHome } from "../../config.js";
import type { AntigravityProviderConfig } from "../../types.js";
import { tokenizeLaunchArgs } from "../codex/config.js";
import type { AcpAgentLaunchSpec } from "../acp/transport.js";

export const ANTIGRAVITY_DEFAULT_MODEL_SLUG = "antigravity-default";

/**
 * Standard SSH_CONNECTION marker recognized by `agy`'s `sshDetector` to select
 * per-home file-based token storage instead of the host OS keychain.
 */
export const ANTIGRAVITY_FILE_STORAGE_SSH_MARKER = "127.0.0.1 0 127.0.0.1 22";

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
 * and `USERPROFILE` (Windows) at the resolved directory and enabling `agy`'s
 * per-home file-based token storage via `SSH_CONNECTION` (unless already set).
 * When unset, returns `baseEnv` (with optional `extraEnv` merged) untouched.
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
    if (!merged.SSH_CONNECTION) {
      merged.SSH_CONNECTION = ANTIGRAVITY_FILE_STORAGE_SSH_MARKER;
    }
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
    if (!envOverrides.SSH_CONNECTION && !options?.baseEnv?.SSH_CONNECTION) {
      envOverrides.SSH_CONNECTION = ANTIGRAVITY_FILE_STORAGE_SSH_MARKER;
    }
  }
  return {
    id: options?.id?.trim().toLowerCase() || "antigravity",
    name: options?.name?.trim() || "Antigravity",
    command,
    args: ["acp", ...dirArgs, ...extra],
    ...(Object.keys(envOverrides).length > 0 ? { env: envOverrides } : {}),
  };
}

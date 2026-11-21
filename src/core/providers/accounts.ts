/**
 * Multi-account configuration, normalization, and runtime isolation helpers
 * for Claude (`claude/<id>`), ChatGPT (`chatgpt/<id>`), and Antigravity
 * (`antigravity/<id>`).
 *
 * Security rule: credentials never live in config. Claude and Antigravity
 * isolate CLI-owned logins via directory/environment isolation; ChatGPT keeps
 * its OAuth tokens exclusively in the OS keychain (`keychain:...` ref only).
 */
import path from "node:path";

import { expandHome } from "../config.js";
import { CliError } from "../errors.js";
import { isSecretRef } from "../secrets.js";
import {
  accountInstanceId,
  parseAccountInstanceId,
  type AccountProviderKind,
  type AntigravityAccountConfig,
  type AntigravityProviderConfig,
  type ChatGptAccountConfig,
  type ChatGptProviderConfig,
  type ClaudeAccountConfig,
  type ClaudeProviderConfig,
  type CodexProviderConfig,
  type ProviderAccountBase,
} from "../types.js";
import { tokenizeLaunchArgs } from "./codex/config.js";
import type { AcpAgentLaunchSpec } from "./acp/transport.js";
import { makeClaudeEnv } from "./claude/config.js";
import { antigravityAccountEnv, antigravityLaunchSpec } from "./antigravity/config.js";

export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Plaintext credential field names refused in config files. */
const REJECTED_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "token",
  "secret",
  "clientsecret",
  "client_secret",
  "password",
]);

function fail(fieldPath: string, reason: string): never {
  throw new CliError("INVALID_CONFIG", `${fieldPath} ${reason}`, { details: { path: fieldPath } });
}

function rejectPlaintextSecrets(obj: Record<string, unknown>, fieldPath: string): void {
  for (const key of Object.keys(obj)) {
    if (REJECTED_SECRET_FIELDS.has(key.toLowerCase())) {
      fail(`${fieldPath}.${key}`, "must not store credentials in config.json; use the provider CLI login or OS keychain.");
    }
  }
}

function parseAccountBase(raw: unknown, fieldPath: string): {
  readonly base: ProviderAccountBase;
  readonly obj: Record<string, unknown>;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(fieldPath, "must be an object.");
  }
  const obj = raw as Record<string, unknown>;
  rejectPlaintextSecrets(obj, fieldPath);

  const rawId = typeof obj["id"] === "string" ? obj["id"].trim().toLowerCase() : "";
  if (!rawId || !ACCOUNT_ID_RE.test(rawId)) {
    fail(`${fieldPath}.id`, "must be a lowercase slug (letters, digits, '.', '_', '-').");
  }

  let label: string | undefined;
  if (obj["label"] !== undefined) {
    if (typeof obj["label"] !== "string") fail(`${fieldPath}.label`, "must be a string.");
    const trimmed = obj["label"].trim();
    if (trimmed.length > 0) label = trimmed;
  }

  let enabled: boolean | undefined;
  if (obj["enabled"] !== undefined) {
    if (typeof obj["enabled"] !== "boolean") fail(`${fieldPath}.enabled`, "must be true or false.");
    if (obj["enabled"] === false) enabled = false;
  }

  let model: string | undefined;
  if (obj["model"] !== undefined) {
    if (typeof obj["model"] !== "string") fail(`${fieldPath}.model`, "must be a string.");
    const trimmed = obj["model"].trim();
    if (trimmed.length > 0) model = trimmed;
  }

  let thinkingEffort: string | undefined;
  if (obj["thinkingEffort"] !== undefined) {
    if (typeof obj["thinkingEffort"] !== "string") fail(`${fieldPath}.thinkingEffort`, "must be a string.");
    const trimmed = obj["thinkingEffort"].trim();
    if (trimmed.length > 0) thinkingEffort = trimmed;
  }

  let env: Record<string, string> | undefined;
  if (obj["env"] !== undefined) {
    if (obj["env"] === null || typeof obj["env"] !== "object" || Array.isArray(obj["env"])) {
      fail(`${fieldPath}.env`, "must be a string map.");
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj["env"] as Record<string, unknown>)) {
      if (typeof value !== "string") fail(`${fieldPath}.env.${key}`, "must be a string.");
      entries[key] = value;
    }
    if (Object.keys(entries).length > 0) env = entries;
  }

  return {
    obj,
    base: {
      id: rawId,
      ...(label !== undefined ? { label } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(env !== undefined ? { env } : {}),
    },
  };
}

function optionalString(obj: Record<string, unknown>, key: string, fieldPath: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${fieldPath}.${key}`, "must be a string.");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function preserveUnknown<T extends object>(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
  target: T,
): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key) && !(key in out)) out[key] = value;
  }
  return out as T;
}

const CLAUDE_KNOWN = new Set(["id", "label", "enabled", "model", "thinkingEffort", "env", "homePath", "binaryPath", "launchArgs"]);

export function normalizeClaudeAccount(raw: unknown, fieldPath: string): ClaudeAccountConfig {
  const { base, obj } = parseAccountBase(raw, fieldPath);
  const homePath = optionalString(obj, "homePath", fieldPath);
  const binaryPath = optionalString(obj, "binaryPath", fieldPath);
  let launchArgs: string[] | undefined;
  if (obj["launchArgs"] !== undefined) {
    if (Array.isArray(obj["launchArgs"]) && obj["launchArgs"].every((entry) => typeof entry === "string")) {
      const cleaned = (obj["launchArgs"] as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
      if (cleaned.length > 0) launchArgs = cleaned;
    } else if (typeof obj["launchArgs"] === "string") {
      try {
        const parsed = tokenizeLaunchArgs(obj["launchArgs"]);
        if (parsed.length > 0) launchArgs = parsed;
      } catch (cause) {
        fail(`${fieldPath}.launchArgs`, cause instanceof Error ? cause.message : "has invalid syntax.");
      }
    } else {
      fail(`${fieldPath}.launchArgs`, "must be a list of strings or launch-arguments string.");
    }
  }
  return preserveUnknown(obj, CLAUDE_KNOWN, {
    ...base,
    ...(homePath !== undefined ? { homePath } : {}),
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    ...(launchArgs !== undefined ? { launchArgs } : {}),
  });
}

const ANTIGRAVITY_KNOWN = new Set(["id", "label", "enabled", "model", "thinkingEffort", "env", "homePath", "binaryPath", "launchArgs"]);

export function normalizeAntigravityAccount(raw: unknown, fieldPath: string): AntigravityAccountConfig {
  const { base, obj } = parseAccountBase(raw, fieldPath);
  const homePath = optionalString(obj, "homePath", fieldPath);
  const binaryPath = optionalString(obj, "binaryPath", fieldPath);
  let launchArgs: string | undefined;
  if (obj["launchArgs"] !== undefined) {
    if (typeof obj["launchArgs"] !== "string") fail(`${fieldPath}.launchArgs`, "must be a string.");
    try {
      tokenizeLaunchArgs(obj["launchArgs"]);
    } catch (cause) {
      fail(`${fieldPath}.launchArgs`, cause instanceof Error ? cause.message : "has invalid syntax.");
    }
    const trimmed = obj["launchArgs"].trim();
    if (trimmed.length > 0) launchArgs = trimmed;
  }
  return preserveUnknown(obj, ANTIGRAVITY_KNOWN, {
    ...base,
    ...(homePath !== undefined ? { homePath } : {}),
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    ...(launchArgs !== undefined ? { launchArgs } : {}),
  });
}

const CHATGPT_KNOWN = new Set([
  "id",
  "label",
  "enabled",
  "model",
  "thinkingEffort",
  "env",
  "email",
  "userId",
  "workspaceName",
  "accountId",
  "planType",
  "authRef",
  "codexHomePath",
  "codexBinaryPath",
  "codexLaunchArgs",
  "codexVerified",
]);

export function normalizeChatGptAccount(raw: unknown, fieldPath: string): ChatGptAccountConfig {
  const { base, obj } = parseAccountBase(raw, fieldPath);
  const email = optionalString(obj, "email", fieldPath);
  const userId = optionalString(obj, "userId", fieldPath);
  const workspaceName = optionalString(obj, "workspaceName", fieldPath);
  const accountId = optionalString(obj, "accountId", fieldPath);
  const planType = optionalString(obj, "planType", fieldPath);
  const authRef = optionalString(obj, "authRef", fieldPath);
  if (authRef !== undefined && !isSecretRef(authRef)) {
    fail(`${fieldPath}.authRef`, "must be an OS keychain reference (keychain:<name>), never a raw token.");
  }
  const codexHomePath = optionalString(obj, "codexHomePath", fieldPath);
  const codexBinaryPath = optionalString(obj, "codexBinaryPath", fieldPath);
  let codexLaunchArgs: string | undefined;
  if (obj["codexLaunchArgs"] !== undefined) {
    if (typeof obj["codexLaunchArgs"] !== "string") fail(`${fieldPath}.codexLaunchArgs`, "must be a string.");
    try {
      tokenizeLaunchArgs(obj["codexLaunchArgs"]);
    } catch (cause) {
      fail(`${fieldPath}.codexLaunchArgs`, cause instanceof Error ? cause.message : "has invalid syntax.");
    }
    const trimmed = obj["codexLaunchArgs"].trim();
    if (trimmed.length > 0) codexLaunchArgs = trimmed;
  }
  let codexVerified: boolean | undefined;
  if (obj["codexVerified"] !== undefined) {
    if (typeof obj["codexVerified"] !== "boolean") fail(`${fieldPath}.codexVerified`, "must be true or false.");
    if (obj["codexVerified"]) codexVerified = true;
  }
  return preserveUnknown(obj, CHATGPT_KNOWN, {
    ...base,
    ...(email !== undefined ? { email } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(planType !== undefined ? { planType } : {}),
    ...(authRef !== undefined ? { authRef } : {}),
    ...(codexHomePath !== undefined ? { codexHomePath } : {}),
    ...(codexBinaryPath !== undefined ? { codexBinaryPath } : {}),
    ...(codexLaunchArgs !== undefined ? { codexLaunchArgs } : {}),
    ...(codexVerified !== undefined ? { codexVerified } : {}),
  });
}

function normalizeAccountList<T extends ProviderAccountBase>(
  raw: unknown,
  listPath: string,
  parseOne: (entry: unknown, entryPath: string) => T,
): T[] {
  if (!Array.isArray(raw)) fail(listPath, "must be a list.");
  const seen = new Set<string>();
  const out: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const entryPath =
      entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["id"] === "string"
        ? `${listPath}[${(entry as Record<string, unknown>)["id"]}]`
        : `${listPath}[${index}]`;
    const parsed = parseOne(entry, entryPath);
    if (seen.has(parsed.id)) {
      fail(listPath, `uses id "${parsed.id}" twice.`);
    }
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

export function normalizeClaudeAccounts(raw: unknown): ClaudeAccountConfig[] {
  return normalizeAccountList(raw, "providers.claude.accounts", normalizeClaudeAccount);
}

export function normalizeAntigravityAccounts(raw: unknown): AntigravityAccountConfig[] {
  return normalizeAccountList(raw, "providers.antigravity.accounts", normalizeAntigravityAccount);
}

export function normalizeChatGptAccounts(raw: unknown): ChatGptAccountConfig[] {
  return normalizeAccountList(raw, "providers.chatgpt.accounts", normalizeChatGptAccount);
}

/** Human-readable provider display name for an account instance. */
export function accountDisplayName(kind: AccountProviderKind, account: Pick<ProviderAccountBase, "id" | "label">): string {
  const base = kind === "claude" ? "Claude Code" : kind === "chatgpt" ? "ChatGPT" : "Antigravity";
  const tag = account.label?.trim() || account.id;
  return `${base} (${tag})`;
}

/** Find a configured account entry for an instance id (`claude/<id>`, `chatgpt/<id>`, `antigravity/<id>`). */
export function findAccountForInstance(
  providers: {
    readonly claude?: ClaudeProviderConfig;
    readonly chatgpt?: ChatGptProviderConfig;
    readonly antigravity?: AntigravityProviderConfig;
  } | undefined,
  instanceId: string,
): ProviderAccountBase | null {
  const parsed = parseAccountInstanceId(instanceId);
  if (!parsed) return null;
  const list =
    parsed.kind === "claude"
      ? providers?.claude?.accounts
      : parsed.kind === "chatgpt"
        ? providers?.chatgpt?.accounts
        : providers?.antigravity?.accounts;
  return list?.find((entry) => entry.id.trim().toLowerCase() === parsed.accountId) ?? null;
}

export interface ResolvedClaudeAccount {
  readonly accountId: string | null;
  readonly instanceId: string;
  readonly usageKey: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly settings: ClaudeProviderConfig;
  readonly env: NodeJS.ProcessEnv;
}

/** Resolve effective Claude settings and isolated env (`CLAUDE_CONFIG_DIR` only, never `HOME`) for `instanceId`. */
export function resolveClaudeAccount(
  config: ClaudeProviderConfig | undefined,
  instanceId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ResolvedClaudeAccount {
  const parsed = parseAccountInstanceId(instanceId);
  const accountId = parsed?.kind === "claude" ? parsed.accountId : null;
  const account = accountId !== null
    ? config?.accounts?.find((entry) => entry.id.trim().toLowerCase() === accountId)
    : undefined;
  const merged: ClaudeProviderConfig = {
    ...(config ?? {}),
    ...(account?.binaryPath !== undefined ? { binaryPath: account.binaryPath } : {}),
    ...(account?.homePath !== undefined ? { homePath: account.homePath } : {}),
    ...(account?.launchArgs !== undefined ? { launchArgs: account.launchArgs } : {}),
    ...(account?.model !== undefined ? { model: account.model } : {}),
    ...(account?.thinkingEffort !== undefined ? { thinkingEffort: account.thinkingEffort } : {}),
  };
  const withExtra = account?.env ? { ...baseEnv, ...account.env } : baseEnv;
  const env = makeClaudeEnv({ homePath: merged.homePath ?? "" }, withExtra);
  const canonicalId = accountId !== null ? accountInstanceId("claude", accountId) : "claudeAgent";
  return {
    accountId,
    instanceId: canonicalId,
    usageKey: accountId !== null ? canonicalId : "claude",
    displayName: account ? accountDisplayName("claude", account) : accountId ? `Claude Code (${accountId})` : "Claude Code",
    enabled: account?.enabled !== false,
    settings: merged,
    env,
  };
}

export interface ResolvedAntigravityAccount {
  readonly accountId: string | null;
  readonly instanceId: string;
  readonly usageKey: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly homePath: string | null;
  readonly spec: AcpAgentLaunchSpec;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Resolve effective Antigravity (`agy`) launch spec and isolated env for `instanceId`.
 * When `account.homePath` is set, isolates `agy` via `HOME`/`USERPROFILE` plus
 * `--gemini-dir <homePath>/.gemini`. Default accounts without `homePath` inherit
 * the user's real `HOME` untouched.
 */
export function resolveAntigravityAccount(
  config: AntigravityProviderConfig | undefined,
  instanceId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ResolvedAntigravityAccount {
  const parsed = parseAccountInstanceId(instanceId);
  const accountId = parsed?.kind === "antigravity" ? parsed.accountId : null;
  const account = accountId !== null
    ? config?.accounts?.find((entry) => entry.id.trim().toLowerCase() === accountId)
    : undefined;
  const mergedConfig: AntigravityProviderConfig = {
    ...(config ?? {}),
    ...(account?.binaryPath !== undefined ? { binaryPath: account.binaryPath } : {}),
    ...(account?.launchArgs !== undefined ? { launchArgs: account.launchArgs } : {}),
  };
  const resolvedHome = account?.homePath?.trim() ? path.resolve(expandHome(account.homePath.trim())) : null;
  const env = antigravityAccountEnv(account?.homePath, baseEnv, account?.env);
  const canonicalId = accountId !== null ? accountInstanceId("antigravity", accountId) : "antigravity";
  const displayName = account
    ? accountDisplayName("antigravity", account)
    : accountId
      ? `Antigravity (${accountId})`
      : "Antigravity";
  const spec = antigravityLaunchSpec(mergedConfig, {
    id: canonicalId,
    name: displayName,
    homePath: account?.homePath,
    env: account?.env,
    baseEnv,
  });
  return {
    accountId,
    instanceId: canonicalId,
    usageKey: canonicalId,
    displayName,
    enabled: account?.enabled !== false,
    homePath: resolvedHome,
    spec,
    env,
  };
}

export interface ResolvedChatGptAccount {
  readonly accountId: string | null;
  readonly instanceId: string;
  readonly usageKey: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly account: ChatGptAccountConfig | null;
  readonly codexSettings: CodexProviderConfig | null;
}

/** Resolve a ChatGPT account (`chatgpt/<id>`) and its paired Codex companion settings (if paired). */
export function resolveChatGptAccount(
  config: ChatGptProviderConfig | undefined,
  codexConfig: CodexProviderConfig | undefined,
  instanceId: string,
): ResolvedChatGptAccount {
  const parsed = parseAccountInstanceId(instanceId);
  const accountId = parsed?.kind === "chatgpt" ? parsed.accountId : null;
  const account = accountId !== null
    ? (config?.accounts?.find((entry) => entry.id.trim().toLowerCase() === accountId) ?? null)
    : null;
  const canonicalId = accountId !== null ? accountInstanceId("chatgpt", accountId) : "chatgpt";
  const displayName = account
    ? accountDisplayName("chatgpt", account)
    : accountId
      ? `ChatGPT (${accountId})`
      : "ChatGPT";
  const codexSettings: CodexProviderConfig | null =
    account?.codexHomePath !== undefined || account?.codexVerified
      ? {
          ...(codexConfig ?? {}),
          ...(account?.codexBinaryPath !== undefined ? { binaryPath: account.codexBinaryPath } : {}),
          ...(account?.codexHomePath !== undefined ? { homePath: account.codexHomePath } : {}),
          ...(account?.codexLaunchArgs !== undefined ? { launchArgs: account.codexLaunchArgs } : {}),
        }
      : null;
  return {
    accountId,
    instanceId: canonicalId,
    usageKey: canonicalId,
    displayName,
    enabled: account?.enabled !== false,
    account,
    codexSettings,
  };
}

/**
 * Multi-account configuration, normalization, and runtime isolation helpers
 * for Claude (`claude/<id>`), ChatGPT (`chatgpt/<id>`), and Antigravity
 * (`antigravity/<id>`).
 *
 * Security rule: credentials never live in config. Claude and Antigravity
 * isolate CLI-owned logins via directory/environment isolation; ChatGPT keeps
 * its OAuth tokens exclusively in the OS keychain (`keychain:...` ref only).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appHomeDir, expandHome } from "../config.js";
import { CliError } from "../errors.js";
import { isSecretRef } from "../secrets.js";
import {
  accountInstanceId,
  managedAccountHomeDisplayPath,
  parseAccountInstanceId,
  type AccountProviderKind,
  type AntigravityAccountConfig,
  type AntigravityProviderConfig,
  type ChatGptAccountConfig,
  type ChatGptProviderConfig,
  type ClaudeAccountConfig,
  type ClaudeProviderConfig,
  type CliConfig,
  type CodexProviderConfig,
  type ProviderAccountBase,
  type ProviderAccountSaveInput,
  type ProviderAccountSummary,
  type ProvidersConfig,
} from "../types.js";
import { tokenizeLaunchArgs } from "./codex/config.js";
import type { AcpAgentLaunchSpec } from "./acp/transport.js";
import { makeClaudeEnv } from "./claude/config.js";
import { antigravityAccountEnv, antigravityLaunchSpec } from "./antigravity/config.js";

export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export { managedAccountHomeDisplayPath };

/** Resolved absolute path of the Moxen-managed isolated directory for an account. */
export function managedAccountHomePath(kind: AccountProviderKind, id: string, homeDir?: string): string {
  const normalized = id.trim().toLowerCase() || "default";
  return path.join(appHomeDir(homeDir), "accounts", kind, normalized);
}

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

export { resolveProfileProviderConfig } from "../types.js";

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
  // Independent profile: when addressed as `claude/<id>`, use ONLY that profile's own settings
  // (sensible defaults when unset; never inherit a parent `providers.claude.*`).
  const settings: ClaudeProviderConfig = account
    ? { ...account }
    : accountId !== null
      ? {}
      : { ...(config ?? {}) };
  const withExtra = account?.env ? { ...baseEnv, ...account.env } : baseEnv;
  const env = makeClaudeEnv({ homePath: settings.homePath ?? "" }, withExtra);
  const canonicalId = accountId !== null ? accountInstanceId("claude", accountId) : "claudeAgent";
  return {
    accountId,
    instanceId: canonicalId,
    usageKey: accountId !== null ? canonicalId : "claude",
    displayName: account ? accountDisplayName("claude", account) : accountId ? `Claude Code (${accountId})` : "Claude Code",
    enabled: account?.enabled !== false,
    settings,
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
  const mergedConfig: AntigravityProviderConfig = account
    ? { ...account }
    : accountId !== null
      ? {}
      : { ...(config ?? {}) };
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

/** Build a public, credential-free summary for one Claude, ChatGPT, or Antigravity account. */
/** Non-secret authentication status & identity probed from a CLI account's local state. */
export interface AccountAuthProbe {
  readonly signedIn: boolean;
  readonly email: string | null;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expandAccountHome(raw: string, homeDir: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return expandHome(trimmed);
}

/**
 * Inspect non-secret Claude Code authentication metadata for an account:
 * reads only `oauthAccount.emailAddress` / `accountUuid` from `.claude.json`
 * (or checks `ANTHROPIC_API_KEY` in env) without touching or returning tokens.
 */
export function probeClaudeAccountAuth(
  account: Pick<ClaudeAccountConfig, "homePath" | "env">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): AccountAuthProbe {
  const configuredHome = account.homePath?.trim();
  const envConfigDir = account.env?.CLAUDE_CONFIG_DIR?.trim() || baseEnv.CLAUDE_CONFIG_DIR?.trim();
  const claudeJsonPath = configuredHome
    ? path.join(path.resolve(expandAccountHome(configuredHome, homeDir)), ".claude.json")
    : envConfigDir
      ? path.join(path.resolve(expandAccountHome(envConfigDir, homeDir)), ".claude.json")
      : path.join(homeDir, ".claude.json");
  const root = readJsonRecord(claudeJsonPath);
  const oauth =
    root && root.oauthAccount !== null && typeof root.oauthAccount === "object" && !Array.isArray(root.oauthAccount)
      ? (root.oauthAccount as Record<string, unknown>)
      : null;
  const email = typeof oauth?.emailAddress === "string" && oauth.emailAddress.trim().length > 0 ? oauth.emailAddress.trim() : null;
  const accountUuid = typeof oauth?.accountUuid === "string" && oauth.accountUuid.trim().length > 0 ? oauth.accountUuid.trim() : null;
  if (email || accountUuid) {
    return { signedIn: true, email };
  }
  const hasApiKey = Boolean(account.env?.ANTHROPIC_API_KEY?.trim() || baseEnv.ANTHROPIC_API_KEY?.trim());
  return { signedIn: hasApiKey, email: null };
}

/**
 * Inspect non-secret Antigravity (`agy`) authentication metadata for an account:
 * checks `cache/acp-auth-state.json` and extracts only `id_token_email` / presence
 * from `antigravity-oauth-token` without ever returning or logging any token.
 */
export function probeAntigravityAccountAuth(
  account: Pick<AntigravityAccountConfig, "homePath" | "env">,
  _baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): AccountAuthProbe {
  const configuredHome = account.homePath?.trim();
  const resolvedBase = configuredHome ? path.resolve(expandAccountHome(configuredHome, homeDir)) : homeDir;
  const agyDir = path.join(resolvedBase, ".gemini", "antigravity-cli");
  const tokenDoc = readJsonRecord(path.join(agyDir, "antigravity-oauth-token"));
  const email =
    typeof tokenDoc?.id_token_email === "string" && tokenDoc.id_token_email.trim().length > 0
      ? tokenDoc.id_token_email.trim()
      : null;
  const hasToken = typeof tokenDoc?.token === "string" && tokenDoc.token.trim().length > 0;
  if (email || hasToken) {
    return { signedIn: true, email };
  }
  const authState = readJsonRecord(path.join(agyDir, "cache", "acp-auth-state.json"));
  const methodId = typeof authState?.methodId === "string" && authState.methodId.trim().length > 0 ? authState.methodId.trim() : null;
  return { signedIn: methodId !== null, email: null };
}

export function summarizeAccount(
  kind: "claude",
  account: ClaudeAccountConfig,
  auth?: boolean | AccountAuthProbe,
): ProviderAccountSummary;
export function summarizeAccount(
  kind: "antigravity",
  account: AntigravityAccountConfig,
  auth?: boolean | AccountAuthProbe,
): ProviderAccountSummary;
export function summarizeAccount(
  kind: "chatgpt",
  account: ChatGptAccountConfig,
  auth?: boolean | AccountAuthProbe,
): ProviderAccountSummary;
export function summarizeAccount(
  kind: AccountProviderKind,
  account: ClaudeAccountConfig | AntigravityAccountConfig | ChatGptAccountConfig,
  auth?: boolean | AccountAuthProbe,
): ProviderAccountSummary {
  const id = account.id.trim().toLowerCase();
  const instanceId = accountInstanceId(kind, id);
  const label = account.label?.trim() || id;
  const probedSignedIn = typeof auth === "boolean" ? auth : auth?.signedIn;
  const probedEmail = typeof auth === "object" && auth !== null ? auth.email : null;
  const base = {
    kind,
    id,
    instanceId,
    label,
    enabled: account.enabled !== false,
    env: account.env ? { ...account.env } : {},
    model: account.model ?? null,
    thinkingEffort: account.thinkingEffort ?? null,
  };
  if (kind === "claude") {
    const claude = account as ClaudeAccountConfig;
    return {
      ...base,
      homePath: claude.homePath ?? null,
      binaryPath: claude.binaryPath ?? null,
      launchArgs: claude.launchArgs?.length ? claude.launchArgs.join(" ") : null,
      email: probedEmail,
      workspaceName: null,
      planType: null,
      signedIn: probedSignedIn ?? null,
      codexHomePath: null,
      codexBinaryPath: null,
      codexLaunchArgs: null,
      codexVerified: false,
    };
  }
  if (kind === "antigravity") {
    const agy = account as AntigravityAccountConfig;
    return {
      ...base,
      homePath: agy.homePath ?? null,
      binaryPath: agy.binaryPath ?? null,
      launchArgs: agy.launchArgs ?? null,
      email: probedEmail,
      workspaceName: null,
      planType: null,
      signedIn: probedSignedIn ?? null,
      codexHomePath: null,
      codexBinaryPath: null,
      codexLaunchArgs: null,
      codexVerified: false,
    };
  }
  const chatgpt = account as ChatGptAccountConfig;
  return {
    ...base,
    homePath: null,
    binaryPath: null,
    launchArgs: null,
    email: chatgpt.email ?? probedEmail ?? null,
    workspaceName: chatgpt.workspaceName ?? null,
    planType: chatgpt.planType ?? null,
    signedIn: probedSignedIn ?? Boolean(chatgpt.authRef),
    codexHomePath: chatgpt.codexHomePath ?? null,
    codexBinaryPath: chatgpt.codexBinaryPath ?? null,
    codexLaunchArgs: chatgpt.codexLaunchArgs ?? null,
    codexVerified: Boolean(chatgpt.codexVerified),
  };
}

/** Return credential-free summaries of all configured accounts in stable order. */
export function summarizeProviderAccounts(
  providers: ProvidersConfig | undefined,
  authByInstance?: ReadonlyMap<string, boolean | AccountAuthProbe>,
): ProviderAccountSummary[] {
  const out: ProviderAccountSummary[] = [];
  for (const account of providers?.claude?.accounts ?? []) {
    const instanceId = accountInstanceId("claude", account.id.trim().toLowerCase());
    out.push(summarizeAccount("claude", account, authByInstance?.get(instanceId)));
  }
  for (const account of providers?.chatgpt?.accounts ?? []) {
    const instanceId = accountInstanceId("chatgpt", account.id.trim().toLowerCase());
    out.push(summarizeAccount("chatgpt", account, authByInstance?.get(instanceId)));
  }
  for (const account of providers?.antigravity?.accounts ?? []) {
    const instanceId = accountInstanceId("antigravity", account.id.trim().toLowerCase());
    out.push(summarizeAccount("antigravity", account, authByInstance?.get(instanceId)));
  }
  return out;
}

function applyOptionalPatch<T>(existing: T | undefined, patch: T | null | undefined): T | undefined {
  if (patch === undefined) return existing;
  if (patch === null) return undefined;
  if (typeof patch === "string" && patch.trim() === "") return undefined;
  return patch;
}

function applyEnvPatch(
  existing: Record<string, string> | undefined,
  patch: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> | undefined {
  if (patch === undefined) return existing;
  if (patch === null || Object.keys(patch).length === 0) return undefined;
  return { ...patch };
}

/** Create or update one configured provider account, preserving OAuth metadata on edits. */
export function upsertProviderAccount(
  config: CliConfig,
  input: ProviderAccountSaveInput,
): { readonly config: CliConfig; readonly account: ProviderAccountSummary; readonly created: boolean } {
  const normalizedId = input.id.trim().toLowerCase();
  const fieldPath = `providers.${input.kind}.accounts[${normalizedId || input.id}]`;

  if (input.kind === "claude") {
    const existingList = config.providers?.claude?.accounts ?? [];
    const existing = existingList.find((entry) => entry.id.trim().toLowerCase() === normalizedId);
    const launchArgsPatch =
      input.launchArgs === undefined
        ? existing?.launchArgs
        : input.launchArgs === null
          ? undefined
          : input.launchArgs;
    const raw: Record<string, unknown> = {
      ...(existing ?? {}),
      id: normalizedId,
      label: applyOptionalPatch(existing?.label, input.label),
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled,
      homePath: applyOptionalPatch(existing?.homePath, input.homePath),
      binaryPath: applyOptionalPatch(existing?.binaryPath, input.binaryPath),
      launchArgs: launchArgsPatch,
      env: applyEnvPatch(existing?.env, input.env),
      model: applyOptionalPatch(existing?.model, input.model),
      thinkingEffort: applyOptionalPatch(existing?.thinkingEffort, input.thinkingEffort),
    };
    const saved = normalizeClaudeAccount(raw, fieldPath);
    const accounts = existing
      ? existingList.map((entry) => (entry.id.trim().toLowerCase() === saved.id ? saved : entry))
      : [...existingList, saved];
    const next: CliConfig = {
      ...config,
      providers: {
        ...config.providers,
        claude: { ...config.providers?.claude, accounts },
      },
    };
    return { config: next, account: summarizeAccount("claude", saved), created: !existing };
  }

  if (input.kind === "antigravity") {
    const existingList = config.providers?.antigravity?.accounts ?? [];
    const existing = existingList.find((entry) => entry.id.trim().toLowerCase() === normalizedId);
    const launchArgsString =
      input.launchArgs === undefined
        ? existing?.launchArgs
        : input.launchArgs === null
          ? undefined
          : Array.isArray(input.launchArgs)
            ? input.launchArgs.join(" ")
            : input.launchArgs;
    const raw: Record<string, unknown> = {
      ...(existing ?? {}),
      id: normalizedId,
      label: applyOptionalPatch(existing?.label, input.label),
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled,
      homePath: applyOptionalPatch(existing?.homePath, input.homePath),
      binaryPath: applyOptionalPatch(existing?.binaryPath, input.binaryPath),
      launchArgs: launchArgsString,
      env: applyEnvPatch(existing?.env, input.env),
      model: applyOptionalPatch(existing?.model, input.model),
      thinkingEffort: applyOptionalPatch(existing?.thinkingEffort, input.thinkingEffort),
    };
    const saved = normalizeAntigravityAccount(raw, fieldPath);
    const accounts = existing
      ? existingList.map((entry) => (entry.id.trim().toLowerCase() === saved.id ? saved : entry))
      : [...existingList, saved];
    const next: CliConfig = {
      ...config,
      providers: {
        ...config.providers,
        antigravity: { ...config.providers?.antigravity, accounts },
      },
    };
    return { config: next, account: summarizeAccount("antigravity", saved), created: !existing };
  }

  const existingList = config.providers?.chatgpt?.accounts ?? [];
  const existing = existingList.find((entry) => entry.id.trim().toLowerCase() === normalizedId);
  const nextCodexHome = applyOptionalPatch(existing?.codexHomePath, input.codexHomePath);
  const codexHomeChanged = input.codexHomePath !== undefined && nextCodexHome !== existing?.codexHomePath;
  const raw: Record<string, unknown> = {
    ...(existing ?? {}),
    id: normalizedId,
    label: applyOptionalPatch(existing?.label, input.label),
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled,
    env: applyEnvPatch(existing?.env, input.env),
    model: applyOptionalPatch(existing?.model, input.model),
    thinkingEffort: applyOptionalPatch(existing?.thinkingEffort, input.thinkingEffort),
    codexHomePath: nextCodexHome,
    codexBinaryPath: applyOptionalPatch(existing?.codexBinaryPath, input.codexBinaryPath),
    codexLaunchArgs: applyOptionalPatch(existing?.codexLaunchArgs, input.codexLaunchArgs),
    // Changing or clearing the companion home invalidates prior identity verification.
    codexVerified: codexHomeChanged ? undefined : existing?.codexVerified,
  };
  const saved = normalizeChatGptAccount(raw, fieldPath);
  const accounts = existing
    ? existingList.map((entry) => (entry.id.trim().toLowerCase() === saved.id ? saved : entry))
    : [...existingList, saved];
  const next: CliConfig = {
    ...config,
    providers: {
      ...config.providers,
      chatgpt: { ...config.providers?.chatgpt, accounts },
    },
  };
  return { config: next, account: summarizeAccount("chatgpt", saved), created: !existing };
}

/** Remove a configured provider account; returns any ChatGPT `authRef` so the caller can clear the keychain. */
export function removeProviderAccount(
  config: CliConfig,
  kind: AccountProviderKind,
  id: string,
): { readonly config: CliConfig; readonly removed: boolean; readonly authRef: string | null } {
  const target = id.trim().toLowerCase();
  if (kind === "claude") {
    const existing = config.providers?.claude?.accounts ?? [];
    const remaining = existing.filter((entry) => entry.id.trim().toLowerCase() !== target);
    if (remaining.length === existing.length) return { config, removed: false, authRef: null };
    const { accounts: _old, ...restClaude } = config.providers?.claude ?? {};
    return {
      config: {
        ...config,
        providers: {
          ...config.providers,
          claude: remaining.length > 0 ? { ...restClaude, accounts: remaining } : restClaude,
        },
      },
      removed: true,
      authRef: null,
    };
  }
  if (kind === "antigravity") {
    const existing = config.providers?.antigravity?.accounts ?? [];
    const remaining = existing.filter((entry) => entry.id.trim().toLowerCase() !== target);
    if (remaining.length === existing.length) return { config, removed: false, authRef: null };
    const { accounts: _old, ...restAgy } = config.providers?.antigravity ?? {};
    return {
      config: {
        ...config,
        providers: {
          ...config.providers,
          antigravity: remaining.length > 0 ? { ...restAgy, accounts: remaining } : restAgy,
        },
      },
      removed: true,
      authRef: null,
    };
  }
  const existing = config.providers?.chatgpt?.accounts ?? [];
  const victim = existing.find((entry) => entry.id.trim().toLowerCase() === target);
  if (!victim) return { config, removed: false, authRef: null };
  const remaining = existing.filter((entry) => entry.id.trim().toLowerCase() !== target);
  const { accounts: _old, ...restChatGpt } = config.providers?.chatgpt ?? {};
  return {
    config: {
      ...config,
      providers: {
        ...config.providers,
        chatgpt: remaining.length > 0 ? { ...restChatGpt, accounts: remaining } : restChatGpt,
      },
    },
    removed: true,
    authRef: victim.authRef ?? null,
  };
}

/** Enable or disable an existing provider account without removing it. */
export function setProviderAccountEnabled(
  config: CliConfig,
  kind: AccountProviderKind,
  id: string,
  enabled: boolean,
): { readonly config: CliConfig; readonly account: ProviderAccountSummary } {
  const target = id.trim().toLowerCase();
  const list =
    kind === "claude"
      ? config.providers?.claude?.accounts
      : kind === "chatgpt"
        ? config.providers?.chatgpt?.accounts
        : config.providers?.antigravity?.accounts;
  const found = list?.find((entry) => entry.id.trim().toLowerCase() === target);
  if (!found) {
    throw new CliError("ACCOUNT_NOT_FOUND", `No ${kind} account "${id}" is configured.`, {
      exitCode: 4,
      details: { kind, id },
    });
  }
  const updated = upsertProviderAccount(config, { kind, id: found.id, enabled });
  return { config: updated.config, account: updated.account };
}

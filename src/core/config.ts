import { readFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliError } from "./errors.js";
import { parseMcpServers, parseNameList, type McpServerEntry } from "./mcp.js";
import { normalizeHarnessConfig, parseHarnessProfile } from "./providers/harness/profiles.js";
import { STICKY_INTERACTION_MODES } from "./interactionmode.js";
import { HIDDEN_VALUE, writeListValue } from "./configlist.js";
import { normalizeHandoffModels, normalizeModeModels } from "./handoffmodels.js";
import { listTarget, parseSettingValue, secretKeyName, settingDescriptor, writeSetting } from "./configschema.js";
import { isSecretRef, secretRef, writeSecret } from "./secrets.js";
import { normalizePriceMap } from "./modelprices.js";
import type {
  ClaudeProviderConfig,
  CodexProviderConfig,
  CliConfig,
  ForgeConfig,
  GitConfig,
  HarnessProfileConfig,
  HarnessProviderConfig,
  InteractionMode,
  ModelPriceMaps,
  OpencodeProviderConfig,
  OpenMode,
  ProjectPolicy,
  PromptImproverConfig,
  RuntimeMode,
  ProvidersConfig,
  SpeedMode,
  ThreadEnvMode,
  UpdatesConfig,
  RemoteConfig,
  LongThreadsConfig,
  UiConfig,
  SkillsConfig,
  WebConfig,
  WorkspaceMode,
} from "./types.js";

export const DEFAULT_CONFIG: CliConfig = {
  projectPolicy: "create",
  workspaceMode: "repo",
  openMode: "auto",
  threadEnvMode: "local",
  runtimeMode: "full-access",
  interactionMode: "default",
  sessionTtl: "1h",
};

const projectPolicies = new Set<ProjectPolicy>(["create", "existing"]);
const workspaceModes = new Set<WorkspaceMode>(["repo", "folder"]);
const openModes = new Set<OpenMode>(["auto", "desktop", "browser", "none"]);
const threadEnvModes = new Set<ThreadEnvMode>(["auto", "local", "worktree"]);
const runtimeModes = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
const interactionModes = new Set<InteractionMode>(STICKY_INTERACTION_MODES);
/** A saved mode since removed, read as Build (the shared migration rule): plan mode (MXN-136). */
const REMOVED_INTERACTION_MODES = new Set(["plan"]);
const speedModes = new Set<SpeedMode>(["standard", "fast"]);

/**
 * Every settable key, straight from the schema table — the CLI and the
 * TUI therefore accept exactly the same set. Dotted paths
 * (`providers.claude.binaryPath`) are keys like any other. Re-exported, not
 * copied: the schema imports this module back (through `mcp.ts`), so a copy
 * taken while it loads would read the table before it exists.
 */
export { SETTING_KEYS as CONFIG_KEYS } from "./configschema.js";
export type ConfigKey = string;

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * The product's name on every surface that persists it: the home and
 * config directories, the env prefix, the project file and the git ref
 * namespace. One constant, so the name lives in exactly one place.
 */
export const APP_NAME = "moxen";

/** The name in prose — what an agent is told it runs in. */
export const APP_DISPLAY_NAME = "Moxen";

/** `MOXEN_<name>` from the environment. */
export function appEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MOXEN_${name}`];
}

/** `~/.moxen` — threads, caches, attachments. */
export function appHomeDir(home: string = os.homedir()): string {
  return path.join(home, `.${APP_NAME}`);
}

function configRoot(): string {
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  return process.env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(process.env.XDG_CONFIG_HOME))
    : path.join(os.homedir(), ".config");
}

/**
 * On a new launch of the real program (never the mock, a test, or anything
 * with `MOXEN_CONFIG` set), bring the config from where older builds kept it
 * (`~/.config/moxen/config.json`) to `~/.moxen/config.json`. It is copied,
 * not moved: a Moxen process that started on the old build keeps reading the
 * old file, so nothing already running loses its settings. Returns whether
 * a copy was made; every failure is swallowed, because a launch must not
 * depend on it (the old file is still found by `defaultConfigPath`).
 */
export function migrateLegacyConfig(): boolean {
  if (appEnv("CONFIG") || appEnv("NO_CONFIG_MIGRATION")) return false;
  try {
    const current = path.join(appHomeDir(), "config.json");
    const legacy = path.join(configRoot(), APP_NAME, "config.json");
    if (fs.existsSync(current) || !fs.existsSync(legacy)) return false;
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.copyFileSync(legacy, current, fs.constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false;
  }
}

export function defaultConfigPath(): string {
  const override = appEnv("CONFIG");
  if (override) return path.resolve(expandHome(override));
  const current = path.join(appHomeDir(), "config.json");
  // Configs written before everything moved under ~/.moxen stay where they are until moved by hand.
  const legacy = path.join(configRoot(), APP_NAME, "config.json");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

function asString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError("INVALID_CONFIG", `${key} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * A config entry that failed to parse. A lenient load skips it — with its
 * location — instead of refusing the whole file, and the raw value rides
 * along so a save can carry it through rather than silently dropping it.
 * Values never leave this machine and are never printed: they may hold secrets.
 */
export interface SkippedConfigEntry {
  readonly path: string;
  readonly message: string;
  readonly value: unknown;
}

/** What the server reports for a skipped entry: where it is, never what it holds. */
export interface ConfigProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * Parse one field: strict callers throw as before; a lenient load records
 * the bad entry (with its raw value, for the next save) and keeps the rest.
 * Only config errors are skipped — anything else still throws.
 */
function guarded(skipped: SkippedConfigEntry[] | undefined, path: string, value: unknown, run: () => void): void {
  if (skipped === undefined) {
    run();
    return;
  }
  try {
    run();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    skipped.push({ path, message: error.message, value });
  }
}

export function normalizeConfig(raw: unknown, skipped?: SkippedConfigEntry[]): CliConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("INVALID_CONFIG", "The config file must contain a JSON object.");
  }
  const input = raw as Record<string, unknown>;
  const result: CliConfig = { ...DEFAULT_CONFIG };

  if (input.projectPolicy !== undefined) guarded(skipped, "projectPolicy", input.projectPolicy, () => {
    const value = asString(input.projectPolicy, "projectPolicy") as ProjectPolicy;
    if (!projectPolicies.has(value)) throw new CliError("INVALID_CONFIG", "projectPolicy must be create or existing.");
    result.projectPolicy = value;
  });
  if (input.workspaceMode !== undefined) guarded(skipped, "workspaceMode", input.workspaceMode, () => {
    const value = asString(input.workspaceMode, "workspaceMode") as WorkspaceMode;
    if (!workspaceModes.has(value)) throw new CliError("INVALID_CONFIG", "workspaceMode must be repo or folder.");
    result.workspaceMode = value;
  });
  if (input.openMode !== undefined) guarded(skipped, "openMode", input.openMode, () => {
    const value = asString(input.openMode, "openMode") as OpenMode;
    if (!openModes.has(value)) throw new CliError("INVALID_CONFIG", "openMode is invalid.");
    result.openMode = value;
  });
  if (input.threadEnvMode !== undefined) guarded(skipped, "threadEnvMode", input.threadEnvMode, () => {
    const value = asString(input.threadEnvMode, "threadEnvMode") as ThreadEnvMode;
    if (!threadEnvModes.has(value)) throw new CliError("INVALID_CONFIG", "threadEnvMode is invalid.");
    // `auto` always meant the project checkout; it still loads, as what it meant.
    result.threadEnvMode = value === "auto" ? "local" : value;
  });
  if (input.runtimeMode !== undefined) guarded(skipped, "runtimeMode", input.runtimeMode, () => {
    const value = asString(input.runtimeMode, "runtimeMode") as RuntimeMode;
    if (!runtimeModes.has(value)) throw new CliError("INVALID_CONFIG", "runtimeMode is invalid.");
    result.runtimeMode = value;
  });
  if (input.interactionMode !== undefined) guarded(skipped, "interactionMode", input.interactionMode, () => {
    const raw = asString(input.interactionMode, "interactionMode");
    const value = (REMOVED_INTERACTION_MODES.has(raw) ? "default" : raw) as InteractionMode;
    if (!interactionModes.has(value)) throw new CliError("INVALID_CONFIG", "interactionMode is invalid.");
    result.interactionMode = value;
  });
  if (input.provider !== undefined) guarded(skipped, "provider", input.provider, () => {
    result.provider = asString(input.provider, "provider");
  });
  if (input.model !== undefined) guarded(skipped, "model", input.model, () => {
    result.model = asString(input.model, "model");
  });
  if (input.promptImprover !== undefined) guarded(skipped, "promptImprover", input.promptImprover, () => {
    const promptImprover = normalizeSection<PromptImproverConfig>(input.promptImprover, "promptImprover", ["provider", "model"], skipped);
    if (promptImprover) result.promptImprover = promptImprover;
  });
  if (input.speedMode !== undefined) guarded(skipped, "speedMode", input.speedMode, () => {
    const value = asString(input.speedMode, "speedMode") as SpeedMode;
    if (!speedModes.has(value)) throw new CliError("INVALID_CONFIG", "speedMode must be standard or fast.");
    result.speedMode = value;
  });
  if (input.thinkingEffort !== undefined) guarded(skipped, "thinkingEffort", input.thinkingEffort, () => {
    result.thinkingEffort = asString(input.thinkingEffort, "thinkingEffort");
  });
  if (input.sessionTtl !== undefined) guarded(skipped, "sessionTtl", input.sessionTtl, () => {
    result.sessionTtl = asString(input.sessionTtl, "sessionTtl");
  });
  if (input.backgroundForgottenAfter !== undefined) guarded(skipped, "backgroundForgottenAfter", input.backgroundForgottenAfter, () => {
    result.backgroundForgottenAfter = asString(input.backgroundForgottenAfter, "backgroundForgottenAfter");
  });
  if (input.instructions !== undefined) guarded(skipped, "instructions", input.instructions, () => {
    const value = asString(input.instructions, "instructions").trim();
    if (value) result.instructions = value;
  });
  if (input.memory !== undefined) guarded(skipped, "memory", input.memory, () => {
    const raw: unknown = input.memory;
    const value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (value === null) throw new CliError("INVALID_CONFIG", "memory must be true or false.");
    // On is the default, so only off is kept.
    if (!value) result.memory = false;
  });
  if (input.memoryEmbeddings !== undefined) guarded(skipped, "memoryEmbeddings", input.memoryEmbeddings, () => {
    const value = input.memoryEmbeddings;
    if (value !== true && value !== false && value !== "true" && value !== "false") throw new CliError("INVALID_CONFIG", "memoryEmbeddings must be true or false.");
    result.memoryEmbeddings = value === true || value === "true";
  });
  if (input.memoryEmbeddingLoading !== undefined) guarded(skipped, "memoryEmbeddingLoading", input.memoryEmbeddingLoading, () => {
    if (input.memoryEmbeddingLoading !== "keep-loaded" && input.memoryEmbeddingLoading !== "on-demand") throw new CliError("INVALID_CONFIG", "memoryEmbeddingLoading must be keep-loaded or on-demand.");
    result.memoryEmbeddingLoading = input.memoryEmbeddingLoading;
  });
  for (const [key, choices] of Object.entries({ usageProtection: ["off", "notify", "auto"], usageRecovery: ["parallel", "sequential"], usageContinuation: ["same-thread", "handoff"], usageColdResume: ["same-thread", "handoff"] })) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    guarded(skipped, key, value, () => {
      if (typeof value !== "string" || !choices.includes(value)) throw new CliError("INVALID_CONFIG", `${key} must be one of ${choices.join(", ")}.`);
      Object.assign(result, { [key]: value });
    });
  }
  for (const key of ["usageMinimumSession", "usageMinimumWeekly"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    guarded(skipped, key, value, () => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) throw new CliError("INVALID_CONFIG", `${key} must be a percentage from 0 to 100.`);
      result[key] = value;
    });
  }
  if (input.usageColdResumeAfter !== undefined) guarded(skipped, "usageColdResumeAfter", input.usageColdResumeAfter, () => {
    result.usageColdResumeAfter = asString(input.usageColdResumeAfter, "usageColdResumeAfter");
  });
  if (input.usageColdResumeTokens !== undefined) guarded(skipped, "usageColdResumeTokens", input.usageColdResumeTokens, () => {
    const raw: unknown = input.usageColdResumeTokens;
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_000_000) throw new CliError("INVALID_CONFIG", "usageColdResumeTokens must be a whole number of tokens from 0 to 2000000.");
    result.usageColdResumeTokens = value;
  });
  if (input.autoContinueAtUsageLimit !== undefined) guarded(skipped, "autoContinueAtUsageLimit", input.autoContinueAtUsageLimit, () => {
    // A boolean in the file; `config set` hands it over as text.
    const raw: unknown = input.autoContinueAtUsageLimit;
    const value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (value === null) throw new CliError("INVALID_CONFIG", "autoContinueAtUsageLimit must be true or false.");
    if (value) result.autoContinueAtUsageLimit = true;
  });
  if (input.usageLimitContinues !== undefined) guarded(skipped, "usageLimitContinues", input.usageLimitContinues, () => {
    const value = Number(input.usageLimitContinues);
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new CliError("INVALID_CONFIG", "usageLimitContinues must be a whole number from 1 to 5.");
    if (value !== 2) result.usageLimitContinues = value;
  });
  if (input.branchPruneDays !== undefined) guarded(skipped, "branchPruneDays", input.branchPruneDays, () => {
    const value = Number(input.branchPruneDays);
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      throw new CliError("INVALID_CONFIG", "branchPruneDays must be a whole number of days from 0 to 365.");
    }
    result.branchPruneDays = value;
  });
  if (input.installSkills !== undefined) guarded(skipped, "installSkills", input.installSkills, () => {
    const raw: unknown = input.installSkills;
    const value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (value === null) throw new CliError("INVALID_CONFIG", "installSkills must be true or false.");
    if (!value) result.installSkills = false;
  });
  if (input.mcpRunner !== undefined) guarded(skipped, "mcpRunner", input.mcpRunner, () => {
    if (input.mcpRunner !== "npx" && input.mcpRunner !== "bunx" && input.mcpRunner !== "pnpm" && input.mcpRunner !== "yarn") throw new CliError("INVALID_CONFIG", "mcpRunner must be npx, bunx, pnpm or yarn.");
    if (input.mcpRunner !== "npx") result.mcpRunner = input.mcpRunner;
  });
  if (input.mcpServers !== undefined) {
    if (skipped === undefined) {
      const servers = parseMcpServers(input.mcpServers, "config") as Record<string, McpServerEntry>;
      if (Object.keys(servers).length > 0) result.mcpServers = servers;
    } else {
      const servers = lenientMcpServers(input.mcpServers, skipped);
      if (servers && Object.keys(servers).length > 0) result.mcpServers = servers;
    }
  }
  if (input.skills !== undefined) guarded(skipped, "skills", input.skills, () => {
    const skills = normalizeSection<SkillsConfig>(input.skills, "skills", ["moxen"], skipped);
    if (skills) result.skills = skills;
  });
  if (input.web !== undefined) guarded(skipped, "web", input.web, () => {
    const web = normalizeSection<WebConfig>(input.web, "web", ["browser", "browserPath", "privateNetwork"], skipped);
    if (web) result.web = web;
  });
  if (input.longThreads !== undefined) guarded(skipped, "longThreads", input.longThreads, () => {
    const longThreads = normalizeSection<LongThreadsConfig>(input.longThreads, "longThreads", ["handoff", "handoffAt", "compaction", "compactAt"], skipped);
    if (longThreads) result.longThreads = longThreads;
  });
  if (input.ui !== undefined) guarded(skipped, "ui", input.ui, () => {
    const ui = normalizeSection<UiConfig>(input.ui, "ui", ["backdrop", "theme", "language", "modelScenes", "hideBinaryDiffs", "defaultSidePanel", "contextRefreshSeconds", "usageRefreshSeconds", "autoHandoff", "autoHandoffPercent", "autoHandoffTokens"], skipped);
    if (ui) result.ui = ui;
  });
  if (input.git !== undefined) guarded(skipped, "git", input.git, () => {
    const git = normalizeSection<GitConfig>(input.git, "git", ["historyLimit", "autoFetch"], skipped);
    if (git) result.git = git;
  });
  if (input.forge !== undefined) guarded(skipped, "forge", input.forge, () => {
    const forge = normalizeSection<ForgeConfig>(input.forge, "forge", ["enabled", "ghPath", "glabPath"], skipped);
    if (forge) result.forge = forge;
  });
  if (input.updates !== undefined) guarded(skipped, "updates", input.updates, () => {
    const updates = normalizeSection<UpdatesConfig>(input.updates, "updates", ["checkLatest"], skipped);
    if (updates) result.updates = updates;
  });
  if (input.remote !== undefined) guarded(skipped, "remote", input.remote, () => {
    const remote = normalizeSection<RemoteConfig>(input.remote, "remote", ["enabled", "interfaces", "port"], skipped);
    if (remote) result.remote = remote;
  });
  if (input.providers !== undefined) guarded(skipped, "providers", input.providers, () => {
    const providers = normalizeProviders(input.providers, skipped);
    if (providers) result.providers = providers;
  });
  return applyEnvironmentOverrides(retireServerProviders(result));
}

/** A lenient load: the config with every bad entry skipped, and the skipped entries with their locations. */
export function normalizeConfigLenient(raw: unknown): { config: CliConfig; skipped: SkippedConfigEntry[] } {
  const skipped: SkippedConfigEntry[] = [];
  return { config: normalizeConfig(raw, skipped), skipped };
}

/**
 * One bad MCP server cannot take the rest: parse each entry on its own,
 * keeping the good ones and recording the bad ones by name.
 */
function lenientMcpServers(raw: unknown, skipped: SkippedConfigEntry[]): Record<string, McpServerEntry> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    skipped.push({ path: "mcpServers", message: "mcpServers must be an object keyed by server name.", value: raw });
    return undefined;
  }
  const out: Record<string, McpServerEntry> = {};
  const seen = new Set<string>();
  for (const [name, entry] of Object.entries(raw)) {
    try {
      const parsed = parseMcpServers({ [name]: entry }, "config") as Record<string, McpServerEntry>;
      const normalized = Object.keys(parsed)[0]!;
      if (seen.has(normalized)) throw new CliError("INVALID_CONFIG", `config: mcpServers name "${name}" duplicates another name ignoring case.`);
      seen.add(normalized);
      Object.assign(out, parsed);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      skipped.push({ path: `mcpServers.${name}`, message: error.message, value: entry });
    }
  }
  return out;
}

/**
 * One bad harness profile cannot take the rest: parse each on its own,
 * keeping the good ones and recording the bad ones by index.
 */
function lenientHarnessProfiles(raw: unknown, skipped: SkippedConfigEntry[]): HarnessProviderConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    skipped.push({ path: "providers.harness.profiles", message: "providers.harness.profiles must be a list.", value: raw });
    return undefined;
  }
  const entries = (raw as { profiles?: unknown }).profiles;
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries)) {
    skipped.push({ path: "providers.harness.profiles", message: "providers.harness.profiles must be a list.", value: entries });
    return undefined;
  }
  const profiles: HarnessProfileConfig[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    // By id when the entry names one, so an explicit reset of that profile
    // clears it; by index when it does not even name itself.
    const here = typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).id === "string"
      ? `providers.harness.profiles[${(entry as Record<string, unknown>).id}]`
      : `providers.harness.profiles[${index}]`;
    try {
      const parsed = parseHarnessProfile(entry, index);
      if (seen.has(parsed.id)) throw new CliError("INVALID_CONFIG", `providers.harness.profiles uses id "${parsed.id}" twice.`);
      seen.add(parsed.id);
      profiles.push(parsed);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      skipped.push({ path: here, message: error.message, value: entry });
    }
  });
  return profiles.length > 0 ? { profiles } : undefined;
}

function asSection(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("INVALID_CONFIG", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate one nested section against the schema, field by field. Values
 * arrive either already typed (from the file) or as text (`config set`
 * hands everything over as a string), so each goes through the
 * descriptor's own parser. Unknown fields are dropped rather than
 * rejected: a config written by a newer build must stay loadable.
 */
/** Exa and Brave were once built-in search backends; they are now their MCP servers. A file that names one reads as the default backend (DuckDuckGo), not as an error. */
function withoutRetiredSearch(section: unknown): unknown {
  if (section === null || typeof section !== "object" || Array.isArray(section)) return section;
  const { webSearch, ...rest } = section as Record<string, unknown>;
  return webSearch === "exa" || webSearch === "brave" ? rest : section;
}

function normalizeSection<T>(raw: unknown, prefix: string, fields: readonly string[], skipped?: SkippedConfigEntry[]): T | undefined {
  if (raw === undefined) return undefined;
  let input: Record<string, unknown>;
  try {
    input = asSection(raw, prefix);
  } catch (error) {
    if (skipped === undefined || !(error instanceof CliError)) throw error;
    skipped.push({ path: prefix, message: error.message, value: raw });
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const descriptor = settingDescriptor(`${prefix}.${field}`);
    if (!descriptor) continue;
    try {
      // A line (`compactAt`) may be a bare token count in the file; it is read as the same text `config set` takes.
      out[field] = typeof value === "string" || (descriptor.kind.type === "line" && typeof value === "number") ? parseSettingValue(descriptor, String(value)) : checkTyped(descriptor.kind.type, value, `${prefix}.${field}`);
    } catch (error) {
      if (skipped === undefined || !(error instanceof CliError)) throw error;
      skipped.push({ path: `${prefix}.${field}`, message: error.message, value });
    }
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/** A non-string value straight from the file still has to match its kind. */
function checkTyped(kind: string, value: unknown, label: string): unknown {
  if (kind === "boolean") {
    if (typeof value !== "boolean") throw new CliError("INVALID_CONFIG", `${label} must be true or false.`);
    return value;
  }
  if (kind === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new CliError("INVALID_CONFIG", `${label} must be a whole number.`);
    }
    return value;
  }
  throw new CliError("INVALID_CONFIG", `${label} must be a string.`);
}

type PerModelFields = Pick<ClaudeProviderConfig, "autoHandoffModels" | "compactAtModels" | "handoffModels" | "compactionModels">;

/** A provider section's per-model token prices (USD per million tokens), as the fields to merge in. */
function modelPricesOf(section: unknown, prefix: string, skipped?: SkippedConfigEntry[]): ModelPriceMaps | undefined {
  let input: Record<string, unknown>;
  try {
    input = asSection(section, prefix);
  } catch (error) {
    if (skipped === undefined || !(error instanceof CliError)) throw error;
    skipped.push({ path: prefix, message: error.message, value: section });
    return undefined;
  }
  const out: ModelPriceMaps = {};
  for (const field of ["modelInputPrices", "modelOutputPrices", "modelCacheReadPrices", "modelCacheWritePrices"] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    try {
      const map = normalizePriceMap(raw, `${prefix}.${field}`);
      if (map) out[field] = map;
    } catch (error) {
      if (skipped === undefined || !(error instanceof CliError)) throw error;
      skipped.push({ path: `${prefix}.${field}`, message: error.message, value: raw });
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A provider section's per-model hand-off and compaction overrides (sizes and choices), as the fields to merge in. */
function handoffModelsOf(section: unknown, prefix: string, skipped?: SkippedConfigEntry[]): PerModelFields | undefined {
  let input: Record<string, unknown>;
  try {
    input = asSection(section, prefix);
  } catch (error) {
    if (skipped === undefined || !(error instanceof CliError)) throw error;
    skipped.push({ path: prefix, message: error.message, value: section });
    return undefined;
  }
  const out: PerModelFields = {};
  for (const field of ["autoHandoffModels", "compactAtModels"] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    try {
      const map = normalizeHandoffModels(raw, `${prefix}.${field}`);
      if (map) out[field] = map;
    } catch (error) {
      if (skipped === undefined || !(error instanceof CliError)) throw error;
      skipped.push({ path: `${prefix}.${field}`, message: error.message, value: raw });
    }
  }
  if (input.handoffModels !== undefined && input.handoffModels !== null) {
    try {
      const map = normalizeModeModels(input.handoffModels, `${prefix}.handoffModels`, ["ask", "auto", "off"] as const);
      if (map) out.handoffModels = map;
    } catch (error) {
      if (skipped === undefined || !(error instanceof CliError)) throw error;
      skipped.push({ path: `${prefix}.handoffModels`, message: error.message, value: input.handoffModels });
    }
  }
  if (input.compactionModels !== undefined && input.compactionModels !== null) {
    try {
      const map = normalizeModeModels(input.compactionModels, `${prefix}.compactionModels`, ["provider", "ask", "auto", "off"] as const);
      if (map) out.compactionModels = map;
    } catch (error) {
      if (skipped === undefined || !(error instanceof CliError)) throw error;
      skipped.push({ path: `${prefix}.compactionModels`, message: error.message, value: input.compactionModels });
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProviders(raw: unknown, skipped?: SkippedConfigEntry[]): ProvidersConfig | undefined {
  if (raw === undefined) return undefined;
  let input: Record<string, unknown>;
  try {
    input = asSection(raw, "providers");
  } catch (error) {
    if (skipped === undefined || !(error instanceof CliError)) throw error;
    skipped.push({ path: "providers", message: error.message, value: raw });
    return undefined;
  }
  const result: ProvidersConfig = {};
  if (input.claude !== undefined) guarded(skipped, "providers.claude", input.claude, () => {
    const claude = normalizeSection<ClaudeProviderConfig>(input.claude, "providers.claude", [
      "binaryPath",
      "homePath",
      "thinkingDisplay",
      "usageWrapUp",
      "promptSuggestions",
      "partialMessages",
      "agentSkills",
      "compaction",
      "compactAt",
      "handoff",
      "handoffAt",
      "autoCompactWindow",
      "autoCompact",
      "autoCompactPercent",
      "ultracode",
      "autoHandoff",
      "autoHandoffTokens",
      "autoHandoffPercent",
      "runtimeMode",
      "model",
      "thinkingEffort",
      "moxenTools",
      "orchestration",
      "memory",
      "moxenSkills",
      "instructions",
      "autoContinueAtUsageLimit",
      "sessionTtl",
      "webFetch",
      "todos",
      "mcpExclude",
      "disabledNativeTools",
      "webSearchOrder", "webFetchOrder",
    ], skipped);
    const launchArgs = asSection(input.claude, "providers.claude").launchArgs;
    const args = Array.isArray(launchArgs) && launchArgs.every((entry) => typeof entry === "string") ? (launchArgs as string[]) : undefined;
    const models = handoffModelsOf(input.claude, "providers.claude", skipped);
    const prices = modelPricesOf(input.claude, "providers.claude", skipped);
    if (claude || args || models || prices) result.claude = { ...(claude ?? {}), ...(args ? { launchArgs: args } : {}), ...models, ...prices };
  });
  if (input.codex !== undefined) guarded(skipped, "providers.codex", input.codex, () => {
    const codex = normalizeSection<CodexProviderConfig>(input.codex, "providers.codex", ["binaryPath", "homePath", "launchArgs", "reasoningSummary", "runtimeMode", "model", "thinkingEffort", "compaction", "compactAt", "handoff", "handoffAt", "autoHandoff", "autoHandoffTokens", "autoHandoffPercent", "moxenTools", "orchestration", "memory", "moxenSkills", "instructions", "autoContinueAtUsageLimit", "sessionTtl", "webFetch", "todos", "mcpExclude", "disabledNativeTools", "webSearchOrder", "webFetchOrder"], skipped);
    const models = handoffModelsOf(input.codex, "providers.codex", skipped);
    const prices = modelPricesOf(input.codex, "providers.codex", skipped);
    if (codex || models || prices) result.codex = { ...codex, ...models, ...prices };
  });
  if (input.opencode !== undefined) guarded(skipped, "providers.opencode", input.opencode, () => {
    const opencode = normalizeSection<OpencodeProviderConfig>(input.opencode, "providers.opencode", ["binaryPath", "bundledSkills", "compaction", "compactAt", "handoff", "handoffAt", "autoCompact", "compactBuffer", "autoHandoff", "autoHandoffTokens", "autoHandoffPercent", "runtimeMode", "model", "thinkingEffort", "moxenTools", "orchestration", "memory", "moxenSkills", "instructions", "autoContinueAtUsageLimit", "sessionTtl", "webFetch", "todos", "mcpExclude", "disabledNativeTools", "webSearchOrder", "webFetchOrder", "moxenPrompt"], skipped);
    const models = handoffModelsOf(input.opencode, "providers.opencode", skipped);
    const prices = modelPricesOf(input.opencode, "providers.opencode", skipped);
    if (opencode || models || prices) result.opencode = { ...opencode, ...models, ...prices };
  });
  if (input.harness !== undefined) guarded(skipped, "providers.harness", input.harness, () => {
    if (skipped === undefined) {
      const withProfiles = normalizeHarnessConfig(input.harness);
      const defaults = normalizeSection<HarnessProviderConfig>(withoutRetiredSearch(input.harness), "providers.harness", ["runtimeMode", "model", "thinkingEffort", "moxenTools", "orchestration", "memory", "moxenSkills", "instructions", "autoContinueAtUsageLimit", "sessionTtl", "webFetch", "todos", "mcpExclude", "compaction", "compactAt", "handoff", "handoffAt", "autoHandoff", "autoHandoffTokens", "autoHandoffPercent", "slots", "autoCompact", "autoCompactPercent", "autoCompactTokens", "keepRecentTokens", "webSearch", "searxngUrl", "webBrowser", "webBrowserPath", "webPrivateNetwork"]);
      const models = handoffModelsOf(input.harness, "providers.harness");
      const prices = modelPricesOf(input.harness, "providers.harness");
      if (withProfiles || defaults || models || prices) result.harness = { ...defaults, ...withProfiles, ...models, ...prices };
    } else {
      const defaults = normalizeSection<HarnessProviderConfig>(withoutRetiredSearch(input.harness), "providers.harness", ["runtimeMode", "model", "thinkingEffort", "moxenTools", "orchestration", "memory", "moxenSkills", "instructions", "autoContinueAtUsageLimit", "sessionTtl", "webFetch", "todos", "mcpExclude", "compaction", "compactAt", "handoff", "handoffAt", "autoHandoff", "autoHandoffTokens", "autoHandoffPercent", "slots", "autoCompact", "autoCompactPercent", "autoCompactTokens", "keepRecentTokens", "webSearch", "searxngUrl", "webBrowser", "webBrowserPath", "webPrivateNetwork"], skipped);
      const models = handoffModelsOf(input.harness, "providers.harness", skipped);
      const prices = modelPricesOf(input.harness, "providers.harness", skipped);
      const withProfiles = lenientHarnessProfiles(input.harness, skipped);
      if (withProfiles || defaults || models || prices) result.harness = { ...defaults, ...withProfiles, ...models, ...prices };
    }
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * A configured server's older `providers` list ("Offered to") is a limit no
 * page shows. It is read as what it meant: each provider it leaves out gets
 * the server in its own `mcpExclude` (the checklist on that provider's tab),
 * and the list is dropped, so nothing hidden decides whether a server is
 * offered. Older builds read `mcpExclude` too, so the result means the same to them.
 */
function retireServerProviders(config: CliConfig): CliConfig {
  const limited = Object.entries(config.mcpServers ?? {}).filter(([, entry]) => entry.providers !== undefined);
  if (limited.length === 0) return config;
  const servers: Record<string, McpServerEntry> = { ...config.mcpServers };
  const providers: ProvidersConfig = { ...config.providers };
  for (const [name, entry] of limited) {
    const { providers: offered, ...rest } = entry;
    servers[name] = rest as McpServerEntry;
    if (offered === undefined || offered.length === 0) continue;
    for (const kind of ["claude", "opencode", "harness"] as const) {
      if (offered.includes(kind)) continue;
      const own = providers[kind] ?? {};
      const excluded = parseNameList(own.mcpExclude);
      if (!excluded.includes(name)) providers[kind] = { ...own, mcpExclude: [...excluded, name].join(", ") } as never;
    }
  }
  return { ...config, mcpServers: servers, providers };
}

function envOverride(name: string): string | undefined {
  return appEnv(name);
}

function applyEnvironmentOverrides(config: CliConfig): CliConfig {
  const next = { ...config };
  const projectPolicy = envOverride("PROJECT_POLICY");
  if (projectPolicy) next.projectPolicy = projectPolicy as ProjectPolicy;
  const workspaceMode = envOverride("WORKSPACE_MODE");
  if (workspaceMode) next.workspaceMode = workspaceMode as WorkspaceMode;
  const openMode = envOverride("OPEN_MODE");
  if (openMode) next.openMode = openMode as OpenMode;
  const threadEnvMode = envOverride("THREAD_ENV_MODE");
  if (threadEnvMode) next.threadEnvMode = (threadEnvMode === "auto" ? "local" : threadEnvMode) as ThreadEnvMode;
  const runtimeMode = envOverride("RUNTIME_MODE");
  if (runtimeMode) next.runtimeMode = runtimeMode as RuntimeMode;
  const interactionMode = envOverride("INTERACTION_MODE");
  if (interactionMode) next.interactionMode = (REMOVED_INTERACTION_MODES.has(interactionMode) ? "default" : interactionMode) as InteractionMode;
  const provider = envOverride("PROVIDER");
  if (provider) next.provider = provider;
  const model = envOverride("MODEL");
  if (model) next.model = model;
  const speedMode = envOverride("SPEED_MODE");
  if (speedMode) next.speedMode = speedMode as SpeedMode;
  const thinkingEffort = envOverride("THINKING_EFFORT");
  if (thinkingEffort) next.thinkingEffort = thinkingEffort;
  return normalizeConfigValues(next);
}

function normalizeConfigValues(config: CliConfig): CliConfig {
  const withoutEnvironment = { ...config };
  if (!projectPolicies.has(withoutEnvironment.projectPolicy)) throw new CliError("INVALID_CONFIG", "Invalid project policy override.");
  if (!workspaceModes.has(withoutEnvironment.workspaceMode)) throw new CliError("INVALID_CONFIG", "Invalid workspace mode override.");
  if (!openModes.has(withoutEnvironment.openMode)) throw new CliError("INVALID_CONFIG", "Invalid open mode override.");
  if (!threadEnvModes.has(withoutEnvironment.threadEnvMode)) throw new CliError("INVALID_CONFIG", "Invalid thread env mode override.");
  if (!runtimeModes.has(withoutEnvironment.runtimeMode)) throw new CliError("INVALID_CONFIG", "Invalid runtime mode override.");
  if (!interactionModes.has(withoutEnvironment.interactionMode)) throw new CliError("INVALID_CONFIG", "Invalid interaction mode override.");
  if (withoutEnvironment.speedMode !== undefined && !speedModes.has(withoutEnvironment.speedMode)) {
    throw new CliError("INVALID_CONFIG", "Invalid speed mode override.");
  }
  return withoutEnvironment;
}

/** What a config load saw: the settings in force, and the entries it skipped to get there. */
export interface LoadedConfig {
  readonly config: CliConfig;
  readonly path: string;
  readonly exists: boolean;
  /** Entries that failed to parse: skipped, with raw values for the next save. */
  readonly skipped: SkippedConfigEntry[];
  /** Where the skipped entries are, for reports; never their values. */
  readonly problems: ConfigProblem[];
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const configPath = path.resolve(expandHome(explicitPath ?? defaultConfigPath()));
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const { config, skipped } = normalizeConfigLenient(raw);
    return {
      config,
      path: configPath,
      exists: true,
      skipped,
      problems: skipped.map((entry) => ({ path: entry.path, message: entry.message })),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { config: applyEnvironmentOverrides({ ...DEFAULT_CONFIG }), path: configPath, exists: false, skipped: [], problems: [] };
    }
    if (error instanceof CliError) throw error;
    // Truly nothing to load: the file is not JSON at all. Name the way
    // back: the previous save's backup, or moving the file aside to start fresh.
    throw new CliError(
      "CONFIG_READ_FAILED",
      `Could not parse config at ${configPath}: it is not valid JSON. A backup of the previous save may exist at ${configPath}.bak — restore it, or move the file aside to start fresh.`,
      { cause: error },
    );
  }
}

export async function saveConfig(configPath: string, config: CliConfig, skipped: readonly SkippedConfigEntry[] = []): Promise<void> {
  // Loaded here rather than at the top: `core/config` is imported during
  // test setup, before any file mock registers, and a static edge would pin
  // the atomic write to the real filesystem for the whole test run.
  const { writeAtomic } = await import("./infra/atomic.js");
  // Skipped entries ride along: a save must never drop what it could not
  // read. They apply only where the normalized config says nothing — a
  // value the user fixed always wins over the old bad one.
  const next = applySkipped(structuredClone(config) as unknown as Record<string, unknown>, skipped);
  // A backup of the previous save, so a bad write can be undone. Best
  // effort: a missing file (a first save) or an unwritable backup never
  // stops the save itself.
  try {
    await writeAtomic(`${configPath}.bak`, await readFile(configPath, "utf8"));
  } catch {
    // No previous file, or nowhere to keep it.
  }
  await writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Re-apply skipped entries onto a normalized config, setting only what is
 * absent: the normalized config (the user's fixes included) always wins.
 * Array indexes that no longer line up append instead of overwriting, so a
 * save never invents holes or drops a good entry.
 */
function applySkipped(config: Record<string, unknown>, skipped: readonly SkippedConfigEntry[]): Record<string, unknown> {
  for (const entry of skipped) setPathIfAbsent(config, parseSkippedPath(entry.path), entry.value);
  return config;
}

function parseSkippedPath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of path.split(".")) {
    const match = /^([^\[]+?)(?:\[([^\]]+)\])?$/.exec(part);
    const name = match?.[1];
    if (!match || name === undefined || name === "") {
      segments.push(part);
      continue;
    }
    segments.push(name);
    const raw = match[2];
    if (raw !== undefined) {
      const index = Number(raw);
      segments.push(Number.isInteger(index) && String(index) === raw ? index : raw);
    }
  }
  return segments;
}

/**
 * Whether `config set`/`settings.set` of `key` covers a skipped entry: the
 * key names the entry or something above it (`ui`, `mcpServers[x]`,
 * `providers.harness.profiles[x]`). Covered entries are dropped from
 * preservation, so resetting or removing a bad entry actually clears it
 * instead of the next save carrying it back.
 */
export function configKeyCoversPath(key: string, skippedPath: string): boolean {
  const wanted = parseSkippedPath(key);
  const actual = parseSkippedPath(skippedPath);
  return wanted.length <= actual.length && wanted.every((segment, index) => actual[index] === segment);
}

function setPathIfAbsent(root: Record<string, unknown>, segments: Array<string | number>, value: unknown): void {
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  let node: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = segments[index + 1]!;
    if (typeof segment === "number") {
      if (!Array.isArray(node)) return;
      if (segment >= node.length) {
        const fresh: Record<string, unknown> | unknown[] = typeof next === "number" ? [] : {};
        node.push(fresh);
        node = fresh;
      } else {
        const child = node[segment];
        if (typeof child !== "object" || child === null) return;
        node = child as Record<string, unknown> | unknown[];
      }
    } else {
      if (typeof node !== "object" || node === null || Array.isArray(node)) return;
      const record = node as Record<string, unknown>;
      const child = record[segment];
      if (child === undefined) {
        const fresh: Record<string, unknown> | unknown[] = typeof next === "number" ? [] : {};
        record[segment] = fresh;
        node = fresh;
      } else {
        if (typeof child !== "object" || child === null) return;
        node = child as Record<string, unknown> | unknown[];
      }
    }
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) return;
  if (Array.isArray(node) && typeof leaf === "string") {
    // A list entry by id (`providers.harness.profiles[x]`): already carried
    // under that id, or superseded by a good entry the user wrote — either
    // way nothing is appended.
    const carried = node.some((element) => typeof element === "object" && element !== null && (element as Record<string, unknown>).id === leaf);
    if (!carried) node.push(value);
    return;
  }
  if (typeof leaf === "number") {
    if (!Array.isArray(node)) return;
    if (leaf < node.length) {
      // Occupied: already carried (leave it) or holding something else (keep it, append).
      if (!same(node[leaf], value)) node.push(value);
    } else {
      node.push(value);
    }
  } else {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    if ((node as Record<string, unknown>)[leaf] === undefined) (node as Record<string, unknown>)[leaf] = value;
  }
}

/**
 * Apply one `key=value` edit. The value is parsed against the key's
 * descriptor first — so a bad enum fails with the allowed set rather than
 * being written and rejected on the next load — then the whole config is
 * re-normalized, which is what catches combinations no single key can.
 */
export function setConfigValue(config: CliConfig, key: ConfigKey, rawValue: string): CliConfig {
  // An entry or field of a list (`providers.harness.profiles[colab].baseUrl`) is edited by id.
  const entry = listTarget(key);
  if (entry) return normalizeConfig(writeListValue(config, entry, rawValue, key));
  const descriptor = settingDescriptor(key);
  if (!descriptor) throw new CliError("INVALID_CONFIG_KEY", `Unknown config key: ${key}`);
  return normalizeConfig(writeSetting(config, key, parseSettingValue(descriptor, rawValue)));
}

/**
 * `setConfigValue`, where a key that holds a secret goes to the OS keychain and
 * the config gets only the reference (an empty value removes both). Everything
 * that sets a key from the outside (the settings page, `config set`) uses this.
 */
export async function setConfigValueSecure(config: CliConfig, key: ConfigKey, rawValue: string): Promise<CliConfig> {
  const mcp = /^mcpServers\[([^\]]+)\](?:\.(env|headers))?$/.exec(key);
  if (mcp !== null) return setConfigValue(config, key, await keepMcpSecrets(mcp[1]!, mcp[2] as "env" | "headers" | undefined, rawValue));
  const name = secretKeyName(key);
  if (name === null) return setConfigValue(config, key, rawValue);
  const value = rawValue.trim();
  try {
    await writeSecret(name, value);
  } catch (error) {
    throw new CliError("KEYCHAIN_UNAVAILABLE", `Could not use the OS keychain: ${error instanceof Error ? error.message : String(error)}`);
  }
  return setConfigValue(config, key, value === "" ? "" : secretRef(name));
}

/**
 * An MCP server's `env` and `headers` hold keys and tokens, so what is typed
 * goes to the OS keychain and the config gets a reference. `field` is `env`,
 * `headers`, or undefined when `rawValue` is the whole entry as JSON. A value
 * that is already a reference, or the `<hidden>` placeholder that keeps the
 * stored one, is left as it is.
 */
async function keepMcpSecrets(id: string, field: "env" | "headers" | undefined, rawValue: string): Promise<string> {
  const keep = async (where: "env" | "headers", name: string, value: string): Promise<string> => {
    if (value === "" || value === HIDDEN_VALUE || isSecretRef(value)) return value;
    const secret = `mcp-${id}-${where}-${name}`;
    try {
      await writeSecret(secret, value);
    } catch (error) {
      throw new CliError("KEYCHAIN_UNAVAILABLE", `Could not use the OS keychain: ${error instanceof Error ? error.message : String(error)}`);
    }
    return secretRef(secret);
  };
  if (field !== undefined) {
    const lines: string[] = [];
    for (const line of rawValue.split("\n")) {
      const at = line.indexOf("=");
      lines.push(at <= 0 || line.trim() === "" ? line : `${line.slice(0, at)}=${await keep(field, line.slice(0, at).trim(), line.slice(at + 1).trim())}`);
    }
    return lines.join("\n");
  }
  let entry: unknown;
  try {
    entry = JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return rawValue;
  const out = { ...(entry as Record<string, unknown>) };
  for (const where of ["env", "headers"] as const) {
    const record = out[where];
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    out[where] = Object.fromEntries(await Promise.all(Object.entries(record as Record<string, unknown>).map(async ([name, value]) => [name, typeof value === "string" ? await keep(where, name, value) : value])));
  }
  return JSON.stringify(out);
}

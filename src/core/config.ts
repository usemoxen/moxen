import { mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliError } from "./errors.js";
import { parseMcpServers, parseNameList, type McpServerEntry } from "./mcp.js";
import { normalizeHarnessConfig } from "./providers/harness/profiles.js";
import { INTERACTION_MODES } from "./interactionmode.js";
import { HIDDEN_VALUE, writeListValue } from "./configlist.js";
import { normalizeHandoffModels, normalizeModeModels } from "./handoffmodels.js";
import { listTarget, parseSettingValue, secretKeyName, settingDescriptor, writeSetting } from "./configschema.js";
import { isSecretRef, secretRef, writeSecret } from "./secrets.js";
import type {
  ClaudeProviderConfig,
  CliConfig,
  ForgeConfig,
  GitConfig,
  HarnessProviderConfig,
  KeyedSearchBackend,
  InteractionMode,
  OpencodeProviderConfig,
  OpenMode,
  ProjectPolicy,
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
const interactionModes = new Set<InteractionMode>(INTERACTION_MODES);
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

export function normalizeConfig(raw: unknown): CliConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("INVALID_CONFIG", "The config file must contain a JSON object.");
  }
  const input = raw as Record<string, unknown>;
  const result: CliConfig = { ...DEFAULT_CONFIG };

  if (input.projectPolicy !== undefined) {
    const value = asString(input.projectPolicy, "projectPolicy") as ProjectPolicy;
    if (!projectPolicies.has(value)) throw new CliError("INVALID_CONFIG", "projectPolicy must be create or existing.");
    result.projectPolicy = value;
  }
  if (input.workspaceMode !== undefined) {
    const value = asString(input.workspaceMode, "workspaceMode") as WorkspaceMode;
    if (!workspaceModes.has(value)) throw new CliError("INVALID_CONFIG", "workspaceMode must be repo or folder.");
    result.workspaceMode = value;
  }
  if (input.openMode !== undefined) {
    const value = asString(input.openMode, "openMode") as OpenMode;
    if (!openModes.has(value)) throw new CliError("INVALID_CONFIG", "openMode is invalid.");
    result.openMode = value;
  }
  if (input.threadEnvMode !== undefined) {
    const value = asString(input.threadEnvMode, "threadEnvMode") as ThreadEnvMode;
    if (!threadEnvModes.has(value)) throw new CliError("INVALID_CONFIG", "threadEnvMode is invalid.");
    // `auto` always meant the project checkout; it still loads, as what it meant.
    result.threadEnvMode = value === "auto" ? "local" : value;
  }
  if (input.runtimeMode !== undefined) {
    const value = asString(input.runtimeMode, "runtimeMode") as RuntimeMode;
    if (!runtimeModes.has(value)) throw new CliError("INVALID_CONFIG", "runtimeMode is invalid.");
    result.runtimeMode = value;
  }
  if (input.interactionMode !== undefined) {
    const raw = asString(input.interactionMode, "interactionMode");
    const value = (REMOVED_INTERACTION_MODES.has(raw) ? "default" : raw) as InteractionMode;
    if (!interactionModes.has(value)) throw new CliError("INVALID_CONFIG", "interactionMode is invalid.");
    result.interactionMode = value;
  }
  if (input.provider !== undefined) result.provider = asString(input.provider, "provider");
  if (input.model !== undefined) result.model = asString(input.model, "model");
  if (input.speedMode !== undefined) {
    const value = asString(input.speedMode, "speedMode") as SpeedMode;
    if (!speedModes.has(value)) throw new CliError("INVALID_CONFIG", "speedMode must be standard or fast.");
    result.speedMode = value;
  }
  if (input.thinkingEffort !== undefined) {
    result.thinkingEffort = asString(input.thinkingEffort, "thinkingEffort");
  }
  if (input.sessionTtl !== undefined) result.sessionTtl = asString(input.sessionTtl, "sessionTtl");
  if (input.instructions !== undefined) {
    const value = asString(input.instructions, "instructions").trim();
    if (value) result.instructions = value;
  }
  if (input.memory !== undefined) {
    const raw: unknown = input.memory;
    const value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (value === null) throw new CliError("INVALID_CONFIG", "memory must be true or false.");
    // On is the default, so only off is kept.
    if (!value) result.memory = false;
  }
  if (input.autoContinueAtUsageLimit !== undefined) {
    // A boolean in the file; `config set` hands it over as text.
    const raw: unknown = input.autoContinueAtUsageLimit;
    const value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (value === null) throw new CliError("INVALID_CONFIG", "autoContinueAtUsageLimit must be true or false.");
    if (value) result.autoContinueAtUsageLimit = true;
  }
  if (input.usageLimitContinues !== undefined) {
    const value = Number(input.usageLimitContinues);
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new CliError("INVALID_CONFIG", "usageLimitContinues must be a whole number from 1 to 5.");
    if (value !== 2) result.usageLimitContinues = value;
  }
  if (input.branchPruneDays !== undefined) {
    const value = Number(input.branchPruneDays);
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      throw new CliError("INVALID_CONFIG", "branchPruneDays must be a whole number of days from 0 to 365.");
    }
    result.branchPruneDays = value;
  }
  if (input.installSkills !== undefined) {
    const raw: unknown = input.installSkills;
    const value = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
    if (value === null) throw new CliError("INVALID_CONFIG", "installSkills must be true or false.");
    if (!value) result.installSkills = false;
  }
  if (input.mcpRunner !== undefined) {
    if (input.mcpRunner !== "npx" && input.mcpRunner !== "bunx" && input.mcpRunner !== "pnpm" && input.mcpRunner !== "yarn") throw new CliError("INVALID_CONFIG", "mcpRunner must be npx, bunx, pnpm or yarn.");
    if (input.mcpRunner !== "npx") result.mcpRunner = input.mcpRunner;
  }
  if (input.mcpServers !== undefined) {
    const servers = parseMcpServers(input.mcpServers, "config") as Record<string, McpServerEntry>;
    if (Object.keys(servers).length > 0) result.mcpServers = servers;
  }
  const skills = normalizeSection<SkillsConfig>(input.skills, "skills", ["moxen"]);
  if (skills) result.skills = skills;
  const web = normalizeSection<WebConfig>(input.web, "web", ["browser", "browserPath", "privateNetwork"]);
  if (web) result.web = web;
  const longThreads = normalizeSection<LongThreadsConfig>(input.longThreads, "longThreads", ["handoff", "handoffAt", "compaction", "compactAt"]);
  if (longThreads) result.longThreads = longThreads;
  const ui = normalizeSection<UiConfig>(input.ui, "ui", ["backdrop", "modelScenes", "hideBinaryDiffs", "defaultSidePanel", "contextRefreshSeconds", "usageRefreshSeconds", "autoHandoff", "autoHandoffPercent", "autoHandoffTokens"]);
  if (ui) result.ui = ui;
  const git = normalizeSection<GitConfig>(input.git, "git", ["historyLimit", "autoFetch"]);
  if (git) result.git = git;
  const forge = normalizeSection<ForgeConfig>(input.forge, "forge", ["enabled", "ghPath", "glabPath"]);
  if (forge) result.forge = forge;
  const updates = normalizeSection<UpdatesConfig>(input.updates, "updates", ["checkLatest"]);
  if (updates) result.updates = updates;
  const remote = normalizeSection<RemoteConfig>(input.remote, "remote", ["enabled", "interfaces", "port"]);
  if (remote) result.remote = remote;
  const providers = normalizeProviders(input.providers);
  if (providers) result.providers = providers;
  return applyEnvironmentOverrides(retireServerProviders(result));
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
function normalizeSection<T>(raw: unknown, prefix: string, fields: readonly string[]): T | undefined {
  if (raw === undefined) return undefined;
  const input = asSection(raw, prefix);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const descriptor = settingDescriptor(`${prefix}.${field}`);
    if (!descriptor) continue;
    // A line (`compactAt`) may be a bare token count in the file; it is read as the same text `config set` takes.
    out[field] = typeof value === "string" || (descriptor.kind.type === "line" && typeof value === "number") ? parseSettingValue(descriptor, String(value)) : checkTyped(descriptor.kind.type, value, `${prefix}.${field}`);
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

/** A provider section's per-model hand-off and compaction overrides (sizes and choices), as the fields to merge in. */
function handoffModelsOf(section: unknown, prefix: string): PerModelFields | undefined {
  const input = asSection(section, prefix);
  const out: PerModelFields = {};
  for (const field of ["autoHandoffModels", "compactAtModels"] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    const map = normalizeHandoffModels(raw, `${prefix}.${field}`);
    if (map) out[field] = map;
  }
  if (input.handoffModels !== undefined && input.handoffModels !== null) {
    const map = normalizeModeModels(input.handoffModels, `${prefix}.handoffModels`, ["ask", "auto", "off"] as const);
    if (map) out.handoffModels = map;
  }
  if (input.compactionModels !== undefined && input.compactionModels !== null) {
    const map = normalizeModeModels(input.compactionModels, `${prefix}.compactionModels`, ["provider", "ask", "auto", "off"] as const);
    if (map) out.compactionModels = map;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProviders(raw: unknown): ProvidersConfig | undefined {
  if (raw === undefined) return undefined;
  const input = asSection(raw, "providers");
  const result: ProvidersConfig = {};
  if (input.claude !== undefined) {
    const claude = normalizeSection<ClaudeProviderConfig>(input.claude, "providers.claude", [
      "binaryPath",
      "homePath",
      "thinkingDisplay",
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
      "moxenSkills",
      "instructions",
      "autoContinueAtUsageLimit",
      "sessionTtl",
      "webFetch",
      "todos",
      "mcpExclude",
      "disabledNativeTools",
      "webSearchOrder", "webFetchOrder",
    ]);
    const launchArgs = asSection(input.claude, "providers.claude").launchArgs;
    const args = Array.isArray(launchArgs) && launchArgs.every((entry) => typeof entry === "string") ? (launchArgs as string[]) : undefined;
    const models = handoffModelsOf(input.claude, "providers.claude");
    if (claude || args || models) result.claude = { ...(claude ?? {}), ...(args ? { launchArgs: args } : {}), ...models };
  }
  if (input.opencode !== undefined) {
    const opencode = normalizeSection<OpencodeProviderConfig>(input.opencode, "providers.opencode", ["binaryPath", "bundledSkills", "compaction", "compactAt", "handoff", "handoffAt", "autoCompact", "compactBuffer", "autoHandoff", "autoHandoffTokens", "autoHandoffPercent", "runtimeMode", "model", "thinkingEffort", "moxenTools", "orchestration", "moxenSkills", "instructions", "autoContinueAtUsageLimit", "sessionTtl", "webFetch", "todos", "mcpExclude", "disabledNativeTools", "webSearchOrder", "webFetchOrder", "moxenPrompt"]);
    const models = handoffModelsOf(input.opencode, "providers.opencode");
    if (opencode || models) result.opencode = { ...opencode, ...models };
  }
  if (input.harness !== undefined) {
    const withProfiles = normalizeHarnessConfig(input.harness);
    const defaults = normalizeSection<HarnessProviderConfig>(input.harness, "providers.harness", ["runtimeMode", "model", "thinkingEffort", "moxenTools", "orchestration", "moxenSkills", "instructions", "autoContinueAtUsageLimit", "sessionTtl", "webFetch", "todos", "mcpExclude", "compaction", "compactAt", "handoff", "handoffAt", "autoHandoff", "autoHandoffTokens", "autoHandoffPercent", "slots", "autoCompact", "autoCompactPercent", "autoCompactTokens", "keepRecentTokens", "webSearch", "webSearchKey", "webSearchKeyEnv", "searxngUrl", "webBrowser", "webBrowserPath", "webPrivateNetwork"]);
    const models = handoffModelsOf(input.harness, "providers.harness");
    const section = asSection(input.harness, "providers.harness");
    const keys = normalizeSection<Partial<Record<KeyedSearchBackend, string>>>(section.webSearchKeys, "providers.harness.webSearchKeys", ["exa", "brave"]);
    const keyEnvs = normalizeSection<Partial<Record<KeyedSearchBackend, string>>>(section.webSearchKeyEnvs, "providers.harness.webSearchKeyEnvs", ["exa", "brave"]);
    if (withProfiles || defaults || models || keys || keyEnvs) result.harness = { ...defaults, ...withProfiles, ...models, ...(keys ? { webSearchKeys: keys } : {}), ...(keyEnvs ? { webSearchKeyEnvs: keyEnvs } : {}) };
  }
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

export async function loadConfig(explicitPath?: string): Promise<{ config: CliConfig; path: string; exists: boolean }> {
  const configPath = path.resolve(expandHome(explicitPath ?? defaultConfigPath()));
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return { config: normalizeConfig(raw), path: configPath, exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { config: applyEnvironmentOverrides({ ...DEFAULT_CONFIG }), path: configPath, exists: false };
    if (error instanceof CliError) throw error;
    throw new CliError("CONFIG_READ_FAILED", `Could not read config at ${configPath}.`, { cause: error });
  }
}

export async function saveConfig(configPath: string, config: CliConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

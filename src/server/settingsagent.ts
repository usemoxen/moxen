/**
 * The safe view of Moxen's settings that an agent may read: the canonical
 * schema (`core/configschema.ts`) with only reviewed live values.
 *
 * A setting's descriptor is static and safe to show. Its live value is not:
 * the config can hold keychain references, MCP server env and header values,
 * Harness profile endpoints, custom profile or model identifiers, paths and
 * free-form instructions. So every key is redacted unless it is on an explicit
 * allowlist of reviewed non-free-form keys (enums, booleans, integers, and
 * validated duration/threshold lines). A new setting is therefore hidden until
 * someone adds it to the list.
 */
import { SETTING_SECTIONS, type SettingAppliesAt, type SettingDescriptor, type SettingEffective, type SettingKind, type SettingValue, type SettingView } from "../core/configschema.js";
import { CliError } from "../core/errors.js";
import { durationMs } from "../core/threads/idle.js";
import { lineText, parseLine } from "../core/threads/lines.js";

/** The MCP tool's name, shared by its definition, its routing and the server's denial check. */
export const SETTINGS_READ_TOOL = "settings_read";
export const AGENT_SETTINGS_DEFAULT_LIMIT = 40;
export const AGENT_SETTINGS_MAX_LIMIT = 100;

const PROVIDER_KINDS = ["claude", "codex", "opencode", "harness"] as const;

/**
 * Keys whose live value is safe for an agent to read: booleans, integers,
 * enums, and validated duration/threshold lines (never free-form strings,
 * user-defined provider/profile/model identifiers, paths or endpoints).
 * Deliberately explicit: a setting added later stays redacted until it is
 * reviewed here.
 */
const COMMON_PROVIDER_KEYS = [
  "runtimeMode",
  "memory",
  "orchestration",
  "moxenSkills",
  "webFetch",
  "moxenTools",
  "todos",
  "compaction",
  "compactAt",
  "handoff",
  "handoffAt",
  "autoHandoff",
  "autoHandoffPercent",
  "autoHandoffTokens",
  "sessionTtl",
  "autoContinueAtUsageLimit",
] as const;

const PROVIDER_ONLY_KEYS: Readonly<Record<(typeof PROVIDER_KINDS)[number], readonly string[]>> = {
  claude: ["thinkingDisplay", "promptSuggestions", "partialMessages", "ultracode", "agentSkills", "autoCompact", "autoCompactPercent", "autoCompactWindow", "usageWrapUp"],
  codex: ["reasoningSummary"],
  opencode: ["autoCompact", "compactBuffer", "moxenPrompt", "bundledSkills"],
  harness: ["autoCompact", "autoCompactPercent", "autoCompactTokens", "keepRecentTokens", "slots", "webSearch"],
};

const GLOBAL_KEYS = [
  "projectPolicy",
  "workspaceMode",
  "openMode",
  "threadEnvMode",
  "runtimeMode",
  "interactionMode",
  "sessionTtl",
  "backgroundForgottenAfter",
  "usageProtection",
  "usageRecovery",
  "usageContinuation",
  "usageColdResume",
  "usageColdResumeAfter",
  "usageColdResumeTokens",
  "usageMinimumSession",
  "usageMinimumWeekly",
  "autoContinueAtUsageLimit",
  "usageLimitContinues",
  "branchPruneDays",
  "skills.moxen",
  "installSkills",
  "speedMode",
  "memory",
  "memoryEmbeddings",
  "memoryEmbeddingLoading",
  "longThreads.handoff",
  "longThreads.handoffAt",
  "longThreads.compaction",
  "longThreads.compactAt",
  "web.browser",
  "web.privateNetwork",
  "updates.checkLatest",
  "git.historyLimit",
  "git.autoFetch",
  "forge.enabled",
  "mcpRunner",
] as const;

const LIVE_KEYS: ReadonlySet<string> = new Set([
  ...GLOBAL_KEYS,
  ...PROVIDER_KINDS.flatMap((kind) => [
    ...COMMON_PROVIDER_KEYS.map((field) => `providers.${kind}.${field}`),
    ...PROVIDER_ONLY_KEYS[kind].map((field) => `providers.${kind}.${field}`),
  ]),
]);

/** Whether this setting's live value may leave the server. */
export function agentSettingLiveAllowed(key: string): boolean {
  return LIVE_KEYS.has(key);
}

export type AgentSettingRedaction = "secret" | "complex" | "free-form" | "not-allowlisted";

export interface AgentSettingChoice {
  readonly value: string;
  readonly label: string;
  readonly hidden?: true;
}

export type AgentSettingKind =
  | { readonly type: "enum"; readonly choices: readonly AgentSettingChoice[] }
  | { readonly type: "boolean" }
  | { readonly type: "secret" }
  | { readonly type: "string" }
  | { readonly type: "integer"; readonly min: number; readonly max: number; readonly unit?: string; readonly binary?: boolean; readonly presets?: readonly number[] }
  | { readonly type: "duration"; readonly presets?: readonly string[] }
  | { readonly type: "line"; readonly presets?: readonly string[] }
  | { readonly type: "list"; readonly noun: string };

interface AgentSettingBase {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly section: string;
  readonly group?: string;
  readonly hidden?: boolean;
  readonly kind: AgentSettingKind;
  readonly appliesAt?: SettingAppliesAt;
}

/** A reviewed setting: its live value, where it comes from, and when it applies. */
export interface AgentSettingValue extends AgentSettingBase {
  readonly redacted: false;
  readonly value?: SettingValue;
  readonly explicit: boolean;
  readonly source: "config" | "fallback" | "default" | "unset";
  readonly effective?: SettingEffective;
  readonly unavailable?: string;
  readonly inForce?: string;
}

/** A setting whose live value stays on the server. */
export interface AgentSettingRedacted extends AgentSettingBase {
  readonly redacted: AgentSettingRedaction;
}

export type AgentSetting = AgentSettingValue | AgentSettingRedacted;

export interface AgentSettingsRequest {
  readonly key?: string;
  readonly section?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AgentSettingsResult {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly sections: readonly string[];
  readonly settings: readonly AgentSetting[];
}

function kindOf(kind: SettingKind): AgentSettingKind {
  switch (kind.type) {
    case "enum":
      return { type: "enum", choices: kind.choices.map((choice) => ({ value: choice.value, label: choice.label, ...(choice.hidden === true ? { hidden: true as const } : {}) })) };
    case "boolean":
      return { type: "boolean" };
    case "secret":
      return { type: "secret" };
    case "string":
      return { type: "string" };
    case "integer":
      return { type: "integer", min: kind.min, max: kind.max, ...(kind.unit === undefined ? {} : { unit: kind.unit }), ...(kind.binary === true ? { binary: true } : {}), ...(kind.presets === undefined ? {} : { presets: kind.presets }) };
    case "duration":
      return { type: "duration", ...(kind.presets === undefined ? {} : { presets: kind.presets }) };
    case "line":
      return { type: "line", ...(kind.presets === undefined ? {} : { presets: kind.presets }) };
    case "list":
      return { type: "list", noun: kind.noun };
  }
}

function redactionOf(descriptor: SettingDescriptor): AgentSettingRedaction {
  if (descriptor.kind.type === "secret") return "secret";
  if (descriptor.kind.type === "list") return "complex";
  if (descriptor.kind.type === "string") return "free-form";
  return "not-allowlisted";
}

function baseOf(descriptor: SettingDescriptor): AgentSettingBase {
  return {
    key: descriptor.key,
    label: descriptor.label,
    description: descriptor.description,
    section: descriptor.section,
    ...(descriptor.group === undefined ? {} : { group: descriptor.group }),
    ...(descriptor.hidden === true ? { hidden: true } : {}),
    kind: kindOf(descriptor.kind),
    ...(descriptor.appliesAt === undefined ? {} : { appliesAt: descriptor.appliesAt }),
  };
}

function canonicalLiveValue(
  kind: SettingKind,
  value: SettingValue,
): { readonly ok: true; readonly value: SettingValue } | { readonly ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  switch (kind.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false };
    case "integer":
      return typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : { ok: false };
    case "enum":
      return typeof value === "string" && kind.choices.some((choice) => choice.value === value) ? { ok: true, value } : { ok: false };
    case "duration":
      return typeof value === "string" && durationMs(value) !== null ? { ok: true, value: value.trim() } : { ok: false };
    case "line": {
      const parsed = parseLine(value);
      return parsed !== null ? { ok: true, value: lineText(parsed) } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

function projectView(view: SettingView): AgentSetting {
  const descriptor = view.descriptor;
  if (!agentSettingLiveAllowed(descriptor.key)) {
    return { ...baseOf(descriptor), redacted: redactionOf(descriptor) };
  }
  const raw = view.value === "" ? undefined : view.value;
  const checked = canonicalLiveValue(descriptor.kind, raw);
  const checkedEffective = view.effective === undefined ? undefined : canonicalLiveValue(descriptor.kind, view.effective.value);
  if (!checked.ok || (checkedEffective !== undefined && !checkedEffective.ok)) {
    return { ...baseOf(descriptor), redacted: "free-form" };
  }
  const value = checked.value;
  const effective = view.effective === undefined ? undefined : { ...view.effective, value: checkedEffective!.value };
  const source: AgentSettingValue["source"] = view.explicit
    ? "config"
    : effective !== undefined
      ? "fallback"
      : descriptor.defaultValue !== undefined
        ? "default"
        : "unset";
  return {
    ...baseOf(descriptor),
    redacted: false,
    ...(value === undefined || descriptor.kind.type === "secret" ? {} : { value }),
    explicit: view.explicit,
    source,
    ...(effective === undefined ? {} : { effective }),
    ...(view.unavailable === undefined ? {} : { unavailable: view.unavailable }),
    ...(view.inForce === undefined ? {} : { inForce: view.inForce }),
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new CliError("INVALID_TOOL_INPUT", "limit and offset must be numbers.");
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Project the canonical snapshot for `settings_read`. A key is exact and
 * must name a setting in the schema; anything else (an alias, a nested list
 * field, a typo) is refused rather than guessed at.
 */
export function projectAgentSettings(views: readonly SettingView[], request: AgentSettingsRequest): AgentSettingsResult {
  const sections = [...SETTING_SECTIONS];
  const key = request.key?.trim();
  if (key !== undefined && key !== "") {
    const view = views.find((candidate) => candidate.descriptor.key === key);
    if (view === undefined) {
      throw new CliError("SETTINGS_KEY_UNKNOWN", `Unknown setting key. Call ${SETTINGS_READ_TOOL} with no key to list the exact keys.`, { exitCode: 2 });
    }
    return { total: 1, offset: 0, limit: 1, hasMore: false, sections, settings: [projectView(view)] };
  }
  const section = request.section?.trim();
  if (section !== undefined && section !== "" && !(SETTING_SECTIONS as readonly string[]).includes(section)) {
    throw new CliError("SETTINGS_SECTION_UNKNOWN", `Unknown setting section. Call ${SETTINGS_READ_TOOL} with no key to list the sections.`, { exitCode: 2 });
  }
  const filtered = section === undefined || section === "" ? views : views.filter((view) => view.descriptor.section === section);
  const offset = clampInteger(request.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInteger(request.limit, AGENT_SETTINGS_DEFAULT_LIMIT, 1, AGENT_SETTINGS_MAX_LIMIT);
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < filtered.length;
  return {
    total: filtered.length,
    offset,
    limit,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    sections,
    settings: page.map(projectView),
  };
}

/**
 * Saved endpoints. A profile is configuration, not a secret: it names the
 * environment variable that holds the API key (`apiKeyEnv`) and the key is
 * read from it when a request goes out. Nothing here, and nothing derived
 * from it, ever holds the key's value beyond that call.
 */
import { cachedSecret, isSecretRef, primeSecret } from "../../secrets.js";
import { CliError } from "../../errors.js";
import type { HarnessModelConfig, HarnessProbedConfig, HarnessProfileConfig, HarnessProviderConfig } from "../../types.js";
import { parseLine } from "../../threads/lines.js";
import { autoCompactThreshold, DEFAULT_COMPACTION, type CompactionSettings } from "./compactsettings.js";
import { parseQuirkOverrides, resolveQuirks, type ModelQuirks, type ResolveQuirksInput } from "./quirks.js";

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Field names a key would be typed into by mistake; refused by name so the value is never looked at, let alone echoed. */
const KEY_FIELDS = ["apikey", "api_key", "key", "token", "secret", "password", "authorization", "headers"];

/** The instance id a profile's threads carry: `harness/<id>`. */
export function harnessInstanceId(profileId: string): string {
  return `harness/${profileId}`;
}

/** The profile id out of an instance id, or null when it is not a harness one. */
export function harnessProfileId(instanceId: string): string | null {
  const lower = instanceId.trim().toLowerCase();
  return lower.startsWith("harness/") && lower.length > "harness/".length ? lower.slice("harness/".length) : null;
}

function fail(label: string, message: string): never {
  throw new CliError("INVALID_CONFIG", `${label} ${message}`);
}

function optionalString(input: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${label}.${key}`, "must be a string.");
  return value.trim() === "" ? undefined : value.trim();
}

function optionalPositiveInt(input: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(`${label}.${key}`, "must be a positive whole number.");
  return value;
}

function optionalNumber(input: Record<string, unknown>, key: string, label: string, min: number, max: number): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${label}.${key}`, `must be a number from ${min} to ${max}.`);
  return value;
}

function parseModel(raw: unknown, label: string): HarnessModelConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(label, "must be an object.");
  const input = raw as Record<string, unknown>;
  const id = optionalString(input, "id", label);
  if (!id) fail(`${label}.id`, "is required.");
  const model: HarnessModelConfig = { id };
  const contextWindow = optionalPositiveInt(input, "contextWindow", label);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxOutput = optionalPositiveInt(input, "maxOutput", label);
  if (maxOutput !== undefined) model.maxOutput = maxOutput;
  if (input.vision !== undefined) {
    if (typeof input.vision !== "boolean") fail(`${label}.vision`, "must be true or false.");
    model.vision = input.vision;
  }
  const family = optionalString(input, "family", label);
  if (family !== undefined) model.family = family;
  if (input.efforts !== undefined) {
    if (!Array.isArray(input.efforts) || input.efforts.some((entry) => typeof entry !== "string" || entry.trim() === "")) fail(`${label}.efforts`, "must be a list of words.");
    const efforts = [...new Set((input.efforts as string[]).map((entry) => entry.trim()))];
    if (efforts.length > 0) model.efforts = efforts;
  }
  if (input.probed !== undefined) model.probed = parseProbed(input.probed, `${label}.probed`);
  return model;
}

function parseProbed(raw: unknown, label: string): HarnessProbedConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(label, "must be an object.");
  const input = raw as Record<string, unknown>;
  const at = optionalString(input, "at", label);
  if (at === undefined || Number.isNaN(Date.parse(at))) fail(`${label}.at`, "must be a date and time.");
  const probed: HarnessProbedConfig = { at, quirks: parseQuirkOverrides(input.quirks, `${label}.quirks`) };
  const contextWindow = optionalPositiveInt(input, "contextWindow", label);
  if (contextWindow !== undefined) probed.contextWindow = contextWindow;
  const slots = optionalPositiveInt(input, "slots", label);
  if (slots !== undefined) probed.slots = slots;
  const templateHash = optionalString(input, "templateHash", label);
  if (templateHash !== undefined) probed.templateHash = templateHash;
  return probed;
}

function parseProfile(raw: unknown, label: string): HarnessProfileConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(label, "must be an object.");
  const input = raw as Record<string, unknown>;
  const id = optionalString(input, "id", label)?.toLowerCase();
  if (!id || !PROFILE_ID.test(id)) fail(`${label}.id`, "must be lowercase letters, digits, '.', '_' or '-' (max 64).");
  const here = `${label}(${id})`;
  const keyField = Object.keys(input).find((name) => KEY_FIELDS.includes(name.toLowerCase()) && !(name === "apiKey" && isSecretRef(input.apiKey)));
  if (keyField !== undefined) {
    fail(`${here}.${keyField}`, keyField === "apiKey" ? "is a key, which is kept in the OS keychain and not in the config: set it on the settings page or with `moxen config set`." : "is not accepted: a profile holds the NAME of an environment variable (apiKeyEnv) or a reference to the keychain, never a key or a header.");
  }
  const apiFormat = input.apiFormat ?? "chat";
  if (apiFormat !== "chat" && apiFormat !== "responses" && apiFormat !== "anthropic") {
    fail(`${here}.apiFormat`, 'must be "chat", "responses" or "anthropic".');
  }
  const baseUrl = optionalString(input, "baseUrl", here);
  if (!baseUrl) fail(`${here}.baseUrl`, "is required.");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    if (parsed.username || parsed.password) throw new Error("credentials");
  } catch {
    fail(`${here}.baseUrl`, "must be an http(s) URL without credentials in it.");
  }
  const apiKeyEnv = optionalString(input, "apiKeyEnv", here);
  if (apiKeyEnv !== undefined && !ENV_NAME.test(apiKeyEnv)) {
    fail(`${here}.apiKeyEnv`, "must be the NAME of an environment variable, not the key itself.");
  }
  if (!Array.isArray(input.models) || input.models.length === 0) fail(`${here}.models`, "must list at least one model.");
  const models = input.models.map((entry, index) => parseModel(entry, `${here}.models[${index}]`));
  if (new Set(models.map((model) => model.id)).size !== models.length) fail(`${here}.models`, "lists a model twice.");

  const profile: HarnessProfileConfig = { id, apiFormat, baseUrl, models };
  const title = optionalString(input, "label", here);
  if (title !== undefined) profile.label = title;
  if (apiKeyEnv !== undefined) profile.apiKeyEnv = apiKeyEnv;
  if (isSecretRef(input.apiKey)) profile.apiKey = input.apiKey;
  if (input.sampling !== undefined) {
    if (typeof input.sampling !== "object" || input.sampling === null || Array.isArray(input.sampling)) fail(`${here}.sampling`, "must be an object.");
    const raw = input.sampling as Record<string, unknown>;
    const sampling: NonNullable<HarnessProfileConfig["sampling"]> = {};
    const temperature = optionalNumber(raw, "temperature", `${here}.sampling`, 0, 5);
    const topP = optionalNumber(raw, "topP", `${here}.sampling`, 0, 1);
    const topK = optionalNumber(raw, "topK", `${here}.sampling`, 0, 100_000);
    const minP = optionalNumber(raw, "minP", `${here}.sampling`, 0, 1);
    if (temperature !== undefined) sampling.temperature = temperature;
    if (topP !== undefined) sampling.topP = topP;
    if (topK !== undefined) sampling.topK = topK;
    if (minP !== undefined) sampling.minP = minP;
    if (Object.keys(sampling).length > 0) profile.sampling = sampling;
  }
  const slots = optionalPositiveInt(input, "slots", here);
  if (slots !== undefined) profile.slots = slots;
  if (input.preserveThinking !== undefined) {
    if (typeof input.preserveThinking !== "boolean") fail(`${here}.preserveThinking`, "must be true or false.");
    profile.preserveThinking = input.preserveThinking;
  }
  if (input.quirks !== undefined) {
    // Validated now so a bad value fails at load, not mid-turn; kept as the raw object.
    parseQuirkOverrides(input.quirks, `${here}.quirks`);
    profile.quirks = input.quirks as Record<string, unknown>;
  }
  if (input.compaction !== undefined) {
    if (typeof input.compaction !== "object" || input.compaction === null || Array.isArray(input.compaction)) fail(`${here}.compaction`, "must be an object.");
    const raw = input.compaction as Record<string, unknown>;
    const label = `${here}.compaction`;
    const compaction: NonNullable<HarnessProfileConfig["compaction"]> = {};
    if (raw.auto !== undefined) {
      if (typeof raw.auto !== "boolean") fail(`${label}.auto`, "must be true or false.");
      compaction.auto = raw.auto;
    }
    const fraction = optionalNumber(raw, "fraction", label, 0.3, 0.95);
    if (fraction !== undefined) compaction.fraction = fraction;
    const tokens = optionalPositiveInt(raw, "tokens", label);
    if (tokens !== undefined) compaction.tokens = tokens;
    const keep = optionalPositiveInt(raw, "keepRecentTokens", label);
    if (keep !== undefined) compaction.keepRecentTokens = keep;
    const effort = optionalString(raw, "effort", label);
    if (effort !== undefined) compaction.effort = effort;
    if (Object.keys(compaction).length > 0) profile.compaction = compaction;
  }
  if (input.loopGuard !== undefined) {
    if (typeof input.loopGuard !== "object" || input.loopGuard === null || Array.isArray(input.loopGuard)) fail(`${here}.loopGuard`, "must be an object.");
    const raw = input.loopGuard as Record<string, unknown>;
    const label = `${here}.loopGuard`;
    const guard: NonNullable<HarnessProfileConfig["loopGuard"]> = {};
    const warn = optionalPositiveInt(raw, "repeatWarn", label);
    if (warn !== undefined) guard.repeatWarn = warn;
    const stop = optionalPositiveInt(raw, "repeatStop", label);
    if (stop !== undefined) guard.repeatStop = stop;
    const text = optionalPositiveInt(raw, "textRepeats", label);
    if (text !== undefined) guard.textRepeats = text;
    for (const name of ["calls", "text"] as const) {
      const flag = raw[name];
      if (flag === undefined) continue;
      if (typeof flag !== "boolean") fail(`${label}.${name}`, "must be true or false.");
      guard[name] = flag;
    }
    if (Object.keys(guard).length > 0) profile.loopGuard = guard;
  }
  if (input.titles !== undefined) {
    if (typeof input.titles !== "boolean") fail(`${here}.titles`, "must be true or false.");
    profile.titles = input.titles;
  }
  if (input.toolDescriptions !== undefined) {
    if (typeof input.toolDescriptions !== "object" || input.toolDescriptions === null || Array.isArray(input.toolDescriptions)) fail(`${here}.toolDescriptions`, "must be an object of tool name to text.");
    const descriptions: Record<string, string> = {};
    for (const [tool, text] of Object.entries(input.toolDescriptions as Record<string, unknown>)) {
      if (typeof text !== "string" || text.trim() === "") fail(`${here}.toolDescriptions.${tool}`, "must be non-empty text.");
      descriptions[tool] = text as string;
    }
    if (Object.keys(descriptions).length > 0) profile.toolDescriptions = descriptions;
  }
  const append = optionalString(input, "systemPromptAppend", here);
  if (append !== undefined) profile.systemPromptAppend = append;
  return profile;
}

/**
 * The compaction settings in force for a profile, most specific first: the
 * profile's own, then the model's size on the Harness tab (`compactAtModels`),
 * then the tab's line (`compaction`, `compactAt`, which `driverProviders`
 * fills from the global line too), then its older keys, then ours. Within a
 * level a size beats a share, as it always has.
 */
export function resolveCompactionSettings(config: HarnessProviderConfig | undefined, profile: HarnessProfileConfig, model?: string): CompactionSettings {
  const own = profile.compaction;
  const modelTokens = model === undefined ? undefined : config?.compactAtModels?.[model];
  // The model's own choice beats the tab's; the Harness's own compaction is its automatic one.
  const chosen = model === undefined ? undefined : config?.compactionModels?.[model];
  const tabMode = chosen === undefined ? config?.compaction : chosen === "provider" ? "auto" : chosen;
  const line = own?.tokens !== undefined ? { tokens: own.tokens } : own?.fraction !== undefined ? { fraction: own.fraction } : modelTokens !== undefined ? { tokens: modelTokens } : tabLine(config);
  return {
    auto: own?.auto ?? (tabMode !== undefined ? tabMode !== "off" : config?.autoCompact) ?? DEFAULT_COMPACTION.auto,
    // A profile that switches compaction on or off itself is not asked about: it says what it wants.
    ask: own?.auto === undefined && tabMode === "ask",
    fraction: line !== null && "fraction" in line ? line.fraction : null,
    tokens: line !== null && "tokens" in line ? line.tokens : null,
    keepRecentTokens: own?.keepRecentTokens ?? config?.keepRecentTokens ?? DEFAULT_COMPACTION.keepRecentTokens,
    effort: own?.effort ?? DEFAULT_COMPACTION.effort,
  };
}

function tabLine(config: HarnessProviderConfig | undefined): { tokens: number } | { fraction: number } | null {
  const set = config?.compactAt === undefined ? null : parseLine(config.compactAt);
  if (set !== null) return "tokens" in set ? set : { fraction: set.percent / 100 };
  if (config?.autoCompactTokens !== undefined) return { tokens: config.autoCompactTokens };
  if (config?.autoCompactPercent !== undefined) return { fraction: Math.min(0.95, Math.max(0.3, config.autoCompactPercent / 100)) };
  return null;
}

/** Parse one harness profile on its own, so a lenient load can keep the good ones and report the bad one by index. */
export function parseHarnessProfile(raw: unknown, index: number): HarnessProfileConfig {
  return parseProfile(raw, `providers.harness.profiles[${index}]`);
}

/** Validate `providers.harness` from the config file. Undefined when it holds no profiles. */
export function normalizeHarnessConfig(raw: unknown): HarnessProviderConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("providers.harness", "must be an object.");
  const input = raw as Record<string, unknown>;
  if (input.profiles === undefined) return undefined;
  if (!Array.isArray(input.profiles)) fail("providers.harness.profiles", "must be a list.");
  const profiles = input.profiles.map((entry, index) => parseProfile(entry, `providers.harness.profiles[${index}]`));
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) fail("providers.harness.profiles", "uses an id twice.");
  return profiles.length > 0 ? { profiles } : undefined;
}

export interface ResolvedHarnessTarget {
  readonly profile: HarnessProfileConfig;
  readonly model: HarnessModelConfig;
  readonly quirks: ModelQuirks;
}

/**
 * The profile, model and quirks for a model selection. A model the profile
 * does not list is still sent as asked: an endpoint can serve more than its
 * profile names, and refusing would make the config a gate on the server.
 */
export function resolveHarnessTarget(config: HarnessProviderConfig | undefined, instanceId: string, modelId: string): ResolvedHarnessTarget {
  const profileId = harnessProfileId(instanceId);
  const profile = profileId === null ? undefined : config?.profiles?.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new CliError("PROVIDER_UNKNOWN", `No harness profile "${profileId ?? instanceId}". Add it under providers.harness.profiles.`, { details: { instanceId } });
  }
  const listed = profile.models.find((entry) => entry.id === modelId) ?? { id: modelId };
  // The server's own window stands in until the profile states one.
  const model = listed.contextWindow === undefined && listed.probed?.contextWindow !== undefined ? { ...listed, contextWindow: listed.probed.contextWindow } : listed;
  return { profile, model, quirks: resolveProfileQuirks(profile, listed) };
}

/** The quirks in force for one of a profile's models: preset, then its probe result, then the profile's overrides. */
export function resolveProfileQuirks(profile: HarnessProfileConfig, model: HarnessModelConfig, options: { readonly ignoreProbed?: boolean } = {}): ModelQuirks {
  return resolveQuirks(quirkInputs(profile, model, options));
}

export function quirkInputs(profile: HarnessProfileConfig, model: HarnessModelConfig, options: { readonly ignoreProbed?: boolean } = {}): ResolveQuirksInput {
  const label = `providers.harness.profiles(${profile.id})`;
  return {
    modelId: model.id,
    // Anthropic's API serves Claude models whatever the id is called (a proxy may rename them).
    family: model.family ?? (profile.apiFormat === "anthropic" ? "claude" : undefined),
    vision: model.vision,
    preserveThinking: profile.preserveThinking,
    probed: model.probed && !options.ignoreProbed ? parseQuirkOverrides(model.probed.quirks, `${label}.models(${model.id}).probed.quirks`) : undefined,
    overrides: profile.quirks ? parseQuirkOverrides(profile.quirks, `${label}.quirks`) : undefined,
  };
}

/** `<baseUrl>/chat/completions`, tolerating a base with or without `/v1` and trailing slashes. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

function versionedUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}${path}` : `${trimmed}/v1${path}`;
}

/** `<baseUrl>/v1/messages` (Anthropic), with the same tolerance for a base that already ends in `/v1`. */
export function anthropicMessagesUrl(baseUrl: string): string {
  return versionedUrl(baseUrl, "/messages");
}

/** `<baseUrl>/v1/responses` (OpenAI Responses). */
export function responsesUrl(baseUrl: string): string {
  return versionedUrl(baseUrl, "/responses");
}

/** Load the profile's saved key into memory, so `readProfileApiKey` can answer. Call before the first request. */
export async function primeProfileKey(profile: HarnessProfileConfig): Promise<void> {
  await primeSecret(profile.apiKey);
}

/** The key for a profile, from the keychain or its environment variable now. Undefined when none is configured or set. */
export function readProfileApiKey(profile: HarnessProfileConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // A key saved in the keychain wins; it was loaded into memory (`primeProfileKey`) before the request.
  const saved = cachedSecret(profile.apiKey);
  if (saved !== undefined) return saved;
  if (!profile.apiKeyEnv) return undefined;
  const value = env[profile.apiKeyEnv];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Where a Harness thread on "ask" is offered compaction: the threshold its
 * loop would use (profile, model, tab, window), as tokens. Null when it does
 * not ask (its profile decides, or compaction is automatic or off), or the
 * window is unknown, so no line can be placed.
 */
export function harnessAskLine(config: HarnessProviderConfig | undefined, instanceId: string, modelId: string): { readonly tokens: number } | null {
  let target: ResolvedHarnessTarget;
  try {
    target = resolveHarnessTarget(config, instanceId, modelId);
  } catch {
    return null;
  }
  const settings = resolveCompactionSettings(config, target.profile, target.model.id);
  if (!settings.ask) return null;
  const tokens = autoCompactThreshold(target.model.contextWindow, settings);
  return tokens === null ? null : { tokens };
}

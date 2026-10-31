import { driverKindOfInstance, type CliConfig } from "../../core/types.js";
import { configuredModel } from "../../core/catalog/selection.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import { updateState, versionNumber, type UpdatableProvider } from "../../core/catalog/update.js";
import type { SettingDescriptor, SettingEffective, SettingEnds, SettingSection, SettingValue, SettingView } from "../../core/configschema.js";
import { defaultEffortId, describeEffort } from "./display.js";
import { numberLabel } from "./numberlabel.js";
import { handoffModelsFromText, handoffModelsToText } from "./autohandoff.js";
import type { QueryResult } from "../../server/api.js";
import { t, tx } from "../i18n/index.js";

/**
 * What the settings page offers for a setting, as a list to pick from.
 *
 * The page never asks for typing unless nothing else can supply the value:
 * enums list their choices, integers and durations their presets, and the
 * model defaults the provider catalog (so "Model" lists the models
 * the default provider actually has). What stays free text is what only the
 * user knows — an executable's path, extra instructions.
 */
export interface SettingOption {
  /** What `settings.set` receives; `""` clears the key back to its default. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** What applies when nothing is chosen (the model's own effort, a setting's default): a slider says so under it. */
  readonly isDefault?: boolean;
  /** A short tag beside the label, drawn in the accent ("default"). */
  readonly badge?: string;
  /** The heading a long list files it under (a model under its provider). */
  readonly group?: string;
  /** A shorter label for a slider, where the stops share one line ("2m" for "2 minutes"). */
  readonly short?: string;
}

/** How a setting is edited on the page. */
export type SettingControl =
  /** `tristate`: the setting has no default of its own, so it can also be unset (Default), and `effective` says what that amounts to. */
  | { readonly kind: "toggle"; readonly tristate?: boolean; readonly effective?: SettingEffective }
  | {
      readonly kind: "pick";
      readonly options: readonly SettingOption[];
      /** `slider`: a few short values along a track, stepped with left and right. `list`: one per line. */
      readonly layout: "slider" | "list";
      /** What the slider's two ends mean. */
      readonly ends?: SettingEnds;
      /** `effort`: each stop gets its own colour along a cool-to-hot ramp. */
      readonly scale?: "effort";
      /** Long enough that typing narrows it. */
      readonly searchable: boolean;
      /** What the Default option amounts to, when the setting is unset and core knows. */
      readonly effective?: SettingEffective;
      /** The value in force is not one the catalog offers (a model another provider has, a level the model lacks): said beside it, still editable. */
      readonly warning?: string;
    }
  /** `effective`: what applies while it is unset (an older key's value), when core knows. */
  | { readonly kind: "text"; readonly multiline: boolean; readonly effective?: SettingEffective }
  /** A key or token: typed into a masked input and kept in the OS keychain. */
  | { readonly kind: "secret"; readonly effective?: SettingEffective }
  /** A structured list (the harness profiles): opens its own editor. */
  | { readonly kind: "list" }
  /** The MCP servers one provider gets: a checklist of every server, opened in its own editor. */
  | { readonly kind: "servers"; readonly servers: readonly McpAccessEntry[]; readonly excluded: readonly string[] }
  /** The provider's own tools: the same checklist, over the tools the provider ships with (the setting holds the ones switched OFF). */
  | { readonly kind: "tools"; readonly tools: readonly McpAccessEntry[]; readonly excluded: readonly string[] }
  /** The order a provider's model should try its web tools in: ranked rows first, then the rest. */
  /** `warning`: what the ranked tools still need (a server to add, a switch that is off), said on the closed row too. */
  | { readonly kind: "order"; readonly rows: readonly WebOrderRow[]; readonly warning?: string }
  /** The models of one provider, each with its own long-thread overrides or none: opened in its own editor, a page per model. */
  | { readonly kind: "handoff"; readonly models: readonly ModelOverrideEntry[]; readonly compaction: ModelCompactionChoices };

/** The four things a model can choose for itself; null follows the provider. */
export interface ModelOverrides {
  readonly handoff: string | null;
  readonly handoffAt: number | null;
  readonly compaction: string | null;
  readonly compactAt: number | null;
}
export type ModelOverrideField = keyof ModelOverrides;

/** One model as the per-model editor lists it. */
export interface ModelOverrideEntry extends ModelOverrides {
  readonly slug: string;
  readonly name: string;
  /** False for a model the setting names that the provider does not offer (no longer, or not without a login): listed so its override can be removed. */
  readonly offered: boolean;
}

/** The Compaction choices a model of this provider has, or why it has none (OpenCode while its own compaction is on). */
export interface ModelCompactionChoices {
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly unavailable: string | null;
}

/** The config key each per-model field is kept in, under `providers.<kind>.`. */
export const MODEL_OVERRIDE_KEY: Readonly<Record<ModelOverrideField, string>> = {
  handoff: "handoffModels",
  handoffAt: "autoHandoffModels",
  compaction: "compactionModels",
  compactAt: "compactAtModels",
};

export const HANDOFF_MODE_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Automatic" },
  { value: "off", label: "Off" },
];

/** A model with anything of its own. */
export function hasOverrides(entry: ModelOverrides): boolean {
  return entry.handoff !== null || entry.handoffAt !== null || entry.compaction !== null || entry.compactAt !== null;
}

/** The sizes the per-model slider offers; the catalog has no window per model, so these span a small local model (16K) to 1M. */
export const HANDOFF_PRESETS: readonly number[] = [16_000, 32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 500_000, 750_000, 1_000_000];

/** A hand-off size as the editor writes it: `128K`, `1M`, `1.5M`; anything else with separators. */
export function handoffTokensLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}

/** The slider's stops: the presets, plus the size already set when it is not one of them (a hand-edited 300k), in order. */
export function handoffStops(current: number | null): number[] {
  return current === null || HANDOFF_PRESETS.includes(current) ? [...HANDOFF_PRESETS] : [...HANDOFF_PRESETS, current].sort((a, b) => a - b);
}

/** A `slug=choice` text as a map (the choices are core's to check). */
export function modesFromText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[\n,]/)) {
    const at = part.lastIndexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** The four per-model settings' values, as the page holds them (text), keyed by field. */
export type ModelOverrideValues = Readonly<Record<ModelOverrideField, SettingValue>>;

/**
 * The models a provider's per-model editor lists: its catalog models (hidden
 * ones left out, the default first), each with what the four settings hold
 * for it, then any model they name that the catalog does not, so a stale or
 * hand-written override can still be seen and cleared.
 */
export function modelOverrideEntries(providers: readonly ProviderSummary[] | null, kind: "claude" | "codex" | "opencode" | "harness" | undefined, values: ModelOverrideValues): ModelOverrideEntry[] {
  const text = (field: ModelOverrideField) => (values[field] === undefined ? "" : String(values[field]));
  const sizes = { handoffAt: handoffModelsFromText(text("handoffAt")), compactAt: handoffModelsFromText(text("compactAt")) };
  const modes = { handoff: modesFromText(text("handoff")), compaction: modesFromText(text("compaction")) };
  const of = (slug: string): ModelOverrides => ({
    handoff: modes.handoff[slug] ?? null,
    handoffAt: sizes.handoffAt[slug] ?? null,
    compaction: modes.compaction[slug] ?? null,
    compactAt: sizes.compactAt[slug] ?? null,
  });
  const out: ModelOverrideEntry[] = [];
  const seen = new Set<string>();
  for (const provider of providers ?? []) {
    if (kind !== undefined && driverKindOfInstance(provider.instanceId) !== kind) continue;
    for (const model of [...provider.models].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true))) {
      if (model.isHidden || seen.has(model.slug)) continue;
      seen.add(model.slug);
      out.push({ slug: model.slug, name: model.name, ...of(model.slug), offered: true });
    }
  }
  // Before the catalog arrives nothing is known to be gone.
  const known = providers !== null;
  const named = new Set([...Object.keys(modes.handoff), ...Object.keys(sizes.handoffAt), ...Object.keys(modes.compaction), ...Object.keys(sizes.compactAt)]);
  for (const slug of named) if (!seen.has(slug)) out.push({ slug, name: known ? `${slug} (not offered)` : slug, ...of(slug), offered: !known });
  return out;
}

/** A per-model setting's text after `slug`'s `field` is set to `next` (null removes it); other models stay as they were. */
export function withModelOverride(field: ModelOverrideField, value: SettingValue, slug: string, next: string | number | null): string {
  const text = value === undefined ? "" : String(value);
  if (field === "handoffAt" || field === "compactAt") {
    const held = handoffModelsFromText(text);
    if (next === null) delete held[slug];
    else held[slug] = Number(next);
    return handoffModelsToText(held);
  }
  const held = modesFromText(text);
  if (next === null) delete held[slug];
  else held[slug] = String(next);
  return Object.entries(held).map(([model, choice]) => `${model}=${choice}`).join(", ");
}

/** One web tool in a provider's order: its rank (1 is tried first), or null when it is not ranked. */
export interface WebOrderRow {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly locked: string | null;
  readonly rank: number | null;
}

/** Ranked tools in the order the setting names them (an id the table lacks is kept, so it can be taken out), then the others. */
export function webOrderRows(entries: readonly { readonly id: string; readonly label: string; readonly summary: string; readonly locked: string | null }[], value: SettingValue): WebOrderRow[] {
  const order = [...new Set(String(value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  const ranked = order.map((id, at): WebOrderRow => {
    const entry = entries.find((candidate) => candidate.id === id);
    // i18n-exempt: English from core, translated where it is drawn (weborder.tsx)
    return { id, label: entry?.label ?? id, summary: entry?.summary ?? "not a tool Moxen knows", locked: entry?.locked ?? (entry ? null : "unknown"), rank: at + 1 };
  });
  return [...ranked, ...entries.filter((entry) => !order.includes(entry.id)).map((entry): WebOrderRow => ({ ...entry, rank: null }))];
}

/** One MCP server as a provider's checklist shows it. */
export interface McpAccessEntry {
  readonly name: string;
  readonly summary: string;
  /** Why this provider gets it no matter what is ticked here, or null. */
  readonly locked: string | null;
  readonly enabledWhenLocked?: boolean;
}

const option = (value: string, label: string, description?: string, isDefault = false, short?: string): SettingOption => ({
  value,
  label,
  ...(short === undefined ? {} : { short }),
  ...(description === undefined ? {} : { description }),
  ...(isDefault ? { isDefault } : {}),
});

function durationLabel(value: string): string {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (match === null) return value;
  const count = Number(match[1]);
  return t(`duration.${match[2] as "ms" | "s" | "m" | "h"}`, { count });
}

/** The Default option of a setting with no default of its own: it names what applies instead, as core worked it out. */
function defaultOption(effective: SettingEffective | undefined): SettingOption {
  if (effective === undefined) return option("", t("settings.default"), t("settings.nothingSet"));
  return option("", t("settings.default"), effective.origin === undefined ? effective.label : `${effective.label}, ${effective.origin}`);
}

/** The value a page writes for an unset setting: "Default (Full access)". */
export function defaultLabel(effective: SettingEffective | undefined): string {
  return effective === undefined ? t("settings.default") : t("settings.defaultOf", { value: effective.label });
}

/** A preset, marked when it is the value a setting has unless told otherwise. */
const presetOption = (value: string, label: string, defaultValue: SettingValue, short?: string): SettingOption =>
  String(defaultValue) === value ? option(value, label, t("settings.theDefault"), true, short) : option(value, label, undefined, false, short);

/** The value a key holds on the page right now, as `settings.set` would take it. */
function valueOf(settings: readonly SettingView[], key: string): string | undefined {
  const value = settings.find((view) => view.descriptor.key === key)?.value;
  return value === undefined || value === "" ? undefined : String(value);
}

/**
 * The model a new thread on this provider starts with according to the
 * settings, by the rule the server resolves new threads with
 * (`configuredModel` in core): the provider's own Model, else the global one
 * when the global Provider is this one. Undefined when neither applies, so
 * the provider's catalog default does.
 */
export function configuredDefaultModel(settings: readonly SettingView[], instanceId: string): string | undefined {
  const model = (kind: "claude" | "codex" | "opencode" | "harness") => ({ model: valueOf(settings, `providers.${kind}.model`) });
  const provider = valueOf(settings, "provider");
  const global = valueOf(settings, "model");
  return configuredModel(
    { ...(provider === undefined ? {} : { provider }), ...(global === undefined ? {} : { model: global }), providers: { codex: model("codex"), claude: model("claude"), opencode: model("opencode"), harness: model("harness") } } as Pick<CliConfig, "provider" | "model" | "providers">,
    instanceId,
  );
}

/** Whose models a model setting picks from, for a warning: the provider of its page, else the global Provider. */
function catalogName(settings: readonly SettingView[], providers: readonly ProviderSummary[], providerKind: "claude" | "codex" | "opencode" | "harness" | undefined): string {
  const aimed = valueOf(settings, "provider");
  const provider = providers.find((entry) => (providerKind !== undefined ? driverKindOfInstance(entry.instanceId) === providerKind : entry.instanceId === aimed));
  return provider?.displayName ?? provider?.instanceId ?? t("settings.theProvider");
}

/** The catalog providers worth offering: enabled ones. */
function offered(providers: readonly ProviderSummary[]): readonly ProviderSummary[] {
  return providers.filter((provider) => provider.enabled);
}

/** The provider an MCP access setting (`providers.<kind>.mcpExclude`) belongs to. */
function mcpAccessKind(key: string): "claude" | "codex" | "opencode" | "harness" | null {
  const kind = /^providers\.(claude|codex|opencode|harness)\.mcpExclude$/.exec(key)?.[1];
  return kind === "codex" || kind === "claude" || kind === "opencode" || kind === "harness" ? kind : null;
}

/** Every configured server with what keeps it from this provider besides the checklist, and the names switched off here. */
function mcpAccessControl(descriptor: SettingDescriptor, value: SettingValue, settings: readonly SettingView[]): SettingControl {
  const kind = mcpAccessKind(descriptor.key);
  const items = settings.find((view) => view.descriptor.key === "mcpServers")?.items ?? [];
  const servers = items.map((item): McpAccessEntry => {
    const offered = String(item.fields.find((field) => field.path === "providers")?.value ?? "").split(",").map((word) => word.trim()).filter((word) => word !== "");
    const off = item.fields.find((field) => field.path === "disabled")?.value === true;
    const locked = off ? "switched off on its own entry" : kind !== null && offered.length > 0 && !offered.includes(kind) ? `only offered to ${offered.join(", ")}` : null;
    return { name: item.id, summary: item.summary, locked };
  });
  const excluded = String(value ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  return { kind: "servers", servers, excluded };
}

function catalogOptions(
  source: "provider" | "model" | "effort",
  settings: readonly SettingView[],
  providers: readonly ProviderSummary[],
  providerKind?: "claude" | "codex" | "opencode" | "harness",
  effective?: SettingEffective,
): SettingOption[] {
  const available = offered(providers);
  const providerId = valueOf(settings, "provider");
  // A provider's own page lists that provider's models; the global one follows the default provider.
  const scoped =
    providerKind !== undefined
      ? available.filter((provider) => driverKindOfInstance(provider.instanceId) === providerKind)
      : providerId === undefined
        ? available
        : available.filter((provider) => provider.instanceId === providerId);
  if (source === "provider") {
    return [
      option("", t("settings.firstAvailable"), effective?.label ?? t("settings.claudeWhenInstalled")),
      ...available.map((provider) => option(provider.instanceId, provider.displayName ?? provider.instanceId)),
    ];
  }
  if (source === "model") {
    const out: SettingOption[] = [effective === undefined ? option("", t("settings.providerDefault")) : defaultOption(effective)];
    const seen = new Set<string>();
    for (const provider of scoped) {
      // Across providers each one's models sit under its own heading, the provider's default first.
      const group = scoped.length > 1 ? (provider.displayName ?? provider.instanceId) : undefined;
      const models = [...provider.models].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
      for (const model of models) {
        if (model.isHidden || seen.has(model.slug)) continue;
        seen.add(model.slug);
        // The name says which model it is and the slug stays searchable; what the row adds is the range of reasoning levels it takes.
        const levels = model.efforts.flatMap((descriptor) => descriptor.choices.map((choice) => choice.id));
        const range = levels.length === 0 ? undefined : levels.length === 1 ? levels[0] : `${levels[0]}–${levels[levels.length - 1]}`;
        out.push({
          ...option(model.slug, model.name, range),
          ...(model.isDefault === true ? { badge: "default" } : {}),
          ...(group === undefined ? {} : { group }),
        });
      }
    }
    return out;
  }
  // Effort: the levels the model a new thread would start on takes. On a
  // provider's page (or with a global Provider) that is one model; with no
  // global Provider the setting reaches every provider, so only the levels
  // each provider's model takes are offered: none of them can be handed a
  // level its model lacks.
  const out: SettingOption[] = [effective === undefined ? option("", t("settings.providerDefault")) : defaultOption(effective)];
  const perProvider = scoped.flatMap((provider) => {
    const slug = configuredDefaultModel(settings, provider.instanceId) ?? provider.models.find((model) => model.isDefault === true)?.slug;
    const model = provider.models.find((candidate) => candidate.slug === slug) ?? (slug === undefined ? provider.models[0] : undefined);
    const choices = model?.efforts.flatMap((descriptor) => descriptor.choices) ?? [];
    return choices.length === 0 ? [] : [choices];
  });
  const levels = new Map<string, { id: string; label: string; isDefault?: boolean | null | undefined }>();
  for (const choice of perProvider[0] ?? []) {
    if (perProvider.every((choices) => choices.some((other) => other.id === choice.id)) && !levels.has(choice.id)) levels.set(choice.id, choice);
  }
  const fallback = defaultEffortId([...levels.values()]);
  for (const choice of levels.values()) out.push(choice.id === fallback ? option(choice.id, tx(choice.label), describeEffort(choice.id, true), true) : option(choice.id, tx(choice.label), describeEffort(choice.id, false)));
  if (out.length === 1) out[0] = option("", t("settings.providerDefault"), t("settings.noEffortSetting"));
  return out;
}

/**
 * A permission mode none of the providers the setting governs can run: a
 * provider reports the modes it takes, and offering one it would refuse only
 * sets a value that does nothing. Without a report (null) nothing is hidden.
 */
function isUnsupportedMode(
  descriptor: SettingDescriptor,
  mode: string,
  settings: readonly SettingView[],
  providers: readonly ProviderSummary[] | null,
): boolean {
  if (!descriptor.key.endsWith("runtimeMode") || providers === null) return false;
  const kindOfPage = descriptor.key.startsWith("providers.") ? (descriptor.key.split(".")[1] as "claude" | "codex" | "opencode" | "harness") : undefined;
  const providerId = valueOf(settings, "provider");
  const governed = offered(providers).filter((provider) =>
    kindOfPage !== undefined ? driverKindOfInstance(provider.instanceId) === kindOfPage : providerId === undefined || provider.instanceId === providerId,
  );
  if (governed.length === 0 || governed.some((provider) => provider.supportedRuntimeModes === null)) return false;
  return !governed.some((provider) => provider.supportedRuntimeModes!.includes(mode as never));
}

/**
 * How the page edits `descriptor`, given every setting's value (the model
 * list follows the default provider) and the provider catalog. A value the
 * lists do not name (a model pinned by hand, a custom duration) is kept as
 * the first option, so opening the list never hides what is in force.
 */
export function settingControl(
  descriptor: SettingDescriptor,
  value: SettingValue,
  settings: readonly SettingView[],
  providers: readonly ProviderSummary[] | null,
): SettingControl {
  const kind = descriptor.kind;
  const effective = descriptor.defaultValue === undefined ? settings.find((view) => view.descriptor.key === descriptor.key)?.effective : undefined;
  // A preset is marked as what applies by default: the setting's own default, else what its fallback amounts to.
  const applies = descriptor.defaultValue ?? effective?.value;
  let options: SettingOption[];
  switch (kind.type) {
    case "list":
      return { kind: "list" };
    case "secret":
      return effective ? { kind: "secret", effective } : { kind: "secret" };
    case "boolean":
      return descriptor.defaultValue === undefined ? { kind: "toggle", tristate: true, ...(effective ? { effective } : {}) } : { kind: "toggle" };
    case "enum":
      options = [
        ...(descriptor.defaultValue === undefined ? [defaultOption(effective)] : []),
        ...kind.choices
          .filter((choice) => choice.hidden !== true && !isUnsupportedMode(descriptor, choice.value, settings, providers))
          .map((choice) => option(choice.value, choice.label, choice.description)),
      ];
      break;
    case "integer":
      if (kind.presets === undefined) return { kind: "text", multiline: false };
      options = [
        // A key unset by default needs a way back to unset, which is also what it reads as at first.
        ...(descriptor.defaultValue === undefined ? [defaultOption(effective)] : []),
        ...kind.presets.map((preset) => presetOption(String(preset), `${numberLabel(preset, kind.binary)}${kind.unit ?? ""}`, applies)),
      ];
      break;
    case "line":
      if (kind.presets === undefined) return { kind: "text", multiline: false };
      // Shares first (they follow any window), then sizes from small local models up.
      options = [
        ...(descriptor.defaultValue === undefined ? [defaultOption(effective)] : []),
        ...kind.presets.map((preset) => presetOption(preset, t(preset.endsWith("%") ? "settings.ofWindow" : "settings.tokensOf", { preset }), applies, preset)),
      ];
      break;
    case "duration":
      if (kind.presets === undefined) return { kind: "text", multiline: false };
      options = kind.presets.map((preset) => presetOption(preset, durationLabel(preset), descriptor.defaultValue, preset));
      break;
    case "string":
      if (kind.source === "mcp-server") return mcpAccessControl(descriptor, value, settings);
      if (kind.source === "web-order") {
        const rows = webOrderRows(settings.find((view) => view.descriptor.key === descriptor.key)?.order ?? [], value);
        const blocked = rows.filter((row) => row.rank !== null && row.locked !== null && row.locked !== "unknown");
        return blocked.length === 0 ? { kind: "order", rows } : { kind: "order", rows, warning: t("settings.rankedUnavailable", { list: blocked.map((row) => `${row.label} (${tx(row.locked ?? "")})`).join("; ") }) };
      }
      if (kind.source === "native-tools") {
        const tools = (kind.tools ?? []).map((tool): McpAccessEntry => ({ name: tool.name, summary: tx(tool.summary), locked: tool.disabledReason ?? null, ...(tool.disabledReason ? { enabledWhenLocked: true } : {}) }));
        return { kind: "tools", tools, excluded: String(value ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "") };
      }
      if (kind.source === "model-overrides") return modelOverridesControl(descriptor, value, settings, providers, kind.providerKind);
      if (kind.source === undefined) return { kind: "text", multiline: kind.multiline === true, ...(effective ? { effective } : {}) };
      // No catalog yet (still loading): the list would be empty, not wrong.
      options = catalogOptions(kind.source, settings, providers ?? [], kind.providerKind, effective);
      break;
  }
  const current = value === undefined || value === "" ? "" : String(value);
  const unknown = !options.some((entry) => entry.value === current);
  // Only a loaded catalog can say a model or level is not there; while it loads, nothing is claimed.
  const warning = unknown && kind.type === "string" && (kind.source === "model" || kind.source === "effort") && providers !== null && options.length > 1
    ? kind.source === "model"
      ? t("settings.notAModel", { current, catalog: catalogName(settings, providers, kind.providerKind) })
      : t("settings.noLevel", { current })
    : undefined;
  if (unknown) options = [option(current, current, t("settings.setInFile")), ...options];
  // A few short values read better side by side; names and long lists get a line each.
  const stops = options.filter((entry) => entry.value !== "");
  const slider =
    (kind.type === "integer" || kind.type === "duration" || (kind.type === "string" && kind.source === "effort")) && stops.length >= 2 && stops.length <= 12 && stops.every((entry) => (entry.short ?? entry.label).length <= 20);
  const ends: SettingEnds | undefined = kind.type === "string" ? { low: t("settings.faster"), high: t("settings.smarter") } : kind.type === "integer" || kind.type === "duration" ? (kind.ends === undefined ? undefined : { low: tx(kind.ends.low), high: tx(kind.ends.high) }) : undefined;
  return { kind: "pick", options, layout: slider ? "slider" : "list", ...(slider && ends !== undefined ? { ends } : {}),
    ...(slider && kind.type === "string" && kind.source === "effort" ? { scale: "effort" as const } : {}), searchable: !slider && (options.length > 8 || (kind.type === "string" && kind.source === "model" && options.length > 6)),
    ...(effective ? { effective } : {}), ...(warning ? { warning } : {}) };
}

/**
 * What pressing a switch writes. A two-way switch flips. A three-way one goes
 * unset, on, off, then back to unset (`""` clears the key), so the page can
 * always return to what applies when nothing is set here.
 */
export function nextToggleValue(control: Extract<SettingControl, { kind: "toggle" }>, value: SettingValue): string {
  if (control.tristate !== true) return value === true ? "false" : "true";
  return value === undefined ? "true" : value === true ? "false" : "";
}

/** A setting's value as the page shows it. */
export function settingValueLabel(descriptor: SettingDescriptor, value: SettingValue, control: SettingControl, count?: number): string {
  if (descriptor.kind.type === "list") {
    const noun = descriptor.kind.noun;
    return count === undefined || count === 0 ? t("settings.noneYet") : `${count} ${noun}${count === 1 ? "" : "s"}`;
  }
  if (control.kind === "servers") {
    // Only the servers this provider could get count: one limited elsewhere is not the checklist's to say.
    const open = control.servers.filter((server) => server.locked === null);
    const total = open.length;
    if (control.servers.length === 0) return t("settings.noServersYet");
    if (total === 0) return t("settings.noneAny");
    const off = open.filter((server) => control.excluded.includes(server.name)).length;
    return off === 0 ? (total === 1 ? t("settings.theServer") : t("settings.allServers", { count: total })) : off === total ? t("settings.noneAny") : t("settings.ofTotal", { count: total - off, total });
  }
  if (control.kind === "order") {
    const ranked = control.rows.filter((row) => row.rank !== null);
    return ranked.length === 0 ? t("settings.noPreference") : ranked.map((row) => row.label).join(" → ");
  }
  if (control.kind === "tools") {
    const off = control.excluded.length;
    return off === 0 ? t("settings.allOn") : t("settings.countOff", { count: off });
  }
  if (control.kind === "handoff") {
    const set = control.models.filter(hasOverrides).length;
    return set === 0 ? t("settings.noneAny") : t("settings.models", { count: set });
  }
  if (descriptor.kind.type === "boolean") {
    if (control.kind === "toggle" && control.tristate === true && value === undefined) return defaultLabel(control.effective);
    return value === true ? t("settings.on") : t("settings.off");
  }
  if (descriptor.kind.type === "secret") {
    if (value !== undefined && value !== "") return t("settings.keySaved");
    return control.kind === "secret" && control.effective !== undefined ? defaultLabel(control.effective) : t("settings.noKey");
  }
  if (control.kind === "pick") {
    const current = value === undefined || value === "" ? "" : String(value);
    const match = control.options.find((entry) => entry.value === current);
    if (match !== undefined) return match.value === "" && match.label === t("settings.default") ? defaultLabel(control.effective) : match.label;
  }
  if (value === undefined || value === "") return control.kind === "text" ? defaultLabel(control.effective) : t("settings.default");
  if (descriptor.kind.type === "integer") return `${typeof value === "number" ? numberLabel(value, descriptor.kind.binary) : String(value)}${descriptor.kind.unit ?? ""}`;
  return String(value);
}

// -- provider versions and updates ---------------------------------------------

/** The provider a settings section is about, when it can be updated from here. */
export function updatableProviderOf(section: SettingSection): UpdatableProvider | null {
  if (section === "provider:codex") return "codex";
  if (section === "provider:claude") return "claude";
  if (section === "provider:opencode") return "opencode";
  return null;
}

/** One provider as the doctor query reports it. */
export type ProviderCheckView = QueryResult<"doctor">["providers"]["claude"];

/** What the registry said about one provider's newest release; `undefined` while it is still being asked. */
export type LatestView = { readonly enabled: boolean; readonly latest: string | null; readonly channel: string | null };

export interface ProviderVersionLine {
  /** The version number, or null when the binary is missing or would not say. */
  readonly version: string | null;
  /** One sentence on where it stands: against the floor Moxen holds it to, then the newest release. */
  readonly status: string;
  readonly tone: "ok" | "warn" | "update" | "muted";
  /** The update button's text: it names the version when there is one to go to, and says so when there is not. */
  readonly button: string;
  /** Nothing newer exists, so the button is a statement more than an action. */
  readonly settled: boolean;
}

/**
 * Where an installed provider stands, for the settings page: its version,
 * whether it meets the floor Moxen holds it to, and whether a newer release
 * exists on its channel. "Newer exists" comes only from a successful registry
 * read; without one the page says it could not tell, never "up to date".
 */
export function providerVersionLine(check: ProviderCheckView | undefined, latest?: LatestView): ProviderVersionLine {
  const base = { button: t("settings.update.button"), settled: false } as const;
  if (check === undefined) return { ...base, version: null, status: t("settings.update.checking"), tone: "muted" };
  if (!check.installed) return { ...base, version: null, status: t("settings.update.notFound"), tone: "warn" };
  const version = versionNumber(check.version);
  if (version === null) return { ...base, version: null, status: t("settings.update.noVersion"), tone: "warn" };
  if (check.minVersion !== undefined && !check.ok) {
    return { ...base, version, status: t("settings.update.tooOld", { min: check.minVersion }), tone: "warn" };
  }
  if (latest === undefined) return { ...base, version, status: t("settings.update.checkingLatest"), tone: "muted" };
  if (!latest.enabled) return { ...base, version, status: t("settings.update.checksOff"), tone: "muted" };
  const state = updateState(version, latest.latest);
  const channel = latest.channel === null ? "" : t("settings.update.channel", { channel: latest.channel });
  if (state === "available") {
    return { version, status: t("settings.update.available", { latest: latest.latest ?? "", channel }), tone: "update", button: t("settings.update.buttonTo", { version: latest.latest ?? "" }), settled: false };
  }
  if (state === "current") {
    return { version, status: t("settings.update.current", { latest: latest.latest ?? "", channel }), tone: "ok", button: t("settings.update.buttonCurrent"), settled: true };
  }
  return { ...base, version, status: t("settings.update.cannotCheck"), tone: "muted" };
}

/** The "Per model" row: every model with its four overrides, read from the four settings beside it, and what its Compaction can be. */
function modelOverridesControl(descriptor: SettingDescriptor, value: SettingValue, settings: readonly SettingView[], providers: readonly ProviderSummary[] | null, kind: "claude" | "codex" | "opencode" | "harness" | undefined): SettingControl {
  const prefix = descriptor.key.slice(0, descriptor.key.lastIndexOf(".") + 1);
  const read = (field: ModelOverrideField) => settings.find((view) => view.descriptor.key === `${prefix}${MODEL_OVERRIDE_KEY[field]}`)?.value;
  // The row's own key holds the hand-off sizes; the other three sit beside it.
  const values: ModelOverrideValues = { handoff: read("handoff"), handoffAt: value, compaction: read("compaction"), compactAt: read("compactAt") };
  const compactionView = settings.find((view) => view.descriptor.key === `${prefix}compaction`);
  const choices = compactionView !== undefined && compactionView.descriptor.kind.type === "enum" ? compactionView.descriptor.kind.choices.filter((choice) => choice.hidden !== true).map((choice) => ({ value: choice.value, label: choice.label })) : [];
  // OpenCode's own compaction is one switch for its whole server: while it is on, no model can choose otherwise, and no model can turn it on.
  const providerMode = String(compactionView?.value ?? compactionView?.effective?.value ?? "");
  const compaction: ModelCompactionChoices =
    kind === "opencode"
      ? providerMode === "provider"
        ? { choices: [], unavailable: t("settings.openCodeCompacts") }
        : { choices: choices.filter((choice) => choice.value !== "provider"), unavailable: null }
      : { choices, unavailable: null };
  return { kind: "handoff", models: modelOverrideEntries(providers, kind, values), compaction };
}

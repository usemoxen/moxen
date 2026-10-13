import type { ProviderSummary } from "../../core/catalog/summary.js";
import { updateState, versionNumber, type UpdatableProvider } from "../../core/catalog/update.js";
import type { SettingDescriptor, SettingSection, SettingValue, SettingView } from "../../core/configschema.js";
import type { QueryResult } from "../../server/api.js";

/**
 * What the settings page offers for a setting, as a list to pick from.
 *
 * The page never asks for typing unless nothing else can supply the value:
 * enums list their choices, integers and durations their presets, and the
 * model defaults the provider catalog (so "Default model" lists the models
 * the default provider actually has). What stays free text is what only the
 * user knows — an executable's path, extra instructions.
 */
export interface SettingOption {
  /** What `settings.set` receives; `""` clears the key back to its default. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** How a setting is edited on the page. */
export type SettingControl =
  | { readonly kind: "toggle" }
  | { readonly kind: "pick"; readonly options: readonly SettingOption[] }
  | { readonly kind: "text"; readonly multiline: boolean };

const option = (value: string, label: string, description?: string): SettingOption =>
  description === undefined ? { value, label } : { value, label, description };

/** Big numbers with thousands separators (`200,000`), small ones as they are. */
function numberLabel(value: number): string {
  return value >= 10_000 ? value.toLocaleString("en-US") : String(value);
}

function durationLabel(value: string): string {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (match === null) return value;
  const count = Number(match[1]);
  const unit = { ms: "millisecond", s: "second", m: "minute", h: "hour" }[match[2] as "ms" | "s" | "m" | "h"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The value a key holds on the page right now, as `settings.set` would take it. */
function valueOf(settings: readonly SettingView[], key: string): string | undefined {
  const value = settings.find((view) => view.descriptor.key === key)?.value;
  return value === undefined || value === "" ? undefined : String(value);
}

/** The catalog providers worth offering: enabled ones. */
function offered(providers: readonly ProviderSummary[]): readonly ProviderSummary[] {
  return providers.filter((provider) => provider.enabled);
}

function catalogOptions(
  source: "provider" | "model" | "effort",
  settings: readonly SettingView[],
  providers: readonly ProviderSummary[],
): SettingOption[] {
  const available = offered(providers);
  const providerId = valueOf(settings, "provider");
  const scoped = providerId === undefined ? available : available.filter((provider) => provider.instanceId === providerId);
  if (source === "provider") {
    return [
      option("", "Not set", "Each project's own default."),
      ...available.map((provider) => option(provider.instanceId, provider.displayName ?? provider.instanceId, provider.instanceId)),
    ];
  }
  if (source === "model") {
    const out: SettingOption[] = [option("", "Provider's default")];
    const seen = new Set<string>();
    for (const provider of scoped) {
      for (const model of provider.models) {
        if (model.isHidden || seen.has(model.slug)) continue;
        seen.add(model.slug);
        // Across providers the provider name tells two same-named models apart.
        const where = scoped.length > 1 ? `${provider.displayName ?? provider.instanceId} · ` : "";
        out.push(option(model.slug, model.name, `${where}${model.slug}`));
      }
    }
    return out;
  }
  // Effort: the levels the default model takes, or every level the
  // offered models share a name for when no model is pinned.
  const modelSlug = valueOf(settings, "model");
  const out: SettingOption[] = [option("", "Provider's default")];
  const seen = new Set<string>();
  for (const provider of scoped) {
    for (const model of provider.models) {
      if (modelSlug !== undefined && model.slug !== modelSlug) continue;
      for (const descriptor of model.efforts) {
        for (const choice of descriptor.choices) {
          if (seen.has(choice.id)) continue;
          seen.add(choice.id);
          out.push(option(choice.id, choice.label));
        }
      }
    }
  }
  return out;
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
  let options: SettingOption[];
  switch (kind.type) {
    case "boolean":
      return { kind: "toggle" };
    case "enum":
      options = [
        ...(descriptor.defaultValue === undefined ? [option("", "Not set", "Whatever the provider does by default.")] : []),
        ...kind.choices.map((choice) => option(choice.value, choice.label, choice.description)),
      ];
      break;
    case "integer":
      if (kind.presets === undefined) return { kind: "text", multiline: false };
      options = [
        // A key unset by default needs a way back to unset, which is also what it reads as at first.
        ...(descriptor.defaultValue === undefined ? [option("", "Not set", "Left to the provider")] : []),
        ...kind.presets.map((preset) => option(String(preset), `${numberLabel(preset)}${kind.unit ?? ""}`)),
      ];
      break;
    case "duration":
      if (kind.presets === undefined) return { kind: "text", multiline: false };
      options = kind.presets.map((preset) => option(preset, durationLabel(preset)));
      break;
    case "string":
      if (kind.source === undefined) return { kind: "text", multiline: kind.multiline === true };
      // No catalog yet (still loading): the list would be empty, not wrong.
      options = catalogOptions(kind.source, settings, providers ?? []);
      break;
  }
  const current = value === undefined || value === "" ? "" : String(value);
  if (!options.some((entry) => entry.value === current)) options = [option(current, current, "Set in the config file"), ...options];
  return { kind: "pick", options };
}

/** A setting's value as the page shows it. */
export function settingValueLabel(descriptor: SettingDescriptor, value: SettingValue, control: SettingControl): string {
  if (descriptor.kind.type === "boolean") return value === true ? "On" : "Off";
  if (control.kind === "pick") {
    const current = value === undefined || value === "" ? "" : String(value);
    const match = control.options.find((entry) => entry.value === current);
    if (match !== undefined) return match.label;
  }
  if (value === undefined || value === "") return "Not set";
  if (descriptor.kind.type === "integer") return `${typeof value === "number" ? numberLabel(value) : String(value)}${descriptor.kind.unit ?? ""}`;
  return String(value);
}

// -- provider versions and updates ---------------------------------------------

/** The provider a settings section is about, when it can be updated from here. */
export function updatableProviderOf(section: SettingSection): UpdatableProvider | null {
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
  const base = { button: "[ Update ]", settled: false } as const;
  if (check === undefined) return { ...base, version: null, status: "Checking…", tone: "muted" };
  if (!check.installed) return { ...base, version: null, status: "Not found on this machine. Check the executable path below.", tone: "warn" };
  const version = versionNumber(check.version);
  if (version === null) return { ...base, version: null, status: "Could not read its version.", tone: "warn" };
  if (check.minVersion !== undefined && !check.ok) {
    return { ...base, version, status: `Older than the ${check.minVersion} Moxen needs: sessions will not start until it is updated.`, tone: "warn" };
  }
  if (latest === undefined) return { ...base, version, status: "Checking for a newer version…", tone: "muted" };
  if (!latest.enabled) return { ...base, version, status: "Version checks are off (Settings, General).", tone: "muted" };
  const state = updateState(version, latest.latest);
  const channel = latest.channel === null ? "" : ` on the ${latest.channel} channel`;
  if (state === "available") {
    return { version, status: `${latest.latest} is available${channel}.`, tone: "update", button: `[ Update to ${latest.latest} ]`, settled: false };
  }
  if (state === "current") {
    return { version, status: `Up to date: ${latest.latest} is the newest${channel}.`, tone: "ok", button: "[ Up to date ]", settled: true };
  }
  return { ...base, version, status: "Could not check for a newer version.", tone: "muted" };
}

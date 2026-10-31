/**
 * The settings schema: one declarative table describing every key the
 * config file accepts.
 *
 * This exists so the CLI and the TUI cannot drift. `moxen config set` used
 * to validate against a flat `CONFIG_KEYS` tuple while nothing else knew
 * what a key meant — no label, no range, no idea whether it was an enum.
 * A TUI settings page built against that would have had to restate all of
 * it, and the two would have disagreed by the second change. Here the
 * table *is* the contract: the CLI derives its key list from it, the TUI
 * renders a control per descriptor, and adding a setting is one entry.
 *
 * It lives in the shared kernel (`src/core/config*`) on purpose — a client
 * may read vocabulary directly, and a setting's type and choices are
 * vocabulary. Applying a change still goes through `ClientApi`, because a
 * server outlives any one client and owns the file.
 *
 * Keys are dotted paths (`providers.claude.binaryPath`) resolved against
 * the config object; `readSetting` / `writeSetting` below are the only
 * things that walk them.
 */
import { readListScalar, resolveListKey, type ListDescriptor, type ListTarget } from "./configlist.js";
import { CliError } from "./errors.js";
import { webOrderEntries, webOrderUnavailable, type WebOrderEntry, type WebRole } from "./webservers.js";
import { CODEX_NATIVE_TOOLS, CLAUDE_NATIVE_TOOLS, OPENCODE_NATIVE_TOOLS, type NativeTool } from "./nativetools.js";
import { formatHandoffModels, formatModeModels } from "./handoffmodels.js";
import { numberLabel } from "./configformat.js";
import {
  COMPACTION_MODES,
  DEFAULT_COMPACT_LINE,
  LINE_PERCENT_MAX,
  LINE_PERCENT_MIN,
  compactionModeFor,
  compactLineFor,
  handoffLineFor,
  handoffModeFor,
  lineLabel,
  lineText,
  parseLine,
  type CompactionMode,
  type LongThreadKind,
} from "./threads/longthreads.js";
import { isSecretRef } from "./secrets.js";
import { MCP_RUNNER_SETTING, MCP_SERVERS_SETTING } from "./mcpschema.js";
import { describeMcpServers } from "./mcpview.js";
import { HARNESS_PROFILES_SETTING } from "./providers/harness/profileschema.js";
import { describeHarnessProfiles } from "./providers/harness/profileview.js";
import { moxenToolsOf } from "./mcp.js";
import { driverKindOfInstance, type CliConfig } from "./types.js";

/** The TCP port remote access listens on unless `remote.port` says otherwise. */
export const DEFAULT_REMOTE_PORT = 47_317;

/** Where a setting shows up. Order is the order a settings page renders. */
export const SETTING_SECTIONS = [
  "general",
  "defaults",
  "sessions",
  "long-threads",
  "agent",
  "interface",
  "git",
  "provider:claude",
  "provider:opencode",
  "provider:codex",
  "provider:harness",
  "mcp",
] as const;

export type SettingSection = (typeof SETTING_SECTIONS)[number];

export const SECTION_LABEL: Record<SettingSection, string> = {
  general: "General",
  defaults: "Defaults",
  sessions: "Sessions",
  "long-threads": "Long threads",
  agent: "Agent context",
  interface: "Interface",
  git: "Git and forges",
  "provider:codex": "Codex",
  "provider:claude": "Claude Code",
  "provider:opencode": "OpenCode",
  "provider:harness": "Moxen Harness",
  mcp: "MCP servers",
};

/** What the two ends of a slider over a setting's presets mean ("Faster" / "Smarter"). */
export interface SettingEnds {
  readonly low: string;
  readonly high: string;
}

export interface SettingChoice {
  readonly value: string;
  readonly label: string;
  /** One line on what picking this does; shown beside the choice. */
  readonly description?: string;
  /** Still accepted by `config set` and read from old files, but a page does not offer it. */
  readonly hidden?: boolean;
}

export type SettingKind =
  | { readonly type: "enum"; readonly choices: readonly SettingChoice[] }
  | { readonly type: "boolean" }
  /** A key or token: typed into a masked input, kept in the OS keychain, and in the config only as a `keychain:` reference. */
  | { readonly type: "secret" }
  | {
      readonly type: "string";
      readonly placeholder?: string;
      readonly multiline?: boolean;
      /**
       * The value names something in the provider catalog (a provider
       * instance, a model slug, an effort level). A client offers what the
       * catalog lists rather than a text box; the file still holds the id.
       */
      readonly source?: "provider" | "model" | "effort" | "mcp-server" | "model-overrides" | "native-tools" | "web-order";
      /** With `source` web-order: which tools the order ranks. */
      readonly web?: WebRole;
      /** With `source` native-tools: the provider's own tools this setting can switch off (`core/nativetools.ts`). */
      readonly tools?: readonly NativeTool[];
      /** With `source` model or effort: offer only this provider's models (the setting belongs to its page). */
      readonly providerKind?: "claude" | "codex" | "opencode" | "harness";
    }
  /**
   * `unit` is appended when the value is shown ("20" -> "20s"). `presets`
   * are the values a client offers to pick from (any in range is accepted).
   * `binary` counts in powers of two and shows 131072 as "128K" (token windows).
   */
  | { readonly type: "integer"; readonly min: number; readonly max: number; readonly unit?: string; readonly presets?: readonly number[]; readonly binary?: boolean; readonly ends?: SettingEnds }
  /** A duration string the session layer parses (`"2m"`, `"45s"`); `presets` as for integers. */
  | { readonly type: "duration"; readonly presets?: readonly string[]; readonly ends?: SettingEnds }
  /**
   * Where a long thread is handed off or compacted: a share of the window
   * (`70%`) or a size (`32K`, or a token count), kept as that text
   * (`core/threads/longthreads.ts` `parseLine`). `presets` as for durations.
   */
  | { readonly type: "line"; readonly presets?: readonly string[] }
  | ListKind;

/**
 * A field of one list item, addressed relative to the item (`baseUrl`,
 * `sampling.topK`). The kinds are the plain ones: ranges and combinations are
 * checked by whatever owns the list, so they are stated once. A boolean is
 * always three-way (unset, on, off) because an unset field falls back to
 * something and the editor has to be able to say "go back to that".
 */
export interface ListField {
  readonly path: string;
  readonly label: string;
  readonly description: string;
  /** The heading a client files the field under. */
  readonly group: string;
  /** Kept settable for old files, but an editor does not offer it. */
  readonly hidden?: boolean;
  /** Said once under the group's heading; carried by any one field of the group. */
  readonly groupDescription?: string;
  /**
   * What applies while the field is unset, when the item view has nothing better to say: a value
   * the field could hold, or a few words ("the server's"). A page shows it as the field's Default.
   */
  readonly unset?: { readonly value: SettingValue } | { readonly text: string };
  readonly kind: ListFieldKind;
  /**
   * An editor shows this field only while the field at `path` (relative to the
   * same item) holds one of `in`; `""` stands for unset, so a switch that is on
   * unless told otherwise lists both `""` and `"true"`. The CLI lists it always.
   */
  readonly visibleWhen?: { readonly path: string; readonly in: readonly string[] };
}

export type ListFieldKind =
  | { readonly type: "string"; readonly placeholder?: string; readonly multiline?: boolean }
  | { readonly type: "integer"; readonly unit?: string; readonly presets?: readonly number[]; readonly ends?: SettingEnds }
  | { readonly type: "number"; readonly presets?: readonly number[]; readonly ends?: SettingEnds }
  | { readonly type: "boolean" }
  | { readonly type: "secret" }
  | { readonly type: "enum"; readonly choices: readonly SettingChoice[] }
  /** A list of words kept as an array: `separator` is how they are typed (`shell` honours quotes). */
  | { readonly type: "words"; readonly separator: "comma" | "shell" }
  /** `KEY=value` pairs kept as an object. `secret`: values are never shown, and typing `KEY=<hidden>` keeps the stored one. */
  | { readonly type: "pairs"; readonly secret?: boolean }
  /** A list inside the item (a profile's models), addressed `path[<id>]`. */
  | { readonly type: "list"; readonly noun: string; readonly fields: readonly ListField[] }
  /** A reasoning effort, picked from the ones the item's models list (`models[].efforts`); the item view offers them as `choices`. */
  | { readonly type: "effort" };

/**
 * A structured list kept in the config as an array of objects that each carry
 * an `id`. Edited through `config set 'key[<id>]…'` (see `configlist.ts`);
 * `actions` are what a client may offer besides add, edit and remove.
 */
export interface ListKind {
  readonly type: "list";
  /** "profile": used in messages and button labels. */
  readonly noun: string;
  /** Ids are folded to lower case (profile ids are; model ids are not). */
  readonly lowercaseIds?: boolean;
  /** Kept in the config as an object keyed by id (MCP servers, as in `.mcp.json`) rather than an array of objects carrying one. */
  readonly keyed?: boolean;
  /** How a client walks a user through adding one. */
  readonly add: "harness-profile" | "mcp-server";
  readonly fields: readonly ListField[];
  readonly actions: readonly ("duplicate" | "test" | "probe" | "transfer")[];
}

/** One list entry as a client draws it: values, where they come from, and plain-language state. */
export interface ListItemView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** A problem or note worth showing beside the entry ("COLAB_KEY is not set"), or null. */
  readonly status: string | null;
  readonly fields: readonly ListFieldView[];
  /** Read-only rows: what is in force and why, or what a probe found. */
  readonly resolved: readonly ListResolvedRow[];
}

export interface ListFieldView {
  readonly path: string;
  readonly value: SettingValue;
  /** The file holds a value for it. */
  readonly explicit: boolean;
  /** What applies when it is unset, or on top of it, and where that comes from. */
  readonly effective?: ListEffective;
  /** The entries of a nested list. */
  readonly items?: readonly ListItemView[];
  /** What this item lets the field hold, for a field whose choices depend on the item (an effort). */
  readonly choices?: readonly SettingChoice[];
}

export interface ListEffective {
  readonly value: SettingValue;
  /** Short and plain: "this profile", "Compact at (above)", "the server's probe", "the model's name". */
  readonly origin: string;
}

export interface ListResolvedRow {
  readonly label: string;
  readonly value: string;
  readonly origin: string;
}

export type SettingValue = string | boolean | number | undefined;

export interface SettingDescriptor {
  /** Dotted path into the config object, and the id `config set` takes. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly section: SettingSection;
  /** Kept settable for existing configs and scripts, but a settings page does not offer it. */
  readonly hidden?: boolean;
  /** A heading the page files this setting under, within its section; consecutive settings with the same one share it. */
  readonly group?: string;
  readonly kind: SettingKind;
  /** The value in force when the key is absent. `undefined` means "unset". */
  readonly defaultValue: SettingValue;
  /** A page shows this setting only while `key` holds one of `in` (its default counts). The CLI lists it always. */
  readonly visibleWhen?: { readonly key: string; readonly in: readonly string[] };
  /** When a change takes effect, if not at once. Said here rather than in each description, so it is said one way. */
  readonly appliesAt?: SettingAppliesAt;
  /** What applies while the key is unset, for a setting with no default of its own. */
  readonly fallback?: SettingFallback;
  /** `MOXEN_<name>` overrides this key; shown so an ignored edit is explicable. */
  readonly envOverride?: string;
}

/**
 * When a change to a setting takes effect:
 * - `now`: the next read, which is the next turn or the next screen;
 * - `next-session`: a provider session reads it when it starts, so a thread already warm keeps what it had;
 * - `provider-restart`: OpenCode reads it when its server starts; Moxen restarts that server once it is idle;
 * - `server-restart`: the provider's driver reads it once, when Moxen's server starts.
 */
export type SettingAppliesAt = "now" | "next-session" | "provider-restart" | "server-restart";

/** How a client says when a change applies: a short tag beside the value, and the sentence behind it. */
export const APPLIES_AT_TEXT: Readonly<Record<Exclude<SettingAppliesAt, "now">, { readonly tag: string; readonly sentence: string }>> = {
  "next-session": { tag: "next session", sentence: "A change reaches sessions started after it; a thread already running keeps what it had." },
  "provider-restart": { tag: "restarts OpenCode", sentence: "OpenCode reads this when its server starts, so Moxen restarts the server once nothing is running on it." },
  "server-restart": { tag: "next server start", sentence: "Read when Moxen's server starts: restart it (`moxen server stop`, then start) for a change to apply." },
};

/** Whether a change waits for Moxen's server to restart: what `--json config list` has always called `restartRequired`. */
export function restartRequired(descriptor: SettingDescriptor): boolean {
  return descriptor.appliesAt === "server-restart";
}

/**
 * What applies while a key with no default of its own is unset:
 * - `key`: another setting (a provider's Permissions falls back to the global one), followed down its own fallback;
 * - `value` with `text`: a value this setting would hold, decided elsewhere (`text` says where: "OpenCode's own config");
 * - `text` alone: what happens, when it is not a value of this setting ("70% of the window");
 * - `resolver`: a rule in core over several keys (hand-off sizes).
 */
export type SettingFallback =
  | { readonly key: string }
  | { readonly value: SettingValue; readonly text: string }
  | { readonly text: string }
  | { readonly resolver: FallbackResolver };

export type FallbackResolver = "handoffMode" | "handoffLine" | "compactionMode" | "compactLine" | "providerModel" | "webBrowser" | "privateNetwork" | "moxenTools";

/** What is in force for an unset setting, worked out in core so a client only draws it. */
export interface SettingEffective {
  /** The value it amounts to, when it is one this setting could hold; undefined when it is not ("70% of the window"). */
  readonly value: SettingValue;
  /** The value as a page writes it: "Full access", "On", "50% of the window". */
  readonly label: string;
  /** Where it comes from, to follow the label after a comma: "from Permissions on the Defaults tab". Absent when the label says it all. */
  readonly origin?: string;
}

const choice = (value: string, label: string, description?: string): SettingChoice =>
  description === undefined ? { value, label } : { value, label, description };

/** Idle lifetimes a page offers. */
const DURATION_PRESETS = ["2m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "8h", "24h"] as const;

/** Where a line can be put: shares of the window (they follow any model), then sizes from a small local model up. */
const LINE_PRESETS = ["40%", "50%", "60%", "70%", "80%", "90%", "8K", "16K", "24K", "32K", "64K", "128K", "256K", "512K", "1M"] as const;

const COMPACTION_TEXT: Readonly<Record<LongThreadKind, { readonly own: string; readonly description: string }>> = {
  codex: { own: "Codex", description: "Who compacts a thread as it fills. Codex compacts near its model limit; Moxen can compact at the chosen line, asking first or automatically. Off disables automatic compaction." },
  claude: {
    own: "Claude Code",
    description:
      "Who compacts a thread as it fills. Claude Code: it decides, and a size under 'Compact at' becomes its auto-compact window (100K to 1M). Moxen: Claude Code's own is switched off and Moxen compacts past 'Compact at', open or not; asking offers a card, but a delegated task, or a thread halfway from the line to full, is compacted unasked. Off: nobody compacts.",
  },
  opencode: {
    own: "OpenCode",
    description:
      "Who compacts a thread as it fills. OpenCode: the OpenCode servers Moxen starts do it near the model's limit, as their config says. Moxen: their own is switched off and Moxen compacts past 'Compact at', open or not; asking offers a card, but a delegated task, or a thread halfway from the line to full, is compacted unasked. Off: nobody compacts.",
  },
  harness: {
    own: "Automatic",
    description:
      "Who compacts a thread as it fills. Automatic: past 'Compact at', between turns and in the middle of a long one, and when the server refuses a prompt as too long. Asking offers a card at the line instead, but a delegated task, or a thread halfway from the line to full, is compacted unasked. Off leaves /compact and the rescue for a refused prompt.",
  },
};

const COMPACTION_CHOICE_LABEL: Readonly<Record<Exclude<CompactionMode, "provider">, string>> = { ask: "Moxen asks", auto: "Moxen does it", off: "Off" };

/** The sentence every Long threads group ends on, so the two lines are never read apart. */
const LINES_INTERACT = "Handing off is offered first when its line is lower than compaction's; past both, the lower one acts first.";

const PROVIDER_NAME: Readonly<Record<"claude" | "codex" | "opencode" | "harness", string>> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode", harness: "Moxen Harness" };

/**
 * One Tools group per provider, from one template so the three tabs cannot drift: Moxen's own tools
 * and skills, MCP reach, the to-do list, and (Claude Code, OpenCode) the web orders and the
 * provider's own tools to switch off.
 */
function toolSettings(kind: "claude" | "codex" | "opencode" | "harness"): SettingDescriptor[] {
  const name = PROVIDER_NAME[kind];
  const section = `provider:${kind}` as const;
  const base = { section, group: "Tools", appliesAt: "next-session" } as const;
  const settings: SettingDescriptor[] = [
    {
      ...base,
      key: `providers.${kind}.orchestration`,
      label: "Delegation tools",
      description: `Give ${name} threads Moxen's tools for coordinating threads: delegate a task to another thread, follow it, list the models it could run on, cancel it. Moxen's web_fetch is switched on its own.`,
      kind: { type: "boolean" },
      defaultValue: undefined,
      fallback: { resolver: "moxenTools" },
    },
    moxenSkillsSetting(kind),
    {
      ...base,
      key: `providers.${kind}.webFetch`,
      label: "Moxen's web_fetch",
      description: `Give ${name} threads Moxen's web_fetch: it reads a page as text, and loads it in a browser when a plain request cannot. It follows the global Web tools settings.`,
      kind: { type: "boolean" },
      defaultValue: undefined,
      fallback: { resolver: "moxenTools" },
    },
    {
      ...base,
      key: `providers.${kind}.moxenTools`,
      label: "Moxen's tools",
      description: "Kept so older configs still load: Moxen's tools all at once. Off turns off both 'Delegation tools' and 'Moxen's web_fetch' while those are unset.",
      hidden: true,
      kind: { type: "boolean" },
      defaultValue: true,
    },
    {
      ...base,
      key: `providers.${kind}.mcpExclude`,
      label: "MCP servers",
      description: `Which of your MCP servers ${name} threads get: switch off the ones this provider should not see. A server switched off on its own entry stays out either way.`,
      kind: { type: "string", placeholder: "none switched off", source: "mcp-server" },
      defaultValue: undefined,
    },
    {
      ...base,
      key: `providers.${kind}.todos`,
      label: "To-do list",
      description: `Let ${name} models keep a to-do list (the Tasks panel).`,
      kind: { type: "boolean" },
      defaultValue: true,
    },
  ];
  if (kind === "harness") return settings;
  const advice = "It is advice in the prompt: no tool is switched off, and the model may still pick another.";
  return [
    ...settings,
    {
      ...base,
      key: `providers.${kind}.webSearchOrder`,
      label: "Search order",
      description: `The order ${name} threads should try web search tools in, when there is more than one; the model moves to the next only if one fails or finds nothing useful. ${advice}`,
      kind: { type: "string", placeholder: "no preference", source: "web-order", web: "search" },
      defaultValue: undefined,
    },
    {
      ...base,
      key: `providers.${kind}.webFetchOrder`,
      label: "Page reading order",
      description: `The order ${name} threads should try tools that read a page in, when there is more than one; the model moves to the next only if one fails or finds nothing useful. ${advice}`,
      kind: { type: "string", placeholder: "no preference", source: "web-order", web: "fetch" },
      defaultValue: undefined,
    },
    {
      ...base,
      key: `providers.${kind}.disabledNativeTools`,
      label: "Built-in tools off",
      description: kind === "codex" ? "Codex tools and tool families to switch off. Supported switches remove tools from the model; an always-on entry explains the native restriction." : `${name}'s own tools to switch off: each is taken out of the model's list.`,
      ...(kind === "opencode" ? { appliesAt: "provider-restart" as const } : {}),
      kind: { type: "string", placeholder: "none switched off", source: "native-tools", tools: kind === "codex" ? CODEX_NATIVE_TOOLS : kind === "claude" ? CLAUDE_NATIVE_TOOLS : OPENCODE_NATIVE_TOOLS },
      defaultValue: undefined,
    },
  ];
}

/** A provider's switch for the skills Moxen used to ship (MXN-138): kept so older configs still load, and does nothing. */
function moxenSkillsSetting(kind: "claude" | "codex" | "opencode" | "harness"): SettingDescriptor {
  return {
    key: `providers.${kind}.moxenSkills`,
    label: "Moxen's skills",
    description: "Kept so older configs still load. Moxen ships no skills now, so it does nothing.",
    section: `provider:${kind}`,
    group: "Tools",
    hidden: true,
    kind: { type: "boolean" },
    defaultValue: undefined,
    appliesAt: "next-session",
  };
}

/**
 * One Sessions group per provider, the global Sessions settings narrowed to it: instructions that only this
 * provider's threads get, and whether a usage limit is waited out. Unset, each follows the global one.
 */
function sessionSettings(kind: "claude" | "codex" | "opencode" | "harness"): SettingDescriptor[] {
  const name = PROVIDER_NAME[kind];
  const section = `provider:${kind}` as const;
  return [
    {
      key: `providers.${kind}.instructions`,
      label: "Provider instructions",
      description: `Added to the system prompt of ${name} threads only, after the global 'Extra instructions' and before a project's moxen.json instructions${kind === "harness" ? ", then a profile's own Profile instructions" : ""}. For guidance one model family needs and the others do not.`,
      section,
      group: "Sessions",
      kind: { type: "string", placeholder: `Appended to ${name} sessions`, multiline: true },
      defaultValue: undefined,
      appliesAt: "next-session",
    },
    {
      key: `providers.${kind}.sessionTtl`,
      label: "Idle session lifetime",
      description: `How long ${kind === "claude" ? "a" : kind === "opencode" ? "an" : "a"} ${name} session stays warm with nothing happening on it, before it is ended (the next message resumes it). ${{ codex: "Each is a Codex app-server process.", claude: "Each is a Claude Code process.", opencode: "Sessions share one OpenCode server per folder.", harness: "A local server re-reads the whole prompt when a session comes back." }[kind]}`,
      section,
      group: "Sessions",
      kind: { type: "duration", presets: DURATION_PRESETS, ends: { low: "Shorter", high: "Longer" } },
      defaultValue: undefined,
      fallback: { key: "sessionTtl" },
      appliesAt: "next-session",
    },
    {
      key: `providers.${kind}.autoContinueAtUsageLimit`,
      label: "Continue after a usage limit",
      description: `When a plan limit stops ${kind === "opencode" ? "an" : "a"} ${name} turn, schedule a continue for just after it resets. Limits are per account, so this can be on for a subscription and off for a metered key.`,
      section,
      group: "Sessions",
      kind: { type: "boolean" },
      defaultValue: undefined,
      fallback: { key: "autoContinueAtUsageLimit" },
    },
  ];
}

/**
 * One Long threads group per provider, the same rows on every tab: who
 * compacts and where, then whether and where to hand off. Each line is a share
 * or a size and falls back, whatever its unit, to the global setting (`core/threads/longthreads.ts`).
 */
function longThreadSettings(kind: LongThreadKind): SettingDescriptor[] {
  const section = `provider:${kind}` as const;
  const group = "Long threads";
  const modes = COMPACTION_MODES[kind];
  const compactionKey = `providers.${kind}.compaction`;
  return [
    {
      key: compactionKey,
      label: "Compaction",
      description: COMPACTION_TEXT[kind].description,
      section,
      group,
      kind: {
        type: "enum",
        choices: modes.map((mode) =>
          kind === "harness" ? choice(mode, mode === "auto" ? "Automatic" : mode === "ask" ? "Moxen asks" : "Off") : choice(mode, mode === "provider" ? COMPACTION_TEXT[kind].own : COMPACTION_CHOICE_LABEL[mode]),
        ),
      },
      defaultValue: undefined,
      fallback: { resolver: "compactionMode" },
      ...(kind === "harness" ? {} : { appliesAt: "server-restart" as const }),
    },
    {
      key: `providers.${kind}.compactAt`,
      label: "Compact at",
      description: `Where a thread here is compacted: a share of the model's window or a size, whichever suits its models. A model below can have its own. ${kind === "harness" ? "At least 16K tokens are always left free, and a share needs the model's contextWindow in its profile. " : ""}${LINES_INTERACT}`,
      section,
      group,
      kind: { type: "line", presets: LINE_PRESETS },
      defaultValue: undefined,
      fallback: { resolver: "compactLine" },
      visibleWhen: { key: compactionKey, in: kind === "claude" ? ["", "provider", "ask", "auto"] : kind === "opencode" ? ["", "ask", "auto"] : ["", "ask", "auto"] },
    },
    ...(kind === "harness"
      ? [
          {
            key: "providers.harness.keepRecentTokens",
            label: "Kept word for word",
            description: "How much of the newest conversation stays as it was when older history is summarised, in tokens.",
            section,
            group,
            kind: { type: "integer", min: 2_000, max: 100_000, presets: [4_096, 8_192, 12_288, 16_384, 24_576, 32_768, 49_152, 65_536] },
            defaultValue: 16_384,
            visibleWhen: { key: compactionKey, in: ["", "ask", "auto"] },
          } satisfies SettingDescriptor,
        ]
      : []),
    {
      key: `providers.${kind}.handoff`,
      label: "Hand off",
      description: "What to do when a thread here passes 'Hand off at': ask with a card, hand off by itself, or never.",
      section,
      group,
      kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("off", "Off")] },
      defaultValue: undefined,
      fallback: { resolver: "handoffMode" },
    },
    {
      key: `providers.${kind}.handoffAt`,
      label: "Hand off at",
      description: `Where a thread here is handed off: a share of the model's window or a size. A model below can have its own. ${LINES_INTERACT}`,
      section,
      group,
      kind: { type: "line", presets: LINE_PRESETS },
      defaultValue: undefined,
      fallback: { resolver: "handoffLine" },
      visibleWhen: { key: `providers.${kind}.handoff`, in: ["", "ask", "auto"] },
    },
    {
      key: `providers.${kind}.autoHandoffModels`,
      label: "Per model",
      description: `Particular models of this provider that hand off or compact differently: each can have its own Hand off, Hand off at, Compaction and Compact at; what it leaves alone follows the rows above.${kind === "opencode" ? " OpenCode's own compaction is one switch for its whole server, so a model chooses its Compaction only while that is not OpenCode's." : kind === "harness" ? " A profile's own compaction still wins for its models." : ""} In the config file and \`moxen config set\`, sizes are model=tokens pairs here and in compactAtModels, choices model=choice pairs in handoffModels and compactionModels.`,
      section,
      group,
      kind: { type: "string", placeholder: "model=500k", multiline: true, source: "model-overrides", providerKind: kind },
      defaultValue: undefined,
    },
    ...perModelSettings(kind),
    ...legacyHandoffSettings(kind),
  ];
}

/** The per-model maps the "Per model" row edits beside its own (`autoHandoffModels`): set from its editor or `config set`, not shown as rows. */
function perModelSettings(kind: LongThreadKind): SettingDescriptor[] {
  const base = { section: `provider:${kind}` as const, group: "Long threads", hidden: true, defaultValue: undefined } as const;
  return [
    { ...base, key: `providers.${kind}.compactAtModels`, label: "Compact at, per model", description: "Token counts at which particular models of this provider are compacted, as model=tokens pairs (claude-opus-5=400k). Wins over 'Compact at' for those models.", kind: { type: "string", placeholder: "model=400k", multiline: true } },
    { ...base, key: `providers.${kind}.handoffModels`, label: "Hand off, per model", description: "Whether particular models of this provider are handed off, as model=choice pairs (claude-opus-5=off): ask, auto or off. Wins over 'Hand off' for those models.", kind: { type: "string", placeholder: "model=off", multiline: true } },
    { ...base, key: `providers.${kind}.compactionModels`, label: "Compaction, per model", description: `Who compacts particular models of this provider, as model=choice pairs (claude-opus-5=auto): ${COMPACTION_MODES[kind].join(", ")}. Wins over 'Compaction' for those models.`, kind: { type: "string", placeholder: "model=auto", multiline: true } },
  ];
}

/** The older per-provider hand-off keys: still read where the new ones are unset (`handoffModeFor`, `handoffLineFor`), and `config set` on them writes the new key too. */
function legacyHandoffSettings(kind: LongThreadKind): SettingDescriptor[] {
  const section = `provider:${kind}` as const;
  const legacy = { section, group: "Long threads", hidden: true, defaultValue: undefined } as const;
  return [
    { ...legacy, key: `providers.${kind}.autoHandoff`, label: "Hand off long threads", description: "Kept so older configs still load: 'Hand off' before it took its place.", kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("off", "Off")] } },
    { ...legacy, key: `providers.${kind}.autoHandoffPercent`, label: "Hand off at (share)", description: "Kept so older configs still load: 'Hand off at' as a share of the window.", kind: { type: "integer", min: 10, max: 90, unit: "%", presets: [20, 30, 40, 50, 60, 70, 80] } },
    { ...legacy, key: `providers.${kind}.autoHandoffTokens`, label: "Hand off at a fixed size", description: "Kept so older configs still load: 'Hand off at' as a size; it beat the share beside it.", kind: { type: "integer", min: 8_192, max: 2_000_000, binary: true } },
  ];
}

const SETTINGS_IN_WRITTEN_ORDER: readonly SettingDescriptor[] = [
  // -- general ---------------------------------------------------------------
  {
    key: "projectPolicy",
    label: "Unknown folders",
    description: "What happens when a prompt names a folder that is not a project yet.",
    section: "general",
    kind: {
      type: "enum",
      choices: [
        choice("create", "Create the project", "Register the folder and carry on."),
        choice("existing", "Require an existing project", "Refuse rather than register anything."),
      ],
    },
    defaultValue: "create",
    envOverride: "MOXEN_PROJECT_POLICY",
  },
  {
    key: "workspaceMode",
    label: "Workspace root",
    description: "Whether a project's root is the enclosing git repository or the folder itself.",
    section: "general",
    kind: {
      type: "enum",
      choices: [
        choice("repo", "Repository root", "Walk up to the git root."),
        choice("folder", "The folder itself", "Take the path as given."),
      ],
    },
    defaultValue: "repo",
    envOverride: "MOXEN_WORKSPACE_MODE",
  },
  {
    key: "openMode",
    label: "Open links in",
    description: "Kept so older scripts and configs still load. Moxen has no desktop app to deep-link into, so nothing is opened whatever this says; threads are used through the TUI.",
    section: "general",
    hidden: true,
    kind: {
      type: "enum",
      choices: [
        choice("auto", "Whatever is available"),
        choice("desktop", "The desktop app"),
        choice("browser", "A browser"),
        choice("none", "Nowhere", "Print the link instead of opening it."),
      ],
    },
    defaultValue: "auto",
    envOverride: "MOXEN_OPEN_MODE",
  },
  {
    key: "threadEnvMode",
    label: "Thread environment",
    description: "The last-resort answer for threads started from the command line (`moxen handover`, `moxen threads create`) when neither the command, the project, nor its moxen.json says whether to use a worktree. A model delegating work chooses for itself each time (a worktree unless it asks for the shared checkout), so this does not govern delegation.",
    section: "defaults",
    kind: {
      type: "enum",
      choices: [
        // Kept so old files and scripts still load; it always meant the project checkout, and reads as that.
        { ...choice("auto", "Automatic", "The project checkout."), hidden: true },
        choice("local", "The project checkout", "Work directly in the project's folder."),
        choice("worktree", "Always a worktree", "Give each thread its own checkout on a new branch, so threads cannot step on each other."),
      ],
    },
    defaultValue: "local",
    envOverride: "MOXEN_THREAD_ENV_MODE",
  },

  // -- turns -----------------------------------------------------------------
  {
    key: "runtimeMode",
    label: "Permissions",
    description: "How much a new thread may do without asking. A provider's own 'Permissions' wins over this. Each provider maps the mode onto its own native one.",
    section: "defaults",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "The provider judges each call (Moxen Harness: its command classifier)."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: "full-access",
    envOverride: "MOXEN_RUNTIME_MODE",
  },
  {
    key: "interactionMode",
    label: "Start in",
    description: "The mode new threads start in. Research and Orchestrate delegate work to other threads, so a settings page offers neither as a default; a config that still says plan (removed) reads as Build.",
    section: "defaults",
    hidden: true,
    kind: {
      type: "enum",
      choices: [
        choice("default", "Build"),
        choice("research", "Research", "Runs requests as research: researcher agents, a critic and a final report."),
        choice("orchestrate", "Orchestrate", "Breaks requests into tasks delegated to the model that fits each."),
      ],
    },
    defaultValue: "default",
    envOverride: "MOXEN_INTERACTION_MODE",
  },
  {
    key: "sessionTtl",
    label: "Idle session lifetime",
    description: "How long a provider session stays warm with nothing happening on it: no turn, no background task, nothing waiting on you. Past it the session is ended, and the next message resumes it, at the cost of a restart and reading the prompt cache afresh. Each provider can set its own.",
    section: "sessions",
    kind: { type: "duration", presets: DURATION_PRESETS, ends: { low: "Shorter", high: "Longer" } },
    defaultValue: "1h",
    appliesAt: "next-session",
  },
  {
    key: "autoContinueAtUsageLimit",
    label: "Continue after a usage limit",
    description:
      "When a plan limit stops a turn, schedule a continue for just after it resets, at most 'Continues in a row' times. It runs work while nobody is watching. Each provider can say otherwise for itself.",
    section: "sessions",
    kind: { type: "boolean" },
    defaultValue: false,
  },
  {
    key: "usageLimitContinues",
    label: "Continues in a row",
    description: "How many automatic continues may follow one another when each runs into the limit again; past it, a notice says it stopped and waits for you.",
    section: "sessions",
    kind: { type: "integer", min: 1, max: 5, presets: [1, 2, 3, 4, 5], ends: { low: "Fewer", high: "More" } },
    defaultValue: 2,
    visibleWhen: { key: "autoContinueAtUsageLimit", in: ["true"] },
  },
  {
    key: "branchPruneDays",
    label: "Delete finished worktree branches after",
    description:
      "Days after a thread is archived or deleted before its `moxen/…` branch is deleted, here and on origin if it was pushed. Only a branch already merged into the project's branch goes, so no work is lost; a branch with commits that were never merged is kept. 0 keeps every branch.",
    section: "git",
    kind: { type: "integer", min: 0, max: 365, unit: "d", presets: [0, 1, 3, 7, 14, 30, 60, 90, 180], ends: { low: "Sooner", high: "Later" } },
    defaultValue: 14,
  },
  {
    key: "skills.moxen",
    label: "Moxen's skills",
    description: "Kept so older configs still load. Moxen ships no skills now, so it does nothing; copies it made in a project are taken out.",
    section: "agent",
    hidden: true,
    kind: {
      type: "enum",
      choices: [
        choice("copy", "Copy into the project", "Into its .claude or .agents folder; served when it has neither."),
        choice("serve", "Serve from Moxen", "Nothing written into the project."),
        choice("off", "Off", "No thread gets them, unless a provider's own switch turns them on."),
      ],
    },
    defaultValue: undefined,
    appliesAt: "next-session",
  },
  {
    key: "installSkills",
    label: "Install Moxen's skills in projects",
    description: "Kept so older configs still load. Moxen ships no skills now, so it does nothing.",
    section: "agent",
    hidden: true,
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "next-session",
  },
  {
    key: "instructions",
    label: "Extra instructions",
    description: "Appended to every provider session's system prompt. Each provider's 'Provider instructions' come after these, and a project's moxen.json after that.",
    section: "agent",
    kind: { type: "string", placeholder: "Appended to every session", multiline: true },
    defaultValue: undefined,
    appliesAt: "next-session",
  },
  {
    key: "memory",
    label: "Memory",
    description:
      "Lets agents keep what they learn across sessions (your preferences, corrections, project decisions) in Moxen's memory, for every provider. Turning it on also turns Claude Code's own auto memory off in Moxen's sessions. A project's moxen.json can turn it off for itself (`\"memory\": false`).",
    section: "agent",
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "next-session",
  },

  // -- model -----------------------------------------------------------------
  {
    key: "provider",
    label: "Provider",
    description: "The provider a new thread uses when neither the request nor the project names one. A project's own default wins over this.",
    section: "defaults",
    kind: { type: "string", placeholder: "claude", source: "provider" },
    defaultValue: undefined,
    fallback: { text: "The first available: Claude Code when it is installed" },
    envOverride: "MOXEN_PROVIDER",
  },
  {
    key: "model",
    label: "Model",
    description: "The model a new thread on the Provider above starts with. A model belongs to one provider, so this applies only to threads on that provider, and a provider's own 'Model' wins over it.",
    section: "defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "model" },
    defaultValue: undefined,
    envOverride: "MOXEN_MODEL",
  },
  {
    key: "speedMode",
    label: "Speed",
    description: "Kept so older configs still load. No provider Moxen drives reads it today, so a settings page does not offer it.",
    section: "defaults",
    hidden: true,
    kind: { type: "enum", choices: [choice("standard", "Standard"), choice("fast", "Fast")] },
    defaultValue: undefined,
    fallback: { text: "The provider's own" },
    envOverride: "MOXEN_SPEED_MODE",
  },
  {
    key: "thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new thread starts at, for models that take one. A provider's own 'Effort' wins over this.",
    section: "defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort" },
    defaultValue: undefined,
    envOverride: "MOXEN_THINKING_EFFORT",
  },

  // -- interface -------------------------------------------------------------
  {
    key: "ui.backdrop",
    label: "Backdrop",
    description: "The animated field behind the thread list and the new-thread view. Turn it off on a slow terminal or over SSH.",
    section: "interface",
    kind: {
      type: "enum",
      choices: [
        choice("animated", "Animated"),
        choice("static", "Static", "Drawn once, never redrawn."),
        choice("off", "Off"),
      ],
    },
    defaultValue: "animated",
  },
  {
    key: "ui.theme",
    label: "Theme",
    description: "The colours of the interface. Catppuccin, Dracula, Nord, Gruvbox and Tokyo Night follow their published palettes; Moxen is the default.",
    section: "interface",
    kind: {
      type: "enum",
      choices: [
        choice("moxen", "Moxen"),
        choice("catppuccin-latte", "Catppuccin Latte", "A light theme."),
        choice("catppuccin-frappe", "Catppuccin Frappé"),
        choice("catppuccin-macchiato", "Catppuccin Macchiato"),
        choice("catppuccin-mocha", "Catppuccin Mocha"),
        choice("dracula", "Dracula"),
        choice("nord", "Nord"),
        choice("gruvbox", "Gruvbox"),
        choice("tokyo-night", "Tokyo Night"),
      ],
    },
    defaultValue: "moxen",
  },
  {
    key: "ui.language",
    label: "Language",
    description: "The language of the interface. Auto follows the terminal's locale (LC_ALL, LC_MESSAGES, LANG) and falls back to English. Only the TUI is translated; CLI output and --json stay in English.",
    section: "interface",
    kind: {
      type: "enum",
      choices: [choice("auto", "Auto"), choice("en", "English"), choice("es-ES", "Español (España)")],
    },
    defaultValue: "auto",
  },
  {
    key: "ui.modelScenes",
    label: "Model backdrops",
    description:
      "Give each model its own scene behind the new-thread view, easing between them as you switch the model there. Off, every model keeps the monitoring field. Follows the Backdrop setting: static draws it once, off hides it.",
    section: "interface",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "ui.hideBinaryDiffs",
    label: "Hide binary files in diffs",
    description: "Leave images, archives and other binary files out of the Diff panel, which can only say that they changed. Ignored files are never in a diff.",
    section: "interface",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "ui.defaultSidePanel",
    label: "Side panel on open",
    description: "Which view the side panel shows the first time it is opened in a session.",
    section: "interface",
    kind: {
      type: "enum",
      choices: [
        choice("context", "Context"),
        choice("git", "Git"),
        choice("agents", "Agents"),
        choice("background", "Background"),
      ],
    },
    defaultValue: "context",
  },
  {
    key: "ui.contextRefreshSeconds",
    label: "Context refresh",
    description: "How often an open Context panel re-reads the live breakdown.",
    section: "interface",
    kind: { type: "integer", min: 1, max: 600, unit: "s", presets: [1, 2, 3, 5, 10, 15, 30, 60, 120], ends: { low: "More often", high: "Less often" } },
    defaultValue: 5,
  },
  {
    key: "ui.usageRefreshSeconds",
    label: "Usage refresh",
    description: "How often plan usage windows are re-read.",
    section: "interface",
    kind: { type: "integer", min: 5, max: 3600, unit: "s", presets: [5, 10, 20, 30, 60, 120, 300, 600, 900], ends: { low: "More often", high: "Less often" } },
    defaultValue: 20,
  },
  {
    key: "longThreads.handoff",
    label: "Hand off",
    description:
      "Models make more tool-call mistakes as the window fills, so a thread past 'Hand off at' moves to a fresh one, opened with a summary of the work so far. Ask shows a card with the action; Automatic does it by itself once no turn, subthread or background task is running; until then the card stays with a button to hand off by hand. Each provider can change it.",
    section: "long-threads",
    kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("off", "Off")] },
    defaultValue: undefined,
    fallback: { resolver: "handoffMode" },
  },
  {
    key: "longThreads.handoffAt",
    label: "Hand off at",
    description: `Where a thread is handed off: a share of the model's window (a bigger window hands off later) or a size, the same for every model. A provider, or a model on it, can set its own; the most specific one applies, whatever its unit. ${LINES_INTERACT}`,
    section: "long-threads",
    kind: { type: "line", presets: LINE_PRESETS },
    defaultValue: undefined,
    fallback: { resolver: "handoffLine" },
  },
  {
    key: "longThreads.compaction",
    label: "Compaction",
    description: "Who compacts a thread as it fills. Asking offers a card past 'Compact at', but a delegated task, or a thread halfway from the line to full, is compacted unasked. Each provider can change it.",
    section: "long-threads",
    kind: {
      type: "enum",
      choices: [
        choice("provider", "The provider's own", "Claude Code and OpenCode compact by themselves; the Moxen Harness's own is automatic."),
        choice("ask", COMPACTION_CHOICE_LABEL.ask),
        choice("auto", COMPACTION_CHOICE_LABEL.auto),
        choice("off", COMPACTION_CHOICE_LABEL.off),
      ],
    },
    defaultValue: undefined,
    fallback: { text: "Each provider's own default" },
    appliesAt: "server-restart",
  },
  {
    key: "longThreads.compactAt",
    label: "Compact at",
    description: `Where a thread is compacted when Moxen does it: Claude Code and OpenCode while their Compaction is Moxen's, and the Moxen Harness. A share of the window or a size; each provider can set its own. ${LINES_INTERACT}`,
    section: "long-threads",
    kind: { type: "line", presets: LINE_PRESETS },
    defaultValue: undefined,
    fallback: { resolver: "compactLine" },
  },
  {
    key: "ui.autoHandoff",
    label: "Hand off long threads",
    description: "Kept so older configs still load: 'Hand off' before it moved out of the interface settings.",
    section: "long-threads",
    hidden: true,
    kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("off", "Off")] },
    defaultValue: "ask",
  },
  {
    key: "ui.autoHandoffPercent",
    label: "Hand off at (share)",
    description: "Kept so older configs still load: 'Hand off at' as a share of the window.",
    section: "long-threads",
    hidden: true,
    kind: { type: "integer", min: 10, max: 90, unit: "%", presets: [20, 30, 40, 50, 60, 70, 80] },
    defaultValue: 50,
  },
  {
    key: "ui.autoHandoffTokens",
    label: "Hand off at a fixed size",
    description: "Kept so older configs still load: 'Hand off at' as a size; it beat the share beside it.",
    section: "long-threads",
    hidden: true,
    kind: { type: "integer", min: 8_192, max: 2_000_000, binary: true },
    defaultValue: undefined,
  },

  // -- web tools (shared by every provider) ----------------------------------
  {
    key: "web.browser",
    label: "Browser for web pages",
    description:
      "When a page cannot be read with a plain request (it turns the request away, or builds its content with scripts), Moxen's web_fetch can load it in an installed Chrome or Chromium, headless and with a throwaway profile (none of your cookies or logins). This is the web_fetch every provider gets from Moxen and the Moxen Harness's own. Never: no thread starts a browser.",
    section: "agent",
    group: "Web tools",
    kind: { type: "enum", choices: [choice("auto", "When needed", "Use an installed Chrome or Chromium."), choice("off", "Never")] },
    defaultValue: undefined,
    fallback: { resolver: "webBrowser" },
  },
  {
    key: "web.browserPath",
    label: "Browser program",
    description: "The Chrome or Chromium program web_fetch starts.",
    section: "agent",
    group: "Web tools",
    kind: { type: "string", placeholder: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    defaultValue: undefined,
    fallback: { text: "Looked for in the usual places" },
    visibleWhen: { key: "web.browser", in: ["", "auto"] },
  },
  {
    key: "web.privateNetwork",
    label: "Web tools reach private networks",
    description: "Let Moxen's web tools, on every provider, reach addresses on your local network (10.x, 192.168.x and the like). This machine's own servers are always allowed; cloud metadata addresses never are.",
    section: "agent",
    group: "Web tools",
    kind: { type: "boolean" },
    defaultValue: undefined,
    fallback: { resolver: "privateNetwork" },
  },

  {
    key: "updates.checkLatest",
    label: "Check for newer versions",
    description:
      "When the settings page opens, ask the npm registry which Claude Code and OpenCode releases are newest, so it can say whether an update is available. Nothing else is sent. Off, the page shows installed versions only.",
    section: "general",
    kind: { type: "boolean" },
    defaultValue: true,
  },

  // -- remote access (the server, reached from another machine) -------------
  {
    key: "remote.enabled",
    label: "Remote access",
    description:
      "Let paired devices on your network or tailnet drive this machine's Moxen server, over TLS. Off, the server listens on this machine only. Takes effect at once while the server runs.",
    section: "general",
    group: "Remote access",
    kind: { type: "boolean" },
    defaultValue: false,
  },
  {
    key: "remote.interfaces",
    label: "Listen on",
    description: "Which of this machine's addresses remote access listens on: the local network, Tailscale, or both. Never all addresses at once.",
    section: "general",
    group: "Remote access",
    kind: {
      type: "enum",
      choices: [
        choice("both", "LAN and Tailscale"),
        choice("lan", "Local network", "Private addresses such as 192.168.x and 10.x."),
        choice("tailscale", "Tailscale", "This machine's tailnet address only."),
      ],
    },
    defaultValue: "both",
    visibleWhen: { key: "remote.enabled", in: ["true"] },
  },
  {
    key: "remote.port",
    label: "Port",
    description: "The TCP port remote access listens on.",
    section: "general",
    group: "Remote access",
    kind: { type: "integer", min: 1024, max: 65535 },
    defaultValue: DEFAULT_REMOTE_PORT,
    visibleWhen: { key: "remote.enabled", in: ["true"] },
  },

  // -- git and forges --------------------------------------------------------
  {
    key: "git.historyLimit",
    label: "Commits to load",
    description: "How many commits the Git panel reads per branch.",
    section: "git",
    kind: { type: "integer", min: 10, max: 1000, presets: [25, 50, 100, 150, 200, 300, 500, 750, 1000], ends: { low: "Fewer", high: "More" } },
    defaultValue: 50,
  },
  {
    key: "git.autoFetch",
    label: "Fetch before listing",
    description:
      "Run `git fetch` before reading history, so remote branches are current. It touches the network each time the panel opens.",
    section: "git",
    kind: { type: "boolean" },
    defaultValue: false,
  },
  {
    key: "forge.enabled",
    label: "Forge integration",
    description:
      "Use `gh` or `glab` for pull and merge requests when the remote points at GitHub or GitLab. Moxen never handles their credentials — each CLI owns its own login.",
    section: "git",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "forge.ghPath",
    label: "gh executable",
    description: "Path to the GitHub CLI, if it is not on PATH.",
    section: "git",
    kind: { type: "string", placeholder: "gh" },
    defaultValue: "gh",
  },
  {
    key: "forge.glabPath",
    label: "glab executable",
    description: "Path to the GitLab CLI, if it is not on PATH.",
    section: "git",
    kind: { type: "string", placeholder: "glab" },
    defaultValue: "glab",
  },

  // -- Claude Code -----------------------------------------------------------
  {
    key: "providers.claude.runtimeMode",
    label: "Permissions",
    description: "How much a new Claude Code thread may do without asking.",
    section: "provider:claude",
    group: "Defaults",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "Claude Code's own auto mode judges each call."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
    fallback: { key: "runtimeMode" },
  },
  {
    key: "providers.claude.model",
    label: "Model",
    description: "The model a new Claude Code thread starts with, when neither the request nor the project names one.",
    section: "provider:claude",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "claude" },
    defaultValue: undefined,
    fallback: { resolver: "providerModel" },
  },
  {
    key: "providers.claude.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new Claude Code thread starts at, for models that take one.",
    section: "provider:claude",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "claude" },
    defaultValue: undefined,
    fallback: { key: "thinkingEffort" },
  },
  ...toolSettings("claude"),
  {
    key: "providers.claude.binaryPath",
    label: "Claude executable",
    description: "The `claude` binary to spawn. On Windows an npm shim is followed to the real package entry.",
    section: "provider:claude",
    group: "Setup",
    kind: { type: "string", placeholder: "claude" },
    defaultValue: "claude",
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.homePath",
    label: "Claude config directory",
    description:
      "Sets CLAUDE_CONFIG_DIR for spawned sessions, to run against a separate Claude home. Left empty, the CLI's own is inherited. HOME is never overridden — that would break keychain login on macOS.",
    section: "provider:claude",
    group: "Setup",
    kind: { type: "string", placeholder: "~/.claude" },
    defaultValue: "",
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.thinkingDisplay",
    label: "Thinking display",
    description:
      "How extended thinking comes back. Claude Code's `highlights` is not offered: the API allows it only for sessions Anthropic hosts, and any other client silently falls back to no thinking text at all.",
    section: "provider:claude",
    group: "Output",
    kind: {
      type: "enum",
      choices: [
        choice("summarized", "Readable summaries"),
        choice("omitted", "No thinking text"),
      ],
    },
    defaultValue: "summarized",
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.promptSuggestions",
    label: "Suggest the next prompt",
    description: "Ask for one predicted next prompt after each turn, offered in the composer.",
    section: "provider:claude",
    group: "Output",
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.partialMessages",
    label: "Stream token by token",
    description:
      "Take the CLI's partial-message stream so text appears as it is written. Turning it off leaves whole messages arriving at once, which is quieter over a slow link.",
    section: "provider:claude",
    group: "Output",
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.agentSkills",
    label: "Your skills from .agents/skills",
    description:
      "Offer the skills in a project's or your home `.agents/skills` to Claude Code, which reads only `.claude/skills`, through a mod. A skill `.claude/skills` already has is left to Claude Code. Needs Claude Code 2.1.287 or newer.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.ultracode",
    label: "Ultracode",
    description:
      "Start every Claude Code session with Ultracode on: Claude plans larger jobs as workflows, spawning and coordinating many agents, and works through them until they are done. It uses far more tokens than a normal turn, and it is separate from Effort: it stays on at any level. Needs a Claude Code version that has it.",
    section: "provider:claude",
    group: "Ultracode",
    kind: { type: "boolean" },
    defaultValue: false,
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.autoCompact",
    label: "Compact long threads",
    description: "Kept so older configs still load: 'Compaction' before it took its place (claude is Claude Code's own).",
    section: "provider:claude",
    group: "Long threads",
    hidden: true,
    kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("claude", "Claude Code"), choice("off", "Off")] },
    defaultValue: "ask",
    appliesAt: "server-restart",
  },
  {
    key: "providers.claude.autoCompactPercent",
    label: "Compact at (share)",
    description: "Kept so older configs still load: 'Compact at' as a share, while Moxen compacts.",
    section: "provider:claude",
    group: "Long threads",
    hidden: true,
    kind: { type: "integer", min: 10, max: 95, unit: "%", presets: [40, 50, 60, 65, 70, 75, 80, 85, 90] },
    defaultValue: 80,
  },
  {
    key: "providers.claude.autoCompactWindow",
    label: "Auto-compact window",
    description: "Kept so older configs still load: 'Compact at' as a size, while Claude Code compacts on its own.",
    section: "provider:claude",
    group: "Long threads",
    hidden: true,
    kind: { type: "integer", min: 100_000, max: 1_000_000, binary: true },
    defaultValue: undefined,
    appliesAt: "server-restart",
  },

  ...sessionSettings("claude"),
  ...longThreadSettings("claude"),

  // -- OpenCode --------------------------------------------------------------
  {
    key: "providers.codex.runtimeMode",
    label: "Permissions",
    description: "How much a new Codex thread may do without asking.",
    section: "provider:codex",
    group: "Defaults",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "Codex's own rules judge each call."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
    fallback: { key: "runtimeMode" },
  },
  {
    key: "providers.codex.model",
    label: "Model",
    description: "The model a new Codex thread starts with, when neither the request nor the project names one.",
    section: "provider:codex",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "codex" },
    defaultValue: undefined,
    fallback: { resolver: "providerModel" },
  },
  {
    key: "providers.codex.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new Codex thread starts at, for models that take one.",
    section: "provider:codex",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "codex" },
    defaultValue: undefined,
    fallback: { key: "thinkingEffort" },
  },
  {
    key: "providers.codex.reasoningSummary",
    label: "Thinking summaries",
    description: "How much of Codex's reasoning summary to show. The model decides what summary it can provide.",
    section: "provider:codex",
    group: "Defaults",
    kind: { type: "enum", choices: [choice("detailed", "Detailed"), choice("auto", "Automatic"), choice("concise", "Concise"), choice("none", "Off")] },
    defaultValue: "detailed",
    appliesAt: "server-restart",
  },
  ...toolSettings("codex"),
  ...sessionSettings("codex"),
  ...longThreadSettings("codex"),
  ...(["binaryPath", "homePath", "launchArgs"] as const).map((field): SettingDescriptor => ({
    key: `providers.codex.${field}`,
    label: { binaryPath: "Executable", homePath: "Config directory", launchArgs: "Launch arguments" }[field],
    description: { binaryPath: "The Codex executable to run.", homePath: "The Codex configuration and login directory to use.", launchArgs: "Extra arguments passed to Codex app-server." }[field],
    section: "provider:codex", group: "Runtime", kind: { type: "string" },
    defaultValue: field === "binaryPath" ? "codex" : undefined,
    appliesAt: "server-restart",
  })),
  {
    key: "providers.opencode.runtimeMode",
    label: "Permissions",
    description: "How much a new OpenCode thread may do without asking.",
    section: "provider:opencode",
    group: "Defaults",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "OpenCode's own rules judge each call."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
    fallback: { key: "runtimeMode" },
  },
  {
    key: "providers.opencode.model",
    label: "Model",
    description: "The model a new OpenCode thread starts with, when neither the request nor the project names one.",
    section: "provider:opencode",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "opencode" },
    defaultValue: undefined,
    fallback: { resolver: "providerModel" },
  },
  {
    key: "providers.opencode.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new OpenCode thread starts at, for models that take one.",
    section: "provider:opencode",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "opencode" },
    defaultValue: undefined,
    fallback: { key: "thinkingEffort" },
  },
  ...toolSettings("opencode"),
  {
    key: "providers.opencode.moxenPrompt",
    label: "Moxen's system prompt",
    description:
      "Replace the base system prompt OpenCode picks for the model's family with Moxen's, the one the Moxen Harness works from, written for OpenCode's tools. Your AGENTS.md files, skills, MCP guidance and Moxen's runtime instructions still apply, and an agent you gave your own `system` keeps it.",
    section: "provider:opencode",
    group: "Prompt",
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "provider-restart",
  },
  // `serverUrl` (an external server) is left out on purpose: v2 authenticates every
  // call and Moxen reads the external server's password only from config, so a URL
  // alone cannot work. It waits for a masked field.
  {
    key: "providers.opencode.binaryPath",
    label: "OpenCode executable",
    description: "The `opencode` binary Moxen starts its servers with, and updates.",
    section: "provider:opencode",
    group: "Setup",
    kind: { type: "string", placeholder: "opencode" },
    defaultValue: "opencode",
    appliesAt: "server-restart",
  },
  {
    key: "providers.opencode.autoCompact",
    label: "Compact automatically",
    description: "Kept so older configs still load: 'Compaction' before it took its place (off is Off, on is OpenCode's own).",
    section: "provider:opencode",
    group: "Long threads",
    hidden: true,
    kind: { type: "boolean" },
    defaultValue: undefined,
    appliesAt: "server-restart",
  },
  {
    key: "providers.opencode.compactBuffer",
    label: "Compact when this much is left",
    description:
      "OpenCode's own compaction line, kept as it was: tokens kept free below the model's limit, so a larger value compacts earlier. A per-model window cannot be written as one share or size, so 'Compact at' applies to Moxen's compaction only. Config file and `moxen config set` only.",
    section: "provider:opencode",
    group: "Long threads",
    hidden: true,
    kind: { type: "integer", min: 0, max: 1_000_000, binary: true },
    defaultValue: undefined,
    appliesAt: "server-restart",
  },
  {
    key: "providers.opencode.bundledSkills",
    label: "Moxen's skills",
    description: "Kept so older configs still load. Moxen ships no skills now, so it does nothing.",
    section: "provider:opencode",
    group: "Behaviour",
    hidden: true,
    kind: { type: "boolean" },
    defaultValue: true,
    appliesAt: "next-session",
  },

  ...sessionSettings("opencode"),
  ...longThreadSettings("opencode"),

  // -- Moxen Harness ---------------------------------------------------------
  {
    key: "providers.harness.runtimeMode",
    label: "Permissions",
    description: "How much a new Moxen Harness thread may do without asking.",
    section: "provider:harness",
    group: "Defaults",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "Moxen's command classifier lets safe calls through and refuses dangerous ones."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
    fallback: { key: "runtimeMode" },
  },
  {
    key: "providers.harness.model",
    label: "Model",
    description: "The model a new Moxen Harness thread starts with, when neither the request nor the project names one.",
    section: "provider:harness",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "harness" },
    defaultValue: undefined,
    fallback: { resolver: "providerModel" },
  },
  {
    key: "providers.harness.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new Moxen Harness thread starts at, for models that take one.",
    section: "provider:harness",
    group: "Defaults",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "harness" },
    defaultValue: undefined,
    fallback: { key: "thinkingEffort" },
  },
  ...toolSettings("harness"),
  // These apply to every profile; a profile's own `compaction` fields (in the profile list below) win.
  // The driver reads the config on every turn, so none of this needs a restart.
  {
    key: "providers.harness.slots",
    label: "Requests at once",
    description: "How many requests a model server takes at the same time, for profiles that do not say (a profile's own 'Requests at once' wins). Subagents, summaries and titles queue behind it. A single-GPU llama.cpp server is usually 1; /btw is refused while a turn runs on a server with one slot.",
    section: "provider:harness",
    group: "Sessions",
    kind: { type: "integer", min: 1, max: 64, presets: [1, 2, 3, 4, 6, 8, 12, 16], ends: { low: "Fewer", high: "More" } },
    defaultValue: undefined,
    fallback: { text: "No limit" },
  },
  {
    key: "providers.harness.autoCompact",
    label: "Compact automatically",
    description: "Kept so older configs still load: 'Compaction' before it took its place.",
    section: "provider:harness",
    group: "Long threads",
    hidden: true,
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.harness.autoCompactPercent",
    label: "Compact at (share of window)",
    description: "Kept so older configs still load: 'Compact at' as a share. The size beside it wins when both are set.",
    section: "provider:harness",
    group: "Long threads",
    hidden: true,
    kind: { type: "integer", min: 30, max: 95, unit: "%" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.autoCompactTokens",
    label: "Compact at (size)",
    description: "Kept so older configs still load: 'Compact at' as a size.",
    section: "provider:harness",
    group: "Long threads",
    hidden: true,
    kind: { type: "integer", min: 8_192, max: 2_000_000, binary: true },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.webSearch",
    label: "Web search",
    description:
      "Where the Moxen Harness's web_search looks. DuckDuckGo needs no account but can ask for a human check if it sees many searches. SearXNG is an instance you run. For Exa or Brave Search, add their MCP servers (MCP servers → Add); they bring their own tools and key.",
    section: "provider:harness",
    group: "Web search",
    kind: {
      type: "enum",
      choices: [
        choice("duckduckgo", "DuckDuckGo", "No account. Unofficial, best-effort."),
        choice("searxng", "SearXNG", "Your own instance."),
      ],
    },
    defaultValue: "duckduckgo",
  },
  {
    key: "providers.harness.searxngUrl",
    label: "SearXNG address",
    description: "The address of your SearXNG instance, e.g. http://localhost:8888. Its settings must allow the json format.",
    section: "provider:harness",
    group: "Web search",
    visibleWhen: { key: "providers.harness.webSearch", in: ["searxng"] },
    kind: { type: "string", placeholder: "http://localhost:8888" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.webBrowser",
    label: "Browser for web pages (Harness)",
    description: "Kept so older configs still load: now the global 'Browser for web pages' (web.browser), which every provider's web_fetch follows and which wins when set.",
    section: "provider:harness",
    group: "Web search",
    hidden: true,
    kind: { type: "enum", choices: [choice("auto", "When needed"), choice("off", "Never")] },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.webBrowserPath",
    label: "Browser program (Harness)",
    description: "Kept so older configs still load: now the global 'Browser program' (web.browserPath), which wins when set.",
    section: "provider:harness",
    group: "Web search",
    hidden: true,
    kind: { type: "string", placeholder: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.webPrivateNetwork",
    label: "Web tools reach private networks (Harness)",
    description: "Kept so older configs still load: opened private networks for the Moxen Harness's web tools only. Now the global 'Web tools reach private networks' (web.privateNetwork), one switch for every provider, which wins when set.",
    section: "provider:harness",
    group: "Web search",
    hidden: true,
    kind: { type: "boolean" },
    defaultValue: undefined,
  },
  ...sessionSettings("harness"),
  ...longThreadSettings("harness"),
  HARNESS_PROFILES_SETTING,

  // -- MCP servers -----------------------------------------------------------
  MCP_SERVERS_SETTING,
  MCP_RUNNER_SETTING,
];

/**
 * The order a provider's page files its settings under headings, the same on every
 * provider so Claude Code, OpenCode and the Moxen Harness read alike: what a new
 * thread starts with, the tools, how long threads are handled, then whatever is
 * particular to that provider, and where it lives last.
 */
const PROVIDER_GROUP_ORDER = ["Defaults", "Tools", "Long threads", "Sessions", "Setup", "Output", "Ultracode", "Prompt", "Web search", "Model servers"];

/** The Defaults tab in the order a new thread's choices are made: provider, model, effort, then permissions and checkout. */
const DEFAULTS_ORDER = ["provider", "model", "speedMode", "thinkingEffort", "runtimeMode", "interactionMode", "threadEnvMode"];

function orderDefaults(settings: readonly SettingDescriptor[]): readonly SettingDescriptor[] {
  const out = [...settings];
  const slots = out.flatMap((entry, at) => (entry.section === "defaults" ? [at] : []));
  const rank = (entry: SettingDescriptor): number => {
    const at = DEFAULTS_ORDER.indexOf(entry.key);
    return at === -1 ? DEFAULTS_ORDER.length : at;
  };
  const sorted = slots.map((at) => out[at]!).sort((a, b) => rank(a) - rank(b));
  slots.forEach((at, index) => {
    out[at] = sorted[index]!;
  });
  return out;
}

function orderProviderGroups(settings: readonly SettingDescriptor[]): readonly SettingDescriptor[] {
  const out = [...settings];
  for (const section of ["provider:codex", "provider:claude", "provider:opencode", "provider:harness"] as const) {
    const slots = out.flatMap((entry, at) => (entry.section === section ? [at] : []));
    const rank = (entry: SettingDescriptor): number => {
      const at = entry.group === undefined ? -1 : PROVIDER_GROUP_ORDER.indexOf(entry.group);
      // A group the table does not name (a list's own heading) stays after the named ones, in the order it was written.
      return at === -1 ? PROVIDER_GROUP_ORDER.length : at;
    };
    const sorted = slots.map((at) => out[at]!).sort((a, b) => rank(a) - rank(b));
    slots.forEach((at, index) => {
      out[at] = sorted[index]!;
    });
  }
  return out;
}

export const SETTINGS: readonly SettingDescriptor[] = orderDefaults(orderProviderGroups(SETTINGS_IN_WRITTEN_ORDER));

const BY_KEY: ReadonlyMap<string, SettingDescriptor> = new Map(
  SETTINGS.map((descriptor) => [descriptor.key, descriptor]),
);

export function settingDescriptor(key: string): SettingDescriptor | undefined {
  return BY_KEY.get(key);
}

/** Every key, in table order — what `config set` accepts and lists on error. List keys address entries as `key[<id>]…`. */
export const SETTING_KEYS: readonly string[] = SETTINGS.map((descriptor) => descriptor.key);

const LISTS: readonly ListDescriptor[] = SETTINGS.filter((descriptor): descriptor is ListDescriptor => descriptor.kind.type === "list");

/** What a key into a list setting addresses, or null for any other key. Throws for a malformed one. */
export function listTarget(key: string): ListTarget | null {
  return key.includes("[") || LISTS.some((list) => list.key === key) ? resolveListKey(key, LISTS) : null;
}

/** Whether `config set` accepts the key: a flat key, or an entry or field of a list. */
export function isSettingKey(key: string): boolean {
  if (BY_KEY.has(key)) return true;
  try {
    return listTarget(key) !== null;
  } catch {
    return false;
  }
}

export function settingsInSection(section: SettingSection): readonly SettingDescriptor[] {
  return SETTINGS.filter((descriptor) => descriptor.section === section);
}

// -- reading and writing dotted paths ----------------------------------------

function walk(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The value in force for a key: what the config holds, else the
 * descriptor's default. Unknown keys read as `undefined` rather than
 * throwing, so a config written by a newer build stays readable.
 */
export function readSetting(config: CliConfig, key: string): SettingValue {
  const entry = key.includes("[") ? listTarget(key) : null;
  if (entry) return readListScalar(config, entry);
  const raw = walk(config, key.split("."));
  if (raw === undefined || raw === null) return settingDescriptor(key)?.defaultValue;
  if (typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number") return raw;
  if ((key.endsWith(".autoHandoffModels") || key.endsWith(".compactAtModels")) && typeof raw === "object") return formatHandoffModels(raw as Record<string, number>);
  if ((key.endsWith(".handoffModels") || key.endsWith(".compactionModels")) && typeof raw === "object") return formatModeModels(raw as Record<string, string>);
  return undefined;
}

/** A key is never written to the config: only the reference to where the keychain holds it. */
export function secretValue(key: string, text: string): string {
  if (text === "" || isSecretRef(text)) return text;
  throw new CliError("INVALID_CONFIG", `${key} holds a secret, which is kept in the OS keychain, not in the config. Set it with \`moxen config set ${key} <value>\` or on the settings page.`);
}

/**
 * The keychain name for a key that holds a secret: the key itself for a flat
 * setting, the full address for a list field (`providers.harness.profiles[colab].apiKey`).
 * Null for any other key.
 */
export function secretKeyName(key: string): string | null {
  const flat = BY_KEY.get(key);
  if (flat) return flat.kind.type === "secret" ? key : null;
  if (!key.includes("[")) return null;
  let target: ListTarget | null;
  try {
    target = listTarget(key);
  } catch {
    return null;
  }
  if (target === null || target.id === null || target.trail.length === 0) return null;
  const last = target.trail[target.trail.length - 1]!;
  if (last.field.kind.type !== "secret" || last.childId !== null) return null;
  const path = target.trail.map((step) => `${step.field.path}${step.childId === null ? "" : `[${step.childId}]`}`).join(".");
  return `${target.list.key}[${target.id}].${path}`;
}

/** Parse one `config set` argument against its descriptor. */
export function parseSettingValue(descriptor: SettingDescriptor, raw: string): SettingValue {
  const text = raw.trim();
  // An optional key (no default) set to nothing is cleared, whatever its type.
  if (text === "" && descriptor.defaultValue === undefined) return "";
  switch (descriptor.kind.type) {
    case "enum": {
      const match = descriptor.kind.choices.find((option) => option.value === text);
      if (!match) {
        const allowed = descriptor.kind.choices.map((option) => option.value).join(", ");
        throw new CliError("INVALID_CONFIG", `${descriptor.key} must be one of: ${allowed}.`);
      }
      return match.value;
    }
    case "boolean": {
      if (text === "true") return true;
      if (text === "false") return false;
      throw new CliError("INVALID_CONFIG", `${descriptor.key} must be true or false.`);
    }
    case "integer": {
      const value = Number(text);
      if (!Number.isInteger(value) || value < descriptor.kind.min || value > descriptor.kind.max) {
        throw new CliError(
          "INVALID_CONFIG",
          `${descriptor.key} must be a whole number between ${descriptor.kind.min} and ${descriptor.kind.max}.`,
        );
      }
      return value;
    }
    case "line": {
      const line = parseLine(text);
      if (line === null) {
        throw new CliError(
          "INVALID_CONFIG",
          `${descriptor.key} must be a share of the window from ${LINE_PERCENT_MIN}% to ${LINE_PERCENT_MAX}% (70%) or a size from 4K to 2M tokens (32K, 256K, 1M).`,
        );
      }
      return lineText(line);
    }
    case "duration": {
      if (!/^\d+(?:ms|s|m|h)$/.test(text)) {
        throw new CliError("INVALID_CONFIG", `${descriptor.key} must be a duration such as 45s, 2m or 1h.`);
      }
      return text;
    }
    case "string":
      return text;
    case "secret":
      return secretValue(descriptor.key, text);
    case "list":
      throw new CliError("INVALID_CONFIG", `${descriptor.key} is a list. Address an entry: ${descriptor.key}[<id>] (JSON) or ${descriptor.key}[<id>].<field>.`);
  }
}

/**
 * A copy of `config` with `key` set, creating intermediate objects as
 * needed. An empty string clears a key that has no meaningful empty value,
 * so `config set model ""` goes back to the provider's default rather than
 * pinning the empty string.
 */
export function writeSetting(config: CliConfig, key: string, value: SettingValue): CliConfig {
  const written = writeSettingValue(config, key, value);
  const alias = LONG_THREAD_ALIASES[key];
  return alias === undefined ? written : writeLongThreadAlias(config, written, key, value, alias);
}

/**
 * The older long-thread keys and what each now writes (MXN-99). `config set`
 * on one still writes it, for an older build sharing the file, and writes
 * the key that took its place too, which a newer build reads first; clearing
 * it clears that key as well when it still says the same thing.
 */
const LONG_THREAD_ALIASES: Readonly<Record<string, { readonly key: string; readonly map: (value: SettingValue) => string }>> = (() => {
  const out: Record<string, { key: string; map: (value: SettingValue) => string }> = {};
  const share = (value: SettingValue): string => `${String(value)}%`;
  const size = (value: SettingValue): string => lineText({ tokens: Number(value) });
  const same = (value: SettingValue): string => String(value);
  out["ui.autoHandoff"] = { key: "longThreads.handoff", map: same };
  out["ui.autoHandoffPercent"] = { key: "longThreads.handoffAt", map: share };
  out["ui.autoHandoffTokens"] = { key: "longThreads.handoffAt", map: size };
  for (const kind of ["claude", "opencode", "harness"] as const) {
    out[`providers.${kind}.autoHandoff`] = { key: `providers.${kind}.handoff`, map: same };
    out[`providers.${kind}.autoHandoffPercent`] = { key: `providers.${kind}.handoffAt`, map: share };
    out[`providers.${kind}.autoHandoffTokens`] = { key: `providers.${kind}.handoffAt`, map: size };
  }
  out["providers.claude.autoCompact"] = { key: "providers.claude.compaction", map: (value) => (value === "claude" ? "provider" : String(value)) };
  out["providers.claude.autoCompactPercent"] = { key: "providers.claude.compactAt", map: share };
  out["providers.claude.autoCompactWindow"] = { key: "providers.claude.compactAt", map: size };
  out["providers.opencode.autoCompact"] = { key: "providers.opencode.compaction", map: (value) => (value === true ? "provider" : "off") };
  out["providers.harness.autoCompact"] = { key: "providers.harness.compaction", map: (value) => (value === true ? "auto" : "off") };
  out["providers.harness.autoCompactPercent"] = { key: "providers.harness.compactAt", map: share };
  out["providers.harness.autoCompactTokens"] = { key: "providers.harness.compactAt", map: size };
  return out;
})();

function writeLongThreadAlias(before: CliConfig, written: CliConfig, key: string, value: SettingValue, alias: { readonly key: string; readonly map: (value: SettingValue) => string }): CliConfig {
  if (value !== "" && value !== undefined) return writeSettingValue(written, alias.key, parseSettingValue(BY_KEY.get(alias.key)!, alias.map(value)));
  const previous = readSetting(before, key);
  const stillSame = previous !== undefined && previous !== "" && readSetting(written, alias.key) === parseSettingValue(BY_KEY.get(alias.key)!, alias.map(previous));
  return stillSame ? writeSettingValue(written, alias.key, "") : written;
}

function writeSettingValue(config: CliConfig, key: string, value: SettingValue): CliConfig {
  const descriptor = settingDescriptor(key);
  if (!descriptor) throw new CliError("INVALID_CONFIG_KEY", `Unknown config key: ${key}`);
  const clears = value === "" && descriptor.defaultValue !== "";
  const path = key.split(".");
  const next = { ...config } as Record<string, unknown>;
  let cursor = next;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    const branch = existing !== null && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
    cursor[segment] = branch;
    cursor = branch;
  }
  const leaf = path[path.length - 1]!;
  if (clears) delete cursor[leaf];
  else cursor[leaf] = value;
  return next as unknown as CliConfig;
}

/** Every setting with its current value — what a settings page renders from. */
export interface SettingView {
  readonly descriptor: SettingDescriptor;
  readonly value: SettingValue;
  /** True when the config file pins it, rather than it falling back to the default. */
  readonly explicit: boolean;
  /** The entries of a list setting. Absent for every other kind. */
  readonly items?: readonly ListItemView[];
  /** Why the setting can do nothing at the moment (a client greys it out and says so); absent when it can. */
  readonly unavailable?: string;
  /** For a web order: the tools it can rank, with the ones this provider cannot use marked. */
  readonly order?: readonly WebOrderEntry[];
  /** What applies while the setting is unset (from its `fallback`), so a page's Default can name it. Absent when set, or when nothing more is known. */
  readonly effective?: SettingEffective;
  /** What the setting amounts to with everything else taken into account, set or not ("Served by Moxen from its own folder"); a page shows it beneath. */
  readonly inForce?: string;
}

/** A setting's value as a page writes it: a choice's label, On or Off, a number with its unit. */
export function formatSettingValue(descriptor: SettingDescriptor, value: SettingValue): string {
  if (value === undefined || value === "") return "Default";
  const kind = descriptor.kind;
  if (kind.type === "enum") return kind.choices.find((option) => option.value === String(value))?.label ?? String(value);
  if (kind.type === "boolean" || typeof value === "boolean") return value === true ? "On" : "Off";
  if (kind.type === "secret") return "Saved in the keychain";
  if (kind.type === "integer" && typeof value === "number") return `${numberLabel(value, kind.binary)}${kind.unit ?? ""}`;
  if (kind.type === "line") {
    const line = parseLine(value);
    if (line !== null) return lineLabel(line);
  }
  return String(value);
}

/** Where a fallback setting lives, said from the page of the one that falls back to it. */
function settingPlace(from: SettingDescriptor, to: SettingDescriptor): string {
  if (to.hidden === true) return `from ${to.key} in the config file`;
  return from.section === to.section ? `from '${to.label}'` : `from '${to.label}' on the ${SECTION_LABEL[to.section]} tab`;
}

/** The provider a Long threads row is on; undefined for the global one. */
const longThreadKindOf = (descriptor: SettingDescriptor): LongThreadKind | undefined =>
  /^providers\.(claude|codex|opencode|harness)\./.exec(descriptor.key)?.[1] as LongThreadKind | undefined;

/** What a long-thread rule found, said on `descriptor`'s page: the value as that page writes it, and where it is set (nothing for the built-in default). */
function sourcedEffective(descriptor: SettingDescriptor, value: string, key: string | null): SettingEffective {
  const label = formatSettingValue(descriptor, value);
  const from = key === null ? undefined : BY_KEY.get(key);
  return from === undefined || from.key === descriptor.key ? { value, label } : { value, label, origin: settingPlace(descriptor, from) };
}

const FALLBACK_RESOLVERS: Readonly<Record<FallbackResolver, (config: CliConfig, descriptor: SettingDescriptor) => SettingEffective | undefined>> = {
  /** A provider's delegation tools or web_fetch, unset: the older all-at-once `moxenTools` (`moxenToolsOf`), else on. */
  moxenTools(config, descriptor) {
    const kind = /^providers\.(claude|codex|opencode|harness)\./.exec(descriptor.key)?.[1] as "claude" | "codex" | "opencode" | "harness" | undefined;
    const legacy = kind === undefined ? undefined : config.providers?.[kind]?.moxenTools;
    return legacy === false ? { value: false, label: "Off", origin: `from providers.${kind}.moxenTools in the config file` } : { value: true, label: "On" };
  },
  /** The shared browser setting, unset: the Harness's older key when the file has it (`webPolicy`), else When needed. */
  webBrowser(config, descriptor) {
    const legacy = config.providers?.harness?.webBrowser;
    const when = legacy === "off" ? "off" : "auto";
    return { value: when, label: formatSettingValue(descriptor, when), ...(legacy === undefined ? {} : { origin: "from providers.harness.webBrowser in the config file" }) };
  },
  /** The shared private-network switch, unset: off, except that the Harness's older switch still opens its own tools. */
  privateNetwork(config) {
    return config.providers?.harness?.webPrivateNetwork === true
      ? { value: undefined, label: "Moxen Harness only", origin: "from providers.harness.webPrivateNetwork in the config file" }
      : { value: false, label: "Off" };
  },
  /** A provider tab's Model, unset: the global Model when the global Provider is this one (`configuredModel`); else the provider's catalog default, which the picker names itself. */
  providerModel(config, descriptor) {
    const kind = /^providers\.(claude|codex|opencode|harness)\.model$/.exec(descriptor.key)?.[1];
    const global = BY_KEY.get("model")!;
    const aimed = kind !== undefined && config.provider !== undefined && driverKindOfInstance(config.provider) === kind;
    if (aimed && config.model !== undefined && config.model.trim() !== "") return { value: config.model, label: config.model, origin: settingPlace(descriptor, global) };
    // Nothing more to say than the picker's own "Provider's default".
    return undefined;
  },
  /** Hand off, unset: the older key beside it, then the global setting, then Ask (`handoffModeFor`). */
  handoffMode(config, descriptor) {
    const found = handoffModeFor(config, longThreadKindOf(descriptor));
    return sourcedEffective(descriptor, found.value, found.key);
  },
  /** Hand off at, unset: the older keys beside it, then the global setting, then half the window, whatever the unit (`handoffLineFor`). */
  handoffLine(config, descriptor) {
    const found = handoffLineFor(config, longThreadKindOf(descriptor));
    return sourcedEffective(descriptor, lineText(found.value), found.key);
  },
  compactionMode(config, descriptor) {
    const kind = longThreadKindOf(descriptor);
    if (kind === undefined) return undefined;
    const found = compactionModeFor(config, kind);
    return sourcedEffective(descriptor, found.value, found.key);
  },
  /** Compact at, unset: the older keys beside it, then the global setting, then 80%; or the provider's own line, which is not one Moxen draws. */
  compactLine(config, descriptor) {
    const kind = longThreadKindOf(descriptor);
    if (kind === undefined) return { value: lineText(DEFAULT_COMPACT_LINE), label: lineLabel(DEFAULT_COMPACT_LINE), origin: "the Moxen Harness keeps its own: 70%, 60% under 128K" };
    const mode = compactionModeFor(config, kind).value;
    const found = compactLineFor(config, kind);
    if (found !== null) return sourcedEffective(descriptor, lineText(found.value), found.key);
    if (mode === "off") return undefined;
    if (kind === "harness") return { value: undefined, label: "70% of the window (60% under 128K)" };
    const buffer = kind === "opencode" ? config.providers?.opencode?.compactBuffer : undefined;
    return {
      value: undefined,
      label: kind === "codex" ? "Codex's own" : kind === "claude" ? "Claude Code's own, tuned per model" : buffer !== undefined ? `OpenCode's own, ${numberLabel(buffer, true)} before the limit` : "OpenCode's own, 10% before the limit",
    };
  },
};

/** What applies while `descriptor` is unset, following a chain of fallback keys (a few links at most). */
function effectiveOf(config: CliConfig, descriptor: SettingDescriptor, depth = 0): SettingEffective | undefined {
  const fallback = descriptor.fallback;
  if (fallback === undefined || depth > 4) return undefined;
  if ("resolver" in fallback) return FALLBACK_RESOLVERS[fallback.resolver](config, descriptor);
  if ("key" in fallback) {
    const target = BY_KEY.get(fallback.key);
    if (target === undefined) return undefined;
    const origin = settingPlace(descriptor, target);
    const value = readSetting(config, target.key);
    if (value !== undefined && value !== "") return { value, label: formatSettingValue(target, value), origin };
    const deeper = effectiveOf(config, target, depth + 1);
    return deeper === undefined ? undefined : { value: deeper.value, label: deeper.label, origin };
  }
  if ("value" in fallback) return { value: fallback.value, label: formatSettingValue(descriptor, fallback.value), origin: fallback.text };
  return { value: undefined, label: fallback.text };
}

/** What is in force for a setting whose outcome depends on more than its own value, keyed by its setting key. */
const IN_FORCE: Readonly<Record<string, (config: CliConfig) => string>> = {};

/** How each list setting's entries are described, keyed by its setting key. */
const LIST_VIEWS: Readonly<Record<string, (config: CliConfig) => readonly ListItemView[]>> = {
  [HARNESS_PROFILES_SETTING.key]: describeHarnessProfiles,
  [MCP_SERVERS_SETTING.key]: (config) => describeMcpServers(config),
};

/**
 * Why a setting does nothing in this config, for one that is not a web order:
 * the global Model belongs to the global Provider, so with none it is ignored
 * (`configuredModel`, `core/catalog/selection.ts`).
 */
function settingUnavailable(config: CliConfig, descriptor: SettingDescriptor): string | undefined {
  if (descriptor.key !== "model" || (config.provider ?? "").trim() !== "") return undefined;
  return (config.model ?? "").trim() !== ""
    ? `Ignored: ${config.model} applies only once Provider above names its provider, because a model belongs to one.`
    : "Applies once Provider above names one: a model belongs to one provider.";
}

/** A web order's provider and role, from its key. */
function webOrderOf(descriptor: SettingDescriptor): { provider: "claude" | "codex" | "opencode"; role: WebRole } | null {
  const match = /^providers\.(claude|codex|opencode)\.web(Search|Fetch)Order$/.exec(descriptor.key);
  return match === null ? null : { provider: match[1] as "claude" | "codex" | "opencode", role: match[2] === "Search" ? "search" : "fetch" };
}

export function describeSettings(config: CliConfig): readonly SettingView[] {
  return SETTINGS.map((descriptor) => {
    const items = LIST_VIEWS[descriptor.key]?.(config);
    const web = webOrderOf(descriptor);
    const unavailable = web === null ? settingUnavailable(config, descriptor) : webOrderUnavailable(config, web.provider, web.role);
    const value = readSetting(config, descriptor.key);
    const effective = value === undefined || value === "" ? effectiveOf(config, descriptor) : undefined;
    const inForce = IN_FORCE[descriptor.key]?.(config);
    return {
      descriptor,
      value,
      explicit: walk(config, descriptor.key.split(".")) !== undefined,
      ...(items ? { items } : {}),
      ...(unavailable ? { unavailable } : {}),
      ...(web ? { order: webOrderEntries(config, web.provider, web.role) } : {}),
      ...(effective ? { effective } : {}),
      ...(inForce ? { inForce } : {}),
    };
  });
}

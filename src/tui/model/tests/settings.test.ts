import { describe, expect, it } from "vitest";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { describeSettings, restartRequired, settingDescriptor, SETTINGS } from "../../../core/configschema.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../../../core/config.js";
import type { CliConfig } from "../../../core/types.js";
import { uiFromSnapshot } from "../../features/settings/useSettings.js";
import { configuredDefaultModel, defaultLabel, modelOverrideEntries, nextToggleValue, handoffStops, handoffTokensLabel, providerVersionLine, settingControl, settingValueLabel, updatableProviderOf, withModelOverride, type ProviderCheckView } from "../settings.js";

function provider(instanceId: string, models: Array<{ slug: string; name: string; efforts?: string[]; hidden?: boolean }>, enabled = true): ProviderSummary {
  return {
    instanceId,
    driver: instanceId,
    displayName: instanceId === "claudeAgent" ? "Claude" : "Codex",
    enabled,
    installed: true,
    status: null,
    authStatus: null,
    models: models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      isDefault: null,
      isHidden: model.hidden === true,
      efforts: model.efforts === undefined ? [] : [{ id: "effort", label: "Effort", currentValue: null, choices: model.efforts.map((id) => ({ id, label: id.toUpperCase(), isDefault: null })) }],
    })),
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };
}

const CATALOG = [
  provider("claudeAgent", [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "high", "xhigh"] },
    { slug: "claude-old", name: "Old", hidden: true },
  ]),
  provider("codex", [{ slug: "gpt-6", name: "GPT-6", efforts: ["low", "medium"] }]),
  provider("grok", [{ slug: "grok-5", name: "Grok 5" }], false),
];

function control(key: string, config: CliConfig = DEFAULT_CONFIG) {
  const settings = describeSettings(config);
  const view = settings.find((entry) => entry.descriptor.key === key)!;
  return settingControl(view.descriptor, view.value, settings, CATALOG);
}

describe("settingControl", () => {
  it("offers the catalog's enabled providers, and models only from the default provider", () => {
    const providers = control("provider");
    expect(providers.kind === "pick" && providers.options.map((entry) => entry.value)).toEqual(["", "claudeAgent", "codex"]);
    const allModels = control("model");
    expect(allModels.kind === "pick" && allModels.options.map((entry) => entry.value)).toEqual(["", "claude-opus-5-5", "gpt-6"]);
    const claudeModels = control("model", { ...DEFAULT_CONFIG, provider: "claudeAgent" });
    expect(claudeModels.kind === "pick" && claudeModels.options.map((entry) => entry.value)).toEqual(["", "claude-opus-5-5"]);
  });

  it("offers the default model's efforts", () => {
    const efforts = control("thinkingEffort", { ...DEFAULT_CONFIG, provider: "codex", model: "gpt-6" });
    expect(efforts.kind === "pick" && efforts.options.map((entry) => entry.value)).toEqual(["", "low", "medium"]);
  });

  it("keeps a hand-set value it cannot name at the top of the list", () => {
    const models = control("model", { ...DEFAULT_CONFIG, model: "my-custom" });
    expect(models.kind === "pick" && models.options[0]).toMatchObject({ value: "my-custom" });
  });

  it("picks from presets for numbers and durations, and types only what only the user knows", () => {
    const ttl = control("sessionTtl");
    expect(ttl.kind === "pick" && ttl.options.find((entry) => entry.value === "2m")?.label).toBe("2 minutes");
    expect(control("ui.contextRefreshSeconds").kind).toBe("pick");
    expect(control("providers.claude.binaryPath")).toEqual({ kind: "text", multiline: false });
    expect(control("instructions")).toEqual({ kind: "text", multiline: true });
    expect(control("forge.enabled")).toEqual({ kind: "toggle" });
  });

  it("lays short numeric presets out in a row, and filters long lists by typing", () => {
    const ttl = control("sessionTtl");
    expect(ttl.kind === "pick" && ttl.layout).toBe("slider");
    const permissions = control("runtimeMode");
    expect(permissions.kind === "pick" && permissions.layout).toBe("list");
    expect(permissions.kind === "pick" && permissions.searchable).toBe(false);
  });

  it("hides a permission mode the governed providers do not take, but not when they do not say", () => {
    const view = describeSettings(DEFAULT_CONFIG).find((entry) => entry.descriptor.key === "providers.claude.runtimeMode")!;
    const withModes = { ...provider("claudeAgent", []), supportedRuntimeModes: ["approval-required", "full-access"] as ProviderSummary["supportedRuntimeModes"] };
    const some = settingControl(view.descriptor, undefined, describeSettings(DEFAULT_CONFIG), [withModes]);
    expect(some.kind === "pick" && some.options.map((entry) => entry.value)).toEqual(["", "approval-required", "full-access"]);
    const unknown = settingControl(view.descriptor, undefined, describeSettings(DEFAULT_CONFIG), [provider("claudeAgent", [])]);
    expect(unknown.kind === "pick" && unknown.options).toHaveLength(5);
  });

  it("makes a long model list searchable", () => {
    const many = provider("claudeAgent", Array.from({ length: 12 }, (_, at) => ({ slug: `m${at}`, name: `Model ${at}` })));
    const view = describeSettings(DEFAULT_CONFIG).find((entry) => entry.descriptor.key === "model")!;
    const picked = settingControl(view.descriptor, undefined, describeSettings(DEFAULT_CONFIG), [many]);
    expect(picked.kind === "pick" && picked.searchable).toBe(true);
    expect(picked.kind === "pick" && picked.layout).toBe("list");
  });

  it("says plainly when a model has no effort to pick", () => {
    const efforts = control("thinkingEffort", { ...DEFAULT_CONFIG, provider: "claudeAgent", model: "claude-old" });
    expect(efforts.kind === "pick" && efforts.options).toHaveLength(1);
    expect(efforts.kind === "pick" && efforts.options[0]?.description).toMatch(/no effort/);
  });

  it("labels values by what they mean", () => {
    const descriptor = settingDescriptor("speedMode")!;
    const pick = control("speedMode");
    expect(settingValueLabel(descriptor, undefined, pick)).toBe("Default (The provider's own)");
    expect(settingValueLabel(descriptor, "fast", pick)).toBe("Fast");
    const model = control("model", { ...DEFAULT_CONFIG, model: "gpt-6" });
    expect(settingValueLabel(settingDescriptor("model")!, "gpt-6", model)).toBe("GPT-6");
  });
});

describe("provider updates on the settings page", () => {
  it("offers an update only on the sections of providers that have one", () => {
    expect(updatableProviderOf("provider:claude")).toBe("claude");
    expect(updatableProviderOf("provider:opencode")).toBe("opencode");
    expect(updatableProviderOf("provider:codex")).toBe("codex");
    expect(updatableProviderOf("general")).toBeNull();
    expect(updatableProviderOf("git")).toBeNull();
  });

  const check = (overrides: Partial<ProviderCheckView>): ProviderCheckView =>
    ({ ok: true, installed: true, version: "2.1.292 (Claude Code)", login: "inherit", minVersion: "2.1.292", ...overrides }) as ProviderCheckView;
  const newest = (latest: string | null, channel: string | null = "latest") => ({ enabled: true, latest, channel });

  it("says an update is available, naming it, when the registry has something newer on the channel", () => {
    expect(providerVersionLine(check({}), newest("2.1.293"))).toEqual({
      version: "2.1.292",
      status: "2.1.293 is available on the latest channel.",
      tone: "update",
      button: "[ Update to 2.1.293 ]",
      settled: false,
    });
    expect(providerVersionLine(check({}), newest("2.1.293", null)).status).toBe("2.1.293 is available.");
  });

  it("says it is up to date only when the registry's newest is what is installed or older", () => {
    const current = providerVersionLine(check({ version: "2.1.293 (Claude Code)" }), newest("2.1.293"));
    expect(current).toMatchObject({ tone: "ok", button: "[ Up to date ]", settled: true, status: "Up to date: 2.1.293 is the newest on the latest channel." });
    // Ahead of a lagging channel (took `latest`, follows `stable`): still nothing to update to.
    expect(providerVersionLine(check({ version: "2.1.293 (Claude Code)" }), newest("2.1.285", "stable")).settled).toBe(true);
  });

  it("never claims up to date without a successful read", () => {
    for (const latest of [undefined, newest(null), { enabled: false, latest: null, channel: null }]) {
      const line = providerVersionLine(check({}), latest);
      expect(line.settled).toBe(false);
      expect(line.tone).toBe("muted");
      expect(line.button).toBe("[ Update ]");
      expect(line.status).not.toContain("Up to date");
    }
    expect(providerVersionLine(check({}), undefined).status).toBe("Checking for a newer version…");
    expect(providerVersionLine(check({}), newest(null)).status).toBe("Could not check for a newer version.");
    expect(providerVersionLine(check({}), { enabled: false, latest: null, channel: null }).status).toContain("checks are off");
  });

  it("puts the floor first: an install below it is told to update whatever the registry says", () => {
    const old = providerVersionLine(check({ ok: false, version: "2.1.280 (Claude Code)" }), newest("2.1.293"));
    expect(old).toMatchObject({ version: "2.1.280", tone: "warn" });
    expect(old.status).toContain("Older than the 2.1.292 Moxen needs");
  });

  it("explains a provider that is missing, unreadable, or not yet checked", () => {
    expect(providerVersionLine(check({ installed: false, ok: false, version: null })).status).toContain("Not found");
    expect(providerVersionLine(check({ version: "weird output" })).status).toBe("Could not read its version.");
    expect(providerVersionLine(undefined)).toMatchObject({ version: null, status: "Checking…", tone: "muted" });
  });
});

describe("a line setting that is unset by default", () => {
  const descriptor = settingDescriptor("providers.claude.handoffAt")!;
  const control = (value: string | undefined) => settingControl(descriptor, value, describeSettings(DEFAULT_CONFIG), null);

  it("offers the default first, so it can be cleared, then shares, then sizes from a small model up", () => {
    const picked = control(undefined);
    expect(picked.kind).toBe("pick");
    if (picked.kind !== "pick") return;
    expect(picked.options.map((entry) => entry.value)).toEqual(["", "40%", "50%", "60%", "70%", "80%", "90%", "8K", "16K", "24K", "32K", "64K", "128K", "256K", "512K", "1M"]);
    expect(picked.options[2]!.label).toBe("50% of the window");
    expect(picked.options[10]!.label).toBe("32K tokens");
    expect(settingValueLabel(descriptor, undefined, picked)).toBe("Default (50% of the window)");
    expect(picked.layout).toBe("list");
  });

  it("reads a chosen line back the same way", () => {
    expect(settingValueLabel(descriptor, "256K", control("256K"))).toBe("256K tokens");
    expect(settingValueLabel(descriptor, "70%", control("70%"))).toBe("70% of the window");
  });
});

describe("MCP servers on a provider's page", () => {
  const config = normalizeConfig({
    mcpServers: {
      fs: { command: "npx" },
      gh: { command: "npx", providers: ["claude"] },
      off: { command: "x", disabled: true },
    },
    providers: { harness: { mcpExclude: "fs" } },
  });
  const settings = describeSettings(config);
  const descriptor = (key: string) => settings.find((view) => view.descriptor.key === key)!;

  it("lists every server, and says why one stays out whatever is ticked; an older 'offered to' limit is ticked out instead", () => {
    const control = settingControl(descriptor("providers.claude.mcpExclude").descriptor, undefined, settings, null);
    expect(control.kind === "servers" && control.servers.map((server) => [server.name, server.locked])).toEqual([
      ["fs", null],
      ["gh", null],
      ["off", "switched off on its own entry"],
    ]);
    // `gh` was offered to Claude Code only: the other providers have it switched off on their own checklist, where it can be seen and changed.
    const harness = settingControl(descriptor("providers.harness.mcpExclude").descriptor, descriptor("providers.harness.mcpExclude").value, settings, null);
    expect(harness.kind === "servers" && harness.servers.find((server) => server.name === "gh")?.locked).toBeNull();
    expect(harness.kind === "servers" && harness.excluded).toEqual(["fs", "gh"]);
    expect(descriptor("providers.opencode.mcpExclude").value).toBe("gh");
  });

  it("summarises how many it gets, counting only the ones it could get", () => {
    const label = (key: string, value: string | undefined) => {
      const d = descriptor(key).descriptor;
      return settingValueLabel(d, value, settingControl(d, value, settings, null));
    };
    expect(label("providers.claude.mcpExclude", undefined)).toBe("All 2 servers");
    expect(label("providers.claude.mcpExclude", "fs")).toBe("1 of 2");
    expect(label("providers.claude.mcpExclude", "fs,gh")).toBe("None");
    expect(label("providers.harness.mcpExclude", String(descriptor("providers.harness.mcpExclude").value))).toBe("None");
  });
});

describe("a provider's own tools and web preference on its page", () => {
  const view = (config: Parameters<typeof describeSettings>[0], key: string) => describeSettings(config).find((entry) => entry.descriptor.key === key)!;

  it("lists the provider's tools with the ones switched off ticked out, keeping a name the catalogue lacks", () => {
    const settings = describeSettings(normalizeConfig({}));
    const d = settings.find((entry) => entry.descriptor.key === "providers.opencode.disabledNativeTools")!.descriptor;
    const control = settingControl(d, "websearch, madeup", settings, null);
    expect(control.kind === "tools" && control.tools.map((tool) => tool.name)).toContain("webfetch");
    expect(control.kind === "tools" && control.excluded).toEqual(["websearch", "madeup"]);
    expect(settingValueLabel(d, "websearch, madeup", control)).toBe("2 off");
    expect(settingValueLabel(d, undefined, settingControl(d, undefined, settings, null))).toBe("All on");
    const codex = settings.find((entry) => entry.descriptor.key === "providers.codex.disabledNativeTools")!.descriptor;
    const native = settingControl(codex, undefined, settings, null);
    expect(native.kind).toBe("tools");
    if (native.kind !== "tools") throw new Error("expected native tools");
    expect(native.tools.find((tool) => tool.name === "apply_patch")).toMatchObject({ enabledWhenLocked: true, locked: expect.stringContaining("no independent removal control") });
  });

  it("greys each web order out until a tool it could rank is available to the provider, and says what it covers", () => {
    const search = "providers.claude.webSearchOrder";
    const fetch = "providers.claude.webFetchOrder";
    expect(view(normalizeConfig({}), search).unavailable).toContain("Brave Search or Exa");
    // Moxen's own web_fetch is there for the fetch order unless Moxen's tools are off.
    expect(view(normalizeConfig({}), fetch).unavailable).toBeUndefined();
    expect(view(normalizeConfig({ providers: { claude: { moxenTools: false } } }), fetch).unavailable).toContain("Moxen's web_fetch on");
    expect(view(normalizeConfig({ providers: { claude: { webFetch: false } } }), fetch).unavailable).toContain("Moxen's web_fetch on");
    // Orchestration off leaves web_fetch, and the order's Moxen row, as they were.
    expect(view(normalizeConfig({ providers: { claude: { orchestration: false } } }), fetch).unavailable).toBeUndefined();
    expect(view(normalizeConfig({ providers: { claude: { orchestration: false } } }), fetch).order?.find((entry) => entry.id === "moxen")?.locked).toBeNull();
    const brave = { type: "stdio" as const, command: "npx", args: ["-y", "@brave/brave-search-mcp-server"] };
    expect(view(normalizeConfig({ mcpServers: { search: brave } }), search).unavailable).toBeUndefined();
    // Switched off, limited to another provider, or excluded on this one: not available to it.
    expect(view(normalizeConfig({ mcpServers: { search: { ...brave, disabled: true } } }), search).unavailable).toBeDefined();
    expect(view(normalizeConfig({ mcpServers: { search: { ...brave, providers: ["opencode"] } } }), search).unavailable).toBeDefined();
    expect(view(normalizeConfig({ mcpServers: { search: brave }, providers: { claude: { mcpExclude: "search" } } }), search).unavailable).toBeDefined();
    // A search server of someone else's, however it is named, is not one Moxen can guide.
    expect(view(normalizeConfig({ mcpServers: { "brave-search": { type: "stdio", command: "npx", args: ["-y", "some-other-brave-server"] } } }), search).unavailable).toBeDefined();
    expect(view(normalizeConfig({}), search).descriptor.description).toContain("no tool is switched off");
  });

  it("lists the ranked tools first in their order, then the rest, and shows the ranking as the value", () => {
    const config = normalizeConfig({ mcpServers: { search: { type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"] } }, providers: { claude: { webSearchOrder: "native, brave, gone", disabledNativeTools: "WebSearch" } } });
    const settings = describeSettings(config);
    const d = settings.find((entry) => entry.descriptor.key === "providers.claude.webSearchOrder")!.descriptor;
    const control = settingControl(d, "native, brave, gone", settings, null);
    expect(control.kind === "order" && control.rows.map((row) => [row.id, row.rank, row.locked])).toEqual([
      ["native", 1, "switched off under Built-in tools off"],
      ["brave", 2, null],
      ["gone", 3, "unknown"],
      ["exa", null, "Exa is not added, or is off for this provider"],
    ]);
    expect(settingValueLabel(d, "native, brave, gone", control)).toBe("Claude Code's own → Brave Search → gone");
    expect(settingValueLabel(d, undefined, settingControl(d, undefined, settings, null))).toBe("No preference");
  });
});

describe("per-model overrides on a provider's page", () => {
  const claude = provider("claudeAgent", [{ slug: "opus", name: "Opus" }, { slug: "sonnet", name: "Sonnet" }, { slug: "old", name: "Old", hidden: true }]);
  const other = provider("codex", [{ slug: "gpt", name: "GPT" }]);
  const none = { handoff: null, handoffAt: null, compaction: null, compactAt: null };

  it("lists the provider's visible models with all four overrides, then models only the settings name", () => {
    const values = { handoff: "opus=off", handoffAt: "opus=500000, gone=300000", compaction: "sonnet=auto", compactAt: undefined };
    expect(modelOverrideEntries([claude, other], "claude", values)).toEqual([
      { slug: "opus", name: "Opus", ...none, handoff: "off", handoffAt: 500_000, offered: true },
      { slug: "sonnet", name: "Sonnet", ...none, compaction: "auto", offered: true },
      { slug: "gone", name: "gone (not offered)", ...none, handoffAt: 300_000, offered: false },
    ]);
    // Before the catalog arrives the overrides are still there to see and clear, and none is called gone.
    expect(modelOverrideEntries(null, "claude", { ...values, handoffAt: "opus=500000", compaction: undefined })).toEqual([{ slug: "opus", name: "opus", ...none, handoff: "off", handoffAt: 500_000, offered: true }]);
  });

  it("writes one model's field and leaves the others, and removes it with null", () => {
    expect(withModelOverride("handoffAt", "opus=500000", "sonnet", 128_000)).toBe("opus=500000, sonnet=128000");
    expect(withModelOverride("compactAt", "opus=500000, sonnet=128000", "opus", null)).toBe("sonnet=128000");
    expect(withModelOverride("handoff", undefined, "opus", "off")).toBe("opus=off");
    expect(withModelOverride("compaction", "opus=ask, sonnet=auto", "opus", null)).toBe("sonnet=auto");
  });

  it("labels sizes and keeps a hand-set size among the stops", () => {
    expect([100_000, 128_000, 1_000_000, 1_500_000, 300_500].map(handoffTokensLabel)).toEqual(["100K", "128K", "1M", "1.5M", "300,500"]);
    expect(handoffStops(null)).toHaveLength(10);
    expect(handoffStops(300_000)).toContain(300_000);
    expect(handoffStops(300_000)).toEqual([...handoffStops(300_000)].sort((a, b) => a - b));
  });

  it("counts the overrides on the collapsed row", () => {
    const descriptor = settingDescriptor("providers.claude.autoHandoffModels")!;
    const label = (value: string) => settingValueLabel(descriptor, value, settingControl(descriptor, value, [], [claude]));
    expect(label("")).toBe("None");
    expect(label("opus=500000")).toBe("1 model");
    expect(label("opus=500000, sonnet=100000")).toBe("2 models");
  });
});

describe("a yes/no setting with no default of its own", () => {
  const key = "providers.opencode.orchestration";
  const descriptor = settingDescriptor(key)!;
  const at = (value: boolean | undefined) => {
    const config = value === undefined ? DEFAULT_CONFIG : normalizeConfig({ providers: { opencode: { orchestration: value } } });
    const settings = describeSettings(config);
    const view = settings.find((entry) => entry.descriptor.key === key)!;
    return { view, control: settingControl(descriptor, view.value, settings, null) };
  };

  it("reads as the default it falls back to, not as off", () => {
    const { control } = at(undefined);
    expect(control).toMatchObject({ kind: "toggle", tristate: true });
    expect(settingValueLabel(descriptor, undefined, control)).toBe("Default (On)");
    expect(settingValueLabel(descriptor, true, at(true).control)).toBe("On");
    expect(settingValueLabel(descriptor, false, at(false).control)).toBe("Off");
  });

  it("goes unset, on, off and back to unset", () => {
    const { control } = at(undefined);
    if (control.kind !== "toggle") throw new Error("not a toggle");
    expect([undefined, true, false].map((value) => nextToggleValue(control, value))).toEqual(["true", "false", ""]);
    const twoWay = control.tristate === true ? { kind: "toggle" as const } : control;
    expect([true, false].map((value) => nextToggleValue(twoWay, value))).toEqual(["false", "true"]);
  });
});

describe("what Default names", () => {
  const effective = (key: string, config: CliConfig = DEFAULT_CONFIG) => describeSettings(config).find((entry) => entry.descriptor.key === key)?.effective;

  it("follows a provider's setting to the global one, and says where it is", () => {
    expect(effective("providers.claude.runtimeMode")).toEqual({ value: "full-access", label: "Full access", origin: "from 'Permissions' on the Defaults tab" });
    expect(effective("providers.claude.runtimeMode", normalizeConfig({ runtimeMode: "approval-required" }))?.label).toBe("Supervised");
    expect(effective("providers.claude.runtimeMode", normalizeConfig({ providers: { claude: { runtimeMode: "auto" } } }))).toBeUndefined();
    const pick = control("providers.claude.runtimeMode");
    expect(pick.kind === "pick" && pick.options[0]).toMatchObject({ value: "", label: "Default", description: "Full access, from 'Permissions' on the Defaults tab" });
    expect(settingValueLabel(settingDescriptor("providers.claude.runtimeMode")!, undefined, pick)).toBe("Default (Full access)");
  });

  it("works out a hand-off line the way the server does, whatever its unit", () => {
    expect(effective("longThreads.handoffAt")).toEqual({ value: "50%", label: "50% of the window" });
    expect(effective("providers.claude.handoffAt", normalizeConfig({ longThreads: { handoffAt: "40%" } }))).toMatchObject({ label: "40% of the window", origin: "from 'Hand off at' on the Long threads tab" });
    expect(effective("providers.claude.handoffAt", normalizeConfig({ ui: { autoHandoffTokens: 131_072 } }))).toMatchObject({ value: "128K", label: "128K tokens" });
    // A provider's own (older) share wins over the global size.
    expect(effective("providers.claude.handoffAt", normalizeConfig({ ui: { autoHandoffTokens: 131_072 }, providers: { claude: { autoHandoffPercent: 40 } } }))).toMatchObject({ value: "40%", label: "40% of the window" });
  });

  it("marks the preset a fallback lands on, so a slider opens there", () => {
    const share = control("providers.claude.handoffAt");
    expect(share.kind === "pick" && share.options.find((entry) => entry.isDefault === true)?.value).toBe("50%");
  });

  it("names something for every unset enum, number and switch a page offers", () => {
    const unnamed = describeSettings(DEFAULT_CONFIG).filter(
      (view) => view.descriptor.hidden !== true && view.descriptor.defaultValue === undefined && ["enum", "integer", "boolean"].includes(view.descriptor.kind.type) && view.effective === undefined,
    );
    expect(unnamed.map((view) => view.descriptor.key)).toEqual([]);
    expect(defaultLabel(undefined)).toBe("Default");
  });
});

describe("when a change applies", () => {
  it("is a tag, not a sentence in the description", () => {
    for (const descriptor of SETTINGS) {
      expect(descriptor.description).not.toMatch(/Applies to the next session|reads this when its server starts/);
    }
  });

  it("keeps restartRequired for exactly the settings that wait for Moxen's server", () => {
    const flagged = SETTINGS.filter(restartRequired).map((descriptor) => descriptor.key);
    expect(flagged).toContain("providers.claude.binaryPath");
    expect(flagged).toContain("providers.opencode.compactBuffer");
    expect(flagged).not.toContain("providers.claude.moxenTools");
    expect(settingDescriptor("providers.claude.moxenTools")!.appliesAt).toBe("next-session");
    expect(settingDescriptor("providers.opencode.moxenPrompt")!.appliesAt).toBe("provider-restart");
  });
});


describe("uiFromSnapshot", () => {
  it("carries every interface setting the app draws from, so an edit applies without a restart", () => {
    const config = normalizeConfig({ ui: { backdrop: "off", modelScenes: false, hideBinaryDiffs: false, defaultSidePanel: "git" } });
    const ui = uiFromSnapshot({ settings: describeSettings(config) } as never);
    expect(ui).toMatchObject({ backdrop: "off", modelScenes: false, hideBinaryDiffs: false, defaultSidePanel: "git" });
  });
});

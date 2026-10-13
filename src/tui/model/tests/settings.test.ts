import { describe, expect, it } from "vitest";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { describeSettings, settingDescriptor } from "../../../core/configschema.js";
import { DEFAULT_CONFIG } from "../../../core/config.js";
import type { CliConfig } from "../../../core/types.js";
import { providerVersionLine, settingControl, settingValueLabel, updatableProviderOf, type ProviderCheckView } from "../settings.js";

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

  it("labels values by what they mean", () => {
    const descriptor = settingDescriptor("speedMode")!;
    const pick = control("speedMode");
    expect(settingValueLabel(descriptor, undefined, pick)).toBe("Not set");
    expect(settingValueLabel(descriptor, "fast", pick)).toBe("Fast");
    const model = control("model", { ...DEFAULT_CONFIG, model: "gpt-6" });
    expect(settingValueLabel(settingDescriptor("model")!, "gpt-6", model)).toBe("GPT-6");
  });
});

describe("provider updates on the settings page", () => {
  it("offers an update only on the sections of providers that have one", () => {
    expect(updatableProviderOf("provider:claude")).toBe("claude");
    expect(updatableProviderOf("provider:opencode")).toBe("opencode");
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

describe("an integer setting that is unset by default", () => {
  const descriptor = settingDescriptor("providers.claude.autoCompactWindow")!;
  const control = (value: number | undefined) => settingControl(descriptor, value, describeSettings(DEFAULT_CONFIG), null);

  it("offers Not set first, so it can be cleared, and shows big presets with separators", () => {
    const picked = control(undefined);
    expect(picked.kind).toBe("pick");
    if (picked.kind !== "pick") return;
    expect(picked.options.map((entry) => entry.label)).toEqual(["Not set", "200,000", "300,000", "500,000", "800,000", "1,000,000"]);
    expect(picked.options[0]!.value).toBe("");
    expect(settingValueLabel(descriptor, undefined, picked)).toBe("Not set");
  });

  it("reads a chosen window back the same way", () => {
    const picked = control(300_000);
    expect(settingValueLabel(descriptor, 300_000, picked)).toBe("300,000");
  });
});

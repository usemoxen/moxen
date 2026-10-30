import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, setConfigValue, normalizeConfig, CONFIG_KEYS } from "../config.js";
import {
  SETTINGS,
  describeSettings,
  parseSettingValue,
  readSetting,
  settingDescriptor,
  writeSetting,
} from "../configschema.js";

describe("settings schema", () => {
  it("is the single source of settable keys", () => {
    // The CLI validates `config set` against this list and the TUI renders
    // a control per entry, so a key missing here is a key neither surface has.
    expect(CONFIG_KEYS).toEqual(SETTINGS.map((descriptor) => descriptor.key));
    expect(new Set(CONFIG_KEYS).size).toBe(CONFIG_KEYS.length);
  });

  it("keeps every key the config file used to accept", () => {
    for (const key of ["projectPolicy", "workspaceMode", "openMode", "threadEnvMode", "runtimeMode", "interactionMode", "provider", "model", "speedMode", "thinkingEffort", "sessionTtl", "instructions", "autoContinueAtUsageLimit"]) {
      expect(settingDescriptor(key), key).toBeDefined();
    }
  });

  it("reads a default through for an unset key, and the pinned value once set", () => {
    expect(readSetting(DEFAULT_CONFIG, "git.historyLimit")).toBe(50);
    const next = setConfigValue(DEFAULT_CONFIG, "git.historyLimit", "120");
    expect(readSetting(next, "git.historyLimit")).toBe(120);
    expect(next.git?.historyLimit).toBe(120);
  });

  it("creates intermediate objects for a dotted key without disturbing siblings", () => {
    const withPath = setConfigValue(DEFAULT_CONFIG, "providers.claude.binaryPath", "/opt/claude");
    const withBoth = setConfigValue(withPath, "providers.claude.promptSuggestions", "false");
    expect(withBoth.providers?.claude).toEqual({ binaryPath: "/opt/claude", promptSuggestions: false });
  });

  it("rejects a bad value with the allowed set rather than writing it", () => {
    expect(() => setConfigValue(DEFAULT_CONFIG, "ui.backdrop", "sparkly")).toThrow(
      "ui.backdrop must be one of: animated, static, off.",
    );
    expect(() => setConfigValue(DEFAULT_CONFIG, "git.historyLimit", "9")).toThrow(
      "git.historyLimit must be a whole number between 10 and 1000.",
    );
    expect(() => setConfigValue(DEFAULT_CONFIG, "forge.enabled", "yes")).toThrow("forge.enabled must be true or false.");
    expect(() => setConfigValue(DEFAULT_CONFIG, "sessionTtl", "soon")).toThrow(
      "sessionTtl must be a duration such as 45s, 2m or 1h.",
    );
  });

  it("offers only presets the key itself would accept, its default among them", () => {
    for (const descriptor of SETTINGS) {
      const kind = descriptor.kind;
      if ((kind.type !== "integer" && kind.type !== "duration") || kind.presets === undefined) continue;
      for (const preset of kind.presets) expect(parseSettingValue(descriptor, String(preset))).toBe(preset);
      // A key that is unset by default (the auto-compact window) has no default to offer among them.
      if (descriptor.defaultValue !== undefined) expect(kind.presets as readonly unknown[]).toContain(descriptor.defaultValue);
    }
  });

  it("clears an optional enum set to nothing, but refuses nothing for one with a default", () => {
    expect(setConfigValue({ ...DEFAULT_CONFIG, speedMode: "fast" }, "speedMode", "").speedMode).toBeUndefined();
    expect(() => parseSettingValue(settingDescriptor("ui.backdrop")!, "")).toThrow(/must be one of/);
  });

  it("takes the provider settings the panes offer, within their range, and reads them back from the file", () => {
    const window = setConfigValue(DEFAULT_CONFIG, "providers.claude.autoCompactWindow", "300000");
    expect(window.providers?.claude?.autoCompactWindow).toBe(300_000);
    expect(() => setConfigValue(DEFAULT_CONFIG, "providers.claude.autoCompactWindow", "50000")).toThrow(/between 100000 and 1000000/);
    expect(setConfigValue(window, "providers.claude.autoCompactWindow", "").providers?.claude?.autoCompactWindow).toBeUndefined();

    const both = setConfigValue(window, "providers.opencode.binaryPath", "/opt/opencode");
    const reloaded = normalizeConfig(JSON.parse(JSON.stringify(both)));
    expect(reloaded.providers?.claude?.autoCompactWindow).toBe(300_000);
    expect(reloaded.providers?.opencode?.binaryPath).toBe("/opt/opencode");
  });

  it("refuses a key it does not know", () => {
    expect(() => setConfigValue(DEFAULT_CONFIG, "git.historyLimitt", "20")).toThrow("Unknown config key");
  });

  it("clears a key set back to empty, rather than pinning the empty string", () => {
    const pinned = setConfigValue(DEFAULT_CONFIG, "model", "opus");
    expect(setConfigValue(pinned, "model", "").model).toBeUndefined();
    // A key whose default *is* empty keeps it: "" means "inherit the CLI's own".
    expect(setConfigValue(DEFAULT_CONFIG, "providers.claude.homePath", "").providers?.claude?.homePath).toBe("");
  });

  it("round-trips a nested section through the file normalizer", () => {
    const written = setConfigValue(setConfigValue(DEFAULT_CONFIG, "forge.ghPath", "/usr/bin/gh"), "ui.backdrop", "off");
    const reloaded = normalizeConfig(JSON.parse(JSON.stringify(written)));
    expect(reloaded.forge?.ghPath).toBe("/usr/bin/gh");
    expect(reloaded.ui?.backdrop).toBe("off");
  });

  it("drops a section field a newer build wrote, instead of failing the load", () => {
    const reloaded = normalizeConfig({ ...DEFAULT_CONFIG, git: { historyLimit: 30, somethingNew: true } });
    expect(reloaded.git).toEqual({ historyLimit: 30 });
  });

  it("rejects a section that is not an object", () => {
    expect(() => normalizeConfig({ ...DEFAULT_CONFIG, ui: "off" })).toThrow("ui must be a JSON object.");
  });

  it("type-checks a value that arrives already typed from the file", () => {
    expect(() => normalizeConfig({ ...DEFAULT_CONFIG, git: { autoFetch: 1 } })).toThrow(
      "git.autoFetch must be true or false.",
    );
    expect(() => normalizeConfig({ ...DEFAULT_CONFIG, git: { historyLimit: 20.5 } })).toThrow(
      "git.historyLimit must be a whole number.",
    );
  });

  it("marks which values the file pins and which fall back", () => {
    const views = describeSettings(setConfigValue(DEFAULT_CONFIG, "ui.backdrop", "static"));
    const backdrop = views.find((view) => view.descriptor.key === "ui.backdrop");
    const refresh = views.find((view) => view.descriptor.key === "ui.contextRefreshSeconds");
    expect(backdrop).toMatchObject({ value: "static", explicit: true });
    expect(refresh).toMatchObject({ value: 5, explicit: false });
  });

  it("gives every descriptor a label and a description", () => {
    for (const descriptor of SETTINGS) {
      expect(descriptor.label.length, descriptor.key).toBeGreaterThan(0);
      expect(descriptor.description.length, descriptor.key).toBeGreaterThan(0);
    }
  });

  it("parses each kind on its own", () => {
    expect(parseSettingValue({ ...SETTINGS[0]!, kind: { type: "string" } }, "  spaced  ")).toBe("spaced");
    expect(writeSetting(DEFAULT_CONFIG, "forge.enabled", false).forge?.enabled).toBe(false);
  });
});

describe("web tools shared by every provider", () => {
  const view = (config: unknown, key: string) => describeSettings(normalizeConfig(config)).find((entry) => entry.descriptor.key === key)!;

  it("reads the Harness's older keys as what the shared settings amount to while they are unset", () => {
    expect(view({ providers: { harness: { webBrowser: "off" } } }, "web.browser").effective).toEqual({ value: "off", label: "Never", origin: "from providers.harness.webBrowser in the config file" });
    expect(view({}, "web.browser").effective).toEqual({ value: "auto", label: "When needed" });
    expect(view({ providers: { harness: { webPrivateNetwork: true } } }, "web.privateNetwork").effective).toMatchObject({ label: "Moxen Harness only" });
    expect(view({ web: { browser: "auto" }, providers: { harness: { webBrowser: "off" } } }, "web.browser")).toMatchObject({ value: "auto", explicit: true });
    for (const key of ["providers.harness.webBrowser", "providers.harness.webBrowserPath", "providers.harness.webPrivateNetwork"]) {
      expect(settingDescriptor(key)!.hidden).toBe(true);
    }
  });

  it("offers only the search backends that are built in, and no key rows for Exa or Brave (their MCP servers hold those)", () => {
    expect(settingDescriptor("providers.harness.webSearch")!.kind).toMatchObject({ type: "enum", choices: [{ value: "duckduckgo" }, { value: "searxng" }] });
    expect(SETTINGS.filter((descriptor) => descriptor.key.startsWith("providers.harness.webSearchKey"))).toEqual([]);
  });
});

describe("where settings live", () => {
  const visible = SETTINGS.filter((descriptor) => descriptor.hidden !== true);
  const sectionOf = (key: string) => settingDescriptor(key)!.section;

  it("files each global setting on the tab that says what it does", () => {
    expect(["provider", "model", "thinkingEffort", "runtimeMode", "threadEnvMode"].map(sectionOf)).toEqual(Array(5).fill("defaults"));
    // Defaults in the order a new thread's choices are made.
    expect(visible.filter((descriptor) => descriptor.section === "defaults").map((descriptor) => descriptor.key)).toEqual(["provider", "model", "thinkingEffort", "runtimeMode", "threadEnvMode"]);
    expect(["sessionTtl", "autoContinueAtUsageLimit", "usageLimitContinues"].map(sectionOf)).toEqual(Array(3).fill("sessions"));
    expect(["longThreads.handoff", "longThreads.handoffAt", "longThreads.compactAt"].map(sectionOf)).toEqual(Array(3).fill("long-threads"));
    expect(["instructions", "skills.moxen", "web.browser"].map(sectionOf)).toEqual(Array(3).fill("agent"));
    expect(sectionOf("branchPruneDays")).toBe("git");
    // No ui.* key outside the Interface tab.
    expect(visible.filter((descriptor) => descriptor.key.startsWith("ui.") && descriptor.section !== "interface")).toEqual([]);
  });

  it("gives every provider tab the same leading groups, and no catch-all", () => {
    for (const kind of ["claude", "opencode", "harness"]) {
      const groups = [...new Set(visible.filter((descriptor) => descriptor.section === `provider:${kind}`).map((descriptor) => descriptor.group))];
      expect(groups.slice(0, 4)).toEqual(["Defaults", "Tools", "Long threads", "Sessions"]);
      expect(groups).not.toContain("Behaviour");
      expect(groups).not.toContain("Concurrency");
    }
  });

  it("names no tab in a description: a cross-reference is generated where it is shown", () => {
    const tabs = /\b(Turns|New threads|General|Defaults|Sessions|Agent context|Interface|Git and forges|Moxen Harness|Claude Code|OpenCode) tab\b/;
    expect(SETTINGS.filter((descriptor) => tabs.test(descriptor.description)).map((descriptor) => descriptor.key)).toEqual([]);
  });
});

describe("descriptions say what a setting changes, and nothing the page generates", () => {
  type Field = { readonly path: string; readonly description: string; readonly hidden?: boolean; readonly kind: { readonly type: string; readonly fields?: readonly Field[]; readonly choices?: readonly { readonly description?: string }[] } };
  const texts: Array<[string, string]> = [];
  const walk = (key: string, fields: readonly Field[]) => {
    for (const field of fields) {
      if (field.hidden === true) continue;
      texts.push([`${key}.${field.path}`, field.description]);
      for (const option of field.kind.choices ?? []) if (option.description) texts.push([`${key}.${field.path}`, option.description]);
      if (field.kind.fields) walk(`${key}.${field.path}`, field.kind.fields);
    }
  };
  for (const descriptor of SETTINGS) {
    if (descriptor.hidden === true) continue;
    texts.push([descriptor.key, descriptor.description]);
    const kind = descriptor.kind as Field["kind"];
    for (const option of kind.choices ?? []) if (option.description) texts.push([descriptor.key, option.description]);
    if (kind.fields) walk(descriptor.key, kind.fields);
  }

  it("never says when it applies, what applies unset, or which tab another setting is on", () => {
    const generated = /Applies to the next session|Applies from the next session|restarts|Unset:|Default:|\btabs?\b/;
    expect(texts.filter(([, text]) => generated.test(text)).map(([key]) => key)).toEqual([]);
  });

  it("uses one word per concept", () => {
    // Command and key names in backticks are names, not prose.
    expect(texts.filter(([, text]) => /hand-off|handover|summari[sz]e the conversation/i.test(text.replace(/`[^`]*`/g, ""))).map(([key]) => key)).toEqual([]);
  });

  it("writes each provider's shared settings from one template", () => {
    // The Harness alone adds where its profiles' own instructions go.
    const strip = (key: string) => settingDescriptor(key)!.description.replace(/, then a profile's own Profile instructions/, "").replace(/Claude Code|OpenCode|Moxen Harness/g, "<provider>").replace(/\b(an?) <provider>/g, "a <provider>");
    for (const field of ["orchestration", "webFetch", "mcpExclude", "todos", "moxenSkills", "instructions", "autoContinueAtUsageLimit"]) {
      expect(new Set(["claude", "opencode", "harness"].map((kind) => strip(`providers.${kind}.${field}`))).size, field).toBe(1);
    }
  });
});

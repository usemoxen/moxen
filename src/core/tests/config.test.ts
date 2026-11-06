import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, configKeyCoversPath, defaultConfigPath, loadConfig, migrateLegacyConfig, normalizeConfig, normalizeConfigLenient, saveConfig, setConfigValue } from "../config.js";
import { readSetting } from "../configschema.js";

it.each(["claude", "codex", "opencode", "harness"] as const)("preserves the %s memory opt-out when normalizing config", (kind) => {
  const config = normalizeConfig({ providers: { [kind]: { memory: false } } });
  expect(config.providers?.[kind]?.memory).toBe(false);
});

describe("config", () => {
  it("applies documented defaults", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({ runtimeMode: "full-access" });
    expect(DEFAULT_CONFIG).not.toHaveProperty("provider");
    expect(DEFAULT_CONFIG).not.toHaveProperty("model");
    expect(DEFAULT_CONFIG).not.toHaveProperty("speedMode");
    expect(DEFAULT_CONFIG).not.toHaveProperty("thinkingEffort");
  });

  it("validates project and workspace policy", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "projectPolicy", "existing").projectPolicy).toBe("existing");
    expect(setConfigValue(DEFAULT_CONFIG, "workspaceMode", "folder").workspaceMode).toBe("folder");
    expect(() => setConfigValue(DEFAULT_CONFIG, "projectPolicy", "sometimes")).toThrow(
      "projectPolicy must be one of: create, existing.",
    );
  });

  it("normalizes model selection overrides", () => {
    const config = normalizeConfig({
      provider: " claudeAgent ",
      model: " claude-sonnet-4-6 ",
      speedMode: "standard",
      thinkingEffort: " high ",
    });

    expect(config).toMatchObject({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      speedMode: "standard",
      thinkingEffort: "high",
    });
    expect(() => normalizeConfig({ speedMode: "turbo" })).toThrow("speedMode must be standard or fast");
  });

  it("keeps the harness compaction defaults through the config file, with or without profiles", () => {
    expect(normalizeConfig({ providers: { harness: { autoCompact: false, autoCompactPercent: 80, keepRecentTokens: 9000 } } }).providers?.harness).toEqual({
      autoCompact: false,
      autoCompactPercent: 80,
      keepRecentTokens: 9000,
    });
    expect(() => normalizeConfig({ providers: { harness: { autoCompact: "sometimes" } } })).toThrow(/autoCompact/);
  });

  it("keeps the harness web settings, and refuses a search backend it does not have", () => {
    const web = { webSearch: "searxng", searxngUrl: "http://localhost:8888", webBrowser: "off", webBrowserPath: "/usr/bin/chromium", webPrivateNetwork: true };
    expect(normalizeConfig({ providers: { harness: web } }).providers?.harness).toEqual(web);
    expect(() => normalizeConfig({ providers: { harness: { webSearch: "bing" } } })).toThrow(/webSearch must be one of/);
    // Exa and Brave were built-in backends once; they are their MCP servers now, and a file that names one still loads, as the default.
    expect(normalizeConfig({ providers: { harness: { webSearch: "exa", webSearchKeyEnv: "EXA_API_KEY", webSearchKeys: { exa: "keychain:x" }, searxngUrl: "http://s" } } }).providers?.harness).toEqual({ searxngUrl: "http://s" });
    expect(normalizeConfig({ providers: { harness: { webSearch: "brave" } } }).providers?.harness).toBeUndefined();
    expect(() => normalizeConfig({ providers: { harness: { webBrowser: "always" } } })).toThrow(/webBrowser/);
  });

  it("keeps the runner chosen for well-known MCP servers, npx being the default", () => {
    expect(normalizeConfig({ mcpRunner: "bunx" }).mcpRunner).toBe("bunx");
    expect(normalizeConfig({ mcpRunner: "npx" }).mcpRunner).toBeUndefined();
    expect(() => normalizeConfig({ mcpRunner: "deno" })).toThrow(/mcpRunner/);
    expect(setConfigValue(normalizeConfig({}), "mcpRunner" as Parameters<typeof setConfigValue>[1], "pnpm").mcpRunner).toBe("pnpm");
  });

  it("keeps who compacts Claude Code threads and at what share", () => {
    const config = normalizeConfig({ providers: { claude: { autoCompact: "auto", autoCompactPercent: 70 } } });
    expect(config.providers?.claude).toEqual({ autoCompact: "auto", autoCompactPercent: 70 });
  });

  it("keeps Codex's reasoning-summary choice through the config file and CLI", () => {
    const config = normalizeConfig({ providers: { codex: { reasoningSummary: "detailed" } } });
    expect(config.providers?.codex?.reasoningSummary).toBe("detailed");
    expect(setConfigValue(config, "providers.codex.reasoningSummary", "none").providers?.codex?.reasoningSummary).toBe("none");
    expect(() => normalizeConfig({ providers: { codex: { reasoningSummary: "unlimited" } } })).toThrow(/reasoningSummary/);
  });

  it("keeps a provider's hand-off share and per-model tokens, and sets them from text", () => {
    const config = normalizeConfig({ providers: { claude: { autoHandoffPercent: 75, autoHandoffTokens: 131072, autoHandoffModels: { "claude-opus-4-5": "500k", "gpt-5": 1_000_000 } } } });
    expect(config.providers?.claude).toEqual({ autoHandoffPercent: 75, autoHandoffTokens: 131072, autoHandoffModels: { "claude-opus-4-5": 500_000, "gpt-5": 1_000_000 } });
    const set = setConfigValue(config, "providers.opencode.autoHandoffModels", "a/b.c=64k, d=1m");
    expect(set.providers?.opencode?.autoHandoffModels).toEqual({ "a/b.c": 64_000, d: 1_000_000 });
    expect(setConfigValue(set, "providers.opencode.autoHandoffModels", "").providers?.opencode).toBeUndefined();
    expect(() => normalizeConfig({ providers: { claude: { autoHandoffModels: { x: 100 } } } })).toThrow(/token count/);
  });
  it("keeps per-model prices, sets them from text, and refuses a negative one", () => {
    const config = normalizeConfig({ providers: { opencode: { modelInputPrices: { "opencode-go/muse-spark-1.3-contributor": 2 }, modelOutputPrices: { "opencode-go/muse-spark-1.3-contributor": "10" } } } });
    expect(config.providers?.opencode).toEqual({ modelInputPrices: { "opencode-go/muse-spark-1.3-contributor": 2 }, modelOutputPrices: { "opencode-go/muse-spark-1.3-contributor": 10 } });
    const set = setConfigValue(config, "providers.codex.modelInputPrices", "gpt-6.1-sol=2, other=0");
    expect(set.providers?.codex?.modelInputPrices).toEqual({ "gpt-6.1-sol": 2, other: 0 });
    expect(readSetting(set, "providers.codex.modelInputPrices")).toBe("gpt-6.1-sol=2, other=0");
    expect(setConfigValue(set, "providers.codex.modelInputPrices", "").providers?.codex).toBeUndefined();
    expect(() => setConfigValue(config, "providers.codex.modelInputPrices", "gpt-6.1-sol=-1")).toThrow(/zero or more/);
    expect(() => normalizeConfig({ providers: { codex: { modelOutputPrices: { "gpt-6.1-sol": "many" } } } })).toThrow(/zero or more/);
  });

  it("replaces the config file when saving, so a crash cannot leave a torn config", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-"));
    const file = path.join(dir, "nested", "config.json");
    await saveConfig(file, normalizeConfig({}));
    const before = statSync(file).ino;
    await saveConfig(file, normalizeConfig({ runtimeMode: "approval-required" }));
    // A rename, not a rewrite in place: a crash mid-write leaves either the
    // old file or the new one, never half of one.
    expect(statSync(file).ino).not.toBe(before);
    expect((await loadConfig(file)).config.runtimeMode).toBe("approval-required");
    // The overwritten file is kept beside it, so a bad save can be undone.
    expect(readdirSync(path.join(dir, "nested")).sort()).toEqual(["config.json", "config.json.bak"]);
  });

  it("loads past one bad scalar, keeping the rest and reporting where it was", async () => {
    const { config, skipped } = normalizeConfigLenient({ provider: "mine", speedMode: "turbo" });
    expect(config.provider).toBe("mine");
    expect(config.speedMode).toBeUndefined();
    expect(skipped.map((entry) => entry.path)).toEqual(["speedMode"]);
    // The strict reader still refuses it whole: `config set` must not accept it either.
    expect(() => normalizeConfig({ provider: "mine", speedMode: "turbo" })).toThrow("speedMode must be standard or fast");
  });

  it("skips one bad MCP server and keeps the good one", () => {
    const { config, skipped } = normalizeConfigLenient({
      mcpServers: {
        good: { command: "server" },
        bad: { command: "" },
      },
    });
    expect(Object.keys(config.mcpServers ?? {})).toEqual(["good"]);
    expect(skipped.map((entry) => entry.path)).toEqual(["mcpServers.bad"]);
  });

  it("skips one bad harness profile and keeps the good one", () => {
    const good = { id: "lab", baseUrl: "http://localhost:8080", models: [{ id: "qwen3" }] };
    const { config, skipped } = normalizeConfigLenient({
      providers: { harness: { profiles: [good, { id: "broken" }] } },
    });
    expect(config.providers?.harness?.profiles?.map((profile) => profile.id)).toEqual(["lab"]);
    expect(skipped.map((entry) => entry.path)).toEqual(["providers.harness.profiles[broken]"]);
  });

  it("a skipped entry survives a save instead of being silently dropped", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ provider: "mine", speedMode: "turbo" }));
    const loaded = await loadConfig(file);
    expect(loaded.config.provider).toBe("mine");
    expect(loaded.skipped.map((entry) => entry.path)).toEqual(["speedMode"]);
    await saveConfig(file, { ...loaded.config, provider: "theirs" }, loaded.skipped);
    const reread = await loadConfig(file);
    // The user's edit landed, and the bad value is still there to fix, not gone.
    expect(reread.config.provider).toBe("theirs");
    expect(reread.skipped.map((entry) => entry.path)).toEqual(["speedMode"]);
    expect(JSON.parse(readFileSync(file, "utf8")).speedMode).toBe("turbo");
  });

  it("a fixed entry stops being preserved once it parses", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ speedMode: "turbo" }));
    const loaded = await loadConfig(file);
    expect(loaded.skipped.map((entry) => entry.path)).toEqual(["speedMode"]);
    // The user fixed it: the new value is in force, not the old bad one.
    await saveConfig(file, { ...loaded.config, speedMode: "fast" }, loaded.skipped);
    expect(JSON.parse(readFileSync(file, "utf8")).speedMode).toBe("fast");
    expect((await loadConfig(file)).skipped).toEqual([]);
  });

  it("matches a set key against the skipped entries it covers", () => {
    expect(configKeyCoversPath("speedMode", "speedMode")).toBe(true);
    expect(configKeyCoversPath("ui", "ui.theme")).toBe(true);
    expect(configKeyCoversPath("ui.theme", "ui.theme")).toBe(true);
    expect(configKeyCoversPath("ui.theme", "ui.language")).toBe(false);
    expect(configKeyCoversPath("mcpServers[lab]", "mcpServers.lab")).toBe(true);
    expect(configKeyCoversPath("providers.harness.profiles[broken]", "providers.harness.profiles[broken]")).toBe(true);
    expect(configKeyCoversPath("providers.harness.profiles[lab]", "providers.harness.profiles[broken]")).toBe(false);
  });
});

describe("config location", () => {
  const saved = { HOME: process.env.HOME, PROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, XDG: process.env.XDG_CONFIG_HOME, CONFIG: process.env.MOXEN_CONFIG, NO: process.env.MOXEN_NO_CONFIG_MIGRATION };
  afterEach(() => {
    for (const [key, value] of [["HOME", saved.HOME], ["USERPROFILE", saved.PROFILE], ["APPDATA", saved.APPDATA], ["XDG_CONFIG_HOME", saved.XDG], ["MOXEN_CONFIG", saved.CONFIG], ["MOXEN_NO_CONFIG_MIGRATION", saved.NO]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const sandbox = () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moxen-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.MOXEN_CONFIG;
    delete process.env.MOXEN_NO_CONFIG_MIGRATION;
    // Where older builds kept the config: `%APPDATA%` on Windows, `~/.config` elsewhere.
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    mkdirSync(path.join(legacyRoot(home), "moxen"), { recursive: true });
    writeFileSync(path.join(legacyRoot(home), "moxen", "config.json"), '{"runtimeMode":"approval-required"}');
    return home;
  };
  const legacyRoot = (home: string) => (process.platform === "win32" ? path.join(home, "AppData", "Roaming") : path.join(home, ".config"));

  it("keeps using an old config where it is until a launch copies it", () => {
    const home = sandbox();
    expect(defaultConfigPath()).toBe(path.join(legacyRoot(home), "moxen", "config.json"));
    expect(migrateLegacyConfig()).toBe(true);
    expect(defaultConfigPath()).toBe(path.join(home, ".moxen", "config.json"));
    expect(readFileSync(path.join(home, ".moxen", "config.json"), "utf8")).toContain("approval-required");
    // Copied, not moved: a process still on the old build keeps its file.
    expect(existsSync(path.join(legacyRoot(home), "moxen", "config.json"))).toBe(true);
    expect(migrateLegacyConfig()).toBe(false);
  });

  it("never migrates when a config path is forced or migration is switched off", () => {
    const home = sandbox();
    process.env.MOXEN_NO_CONFIG_MIGRATION = "1";
    expect(migrateLegacyConfig()).toBe(false);
    delete process.env.MOXEN_NO_CONFIG_MIGRATION;
    process.env.MOXEN_CONFIG = path.join(home, "elsewhere.json");
    expect(migrateLegacyConfig()).toBe(false);
    expect(existsSync(path.join(home, ".moxen", "config.json"))).toBe(false);
  });
});

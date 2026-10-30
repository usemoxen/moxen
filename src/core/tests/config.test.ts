import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, defaultConfigPath, migrateLegacyConfig, normalizeConfig, setConfigValue } from "../config.js";

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

  it("keeps a provider's hand-off share and per-model tokens, and sets them from text", () => {
    const config = normalizeConfig({ providers: { claude: { autoHandoffPercent: 75, autoHandoffTokens: 131072, autoHandoffModels: { "claude-opus-4-5": "500k", "gpt-5": 1_000_000 } } } });
    expect(config.providers?.claude).toEqual({ autoHandoffPercent: 75, autoHandoffTokens: 131072, autoHandoffModels: { "claude-opus-4-5": 500_000, "gpt-5": 1_000_000 } });
    const set = setConfigValue(config, "providers.opencode.autoHandoffModels", "a/b.c=64k, d=1m");
    expect(set.providers?.opencode?.autoHandoffModels).toEqual({ "a/b.c": 64_000, d: 1_000_000 });
    expect(setConfigValue(set, "providers.opencode.autoHandoffModels", "").providers?.opencode).toBeUndefined();
    expect(() => normalizeConfig({ providers: { claude: { autoHandoffModels: { x: 100 } } } })).toThrow(/token count/);
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

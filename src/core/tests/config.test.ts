import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, defaultConfigPath, loadConfig, migrateLegacyConfig, normalizeConfig, normalizeFileConfig, saveConfig, setConfigValue } from "../config.js";
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
    // The retired backend's leftover keys stay in the file untouched, so a save does not drop them.
    expect(normalizeConfig({ providers: { harness: { webSearch: "exa", webSearchKeyEnv: "EXA_API_KEY", webSearchKeys: { exa: "keychain:x" }, searxngUrl: "http://s" } } }).providers?.harness).toEqual({ searxngUrl: "http://s", webSearchKeyEnv: "EXA_API_KEY", webSearchKeys: { exa: "keychain:x" } });
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
    await saveConfig(file, normalizeFileConfig({}));
    const before = statSync(file).ino;
    await saveConfig(file, normalizeFileConfig({ runtimeMode: "approval-required" }));
    // A rename, not a rewrite in place: a crash mid-write leaves either the
    // old file or the new one, never half of one.
    expect(statSync(file).ino).not.toBe(before);
    expect((await loadConfig(file)).config.runtimeMode).toBe("approval-required");
    // The rewrite before it left a backup beside the file.
    expect(readdirSync(path.join(dir, "nested")).sort()).toEqual(["config.json", "config.json.bak.1"]);
    expect(JSON.parse(readFileSync(path.join(dir, "nested", "config.json.bak.1"), "utf8")).runtimeMode).toBe("full-access");
  });

  it("refuses an unknown key on `config set`, instead of writing it", () => {
    expect(() => setConfigValue(normalizeFileConfig({}), "futureTop", "1")).toThrow("Unknown config key: futureTop");
    expect(() => setConfigValue(normalizeFileConfig({}), "ui.futureSection", "1")).toThrow("Unknown config key: ui.futureSection");
  });
});

describe("config keeps unknown keys", () => {
  const FUTURE = {
    futureTop: 7,
    ui: { theme: "moxen", futureSection: "keep-me" },
    providers: {
      claude: { binaryPath: "claude", futureField: "keep" },
      harness: {
        futureProviderField: "keep",
        profiles: [
          {
            id: "local",
            baseUrl: "http://localhost:8080",
            futureProfile: "keep",
            sampling: { topK: 20, futureSampling: 1 },
            compaction: { tokens: 65_536, futureCompaction: 2 },
            loopGuard: { calls: false, futureGuard: 3 },
            quirks: { systemFirstOnly: false, futureQuirk: true },
            models: [{ id: "qwen3:8b", contextWindow: 131_072, futureModel: "keep", probed: { at: "2026-10-14T10:00:00.000Z", quirks: {}, futureProbed: "keep" } }],
          },
          { id: "other", baseUrl: "http://localhost:8081", models: [{ id: "m" }] },
        ],
      },
      futureProvider: { anything: "keep" },
    },
    mcpServers: { docs: { command: "docs-mcp", futureServer: "keep" } },
  };

  it("keeps unknown keys at every level through a known edit, in memory and through the file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-unknowns-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(FUTURE, null, 2));
    const loaded = await loadConfig(file);
    const edited = setConfigValue(loaded.fileConfig, "ui.theme", "dracula");
    expect((edited as unknown as Record<string, unknown>).futureTop).toBe(7);
    expect((edited.ui as unknown as Record<string, unknown>).futureSection).toBe("keep-me");
    expect((edited.providers?.claude as unknown as Record<string, unknown>).futureField).toBe("keep");
    expect((edited.providers?.harness as unknown as Record<string, unknown>).futureProviderField).toBe("keep");
    expect((edited.providers as unknown as Record<string, unknown>).futureProvider).toEqual({ anything: "keep" });
    expect((edited.mcpServers?.docs as unknown as Record<string, unknown>).futureServer).toBe("keep");
    const local = edited.providers?.harness?.profiles?.find((entry) => entry.id === "local") as unknown as Record<string, unknown>;
    expect(local.futureProfile).toBe("keep");
    expect((local.sampling as Record<string, unknown>).futureSampling).toBe(1);
    expect((local.compaction as Record<string, unknown>).futureCompaction).toBe(2);
    expect((local.loopGuard as Record<string, unknown>).futureGuard).toBe(3);
    expect((local.quirks as Record<string, unknown>).futureQuirk).toBe(true);
    expect((((local.models as unknown[])[0]) as Record<string, unknown>).futureModel).toBe("keep");
    await saveConfig(file, edited);
    const reloaded = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(reloaded.futureTop).toBe(7);
    expect((reloaded.ui as Record<string, unknown>).futureSection).toBe("keep-me");
    expect(((reloaded.providers as Record<string, unknown>).claude as Record<string, unknown>).futureField).toBe("keep");
    expect((((reloaded.providers as Record<string, unknown>).harness as Record<string, unknown>).profiles as unknown[]).length).toBe(2);
    expect((((((reloaded.providers as Record<string, unknown>).harness as Record<string, unknown>).profiles as unknown[])[0]) as Record<string, unknown>).futureProfile).toBe("keep");
    expect((reloaded.mcpServers as Record<string, Record<string, unknown>>).docs!.futureServer).toBe("keep");
    expect((reloaded.ui as Record<string, unknown>).theme).toBe("dracula");
  });

  it("does not resurrect a cleared setting or a removed entry from the raw file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-clear-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(FUTURE, null, 2));
    const loaded = await loadConfig(file);
    let edited = setConfigValue(loaded.fileConfig, "model", "gpt-6");
    edited = setConfigValue(edited, "model", "");
    edited = setConfigValue(edited, "providers.harness.profiles[other]", "");
    await saveConfig(file, edited);
    const reloaded = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(reloaded.model).toBeUndefined();
    expect((reloaded.ui as Record<string, unknown>).futureSection).toBe("keep-me");
    const profiles = ((reloaded.providers as Record<string, unknown>).harness as Record<string, unknown>).profiles as unknown[];
    expect(profiles.map((entry) => (entry as Record<string, unknown>).id)).toEqual(["local"]);
  });

  it("never writes an active environment override into the file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-env-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ provider: "file-provider", ui: { theme: "moxen" } }, null, 2));
    const previous = process.env.MOXEN_PROVIDER;
    process.env.MOXEN_PROVIDER = "env-provider";
    try {
      const loaded = await loadConfig(file);
      expect(loaded.config.provider).toBe("env-provider");
      const edited = setConfigValue(loaded.fileConfig, "ui.theme", "dracula");
      await saveConfig(file, edited);
      const reloaded = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(reloaded.provider).toBe("file-provider");
      expect((reloaded.ui as Record<string, unknown>).theme).toBe("dracula");
    } finally {
      if (previous === undefined) delete process.env.MOXEN_PROVIDER;
      else process.env.MOXEN_PROVIDER = previous;
    }
  });

  it("keeps a keychain reference as a reference, never a secret", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-secret-"));
    const file = path.join(dir, "config.json");
    const raw = { providers: { harness: { profiles: [{ id: "local", baseUrl: "http://localhost:8080", apiKey: "keychain:my-key", models: [{ id: "m" }] }] } } };
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const loaded = await loadConfig(file);
    const edited = setConfigValue(loaded.fileConfig, "ui.theme", "dracula");
    await saveConfig(file, edited);
    const reloaded = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const profile = (((reloaded.providers as Record<string, unknown>).harness as Record<string, unknown>).profiles as Record<string, unknown>[])[0]!;
    expect(profile.apiKey).toBe("keychain:my-key");
  });

  it("keeps only a small number of backups beside the file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-backups-"));
    const file = path.join(dir, "config.json");
    await saveConfig(file, normalizeFileConfig({ projectPolicy: "create" }));
    for (let at = 0; at < 7; at += 1) {
      await saveConfig(file, normalizeFileConfig({ projectPolicy: "create", sessionTtl: `${at + 2}m` }));
    }
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["config.json", "config.json.bak.1", "config.json.bak.2", "config.json.bak.3", "config.json.bak.4", "config.json.bak.5"]);
    expect(JSON.parse(readFileSync(path.join(dir, "config.json.bak.5"), "utf8")).sessionTtl).toBe("3m");
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

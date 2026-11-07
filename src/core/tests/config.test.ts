import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, configKeyCoversPath, defaultConfigPath, loadConfig, migrateLegacyConfig, normalizeConfig, normalizeConfigLenient, normalizeFileConfig, saveConfig, setConfigValue } from "../config.js";
import type { CliConfig } from "../types.js";
import { readSetting } from "../configschema.js";

it.each(["claude", "codex", "opencode", "harness"] as const)("preserves the %s memory opt-out when normalizing config", (kind) => {
  const config = normalizeConfig({ providers: { [kind]: { memory: false } } });
  expect(config.providers?.[kind]?.memory).toBe(false);
});

describe("config", () => {
  it("applies documented defaults, stamped as version 1", () => {
    expect(normalizeConfig({})).toEqual({ ...DEFAULT_CONFIG, formatVersion: 1 });
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

  it("keeps unknown keys and skipped entries together through a load, edit, and save", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-"));
    const file = path.join(dir, "config.json");
    const written = {
      provider: "mine",
      speedMode: "turbo",
      futureTop: { nested: [1, 2, 3] },
      ui: { theme: "moxen", futureSection: "keep-me" },
      providers: { harness: { profiles: [{ id: "broken" }] } },
    };
    writeFileSync(file, JSON.stringify(written, null, 2));
    const loaded = await loadConfig(file);
    // Both problems are reported, and the unknown keys ride along untouched.
    expect(loaded.problems.map((entry) => entry.path).sort()).toEqual(["providers.harness.profiles[broken]", "speedMode"]);
    expect((loaded.fileConfig as unknown as Record<string, unknown>).futureTop).toEqual({ nested: [1, 2, 3] });
    expect((loaded.fileConfig.ui as unknown as Record<string, unknown>).futureSection).toBe("keep-me");
    // A known edit, saved the way the server saves it: unknown keys stay,
    // the skipped raws ride along, and a backup is written.
    const edited = setConfigValue(loaded.fileConfig, "provider", "theirs");
    const kept = loaded.skipped.filter((entry) => !configKeyCoversPath("provider", entry.path));
    await saveConfig(file, edited, kept);
    const reread = await loadConfig(file);
    expect(reread.config.provider).toBe("theirs");
    expect(reread.problems.map((entry) => entry.path).sort()).toEqual(["providers.harness.profiles[broken]", "speedMode"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(onDisk.futureTop).toEqual({ nested: [1, 2, 3] });
    expect((onDisk.ui as Record<string, unknown>).futureSection).toBe("keep-me");
    expect(onDisk.speedMode).toBe("turbo");
    expect(((onDisk.providers as Record<string, unknown>).harness as Record<string, unknown>).profiles).toEqual([{ id: "broken" }]);
    expect(readdirSync(dir).sort()).toEqual(["config.json", "config.json.bak.1"]);
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

  it("refuses an unknown key on `config set`, instead of writing it", () => {
    expect(() => setConfigValue(normalizeFileConfig({}), "futureTop", "1")).toThrow("Unknown config key: futureTop");
    expect(() => setConfigValue(normalizeFileConfig({}), "ui.futureSection", "1")).toThrow("Unknown config key: ui.futureSection");
  });
});

describe("config format version", () => {
  /** A config file as written today: version 1, before versions were stamped. */
  const TODAY = {
    provider: "mine",
    threadEnvMode: "local",
    ui: { theme: "moxen" },
    mcpServers: { docs: { command: "docs-mcp" } },
    providers: { harness: { autoCompactPercent: 80 } },
  };

  it("reads today's shape as version 1 and stamps it on save", async () => {
    expect(normalizeFileConfig(TODAY).formatVersion).toBe(1);
    expect(normalizeFileConfig({ ...TODAY, formatVersion: 1 })).toEqual(normalizeFileConfig(TODAY));

    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(TODAY, null, 2));
    // A save stamps the version the build knows; the settings survive it.
    await saveConfig(file, setConfigValue((await loadConfig(file)).fileConfig, "provider", "theirs"));
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(onDisk.formatVersion).toBe(1);
    expect(onDisk.provider).toBe("theirs");
    expect(onDisk.ui).toEqual({ theme: "moxen" });
    expect((await loadConfig(file)).fileConfig.formatVersion).toBe(1);
  });

  it("refuses a config newer than it knows, on read and on write", async () => {
    expect(() => normalizeFileConfig({ ...TODAY, formatVersion: 2 })).toThrow(
      expect.objectContaining({ code: "FORMAT_TOO_NEW" }),
    );

    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...TODAY, formatVersion: 2 }));
    await expect(loadConfig(file)).rejects.toMatchObject({ code: "FORMAT_TOO_NEW" });

    await expect(saveConfig(file, { ...normalizeFileConfig(TODAY), formatVersion: 2 })).rejects.toMatchObject({
      code: "FORMAT_TOO_NEW",
    });
    // The refused save wrote nothing: the newer file is untouched.
    expect(JSON.parse(readFileSync(file, "utf8")).formatVersion).toBe(2);
  });

  it("refuses a version that is not a version, and never takes it by hand", () => {
    expect(() => normalizeFileConfig({ ...TODAY, formatVersion: "2" })).toThrow(
      expect.objectContaining({ code: "INVALID_FORMAT_VERSION" }),
    );
    expect(() => setConfigValue(normalizeFileConfig(TODAY), "formatVersion", "1")).toThrow(
      "Unknown config key: formatVersion",
    );
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

  it("reads a leaked override back as the file's own value when a save is handed the effective config", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-envleak-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ provider: "file-provider" }, null, 2));
    const previous = process.env.MOXEN_PROVIDER;
    process.env.MOXEN_PROVIDER = "env-provider";
    try {
      const loaded = await loadConfig(file);
      // A caller that hands the effective config to the save (rather than the
      // file's config) must not persist the override.
      const leaked = { ...loaded.fileConfig, provider: loaded.config.provider } as unknown as CliConfig;
      await saveConfig(file, leaked);
      expect((JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>).provider).toBe("file-provider");
      // A value the user actually changed still saves as intended.
      await saveConfig(file, { ...loaded.fileConfig, provider: "user-choice" });
      expect((JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>).provider).toBe("user-choice");
    } finally {
      if (previous === undefined) delete process.env.MOXEN_PROVIDER;
      else process.env.MOXEN_PROVIDER = previous;
    }
  });

  it("reads a remapped override back as the file's own value, not the raw one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-envremap-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ interactionMode: "research" }, null, 2));
    const previous = process.env.MOXEN_INTERACTION_MODE;
    process.env.MOXEN_INTERACTION_MODE = "plan";
    try {
      const loaded = await loadConfig(file);
      // `plan` was removed: in force it reads as Build.
      expect(loaded.config.interactionMode).toBe("default");
      // A save handed the effective value must restore the file's own, not persist the remapping.
      await saveConfig(file, { ...loaded.fileConfig, interactionMode: loaded.config.interactionMode });
      expect((JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>).interactionMode).toBe("research");
    } finally {
      if (previous === undefined) delete process.env.MOXEN_INTERACTION_MODE;
      else process.env.MOXEN_INTERACTION_MODE = previous;
    }
  });

  it("skips the backup and the rewrite when a save changes nothing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-noop-"));
    const file = path.join(dir, "config.json");
    const first = normalizeFileConfig({ projectPolicy: "existing" });
    await saveConfig(file, first);
    expect(readdirSync(dir).sort()).toEqual(["config.json"]);
    await saveConfig(file, normalizeFileConfig(JSON.parse(readFileSync(file, "utf8"))));
    expect(readdirSync(dir).sort()).toEqual(["config.json"]);
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

  it("keeps skipped entries and unknown keys together through a load, edit, and save", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moxen-config-roundtrip-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({
      futureTop: { nested: [1, 2, 3] },
      speedMode: "turbo",
      ui: { theme: "moxen", futureSection: "keep-me" },
      providers: { harness: { profiles: [{ id: "broken" }] } },
    }, null, 2));
    const loaded = await loadConfig(file);
    expect(loaded.problems.map((entry) => entry.path).sort()).toEqual(["providers.harness.profiles[broken]", "speedMode"]);
    expect((loaded.fileConfig as unknown as Record<string, unknown>).futureTop).toEqual({ nested: [1, 2, 3] });
    // Edit a known key the way the server does: fileConfig through
    // setConfigValue, skipped filtered by the edited key, then saved.
    const edited = setConfigValue(loaded.fileConfig, "ui.theme", "dracula");
    const kept = loaded.skipped.filter((entry) => !configKeyCoversPath("ui.theme", entry.path));
    await saveConfig(file, edited, kept);
    expect(readdirSync(dir).sort()).toEqual(["config.json", "config.json.bak.1"]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(onDisk.futureTop).toEqual({ nested: [1, 2, 3] });
    expect((onDisk.ui as Record<string, unknown>).futureSection).toBe("keep-me");
    expect((onDisk.ui as Record<string, unknown>).theme).toBe("dracula");
    expect(onDisk.speedMode).toBe("turbo");
    expect(((onDisk.providers as Record<string, unknown>).harness as Record<string, unknown>).profiles).toEqual([{ id: "broken" }]);
    const reread = await loadConfig(file);
    expect(reread.problems.map((entry) => entry.path).sort()).toEqual(["providers.harness.profiles[broken]", "speedMode"]);
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

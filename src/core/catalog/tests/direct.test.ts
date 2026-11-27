import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { selectModel, selectProvider } from "../summary.js";
import { buildDirectProviders } from "../direct.js";
import { clearStoredAuthCache, type LoadedServedModels } from "../../providers/opencode/catalog.js";
import { tempDir } from "../../testing/tmp.js";

function binDir(names: string[]): string {
  const dir = tempDir("moxen-bin-");
  for (const name of names) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n");
  return dir;
}

/** A stub `opencode` whose `auth list --format json` prints `list` (v2 shape). */
function opencodeBin(list: unknown[]): string {
  const dir = tempDir("moxen-bin-");
  if (process.platform === "win32") fs.writeFileSync(path.join(dir, "opencode.cmd"), `@echo off\r\necho ${JSON.stringify(list)}\r\n`);
  else fs.writeFileSync(path.join(dir, "opencode"), `#!/bin/sh\necho '${JSON.stringify(list)}'\n`, { mode: 0o755 });
  return dir;
}

/** An `opencode` stub at an explicit path; `null` makes its auth call exit non-zero. */
function opencodeAt(file: string, list: unknown[] | null): string {
  const body = list === null ? null : JSON.stringify(list);
  if (process.platform === "win32") fs.writeFileSync(file, body === null ? "@echo off\r\nexit /b 7\r\n" : `@echo off\r\necho ${body}\r\n`);
  else fs.writeFileSync(file, body === null ? "#!/bin/sh\nexit 7\n" : `#!/bin/sh\necho '${body}'\n`, { mode: 0o755 });
  return file;
}

const AUTH_ONLY_ANTHROPIC = [{ id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] }];

const MODELS_DEV = {
  catalog: [
    {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: [
        { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", reasoningOptions: [{ type: "effort", values: ["low", "high"] }], cost: { input: 5, output: 25 } },
        { id: "anthropic/plain", name: "Plain", reasoningOptions: [], cost: { input: 0, output: 0 } },
      ],
    },
  ],
  source: "snapshot" as const,
};

function tmpStore(): string {
  return tempDir("moxen-catalog-");
}

describe("buildDirectProviders", () => {
  it("exposes zero providers by default when no accounts or opt-in providers are configured", async () => {
    const providers = await buildDirectProviders({
      env: { PATH: binDir(["claude", "opencode", "codex", "agy"]) },
      storeRoot: tmpStore(),
      modelsDev: async () => MODELS_DEV,
    });
    expect(providers).toEqual([]);
  });

  it("marks missing binaries as not installed without spawning anything", async () => {
    const providers = await buildDirectProviders({
      env: { PATH: "/nonexistent" },
      storeRoot: tmpStore(),
      claude: { accounts: [{ id: "default" }] },
      opencode: { enabled: true },
      modelsDev: async () => MODELS_DEV,
    });
    const claude = providers.find((entry) => entry.instanceId === "claude/default");
    expect(claude?.installed).toBe(false);
    expect(claude?.enabled).toBe(false);
    expect(claude?.status).toBe("not installed");
    expect(providers.find((entry) => entry.driver === "codex")).toBeUndefined();
    expect(providers.map((entry) => entry.driver)).not.toContain("grok");
    const opencode = providers.find((entry) => entry.instanceId === "opencode");
    expect(opencode?.installed).toBe(false);
    expect(opencode?.enabled).toBe(false);
    expect(opencode?.models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/plain",
    ]);
    expect(opencode?.status).toBe("not installed");
  });

  it("lists pinned claude models with effort descriptors", async () => {
    const dir = binDir(["claude"]);
    const providers = await buildDirectProviders({
      env: { PATH: dir },
      storeRoot: tmpStore(),
      claude: { accounts: [{ id: "default" }] },
      modelsDev: async () => ({ catalog: [], source: "live" }),
    });
    const claude = providers.find((entry) => entry.instanceId === "claude/default");
    expect(claude?.enabled).toBe(true);
    expect(claude?.models.length).toBeGreaterThan(0);
    const opus = claude?.models.find((model) => model.slug === "claude-opus-4-6");
    expect(opus?.efforts.map((effort) => effort.id)).toContain("effort");
  });

  it("merges all models.dev providers into one addressed opencode instance", async () => {
    const live = await buildDirectProviders({
      env: {
        PATH: opencodeBin([{ id: "anthropic", name: "Anthropic", connections: [{ type: "oauth" }] }]),
        ANTHROPIC_API_KEY: "k",
      },
      storeRoot: tmpStore(),
      opencode: { enabled: true },
      modelsDev: async () => MODELS_DEV,
    });
    // Categorized per-provider entry (credentialed: everything) …
    const section = live.find((entry) => entry.instanceId === "opencode/anthropic");
    expect(section?.enabled).toBe(true);
    expect(section?.status).toBe("models.dev snapshot");
    expect(section?.authStatus).toBe("oauth");
    expect(section?.models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/plain",
    ]);
    // … plus the hidden compat shell for legacy addressing.
    const compat = live.find((entry) => entry.instanceId === "opencode");
    expect(compat?.enabled).toBe(false);
    expect(compat?.models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/plain",
    ]);
    expect(compat?.models.every((model) => model.isHidden)).toBe(true);
  });

  it("lists a provider that is not connected as disabled, with no models to pick", async () => {
    const providers = await buildDirectProviders({
      env: { PATH: opencodeBin([]) },
      storeRoot: tmpStore(),
      opencode: { enabled: true },
      modelsDev: async () => MODELS_DEV,
    });
    const section = providers.find((entry) => entry.instanceId === "opencode/anthropic");
    expect(section?.enabled).toBe(false);
    expect(section?.authStatus).toBeNull();
    expect(section?.status).toBe("not connected (set ANTHROPIC_API_KEY or run opencode auth login)");
    expect(section?.models).toEqual([]);
  });

  const ZEN = {
    catalog: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        env: ["OPENCODE_API_KEY"],
        models: [
          { id: "free-one", name: "Free", reasoningOptions: [], cost: { input: 0, output: 0 } },
          { id: "retired-free", name: "Retired", reasoningOptions: [], cost: { input: 0, output: 0 } },
          { id: "paid-one", name: "Paid", reasoningOptions: [], cost: { input: 3, output: 15 } },
        ],
      },
    ],
    source: "live" as const,
  };
  const zenOf = async (env: NodeJS.ProcessEnv, served: () => Promise<LoadedServedModels>) =>
    (await buildDirectProviders({ env: { PATH: opencodeBin([]), ...env }, storeRoot: tmpStore(), opencode: { enabled: true }, modelsDev: async () => ZEN, opencodeServed: served })).find((entry) => entry.instanceId === "opencode/opencode");

  it("keeps OpenCode's own free tier without a login: zero-cost models it still serves", async () => {
    const zen = await zenOf({}, async () => ({ ids: new Set(["free-one", "paid-one"]), source: "live" }));
    expect(zen?.enabled).toBe(true);
    expect(zen?.status).toBe("free models only (connect it for all 3)");
    expect(zen?.models.map((model) => model.slug)).toEqual(["opencode/free-one"]);
  });

  it("falls back to every zero-cost model when OpenCode's list cannot be read, and says so", async () => {
    const zen = await zenOf({}, async () => ({ ids: null, source: "none" }));
    expect(zen?.models.map((model) => model.slug)).toEqual(["opencode/free-one", "opencode/retired-free"]);
    expect(zen?.status).toMatch(/could not be read, so some may be retired$/);
    const stale = await zenOf({}, async () => ({ ids: new Set(["free-one"]), source: "stale" }));
    expect(stale?.models.map((model) => model.slug)).toEqual(["opencode/free-one"]);
    expect(stale?.status).toMatch(/out of date$/);
  });

  it("offers no free tier under OPENCODE_DISABLE_FREE_MODELS, and asks nothing of the network", async () => {
    let asked = false;
    const zen = await zenOf({ OPENCODE_DISABLE_FREE_MODELS: "1" }, async () => {
      asked = true;
      return { ids: null, source: "none" };
    });
    expect(zen?.enabled).toBe(false);
    expect(zen?.models).toEqual([]);
    expect(zen?.status).toMatch(/OPENCODE_DISABLE_FREE_MODELS/);
    expect(asked).toBe(false);
  });

  it("lists everything once connected, without reading the served list", async () => {
    let asked = false;
    const zen = await zenOf({ OPENCODE_API_KEY: "set" }, async () => {
      asked = true;
      return { ids: null, source: "none" };
    });
    expect(zen?.models).toHaveLength(3);
    expect(asked).toBe(false);
  });

  it("prefixes bare source ids with their provider", async () => {
    const providers = await buildDirectProviders({
      env: { PATH: binDir(["opencode"]) },
      storeRoot: tmpStore(),
      opencode: { enabled: true },
      modelsDev: async () => ({
        catalog: [
          { id: "zen", name: "Zen", env: ["ZEN_KEY"], models: [{ id: "bare-model", name: "Bare", reasoningOptions: [], cost: null }] },
        ],
        source: "live" as const,
      }),
    });
    const entry = providers.find((item) => item.instanceId === "opencode");
    expect(entry?.models.map((model) => model.slug)).toEqual(["zen/bare-model"]);
  });

  it("finds a configured OpenCode executable outside PATH, and asks it for credentials", async () => {
    clearStoredAuthCache();
    const binary = opencodeAt(path.join(tempDir("moxen-config-bin-"), process.platform === "win32" ? "opencode.cmd" : "opencode"), AUTH_ONLY_ANTHROPIC);
    const providers = await buildDirectProviders({
      env: { PATH: "/nonexistent" },
      opencode: { enabled: true },
      opencodeBinaryPath: binary,
      storeRoot: tmpStore(),
      modelsDev: async () => MODELS_DEV,
    });
    const section = providers.find((entry) => entry.instanceId === "opencode/anthropic");
    expect(section?.installed).toBe(true);
    expect(section?.enabled).toBe(true);
    expect(section?.authStatus).toBe("api-key");
    expect(section?.models).toHaveLength(2);
    clearStoredAuthCache();
  });

  it("keeps a provider a usage reading proves ran when the credential probe never answers", async () => {
    clearStoredAuthCache();
    const binary = opencodeAt(path.join(tempDir("moxen-auth-bin-"), process.platform === "win32" ? "opencode.cmd" : "opencode"), null);
    const providers = await buildDirectProviders({
      env: { PATH: "/nonexistent" },
      opencode: { enabled: true },
      opencodeBinaryPath: binary,
      storeRoot: tmpStore(),
      modelsDev: async () => MODELS_DEV,
      usageLimits: () => ({
        "opencode/anthropic": {
          checkedAt: "2026-11-19T00:00:00.000Z",
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 10, resetsAt: null }],
          unavailable: null,
        },
      }),
    });
    const section = providers.find((entry) => entry.instanceId === "opencode/anthropic");
    expect(section?.installed).toBe(true);
    expect(section?.enabled).toBe(true);
    expect(section?.authStatus).toBe("unknown");
    expect(section?.status).toMatch(/credentials unknown .*usage reading/);
    expect(section?.models).toHaveLength(2);
    clearStoredAuthCache();
  });

  it("keeps selectProvider/selectModel error codes on direct output", async () => {
    const providers = await buildDirectProviders({
      env: { PATH: "/nonexistent" },
      storeRoot: tmpStore(),
      opencode: { enabled: true },
      modelsDev: async () => MODELS_DEV,
    });
    expect(() => selectProvider(providers, "nope")).toThrowError(expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }));
    const opencode = selectProvider(providers, "opencode");
    expect(() => selectModel(opencode, "nope")).toThrowError(expect.objectContaining({ code: "MODEL_NOT_FOUND" }));
    expect(selectModel(opencode, "anthropic/plain").name).toBe("Plain");
  });
});

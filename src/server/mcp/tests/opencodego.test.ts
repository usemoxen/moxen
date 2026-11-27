/**
 * MXN-402: the agent tools list OpenCode Go on a cold start whose credential
 * probe does not answer. `models` (with and without a provider filter) and
 * `usage_status` must both see it, with its visible models and an
 * unconfirmed-auth note. The catalog row is the real one `buildDirectProviders`
 * builds, not a hand-made ProviderSummary.
 *
 * Round 9: a stored usage reading is not required. The first cold start on a
 * machine — no cached auth, no usage window ever recorded — is exactly when
 * the list matters most, so Go stays discoverable with `authStatus: "unknown"`
 * rather than being hidden until something proves it runs.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDirectProviders } from "../../../core/catalog/direct.js";
import type { ProviderUsageLimits, ProviderSummary } from "../../../core/catalog/summary.js";
import { clearStoredAuthCache, type ModelsDevCatalog } from "../../../core/providers/opencode/catalog.js";
import { tempDir } from "../../../core/testing/tmp.js";
import { recordUsageWindows, resetUsageLimitsForTests, usageLimitsSnapshot } from "../../../core/usage/limits.js";
import type { ClientApi } from "../../api.js";
import { callMoxenTool } from "../tools.js";

const CATALOG: ModelsDevCatalog = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    models: [{ id: "glm-free", name: "GLM Free", reasoningOptions: [], cost: { input: 0, output: 0 } }],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    env: ["OPENCODE_API_KEY"],
    models: [
      { id: "glm-5", name: "GLM-5", reasoningOptions: [{ type: "effort", values: ["low", "high"] }], cost: { input: 1, output: 4 } },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoningOptions: [{ type: "effort", values: ["low", "high", "max"] }], cost: { input: 1, output: 2 } },
    ],
  },
];

/** An `opencode` on PATH whose `auth list` exits non-zero: the cold-start probe. */
function brokenOpencodeDir(): string {
  const dir = tempDir("moxen-broken-open-");
  const file = path.join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") fs.writeFileSync(file, "@echo off\r\nexit /b 7\r\n");
  else fs.writeFileSync(file, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  return dir;
}

/** An `opencode` on PATH that exits cleanly and prints something that is not a credential list. */
function malformedOpencodeDir(): string {
  const dir = tempDir("moxen-malformed-open-");
  const file = path.join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") fs.writeFileSync(file, "@echo off\r\necho not-json\r\n");
  else fs.writeFileSync(file, "#!/bin/sh\necho not-json\n", { mode: 0o755 });
  return dir;
}

/** An `opencode` on PATH that answers an explicit logout, which is not a failed probe. */
function logoutOpencodeDir(): string {
  const dir = tempDir("moxen-logout-open-");
  const file = path.join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") fs.writeFileSync(file, "@echo off\r\necho []\r\n");
  else fs.writeFileSync(file, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  return dir;
}

function apiOf(providers: ProviderSummary[], usage: Record<string, ProviderUsageLimits>): ClientApi {
  return {
    query: async (query: { type: string }) => {
      switch (query.type) {
        case "providers.list":
          return { providers };
        case "config.read":
          return { config: {} };
        case "usage.limits":
        case "usage.refresh":
          return { providers: usage };
        case "usage.protection":
          return { forecasts: [], queue: [] };
        case "thread.inspect":
          return { project: null, thread: { modelSelection: { instanceId: "opencode/opencode-go", model: "opencode-go/glm-5" } } };
        default:
          throw new Error(`unexpected query ${query.type}`);
      }
    },
  } as unknown as ClientApi;
}

/** The real catalog, with a cold process cache, a broken probe, and Go's windows on record. */
async function coldStartProviders(bin: () => string = brokenOpencodeDir, opencode: { enabled: boolean } = { enabled: true }): Promise<ProviderSummary[]> {
  return await buildDirectProviders({
    env: { PATH: bin() },
    opencode,
    storeRoot: tempDir("moxen-cold-store-"),
    modelsDev: async () => ({ catalog: CATALOG, source: "snapshot" }),
    opencodeServed: async () => ({ ids: null, source: "none" }),
  });
}

beforeEach(() => {
  resetUsageLimitsForTests();
  clearStoredAuthCache();
  recordUsageWindows("opencode/opencode-go", [
    { id: "session", label: "Session", usedPercent: 3, resetsAt: null, exhausted: false },
    { id: "weekly", label: "Weekly", usedPercent: 55, resetsAt: null, exhausted: false },
    { id: "monthly", label: "Monthly", usedPercent: 63, resetsAt: null, exhausted: false },
  ]);
});

afterEach(() => {
  resetUsageLimitsForTests();
  clearStoredAuthCache();
});

describe("OpenCode Go on a cold start whose credential probe fails", () => {
  it("is listed by models, by name and in the whole catalog, with its models and efforts", async () => {
    const providers = await coldStartProviders();
    const go = providers.find((provider) => provider.instanceId === "opencode/opencode-go");
    expect(go).toMatchObject({ installed: true, enabled: true, authStatus: "unknown" });
    expect(go?.models.map((model) => model.slug)).toEqual(["opencode-go/glm-5", "opencode-go/deepseek-v4.1-flash"]);

    const api = apiOf(providers, usageLimitsSnapshot());
    const one = await callMoxenTool(api, "parent", "models", { provider: "opencode/opencode-go" });
    expect(one.isError).toBe(false);
    expect(JSON.parse(one.text)).toEqual({
      providers: [{
        provider: "opencode/opencode-go",
        name: "OpenCode Go",
        authStatus: "unknown",
        authNote: "Moxen could not read this provider's credential store, so its login is unconfirmed. Delegating may still work.",
        models: [
          { model: "opencode-go/glm-5", name: "GLM-5", efforts: ["low", "high"] },
          { model: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", efforts: ["low", "high", "max"] },
        ],
      }],
    });

    const all = JSON.parse((await callMoxenTool(api, "parent", "models", {})).text) as { providers: Array<{ provider: string }> };
    expect(all.providers.map((row) => row.provider)).toContain("opencode/opencode-go");
  });

  it("reports OpenCode Go's windows in usage_status", async () => {
    const providers = await coldStartProviders();
    const result = await callMoxenTool(apiOf(providers, usageLimitsSnapshot()), "parent", "usage_status", {}, { usageRefreshMs: 20 });
    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.text) as {
      providers: Array<{ provider: string; authStatus?: string; authNote?: string; windows: Array<{ id: string; usedPercent: number }> }>;
    };
    const go = answer.providers.find((row) => row.provider === "opencode/opencode-go");
    expect(go?.authStatus).toBe("unknown");
    expect(go?.authNote).toMatch(/login is unconfirmed/i);
    expect(go?.windows.map((window) => [window.id, window.usedPercent])).toEqual([["session", 3], ["weekly", 55], ["monthly", 63]]);
  });
});

/**
 * The first run on a machine: nothing has ever been read or recorded. A probe
 * that cannot answer must not hide the provider — that is the state in which
 * the agent most needs to see what it can run work on.
 */
describe("OpenCode Go on a cold start with no saved usage at all", () => {
  beforeEach(() => {
    // Zero saved usage windows: no stored reading is available as evidence.
    resetUsageLimitsForTests();
    expect(usageLimitsSnapshot()).toEqual({});
  });

  it("is listed by models with its models and an unconfirmed-auth note", async () => {
    const providers = await coldStartProviders();
    const go = providers.find((provider) => provider.instanceId === "opencode/opencode-go");
    expect(go).toMatchObject({ installed: true, enabled: true, authStatus: "unknown" });
    expect(go?.models.map((model) => model.slug)).toEqual(["opencode-go/glm-5", "opencode-go/deepseek-v4.1-flash"]);

    const api = apiOf(providers, usageLimitsSnapshot());
    const one = await callMoxenTool(api, "parent", "models", { provider: "opencode/opencode-go" });
    expect(one.isError).toBe(false);
    expect(JSON.parse(one.text)).toEqual({
      providers: [{
        provider: "opencode/opencode-go",
        name: "OpenCode Go",
        authStatus: "unknown",
        authNote: "Moxen could not read this provider's credential store, so its login is unconfirmed. Delegating may still work.",
        models: [
          { model: "opencode-go/glm-5", name: "GLM-5", efforts: ["low", "high"] },
          { model: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", efforts: ["low", "high", "max"] },
        ],
      }],
    });

    const all = JSON.parse((await callMoxenTool(api, "parent", "models", {})).text) as { providers: Array<{ provider: string }> };
    expect(all.providers.map((row) => row.provider)).toContain("opencode/opencode-go");
  });

  it("is listed by usage_status with its auth state and no windows, not hidden", async () => {
    const providers = await coldStartProviders();
    const result = await callMoxenTool(apiOf(providers, usageLimitsSnapshot()), "parent", "usage_status", {}, { usageRefreshMs: 20 });
    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.text) as {
      providers: Array<{ provider: string; authStatus?: string; authNote?: string; windows: unknown[]; note?: string }>;
    };
    const go = answer.providers.find((row) => row.provider === "opencode/opencode-go");
    expect(go).toMatchObject({ authStatus: "unknown" });
    expect(go?.authNote).toMatch(/login is unconfirmed/i);
    expect(go?.windows).toEqual([]);
    expect(go?.note).toMatch(/No usage reported/);
  });

  it("holds for a probe that answers something that is not a credential list", async () => {
    const providers = await coldStartProviders(malformedOpencodeDir);
    const go = providers.find((provider) => provider.instanceId === "opencode/opencode-go");
    expect(go).toMatchObject({ installed: true, enabled: true, authStatus: "unknown" });
    expect(go?.models).toHaveLength(2);
    const result = await callMoxenTool(apiOf(providers, usageLimitsSnapshot()), "parent", "usage_status", {}, { usageRefreshMs: 20 });
    const answer = JSON.parse(result.text) as { providers: Array<{ provider: string }> };
    expect(answer.providers.map((row) => row.provider)).toContain("opencode/opencode-go");
  });

  it("still narrows to PROVIDER_NOT_FOUND when the probe answers an explicit logout", async () => {
    // A readable empty list is a confirmed logout, not an unreadable probe:
    // the disagreement is what keeps "unknown" from meaning "logged in".
    const providers = await coldStartProviders(logoutOpencodeDir);
    const go = providers.find((provider) => provider.instanceId === "opencode/opencode-go");
    expect(go).toMatchObject({ installed: true, enabled: false, authStatus: null });
    expect(go?.models).toEqual([]);
    const one = await callMoxenTool(apiOf(providers, usageLimitsSnapshot()), "parent", "models", { provider: "opencode/opencode-go" });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("PROVIDER_NOT_FOUND");
  });

  it("keeps OpenCode out entirely while providers.opencode.enabled is false", async () => {
    const providers = await coldStartProviders(brokenOpencodeDir, { enabled: false });
    expect(providers.filter((provider) => provider.driver === "opencode")).toEqual([]);
    const one = await callMoxenTool(apiOf(providers, usageLimitsSnapshot()), "parent", "models", { provider: "opencode/opencode-go" });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("PROVIDER_NOT_FOUND");
  });
});

/**
 * MXN-402: the agent tools list OpenCode Go on a cold start whose credential
 * probe does not answer. A stored usage reading proves the provider runs
 * here, so the catalog keeps its models and reports the auth state unknown;
 * `models` (with and without a provider filter) and `usage_status` must both
 * see it, with its windows. The catalog row is the real one `buildDirectProviders`
 * builds, not a hand-made ProviderSummary.
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
async function coldStartProviders(): Promise<ProviderSummary[]> {
  return await buildDirectProviders({
    env: { PATH: brokenOpencodeDir() },
    opencode: { enabled: true },
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

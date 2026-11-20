import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { updateProvider } from "../../update.js";
import { FakeAcpTransport } from "../../acp/tests/fakes.js";
import { antigravityProvider, disambiguateAntigravityModelName, forgetAntigravityCatalogCache } from "../catalog.js";
import { ANTIGRAVITY_DEFAULT_MODEL_SLUG, antigravityLaunchSpec } from "../config.js";
import {
  ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS,
  antigravityQuotaWindowForModel,
  forgetAntigravityUsageCache,
  parseAntigravityCreditsJson,
  parseAntigravityQuotaError,
  parseAntigravityTier,
  parseAntigravityUsageJson,
  probeAntigravityUsage,
} from "../usage.js";

const tempDirs: string[] = [];
afterEach(async () => {
  forgetAntigravityCatalogCache();
  forgetAntigravityUsageCache();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("Antigravity first-class provider", () => {
  it("builds an unmodified agy acp launch spec with optional binaryPath and tokenized launchArgs", () => {
    expect(antigravityLaunchSpec(undefined)).toEqual({
      id: "antigravity",
      name: "Antigravity",
      command: "agy",
      args: ["acp"],
    });
    expect(antigravityLaunchSpec({ binaryPath: "/opt/bin/agy", launchArgs: '--flag "two words"' })).toEqual({
      id: "antigravity",
      name: "Antigravity",
      command: "/opt/bin/agy",
      args: ["acp", "--flag", "two words"],
    });
  });

  it("probes agy acp via initialize without creating sessions and exposes Antigravity as a first-class provider", async () => {
    const transport = new FakeAcpTransport({
      authMethods: [{ id: "oauth", name: "Google login" }],
    });
    const summary = await antigravityProvider(
      { binaryPath: "agy" },
      process.env,
      process.cwd(),
      transport,
    );
    expect(summary).toMatchObject({
      instanceId: "antigravity",
      driver: "antigravity",
      displayName: "Antigravity",
      installed: true,
      enabled: true,
      authStatus: "oauth",
    });
    expect(summary.models.map((m) => m.slug)).toEqual([ANTIGRAVITY_DEFAULT_MODEL_SLUG]);
    expect(transport.sessions[0]?.server.requestsTo("initialize")).toHaveLength(1);
    expect(transport.sessions[0]?.server.requestsTo("session/new")).toEqual([]);
  });

  it("discovers live Antigravity models and per-model efforts via session/new + session/close and caches them", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "moxen-agy-cache-"));
    tempDirs.push(storeRoot);
    const transport = new FakeAcpTransport({
      version: "1.5.13",
      canCloseSession: true,
      configOptions: [
        {
          id: "model",
          category: "model",
          name: "Model",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-4-argon", name: "Gemini 4 Argon" },
            { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
            { value: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
            { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          name: "Thought Level",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" },
          ],
        },
      ],
      models: {
        currentModelId: "gemini-4-neon-high",
        availableModels: [
          { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
          { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
          { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (Extra)" },
          { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
          { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
          { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
          { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
          { modelId: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
          { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
    });

    const summary = await antigravityProvider({ binaryPath: "agy" }, process.env, process.cwd(), transport, { storeRoot });
    // Internal Orchestrator models are omitted from the offered catalog; GPT-OSS stays with empty efforts.
    expect(summary.models.map((m) => m.slug)).toEqual([
      "gemini-4-neon",
      "gemini-4-argon",
      "gpt-oss-120b-medium",
    ]);
    expect(summary.models[0]).toMatchObject({
      slug: "gemini-4-neon",
      name: "Gemini 4 Neon",
      isDefault: true,
      efforts: [
        {
          id: "effort",
          label: "Thought Level",
          choices: [
            { id: "low", label: "Low", isDefault: null },
            { id: "medium", label: "Medium", isDefault: null },
            { id: "high", label: "High", isDefault: true },
            { id: "xhigh", label: "Extra", isDefault: null },
          ],
        },
      ],
    });
    expect(summary.models[1]?.efforts[0]?.choices.map((e) => e.id)).toEqual(["low", "medium", "high"]);
    expect(summary.models[2]?.efforts).toEqual([]);
    expect(transport.sessions[0]?.server.requestsTo("session/new")).toHaveLength(1);
    expect(transport.sessions[0]?.server.requestsTo("session/close")).toHaveLength(1);

    // Second discovery with the same agent version reuses the in-memory cache without creating another session.
    const cached = await antigravityProvider({ binaryPath: "agy" }, process.env, process.cwd(), transport, { storeRoot });
    expect(cached.models).toEqual(summary.models);
    expect(transport.sessions[1]?.server.requestsTo("session/new")).toEqual([]);

    // After clearing in-memory cache, the on-disk cache under storeRoot still avoids another session.
    forgetAntigravityCatalogCache();
    const fromDisk = await antigravityProvider({ binaryPath: "agy" }, process.env, process.cwd(), transport, { storeRoot });
    expect(fromDisk.models).toEqual(summary.models);
    expect(transport.sessions[2]?.server.requestsTo("session/new")).toEqual([]);
  });

  it("surfaces pinned ACP v1 protocol version mismatches on Antigravity", async () => {
    const transport = new FakeAcpTransport({ protocolVersion: 2 });
    const summary = await antigravityProvider(undefined, process.env, process.cwd(), transport);
    expect(summary.enabled).toBe(false);
    expect(summary.status).toMatch(/protocol v2.*only supports ACP protocol v1/i);
  });

  it("updates Antigravity by running agy update without a shell", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    let version = "1.2.3";
    const result = await updateProvider("antigravity", {
      binaryPath: "/custom/agy",
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "--version") return { exitCode: 0, stdout: `${version}\n`, stderr: "" };
        version = "1.3.0";
        return { exitCode: 0, stdout: "Updated Antigravity to 1.3.0\n", stderr: "" };
      },
    });
    expect(calls).toEqual([
      { command: "/custom/agy", args: ["--version"] },
      { command: "/custom/agy", args: ["update"] },
      { command: "/custom/agy", args: ["--version"] },
    ]);
    expect(result).toMatchObject({
      provider: "antigravity",
      before: "1.2.3",
      after: "1.3.0",
      updated: true,
    });
  });

  it("disambiguates non-Gemini Antigravity models and surfaces _meta.antigravity.tier.name as authStatus", async () => {
    expect(disambiguateAntigravityModelName("Gemini 4 Neon")).toBe("Gemini 4 Neon");
    expect(disambiguateAntigravityModelName("Claude Sonnet 5.5")).toBe("Claude Sonnet 5.5 (Antigravity)");
    expect(disambiguateAntigravityModelName("Claude Sonnet 5.5 (Antigravity)")).toBe("Claude Sonnet 5.5 (Antigravity)");
    expect(disambiguateAntigravityModelName("GPT-OSS 120B (Medium)")).toBe("GPT-OSS 120B (Medium, Antigravity)");

    const transport = new FakeAcpTransport({
      canCloseSession: true,
      sessionMeta: { antigravity: { tier: { name: "Google AI Pro" } } },
      configOptions: [
        {
          id: "model",
          category: "model",
          name: "Model",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
            { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
          ],
        },
      ],
    });
    const summary = await antigravityProvider({ binaryPath: "agy" }, process.env, process.cwd(), transport);
    expect(summary.authStatus).toBe("Google AI Pro");
    expect(summary.models.map((m) => [m.slug, m.name])).toEqual([
      ["gemini-4-neon", "Gemini 4 Neon"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5 (Antigravity)"],
      ["claude-opus-5-5", "Claude Opus 5.5 (Antigravity)"],
    ]);
  });

  it("parses agy /usage and /credits JSON into Moxen rate-limit windows and credits", async () => {
    const usageJson = JSON.stringify({
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.565, reset_time: "2026-11-27T03:05:29Z" },
                { id: "gemini-5h", window: "5h", remaining_fraction: 0.2, reset_time: "2026-11-20T18:16:16Z" },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-5h", window: "5h", remaining_fraction: 0, reset_time: "2026-11-20T20:34:39Z" },
              ],
            },
            {
              name: "Gemini 4 Argon",
              buckets: [
                { id: "gemini-argon-wtu-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-27T15:49:49Z" },
              ],
            },
          ],
        },
      },
    });
    const creditsJson = JSON.stringify({
      command: { name: "credits", data: { remaining_credits: 42 } },
    });

    expect(parseAntigravityUsageJson(usageJson)).toEqual([
      { id: "gemini-weekly", label: "Weekly – Gemini", usedPercent: 43.5, exhausted: false, resetsAt: "2026-11-27T03:05:29.000Z" },
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 80, exhausted: false, resetsAt: "2026-11-20T18:16:16.000Z" },
      { id: "3p-5h", label: "Session – Claude & GPT", usedPercent: 100, exhausted: true, resetsAt: "2026-11-20T20:34:39.000Z" },
      { id: "gemini-argon-wtu-weekly", label: "Weekly – Argon", usedPercent: 0, exhausted: false, resetsAt: "2026-11-27T15:49:49.000Z" },
    ]);
    expect(parseAntigravityCreditsJson(creditsJson)).toBe(42);
    expect(parseAntigravityTier({ _meta: { antigravity: { tier: { name: "Google AI Ultra" } } } })).toBe("Google AI Ultra");

    const probed = await probeAntigravityUsage("agy", process.env, {
      run: async (_cmd, args) => (args.includes("/usage") ? usageJson : creditsJson),
    });
    expect(probed).toMatchObject({ credits: 42 });
    expect(probed?.windows).toHaveLength(4);
  });

  it("chains a fresh probe when force: true arrives during an in-flight probe and bounds probe timeout <= 6s", async () => {
    expect(ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(6_000);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callNum = 0;
    const creditsPayload = (n: number) => JSON.stringify({ command: { name: "credits", data: { remaining_credits: n } } });
    const usagePayload = JSON.stringify({ command: { name: "usage", data: { groups: [] } } });
    const run = async (_cmd: string, args: readonly string[]): Promise<string | null> => {
      if (args.includes("/usage")) return usagePayload;
      callNum += 1;
      if (callNum === 1) {
        await firstGate;
        return creditsPayload(100);
      }
      return creditsPayload(85);
    };

    const p1 = probeAntigravityUsage("agy-force-test", process.env, { run, useCache: true });
    // Coalesce a second non-forced call onto p1.
    const p1Dup = probeAntigravityUsage("agy-force-test", process.env, { run, useCache: true });
    // A forced call while p1 is still in flight must NOT return p1's stale result.
    const pForced = probeAntigravityUsage("agy-force-test", process.env, { run, useCache: true, force: true });
    releaseFirst();

    const [r1, r1Dup, rForced] = await Promise.all([p1, p1Dup, pForced]);
    expect(r1?.credits).toBe(100);
    expect(r1Dup?.credits).toBe(100);
    expect(rForced?.credits).toBe(85);
    expect(callNum).toBe(2);
  });

  it("parses Antigravity quota-exhaustion warning messages and maps them to model pools without false positives (MXN-454)", () => {
    const now = Date.parse("2026-11-20T22:59:08.000Z");
    const observed = parseAntigravityQuotaError(
      "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 17m8s.\n",
      now,
    );
    expect(observed).toEqual({
      message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 17m8s.",
      resetsAt: "2026-11-20T23:16:16.000Z",
      pureWarning: true,
    });

    const withProse = parseAntigravityQuotaError(
      "Checked the first file.\n\n⚠ You have exhausted your capacity on this model. Your quota will reset after 2h15m.\n",
      now,
    );
    expect(withProse).toEqual({
      message: "You have exhausted your capacity on this model. Your quota will reset after 2h15m.",
      resetsAt: "2026-11-21T01:14:08.000Z",
      pureWarning: false,
    });

    const noDuration = parseAntigravityQuotaError("⚠ Quota has been exceeded. Please try again later.", now);
    expect(noDuration).toEqual({
      message: "Quota has been exceeded. Please try again later.",
      resetsAt: null,
      pureWarning: true,
    });

    // Normal assistant prose discussing quota errors must never trigger false positives.
    expect(
      parseAntigravityQuotaError(
        "I fixed the bug where '⚠ Individual quota reached. Resets in 17m8s.' completed normally.",
        now,
      ),
    ).toBeNull();
    expect(
      parseAntigravityQuotaError(
        "⚠ Individual quota reached. Resets in 17m8s.\nHere is how we handle that error in the driver.",
        now,
      ),
    ).toBeNull();

    // JSON-RPC error strings without the warning glyph still match when requireWarningPrefix is false.
    expect(
      parseAntigravityQuotaError("RESOURCE_EXHAUSTED: Individual quota reached. Resets in 45s.", now, {
        requireWarningPrefix: false,
      }),
    ).toEqual({
      message: "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 45s.",
      resetsAt: "2026-11-20T22:59:53.000Z",
      pureWarning: true,
    });

    expect(antigravityQuotaWindowForModel("gemini-4-neon", "2026-11-20T23:16:16.000Z", now)).toEqual({
      id: "gemini-5h",
      label: "Session – Gemini",
      usedPercent: 100,
      exhausted: true,
      resetsAt: "2026-11-20T23:16:16.000Z",
    });
    expect(antigravityQuotaWindowForModel("claude-sonnet-5-5", "2026-11-20T23:16:16.000Z", now)).toEqual({
      id: "3p-5h",
      label: "Session – Claude & GPT",
      usedPercent: 100,
      exhausted: true,
      resetsAt: "2026-11-20T23:16:16.000Z",
    });
    expect(antigravityQuotaWindowForModel("gemini-4-neon", "2026-11-23T00:00:00.000Z", now)).toEqual({
      id: "gemini-weekly",
      label: "Weekly – Gemini",
      usedPercent: 100,
      exhausted: true,
      resetsAt: "2026-11-23T00:00:00.000Z",
    });
  });
});

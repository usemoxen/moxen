import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { updateProvider } from "../../update.js";
import { FakeAcpTransport } from "../../acp/tests/fakes.js";
import { antigravityProvider, forgetAntigravityCatalogCache } from "../catalog.js";
import { ANTIGRAVITY_DEFAULT_MODEL_SLUG, antigravityLaunchSpec } from "../config.js";

const tempDirs: string[] = [];
afterEach(async () => {
  forgetAntigravityCatalogCache();
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
        ],
      },
    });

    const summary = await antigravityProvider({ binaryPath: "agy" }, process.env, process.cwd(), transport, { storeRoot });
    expect(summary.models.map((m) => m.slug)).toEqual([
      "gemini-4-neon",
      "gemini-4-argon",
      "gemini-pro-orchestrator-neon",
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
});

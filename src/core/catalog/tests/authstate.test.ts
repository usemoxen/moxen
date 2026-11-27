/**
 * MXN-402 round 2: a credential read once does not stay "current" forever.
 * When the probe stops answering, the provider must stay listed and
 * delegable, but its auth state says unverified — at once, at the trust
 * bound, and 30 days later — until a later answer replaces it.
 *
 * Round 5 adds the concurrent-probe and duplicate-row sequences at the
 * catalog-query level, through the same public `buildDirectProviders` seam.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDirectProviders } from "../direct.js";
import { AUTH_LIST_CACHE_TTL_MS, OPENCODE_AUTH_TRUST_MS, clearStoredAuthCache } from "../../providers/opencode/catalog.js";
import { tempDir } from "../../testing/tmp.js";

const MODELS_DEV = {
  catalog: [
    {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: [
        { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", reasoningOptions: [], cost: { input: 5, output: 25 } },
        { id: "anthropic/plain", name: "Plain", reasoningOptions: [], cost: { input: 0, output: 0 } },
      ],
    },
  ],
  source: "snapshot" as const,
};

function authOnlyAnthropicStub(): string {
  const file = path.join(tempDir("moxen-stale-bin-"), process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") fs.writeFileSync(file, "@echo off\r\nexit /b 0\r\n");
  else fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

describe("credential verification age", () => {
  it("marks a credential unverified at once and past the trust bound, and never revives it by age", async () => {
    clearStoredAuthCache();
    const binary = authOnlyAnthropicStub();
    let clock = Date.parse("2026-11-19T00:00:00.000Z");
    let mono = 1_000;
    const advance = (ms: number) => { clock += ms; mono += ms; };
    let reply: string | null = JSON.stringify([{ id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] }]);
    const section = async () => {
      const providers = await buildDirectProviders({
        env: { PATH: "/nonexistent" },
        opencode: { enabled: true },
        opencodeBinaryPath: binary,
        storeRoot: tempDir("moxen-stale-store-"),
        modelsDev: async () => MODELS_DEV,
        storedAuth: { run: async () => reply, now: () => clock, monotonic: () => mono },
      });
      return providers.find((entry) => entry.instanceId === "opencode/anthropic");
    };
    expect(await section()).toMatchObject({ installed: true, enabled: true, authStatus: "api-key" });
    expect((await section())?.models).toHaveLength(2);

    // The credential store stops answering: stale from the first failed probe.
    reply = null;
    advance(3_600_000);
    const hour = await section();
    expect(hour).toMatchObject({ enabled: true, authStatus: "unverified" });
    expect(hour?.models).toHaveLength(2);
    expect(hour?.status).toMatch(/credentials unverified \(last confirmed 1h ago\)/);

    // At and past the trust bound the provider stays listed and delegable.
    advance(OPENCODE_AUTH_TRUST_MS);
    expect(await section()).toMatchObject({ enabled: true, authStatus: "unverified" });
    advance(30 * 24 * 3_600_000);
    const month = await section();
    expect(month).toMatchObject({ enabled: true, authStatus: "unverified" });
    expect(month?.models).toHaveLength(2);

    // A later answer, including "no credentials", replaces the state on the
    // next probe (after the short window in which a settled attempt is served).
    reply = "[]";
    advance(AUTH_LIST_CACHE_TTL_MS);
    const cleared = await section();
    expect(cleared).toMatchObject({ enabled: false, authStatus: null });
    expect(cleared?.models).toEqual([]);
    clearStoredAuthCache();
  });

  it("does not serve an older login as freshly confirmed after a newer concurrent probe failed", async () => {
    clearStoredAuthCache();
    const binary = authOnlyAnthropicStub();
    let clock = 1_000;
    let mono = 1_000;
    const advance = (ms: number) => { clock += ms; mono += ms; };
    const login = JSON.stringify([{ id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] }]);
    const releases: Array<() => void> = [];
    const startResolvers: Array<() => void> = [];
    const starts = [0, 1].map(() => new Promise<void>((resolve) => startResolvers.push(resolve)));
    let calls = 0;
    const run = async () => {
      const index = calls++;
      startResolvers[index]!();
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
      return index === 0 ? login : null;
    };
    const build = () =>
      buildDirectProviders({
        env: { PATH: "/nonexistent" },
        opencode: { enabled: true },
        opencodeBinaryPath: binary,
        storeRoot: tempDir("moxen-race-store-"),
        modelsDev: async () => MODELS_DEV,
        storedAuth: { run, now: () => clock, monotonic: () => mono },
      });
    // A starts first (a login) and B starts while A is pending (a failure).
    const a = build();
    const b = build();
    await Promise.all(starts);
    releases[0]!();
    const older = (await a).find((entry) => entry.instanceId === "opencode/anthropic");
    expect(older).toMatchObject({ installed: true, enabled: true });
    releases[1]!();
    await b;
    // Inside the 15s after B settled: the catalog must not call the login confirmed.
    advance(1_000);
    const after = (await build()).find((entry) => entry.instanceId === "opencode/anthropic");
    expect(after).toMatchObject({ enabled: true, authStatus: "unverified" });
    expect(after?.models).toHaveLength(2);
    clearStoredAuthCache();
  });

  it("a wall-clock rollback does not revive a login past the trust bound", async () => {
    clearStoredAuthCache();
    const binary = authOnlyAnthropicStub();
    let wall = 1_000;
    let mono = 1_000;
    let reply: string | null = JSON.stringify([{ id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] }]);
    let calls = 0;
    const section = async () => {
      const providers = await buildDirectProviders({
        env: { PATH: "/nonexistent" },
        opencode: { enabled: true },
        opencodeBinaryPath: binary,
        storeRoot: tempDir("moxen-rollback-store-"),
        modelsDev: async () => MODELS_DEV,
        storedAuth: {
          run: async () => {
            calls += 1;
            return reply;
          },
          now: () => wall,
          monotonic: () => mono,
        },
      });
      return providers.find((entry) => entry.instanceId === "opencode/anthropic");
    };
    expect(await section()).toMatchObject({ installed: true, enabled: true, authStatus: "api-key" });
    expect(calls).toBe(1);
    // The wall moves back a minute while the monotonic clock passes the 24h
    // bound: the catalog must probe again, not serve the login as confirmed.
    wall -= 60_000;
    mono += OPENCODE_AUTH_TRUST_MS + 1;
    reply = null;
    const after = await section();
    expect(calls).toBe(2);
    expect(after).toMatchObject({ enabled: true, authStatus: "unverified" });
    clearStoredAuthCache();
  });

  it("rejects a reply with two rows for one provider instead of reordering the login", async () => {
    clearStoredAuthCache();
    const binary = authOnlyAnthropicStub();
    let clock = 1_000;
    let mono = 1_000;
    const advance = (ms: number) => { clock += ms; mono += ms; };
    let reply: string | null = JSON.stringify([{ id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] }]);
    const section = async () => {
      const providers = await buildDirectProviders({
        env: { PATH: "/nonexistent" },
        opencode: { enabled: true },
        opencodeBinaryPath: binary,
        storeRoot: tempDir("moxen-duplicate-store-"),
        modelsDev: async () => MODELS_DEV,
        storedAuth: { run: async () => reply, now: () => clock, monotonic: () => mono },
      });
      return providers.find((entry) => entry.instanceId === "opencode/anthropic");
    };
    expect(await section()).toMatchObject({ enabled: true, authStatus: "api-key" });
    // Same provider under another spelling, disagreeing about the credential.
    reply = JSON.stringify([
      { id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] },
      { id: "Anthropic", name: "Anthropic", connections: [{ type: "oauth" }] },
    ]);
    advance(AUTH_LIST_CACHE_TTL_MS);
    const after = await section();
    expect(after).toMatchObject({ enabled: true, authStatus: "unverified" });
    expect(after?.models).toHaveLength(2);
    clearStoredAuthCache();
  });
});

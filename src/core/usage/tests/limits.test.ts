import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { captureUsageProtectionOverride, usageKeyForInstance, usageProtectionOverrideActive, persistUsageLimits, recordUsageWindows, resetUsageLimitsForTests, usageLimitsSnapshot, standingLimit } from "../limits.js";

const NOW = Date.parse("2026-09-25T10:00:00.000Z");
const IN_2H = new Date(NOW + 2 * 3_600_000).toISOString();

afterEach(() => resetUsageLimitsForTests());

describe("usage limits registry", () => {
  it.each([false, true])("expires a thread override at the first known or observed reset (unknown reset: %s)", (unknown) => {
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 95, exhausted: false, resetsAt: unknown ? null : IN_2H },
      { id: "weekly", label: "Weekly", usedPercent: 98, exhausted: false, resetsAt: new Date(NOW + 86400_000).toISOString() },
    ], NOW);
    const override = captureUsageProtectionOverride("codex", NOW);
    expect(usageProtectionOverrideActive(override, "claude", NOW)).toBe(false);
    expect(usageProtectionOverrideActive(override, "codex", NOW + 1000)).toBe(true);
    if (unknown) recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: null }], NOW + 2000);
    expect(usageProtectionOverrideActive(override, "codex", unknown ? NOW + 2000 : NOW + 2 * 3600_000)).toBe(false);
  });

  it("waits for the last blocking window rather than retrying through a weekly limit", () => {
    const weekly = new Date(NOW + 24 * 3_600_000).toISOString();
    recordUsageWindows("codex", [
      { id: "primary", label: "Session", usedPercent: 100, exhausted: true, resetsAt: IN_2H },
      { id: "secondary", label: "Weekly", usedPercent: 100, exhausted: true, resetsAt: weekly },
    ], NOW);
    expect(standingLimit("codex", NOW)).toEqual({ label: "Weekly", resetsAt: weekly });
  });

  it("scopes Antigravity standingLimit to the model's quota pool so 3p exhaustion does not block Gemini", () => {
    const weekly = new Date(NOW + 24 * 3_600_000).toISOString();
    recordUsageWindows("antigravity", [
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 40, exhausted: false, resetsAt: IN_2H },
      { id: "3p-5h", label: "Session – Claude & GPT", usedPercent: 100, exhausted: true, resetsAt: IN_2H },
      { id: "gemini-argon-wtu-weekly", label: "Weekly – Argon", usedPercent: 100, exhausted: true, resetsAt: weekly },
    ], NOW);
    expect(standingLimit("antigravity", NOW, "gemini-4-neon")).toBeNull();
    expect(standingLimit("antigravity", NOW, "gemini-4-argon")).toEqual({ label: "Weekly – Argon", resetsAt: weekly });
    expect(standingLimit("antigravity", NOW, "claude-sonnet-5-5")).toEqual({ label: "Session – Claude & GPT", resetsAt: IN_2H });
    expect(standingLimit("antigravity", NOW, "gpt-oss-120b-medium")).toEqual({ label: "Session – Claude & GPT", resetsAt: IN_2H });
    // Without a model, secondary 3p pool does not block primary account.
    recordUsageWindows("antigravity", [
      { id: "gemini-argon-wtu-weekly", label: "Weekly – Argon", usedPercent: 0, exhausted: false, resetsAt: weekly },
    ], NOW);
    expect(standingLimit("antigravity", NOW)).toBeNull();
  });
  it("drops a window a full read no longer reports, instead of showing it forever", () => {
    const weekly = new Date(NOW + 24 * 3_600_000).toISOString();
    recordUsageWindows("antigravity", [
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 40, exhausted: false, resetsAt: IN_2H },
      { id: "gemini-argon-wtu-weekly", label: "Weekly – Argon", usedPercent: 90.6, exhausted: false, resetsAt: weekly },
    ], NOW, { complete: true });
    // Google removed the separate Argon quota: `/usage` no longer lists it, and
    // its last number must not outlive the reading that stopped reporting it.
    recordUsageWindows("antigravity", [
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 42, exhausted: false, resetsAt: IN_2H },
    ], NOW + 60_000, { complete: true });
    expect(usageLimitsSnapshot(NOW + 60_000).antigravity!.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["gemini-5h", 42],
    ]);
  });

  it("keeps a window a live event does not mention, even after a full read", () => {
    recordUsageWindows("antigravity", [
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 40, exhausted: false, resetsAt: IN_2H },
      { id: "gemini-argon-wtu-weekly", label: "Weekly – Argon", usedPercent: 90.6, exhausted: false, resetsAt: IN_2H },
    ], NOW, { complete: true });
    // A live event names only the pool this turn spent (here the quota hit):
    // it refreshes that window and leaves the others alone.
    recordUsageWindows("antigravity", [
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 100, exhausted: true, resetsAt: IN_2H },
    ], NOW + 60_000);
    expect(usageLimitsSnapshot(NOW + 60_000).antigravity!.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["gemini-5h", 100],
      ["gemini-argon-wtu-weekly", 90.6],
    ]);
  });

  it("keeps a full read that carries no windows from emptying the record", () => {
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 30, exhausted: false, resetsAt: IN_2H }], NOW);
    recordUsageWindows("claude", [], NOW + 60_000, { complete: true });
    expect(usageLimitsSnapshot(NOW + 60_000).claude!.windows.map((window) => window.usedPercent)).toEqual([30]);
  });

  it("keeps the probe's windows and refreshes one from a live event", () => {
    recordUsageWindows(
      "claude",
      [
        { id: "session", label: "Session", resetsAt: IN_2H, exhausted: false, usedPercent: 40 },
        { id: "weekly", label: "Weekly", resetsAt: IN_2H, exhausted: false, usedPercent: 12 },
      ],
      NOW,
    );
    recordUsageWindows("claude", [{ id: "session", label: "Session", resetsAt: IN_2H, exhausted: false, usedPercent: 55 }], NOW);
    const claude = usageLimitsSnapshot(NOW).claude!;
    expect(claude.windows.map((window) => [window.id, window.kind, window.usedPercent])).toEqual([
      ["session", "session", 55],
      ["weekly", "weekly", 12],
    ]);
  });

  it("keeps the last percentage when an event carries none, and reads an exhausted window as full", () => {
    recordUsageWindows("claude", [{ id: "session", label: "Session", resetsAt: IN_2H, exhausted: false, usedPercent: 30 }], NOW);
    recordUsageWindows("claude", [{ id: "session", label: "Session", resetsAt: IN_2H, exhausted: false, usedPercent: null }], NOW);
    expect(usageLimitsSnapshot(NOW).claude!.windows[0]!.usedPercent).toBe(30);
    recordUsageWindows("codex", [{ id: "primary", label: "Session", resetsAt: IN_2H, exhausted: true }], NOW);
    expect(usageLimitsSnapshot(NOW).codex!.windows[0]).toMatchObject({ kind: "session", usedPercent: 100 });
  });

  it("leaves out a window it has never seen a percentage for", () => {
    recordUsageWindows("grok", [{ id: "subscription", label: "Monthly", resetsAt: null, exhausted: false }], NOW);
    expect(usageLimitsSnapshot(NOW).grok).toBeUndefined();
  });

  it("reads a window whose reset has passed as empty", () => {
    recordUsageWindows("claude", [{ id: "session", label: "Session", resetsAt: IN_2H, exhausted: true, usedPercent: 100 }], NOW);
    const later = usageLimitsSnapshot(NOW + 3 * 3_600_000).claude!.windows[0]!;
    expect(later).toMatchObject({ usedPercent: 0, resetsAt: null });
  });

  it("isolates usage keys and standing limits per account for claude/<id>, chatgpt/<id>, and antigravity/<id>", () => {
    expect(usageKeyForInstance("claude/personal")).toBe("claude/personal");
    expect(usageKeyForInstance("claude/work")).toBe("claude/work");
    expect(usageKeyForInstance("claudeAgent")).toBe("claude");
    expect(usageKeyForInstance("chatgpt/personal")).toBe("chatgpt/personal");
    expect(usageKeyForInstance("antigravity/main")).toBe("antigravity/main");
    expect(usageKeyForInstance("antigravity/alt")).toBe("antigravity/alt");

    recordUsageWindows("claude/personal", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: IN_2H }], NOW);
    recordUsageWindows("claude/work", [{ id: "session", label: "Session", usedPercent: 10, exhausted: false, resetsAt: IN_2H }], NOW);
    expect(standingLimit("claude/personal", NOW)).toEqual({ label: "Session", resetsAt: IN_2H });
    expect(standingLimit("claude/work", NOW)).toBeNull();

    recordUsageWindows("antigravity/alt", [
      { id: "gemini-5h", label: "Session – Gemini", usedPercent: 25, exhausted: false, resetsAt: IN_2H },
      { id: "3p-5h", label: "Session – Claude & GPT", usedPercent: 100, exhausted: true, resetsAt: IN_2H },
    ], NOW);
    expect(standingLimit("antigravity/alt", NOW, "gemini-4-neon")).toBeNull();
    expect(standingLimit("antigravity/alt", NOW, "claude-sonnet-5-5")).toEqual({ label: "Session – Claude & GPT", resetsAt: IN_2H });
    expect(standingLimit("antigravity/main", NOW, "claude-sonnet-5-5")).toBeNull();
  });

  it("persists next to the store and loads it in a fresh registry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-usage-"));
    try {
      persistUsageLimits(root);
      recordUsageWindows("claude", [{ id: "weekly", label: "Weekly – Opus", resetsAt: IN_2H, exhausted: false, usedPercent: 71 }], NOW);
      // The registry persists on a chained promise: wait for the file to say
      // what was recorded, never for a fixed delay a loaded runner overruns.
      const file = path.join(root, "usage-limits.json");
      await vi.waitFor(() => {
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
          claude: { windows: [{ label: "Weekly – Opus", usedPercent: 71 }] },
        });
      }, { timeout: 10_000, interval: 10 });
      resetUsageLimitsForTests();
      persistUsageLimits(root);
      expect(usageLimitsSnapshot(NOW).claude!.windows[0]).toMatchObject({ label: "Weekly – Opus", kind: "weekly", usedPercent: 71 });
    } finally {
      resetUsageLimitsForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureUsageProtectionOverride, usageProtectionOverrideActive, persistUsageLimits, recordUsageWindows, resetUsageLimitsForTests, usageLimitsSnapshot, standingLimit } from "../limits.js";

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

  it("persists next to the store and loads it in a fresh registry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-usage-"));
    persistUsageLimits(root);
    recordUsageWindows("claude", [{ id: "weekly", label: "Weekly – Opus", resetsAt: IN_2H, exhausted: false, usedPercent: 71 }], NOW);
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      resetUsageLimitsForTests();
      persistUsageLimits(root);
      expect(usageLimitsSnapshot(NOW).claude!.windows[0]).toMatchObject({ label: "Weekly – Opus", kind: "weekly", usedPercent: 71 });
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
});

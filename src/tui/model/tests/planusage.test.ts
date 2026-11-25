import { describe, expect, it } from "vitest";

import { compactPlanUsage, providerUsageLimitsFor } from "../sidepanel.js";

describe("compactPlanUsage and multi-account usage isolation (MXN-471)", () => {
  it("formats compact session and weekly usage summaries with warn/danger tones and reset hint when hot", () => {
    expect(compactPlanUsage(null)).toBeNull();

    const calm = compactPlanUsage({
      windows: [
        { id: "session", kind: "session", label: "5h", usedPercent: 18, resetsAt: "2026-11-22T05:00:00.000Z" },
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 42, resetsAt: null },
      ],
    });
    expect(calm).toEqual({ text: "5h 18% · wk 42%", tone: "normal" });

    const warn = compactPlanUsage({
      windows: [
        { id: "session", kind: "session", label: "5h", usedPercent: 75, resetsAt: null },
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 30, resetsAt: null },
      ],
    });
    expect(warn).toEqual({ text: "5h 75% · wk 30%", tone: "warn" });

    const hot = compactPlanUsage(
      {
        windows: [
          { id: "session", kind: "session", label: "5h", usedPercent: 98, resetsAt: "2026-11-22T05:00:00.000Z" },
        ],
      },
      () => "↻ 45m",
    );
    expect(hot).toEqual({ text: "5h 98% · ↻ 45m", tone: "danger" });

    const creditsOnly = compactPlanUsage({ windows: [], credits: 1250 });
    expect(creditsOnly).toEqual({ text: "1,250 cr", tone: "normal" });
  });

  it("isolates account-addressed instances so one account never inherits another account's driver bucket", () => {
    const map = {
      antigravity: {
        windows: [{ id: "session", kind: "session", label: "5h", usedPercent: 95, resetsAt: null }],
      },
      "antigravity/personal": {
        windows: [{ id: "session", kind: "session", label: "5h", usedPercent: 14, resetsAt: null }],
      },
    };

    expect(
      providerUsageLimitsFor(map, { instanceId: "antigravity/personal", driver: "antigravity" })?.windows[0]?.usedPercent,
    ).toBe(14);
    expect(
      providerUsageLimitsFor(map, { instanceId: "antigravity/work", driver: "antigravity" }),
    ).toBeNull();
    // Legacy non-account instance still falls back to its driver bucket.
    expect(
      providerUsageLimitsFor(map, { instanceId: "antigravity", driver: "antigravity" })?.windows[0]?.usedPercent,
    ).toBe(95);
  });
});

import { describe, expect, it } from "vitest";
import type { QueryResults } from "../../../server/protocol.js";
import { usageProtectionNotices } from "../usageprotection.js";
import { queueConditionText, queueEntryState } from "../workqueue.js";

type Queue = QueryResults["usage.protection"]["queue"][number];
type WorkEntry = QueryResults["queue.read"]["entries"][number];

const NOW = Date.parse("2026-11-03T16:50:50");
const pause = (patch: Partial<Queue>): Queue => ({ provider: "codex", threadId: "t", title: "review unreviewed commits", phase: "waiting", order: 1, resetsAt: null, handoff: false, ...patch });
const notice = (patch: Partial<Queue>) => usageProtectionNotices({ forecasts: [], queue: [pause(patch)] }, () => {}, NOW)[0]!;
const detailText = (patch: Partial<Queue>) => String((notice(patch).detail as { props: { children: unknown } }).props.children);
const work = (patch: Partial<WorkEntry> & Pick<WorkEntry, "status">): WorkEntry => ({
  threadId: "t", turnId: "turn", title: "review unreviewed commits", provider: "codex", prompt: "", scheduledFor: null, blocked: [],
  policy: { conditions: [], held: false, order: 1, sequential: true, continuation: "same-thread", automatic: true, requestId: "usage:1" }, ...patch,
});

describe("usage recovery status", () => {
  it("says the work resumed, with no countdown and no cancel, once the recovery turn is running", () => {
    const running = notice({ phase: "resuming", resetsAt: new Date(NOW - 60_000).toISOString(), recoveryTurnId: "turn" });
    expect(running.title).toBe("1. review unreviewed commits · resumed");
    expect(detailText({ phase: "resuming", resetsAt: new Date(NOW - 60_000).toISOString() })).not.toMatch(/Resets in|messages wait|min/);
    expect(running.actions).toEqual([]);
  });

  it("never counts down to a reset time that has passed", () => {
    for (const phase of ["pending", "wrapping", "waiting"] as const) {
      const text = detailText({ phase, resetsAt: new Date(NOW - 30_000).toISOString() });
      expect(text).not.toContain("0 min");
      expect(text).toContain("Usage has reset");
    }
    expect(detailText({ resetsAt: new Date(NOW + 90 * 60_000).toISOString() })).toContain("Resets in 1 h 30 min");
    expect(notice({ resetsAt: new Date(NOW + 60_000).toISOString() }).actions.map((action) => action.label)).toEqual(["Move first", "Move last", "Cancel recovery"]);
  });

  it("names a running recovery in the work queue as the banner does", () => {
    expect(queueEntryState(work({ status: "running" }))).toBe("resumed");
    expect(queueEntryState(work({ status: "running", policy: { ...work({ status: "running" }).policy, automatic: false, requestId: "x" } }))).toBe("running");
  });

  it("reads queue conditions as sentences with the TUI's clock format", () => {
    expect(queueConditionText({ type: "usage", provider: "codex", window: "all", minimum: 0 })).toBe("When Codex has allowance left");
    expect(queueConditionText({ type: "usage", provider: "codex", window: "weekly", minimum: 10 })).toBe("When Codex has at least 10% of its weekly allowance left");
    expect(queueConditionText({ type: "at", at: new Date(NOW).toISOString() }, [], [], NOW)).toBe("At 16:50");
    expect(queueConditionText({ type: "at", at: new Date(NOW + 86_400_000).toISOString() }, [], [], NOW)).toMatch(/^At \w+, 16:50$/);
  });
});

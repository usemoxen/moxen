import { expect, it } from "vitest";
import type { TurnUsagePause } from "../../../core/types.js";
import { isProtectCommand, usagePauseLines, usagePauseTitle } from "../usagepause.js";

const now = Date.UTC(2026, 10, 3, 18, 0);
const pause: TurnUsagePause = { provider: "claude", windows: [{ id: "w", kind: "session", label: "Claude 5h", resetsAt: null }], resetsAt: "2026-11-03T21:00:00.000Z", pausedAt: "2026-11-03T17:05:00.000Z", hasUncommittedChanges: false };
// The join the timeline does: `turnUsagePauses[turnId]`.
const pauses: Record<string, TurnUsagePause> = { paused: pause };

it("marks the paused turn only: a later turn has no entry and no marker", () => {
  expect(pauses["paused"]).toBeDefined();
  expect(pauses["later"]).toBeUndefined();
});

it("names the window and the reset, and says nothing about changes when false or unknown", () => {
  for (const unclear of [false, null]) {
    const lines = usagePauseLines({ ...pause, hasUncommittedChanges: unclear }, now);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Claude 5h");
    expect(lines[1]).toContain("resets");
    expect(lines.join(" ")).not.toContain("uncommitted");
  }
});

it("says the reset is unknown when absent, and flags uncommitted changes", () => {
  const lines = usagePauseLines({ ...pause, resetsAt: null, hasUncommittedChanges: true }, now);
  expect(lines[1]).toContain("isn't known");
  expect(lines[2]).toContain("uncommitted");
});

it("a forced pause says the user protected the thread and a message ends it: no window, no reset", () => {
  const forced: TurnUsagePause = { ...pause, windows: [], resetsAt: null, forced: true };
  const lines = usagePauseLines({ ...forced, hasUncommittedChanges: true }, now);
  expect(lines[0]).toContain("You protected");
  expect(lines[1]).toContain("message ends");
  expect(lines[2]).toContain("uncommitted");
  expect(lines.join(" ")).not.toMatch(/reset|ran low|usage/i);
  expect(usagePauseTitle(forced)).not.toBe(usagePauseTitle(pause));
  expect(usagePauseLines(forced, now)).toHaveLength(2);
});

it("only the bare /protect command is the protect command", () => {
  expect(isProtectCommand("/protect")).toBe(true);
  expect(isProtectCommand("  /protect\n")).toBe(true);
  expect(isProtectCommand("/protect now")).toBe(false);
  expect(isProtectCommand("please /protect")).toBe(false);
});

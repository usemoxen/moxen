import { expect, it } from "vitest";
import type { QueryResults } from "../../../server/protocol.js";
import { editableQueueSelection, queueActions, queueConditionText, queueDescription, queueDetails, queueEntryState, queueGroups, queueHeadline, queueMoveSteps, queueProviders, queueWindows } from "../workqueue.js";
import { applyLanguage, tx } from "../../i18n/index.js";

type Entry = QueryResults["queue.read"]["entries"][number];
const entry = (turnId: string, status = "queued", removed = false): Entry => ({ threadId: `thread-${turnId}`, turnId, title: `Task ${turnId}`, provider: "codex", prompt: "work", scheduledFor: null, status, blocked: [], policy: { conditions: [], order: 1, held: false, sequential: true, continuation: "same-thread", removed } });

it("never applies a stale selection to a different entry or a running turn", () => {
  const rows = [entry("a"), entry("b", "running"), entry("c", "interrupted", true)];
  expect(editableQueueSelection(rows, ["gone"], "a")).toEqual([]);
  expect(editableQueueSelection(rows, ["b", "c", "a"], "b").map((row) => row.turnId)).toEqual(["a", "c"]);
  expect(editableQueueSelection(rows, [], "b")).toEqual([]);
});

it("distinguishes latched provider events from live conditions and names dependencies", () => {
  const condition = { type: "provider" as const, provider: "claude", state: "exhausted" as const, mode: "after" as const };
  expect(queueConditionText(condition)).toBe("After Claude is out of usage");
  expect(queueConditionText({ ...condition, mode: "while" })).toBe("While Claude is out of usage");
  expect(queueConditionText({ type: "entry", threadId: "thread-a", turnId: "a" }, [], [entry("a")])).toContain("Task a");
  expect(queueConditionText({ type: "thread", threadId: "missing" })).toContain("missing");
});

it("translates server-owned blocking reasons without exposing untranslated quota states", () => {
  applyLanguage("es-ES");
  try {
    expect(tx("codex: needs 5% weekly remaining")).toBe("codex: se necesita un 5% restante de uso semanal");
    expect(tx("codex: waiting for session reset")).toBe("codex: esperando el restablecimiento de sesión");
    expect(tx("Waiting for usage protection")).toBe("Esperando a la protección de uso");
  } finally { applyLanguage("en"); }
});

it("offers only the actions that apply to the focused entry", () => {
  const held = { ...entry("a"), policy: { ...entry("a").policy, held: true } };
  expect(queueActions(entry("a"))).toEqual(["hold", "conditions", "options", "remove"]);
  expect(queueActions(held)).toEqual(["release", "conditions", "options", "remove"]);
  expect(queueActions(entry("a", "running"))).toEqual([]);
  expect(queueActions(entry("a", "interrupted", true))).toEqual(["restore"]);
  expect(queueActions(entry("a"), [entry("a"), held])).toEqual(["hold", "conditions", "options", "remove"]);
  expect(queueActions(held, [held, { ...held, turnId: "b" }])).toEqual(["release", "conditions", "options", "remove"]);
});

it("groups entries by what is happening and moves one past the entries of other groups", () => {
  const held = (turnId: string) => ({ ...entry(turnId), policy: { ...entry(turnId).policy, held: true } });
  const rows = [entry("run", "running"), entry("a"), held("h"), entry("b"), entry("gone", "failed", true)];
  const groups = queueGroups(rows);
  expect([groups.running, groups.upNext, groups.held, groups.removed].map((group) => group.map((row) => row.turnId))).toEqual([["run"], ["a", "b"], ["h"], ["gone"]]);
  // "b" sits two places after "a" in the server's order because the held entry is between them.
  expect(queueMoveSteps(rows, rows[1]!, "down")).toBe(2);
  expect(queueMoveSteps(rows, rows[3]!, "up")).toBe(2);
  expect(queueMoveSteps(rows, rows[1]!, "up")).toBe(0);
  expect(queueMoveSteps(rows, rows[2]!, "down")).toBe(0);
  expect(queueMoveSteps(rows, rows[0]!, "down")).toBe(0);
});

it("describes an entry in words and never shows the prompt it carries", () => {
  const prompt = "The usage allowance has reset. Resume the unfinished task from your wrap-up";
  const recovery = { ...entry("a"), prompt, policy: { ...entry("a").policy, automatic: true, requestId: "usage:1" } };
  expect(queueDescription(recovery, 0)).toBe("Picks the unfinished work back up after the usage reset.");
  expect(queueDescription({ ...entry("a"), prompt }, 0)).not.toContain("Resume");
  expect(queueDescription({ ...entry("a", "running"), prompt }, 0)).toBe("This work is running now.");
  expect(queueHeadline([], 0)).toBe("Nothing is queued.");
  expect(queueHeadline([{ ...entry("a"), blocked: ["Held by you"], policy: { ...entry("a").policy, held: true } }], 0)).toBe("Everything queued is on hold.");
  expect(queueHeadline([{ ...entry("a"), blocked: ["codex: waiting for session reset"] }], 0)).toBe("Next: Task a · codex: waiting for session reset");
});

it("offers conditions only providers that report usage, in every window they report", () => {
  const limits = {
    claude: { windows: [{ kind: "session" }, { kind: "weekly" }], unavailable: null },
    codex: { windows: [{ kind: "weekly" }], unavailable: null },
    opencode: { windows: [], unavailable: { reason: "none" } },
    harness: { windows: [], unavailable: { reason: "none" } },
  };
  expect(queueProviders(limits)).toEqual(["claude", "codex"]);
  expect(queueWindows(limits, "claude")).toEqual(["session", "weekly", "all"]);
  expect(queueWindows(limits, "codex")).toEqual(["weekly", "all"]);
  expect(queueProviders(null)).toEqual(["claude", "codex"]);
});

it("says when an entry waits for a known time, and lists what it waits for without the prompt", () => {
  const NOW = Date.parse("2026-11-05T12:00:00");
  const later = new Date(NOW + 4 * 3_600_000).toISOString();
  const waiting: Entry = { ...entry("a"), prompt: "SECRET PROMPT", blocked: ["codex: waiting for session reset"], policy: { ...entry("a").policy, conditions: [{ type: "reset", provider: "codex", window: "session", resetsAt: later }, { type: "usage", provider: "codex", window: "weekly", minimum: 5 }] } };
  expect(queueEntryState(waiting, NOW)).toBe("waiting · 16:00");
  expect(queueEntryState({ ...waiting, blocked: [] }, NOW)).toBe("ready");
  expect(queueEntryState({ ...waiting, policy: { ...waiting.policy, held: true } }, NOW)).toBe("held by you");
  expect(queueDetails(waiting, [], [], NOW)).toEqual(["After Codex's next session reset", "When Codex has at least 5% of its weekly allowance left"]);
  expect(queueDetails({ ...waiting, policy: { ...waiting.policy, held: true } }, [], [], NOW)[0]).toBe("On hold until you release it");
  expect(queueDetails(entry("r", "running"), [], [], NOW)).toEqual([]);
  expect([queueDescription(waiting, NOW), ...queueDetails(waiting, [], [], NOW)].join("\n")).not.toContain("SECRET PROMPT");
});

it("heads the list with what runs next, even while something runs", () => {
  const running = entry("run", "running");
  const queued = { ...entry("a"), blocked: ["Thread is running"] };
  expect(queueHeadline([running, queued], 0)).toBe("Next: Task a · Thread is running");
  expect(queueHeadline([running], 0)).toBe("Running now: Task run");
});

import { expect, it } from "vitest";
import type { QueryResults } from "../../../server/protocol.js";
import { editableQueueSelection, queueActions, queueConditionText, queueDescription, queueHeadline, queueProviders, queueWindows } from "../workqueue.js";
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
  expect(queueConditionText(condition)).toBe("Starts after claude becomes out of usage");
  expect(queueConditionText({ ...condition, mode: "while" })).toBe("Starts while claude is out of usage");
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
  const rows = [entry("a"), entry("b"), entry("c")];
  expect(queueActions(rows[0]!, 0, 3)).toEqual(["down", "last", "hold", "remove"]);
  expect(queueActions(rows[1]!, 1, 3)).toEqual(["up", "down", "hold", "remove"]);
  expect(queueActions(rows[2]!, 2, 3)).toEqual(["first", "up", "hold", "remove"]);
  expect(queueActions(entry("a"), 0, 1)).toEqual(["hold", "remove"]);
  expect(queueActions({ ...entry("a"), policy: { ...entry("a").policy, held: true } }, 0, 1)).toEqual(["release", "remove"]);
  expect(queueActions(entry("a", "running"), 0, 1)).toEqual([]);
  expect(queueActions(entry("a", "interrupted", true), -1, 0)).toEqual(["restore"]);
  expect(queueActions(rows[0]!, 0, 3, [rows[0]!, rows[1]!])).toEqual(["hold", "remove"]);
});

it("describes an entry in words and never shows the prompt it carries", () => {
  const prompt = "The usage allowance has reset. Resume the unfinished task from your wrap-up";
  const recovery = { ...entry("a"), prompt, policy: { ...entry("a").policy, automatic: true, requestId: "usage:1" } };
  expect(queueDescription(recovery, 0)).toBe("Picks the unfinished work back up after the usage reset.");
  expect(queueDescription({ ...entry("a"), prompt }, 0)).not.toContain("Resume");
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

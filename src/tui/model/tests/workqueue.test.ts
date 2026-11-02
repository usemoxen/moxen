import { expect, it } from "vitest";
import type { QueryResults } from "../../../server/protocol.js";
import { editableQueueSelection, queueConditionText } from "../workqueue.js";
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
  expect(queueConditionText(condition)).toBe("After claude becomes out of usage");
  expect(queueConditionText({ ...condition, mode: "while" })).toBe("While claude is out of usage");
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

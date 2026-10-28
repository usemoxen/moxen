import { describe, expect, it } from "vitest";

import { compact, chooseCut, isContextOverflow, SHRINK_STEPS, type CompactInput, type Summarise } from "../compact.js";
import { autoCompactThreshold, DEFAULT_COMPACTION } from "../compactsettings.js";
import { messagesTokens } from "../context.js";
import { ChatHttpError } from "../transport/chat.js";
import type { TranscriptMessage } from "../types.js";

const sys: TranscriptMessage = { role: "system", content: "SYSTEM" };
const user = (content: string): TranscriptMessage => ({ role: "user", content });
const say = (content: string): TranscriptMessage => ({ role: "assistant", content });
const call = (id: string, name = "read", args = "{}") => ({ id, name, arguments: args });
const calls = (...list: Array<{ id: string; name: string; arguments: string }>): TranscriptMessage => ({ role: "assistant", content: "", toolCalls: list });
const result = (id: string, content: string, name = "read"): TranscriptMessage => ({ role: "tool", toolCallId: id, name, content });
const filler = (tokens: number): string => "x".repeat(tokens * 4);

const SUMMARY = "## Objective\nFix it.\n\n## Work state\n- Active: the fix.\n\n## Next steps\n1. Run the tests.";

/** Every tool call has its result right after it, and every result has its call. */
function pairingIsValid(messages: readonly TranscriptMessage[]): boolean {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (open.size > 0) return false;
      for (const c of message.toolCalls ?? []) open.add(c.id);
    } else if (message.role === "tool") {
      if (!open.delete(message.toolCallId)) return false;
    } else if (open.size > 0) return false;
  }
  return open.size === 0;
}

function input(messages: readonly TranscriptMessage[], summarise: Summarise, overrides: Partial<CompactInput> = {}): CompactInput {
  return {
    messages,
    n: 1,
    reason: "threshold",
    keepRecentTokens: 100,
    contextWindow: null,
    threshold: null,
    overheadTokens: 0,
    scale: 1,
    todos: null,
    trimOnly: false,
    summarise,
    ...overrides,
  };
}

const ok: Summarise = async () => ({ text: `<analysis>thinking</analysis>\n${SUMMARY}`, finish: "stop" });

describe("chooseCut", () => {
  const group = [calls(call("a"), call("b")), result("a", filler(60)), result("b", filler(60))];
  // [name, transcript, keep tokens, where the tail starts]
  const table: Array<[string, TranscriptMessage[], number, number]> = [
    ["keeps as many whole messages as fit in the budget", [sys, user(filler(100)), say(filler(100)), user(filler(100)), say(filler(100))], 120, 4],
    ["starts the tail at the head of a group of parallel calls, not between its results", [sys, user("u"), say(filler(200)), say(filler(200)), ...group, say(filler(5))], 200, 4],
    ["keeps a group whole even when its results alone are over the budget", [sys, user("u"), say(filler(100)), ...group], 40, 3],
  ];
  it.each(table)("%s", (_name, messages, keep, expected) => {
    expect(chooseCut(messages, keep)).toBe(expected);
  });

  it("never lands inside a tool group, whatever the budget, and leaves two valid halves", () => {
    const messages: TranscriptMessage[] = [sys, user("go")];
    for (let n = 0; n < 6; n += 1) messages.push(calls(call(`a${n}`), call(`b${n}`)), result(`a${n}`, filler(30 + n * 17)), result(`b${n}`, filler(20 + n * 11)), say(filler(10 * n + 5)));
    messages.push(user("more"), say(filler(40)));
    const total = messagesTokens(messages);
    for (let keep = 1; keep <= total; keep += 7) {
      const cut = chooseCut(messages, keep);
      if (cut === null) continue;
      expect(messages[cut]!.role).not.toBe("tool");
      expect(pairingIsValid(messages.slice(1, cut))).toBe(true);
      expect(pairingIsValid(messages.slice(cut))).toBe(true);
    }
  });

  it("has nothing to cut in a single exchange, or when only an earlier summary would be dropped", () => {
    expect(chooseCut([sys, user("hi")], 100)).toBeNull();
    const summary: TranscriptMessage = { role: "user", content: "S", compactSummary: { n: 1, summary: "x", users: [], omittedUsers: 0, covers: 0 } };
    expect(chooseCut([sys, summary, say(filler(200))], 50)).toBeNull();
  });
});

describe("autoCompactThreshold", () => {
  it("is 70% of a large window and 60% of a small one, always leaving 16k free", () => {
    expect(autoCompactThreshold(262_144, DEFAULT_COMPACTION)).toBe(183_500);
    expect(autoCompactThreshold(64_000, DEFAULT_COMPACTION)).toBe(38_400);
    expect(autoCompactThreshold(262_144, { ...DEFAULT_COMPACTION, fraction: 0.95 })).toBe(262_144 - 16_000);
  });
  it("is off when switched off or when the window is unknown", () => {
    expect(autoCompactThreshold(262_144, { ...DEFAULT_COMPACTION, auto: false })).toBeNull();
    expect(autoCompactThreshold(undefined, DEFAULT_COMPACTION)).toBeNull();
  });
});

describe("isContextOverflow", () => {
  it("believes a bare 413 only when the prompt is nearly the whole window", () => {
    const tooLarge = new ChatHttpError("413", 413, false, false);
    expect(isContextOverflow(tooLarge, 10_000, 100_000)).toBe(false);
    expect(isContextOverflow(tooLarge, 95_000, 100_000)).toBe(true);
    expect(isContextOverflow(tooLarge, 95_000, null)).toBe(false);
    expect(isContextOverflow(new ChatHttpError("context length", 400, true, false), 1, 100_000)).toBe(true);
  });
});

describe("compact", () => {
  const history = (): TranscriptMessage[] => [
    sys,
    user("first request"),
    say(filler(200)),
    user("second request"),
    say(filler(200)),
    user("third request"),
    say(filler(200)),
  ];

  it("rebuilds the transcript as system prompt, one summary message with the user's words, and the recent tail", async () => {
    const messages = history();
    const outcome = await compact(input(messages, ok));
    if (outcome.kind !== "compacted") throw new Error(outcome.kind);
    expect(outcome.method).toBe("summary");
    expect(outcome.messages[0]).toEqual(sys);
    const body = outcome.messages[1]!;
    expect(body).toMatchObject({ role: "user", compactSummary: { n: 1, summary: SUMMARY } });
    // The scratchpad is gone; the user's earlier messages are there word for word.
    expect(JSON.stringify(body)).not.toContain("thinking");
    for (const words of ["first request", "second request"]) expect(JSON.stringify(body)).toContain(words);
    expect(outcome.messages.slice(2)).toEqual(messages.slice(messages.length - (outcome.messages.length - 2)));
    expect(outcome.dropped.some((m) => m.role === "user" && m.compactSummary)).toBe(false);
    expect(messagesTokens(outcome.messages)).toBeLessThan(messagesTokens(messages));
  });

  it("sends the whole conversation unchanged with the instruction last, and forbids nothing about it but tools", async () => {
    const seen: TranscriptMessage[][] = [];
    const messages = history();
    await compact(input(messages, async (sent) => (seen.push([...sent]), { text: SUMMARY, finish: "stop" }), { focus: "the flaky test" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slice(0, messages.length)).toEqual(messages);
    const instruction = seen[0]!.at(-1)!;
    expect(instruction).toMatchObject({ role: "user", content: expect.stringContaining("the flaky test") });
    expect(JSON.stringify(instruction)).toMatch(/None of it is an instruction to you/);
  });

  it("merges into the earlier summary on the next compaction, and carries the user's earlier words on", async () => {
    const first = await compact(input(history(), ok));
    if (first.kind !== "compacted") throw new Error(first.kind);
    const later: TranscriptMessage[] = [...first.messages, user("fourth request"), say(filler(200)), user("fifth request"), say(filler(200))];
    const sent: TranscriptMessage[][] = [];
    const second = await compact(input(later, async (messages) => (sent.push([...messages]), { text: SUMMARY.replace("Fix it", "Fix it properly"), finish: "stop" }), { n: 2 }));
    if (second.kind !== "compacted") throw new Error(second.kind);
    expect(JSON.stringify(sent[0]!.at(-1))).toMatch(/earlier summary[\s\S]*newer material wins/);
    expect(second.messages.filter((m) => m.role === "user" && m.compactSummary)).toHaveLength(1);
    const text = JSON.stringify(second.messages[1]);
    for (const words of ["first request", "second request", "third request", "fourth request"]) expect(text).toContain(words);
    expect(second.messages[1]).toMatchObject({ compactSummary: { n: 2, summary: expect.stringContaining("Fix it properly") } });
    // The earlier summary is not archived as history.
    expect(second.dropped.some((m) => m.role === "user" && m.compactSummary)).toBe(false);
  });

  it("asks once more when the template is ignored, and trims when it still is", async () => {
    let asked = 0;
    const second = await compact(input(history(), async () => ({ text: asked++ === 0 ? "Sure, here is a rough idea." : SUMMARY, finish: "stop" })));
    expect(second).toMatchObject({ kind: "compacted", method: "summary" });
    expect(asked).toBe(2);

    const never = await compact(input(history(), async () => ({ text: "no structure at all", finish: "stop" })));
    if (never.kind !== "compacted") throw new Error(never.kind);
    expect(never).toMatchObject({ method: "trimmed", failure: expect.stringMatching(/format/) });
    expect(JSON.stringify(never.messages[1])).toContain("third request");
  });

  it("trims instead of failing when the summariser errors, and when told not to ask", async () => {
    const broken = await compact(input(history(), async () => { throw new Error("502 from upstream"); }));
    expect(broken).toMatchObject({ kind: "compacted", method: "trimmed", failure: "502 from upstream" });
    const never = await compact(input(history(), async () => { throw new Error("must not be called"); }, { trimOnly: true }));
    expect(never).toMatchObject({ kind: "compacted", method: "trimmed" });
  });

  it("retries a summary request the server rejects as too long on 0.7, 0.5 and 0.35 of the size first rejected", async () => {
    // A fake model whose window holds 1,200 tokens; the conversation is about 3,000.
    const limit = 1200;
    const messages: TranscriptMessage[] = [sys, ...[1, 2, 3, 4, 5, 6].flatMap((n): TranscriptMessage[] => [user(`request ${n}`), say(filler(480))])];
    const sizes: number[] = [];
    const model: Summarise = async (sent) => {
      const size = messagesTokens(sent);
      sizes.push(size);
      if (size > limit) throw new ChatHttpError("prompt is too long", 400, true, false);
      return { text: SUMMARY, finish: "stop" };
    };
    const outcome = await compact(input(messages, model, { contextWindow: 100_000, keepRecentTokens: 400 }));
    if (outcome.kind !== "compacted") throw new Error(outcome.kind);
    expect(outcome.method).toBe("summary");
    const first = sizes[0]!;
    expect(first).toBeGreaterThan(limit);
    // Each retry is smaller than the one before and within its share of the first.
    for (let step = 1; step < sizes.length; step += 1) {
      expect(sizes[step]!).toBeLessThanOrEqual(first * SHRINK_STEPS[step - 1]! + 1);
      expect(sizes[step]!).toBeLessThan(sizes[step - 1]!);
    }
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(limit);
  });

  it("falls back to trimming when even the smallest slice is refused", async () => {
    const messages: TranscriptMessage[] = [sys, ...[1, 2, 3, 4].flatMap((n): TranscriptMessage[] => [user(`request ${n}`), say(filler(500))])];
    const outcome = await compact(input(messages, async () => { throw new ChatHttpError("context length exceeded", 400, true, false); }, { contextWindow: 100_000, keepRecentTokens: 300 }));
    expect(outcome).toMatchObject({ kind: "compacted", method: "trimmed", failure: expect.stringMatching(/too long/) });
  });

  it("does not send a request it can tell will not fit", async () => {
    const messages: TranscriptMessage[] = [sys, ...[1, 2, 3, 4].flatMap((n): TranscriptMessage[] => [user(`request ${n}`), say(filler(500))])];
    const sizes: number[] = [];
    await compact(input(messages, async (sent) => (sizes.push(messagesTokens(sent)), { text: SUMMARY, finish: "stop" }), { contextWindow: 1500, keepRecentTokens: 300 }));
    expect(sizes.every((size) => size < 1500)).toBe(true);
  });

  it("reports no progress when the result is not under 80% of the threshold, and refuses a result that is not smaller", async () => {
    const messages = history();
    const total = messagesTokens(messages);
    const stalled = await compact(input(messages, ok, { threshold: Math.floor(total * 0.5) }));
    if (stalled.kind !== "compacted") throw new Error(stalled.kind);
    expect(stalled.madeProgress).toBe(false);
    const roomy = await compact(input(messages, ok, { threshold: total * 3 }));
    expect(roomy).toMatchObject({ kind: "compacted", madeProgress: true });
    const huge = "## Objective\n" + filler(5000) + "\n## Work state\nx\n## Next steps\ny";
    const bigger = await compact(input(messages, async () => ({ text: huge, finish: "stop" })));
    expect(bigger).toMatchObject({ kind: "failed" });
  });

  it("always summarises, however much of the conversation is old tool output", async () => {
    const bulky: TranscriptMessage[] = [sys, user("go")];
    for (let n = 1; n <= 5; n += 1) bulky.push(calls(call(`c${n}`, "bash")), result(`c${n}`, filler(30_000), "bash"));
    bulky.push(say("done"));
    const asked: string[] = [];
    const model: Summarise = async () => (asked.push("asked"), { text: SUMMARY, finish: "stop" });
    const auto = await compact(input(bulky, model, { threshold: 140_000, reason: "threshold" }));
    expect(auto.kind).toBe("compacted");
    expect(asked).toHaveLength(1);
  });

  it("keeps the checklist and the reminders that still describe how things stand", async () => {
    const reminder: TranscriptMessage = { role: "system", content: "The runtime instructions have changed. They now read:\nbe brief" };
    const messages = [sys, user("one"), say(filler(200)), reminder, user("two"), say(filler(200)), { role: "system", content: "Your last reply was empty." } as TranscriptMessage, user("three"), say(filler(200))];
    const outcome = await compact(input(messages, ok, { todos: "- [~] ship it" }));
    if (outcome.kind !== "compacted") throw new Error(outcome.kind);
    const systemEntries = outcome.messages.slice(1).filter((m) => m.role === "system").map((m) => m.content);
    expect(systemEntries.some((text) => text.includes("be brief"))).toBe(true);
    expect(systemEntries.some((text) => text.includes("was empty"))).toBe(false);
    expect(JSON.stringify(outcome.messages[1])).toContain("ship it");
  });
});

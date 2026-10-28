import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "../../spi.js";
import { HarnessDriver } from "../driver.js";
import { ChatHttpError, type ChatRequest } from "../transport/chat.js";
import type { ModelEvent, TranscriptMessage } from "../types.js";

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-compaction-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const selection = { instanceId: "harness/colab", model: "m" };
const profile = (window: number, compaction: Record<string, unknown> = {}) => ({
  profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "m", contextWindow: window }], compaction }],
});

type Step = ModelEvent[] | Error;

function driverWith(script: Step[], window = 262_144, compaction: Record<string, unknown> = {}, sessionsDir = path.join(dir, "sessions"), tab: Record<string, unknown> = {}) {
  const requests: ChatRequest[] = [];
  const driver = new HarnessDriver({
    config: { ...profile(window, compaction), ...tab },
    sessionsDir,
    // Nothing from the real home directory or the package: a test sees only its own skills.
    home: dir,
    sleep: async () => {},
    transport: (request) => {
      requests.push(request);
      const step = script.shift();
      return (async function* () {
        if (step === undefined) throw new Error("script exhausted");
        if (step instanceof Error) throw step;
        yield* step;
      })();
    },
  });
  const events: ProviderRuntimeEvent[] = [];
  void Effect.runPromise(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
  return { driver, requests, events, script };
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const SUMMARY = "## Objective\nFix the parser.\n\n## Work state\n- Active: the parser.\n\n## Next steps\n1. Run the tests.";
const summary = (text = SUMMARY): ModelEvent[] => [{ type: "text.delta", text: `<analysis>scratch</analysis>${text}` }, { type: "finish", reason: "stop" }];
const answer = (text: string, inputTokens = 100): ModelEvent[] => [{ type: "text.delta", text }, { type: "usage", usage: { inputTokens, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0 } }, { type: "finish", reason: "stop" }];
const call = (id: string, name: string, args: unknown, inputTokens = 100): ModelEvent[] => [
  { type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } },
  { type: "usage", usage: { inputTokens, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0 } },
  { type: "finish", reason: "tool-calls" },
];
const long = (tokens: number): string => "z".repeat(tokens * 4);

async function start(driver: HarnessDriver, extra: Record<string, unknown> = {}) {
  await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection, ...extra }));
}
async function send(driver: HarnessDriver, prompt: string) {
  const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt }));
  return await driver.awaitTurn("t1", turnId);
}
const notices = (events: ProviderRuntimeEvent[]) => events.filter((event) => event.type === "session.notice") as Array<{ notice: string; title: string; detail: string | null }>;
const transcriptOf = (driver: HarnessDriver) => (driver as unknown as { sessions: Map<string, { transcript: { messages: readonly TranscriptMessage[] }; sessionId: string }> }).sessions.get("t1")!;

/** Two long exchanges, so there is something to summarise. */
async function twoTurns(driver: HarnessDriver) {
  expect(await send(driver, "first question")).toMatchObject({ status: "completed" });
  expect(await send(driver, "second question")).toMatchObject({ status: "completed" });
}

describe("manual /compact", () => {
  it("asks the model on the same conversation and the same tool definitions, with the instruction last and tools forbidden", async () => {
    const { driver, requests, events } = driverWith([answer(long(3000)), answer(long(3000)), summary()]);
    await start(driver);
    await twoTurns(driver);
    expect(await send(driver, "/compact")).toMatchObject({ status: "completed" });

    const [, last, ask] = requests as [ChatRequest, ChatRequest, ChatRequest];
    // The server's cache of everything it has already seen applies: the new request only adds to the end.
    expect(ask.messages.slice(0, last.messages.length)).toEqual(last.messages);
    expect(ask.messages.length).toBeGreaterThan(last.messages.length);
    expect(ask.messages[0]).toEqual(last.messages[0]);
    expect(ask.tools).toEqual(last.tools);
    expect(ask.toolChoice).toBe("none");
    expect(JSON.stringify(ask.messages.at(-1))).toMatch(/Objective/);

    expect(notices(events)).toEqual([expect.objectContaining({ notice: "compacted", title: "Conversation compacted", detail: expect.stringContaining("Fix the parser.") })]);
    // The scratchpad was not kept.
    expect(notices(events)[0]!.detail).not.toContain("scratch");
  });

  it("answers `/compact <focus>` by telling the summariser what to look at", async () => {
    const { driver, requests } = driverWith([answer(long(3000)), answer(long(3000)), summary()]);
    await start(driver);
    await twoTurns(driver);
    await send(driver, "/compact keep the migration plan");
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain("keep the migration plan");
  });

  it("leaves the model one summary message, reads as an estimate until the next reply, and reports the threshold", async () => {
    const { driver, requests } = driverWith([answer(long(3000)), answer(long(3000)), summary(), answer("ok", 400)]);
    await start(driver);
    await twoTurns(driver);
    await expect(driver.contextUsage("t1")).resolves.toMatchObject({ estimated: false, compactsAutomatically: true, autoCompactThreshold: 183_500 });
    await send(driver, "/compact");
    await expect(driver.contextUsage("t1")).resolves.toMatchObject({ estimated: true, compactsAutomatically: true, autoCompactThreshold: 183_500 });
    await expect(driver.contextBreakdown("t1")).resolves.toMatchObject({ estimated: true, compactsAutomatically: true });

    await send(driver, "third question");
    const wire = requests.at(-1)!.messages;
    expect(wire[0]).toMatchObject({ role: "system" });
    expect(String(wire[1]!.content)).toContain("Fix the parser.");
    for (const words of ["first question", "second question"]) expect(String(wire[1]!.content)).toContain(words);
    await expect(driver.contextUsage("t1")).resolves.toMatchObject({ estimated: false, usedTokens: 410 });
  });

  it("forgets what was read, so an edit has to read the file again", async () => {
    const file = path.join(work, "a.txt");
    fs.writeFileSync(file, `${"line of text\n".repeat(2000)}`);
    const { driver, requests } = driverWith([call("r1", "read", { file_path: file }), answer(long(3000)), answer(long(3000)), summary(), call("e1", "edit", { file_path: file, old_string: "line of text", new_string: "x", replace_all: true }), answer("ok")]);
    await start(driver);
    await send(driver, "read it");
    await send(driver, "and again");
    await send(driver, "/compact");
    await send(driver, "now edit");
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toMatch(/read/i);
    expect(fs.readFileSync(file, "utf8")).toContain("line of text");
  });

  it("says when there is nothing to compact", async () => {
    const { driver } = driverWith([answer("hi")]);
    await start(driver);
    await send(driver, "hello");
    expect(await send(driver, "/compact")).toMatchObject({ status: "failed", error: expect.stringMatching(/too short|smaller/) });
  });

  it("changes nothing and says so when the summariser is down for good", async () => {
    const { driver, events } = driverWith([answer(long(3000)), answer(long(3000)), new Error("down"), new Error("down")]);
    await start(driver);
    await twoTurns(driver);
    // Trimmed rather than stuck: the thread still ends up smaller, and the notice says no summary was made.
    expect(await send(driver, "/compact")).toMatchObject({ status: "completed" });
    expect(notices(events)[0]).toMatchObject({ title: "Conversation trimmed (no summary)", detail: expect.stringContaining("down") });
  });
});

describe("what a compaction leaves on disk", () => {
  it("keeps the dropped history readable, survives a restart, and rolls back only as far as the summary", async () => {
    const sessionsDir = path.join(dir, "sessions");
    const first = driverWith([answer(long(3000)), answer(long(3000)), summary(), answer("fine"), answer("also fine")], 262_144, {}, sessionsDir);
    await start(first.driver);
    await twoTurns(first.driver);
    await send(first.driver, "/compact");
    await send(first.driver, "third question");
    const cursor = first.driver.resumeCursor("t1")!;

    const promptsOf = async (driver: HarnessDriver) =>
      (await run(driver.readThread("t1"))).turns.map((turn) => (turn.items[0] as TranscriptMessage & { content: string }).content);
    expect(await promptsOf(first.driver)).toEqual(["first question", "second question", "third question"]);

    // A new process picks the compacted thread up from disk, history and all.
    const second = driverWith([answer("resumed")], 262_144, {}, sessionsDir);
    await run(second.driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection, resumeCursor: cursor }));
    expect(await promptsOf(second.driver)).toEqual(["first question", "second question", "third question"]);
    await send(second.driver, "fourth question");
    const wire = second.requests[0]!.messages;
    expect(String(wire[1]!.content)).toContain("Fix the parser.");
    expect(wire.filter((m) => m.role === "user" && String(m.content).includes("first question"))).toHaveLength(1);

    // Two later prompts can be taken back; the earlier ones are inside the summary and cannot.
    await run(second.driver.rollbackThread("t1", 2));
    expect(await promptsOf(second.driver)).toEqual(["first question", "second question"]);
    await expect(run(second.driver.rollbackThread("t1", 1))).rejects.toThrow(/before the last compaction are gone/);
    expect(transcriptOf(second.driver).transcript.messages.some((m) => m.role === "user" && m.compactSummary)).toBe(true);
  });
});

describe("automatic compaction", () => {
  // These numbers were tuned for a conversation plus the tools the harness had when they were written: a 20,000-token window
  // compacts at 10,000 and wants the result under 8,000. Tools added since are a fixed cost on every request, so the window
  // grows by what they take (with the threshold and the target growing by the same amount), and the sizes below keep their meaning.
  const ORIGINAL_TOOLS = new Set(["read", "edit", "write", "glob", "grep", "bash", "todo", "ask", "enter_plan_mode", "exit_plan_mode"]);
  let EXTRA = 0;
  beforeAll(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "harness-measure-"));
    let tools: ChatRequest["tools"] = [];
    const driver = new HarnessDriver({
      config: profile(100_000),
      sessionsDir: path.join(scratch, "s"),
      home: scratch,
      transport: (request) => {
        tools = request.tools;
        return (async function* () {
          yield* answer("hi");
        })();
      },
    });
    await run(driver.startSession({ threadId: "m", workingDirectory: scratch, modelSelection: selection }));
    const { turnId } = await run(driver.sendTurn({ threadId: "m", prompt: "hi" }));
    await driver.awaitTurn("m", turnId);
    EXTRA = Math.ceil(tools.filter((tool) => !ORIGINAL_TOOLS.has(tool.name)).reduce((sum, tool) => sum + JSON.stringify(tool).length / 4, 0)) + 150;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  // Room for the system prompt and the tool list as they are today; both grow, and the fixtures below are sized against them.
  const WINDOW_BASE = 27_000;
  const window = (): number => WINDOW_BASE + Math.round(EXTRA * 2.5);
  const full = (): number => 14_000 + Math.round(EXTRA * 1.25);

  it("compacts after a turn that ends past the threshold, before the thread is free again", async () => {
    const { driver, requests, events } = driverWith([answer(long(3000)), answer(long(3000)), answer(long(3000), full()), summary(), answer("ok")], window());
    await start(driver);
    await send(driver, "first question");
    await send(driver, "second question");
    expect(await send(driver, "third question")).toMatchObject({ status: "completed" });
    expect(notices(events)).toEqual([expect.objectContaining({ notice: "compacted", title: "Conversation compacted automatically" })]);
    expect(requests).toHaveLength(4);
    await send(driver, "fourth question");
    expect(String(requests.at(-1)!.messages[1]!.content)).toContain("Fix the parser.");
  });

  it("on ask, leaves a turn past the line to the card, and compacts by itself only past the hard line", async () => {
    const asking = driverWith([answer(long(3000)), answer(long(3000)), answer(long(3000), full())], window(), {}, path.join(dir, "sessions"), { compaction: "ask" });
    await start(asking.driver);
    await send(asking.driver, "first question");
    await send(asking.driver, "second question");
    expect(await send(asking.driver, "third question")).toMatchObject({ status: "completed" });
    expect(notices(asking.events)).toEqual([]);
    expect(asking.requests).toHaveLength(3);
    // The card's Compact is a /compact turn, which the Harness answers as on any setting.
    asking.script.unshift(summary());
    await send(asking.driver, "/compact");
    expect(notices(asking.events)).toEqual([expect.objectContaining({ notice: "compacted" })]);
  });

  it("compacts in the middle of a long tool loop, before the next request", async () => {
    const file = path.join(work, "big.txt");
    fs.writeFileSync(file, `${"y".repeat(99)}\n`.repeat(160));
    const script: Step[] = [
      call("r1", "read", { file_path: file }, 1500),
      call("r2", "read", { file_path: file, offset: 2 }, 3000),
      call("r3", "read", { file_path: file, offset: 3 }, 9500 + Math.round(EXTRA * 1.25)),
      // What the third reply left, plus its result, is past the threshold: the next thing asked is the summary.
      summary(),
      answer("All read."),
    ];
    const { driver, requests, events } = driverWith(script, window(), { keepRecentTokens: 1000 });
    await start(driver);
    const outcome = await send(driver, "read it three times");
    expect(outcome).toMatchObject({ status: "completed", text: "All read." });
    expect(requests.filter((request) => request.toolChoice === "none")).toHaveLength(1);
    expect(requests.indexOf(requests.find((request) => request.toolChoice === "none")!)).toBe(3);
    expect(notices(events)).toHaveLength(1);
    // Every call still has its result in what the model sees afterwards.
    const wire = requests.at(-1)!.messages;
    const callIds = wire.flatMap((m) => ((m.tool_calls as Array<{ id: string }> | undefined) ?? []).map((c) => c.id));
    const resultIds = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(resultIds).toEqual(callIds);
    expect(callIds.length).toBeGreaterThan(0);
  });

  it("compacts when the server refuses a prompt as too long, then sends the same request again", async () => {
    const { driver, requests, events } = driverWith(
      [answer(long(3000)), answer(long(3000)), new ChatHttpError("prompt is too long", 400, true, false), summary(), answer("made it")],
      window(),
      { auto: false, keepRecentTokens: 2000 },
    );
    await start(driver);
    await send(driver, "first question");
    await send(driver, "second question");
    expect(await send(driver, "third question")).toMatchObject({ status: "completed", text: "made it" });
    expect(requests).toHaveLength(5);
    expect(notices(events)).toHaveLength(1);
    // The retried request holds the new prompt, after the summary.
    const retried = requests.at(-1)!.messages;
    expect(String(retried.at(-1)!.content)).toContain("third question");
    expect(String(retried[1]!.content)).toContain("Fix the parser.");
  });

  it("makes room and lets the reply finish when it is cut off by the limit with the window nearly full", async () => {
    const cut: ModelEvent[] = [{ type: "text.delta", text: long(3000) }, { type: "usage", usage: { inputTokens: full(), outputTokens: 500, cachedInputTokens: 0, reasoningTokens: 0 } }, { type: "finish", reason: "length" }];
    const { driver, requests } = driverWith([answer(long(3000)), cut, summary(), answer("and the rest")], window());
    await start(driver);
    await send(driver, "first question");
    expect(await send(driver, "second question")).toMatchObject({ status: "completed", text: "and the rest" });
    expect(String(requests.at(-1)!.messages.at(-1)!.content)).toMatch(/cut off/);
  });

  it("ends the turn and says so when compacting does not free enough room, instead of compacting again and again", async () => {
    const file = path.join(work, "big.txt");
    fs.writeFileSync(file, `${"y".repeat(99)}\n`.repeat(160));
    // Every kept message and the system prompt alone are past 80% of this threshold.
    const script: Step[] = [call("r1", "read", { file_path: file }, 1500), call("r2", "read", { file_path: file, offset: 2 }, 9000), summary()];
    const { driver, events } = driverWith(script, window(), { tokens: 4000 });
    await start(driver);
    const outcome = await send(driver, "read it twice");
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/too little room|smaller/) });
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
  });

  it("stops asking a summariser that keeps failing, and trims instead, until a manual /compact", async () => {
    const junk: ModelEvent[] = [{ type: "text.delta", text: "I would rather not." }, { type: "finish", reason: "stop" }];
    const script: Step[] = [answer(long(3000))];
    for (let turn = 0; turn < 3; turn += 1) script.push(answer(long(3000), full()), junk, junk);
    script.push(answer(long(3000), full()));
    const { driver, requests, events, script: queue } = driverWith(script, window());
    await start(driver);
    for (const prompt of ["one", "two", "three", "four", "five"]) expect(await send(driver, prompt)).toMatchObject({ status: "completed" });
    // Three compactions asked twice each (the reply and the nudge); the fourth did not ask at all.
    expect(requests.filter((request) => request.toolChoice === "none")).toHaveLength(6);
    expect(notices(events).map((notice) => notice.title)).toEqual(Array(4).fill("Conversation trimmed (no summary)"));
    // The user's own /compact asks again, and a summary that works starts the automatic ones asking afresh.
    queue.push(answer(long(3000)), summary());
    await send(driver, "six");
    expect(await send(driver, "/compact")).toMatchObject({ status: "completed" });
    expect(requests.filter((request) => request.toolChoice === "none")).toHaveLength(7);
    expect(notices(events).at(-1)).toMatchObject({ title: "Conversation compacted" });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessDriver } from "../driver.js";
import { cleanTitle, settledPrefix } from "../sidequery.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent, TranscriptMessage } from "../types.js";

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-aside-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const config = { profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "qwen3.8-flash-next" }] }] };
const selection = { instanceId: "harness/colab", model: "qwen3.8-flash-next" };
const say = (text: string): ModelEvent[] => [{ type: "text.delta", text }, { type: "finish", reason: "stop" }];
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

function driverWith(script: Array<ModelEvent[] | Error>, sessionsDir = path.join(dir, "sessions")) {
  const requests: ChatRequest[] = [];
  const driver = new HarnessDriver({
    config,
    sessionsDir,
    home: dir,
    sleep: async () => {},
    transport: (request) => {
      requests.push(request);
      const step = script.shift();
      return (async function* () {
        if (!step) throw new Error("script exhausted");
        if (step instanceof Error) throw step;
        yield* step;
      })();
    },
  });
  return { driver, requests };
}

async function talk(driver: HarnessDriver): Promise<string> {
  await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection }));
  const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "Fix the parser" }));
  await driver.awaitTurn("t1", turnId);
  return driver.resumeCursor("t1")!;
}

describe("sideQuestion (/btw)", () => {
  it("answers over a copy of the conversation with the same tools but no calls, and leaves the thread alone", async () => {
    const { driver, requests } = driverWith([say("Done."), say("Because it is cheaper.")]);
    const cursor = await talk(driver);
    const before = fs.readFileSync(path.join(dir, "sessions", `${cursor}.jsonl`), "utf8");
    const answer = await driver.sideQuestion({ cursor, workingDirectory: work, question: "  why a map?  ", model: selection.model });
    expect(answer).toEqual({ text: "Because it is cheaper.", withContext: true });
    const [turn, aside] = requests;
    expect(aside!.toolChoice).toBe("none");
    expect(aside!.tools).toEqual(turn!.tools);
    const last = aside!.messages.at(-1)!;
    expect(String(last.content)).toContain("Question: why a map?");
    expect(aside!.messages.some((message) => String(message.content).includes("Fix the parser"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "sessions", `${cursor}.jsonl`), "utf8")).toBe(before);
  });

  it("answers without context when the thread has no conversation, and says which profile it needs when only a model is known", async () => {
    const { driver, requests } = driverWith([say("Four.")]);
    await expect(driver.sideQuestion({ cursor: null, workingDirectory: work, question: "2+2?", model: selection.model })).resolves.toEqual({ text: "Four.", withContext: false });
    expect(requests[0]!.tools).toEqual([]);
    expect(requests[0]!.toolChoice).toBeUndefined();
    await expect(driver.sideQuestion({ cursor: null, workingDirectory: work, question: "x", model: "unlisted" })).rejects.toThrow(/which harness profile/);
  });

  it("reads the stored conversation when the process that had the session is gone", async () => {
    const sessionsDir = path.join(dir, "sessions");
    const first = driverWith([say("Done.")], sessionsDir);
    const cursor = await talk(first.driver);
    const second = driverWith([say("It was the parser."), say("No idea.")], sessionsDir);
    await expect(second.driver.sideQuestion({ cursor, workingDirectory: work, question: "what was it?", model: selection.model })).resolves.toMatchObject({ withContext: true });
    expect(second.requests[0]!.messages.some((message) => String(message.content).includes("Fix the parser"))).toBe(true);
    // A cursor is a file name: nothing else gets read.
    await expect(second.driver.sideQuestion({ cursor: "../../etc/passwd", workingDirectory: work, question: "x", model: selection.model })).resolves.toMatchObject({ withContext: false });
    expect(second.requests[1]!.messages.some((message) => String(message.content).includes("Fix the parser"))).toBe(false);
  });

  it("turns an endpoint failure and an empty answer into errors the client can show", async () => {
    const { driver } = driverWith([say("Done."), new Error("boom"), say("   ")]);
    const cursor = await talk(driver);
    await expect(driver.sideQuestion({ cursor, workingDirectory: work, question: "q", model: selection.model })).rejects.toThrow(/side question.*boom/s);
    await expect(driver.sideQuestion({ cursor, workingDirectory: work, question: "q", model: selection.model })).rejects.toThrow(/no answer/);
  });
});

describe("settledPrefix", () => {
  const call = { id: "c1", name: "read", arguments: "{}" };
  it("stops before a tool call whose results are not all in, and keeps one that is complete", () => {
    const base: TranscriptMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [call, { ...call, id: "c2" }] }, { role: "tool", toolCallId: "c1", name: "read", content: "a" }];
    expect(settledPrefix(base)).toEqual([base[0]]);
    const done = [...base, { role: "tool", toolCallId: "c2", name: "read", content: "b" } as const];
    expect(settledPrefix(done)).toEqual(done);
  });
});

describe("session titles", () => {
  it("makes one after the model has answered, keeps it, and makes another only when asked", async () => {
    const { driver, requests } = driverWith([say("Done."), say('"Fix the parser bug."\n'), say("Parser fix")]);
    await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection }));
    const cursor = driver.resumeCursor("t1")!;
    // Nothing said yet: nothing to title, and no request spent finding that out.
    await expect(driver.sessionTitle(cursor, work)).resolves.toBeNull();
    expect(requests).toHaveLength(0);
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "Fix the parser" }));
    await driver.awaitTurn("t1", turnId);
    await expect(driver.sessionTitle(cursor, work)).resolves.toBe("Fix the parser bug");
    expect(requests[1]!.toolChoice).toBe("none");
    await expect(driver.sessionTitle(cursor, work)).resolves.toBe("Fix the parser bug");
    expect(requests).toHaveLength(2);
    await expect(driver.regenerateSessionTitle(cursor, work)).resolves.toBe("Parser fix");
    await expect(driver.sessionTitle(cursor, work)).resolves.toBe("Parser fix");
  });

  it("gives up after two attempts that made nothing, until asked to regenerate", async () => {
    const { driver, requests } = driverWith([say("Done."), new Error("down"), say("  "), say("Third time")]);
    const cursor = await talk(driver);
    await expect(driver.sessionTitle(cursor, work)).resolves.toBeNull();
    await expect(driver.sessionTitle(cursor, work)).resolves.toBeNull();
    await expect(driver.sessionTitle(cursor, work)).resolves.toBeNull();
    expect(requests).toHaveLength(3);
    await expect(driver.regenerateSessionTitle(cursor, work)).resolves.toBe("Third time");
  });
});

describe("cleanTitle", () => {
  it("takes the first line without quotes, markup, a Title: prefix or closing punctuation, and caps its length", () => {
    expect(cleanTitle('**Title:** "Add retry to uploads."\nSecond line')).toBe("Add retry to uploads");
    expect(cleanTitle("\n\n# Fix flaky test\n")).toBe("Fix flaky test");
    expect(cleanTitle("  ")).toBeNull();
    expect(cleanTitle("x".repeat(200))!.length).toBe(80);
  });
});

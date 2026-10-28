import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessDriver } from "../driver.js";
import { runProbe, testProfile } from "../probe.js";
import { normalizeHarnessConfig } from "../profiles.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent, ReasoningItem } from "../types.js";

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-formats-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const signed: ReasoningItem = { format: "anthropic", item: { type: "thinking", thinking: "hm", signature: "SIG" } };
const reply = (text: string, withReasoning = false): ModelEvent[] => [...(withReasoning ? [{ type: "reasoning.item", item: signed } as ModelEvent] : []), { type: "text.delta", text }, { type: "finish", reason: "stop" }];

function driverFor(apiFormat: "chat" | "anthropic" | "responses", script: ModelEvent[][]) {
  const requests: ChatRequest[] = [];
  const driver = new HarnessDriver({
    config: { profiles: [{ id: "p", apiFormat, baseUrl: "http://x", models: [{ id: "claude-opus-5-5" }] }] },
    sessionsDir: path.join(dir, "sessions"),
    home: dir,
    sleep: async () => {},
    transport: (request) => {
      requests.push(request);
      const step = script.shift();
      return (async function* () {
        if (!step) throw new Error("script exhausted");
        yield* step;
      })();
    },
  });
  return { driver, requests };
}

const selection = { instanceId: "harness/p", model: "claude-opus-5-5" };

describe("API formats in a session", () => {
  it("accepts the three formats in a profile and refuses any other", () => {
    const profile = (apiFormat: unknown) => ({ profiles: [{ id: "p", apiFormat, baseUrl: "http://x", models: [{ id: "m" }] }] });
    for (const format of ["chat", "responses", "anthropic"]) expect(normalizeHarnessConfig(profile(format))?.profiles?.[0]?.apiFormat).toBe(format);
    expect(normalizeHarnessConfig({ profiles: [{ id: "p", baseUrl: "http://x", models: [{ id: "m" }] }] })?.profiles?.[0]?.apiFormat).toBe("chat");
    expect(() => normalizeHarnessConfig(profile("grpc"))).toThrow(/chat.*responses.*anthropic/);
  });

  it("hands the adapter the transcript and the format, keeps the reasoning it signs, and replays it on the next request", async () => {
    const { driver, requests } = driverFor("anthropic", [reply("One.", true), reply("Two.")]);
    await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection }));
    for (const prompt of ["first", "second"]) {
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt }));
      await driver.awaitTurn("t1", turnId);
    }
    expect(requests[0]).toMatchObject({ format: "anthropic", messages: [] });
    // (The transcript is the live one, so it has grown since; the first request saw it up to the first prompt.)
    expect(requests[0]!.transcript!.find((message) => message.role === "user")).toMatchObject({ content: "first" });
    const replayed = requests[1]!.transcript!.find((message) => message.role === "assistant");
    expect(replayed).toMatchObject({ content: "One.", reasoningItems: [signed] });
  });

  it("keeps chat sessions exactly as they were: chat wire messages, no transcript-only fields needed", async () => {
    const { driver, requests } = driverFor("chat", [reply("Hello.")]);
    await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection }));
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "hi" }));
    await driver.awaitTurn("t1", turnId);
    expect(requests[0]!.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(requests[0]!.format).toBe("chat");
  });

  it("sends compaction, /btw and titles in the same format as the conversation", async () => {
    const { driver, requests } = driverFor("responses", [reply("Done."), reply("Because."), reply("A title")]);
    await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection }));
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await driver.awaitTurn("t1", turnId);
    const cursor = driver.resumeCursor("t1")!;
    await driver.sideQuestion({ cursor, workingDirectory: work, question: "why?", model: selection.model });
    await driver.sessionTitle(cursor, work);
    expect(requests.map((request) => request.format)).toEqual(["responses", "responses", "responses"]);
    expect(requests[1]).toMatchObject({ toolChoice: "none" });
    expect(requests[1]!.transcript!.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Question: why?") });
  });
});

describe("Test and probe on other formats", () => {
  const profile = (apiFormat: "anthropic" | "responses") => ({ id: "p", apiFormat, baseUrl: "https://example.test", apiKeyEnv: "K", models: [{ id: "m" }] });

  it("tests an Anthropic and a Responses endpoint with one small request in each one's own shape", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      const events = url.endsWith("/messages")
        ? [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]
        : [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: {} }];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
    }) as unknown as typeof fetch;
    for (const format of ["anthropic", "responses"] as const) {
      const p = profile(format);
      await expect(testProfile({ profile: p, model: p.models[0]!, fetch: fake, env: { K: "key" } })).resolves.toMatchObject({ ok: true });
    }
    expect(seen).toEqual(["https://example.test/v1/messages", "https://example.test/v1/responses"]);
  });

  it("does not run the chat-template battery against them, and says why", async () => {
    const p = profile("anthropic");
    const report = await runProbe({ profile: p, model: p.models[0]!, fetch: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch, env: {} });
    expect(report.checks).toEqual([]);
    expect(report.stopped).toMatch(/does not have/);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTurn, type LoopEvent, type TurnConfig } from "../loop.js";
import { openMcpPool } from "../mcp.js";
import { stdioSpec } from "./mcpfixtures.js";
import { DEFAULT_QUIRKS } from "../quirks.js";
import { HarnessTranscript } from "../session.js";
import { builtinTools, ReadState, type HarnessTool } from "../tools/index.js";
import { ChatHttpError, type ChatRequest } from "../transport/chat.js";
import type { ModelEvent } from "../types.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-loop-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Script = Array<ModelEvent[] | Error>;

function setup(script: Script, overrides: Partial<TurnConfig> = {}) {
  const requests: ChatRequest[] = [];
  const events: LoopEvent[] = [];
  const config: TurnConfig = {
    baseUrl: "http://x",
    apiKey: () => undefined,
    model: "m",
    quirks: DEFAULT_QUIRKS,
    tools: builtinTools(),
    toolContext: { cwd: dir, readState: new ReadState(), artifactDir: path.join(dir, "art") },
    authorize: async () => ({ allow: true }),
    sleep: async () => {},
    transport: (request) => {
      requests.push(request);
      const step = script.shift();
      if (step === undefined) throw new Error("script exhausted");
      return (async function* () {
        if (step instanceof Error) throw step;
        yield* step;
      })();
    },
    ...overrides,
  };
  const transcript = HarnessTranscript.open(path.join(dir, "t.jsonl"));
  transcript.append({ role: "system", content: "SYSTEM" });
  const run = (text = "do it", signal = new AbortController().signal) => runTurn(transcript, { text }, "t1", config, (e) => events.push(e), signal);
  return { run, transcript, requests, events };
}

const text = (t: string): ModelEvent[] => [{ type: "text.delta", text: t }, { type: "finish", reason: "stop" }];
const toolCall = (name: string, args: unknown, id = `c_${name}`): ModelEvent[] => [
  { type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } },
  { type: "finish", reason: "tool-calls" },
];

describe("runTurn", () => {
  it.each([true, false])("preserves mixed MCP text and images through the transport when vision is %s", async (vision) => {
    const pool = await openMcpPool([stdioSpec(dir)], { cwd: dir, artifactDir: dir });
    try {
      const content = [
        { type: "text", text: "before" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "text", text: "after" },
      ];
      const { run, requests } = setup([toolCall("mcp__files__echo", { text: "", content }), text("seen")], {
        tools: pool.tools,
        quirks: { ...DEFAULT_QUIRKS, images: vision ? "native" : "none" },
        toolContext: { cwd: dir, readState: new ReadState(), artifactDir: dir, acceptsImages: vision },
      });
      expect((await run()).status).toBe("completed");
      const result = requests[1]!.messages.find((message) => message.role === "tool")!;
      expect(result.content).toMatch(vision ? /before\n\[image: image\/png, attached as MCP image 1\]\nafter/ : /before\n\[image: image\/png, model does not support images\]\nafter/);
      if (vision) expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: [
        { type: "text", text: "[Image returned by mcp__files__echo: MCP image 1]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ] });
      else expect(requests[1]!.messages.some((message) => Array.isArray(message.content))).toBe(false);
    } finally {
      await pool.close();
    }
  });

  it("runs a tool the model calls and shows it the result before it answers", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "hello\n");
    const { run, transcript, requests, events } = setup([toolCall("read", { file_path: file }), text("It says hello.")]);
    const result = await run();
    expect(result).toMatchObject({ status: "completed", text: "It says hello." });
    expect(transcript.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    // The second request carried the tool result.
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("hello") });
    expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(1);
  });

  it("answers a tool call it cannot run with the reason, and keeps going", async () => {
    const { run, transcript } = setup([
      toolCall("nope", {}, "c1"),
      toolCall("read", {}, "c2"),
      text("Sorry, done."),
    ]);
    const result = await run();
    expect(result.status).toBe("completed");
    const tools = transcript.messages.filter((m) => m.role === "tool");
    expect(tools[0]).toMatchObject({ isError: true, content: expect.stringMatching(/no tool named "nope".*read/) });
    expect(tools[1]).toMatchObject({ isError: true, content: expect.stringMatching(/needs the "file_path"/) });
  });

  it("does not run a tool the user has not allowed, and tells the model why", async () => {
    const file = path.join(dir, "w.txt");
    const { run, transcript } = setup([toolCall("write", { file_path: file, content: "x" }), text("ok")], {
      authorize: async () => ({ allow: false, reason: "Not allowed in this mode." }),
    });
    await run();
    expect(fs.existsSync(file)).toBe(false);
    expect(transcript.messages.find((m) => m.role === "tool")).toMatchObject({ content: "Not allowed in this mode.", isError: true });
  });

  it("retries a request that fails before producing anything, but not one that already streamed", async () => {
    const down = new ChatHttpError("busy", 503, false, true);
    const ok = setup([down, down, text("fine")]);
    expect(await ok.run()).toMatchObject({ status: "completed", text: "fine" });
    expect(ok.events.filter((e) => e.type === "retry")).toHaveLength(2);

    const exhausted = setup([down, down, down, down]);
    expect((await exhausted.run()).status).toBe("failed");

    // A request that already streamed output cannot be retried without repeating it.
    const failing = setup([], {
      transport: () =>
        (async function* () {
          yield { type: "text.delta", text: "partial" } as ModelEvent;
          throw down;
        })(),
    });
    const outcome = await failing.run();
    expect(outcome.status).toBe("failed");
    expect(failing.events.filter((e) => e.type === "retry")).toHaveLength(0);
  });

  it("fails a conversation that no longer fits instead of retrying it", async () => {
    const { run } = setup([new ChatHttpError("too long", 400, true, false)]);
    expect(await run()).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer fits/) });
  });

  describe("a 413", () => {
    const tooLarge = () => new ChatHttpError("The model endpoint answered 413: Payload Too Large", 413, false, false);
    const hook = (window: number) => {
      const reasons: string[] = [];
      return { reasons, compaction: { threshold: null, contextWindow: window, run: async (reason: string) => (reasons.push(reason), { status: "nothing" as const, message: "" }) } };
    };

    it("is not a context overflow when the prompt is far from filling the window", async () => {
      const { reasons, compaction } = hook(100_000);
      const { run } = setup([tooLarge()], { compaction });
      expect(await run()).toMatchObject({ status: "failed", error: expect.stringMatching(/413/) });
      expect(reasons).toEqual([]);
    });

    it("is one when our own count says the prompt nearly fills it", async () => {
      const { reasons, compaction } = hook(40);
      const { run } = setup([tooLarge()], { compaction });
      await run("x".repeat(400));
      expect(reasons).toEqual(["overflow"]);
    });
  });

  it("gives every tool call a result when the turn is interrupted while a tool runs", async () => {
    const controller = new AbortController();
    const { run, transcript } = setup([toolCall("bash", { command: "sleep 30" })]);
    const running = run("go", controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect((await running).status).toBe("interrupted");
    const roles = transcript.messages.map((m) => m.role);
    expect(roles.filter((r) => r === "tool")).toHaveLength(1);
    expect(roles.at(-1)).toBe("tool");
  }, 15000);

  it("nudges once after an empty reply following a tool result, then gives up", async () => {
    const empty: ModelEvent[] = [{ type: "finish", reason: "stop" }];
    const file = path.join(dir, "e.txt");
    fs.writeFileSync(file, "x");
    const nudged = setup([toolCall("read", { file_path: file }), empty, text("Here is what I found.")]);
    expect(await nudged.run()).toMatchObject({ status: "completed", text: "Here is what I found." });
    expect(nudged.transcript.messages.some((m) => m.role === "system" && m.content.includes("reply was empty"))).toBe(true);

    const stubborn = setup([toolCall("read", { file_path: file }), empty, empty]);
    expect((await stubborn.run()).status).toBe("failed");
  });

  it("ends a turn that repeats the same call", async () => {
    const file = path.join(dir, "r.txt");
    fs.writeFileSync(file, "x");
    const script: Script = Array.from({ length: 10 }, () => toolCall("read", { file_path: file }));
    const { run } = setup(script);
    expect(await run()).toMatchObject({ status: "failed", error: expect.stringMatching(/same read call/) });
  });

  it("records the usage of every request and what the last one held", async () => {
    const usage = (inputTokens: number, outputTokens: number, cachedInputTokens: number): ModelEvent => ({ type: "usage", usage: { inputTokens, outputTokens, cachedInputTokens, reasoningTokens: 5 } });
    const file = path.join(dir, "u.txt");
    fs.writeFileSync(file, "x");
    const { run } = setup([[...toolCall("read", { file_path: file }), usage(100, 10, 0)], [...text("done"), usage(150, 20, 100)]]);
    const result = await run();
    expect(result.usage).toEqual({ input: 150, cacheRead: 100, output: 30, thinking: 10 });
    expect(result.contextTokens).toBe(170);
  });

  it("reads text sent mid-turn at the next step, and answers it too when it arrives after the model's last answer", async () => {
    const file = path.join(dir, "s.txt");
    fs.writeFileSync(file, "x");
    // The first take happens before round two (the tool results are in), the second as the model finishes.
    const takes = [[{ text: "also do B", images: [] }], [{ text: "and C", images: [] }], []];
    const { run, requests, events } = setup([toolCall("read", { file_path: file }), text("A done."), text("B and C done.")], { takeSteering: () => takes.shift() ?? [] });
    expect(await run()).toMatchObject({ status: "completed", text: "B and C done." });
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "also do B" });
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: "and C" });
    expect(events.filter((e) => e.type === "steered")).toHaveLength(2);
  });

  it("ends the turn with a tool's answer when the tool hands over, after giving the call its result", async () => {
    const handover: HarnessTool<never> = {
      readOnly: true,
      definition: { name: "handover", description: "x", parameters: { type: "object", properties: {} } },
      intent: () => ({ action: "read", paths: [] }),
      run: async () => ({ content: "shown", endTurn: { answer: "the plan" } }),
    } as unknown as HarnessTool<never>;
    const { run, transcript } = setup([toolCall("handover", {}), text("must not be asked for")], { tools: [handover] });
    expect(await run()).toMatchObject({ status: "completed", text: "the plan" });
    expect(transcript.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("offers the tools as they are before each request, so a mid-turn change of mode takes effect at once", async () => {
    let planning = false;
    const all = builtinTools();
    const enter: HarnessTool<never> = {
      readOnly: false,
      definition: { name: "enter", description: "x", parameters: { type: "object", properties: {} } },
      intent: () => ({ action: "read", paths: [] }),
      run: async () => {
        planning = true;
        return { content: "on" };
      },
    } as unknown as HarnessTool<never>;
    const { run, requests } = setup([toolCall("enter", {}), text("ok")], { tools: () => (planning ? all.filter((t) => t.readOnly) : [enter, ...all]) });
    await run();
    expect(requests[0]!.tools.map((t) => t.name)).toContain("write");
    expect(requests[1]!.tools.map((t) => t.name)).not.toContain("write");
  });
});

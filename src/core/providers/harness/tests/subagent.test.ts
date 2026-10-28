import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "../../spi.js";
import { HarnessDriver } from "../driver.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent } from "../types.js";

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-subagent-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const config = { profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "m" }] }] };
const selection = { instanceId: "harness/colab", model: "m" };
const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } }, { type: "finish", reason: "tool-calls" }];
const say = (text: string, usage = false): ModelEvent[] => [
  { type: "text.delta", text },
  ...(usage ? [{ type: "usage", usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, reasoningTokens: 0 } } as ModelEvent] : []),
  { type: "finish", reason: "stop" },
];
type Step = ModelEvent[] | ((request: ChatRequest) => AsyncIterable<ModelEvent>);
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

function driverWith(script: Step[]) {
  const requests: ChatRequest[] = [];
  const driver = new HarnessDriver({
    config,
    sessionsDir: path.join(dir, "sessions"),
    home: dir,
    sleep: async () => {},
    transport: (request) => {
      requests.push(request);
      const step = script.shift();
      if (typeof step === "function") return step(request);
      return (async function* () {
        if (!step) throw new Error("script exhausted");
        yield* step;
      })();
    },
  });
  const events: ProviderRuntimeEvent[] = [];
  void Effect.runPromise(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
  return { driver, requests, events };
}

const until = async (check: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const names = (request: ChatRequest): string[] => request.tools.map((tool) => tool.name);

async function begin(driver: HarnessDriver, extra: Record<string, unknown> = {}) {
  await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection, ...extra }));
  return await run(driver.sendTurn({ threadId: "t1", prompt: "survey the module" }));
}

describe("the subagent tool", () => {
  it("runs a nested loop on its own conversation with read-only tools, returns the report as untrusted data, and keeps the parent's conversation clean", async () => {
    const file = path.join(work, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");
    const { driver, requests, events } = driverWith([
      call("p1", "subagent", { description: "survey a.ts", prompt: "Say what a.ts exports." }),
      call("s1", "read", { file_path: file }),
      say("It exports a.", true),
      say("Done: a exports a.", true),
    ]);
    const { turnId } = await begin(driver);
    const outcome = await driver.awaitTurn("t1", turnId);
    expect(outcome).toMatchObject({ status: "completed", text: "Done: a exports a." });
    const [, nestedFirst, , parentLast] = requests;
    // The parent's tools, minus asking, planning, the to-do list and more subagents.
    expect(names(nestedFirst!)).toEqual(expect.arrayContaining(["read", "edit", "write", "glob", "grep", "web_fetch", "web_search", "task_output", "task_stop"]));
    expect(names(nestedFirst!)).not.toEqual(expect.arrayContaining(["subagent"]));
    for (const hidden of ["subagent", "ask", "todo", "enter_plan_mode", "exit_plan_mode"]) expect(names(nestedFirst!)).not.toContain(hidden);
    expect(String(nestedFirst!.messages[0]!.content)).toContain("# Your role");
    expect(nestedFirst!.messages.at(-1)).toMatchObject({ role: "user", content: "Say what a.ts exports." });
    // The parent sees the report only, wrapped; the subagent's reads are not in its conversation.
    expect(parentLast!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/^<untrusted_context source="subagent">\nIt exports a\.\n<\/untrusted_context>$/) });
    expect(parentLast!.messages.some((message) => String(message.content).includes("export const a"))).toBe(false);
    const updates = events.filter((event) => event.type === "subagent.updated") as Array<Extract<ProviderRuntimeEvent, { type: "subagent.updated" }>>;
    expect(updates.map((event) => [event.status, event.agentType, event.lastMessage])).toEqual([["started", "general", null], ["stopped", "general", "It exports a."]]);
    expect(updates[0]).toMatchObject({ description: "survey a.ts", turnId });
    // Its tokens are counted with the turn's.
    expect(outcome.usage).toMatchObject({ input: 120, cacheRead: 80, output: 20 });
    // Its conversation is kept and reads back with the call paired to its result.
    const history = await driver.subagentHistory("t1", updates[0]!.agentId);
    expect(history!.map((item) => item.kind)).toEqual(["prompt", "tool", "text"]);
    expect(history![1]).toMatchObject({ tool: "read", raw: { toolUseId: "s1", input: { file_path: file }, isError: false } });
  });

  it("serves a subagent's history without a live session when given the thread's cursor, and nothing for an id that is not one", async () => {
    const { driver, events } = driverWith([call("p1", "subagent", { description: "d", prompt: "p" }), say("r"), say("ok")]);
    const { turnId } = await begin(driver);
    await driver.awaitTurn("t1", turnId);
    const cursor = driver.resumeCursor("t1")!;
    const agentId = (events.find((event) => event.type === "subagent.updated") as { agentId: string }).agentId;
    await run(driver.stopSession("t1"));
    expect(await driver.subagentHistory("t1", agentId)).toBeNull();
    expect((await driver.subagentHistory("t1", agentId, cursor))!.map((item) => item.kind)).toEqual(["prompt", "text"]);
    expect(await driver.subagentHistory("t1", "../../sessions/" + cursor, cursor)).toBeNull();
    expect(await driver.subagentHistory("t1", agentId, "../x")).toBeNull();
  });

  it("sends a general subagent's edit through the same approval prompt as the parent's, and does the edit only once it is accepted", async () => {
    const target = path.join(work, "new.txt");
    const { driver, events } = driverWith([
      call("p1", "subagent", { description: "write it", prompt: "Create new.txt", kind: "general" }),
      call("s1", "write", { file_path: target, content: "hi\n" }),
      say("Created."),
      say("All done."),
    ]);
    const { turnId } = await begin(driver, { runtimeMode: "approval-required" });
    await until(() => events.some((event) => event.type === "permission.request.opened"));
    expect(fs.existsSync(target)).toBe(false);
    const opened = events.find((event) => event.type === "permission.request.opened") as { requestId: string; raw: { toolName: string; classification: string } };
    expect(opened.raw).toMatchObject({ toolName: "write", classification: "file-change" });
    await run(driver.respondToRequest("t1", opened.requestId, { kind: "accept" }));
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
    expect(fs.readFileSync(target, "utf8")).toBe("hi\n");
  });

  it("refuses a subagent's call that needs approval when nobody can be asked, and tells the parent", async () => {
    const target = path.join(work, "no.txt");
    const { driver, requests, events } = driverWith([
      call("p1", "subagent", { description: "write it", prompt: "Create no.txt", kind: "general" }),
      call("s1", "write", { file_path: target, content: "x" }),
      say("Could not create it."),
      say("Reported."),
    ]);
    const { turnId } = await begin(driver, { runtimeMode: "approval-required", moxenSkills: "none", delegated: true });
    await driver.awaitTurn("t1", turnId);
    expect(fs.existsSync(target)).toBe(false);
    expect(events.some((event) => event.type === "permission.request.opened")).toBe(false);
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/needs approval.*no one|without anyone to ask/s) });
  });

  it("stops the subagent when the turn is interrupted, and still closes its entry", async () => {
    let nestedStarted = false;
    const { driver, events } = driverWith([
      call("p1", "subagent", { description: "slow", prompt: "Wait" }),
      (request) =>
        (async function* () {
          nestedStarted = true;
          await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
          yield* [] as ModelEvent[];
        })(),
    ]);
    const { turnId } = await begin(driver);
    await until(() => nestedStarted);
    await run(driver.interruptTurn("t1"));
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "interrupted" });
    await until(() => events.some((event) => event.type === "subagent.updated" && event.status === "stopped"));
  });

  it("stops one foreground subagent by its id, closes its entry, and lets the parent carry on", async () => {
    let nestedStarted = false;
    const { driver, events } = driverWith([
      call("p1", "subagent", { description: "slow", prompt: "Wait" }),
      (request) =>
        (async function* () {
          nestedStarted = true;
          await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
          yield* [] as ModelEvent[];
        })(),
      say("the subagent was stopped"),
    ]);
    const { turnId } = await begin(driver);
    await until(() => nestedStarted);
    const started = events.find((event) => event.type === "subagent.updated" && event.status === "started");
    await run(driver.stopBackgroundTask("t1", started?.type === "subagent.updated" ? started.agentId : "missing"));
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
    expect(events.some((event) => event.type === "subagent.updated" && event.status === "stopped")).toBe(true);
  });
});

describe("subagents beside each other and in the background", () => {
  const slotted = (slots?: number) => ({ profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", ...(slots !== undefined ? { slots } : {}), models: [{ id: "m" }] }] });

  function liveDriver(config: ReturnType<typeof slotted>, respond: (request: ChatRequest) => AsyncIterable<ModelEvent>) {
    const requests: ChatRequest[] = [];
    let active = 0;
    let peak = 0;
    const driver = new HarnessDriver({
      config,
      sessionsDir: path.join(dir, "sessions"),
      home: dir,
      sleep: async () => {},
      transport: (request) => {
        requests.push(request);
        return (async function* () {
          active += 1;
          peak = Math.max(peak, active);
          try {
            yield* respond(request);
          } finally {
            active -= 1;
          }
        })();
      },
    });
    const events: ProviderRuntimeEvent[] = [];
    void Effect.runPromise(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
    return { driver, requests, events, peak: () => peak };
  }

  const reply = (request: ChatRequest): AsyncIterable<ModelEvent> => {
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    const parent = request.tools.some((tool) => tool.name === "subagent");
    return (async function* () {
      if (parent && last?.role === "user") {
        yield* [
          { type: "tool.call", call: { id: "a", name: "subagent", arguments: JSON.stringify({ description: "first", prompt: "task one" }) } },
          { type: "tool.call", call: { id: "b", name: "subagent", arguments: JSON.stringify({ description: "second", prompt: "task two" }) } },
          { type: "tool.call", call: { id: "c", name: "subagent", arguments: JSON.stringify({ description: "third", prompt: "task three" }) } },
          { type: "finish", reason: "tool-calls" },
        ] as ModelEvent[];
      } else if (last?.role === "user") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield* say(`report for ${text}`);
      } else {
        yield* say("all three are back");
      }
    })();
  };

  it("runs several subagents of one reply at the same time when the server has room", async () => {
    const { driver, peak } = liveDriver(slotted(), reply);
    const { turnId } = await begin(driver);
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed", text: "all three are back" });
    expect(peak()).toBe(3);
  });

  it("queues them behind the server's slots instead", async () => {
    const { driver, peak } = liveDriver(slotted(1), reply);
    const { turnId } = await begin(driver);
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
    expect(peak()).toBe(1);
    const two = liveDriver(slotted(2), reply);
    await run(two.driver.stopSession("t1")).catch(() => undefined);
  });

  it("refuses /btw while a turn is running on a one-slot server, and answers it when idle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { driver } = liveDriver(slotted(1), (request) =>
      (async function* () {
        if (request.messages.at(-1)?.content === "survey the module") await gate;
        yield* say("ok");
      })(),
    );
    const { turnId } = await begin(driver);
    const cursor = driver.resumeCursor("t1");
    await expect(driver.sideQuestion({ cursor, workingDirectory: work, question: "what is this?", model: "m" })).rejects.toMatchObject({ code: "SIDE_QUESTION_BUSY" });
    release();
    await driver.awaitTurn("t1", turnId);
    await expect(driver.sideQuestion({ cursor, workingDirectory: work, question: "what is this?", model: "m" })).resolves.toMatchObject({ text: "ok" });
  });

  it("starts a background subagent at once, reports its end through the log, and wakes the model with it", async () => {
    let released = false;
    const { driver, requests, events } = liveDriver(slotted(), (request) =>
      (async function* () {
        const last = request.messages.at(-1);
        const parent = request.tools.some((tool) => tool.name === "subagent");
        if (parent && last?.role === "user" && String(last.content) === "survey the module") {
          yield* call("a", "subagent", { description: "dig", prompt: "dig deep", run_in_background: true });
        } else if (parent && last?.role === "tool") {
          yield* say("Started it; waiting.");
        } else if (parent && last?.role === "user") {
          yield* say("The subagent finished: found it.");
        } else {
          while (!released) await new Promise((resolve) => setTimeout(resolve, 10));
          yield* say("Found it in a.ts.");
        }
      })(),
    );
    const { turnId } = await begin(driver);
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed", text: "Started it; waiting." });
    expect(events.some((event) => event.type === "background.task" && event.status === "started" && event.taskType === "local_agent")).toBe(true);
    released = true;
    // The idle session starts a turn of its own to hear of it.
    await until(() => events.some((event) => event.type === "turn.started" && event.origin === "background"));
    await until(() => events.filter((event) => event.type === "turn.completed").length === 2);
    const woken = requests.at(-1)!.messages.find((message) => message.role === "user" && String(message.content).includes("Background subagent"));
    expect(String(woken?.content)).toMatch(/Found it in a\.ts\./);
    expect(String(woken?.content)).toMatch(/subagent/);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { permissionActivityRow, userInputActivityRow, type UserInputRuntimeEvent } from "../../../threads/requestactivity.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { HarnessDriver } from "../driver.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent } from "../types.js";

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-driver-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const config = {
  profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "qwen3.8-flash-next", contextWindow: 262144 }] }],
};
const selection = { instanceId: "harness/colab", model: "qwen3.8-flash-next" };

function driverWith(script: ModelEvent[][]) {
  const requests: ChatRequest[] = [];
  const driver = new HarnessDriver({
    config,
    sessionsDir: path.join(dir, "sessions"),
    // Nothing from the real home directory or the package: a test sees only its own skills.
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
  const events: ProviderRuntimeEvent[] = [];
  void Effect.runPromise(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
  return { driver, requests, events };
}

const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } }, { type: "finish", reason: "tool-calls" }];

async function until(events: ProviderRuntimeEvent[], predicate: (event: ProviderRuntimeEvent) => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!events.some(predicate)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for an event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const answer = (text: string): ModelEvent[] => [{ type: "reasoning.delta", text: "hmm" }, { type: "text.delta", text }, { type: "usage", usage: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 20, reasoningTokens: 1 } }, { type: "finish", reason: "stop" }];

async function start(driver: HarnessDriver, extra: Record<string, unknown> = {}) {
  await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection, ...extra }));
}

describe("HarnessDriver", () => {
  it("sends to a profile added after it was built, and drops the window an edited profile no longer states", async () => {
    // The server builds one driver and keeps it; the settings editor changes profiles under it.
    const { driver, requests } = driverWith([answer("a"), answer("b")]);
    driver.setConfig({ profiles: [] });
    await start(driver);
    await expect(run(driver.sendTurn({ threadId: "t1", prompt: "hi" }))).rejects.toThrow(/No harness profile "colab"/);
    driver.setConfig(config);
    const first = await run(driver.sendTurn({ threadId: "t1", prompt: "hi" }));
    await driver.awaitTurn("t1", first.turnId);
    await expect(driver.contextUsage("t1")).resolves.toMatchObject({ maxTokens: 262144 });
    driver.setConfig({ profiles: [{ ...config.profiles[0]!, models: [{ id: "qwen3.8-flash-next" }] }] });
    const second = await run(driver.sendTurn({ threadId: "t1", prompt: "again" }));
    await driver.awaitTurn("t1", second.turnId);
    expect(requests).toHaveLength(2);
    await expect(driver.contextUsage("t1")).resolves.toMatchObject({ maxTokens: null });
  });

  it("runs a turn, publishes the events the other drivers publish, and settles awaitTurn", async () => {
    const { driver, events } = driverWith([answer("Hello there.")]);
    await start(driver);
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "hi" }));
    const outcome = await driver.awaitTurn("t1", turnId);
    expect(outcome).toMatchObject({ status: "completed", text: "Hello there.", usage: { input: 30, cacheRead: 20, output: 5, thinking: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const types = events.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["reasoning.updated", "reasoning.delta", "message.part.updated", "token-usage.updated", "turn.completed"]));
    expect(events.filter((event) => event.type === "reasoning.updated").map((event) => (event as { status: string }).status)).toEqual(["running", "completed"]);
    await expect(driver.contextUsage("t1")).resolves.toMatchObject({ usedTokens: 55, maxTokens: 262144 });
  });

  it("publishes a tool call in the shape the activity ledger reads", async () => {
    const file = path.join(work, "a.txt");
    fs.writeFileSync(file, "x\n");
    const { driver, events } = driverWith([call("c1", "read", { file_path: file }), call("c2", "write", { file_path: file, content: "y" }), answer("Done.")]);
    await start(driver, { runtimeMode: "full-access" });
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await driver.awaitTurn("t1", turnId);
    const completed = events.filter((event) => event.type === "tool.execute.completed") as Array<{ tool: string; raw: { toolUseId: string; isError: boolean } }>;
    expect(completed.map((event) => [event.tool, event.raw.toolUseId, event.raw.isError])).toEqual([["read", "c1", false], ["write", "c2", false]]);
  });

  describe("approvals", () => {
    const opened = (events: ProviderRuntimeEvent[]) => events.filter((event) => event.type === "permission.request.opened") as Array<{ requestId: string; raw: { toolName: string; classification: string; input: Record<string, string> } }>;

    it("parks an edit in approval-required mode in the shape the approval prompt reads, and runs it only once accepted", async () => {
      const file = path.join(work, "new.txt");
      const { driver, events } = driverWith([call("c1", "write", { file_path: file, content: "y\n" }), answer("Written.")]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      expect(opened(events)[0]).toMatchObject({ raw: { toolName: "write", classification: "file-change", input: { file_path: file } } });
      expect(fs.existsSync(file)).toBe(false);
      // The ledger row the approval prompt is built from.
      expect(permissionActivityRow(events.find((event) => event.type === "permission.request.opened") as never).payload).toMatchObject({ toolName: "write", classification: "file-change", detail: file });
      await run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "accept" }));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
      expect(fs.readFileSync(file, "utf8")).toBe("y\n");
      expect(events.some((event) => event.type === "permission.request.resolved" && (event as { raw: { behavior: string } }).raw.behavior === "allow")).toBe(true);
    });

    it("tells the model a declined call was declined, and does not let it try another way", async () => {
      const file = path.join(work, "a.txt");
      const { driver, events, requests } = driverWith([call("c1", "write", { file_path: file, content: "y" }), answer("Understood.")]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      await run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "decline" }));
      await driver.awaitTurn("t1", turnId);
      expect(fs.existsSync(file)).toBe(false);
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/declined.*another way/s) });
    });

    it("remembers acceptForSession per command pattern, not per tool", async () => {
      const { driver, events } = driverWith([call("c1", "bash", { command: "git status" }), call("c2", "bash", { command: "git status -s" }), call("c3", "bash", { command: "git log" }), answer("Done.")]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      await run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "acceptForSession" }));
      // `git status -s` is covered; `git log` is a different pattern and asks again.
      await until(events, () => opened(events).length === 2);
      expect(opened(events)[1]!.raw.input.command).toBe("git log");
      await run(driver.respondToRequest("t1", opened(events)[1]!.requestId, { kind: "decline" }));
      await driver.awaitTurn("t1", turnId);
      expect(opened(events)).toHaveLength(2);
    });

    it("follows a permission mode changed mid-turn from the next tool call", async () => {
      const a = path.join(work, "a.txt");
      const b = path.join(work, "b.txt");
      const { driver, events } = driverWith([call("c1", "write", { file_path: a, content: "a\n" }), call("c2", "write", { file_path: b, content: "b\n" }), answer("Done.")]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      driver.setRuntimeMode("t1", "full-access");
      await run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "accept" }));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
      // The second write was not asked about.
      expect(opened(events)).toHaveLength(1);
      expect(fs.readFileSync(b, "utf8")).toBe("b\n");
    });

    it("lets an interrupt resolve a parked approval and gives the call a result", async () => {
      const file = path.join(work, "a.txt");
      const { driver, events } = driverWith([call("c1", "write", { file_path: file, content: "y" })]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      await run(driver.interruptTurn("t1"));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "interrupted" });
      expect(events.some((event) => event.type === "permission.request.resolved")).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
      const snapshot = await run(driver.readThread("t1"));
      expect(JSON.stringify(snapshot)).toContain('"role":"tool"');
      await expect(run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "accept" }))).rejects.toThrow(/No pending/);
    });

    it("stops the turn on cancel", async () => {
      const { driver, events } = driverWith([call("c1", "bash", { command: "echo hi" })]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      await run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "cancel" }));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "interrupted" });
    });

    it("refuses instead of waiting in a delegated session, where nobody can answer", async () => {
      const { driver, events, requests } = driverWith([call("c1", "bash", { command: "echo hi" }), answer("Could not.")]);
      await start(driver, { runtimeMode: "approval-required", moxenSkills: "none", delegated: true });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
      expect(opened(events)).toHaveLength(0);
      expect(requests[1]!.messages.at(-1)).toMatchObject({ content: expect.stringMatching(/without anyone to ask/) });
    });

    it("still refuses a call that reaches the original checkout from an isolated worktree, whatever the mode", async () => {
      const outside = path.join(dir, "main-checkout");
      fs.mkdirSync(outside);
      const { driver, events, requests } = driverWith([call("c1", "write", { file_path: path.join(outside, "x.txt"), content: "y" }), answer("Blocked.")]);
      await start(driver, { runtimeMode: "full-access", isolation: { worktreeRoot: work, protectedRoots: [outside] } });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await driver.awaitTurn("t1", turnId);
      expect(fs.existsSync(path.join(outside, "x.txt"))).toBe(false);
      expect(opened(events)).toHaveLength(0);
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool" });
    });
  });

  it("never offers plan mode tools: Moxen has no plan mode", async () => {
    const { driver, requests } = driverWith([answer("Done.")]);
    await start(driver);
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await driver.awaitTurn("t1", turnId);
    const names = requests[0]!.tools.map((tool) => tool.name);
    expect(names).not.toContain("enter_plan_mode");
    expect(names).not.toContain("exit_plan_mode");
    expect(names).toEqual(expect.arrayContaining(["edit", "bash", "ask", "todo"]));
  });

  it("publishes the todo list the way the tasks panel reads it, and refuses two items in progress", async () => {
    const todos = (a: string, b: string) => ({ todos: [{ content: "One", status: a }, { content: "Two", status: b }] });
    const { driver, events, requests } = driverWith([call("c1", "todo", todos("in_progress", "in_progress")), call("c2", "todo", todos("completed", "in_progress")), answer("Ok.")]);
    await start(driver);
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await driver.awaitTurn("t1", turnId);
    const updates = events.filter((event) => event.type === "turn.plan.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ raw: { plan: [{ step: "One", status: "completed" }, { step: "Two", status: "inProgress" }] } });
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/2 items are in_progress/) });
  });

  describe("questions", () => {
    const question = { question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "Hosted" }, { label: "SQLite" }] };
    const asked = (events: ProviderRuntimeEvent[]) => events.filter((event) => event.type === "user-input.request.opened") as Array<{ requestId: string; raw: { toolName: string; input: { questions: unknown[] } } }>;

    it("parks the questions in the shape the answer panel reads and hands the answers back to the model", async () => {
      const { driver, events, requests } = driverWith([call("c1", "ask", { questions: [question] }), answer("Using Postgres.")]);
      await start(driver);
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "user-input.request.opened");
      expect(asked(events)[0]!.raw.input.questions[0]).toMatchObject({ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "Hosted" }, { label: "SQLite" }] });
      // The ledger row the answer panel is built from; its question id is the key the answers come back under.
      expect(userInputActivityRow(events.find((event) => event.type === "user-input.request.opened") as UserInputRuntimeEvent)?.payload).toMatchObject({ questions: [{ id: "Which database?" }] });
      await run(driver.respondToUserInput("t1", asked(events)[0]!.requestId, { "Which database?": "Postgres" }));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining('"Which database?" = "Postgres"') });
      expect(events.some((event) => event.type === "user-input.request.resolved")).toBe(true);
    });

    it("treats a dismissed question as an answer the model can work with, and a cancelled one as a stop", async () => {
      const { driver, events, requests } = driverWith([call("c1", "ask", { questions: [question] }), answer("Assuming SQLite.")]);
      await start(driver);
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "user-input.request.opened");
      await run(driver.respondToRequest("t1", asked(events)[0]!.requestId, { kind: "decline" }));
      await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
      expect(requests[1]!.messages.at(-1)).toMatchObject({ content: expect.stringMatching(/dismissed/) });

      const other = driverWith([call("c1", "ask", { questions: [question] })]);
      await start(other.driver);
      const second = await run(other.driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(other.events, (event) => event.type === "user-input.request.opened");
      await run(other.driver.respondToRequest("t1", asked(other.events)[0]!.requestId, { kind: "cancel" }));
      await expect(other.driver.awaitTurn("t1", second.turnId)).resolves.toMatchObject({ status: "interrupted" });
    });

    it("rejects a permission decision aimed at a question, and offers no ask tool to a delegated session", async () => {
      const { driver, events } = driverWith([call("c1", "ask", { questions: [question] }), answer("x")]);
      await start(driver);
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "user-input.request.opened");
      await expect(run(driver.respondToRequest("t1", asked(events)[0]!.requestId, { kind: "accept" }))).rejects.toThrow(/needs user input/);
      await run(driver.interruptTurn("t1"));
      await driver.awaitTurn("t1", turnId);

      const delegated = driverWith([answer("ok")]);
      await start(delegated.driver, { moxenSkills: "none", delegated: true });
      const sent = await run(delegated.driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await delegated.driver.awaitTurn("t1", sent.turnId);
      expect(delegated.requests[0]!.tools.map((tool) => tool.name)).not.toContain("ask");
      expect(JSON.stringify(delegated.requests[0]!.messages)).not.toMatch(/ask with ask/);
    });
  });

  describe("steering", () => {
    it("carries the images of a steer onto the user message (as a note for a model without vision)", async () => {
      const { driver, events, requests } = driverWith([call("c1", "bash", { command: "echo hi" }), answer("Seen.")]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      const image = { name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" };
      await run(driver.steerTurn("t1", "see this", [image]));
      const request = events.find((event) => event.type === "permission.request.opened") as { requestId: string };
      await run(driver.respondToRequest("t1", request.requestId, { kind: "accept" }));
      await driver.awaitTurn("t1", turnId);
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "see this\n\n[Attached image: a.png]" });
    });

    it("hands text sent during a turn to the model as a user message at its next step", async () => {
      const { driver, events, requests } = driverWith([call("c1", "bash", { command: "echo hi" }), answer("Switched.")]);
      await start(driver, { runtimeMode: "approval-required" });
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
      await until(events, (event) => event.type === "permission.request.opened");
      await run(driver.steerTurn("t1", "actually, use python"));
      const request = events.find((event) => event.type === "permission.request.opened") as { requestId: string };
      await run(driver.respondToRequest("t1", request.requestId, { kind: "accept" }));
      await driver.awaitTurn("t1", turnId);
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "actually, use python" });
      await expect(run(driver.steerTurn("t1", "too late"))).rejects.toThrow(/no running turn/);
    });
  });

  it("resumes a session from its cursor with the same history, and tells the model when the instructions changed", async () => {
    const first = driverWith([answer("One.")]);
    await start(first.driver, { instructions: "Be brief." });
    const turn = await run(first.driver.sendTurn({ threadId: "t1", prompt: "first" }));
    await first.driver.awaitTurn("t1", turn.turnId);
    const cursor = first.driver.resumeCursor("t1")!;

    const second = driverWith([answer("Two.")]);
    await start(second.driver, { resumeCursor: cursor, instructions: "Be verbose." });
    const next = await run(second.driver.sendTurn({ threadId: "t1", prompt: "second" }));
    await second.driver.awaitTurn("t1", next.turnId);
    const sent = JSON.stringify(second.requests[0]!.messages);
    expect(sent).toContain("first");
    expect(sent).toContain("Be verbose.");
    expect(sent).toContain("runtime instructions have changed");
  });

  it("rolls back turns and refuses a second turn while one runs", async () => {
    const { driver } = driverWith([answer("A."), answer("B.")]);
    await start(driver);
    for (const prompt of ["one", "two"]) {
      const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt }));
      await driver.awaitTurn("t1", turnId);
    }
    const snapshot = await run(driver.rollbackThread("t1", 1));
    expect(snapshot.turns).toHaveLength(1);
    await expect(run(driver.rollbackThread("t1", 5))).rejects.toThrow();
  });

  it("interrupts a running turn", async () => {
    const calls: ModelEvent[] = [{ type: "tool.call", call: { id: "c1", name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) } }, { type: "finish", reason: "tool-calls" }];
    const { driver } = driverWith([calls]);
    await start(driver);
    const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt: "wait" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await run(driver.interruptTurn("t1"));
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "interrupted" });
  }, 15000);

  it("fails a turn on a profile that does not exist, and answers /compact on a thread with nothing to compact", async () => {
    const { driver } = driverWith([]);
    await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: { instanceId: "harness/nope", model: "m" } }));
    await expect(run(driver.sendTurn({ threadId: "t1", prompt: "hi" }))).rejects.toThrow(/No harness profile "nope"/);
    const other = driverWith([]);
    await start(other.driver);
    const { turnId } = await run(other.driver.sendTurn({ threadId: "t1", prompt: "/compact" }));
    await expect(other.driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/too short to compact/) });
  });
});

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";

import { CliError } from "../../../errors.js";
import { CLAUDE_NATIVE_TOOLS } from "../../../nativetools.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { ClaudeDriver, claudeContextUsageOf } from "../driver.js";
import {
  assistantText,
  assistantToolUse,
  compactBoundary,
  errorResult,
  FakeSessionApi,
  FakeTransport,
  historyToolResult,
  historyUser,
  initMessage,
  permissionCallbackOptions,
  rateLimitEvent,
  successResult,
} from "./fakes.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectEvents(driver: ClaudeDriver, count: number): Promise<ProviderRuntimeEvent[]> {
  const chunk = await Effect.runPromise(Stream.runCollect(Stream.take(driver.streamEvents, count)));
  return [...chunk];
}

function openedRequestId(events: ProviderRuntimeEvent[], type: string): string {
  const opened = events.find((event) => event.type === type);
  expect(opened).toBeDefined();
  return (opened as { requestId: string }).requestId;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof CliError) return cause.code;
    throw cause;
  }
  throw new Error("expected a CliError");
}

const START = { threadId: "thread-1", workingDirectory: "/repo" };

describe("claude driver turns", () => {
  it("lists skills and built-in commands from a prompt-less query, then closes it", async () => {
    const transport = new FakeTransport([[]]);
    transport.commands = [
      { name: "handoff", description: "Hand the conversation off. (user)", argumentHint: "What next?" },
      { name: "review", description: "Review the diff (project)", argumentHint: "" },
      { name: "compact", description: "Compact the conversation", argumentHint: "<focus>", builtin: true },
    ];
    const driver = new ClaudeDriver({ transport });
    const inventory = await driver.skillInventory("/repo");
    expect(transport.created[0]!.options.cwd).toBe("/repo");
    expect(transport.created[0]!.closed).toBe(true);
    expect(inventory.trigger).toBe("/");
    expect(inventory.skills.map((skill) => [skill.name, skill.description])).toEqual([
      ["handoff", "Hand the conversation off."],
      ["review", "Review the diff"],
    ]);
    expect(inventory.commands).toEqual([
      { name: "compact", description: "Compact the conversation", argumentHint: "<focus>", builtin: true },
    ]);
  });

  it("always runs on Claude Code's own system prompt, appending runtime instructions when given", async () => {
    const transport = new FakeTransport([[initMessage()], [initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, instructions: "Report back." }));
    expect(transport.created[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Report back." });
    await Effect.runPromise(driver.startSession({ ...START, threadId: "thread-2" }));
    // Never omitted: the SDK would substitute an empty prompt.
    expect(transport.created[1]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("loads the agent-skills mod for the user's own .agents/skills, and only then", async () => {
    const skillsMod = { path: "/pkg/mods/agent-skills" };
    const on = new FakeTransport([[initMessage()]]);
    await Effect.runPromise(new ClaudeDriver({ transport: on, skillsMod }).startSession(START));
    expect(on.created[0]!.options.plugins).toEqual([{ type: "local", path: "/pkg/mods/agent-skills" }]);

    // Off by default, so a session without it is exactly what it was.
    const absent = new FakeTransport([[initMessage()]]);
    await Effect.runPromise(new ClaudeDriver({ transport: absent }).startSession(START));
    expect(absent.created[0]!.options.plugins).toBeUndefined();

    // The user's own .agents/skills switched off: nothing needs the mod.
    const off = new FakeTransport([[initMessage()]]);
    await Effect.runPromise(new ClaudeDriver({ transport: off, skillsMod, settings: { agentSkills: false } }).startSession(START));
    expect(off.created[0]!.options.plugins).toBeUndefined();
  });

  it("takes the final answer from the result, not every interim note", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await sleep(20);
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    transport.created[0]!.push(assistantText("Let me look at the file."));
    transport.created[0]!.push(assistantToolUse("tu-1", "Read", { file_path: "/repo/a.ts" }));
    transport.created[0]!.push(assistantText("It exports one function."));
    transport.created[0]!.push(successResult("It exports one function.", 0.01));
    const outcome = await outcomePromise;
    expect(outcome.text).toBe("It exports one function.");
  });

  it("records the thread's running total on each turn, the cost never going down (MXN-170)", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await sleep(20);

    const first = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    const firstOutcome = driver.awaitTurn("thread-1", first.turnId);
    transport.created[0]!.push(assistantText("a", { input_tokens: 10, output_tokens: 5 }));
    transport.created[0]!.push(successResult("a", 0.02));
    expect((await firstOutcome).usage).toMatchObject({ input: 10, output: 5, costUsd: 0.02 });

    const second = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    const secondOutcome = driver.awaitTurn("thread-1", second.turnId);
    transport.created[0]!.push(assistantText("b", { input_tokens: 20, output_tokens: 7 }));
    // A result reporting less than was already seen does not lower the total.
    transport.created[0]!.push(successResult("b", 0.01));
    expect((await secondOutcome).usage).toMatchObject({ input: 30, output: 12, costUsd: 0.02 });
  });

  it("starts a session and runs a turn to completion", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    expect(await Effect.runPromise(driver.hasSession("thread-1"))).toBe(true);
    await sleep(20);

    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    transport.created[0]!.push(assistantText("hello", { input_tokens: 10, output_tokens: 5 }));
    transport.created[0]!.push(successResult("hello", 0.02));
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("hello");
    expect(outcome.usage).toMatchObject({ input: 10, output: 5, costUsd: 0.02 });

    const snapshot = await Effect.runPromise(driver.readThread("thread-1"));
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]!.items.map((item) => (item as { kind: string }).kind)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("rejects sends without a session and concurrent turns", async () => {
    const driver = new ClaudeDriver({ transport: new FakeTransport([]) });
    expect(await codeOf(() => Effect.runPromise(driver.sendTurn({ threadId: "t-x", prompt: "hi" })))).toBe(
      "CLAUDE_NOT_STARTED",
    );

    const driver2 = new ClaudeDriver({ transport: new FakeTransport([[initMessage()]]) });
    await Effect.runPromise(driver2.startSession(START));
    await Effect.runPromise(driver2.sendTurn({ threadId: "thread-1", prompt: "one" }));
    expect(await codeOf(() => Effect.runPromise(driver2.sendTurn({ threadId: "thread-1", prompt: "two" })))).toBe(
      "TURN_BUSY",
    );
  });

  it("interrupts a running turn", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    await Effect.runPromise(driver.interruptTurn("thread-1"));
    await expect(outcomePromise).resolves.toMatchObject({ status: "interrupted" });
    expect(transport.created[0]!.interrupted).toBe(1);
  });

  it("fails turns on error results", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    transport.created[0]!.push(errorResult());
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("boom");
  });
});

describe("claude driver permissions", () => {
  async function parkedSetup() {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 3);
    await Effect.runPromise(driver.startSession({ ...START, runtimeMode: "approval-required" }));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    transport.created[0]!.push(assistantToolUse("tu-1", "Bash"));
    await sleep(20);
    const pending = driver.handlePermissionRequest(
      "Bash",
      { command: "ls" },
      permissionCallbackOptions("tu-1"),
    );
    const events = await eventsPromise;
    return { driver, pending, events };
  }

  it("parks tool requests until answered", async () => {
    const { driver, pending, events } = await parkedSetup();
    expect(events.map((event) => event.type)).toContain("permission.request.opened");
    const requestId = openedRequestId(events, "permission.request.opened");

    await Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "accept" }));
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("acceptForSession allows later tools without parking", async () => {
    const { driver, pending, events } = await parkedSetup();
    const requestId = openedRequestId(events, "permission.request.opened");
    await Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "acceptForSession" }));
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });

    const second = await driver.handlePermissionRequest(
      "Bash",
      { command: "pwd" },
      permissionCallbackOptions("tu-2"),
    );
    expect(second).toMatchObject({ behavior: "allow" });
  });

  it("cancels with interrupt and rejects unknown requests", async () => {
    const { driver, pending, events } = await parkedSetup();
    const requestId = openedRequestId(events, "permission.request.opened");
    expect(
      await codeOf(() => Effect.runPromise(driver.respondToRequest("thread-1", "nope", { kind: "accept" }))),
    ).toBe("REQUEST_UNKNOWN");
    await Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "cancel" }));
    await expect(pending).resolves.toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("surfaces AskUserQuestion and resolves answers", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 2);
    await Effect.runPromise(driver.startSession(START));
    const pending = driver.handlePermissionRequest(
      "AskUserQuestion",
      { questions: [{ question: "Which?", options: [] }] },
      permissionCallbackOptions(),
    );
    const events = await eventsPromise;
    const requestId = openedRequestId(events, "user-input.request.opened");
    await Effect.runPromise(driver.respondToUserInput("thread-1", requestId, { Which: "this" }));
    await expect(pending).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { Which: "this" } },
    });
  });

  it("answers a question without dropping the input it was asked with", async () => {
    // `updatedInput` replaces the tool input wholesale: answers alone would
    // strip `questions` and fail the tool's own schema on a valid answer.
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 2);
    await Effect.runPromise(driver.startSession(START));
    const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }] };
    const pending = driver.handlePermissionRequest("AskUserQuestion", input, permissionCallbackOptions());
    const requestId = openedRequestId(await eventsPromise, "user-input.request.opened");
    await Effect.runPromise(driver.respondToUserInput("thread-1", requestId, { Which: "A" }));
    await expect(pending).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { questions: input.questions, answers: { Which: "A" } },
    });
  });

  it("releases a parked question when it is dismissed", async () => {
    // Dismissal used to have no path to the parked promise at all, so the
    // turn stayed blocked inside canUseTool until it was interrupted.
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 2);
    await Effect.runPromise(driver.startSession(START));
    const pending = driver.handlePermissionRequest(
      "AskUserQuestion",
      { questions: [{ question: "Which?", options: [] }] },
      permissionCallbackOptions(),
    );
    const requestId = openedRequestId(await eventsPromise, "user-input.request.opened");
    // Accepting is a miscall — there is no answer to accept — and has to
    // stay distinguishable from dismissal rather than silently denying.
    expect(
      await codeOf(() => Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "accept" }))),
    ).toBe("REQUEST_MISMATCH");
    await Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "decline" }));
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });

  it("never offers Claude Code's plan mode tools, whatever the user switched off", async () => {
    // Moxen has no plan mode (MXN-136): a mode the model entered would leave it unable to change anything.
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, disabledNativeTools: ["WebSearch"] }));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    expect(transport.created[0]!.options.disallowedTools).toEqual(expect.arrayContaining(["EnterPlanMode", "ExitPlanMode", "WebSearch"]));
    // Settings lists the tools a user may switch off; one Moxen always blocks is not among them.
    const switchable = CLAUDE_NATIVE_TOOLS.map((tool) => tool.name);
    expect(switchable).not.toContain("EnterPlanMode");
    expect(switchable).not.toContain("ExitPlanMode");
  });

  it("allows everything in full-access except questions", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const allowed = await driver.handlePermissionRequest(
      "Bash",
      { command: "ls" },
      permissionCallbackOptions(),
    );
    expect(allowed).toMatchObject({ behavior: "allow" });
  });
});

describe("claude driver compaction, limits, rollback", () => {
  it("observes compaction and carries the usage on", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 6);
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    const query = transport.created[0]!;
    query.push(assistantText("a", { input_tokens: 10, output_tokens: 5 }));
    query.push(compactBoundary(100, 20));
    query.push(assistantText("b", { input_tokens: 3, output_tokens: 1 }));
    query.push(successResult("b"));
    const outcome = await outcomePromise;
    // 10 + 3 in, 5 + 1 out: compaction does not lower what the thread has spent.
    expect(outcome.usage).toMatchObject({ input: 13, output: 6 });
    const events = await eventsPromise;
    expect(
      events.find(
        (event) => event.type === "thread.state.changed" && event.state === "compacted",
      ),
    ).toBeDefined();
  });

  it("announces rate-limited pauses once per turn", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 5400;
    const info = { status: "rejected", rateLimitType: "five_hour", resetsAt };
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 6);
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    const query = transport.created[0]!;
    query.push(rateLimitEvent(info));
    query.push(rateLimitEvent(info));
    query.push(successResult("done"));
    await outcomePromise;
    const events = await eventsPromise;
    const byType = (type: ProviderRuntimeEvent["type"]): ProviderRuntimeEvent[] =>
      events.filter((event) => event.type === type);
    expect(byType("rate-limits.updated")).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.type === "thread.state.changed" && event.state === "rate-limited",
      ),
    ).toHaveLength(1);
    expect(byType("rate-limits.updated")[0]).toMatchObject({
      windows: [{ id: "session", exhausted: true }],
    });
  });

  it("announces a graceful wrap-up once per turn, as its own state", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 5400;
    const info = { status: "allowed_warning", rateLimitType: "five_hour", resetsAt, rateLimitGraceActive: true };
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 6);
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    const query = transport.created[0]!;
    query.push(rateLimitEvent(info as never));
    query.push(rateLimitEvent(info as never));
    query.push(successResult("done"));
    await outcomePromise;
    const events = await eventsPromise;
    const states = events.filter((event) => event.type === "thread.state.changed" && event.state !== "session-started");
    expect(states.map((event) => (event as { state: string }).state)).toEqual(["usage-wrap-up"]);
    expect(states[0]).toMatchObject({ raw: { rateLimitType: "five_hour", label: "Session" } });
  });

  it("rolls back via fork and validates input", async () => {
    // The trailing `/rename` is a logged local command (native title regeneration), not a prompt.
    const api = new FakeSessionApi([
      historyUser("u-1", "one"),
      historyToolResult("tr-1"),
      historyUser("u-2", "two"),
      historyUser("u-cmd", "<command-name>/rename</command-name>"),
    ]);
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport, sessionApi: api });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "three" }));

    const snapshot = await Effect.runPromise(driver.rollbackThread("thread-1", 1));
    // Inclusive fork point: the message before the dropped prompt "two".
    expect(api.forks).toEqual([{ sessionId: "session-1", upToMessageId: "tr-1" }]);
    expect(transport.created[1]!.options.resume).toBe("forked-session");
    expect(driver.resumeCursor("thread-1")).toBe("forked-session");
    expect(snapshot.turns).toHaveLength(0);

    expect(await codeOf(() => Effect.runPromise(driver.rollbackThread("thread-1", 0)))).toBe(
      "INVALID_ROLLBACK",
    );
  });

  it("refuses rollback past a compaction boundary", async () => {
    const api = new FakeSessionApi([historyUser("u-1", "one"), historyUser("u-2", "two")]);
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport, sessionApi: api });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "three" }));
    transport.created[0]!.push(compactBoundary());
    await sleep(20);
    expect(await codeOf(() => Effect.runPromise(driver.rollbackThread("thread-1", 1)))).toBe(
      "ROLLBACK_UNAVAILABLE",
    );
    expect(api.forks).toEqual([]);
  });
});

describe("claude driver session liveness", () => {
  it("retires a session whose query has ended, instead of queueing into it", async () => {
    // The whole bug: interrupt ends the query for good, but the session
    // stayed in the map with closed === false. hasSession reported it live,
    // sendTurn pushed into a queue nobody drained, and every later turn on
    // the thread hung silently until it too was interrupted.
    const transport = new FakeTransport([[initMessage()], [initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    await Effect.runPromise(driver.interruptTurn("thread-1"));
    await sleep(20);

    expect(await Effect.runPromise(driver.hasSession("thread-1"))).toBe(false);
    expect(await codeOf(() => Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "again" })))).toBe(
      "CLAUDE_NOT_STARTED",
    );
  });

  it("resumes the CLI session when a retired thread starts a new one", async () => {
    // A rebuilt session must carry the conversation: without resume the
    // next turn would silently start from an empty context.
    const transport = new FakeTransport([[initMessage()], [initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    await Effect.runPromise(driver.interruptTurn("thread-1"));
    await sleep(20);

    await Effect.runPromise(driver.startSession(START));
    expect(transport.created).toHaveLength(2);
    expect(transport.created[0]!.options.resume).toBeUndefined();
    expect(transport.created[1]!.options.resume).toBe("session-1");
  });

  it("resumes a cursor left by a previous process when the CLI still has it", async () => {
    const transport = new FakeTransport([[initMessage({ session_id: "session-old" })]]);
    const sessionApi = new FakeSessionApi();
    sessionApi.existing.add("session-old");
    const driver = new ClaudeDriver({ transport, sessionApi });
    // Known before the first reply, so the runner can persist it at once.
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "session-old" }));
    expect(transport.created[0]!.options.resume).toBe("session-old");
    expect(driver.resumeCursor("thread-1")).toBe("session-old");
  });

  it("starts fresh instead of failing when the CLI lost that session", async () => {
    const transport = new FakeTransport([[initMessage({ session_id: "session-new" })]]);
    const driver = new ClaudeDriver({ transport, sessionApi: new FakeSessionApi() });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "session-gone" }));
    expect(transport.created[0]!.options.resume).toBeUndefined();
    await sleep(20);
    // The fresh session's own id replaces the lost one once `init` lands.
    expect(driver.resumeCursor("thread-1")).toBe("session-new");
  });
});

describe("claude driver session controls", () => {
  it("switches model per turn, and never Claude Code's plan permission mode", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const first = await Effect.runPromise(
      driver.sendTurn({
        threadId: "thread-1",
        prompt: "hi",
        modelSelection: { instanceId: "claude", model: "new-model" },
        interactionMode: "default",
      }),
    );
    const firstOutcome = driver.awaitTurn("thread-1", first.turnId);
    transport.created[0]!.push(successResult("ok"));
    await firstOutcome;
    expect(transport.created[0]!.models).toEqual(["new-model"]);
    expect(transport.created[0]!.permissionModes).toEqual([]);

    const second = await Effect.runPromise(
      driver.sendTurn({ threadId: "thread-1", prompt: "again", interactionMode: "default" }),
    );
    const secondOutcome = driver.awaitTurn("thread-1", second.turnId);
    transport.created[0]!.push(successResult("ok2"));
    await secondOutcome;
    expect(transport.created[0]!.permissionModes).toEqual([]);
  });

  it("stops sessions", async () => {
    const transport = new FakeTransport([[initMessage()], [initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.startSession({ threadId: "thread-2", workingDirectory: "/repo" }));
    expect(await Effect.runPromise(driver.listSessions())).toHaveLength(2);
    await Effect.runPromise(driver.stopSession("thread-1"));
    expect(await Effect.runPromise(driver.hasSession("thread-1"))).toBe(false);
    await Effect.runPromise(driver.stopAll());
    expect(await Effect.runPromise(driver.listSessions())).toHaveLength(0);
  });

  it("probes usage windows best-effort", async () => {
    const transport = new FakeTransport([[initMessage()]], [
      {
        session: { total_cost_usd: 2 },
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: "2026-09-20T17:00:00.000Z" },
        },
      },
    ]);
    const driver = new ClaudeDriver({ transport });
    const eventsPromise = collectEvents(driver, 2);
    await Effect.runPromise(driver.startSession(START));
    const events = await eventsPromise;
    expect(events[0]!.type).toBe("thread.state.changed");
    expect(events[1]).toMatchObject({
      type: "rate-limits.updated",
      windows: [{ id: "session", exhausted: false }],
    });
  });
});

describe("claude context usage", () => {
  const response = {
    totalTokens: 431_553,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 43,
    autoCompactThreshold: 920_000,
    isAutoCompactEnabled: true,
    apiUsage: { input_tokens: 9, output_tokens: 120, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 430_344 },
    categories: [],
  };

  it("maps the CLI's /context summary, cache reads included", () => {
    expect(claudeContextUsageOf(response)).toEqual({
      usedTokens: 431_553,
      maxTokens: 1_000_000,
      cachedInputTokens: 430_344,
      autoCompactThreshold: 920_000,
      compactsAutomatically: true,
    });
    expect(claudeContextUsageOf({ maxTokens: 10 })).toBeNull();
    expect(claudeContextUsageOf({ totalTokens: 5, apiUsage: null })).toMatchObject({
      usedTokens: 5,
      maxTokens: null,
      cachedInputTokens: null,
    });
  });

  it("asks the live session for the cheap summary, and nothing once it is gone", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    expect(await driver.contextUsage("thread-1")).toBeNull();
    await Effect.runPromise(driver.startSession(START));
    transport.created[0]!.contextUsageResponse = response;
    expect((await driver.contextUsage("thread-1"))?.usedTokens).toBe(431_553);
    expect(transport.created[0]!.contextUsageRequests).toEqual([{ detail: "summary" }]);
  });

  it("carries the session's running cost alongside the token reading", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    transport.created[0]!.push(successResult("hello", 0.02));
    await outcomePromise;
    transport.created[0]!.contextUsageResponse = response;
    expect(await driver.contextUsage("thread-1")).toMatchObject({ usedTokens: 431_553, costUsd: 0.02 });
  });

  it("takes the running cost from the usage probe, mid-turn, before any result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const transport = new FakeTransport([[initMessage()]], [{ session: { total_cost_usd: 1.5 } }]);
      const driver = new ClaudeDriver({ transport });
      await Effect.runPromise(driver.startSession(START));
      await sleep(10);
      const query = transport.created[0]!;
      query.contextUsageResponse = response;
      // The start-up probe carries a resumed session's spend.
      expect(await driver.contextUsage("thread-1")).toMatchObject({ costUsd: 1.5 });
      // A reading once the probe has gone stale probes again.
      query.usageProbeResponse = { session: { total_cost_usd: 2.25 } };
      vi.setSystemTime(Date.now() + 30_000);
      expect(await driver.contextUsage("thread-1")).toMatchObject({ costUsd: 2.25 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("claude steering", () => {
  it("streams the steer into the running turn and settles on the last result", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "refactor it" }));
    const outcome = driver.awaitTurn("thread-1", sent.turnId);
    await Effect.runPromise(driver.steerTurn("thread-1", "and keep the old API"));
    await sleep(20);
    const query = transport.created[0]!;
    expect(query.prompts).toEqual(["refactor it", "and keep the old API"]);

    // Too late to fold in: the CLI runs it next and says so on the result.
    query.push(successResult("first pass", 0.01, { queued_turn_count: 1 }));
    await sleep(20);
    let settled = false;
    void outcome.then(() => (settled = true));
    await sleep(20);
    expect(settled).toBe(false);

    query.push(successResult("kept the old API", 0.02, { queued_turn_count: 0 }));
    expect(await outcome).toMatchObject({ status: "completed", text: "kept the old API" });
  });

  it("refuses when no turn is running", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    expect(await codeOf(() => Effect.runPromise(driver.steerTurn("thread-1", "late")))).toBe("TURN_NOT_RUNNING");
  });
});

describe("claude images", () => {
  it("sends images as base64 content blocks after the text", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(
      driver.sendTurn({ threadId: "thread-1", prompt: "what is this?", images: [{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" }] }),
    );
    await sleep(20);
    expect(transport.created[0]!.messages[0]!.message.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });

  it("carries images on a steer into the running turn", async () => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    await Effect.runPromise(driver.steerTurn("thread-1", "look at this", [{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" }]));
    await sleep(20);
    expect(transport.created[0]!.messages[1]!.message.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });
});
const MCP = [
  { name: "docs", type: "http" as const, url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } },
  { name: "fs", type: "stdio" as const, command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/" } },
];

describe("claude MCP injection", () => {
  it("hands moxen's servers to the SDK as its mcpServers record", async () => {
    const transport = new FakeTransport([[initMessage({ session_id: "session-1" })]]);
    const driver = new ClaudeDriver({ transport, sessionApi: new FakeSessionApi() });
    await Effect.runPromise(driver.startSession({ ...START, mcpServers: MCP }));
    expect(transport.created[0]!.options.mcpServers).toEqual({
      docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } },
      fs: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/" } },
    });
  });

  it("sets nothing when there are none, leaving the user's own servers alone", async () => {
    const transport = new FakeTransport([[initMessage({ session_id: "session-1" })]]);
    const driver = new ClaudeDriver({ transport, sessionApi: new FakeSessionApi() });
    await Effect.runPromise(driver.startSession(START));
    expect(transport.created[0]!.options.mcpServers).toBeUndefined();
  });
});

describe("claude MCP changes on a live session", () => {
  async function live(servers = MCP) {
    const transport = new FakeTransport([[initMessage({ session_id: "session-1" })]]);
    const driver = new ClaudeDriver({ transport, sessionApi: new FakeSessionApi() });
    await Effect.runPromise(driver.startSession({ ...START, mcpServers: servers }));
    return { driver, query: transport.created[0]! };
  }

  it("hands the SDK the whole new set when one was added, removed or changed", async () => {
    const { driver, query } = await live();
    const added = { name: "git", type: "stdio" as const, command: "git-mcp", args: [], env: {} };
    await driver.updateMcpServers("thread-1", [...MCP, added]);
    expect(Object.keys(query.mcpServerSets[0]!)).toEqual(["docs", "fs", "git"]);
    // A server taken out of the config goes too: the SDK replaces the set it was given.
    await driver.updateMcpServers("thread-1", [MCP[0]!, added]);
    expect(Object.keys(query.mcpServerSets[1]!)).toEqual(["docs", "git"]);
    await driver.updateMcpServers("thread-1", []);
    expect(query.mcpServerSets[2]).toEqual({});
  });

  it("does nothing when the set is the same, in any order", async () => {
    const { driver, query } = await live();
    await driver.updateMcpServers("thread-1", [...MCP].reverse());
    expect(query.mcpServerSets).toEqual([]);
  });

  it("does nothing for a thread with no live session", async () => {
    const { driver, query } = await live();
    await driver.updateMcpServers("elsewhere", []);
    expect(query.mcpServerSets).toEqual([]);
  });
});

describe("claude driver native session titles", () => {
  it("reads and renames the session title, and regenerates it through a bare /rename", async () => {
    const api = new FakeSessionApi();
    const transport = new FakeTransport([[successResult("")]]);
    const driver = new ClaudeDriver({ transport, sessionApi: api });

    expect(await driver.sessionTitle("session-1", "/work")).toBeNull();
    await driver.renameSession("session-1", "/work", "Mine");
    expect(api.renames).toEqual([{ sessionId: "session-1", title: "Mine", dir: "/work" }]);
    expect(await driver.sessionTitle("session-1", "/work")).toBe("Mine");

    // The CLI answers `/rename` itself and writes the new title to the session file.
    api.titles.set("session-1", "Auto title");
    expect(await driver.regenerateSessionTitle("session-1", "/work")).toBe("Auto title");
    const query = transport.created[0]!;
    expect(transport.stringPrompts).toEqual(["/rename"]);
    expect(query.options).toMatchObject({ cwd: "/work", resume: "session-1", tools: [], maxTurns: 1 });
    expect(query.options.forkSession).toBeUndefined();
    expect(query.closed).toBe(true);

    const failing = new ClaudeDriver({ transport: new FakeTransport([[errorResult("error_max_turns")]]), sessionApi: api });
    await expect(failing.regenerateSessionTitle("session-1", "/work")).rejects.toThrow("could not retitle");
  });
});

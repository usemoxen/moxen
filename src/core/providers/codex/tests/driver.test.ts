import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { CodexDriver, codexContextUsageOf } from "../driver.js";
import { codexDisabledToolConfig } from "../../../nativetools.js";
import { FakeCodexTransport } from "./fakes.js";

async function collectEvents(driver: CodexDriver, count: number): Promise<ProviderRuntimeEvent[]> {
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

describe("codex session resume", () => {
  it("does not silently replace a conversation when resume fails for authentication", async () => {
    const transport = new FakeCodexTransport({ failRequests: { "thread/resume": "authentication required" } });
    const driver = new CodexDriver({ transport });
    await expect(Effect.runPromise(driver.startSession({ ...START, resumeCursor: "old" }))).rejects.toThrow(/authentication/);
    expect(transport.sessions[0]!.server.requestsTo("thread/start")).toEqual([]);
  });
  it("reattaches to the thread a previous process started, without replaying turns", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "codex-thread-old" }));
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("thread/resume")[0]!.params).toMatchObject({
      threadId: "codex-thread-old",
      excludeTurns: true,
      cwd: "/repo",
    });
    expect(server.requestsTo("thread/start")).toEqual([]);
    expect(driver.resumeCursor("thread-1")).toBe("codex-thread-old");
  });

  it("starts a new thread when the app-server lost the old one", async () => {
    const transport = new FakeCodexTransport({ lostThreads: ["codex-thread-old"] });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "codex-thread-old" }));
    expect(transport.sessions[0]!.server.requestsTo("thread/start")).toHaveLength(1);
    expect(driver.resumeCursor("thread-1")).toBe("codex-thread-1");
  });
});

describe("codex driver turns", () => {
  it("passes an explicitly selected skill as a native skill input without treating a file path as a skill", async () => {
    const transport = new FakeCodexTransport({ skills: [{ skills: [{ name: "imagegen", path: "/skills/imagegen/SKILL.md", enabled: true }, { name: "off", path: "/skills/off/SKILL.md", enabled: false }] }] });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: START.threadId, prompt: "/imagegen Make a picture" }));
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("turn/start")[0]!.params).toMatchObject({ input: [{ type: "text", text: "/imagegen Make a picture" }, { type: "skill", name: "imagegen", path: "/skills/imagegen/SKILL.md" }] });
    await Effect.runPromise(driver.interruptTurn(START.threadId));
    await Effect.runPromise(driver.sendTurn({ threadId: START.threadId, prompt: "/etc/config is a path" }));
    expect(server.requestsTo("skills/list")).toHaveLength(1);
    expect(server.requestsTo("turn/start")[1]!.params).toMatchObject({ input: [{ type: "text", text: "/etc/config is a path" }] });
    await Effect.runPromise(driver.interruptTurn(START.threadId));
    await Effect.runPromise(driver.sendTurn({ threadId: START.threadId, prompt: "/off Do this" }));
    expect(server.requestsTo("turn/start")[2]!.params).toMatchObject({ input: [{ type: "text", text: "/off Do this" }] });
    await Effect.runPromise(driver.stopAll());
  });

  it("starts a session with the static policy and runs a turn", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    expect(driver.accountTypeOf("thread-1")).toBe("chatgpt");

    const threadStart = transport.sessions[0]!.server.requestsTo("thread/start")[0]!;
    expect(threadStart.params).toMatchObject({
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const server = transport.sessions[0]!.server;
    const turnStart = server.requestsTo("turn/start")[0]!;
    expect(turnStart.params).toMatchObject({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "hi" }],
      summary: "detailed",
    });

    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "srv-1" } });
    server.notify("item/agentMessage/delta", { text: "hello" });
    server.notify("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningTokens: 1 },
        last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningTokens: 1 },
      },
    });
    server.notify("turn/completed", {
      threadId: "codex-thread-1",
      turn: { id: "srv-1", status: "completed" },
    });
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("hello");
    expect(outcome.usage).toMatchObject({ input: 10, cacheRead: 2, output: 5, thinking: 1 });
    // No `modelContextWindow` or `totalTokens` in this notification: the
    // window stays unknown and used falls back to input + output.
    expect(await driver.contextUsage("thread-1")).toEqual({
      usedTokens: 15,
      maxTokens: null,
      cachedInputTokens: 2,
      autoCompactThreshold: null,
      compactsAutomatically: null,
    });

    const snapshot = await Effect.runPromise(driver.readThread("thread-1"));
    expect(snapshot.turns[0]!.items.map((item) => (item as { kind: string }).kind)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("lists skills for a directory with skills/list, on a session it then closes", async () => {
    const transport = new FakeCodexTransport({
      skills: [
        {
          cwd: "/repo",
          errors: [],
          skills: [
            { name: "deploy", description: "Ship it", interface: { displayName: "Deploy", shortDescription: "Ship" }, enabled: true },
            { name: "old", description: "Retired", enabled: false },
          ],
        },
      ],
    });
    const driver = new CodexDriver({ transport });
    const inventory = await driver.skillInventory("/repo");
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("skills/list")[0]!.params).toEqual({ cwds: ["/repo"] });
    expect(inventory.trigger).toBe("$");
    expect(inventory.skills).toMatchObject([
      { name: "deploy", displayName: "Deploy", shortDescription: "Ship", enabled: true },
      { name: "old", enabled: false },
    ]);
    // Only the per-call catalog session was started, and it is gone again.
    expect(await Effect.runPromise(driver.hasSession("thread-1"))).toBe(false);
  });

  it("passes runtime instructions as developerInstructions", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, instructions: "Report back." }));
    expect(transport.sessions[0]!.server.requestsTo("thread/start")[0]!.params).toMatchObject({
      developerInstructions: expect.stringContaining("Report back."),
    });
  });

  it("sends no model for codex-default, so the app-server's own default applies", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(
      driver.startSession({ ...START, modelSelection: { instanceId: "codex", model: "codex-default" } }),
    );
    await Effect.runPromise(
      driver.sendTurn({ threadId: "thread-1", prompt: "hi", modelSelection: { instanceId: "codex", model: "codex-default" } }),
    );
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("thread/start")[0]!.params).not.toHaveProperty("model");
    expect(server.requestsTo("turn/start")[0]!.params).not.toHaveProperty("model");
  });

  it("keeps commentary out of the answer, streaming it and recording it as a note", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const server = transport.sessions[0]!.server;
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "srv-1" } });
    const agentMessage = (id: string, phase: string, text = "") => ({
      threadId: "codex-thread-1",
      turnId: "srv-1",
      item: { type: "agentMessage", id, text, phase },
    });
    server.notify("item/started", agentMessage("m-1", "commentary"));
    server.notify("item/agentMessage/delta", { itemId: "m-1", delta: "Checking the repo first." });
    server.notify("item/completed", agentMessage("m-1", "commentary", "Checking the repo first."));
    server.notify("item/started", agentMessage("m-2", "final_answer"));
    server.notify("item/agentMessage/delta", { itemId: "m-2", delta: "All " });
    server.notify("item/agentMessage/delta", { itemId: "m-2", delta: "done." });
    server.notify("turn/completed", {
      threadId: "codex-thread-1",
      turn: { id: "srv-1", status: "completed" },
    });
    const outcome = await outcomePromise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(outcome.text).toBe("All done.");
    // Commentary streams live under its own message id, and is published once,
    // whole, as a note — but never becomes part of the answer.
    const streamed = events.flatMap((event) => (event.type === "message.part.updated" ? [[event.messageId, event.text]] : []));
    expect(streamed).toEqual([
      ["m-1", "Checking the repo first."],
      ["m-2", "All "],
      ["m-2", "done."],
    ]);
    const notes = events.flatMap((event) => (event.type === "assistant.note" ? [[event.messageId, event.text]] : []));
    expect(notes).toEqual([["m-1", "Checking the repo first."]]);
  });

  it("opens native async questions without folding them into the final answer or blocking the turn", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: START.threadId, prompt: "work" }));
    const server = transport.sessions[0]!.server;
    const question = { threadId: "codex-thread-1", item: { type: "agentMessage", id: "question", phase: "final_answer", delivery: "async", text: "Which images?\n- All\n- Recent", questions: [{ title: "Which images?", options: ["All", "Recent"] }, { title: "Which images?", options: null }] } };
    server.notify("item/started", question);
    server.notify("item/completed", question);
    server.notify("item/completed", { item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Finished the research." } });
    server.notify("turn/completed", { turn: { status: "completed" } });
    expect((await driver.awaitTurn(START.threadId, sent.turnId)).text).toBe("Finished the research.");
    const opened = events.find((event) => event.type === "user-input.request.opened");
    expect(opened).toMatchObject({ requestId: "codex-async:codex-thread-1:question", raw: { delivery: "async", nativeThreadId: "codex-thread-1", questions: [
      { id: JSON.stringify(["request_user_input_async", "question", 0]), question: "Which images?", options: [{ label: "All" }, { label: "Recent" }] },
      { id: JSON.stringify(["request_user_input_async", "question", 1]), question: "Which images?", options: [] },
    ] } });
    expect(events.filter((event) => event.type === "assistant.note")).toEqual([]);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopAll());
  });

  it("requires auth and rejects concurrent turns", async () => {
    const locked = new FakeCodexTransport({ failRequests: { "account/read": "Not logged in" } });
    const lockedDriver = new CodexDriver({ transport: locked });
    expect(await codeOf(() => Effect.runPromise(lockedDriver.startSession(START)))).toBe(
      "CODEX_AUTH_REQUIRED",
    );

    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    expect(await codeOf(() => Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" })))).toBe(
      "TURN_BUSY",
    );
  });

  it("interrupts a running turn", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    await Effect.runPromise(driver.interruptTurn("thread-1"));
    await expect(outcomePromise).resolves.toMatchObject({ status: "interrupted" });
    expect(transport.sessions[0]!.server.requestsTo("turn/interrupt")).toHaveLength(1);
  });

  it("enforces medium effort unless overridden", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    expect(transport.sessions[0]!.server.requestsTo("turn/start")[0]!.params).toMatchObject({
      effort: "medium",
    });

    const transport2 = new FakeCodexTransport();
    const driver2 = new CodexDriver({ transport: transport2, settings: { reasoningSummary: "none" } });
    await Effect.runPromise(driver2.startSession(START));
    await Effect.runPromise(
      driver2.sendTurn({
        threadId: "thread-1",
        prompt: "hi",
        modelSelection: { instanceId: "codex", model: "gpt-5.4", options: [{ id: "reasoningEffort", value: "high" }] },
      }),
    );
    expect(transport2.sessions[0]!.server.requestsTo("turn/start")[0]!.params).toMatchObject({
      effort: "high",
      summary: "none",
    });
  });
});

describe("codex driver approvals", () => {
  async function approvalSession() {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, runtimeMode: "approval-required" }));
    const threadStart = transport.sessions[0]!.server.requestsTo("thread/start")[0]!;
    expect(threadStart.params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const server = transport.sessions[0]!.server;
    return { transport, driver, server };
  }

  it("parks command approvals until answered", async () => {
    const { driver, server } = await approvalSession();
    const eventsPromise = collectEvents(driver, 2);
    const answerPromise = server.ask("item/commandExecution/requestApproval", {
      threadId: "codex-thread-1",
      approvalId: "a-1",
      command: ["rm", "-rf", "/"],
    });
    const events = await eventsPromise;
    const requestId = openedRequestId(events, "permission.request.opened");
    await Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "accept" }));
    await expect(answerPromise).resolves.toEqual({ decision: "accept" });
  });

  it("lets Codex scope a session approval instead of approving unrelated calls", async () => {
    const { driver, server } = await approvalSession();
    const eventsPromise = collectEvents(driver, 2);
    const first = server.ask("item/fileChange/requestApproval", { threadId: "codex-thread-1" });
    const requestId = openedRequestId(await eventsPromise, "permission.request.opened");
    await Effect.runPromise(driver.respondToRequest("thread-1", requestId, { kind: "acceptForSession" }));
    await expect(first).resolves.toEqual({ decision: "acceptForSession" });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
    const second = server.ask("item/commandExecution/requestApproval", { threadId: "codex-thread-1" });
    await expect.poll(() => events.some((event) => event.type === "permission.request.opened")).toBe(true);
    await Effect.runPromise(driver.respondToRequest("thread-1", openedRequestId(events, "permission.request.opened"), { kind: "decline" }));
    await expect(second).resolves.toEqual({ decision: "decline" });
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("declines, cancels, and rejects unknown or mismatched requests", async () => {
    const { driver, server } = await approvalSession();
    const eventsPromise = collectEvents(driver, 3);
    const declined = server.ask("item/permissions/requestApproval", { threadId: "codex-thread-1" });
    const inputAsked = server.ask("item/tool/requestUserInput", {
      threadId: "codex-thread-1",
      questions: [],
    });
    const events = await eventsPromise;
    const declineId = openedRequestId(events, "permission.request.opened");
    await Effect.runPromise(driver.respondToRequest("thread-1", declineId, { kind: "decline" }));
    await expect(declined).resolves.toEqual({ permissions: {}, scope: "turn" });

    const inputId = openedRequestId(events, "user-input.request.opened");
    expect(
      await codeOf(() => Effect.runPromise(driver.respondToRequest("thread-1", inputId, { kind: "accept" }))),
    ).toBe("REQUEST_MISMATCH");
    expect(
      await codeOf(() => Effect.runPromise(driver.respondToRequest("thread-1", "nope", { kind: "accept" }))),
    ).toBe("REQUEST_UNKNOWN");
    await Effect.runPromise(driver.respondToUserInput("thread-1", inputId, { color: "blue" }));
    await expect(inputAsked).resolves.toEqual({ answers: { color: { answers: ["blue"] } } });
  });

  it("releases a parked question when it is dismissed", async () => {
    // Dismissal used to throw REQUEST_MISMATCH, so closing the panel left
    // the server call blocked until the next interrupt. A declined question
    // answers nothing rather than refusing a permission: `{ decision }` is
    // not a shape `requestUserInput` understands.
    const { driver, server } = await approvalSession();
    // Two opens plus the earlier rate-limits probe event.
    const eventsPromise = collectEvents(driver, 3);
    const asked = server.ask("item/tool/requestUserInput", {
      threadId: "codex-thread-1",
      questions: [],
    });
    const elicited = server.ask("mcpServer/elicitation/request", { threadId: "codex-thread-1" });
    const events = await eventsPromise;
    const ids = events
      .filter((event) => event.type === "user-input.request.opened")
      .map((event) => (event as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    await Effect.runPromise(driver.respondToRequest("thread-1", ids[0]!, { kind: "decline" }));
    await Effect.runPromise(driver.respondToRequest("thread-1", ids[1]!, { kind: "decline" }));
    await expect(asked).resolves.toEqual({ answers: {} });
    await expect(elicited).resolves.toEqual({ action: "decline" });
  });

  it("answers elicitation and refuses unimplemented dynamic tools", async () => {
    const { driver, server } = await approvalSession();
    const eventsPromise = collectEvents(driver, 2);
    const elicited = server.ask("mcpServer/elicitation/request", { threadId: "codex-thread-1" });
    await expect(server.ask("item/tool/call", { threadId: "codex-thread-1", callId: "call-1", tool: "subagent" })).resolves.toMatchObject({ success: false });
    const events = await eventsPromise;
    await Effect.runPromise(driver.respondToUserInput("thread-1", openedRequestId(events, "user-input.request.opened"), { token: "t" }));
    await expect(elicited).resolves.toEqual({ action: "accept", content: { token: "t" } });
  });

});

describe("codex driver compaction, rollback, models", () => {
  it("starts native compaction and observes the boundary", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    expect(driver.compaction).toMatchObject({ type: "native" });
    const eventsPromise = collectEvents(driver, 2);
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const server = transport.sessions[0]!.server;
    await Effect.runPromise(driver.compaction.start("thread-1"));
    expect(server.requestsTo("thread/compact/start")).toHaveLength(1);
    server.notify("thread/compacted", { threadId: "codex-thread-1" });
    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toContain("thread.state.changed");
  });

  it("reverts at a retained turn and refuses missing history", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    for (const [prompt, serverId] of [["one", "srv-1"], ["two", "srv-2"]] as const) {
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt }));
      const done = driver.awaitTurn("thread-1", sent.turnId);
      server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: serverId } });
      server.notify("turn/completed", {
        threadId: "codex-thread-1",
        turn: { id: serverId, status: "completed" },
      });
      await done;
    }
    const snapshot = await Effect.runPromise(driver.rollbackThread("thread-1", 1));
    expect(server.requestsTo("thread/revert")[0]!.params).toMatchObject({
      threadId: "codex-thread-1",
      beforeTurnId: "srv-2",
    });
    expect(snapshot.turns).toHaveLength(1);

    expect(await codeOf(() => Effect.runPromise(driver.rollbackThread("thread-1", 0)))).toBe(
      "INVALID_ROLLBACK",
    );
    expect(await codeOf(() => Effect.runPromise(driver.rollbackThread("thread-1", 5)))).toBe("ROLLBACK_UNAVAILABLE");
    expect(server.requestsTo("thread/rollback")).toEqual([]);
  });

  it("rolls back a resumed thread whose earlier turns ran in another process", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "codex-thread-old" }));
    await Effect.runPromise(driver.rollbackThread("thread-1", 2));
    expect(transport.sessions[0]!.server.requestsTo("thread/revert")[0]!.params).toEqual({
      threadId: "codex-thread-old",
      beforeTurnId: "srv-1",
    });
  });

  it("lists models without an allowlist", async () => {
    const transport = new FakeCodexTransport({ models: [{ id: "gpt-a" }, { model: "gpt-b" }] });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await expect(driver.listModels("thread-1")).resolves.toEqual([{ id: "gpt-a" }, { id: "gpt-b" }]);
  });

  it("reads the paginated data envelope with display names and efforts", async () => {
    const transport = new FakeCodexTransport({ models: [{ id: "gpt-5.6-terra" }], modelsEnvelope: "data" });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await expect(driver.listModels("thread-1")).resolves.toEqual([
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6-Terra",
        reasoningEfforts: ["low", "medium"],
      },
    ]);
  });

  it("rewrites limit errors with reset times", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 5400;
    const transport = new FakeCodexTransport({
      rateLimits: { primary: { usedPercent: 100, resetsAt, windowDurationMins: 300 } },
    });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const done = driver.awaitTurn("thread-1", sent.turnId);
    transport.sessions[0]!.server.notify("turn/completed", {
      threadId: "codex-thread-1",
      turn: { id: "srv-9", status: "failed", error: "usage limit exceeded" },
    });
    const outcome = await done;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("resets in");
  });

  it("consumes reset credits and stops sessions", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await driver.consumeResetCredit("thread-1");
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("account/rateLimitResetCredit/consume")).toHaveLength(1);
    // Initial probe + post-consume re-probe.
    expect(server.requestsTo("account/rateLimits/read")).toHaveLength(2);
    await Effect.runPromise(driver.stopSession("thread-1"));
    expect(await Effect.runPromise(driver.hasSession("thread-1"))).toBe(false);
    expect(transport.sessions[0]!.client.closed).toBe(true);
  });
});

describe("codex context usage", () => {
  it("reads the last request against the model's window", () => {
    expect(
      codexContextUsageOf({
        total: { inputTokens: 900_000, cachedInputTokens: 800_000, outputTokens: 20_000, totalTokens: 920_000 },
        last: { inputTokens: 61_000, cachedInputTokens: 58_000, outputTokens: 1_200, totalTokens: 62_200 },
        modelContextWindow: 272_000,
      }),
    ).toEqual({
      usedTokens: 62_200,
      maxTokens: 272_000,
      cachedInputTokens: 58_000,
      autoCompactThreshold: null,
      compactsAutomatically: null,
    });
    expect(codexContextUsageOf({ total: { totalTokens: 5 } })).toBeNull();
  });
});

describe("codex steering", () => {
  it("sends turn/steer pinned to the running server turn", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hi" }));
    const server = transport.sessions[0]!.server;
    // Before the app-server names the turn there is nothing to pin to.
    expect(await codeOf(() => Effect.runPromise(driver.steerTurn("thread-1", "too soon")))).toBe("TURN_NOT_RUNNING");

    server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "srv-1" } });
    await expect.poll(async () => codeOf(() => Effect.runPromise(driver.steerTurn("thread-1", "also add tests"))).catch(() => "accepted")).toBe("accepted");
    expect(server.requestsTo("turn/steer")[0]!.params).toEqual({
      threadId: "codex-thread-1",
      expectedTurnId: "srv-1",
      input: [{ type: "text", text: "also add tests" }],
    });
  });
});

describe("codex images", () => {
  it("sends images as image inputs carrying a data URL", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    await Effect.runPromise(
      driver.sendTurn({ threadId: "thread-1", prompt: "look", images: [{ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" }] }),
    );
    expect(transport.sessions[0]!.server.requestsTo("turn/start")[0]!.params).toMatchObject({
      input: [{ type: "text", text: "look" }, { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
    });
  });
});
const MCP = [
  { name: "docs", type: "http" as const, url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } },
  { name: "fs", type: "stdio" as const, command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/" } },
];

describe("codex MCP injection", () => {
  it("adds each server as its own mcp_servers.<name> override, on start and on resume", async () => {
    const expected = {
      "mcp_servers.docs": { url: "https://docs.example/mcp", http_headers: { Authorization: "Bearer t" } },
      "mcp_servers.fs": { command: "npx", args: ["-y", "fs-mcp"], env: { ROOT: "/" } },
    };
    const fresh = new FakeCodexTransport();
    await Effect.runPromise(new CodexDriver({ transport: fresh }).startSession({ ...START, mcpServers: MCP }));
    expect(fresh.sessions[0]!.server.requestsTo("thread/start")[0]!.params).toMatchObject({ config: expected });

    const resumed = new FakeCodexTransport();
    await Effect.runPromise(
      new CodexDriver({ transport: resumed }).startSession({ ...START, resumeCursor: "codex-thread-old", mcpServers: MCP }),
    );
    expect(resumed.sessions[0]!.server.requestsTo("thread/resume")[0]!.params).toMatchObject({ config: expected });
  });

  it("disables native shell and questions even without user tool overrides", async () => {
    const transport = new FakeCodexTransport();
    await Effect.runPromise(new CodexDriver({ transport }).startSession(START));
    const config = (transport.sessions[0]!.server.requestsTo("thread/start")[0]!.params as { config: Record<string, unknown> }).config;
    expect(config["features.shell_tool"]).toBe(false);
    expect(config["tools.experimental_request_user_input.enabled"]).toBe(false);
  });
});


describe("Codex lifecycle boundaries", () => {
  it("falls back from advertised but unimplemented history and revert methods, without hiding other failures", async () => {
    const transport = new FakeCodexTransport({ failRequests: { "thread/items/list": "thread/items/list is not supported yet", "thread/turns/list": "thread/turns/list is not supported yet", "thread/revert": "thread/revert is not supported yet" }, historyTurns: [
      { id: "first", status: "completed", items: [{ id: "prompt", type: "userMessage", content: [{ type: "text", text: "retained prompt" }] }] },
      { id: "second", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "retained answer" }] },
    ] });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    expect((await driver.subagentHistory(START.threadId, "child"))?.map((entry) => entry.kind)).toEqual(["prompt", "text"]);
    await Effect.runPromise(driver.rollbackThread(START.threadId, 1));
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("thread/revert")[0]!.params).toMatchObject({ beforeTurnId: "second" });
    expect(server.requestsTo("thread/rollback")[0]!.params).toEqual({ threadId: "codex-thread-1", numTurns: 1 });
    await Effect.runPromise(driver.stopAll());

    const deniedTransport = new FakeCodexTransport({ failRequests: { "thread/items/list": "permission denied" } });
    const denied = new CodexDriver({ transport: deniedTransport });
    await Effect.runPromise(denied.startSession(START));
    await expect(denied.subagentHistory(START.threadId, "child")).rejects.toThrow(/permission denied/);
    expect(deniedTransport.sessions[0]!.server.requestsTo("thread/read")).toEqual([]);
    await Effect.runPromise(denied.stopAll());
  });

  it("streams native reasoning and completed predictions without exposing failed predictions", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const collected = collectEvents(driver, 7);
    server.notify("item/started", { threadId: "codex-thread-1", item: { id: "reason", type: "reasoning", summary: [] } });
    server.notify("item/reasoning/summaryTextDelta", { threadId: "codex-thread-1", itemId: "reason", delta: "A summary" });
    server.notify("item/reasoning/summaryPartAdded", { threadId: "codex-thread-1", itemId: "reason", summaryIndex: 1 });
    server.notify("item/reasoning/summaryTextDelta", { threadId: "codex-thread-1", itemId: "reason", summaryIndex: 1, delta: "Another section" });
    server.notify("item/completed", { threadId: "codex-thread-1", item: { id: "reason", type: "reasoning", summary: [] } });
    server.notify("thread/prediction/updated", { threadId: "codex-thread-1", result: { type: "failed", text: "ignored" } });
    server.notify("thread/prediction/updated", { threadId: "codex-thread-1", result: { type: "completed", text: "Next step" } });
    const events = await collected;
    expect(events.filter((event) => event.type === "reasoning.updated")).toMatchObject([{ status: "running" }, { status: "completed", text: "A summary\n\nAnother section", durationMs: expect.any(Number) }]);
    expect(events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("")).toBe("A summary\n\nAnother section");
    expect(events.filter((event) => event.type === "prompt.suggested")).toMatchObject([{ suggestion: "Next step" }]);
    await Effect.runPromise(driver.stopAll());
  });

  it("uses verified tool switches and refuses to pretend patch removal succeeded", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, disabledNativeTools: ["shell", "view_image", "image_generation", "apps"] }));
    expect(transport.sessions[0]!.server.requestsTo("thread/start")[0]!.params).toMatchObject({ config: { "features.shell_tool": false, "features.view_image": false, "features.image_generation": false, "features.apps": false } });
    expect(() => codexDisabledToolConfig(["apply_patch"])).toThrow(/no independent removal control/);
    await Effect.runPromise(driver.stopAll());
  });

  it("interrupts only a selected native child's turn and retains command output without claiming independent stop", async () => {
    const transport = new FakeCodexTransport({ turns: [{ id: "child-turn", status: "inProgress" }] });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: START.threadId, prompt: "work" }));
    const server = transport.sessions[0]!.server;
    server.notify("item/started", { threadId: "codex-thread-1", item: { id: "cmd", type: "commandExecution", status: "inProgress", command: "a command" } });
    server.notify("item/commandExecution/outputDelta", { threadId: "codex-thread-1", itemId: "cmd", delta: "output" });
    server.notify("item/started", { threadId: "codex-thread-1", item: { id: "activity", type: "subAgentActivity", agentThreadId: "child", kind: "started" } });
    await expect.poll(() => driver.backgroundTasks(START.threadId).length).toBe(2);
    expect(driver.backgroundTasks(START.threadId).find((task) => task.taskId === "command:cmd")?.stoppable).toBe(false);
    expect(await driver.backgroundTaskOutput(START.threadId, "command:cmd")).toEqual({ lines: ["output"] });
    await expect(Effect.runPromise(driver.stopBackgroundTask(START.threadId, "command:cmd"))).rejects.toThrow(/independently/);
    await Effect.runPromise(driver.stopBackgroundTask(START.threadId, "agent:child"));
    expect(server.requestsTo("turn/interrupt").map((request) => request.params)).toEqual([{ threadId: "child", turnId: "child-turn" }]);
    server.notify("turn/completed", { threadId: "child", turn: { status: "completed" } });
    server.notify("item/agentMessage/delta", { threadId: "codex-thread-1", delta: "parent answer" });
    server.notify("turn/completed", { threadId: "codex-thread-1", turn: { status: "completed" } });
    expect((await driver.awaitTurn(START.threadId, sent.turnId)).text).toBe("parent answer");
    await Effect.runPromise(driver.stopAll());
    expect(driver.backgroundTasks(START.threadId)).toEqual([]);
  });

  it("estimates only history after the last native compaction", async () => {
    const transport = new FakeCodexTransport({ items: [
      { item: { id: "old", type: "userMessage", content: [{ type: "text", text: "x".repeat(400) }] } },
      { item: { id: "compact", type: "contextCompaction" } },
      { item: { id: "new", type: "userMessage", content: [{ type: "text", text: "12345678" }] } },
    ] });
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    server.notify("thread/tokenUsage/updated", { threadId: "codex-thread-1", tokenUsage: { last: { totalTokens: 100, inputTokens: 100 }, modelContextWindow: 1000 } });
    await expect.poll(() => driver.contextUsage(START.threadId)).not.toBeNull();
    const breakdown = await driver.contextBreakdown(START.threadId);
    expect(breakdown?.estimated).toBe(true);
    expect(breakdown?.categories.find((category) => category.name === "User messages")?.tokens).toBe(2);
    expect(breakdown?.categories.find((category) => category.name === "System prompt & tools")?.tokens).toBe(98);
    await Effect.runPromise(driver.stopAll());
  });

  it("does not overwrite a manual rename with a title already being generated", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    const generated = driver.sessionTitle("parent", START.workingDirectory);
    await expect.poll(() => transport.sessions.find((session) => session.server.requestsTo("turn/start").length > 0)).toBeDefined();
    const side = transport.sessions.find((session) => session.server.requestsTo("turn/start").length > 0)!.server;
    await driver.renameSession("parent", START.workingDirectory, "User title");
    side.notify("item/agentMessage/delta", { threadId: "fork-1", itemId: "title", delta: "Generated title" });
    side.notify("turn/completed", { threadId: "fork-1", turn: { status: "completed" } });
    expect(await generated).toBeNull();
    expect(transport.sessions.flatMap((session) => session.server.requestsTo("thread/name/set").map((request) => request.params))).toEqual([{ threadId: "parent", name: "User title" }]);
  });

  it("keeps usage if completion arrives before awaitTurn and ignores another thread", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: START.threadId, prompt: "hi", runtimeMode: "approval-required" }));
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("turn/start")[0]!.params).toMatchObject({ sandboxPolicy: { type: "readOnly" }, approvalPolicy: "untrusted" });
    server.notify("item/agentMessage/delta", { threadId: "other-thread", delta: "wrong" });
    server.notify("thread/tokenUsage/updated", { threadId: "codex-thread-1", tokenUsage: { total: { inputTokens: 12, outputTokens: 3 }, last: { inputTokens: 12, outputTokens: 3 } } });
    server.notify("turn/completed", { threadId: "codex-thread-1", turn: { id: "srv-1", status: "completed" } });
    await expect.poll(async () => (await Effect.runPromise(driver.readThread(START.threadId))).turns.length).toBe(1);
    const outcome = await driver.awaitTurn(START.threadId, sent.turnId);
    expect(outcome.text).toBe("");
    expect(outcome.usage).toMatchObject({ input: 12, output: 3 });
  });

  it("answers on a disposable read-only fork without enabling inherited external tools", async () => {
    const transport = new FakeCodexTransport();
    const driver = new CodexDriver({ transport });
    const answer = driver.sideQuestion({ cursor: "parent", workingDirectory: START.workingDirectory, question: "Why?" });
    await expect.poll(() => transport.sessions[0]?.server.requestsTo("turn/start").length).toBe(1);
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("thread/fork")[0]!.params).toMatchObject({ threadId: "parent", ephemeral: true, excludeTurns: true, sandbox: "read-only", approvalPolicy: "never", config: { "features.shell_tool": false, "features.multi_agent": false, "mcp_servers.private.enabled": false, "apps._default.enabled": false } });
    server.notify("item/agentMessage/delta", { threadId: "fork-1", itemId: "m", delta: "Because." });
    server.notify("turn/completed", { threadId: "fork-1", turn: { status: "completed" } });
    await expect(answer).resolves.toEqual({ text: "Because.", withContext: true });
    expect(transport.sessions[0]!.client.closed).toBe(true);
    expect(server.requestsTo("thread/start")).toEqual([]);
  });
});

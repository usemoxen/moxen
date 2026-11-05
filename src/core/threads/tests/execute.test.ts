import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeDriver } from "../../providers/opencode/driver.js";
import { FakeOpencodeTransport } from "../../providers/opencode/tests/fakes.js";
import type { ProviderRuntimeEvent } from "../../providers/spi.js";
import { CliError } from "../../errors.js";
import { openThreadStore } from "../store.js";
import { adoptProviderTitle, createThread, readThread, sendTurn, interruptTurn, openTurn } from "../threads.js";
import { retitleThread, type OperationContext } from "../operations.js";
import { driverForInstance, ensureDriverSession, executeTurn, watchDriverSession, type TurnDriver } from "../execute.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { buildHandoff } from "../handoff.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe("driverForInstance", () => {
  it("routes known providers and shares opencode/* drivers", () => {
    const owner = {};
    const factories = { opencode: () => new OpenCodeDriver({ transport: new FakeOpencodeTransport() }) };
    const first = driverForInstance(owner, "opencode/anthropic", factories);
    expect(driverForInstance(owner, "opencode/openai", factories)).toBe(first);
    expect(driverForInstance(owner, "OPENCODE", factories)).toBe(first);
    expect(() => driverForInstance(owner, "cursor", factories)).toThrowError(
      expect.objectContaining({ code: "PROVIDER_UNKNOWN" }),
    );
    expect(driverForInstance({}, "opencode/x", factories)).not.toBe(first);
  });
});

describe("executeTurn", () => {
  it.each(["completed", "interrupted", "aborted", "failed", "empty-result", "late-result"] as const)("keeps streamed wrap-up notes in history when the turn is %s", async (status) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-wrap-notes-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "p", title: "Wrap up", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, env: { mode: "local", path: root, branch: null } });
    const sent = await sendTurn(store, thread.id, { prompt: "Private stopping instructions", origin: "usage-protection", usageControl: true });
    const queue = await Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>());
    cleanup.push(async () => { await Effect.runPromise(Queue.shutdown(queue)); });
    let received!: () => void;
    const streamed = new Promise<void>((resolve) => { received = resolve; });
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true), startSession: () => Effect.succeed({}),
      sendTurn: () => Effect.succeed({ threadId: thread.id, turnId: "native-turn" }),
      interruptTurn: () => Effect.void, streamEvents: Stream.fromQueue(queue),
      awaitTurn: async () => {
        await Effect.runPromise(Queue.offer(queue, { type: "message.part.updated", provider: "codex", threadId: thread.id, turnId: "native-turn", messageId: "earlier", text: "Edits are on disk; inspect them before continuing." }));
        await Effect.runPromise(Queue.offer(queue, { type: "assistant.note", provider: "codex", threadId: thread.id, turnId: "native-turn", messageId: "earlier", text: "Edits are on disk; inspect them before continuing." }));
        await Effect.runPromise(Queue.offer(queue, { type: "message.part.updated", provider: "codex", threadId: thread.id, turnId: "native-turn", messageId: "retracted", text: "Discarded attempt" }));
        await Effect.runPromise(Queue.offer(queue, { type: "message.retracted", provider: "codex", threadId: thread.id, turnId: "native-turn", messageIds: ["retracted"], toolUseIds: [] }));
        await Effect.runPromise(Queue.offer(queue, { type: "message.part.updated", provider: "codex", threadId: thread.id, turnId: "native-turn", messageId: "notes", text: "Stopping here; " }));
        await Effect.runPromise(Queue.offer(queue, { type: "message.part.updated", provider: "codex", threadId: thread.id, turnId: "native-turn", messageId: "notes", text: "tests remain unfinished." }));
        await streamed;
        if (status === "aborted") {
          await interruptTurn(store, thread.id, sent.turn.id);
          throw new CliError("TURN_ABORTED", "Interrupted before result");
        }
        if (status === "late-result") await interruptTurn(store, thread.id, sent.turn.id);
        return { status: status === "empty-result" || status === "late-result" ? "completed" : status, text: status === "completed" || status === "late-result" ? "Stopping here; tests remain unfinished." : "", usage: null, error: null };
      },
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: sent.turn.id, prompt: "Private stopping instructions", onEvent: (event) => { if (event.type === "message.part.updated" && event.text.includes("tests remain")) received(); } });
    const reopened = await openThreadStore(root);
    expect((await reopened.readMessages(thread.id)).filter((row) => row.role === "assistant").map((row) => row.text)).toEqual(["Edits are on disk; inspect them before continuing.", "Stopping here; tests remain unfinished."]);
    expect(await buildHandoff(reopened, thread.id)).toContain("Stopping here; tests remain unfinished.");
    expect(await buildHandoff(reopened, thread.id, { preferModelSummary: true })).toContain("Stopping here; tests remain unfinished.");
    expect(await buildHandoff(reopened, thread.id, { preferModelSummary: true })).toContain("Edits are on disk; inspect them before continuing.");
  });

  it.each([false, true])("a late interrupted runner never interrupts the replacement wrap-up (throws=%s)", async (throws) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-interrupt-race-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "p", title: "Race", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, env: { mode: "local", path: root, branch: null } });
    const original = await sendTurn(store, thread.id, { prompt: "work" });
    let replacement: string | undefined;
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true), startSession: () => Effect.succeed({}),
      sendTurn: () => Effect.succeed({ threadId: thread.id, turnId: "original" }),
      interruptTurn: () => Effect.void, streamEvents: Stream.never,
      awaitTurn: async () => {
        await interruptTurn(store, thread.id, original.turn.id);
        replacement = (await sendTurn(store, thread.id, { prompt: "wrap up" })).turn.id;
        if (throws) throw new CliError("TURN_ABORTED", "Interrupted");
        return { status: "interrupted", text: "", usage: null, error: null };
      },
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: original.turn.id, prompt: "work" });
    expect(openTurn(await store.readTurns(thread.id))?.id).toBe(replacement);
    await interruptTurn(store, thread.id, replacement);
  });

  it("converges completion, usage, checkpoints, and events into the ledger", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-execute-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Execute",
      modelSelection: { instanceId: "opencode/anthropic", model: "claude-opus-4-6" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (
      await import("../threads.js")
    ).sendTurn(store, thread.id, { prompt: "do it" });

    const transport = new FakeOpencodeTransport({
      messages: [
        {
          info: { id: "m", role: "assistant", tokens: { input: 4, output: 8, reasoning: 1, cache: { read: 0, write: 2 } } },
          parts: [],
        },
      ],
    });
    const driver = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    await Effect.runPromise(driver.startSession({ threadId: thread.id, workingDirectory: root }));
    const seen: ProviderRuntimeEvent[] = [];
    const running = executeTurn({
      store,
      driver,
      threadId: thread.id,
      storeTurnId: turn.id,
      prompt: "do it",
      modelSelection: thread.modelSelection,
      workingDirectory: root,
      onEvent: (event) => seen.push(event),
    });
    const deadline = Date.now() + 3000;
    for (;;) {
      if ((transport.servers[0]?.callsTo("session.prompt").length ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error("prompt was never called");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await transport.servers[0]?.push({
      type: "message.part.updated",
      properties: { sessionID: "opencode-session-1", part: { id: "p-1", type: "text", text: "answer" } },
    });
    await transport.servers[0]?.push({ type: "session.idle", properties: { sessionID: "opencode-session-1" } });
    await running;

    const read = await readThread(store, thread.id);
    expect(read.turns[0]?.status).toBe("completed");
    expect(read.turns[0]?.usage).toMatchObject({ input: 4, output: 8 });
    expect(read.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
      "answer",
    ]);
    const checkpoints = await store.readCheckpoints(thread.id);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]?.status).toBe("unavailable");
    expect(seen.map((event) => event.type)).toContain("message.part.updated");
  });

  it("records the turn's tool calls as replayable activity rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-execute-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Tools",
      modelSelection: { instanceId: "opencode/anthropic", model: "claude-opus-4-6" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "run it" });

    const transport = new FakeOpencodeTransport();
    const driver = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    await Effect.runPromise(driver.startSession({ threadId: thread.id, workingDirectory: root }));
    const running = executeTurn({
      store,
      driver,
      threadId: thread.id,
      storeTurnId: turn.id,
      prompt: "run it",
      modelSelection: thread.modelSelection,
    });
    const deadline = Date.now() + 3000;
    for (;;) {
      if ((transport.servers[0]?.callsTo("session.prompt").length ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error("prompt was never called");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const toolPart = (status: string, output?: string) => ({
      type: "message.part.updated" as const,
      properties: {
        sessionID: "opencode-session-1",
        part: {
          id: "prt-1",
          callID: "call-1",
          type: "tool",
          tool: "bash",
          state: {
            status,
            input: { command: "git status" },
            ...(output === undefined ? {} : { output }),
            time: { start: 1000, ...(status === "completed" ? { end: 2000 } : {}) },
          },
        },
      },
    });
    await transport.servers[0]?.push(toolPart("running"));
    // A repeat of the same state must not add a row.
    await transport.servers[0]?.push(toolPart("running"));
    await transport.servers[0]?.push(toolPart("completed", "on branch main"));
    await transport.servers[0]?.push({ type: "session.idle", properties: { sessionID: "opencode-session-1" } });
    await running;

    const read = await readThread(store, thread.id);
    const tools = read.activities.filter((activity) => activity.kind.startsWith("tool-call."));
    expect(tools.map((activity) => activity.kind)).toEqual(["tool-call.started", "tool-call.completed"]);
    expect(tools[0]?.summary).toBe("$ git status");
    // Both rows share the call id, so the transcript folds them into one card.
    expect(tools.map((activity) => (activity.payload as { toolCallId: string }).toolCallId)).toEqual([
      "call-1",
      "call-1",
    ]);
    expect((tools[1]?.payload as { status: string }).status).toBe("completed");
  });

  it("records failures without losing the prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-execute-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Execute",
      modelSelection: { instanceId: "opencode/anthropic", model: "x" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (
      await import("../threads.js")
    ).sendTurn(store, thread.id, { prompt: "do it" });

    const transport = new FakeOpencodeTransport({ failMethods: { "session.prompt": "nope" } });
    const failing = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    await Effect.runPromise(failing.startSession({ threadId: thread.id, workingDirectory: root }));
    await executeTurn({
      store,
      driver: failing,
      threadId: thread.id,
      storeTurnId: turn.id,
      prompt: "do it",
    });
    const read = await readThread(store, thread.id);
    expect(read.turns[0]?.status).toBe("failed");
  });
});

/**
 * A thread's provider-side history has to outlive the process that started
 * it. The native session handle only ever lived in the driver's memory, so
 * closing the TUI (or a CLI `send` from a fresh process) silently began an
 * empty provider conversation under the old transcript.
 */
describe("provider session resume", () => {
  async function ranThread(nativeTitle: string | null = null) {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-resume-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Resume",
      modelSelection: { instanceId: "opencode/anthropic", model: "claude-opus-4-6" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "remember 7" });
    const transport = new FakeOpencodeTransport();
    const driver = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    await ensureDriverSession(driver, thread, { store });
    const sessionsBeforeTurn = (await store.readThreadRecord(thread.id))?.providerSessions;
    const running = executeTurn({
      store,
      driver,
      threadId: thread.id,
      storeTurnId: turn.id,
      prompt: "remember 7",
      workingDirectory: root,
    });
    const deadline = Date.now() + 3000;
    while ((transport.servers[0]?.callsTo("session.prompt").length ?? 0) === 0) {
      if (Date.now() > deadline) throw new Error("prompt was never called");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    transport.servers[0]!.title = nativeTitle;
    await transport.servers[0]?.push({ type: "session.idle", properties: { sessionID: "opencode-session-1" } });
    await running;
    return { store, threadId: thread.id, driver, server: transport.servers[0]!, root, sessionsBeforeTurn };
  }

  it("records the native session before sending the first turn, keyed by driver", async () => {
    const { store, threadId, sessionsBeforeTurn } = await ranThread();
    expect(sessionsBeforeTurn).toEqual({ opencode: "opencode-session-1" });
    const record = await store.readThreadRecord(threadId);
    expect(record?.providerSessions).toEqual({ opencode: "opencode-session-1" });
  });

  it("adopts the provider's title unless the user named the thread, and renames and regenerates natively", async () => {
    const { store, threadId, driver, server, root } = await ranThread("Native title");
    // Untitled on creation, so OpenCode's own title agent names the session.
    expect(server.callsTo("session.create").map((call) => call.args)).toEqual([{}]);
    expect(await store.readThreadRecord(threadId)).toMatchObject({ title: "Native title", titleSource: "provider" });

    const ctx = { store, storeRoot: root, config: {}, driverFor: () => driver } as unknown as OperationContext;
    await retitleThread(ctx, threadId, { title: "  Mine " });
    expect(await store.readThreadRecord(threadId)).toMatchObject({ title: "Mine", titleSource: "user" });
    expect(server.title).toBe("Mine");
    expect(await adoptProviderTitle(store, threadId, "Native again")).toBeNull();

    await retitleThread(ctx, threadId, { regenerate: true });
    expect(await store.readThreadRecord(threadId)).toMatchObject({ title: "Regenerated title", titleSource: "provider" });

    // A provider with no native regeneration keeps moxen's seed from the first message.
    await retitleThread({ ...ctx, driverFor: () => ({}) as TurnDriver }, threadId, { regenerate: true });
    expect(await store.readThreadRecord(threadId)).toMatchObject({ title: "remember 7", titleSource: "seed" });
  });

  it("resumes that session from a fresh driver instead of starting an empty one", async () => {
    const { store, threadId } = await ranThread();
    // A new driver is what a new process gets: nothing in memory.
    const transport = new FakeOpencodeTransport({ sessionID: "opencode-session-2" });
    const driver = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    const record = await store.readThreadRecord(threadId);
    await ensureDriverSession(driver, record!);
    const server = transport.servers[0]!;
    expect(server.callsTo("session.get").map((call) => call.args)).toEqual([{ sessionID: "opencode-session-1" }]);
    expect(server.callsTo("session.create")).toEqual([]);
    expect(driver.resumeCursor(threadId)).toBe("opencode-session-1");
  });

  it("starts fresh when the provider no longer has the session", async () => {
    const { store, threadId } = await ranThread();
    const transport = new FakeOpencodeTransport({
      sessionID: "opencode-session-2",
      lostSessions: ["opencode-session-1"],
    });
    const driver = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    await ensureDriverSession(driver, (await store.readThreadRecord(threadId))!);
    expect(transport.servers[0]!.callsTo("session.create")).toHaveLength(1);
    expect(driver.resumeCursor(threadId)).toBe("opencode-session-2");
  });
});

describe("context usage", () => {
  it("records the driver's context reading before the turn's outcome", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-context-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Context",
      modelSelection: { instanceId: "claude", model: "m" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "go" });
    const reading = { usedTokens: 12_000, maxTokens: 200_000, cachedInputTokens: 11_000, autoCompactThreshold: null, compactsAutomatically: true };
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "d-1" }),
      interruptTurn: () => Effect.void,
      awaitTurn: async () => ({ status: "completed", text: "done", usage: null, error: null }),
      streamEvents: Stream.never,
      contextUsage: async () => reading,
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go" });

    const kinds = (await store.readActivities(thread.id)).map((row) => row.kind);
    const context = kinds.indexOf("context-window.updated");
    expect(context).toBeGreaterThan(-1);
    expect(context).toBeLessThan(kinds.indexOf("turn.completed"));
    const row = (await store.readActivities(thread.id))[context]!;
    expect(row.payload).toEqual(reading);
    expect(row.summary).toBe("12000 / 200000 tokens in context");
  });

  it("does not hold the turn hostage to a slow or failing reading", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-context-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Context",
      modelSelection: { instanceId: "claude", model: "m" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "go" });
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "d-1" }),
      interruptTurn: () => Effect.void,
      awaitTurn: async () => ({ status: "completed", text: "done", usage: null, error: null }),
      streamEvents: Stream.never,
      contextUsage: async () => {
        throw new Error("control request timed out");
      },
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go" });
    expect((await store.readTurns(thread.id))[0]?.status).toBe("completed");
    expect((await store.readActivities(thread.id)).some((row) => row.kind === "context-window.updated")).toBe(false);
  });
});

describe("live checklist", () => {
  it("records a turn.plan.updated event as an activity row the tasks panel can read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-plan-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Plan",
      modelSelection: { instanceId: "claude", model: "m" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "go" });
    const plan = [
      { step: "Write the plan", status: "completed" },
      { step: "Implement it", status: "inProgress" },
    ];
    // A finite `Stream.make` drains synchronously inside `ensureDriverPump`'s
    // `runFork` — before `subscribeDriverThread` has added a subscriber — so
    // a fixed event would be silently dropped here (real drivers publish off
    // genuinely async I/O and never hit this). A queue only yields once
    // offered, after the turn runner has subscribed.
    const queue = await Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>());
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "d-1" }),
      interruptTurn: () => Effect.void,
      awaitTurn: async () => {
        await Effect.runPromise(
          Queue.offer(queue, {
            type: "turn.plan.updated",
            provider: "claude",
            threadId: thread.id,
            turnId: "d-1",
            raw: { plan },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "completed", text: "done", usage: null, error: null };
      },
      streamEvents: Stream.fromQueue(queue),
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go" });

    const rows = (await store.readActivities(thread.id)).filter((row) => row.kind === "turn.plan.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ plan });
  });
});

describe("provider-side interruptions", () => {
  /** A driver that publishes `events` mid-turn, then completes. */
  function scriptedDriver(threadId: string, events: ProviderRuntimeEvent[]): Promise<TurnDriver> {
    return Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>()).then((queue) => ({
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "d-1" }),
      interruptTurn: () => Effect.void,
      awaitTurn: async () => {
        for (const event of events) await Effect.runPromise(Queue.offer(queue, event));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "completed" as const, text: "done", usage: null, error: null };
      },
      streamEvents: Stream.fromQueue(queue),
      // For events that arrive after the turn, when nothing is scripted.
      queue,
    }));
  }

  it.each([false, true])("queues a late provider wake before closing a protected session (native input available: %s)", async (captured) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-protected-wake-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "p", title: "Held", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" }, env: { mode: "local", path: root, branch: null } });
    await store.writeThreadRecord({ ...thread, usagePause: { provider: "claude", phase: "waiting", resetsAt: null, order: 1, handoff: false } });
    const driver = await scriptedDriver(thread.id, []);
    const interrupt = vi.fn(() => Effect.void);
    const close = vi.fn(() => Effect.void);
    Object.assign(driver, { interruptTurn: interrupt, stopSession: close });
    watchDriverSession(store, driver, thread.id, root);
    const queue = (driver as unknown as { queue: Queue.Queue<ProviderRuntimeEvent> }).queue;
    if (captured) for (const prompt of ["exact native completion report", "exact injected notification", "exact injected notification"]) await Effect.runPromise(Queue.offer(queue, {
      type: "background.wake-up", provider: "claude", threadId: thread.id, requestId: "native-run", prompt,
    }));
    await Effect.runPromise(Queue.offer(queue, {
      type: "turn.started", provider: "claude", threadId: thread.id, turnId: "late", origin: "background", wakeUpPrompt: "native start payload",
    }));
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(thread.id), { timeout: 10_000 });
    expect(interrupt).toHaveBeenCalledWith(thread.id);
    const turns = await store.readTurns(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "queued", queue: { wakeUp: true, requestId: captured ? "native-run" : "native-turn:late" } });
    const messages = await store.readMessages(thread.id);
    if (captured) expect(messages.map((message) => message.text)).toEqual(["exact native completion report", "exact injected notification"]);
    else expect(messages[0]!.text).toContain("native start payload");
    const reopened = await openThreadStore(root);
    expect(await reopened.readMessages(thread.id)).toEqual(messages);
    expect(await reopened.readTurns(thread.id)).toEqual(turns);
  });

  it("records a session-wide model fallback and moves the turn and the thread to the new model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-fallback-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const modelSelection = { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }] };
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Fallback",
      modelSelection,
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "explain" });
    const driver = await scriptedDriver(thread.id, [
      { type: "message.retracted", provider: "claude", threadId: thread.id, turnId: "d-1", messageIds: ["msg-1"], toolUseIds: ["tu-1"] },
      {
        type: "model.changed",
        provider: "claude",
        threadId: thread.id,
        turnId: "d-1",
        from: "claude-fable-5-1",
        to: "claude-opus-5",
        fromLabel: "Claude Fable 5.1",
        toLabel: "Claude Opus 5",
        reason: "refusal-fallback",
        scope: "session",
        category: "bio",
      },
    ]);
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "explain", modelSelection });

    const activities = await store.readActivities(thread.id);
    expect(activities.find((row) => row.kind === "message.retracted")?.payload).toEqual({
      messageIds: [`${turn.id}:msg-1`],
      toolCallIds: ["tu-1"],
    });
    const switched = activities.find((row) => row.kind === "model.changed");
    expect(switched?.summary).toBe("Switched to Claude Opus 5");
    expect(switched?.payload).toMatchObject({ from: "claude-fable-5-1", to: "claude-opus-5", category: "bio", scope: "session" });
    const moved = { ...modelSelection, model: "claude-opus-5" };
    expect((await store.readTurns(thread.id))[0]?.modelSelection).toEqual(moved);
    expect((await store.readThreadRecord(thread.id))?.modelSelection).toEqual(moved);
  });

  it("records a background subagent that stops after its turn closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-subagent-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const modelSelection = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Background subagent",
      modelSelection,
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "go" });
    const subagent = (status: "started" | "stopped"): ProviderRuntimeEvent => ({
      type: "subagent.updated",
      provider: "claude",
      threadId: thread.id,
      turnId: "d-1",
      agentId: "ag-1",
      agentType: "Explore",
      status,
      lastMessage: status === "stopped" ? "Found 3." : null,
    });
    const driver = await scriptedDriver(thread.id, [subagent("started")]);
    watchDriverSession(store, driver, thread.id, root);
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go", modelSelection });
    // The turn is over; only the session watcher still hears the stop.
    await Effect.runPromise(Queue.offer((driver as unknown as { queue: Queue.Queue<ProviderRuntimeEvent> }).queue, subagent("stopped")));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = (await store.readActivities(thread.id)).filter((row) => row.kind === "subagent");
    // Once each: mid-turn the runner records it and the watcher stands aside.
    expect(rows.map((row) => (row.payload as { status: string }).status)).toEqual(["started", "stopped"]);
    expect(rows[1]?.payload).toMatchObject({ toolCallId: "subagent:ag-1", lastMessage: "Found 3." });
  });

  it("records notices and native subagents, and one model switch per move", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-notice-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const modelSelection = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Notices",
      modelSelection,
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "go" });
    const switched = (reason: "auto" | "refusal-fallback", category: string | null): ProviderRuntimeEvent => ({
      type: "model.changed",
      provider: "claude",
      threadId: thread.id,
      turnId: "d-1",
      from: "claude-fable-5-1",
      to: "claude-opus-5",
      reason,
      scope: "session",
      category,
    });
    const driver = await scriptedDriver(thread.id, [
      { type: "session.notice", provider: "claude", threadId: thread.id, turnId: "d-1", notice: "compacted", title: "Conversation compacted", detail: "Kept: the plan." },
      { type: "subagent.updated", provider: "claude", threadId: thread.id, turnId: "d-1", agentId: "ag-1", agentType: "Explore", status: "stopped", lastMessage: "Done." },
      // The same move reported as the CLI's own switch, then as the refusal it was, then again.
      switched("auto", null),
      switched("refusal-fallback", "bio"),
      switched("auto", null),
    ]);
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go", modelSelection });

    const activities = await store.readActivities(thread.id);
    expect(activities.find((row) => row.kind === "notice")).toMatchObject({
      summary: "Conversation compacted",
      payload: { notice: "compacted", detail: "Kept: the plan." },
    });
    expect(activities.find((row) => row.kind === "subagent")?.payload).toMatchObject({
      toolCallId: "subagent:ag-1",
      agentType: "Explore",
      status: "stopped",
      lastMessage: "Done.",
    });
    const switches = activities.filter((row) => row.kind === "model.changed");
    // Two rows sharing one fold key: the transcript shows one card, and the refusal's reason survives the merge.
    expect(switches.map((row) => (row.payload as { reason: string }).reason)).toEqual(["auto", "refusal-fallback"]);
    expect(new Set(switches.map((row) => (row.payload as { toolCallId: string }).toolCallId)).size).toBe(1);
  });

  it("records a usage-limit hit with the window and its reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-limit-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Limit",
      modelSelection: { instanceId: "claudeAgent", model: "m" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "go" });
    const driver = await scriptedDriver(thread.id, [
      {
        type: "thread.state.changed",
        provider: "claude",
        threadId: thread.id,
        state: "rate-limited",
        raw: { rateLimitType: "five_hour", label: "Session", resetsAt: "2026-09-25T15:45:00.000Z", notice: "paused" },
      },
    ]);
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go" });
    const row = (await store.readActivities(thread.id)).find((activity) => activity.kind === "usage.limit");
    expect(row?.summary).toBe("Usage limit reached");
    expect(row?.payload).toEqual({
      provider: "claude",
      rateLimitType: "five_hour",
      label: "Session",
      resetsAt: "2026-09-25T15:45:00.000Z",
    });
  });
});

/**
 * The second turn into the same wall. The provider reports a limit only
 * when it changes, so a queued message that runs after a hit fails with a
 * bare error — which used to read as "a later turn got through", hiding
 * the limit card and skipping the continue after the reset.
 */
describe("a turn that fails while a limit stands", () => {
  async function failingTurn() {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-standing-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Standing",
      modelSelection: { instanceId: "opencode/anthropic", model: "x" },
      env: { mode: "local", path: root, branch: null },
    });
    const { turn } = await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "queued after the hit" });
    const transport = new FakeOpencodeTransport({ failMethods: { "session.prompt": "usage limit" } });
    const driver = new OpenCodeDriver({ transport, env: { ANTHROPIC_API_KEY: "test-key" } });
    await Effect.runPromise(driver.startSession({ threadId: thread.id, workingDirectory: root }));
    const limited: Array<{ turnId: string; resetsAt: string | null }> = [];
    await executeTurn({
      store,
      driver,
      threadId: thread.id,
      storeTurnId: turn.id,
      prompt: "queued after the hit",
      modelSelection: { instanceId: "opencode/anthropic", model: "x" },
      onUsageLimit: (turnId, resetsAt) => limited.push({ turnId, resetsAt }),
    });
    return { store, threadId: thread.id, turnId: turn.id, limited };
  }

  afterEach(() => resetUsageLimitsForTests());

  it("records the standing limit on the failed turn and asks for the continue", async () => {
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    recordUsageWindows("opencode", [{ id: "session", label: "Session", resetsAt, exhausted: true, usedPercent: 100 }]);
    const { store, threadId, turnId, limited } = await failingTurn();
    const row = (await store.readActivities(threadId)).find((activity) => activity.kind === "usage.limit");
    expect(row?.turnId).toBe(turnId);
    expect(row?.payload).toMatchObject({ provider: "opencode", label: "Session", resetsAt, standing: true });
    expect(limited).toEqual([{ turnId, resetsAt }]);
  });

  it("leaves an ordinary failure alone when no window is spent", async () => {
    const { store, threadId, limited } = await failingTurn();
    expect((await store.readActivities(threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
    expect(limited).toEqual([]);
  });

  it("ignores a spent window whose reset has already passed", async () => {
    recordUsageWindows("opencode", [
      { id: "session", label: "Session", resetsAt: new Date(Date.now() - 60_000).toISOString(), exhausted: true, usedPercent: 100 },
    ]);
    const { store, threadId } = await failingTurn();
    expect((await store.readActivities(threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
  });
});

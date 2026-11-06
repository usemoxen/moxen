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
import { openThreadStore, type ThreadStore } from "../store.js";
import { adoptProviderTitle, createThread, readThread, sendTurn, interruptTurn, openTurn, settleThread } from "../threads.js";
import type { StoredTurn } from "../types.js";
import { retitleThread, type OperationContext } from "../operations.js";
import { driverForInstance, ensureDriverSession, executeTurn, watchDriverSession, type TurnDriver } from "../execute.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { settleRuns } from "../../testing/turns.js";
import { rmTempAsync } from "../../testing/tmp.js";
import { buildHandoff } from "../handoff.js";

/**
 * MXN-290 review: make the checkpoint capture hang on demand, so the
 * bounded pre-outcome work can be pinned. Off unless a test opts in;
 * every other test in this file keeps the real implementation.
 */
let hangCheckpointCapture = false;
const pendingCheckpointCaptures: Array<(ref: string | null) => void> = [];
vi.mock("../../checkpoints/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../checkpoints/git.js")>();
  return {
    ...mod,
    captureWorktree: (...args: Parameters<typeof mod.captureWorktree>) => {
      if (!hangCheckpointCapture) return mod.captureWorktree(...args);
      return new Promise<string | null>((resolve) => {
        pendingCheckpointCaptures.push(resolve);
      });
    },
  };
});

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  hangCheckpointCapture = false;
  pendingCheckpointCaptures.length = 0;
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

  it("a settling runner leaves a promoted turn to the runner that claimed it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-claim-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "p", title: "Race", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, env: { mode: "local", path: root, branch: null } });
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    const queued = await sendTurn(store, thread.id, { prompt: "only once", delivery: "queue" });
    const sent: string[] = [];
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true), startSession: () => Effect.succeed({}),
      sendTurn: (input) => { sent.push(input.prompt); return Effect.succeed({ threadId: thread.id, turnId: "native" }); },
      interruptTurn: () => Effect.void, streamEvents: Stream.never,
      awaitTurn: async () => {
        // The work queue has admitted the next turn and is still setting it up: running, not yet tracked.
        if (sent.length === 1) {
          await store.updateTurn(thread.id, queued.turn.id, { status: "running" });
          store.claimRun(queued.turn.id);
        }
        return { status: "completed", text: "done", usage: null, error: null };
      },
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: first.turn.id, prompt: "first" });
    await settleRuns();
    expect(sent).toEqual(["first"]);
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
    const toolPart = (status: string, input: Record<string, unknown> = { command: "git status" }, output?: string) => ({
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
            input,
            ...(output === undefined ? {} : { output }),
            time: { start: 1000, ...(status === "completed" ? { end: 2000 } : {}) },
          },
        },
      },
    });
    // OpenCode announces the call before it has generated its input.
    await transport.servers[0]?.push(toolPart("pending", {}));
    await transport.servers[0]?.push(toolPart("running"));
    // A repeat of the same state must not add a row.
    await transport.servers[0]?.push(toolPart("running"));
    await transport.servers[0]?.push(toolPart("completed", { command: "git status" }, "on branch main"));
    await transport.servers[0]?.push({ type: "session.idle", properties: { sessionID: "opencode-session-1" } });
    await running;

    const read = await readThread(store, thread.id);
    const tools = read.activities.filter((activity) => activity.kind.startsWith("tool-call."));
    // The row that starts running carries the command; the pending one and the
    // repeat of the same running state do not add anything else.
    expect(tools.map((activity) => activity.kind)).toEqual(["tool-call.started", "tool-call.started", "tool-call.completed"]);
    expect(tools.map((activity) => activity.summary)).toEqual(["$ bash", "$ git status", "$ git status"]);
    expect((tools[0]?.payload as { data: { state: { input: unknown } } }).data.state.input).toEqual({});
    // Every row shares the call id, so the transcript folds them into one card.
    expect(tools.map((activity) => (activity.payload as { toolCallId: string }).toolCallId)).toEqual([
      "call-1",
      "call-1",
      "call-1",
    ]);
    expect((tools[2]?.payload as { status: string }).status).toBe("completed");
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

  /** MXN-290: a turn that fails by exception still writes its context reading and checkpoint before its outcome. */
  it("records the context reading and checkpoint before a failed turn's outcome", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-context-fail-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let now = Date.parse("2026-09-20T12:00:00.000Z");
    const store = await openThreadStore(root, { clock: () => (now += 1000) });
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
      awaitTurn: async () => {
        throw new Error("provider exploded");
      },
      streamEvents: Stream.never,
      contextUsage: async () => reading,
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go" });

    expect((await store.readTurns(thread.id))[0]?.status).toBe("failed");
    const kinds = (await store.readActivities(thread.id)).map((row) => row.kind);
    const context = kinds.indexOf("context-window.updated");
    const failed = kinds.indexOf("turn.failed");
    expect(context).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(-1);
    expect(context).toBeLessThan(failed);
    const checkpoints = await store.readCheckpoints(thread.id);
    expect(checkpoints).toHaveLength(1);
    expect(Date.parse(checkpoints[0]!.createdAt)).toBeLessThan(
      Date.parse((await store.readActivities(thread.id))[failed]!.createdAt),
    );
  });

  /** MXN-290: a turn aborted mid-run still writes its context reading and checkpoint before it is marked interrupted. */
  it("records the context reading and checkpoint before an aborted turn stops", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-context-abort-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let now = Date.parse("2026-09-20T12:00:00.000Z");
    const store = await openThreadStore(root, { clock: () => (now += 1000) });
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
      awaitTurn: async () => {
        throw new CliError("TURN_ABORTED", "Interrupted before result");
      },
      streamEvents: Stream.never,
      contextUsage: async () => reading,
    };
    await executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go" });

    expect((await store.readTurns(thread.id))[0]?.status).toBe("interrupted");
    const activities = await store.readActivities(thread.id);
    const kinds = activities.map((row) => row.kind);
    const context = kinds.indexOf("context-window.updated");
    const interrupted = kinds.indexOf("turn.interrupted");
    expect(context).toBeGreaterThan(-1);
    expect(interrupted).toBeGreaterThan(-1);
    expect(context).toBeLessThan(interrupted);
    const checkpoints = await store.readCheckpoints(thread.id);
    expect(checkpoints).toHaveLength(1);
    expect(Date.parse(checkpoints[0]!.createdAt)).toBeLessThan(Date.parse(activities[interrupted]!.createdAt));
  });

  /** MXN-290 review: the outcome is written on timeout when the checkpoint hangs, and a late checkpoint breaks nothing. */
  it("writes the failure outcome even when the checkpoint never resolves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-checkpoint-hang-"));
    // Retrying remove: the released capture's git can still hold the folder
    // for a moment on Windows (EBUSY), and a bare rm turns that into a failure.
    cleanup.push(() => rmTempAsync(root));
    const store = await openThreadStore(root);
    const thread = await createThread(store, {
      projectId: "project-1",
      title: "Checkpoint",
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
      awaitTurn: async () => {
        hangCheckpointCapture = true;
        throw new Error("provider exploded");
      },
      streamEvents: Stream.never,
      contextUsage: async () => reading,
    };
    const run = executeTurn({ store, driver, threadId: thread.id, storeTurnId: turn.id, prompt: "go", workingDirectory: root });
    // The 15s bound fires: the turn reads failed while the capture is still hanging.
    await vi.waitFor(async () => {
      expect((await store.readTurns(thread.id))[0]?.status).toBe("failed");
    }, { timeout: 30_000 });
    await run;
    expect((await store.readTurns(thread.id))[0]).toMatchObject({ status: "failed", error: "provider exploded" });
    // The capture landing late still writes its row, and the outcome stands.
    for (const release of pendingCheckpointCaptures.splice(0)) release("late-post");
    await vi.waitFor(async () => {
      expect(await store.readCheckpoints(thread.id)).toHaveLength(1);
    }, { timeout: 10_000 });
    expect((await store.readTurns(thread.id))[0]?.status).toBe("failed");
  }, 90_000);
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

  /** MXN-290: a background provider turn on a settled thread is stopped, never recorded, and never wakes it. */
  it("stops a background provider turn on a settled thread without recording or waking it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-settled-bg-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = await openThreadStore(root);
    const thread = await createThread(store, { projectId: "p", title: "Settled", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" }, env: { mode: "local", path: root, branch: null } });
    await settleThread(store, thread.id);
    const driver = await scriptedDriver(thread.id, []);
    const interrupt = vi.fn(() => Effect.void);
    const close = vi.fn(() => Effect.void);
    Object.assign(driver, { interruptTurn: interrupt, stopSession: close });
    watchDriverSession(store, driver, thread.id, root);
    const queue = (driver as unknown as { queue: Queue.Queue<ProviderRuntimeEvent> }).queue;
    await Effect.runPromise(Queue.offer(queue, {
      type: "turn.started", provider: "claude", threadId: thread.id, turnId: "late-settled", origin: "background",
    }));
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(thread.id), { timeout: 10_000 });
    expect(interrupt).toHaveBeenCalledWith(thread.id);
    expect(await store.readTurns(thread.id)).toHaveLength(0);
    expect((await store.readThreadRecord(thread.id))?.settledAt).not.toBeNull();
  });

  /** MXN-290 review: BUSY never kills — the winner keeps its session, the wake-up is queued. */
  describe("a background start on a busy thread", () => {
    /** A watcher driver that only records interrupt/stop calls. */
    async function watchingDriver(threadId: string) {
      const queue = await Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>());
      cleanup.push(async () => { await Effect.runPromise(Queue.shutdown(queue)); });
      const interrupt = vi.fn(() => Effect.void);
      const close = vi.fn(() => Effect.void);
      const driver: TurnDriver = {
        hasSession: () => Effect.succeed(true),
        startSession: () => Effect.succeed({}),
        sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "d-1" }),
        interruptTurn: interrupt,
        awaitTurn: async () => ({ status: "completed" as const, text: "done", usage: null, error: null }),
        streamEvents: Stream.fromQueue(queue),
        stopSession: close,
      };
      return { driver, queue, interrupt, close };
    }

    async function backgroundStarted(queue: Queue.Queue<ProviderRuntimeEvent>, threadId: string, turnId: string, wakeUpPrompt?: string) {
      await Effect.runPromise(Queue.offer(queue, {
        type: "turn.started", provider: "claude", threadId, turnId, origin: "background",
        ...(wakeUpPrompt !== undefined ? { wakeUpPrompt } : {}),
      }));
    }

    async function queuedWakeUp(store: ThreadStore, threadId: string): Promise<StoredTurn> {
      let wake: StoredTurn | undefined;
      await vi.waitFor(async () => {
        wake = (await store.readTurns(threadId)).find((turn) => turn.status === "queued" && turn.queue?.wakeUp === true);
        expect(wake).toBeDefined();
      }, { timeout: 30_000 });
      return wake!;
    }

    it("leaves a live user turn running, with no interrupt or stop", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "moxen-busy-bg-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const store = await openThreadStore(root);
      const thread = await createThread(store, { projectId: "p", title: "Busy", modelSelection: { instanceId: "claude", model: "m" }, env: { mode: "local", path: root, branch: null } });
      const user = (await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "user work" })).turn;
      const watching = await watchingDriver(thread.id);
      watchDriverSession(store, watching.driver, thread.id, root);
      await backgroundStarted(watching.queue, thread.id, "native-busy-1", "native news");
      const wake = await queuedWakeUp(store, thread.id);
      expect(wake.queue).toMatchObject({ wakeUp: true, requestId: "native-turn:native-busy-1" });
      expect((await store.readMessages(thread.id)).some((message) => message.turnId === wake.id && message.text.includes("native news"))).toBe(true);
      // The winner was never touched: still running, session never interrupted or closed.
      expect(openTurn(await store.readTurns(thread.id))?.id).toBe(user.id);
      expect(watching.interrupt).not.toHaveBeenCalled();
      expect(watching.close).not.toHaveBeenCalled();
    }, 60_000);

    it("lets a queued turn promoted at settle run, with no interrupt or stop", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "moxen-busy-promote-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const store = await openThreadStore(root);
      const thread = await createThread(store, { projectId: "p", title: "Busy", modelSelection: { instanceId: "claude", model: "m" }, env: { mode: "local", path: root, branch: null } });
      const first = (await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "one" })).turn;
      const second = (await (await import("../threads.js")).sendTurn(store, thread.id, { prompt: "two", delivery: "queue" })).turn;
      const watching = await watchingDriver(thread.id);
      watchDriverSession(store, watching.driver, thread.id, root);
      await backgroundStarted(watching.queue, thread.id, "native-busy-2");
      await queuedWakeUp(store, thread.id);
      await (await import("../threads.js")).completeTurn(store, thread.id, first.id, { text: "done one" });
      await vi.waitFor(async () => {
        expect((await store.readTurns(thread.id)).find((turn) => turn.id === second.id)?.status).toBe("running");
      });
      expect((await store.readTurns(thread.id)).find((turn) => turn.id === first.id)?.status).toBe("completed");
      expect(watching.interrupt).not.toHaveBeenCalled();
      expect(watching.close).not.toHaveBeenCalled();
    }, 90_000);

    it("records later events while a background run is still going", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "moxen-bg-offchain-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const store = await openThreadStore(root);
      const thread = await createThread(store, { projectId: "p", title: "Background", modelSelection: { instanceId: "claude", model: "m" }, env: { mode: "local", path: root, branch: null } });
      const queue = await Effect.runPromise(Queue.unbounded<ProviderRuntimeEvent>());
      cleanup.push(async () => { await Effect.runPromise(Queue.shutdown(queue)); });
      const driver: TurnDriver = {
        hasSession: () => Effect.succeed(true),
        startSession: () => Effect.succeed({}),
        sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "d-1" }),
        interruptTurn: () => Effect.void,
        // The background run never ends: only the recording may hold the chain, never this.
        awaitTurn: () => new Promise(() => {}),
        streamEvents: Stream.fromQueue(queue),
      };
      watchDriverSession(store, driver, thread.id, root);
      await backgroundStarted(queue, thread.id, "bg-long");
      await vi.waitFor(async () => {
        expect(openTurn(await store.readTurns(thread.id))).not.toBeNull();
      }, { timeout: 10_000 });
      await Effect.runPromise(Queue.offer(queue, {
        type: "background.task", provider: "claude", threadId: thread.id, turnId: null,
        taskId: "t-1", status: "started", description: "Long job", taskType: "local_bash", toolUseId: null, summary: null,
      }));
      // The task row lands while the run is still going: the run went off the chain.
      await vi.waitFor(async () => {
        expect((await store.readActivities(thread.id)).some((row) => row.kind === "background.started")).toBe(true);
      }, { timeout: 10_000 });
      expect(openTurn(await store.readTurns(thread.id))).not.toBeNull();
    }, 60_000);
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
    // OpenCode reports per instance: this thread's account is `opencode/anthropic`.
    recordUsageWindows("opencode/anthropic", [{ id: "session", label: "Session", resetsAt, exhausted: true, usedPercent: 100 }]);
    const { store, threadId, turnId, limited } = await failingTurn();
    const row = (await store.readActivities(threadId)).find((activity) => activity.kind === "usage.limit");
    expect(row?.turnId).toBe(turnId);
    expect(row?.payload).toMatchObject({ provider: "opencode/anthropic", label: "Session", resetsAt, standing: true });
    expect(limited).toEqual([{ turnId, resetsAt }]);
  });

  it("leaves an ordinary failure alone when no window is spent", async () => {
    const { store, threadId, limited } = await failingTurn();
    expect((await store.readActivities(threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
    expect(limited).toEqual([]);
  });

  it("ignores a spent window whose reset has already passed", async () => {
    recordUsageWindows("opencode/anthropic", [
      { id: "session", label: "Session", resetsAt: new Date(Date.now() - 60_000).toISOString(), exhausted: true, usedPercent: 100 },
    ]);
    const { store, threadId } = await failingTurn();
    expect((await store.readActivities(threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
  });
});

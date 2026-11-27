/**
 * `message_queue`, through the real tool handler (`callMoxenTool`), the real server connection and the
 * real store. The only fakes are the provider drivers (`testHarness`).
 */
import { describe, expect, it, vi } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { settleRuns } from "../../../core/testing/turns.js";
import { parseScheduledTime } from "../../../core/threads/scheduledtime.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { completeTurn } from "../../../core/threads/threads.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, DELEGATION_TOOLS, moxenToolsFor } from "../tools.js";
import { answerMcp } from "../stdio.js";
import type { ClientApi } from "../../api.js";
import type { Command, Query } from "../../protocol.js";

const WAIT = { timeout: 12_000 };

async function setup(options: TestHarnessOptions = {}) {
  const harness = await testHarness(options);
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: options.leaveTurnsRunning !== true, threadEnvMode: "local" });
  const store = await openThreadStore(harness.root);
  const served = () => (connection as unknown as { store(): Promise<ThreadStore> }).store();
  const delegate = async () => {
    const result = await callMoxenTool(connection, orchestrator.threadId, "delegate", { task: "Do the work", title: "task", isolation: "shared" });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).taskId as string;
  };
  const queue = async (from: string, args: Record<string, unknown>) => {
    const result = await callMoxenTool(connection, from, "message_queue", args);
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  // MXN-372: a manual continue refuses a running source, so settle the
  // source's own turn first; its tasks keep running.
  const settleRunningTurns = async (threadId: string = orchestrator.threadId) => {
    for (const turn of await store.readTurns(threadId)) {
      if (turn.status === "running") await completeTurn(store, threadId, turn.id, { text: "Settled for the handoff." });
    }
  };
  return { harness, connection, store, served, orchestrator: orchestrator.threadId, delegate, queue, settleRunningTurns };
}

describe("message_queue: a thread queueing for itself", () => {
  it("waits behind the running turn and runs once after it, without joining it as a steer", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "Check the build again" });
      expect(queued.json).toMatchObject({ threadId: t.orchestrator, status: "queued", self: true, scheduledFor: null, expectedRun: "when the current turn ends" });
      const served = await t.served();
      const [first, entry] = await served.readTurns(t.orchestrator);
      expect(entry).toMatchObject({ id: queued.json!.turnId, status: "queued", delivery: "queued" });
      // Not a steer: the running turn gained no message and no steer activity, and the entry is a turn of its own.
      const messages = await served.readMessages(t.orchestrator);
      expect(messages.filter((message) => message.turnId === first!.id)).toHaveLength(1);
      expect((await served.readActivities(t.orchestrator)).some((row) => row.kind === "turn.steered" || row.kind === "message.injected")).toBe(false);
      const stored = messages.find((message) => message.id === queued.json!.messageId)!;
      expect(stored).toMatchObject({ role: "user", origin: "agent-message" });
      expect(stored.text).toBe("Message you queued for this thread earlier with message_queue (not from the user):\n\nCheck the build again");
      // It is the Work queue's entry, not a second scheduler's.
      expect((await t.connection.query({ type: "queue.read" })).entries.some((row) => row.turnId === entry!.id && row.threadId === t.orchestrator)).toBe(true);

      await completeTurn(served, t.orchestrator, first!.id, { text: "Done." });
      const turns = await served.readTurns(t.orchestrator);
      expect(turns.map((turn) => turn.status)).toEqual(["completed", "running"]);
      expect(turns[1]!.id).toBe(entry!.id);
      await completeTurn(served, t.orchestrator, entry!.id, { text: "Checked." });
      await settleRuns();
      expect((await served.readTurns(t.orchestrator)).map((turn) => turn.status)).toEqual(["completed", "completed"]);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("does not end a usage hold: on a protected thread it is an automatic wake-up that keeps waiting", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      await t.connection.dispatch({ type: "thread.protect", threadId: t.orchestrator });
      const queued = await t.queue(t.orchestrator, { message: "Resume after the reset" });
      expect(queued.json).toMatchObject({ status: "queued", self: true });
      expect(queued.json!.waitingFor).toContain("Waiting for thread protection");
      const served = await t.served();
      const thread = await served.readThreadRecord(t.orchestrator);
      expect(thread?.usagePause).toMatchObject({ forced: true });
      expect(thread?.usageProtectionOverride ?? null).toBeNull();
      const entry = (await served.readTurns(t.orchestrator)).find((turn) => turn.id === queued.json!.turnId)!;
      expect(entry).toMatchObject({ status: "queued", queue: { wakeUp: true, automatic: true } });
      expect((await t.connection.query({ type: "thread.inspect", threadId: t.orchestrator })).thread.protection).toMatchObject({ protected: true, waitingWakeUps: 1 });
    } finally {
      await t.connection.close();
    }
  }, 30_000);
});

describe("message_queue: when it runs", () => {
  it("holds a scheduled message to the time `at` names, read by the code --at uses", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const ahead = new Date(Date.now() + 3_600_000).toISOString();
      const iso = await t.queue(t.orchestrator, { message: "Later", at: ahead });
      expect(iso.json).toMatchObject({ status: "queued", scheduledFor: ahead });
      const clock = new Date(Date.now() + 2 * 3_600_000);
      const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
      const byClock = await t.queue(t.orchestrator, { message: "Later still", at: hhmm });
      expect(byClock.json).toMatchObject({ status: "queued", scheduledFor: parseScheduledTime(hhmm) });
      const refused = await t.queue(t.orchestrator, { message: "x", at: "whenever" });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("INVALID_THREAD_OPTION: at takes an ISO date-time or HH:MM.");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("puts conditions in the durable queue and waits for them, and refuses a delivery that would steer", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const other = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Busy", wait: false, threadEnvMode: "local" });
      const queued = await t.queue(t.orchestrator, { message: "After the other one", conditions: [{ type: "thread", threadId: other.threadId }] });
      expect(queued.json!.status).toBe("queued");
      expect(queued.json!.waitingFor).toEqual(expect.arrayContaining([expect.stringContaining("Waiting for")]));
      const entry = (await (await t.served()).readTurns(t.orchestrator)).find((turn) => turn.id === queued.json!.turnId)!;
      expect(entry.queue?.conditions).toEqual([{ type: "thread", threadId: other.threadId }]);
      expect((await t.connection.query({ type: "queue.read" })).entries.some((row) => row.turnId === entry.id)).toBe(true);
      for (const bad of [{ delivery: "steer" }, { conditions: [{ type: "nonsense" }] }]) {
        expect((await t.queue(t.orchestrator, { message: "x", ...bad })).isError).toBe(true);
      }
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("starts a turn at once on an idle task when nothing holds the message, and queues it when `at` is ahead", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      // A full turn round-trip, not a ledger write: allow it longer than
      // waitFor's one-second default (Windows runners are slower).
      await vi.waitFor(async () => expect((await t.store.readTurns(taskId)).every((turn) => turn.status === "completed")).toBe(true), { timeout: 10_000 });
      const held = await t.queue(t.orchestrator, { threadId: taskId, message: "Tomorrow", at: new Date(Date.now() + 3_600_000).toISOString() });
      expect(held.json).toMatchObject({ threadId: taskId, status: "queued", self: false });
      const now = await t.queue(t.orchestrator, { threadId: taskId, message: "Now" });
      expect(now.json).toMatchObject({ threadId: taskId, status: "running", self: false });
      expect(now.json!.expectedRun).toContain("now");
      const message = (await t.store.readMessages(taskId)).find((row) => row.id === now.json!.messageId)!;
      expect(message).toMatchObject({ origin: "agent-message" });
      expect(message.text).toContain("Message from the thread that delegated this task (not from the user):");
      await settleRuns();
    } finally {
      await t.connection.close();
    }
  }, 30_000);
});

describe("message_queue: taking back and changing what it queued", () => {
  it("lists only what this thread queued, then edits and removes it through the Work queue", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "Check the build\nthen the tests", conditions: [{ type: "at", at: new Date(Date.now() + 3_600_000).toISOString() }] });
      const listed = await callMoxenTool(t.connection, t.orchestrator, "message_queue_list", {});
      expect(listed.isError).toBe(false);
      const messages = JSON.parse(listed.text).messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ turnId: queued.json!.turnId, threadId: t.orchestrator, message: "Check the build\nthen the tests" });
      expect(messages[0]!.waitingFor).toEqual(expect.arrayContaining([expect.stringContaining("Thread is running")]));

      const edited = await callMoxenTool(t.connection, t.orchestrator, "message_queue_edit", {
        turnId: queued.json!.turnId,
        conditions: [{ type: "reset", provider: "claudeAgent", window: "session" }],
      });
      expect(edited.isError).toBe(false);
      const entry = (await t.connection.query({ type: "queue.read" })).entries.find((row) => row.turnId === queued.json!.turnId)!;
      expect(entry.policy.conditions).toEqual([expect.objectContaining({ type: "reset", provider: "claude", window: "session" })]);
      expect(entry.agentThreadId).toBe(t.orchestrator);

      const refused = await callMoxenTool(t.connection, t.orchestrator, "message_queue_edit", {
        turnId: queued.json!.turnId,
        conditions: [{ type: "thread", threadId: t.orchestrator }],
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("QUEUE_THREAD_SELF");
      expect(refused.text).toContain("after this turn");

      const removed = await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId: queued.json!.turnId });
      expect(removed.isError).toBe(false);
      expect((await t.connection.query({ type: "queue.read" })).entries.find((row) => row.turnId === queued.json!.turnId)?.policy.removed).toBe(true);
      expect(JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "message_queue_list", {})).text).messages).toEqual([]);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("never lists, edits or removes the user's entries or another agent's", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      // The user's own queued message, through the composer's queue command.
      const user = await t.connection.dispatch({ type: "thread.turn.start", threadId: t.orchestrator, message: { text: "from the user" }, delivery: "queue" });
      // Another agent queueing on its own running thread.
      const other = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Other agent", wait: false, threadEnvMode: "local" });
      const otherEntry = await t.queue(other.threadId, { message: "theirs", conditions: [{ type: "at", at: new Date(Date.now() + 3_600_000).toISOString() }] });
      expect(JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "message_queue_list", {})).text).messages).toEqual([]);

      for (const turnId of [user.turnId, otherEntry.json!.turnId]) {
        const edit = await callMoxenTool(t.connection, t.orchestrator, "message_queue_edit", { turnId, conditions: [] });
        expect(edit.isError).toBe(true);
        expect(edit.text).toContain("QUEUE_MESSAGE_NOT_YOURS");
        const remove = await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId });
        expect(remove.isError).toBe(true);
        expect(remove.text).toContain("QUEUE_MESSAGE_NOT_YOURS");
      }
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("refuses to take back a message that has already started", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await vi.waitFor(async () => expect((await t.store.readTurns(taskId)).every((turn) => turn.status === "completed")).toBe(true), { timeout: 10_000 });
      const started = await t.queue(t.orchestrator, { threadId: taskId, message: "run now" });
      expect(started.json).toMatchObject({ threadId: taskId, status: "running" });
      const removed = await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId: started.json!.turnId });
      expect(removed.isError).toBe(true);
      expect(removed.text).toContain("QUEUE_MESSAGE_NOT_WAITING");
      expect(removed.text).toContain("started");
      await settleRuns();
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("reaches a task it delegated, while another thread's list stays empty", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const queued = await t.queue(t.orchestrator, { threadId: taskId, message: "correct the task", conditions: [{ type: "at", at: new Date(Date.now() + 3_600_000).toISOString() }] });
      expect(queued.json).toMatchObject({ threadId: taskId, status: "queued" });
      const messages = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "message_queue_list", {})).text).messages as Array<Record<string, unknown>>;
      expect(messages.find((row) => row.turnId === queued.json!.turnId)).toMatchObject({ threadId: taskId, message: "correct the task" });
      expect((await callMoxenTool(t.connection, taskId, "message_queue_list", {})).isError).toBe(false);
      expect(JSON.parse((await callMoxenTool(t.connection, taskId, "message_queue_list", {})).text).messages).toEqual([]);
      expect((await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId: queued.json!.turnId })).isError).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 30_000);
});

describe("message_queue: a thread condition naming the calling thread", () => {
  it("is refused, because after this turn is already implied", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const refused = await t.queue(t.orchestrator, { message: "wait for myself", conditions: [{ type: "thread", threadId: t.orchestrator }] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("QUEUE_THREAD_SELF");
      expect(refused.text).toContain("after this turn");
      expect((await t.store.readTurns(t.orchestrator)).some((turn) => turn.agentThreadId === t.orchestrator)).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 30_000);
});

describe("message_queue: management races and transferred tasks", () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it("refuses a prototype provider key and keeps queue reads working (MXN-401)", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "still here", conditions: [{ type: "at", at: future() }] });
      const bad = await callMoxenTool(t.connection, t.orchestrator, "message_queue_edit", {
        turnId: queued.json!.turnId,
        conditions: [{ type: "usage", provider: "constructor", window: "session", minimum: 5 }],
      });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("INVALID_QUEUE");
      // A bad condition must never break the Work queue read.
      expect((await t.connection.query({ type: "queue.read" })).entries.some((entry) => entry.turnId === queued.json!.turnId)).toBe(true);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("keeps the user's hold and order when an agent edits conditions", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "edit me", conditions: [{ type: "at", at: future() }] });
      const turnId = queued.json!.turnId as string;
      await t.connection.dispatch({ type: "queue.edit", threadId: t.orchestrator, turnId, action: "hold" });
      await t.connection.dispatch({ type: "queue.edit", threadId: t.orchestrator, turnId, action: "last" });
      const orderAfterUser = (await t.connection.query({ type: "queue.read" })).entries.find((entry) => entry.turnId === turnId)!.policy.order;
      const edited = await callMoxenTool(t.connection, t.orchestrator, "message_queue_edit", {
        turnId,
        conditions: [{ type: "reset", provider: "claude", window: "session" }],
      });
      expect(edited.isError).toBe(false);
      const after = (await t.connection.query({ type: "queue.read" })).entries.find((entry) => entry.turnId === turnId)!;
      expect(after.policy.held).toBe(true);
      expect(after.policy.order).toBe(orderAfterUser);
      expect(after.policy.conditions).toEqual([expect.objectContaining({ type: "reset", provider: "claude", window: "session" })]);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("refuses a removal once the entry has failed", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "take me back", conditions: [{ type: "at", at: future() }] });
      const turnId = queued.json!.turnId as string;
      const store = await t.served();
      await store.withThreadLock(t.orchestrator, () => store.updateTurn(t.orchestrator, turnId, { status: "failed", error: "boom", completedAt: store.nowIso() }));
      const removed = await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId });
      expect(removed.isError).toBe(true);
      expect(removed.text).toContain("QUEUE_MESSAGE_STARTED");
      const turn = (await store.readTurns(t.orchestrator)).find((entry) => entry.id === turnId)!;
      expect(turn.status).toBe("failed");
      expect(turn.queue?.removed).not.toBe(true);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("records a before-start cancellation when an agent takes a waiting message back", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "never mind", conditions: [{ type: "at", at: future() }] });
      expect((await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId: queued.json!.turnId })).isError).toBe(false);
      const activities = await (await t.served()).readActivities(t.orchestrator);
      expect(activities.some((activity) => activity.kind === "turn.interrupted" && activity.turnId === queued.json!.turnId && (activity.payload as { beforeStart?: boolean } | undefined)?.beforeStart === true)).toBe(true);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("binds management to the authenticated MCP session, and fails closed without one", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const queued = await t.queue(t.orchestrator, { message: "manage me", conditions: [{ type: "at", at: future() }] });
      const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "message_queue_list", arguments: {} } };
      const authed = await answerMcp({ api: t.connection, parentThreadId: t.orchestrator, agentQueue: t.connection.agentQueue }, request) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(authed.result.isError).toBe(false);
      expect(JSON.parse(authed.result.content[0]!.text).messages.some((entry: { turnId: string }) => entry.turnId === queued.json!.turnId)).toBe(true);

      // The stdio route has no daemon credential here: --thread alone is not proof.
      const unauthenticated = {
        query: (query: Query) => t.connection.query(query),
        dispatch: (command: Command) => t.connection.dispatch(command),
      } as unknown as ClientApi;
      const denied = await answerMcp({ api: unauthenticated, parentThreadId: t.orchestrator }, request) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0]!.text).toContain("AGENT_QUEUE_AUTH_REQUIRED");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("takes management away from an old parent once the task transfers to a continuation", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const queued = await t.queue(t.orchestrator, { threadId: taskId, message: "after the reset", conditions: [{ type: "at", at: future() }] });
      const turnId = queued.json!.turnId as string;
      await t.settleRunningTurns();
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect(continued.threadId).not.toBe(t.orchestrator);

      const oldRemove = await callMoxenTool(t.connection, t.orchestrator, "message_queue_remove", { turnId });
      expect(oldRemove.isError).toBe(true);
      expect(oldRemove.text).toContain("QUEUE_MESSAGE_NOT_YOURS");
      expect(JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "message_queue_list", {})).text).messages).toEqual([]);

      // The continuation owns the task now and inherits its earlier entries.
      const listed = JSON.parse((await callMoxenTool(t.connection, continued.threadId, "message_queue_list", {})).text).messages as Array<Record<string, unknown>>;
      expect(listed.find((entry) => entry.turnId === turnId)).toMatchObject({ threadId: taskId, message: "after the reset" });
      expect((await callMoxenTool(t.connection, continued.threadId, "message_queue_remove", { turnId })).isError).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 45_000);
});

describe("message_queue: whose thread it is", () => {
  it("reaches only the caller's own thread and the tasks it delegated, continuations included", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      const before = (await t.store.readTurns(taskId)).length;
      for (const [from, target] of [[stranger.threadId, taskId], [t.orchestrator, stranger.threadId], [taskId, stranger.threadId], [t.orchestrator, "thread-that-does-not-exist"]] as const) {
        const refused = await t.queue(from, { message: "Take over", threadId: target });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("TASK_NOT_FOUND");
      }
      expect(await t.store.readTurns(taskId)).toHaveLength(before);

      expect((await t.queue(t.orchestrator, { message: "Carry on", threadId: taskId })).json).toMatchObject({ threadId: taskId, status: "queued", self: false });
      await t.settleRunningTurns();
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect((await t.queue(continued.threadId, { message: "Still mine", threadId: taskId })).json).toMatchObject({ threadId: taskId, self: false });
      expect((await t.queue(t.orchestrator, { message: "Old thread", threadId: taskId })).text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("is not offered to a delegated task, and refuses a research run's lead and roles", async () => {
    for (const name of ["message_queue", "message_queue_list", "message_queue_edit", "message_queue_remove"]) {
      expect(DELEGATION_TOOLS.has(name)).toBe(true);
      expect(moxenToolsFor({}).map((tool) => tool.name)).toContain(name);
      expect(moxenToolsFor({ delegated: true }).map((tool) => tool.name)).not.toContain(name);
    }
    const t = await setup();
    const unattended = t.connection.subscribeShell({ researchProposals: [t.orchestrator] }, () => {}, () => {});
    try {
      const proposed = callMoxenTool(t.connection, t.orchestrator, "delegate", {
        task: "Check the claim", title: "Evidence", mode: "research", isolation: "shared",
        researchProposal: { size: { researchers: 1, critics: 1 } },
      });
      await expect.poll(async () => (await t.connection.query({ type: "research.proposals", threadId: t.orchestrator })).length, WAIT).toBe(1);
      const [proposal] = await t.connection.query({ type: "research.proposals", threadId: t.orchestrator });
      await t.connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan: { size: { researchers: 1, critics: 1 } } });
      const leadId = JSON.parse((await proposed).text).taskId as string;
      const researcher = await t.connection.dispatch({ type: "research.role.start", leadThreadId: leadId, role: "researcher", question: "Evidence" });
      await expect.poll(async () => (await t.store.readTurns(leadId)).at(-1)?.status, WAIT).toBe("completed");

      expect((await t.queue(t.orchestrator, { message: "Skip the critic", threadId: leadId })).text).toContain("QUEUE_MESSAGE_RESEARCH");
      expect((await t.queue(leadId, { message: "Note to self" })).text).toContain("QUEUE_MESSAGE_RESEARCH");
      expect((await t.queue(leadId, { message: "Report now", threadId: researcher.child.id })).text).toContain("QUEUE_MESSAGE_RESEARCH");
      expect((await t.queue(t.orchestrator, { message: "Report now", threadId: researcher.child.id })).text).toContain("TASK_NOT_FOUND");
      for (const id of [leadId, researcher.child.id]) {
        expect((await t.store.readMessages(id)).some((message) => message.origin === "agent-message")).toBe(false);
      }
    } finally {
      unattended();
      await t.connection.close();
    }
  }, 30_000);

  it("keeps agent ownership and internal handoff wait when a continued thread moves a queued entry", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const queued = await t.queue(t.orchestrator, {
        message: "Follow up after the handoff",
        conditions: [{ type: "at", at: future }],
      });
      expect(queued.isError).toBe(false);

      await t.settleRunningTurns(t.orchestrator);
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      const destId = continued.threadId;

      const listed = await callMoxenTool(t.connection, destId, "message_queue_list", {});
      expect(listed.isError).toBe(false);
      const messages = (JSON.parse(listed.text) as { messages: Array<{ threadId: string; turnId: string; text: string }> }).messages;
      expect(messages).toHaveLength(1);
      const movedTurnId = messages[0]!.turnId;
      expect(messages[0]!.threadId).toBe(destId);

      // Editing conditions as the continuation preserves the internal serverWait on the handoff turn.
      const later = new Date(Date.now() + 7_200_000).toISOString();
      const edited = await callMoxenTool(t.connection, destId, "message_queue_edit", {
        turnId: movedTurnId,
        conditions: [{ type: "at", at: later }],
      });
      expect(edited.isError).toBe(false);
      const destTurns = await (await t.served()).readTurns(destId);
      const movedTurn = destTurns.find((candidate) => candidate.id === movedTurnId)!;
      expect(movedTurn.agentThreadId).toBe(t.orchestrator);
      expect(movedTurn.queue?.conditions).toEqual([
        { type: "at", at: later },
        expect.objectContaining({ type: "entry", threadId: destId, serverWait: true }),
      ]);

      // The continuation can also remove the moved entry cleanly.
      const removed = await callMoxenTool(t.connection, destId, "message_queue_remove", { turnId: movedTurnId });
      expect(removed.isError).toBe(false);
      const listedAfter = await callMoxenTool(t.connection, destId, "message_queue_list", {});
      expect((JSON.parse(listedAfter.text) as { messages: unknown[] }).messages).toEqual([]);
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

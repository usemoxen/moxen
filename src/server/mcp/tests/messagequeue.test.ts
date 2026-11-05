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
  return { harness, connection, store, served, orchestrator: orchestrator.threadId, delegate, queue };
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
      await vi.waitFor(async () => expect((await t.store.readTurns(taskId)).every((turn) => turn.status === "completed")).toBe(true));
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
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect((await t.queue(continued.threadId, { message: "Still mine", threadId: taskId })).json).toMatchObject({ threadId: taskId, self: false });
      expect((await t.queue(t.orchestrator, { message: "Old thread", threadId: taskId })).text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("is not offered to a delegated task, and refuses a research run's lead and roles", async () => {
    expect(DELEGATION_TOOLS.has("message_queue")).toBe(true);
    expect(moxenToolsFor({}).map((tool) => tool.name)).toContain("message_queue");
    expect(moxenToolsFor({ delegated: true }).map((tool) => tool.name)).not.toContain("message_queue");
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
});

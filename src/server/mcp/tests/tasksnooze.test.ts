/**
 * `task_snooze`, through the real tool handler (`callMoxenTool`), the real
 * server connection and the real store. The automatic wake runs the same core
 * pass the server's tick does (`wakeDueSnoozes`), against the same harness
 * store, so nothing here waits on a timer.
 */
import { describe, expect, it } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import type { TurnDriver } from "../../../core/threads/execute.js";
import { wakeDueSnoozes, runWorkQueue, type OperationContext } from "../../../core/threads/operations.js";
import { threadStatus } from "../../../core/threads/threads.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { parseScheduledTime } from "../../../core/threads/scheduledtime.js";
import { driverKindOfInstance } from "../../../core/types.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, DELEGATION_TOOLS, moxenToolsFor } from "../tools.js";

const WAIT = { timeout: 12_000 };

async function setup(options: TestHarnessOptions = {}) {
  const harness = await testHarness(options);
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: options.leaveTurnsRunning !== true, threadEnvMode: "local" });
  const store = await openThreadStore(harness.root);
  // The server's own context, as the tick builds it: the wake pass reads
  // configuration and usage the same way here.
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store,
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (id) => {
      const kind = driverKindOfInstance(id)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = harness.drivers[kind]!();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
  const delegate = async (title = "task") => {
    const result = await callMoxenTool(connection, orchestrator.threadId, "delegate", { task: "Do the work", title, isolation: "shared" });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).taskId as string;
  };
  const snooze = async (from: string, args: Record<string, unknown>) => {
    const result = await callMoxenTool(connection, from, "task_snooze", args);
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  return { harness, connection, store, ctx, orchestrator: orchestrator.threadId, delegate, snooze };
}

const statusOf = async (store: ThreadStore, threadId: string) => threadStatus((await store.readThreadRecord(threadId))!);
const waitForTurnDone = async (store: ThreadStore, taskId: string) =>
  await expect.poll(async () => (await store.readTurns(taskId)).at(-1)?.status, WAIT).toBe("completed");

describe("task_snooze", () => {
  it("is offered to orchestrators, not to delegated tasks", async () => {
    expect(DELEGATION_TOOLS.has("task_snooze")).toBe(true);
    const names = (options: Parameters<typeof moxenToolsFor>[0]) => moxenToolsFor(options).map((tool) => tool.name);
    expect(names({})).toContain("task_snooze");
    expect(names({ delegated: true })).not.toContain("task_snooze");
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const refused = await callMoxenTool(t.connection, taskId, "task_snooze", { taskId, at: new Date(Date.now() + 60_000).toISOString() }, { delegated: true });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("not available in a delegated task");
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("holds a task out of the active set to `at`, and past-due it reads active with no unsnooze", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const ahead = new Date(Date.now() + 3_600_000).toISOString();
      const snoozed = await t.snooze(t.orchestrator, { taskId, at: ahead });
      expect(snoozed.isError).toBe(false);
      expect(snoozed.json).toMatchObject({ taskId, snoozed: true, status: "snoozed", snoozedUntil: ahead, conditions: [], workStatus: "completed" });
      expect(snoozed.json!.wakes).toBe(`at ${ahead}`);
      expect(await statusOf(t.store, taskId)).toBe("snoozed");
      expect((await t.connection.query({ type: "thread.inspect", threadId: taskId })).thread.status).toBe("snoozed");
      expect((await t.connection.query({ type: "threads.list", status: "snoozed" })).threads.map((thread) => thread.id)).toContain(taskId);

      // HH:MM goes through the same reader `--at` and message_queue use.
      const clock = new Date(Date.now() + 2 * 3_600_000);
      const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
      const byClock = await t.snooze(t.orchestrator, { taskId, at: hhmm });
      expect(byClock.json).toMatchObject({ snoozedUntil: parseScheduledTime(hhmm) });

      // A past due mark needs nothing written: the same status rule the rest
      // of the app reads says active again.
      await t.connection.dispatch({ type: "thread.snooze", threadId: taskId, snoozedUntil: new Date(Date.now() - 1000).toISOString() });
      expect(await statusOf(t.store, taskId)).toBe("active");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("waits on conditions for as long as they hold, and wakes itself once they are met", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const other = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Busy work", wait: false, threadEnvMode: "local" });
      const snoozed = await t.snooze(t.orchestrator, { taskId, conditions: [{ type: "thread", threadId: other.threadId }] });
      expect(snoozed.isError).toBe(false);
      expect(snoozed.json).toMatchObject({ taskId, status: "snoozed", snoozedUntil: null, conditions: [{ type: "thread", threadId: other.threadId }] });
      expect(snoozed.json!.wakes).toBe("when its conditions are met");
      const record = (await t.store.readThreadRecord(taskId))!;
      expect(record.snoozedUntil).toBeNull();
      expect(record.snoozeConditions).toEqual([{ type: "thread", threadId: other.threadId }]);

      // The dependency is still working: the pass that wakes due snoozes leaves it alone.
      expect(await wakeDueSnoozes(t.ctx)).toEqual([]);
      expect(await statusOf(t.store, taskId)).toBe("snoozed");

      for (const turn of await t.store.readTurns(other.threadId)) {
        if (turn.status === "running" || turn.status === "queued") await t.connection.dispatch({ type: "thread.turn.interrupt", threadId: other.threadId });
      }
      const turnsBefore = await t.store.readTurns(taskId);
      expect(await wakeDueSnoozes(t.ctx)).toEqual([taskId]);
      expect(await statusOf(t.store, taskId)).toBe("active");
      expect((await t.store.readThreadRecord(taskId))!.snoozeConditions).toBeNull();
      // Nothing ran in the task: the wake is a lifecycle change, not a turn.
      expect(await t.store.readTurns(taskId)).toEqual(turnsBefore);
      // A second pass is a no-op.
      expect(await wakeDueSnoozes(t.ctx)).toEqual([]);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("holds queued messages behind the snooze, and releases them when it ends", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      await t.snooze(t.orchestrator, { taskId, at: new Date(Date.now() + 3_600_000).toISOString() });
      const queued = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "message_queue", { threadId: taskId, message: "Pick this up after the snooze" })).text) as Record<string, unknown>;
      expect(queued).toMatchObject({ threadId: taskId, status: "queued" });
      const blockedOf = async (turnId: unknown) =>
        (await t.connection.query({ type: "queue.read" })).entries.find((entry) => entry.turnId === turnId)?.blocked ?? [];
      expect(await blockedOf(queued.turnId)).toContain("Thread is not active");

      await t.connection.dispatch({ type: "thread.unsnooze", threadId: taskId });
      expect(await blockedOf(queued.turnId)).not.toContain("Thread is not active");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("does not hold a message the orchestrator sends: task_send on a snoozed task still starts its turn", async () => {
    // Pinned rather than intended-sounding: the snooze holds queued work, and
    // a direct message is an act of the orchestrator, like the user typing.
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      await t.snooze(t.orchestrator, { taskId, at: new Date(Date.now() + 3_600_000).toISOString() });
      const sent = await callMoxenTool(t.connection, t.orchestrator, "task_send", { taskId, message: "One more thing", wake: true });
      expect(sent.isError).toBe(false);
      expect(JSON.parse(sent.text)).toMatchObject({ taskId, outcome: "started", woke: true });
      await expect.poll(async () => (await t.store.readTurns(taskId)).filter((turn) => turn.status === "running").length, WAIT).toBe(1);
      // The snooze is untouched by it and still ends on its own time.
      expect((await t.store.readThreadRecord(taskId))!.snoozedUntil).not.toBeNull();
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("runs a direct task_send at once past a message the snooze holds, and leaves that message held", async () => {
    // The snooze hold is its own hold, not the oldest-first hold a plain
    // settle leaves: a direct send must not queue behind the snoozed
    // message_queue entry, run it, or fold it into its own turn.
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      await t.snooze(t.orchestrator, { taskId, at: new Date(Date.now() + 3_600_000).toISOString() });
      const queued = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "message_queue", { threadId: taskId, message: "Pick this up after the snooze" })).text) as Record<string, unknown>;
      expect(queued).toMatchObject({ threadId: taskId, status: "queued" });
      const sent = await callMoxenTool(t.connection, t.orchestrator, "task_send", { taskId, message: "One more thing", wake: true });
      expect(JSON.parse(sent.text)).toMatchObject({ taskId, outcome: "started", woke: true });
      await waitForTurnDone(t.store, taskId);
      // The snoozed message waited through that whole turn, held for the
      // snooze — not batched into it, not released by it.
      const held = (await t.store.readTurns(taskId)).find((turn) => turn.id === queued.turnId)!;
      expect(held).toMatchObject({ status: "queued", heldBySnooze: true });
      expect(held.heldAtSettle).toBeUndefined();
      // Exactly the snoozed message stayed on the held turn: the direct
      // send's turn neither folded it in nor left it a copy of its own.
      const messages = await t.store.readMessages(taskId);
      const heldMessages = messages.filter((message) => message.turnId === held.id);
      expect(heldMessages).toHaveLength(1);
      expect(heldMessages[0]!.text).toContain("Pick this up after the snooze");
      // Nothing was lost by running past it: once the snooze ends, the
      // admission pass starts the held message on its own.
      await t.connection.dispatch({ type: "thread.unsnooze", threadId: taskId });
      await runWorkQueue(t.ctx);
      expect(await t.store.readTurns(taskId)).not.toContainEqual(expect.objectContaining({ id: held.id, status: "queued" }));
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("waits for both the time and the conditions when it is given both", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const other = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Finished elsewhere", wait: true, threadEnvMode: "local" });
      const ahead = new Date(Date.now() + 3_600_000).toISOString();
      // The condition is met (the other thread has nothing left) and the clock is not.
      const snoozed = await t.snooze(t.orchestrator, { taskId, at: ahead, conditions: [{ type: "thread", threadId: other.threadId }] });
      expect(snoozed.json).toMatchObject({ status: "snoozed", snoozedUntil: ahead });
      expect(snoozed.json!.wakes).toBe(`at ${ahead} at the earliest, once its conditions are met`);
      expect(await wakeDueSnoozes(t.ctx)).toEqual([]);
      expect(await statusOf(t.store, taskId)).toBe("snoozed");
      // The clock is the only gate left, and a past-due time needs no pass.
      await t.connection.dispatch({ type: "thread.snooze", threadId: taskId, snoozedUntil: new Date(Date.now() - 1000).toISOString() });
      expect(await statusOf(t.store, taskId)).toBe("active");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("shows the snooze in task_status beside the work status, and a condition snooze with no time", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const other = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Busy", wait: false, threadEnvMode: "local" });
      const conditions = [{ type: "thread", threadId: other.threadId }];
      await t.snooze(t.orchestrator, { taskId, conditions });
      const status = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "task_status", { taskId, waitMs: 0 })).text) as Record<string, unknown>;
      // The work status is the task's own last turn; the snooze is lifecycle, kept apart from it.
      expect(status).toMatchObject({ taskId, status: "completed", finished: true, snoozed: { until: null, conditions } });
      await t.connection.dispatch({ type: "thread.unsnooze", threadId: taskId });
      const awake = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "task_status", { taskId, waitMs: 0 })).text) as Record<string, unknown>;
      expect(awake).not.toHaveProperty("snoozed");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("refuses a snooze with nothing to wait for, a malformed condition, a bad time, and a settled task", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const nothing = await t.snooze(t.orchestrator, { taskId });
      expect(nothing.isError).toBe(true);
      expect(nothing.text).toContain("INVALID_TOOL_INPUT");
      for (const conditions of [[{ type: "nonsense" }], [{ type: "entry", threadId: taskId }]]) {
        const badCondition = await t.snooze(t.orchestrator, { taskId, conditions });
        expect(badCondition.isError).toBe(true);
        expect(badCondition.text).toContain("INVALID_QUEUE");
      }
      const badTime = await t.snooze(t.orchestrator, { taskId, at: "whenever" });
      expect(badTime.isError).toBe(true);
      expect(badTime.text).toContain("at takes an ISO date-time or HH:MM.");
      expect(await statusOf(t.store, taskId)).toBe("active");

      await callMoxenTool(t.connection, t.orchestrator, "task_settle", { taskId });
      const settled = await t.snooze(t.orchestrator, { taskId, at: new Date(Date.now() + 60_000).toISOString() });
      expect(settled.isError).toBe(true);
      expect(settled.text).toContain("TASK_SETTLED");
      expect(settled.text).toContain("task_unsettle");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("reaches only the caller's own tasks: a stranger, another thread's task, a deleted task and a research run", async () => {
    const t = await setup();
    const unattended = t.connection.subscribeShell({ researchProposals: [t.orchestrator] }, () => {}, () => {});
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const ahead = new Date(Date.now() + 60_000).toISOString();
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      for (const from of [stranger.threadId, taskId]) {
        const refused = await t.snooze(from, { taskId, at: ahead });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("TASK_NOT_FOUND");
      }
      expect((await t.snooze(t.orchestrator, { taskId: "task-that-does-not-exist", at: ahead })).text).toContain("TASK_NOT_FOUND");
      expect(await statusOf(t.store, taskId)).toBe("active");

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
      expect((await t.snooze(t.orchestrator, { taskId: leadId, at: ahead })).text).toContain("TASK_SNOOZE_RESEARCH");
      expect((await t.snooze(t.orchestrator, { taskId: researcher.child.id, at: ahead })).text).toContain("TASK_NOT_FOUND");

      await t.connection.dispatch({ type: "thread.delete", threadId: taskId });
      expect((await t.snooze(t.orchestrator, { taskId, at: ahead })).text).toContain("TASK_NOT_FOUND");
    } finally {
      unattended();
      await t.connection.close();
    }
  }, 30_000);
});

/**
 * `task_unsettle`, through the real tool handler (`callMoxenTool`), the real
 * server connection and the real store: nothing here hand-builds a delegation
 * row, a settle or a result.
 */
import { describe, expect, it } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { threadStatus } from "../../../core/threads/threads.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, DELEGATION_TOOLS, moxenToolsFor } from "../tools.js";

const WAIT = { timeout: 12_000 };

async function setup(options: TestHarnessOptions = {}) {
  const harness = await testHarness(options);
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: options.leaveTurnsRunning !== true, threadEnvMode: "local" });
  const store = await openThreadStore(harness.root);
  const delegate = async (title = "task") => {
    const result = await callMoxenTool(connection, orchestrator.threadId, "delegate", { task: "Do the work", title, isolation: "shared" });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).taskId as string;
  };
  const settle = async (from: string, taskId: string) => {
    const result = await callMoxenTool(connection, from, "task_settle", { taskId });
    expect(result.text).not.toContain("error");
    return result;
  };
  const unsettle = async (from: string, args: Record<string, unknown>) => {
    const result = await callMoxenTool(connection, from, "task_unsettle", args);
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  return { harness, connection, store, orchestrator: orchestrator.threadId, delegate, settle, unsettle };
}

/** The child's turn is done, so settling needs no `stop`. */
async function waitForTurnDone(store: ThreadStore, taskId: string) {
  await expect.poll(async () => (await store.readTurns(taskId)).at(-1)?.status, WAIT).toBe("completed");
}

const statusOf = async (store: ThreadStore, threadId: string) => threadStatus((await store.readThreadRecord(threadId))!);

/** A settled task, ready to reopen. */
async function settledTask(t: Awaited<ReturnType<typeof setup>>) {
  const taskId = await t.delegate();
  await waitForTurnDone(t.store, taskId);
  await t.settle(t.orchestrator, taskId);
  expect(await statusOf(t.store, taskId)).toBe("settled");
  return taskId;
}

describe("task_unsettle", () => {
  it("is offered to orchestrators, not to delegated tasks", async () => {
    expect(DELEGATION_TOOLS.has("task_unsettle")).toBe(true);
    const names = (options: Parameters<typeof moxenToolsFor>[0]) => moxenToolsFor(options).map((tool) => tool.name);
    expect(names({})).toContain("task_unsettle");
    expect(names({ delegated: true })).not.toContain("task_unsettle");
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const refused = await callMoxenTool(t.connection, taskId, "task_unsettle", { taskId }, { delegated: true });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("not available in a delegated task");
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("reopens a settled task without starting a turn, and leaves its siblings settled", async () => {
    const t = await setup();
    try {
      const taskId = await settledTask(t);
      // A sibling the same orchestrator settled: unsettling one task never
      // reaches across to another, only down to the task's own delegated work.
      const sibling = await t.delegate("sibling");
      await waitForTurnDone(t.store, sibling);
      await t.settle(t.orchestrator, sibling);
      const before = await t.store.readTurns(taskId);

      const unsettled = await t.unsettle(t.orchestrator, { taskId });
      expect(unsettled.isError).toBe(false);
      expect(unsettled.json).toMatchObject({ taskId, unsettled: true, status: "active", workStatus: "completed", startedTurn: false });
      expect(await statusOf(t.store, taskId)).toBe("active");
      expect(await statusOf(t.store, sibling)).toBe("settled");
      const record = (await t.store.readThreadRecord(taskId))!;
      expect(record.settledAt).toBeNull();
      expect(record.settledOverride).toBe("active");
      // No turn was started: the task's turns are exactly what they were, and
      // no message arrived in it.
      expect(await t.store.readTurns(taskId)).toEqual(before);
      expect((await t.store.readMessages(taskId)).filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("refuses an active task and a snoozed one, and changes nothing", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const active = await t.unsettle(t.orchestrator, { taskId });
      expect(active.isError).toBe(true);
      expect(active.text).toContain("TASK_NOT_SETTLED");
      expect(active.text).toContain("active, not settled");

      await t.connection.dispatch({ type: "thread.snooze", threadId: taskId, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
      const snoozed = await t.unsettle(t.orchestrator, { taskId });
      expect(snoozed.isError).toBe(true);
      expect(snoozed.text).toContain("TASK_NOT_SETTLED");
      expect(snoozed.text).toContain("snoozed, not settled");
      const record = (await t.store.readThreadRecord(taskId))!;
      expect(record.settledAt).toBeNull();
      expect(record.snoozedUntil).not.toBeNull();
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("reaches only the caller's own tasks: a stranger, another thread's task and a deleted task all read TASK_NOT_FOUND", async () => {
    const t = await setup();
    try {
      const taskId = await settledTask(t);
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      const before = (await t.store.readThreadRecord(taskId))!;
      for (const from of [stranger.threadId, taskId]) {
        const refused = await t.unsettle(from, { taskId });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("TASK_NOT_FOUND");
      }
      expect((await t.store.readThreadRecord(taskId))!.settledAt).toBe(before.settledAt);

      await t.connection.dispatch({ type: "thread.delete", threadId: taskId });
      const deleted = await t.unsettle(t.orchestrator, { taskId });
      expect(deleted.text).toContain("TASK_NOT_FOUND");
      const missing = await t.unsettle(t.orchestrator, { taskId: "task-that-does-not-exist" });
      expect(missing.text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("does not advise sending work to a task whose worktree checkout is gone", async () => {
    const t = await setup();
    try {
      // A task with its own checkout that never committed settles with that
      // checkout removed, so its directory is gone: `task_send` refuses it, and
      // the advice must say so instead. Shared isolation has no checkout, so
      // this task is delegated without it.
      const delegated = await callMoxenTool(t.connection, t.orchestrator, "delegate", { task: "Do the work", title: "checkout" });
      const taskId = JSON.parse(delegated.text).taskId as string;
      await waitForTurnDone(t.store, taskId);
      const settled = await callMoxenTool(t.connection, t.orchestrator, "task_settle", { taskId, removeWorktree: true });
      expect(JSON.parse(settled.text)).toMatchObject({ settled: true, worktreeRemoved: true });
      const unsettled = await t.unsettle(t.orchestrator, { taskId });
      expect(unsettled.isError).toBe(false);
      expect(unsettled.json).toMatchObject({ taskId, unsettled: true, status: "active", worktreeRemoved: true });
      // Not the "send it work" advice an active task gets: sending is refused.
      expect(unsettled.json!.next).not.toMatch(/Send it work/);
      expect(unsettled.json!.next).toContain("re-delegate");
      expect((await callMoxenTool(t.connection, t.orchestrator, "task_send", { taskId, message: "One more thing", wake: true })).text).toContain("TASK_WORKTREE_REMOVED");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("refuses a research run's lead and roles, which go through the run", async () => {
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

      // The lead is a task the orchestrator delegated, so ownership alone would
      // pass: the run's own rule is what refuses it.
      expect((await t.unsettle(t.orchestrator, { taskId: leadId })).text).toContain("TASK_UNSETTLE_RESEARCH");
      // A role has no delegation row at all: the same refusal a fake id gets.
      expect((await t.unsettle(t.orchestrator, { taskId: researcher.child.id })).text).toContain("TASK_NOT_FOUND");
      expect((await t.store.readThreadRecord(leadId))!.settledAt).toBeNull();
    } finally {
      unattended();
      await t.connection.close();
    }
  }, 30_000);
});

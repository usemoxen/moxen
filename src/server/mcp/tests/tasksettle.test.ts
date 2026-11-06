/**
 * `task_settle`, through the real tool handler (`callMoxenTool`), the real
 * server connection and the real store: nothing here hand-builds a delegation
 * row or a result. The removal checks run against real temporary git repos —
 * the harness workdir and the worktrees `delegate` provisions in it.
 */
import { existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { runProcess } from "../../../core/infra/process.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, DELEGATION_TOOLS, moxenToolsFor } from "../tools.js";

const WAIT = { timeout: 12_000 };

async function setup(options: TestHarnessOptions = {}) {
  const stoppedSessions: string[] = [];
  const harness = await testHarness({ ...options, onStopSession: (threadId) => stoppedSessions.push(threadId) });
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: options.leaveTurnsRunning !== true, threadEnvMode: "local" });
  const store = await openThreadStore(harness.root);
  const delegate = async (title = "task", isolation?: "shared") => {
    const result = await callMoxenTool(connection, orchestrator.threadId, "delegate", {
      task: "Do the work", title, ...(isolation === undefined ? {} : { isolation }),
    });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).taskId as string;
  };
  const settle = async (from: string, args: Record<string, unknown>) => {
    const result = await callMoxenTool(connection, from, "task_settle", args);
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  return { harness, connection, store, orchestrator: orchestrator.threadId, delegate, settle, stoppedSessions };
}

/** The child's turn is done, so settling needs no `stop`. */
async function waitForTurnDone(store: ThreadStore, taskId: string) {
  await expect.poll(async () => (await store.readTurns(taskId)).at(-1)?.status, WAIT).toBe("completed");
}

const worktreeOf = async (store: ThreadStore, taskId: string) => (await store.readThreadRecord(taskId))?.env.path ?? "";

async function commitIn(dir: string, message: string) {
  const result = await runProcess("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-m", message], { cwd: dir });
  expect(result.exitCode).toBe(0);
}

async function branchList(repo: string, branch: string) {
  return (await runProcess("git", ["branch", "--list", branch], { cwd: repo })).stdout;
}

describe("task_settle", () => {
  it("is offered to orchestrators, not to delegated tasks", async () => {
    expect(DELEGATION_TOOLS.has("task_settle")).toBe(true);
    const names = (options: Parameters<typeof moxenToolsFor>[0]) => moxenToolsFor(options).map((tool) => tool.name);
    expect(names({})).toContain("task_settle");
    expect(names({ delegated: true })).not.toContain("task_settle");
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const refused = await callMoxenTool(t.connection, taskId, "task_settle", { taskId }, { delegated: true });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("not available in a delegated task");
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("settles a finished task without stopping anything", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const settled = await t.settle(t.orchestrator, { taskId });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, status: "completed", stopped: false });
      expect(settled.json).not.toHaveProperty("worktreeRemoved");
      expect((await t.store.readThreadRecord(taskId))?.settledAt).not.toBeNull();
    } finally {
      await t.connection.close();
    }
  });

  it("refuses a running task without stop, and ends it with stop", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const refused = await t.settle(t.orchestrator, { taskId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("THREAD_SETTLE_BLOCKED");
      expect((await t.store.readThreadRecord(taskId))?.settledAt).toBeNull();

      const settled = await t.settle(t.orchestrator, { taskId, stop: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, status: "interrupted", stopped: true });
      expect((await t.store.readThreadRecord(taskId))?.settledAt).not.toBeNull();
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("refuses a thread that did not delegate the task, and leaves the task alone", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      const refused = await t.settle(stranger.threadId, { taskId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("TASK_NOT_FOUND");
      // A thread that is not a task of anyone's gets the same answer as an id that does not exist.
      const other = await t.settle(t.orchestrator, { taskId: stranger.threadId });
      expect(other.isError).toBe(true);
      expect(other.text).toContain("TASK_NOT_FOUND");
      expect((await t.store.readThreadRecord(taskId))?.settledAt).toBeNull();
    } finally {
      await t.connection.close();
    }
  });

  it("after the orchestrator continues, only the continuation settles the task", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect((await t.settle(t.orchestrator, { taskId })).text).toContain("TASK_NOT_FOUND");
      const settled = await t.settle(continued.threadId, { taskId, stop: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, stopped: true });
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("after the orchestrator continues, a finished task settles from the continuation and no longer from the old thread", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect((await t.settle(t.orchestrator, { taskId })).text).toContain("TASK_NOT_FOUND");
      const settled = await t.settle(continued.threadId, { taskId });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, status: "completed", stopped: false });
    } finally {
      await t.connection.close();
    }
  });

  it("settles several tasks at once, reporting each outcome without stopping on a bad id", async () => {
    const t = await setup();
    try {
      const first = await t.delegate("first");
      const second = await t.delegate("second");
      await waitForTurnDone(t.store, first);
      await waitForTurnDone(t.store, second);
      const result = await t.settle(t.orchestrator, { taskIds: [first, "task-missing", second] });
      expect(result.isError).toBe(false);
      const tasks = result.json!["tasks"] as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(3);
      expect(tasks[0]).toMatchObject({ taskId: first, settled: true });
      expect(tasks[1]).toMatchObject({ taskId: "task-missing", error: expect.stringContaining("TASK_NOT_FOUND") });
      expect(tasks[2]).toMatchObject({ taskId: second, settled: true });
    } finally {
      await t.connection.close();
    }
  });

  it("refuses a task_settle that mixes or omits the id forms, or passes a non-boolean flag", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await waitForTurnDone(t.store, taskId);
      const call = (args: Record<string, unknown>) => t.settle(t.orchestrator, args);
      expect((await call({ taskId, taskIds: [taskId] })).text).toContain("not both");
      expect((await call({})).text).toContain("taskId");
      expect((await call({ taskIds: [] })).text).toContain("non-empty array");
      expect((await call({ taskId, stop: "yes" })).text).toContain("stop must be true or false");
      expect((await call({ taskId, removeWorktree: "yes" })).text).toContain("removeWorktree must be true or false");
      for (const reply of [await call({}), await call({ taskIds: [] })]) expect(reply.isError).toBe(true);
    } finally {
      await t.connection.close();
    }
  });
});

describe("task_settle with removeWorktree", () => {
  it("keeps a shared checkout: there is no worktree of its own to remove", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate("reader", "shared");
      await waitForTurnDone(t.store, taskId);
      const settled = await t.settle(t.orchestrator, { taskId, removeWorktree: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, worktreeRemoved: false });
      expect(settled.json!["worktreeReason"]).toMatch(/no worktree|shares a checkout/);
    } finally {
      await t.connection.close();
    }
  });

  it("refuses a dirty checkout, and settling still happened", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate("dirty");
      await waitForTurnDone(t.store, taskId);
      const dir = await worktreeOf(t.store, taskId);
      expect(existsSync(dir)).toBe(true);
      await appendFile(path.join(dir, ".gitkeep"), "more");
      await writeFile(path.join(dir, "notes.txt"), "uncommitted");
      const settled = await t.settle(t.orchestrator, { taskId, removeWorktree: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, worktreeRemoved: false });
      expect(settled.json!["worktreeReason"]).toMatch(/uncommitted or untracked/);
      expect(existsSync(dir)).toBe(true);
      expect((await t.store.readThreadRecord(taskId))?.settledAt).not.toBeNull();
    } finally {
      await t.connection.close();
    }
  });

  it("refuses an unmerged branch, keeping the checkout and the branch", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate("unmerged");
      await waitForTurnDone(t.store, taskId);
      const dir = await worktreeOf(t.store, taskId);
      const branch = (await t.store.readThreadRecord(taskId))?.env.branch ?? "";
      await writeFile(path.join(dir, "feature.txt"), "work");
      await runProcess("git", ["add", "-A"], { cwd: dir });
      await commitIn(dir, "feature");
      const settled = await t.settle(t.orchestrator, { taskId, removeWorktree: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, worktreeRemoved: false });
      expect(settled.json!["worktreeReason"]).toMatch(/1 commit.*not in main/);
      expect(existsSync(dir)).toBe(true);
      expect(await branchList(t.harness.work, branch)).toContain(branch);
    } finally {
      await t.connection.close();
    }
  });

  it("removes the checkout once the branch squash-merged, and keeps the branch", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate("merged");
      await waitForTurnDone(t.store, taskId);
      const dir = await worktreeOf(t.store, taskId);
      const branch = (await t.store.readThreadRecord(taskId))?.env.branch ?? "";
      await writeFile(path.join(dir, "feature.txt"), "work");
      await runProcess("git", ["add", "-A"], { cwd: dir });
      await commitIn(dir, "feature");
      await runProcess("git", ["merge", "--squash", branch], { cwd: t.harness.work });
      await commitIn(t.harness.work, "squash-merge feature");
      const settled = await t.settle(t.orchestrator, { taskId, removeWorktree: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, worktreeRemoved: true });
      expect(existsSync(dir)).toBe(false);
      expect(await branchList(t.harness.work, branch)).toContain(branch);
      expect(t.stoppedSessions).toContain(taskId);
    } finally {
      await t.connection.close();
    }
  });

  it("removes the checkout when the task never committed", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate("clean");
      await waitForTurnDone(t.store, taskId);
      const dir = await worktreeOf(t.store, taskId);
      const settled = await t.settle(t.orchestrator, { taskId, removeWorktree: true });
      expect(settled.isError).toBe(false);
      expect(settled.json).toMatchObject({ taskId, settled: true, worktreeRemoved: true });
      expect(existsSync(dir)).toBe(false);
    } finally {
      await t.connection.close();
    }
  });

  it("waking a task whose worktree was removed fails plainly instead of starting a turn in a missing directory", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate("gone");
      await waitForTurnDone(t.store, taskId);
      const settled = await t.settle(t.orchestrator, { taskId, removeWorktree: true });
      expect(settled.json).toMatchObject({ settled: true, worktreeRemoved: true });
      for (const wake of [true, false]) {
        const sent = await callMoxenTool(t.connection, t.orchestrator, "task_send", { taskId, message: "One more thing", ...(wake ? { wake: true } : {}) });
        expect(sent.isError).toBe(true);
        expect(sent.text).toContain("TASK_WORKTREE_REMOVED");
      }
      expect((await t.store.readTurns(taskId))).toHaveLength(1);
    } finally {
      await t.connection.close();
    }
  });
});

/**
 * `task_ask`, through the real tool handler (`callMoxenTool`), the real
 * server connection and the real store. The fake drivers answer a side
 * question only where a test gives them one, as the real ones do; the rest
 * have none and report `SIDE_QUESTION_UNSUPPORTED`.
 */
import { describe, expect, it, vi } from "vitest";

import type { SideQuestionInput } from "../../../core/providers/spi.js";
import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, DELEGATION_TOOLS, moxenToolsFor } from "../tools.js";

async function setup(options: TestHarnessOptions = {}) {
  const harness = await testHarness(options);
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: options.leaveTurnsRunning !== true, threadEnvMode: "local" });
  const store = await openThreadStore(harness.root);
  const delegate = async (provider?: string, title = "task") => {
    const result = await callMoxenTool(connection, orchestrator.threadId, "delegate", {
      task: "Do the work", title, isolation: "shared", ...(provider ? { provider, model: "gpt-5.4" } : {}),
    });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).taskId as string;
  };
  const ask = async (from: string, taskId: string, question = "How is it going?", askTimeoutMs?: number) => {
    const result = await callMoxenTool(connection, from, "task_ask", { taskId, question }, askTimeoutMs === undefined ? {} : { askTimeoutMs });
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  return { harness, connection, store, orchestrator: orchestrator.threadId, delegate, ask };
}

/** The task's thread as `task_ask` must leave it: its messages, its turns, its activity ledger. */
async function snapshot(store: ThreadStore, threadId: string) {
  return {
    messages: await store.readMessages(threadId),
    turns: await store.readTurns(threadId),
    activities: await store.readActivities(threadId),
  };
}

describe("task_ask: the answer", () => {
  it("comes from the task's own session, and leaves the running task's messages, turns and activity unchanged", async () => {
    let taskId = "";
    let during: Awaited<ReturnType<typeof snapshot>> | null = null;
    const asked: SideQuestionInput[] = [];
    const t = await setup({
      leaveTurnsRunning: true,
      sideQuestions: {
        opencode: async (input) => {
          asked.push(input);
          during = await snapshot(t.store, taskId);
          return { text: "Still on step two of three.", withContext: true };
        },
      },
    });
    try {
      taskId = await t.delegate();
      // A second read after the provider answered: nothing may have moved.
      const answer = await t.ask(t.orchestrator, taskId, "How is it going?");
      expect(answer.isError).toBe(false);
      expect(answer.json).toMatchObject({
        taskId,
        status: "running",
        answer: "Still on step two of three.",
        withContext: true,
        provider: "opencode",
      });
      expect(String(answer.json!.note)).toContain("with no tools");
      // It asked about the task's session, not the orchestrator's conversation.
      expect(asked).toEqual([expect.objectContaining({ cursor: `harness-session-${taskId}`, question: "How is it going?" })]);
      expect(during).not.toBeNull();
      expect(await snapshot(t.store, taskId)).toEqual(during);
      expect((await t.store.readMessages(taskId)).some((message) => message.text.includes("How is it going?"))).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("says when the task had no session to answer from, instead of pretending the answer is about it", async () => {
    const t = await setup({
      leaveTurnsRunning: true,
      sideQuestions: { opencode: async () => ({ text: "I cannot see a conversation.", withContext: false }) },
    });
    try {
      const taskId = await t.delegate();
      const answer = await t.ask(t.orchestrator, taskId);
      expect(answer.isError).toBe(false);
      expect(answer.json).toMatchObject({ withContext: false });
      expect(String(answer.json!.note)).toContain("no session");
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("still answers about a finished task", async () => {
    const t = await setup({ sideQuestions: { opencode: async () => ({ text: "It finished the work.", withContext: true }) } });
    try {
      const taskId = await t.delegate();
      await vi.waitFor(async () => expect((await t.store.readTurns(taskId)).every((turn) => turn.status === "completed")).toBe(true), { timeout: 8_000 });
      const answer = await t.ask(t.orchestrator, taskId, "What did you do?");
      expect(answer.json).toMatchObject({ taskId, status: "completed", answer: "It finished the work." });
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

describe("task_ask: whose task it is", () => {
  it("refuses a thread that did not delegate the task, without asking anyone", async () => {
    const asked: SideQuestionInput[] = [];
    const t = await setup({ leaveTurnsRunning: true, sideQuestions: { opencode: async (input) => { asked.push(input); return { text: "answer", withContext: true }; } } });
    try {
      const taskId = await t.delegate();
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      const refused = await t.ask(stranger.threadId, taskId);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("TASK_NOT_FOUND");
      expect(asked).toEqual([]);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("is still reachable from the parent's continuation, and no longer from the parent", async () => {
    const t = await setup({ leaveTurnsRunning: true, sideQuestions: { opencode: async () => ({ text: "yes", withContext: true }) } });
    try {
      const taskId = await t.delegate();
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect((await t.ask(continued.threadId, taskId)).isError).toBe(false);
      expect((await t.ask(t.orchestrator, taskId)).text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

describe("task_ask: what it cannot do", () => {
  it("returns SIDE_QUESTION_UNSUPPORTED as a plain result, not a failed call", async () => {
    // No sideQuestions given: the fake provider cannot copy a session, like a real one that cannot.
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const answer = await t.ask(t.orchestrator, taskId);
      expect(answer.isError).toBe(false);
      expect(answer.json).toMatchObject({ taskId, supported: false, code: "SIDE_QUESTION_UNSUPPORTED", provider: "opencode" });
      expect(String(answer.json!.next)).toContain("thread_read");
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("returns a clear timed-out result instead of waiting forever", async () => {
    let finished = false;
    const t = await setup({
      leaveTurnsRunning: true,
      sideQuestions: {
        opencode: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          finished = true;
          return { text: "too late", withContext: true };
        },
      },
    });
    try {
      const taskId = await t.delegate();
      const answer = await t.ask(t.orchestrator, taskId, "How is it going?", 25);
      expect(answer.isError).toBe(false);
      expect(answer.json).toMatchObject({ taskId, timedOut: true });
      expect(String(answer.json!.note)).toContain("still working");
      expect(String(answer.json!.note)).toContain("task_status");
      // The work it gave up waiting for still finishes on its own: the task is untouched.
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5_000 });
      expect((await t.store.readTurns(taskId)).map((turn) => turn.status)).toEqual(["running"]);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("is not offered to a delegated task, and refused when called anyway", async () => {
    expect(DELEGATION_TOOLS.has("task_ask")).toBe(true);
    const names = (options: Parameters<typeof moxenToolsFor>[0]) => moxenToolsFor(options).map((tool) => tool.name);
    expect(names({})).toContain("task_ask");
    expect(names({ delegated: true })).not.toContain("task_ask");
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const refused = await callMoxenTool(t.connection, taskId, "task_ask", { taskId, question: "How is it going?" }, { delegated: true });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("not available in a delegated task");
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

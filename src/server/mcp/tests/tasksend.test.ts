/**
 * `task_send`, through the real tool handler (`callMoxenTool`), the real server connection and the
 * real store: nothing here hand-builds a delegation row or a result. The only fakes are the
 * provider drivers (`testHarness`), which differ from the real ones in exactly one way a test can
 * choose: whether the driver has `steerTurn` and whether it succeeds.
 */
import { describe, expect, it, vi } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { TASK_NOTIFICATION_BATCH_MS } from "../../../core/threads/operations.js";
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
  const delegate = async (provider?: string, title = "task") => {
    const result = await callMoxenTool(connection, orchestrator.threadId, "delegate", {
      task: "Do the work", title, isolation: "shared", ...(provider ? { provider, model: "gpt-5.4" } : {}),
    });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).taskId as string;
  };
  const send = async (from: string, taskId: string, message: string, wake?: boolean) => {
    const result = await callMoxenTool(connection, from, "task_send", { taskId, message, ...(wake === undefined ? {} : { wake }) });
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  const notifications = async (threadId = orchestrator.threadId) =>
    (await store.readMessages(threadId)).filter((message) => message.origin === "task-notification");
  return { harness, connection, store, orchestrator: orchestrator.threadId, delegate, send, notifications };
}

describe("task_send: what happened to the message, per provider", () => {
  // The outcome is read from what the running provider turn returned, not from which provider it is.
  const PROVIDERS = ["claude", "codex", "opencode", "harness"] as const;

  it.each(PROVIDERS)("%s: steered when its driver takes the steer, queued when it has no mid-turn input, not_delivered when the steer fails", async (provider) => {
    const steered: string[] = [];
    for (const [steering, expected] of [["delivers", "steered"], [undefined, "queued"], ["fails", "not_delivered"]] as const) {
      const t = await setup({ leaveTurnsRunning: true, onSteer: (_thread, text) => steered.push(text), ...(steering ? { steering: { [provider]: steering } } : {}) });
      try {
        const taskId = await t.delegate(provider);
        const sent = await t.send(t.orchestrator, taskId, "Use the v2 endpoint");
        expect(sent.isError).toBe(false);
        expect(sent.json).toMatchObject({ taskId, outcome: expected, status: "running", woke: false });
        const turns = await t.store.readTurns(taskId);
        // Queued is a turn of its own that waits; steered and not_delivered land on the running one.
        expect(turns.map((turn) => turn.status)).toEqual(expected === "queued" ? ["running", "queued"] : ["running"]);
        if (expected === "queued") expect(sent.json!.note).toContain("has not read it yet");
        if (expected === "steered") expect(steered.at(-1)).toContain("Use the v2 endpoint");
      } finally {
        await t.connection.close();
      }
    }
  }, 30_000);

  it("attributes the message to the delegating thread, not to the user", async () => {
    const t = await setup({ leaveTurnsRunning: true, steering: { opencode: "delivers" } });
    try {
      const taskId = await t.delegate();
      await t.send(t.orchestrator, taskId, "Stop touching the lockfile");
      const message = (await t.store.readMessages(taskId)).at(-1)!;
      expect(message).toMatchObject({ role: "user", origin: "task-message" });
      expect(message.text).toBe("Message from the thread that delegated this task (not from the user):\n\nStop touching the lockfile");
    } finally {
      await t.connection.close();
    }
  });

  it("refuses an empty message and a bad wake like the ordinary send does", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      expect((await t.send(t.orchestrator, taskId, "   ")).isError).toBe(true);
      expect((await callMoxenTool(t.connection, t.orchestrator, "task_send", { taskId, message: "x", wake: "yes" })).isError).toBe(true);
      expect(await t.store.readTurns(taskId)).toHaveLength(1);
    } finally {
      await t.connection.close();
    }
  });
});

describe("task_send: a finished task", () => {
  it("is refused without wake; with wake it reports running, and the parent is told again when it settles again", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await expect.poll(async () => (await t.notifications()).length, WAIT).toBe(1);

      const refused = await t.send(t.orchestrator, taskId, "One more thing");
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("TASK_SETTLED");
      expect(refused.text).toContain("wake: true");
      expect(await t.store.readTurns(taskId)).toHaveLength(1);

      const woken = await t.send(t.orchestrator, taskId, "One more thing", true);
      expect(woken.json).toMatchObject({ outcome: "started", woke: true });
      await expect.poll(async () => (await t.notifications()).length, WAIT).toBe(2);
      const [first, second] = await t.notifications();
      expect(second!.text).toContain(`taskId ${taskId}`);
      expect(second!.id).not.toBe(first!.id);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("reports running through task_status right after a wake, not the old finished report", async () => {
    // Turns never finish here, so the first one is stopped by task_cancel and the task is finished (interrupted).
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskId });
      const before = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "task_status", { taskId, waitMs: 0 })).text);
      expect(before).toMatchObject({ finished: true });
      await t.send(t.orchestrator, taskId, "Try again, differently", true);
      const after = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "task_status", { taskId, waitMs: 0 })).text);
      expect(after).toMatchObject({ status: "running", finished: false });
      expect(after.report).toBeUndefined();
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("tells the parent once the queued message's turn has ended too, not when the first turn does", async () => {
    // Turns never finish by themselves here; the test settles them in the ledger, first the running one, then the one it promotes.
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      expect((await t.send(t.orchestrator, taskId, "Then do this")).json).toMatchObject({ outcome: "queued" });
      // The server's own store: its events are what the parent's watch hears (a second store has a bus of its own).
      const served = (await (t.connection as unknown as { store(): Promise<ThreadStore> }).store());
      const [first] = await served.readTurns(taskId);
      await completeTurn(served, taskId, first!.id, { text: "First done." });
      const promoted = (await served.readTurns(taskId)).find((turn) => turn.status === "running")!;
      expect(promoted.delivery).toBe("queued");
      await new Promise((resolve) => setTimeout(resolve, TASK_NOTIFICATION_BATCH_MS + 500));
      expect(await t.notifications()).toHaveLength(0);

      await completeTurn(served, taskId, promoted.id, { text: "Second done." });
      await expect.poll(async () => (await t.notifications()).length, WAIT).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, TASK_NOTIFICATION_BATCH_MS + 500));
      expect(await t.notifications()).toHaveLength(1);
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

describe("task_send: whose task it is", () => {
  it("reaches only the delegating thread's tasks, and still the continuation after the orchestrator continues", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });

      const refused = await t.send(stranger.threadId, taskId, "Take over");
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("TASK_NOT_FOUND");
      expect(await t.store.readTurns(taskId)).toHaveLength(1);

      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      const fromContinuation = await t.send(continued.threadId, taskId, "Carry on, I am the same orchestrator");
      expect(fromContinuation.isError).toBe(false);
      expect(fromContinuation.json).toMatchObject({ taskId, status: "running" });
      // The thread that handed the task over no longer owns it.
      expect((await t.send(t.orchestrator, taskId, "Old thread")).text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

describe("task_send: a task that finished before the orchestrator continued", () => {
  it("stays reachable from the continuation, reports there once woken, and never reaches a stranger", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      await vi.waitFor(async () => expect((await t.store.readTurns(taskId)).every((turn) => turn.status === "completed")).toBe(true));
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      const again = await t.connection.dispatch({ type: "thread.continue", threadId: continued.threadId });
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      expect((await t.send(stranger.threadId, taskId, "Take over", true)).text).toContain("TASK_NOT_FOUND");

      // Two continuations on, it still needs wake, and the finished task stays listed under the first thread until then.
      expect((await t.send(again.threadId, taskId, "One more thing")).text).toContain("TASK_SETTLED");
      expect((await t.store.readDelegations()).find((row) => row.childThreadId === taskId)?.parentThreadId).toBe(t.orchestrator);

      const woken = await t.send(again.threadId, taskId, "One more thing", true);
      expect(woken.json).toMatchObject({ taskId, outcome: "started" });
      expect((await t.store.readDelegations()).find((row) => row.childThreadId === taskId)?.parentThreadId).toBe(again.threadId);
      await vi.waitFor(async () => expect(await t.notifications(again.threadId)).toHaveLength(1), { timeout: 8_000 });
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

describe("task_send: research runs and delegated tasks", () => {
  it("is not offered where task_cancel is not, and refused when called anyway", async () => {
    expect(DELEGATION_TOOLS.has("task_send")).toBe(true);
    const names = (options: Parameters<typeof moxenToolsFor>[0]) => moxenToolsFor(options).map((tool) => tool.name);
    expect(names({})).toContain("task_send");
    expect(names({ delegated: true })).not.toContain("task_send");
    expect(names({ delegated: true })).not.toContain("task_cancel");
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const refused = await callMoxenTool(t.connection, taskId, "task_send", { taskId, message: "x" }, { delegated: true });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("not available in a delegated task");
    } finally {
      await t.connection.close();
    }
  });

  it("does not reach a research run's lead or roles: their messages are scoped and capped", async () => {
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

      // The orchestrator that started the run, wake or not, cannot message its lead.
      for (const wake of [false, true]) {
        const toLead = await t.send(t.orchestrator, leadId, "Skip the critic", wake);
        expect(toLead.isError).toBe(true);
        expect(toLead.text).toContain("TASK_SEND_RESEARCH");
      }
      // The lead cannot message its roles, and a role is nobody's task but the lead's.
      const toRole = await t.send(leadId, researcher.child.id, "Report now", true);
      expect(toRole.isError).toBe(true);
      expect(toRole.text).toContain("TASK_SEND_RESEARCH");
      expect((await t.send(t.orchestrator, researcher.child.id, "Report now", true)).text).toContain("TASK_NOT_FOUND");
      expect((await t.store.readMessages(researcher.child.id)).some((message) => message.origin === "task-message")).toBe(false);
      expect((await t.store.readMessages(leadId)).some((message) => message.origin === "task-message")).toBe(false);

      // A side question follows the same rule: the run's traffic goes through the run.
      const askedLead = await callMoxenTool(t.connection, t.orchestrator, "task_ask", { taskId: leadId, question: "How is it going?" });
      expect(askedLead.isError).toBe(true);
      expect(askedLead.text).toContain("TASK_ASK_RESEARCH");
      const askedRole = await callMoxenTool(t.connection, leadId, "task_ask", { taskId: researcher.child.id, question: "How is it going?" });
      expect(askedRole.isError).toBe(true);
      expect(askedRole.text).toContain("TASK_ASK_RESEARCH");
    } finally {
      unattended();
      await t.connection.close();
    }
  }, 30_000);
});

describe("task_cancel: whose task it is", () => {
  it("refuses a thread that did not delegate the task, and leaves the task running", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      const refused = await callMoxenTool(t.connection, stranger.threadId, "task_cancel", { taskId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("TASK_NOT_FOUND");
      // A thread that is not a task of anyone's gets the same answer as an id that does not exist.
      const other = await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskId: stranger.threadId });
      expect(other.isError).toBe(true);
      expect(other.text).toContain("TASK_NOT_FOUND");
      expect((await t.store.readTurns(taskId)).map((turn) => turn.status)).toEqual(["running"]);
      expect((await t.store.readTurns(stranger.threadId)).some((turn) => turn.status === "interrupted")).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("lets the delegating thread cancel, and after the orchestrator continues only the continuation", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const first = await t.delegate();
      const second = await t.delegate(undefined, "second");
      const cancelled = await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskId: first });
      expect(cancelled.isError).toBe(false);
      expect(JSON.parse(cancelled.text)).toMatchObject({ taskId: first, cancelRequested: true });

      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      expect((await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskId: second })).text).toContain("TASK_NOT_FOUND");
      expect((await t.store.readTurns(second)).map((turn) => turn.status)).toEqual(["running"]);
      const fromContinuation = await callMoxenTool(t.connection, continued.threadId, "task_cancel", { taskId: second });
      expect(fromContinuation.isError).toBe(false);
      expect(JSON.parse(fromContinuation.text)).toMatchObject({ taskId: second, cancelRequested: true });
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

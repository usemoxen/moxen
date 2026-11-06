/**
 * `task_send`, through the real tool handler (`callMoxenTool`), the real server connection and the
 * real store: nothing here hand-builds a delegation row or a result. The only fakes are the
 * provider drivers (`testHarness`), which differ from the real ones in exactly one way a test can
 * choose: whether the driver has `steerTurn` and whether it succeeds.
 */
import { describe, expect, it } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { TASK_NOTIFICATION_BATCH_MS } from "../../../core/threads/operations.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { completeTurn } from "../../../core/threads/threads.js";
import type { ClientApi } from "../../api.js";
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

  // Two fixed 2.5s waits plus polls and two real turns: about 10s green on
  // Windows, so a loaded runner needs more than twenty seconds.
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
  }, 30_000);
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

describe("task_send: a task that is idle when the orchestrator continues", () => {
  // Three turn lifecycles (the orchestrator's handover, the delegate's, the
  // woken one) plus two 2s notification batch windows: a loaded Windows
  // runner does not fit in twenty seconds (23.3s in the red CI run, against
  // ~9s green). Each wait below covers one turn settling plus one 2s batch
  // window: ~2.6s healthy locally, and the red runner (1.45x the green pace
  // file-wide) still had zero reports at 8s — so the bound is the file's
  // WAIT, the same 12s every other notification wait here already uses, not
  // a blind bump. A real hang still fails inside the 30s outer budget.
  it("moves with the continuation, reports there once woken, and never reaches a stranger or the old parent", async () => {
    const t = await setup();
    try {
      const taskId = await t.delegate();
      // The task's first report reaches the orchestrator before any handoff,
      // so later counts have a stable baseline. One wait, not two: the report
      // is queued only after the task's turn settles (and delivered after the
      // batch window), so seeing it already means the turn completed.
      await expect.poll(async () => (await t.notifications()).length, WAIT).toBe(1);
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      const again = await t.connection.dispatch({ type: "thread.continue", threadId: continued.threadId });
      const stranger = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Someone else, same project", wait: false, threadEnvMode: "local" });
      expect((await t.send(stranger.threadId, taskId, "Take over", true)).text).toContain("TASK_NOT_FOUND");

      // Each continuation takes the delegation rows with it, so the idle task
      // is the latest continuation's from the start: both older threads read
      // as strangers now, not just unrelated ones.
      expect((await t.store.readDelegations()).find((row) => row.childThreadId === taskId)?.parentThreadId).toBe(again.threadId);
      expect((await t.send(t.orchestrator, taskId, "Old thread", true)).text).toContain("TASK_NOT_FOUND");
      expect((await t.send(continued.threadId, taskId, "Middle thread", true)).text).toContain("TASK_NOT_FOUND");
      // It still needs wake: idleness is the task's own state, not the row's.
      expect((await t.send(again.threadId, taskId, "One more thing")).text).toContain("TASK_SETTLED");

      const woken = await t.send(again.threadId, taskId, "One more thing", true);
      expect(woken.json).toMatchObject({ taskId, outcome: "started" });
      expect((await t.store.readDelegations()).find((row) => row.childThreadId === taskId)?.parentThreadId).toBe(again.threadId);
      // The old parents keep whatever they already had (the task's first
      // report went to the orchestrator before the handoff); the new report
      // from the woken turn reaches only the thread that owns the task now.
      const beforeOld = await t.notifications(t.orchestrator);
      const beforeMid = await t.notifications(continued.threadId);
      await expect.poll(async () => (await t.notifications(again.threadId)).length, WAIT).toBe(1);
      expect(await t.notifications(t.orchestrator)).toEqual(beforeOld);
      expect(await t.notifications(continued.threadId)).toEqual(beforeMid);
    } finally {
      await t.connection.close();
    }
  }, 30_000);
});

describe("task handoff on continue (MXN-300)", () => {
  it("moves running and idle tasks to the new parent, which steers and is notified, while the old parent reads TASK_NOT_FOUND", async () => {
    const t = await setup({
      leaveTurnsRunning: true,
      steering: { opencode: "delivers" },
      sideQuestions: { opencode: async () => ({ text: "On it.", withContext: true }) },
    });
    try {
      const running = await t.delegate(undefined, "running");
      const idle = await t.delegate(undefined, "idle");
      // The server's own store: its events are what the parent's watch hears (a second store has a bus of its own).
      const served = await (t.connection as unknown as { store(): Promise<ThreadStore> }).store();
      const idleTurn = (await served.readTurns(idle)).find((turn) => turn.status === "running")!;
      await completeTurn(served, idle, idleTurn.id, { text: "Idle task done." });
      // Its first report reaches the orchestrator before any handoff, so later counts have a stable baseline.
      await expect.poll(async () => (await t.notifications()).length, WAIT).toBe(1);

      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      const rows = await t.store.readDelegations();
      expect(rows.find((row) => row.childThreadId === running)?.parentThreadId).toBe(continued.threadId);
      expect(rows.find((row) => row.childThreadId === idle)?.parentThreadId).toBe(continued.threadId);
      // The handoff turn never settles on its own here, and a notification
      // addressed to a busy thread queues behind it: settle it, as a real
      // handoff turn settles once the new agent has read it.
      const handoffTurn = (await served.readTurns(continued.threadId)).find((turn) => turn.status === "running")!;
      await completeTurn(served, continued.threadId, handoffTurn.id, { text: "Handoff read." });

      // The new parent steers the running task and reads the idle one.
      expect((await t.send(continued.threadId, running, "Pick up the pace")).json).toMatchObject({ taskId: running, outcome: "steered" });
      expect(JSON.parse((await callMoxenTool(t.connection, continued.threadId, "task_status", { taskId: idle })).text)).toMatchObject(
        { taskId: idle, status: "completed", finished: true },
      );
      const asked = await callMoxenTool(t.connection, continued.threadId, "task_ask", { taskId: idle, question: "How did it go?" });
      expect(asked.isError).toBe(false);
      expect(JSON.parse(asked.text)).toMatchObject({ taskId: idle });

      // The old parent lost the task entirely: steering, reads, questions,
      // queueing and cancelling all read as TASK_NOT_FOUND there now.
      expect((await t.send(t.orchestrator, running, "Old thread")).text).toContain("TASK_NOT_FOUND");
      expect((await callMoxenTool(t.connection, t.orchestrator, "task_status", { taskId: idle })).text).toContain("TASK_NOT_FOUND");
      expect((await callMoxenTool(t.connection, t.orchestrator, "task_ask", { taskId: idle, question: "x" })).text).toContain("TASK_NOT_FOUND");
      expect((await callMoxenTool(t.connection, t.orchestrator, "message_queue", { message: "x", threadId: idle })).text).toContain("TASK_NOT_FOUND");
      expect((await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskId: running })).text).toContain("TASK_NOT_FOUND");
      // Cancelling from the new parent works, and on the already-finished
      // idle task is a no-op report, not an interrupt.
      expect(JSON.parse((await callMoxenTool(t.connection, continued.threadId, "task_cancel", { taskId: idle })).text)).toMatchObject(
        { taskId: idle, cancelRequested: false, status: "completed" },
      );

      // Each task settling afterwards notifies the new parent only. A send
      // from the new parent arms that watch (a queued or started outcome);
      // the delegate-time run never settles on a parked driver, so it cannot.
      const runningTurn = (await served.readTurns(running)).find((turn) => turn.status === "running")!;
      await completeTurn(served, running, runningTurn.id, { text: "Running task done." });
      const followUp = await t.send(continued.threadId, running, "Now do it differently", true);
      expect(followUp.json).toMatchObject({ taskId: running, outcome: "started", woke: true });
      const followUpTurn = (await served.readTurns(running)).find((turn) => turn.status === "running")!;
      await completeTurn(served, running, followUpTurn.id, { text: "Running task, second run done." });
      await expect.poll(async () => (await t.notifications(continued.threadId)).length, WAIT).toBe(1);
      const woken = await t.send(continued.threadId, idle, "One more thing", true);
      expect(woken.json).toMatchObject({ taskId: idle, outcome: "started" });
      const wokenTurn = (await served.readTurns(idle)).find((turn) => turn.status === "running")!;
      await completeTurn(served, idle, wokenTurn.id, { text: "Idle task, second run done." });
      await expect.poll(async () => (await t.notifications(continued.threadId)).length, WAIT).toBe(2);
      expect(await t.notifications()).toHaveLength(1);

      // Queueing resolves against the new parent too — last, so the held
      // entry cannot keep the woken task from settling above.
      const queued = await callMoxenTool(t.connection, continued.threadId, "message_queue", {
        message: "For later",
        threadId: idle,
        at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(queued.isError).toBe(false);
      expect(JSON.parse(queued.text)).toMatchObject({ threadId: idle, status: "queued" });
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("hands the new thread to another provider and model, leaving the tasks' own selection alone", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const before = JSON.parse((await callMoxenTool(t.connection, t.orchestrator, "task_status", { taskId, waitMs: 0 })).text);
      expect(before.status).toBe("running");

      const continued = await t.connection.dispatch({
        type: "thread.continue",
        threadId: t.orchestrator,
        provider: "codex",
        model: "gpt-6.1-sol",
      });
      const read = await t.connection.query({ type: "thread.inspect", threadId: continued.threadId });
      const selection = (read.thread as unknown as { modelSelection: { instanceId: string; model: string } }).modelSelection;
      expect(selection).toMatchObject({ instanceId: "codex", model: "gpt-6.1-sol" });
      // The task keeps its own provider and model; only the parent link moved.
      const child = await t.connection.query({ type: "thread.inspect", threadId: taskId });
      const childSelection = (child.thread as unknown as { modelSelection: { instanceId: string; model: string } }).modelSelection;
      expect(childSelection).toMatchObject({ instanceId: "opencode", model: "gpt-5.4" });
      expect((await t.store.readDelegations()).find((row) => row.childThreadId === taskId)?.parentThreadId).toBe(continued.threadId);
      expect((await t.send(continued.threadId, taskId, "Carry on")).json).toMatchObject({ taskId });
      expect((await t.send(t.orchestrator, taskId, "Old thread")).text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 30_000);

  it("refuses a delegation from a thread that already continued, naming the live thread", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      await t.delegate();
      const continued = await t.connection.dispatch({ type: "thread.continue", threadId: t.orchestrator });
      const refused = await callMoxenTool(t.connection, t.orchestrator, "delegate", { task: "More work", title: "late", isolation: "shared" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("THREAD_CONTINUED");
      expect(refused.text).toContain(continued.threadId);
      // From the live thread it still works.
      const again = await callMoxenTool(t.connection, continued.threadId, "delegate", { task: "More work", title: "live", isolation: "shared" });
      expect(again.isError).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 30_000);
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

  it("cancels several tasks at once, reporting each outcome without stopping on a bad id", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const first = await t.delegate();
      const second = await t.delegate(undefined, "second");
      const result = await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskIds: [first, "task-missing", second] });
      expect(result.isError).toBe(false);
      const batch = JSON.parse(result.text) as { tasks: Array<Record<string, unknown>> };
      expect(batch.tasks).toHaveLength(3);
      expect(batch.tasks[0]).toMatchObject({ taskId: first, cancelRequested: true });
      expect(batch.tasks[1]).toMatchObject({ taskId: "task-missing", error: expect.stringContaining("TASK_NOT_FOUND") });
      expect(batch.tasks[2]).toMatchObject({ taskId: second, cancelRequested: true });
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("refuses a task_cancel that mixes or omits the id forms", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const call = (args: Record<string, unknown>) => callMoxenTool(t.connection, t.orchestrator, "task_cancel", args);
      expect((await call({ taskId, taskIds: [taskId] })).text).toContain("not both");
      expect((await call({})).text).toContain("taskId");
      expect((await call({ taskIds: [] })).text).toContain("non-empty array");
      for (const reply of [await call({}), await call({ taskIds: [] })]) expect(reply.isError).toBe(true);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("stops a repeated id once, in order", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const taskId = await t.delegate();
      const result = await callMoxenTool(t.connection, t.orchestrator, "task_cancel", { taskIds: [taskId, taskId] });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({ tasks: [{ taskId, cancelRequested: true }] });
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("codes a failure no CliError names, and fails a missing parent as the single form does", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const failing = {
        dispatch: async () => { throw new Error("boom"); },
        query: async () => ({ thread: {} }),
      } as unknown as ClientApi;
      const coded = await callMoxenTool(failing, "parent", "task_cancel", { taskIds: ["a"] });
      expect(coded.isError).toBe(false);
      expect(JSON.parse(coded.text)).toEqual({ tasks: [{ taskId: "a", error: "TASK_START_FAILED: boom" }] });

      const missing = await callMoxenTool(t.connection, "thread-missing", "task_cancel", { taskIds: ["a", "b"] });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("TASK_NOT_FOUND");
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

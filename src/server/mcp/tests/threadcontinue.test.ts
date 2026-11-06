/**
 * `thread_continue`, through the real tool handler (`callMoxenTool`), the real server connection and the
 * real store. The only fakes are the provider drivers (`testHarness`).
 */
import { describe, expect, it } from "vitest";

import { testHarness, type TestHarnessOptions } from "../../../core/testing/harness.js";
import { driverKindOfInstance } from "../../../core/types.js";
import { runWorkQueue, type OperationContext } from "../../../core/threads/operations.js";
import { interruptTurn } from "../../../core/threads/threads.js";
import { openThreadStore, type ThreadStore } from "../../../core/threads/store.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, DELEGATION_TOOLS, moxenToolsFor } from "../tools.js";

async function setup(options: TestHarnessOptions = {}) {
  const harness = await testHarness(options);
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: options.leaveTurnsRunning !== true, threadEnvMode: "local" });
  const store = await openThreadStore(harness.root);
  const served = () => (connection as unknown as { store(): Promise<ThreadStore> }).store();
  const queueContext = async (): Promise<OperationContext> => ({
    store: await served(),
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (instanceId: string) => harness.drivers[driverKindOfInstance(instanceId)!]!(),
  });
  const keep = async (from: string, args: Record<string, unknown>) => {
    const result = await callMoxenTool(connection, from, "thread_continue", args);
    return { ...result, json: result.isError ? null : (JSON.parse(result.text) as Record<string, unknown>) };
  };
  return { harness, connection, store, served, queueContext, orchestrator: orchestrator.threadId, keep };
}

describe("thread_continue: offered", () => {
  it("is listed for plain threads, but not for delegated tasks or research runs", () => {
    // A delegated task neither delegates again nor continues itself in a new
    // thread (a full context there is compacted in place), like the rest of
    // the delegation family.
    expect(DELEGATION_TOOLS.has("thread_continue")).toBe(true);
    expect(moxenToolsFor({}).map((tool) => tool.name)).toContain("thread_continue");
    expect(moxenToolsFor({ delegated: true }).map((tool) => tool.name)).not.toContain("thread_continue");
    expect(moxenToolsFor({ researchMember: true }).map((tool) => tool.name)).not.toContain("thread_continue");
  });
});

describe("thread_continue: continuing your own thread", () => {
  it("holds the new thread until the calling turn ends, moves running tasks, and reports the handoff", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const delegated = await callMoxenTool(t.connection, t.orchestrator, "delegate", { task: "Do the work", title: "task", isolation: "shared" });
      expect(delegated.isError).toBe(false);
      const taskId = JSON.parse(delegated.text).taskId as string;

      const continued = await t.keep(t.orchestrator, { summary: "Goal: ship it. Done: half. Next: the rest.", first: "Do the rest." });
      expect(continued.isError).toBe(false);
      const threadId = continued.json!.threadId as string;
      expect(threadId).not.toBe(t.orchestrator);
      expect(continued.json).toMatchObject({ title: expect.stringContaining("(continued)") });
      expect(continued.json!.note as string).toContain("Finish your turn now");
      // The agent's own text is the handoff; the task moved with it.
      expect(continued.json!.adoptedTasks).toMatchObject([{ taskId }]);
      const prompt = (await (await t.served()).readMessages(threadId)).find((message) => message.role === "user")!.text;
      expect(prompt).toContain("Next: the rest.");
      expect(prompt).toContain("Do the rest.");
      expect(prompt).toContain(`(taskId ${taskId})`);

      // Still queued behind the calling turn after a queue pass.
      const ctx = await t.queueContext();
      await runWorkQueue(ctx);
      expect((await (await t.served()).readTurns(threadId)).map((turn) => turn.status)).toEqual(["queued"]);

      // Once the calling turn ends, the new thread starts with that prompt.
      const [running] = await (await t.served()).readTurns(t.orchestrator);
      await interruptTurn(await t.served(), t.orchestrator, running!.id);
      await runWorkQueue(ctx);
      expect((await (await t.served()).readTurns(threadId)).map((turn) => turn.status)).toEqual(["running"]);
      expect((await (await t.served()).readMessages(threadId)).find((message) => message.role === "user")!.text).toContain("Do the rest.");
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("starts at once on an idle thread", async () => {
    const t = await setup();
    try {
      const continued = await t.keep(t.orchestrator, { summary: "Follow-up work remains." });
      expect(continued.isError).toBe(false);
      const threadId = continued.json!.threadId as string;
      await expect.poll(async () => (await t.store.readTurns(threadId)).map((turn) => turn.status)).toEqual(["completed"]);
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

describe("thread_continue: whose thread it is", () => {
  it("a delegated child is refused: it reports back instead of continuing itself", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const delegated = await callMoxenTool(t.connection, t.orchestrator, "delegate", { task: "Do the work", title: "task", isolation: "shared" });
      const taskId = JSON.parse(delegated.text).taskId as string;
      // The tool names no thread and is not offered to tasks: a call from
      // the child is refused rather than continuing anything. The tool
      // layer refuses it for a delegated session; the core refuses it as a
      // backstop when reached directly.
      const refused = await t.keep(taskId, { summary: "Half done." });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("THREAD_CONTINUE_DELEGATED");
      const gated = await callMoxenTool(t.connection, taskId, "thread_continue", { summary: "Half done." }, { delegated: true });
      expect(gated.isError).toBe(true);
      expect(gated.text).toContain("not available in a delegated task");
      expect((await (await t.served()).readActivities(taskId)).some((activity) => activity.kind === "thread.continued")).toBe(false);
    } finally {
      await t.connection.close();
    }
  }, 20_000);

  it("refuses a research lead and role even when called directly", async () => {
    const t = await setup({ leaveTurnsRunning: true });
    try {
      const served = await t.served();
      const now = served.nowIso();
      const lead = await served.readThreadRecord(t.orchestrator);
      await served.writeThreadRecord({
        ...lead!,
        researchRun: { leadThreadId: t.orchestrator, size: { researchers: 1, critics: 1 }, roles: [], state: "running", createdAt: now, updatedAt: now },
      });
      const refusedLead = await t.keep(t.orchestrator, { summary: "Work left." });
      expect(refusedLead.isError).toBe(true);
      expect(refusedLead.text).toContain("THREAD_CONTINUE_RESEARCH");

      const role = await t.connection.dispatch({ type: "thread.handover", cwd: t.harness.work, prompt: "Role work", wait: false, threadEnvMode: "local" });
      const roleThread = await served.readThreadRecord(role.threadId);
      await served.writeThreadRecord({ ...roleThread!, researchRole: { leadThreadId: t.orchestrator, role: "researcher" } });
      const refusedRole = await t.keep(role.threadId, { summary: "Work left." });
      expect(refusedRole.isError).toBe(true);
      expect(refusedRole.text).toContain("THREAD_CONTINUE_RESEARCH");
    } finally {
      await t.connection.close();
    }
  }, 20_000);
});

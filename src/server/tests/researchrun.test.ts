import { describe, expect, it } from "vitest";

import { testHarness } from "../../core/testing/harness.js";
import { openThreadStore } from "../../core/threads/store.js";
import { DirectConnection } from "../connection.js";
import { availableMoxenTools, callMoxenTool, DELEGATION_TOOLS } from "../mcp/tools.js";
import type { ShellFrame } from "../api.js";

const ROLE_TOOLS = ["research_role_start", "research_role_report", "research_role_cancel"];
const WAIT = { timeout: 10_000 };

describe("full research runs", () => {
  it("offers role tools only to the lead and refuses forged calls from every other thread", async () => {
    const starts: Array<Record<string, unknown>> = [];
    const harness = await testHarness({ onStartSession: (input) => starts.push(input) });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: true });
      const plain = await connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "One researcher", interactionMode: "research", wait: true, notify: false });
      const result = await callMoxenTool(connection, lead.child.id, "research_role_start", { role: "researcher", question: "Check evidence" });
      expect(result.isError).toBe(false);
      const role = JSON.parse(result.text) as { task: { taskId: string } };
      const store = await openThreadStore(harness.root);
      await expect.poll(async () => (await store.readTurns(role.task.taskId)).at(-1)?.status, WAIT).toBe("completed");
      for (const id of [parent.threadId, plain.child.id, role.task.taskId]) {
        const tools = await availableMoxenTools(connection, id, {});
        expect(tools.filter((tool) => ROLE_TOOLS.includes(tool.name))).toEqual([]);
        for (const name of ROLE_TOOLS) expect((await callMoxenTool(connection, id, name, { role: "researcher", question: "Escape", taskId: role.task.taskId })).isError).toBe(true);
        await expect(connection.dispatch({ type: "research.role.start", leadThreadId: id, role: "researcher", question: "Escape" })).rejects.toThrow(/lead/i);
        await expect(connection.dispatch({ type: "research.role.cancel", leadThreadId: id, taskId: role.task.taskId })).rejects.toThrow(/lead/i);
        await expect(connection.query({ type: "research.role.report", leadThreadId: id, taskId: role.task.taskId })).rejects.toThrow(/lead/i);
      }
      const tools = await availableMoxenTools(connection, lead.child.id, {});
      expect(tools.filter((tool) => ROLE_TOOLS.includes(tool.name)).map((tool) => tool.name)).toEqual(ROLE_TOOLS);
      expect(tools.some((tool) => DELEGATION_TOOLS.has(tool.name))).toBe(false);
      expect((await availableMoxenTools(connection, role.task.taskId, {})).some((tool) => DELEGATION_TOOLS.has(tool.name))).toBe(false);
      for (const id of [parent.threadId, lead.child.id, plain.child.id, role.task.taskId]) {
        const servers = starts.find((input) => input.threadId === id)?.mcpServers as Array<{ name: string; tools?: Array<{ name: string }> }>;
        const names = servers.find((server) => server.name === "moxen")?.tools?.map((tool) => tool.name) ?? [];
        expect(names.filter((name) => ROLE_TOOLS.includes(name))).toEqual(id === lead.child.id ? ROLE_TOOLS : []);
        if (id !== parent.threadId) expect(names.some((name) => DELEGATION_TOOLS.has(name))).toBe(false);
      }
      expect(JSON.parse((await callMoxenTool(connection, lead.child.id, "research_role_report", { taskId: role.task.taskId })).text).task.summary).toBe("Completed: Check evidence");
      expect((await callMoxenTool(connection, lead.child.id, "research_role_cancel", { taskId: role.task.taskId })).isError).toBe(false);
      expect((await callMoxenTool(connection, lead.child.id, "research_role_report", { taskId: plain.child.id })).isError).toBe(true);
      expect((await callMoxenTool(connection, lead.child.id, "research_role_cancel", { taskId: plain.child.id })).isError).toBe(true);
      await expect(connection.dispatch({ type: "thread.delegate", parentThreadId: role.task.taskId, task: "Escape" })).rejects.toThrow(/delegated/i);
      expect((await callMoxenTool(connection, role.task.taskId, "delegate", { task: "Escape", title: "Escape" })).isError).toBe(true);
      expect(await store.readThreadRecord(role.task.taskId)).toMatchObject({ interactionMode: "research" });
    } finally { await connection.close(); }
  }, 20_000);

  it("persists roles across connections and reports only the lead to the orchestrator", async () => {
    const harness = await testHarness();
    const options = { storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config, shellPollMs: 10 };
    let connection = new DirectConnection(options);
    const frames: ShellFrame[] = [];
    const errors: unknown[] = [];
    const unsubscribe = connection.subscribeShell({}, (frame) => frames.push(frame), (error) => errors.push(error));
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Final report", wait: false });
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "critic", question: "Check claims" });
      const store = await openThreadStore(harness.root);
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("completed");
      await expect.poll(() => frames.some((frame) => frame.kind === "snapshot" && frame.snapshot.researchRuns?.some((run) => run.roles.some((entry) => entry.threadId === role.child.id))), WAIT).toBe(true);
      const shell = frames.findLast((frame) => frame.kind === "snapshot");
      expect(shell?.kind === "snapshot" && shell.snapshot.threads.find((thread) => thread.id === role.child.id)?.parentThreadId).toBe(lead.child.id);
      expect(errors).toEqual([]);
      await expect.poll(async () => (await store.readMessages(parent.threadId)).filter((message) => message.origin === "task-notification").length, { timeout: 10_000 }).toBe(1);
      await connection.close();
      connection = new DirectConnection(options);
      await expect((await openThreadStore(harness.root)).readThreadRecord(lead.child.id)).resolves.toMatchObject({ researchRun: { state: "completed", roles: [{ threadId: role.child.id, role: "critic" }] } });
      const run = await connection.query({ type: "research.run", threadId: lead.child.id });
      expect(run).toMatchObject({ leadThreadId: lead.child.id, state: "completed", report: "Completed: Final report", roles: [{ role: "critic", threadId: role.child.id, task: { status: "completed", summary: "Completed: Check claims" } }] });
      const notifications = (await store.readMessages(parent.threadId)).filter((message) => message.origin === "task-notification");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.notification?.tasks.map((task) => task.taskId)).toEqual([lead.child.id]);
      expect((await connection.query({ type: "thread.task.status", parentThreadId: parent.threadId, taskId: lead.child.id })).task.summary).toBe("Completed: Final report");
      expect((await connection.query({ type: "research.run", threadId: role.child.id }))?.leadThreadId).toBe(lead.child.id);
    } finally { unsubscribe(); await connection.close(); }
  }, 20_000);

  it("cancels a live role without settling the lead or notifying the orchestrator", async () => {
    const harness = await testHarness({ leaveTurnsRunning: true });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const ids: string[] = [];
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: false, threadEnvMode: "local" });
      ids.push(parent.threadId);
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: false, notify: false });
      ids.push(lead.child.id);
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "finalizer", question: "Compose report", provider: "codex", model: "gpt-5.4", thinkingEffort: "high" });
      ids.push(role.child.id);
      const store = await openThreadStore(harness.root);
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("running");
      const cancelled = await connection.dispatch({ type: "research.role.cancel", leadThreadId: lead.child.id, taskId: role.child.id });
      expect(cancelled.interruptRequested).toBe(true);
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("interrupted");
      expect(await connection.query({ type: "research.run", threadId: lead.child.id })).toMatchObject({ state: "running", roles: [{ role: "finalizer", task: { status: "interrupted" } }] });
      expect((await store.readMessages(parent.threadId)).filter((message) => message.origin === "task-notification")).toEqual([]);
      expect((await store.readThreadRecord(role.child.id))?.modelSelection).toMatchObject({ instanceId: "codex", model: "gpt-5.4", options: expect.arrayContaining([{ id: "effort", value: "high" }]) });
    } finally {
      for (const threadId of ids.reverse()) await connection.dispatch({ type: "thread.turn.interrupt", threadId });
      await connection.close();
    }
  }, 20_000);
});

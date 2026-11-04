import { describe, expect, it } from "vitest";

import { testHarness } from "../../core/testing/harness.js";
import { openThreadStore } from "../../core/threads/store.js";
import { DirectConnection } from "../connection.js";
import { availableMoxenTools, callMoxenTool, DELEGATION_TOOLS } from "../mcp/tools.js";
import type { ShellFrame } from "../api.js";

const ROLE_TOOLS = ["research_role_start", "research_role_report", "research_role_cancel"];
const WAIT = { timeout: 10_000 };

describe("full research runs", () => {
  it.each([1, 8])("enforces %i running researchers atomically without orphan threads, and frees a finished slot", async (researchers) => {
    const harness = await testHarness({ leaveTurnsRunning: true });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: false, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: false, notify: false }, { researchers, critics: 1 });
      const start = () => connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Check" });
      const before = await store.listThreadIds();
      const results = await Promise.allSettled(Array.from({ length: researchers + 1 }, start));
      const accepted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      expect(accepted).toHaveLength(researchers);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused?.status === "rejected" && String(refused.reason)).toMatch(new RegExp(`Researcher running cap is ${researchers}`));
      expect((await store.listThreadIds()).length - before.length).toBe(researchers);
      expect((await connection.query({ type: "research.run", threadId: lead.child.id }))?.size).toEqual({ researchers, critics: 1 });
      const done = accepted[0]!.child.id;
      await expect.poll(async () => (await store.readTurns(done)).at(-1)?.status, WAIT).toBe("running");
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: done });
      await expect.poll(async () => (await store.readTurns(done)).at(-1)?.status, WAIT).toBe("interrupted");
      expect((await start()).child.id).not.toBe(done);
    } finally {
      for (const threadId of await store.listThreadIds()) await connection.dispatch({ type: "thread.turn.interrupt", threadId });
      for (const threadId of await store.listThreadIds()) await expect.poll(async () => (await store.readTurns(threadId)).every((turn) => !["running", "queued"].includes(turn.status)), WAIT).toBe(true);
      await connection.close();
    }
  }, 20_000);

  it("enforces chosen critic size concurrently and rejects sizes outside the hard maximums", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const request = { parentThreadId: parent.threadId, task: "Investigate", wait: true };
      for (const size of [{ researchers: 9, critics: 1 }, { researchers: 1, critics: 4 }, { researchers: 0, critics: 1 }, { researchers: 1, critics: 0 }]) await expect(connection.startResearchRun(request, size)).rejects.toThrow(/researchers 1 to 8 and critics 1 to 3/);
      const lead = await connection.startResearchRun(request, { researchers: 1, critics: 1 });
      const store = await openThreadStore(harness.root);
      const before = (await store.listThreadIds()).length;
      const results = await Promise.all([1, 2].map(() => callMoxenTool(connection, lead.child.id, "research_role_start", { role: "critic", question: "Review" })));
      expect(results.filter((result) => !result.isError)).toHaveLength(1);
      expect(results.find((result) => result.isError)?.text).toMatch(/Critic agent cap is 1/);
      expect((await store.listThreadIds()).length).toBe(before + 1);
      const run = await connection.query({ type: "research.run", threadId: lead.child.id });
      expect(run?.messages).toEqual([expect.objectContaining({ kind: "handoff", text: "Review", threadId: run?.roles[0]?.threadId })]);
      await expect.poll(async () => (await store.readTurns(run!.roles[0]!.threadId)).at(-1)?.status, WAIT).toBe("completed");
      for (let followup = 0; followup < 2; followup++) {
        const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Evidence" });
        await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("completed");
      }
    } finally { await connection.close(); }
  }, 20_000);

  it("scopes run messages to the calling role and gates finalization on every critic verdict", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: true });
      const other = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Private run", wait: true });
      expect((await connection.query({ type: "research.run", threadId: lead.child.id }))?.size).toEqual({ researchers: 8, critics: 3 });
      const start = (role: "researcher" | "critic" | "finalizer") => connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role, question: "Check" });
      await expect(start("finalizer")).rejects.toThrow(/verdict/i);
      const researcher = await start("researcher");
      expect((await callMoxenTool(connection, researcher.child.id, "research_message_submit", { text: "Evidence" })).isError).toBe(false);
      const critics = await Promise.all([start("critic"), start("critic"), start("critic")]);
      await expect(start("critic")).rejects.toThrow(/critic.*3/i);
      for (const critic of critics.slice(0, 2)) expect((await callMoxenTool(connection, critic.child.id, "research_message_submit", { text: "Validated" })).isError).toBe(false);
      await expect(start("finalizer")).rejects.toThrow(/verdict/i);
      expect((await callMoxenTool(connection, critics[2]!.child.id, "research_message_submit", { text: "Validated" })).isError).toBe(false);
      const read = await callMoxenTool(connection, researcher.child.id, "research_messages", { threadId: other.child.id, leadThreadId: other.child.id });
      expect(read.isError).toBe(false);
      expect(JSON.parse(read.text)).toMatchObject({ leadThreadId: lead.child.id, messages: expect.arrayContaining([expect.objectContaining({ text: "Evidence" })]) });
      expect((await callMoxenTool(connection, parent.threadId, "research_messages", { threadId: lead.child.id })).isError).toBe(true);
      expect((await callMoxenTool(connection, other.child.id, "research_message_submit", { text: "Private" })).isError).toBe(false);
      expect((await callMoxenTool(connection, researcher.child.id, "research_messages", { threadId: other.child.id })).text).not.toContain("Private");
      expect((await availableMoxenTools(connection, researcher.child.id, {})).map((tool) => tool.name)).toEqual(expect.arrayContaining(["research_messages", "research_message_submit"]));
      expect((await callMoxenTool(connection, critics[0]!.child.id, "research_message_submit", { text: "Round 2" })).isError).toBe(false);
      const rounds = await Promise.all([3, 4].map((round) => callMoxenTool(connection, critics[0]!.child.id, "research_message_submit", { text: `Round ${round}` })));
      expect(rounds.filter((result) => !result.isError)).toHaveLength(1);
      expect(rounds.find((result) => result.isError)).toMatchObject({ text: expect.stringMatching(/round.*3/i) });
      expect((await callMoxenTool(connection, lead.child.id, "research_message_submit", { text: "Recheck the evidence" })).isError).toBe(false);
      expect((await callMoxenTool(connection, researcher.child.id, "research_message_submit", { text: "Revised evidence" })).isError).toBe(false);
      await expect(start("finalizer")).rejects.toThrow(/verdict/i);
      for (const critic of critics) expect((await callMoxenTool(connection, critic.child.id, "research_message_submit", { text: "Revalidated" })).isError).toBe(false);
      const finalizer = await start("finalizer");
      await expect(start("finalizer")).rejects.toThrow(/Finalizer agent cap is 1/);
      expect((await callMoxenTool(connection, finalizer.child.id, "research_message_submit", { text: "Final report" })).isError).toBe(false);
      const messages = (await connection.query({ type: "research.run", threadId: lead.child.id }))?.messages;
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "followup", text: "Recheck the evidence" }),
        expect.objectContaining({ kind: "verdict", round: 3, findings: 1 }),
        expect.objectContaining({ kind: "verdict", round: 1, findings: 2 }),
        expect.objectContaining({ kind: "final", text: "Final report", findings: 2 }),
      ]));
      const store = await openThreadStore(harness.root);
      for (const id of [researcher.child.id, ...critics.map((c) => c.child.id), finalizer.child.id]) await expect.poll(async () => (await store.readTurns(id)).at(-1)?.status, WAIT).toBe("completed");
    } finally { await connection.close(); }
  }, 20_000);
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
      expect((await callMoxenTool(connection, role.child.id, "research_message_submit", { text: "Claims hold" })).isError).toBe(false);
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
      expect(run?.messages).toEqual([expect.objectContaining({ kind: "handoff", text: "Check claims" }), expect.objectContaining({ kind: "verdict", text: "Claims hold" })]);
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
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Compose report", provider: "codex", model: "gpt-5.4", thinkingEffort: "high" });
      ids.push(role.child.id);
      const store = await openThreadStore(harness.root);
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("running");
      const cancelled = await connection.dispatch({ type: "research.role.cancel", leadThreadId: lead.child.id, taskId: role.child.id });
      expect(cancelled.interruptRequested).toBe(true);
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("interrupted");
      expect(await connection.query({ type: "research.run", threadId: lead.child.id })).toMatchObject({ state: "running", roles: [{ role: "researcher", task: { status: "interrupted" } }] });
      expect((await store.readMessages(parent.threadId)).filter((message) => message.origin === "task-notification")).toEqual([]);
      expect((await store.readThreadRecord(role.child.id))?.modelSelection).toMatchObject({ instanceId: "codex", model: "gpt-5.4", options: expect.arrayContaining([{ id: "effort", value: "high" }]) });
    } finally {
      for (const threadId of ids.reverse()) await connection.dispatch({ type: "thread.turn.interrupt", threadId });
      await connection.close();
    }
  }, 20_000);
});

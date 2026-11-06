import { describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { testHarness } from "../../core/testing/harness.js";
import { openThreadStore, ThreadStore } from "../../core/threads/store.js";
import { DirectConnection } from "../connection.js";
import { availableMoxenTools, callMoxenTool, DELEGATION_TOOLS } from "../mcp/tools.js";
import type { ShellFrame } from "../api.js";
import type { McpServerSpec } from "../../core/mcp.js";

const ROLE_TOOLS = ["research_role_start", "research_role_report", "research_role_cancel"];
const WAIT = { timeout: 10_000 };

describe("full research runs", () => {
  it("keeps one researcher as the tool default, including an unattended full-run proposal", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    const ordinary = connection.subscribeShell({}, () => {}, () => {});
    const unrelated = connection.subscribeShell({ researchProposals: ["another-thread"] }, () => {}, () => {});
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      for (const proposal of [undefined, { size: { researchers: 8, critics: 3 } }]) {
        const result = await callMoxenTool(connection, parent.threadId, "delegate", {
          task: "Read only", title: "Research", mode: "research", isolation: "shared",
          ...(proposal ? { researchProposal: proposal } : {}),
          // A model cannot smuggle a user-approved size through the tool.
          research: { size: { researchers: 8, critics: 3 } },
        });
        expect(result.isError).toBe(false);
        const taskId = JSON.parse(result.text).taskId as string;
        expect(await store.readThreadRecord(taskId)).toMatchObject({ interactionMode: "research" });
        expect(await connection.query({ type: "research.run", threadId: taskId })).toBeNull();
        await expect.poll(async () => (await store.readTurns(taskId)).at(-1)?.status, WAIT).toBe("completed");
      }
      expect(await store.listThreadIds()).toHaveLength(3);
      expect(await connection.query({ type: "research.proposals", threadId: parent.threadId })).toEqual([]);
    } finally { ordinary(); unrelated(); await connection.close(); }
  });

  it("creates no lead or roles for a model proposal, then runs the user's final size and models end to end", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config, shellPollMs: 10 });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const frames: ShellFrame[] = [];
      unsubscribe = connection.subscribeShell({ researchProposals: [parent.threadId] }, (frame) => frames.push(frame), () => {});
      const proposed = callMoxenTool(connection, parent.threadId, "delegate", {
        task: "Check the claim", title: "Evidence", mode: "research", isolation: "shared",
        researchProposal: { size: { researchers: 8, critics: 3 }, models: { critic: { provider: "codex", model: "gpt-5.4" } } },
      });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: parent.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: parent.threadId });
      expect(proposal).toMatchObject({ target: "delegation", plan: { size: { researchers: 8, critics: 3 }, models: { critic: { provider: "codex", model: "gpt-5.4" } } } });
      await expect.poll(() => frames.some((frame) => frame.kind === "snapshot" && frame.snapshot.researchProposals?.some((entry) => entry.id === proposal!.id)), WAIT).toBe(true);
      expect(await store.listThreadIds()).toEqual([parent.threadId]);
      expect(await connection.query({ type: "research.run", threadId: parent.threadId })).toBeNull();
      await expect(connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan: { size: { researchers: 9, critics: 1 } } })).rejects.toThrow(/researchers 1 to 8/);
      expect(await connection.query({ type: "research.proposals", threadId: parent.threadId })).toHaveLength(1);
      const plan = { size: { researchers: 1, critics: 1 }, models: { researcher: { provider: "codex", model: "gpt-5.4", thinkingEffort: "high" } } };
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan });
      const result = await proposed;
      expect(result.isError).toBe(false);
      const leadId = JSON.parse(result.text).taskId as string;
      expect(await connection.query({ type: "research.run", threadId: leadId })).toMatchObject({ ...plan, roles: [] });
      await expect(connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan })).rejects.toThrow(/no longer pending/);
      const researcher = await connection.dispatch({ type: "research.role.start", leadThreadId: leadId, role: "researcher", question: "Evidence", provider: "claudeAgent", model: "ignored" });
      expect((await store.readThreadRecord(researcher.child.id))?.modelSelection).toMatchObject({ instanceId: "codex", model: "gpt-5.4", options: expect.arrayContaining([{ id: "effort", value: "high" }]) });
      await connection.dispatch({ type: "research.message.submit", threadId: researcher.child.id, text: "Sourced evidence" });
      const critic = await connection.dispatch({ type: "research.role.start", leadThreadId: leadId, role: "critic", question: "Challenge" });
      await connection.dispatch({ type: "research.message.submit", threadId: critic.child.id, text: "Evidence holds" });
      const finalizer = await connection.dispatch({ type: "research.role.start", leadThreadId: leadId, role: "finalizer", question: "Compose validated report" });
      await connection.dispatch({ type: "research.message.submit", threadId: finalizer.child.id, text: "Validated final report" });
      for (const threadId of [leadId, researcher.child.id, critic.child.id, finalizer.child.id]) {
        await expect.poll(async () => (await store.readTurns(threadId)).at(-1)?.status, WAIT).toBe("completed");
      }
      expect((await connection.query({ type: "research.run", threadId: leadId }))?.messages?.map((message) => message.kind)).toEqual(["handoff", "report", "handoff", "verdict", "handoff", "final"]);
      await expect.poll(async () => (await store.readMessages(parent.threadId)).filter((message) => message.origin === "task-notification").length, WAIT).toBe(1);
    } finally { unsubscribe(); await connection.close(); }
  });

  it.each(["single", "disconnect", "deadline"] as const)("falls back to one researcher on %s and rejects late answers", async (reason) => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      unsubscribe = connection.subscribeShell({ researchProposals: [parent.threadId] }, () => {}, () => {});
      const pending = connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Research", interactionMode: "research", researchProposal: { size: { researchers: 2, critics: 1 } }, wait: true });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: parent.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: parent.threadId });
      if (reason === "single") await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" });
      if (reason === "disconnect") {
        const second = connection.subscribeShell({ researchProposals: [parent.threadId] }, () => {}, () => {});
        unsubscribe();
        expect(await connection.query({ type: "research.proposals", threadId: parent.threadId })).toHaveLength(1);
        second();
      }
      if (reason === "deadline") {
        // Advance only the production deadline; provider I/O uses real timers.
        vi.spyOn(Date, "now").mockReturnValue(Date.parse(proposal!.expiresAt!) + 1);
        await connection.query({ type: "research.proposals", threadId: parent.threadId });
        vi.restoreAllMocks();
      }
      const result = await pending;
      expect(await connection.query({ type: "research.run", threadId: result.child.id })).toBeNull();
      expect(await store.listThreadIds()).toHaveLength(2);
      await expect(connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" })).rejects.toThrow(/no longer pending/);
    } finally { vi.restoreAllMocks(); unsubscribe(); await connection.close(); }
  });

  it("ends a user run only after lead and roles settle, restores tools, and starts a fresh run without losing the old one", async () => {
    const updates = new Map<string, readonly McpServerSpec[]>();
    const harness = await testHarness({ leaveTurnsRunning: true, onUpdateMcpServers: (id, servers) => updates.set(id, servers) });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: false, threadEnvMode: "local" });
      const store = await openThreadStore(harness.root);
      const settle = async (id: string) => {
        await expect.poll(async () => (await store.readTurns(id)).at(-1)?.status, WAIT).toBe("running");
        await connection.dispatch({ type: "thread.turn.interrupt", threadId: id });
        await expect.poll(async () => (await store.readTurns(id)).every((turn) => !["running", "queued"].includes(turn.status)), WAIT).toBe(true);
      };
      await settle(own.threadId);
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      const pending = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Check the claim" }, interactionMode: "research", wait: false });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      expect(proposal?.target).toBe("user-thread");
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan: { size: { researchers: 1, critics: 1 } } });
      await pending;
      const tools = await availableMoxenTools(connection, own.threadId, {});
      expect(tools.filter((tool) => ROLE_TOOLS.includes(tool.name)).map((tool) => tool.name)).toEqual(ROLE_TOOLS);
      expect(tools.some((tool) => DELEGATION_TOOLS.has(tool.name))).toBe(false);
      const liveTools = updates.get(own.threadId)?.find((server) => server.name === "moxen");
      expect(liveTools?.type === "in-process" && liveTools.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(ROLE_TOOLS));
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: own.threadId, role: "researcher", question: "Check" });
      await settle(own.threadId);
      expect((await connection.query({ type: "research.run", threadId: own.threadId }))?.state).toBe("running");
      await settle(role.child.id);
      const ended = await connection.query({ type: "research.run", threadId: own.threadId });
      expect(ended?.endedAt).toEqual(expect.any(String));
      expect((await availableMoxenTools(connection, own.threadId, {})).some((tool) => tool.name === "delegate")).toBe(true);
      expect((await availableMoxenTools(connection, own.threadId, {})).some((tool) => ROLE_TOOLS.includes(tool.name))).toBe(false);
      expect((await availableMoxenTools(connection, role.child.id, {})).some((tool) => DELEGATION_TOOLS.has(tool.name) || ROLE_TOOLS.includes(tool.name))).toBe(false);
      expect(await store.listThreadIds()).toHaveLength(2);
      expect((await store.readThreadRecord(own.threadId))?.interactionMode).toBe("default");
      await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Later turn" }, wait: false });
      expect((await connection.query({ type: "research.run", threadId: own.threadId }))?.endedAt).toBe(ended?.endedAt);
      const restored = updates.get(own.threadId)?.find((server) => server.name === "moxen");
      const restoredNames = restored?.type === "in-process" ? restored.tools?.map((tool) => tool.name) ?? [] : [];
      expect(restoredNames).toContain("delegate");
      expect(restoredNames.some((name) => ROLE_TOOLS.includes(name))).toBe(false);
      await settle(own.threadId);
      const second = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Fresh research" }, interactionMode: "research", wait: false });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [next] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: next!.id, choice: "start", plan: { size: { researchers: 1, critics: 1 } } });
      await second;
      const fresh = await connection.query({ type: "research.run", threadId: own.threadId });
      expect(fresh?.roles).toEqual([]);
      expect(fresh?.pastResearchRuns).toEqual([expect.objectContaining({ endedAt: ended?.endedAt, roles: [expect.objectContaining({ threadId: role.child.id })] })]);
      expect((await connection.query({ type: "research.run", threadId: role.child.id }))?.endedAt).toBe(ended?.endedAt);
      await expect(connection.dispatch({ type: "research.message.submit", threadId: role.child.id, text: "Stale report" })).rejects.toThrow(/member/);
      const newRole = await connection.dispatch({ type: "research.role.start", leadThreadId: own.threadId, role: "researcher", question: "Fresh evidence" });
      await settle(newRole.child.id);
      await settle(own.threadId);
      const delegated = await connection.dispatch({ type: "thread.delegate", parentThreadId: own.threadId, task: "Ordinary delegation", wait: false });
      await settle(delegated.child.id);
    } finally {
      unsubscribe();
      const store = await openThreadStore(harness.root);
      for (const threadId of await store.listThreadIds()) await connection.dispatch({ type: "thread.turn.interrupt", threadId });
      await connection.close();
    }
  });

  it("keeps a completed user's report and end state after later turns", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      const pending = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId,
        message: { text: "Original report" }, interactionMode: "research", wait: true });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id,
        choice: "start", plan: { size: { researchers: 1, critics: 1 } } });
      await pending;
      const ended = await connection.query({ type: "research.run", threadId: own.threadId });
      expect(ended).toMatchObject({ state: "completed", endedAt: expect.any(String), report: expect.stringContaining("Original report") });
      await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Later answer" }, wait: true });
      expect(await connection.query({ type: "research.run", threadId: own.threadId })).toMatchObject({
        state: "completed", endedAt: ended?.endedAt, report: ended?.report,
      });
    } finally { unsubscribe(); await connection.close(); }
  });

  it("offers the size picker for /research and the first prompt after switching to Research mode, with no answer deadline", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    const proposals = async (threadId: string) => await connection.query({ type: "research.proposals", threadId });
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "research" });
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBe(true);
      const first = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "First question" }, wait: true });
      await expect.poll(async () => (await proposals(own.threadId)).length, WAIT).toBe(1);
      const [proposal] = await proposals(own.threadId);
      expect(proposal).toMatchObject({ target: "user-thread", expiresAt: null });
      // A user's own proposal has no deadline: far in the future it is still waiting.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 3_600_000);
      expect(await proposals(own.threadId)).toHaveLength(1);
      vi.restoreAllMocks();
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" });
      await first;
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBeUndefined();
      // Answered once: later messages in the mode do not ask again.
      await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Second question" }, wait: true });
      expect(await proposals(own.threadId)).toEqual([]);
      // Switching out and back in arms it again; `/research` always asks.
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "default" });
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "research" });
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBe(true);
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "default" });
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBeUndefined();
      const oneOff = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Slash" }, interactionMode: "research", wait: true });
      await expect.poll(async () => (await proposals(own.threadId)).length, WAIT).toBe(1);
      await connection.dispatch({ type: "research.proposal.answer", proposalId: (await proposals(own.threadId))[0]!.id, choice: "single" });
      await oneOff;
    } finally { vi.restoreAllMocks(); unsubscribe(); await connection.close(); }
  });

  it("marks a thread created in Research mode, so its first prompt asks the run size", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    const proposals = async (threadId: string) => await connection.query({ type: "research.proposals", threadId });
    try {
      const project = await connection.dispatch({ type: "project.ensure", cwd: harness.work });
      // The TUI generates the id up front and sends no mode with the turn.
      const threadId = randomUUID();
      await connection.dispatch({ type: "thread.create", threadId, projectId: project.project.id, title: "Fresh research", interactionMode: "research" });
      expect((await store.readThreadRecord(threadId))?.researchPicker).toBe(true);
      unsubscribe = connection.subscribeShell({ researchProposals: [threadId] }, () => {}, () => {});
      const first = connection.dispatch({ type: "thread.turn.start", threadId, message: { text: "First question" }, wait: true });
      await expect.poll(async () => (await proposals(threadId)).length, WAIT).toBe(1);
      const [proposal] = await proposals(threadId);
      expect(proposal).toMatchObject({ target: "user-thread", expiresAt: null });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" });
      await first;
      expect((await store.readThreadRecord(threadId))?.researchPicker).toBeUndefined();
      // Answered once: a later prompt in the mode does not ask again.
      await connection.dispatch({ type: "thread.turn.start", threadId, message: { text: "Second question" }, wait: true });
      expect(await proposals(threadId)).toEqual([]);
      expect((await store.readThreadRecord(threadId))?.researchPicker).toBeUndefined();
    } finally { unsubscribe(); await connection.close(); }
  });

  it("never marks delegated children, research roles or handoffs, so they never ask", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      // A delegated Research task runs as one researcher, with no question.
      const delegated = await connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Scout ahead", interactionMode: "research", wait: true, notify: false });
      expect((await store.readThreadRecord(delegated.child.id))?.researchPicker).toBeUndefined();
      expect(await connection.query({ type: "research.run", threadId: delegated.child.id })).toBeNull();
      expect(await connection.query({ type: "research.proposals", threadId: delegated.child.id })).toEqual([]);
      // A research role thread is Research from birth and still never asks.
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: true, notify: false }, { researchers: 1, critics: 1 });
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Gather evidence" });
      expect((await store.readThreadRecord(role.child.id))?.researchPicker).toBeUndefined();
      expect(await connection.query({ type: "research.proposals", threadId: role.child.id })).toEqual([]);
      // A handoff born in Research mode runs its prompt and asks on no later one.
      const moved = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Carried on", wait: true, threadEnvMode: "local", interactionMode: "research" });
      expect((await store.readThreadRecord(moved.threadId))?.researchPicker).toBeUndefined();
      unsubscribe = connection.subscribeShell({ researchProposals: [moved.threadId] }, () => {}, () => {});
      await connection.dispatch({ type: "thread.turn.start", threadId: moved.threadId, message: { text: "Follow up" }, wait: true });
      expect(await connection.query({ type: "research.proposals", threadId: moved.threadId })).toEqual([]);
      expect((await store.readThreadRecord(moved.threadId))?.researchPicker).toBeUndefined();
    } finally { unsubscribe(); await connection.close(); }
  });

  it("asks nothing while a full run is active, even on an idle lead", async () => {
    const harness = await testHarness({ leaveTurnsRunning: true });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: false, threadEnvMode: "local" });
      await expect.poll(async () => (await store.readTurns(own.threadId)).at(-1)?.status, WAIT).toBe("running");
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: own.threadId });
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "research" });
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      const asking = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Research me" }, wait: false });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan: { size: { researchers: 1, critics: 1 } } });
      await asking;
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: own.threadId, role: "researcher", question: "Gather evidence" });
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("running");
      // The lead's turn stops but its role is still working: the run stays
      // active while the thread is idle.
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: own.threadId });
      await expect.poll(async () => (await connection.query({ type: "research.run", threadId: own.threadId }))?.state, WAIT).toBe("running");
      // A one-off `/research` while the run is active starts a plain turn: no new question.
      await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "More" }, interactionMode: "research", wait: false });
      expect(await connection.query({ type: "research.proposals", threadId: own.threadId })).toEqual([]);
    } finally {
      unsubscribe();
      for (const threadId of await store.listThreadIds()) await connection.dispatch({ type: "thread.turn.interrupt", threadId });
      await connection.close();
    }
  });

  it("does not propose research while busy and preserves mode-lock and delivery semantics", async () => {
    const harness = await testHarness({ leaveTurnsRunning: true });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Busy", wait: false, threadEnvMode: "local" });
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      await expect(connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Research" }, interactionMode: "research", delivery: "queue", wait: false })).rejects.toMatchObject({ code: "MODE_LOCKED_WHILE_RUNNING" });
      expect(await connection.query({ type: "research.proposals", threadId: own.threadId })).toEqual([]);
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: own.threadId });
    } finally { unsubscribe(); await connection.close(); }
  });

  it("parks the size question when a queued row is present instead of spending it", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      // A scheduled message queues while the thread is idle; it must not spend the question.
      const scheduled = await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Later" }, scheduledFor: new Date(Date.now() + 3_600_000).toISOString(), wait: false });
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "research" });
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBe(true);
      // Sticky Research mode carries no interactionMode of its own.
      const parked = await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "First question" }, wait: true });
      expect(parked.researchSizePending).toBe(true);
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBe(true);
      expect(await connection.query({ type: "research.proposals", threadId: own.threadId })).toEqual([]);
      // Once the queue clears, the same question is asked on the next send.
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: own.threadId, turnId: scheduled.turnId });
      const asking = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "First question" }, wait: false });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" });
      await asking;
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBeUndefined();
    } finally { unsubscribe(); await connection.close(); }
  });

  it("keeps the size question when no client listens yet, and asks once one does", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "research" });
      // No opt-in: the send waits for one, then parks the question instead of spending it.
      const parked = await connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "First question" }, wait: true });
      expect(parked.researchSizePending).toBe(true);
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBe(true);
      expect(await connection.query({ type: "research.proposals", threadId: own.threadId })).toEqual([]);
      // A late opt-in still gets the question on the next send.
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      const asking = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "First question" }, wait: false });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" });
      await asking;
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBeUndefined();
    } finally { unsubscribe(); await connection.close(); }
  });

  it("still asks when the opt-in lands while the send waits for it", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      await connection.dispatch({ type: "thread.interaction-mode.set", threadId: own.threadId, interactionMode: "research" });
      const asking = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "First question" }, wait: false });
      await new Promise((resolve) => setTimeout(resolve, 100));
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      // The flag is spent only because a proposal exists to answer.
      expect((await store.readThreadRecord(own.threadId))?.researchPicker).toBeUndefined();
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "single" });
      await asking;
      expect(await connection.query({ type: "research.proposals", threadId: own.threadId })).toEqual([]);
    } finally { unsubscribe(); await connection.close(); }
  });

  it.each([1, 8])("enforces %i total researchers atomically without orphans or reusing a settled slot", async (researchers) => {
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
      expect(refused?.status === "rejected" && String(refused.reason)).toMatch(new RegExp(`Researcher total cap is ${researchers}`));
      expect((await store.listThreadIds()).length - before.length).toBe(researchers);
      expect((await connection.query({ type: "research.run", threadId: lead.child.id }))?.size).toEqual({ researchers, critics: 1 });
      const done = accepted[0]!.child.id;
      await expect.poll(async () => (await store.readTurns(done)).at(-1)?.status, WAIT).toBe("running");
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: done });
      await expect.poll(async () => (await store.readTurns(done)).at(-1)?.status, WAIT).toBe("interrupted");
      await expect(start()).rejects.toThrow(`Researcher total cap is ${researchers}`);
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
      for (const size of [{ researchers: 9, critics: 1 }, { researchers: 1, critics: 2 }, { researchers: 1, critics: 4 }, { researchers: 0, critics: 1 }, { researchers: 1, critics: 0 }]) await expect(connection.startResearchRun(request, size)).rejects.toThrow(/researchers 1 to 8 and critics 1 or 3/);
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
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Evidence" });
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("completed");
      await expect(connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "More" })).rejects.toThrow(/Researcher total cap is 1/);
    } finally { await connection.close(); }
  }, 20_000);

  it("scopes run messages to the calling role and gates finalization on every critic verdict", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: true }, { researchers: 8, critics: 3 });
      const other = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Private run", wait: true }, { researchers: 8, critics: 3 });
      expect((await connection.query({ type: "research.run", threadId: lead.child.id }))?.size).toEqual({ researchers: 8, critics: 3 });
      const start = (role: "researcher" | "critic" | "finalizer") => connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role, question: "Check" });
      await expect(start("finalizer")).rejects.toThrow(/verdict/i);
      const researcher = await start("researcher");
      expect((await callMoxenTool(connection, researcher.child.id, "research_message_submit", { text: "Evidence" })).isError).toBe(false);
      const secondReport = await connection.dispatch({ type: "research.message.submit", threadId: researcher.child.id, text: "More evidence before review" });
      expect(secondReport.findings).toBe(1);
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
      expect((await callMoxenTool(connection, critics[0]!.child.id, "research_message_submit", { text: "Forbidden fourth verdict on new findings" })).isError).toBe(true);
      for (const critic of critics.slice(1)) expect((await callMoxenTool(connection, critic.child.id, "research_message_submit", { text: "Revalidated" })).isError).toBe(false);
      const finalizer = await start("finalizer");
      await expect(start("finalizer")).rejects.toThrow(/Finalizer agent cap is 1/);
      expect((await callMoxenTool(connection, finalizer.child.id, "research_message_submit", { text: "Final report" })).isError).toBe(false);
      const messages = (await connection.query({ type: "research.run", threadId: lead.child.id }))?.messages;
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "followup", text: "Recheck the evidence" }),
        expect.objectContaining({ kind: "verdict", round: 3, findings: 1 }),
        expect.objectContaining({ kind: "verdict", round: 2, findings: 2 }),
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
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Investigate", wait: true }, { researchers: 8, critics: 3 });
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
      await expect(connection.dispatch({ type: "thread.delegate", parentThreadId: lead.child.id, task: "Escape" })).rejects.toThrow(/cannot delegate/);
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

  it("never writes a lead or role record without its research field, so a shell poll can't lose it", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const write = vi.spyOn(ThreadStore.prototype, "writeThreadRecord");
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      write.mockClear();
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Report", wait: false }, { researchers: 1, critics: 1 });
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Evidence" });
      const records = write.mock.calls.map(([record]) => record);
      const leadRecords = records.filter((record) => record.id === lead.child.id);
      const roleRecords = records.filter((record) => record.id === role.child.id);
      expect(leadRecords.length).toBeGreaterThan(0);
      expect(roleRecords.length).toBeGreaterThan(0);
      expect(leadRecords.every((record) => record.researchRun !== undefined)).toBe(true);
      expect(roleRecords.every((record) => record.researchRole !== undefined)).toBe(true);
    } finally { write.mockRestore(); await connection.close(); }
  });

  it("persists roles across connections and reports only the lead to the orchestrator", async () => {
    const harness = await testHarness();
    const options = { storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config, shellPollMs: 10 };
    let connection = new DirectConnection(options);
    const frames: ShellFrame[] = [];
    const errors: unknown[] = [];
    const unsubscribe = connection.subscribeShell({}, (frame) => frames.push(frame), (error) => errors.push(error));
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Final report", wait: false }, { researchers: 8, critics: 3 });
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
      const lead = await connection.startResearchRun({
        parentThreadId: parent.threadId, task: "Investigate", wait: false, notify: false,
        research: { size: { researchers: 8, critics: 3 }, models: { researcher: { provider: "codex", model: "gpt-5.4", thinkingEffort: "high" } } },
      }, { researchers: 8, critics: 3 });
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

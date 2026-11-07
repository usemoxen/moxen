/**
 * The run view reads what core writes: these cases start real runs through
 * the server (fake providers) and read the shell the way the TUI does, so a
 * field the projection leans on cannot drift unnoticed. Client-side on
 * purpose, like `toolactivity.test.ts`: the reader asserting it can read.
 */
import { describe, expect, it } from "vitest";

import { testHarness } from "../../../core/testing/harness.js";
import { openThreadStore } from "../../../core/threads/store.js";
import type { ShellFrame } from "../../../server/api.js";
import { DirectConnection } from "../../../server/connection.js";
import {
  agentAt, columnWidths, defaultAgentIndex, focusRoleOf, isSliver, latestRunOf, MIN_COLUMN_WIDTH, NARROW_BELOW, roleThreadIds, rosterOf, runElapsedMs, SLIVER_WIDTH, stepAgent, summarizeRun,
} from "../researchrun.js";
import { buildSidebarSections } from "../sidebar.js";
import { applyShellFrame, emptyShellState, type ShellState } from "../shell.js";

const WAIT = { timeout: 10_000 };

async function shellOf(connection: DirectConnection): Promise<ShellState> {
  let state = emptyShellState();
  const stop = connection.subscribeShell({}, (frame: ShellFrame) => { state = applyShellFrame(state, frame); }, () => undefined);
  await expect.poll(() => state.synchronized && state.threads.length > 0, WAIT).toBe(true);
  stop();
  return state;
}

describe("the research run as the shell carries it", () => {
  // Two role turns plus the shell sync, each with its own ten-second poll:
  // a loaded runner does not fit in the twenty-second default.
  it("shows a real run: the lead's row stands for the run, its roles have none, and each slot has a state", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const lead = await connection.startResearchRun({ parentThreadId: parent.threadId, task: "Retry strategies", wait: false, notify: false }, { researchers: 4, critics: 3 });
      const researcher = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "researcher", question: "Read the retry code" });
      await expect.poll(async () => (await store.readTurns(researcher.child.id)).at(-1)?.status, WAIT).toBe("completed");
      const critic = await connection.dispatch({ type: "research.role.start", leadThreadId: lead.child.id, role: "critic", question: "Check the claims" });
      await expect.poll(async () => (await store.readTurns(critic.child.id)).at(-1)?.status, WAIT).toBe("completed");

      const shell = await shellOf(connection);
      const run = latestRunOf(shell.researchRuns, lead.child.id);
      expect(run).not.toBeNull();
      expect(roleThreadIds(shell.researchRuns)).toEqual(new Set([researcher.child.id, critic.child.id]));
      const summary = summarizeRun(run!, shell.threads);
      // Over, so the slots nobody started are dropped from the roster.
      expect(summary.agents.researcher.map((agent) => agent.state)).toEqual(["done"]);
      expect(summary.agents.critic.map((agent) => agent.state)).toEqual(["done"]);
      expect(summary.agents.critic.map((agent) => agent.lens)).toEqual(["evidence"]);
      expect(summary.agents.finalizer).toHaveLength(1);
      // The fake lead answered at once and every role it started settled: the run is over, whatever slots are left.
      expect(summary).toMatchObject({ phase: "finished", ended: true });
      expect(rosterOf(summary)).toHaveLength(1 + 1 + 1);

      const sections = buildSidebarSections(shell, { settledExpanded: true, settledLimit: 50, now: Date.now() });
      const rows = [...sections.active, ...sections.settled];
      expect(rows.some((row) => row.thread.id === researcher.child.id || row.thread.id === critic.child.id)).toBe(false);
      expect(rows.find((row) => row.thread.id === lead.child.id)?.research).toBe(true);
      expect(rows.find((row) => row.thread.id === parent.threadId)?.research).toBe(false);
    } finally { await connection.close(); }
  }, 60_000);

  it("shows a role that is still working as working, and a user's own thread as the lead of its run", async () => {
    const harness = await testHarness({ leaveTurnsRunning: true });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const store = await openThreadStore(harness.root);
    let unsubscribe = () => {};
    try {
      const own = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Webhook options", wait: false, threadEnvMode: "local" });
      await expect.poll(async () => (await store.readTurns(own.threadId)).at(-1)?.status, WAIT).toBe("running");
      await connection.dispatch({ type: "thread.turn.interrupt", threadId: own.threadId });
      unsubscribe = connection.subscribeShell({ researchProposals: [own.threadId] }, () => {}, () => {});
      const pending = connection.dispatch({ type: "thread.turn.start", threadId: own.threadId, message: { text: "Compare" }, interactionMode: "research", wait: false });
      await expect.poll(async () => (await connection.query({ type: "research.proposals", threadId: own.threadId })).length, WAIT).toBe(1);
      const [proposal] = await connection.query({ type: "research.proposals", threadId: own.threadId });
      await connection.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan: { size: { researchers: 2, critics: 1 } } });
      await pending;
      const role = await connection.dispatch({ type: "research.role.start", leadThreadId: own.threadId, role: "researcher", question: "Look" });
      await expect.poll(async () => (await store.readTurns(role.child.id)).at(-1)?.status, WAIT).toBe("running");

      const shell = await shellOf(connection);
      const summary = summarizeRun(latestRunOf(shell.researchRuns, own.threadId)!, shell.threads);
      expect(summary.agents.researcher.map((agent) => agent.state)).toEqual(["working", "waiting"]);
      expect(summary.agents.critic.map((agent) => agent.lens)).toEqual(["all"]);
      expect(summary.phase).toBe("researching");
      expect(runElapsedMs(summary, Date.parse(summary.run.createdAt) + 61_000)).toBe(61_000);
    } finally {
      unsubscribe();
      for (const threadId of await store.listThreadIds()) await connection.dispatch({ type: "thread.turn.interrupt", threadId });
      await connection.close();
    }
  });
});

describe("the run view's layout rules", () => {
  const run = (roles: Array<{ role: "researcher" | "critic" | "finalizer"; state: "running" | "completed" }>) => {
    const threads = roles.map((entry, at) => ({
      id: `r${at}`, projectId: "p", title: "x", archivedAt: null,
      latestTurn: { turnId: "t", state: entry.state, requestedAt: "", startedAt: "", completedAt: null, assistantMessageId: null },
      session: { threadId: `r${at}`, status: entry.state === "running" ? "running" : "idle", providerName: null, runtimeMode: "full-access", activeTurnId: null, lastError: null, updatedAt: "" },
    })) as never[];
    return summarizeRun({
      leadThreadId: "lead", size: { researchers: 4, critics: 3 }, state: "running", createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:04:12.000Z",
      roles: roles.map((entry, at) => ({ threadId: `r${at}`, role: entry.role, question: "q" })),
    }, threads);
  };

  it("makes the phase's column wide, shrinks a column nothing started in to a sliver, and keeps every column readable", () => {
    const researching = run([{ role: "researcher", state: "running" }, { role: "researcher", state: "completed" }]);
    const first = columnWidths(researching, 100)!;
    expect(first.researcher).toBeGreaterThan(first.critic);
    expect(isSliver(first, "critic")).toBe(true);
    expect(isSliver(first, "finalizer")).toBe(true);
    expect(first.researcher + first.critic + first.finalizer).toBe(100);

    const reviewing = run([{ role: "researcher", state: "completed" }, { role: "critic", state: "running" }]);
    expect(focusRoleOf(reviewing)).toBe("critic");
    const second = columnWidths(reviewing, 100)!;
    expect(second.critic).toBeGreaterThan(second.researcher);
    expect(isSliver(second, "finalizer")).toBe(true);
    expect(second.researcher).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);

    const finished = run([{ role: "researcher", state: "completed" }, { role: "critic", state: "completed" }, { role: "finalizer", state: "completed" }]);
    const third = columnWidths(finished, NARROW_BELOW)!;
    expect(third.finalizer).toBeGreaterThan(SLIVER_WIDTH);
    expect(Object.values(third).reduce((all, width) => all + width, 0)).toBe(NARROW_BELOW);
    for (const role of ["researcher", "critic", "finalizer"] as const) expect(third[role]).toBeGreaterThanOrEqual(SLIVER_WIDTH);
  });

  it("shows one column at a time below the width three columns need", () => {
    expect(columnWidths(run([{ role: "researcher", state: "running" }]), NARROW_BELOW - 1)).toBeNull();
  });

  it("walks the roster across roles and wraps, and follows the agent at work until one is picked", () => {
    const summary = run([{ role: "researcher", state: "completed" }, { role: "researcher", state: "running" }, { role: "critic", state: "running" }]);
    expect(defaultAgentIndex(summary, "researcher")).toBe(1);
    expect(stepAgent(summary, { role: "researcher", index: 3 }, 1)).toEqual({ role: "critic", index: 0 });
    expect(stepAgent(summary, { role: "researcher", index: 0 }, -1)).toEqual({ role: "finalizer", index: 0 });
    expect(agentAt(summary, { role: "finalizer", index: 0 })?.state).toBe("waiting");
  });
});

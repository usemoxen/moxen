import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { testHarness, type TestHarnessOptions } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import { CliError } from "../../errors.js";
import { createThread, sendTurn, openTurn, completeTurn, interruptTurn, archiveThread, deleteThread, settleThread } from "../threads.js";
import {
  beginResearchRun,
  continueOwnThread,
  continueThread,
  MAX_CONSECUTIVE_AGENT_CONTINUATIONS,
  runWorkQueue,
  type OperationContext,
} from "../operations.js";
import type { TurnDriver } from "../execute.js";

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof CliError) return cause.code;
    throw cause;
  }
  return "<no error>";
}

async function world(options: TestHarnessOptions = {}) {
  const sent: { threadId: string; prompt: string }[] = [];
  const harness = await testHarness({ onSendTurn: (turn) => sent.push(turn), ...options });
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (id) => {
      const kind = driverKindOfInstance(id)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = harness.drivers[kind]!();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
  const make = (title: string) =>
    createThread(harness.store, {
      projectId: "p",
      title,
      env: { mode: "local", path: harness.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
  return { ...harness, ctx, sent, make };
}

describe("continueOwnThread: what the palette path refuses", () => {
  it("refuses a missing, deleted, archived or settled thread", async () => {
    const w = await world();
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: "ghost", summary: "Work left." }))).toBe("THREAD_NOT_FOUND");

    const deleted = await w.make("deleted");
    await sendTurn(w.store, deleted.id, { prompt: "Work" });
    await deleteThread(w.store, deleted.id);
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: deleted.id, summary: "Work left." }))).toBe("THREAD_NOT_FOUND");

    const archived = await w.make("archived");
    await sendTurn(w.store, archived.id, { prompt: "Work" });
    await archiveThread(w.store, archived.id);
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: archived.id, summary: "Work left." }))).toBe("THREAD_ARCHIVED");

    const settled = await w.make("settled");
    const done = (await sendTurn(w.store, settled.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, settled.id, done.id, { text: "Done." });
    await settleThread(w.store, settled.id);
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: settled.id, summary: "Work left." }))).toBe("THREAD_SETTLED");
  });

  it("refuses a research lead and a research role", async () => {
    const w = await world();
    const lead = await w.make("lead");
    const first = (await sendTurn(w.store, lead.id, { prompt: "Research" })).turn;
    await completeTurn(w.store, lead.id, first.id, { text: "Started." });
    await beginResearchRun(w.ctx, lead.id, { size: { researchers: 1, critics: 1 } });
    await sendTurn(w.store, lead.id, { prompt: "Keep researching" });
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: lead.id, summary: "Work left." }))).toBe(
      "THREAD_CONTINUE_RESEARCH",
    );

    const role = await w.make("role");
    await w.store.withThreadLock(role.id, async () => {
      const current = await w.store.readThreadRecord(role.id);
      if (current) await w.store.writeThreadRecord({ ...current, researchRole: { leadThreadId: lead.id, role: "researcher" } });
    });
    await sendTurn(w.store, role.id, { prompt: "Gather evidence" });
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: role.id, summary: "Work left." }))).toBe(
      "THREAD_CONTINUE_RESEARCH",
    );
  });

  it("refuses an empty or overlong handoff", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: source.id, summary: "   " }))).toBe("INVALID_HANDOFF");
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: source.id, summary: "x".repeat(64_001) }))).toBe(
      "INVALID_HANDOFF",
    );
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: source.id, summary: "Left.", firstMessage: "  " }))).toBe(
      "INVALID_HANDOFF",
    );
  });
});

describe("continueOwnThread: consecutive agent continuations", () => {
  it("allows three in a row, then refuses until the user speaks", async () => {
    expect(MAX_CONSECUTIVE_AGENT_CONTINUATIONS).toBe(3);
    const w = await world();
    let id = (await w.make("solo")).id;
    await sendTurn(w.store, id, { prompt: "Work" });
    for (let hop = 1; hop <= MAX_CONSECUTIVE_AGENT_CONTINUATIONS; hop++) {
      id = (await continueOwnThread(w.ctx, { threadId: id, summary: `Hop ${hop}.` })).threadId;
      await settleRuns();
    }
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: id, summary: "One too many." }))).toBe("THREAD_CONTINUE_LIMIT");

    // The user speaking in the newest thread resets the count.
    await sendTurn(w.store, id, { prompt: "Hold on, do it differently", delivery: "queue" });
    const resumed = await continueOwnThread(w.ctx, { threadId: id, summary: "After the user stepped in." });
    expect((await w.store.readThreadRecord(resumed.threadId))?.continuedFrom).toBe(id);
  });

  it("a user's palette continue in the middle never counts", async () => {
    const w = await world();
    let id = (await w.make("solo")).id;
    await sendTurn(w.store, id, { prompt: "Work" });
    for (let hop = 1; hop <= 2; hop++) {
      id = (await continueOwnThread(w.ctx, { threadId: id, summary: `Hop ${hop}.` })).threadId;
      await settleRuns();
    }
    // The user takes it over by hand: a fresh streak starts after this hop.
    id = (await continueThread(w.ctx, { threadId: id })).threadId;
    await settleRuns();
    for (let hop = 1; hop <= MAX_CONSECUTIVE_AGENT_CONTINUATIONS; hop++) {
      id = (await continueOwnThread(w.ctx, { threadId: id, summary: `Again ${hop}.` })).threadId;
      await settleRuns();
    }
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: id, summary: "One too many." }))).toBe("THREAD_CONTINUE_LIMIT");
  });

  it("an orphan reservation names no created thread and never trips the rule", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });
    // A crash between reservation and creation leaves a note for a thread
    // that was never created. A retry must finish the job, not refuse.
    const orphanId = w.store.newId();
    await w.store.appendLedger(source.id, "activity", {
      id: w.store.newId(),
      threadId: source.id,
      turnId: null,
      kind: "thread.continued",
      summary: "Continued in a crash",
      payload: { threadId: orphanId, title: "solo (continued)", scheduledFor: null, automatic: false, byAgent: true },
      createdAt: w.store.nowIso(),
    });
    const continued = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    expect(continued.threadId).toBe(orphanId);
    expect(await w.store.readThreadRecord(orphanId)).not.toBeNull();
  });

  it("runs the new thread on the requested model", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });
    const continued = await continueOwnThread(w.ctx, {
      threadId: source.id,
      summary: "Half done.",
      modelSelection: { instanceId: "codex", model: "other-model" },
    });
    expect((await w.store.readThreadRecord(continued.threadId))?.modelSelection).toEqual({ instanceId: "codex", model: "other-model" });
    // The source keeps its own.
    expect((await w.store.readThreadRecord(source.id))?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
  });

  it("a retry with the same idempotency key returns the first continuation", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });
    const first = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done.", idempotencyKey: "k1" });
    const second = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done.", idempotencyKey: "k1" });
    expect(second.threadId).toBe(first.threadId);
    expect(second.adoptedTasks).toEqual(first.adoptedTasks);
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(1);
    // A different key on the same already-continued thread rejoins it
    // instead of forking a second destination (streak counts chains, and
    // this thread starts none).
    const rejoined = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Other.", idempotencyKey: "k2" });
    expect(rejoined.threadId).toBe(first.threadId);
  });

  it("a retry with different text keeps the first summary and says so", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });
    const first = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done.", idempotencyKey: "k1" });
    const replayed = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Completely rewritten.", idempotencyKey: "k1" });
    expect(replayed.threadId).toBe(first.threadId);
    expect(replayed.note).toContain("first summary was kept");
    const prompt = (await w.store.readMessages(first.threadId)).find((message) => message.role === "user")!.text;
    expect(prompt).toContain("Half done.");
    expect(prompt).not.toContain("Completely rewritten.");
  });

  it("refuses a thread held by usage protection, and leaves the palette path alone", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });
    await w.store.withThreadLock(source.id, async () => {
      const current = await w.store.readThreadRecord(source.id);
      if (current) await w.store.writeThreadRecord({ ...current, usagePause: { provider: "codex", phase: "waiting", resetsAt: null, order: 1, handoff: false } });
    });
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." }))).toBe(
      "THREAD_CONTINUE_PROTECTED",
    );
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
    // The user's own action is unchanged: it still continues a held thread.
    const continued = await continueThread(w.ctx, { threadId: source.id });
    expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(source.id);
  });
});

describe("continueOwnThread: the shared continuation", () => {
  it("opens the new thread with the agent's summary, its first task, and every delegated task", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const running = await w.make("still running");
    const done = await w.make("already done");
    const now = new Date().toISOString();
    for (const [id, child] of [["r", running], ["d", done]] as const) {
      await w.store.appendDelegation({ id, parentThreadId: parent.id, childThreadId: child.id, prompt: id, status: "running", notify: true, createdAt: now, updatedAt: now });
    }
    await sendTurn(w.store, running.id, { prompt: "A" });
    const finished = (await sendTurn(w.store, done.id, { prompt: "B" })).turn;
    await completeTurn(w.store, done.id, finished.id, { text: "Done." });
    await sendTurn(w.store, parent.id, { prompt: "Orchestrate" });

    const continued = await continueOwnThread(w.ctx, {
      threadId: parent.id,
      summary: "Goal: ship it. Done: scaffolding. Next: wire the handler.",
      firstMessage: "Wire the handler and run the tests.",
    });
    expect(continued.adoptedTasks).toHaveLength(2);
    expect(continued.adoptedTasks).toMatchObject([{ taskId: running.id }, { taskId: done.id }]);
    // Every delegation moves to the new thread, finished ones included:
    // the old thread owns nothing afterwards.
    expect((await w.store.readDelegations()).find((row) => row.id === "d")?.parentThreadId).toBe(continued.threadId);
    expect((await w.store.readDelegations()).find((row) => row.id === "r")?.parentThreadId).toBe(continued.threadId);

    const prompt = (await w.store.readMessages(continued.threadId)).find((message) => message.role === "user")!.text;
    expect(prompt).toContain("## Model's wrap-up");
    expect(prompt).toContain("Next: wire the handler.");
    expect(prompt).toContain("## What to do first");
    expect(prompt).toContain("Wire the handler and run the tests.");
    expect(prompt).toContain(`"still running" (taskId ${running.id})`);
    expect(prompt).toContain(`"already done" (taskId ${done.id})`);
    const note = (await w.store.readActivities(parent.id)).find((activity) => activity.kind === "thread.continued");
    expect(note?.payload?.byAgent).toBe(true);
    expect(note?.payload?.threadId).toBe(continued.threadId);
  });

  it("a delegated child cannot continue itself: it reports back instead", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    await sendTurn(w.store, child.id, { prompt: "Build it" });

    // A delegated task's long work is compacted in place; only its own
    // agent's top-level thread moves to a new one.
    expect(await codeOf(() => continueOwnThread(w.ctx, { threadId: child.id, summary: "Half built." }))).toBe(
      "THREAD_CONTINUE_DELEGATED",
    );
    expect((await w.store.readDelegations()).find((row) => row.id === "d1")?.continuedIn).toBeUndefined();
    expect((await w.store.readActivities(child.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
  });
});

describe("continueOwnThread: mid-turn ordering", () => {
  it("holds the new thread until the calling turn ends, then starts it with the summary", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Do the long task" })).turn;

    const continued = await continueOwnThread(w.ctx, {
      threadId: source.id,
      summary: "Goal: the long task. Done: half. Next: the rest.",
      firstMessage: "Do the rest.",
    });
    // Queued behind the calling turn, not started in parallel with it.
    expect((await w.store.readTurns(continued.threadId)).map((turn) => turn.status)).toEqual(["queued"]);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent).toEqual([]);
    const blocked = await w.store.readTurns(continued.threadId);
    expect(blocked).toHaveLength(1);

    await completeTurn(w.store, source.id, running.id, { text: "Wrapping up." });
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([continued.threadId]);
    expect(w.sent[0]!.prompt).toContain("Next: the rest.");
    expect(w.sent[0]!.prompt).toContain("Do the rest.");
  });

  it("waits while the source still has queued work, even after the calling turn ends", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Do the long task" })).turn;
    await sendTurn(w.store, source.id, { prompt: "Queued behind", delivery: "queue" });
    const continued = await continueOwnThread(w.ctx, {
      threadId: source.id,
      summary: "Goal: the long task. Done: half. Next: the rest.",
      firstMessage: "Do the rest.",
    });
    await completeTurn(w.store, source.id, running.id, { text: "Wrapping up." });
    // The queued turn was promoted: the source is still busy, so the new thread waits.
    expect(openTurn(await w.store.readTurns(source.id))).not.toBeNull();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(continued.threadId)).map((turn) => turn.status)).toEqual(["queued"]);
    expect(w.sent).toEqual([]);

    await interruptTurn(w.store, source.id);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(continued.threadId)).map((turn) => turn.status)).toEqual(["completed"]);
    expect(w.sent.map((turn) => turn.threadId)).toEqual([continued.threadId]);
  });

  it("lets a later plain send on the source run alongside the started destination", async () => {
    const w = await world({ leaveTurnsRunning: true });
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Do the long task" })).turn;
    const continued = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    await interruptTurn(w.store, source.id, running.id);
    await runWorkQueue(w.ctx);
    expect((await w.store.readTurns(continued.threadId)).map((turn) => turn.status)).toEqual(["running"]);
    // The user's own choice: the old thread resumes and runs in parallel.
    const followUp = await sendTurn(w.store, source.id, { prompt: "One more thing" });
    expect(followUp.turn.status).toBe("running");
    expect(openTurn(await w.store.readTurns(continued.threadId))).not.toBeNull();
  });
  it("starts at once when the source is idle", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done for now." });

    const continued = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Follow-up work remains." });
    expect(openTurn(await w.store.readTurns(continued.threadId))).not.toBeNull();
  });

  it("still starts the new thread at once on the palette path, with a turn running", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "Work" });

    const continued = await continueThread(w.ctx, { threadId: source.id });
    // The user-facing path is unchanged: the destination starts immediately.
    expect(openTurn(await w.store.readTurns(continued.threadId))).not.toBeNull();
    await settleRuns();
  });
});

describe("continueOwnThread: the old thread stays quiet", () => {
  function watch(w: Awaited<ReturnType<typeof world>>) {
    const driver = w.ctx.driverFor("codex") as TurnDriver & { stopSession?: unknown };
    const stopped: string[] = [];
    driver.stopSession = (threadId: string) => Effect.sync(() => void stopped.push(threadId));
    return { stopped };
  }

  it("closes the source session once its turn settles, not before", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const calls = watch(w);

    await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    expect(calls.stopped).toEqual([]);

    await completeTurn(w.store, source.id, running.id, { text: "Wrapping up." });
    await vi.waitFor(() => expect(calls.stopped).toEqual([source.id]), { timeout: 8_000 });
  });

  it("keeps the session while queued work on the source takes over", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await sendTurn(w.store, source.id, { prompt: "Queued behind", delivery: "queue" });
    const calls = watch(w);

    await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    // Settling promotes the queued turn, which keeps the session.
    await completeTurn(w.store, source.id, running.id, { text: "Wrapping up." });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(openTurn(await w.store.readTurns(source.id))).not.toBeNull();
    expect(calls.stopped).toEqual([]);

    await interruptTurn(w.store, source.id);
    await vi.waitFor(() => expect(calls.stopped).toEqual([source.id]), { timeout: 8_000 });
  });

  it("orders the close before a turn that starts right as the old one settles", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const calls = watch(w);

    await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    expect(calls.stopped).toEqual([]);

    // The close re-checks under the thread lock: a turn starting in the gap
    // queues behind the check instead of racing it, so the session still closes.
    await completeTurn(w.store, source.id, running.id, { text: "Wrapping up." });
    const followUp = await sendTurn(w.store, source.id, { prompt: "Right after" });
    expect(followUp.turn.status).toBe("running");
    await vi.waitFor(() => expect(calls.stopped).toEqual([source.id]), { timeout: 8_000 });
  });
});

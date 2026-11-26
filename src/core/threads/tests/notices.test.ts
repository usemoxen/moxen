/**
 * MXN-418 review: which of a turn's text is Moxen's to speak with, and which is
 * not. Only Moxen's own instruction reaches a developer channel (a mode
 * procedure, an instruction update, a rule-file patch, a usage continue);
 * report data — a settled task's notice with its child's headline, captured
 * shell output, model-written wrap-up notes — stays user text, tagged as
 * before. A batched rider stays the user's, and a notice-led turn still owes
 * whatever an unanswered turn left owed.
 */
import { describe, expect, it, vi } from "vitest";

import { testHarness, type SentTurn } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { driverKindOfInstance } from "../../types.js";
import { completeTurn, createThread, failTurn, interruptTurn, sendTurn } from "../threads.js";
import { flushTaskNotifications, queueTaskNotification, runDueScheduledTurn, scheduleUsageContinue, startTurn, type OperationContext } from "../operations.js";
import { USAGE_CONTINUE_PROMPT } from "../views.js";

/** What each driver was sent: the prompt, and the notices a developer channel keeps apart from it. */
async function world(options: { readonly developerNotices?: boolean; readonly leaveTurnsRunning?: boolean } = {}) {
  const sent: Array<Pick<SentTurn, "threadId" | "prompt" | "notices">> = [];
  const harness = await testHarness({
    developerNotices: options.developerNotices !== false,
    ...(options.leaveTurnsRunning === true ? { leaveTurnsRunning: true } : {}),
    onSendTurn: (turn) => void sent.push(turn),
  });
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

/** The automatic continue Moxen queues for a usage reset, with a user message riding it. */
async function queuedContinue(w: Awaited<ReturnType<typeof world>>, threadId: string, options: { readonly rider?: string } = {}) {
  const stopped = (await w.store.readTurns(threadId)).at(-1)?.id ?? "stopped";
  const turn = (await scheduleUsageContinue(w.ctx, threadId, stopped, new Date(Date.now() + 3_600_000).toISOString()))!;
  if (options.rider !== undefined) {
    await w.store.appendLedger(threadId, "messages", {
      id: w.store.newId(),
      threadId,
      turnId: turn.id,
      role: "user",
      text: options.rider,
      createdAt: w.store.nowIso(),
    });
  }
  return turn;
}

describe("Moxen's own text on a developer channel", () => {
  it("sends a mode block as a notice and the user's prompt unchanged", async () => {
    const w = await world();
    const thread = await w.make("switched mid-thread");
    await startTurn(w.ctx, { threadId: thread.id, prompt: "carry on", interactionMode: "research" });
    await flushTurnRunners();
    expect(w.sent).toHaveLength(1);
    // What the user typed is what the provider reads as the user's.
    expect(w.sent[0]!.prompt).toBe("carry on");
    expect(w.sent[0]!.notices).toHaveLength(1);
    expect(w.sent[0]!.notices![0]).toContain('<moxen-mode key="moxen-research">');
  });

  it("keeps a batched user message out of the developer item on the admission path", async () => {
    const w = await world();
    const thread = await w.make("usage held");
    const nudge = await queuedContinue(w, thread.id, { rider: "and check the docs" });
    await w.store.updateTurn(thread.id, nudge.id, { scheduledFor: new Date(0).toISOString() });
    expect(await runDueScheduledTurn(w.ctx, thread.id)).toBe(true);
    await settleRuns();

    const turn = w.sent.find((entry) => entry.threadId === thread.id);
    expect(turn).toBeDefined();
    // The nudge is Moxen's; the message the user queued behind it is theirs.
    expect(turn!.notices).toEqual([USAGE_CONTINUE_PROMPT]);
    expect(turn!.prompt).toBe("and check the docs");
  });

  it("keeps a batched user message out of the developer item when a settle promotes the turn", async () => {
    // A turn still running when the continue is queued, so the settle promotes it.
    const w = await world({ leaveTurnsRunning: true });
    const thread = await w.make("busy thread");
    const running = await startTurn(w.ctx, { threadId: thread.id, prompt: "long work" });
    await expect.poll(() => w.sent.length).toBe(1);
    const nudge = await sendTurn(w.store, thread.id, { prompt: USAGE_CONTINUE_PROMPT, origin: "usage-continue", scheduleReason: "usage-reset", delivery: "queue" });
    expect(nudge.turn).toMatchObject({ status: "queued", delivery: "queued" });
    await w.store.appendLedger(thread.id, "messages", {
      id: w.store.newId(),
      threadId: thread.id,
      turnId: nudge.turn.id,
      role: "user",
      text: "and check the docs",
      createdAt: w.store.nowIso(),
    });
    // The settle promotes it and the settling runner takes it (`runPromotedTurn`).
    await interruptTurn(w.store, thread.id, running.turn.id);
    await expect.poll(() => w.sent.length).toBe(2);

    const turn = w.sent.at(-1)!;
    expect(turn.notices).toEqual([USAGE_CONTINUE_PROMPT]);
    expect(turn.prompt).toBe("and check the docs");
    await interruptTurn(w.store, thread.id, nudge.turn.id);
  });

  it("replays an owed user prompt on a notice-led recovery", async () => {
    const w = await world();
    const thread = await w.make("stopped by a usage limit");
    // Its first turn never reached the provider: nothing of it is in any conversation.
    const owed = (await sendTurn(w.store, thread.id, { prompt: "port the parser" })).turn;
    await failTurn(w.store, thread.id, owed.id, { error: "Usage limit reached." });
    await w.store.updateTurn(thread.id, owed.id, { unanswered: true });
    const { providerSessions: _sessions, ...withoutSession } = (await w.store.readThreadRecord(thread.id))!;
    await w.store.writeThreadRecord(withoutSession);

    const nudge = await queuedContinue(w, thread.id);
    await w.store.updateTurn(thread.id, nudge.id, { scheduledFor: new Date(0).toISOString() });
    expect(await runDueScheduledTurn(w.ctx, thread.id)).toBe(true);
    await settleRuns();

    const turn = w.sent.find((entry) => entry.threadId === thread.id && entry.notices?.length === 1);
    expect(turn).toBeDefined();
    expect(turn!.notices).toEqual([USAGE_CONTINUE_PROMPT]);
    // The work the provider never read is still asked, ahead of the nudge's turn.
    expect(turn!.prompt).toContain("port the parser");
  });

  it.each([
    { prompt: "client scheduling text", legacy: false },
    { prompt: USAGE_CONTINUE_PROMPT, legacy: false },
    { prompt: "older client scheduling text", legacy: true },
  ])("keeps client-scheduled text in the user channel: $prompt", async ({ prompt, legacy }) => {
    const w = await world();
    const thread = await w.make("client schedule");
    const { turn } = await startTurn(w.ctx, {
      threadId: thread.id,
      prompt,
      scheduleReason: "usage-reset",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (legacy) {
      // Previous builds inferred this origin from client scheduling metadata.
      const messages = await w.store.readMessages(thread.id);
      await w.store.rewriteLedger(thread.id, "messages", messages.map((message) => ({ ...message, origin: "usage-continue" })));
    }
    await w.store.updateTurn(thread.id, turn.id, { scheduledFor: new Date(0).toISOString() });
    expect(await runDueScheduledTurn(w.ctx, thread.id)).toBe(true);
    await settleRuns();
    expect(w.sent.map(({ prompt, notices }) => ({ prompt, notices }))).toEqual([{ prompt, notices: undefined }]);
  });

  it.each([true, false])("preserves owed work on recovery (developer channel: %s)", async (developerNotices) => {
    const w = await world({ developerNotices });
    const thread = await w.make("usage recovery");
    const owed = (await sendTurn(w.store, thread.id, { prompt: "port the parser" })).turn;
    await failTurn(w.store, thread.id, owed.id, { error: "Usage limit reached." });
    await w.store.updateTurn(thread.id, owed.id, { unanswered: true });
    const nudge = await queuedContinue(w, thread.id, { rider: developerNotices ? "/compact" : "and check the docs" });
    await w.store.updateTurn(thread.id, nudge.id, { scheduledFor: new Date(0).toISOString(), interactionMode: "research", interactionModeExplicit: true });
    expect(await runDueScheduledTurn(w.ctx, thread.id)).toBe(true);
    await settleRuns();

    const sent = w.sent[0]!;
    if (developerNotices) {
      expect(sent.prompt).toBe("port the parser\n\n/compact");
      expect(sent.notices).toContain(USAGE_CONTINUE_PROMPT);
    } else {
      expect(sent.prompt).toMatch(/^<moxen-mode/);
      expect(sent.prompt).toContain(`port the parser\n\n${USAGE_CONTINUE_PROMPT}\n\nand check the docs`);
      expect(sent.notices).toBeUndefined();
    }
  });

  it("keeps a settled task's notice, with its child's headline, as user text", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = w.store.nowIso();
    await w.store.appendDelegation({
      id: "d-1",
      parentThreadId: parent.id,
      childThreadId: child.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    const ran = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, ran.id, { error: "Stopped." });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();

    const notice = w.sent.find((entry) => entry.threadId === parent.id);
    expect(notice).toBeDefined();
    // Report data, not Moxen's instruction: it stays the tagged user text it was.
    expect(notice!.notices).toBeUndefined();
    expect(notice!.prompt).toContain("<task-notification>");
    expect(notice!.prompt).toContain(`taskId ${child.id}`);
  });

  it("releases the run claim when the prompt cannot be built", async () => {
    const w = await world();
    const thread = await w.make("protected");
    await w.store.writeThreadRecord({
      ...(await w.store.readThreadRecord(thread.id))!,
      usagePause: { provider: "codex", windows: [], resetsAt: null, order: 1, phase: "resuming", handoff: false },
    });
    // The usage-background read fails while the prompt is composed.
    const read = w.store.readActivities.bind(w.store);
    const spy = vi.spyOn(w.store, "readActivities").mockImplementation((threadId: string) =>
      threadId === thread.id ? Promise.reject(new Error("injected ledger failure")) : read(threadId),
    );
    try {
      await expect(startTurn(w.ctx, { threadId: thread.id, prompt: "carry on" })).rejects.toThrow(/injected ledger failure/);
    } finally {
      spy.mockRestore();
    }
    const turns = await w.store.readTurns(thread.id);
    expect(turns).toHaveLength(1);
    // No runner owns it: it must not stay claimed, or the thread never recovers.
    expect(w.store.isTracked(turns[0]!.id)).toBe(false);
  });

  it("folds the blocks ahead of the prompt and keeps the protection notes after it", async () => {
    const w = await world({ developerNotices: false });
    const thread = await w.make("wrapped up");
    const wrap = (await sendTurn(w.store, thread.id, { prompt: "wrap up", usageControl: true, origin: "usage-protection" })).turn;
    await completeTurn(w.store, thread.id, wrap.id, { text: "safe stopping point" });
    await w.store.writeThreadRecord({
      ...(await w.store.readThreadRecord(thread.id))!,
      usagePause: { provider: "codex", windows: [], resetsAt: null, order: 1, phase: "resuming", turnId: wrap.id, handoff: false },
    });
    await startTurn(w.ctx, { threadId: thread.id, prompt: "carry on", interactionMode: "research" });
    await flushTurnRunners();

    const folded = w.sent.find((entry) => entry.prompt.includes("carry on"));
    expect(folded).toBeDefined();
    expect(folded!.notices).toBeUndefined();
    // The order the prompt had before MXN-418: blocks, then what the user said,
    // then what protection owed the recovery.
    const mode = folded!.prompt.indexOf("<moxen-mode");
    const typed = folded!.prompt.indexOf("carry on");
    const notes = folded!.prompt.indexOf("## Usage-protection wrap-up notes");
    expect(mode).toBe(0);
    expect(typed).toBeGreaterThan(mode);
    expect(notes).toBeGreaterThan(typed);
  });
});

/**
 * Review as a delegate mode and one-off (MXN-286): the trailing verdict a
 * review must end with, what the parent is told about a review task, and
 * the procedure the mode carries.
 */
import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { modeChange, modeInstructionKey, modeProcedure, PROCEDURE_MODES } from "../modes.js";
import { reviewFactsOf, reviewVerdictOf, taskNotificationText, type TaskNotification } from "../notify.js";
import { continueThread, delegate, describeTask, taskNotificationOf, type OperationContext } from "../operations.js";
import { createThread, sendTurn, completeTurn } from "../threads.js";
import { driverKindOfInstance } from "../../types.js";
import type { TurnDriver } from "../execute.js";

function task(overrides: Partial<TaskNotification> & { title: string }): TaskNotification {
  return {
    taskId: "t1",
    status: "completed",
    durationMs: 60_000,
    model: "opencode/gpt-5.6-sol",
    branch: "moxen/review-login",
    headline: "Two blockers in session handling",
    filesChanged: 2,
    additions: 10,
    deletions: 3,
    background: [],
    backgroundUnknown: false,
    ...overrides,
  };
}

describe("reviewVerdictOf", () => {
  it("reads the trailing verdict line", () => {
    expect(reviewVerdictOf("Findings.\n\nVERDICT: MERGE")).toBe("MERGE");
    expect(reviewVerdictOf("Findings.\n\nVERDICT: FIX FIRST")).toBe("FIX FIRST");
  });

  it("ignores surrounding whitespace and takes the last verdict line", () => {
    expect(reviewVerdictOf("VERDICT: MERGE\n")).toBe("MERGE");
    expect(reviewVerdictOf("  VERDICT: FIX FIRST  \n\n")).toBe("FIX FIRST");
    expect(reviewVerdictOf("VERDICT: MERGE\nNotes.\nVERDICT: FIX FIRST")).toBe("FIX FIRST");
  });

  it("finds no verdict in a report that points elsewhere", () => {
    expect(reviewVerdictOf("The full report is delivered above.")).toBeNull();
    expect(reviewVerdictOf("VERDICT: MAYBE")).toBeNull();
    expect(reviewVerdictOf("")).toBeNull();
    expect(reviewVerdictOf(null)).toBeNull();
  });

  it("only accepts a verdict on the report's last line, not trailing prose", () => {
    expect(reviewVerdictOf("VERDICT: MERGE\n\nSome trailing note.")).toBeNull();
    expect(reviewVerdictOf("VERDICT: MERGE\nQuoting the target: VERDICT: FIX FIRST")).toBeNull();
  });
});

describe("reviewFactsOf", () => {
  const review = {
    finished: true,
    interactionMode: "review" as const,
    report: "One nit.\n\nVERDICT: MERGE",
    childModel: "opencode/gpt-5.6-sol",
    parentModel: "claudeAgent/claude-sonnet-4-6",
  };

  it("is null for a task that is not in Review mode", () => {
    expect(reviewFactsOf({ ...review, interactionMode: "default" })).toBeNull();
    expect(reviewFactsOf({ ...review, interactionMode: undefined })).toBeNull();
  });

  it("owes no verdict while the review still runs", () => {
    expect(reviewFactsOf({ ...review, finished: false, report: null })).toMatchObject({
      verdict: null,
      note: null,
    });
  });

  it("says visibly when a finished review holds no verdict", () => {
    const facts = reviewFactsOf({ ...review, report: "The full report is delivered above." })!;
    expect(facts.verdict).toBeNull();
    expect(facts.note).toContain("no VERDICT");
    expect(facts.note).toContain("not a finished review");
  });

  it("flags a reviewer on the parent's own model, as a warning", () => {
    const facts = reviewFactsOf({ ...review, parentModel: "opencode/gpt-5.6-sol" })!;
    expect(facts).toMatchObject({ verdict: "MERGE", sameModel: true });
    expect(facts.note).toContain("opencode/gpt-5.6-sol");
    expect(facts.note).toContain("same model");
  });

  it("stays quiet for a clean review on another model", () => {
    expect(reviewFactsOf(review)).toEqual({ verdict: "MERGE", sameModel: false, note: null });
  });

  it("leaves the model comparison unknown when either side is missing", () => {
    expect(reviewFactsOf({ ...review, childModel: null })?.sameModel).toBeNull();
    expect(reviewFactsOf({ ...review, parentModel: null })?.sameModel).toBeNull();
  });
});

describe("taskNotificationText for a review", () => {
  const report = "One nit in the login form.\n\nVERDICT: MERGE";

  it("carries the verdict and the review itself", () => {
    const text = taskNotificationText([
      task({ title: "review login", review: { verdict: "MERGE", sameModel: false, note: null, report } }),
    ]);
    expect(text).toContain("Review verdict: MERGE");
    expect(text).toContain(`Report:\n${report}`);
    expect(text).toContain("Call task_status with a taskId for the full report.");
  });

  it("calls out a finished review with no verdict instead of passing it on", () => {
    const text = taskNotificationText([
      task({
        title: "review login",
        headline: "The full report is delivered above.",
        review: {
          verdict: null,
          sameModel: false,
          note: "the reviewer's final message has no VERDICT: MERGE or VERDICT: FIX FIRST line, so this is not a finished review. Read the report below",
          report: "The full report is delivered above.",
        },
      }),
    ]);
    expect(text).toContain("Review verdict: none — this is not a finished review");
    expect(text).toContain("Review note: the reviewer's final message has no VERDICT");
  });

  it("leaves an ordinary task's notification as it was", () => {
    const text = taskNotificationText([task({ title: "scout routes" })]);
    expect(text).toContain('Task "scout routes"');
    expect(text).not.toContain("Review verdict");
    expect(text).not.toContain("Report:");
  });
});

describe("the Review procedure", () => {
  it("is carried by the mode, like Research and Orchestrate", () => {
    expect(PROCEDURE_MODES).toContain("review");
    expect(modeInstructionKey("review")).toBe("moxen-review");
    const procedure = modeProcedure("review")!;
    expect(procedure).toContain("scratch worktree");
    expect(procedure).toContain("Change nothing in the target");
    expect(procedure).toContain("VERDICT: MERGE");
    expect(procedure).toContain("VERDICT: FIX FIRST");
    expect(procedure).toContain("Severity:");
    expect(procedure).toContain("Sequence:");
    expect(procedure).toContain("Proof:");
  });

  it("puts the caller's questions first, not behind the checklist", () => {
    const procedure = modeProcedure("review")!;
    expect(procedure).toContain("directed check");
    expect(procedure).toContain("first-class");
  });

  it("arrives ahead of the prompt and leaves with it", () => {
    expect(modeChange("default", "review")).toBe(modeProcedure("review"));
    expect(modeChange("research", "review")).toBe(modeProcedure("review"));
    expect(modeChange("review", "default")).toContain("Review mode is off");
    expect(modeChange("default", "default")).toBeNull();
  });
});

async function reviewWorld() {
  const harness = await testHarness();
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
  const make = (title: string, options?: { interactionMode?: "default" | "review"; instanceId?: string; model?: string }) =>
    createThread(harness.store, {
      projectId: "p",
      title,
      env: { mode: "local", path: harness.work, branch: null },
      modelSelection: { instanceId: options?.instanceId ?? "opencode", model: options?.model ?? "gpt-5.6-sol" },
      ...(options?.interactionMode ? { interactionMode: options.interactionMode } : {}),
    });
  return { ...harness, ctx, make };
}

async function finishChild(
  w: Awaited<ReturnType<typeof reviewWorld>>,
  parentId: string,
  childId: string,
  report: string,
): Promise<void> {
  const now = new Date().toISOString();
  await w.store.appendDelegation({
    id: `d-${childId}`,
    parentThreadId: parentId,
    childThreadId: childId,
    prompt: "Review it",
    status: "running",
    notify: true,
    createdAt: now,
    updatedAt: now,
  });
  const turn = (await sendTurn(w.store, childId, { prompt: "Review it" })).turn;
  await completeTurn(w.store, childId, turn.id, { text: report });
}

describe("a finished review task", () => {
  it("tells the parent the verdict and the review, with the same model flagged", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review" });
    const report = "Headline: two blockers.\n\nFinding 1 of 2 — session fixation.\n\nVERDICT: FIX FIRST";
    await finishChild(w, parent.id, child.id, report);

    const notified = (await taskNotificationOf(w.ctx, child.id))!;
    expect(notified.review).toMatchObject({ verdict: "FIX FIRST", sameModel: true, report });
    expect(notified.review!.note).toContain("same model");
    expect(taskNotificationText([notified])).toContain("Review verdict: FIX FIRST");
    expect(taskNotificationText([notified])).toContain(report);

    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review).toMatchObject({ verdict: "FIX FIRST", sameModel: true });
  });

  it("does not pass on a finished review with no verdict as a finished review", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "The full report is delivered above.");

    const notified = (await taskNotificationOf(w.ctx, child.id))!;
    expect(notified.review).toMatchObject({ verdict: null, sameModel: false });
    const text = taskNotificationText([notified]);
    expect(text).toContain("Review verdict: none — this is not a finished review");

    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review?.verdict).toBeNull();
    expect(described.review?.note).toContain("no VERDICT");
  });

  it("leaves an ordinary task undescribed", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("build it");
    await finishChild(w, parent.id, child.id, "Done.");

    expect((await taskNotificationOf(w.ctx, child.id))?.review).toBeUndefined();
    expect((await describeTask(w.ctx, parent.id, child.id)).review).toBeNull();
  });
});

describe("continuing a review thread", () => {
  it("never keeps Review as a staying mode, and says so in the ledger", async () => {
    const w = await reviewWorld();
    const child = await w.make("review login", { interactionMode: "review" });

    const continued = await continueThread(w.ctx, { threadId: child.id });

    expect((await w.store.readThreadRecord(continued.threadId))?.interactionMode).toBe("default");
    const note = (await w.store.readActivities(child.id)).find((activity) => activity.kind === "thread.continued");
    expect(note?.summary).toContain("Review");
    expect(note?.summary).toContain("Build");
  });

  it("keeps the review and its settled verdict on the continued task", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    expect((await w.store.readThreadRecord(continued.threadId))?.interactionMode).toBe("default");

    // The new thread reads as Build, but the task is the review that settled
    // in it: task_status and the notification keep its verdict, from the
    // task's delegation lineage rather than the live thread's mode.
    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    expect(taskNotificationText([notified])).toContain("Review verdict: MERGE");
  });

  it("warns when the continued review's own report ends without a verdict", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    await completeTurn(w.store, continued.threadId, turn!.id, {
      text: "Finding: the login form still posts twice.\n\nSequence: double submit on enter.\n\nThe full report is delivered above.",
    });

    // Once the continuation has settled its own report, that report is what
    // the parent judges: a missing trailing verdict is still called out.
    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review?.verdict).toBeNull();
    expect(described.review?.note).toContain("no VERDICT");
    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: null, sameModel: false });
    expect(notified.review?.note).toContain("no VERDICT");
    expect(taskNotificationText([notified])).toContain("Review verdict: none — this is not a finished review");
  });

  it("keeps the carried verdict when the opening turn completes with no report", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    // The hand-off turn ends with no assistant text and no tool work: it
    // reviewed nothing, so the verdict the task settled with still stands.
    await completeTurn(w.store, continued.threadId, turn!.id);

    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    expect(notified.review?.note).toBeNull();
    expect(taskNotificationText([notified])).toContain("Review verdict: MERGE");
    expect((await describeTask(w.ctx, parent.id, child.id)).review).toMatchObject({ verdict: "MERGE" });
  });

  it("keeps the carried verdict when the opening turn only acknowledges the hand-off", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    await completeTurn(w.store, continued.threadId, turn!.id, {
      text: "Handoff received; I will review the remaining changes next.",
    });

    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    expect(taskNotificationText([notified])).toContain("Review verdict: MERGE");
  });

  it("still warns when the opening turn did tool work and ended without a verdict", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    await w.store.appendLedger(continued.threadId, "activity", {
      id: "tool-row", threadId: continued.threadId, turnId: turn!.id, kind: "tool-call.completed",
      summary: "Read login.tsx", payload: {}, createdAt: w.store.nowIso(),
    });
    await completeTurn(w.store, continued.threadId, turn!.id, { text: "Read the login form; full report above." });

    // Tool work means the turn did review: a one-line answer with no verdict
    // is not a hand-off acknowledgement, and is called out as unfinished.
    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: null, sameModel: false });
    expect(notified.review?.note).toContain("no VERDICT");
  });

  it("reports the newest continuation's verdict, also after the parent has continued", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const first = await continueThread(w.ctx, { threadId: child.id });
    const [firstTurn] = await w.store.readTurns(first.threadId);
    await completeTurn(w.store, first.threadId, firstTurn!.id, { text: "Re-checked the login form.\n\nVERDICT: FIX FIRST" });
    expect((await describeTask(w.ctx, parent.id, child.id)).review).toMatchObject({ verdict: "FIX FIRST" });

    // The orchestrator carries on too, taking its task with it.
    const nextParent = await continueThread(w.ctx, { threadId: parent.id });
    // The task continues a second time. Its row's `continuesTaskId` names the
    // original task, so the verdict has to come from the thread between them.
    const second = await continueThread(w.ctx, { threadId: first.threadId });
    const described = await describeTask(w.ctx, nextParent.threadId, child.id);
    expect(described.review).toMatchObject({ verdict: "FIX FIRST", sameModel: false });
    const notified = (await taskNotificationOf(w.ctx, second.threadId))!;
    expect(notified.review).toMatchObject({ verdict: "FIX FIRST" });
    expect(taskNotificationText([notified])).toContain("Review verdict: FIX FIRST");
  });

  it("warns when a one-line opening report carries no standalone verdict line", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    // A substantive report, not an acknowledgement: it ends with a line whose
    // verdict words are not a verdict of their own.
    await completeTurn(w.store, continued.threadId, turn!.id, { text: "Found a regression. VERDICT: FIX FIRST" });

    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: null });
    expect(notified.review?.note).toContain("no VERDICT");
    expect(taskNotificationText([notified])).toContain("Review verdict: none — this is not a finished review");
    expect(taskNotificationText([notified])).not.toContain("Review verdict: FIX FIRST");
  });

  it("warns when a one-line opening turn reports a finding instead of acknowledging", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    await completeTurn(w.store, continued.threadId, turn!.id, { text: "Found a regression; the review is complete." });

    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: null });
    expect(notified.review?.note).toContain("no VERDICT");
    expect(taskNotificationText([notified])).toContain("Review verdict: none — this is not a finished review");
  });

  it("warns when an acknowledgement also states a finding", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [turn] = await w.store.readTurns(continued.threadId);
    // The opener does not make it an acknowledgement: it already reported.
    await completeTurn(w.store, continued.threadId, turn!.id, { text: "Acknowledged. The regression is in login.tsx." });

    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: null });
    expect(notified.review?.note).toContain("no VERDICT");
  });

  it("warns when the report arrives on a later turn, after an opening acknowledgement", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    const continued = await continueThread(w.ctx, { threadId: child.id });
    const [opening] = await w.store.readTurns(continued.threadId);
    await completeTurn(w.store, continued.threadId, opening!.id, { text: "Acknowledged." });
    // The carried verdict stands only for the opening turn: the next report is
    // the parent's to judge, however short.
    const second = (await sendTurn(w.store, continued.threadId, { prompt: "What did you find?" })).turn;
    await completeTurn(w.store, continued.threadId, second.id, { text: "Found a regression; the review is complete." });

    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ verdict: null });
    expect(notified.review?.note).toContain("no VERDICT");
  });

  it("keeps an unpinned verdict across two hand-offs that only acknowledged", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "One nit in the login form.\n\nVERDICT: MERGE");

    // Nothing reads the task between these hand-offs, so no row is pinned:
    // the verdict lives only in the original review's settled turn.
    const first = await continueThread(w.ctx, { threadId: child.id });
    const [firstOpening] = await w.store.readTurns(first.threadId);
    await completeTurn(w.store, first.threadId, firstOpening!.id, { text: "Acknowledged." });
    const second = await continueThread(w.ctx, { threadId: first.threadId });
    const [secondOpening] = await w.store.readTurns(second.threadId);
    await completeTurn(w.store, second.threadId, secondOpening!.id, { text: "Acknowledged." });
    expect((await w.store.readDelegations()).every((row) => row.review === undefined)).toBe(true);

    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    const notified = (await taskNotificationOf(w.ctx, second.threadId))!;
    expect(notified.review).toMatchObject({ verdict: "MERGE" });
  });

  it("attributes a legacy pin to the reviewer's model, not the acknowledgement's", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", instanceId: "codex", model: "other-model" });
    const now = new Date().toISOString();
    const report = "One nit in the login form.\n\nVERDICT: MERGE";
    // A row written before the pin recorded its model, so only the delegation
    // snapshot says who reviewed.
    await w.store.appendDelegation({
      id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Review it", status: "running", notify: true,
      modelSnapshot: { parent: "opencode/gpt-5.6-sol", child: "codex/other-model" },
      review: { verdict: "MERGE", report }, createdAt: now, updatedAt: now,
    });
    const reviewed = (await sendTurn(w.store, child.id, { prompt: "Review it" })).turn;
    await completeTurn(w.store, child.id, reviewed.id, { text: report });

    // The continuation runs on the parent's own model and only acknowledges,
    // so the report shown is still the reviewer's, on the reviewer's model.
    const continued = await continueThread(w.ctx, {
      threadId: child.id,
      modelSelection: { instanceId: "opencode", model: "gpt-5.6-sol" },
    });
    const [opening] = await w.store.readTurns(continued.threadId);
    await completeTurn(w.store, continued.threadId, opening!.id, { text: "Acknowledged." });

    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    const row = (await w.store.readDelegations()).find((candidate) => candidate.childThreadId === continued.threadId);
    expect(row?.review?.model).toBe("codex/other-model");
  });

  it("compares the model that produced the verdict, not the one the task was delegated on", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", instanceId: "codex", model: "other-model" });
    const now = new Date().toISOString();
    await w.store.appendDelegation({
      id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Review it", status: "running",
      notify: true, modelSnapshot: { parent: "opencode/gpt-5.6-sol", child: "codex/other-model" }, createdAt: now, updatedAt: now,
    });
    const firstTurn = (await sendTurn(w.store, child.id, { prompt: "Review it" })).turn;
    await completeTurn(w.store, child.id, firstTurn.id, { text: "One nit in the login form.\n\nVERDICT: MERGE" });

    // The review continues on the parent's own provider and model: the report
    // the parent reads was produced by the author's model, not the reviewer's.
    const continued = await continueThread(w.ctx, {
      threadId: child.id,
      modelSelection: { instanceId: "opencode", model: "gpt-5.6-sol" },
    });
    const [turn] = await w.store.readTurns(continued.threadId);
    await completeTurn(w.store, continued.threadId, turn!.id, { text: "Re-checked.\n\nVERDICT: FIX FIRST" });

    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review).toMatchObject({ verdict: "FIX FIRST", sameModel: true });
    expect(described.review?.note).toContain("same model");
    const notified = (await taskNotificationOf(w.ctx, continued.threadId))!;
    expect(notified.review).toMatchObject({ sameModel: true });
    expect(taskNotificationText([notified])).toContain("same model");
  });

  it("resets an explicitly carried review mode too, such as a queued one-off", async () => {
    const w = await reviewWorld();
    const thread = await w.make("plain build");

    const continued = await continueThread(w.ctx, { threadId: thread.id, interactionMode: "review" });

    expect((await w.store.readThreadRecord(continued.threadId))?.interactionMode).toBe("default");
    const note = (await w.store.readActivities(thread.id)).find((activity) => activity.kind === "thread.continued");
    expect(note?.summary).toContain("Review");
  });

  it("leaves other modes alone and writes no reset note", async () => {
    const w = await reviewWorld();
    const thread = await w.make("plain build");

    const continued = await continueThread(w.ctx, { threadId: thread.id, interactionMode: "research" });

    expect((await w.store.readThreadRecord(continued.threadId))?.interactionMode).toBe("research");
    const note = (await w.store.readActivities(thread.id)).find((activity) => activity.kind === "thread.continued");
    expect(note?.summary).not.toContain("Review");
  });
});

describe("a review delegation's recorded models", () => {
  it("snapshots both models at delegate time, and prefers the snapshot when the parent moves on", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const delegated = await delegate(w.ctx, {
      parentThreadId: parent.id,
      task: "Review the login change.",
      title: "review login",
      isolation: "shared",
      interactionMode: "review",
    });
    const rows = await w.store.readDelegations();
    expect(rows.find((row) => row.childThreadId === delegated.child.id)).toMatchObject({
      modelSnapshot: { parent: "opencode/gpt-5.6-sol", child: "opencode/gpt-5.6-sol" },
    });

    // The parent changes model after delegating: the live records now differ,
    // but the snapshot still says the reviewer shares the author's model.
    await w.store.writeThreadRecord({
      ...(await w.store.readThreadRecord(parent.id))!,
      modelSelection: { instanceId: "codex", model: "other-model" },
    });
    const described = await describeTask(w.ctx, parent.id, delegated.child.id);
    expect(described.review).toMatchObject({ verdict: null, sameModel: true });
    expect(described.review?.note).toContain("no VERDICT");
  });
});

describe("a settled review verdict", () => {
  it("is pinned at settle, so a follow-up turn cannot rewrite it", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review" });
    await finishChild(w, parent.id, child.id, "Headline: two blockers.\n\nFinding 1 of 2 — session fixation.\n\nVERDICT: FIX FIRST");

    const first = await describeTask(w.ctx, parent.id, child.id);
    expect(first.review).toMatchObject({ verdict: "FIX FIRST" });

    // A follow-up turn answers conversationally, with no verdict line.
    const turn = (await sendTurn(w.store, child.id, { prompt: "Which file was that in?" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "It was the login form." });

    const second = await describeTask(w.ctx, parent.id, child.id);
    expect(second.review).toMatchObject({ verdict: "FIX FIRST", sameModel: true });
    expect(second.review?.note).toContain("same model");
    const notified = await taskNotificationOf(w.ctx, child.id);
    expect(notified?.review).toMatchObject({ verdict: "FIX FIRST" });
    expect(notified?.review?.report).toContain("VERDICT: FIX FIRST");
    expect(taskNotificationText([notified!])).toContain("Review verdict: FIX FIRST");
  });

  it("re-pins when a follow-up settles with its own verdict", async () => {
    const w = await reviewWorld();
    const parent = await w.make("orchestrator");
    const child = await w.make("review login", { interactionMode: "review", model: "other-model" });
    await finishChild(w, parent.id, child.id, "Headline: blockers.\n\nVERDICT: FIX FIRST");

    const turn = (await sendTurn(w.store, child.id, { prompt: "Re-check after fixes." })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Clean now.\n\nVERDICT: MERGE" });

    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.review).toMatchObject({ verdict: "MERGE", sameModel: false });
    expect(described.review?.note).toBeNull();
  });
});

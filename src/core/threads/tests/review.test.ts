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
  const make = (title: string, options?: { interactionMode?: "default" | "review"; model?: string }) =>
    createThread(harness.store, {
      projectId: "p",
      title,
      env: { mode: "local", path: harness.work, branch: null },
      modelSelection: { instanceId: "opencode", model: options?.model ?? "gpt-5.6-sol" },
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

/**
 * MXN-418: Moxen's own text (a mode procedure, an instruction update, a task
 * notice, a usage continue) is not the user's, so a provider with a developer
 * channel is given it there and the user's prompt stays exactly what they
 * typed. Codex takes it as `thread/inject_items` developer items (the driver's
 * own tests prove the wire); this pins what leaves `operations.ts`, for every
 * turn Moxen starts: a user's, and one of its own with no user half at all.
 */
import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { driverKindOfInstance } from "../../types.js";
import { createThread, completeTurn, failTurn, sendTurn } from "../threads.js";
import { flushTaskNotifications, queueTaskNotification, startTurn, type OperationContext } from "../operations.js";
import type { SentTurn } from "../../testing/harness.js";

/** What each driver was sent: the prompt, and the notices a developer channel keeps apart from it. */
async function world() {
  const sent: Array<Pick<SentTurn, "threadId" | "prompt" | "notices">> = [];
  const harness = await testHarness({ developerNotices: true, onSendTurn: (turn) => void sent.push(turn) });
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
  const make = (title: string, interactionMode: "default" | "research" = "default") =>
    createThread(harness.store, {
      projectId: "p",
      title,
      env: { mode: "local", path: harness.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      interactionMode,
    });
  return { ...harness, ctx, sent, make };
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

  it("sends a settled task's notice with no user half, in its own turn", async () => {
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

    const notice = w.sent.find((turn) => turn.threadId === parent.id);
    expect(notice).toBeDefined();
    // The notice is the whole turn: nothing pretends the user said it.
    expect(notice!.prompt).toBe("");
    expect(notice!.notices).toHaveLength(1);
    expect(notice!.notices![0]).toContain("<task-notification>");
    expect(notice!.notices![0]).toContain(`taskId ${child.id}`);
  });
});

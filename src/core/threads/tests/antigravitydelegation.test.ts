/**
 * Antigravity delegation and automatic prompts (LOCAL-006): off by default,
 * Google's consumer sign-in covers only prompts the user types themselves.
 * Delegation is refused before anything is created; automatic prompts are
 * held in the existing queue/notice machinery and delivered with the user's
 * next message or when the setting turns on. The user's own sends always run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CliError } from "../../errors.js";
import { testHarness } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import type { TurnDriver } from "../execute.js";
import {
  continueOwnThread,
  continueThread,
  delegate,
  flushTaskNotifications,
  queueAgentMessage,
  queueTaskNotification,
  recoverTaskNotifications,
  runWorkQueue,
  sendTaskMessage,
  startTurn,
  type OperationContext,
} from "../operations.js";
import { completeTurn, createThread, sendTurn } from "../threads.js";

async function world() {
  const w = await testHarness();
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: w.store,
    storeRoot: w.root,
    config: w.config,
    driverFor: (instance) => {
      const kind = driverKindOfInstance(instance)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = (w.drivers[kind] ?? w.drivers.codex!)();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
  const make = (instanceId: string, model = "test-model", title = `Work on ${instanceId}`) =>
    createThread(w.store, { projectId: "p", title, env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId, model } });
  const allow = (on: boolean) => {
    w.config.providers = { ...w.config.providers, antigravity: { ...w.config.providers?.antigravity, allowUnsupportedUse: on } };
  };
  return { ...w, ctx, make, allow };
}

/** A notifying delegation row plus a finished turn on the child, as a settled task reports. */
async function settledTask(w: Awaited<ReturnType<typeof world>>, parentId: string, childId: string): Promise<void> {
  const now = new Date().toISOString();
  await w.store.appendDelegation({ id: `d-${childId}`, parentThreadId: parentId, childThreadId: childId, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
  const turn = (await sendTurn(w.store, childId, { prompt: "Do it" })).turn;
  await completeTurn(w.store, childId, turn.id, { text: "Done." });
}

const batchesFile = (root: string) => path.join(root, "task-notification-batches.json");
const readBatches = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(batchesFile(root), "utf8").catch(() => "{}")) as Record<string, unknown>;

describe("Antigravity delegation refused while off", () => {
  it("creates nothing — no thread, no worktree, no delegation row — and names the setting", async () => {
    const w = await world();
    const parent = await w.make("codex");
    const before = await w.store.listThreadIds();
    await expect(delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "antigravity", model: "gemini-4-neon", isolation: "worktree" }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF", message: expect.stringContaining("providers.antigravity.allowUnsupportedUse") });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect(await w.store.readDelegations()).toEqual([]);
    // A dry run is refused too: it must not plan a delegation that cannot start.
    await expect(delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "antigravity", model: "gemini-4-neon", dryRun: true }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
  });

  it.each(["antigravity", "antigravity/work", "agy"])("covers every account id (%s), inheriting the parent's selection", async (instanceId) => {
    const w = await world();
    const parent = await w.make(instanceId, "gemini-4-neon");
    await expect(delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", isolation: "shared" }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
    expect(await w.store.readDelegations()).toEqual([]);
  });

  it("allows the delegation when the setting is on", async () => {
    const w = await world();
    const parent = await w.make("codex");
    w.allow(true);
    const delegated = await delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "antigravity", model: "gemini-4-neon", isolation: "shared" });
    await settleRuns();
    expect((await w.store.readThreadRecord(delegated.child.id))?.modelSelection.instanceId).toBe("antigravity");
    expect((await w.store.readDelegations()).some((row) => row.childThreadId === delegated.child.id)).toBe(true);
  });

  it("leaves other providers alone while off", async () => {
    const w = await world();
    const parent = await w.make("codex");
    const delegated = await delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", isolation: "shared" });
    await settleRuns();
    expect(delegated.modelSelection.instanceId).toBe("codex");
  });

  it("refuses an agent's task_send and wake to an Antigravity task", async () => {
    const w = await world();
    const parent = await w.make("codex");
    const child = await w.make("antigravity", "gemini-4-neon");
    await settledTask(w, parent.id, child.id);
    await expect(sendTaskMessage(w.ctx, parent.id, child.id, "Keep going", true))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
    w.allow(true);
    const sent = await sendTaskMessage(w.ctx, parent.id, child.id, "Keep going", true);
    await settleRuns();
    expect(sent.outcome).toBe("started");
  });

  it("refuses an agent's thread_continue onto Antigravity, but not the user's own Continue", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    await expect(continueOwnThread(w.ctx, { threadId: thread.id, summary: "Handing off." }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
    // The user's palette action is their own choice, not delegation.
    const continued = await continueThread(w.ctx, { threadId: thread.id });
    await settleRuns();
    expect((await w.store.readThreadRecord(continued.threadId))?.modelSelection.instanceId).toBe("antigravity");
  });
});

describe("Antigravity automatic prompts held while off", () => {
  it("holds a task notice and delivers it exactly once with the user's next message", async () => {
    const w = await world();
    const parent = await w.make("antigravity", "gemini-4-neon");
    const child = await w.make("codex");
    await settledTask(w, parent.id, child.id);

    await queueTaskNotification(w.ctx, parent.id, child.id);
    // The batch flush (timer or restart) keeps it: no turn starts on the idle parent.
    await flushTaskNotifications(w.ctx, parent.id);
    await settleRuns();
    expect((await w.store.readTurns(parent.id)).length).toBe(0);
    expect(await readBatches(w.root)).toHaveProperty(parent.id);

    // A restart replays the batch and still holds it.
    await recoverTaskNotifications(w.ctx);
    expect((await w.store.readTurns(parent.id)).length).toBe(0);

    // The user's own message runs, and the notice rides out with it.
    const user = await startTurn(w.ctx, { threadId: parent.id, prompt: "Continue please" });
    expect(user.turn.status).toBe("running");
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();

    const notices = (await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification");
    expect(notices).toHaveLength(1);
    const noticeTurns = (await w.store.readTurns(parent.id)).filter((turn) => turn.origin === "task-notification");
    expect(noticeTurns).toHaveLength(1);
    expect(noticeTurns[0]!.status).toBe("completed");
    expect(await readBatches(w.root)).not.toHaveProperty(parent.id);
  });

  it("releases a held task notice when the setting turns on", async () => {
    const w = await world();
    const parent = await w.make("antigravity", "gemini-4-neon");
    const child = await w.make("codex");
    await settledTask(w, parent.id, child.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect((await w.store.readTurns(parent.id)).length).toBe(0);

    w.allow(true);
    await recoverTaskNotifications(w.ctx);
    await settleRuns();
    const notices = (await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification");
    expect(notices).toHaveLength(1);
  });

  it("holds an agent-queued message; the user's message runs while off, then the held one is admitted", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    const queued = await queueAgentMessage(w.ctx, thread.id, { message: "Check the logs" });
    expect(queued.status).toBe("queued");
    expect(queued.waitingFor.join(" ")).toContain("providers.antigravity.allowUnsupportedUse");

    // The admission pass does not start it on its own.
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turnId)?.status).toBe("queued");

    // The user's own message runs while off.
    const user = await startTurn(w.ctx, { threadId: thread.id, prompt: "Go on" });
    expect(user.turn.status).toBe("running");
    await settleRuns();
    // With a user turn behind it, the held message is admitted and runs once.
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turnId)?.status).toBe("completed");
  });

  it("releases a held agent message when the setting turns on", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    const queued = await queueAgentMessage(w.ctx, thread.id, { message: "Check the logs" });
    expect(queued.status).toBe("queued");
    w.allow(true);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turnId)?.status).toBe("completed");
  });
});
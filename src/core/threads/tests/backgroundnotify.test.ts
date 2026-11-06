import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import type { BackgroundTaskSummary } from "../../providers/spi.js";
import { durationMs } from "../idle.js";
import { describeTask, queueTaskNotification, startTurn, type OperationContext } from "../operations.js";
import { taskNotificationText } from "../notify.js";
import { createThread } from "../threads.js";
import { flushTurnRunners, type TurnDriver, type TurnOutcome } from "../execute.js";

afterEach(() => vi.useRealTimers());

/** A driver whose background work the test controls. */
function scriptedDriver(background: () => readonly BackgroundTaskSummary[]): TurnDriver {
  const sessions = new Set<string>();
  let n = 0;
  return {
    hasSession: (threadId: string) => Effect.succeed(sessions.has(threadId)),
    startSession: (input: { threadId: string }) => Effect.sync(() => {
      sessions.add(input.threadId);
      return {};
    }),
    sendTurn: (input: { threadId: string }) =>
      Effect.succeed({ threadId: input.threadId, turnId: `driver-turn-${(n += 1)}` }),
    interruptTurn: () => Effect.void,
    awaitTurn: async (): Promise<TurnOutcome> => ({ status: "completed", text: "done", usage: null, error: null }),
    streamEvents: Stream.never as TurnDriver["streamEvents"],
    backgroundTasks: (threadId: string) => (sessions.has(threadId) ? background() : []),
  };
}

async function world(background: () => readonly BackgroundTaskSummary[], config: Record<string, unknown> = {}) {
  const harness = await testHarness();
  const scripted = scriptedDriver(background);
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: { ...harness.config, ...config },
    driverFor: (id) => {
      if (driverKindOfInstance(id) === "codex") return scripted;
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
  return { ...harness, ctx, make };
}

async function notificationsIn(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<string[]> {
  return (await w.store.readMessages(threadId))
    .filter((message) => message.origin === "task-notification")
    .map((message) => message.text);
}

async function settleChild(w: Awaited<ReturnType<typeof world>>, childId: string, text: string, origin?: "background-notification"): Promise<void> {
  const started = await startTurn(w.ctx, { threadId: childId, prompt: text, ...(origin ? { origin } : {}) });
  await started.run;
}

describe("a task notification with background work still running", () => {
  it("names the work and its age instead of reading as finished", () => {
    const text = taskNotificationText([
      {
        taskId: "child",
        title: "Build it",
        status: "completed",
        durationMs: 60_000,
        model: "codex/gpt-6.1-sol",
        branch: null,
        headline: "Partial report.",
        filesChanged: null,
        additions: null,
        deletions: null,
        background: [
          { taskId: "bg1", description: "bun run check", command: "bun run check", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
        ],
        backgroundUnknown: false,
      },
    ]);
    expect(text).toContain("not finished");
    expect(text).toContain("bun run check");
    expect(text).toContain("4m");
    expect(text).not.toContain("has settled");
  });

  it("says it cannot verify rather than crying not finished when nothing is named", () => {
    const text = taskNotificationText([
      {
        taskId: "child",
        title: "Build it",
        status: "completed",
        durationMs: 60_000,
        model: "codex/gpt-6.1-sol",
        branch: null,
        headline: "Partial report.",
        filesChanged: null,
        additions: null,
        deletions: null,
        background: [],
        backgroundUnknown: true,
      },
    ]);
    expect(text).toContain("could not verify");
    expect(text).toContain("Check task_status");
    expect(text).not.toContain("not finished");
    expect(text).not.toContain("has settled.");
  });

  it("still reads not finished when work is named, even where the provider cannot report it all", () => {
    const text = taskNotificationText([
      {
        taskId: "child",
        title: "Build it",
        status: "completed",
        durationMs: 60_000,
        model: "opencode/gpt-5.4",
        branch: null,
        headline: "Partial report.",
        filesChanged: null,
        additions: null,
        deletions: null,
        background: [
          { taskId: "bg1", description: "bun run check", command: "bun run check", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
        ],
        backgroundUnknown: true,
      },
    ]);
    expect(text).toContain("not finished");
    expect(text).toContain("bun run check");
    expect(text).toContain("beyond what is named above");
  });

  it("reads exactly as before when nothing runs and the provider reports fully", () => {
    const text = taskNotificationText([
      {
        taskId: "child",
        title: "Build it",
        status: "completed",
        durationMs: 61_000,
        model: "codex/gpt-6.1-sol",
        branch: null,
        headline: "Done.",
        filesChanged: null,
        additions: null,
        deletions: null,
        background: [],
        backgroundUnknown: false,
      },
    ]);
    expect(text).toContain("has settled.");
    expect(text).not.toContain("not finished");
  });
});

describe("a delegated task that ends its turn with background work running", () => {
  it("tells the parent on time, naming the work, then tells it again once the work ends and the task settles", async () => {
    const live: BackgroundTaskSummary[] = [
      {
        taskId: "bg1",
        taskType: "local_bash",
        description: "bun run check",
        toolName: "Bash",
        command: "bun run check",
        startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      },
    ];
    const w = await world(() => live);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({
      id: "d1",
      parentThreadId: parent.id,
      childThreadId: child.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    await settleChild(w, child.id, "Build it");

    queueTaskNotification(w.ctx, parent.id, child.id);
    let first: string[] = [];
    for (let waited = 0; waited < 10_000; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await flushTurnRunners();
      first = await notificationsIn(w, parent.id);
      if (first.length > 0) break;
    }
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("bun run check");
    expect(first[0]).toContain("not finished");

    // The background work ends. The task wakes to pick up the result and settles again.
    live.length = 0;
    await settleChild(w, child.id, "The check passed.", "background-notification");
    let both: string[] = [];
    for (let waited = 0; waited < 10_000; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await flushTurnRunners();
      both = await notificationsIn(w, parent.id);
      if (both.length > 1) break;
    }
    expect(both).toHaveLength(2);
    expect(both[1]).toContain("has settled");
    expect(both[1]).not.toContain("not finished");
  }, 30_000);

  it("sends nothing further while background work never ends and blocks nothing", async () => {
    const live: BackgroundTaskSummary[] = [
      {
        taskId: "watcher",
        taskType: "local_bash",
        description: "bun run dev",
        toolName: "Bash",
        command: "bun run dev",
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ];
    const w = await world(() => live);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({
      id: "d1",
      parentThreadId: parent.id,
      childThreadId: child.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    await settleChild(w, child.id, "Build it");

    queueTaskNotification(w.ctx, parent.id, child.id);
    let first: string[] = [];
    for (let waited = 0; waited < 10_000; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await flushTurnRunners();
      first = await notificationsIn(w, parent.id);
      if (first.length > 0) break;
    }
    expect(first).toHaveLength(1);
    // No turn ever settles again: the watcher alone sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  }, 30_000);
});

describe("task_status with background work", () => {
  // Two full child turns plus the task reads: a loaded runner does not fit in the twenty-second default.
  it("lists what is still running and for how long, flagging what is probably forgotten", async () => {
    const startedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    const w = await world(() => [
      {
        taskId: "bg1",
        taskType: "local_bash",
        description: "bun run check",
        toolName: "Bash",
        command: "bun run check",
        startedAt,
      },
    ]);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({
      id: "d1",
      parentThreadId: parent.id,
      childThreadId: child.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    // A session holds the child once its turn starts; only then can Moxen check its background work.
    await settleChild(w, child.id, "Build it");
    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.background.unknown).toBe(false);
    expect(described.background.tasks).toHaveLength(1);
    expect(described.background.tasks[0]).toMatchObject({ taskId: "bg1", description: "bun run check", command: "bun run check", startedAt });
    expect(described.background.tasks[0]!.ageMs).toBeGreaterThan(3 * 60_000);
    expect(described.background.tasks[0]!.probablyForgotten).toBe(false);

    const aged = await world(() => [
      {
        taskId: "bg1",
        taskType: "local_bash",
        description: "bun run dev",
        toolName: "Bash",
        command: "bun run dev",
        startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    ], { backgroundForgottenAfter: "30m" });
    const agedParent = await createThread(aged.store, {
      projectId: "p",
      title: "orchestrator",
      env: { mode: "local", path: aged.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    const agedChild = await createThread(aged.store, {
      projectId: "p",
      title: "task",
      env: { mode: "local", path: aged.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    await aged.store.appendDelegation({
      id: "d1",
      parentThreadId: agedParent.id,
      childThreadId: agedChild.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    await settleChild(aged, agedChild.id, "Build it");
    const agedDescribed = await describeTask(aged.ctx, agedParent.id, agedChild.id);
    expect(agedDescribed.background.tasks[0]!.probablyForgotten).toBe(true);
    expect(durationMs("30m")).toBe(30 * 60_000);
  }, 60_000);

  it("says it cannot tell when no session holds the task", async () => {
    const w = await world(() => []);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({
      id: "d1",
      parentThreadId: parent.id,
      childThreadId: child.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    // No turn ever started on the child, so no session holds it here.
    const described = await describeTask(w.ctx, parent.id, child.id);
    expect(described.background.unknown).toBe(true);
    expect(described.background.tasks).toEqual([]);
  });
});

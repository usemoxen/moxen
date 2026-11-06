import { afterEach, describe, expect, it, vi } from "vitest";
import { settleRuns } from "../../testing/turns.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeDriver } from "../../providers/claude/driver.js";
import { FakeTransport, initMessage, successResult } from "../../providers/claude/tests/fakes.js";
import { testHarness } from "../../testing/harness.js";
import { createThread, sendTurn, openTurn, completeTurn, interruptTurn, startBackgroundTurn, settleThread, updateThreadMeta } from "../../threads/threads.js";
import { flushTurnRunners, type TurnDriver } from "../../threads/execute.js";
import { continueThread, editWorkQueue, flushTaskNotifications, queueTaskNotification, recoverTaskNotifications, runWorkQueue, scheduleUsageContinue, startTurn, type OperationContext } from "../../threads/operations.js";
import { parseQueuePolicy } from "../../threads/queue.js";
import { openThreadStore } from "../../threads/store.js";
import { driverKindOfInstance } from "../../types.js";
import { CliError } from "../../errors.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../limits.js";
import { UsageProtection, USAGE_CANDIDATE_RESCAN_MS, WRAP_UP_PROMPT } from "../protection.js";
import { UsageForecaster } from "../forecast.js";
import { modelPriceFor, usageCost } from "../prices.js";
import { buildHandoff } from "../../threads/handoff.js";

afterEach(resetUsageLimitsForTests);

async function world(provider: "claude" | "codex" = "codex", driverOverride?: TurnDriver) {
  const sent: string[] = [];
  const prompts: string[] = [];
  const harness = await testHarness({ onSendTurn: (turn) => { sent.push(turn.threadId); prompts.push(turn.prompt); } });
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: { ...harness.config, usageProtection: "auto", usageRecovery: "sequential" }, driverFor: (id) => {
    if (driverOverride) return driverOverride;
    const kind = driverKindOfInstance(id)!;
    let driver = drivers.get(kind);
    if (!driver) { driver = harness.drivers[kind]!(); drivers.set(kind, driver); }
    return driver;
  } };
  const make = async (title: string) => {
    const thread = await createThread(harness.store, { projectId: "p", title, env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: provider === "claude" ? "claudeAgent" : "codex", model: provider === "claude" ? "claude-opus-5" : "gpt-6.1-sol" } });
    await sendTurn(harness.store, thread.id, { prompt: "Finish the feature" });
    return thread.id;
  };
  return { ...harness, ctx, sent, prompts, make, guard: new UsageProtection(async () => ctx) };
}

async function settleStartedTurns(w: Awaited<ReturnType<typeof world>>, threadId: string) {
  const started = (await w.store.readTurns(threadId)).filter((turn) => turn.status === "running");
  await settleRuns();
  // A blind flush gives up silently after its limit; on a loaded runner the
  // turns are still going then, so wait for the turns themselves.
  await expect.poll(
    async () => (await w.store.readTurns(threadId)).filter((turn) => turn.status === "running").length,
    { timeout: 10_000 },
  ).toBe(0);
  const turns = await w.store.readTurns(threadId);
  for (const turn of started) expect(turns.find((settled) => settled.id === turn.id)?.status).toBe("completed");
  expect(openTurn(turns)).toBeNull();
}

describe("usage protection", () => {
  it("keeps forced wake-ups durable and ordered across reset and restart, and runs the user's message first", async () => {
    const w = await world();
    const id = await w.make("protected");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    await w.guard.protect(id);
    const first = await sendTurn(w.store, id, { prompt: "<task-notification>first: all checks passed</task-notification>", origin: "task-notification" });
    const second = await sendTurn(w.store, id, { prompt: "second: shell exit 7\nfull output remains", origin: "background-notification" });
    expect(first.turn.queue).toMatchObject({ wakeUp: true, automatic: true });
    expect(second.turn.queue!.order).toBeGreaterThan(first.turn.queue!.order);
    w.guard.close();
    const store = await openThreadStore(w.root);
    const ctx = { ...w.ctx, store };
    const restarted = new UsageProtection(async () => ctx);
    try {
      const now = Date.now();
      recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(now + 1000).toISOString() }]);
      await restarted.tick(now);
      recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(now + 3600_000).toISOString() }]);
      await restarted.tick(now + 7000);
      expect(openTurn(await store.readTurns(id))).toBeNull();
      expect((await store.readThreadRecord(id))?.usagePause).toMatchObject({ forced: true, resetsAt: null, phase: "waiting" });
      await expect(restarted.reorder(id, "cancel")).rejects.toMatchObject({ code: "THREAD_PROTECTED" });
      const manual = await startTurn(ctx, { threadId: id, prompt: "user goes first" });
      await manual.run;
      expect(manual.delivery).toBe("started");
      expect((await store.readThreadRecord(id))?.usagePause).toBeNull();
      for (const turn of [first.turn, second.turn]) {
        await runWorkQueue(ctx);
        await expect.poll(async () => (await store.readTurns(id)).find((row) => row.id === turn.id)?.status, { timeout: 10_000, interval: 10 }).toBe("completed");
      }
      expect(w.prompts).toEqual(["user goes first", "<task-notification>first: all checks passed</task-notification>", "second: shell exit 7\nfull output remains"]);
    } finally { restarted.close(); }
  });

  it("interrupts a running forced thread, wraps it once, and lets a user end protection during wrap-up", async () => {
    const w = await world();
    const id = await w.make("running");
    const original = openTurn(await w.store.readTurns(id))!;
    try {
      await w.guard.protect(id);
      expect((await w.store.readTurns(id)).find((turn) => turn.id === original.id)).toMatchObject({ status: "interrupted", usagePause: { resetsAt: null, forced: true } });
      await w.guard.tick();
      await expect.poll(async () => (await w.store.readTurns(id)).find((turn) => turn.id !== original.id)?.status, { timeout: 10_000, interval: 10 }).toBe("completed");
      await w.guard.tick();
      expect(w.prompts).toHaveLength(1);
      expect(w.prompts[0]).toContain("Wait for the user's next message");
      expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ forced: true, phase: "waiting" });
      // A wrap-up still running when the user returns must not swallow their send as a steer.
      const wrap = await sendTurn(w.store, id, { prompt: "wrap slowly", usageControl: true, origin: "usage-protection" });
      const user = await sendTurn(w.store, id, { prompt: "new work" });
      expect(user.delivery).toBe("started");
      expect((await w.store.readTurns(id)).find((turn) => turn.id === wrap.turn.id)?.status).toBe("interrupted");
      await completeTurn(w.store, id, user.turn.id, { text: "done" });
    } finally { w.guard.close(); }
  });

  it("does not let a removed wake-up hold back the ones behind it", async () => {
    const w = await world();
    const id = await w.make("protected");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    try {
      await w.guard.protect(id);
      const first = await sendTurn(w.store, id, { prompt: "dropped by the user", origin: "background-notification" });
      const second = await sendTurn(w.store, id, { prompt: "kept", origin: "background-notification" });
      await editWorkQueue(w.ctx, id, first.turn.id, "remove");
      await startTurn(w.ctx, { threadId: id, prompt: "user" }).then((manual) => manual.run);
      await runWorkQueue(w.ctx);
      await expect.poll(async () => (await w.store.readTurns(id)).find((row) => row.id === second.turn.id)?.status, { timeout: 10_000, interval: 10 }).toBe("completed");
      expect(w.prompts).toEqual(["user", "kept"]);
    } finally { w.guard.close(); }
  });

  it("keeps automatic protection armed after a purely manual hold ends, but not after an automatic one", async () => {
    const w = await world();
    const manual = await w.make("manual");
    const automatic = await w.make("automatic");
    for (const id of [manual, automatic]) await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    try {
      await w.guard.protect(manual);
      const held = (await w.store.readThreadRecord(automatic))!;
      await w.store.writeThreadRecord({ ...held, usagePause: { provider: "codex", windows: [{ id: "session", kind: "session", label: "Session", resetsAt: null }], resetsAt: null, order: 1, phase: "waiting", handoff: false } });
      await w.guard.protect(automatic);
      for (const id of [manual, automatic]) await startTurn(w.ctx, { threadId: id, prompt: "go on" }).then((sent) => sent.run);
      expect((await w.store.readThreadRecord(manual))?.usageProtectionOverride ?? null).toBeNull();
      expect((await w.store.readThreadRecord(automatic))?.usageProtectionOverride).toMatchObject({ provider: "codex" });
    } finally { w.guard.close(); }
  });

  it("lets an automatic wrap-up finish when the user protects the thread during it", async () => {
    const w = await world();
    const id = await w.make("wrapping");
    const wrap = openTurn(await w.store.readTurns(id))!;
    try {
      const thread = (await w.store.readThreadRecord(id))!;
      await w.store.writeThreadRecord({ ...thread, usagePause: { provider: "codex", windows: [], resetsAt: null, order: 1, phase: "wrapping", turnId: wrap.id, handoff: false } });
      await w.guard.protect(id);
      expect((await w.store.readTurns(id)).find((turn) => turn.id === wrap.id)?.status).toBe("running");
      expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ forced: true, phase: "wrapping" });
      await completeTurn(w.store, id, wrap.id, { text: "notes" });
      await w.guard.tick();
      await w.guard.tick();
      expect(w.prompts).toEqual([]);
      expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ forced: true, phase: "waiting" });
    } finally { w.guard.close(); }
  });

  it.each([false, true])("persists delegated task facts before the batching timer and does not need the task at replay (batch already pending: %s)", async (pending) => {
    const w = await world();
    const parent = await w.make("parent");
    await completeTurn(w.store, parent, openTurn(await w.store.readTurns(parent))!.id, { text: "idle" });
    const child = await w.make("child report");
    await completeTurn(w.store, child, openTurn(await w.store.readTurns(child))!.id, { text: "Delivered the exact task report" });
    try {
      if (pending) await queueTaskNotification(w.ctx, parent, child);
      await w.guard.protect(parent);
      if (!pending) await queueTaskNotification(w.ctx, parent, child);
      const messages = (await w.store.readMessages(parent)).filter((row) => row.origin === "task-notification");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.notification?.tasks[0]).toMatchObject({ taskId: child, title: "child report" });
      const queued = (await w.store.readTurns(parent)).find((turn) => turn.messageId === messages[0]!.id)!;
      expect(queued).toMatchObject({ status: "queued", queue: { wakeUp: true } });
      const record = (await w.store.readThreadRecord(child))!;
      await w.store.writeThreadRecord({ ...record, deletedAt: w.store.nowIso() });
      const store = await openThreadStore(w.root);
      expect((await store.readMessages(parent)).find((row) => row.id === messages[0]!.id)).toEqual(messages[0]);
      const user = await sendTurn(store, parent, { prompt: "continue" });
      await completeTurn(store, parent, user.turn.id, { text: "done" });
      await runWorkQueue({ ...w.ctx, store });
      await expect.poll(async () => (await store.readTurns(parent)).find((turn) => turn.id === queued.id)?.status, { timeout: 10_000, interval: 10 }).toBe("completed");
      expect(w.prompts[0]).toContain(messages[0]!.text);
    } finally { w.guard.close(); }
  });

  it("delivers a task notification batch held in the batch window across restart, exactly once", async () => {
    const w = await world();
    const parent = await w.make("parent");
    await completeTurn(w.store, parent, openTurn(await w.store.readTurns(parent))!.id, { text: "idle" });
    const child = await w.make("child report");
    await completeTurn(w.store, child, openTurn(await w.store.readTurns(child))!.id, { text: "Delivered the exact task report" });
    try {
      await queueTaskNotification(w.ctx, parent, child);
      // Durable before the timer fires: the sidecar names the batch.
      const persisted = JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8")) as Record<string, string[]>;
      expect(persisted[parent]).toEqual([child]);
      // A restart before the timer fires replays the batch...
      const store = await openThreadStore(w.root);
      const ctx = { ...w.ctx, store };
      await recoverTaskNotifications(ctx);
      await settleRuns();
      const messages = (await store.readMessages(parent)).filter((row) => row.origin === "task-notification");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.notification?.tasks.map((task) => task.taskId)).toEqual([child]);
      // ...and replaying finds nothing left: still exactly one.
      await recoverTaskNotifications(ctx);
      await settleRuns();
      expect((await store.readMessages(parent)).filter((row) => row.origin === "task-notification")).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8"))).toEqual({});
    } finally { w.guard.close(); }
  });

  it("keeps a batch whose delivery fails for a later retry", async () => {
    const w = await world();
    const parent = await w.make("parent");
    await completeTurn(w.store, parent, openTurn(await w.store.readTurns(parent))!.id, { text: "idle" });
    const child = await w.make("child report");
    await completeTurn(w.store, child, openTurn(await w.store.readTurns(child))!.id, { text: "Delivered the exact task report" });
    try {
      // No driver owns this provider, so delivery fails after reading the batch.
      await updateThreadMeta(w.store, parent, { modelSelection: { instanceId: "no-such-provider", model: "x" } });
      await queueTaskNotification(w.ctx, parent, child);
      await expect(flushTaskNotifications(w.ctx, parent)).rejects.toThrow();
      // At-least-once: the batch is still on disk for the retry, and nothing went out.
      expect(JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8"))).toEqual({ [parent]: [child] });
      expect((await w.store.readMessages(parent)).filter((row) => row.origin === "task-notification")).toHaveLength(0);
      await updateThreadMeta(w.store, parent, { modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
      await flushTaskNotifications(w.ctx, parent);
      await settleRuns();
      const messages = (await w.store.readMessages(parent)).filter((row) => row.origin === "task-notification");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.notification?.tasks.map((task) => task.taskId)).toEqual([child]);
      expect(JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8"))).toEqual({});
    } finally { w.guard.close(); }
  });

  it("quarantines a corrupt batch file with a warning instead of silently dropping it", async () => {
    const w = await world();
    try {
      await writeFile(path.join(w.root, "task-notification-batches.json"), "{not json", "utf8");
      const store = await openThreadStore(w.root);
      await recoverTaskNotifications({ ...w.ctx, store });
      await settleRuns();
      // Nothing delivered, and the garbage is moved aside — not reset in place —
      // with a warning where the server's own warnings go.
      const files = await readdir(w.root);
      expect(files.includes("task-notification-batches.json")).toBe(false);
      const quarantined = files.filter((file) => file.startsWith("task-notification-batches.json.corrupt-"));
      expect(quarantined).toHaveLength(1);
      expect(await readFile(path.join(w.root, quarantined[0]!), "utf8")).toBe("{not json");
      const log = await readFile(path.join(w.root, "server.log"), "utf8");
      expect(log).toContain("task-notification-batches.json");
      expect(log).toContain(quarantined[0]!);
    } finally { w.guard.close(); }
  });

  it("batches tasks settling inside the window into one notification, and only once", async () => {
    const w = await world();
    const parent = await w.make("parent");
    await completeTurn(w.store, parent, openTurn(await w.store.readTurns(parent))!.id, { text: "idle" });
    const first = await w.make("first report");
    await completeTurn(w.store, first, openTurn(await w.store.readTurns(first))!.id, { text: "one" });
    const second = await w.make("second report");
    await completeTurn(w.store, second, openTurn(await w.store.readTurns(second))!.id, { text: "two" });
    try {
      await queueTaskNotification(w.ctx, parent, first);
      await queueTaskNotification(w.ctx, parent, second);
      // The timer batches what settles inside the window: one message for
      // both tasks, and nothing more afterwards.
      await expect.poll(async () => (await w.store.readMessages(parent)).filter((row) => row.origin === "task-notification"), { timeout: 10_000, interval: 50 }).toHaveLength(1);
      await settleRuns();
      const messages = (await w.store.readMessages(parent)).filter((row) => row.origin === "task-notification");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.notification?.tasks.map((task) => task.taskId).sort()).toEqual([first, second].sort());
      await settleRuns();
      expect((await w.store.readMessages(parent)).filter((row) => row.origin === "task-notification")).toHaveLength(1);
    } finally { w.guard.close(); }
  });

  it("refuses to protect a settled thread instead of holding it forever", async () => {
    const w = await world();
    const id = await w.make("put away");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    await settleThread(w.store, id);
    try {
      // A forced hold ends on a message, but settled threads refuse messages
      // and the queue cannot cancel a forced hold: accepting this would leave
      // a hold nothing can ever release.
      await expect(w.guard.protect(id)).rejects.toMatchObject({ code: "THREAD_SETTLED" });
      expect((await w.store.readThreadRecord(id))?.usagePause ?? null).toBeNull();
    } finally { w.guard.close(); }
  });

  it("releases a forced hold left on a settled thread", async () => {
    const w = await world();
    const id = await w.make("put away");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    const thread = (await w.store.readThreadRecord(id))!;
    await w.store.writeThreadRecord({ ...thread, usagePause: { provider: "codex", windows: [], resetsAt: null, order: 1, phase: "waiting", handoff: false, forced: true }, settledAt: w.store.nowIso(), settledOverride: null, snoozedUntil: null });
    try {
      // No message can ever release it (settled threads refuse messages, and
      // the queue cannot cancel a forced hold), so the next tick does.
      await w.guard.tick();
      const record = (await w.store.readThreadRecord(id))!;
      expect(record.settledAt).not.toBeNull();
      expect(record.usagePause).toBeNull();
    } finally { w.guard.close(); }
  });

  it.each(["settled", "snoozed", "archived"] as const)("does not run held wake-ups on a %s thread", async (state) => {    const w = await world();
    const id = await w.make("put away");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    try {
      await w.guard.protect(id);
      const queued = await sendTurn(w.store, id, { prompt: "preserve this notification", origin: "task-notification", wakeSettled: true });
      const thread = (await w.store.readThreadRecord(id))!;
      const inactive = state === "settled" ? { settledAt: w.store.nowIso(), settledOverride: "settled" as const } : state === "snoozed" ? { snoozedUntil: new Date(Date.now() + 3600_000).toISOString() } : { archivedAt: w.store.nowIso() };
      await w.store.writeThreadRecord({ ...thread, ...inactive });
      if (state === "settled") {
        const late = await sendTurn(w.store, id, { prompt: "late task facts", origin: "task-notification", wakeSettled: true });
        expect(late.turn.status).toBe("queued");
        expect(late.thread.settledAt).toBe(inactive.settledAt);
      }
      if (state === "archived") await expect(w.guard.protect(id)).rejects.toMatchObject({ code: "THREAD_ARCHIVED" });
      await runWorkQueue(w.ctx);
      expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
      expect(w.prompts).toEqual([]);
    } finally { w.guard.close(); }
  });

  it("replays automatic wake-ups in order after automatic recovery, including across restart", async () => {
    const w = await world();
    const id = await w.make("automatic");
    const reset = Date.now() + 60_000;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(reset).toISOString() }]);
    await w.guard.wrap("codex");
    await w.guard.tick();
    const one = await sendTurn(w.store, id, { prompt: "first notification: exact report", origin: "task-notification" });
    const two = await sendTurn(w.store, id, { prompt: "second notification: full shell output", origin: "background-notification" });
    // Forcing an automatic hold must win over its existing reset recovery.
    const other = await w.make("both protections");
    await w.guard.wrap("codex");
    await w.guard.protect(other);
    w.guard.close();
    const store = await openThreadStore(w.root);
    const ctx = { ...w.ctx, store };
    const guard = new UsageProtection(async () => ctx);
    try {
      recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(reset + 3600_000).toISOString() }]);
      for (const turn of [one.turn, two.turn]) {
        await expect.poll(async () => {
          await guard.tick(reset + 7000);
          return (await store.readTurns(id)).find((row) => row.id === turn.id)?.status;
        }, { timeout: 10_000, interval: 10 }).toBe("completed");
      }
      expect(w.prompts.slice(-2)).toEqual(["first notification: exact report", "second notification: full shell output"]);
      expect((await store.readThreadRecord(other))?.usagePause).toMatchObject({ forced: true, resetsAt: null });
      expect(openTurn(await store.readTurns(other))).toBeNull();
    } finally { guard.close(); }
  });

  it.each(["clean", "dirty", "no checkout"] as const)("records a durable protection pause with %s working directory state", async (workingTree) => {
    const w = await world();
    const id = await w.make("unfinished work");
    const original = openTurn(await w.store.readTurns(id))!;
    if (workingTree === "dirty") await writeFile(path.join(w.work, "unfinished.txt"), "part-done");
    if (workingTree === "no checkout") {
      const folder = path.join(w.root, "plain folder");
      await mkdir(folder);
      const thread = (await w.store.readThreadRecord(id))!;
      await w.store.writeThreadRecord({ ...thread, env: { ...thread.env, path: folder } });
    }
    const reset = Date.now() + 60_000;
    const resetsAt = workingTree === "no checkout" ? null : new Date(reset).toISOString();
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt }]);
    try {
      // A driver callback racing the coordinator must not erase its pause reason.
      vi.spyOn(w.ctx.driverFor("codex"), "interruptTurn").mockImplementation(() => Effect.promise(async () => {
        await interruptTurn(w.store, id, original.id);
      }));
      await w.guard.tick();
      const paused = (await w.store.readTurns(id)).find((turn) => turn.id === original.id)!;
      expect(paused).toMatchObject({ status: "interrupted", usagePause: {
        provider: "codex", windows: [{ id: "session", kind: "session", label: "Session", resetsAt }], resetsAt,
        hasUncommittedChanges: workingTree === "no checkout" ? null : workingTree === "dirty",
      } });
      expect(paused.usagePause?.pausedAt).toBeTruthy();
      const reopened = await openThreadStore(w.root);
      expect((await reopened.readTurns(id)).find((turn) => turn.id === original.id)?.usagePause).toEqual(paused.usagePause);
      if (resetsAt !== null) {
        await w.guard.tick(reset + 6000);
        await settleStartedTurns(w, id);
        await w.guard.tick(reset + 7000);
        expect((await w.store.readThreadRecord(id))?.usagePause).toBeNull();
        expect((await w.store.readTurns(id)).find((turn) => turn.id === original.id)?.usagePause).toEqual(paused.usagePause);
      }
    } finally { w.guard.close(); }
  });

  it("does not mark normal wrap-up completion or a user interruption as paused", async () => {
    const w = await world();
    const id = await w.make("wrap-up finishes");
    const userStopped = await w.make("user stopped");
    await interruptTurn(w.store, userStopped);
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
    try {
      await w.guard.tick();
      await settleStartedTurns(w, id);
      const turns = await w.store.readTurns(id);
      expect(turns[0]?.usagePause).toBeDefined();
      expect(turns.find((turn) => turn.status === "completed")).not.toHaveProperty("usagePause");
      expect((await w.store.readTurns(userStopped))[0]).not.toHaveProperty("usagePause");
    } finally { w.guard.close(); }
  });

  it.each(["native", "moxen"])("settles Claude's held-back %s wrap-up result by stopping its shell, and prevents a late shell wake", async (mode) => {
    const transport = new FakeTransport([[initMessage()]]);
    const driver = new ClaudeDriver({ transport });
    const w = await world("claude", driver);
    const thread = await createThread(w.store, { projectId: "p", title: "watch CI", env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } });
    const system = (fields: Record<string, unknown>) => ({ type: "system", uuid: w.store.newId(), session_id: "session-1", ...fields }) as SDKMessage;
    try {
      if (mode === "moxen") await w.store.writeThreadRecord({ ...thread, usagePause: { provider: "claude", phase: "wrapping", order: Date.now(), resetsAt: null, handoff: false } });
      const started = await startTurn(w.ctx, { threadId: thread.id, prompt: "Watch CI", usageControl: true, ...(mode === "moxen" ? { origin: "usage-protection" as const } : {}) });
      const query = transport.created[0]!;
      // Current interactive SDK interrupts abort a turn, not the process.
      query.interrupt = async () => undefined;
      const stopped: string[] = [];
      Object.assign(query, { stopTask: async (taskId: string) => {
        stopped.push(taskId);
        query.push(system({ subtype: "task_notification", task_id: taskId, status: "stopped", summary: "Stopped", output_file: "" }));
        query.push(system({ subtype: "background_tasks_changed", tasks: [] }));
        query.push(successResult("Stopping here."));
      } });
      query.push(system({ subtype: "task_started", task_id: "watcher", task_type: "local_bash", description: "Watch CI", is_backgrounded: true }));
      query.push({ type: "assistant", uuid: "stopping", session_id: "session-1", parent_tool_use_id: null, message: { id: "notes", content: [{ type: "text", text: "Stopping here." }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage);
      // sdk.d.ts: idle follows heldBackResult flushing and the bg-agent do-while.
      // Until the CLI supplies that result, text alone cannot complete a turn.
      await vi.waitFor(() => expect(driver.backgroundTasks(thread.id)).toHaveLength(1), { timeout: 10_000 });
      expect(openTurn(await w.store.readTurns(thread.id))?.id).toBe(started.turn.id);
      recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 95, exhausted: false, resetsAt: null }]);
      if (mode === "native") w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: thread.id, state: "usage-wrap-up" });
      await w.guard.tick();
      expect(stopped).toEqual(["watcher"]);
      await started.run;
      await w.guard.tick();
      expect(openTurn(await w.store.readTurns(thread.id))).toBeNull();
      expect(await Effect.runPromise(driver.hasSession(thread.id))).toBe(false);
      expect(query.closed).toBe(true);
      expect((await w.store.readMessages(thread.id)).filter((row) => row.role === "assistant").map((row) => row.text)).toEqual(["Stopping here."]);
      expect(await buildHandoff(w.store, thread.id, { preferModelSummary: true })).toContain("Stopping here.");
      expect((await w.store.readActivities(thread.id)).filter((row) => row.kind === "usage.background")).toMatchObject([{ payload: { taskId: "watcher", status: "stopped" } }]);
      await expect.poll(async () => (await w.store.readMessages(thread.id)).filter((row) => row.origin === "background-notification"), { timeout: 10_000, interval: 10 }).toHaveLength(1);
      const wake = (await w.store.readMessages(thread.id)).find((row) => row.origin === "background-notification")!;
      expect(wake.text).toContain('"task_id":"watcher"');
      expect(wake.text).toContain('"summary":"Stopped"');
      const disk = await openThreadStore(w.root);
      expect((await disk.readMessages(thread.id)).find((row) => row.id === wake.id)).toEqual(wake);
      expect((await disk.readTurns(thread.id)).find((row) => row.messageId === wake.id)).toMatchObject({ status: "queued", queue: { wakeUp: true } });
      query.push(system({ subtype: "init" }));
      query.push(successResult("CI finished", 0.01, { origin: { kind: "task-notification" } }));
      await w.guard.tick();
      await expect(startBackgroundTurn(w.store, thread.id, { modelSelection: null })).rejects.toMatchObject({ code: "USAGE_PROTECTED_BACKGROUND" });
      expect((await w.store.readTurns(thread.id)).filter((turn) => turn.delivery === "background")).toEqual([]);
    } finally {
      w.guard.close();
      await Effect.runPromise(driver.interruptTurn(thread.id)).catch(() => undefined);
      await Effect.runPromise(driver.stopAll());
      await flushTurnRunners();
    }
  }, 20_000);

  it.each([true, false])("holds background work before interruption and tells recovery what happened (independent stop: %s)", async (supported) => {
    const w = await world();
    const id = await w.make("build");
    const driver = w.ctx.driverFor("codex");
    let tasks = [{ taskId: "build", taskType: "command", description: "Long build" }, { taskId: "watcher", taskType: "command", description: "Watch CI" }];
    const stopSession = vi.fn(() => Effect.sync(() => { tasks = []; }));
    const stop = vi.fn(() => supported ? Effect.sync(() => { tasks = []; }) : Effect.fail(new CliError("BACKGROUND_TASK_STOP_UNSUPPORTED", "Cannot stop independently")));
    Object.assign(driver, { backgroundTasks: () => tasks, backgroundTaskOutput: async () => tasks.length ? ({ lines: ["compiled 12 modules"] }) : null, stopBackgroundTask: stop, stopSession });
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 98, exhausted: false, resetsAt: null }]);
    try {
      await w.guard.wrap("codex");
      await w.guard.tick();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(stopSession).toHaveBeenCalled();
      expect((await w.store.readActivities(id)).filter((row) => row.kind === "usage.background")).toMatchObject([
        { payload: { taskId: "build", status: supported ? "stopped" : "detached", output: ["compiled 12 modules"] } },
        { payload: { taskId: "watcher", status: supported ? "stopped" : "detached", output: ["compiled 12 modules"] } },
      ]);
      const held = (await w.store.readThreadRecord(id))!;
      const stoppedTurn = (await w.store.readTurns(id))[0]!;
      await w.store.appendLedger(id, "messages", { id: w.store.newId(), threadId: id, turnId: stoppedTurn.id, role: "assistant", text: "The build is unfinished; inspect the saved edits.", createdAt: w.store.nowIso() });
      await w.store.writeThreadRecord({ ...held, usagePause: { ...held.usagePause!, turnId: stoppedTurn.id } });
      const resumed = await startTurn(w.ctx, { threadId: id, prompt: "Continue after reset", usageControl: true, origin: "usage-continue" });
      await resumed.run;
      expect(w.prompts.at(-1)).toContain('"status":"' + (supported ? "stopped" : "detached") + '"');
      expect(w.prompts.at(-1)).toContain("compiled 12 modules");
      expect(w.prompts.at(-1)).toContain("Check it again");
      expect(w.prompts.at(-1)).toContain("## Usage-protection wrap-up notes\n\nThe build is unfinished; inspect the saved edits.");
    } finally {
      w.guard.close();
    }
  });

  it("keeps queued input held while the wrap-up settles slowly, before and after completion", async () => {
    const w = await world();
    const id = await w.make("gated wrap-up");
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checkpoint = new Promise<void>((resolve) => { reached = resolve; });
    const append = w.store.appendLedger.bind(w.store);
    const persist = vi.spyOn(w.store, "appendLedger").mockImplementation(async (threadId, name, row) => {
      if (threadId === id && name === "checkpoints") { reached(); await gate; }
      return append(threadId, name, row);
    });
    let unsubscribe = () => {};
    try {
      recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
      await w.guard.tick();
      await checkpoint;
      const running = openTurn(await w.store.readTurns(id))!;
      expect((await w.store.readMessages(id)).find((message) => message.id === running.messageId)?.origin).toBe("usage-protection");
      const completed = new Promise<void>((resolve) => {
        unsubscribe = w.store.subscribe((event) => {
          if (event.type === "backend.thread.changed" && event.threadId === id && event.reason === "turn-completed") resolve();
        });
      });
      const queued = await sendTurn(w.store, id, { prompt: "held input", delivery: "queue" });
      expect(queued.turn.status).toBe("queued");
      expect(running.id).not.toBe(queued.turn.id);
      await w.guard.tick();
      expect(openTurn(await w.store.readTurns(id))?.id).toBe(running.id);
      expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
      release();
      await completed;
      expect((await w.store.readTurns(id)).find((turn) => turn.id === running.id)?.status).toBe("completed");
      await w.guard.tick();
      expect(openTurn(await w.store.readTurns(id))).toBeNull();
      expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
    } finally {
      release();
      unsubscribe();
      await flushTurnRunners();
      persist.mockRestore();
      w.guard.close();
    }
  });

  // Fifty threads of setup plus repeated ticks: a loaded runner does not fit in the twenty-second default.
  it.each(["off", "auto"] as const)("%s ticks do not reread idle history and discover queued work from store events", async (mode) => {
    const w = await world();
    w.ctx.config.usageProtection = mode;
    const idle: string[] = [];
    for (let index = 0; index < 50; index++) {
      const id = await w.make(`idle ${index}`);
      await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "done" });
      await w.store.rewriteLedger(id, "activity", Array.from({ length: 20 }, (_, index) => ({
        id: `activity-${index}`, threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(),
        payload: { usedTokens: 10_000, cachedInputTokens: 5000, detail: "history".repeat(100) },
      })));
      idle.push(id);
    }
    const running = await w.make("running");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const now = Date.now();
    await w.guard.tick(now);
    const turns = vi.spyOn(w.store, "readTurns");
    const activities = vi.spyOn(w.store, "readActivities");
    const records = vi.spyOn(w.store, "readThreadRecord");
    const lists = vi.spyOn(w.store, "listThreadIds");
    for (let tick = 1; tick <= 3; tick++) await w.guard.tick(now + tick * 2000);
    expect(turns.mock.calls.every(([id]) => id === running)).toBe(true);
    expect(records.mock.calls.every(([id]) => id === running)).toBe(true);
    expect(activities).not.toHaveBeenCalled();
    expect(lists).not.toHaveBeenCalled();
    await sendTurn(w.store, idle[0]!, { prompt: "queued through the API", queue: parseQueuePolicy({ conditions: [], held: true }) });
    turns.mockClear(); records.mockClear();
    await w.guard.tick(now + 8000);
    expect(turns.mock.calls.some(([id]) => id === idle[0])).toBe(true);
    expect(turns.mock.calls.every(([id]) => id === running || id === idle[0])).toBe(true);
    expect(lists).not.toHaveBeenCalled();
    // Another process has no local emitter: a periodic scan must still find its work.
    const outside = await openThreadStore(w.root);
    const external = await createThread(outside, {
      projectId: "p", title: "external write", env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    await sendTurn(outside, external.id, { prompt: "work from another process" });
    await w.guard.tick(now + 10_000);
    expect(turns.mock.calls.some(([id]) => id === external.id)).toBe(false);
    await w.guard.tick(now + USAGE_CANDIDATE_RESCAN_MS);
    expect(turns.mock.calls.some(([id]) => id === external.id)).toBe(true);
    expect(lists).toHaveBeenCalledTimes(1);
    w.guard.close();
  }, 60_000);

  it("keeps context readings live without rereading activity history, and replaces live cost on settlement", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("live context");
    const turn = openTurn(await w.store.readTurns(id))!;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    await w.guard.tick();
    const activities = vi.spyOn(w.store, "readActivities");
    await w.store.appendLedger(id, "activity", {
      id: "context", threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(),
      payload: { usedTokens: 20_000, cachedInputTokens: 10_000 },
    });
    w.guard.observe({ type: "token-usage.updated", threadId: id, provider: "codex",
      usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 2 } });
    await w.guard.tick();
    expect(forecast.mock.calls.at(-1)?.[2]).toMatchObject({ costUsd: 2 });
    expect(forecast.mock.calls.at(-1)?.[2].wrapCostUsd).toBeGreaterThan(0);
    await completeTurn(w.store, id, turn.id, {
      text: "done", usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 3 },
    });
    w.guard.observe({ type: "turn.completed", threadId: id, provider: "codex", turnId: turn.id });
    await w.guard.tick();
    expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBe(3);
    expect(activities).not.toHaveBeenCalled();
    forecast.mockRestore();
    w.guard.close();
  });

  it("prices recorded usage as it is: input already excludes cached reads, so the cache is not subtracted again", async () => {
    // Every driver records `input` and `cacheRead` as disjoint (MXN-235): 10,000 uncached plus 90,000 cached.
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("cached work");
    const turn = openTurn(await w.store.readTurns(id))!;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    const usage = { input: 10_000, cacheRead: 90_000, cacheCreate: 0, output: 0, thinking: 0 };
    w.guard.observe({ type: "token-usage.updated", threadId: id, provider: "codex", usage });
    await w.guard.tick();
    const priced = usageCost(modelPriceFor(w.ctx.config, "codex", "gpt-6.1-sol"), usage)!.usd;
    expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBeCloseTo(priced, 9);
    await completeTurn(w.store, id, turn.id, { text: "done", usage });
    w.guard.observe({ type: "turn.completed", threadId: id, provider: "codex", turnId: turn.id });
    await w.guard.tick();
    expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBeCloseTo(priced, 9);
    forecast.mockRestore();
    w.guard.close();
  });

  it("counts Claude cumulative gains and session resets once, not every historical snapshot", async () => {
    const w = await world("claude");
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("cumulative costs");
    const usage = { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0 };
    for (const costUsd of [2, 5, 1]) {
      await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "done", usage: { ...usage, costUsd } });
      await sendTurn(w.store, id, { prompt: "more work" });
    }
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    await w.guard.tick();
    await w.store.appendLedger(id, "activity", {
      id: "context", threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(), payload: { costUsd: 3, usedTokens: 200_000, cachedInputTokens: 0 },
    });
    await w.guard.tick();
    await w.guard.tick();
    expect(forecast.mock.calls.map(([, , work]) => work.costUsd)).toEqual([6, 8, 8]);
    // A 200k Opus context costs one input plus 4096 output tokens each tick,
    // independent of the $8 accumulated across past turns and the live turn.
    for (const [, , work] of forecast.mock.calls.slice(1)) expect(work.wrapCostUsd).toBeCloseTo(1.3524, 9);
    forecast.mockRestore();
    w.guard.close();
  });

  it("counts live Claude cost after its cumulative total restarts below the settled total", async () => {
    const w = await world("claude");
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("restarted cost");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, {
      text: "done", usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 5 },
    });
    await sendTurn(w.store, id, { prompt: "more work" });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    try {
      await w.guard.tick();
      await w.store.appendLedger(id, "activity", {
        id: "context", threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(), payload: { costUsd: 1 },
      });
      await w.guard.tick();
      await w.guard.tick();
      expect(forecast.mock.calls.map(([, , work]) => work.costUsd)).toEqual([5, 6, 6]);
    } finally {
      forecast.mockRestore();
      w.guard.close();
    }
  });

  it.each(["codex", "claude"] as const)("%s cost stays monotone when paid threads leave the candidate set", async (provider) => {
    const w = await world(provider);
    w.ctx.config.usageProtection = "notify";
    const paid = await w.make("paid work");
    const other = await w.make("still running");
    const turn = openTurn(await w.store.readTurns(paid))!;
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    const window = { id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null };
    recordUsageWindows(provider, [window]);
    const now = Date.now();
    await w.guard.tick(now);
    await completeTurn(w.store, paid, turn.id, {
      text: "done", usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 4 },
    });
    recordUsageWindows(provider, [{ ...window, usedPercent: 21 }]);
    await w.guard.tick(now + 2000);
    const calibrated = w.guard.read().forecasts[0]!.remainingWorkMs;
    expect(calibrated).not.toBeNull();
    const turns = vi.spyOn(w.store, "readTurns");
    await w.guard.tick(now + 4000);
    expect(turns.mock.calls.every(([id]) => id === other)).toBe(true);
    const costs = forecast.mock.calls.map(([, , work]) => work.costUsd);
    expect(costs).toEqual([0, 4, 4]);
    expect(w.guard.read().forecasts[0]!.remainingWorkMs).toBe(calibrated);
    forecast.mockRestore();
    w.guard.close();
  });

  it.each(["claude", "codex"] as const)("%s lets a manual message override only its thread until the next reset, across restart", async (provider) => {
    const w = await world(provider);
    const first = await w.make("override");
    const second = await w.make("still protected");
    const reset = new Date(Date.now() + 60_000).toISOString();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: reset }]);
    await w.guard.tick();
    const recovery = (await w.store.readThreadRecord(first))!.usagePause!.recoveryTurnId!;
    await sendTurn(w.store, first, { prompt: "later", scheduledFor: new Date(Date.now() + 86400_000).toISOString() });
    await sendTurn(w.store, first, { prompt: "task settled", origin: "task-notification" });
    expect((await w.store.readThreadRecord(first))?.usagePause).not.toBeNull();
    await expect(sendTurn(w.store, first, { prompt: "invalid restart", delivery: "restart" })).rejects.toThrow("no active turn");
    expect((await w.store.readThreadRecord(first))?.usageProtectionOverride).toBeUndefined();
    const sent = await sendTurn(w.store, first, { prompt: "Continue anyway" });
    expect(sent.turn.status).toBe("running");
    expect(sent.thread.usagePause).toBeNull();
    expect(sent.thread.usageProtectionOverride?.provider).toBe(provider);
    expect((await w.store.readTurns(first)).find((turn) => turn.id === recovery)).toMatchObject({ status: "interrupted", queue: { removed: true } });
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    expect(openTurn(await w.store.readTurns(first))?.id).toBe(sent.turn.id);
    expect((await w.store.readThreadRecord(second))?.usagePause).not.toBeNull();
    // Reset ends the override permanently, not just for the first low report.
    const nextReset = new Date(Date.parse(reset) + 3600_000).toISOString();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: nextReset }]);
    await restarted.tick();
    expect((await w.store.readThreadRecord(first))?.usageProtectionOverride).toBeNull();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: nextReset }]);
    await restarted.tick();
    expect((await w.store.readThreadRecord(first))?.usagePause).not.toBeNull();
    expect(openTurn(await w.store.readTurns(first))).toBeNull();
  });

  it("does not interrupt or double-wrap Claude's native allowance, including after restart", async () => {
    const w = await world("claude");
    w.ctx.config.providers = { claude: { usageWrapUp: "provider" } };
    const id = await w.make("native");
    const turn = openTurn(await w.store.readTurns(id))!;
    const stop = vi.spyOn(w.ctx.driverFor("claudeAgent"), "interruptTurn");
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3600_000).toISOString() }]);
    w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: id, state: "usage-wrap-up" });
    await w.guard.tick();
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    expect(stop).not.toHaveBeenCalled();
    expect(w.sent).toEqual([]);
    expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ phase: "wrapping", native: true });
    await expect(w.guard.wrap("claude")).rejects.toThrow("Claude Code manages wrap-up");
    await completeTurn(w.store, id, turn.id, { text: "Stopped safely. Next: tests." });
    await restarted.tick();
    expect(restarted.read().queue[0]?.phase).toBe("waiting");
  });

  it("does not interrupt Claude's native allowance when it starts during a Moxen wrap-up", async () => {
    const w = await world("claude");
    const id = await w.make("Moxen wrap-up");
    const turn = openTurn(await w.store.readTurns(id))!;
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    const thread = (await w.store.readThreadRecord(id))!;
    await w.store.writeThreadRecord({ ...thread, usagePause: {
      provider: "claude", phase: "wrapping", resetsAt, order: 1, handoff: false, turnId: turn.id,
    } });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: false, resetsAt }]);
    const stop = vi.spyOn(w.ctx.driverFor("claudeAgent"), "interruptTurn");
    w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: id, state: "usage-wrap-up" });
    await w.guard.tick();
    expect(stop).not.toHaveBeenCalled();
    expect(openTurn(await w.store.readTurns(id))?.id).toBe(turn.id);
    expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ phase: "wrapping", native: true, turnId: turn.id, order: 1 });
    expect(w.sent).toEqual([]);
    await completeTurn(w.store, id, turn.id, { text: "safe stopping point" });
    await w.guard.tick();
    expect(w.guard.read().queue[0]?.phase).toBe("waiting");
    w.guard.close();
  });

  it("does not wait for a weekly reset when the session reserve triggers below 90 percent", async () => {
    const w = await world();
    const ids = [];
    for (let index = 0; index < 4; index++) ids.push(await w.make(`work ${index}`));
    const now = Date.now();
    const session = new Date(now + 3600_000).toISOString();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 89, exhausted: false, resetsAt: session },
      { id: "weekly", label: "Weekly", usedPercent: 20, exhausted: false, resetsAt: new Date(now + 6 * 86400_000).toISOString() },
    ]);
    await w.guard.tick(now);
    expect(w.guard.read().queue).toHaveLength(4);
    expect(w.guard.read().queue.map((entry) => entry.resetsAt)).toEqual(ids.map(() => session));
    for (const id of ids) {
      await settleStartedTurns(w, id);
      await w.guard.tick(now);
    }
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick(Date.parse(session) + 6000);
    await flushTurnRunners();
    expect(w.sent).toHaveLength(5);
    restarted.close();
    w.guard.close();
  });

  it.each([20, 80])("manual wrap-up does not wait for a less urgent reset (weekly usage: %s percent)", async (weeklyPercent) => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("manual wrap-up");
    const now = Date.now();
    const session = new Date(now + 3600_000).toISOString();
    recordUsageWindows("codex", [
      { id: "weekly", label: "Weekly", usedPercent: weeklyPercent, exhausted: false, resetsAt: new Date(now + 6 * 86400_000).toISOString() },
      { id: "session", label: "Session", usedPercent: 80, exhausted: false, resetsAt: session },
    ]);
    await w.guard.tick(now);
    expect(w.guard.read().forecasts.every((forecast) => !forecast.shouldWrap)).toBe(true);
    await w.guard.wrap("codex");
    expect((await w.store.readThreadRecord(id))?.usagePause?.resetsAt).toBe(session);
    await settleStartedTurns(w, id);
    w.guard.close();
  });

  it("does not lose native wrap-up or its recovery notes when its turn settles before the next scheduler tick", async () => {
    const w = await world("claude");
    w.ctx.config.providers = { claude: { usageWrapUp: "provider" } };
    const id = await w.make("already stopped");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "safe stopping point" });
    const reset = Date.now() + 3600_000;
    recordUsageWindows("claude", [{
      id: "session", label: "Session", usedPercent: 100, exhausted: true,
      resetsAt: new Date(reset).toISOString(),
    }]);
    w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: id, state: "usage-wrap-up" });
    await w.guard.tick();
    expect(w.guard.read().queue[0]).toMatchObject({ threadId: id, phase: "waiting", native: true });
    expect((await w.store.readThreadRecord(id))?.usagePause?.recoveryTurnId).toBeTruthy();
    await w.guard.tick(reset + 6000);
    await settleStartedTurns(w, id);
    expect(w.prompts.at(-1)).toContain("## Usage-protection wrap-up notes\n\nsafe stopping point");
    w.guard.close();
  });

  it("notify mode leaves work running until requested, and cancellation keeps queued messages unsent", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("notify");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    expect(w.guard.read().forecasts[0]?.shouldWrap).toBe(true);
    expect(openTurn(await w.store.readTurns(id))).not.toBeNull();
    await w.guard.wrap("codex");
    const queued = await sendTurn(w.store, id, { prompt: "Keep this request", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    expect(await scheduleUsageContinue(w.ctx, id, queued.turn.id, new Date(Date.now() + 1000).toISOString())).toBeNull();
    await w.guard.reorder(id, "cancel");
    await w.guard.tick();
    expect(w.guard.read().queue).toEqual([]);
    expect(openTurn(await w.store.readTurns(id))).toBeNull();
    expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
  });

  it("recovers a missing reset time when telemetry supplies it, and releases parallel threads together", async () => {
    const w = await world();
    w.ctx.config.usageRecovery = "parallel";
    await w.make("one");
    await w.make("two");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    const reset = Date.now() + 60_000;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(reset).toISOString() }]);
    await w.guard.tick();
    expect(w.guard.read().queue.every((entry) => entry.resetsAt === new Date(reset).toISOString())).toBe(true);
    await w.guard.tick(reset + 6000);
    await settleRuns();
    expect(w.sent).toHaveLength(2);
  });

  it("fills a missing reset time from the recovery entry's window while no window runs hot", async () => {
    const w = await world();
    const id = await w.make("held");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "idle" });
    const now = Date.now();
    const soon = new Date(now + 60_000).toISOString();
    const recovery = await sendTurn(w.store, id, {
      prompt: "resume", origin: "usage-continue",
      queue: { ...parseQueuePolicy({ conditions: [{ type: "reset", provider: "codex", window: "session" }], order: 1, sequential: true, continuation: "same-thread" }), automatic: true, requestId: "usage:1" },
    });
    await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(id))!, usagePause: { provider: "codex", windows: [{ id: "session", kind: "session", label: "Session", resetsAt: null }], resetsAt: null, order: 1, phase: "waiting", handoff: false, recoveryTurnId: recovery.turn.id } });
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 50, exhausted: false, resetsAt: soon },
    ]);
    try {
      await w.guard.tick(now);
      // The recovery entry waits for the session reset, so the pause names it
      // too — even though no window runs hot enough for the old heuristic.
      expect((await w.store.readThreadRecord(id))?.usagePause?.resetsAt).toBe(soon);
    } finally { w.guard.close(); }
  });

  it("still recovers the other held threads when closing one thread's session fails", async () => {
    const w = await world();
    w.ctx.config.usageRecovery = "parallel";
    const stuck = await w.make("one");
    await w.make("two");
    const reset = Date.now() + 60_000;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(reset).toISOString() }]);
    await w.guard.tick();
    const driverFor = w.ctx.driverFor;
    vi.spyOn(w.ctx, "driverFor").mockImplementation((id) => {
      const driver = Object.create(driverFor(id)) as TurnDriver;
      return Object.assign(driver, { stopSession: (threadId: string) => threadId === stuck ? Effect.fail(new CliError("CODEX_FAILED", "session would not close")) : Effect.void });
    });
    await w.guard.tick(reset + 6000);
    await settleRuns();
    expect(w.sent).toHaveLength(2);
  });

  // Crash, restart, and two recovery turns: a loaded runner does not fit in the twenty-second default.
  it.each([false, true])("resumes after a crash before recovery admission when wrap-up was skipped (queued input: %s)", async (queued) => {
    const w = await world();
    const id = await w.make("skipped wrap-up");
    const reset = Date.now() + 60_000;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(reset).toISOString() }]);
    await w.guard.tick();
    if (queued) await sendTurn(w.store, id, { prompt: "Preserve this request", delivery: "queue" });
    const write = w.store.writeThreadRecord.bind(w.store);
    const crash = vi.spyOn(w.store, "writeThreadRecord").mockImplementation(async (thread) => {
      await write(thread);
      if (thread.usagePause?.phase === "resuming") throw new Error("server stopped before turn admission");
    });
    await expect(w.guard.tick(reset + 6000)).rejects.toThrow("server stopped");
    crash.mockRestore();
    expect(w.sent).toEqual([]);
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick(reset + 6000);
    await settleStartedTurns(w, id);
    expect(w.sent.filter((threadId) => threadId === id).length).toBe(queued ? 2 : 1);
    expect((await w.store.readMessages(id)).filter((message) => message.role === "user" && message.origin === "usage-continue")).toHaveLength(1);
    await restarted.tick(reset + 7000);
    expect(restarted.read().queue).toEqual([]);
  }, 60_000);

  it("reuses a persisted handoff and keeps future scheduled requests out of its prompt", async () => {
    const w = await world();
    const id = await w.make("handoff");
    const turn = openTurn(await w.store.readTurns(id))!;
    await completeTurn(w.store, id, turn.id, { text: "Model summary: implementation finished, tests remain." });
    const thread = (await w.store.readThreadRecord(id))!;
    await w.store.writeThreadRecord({ ...thread, usagePause: { provider: "codex", phase: "waiting", resetsAt: null, order: 1, handoff: true, turnId: turn.id } });
    await sendTurn(w.store, id, { prompt: "Do this next week only", scheduledFor: new Date(Date.now() + 7 * 86400_000).toISOString() });
    const first = await continueThread(w.ctx, { threadId: id, automatic: true });
    await settleStartedTurns(w, first.threadId);
    const again = await continueThread(w.ctx, { threadId: id, automatic: true });
    expect(again.threadId).toBe(first.threadId);
    expect(w.sent).toEqual([first.threadId]);
    const prompt = (await w.store.readMessages(first.threadId)).find((message) => message.role === "user")!.text;
    expect(prompt).toContain("Model summary: implementation finished, tests remain.");
    expect(prompt).not.toContain("Do this next week only");
    expect((await w.store.readTurns(id)).at(-1)?.status).toBe("queued");
    await interruptTurn(w.store, id, (await w.store.readTurns(id)).at(-1)!.id);
  });

  it.each(["claude", "codex"] as const)("%s holds queued input across restart and wraps only one thread at a time", async (provider) => {
    const w = await world(provider);
    const first = await w.make("first");
    const second = await w.make("second");
    const reset = new Date(Date.now() + 3600_000).toISOString();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 94, exhausted: false, resetsAt: reset }]);
    await w.guard.tick();
    await settleStartedTurns(w, first);
    expect(w.sent).toEqual([first]);
    expect((await w.store.readThreadRecord(second))?.usagePause?.phase).toBe("pending");
    const queued = await sendTurn(w.store, first, { prompt: "Also test the edge case", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    expect(openTurn(await w.store.readTurns(first))).toBeNull();
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    await settleStartedTurns(w, second);
    expect(w.sent).toEqual([first, second]);
    await restarted.tick();
    expect(restarted.read().queue.every((entry) => entry.phase === "waiting")).toBe(true);
    expect((await w.store.readMessages(first)).find((message) => message.text === WRAP_UP_PROMPT)?.origin).toBe("usage-protection");
    await restarted.reorder(second, "first");
    expect(restarted.read().queue[0]?.threadId).toBe(second);
    await restarted.tick(Date.parse(reset) + 6000);
    await settleRuns();
    expect(w.sent[2]).toBe(second);
    expect((await w.store.readThreadRecord(first))?.usagePause?.phase).toBe("waiting");
  });

  it("does not release a session reset through a spent weekly window or invent OpenCode quota", async () => {
    const w = await world();
    const id = await w.make("blocked");
    const now = Date.now();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(now + 1000).toISOString() },
      { id: "weekly", label: "Weekly", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 86400_000).toISOString() },
    ]);
    await w.guard.tick(now);
    expect(w.sent).toEqual([]);
    expect((await w.store.readTurns(id))[0]?.usagePause).toMatchObject({
      windows: [{ id: "session" }, { id: "weekly" }], resetsAt: new Date(now + 86400_000).toISOString(),
    });
    await w.guard.tick(now + 10_000);
    expect((await w.store.readThreadRecord(id))?.usagePause?.phase).toBe("waiting");
    expect(w.sent).toEqual([]);
    await expect(w.guard.wrap("opencode")).rejects.toThrow("has not reported usage");
  });

  it("opt-out never interrupts work and held queues do not promote on completion", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "off";
    const id = await w.make("manual");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    expect(openTurn(await w.store.readTurns(id))).not.toBeNull();
    expect(w.guard.read().forecasts).toEqual([]);
    await w.guard.wrap("codex");
    const queued = await sendTurn(w.store, id, { prompt: "queued", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    await w.guard.tick();
    await settleStartedTurns(w, id);
    await w.guard.tick();
    expect(w.guard.read().queue[0]?.resetsAt).toBeNull();
    expect(openTurn(await w.store.readTurns(id))).toBeNull();
  });
});

describe("usage forecasts", () => {
  it("does not wrap at 64 percent when parallel Claude turns report cost in lumps", () => {
    const f = new UsageForecaster();
    const window = { id: "session", kind: "session", label: "Session", resetsAt: "2030-01-01" };
    // Two threads run for twenty minutes, but only completed turns add cost.
    // The last four points report just $0.10: interval learning reserves 90 points.
    const samples: readonly (readonly [number, number, number])[] = [
      [44, 10, 0], [48, 12, 480_000], [52, 14, 960_000],
      [56, 15.9, 1_440_000], [60, 15.9, 1_680_000], [64, 16, 2_400_000],
    ];
    for (const [usedPercent, costUsd, activeMs] of samples) {
      const forecast = f.forecast("claude", { ...window, usedPercent }, { costUsd, activeMs, wrapCostUsd: 1.5, running: 2 });
      expect(forecast.shouldWrap).toBe(false);
      if (usedPercent === 64) expect(forecast).toMatchObject({ reservePercent: 7.5, remainingWorkMs: 1_980_000 });
    }
    expect(f.forecast("claude", { ...window, usedPercent: 90 }, { costUsd: 23.8, activeMs: 5_520_000, wrapCostUsd: 1.5, running: 2 }).shouldWrap).toBe(true);
  });

  it.each([null, 100])("bounds the reserve even with an uncalibrated or oversized wrap-up cost (%s)", (wrapCostUsd) => {
    const f = new UsageForecaster();
    const window = { id: "session", kind: "session", label: "Session", resetsAt: null };
    const work = { costUsd: 10, activeMs: 0, wrapCostUsd, running: 20 };
    f.forecast("claude", { ...window, usedPercent: 44 }, work);
    expect(f.forecast("claude", { ...window, usedPercent: 64 }, { ...work, costUsd: 10.1, activeMs: 60_000 })).toMatchObject({ reservePercent: 10, shouldWrap: false });
    expect(f.forecast("claude", { ...window, usedPercent: 87 }, { ...work, costUsd: 10.2, activeMs: 120_000 })).toMatchObject({ reservePercent: 10, shouldWrap: true });
  });

  it("learns cost per percent separately per window and forgets it at reset", () => {
    const f = new UsageForecaster();
    const window = { id: "s", kind: "session", label: "Session", usedPercent: 90, resetsAt: "2030-01-01" };
    f.forecast("codex", window, { activeMs: 0, costUsd: 10, wrapCostUsd: 1, running: 2 });
    const forecast = f.forecast("codex", { ...window, usedPercent: 94 }, { activeMs: 240_000, costUsd: 12, wrapCostUsd: 1, running: 2 });
    expect(forecast).toMatchObject({ reservePercent: 3, remainingWorkMs: 90_000, shouldWrap: true });
    expect(f.forecast("codex", { ...window, resetsAt: "2030-01-02", usedPercent: 1 }, { activeMs: 250_000, costUsd: 13, wrapCostUsd: 1, running: 2 }).remainingWorkMs).toBeNull();
    expect(f.forecast("codex", { ...window, id: "w" }, { activeMs: 250_000, costUsd: 13, wrapCostUsd: 1, running: 2 }).remainingWorkMs).toBeNull();
    expect(f.forecast("codex", { ...window, id: "w", usedPercent: 94 }, { activeMs: 290_000, costUsd: 17, wrapCostUsd: 1, running: 2 })).toMatchObject({ reservePercent: 2, remainingWorkMs: 15_000 });
    // A reset can also arrive as a percentage or cost regression without a new reset timestamp.
    expect(f.forecast("codex", { ...window, id: "w", usedPercent: 2 }, { activeMs: 300_000, costUsd: 18, wrapCostUsd: 1, running: 2 }).remainingWorkMs).toBeNull();
    expect(f.forecast("codex", { ...window, id: "w", usedPercent: 3 }, { activeMs: 310_000, costUsd: 1, wrapCostUsd: 1, running: 2 }).remainingWorkMs).toBeNull();
  });

  it("prefers reported cost, charges cached input once, and never adds reasoning twice", () => {
    const usage = { input: 1e6, cacheRead: 1e6, cacheCreate: 1e6, output: 1e6, thinking: 1e6 };
    const shipped = modelPriceFor({}, "codex", "gpt-6.1-sol");
    expect(usageCost(shipped, usage)).toEqual({ usd: 14.6, source: "estimated" });
    expect(usageCost(null, { ...usage, costUsd: 0 })).toEqual({ usd: 0, source: "reported" });
    expect(usageCost(null, usage)).toBeNull();
  });

  it("prices live and settled work at the user's rows over the shipped list", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    w.ctx.config.providers = { codex: { modelInputPrices: { "gpt-6.1-sol": 7 }, modelOutputPrices: { "gpt-6.1-sol": 1 }, modelCacheReadPrices: { "gpt-6.1-sol": 0 }, modelCacheWritePrices: { "gpt-6.1-sol": 0 } } };
    const id = await w.make("user priced");
    const turn = openTurn(await w.store.readTurns(id))!;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    try {
      const usage = { input: 10_000, cacheRead: 90_000, cacheCreate: 0, output: 1_000, thinking: 0 };
      w.guard.observe({ type: "token-usage.updated", threadId: id, provider: "codex", usage });
      await w.guard.tick();
      // 10k input at the user's 7 plus 1k output at the user's 1, cache at the user's 0.
      expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBeCloseTo(0.071, 9);
      await completeTurn(w.store, id, turn.id, { text: "done", usage });
      w.guard.observe({ type: "turn.completed", threadId: id, provider: "codex", turnId: turn.id });
      await w.guard.tick();
      expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBeCloseTo(0.071, 9);
    } finally {
      forecast.mockRestore();
      w.guard.close();
    }
  });
});

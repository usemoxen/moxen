import * as Effect from "effect/Effect";
import { CliError } from "../errors.js";
import { readStatus } from "../git/history.js";
import type { ProviderRuntimeEvent, TokenUsageDelta } from "../providers/spi.js";
import { startTurn, editWorkQueue, flushTaskNotifications, recoverOrphanedTurn, runWorkQueue, type OperationContext } from "../threads/operations.js";
import { interruptTurn, openTurn, sendTurn } from "../threads/threads.js";
import { QUEUE_RESET_GRACE_MS, nextReset, parseQueuePolicy } from "../threads/queue.js";
import type { StoredThread, StoredTurn, UsagePause } from "../threads/types.js";
import { recordUsageProtection, usageKeyForInstance, usageLimitsSnapshot, usageProtectionOverrideActive } from "./limits.js";
import { usageCost, UsageForecaster, type UsageForecast } from "./forecast.js";

const wrapUpPrompt = (reason: string, resume: string) => `${reason} Stop expanding the task. Use only essential tools to leave current work safe; do not commit or publish unless already authorized. ${resume} Do not spend allowance on a handoff summary. Leave only brief stopping notes if needed to resume safely; do not claim the task is finished. Preserve the remaining allowance.`;
export const WRAP_UP_PROMPT = wrapUpPrompt("The provider's shared usage allowance is nearly exhausted.", "You will resume in this same conversation automatically.");
const FORCED_WRAP_UP_PROMPT = wrapUpPrompt("The user has protected this thread.", "Wait for the user's next message before resuming.");
const RESUME_PROMPT = "The usage allowance has reset. Resume the unfinished task from your wrap-up, preserving the user's instructions. Check the working tree before continuing; do not redo completed work.";

export interface UsageQueueEntry extends UsagePause { readonly threadId: string; readonly title: string }
export interface UsageProtectionSnapshot { readonly forecasts: readonly UsageForecast[]; readonly queue: readonly UsageQueueEntry[] }
interface Row { thread: StoredThread; turns: StoredTurn[] }
export const USAGE_CANDIDATE_RESCAN_MS = 60_000;

/** Account-wide coordinator owned by the server, never by an open client tab.
 * Queue state is in the thread record so a server restart cannot release held messages. */
export class UsageProtection {
  private readonly forecaster = new UsageForecaster();
  private readonly live = new Map<string, TokenUsageDelta>();
  private readonly nativeWrap = new Set<string>();
  private readonly activeMs = new Map<string, number>();
  private readonly activeCounts = new Map<string, number>();
  private readonly candidates = new Map<string, Row>();
  private readonly dirty = new Set<string>();
  private readonly contexts = new Map<string, Record<string, unknown> | null>();
  private readonly counted = new Set<string>();
  private readonly completedCost = new Map<string, number>();
  private readonly costCounter = new Map<string, number>();
  private readonly runningCost = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private scannedAt: number | null = null;
  private closed = false;
  private lastAt: number | null = null;
  private snapshot: UsageProtectionSnapshot = { forecasts: [], queue: [] };
  private enabled = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: () => Promise<OperationContext>) {}

  observe(event: ProviderRuntimeEvent): void {
    if (event.type === "token-usage.updated") this.live.set(event.threadId, event.usage);
    if (event.type === "thread.state.changed" && event.state === "usage-wrap-up") {
      this.nativeWrap.add(event.threadId);
      this.dirty.add(event.threadId);
    }
    if (event.type === "turn.completed" || event.type === "turn.interrupted" || event.type === "turn.failed") {
      this.live.delete(event.threadId);
    }
  }

  close(): void { this.closed = true; this.unsubscribe?.(); this.unsubscribe = null; }

  read(): UsageProtectionSnapshot { return { ...this.snapshot, forecasts: this.enabled ? this.snapshot.forecasts : [] }; }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  tick(now = Date.now()): Promise<void> { return this.serialize(() => this.step(now)); }

  protect(threadId: string): Promise<void> {
    return this.serialize(async () => {
      const ctx = await this.context();
      await ctx.store.withThreadLock(threadId, async () => {
        const thread = await ctx.store.readThreadRecord(threadId);
        if (!thread || thread.deletedAt) throw new CliError("THREAD_NOT_FOUND", "The thread does not exist.");
        if (thread.archivedAt) throw new CliError("THREAD_ARCHIVED", "An archived thread cannot be protected.");
        if (thread.usagePause?.forced) return;
        const running = openTurn(await ctx.store.readTurns(threadId));
        const provider = usageKeyForInstance((running?.modelSelection ?? thread.modelSelection).instanceId);
        // A wrap-up already under way is the one wrap-up this hold gets.
        const wrapping = thread.usagePause?.phase === "wrapping";
        await ctx.store.writeThreadRecord({ ...thread, usageProtectionOverride: null, usagePause: {
          ...(thread.usagePause ?? { provider, windows: [], order: Date.now(), handoff: false }),
          forced: true, resetsAt: null, ...(wrapping ? {} : { native: false }), phase: wrapping ? "wrapping" : running ? "pending" : "waiting",
        }, updatedAt: ctx.store.nowIso() });
        recordUsageProtection(provider);
        ctx.store.emit(threadId, "usage-protection");
      });
      const thread = (await ctx.store.readThreadRecord(threadId))!;
      const row = { thread, turns: await ctx.store.readTurns(threadId) };
      await flushTaskNotifications(ctx, threadId);
      if (thread.usagePause!.phase !== "wrapping") await this.stop(ctx, row);
      await this.stopBackgroundOrRetry(ctx, row, thread.usagePause!);
      await this.refresh(ctx, Date.now(), await this.rows(ctx));
    });
  }

  wrap(provider: string): Promise<void> {
    return this.serialize(async () => {
      const ctx = await this.context();
      const rows = await this.rows(ctx);
      if (provider === "claude" && ctx.config.providers?.claude?.usageWrapUp === "provider") throw new CliError("USAGE_PROVIDER_WRAP_UP", "Claude Code manages wrap-up. Choose Moxen in Usage wrap-up to request it here.");
      if (!usageLimitsSnapshot()[provider]?.windows.length) throw new CliError("USAGE_UNAVAILABLE", "This provider has not reported usage windows.");
      const triggering = this.snapshot.forecasts.filter((forecast) => forecast.provider === provider && forecast.shouldWrap);
      await this.begin(ctx, rows, provider, Date.now(), triggering.length ? triggering : undefined);
      await this.refresh(ctx, Date.now(), await this.rows(ctx, Date.now(), true));
    });
  }

  reorder(threadId: string, direction: "first" | "last" | "cancel"): Promise<void> {
    return this.serialize(async () => {
      const ctx = await this.context();
      const rows = await this.rows(ctx);
      const row = rows.find((row) => row.thread.id === threadId && !row.thread.archivedAt);
      if (!row?.thread.usagePause) throw new CliError("USAGE_QUEUE_MISSING", "The thread is not waiting for usage.");
      if (direction === "cancel") {
        if (row.thread.usagePause.forced) throw new CliError("THREAD_PROTECTED", "Send a message to end manual protection.");
        // Cancellation removes automatic recovery, not a request to start work now.
        if (row.thread.usagePause.phase === "wrapping") await this.stop(ctx, row);
        if (row.thread.usagePause.recoveryTurnId) await editWorkQueue(ctx, threadId, row.thread.usagePause.recoveryTurnId, "remove");
        await this.pause(ctx, threadId, null);
      } else {
        if (row.thread.usagePause.recoveryTurnId) await editWorkQueue(ctx, threadId, row.thread.usagePause.recoveryTurnId, direction);
        const orders = rows.flatMap((row) => row.thread.usagePause ? [row.thread.usagePause.order] : []);
        await this.pause(ctx, threadId, { ...row.thread.usagePause, order: direction === "first" ? Math.min(...orders) - 1 : Math.max(...orders) + 1 });
      }
      await this.refresh(ctx, Date.now(), await this.rows(ctx, Date.now(), true));
    });
  }

  private account(row: Row): void {
    const previous = new Map<string, number>();
    for (const turn of row.turns) {
      const selection = turn.modelSelection ?? row.thread.modelSelection;
      const provider = usageKeyForInstance(selection.instanceId);
      if (!provider) continue;
      const fast = selection.options?.some((option) =>
        (option.id === "fastMode" && option.value === true) || (option.id === "serviceTier" && option.value === "fast")) ?? false;
      const reported = turn.usage?.costUsd;
      const key = `${row.thread.id}:${turn.id}`;
      let cost = 0;
      if (provider === "claude" && reported !== undefined) {
        const before = previous.get(provider) ?? 0;
        cost = reported >= before ? reported - before : reported;
        previous.set(provider, reported);
      } else if (provider !== "claude" && turn.usage && !this.counted.has(key)) {
        // Recorded usage keeps input and cached reads/writes apart already: priced as it is.
        cost = usageCost(selection.model, turn.usage, fast)?.usd ?? 0;
      }
      if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") continue;
      if (this.counted.has(key)) continue;
      this.counted.add(key);
      this.completedCost.set(provider, (this.completedCost.get(provider) ?? 0) + Math.max(cost, this.runningCost.get(key) ?? 0));
      this.runningCost.delete(key);
    }
  }

  private async rows(ctx: OperationContext, now = Date.now(), dirtyOnly = false): Promise<Row[]> {
    if (this.closed) return [];
    if (!this.unsubscribe) this.unsubscribe = ctx.store.subscribe((event) => {
      if (event.type === "backend.thread.changed") this.dirty.add(event.threadId);
      if (event.type === "backend.context.updated") this.contexts.set(event.threadId, event.payload);
    });
    const rescan = !dirtyOnly && (this.scannedAt === null || now - this.scannedAt >= USAGE_CANDIDATE_RESCAN_MS);
    const ids = new Set([...(dirtyOnly ? [] : this.candidates.keys()), ...this.dirty]);
    // Consume before awaiting: events emitted during reads belong to the next pass.
    this.dirty.clear();
    if (rescan) for (const id of await ctx.store.listThreadIds()) ids.add(id);
    try {
      for (const id of ids) {
        let thread = await ctx.store.readThreadRecord(id);
        if (!thread || thread.deletedAt) {
          this.candidates.delete(id);
          this.contexts.delete(id);
          continue;
        }
        const override = thread.usageProtectionOverride;
        if (!thread.archivedAt && override && !usageProtectionOverrideActive(override, override.provider, now)) {
          await ctx.store.withThreadLock(id, async () => {
            const current = await ctx.store.readThreadRecord(id);
            const override = current?.usageProtectionOverride;
            if (current && override && !usageProtectionOverrideActive(override, override.provider, now)) {
              await ctx.store.writeThreadRecord({ ...current, usageProtectionOverride: null });
            }
          });
          thread = (await ctx.store.readThreadRecord(id))!;
        }
        if (!thread.archivedAt && thread.settledAt && thread.usagePause?.forced) {
          // A forced hold cannot survive its thread settling: settling ends
          // it now, and a message can never release it afterwards, so without
          // this a hold left by an older version would stick forever.
          // Released here — on the next tick — for those already stuck.
          await this.pause(ctx, id, null, now);
          thread = (await ctx.store.readThreadRecord(id))!;
        }
        if (!thread.archivedAt && thread.usagePause) {
          await recoverOrphanedTurn(ctx, id);
          thread = (await ctx.store.readThreadRecord(id))!;
        }
        const row = { thread, turns: await ctx.store.readTurns(id) };
        if (!thread.archivedAt) this.account(row);
        if (row.turns.some((turn) => turn.status === "running" || turn.status === "queued")
          || thread.usagePause || thread.usageProtectionOverride || this.nativeWrap.has(id)) {
          this.candidates.set(id, row);
        } else {
          this.candidates.delete(id);
          this.contexts.delete(id);
        }
      }
    } catch (cause) {
      // A failed read must not lose a newly discovered thread until the next rescan.
      for (const id of ids) this.dirty.add(id);
      throw cause;
    }
    if (rescan) this.scannedAt = now;
    return [...this.candidates.values()].sort((left, right) =>
      left.thread.createdAt.localeCompare(right.thread.createdAt) || left.thread.id.localeCompare(right.thread.id));
  }

  private async pause(ctx: OperationContext, id: string, usagePause: UsagePause | null, now = Date.now()): Promise<void> {
    await ctx.store.withThreadLock(id, async () => {
      const thread = await ctx.store.readThreadRecord(id);
      if (!thread) return;
      if (usagePause && usageProtectionOverrideActive(thread.usageProtectionOverride, usagePause.provider, now)) return;
      await ctx.store.writeThreadRecord({ ...thread, usagePause, updatedAt: ctx.store.nowIso() });
      ctx.store.emit(id, "usage-protection");
    });
  }

  private async stop(ctx: OperationContext, row: Row): Promise<void> {
    const turn = openTurn(await ctx.store.readTurns(row.thread.id));
    if (!turn) return;
    const pause = (await ctx.store.readThreadRecord(row.thread.id))?.usagePause;
    if (!pause) return;
    const status = await readStatus(row.thread.env.path);
    // Persist the reason with the interruption before aborting the driver: its
    // runner can settle immediately in response to the abort.
    const stopped = await interruptTurn(ctx.store, row.thread.id, turn.id, {
      provider: pause.provider, windows: pause.windows ?? [], resetsAt: pause.resetsAt,
      ...(pause.forced ? { forced: true as const } : {}),
      pausedAt: ctx.store.nowIso(),
      hasUncommittedChanges: status === null ? null : status.staged + status.unstaged + status.untracked + status.conflicted > 0,
    });
    if (!stopped.interrupted) return;
    const driver = ctx.driverFor((turn.modelSelection ?? row.thread.modelSelection).instanceId);
    await Effect.runPromise(driver.interruptTurn(row.thread.id));
  }

  /** One thread's failure must not stop the others being held or recovered; the next tick tries it again. */
  private async stopBackgroundOrRetry(ctx: OperationContext, row: Row, pause: UsagePause): Promise<void> {
    await this.stopBackground(ctx, row, pause).catch(() => undefined);
  }

  private async stopBackground(ctx: OperationContext, row: Row, pause: UsagePause): Promise<void> {
    const turn = openTurn(await ctx.store.readTurns(row.thread.id));
    const driver = ctx.driverFor((turn?.modelSelection ?? row.thread.modelSelection).instanceId);
    const tasks = [...(driver.backgroundTasks?.(row.thread.id) ?? [])];
    const recorded = tasks.length ? await ctx.store.readActivities(row.thread.id) : [];
    const pending = tasks.filter((task) => !recorded.some((activity) => activity.kind === "usage.background" && activity.payload?.order === pause.order && activity.payload.taskId === task.taskId));
    // Capture all logs before a fallback closes the session and its handles.
    const outputs = await Promise.all(pending.map((task) => driver.backgroundTaskOutput?.(row.thread.id, task.taskId).catch(() => null)));
    for (const [index, task] of pending.entries()) {
      let status = "stopped";
      try {
        if (!driver.stopBackgroundTask) throw new Error("Independent task stop unavailable");
        await Effect.runPromise(driver.stopBackgroundTask(row.thread.id, task.taskId));
      } catch {
        // Codex native commands cannot be stopped independently. End this
        // run and detach its session instead; never claim the process died.
        status = "detached";
        await this.stop(ctx, row);
        if (!driver.stopSession) throw new Error("Cannot detach protected session");
        await Effect.runPromise(driver.stopSession(row.thread.id));
      }
      await ctx.store.appendLedger(row.thread.id, "activity", {
        id: ctx.store.newId(), threadId: row.thread.id, turnId: turn?.id ?? null,
        kind: "usage.background", summary: `${status === "stopped" ? "Stopped" : "Detached"} for usage protection: ${task.description || task.taskId}`,
        payload: { ...task, status, order: pause.order, output: outputs[index]?.lines ?? null }, createdAt: ctx.store.nowIso(),
      });
      ctx.store.emit(row.thread.id, "activity");
    }
    // Like continuation (MXN-259), a held thread closes its idle provider
    // session, not just its turn: a late task notification must not wake it.
    if (!openTurn(await ctx.store.readTurns(row.thread.id)) && driver.stopSession) {
      await Effect.runPromise(driver.stopSession(row.thread.id));
    }
  }

  /**
   * The reset a waiting pause without one should name: the reset of the
   * window its recovery entry's condition asked about — not the latest reset
   * across every window running hot. Without a recovery entry yet, the window
   * `ensureRecovery` is about to ask about. Null while that window's reset is
   * still unknown: the work stays held until the provider supplies one.
   */
  private async recoveryResetAt(ctx: OperationContext, threadId: string, pause: UsagePause, windows: readonly { kind: string }[], now: number): Promise<string | null> {
    let window: "session" | "weekly" | "all" | null = null;
    if (pause.recoveryTurnId) {
      const turns = await ctx.store.readTurns(threadId).catch(() => []);
      const recovery = turns.find((turn) => turn.id === pause.recoveryTurnId);
      const reset = recovery?.queue?.conditions.find((condition) => condition.type === "reset");
      if (reset) window = reset.window;
      else {
        const at = recovery?.queue?.conditions.find((condition) => condition.type === "at");
        if (at) return at.at;
      }
    }
    window ??= windows.some((candidate) => candidate.kind === "session") ? "session" : windows.some((candidate) => candidate.kind === "weekly") ? "weekly" : "all";
    return nextReset(pause.provider, window, now);
  }

  private async ensureRecovery(ctx: OperationContext, threadId: string, pause: UsagePause): Promise<void> {
    if (!(await ctx.store.readThreadRecord(threadId))?.usagePause) return;
    if (pause.forced || pause.recoveryTurnId || pause.error) return;
    const windows = usageLimitsSnapshot()[pause.provider]?.windows ?? [];
    const recovery = await sendTurn(ctx.store, threadId, {
      prompt: RESUME_PROMPT, origin: "usage-continue",
      queue: { ...parseQueuePolicy({ conditions: [
        { type: "usage", provider: pause.provider, window: "all", minimum: 0 },
        ...(pause.resetsAt ? [{ type: "at", at: new Date(Date.parse(pause.resetsAt) + QUEUE_RESET_GRACE_MS).toISOString() }] : [{ type: "reset", provider: pause.provider, window: windows.some((w) => w.kind === "session") ? "session" : windows.some((w) => w.kind === "weekly") ? "weekly" : "all", resetsAt: null }]),
      ], order: pause.order, sequential: ctx.config.usageRecovery === "sequential", continuation: pause.handoff ? "stored" : "same-thread" }), automatic: true, requestId: `usage:${pause.order}` },
    }).catch((cause: unknown) => {
      if (cause instanceof CliError && cause.code === "USAGE_PROTECTION_OVERRIDDEN") return null;
      throw cause;
    });
    if (!recovery) return;
    await this.pause(ctx, threadId, { ...pause, recoveryTurnId: recovery.turn.id });
  }

  private async begin(ctx: OperationContext, rows: Row[], provider: string, now = Date.now(), triggering?: readonly UsageForecast[]): Promise<void> {
    const windows = usageLimitsSnapshot()[provider]?.windows ?? [];
    const relevant = triggering === undefined ? [...windows].sort((a, b) => b.usedPercent - a.usedPercent
      || (a.resetsAt === null ? Infinity : Date.parse(a.resetsAt)) - (b.resetsAt === null ? Infinity : Date.parse(b.resetsAt))).slice(0, 1)
      : windows.filter((window) => triggering.some((forecast) => forecast.windowId === window.id) || window.usedPercent >= 100);
    const resets = (relevant.length ? relevant : windows).map((window) => window.resetsAt);
    const resetsAt = resets.some((reset) => reset === null) ? null : resets.filter((reset): reset is string => reset !== null).sort().at(-1) ?? null;
    const pauseWindows = relevant.map((window) => ({
      id: window.id, kind: window.kind, label: window.label, resetsAt: window.resetsAt,
    }));
    const eligible = rows.filter(({ thread, turns }) =>
      !thread.archivedAt && !usageProtectionOverrideActive(thread.usageProtectionOverride, provider, now)
      && !openTurn(turns)?.queue?.summaryFor && (!thread.usagePause || thread.usagePause.phase === "resuming")
      && usageKeyForInstance((openTurn(turns)?.modelSelection ?? thread.modelSelection).instanceId) === provider
      && (openTurn(turns) || this.nativeWrap.has(thread.id))
      && (provider !== "claude" || ctx.config.providers?.claude?.usageWrapUp !== "provider" || this.nativeWrap.has(thread.id)));
    if (eligible.length) recordUsageProtection(provider);
    // Hold every queue before interrupting anything: settlement must not promote queued work.
    for (const [index, row] of eligible.entries()) await this.pause(ctx, row.thread.id, {
      provider, windows: pauseWindows, phase: this.nativeWrap.has(row.thread.id) ? (openTurn(row.turns) ? "wrapping" : "waiting") : "pending", resetsAt, order: Date.now() + index, handoff: false,
      ...(this.nativeWrap.has(row.thread.id) ? { native: true, ...(row.turns.at(-1) ? { turnId: row.turns.at(-1)!.id } : {}) } : {}),
    }, now);
    for (const row of eligible) {
      await flushTaskNotifications(ctx, row.thread.id);
      const pause = (await ctx.store.readThreadRecord(row.thread.id))?.usagePause;
      if (pause) await this.stopBackgroundOrRetry(ctx, row, pause);
      if (this.nativeWrap.has(row.thread.id)) continue;
      if (!(await ctx.store.readThreadRecord(row.thread.id))?.usagePause) continue;
      try { await this.stop(ctx, row); }
      catch {
        await this.pause(ctx, row.thread.id, { provider, windows: pauseWindows, phase: "waiting", resetsAt, order: Date.now(), handoff: false, error: "Could not pause this thread. Inspect it before continuing." });
      }
    }
    for (const row of eligible) {
      const pause = (await ctx.store.readThreadRecord(row.thread.id))?.usagePause;
      if (pause) await this.ensureRecovery(ctx, row.thread.id, pause);
    }
  }

  private async refresh(ctx: OperationContext, now: number, rows: Row[]): Promise<void> {
    this.enabled = ctx.config.usageProtection === "notify" || ctx.config.usageProtection === "auto";
    if (this.enabled || rows.some(({ thread }) => thread.usagePause)) {
      for (const { thread, turns } of rows) {
        if (thread.archivedAt || !openTurn(turns) || this.contexts.has(thread.id)) continue;
        const activities = await ctx.store.readActivities(thread.id);
        if (!this.contexts.has(thread.id)) this.contexts.set(thread.id,
          activities.findLast((activity) => activity.kind === "context-window.updated")?.payload ?? null);
      }
    }
    this.forecast(ctx, now, rows);
  }

  /** Re-project changed work without reading ledgers or advancing the clock twice. */
  private forecast(ctx: OperationContext, now: number, rows: Row[]): void {
    const elapsed = this.lastAt === null ? 0 : Math.max(0, Math.min(now - this.lastAt, 10_000));
    this.lastAt = now;
    const forecasts: UsageForecast[] = [];
    if (!this.enabled && !rows.some(({ thread }) => thread.usagePause)) {
      this.snapshot = { forecasts: [], queue: [] };
      this.activeCounts.clear();
      return;
    }
    for (const [provider, limits] of Object.entries(usageLimitsSnapshot(now))) {
      const members = rows.filter(({ thread, turns }) => !thread.archivedAt
        && usageKeyForInstance((openTurn(turns)?.modelSelection ?? thread.modelSelection).instanceId) === provider);
      const running = members.filter(({ thread, turns }) => openTurn(turns) && !thread.hasPendingApprovals && !thread.hasPendingUserInput);
      const activeMs = (this.activeMs.get(provider) ?? 0) + elapsed * Math.min(running.length, this.activeCounts.get(provider) ?? 0);
      this.activeCounts.set(provider, running.length);
      this.activeMs.set(provider, activeMs);
      let costUsd = this.completedCost.get(provider) ?? 0;
      let wrapCostUsd: number | null = 0;
      for (const { thread, turns } of members) {
        const turn = openTurn(turns);
        if (!turn) continue;
        const selection = turn.modelSelection ?? thread.modelSelection;
        const fast = selection.options?.some((option) => (option.id === "fastMode" && option.value === true) || (option.id === "serviceTier" && option.value === "fast")) ?? false;
        const context = this.contexts.get(thread.id);
        const providerTurns = turns.filter((turn) => usageKeyForInstance((turn.modelSelection ?? selection).instanceId) === provider);
        let inFlight = 0;
        // Claude totals include native tasks. Count gains, including session resets,
        // rather than adding cumulative snapshots or native child costs again.
        if (provider === "claude") {
          let previous = 0;
          for (const turn of providerTurns) {
            if (turn.status === "running" || turn.status === "queued") continue;
            const cost = turn.usage?.costUsd;
            if (cost === undefined) continue;
            previous = cost;
          }
          if (typeof context?.costUsd === "number") inFlight = context.costUsd >= previous ? context.costUsd - previous : context.costUsd;
        }
        else {
          const live = this.live.get(thread.id) ?? turn.usage;
          if (live) inFlight = usageCost(selection.model, live, fast)?.usd ?? 0;
        }
        const key = `${thread.id}:${turn.id}`;
        inFlight = Math.max(inFlight, this.runningCost.get(key) ?? 0);
        this.runningCost.set(key, inFlight);
        costUsd += inFlight;
        const used = typeof context?.usedTokens === "number" ? context.usedTokens : null;
        const cached = typeof context?.cachedInputTokens === "number" ? context.cachedInputTokens : 0;
        // One wrap-up request per open thread: its context input plus a short
        // output, not the cumulative spend of its previous turns.
        const estimate = used === null ? null : usageCost(selection.model, { input: 0, cacheRead: cached, cacheCreate: Math.max(0, used - cached), output: 4096, thinking: 0 }, fast);
        if (estimate === null) wrapCostUsd = null;
        else if (wrapCostUsd !== null) wrapCostUsd += estimate.usd;
      }
      costUsd = Math.max(costUsd, this.costCounter.get(provider) ?? 0);
      this.costCounter.set(provider, costUsd);
      for (const window of limits.windows) {
        const forecast = this.forecaster.forecast(provider, window, { activeMs, costUsd, wrapCostUsd, running: running.length });
        forecasts.push(provider === "claude" && ctx.config.providers?.claude?.usageWrapUp === "provider" ? { ...forecast, shouldWrap: false } : forecast);
      }
    }
    this.snapshot = { forecasts, queue: rows.flatMap(({ thread }) =>
      !thread.archivedAt && thread.usagePause ? [{ ...thread.usagePause, threadId: thread.id, title: thread.title }] : []).sort((a, b) => a.order - b.order) };
  }

  private async step(now: number): Promise<void> {
    const ctx = await this.context();
    if (this.closed) return;
    let rows = await this.rows(ctx, now);
    await this.refresh(ctx, now, rows);
    let changed = false;
    for (const { thread } of rows) {
      if (!thread.archivedAt && thread.usagePause?.phase === "wrapping" && thread.usagePause.provider === "claude" && this.nativeWrap.has(thread.id)) {
        await this.pause(ctx, thread.id, { ...thread.usagePause, native: true }, now);
      }
    }
    if (ctx.config.usageProtection === "auto") {
      const triggering = this.snapshot.forecasts.filter((forecast) => forecast.shouldWrap);
      for (const provider of new Set(triggering.map((forecast) => forecast.provider))) await this.begin(ctx, rows, provider, now, triggering.filter((forecast) => forecast.provider === provider));
      if (this.dirty.size) { rows = await this.rows(ctx, now, true); changed = true; }
      if (rows.some(({ thread }) => !thread.usagePause && this.nativeWrap.has(thread.id))) await this.begin(ctx, rows, "claude", now, triggering.filter((forecast) => forecast.provider === "claude"));
    }
    if (this.dirty.size) { rows = await this.rows(ctx, now, true); changed = true; }
    this.nativeWrap.clear();
    const queue = rows.filter((row) => !row.thread.archivedAt && row.thread.usagePause)
      .sort((a, b) => a.thread.usagePause!.order - b.thread.usagePause!.order);
    const busy = new Set<string>();
    for (const row of queue) {
      const pause = row.thread.usagePause!;
      if (pause.phase !== "resuming") await this.stopBackgroundOrRetry(ctx, row, pause);
      const running = openTurn(row.turns);
      if (pause.phase === "resuming") {
        if (running) busy.add(pause.provider);
        else if (!row.thread.settledAt && !row.thread.snoozedUntil && pause.turnId && row.turns.at(-1)?.id === pause.turnId) {
          // Restart between persisting recovery admission and recording its turn.
          await startTurn(ctx, { threadId: row.thread.id, prompt: RESUME_PROMPT, usageControl: true, origin: "usage-continue" });
          busy.add(pause.provider);
        }
        else if (row.turns.at(-1)?.status === "failed") await this.pause(ctx, row.thread.id, { ...pause, phase: "waiting", error: "Recovery failed. Inspect the thread before continuing." });
        else await this.pause(ctx, row.thread.id, null);
      }
      if (pause.phase === "wrapping") {
        const exhausted = usageLimitsSnapshot(now)[pause.provider]?.windows.some((window) => window.usedPercent >= 97) === true;
        if (running && (pause.native || (!exhausted && now - Date.parse(running.createdAt) < 120_000))) busy.add(pause.provider);
        else {
          if (running) await this.stop(ctx, row);
          this.nativeWrap.delete(row.thread.id);
          await this.pause(ctx, row.thread.id, { ...pause, phase: "waiting" });
        }
      }
    }
    for (const row of queue) {
      const pause = row.thread.usagePause!;
      if (row.thread.settledAt || row.thread.snoozedUntil) continue;
      const windows = usageLimitsSnapshot(now)[pause.provider]?.windows ?? [];
      if (pause.phase === "pending" && !busy.has(pause.provider)) {
        if (windows.some((window) => window.usedPercent >= 97) || openTurn(await ctx.store.readTurns(row.thread.id))) {
          await this.pause(ctx, row.thread.id, { ...pause, phase: "waiting" });
          continue;
        }
        // Persist before admission: a crash never repeats a partially delivered wrap-up.
        await this.pause(ctx, row.thread.id, { ...pause, phase: "wrapping" });
        try {
          const prompt = pause.forced ? FORCED_WRAP_UP_PROMPT : WRAP_UP_PROMPT;
          const sent = await startTurn(ctx, { threadId: row.thread.id, prompt, usageControl: true, origin: "usage-protection" });
          await this.pause(ctx, row.thread.id, { ...pause, phase: "wrapping", turnId: sent.turn.id });
          busy.add(pause.provider);
        } catch {
          await this.pause(ctx, row.thread.id, { ...pause, phase: "waiting", error: "Could not start wrap-up. Cancel recovery and inspect the thread before continuing." });
        }
      }
      if (pause.phase !== "waiting" || pause.error) continue;
      let waiting = pause;
      if (!pause.forced && pause.resetsAt === null) {
        const resetsAt = await this.recoveryResetAt(ctx, row.thread.id, waiting, windows, now);
        if (resetsAt !== null) {
          waiting = { ...waiting, resetsAt };
          await this.pause(ctx, row.thread.id, waiting);
        }
      }
      await this.ensureRecovery(ctx, row.thread.id, waiting);
    }
    if (this.dirty.size) { rows = await this.rows(ctx, now, true); changed = true; }
    await runWorkQueue(ctx, now, rows);
    if (this.dirty.size) { rows = await this.rows(ctx, now, true); changed = true; }
    if (changed) this.forecast(ctx, now, rows);
  }
}

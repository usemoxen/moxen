import * as Effect from "effect/Effect";
import { CliError } from "../errors.js";
import { driverKindOfInstance } from "../types.js";
import type { ProviderRuntimeEvent, TokenUsageDelta } from "../providers/spi.js";
import { startTurn, editWorkQueue, recoverOrphanedTurn, runWorkQueue, type OperationContext } from "../threads/operations.js";
import { interruptTurn, openTurn, sendTurn } from "../threads/threads.js";
import { QUEUE_RESET_GRACE_MS, parseQueuePolicy } from "../threads/queue.js";
import type { StoredThread, StoredTurn, UsagePause } from "../threads/types.js";
import { recordUsageProtection, usageLimitsSnapshot, usageProtectionOverrideActive } from "./limits.js";
import { usageCost, UsageForecaster, type UsageForecast } from "./forecast.js";

export const WRAP_UP_PROMPT = "The provider's shared usage allowance is nearly exhausted. Stop expanding the task. Use only essential tools to leave current work safe; do not commit or publish unless already authorized. You will resume in this same conversation automatically. Do not spend allowance on a handoff summary. Leave only brief stopping notes if needed to resume safely; do not claim the task is finished. Preserve the remaining allowance.";
const RESUME_PROMPT = "The usage allowance has reset. Resume the unfinished task from your wrap-up, preserving the user's instructions. Check the working tree before continuing; do not redo completed work.";

export interface UsageQueueEntry extends UsagePause { readonly threadId: string; readonly title: string }
export interface UsageProtectionSnapshot { readonly forecasts: readonly UsageForecast[]; readonly queue: readonly UsageQueueEntry[] }
interface Row { thread: StoredThread; turns: StoredTurn[] }

/** Account-wide coordinator owned by the server, never by an open client tab.
 * Queue state is in the thread record so a server restart cannot release held messages. */
export class UsageProtection {
  private readonly forecaster = new UsageForecaster();
  private readonly live = new Map<string, TokenUsageDelta>();
  private readonly nativeWrap = new Set<string>();
  private readonly activeMs = new Map<string, number>();
  private readonly activeCounts = new Map<string, number>();
  private lastAt: number | null = null;
  private snapshot: UsageProtectionSnapshot = { forecasts: [], queue: [] };
  private enabled = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: () => Promise<OperationContext>) {}

  observe(event: ProviderRuntimeEvent): void {
    if (event.type === "token-usage.updated") this.live.set(event.threadId, event.usage);
    if (event.type === "thread.state.changed" && event.state === "usage-wrap-up") this.nativeWrap.add(event.threadId);
    if (event.type === "turn.completed" || event.type === "turn.interrupted" || event.type === "turn.failed") {
      this.live.delete(event.threadId);
    }
  }

  read(): UsageProtectionSnapshot { return { ...this.snapshot, forecasts: this.enabled ? this.snapshot.forecasts : [] }; }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  tick(now = Date.now()): Promise<void> { return this.serialize(() => this.step(now)); }

  wrap(provider: string): Promise<void> {
    return this.serialize(async () => {
      const ctx = await this.context();
      const rows = await this.rows(ctx);
      if (provider === "claude" && ctx.config.providers?.claude?.usageWrapUp === "provider") throw new CliError("USAGE_PROVIDER_WRAP_UP", "Claude Code manages wrap-up. Choose Moxen in Usage wrap-up to request it here.");
      if (!usageLimitsSnapshot()[provider]?.windows.length) throw new CliError("USAGE_UNAVAILABLE", "This provider has not reported usage windows.");
      await this.begin(ctx, rows, provider);
      await this.refresh(ctx, Date.now());
    });
  }

  reorder(threadId: string, direction: "first" | "last" | "cancel"): Promise<void> {
    return this.serialize(async () => {
      const ctx = await this.context();
      const rows = await this.rows(ctx);
      const row = rows.find((row) => row.thread.id === threadId);
      if (!row?.thread.usagePause) throw new CliError("USAGE_QUEUE_MISSING", "The thread is not waiting for usage.");
      if (direction === "cancel") {
        // Cancellation removes automatic recovery, not a request to start work now.
        if (row.thread.usagePause.phase === "wrapping") await this.stop(ctx, row);
        if (row.thread.usagePause.recoveryTurnId) await editWorkQueue(ctx, threadId, row.thread.usagePause.recoveryTurnId, "remove");
        await this.pause(ctx, threadId, null);
      } else {
        if (row.thread.usagePause.recoveryTurnId) await editWorkQueue(ctx, threadId, row.thread.usagePause.recoveryTurnId, direction);
        const orders = rows.flatMap((row) => row.thread.usagePause ? [row.thread.usagePause.order] : []);
        await this.pause(ctx, threadId, { ...row.thread.usagePause, order: direction === "first" ? Math.min(...orders) - 1 : Math.max(...orders) + 1 });
      }
      await this.refresh(ctx, Date.now());
    });
  }

  private async rows(ctx: OperationContext, heldOnly = false, now = Date.now()): Promise<Row[]> {
    const rows: Row[] = [];
    for (const id of await ctx.store.listThreadIds()) {
      let thread = await ctx.store.readThreadRecord(id);
      if (!thread || thread.archivedAt || thread.deletedAt) continue;
      if (thread.usageProtectionOverride && !usageProtectionOverrideActive(thread.usageProtectionOverride, thread.usageProtectionOverride.provider, now)) {
        await ctx.store.withThreadLock(id, async () => {
          const current = await ctx.store.readThreadRecord(id);
          if (current?.usageProtectionOverride && !usageProtectionOverrideActive(current.usageProtectionOverride, current.usageProtectionOverride.provider, now)) await ctx.store.writeThreadRecord({ ...current, usageProtectionOverride: null });
        });
        thread = (await ctx.store.readThreadRecord(id))!;
      }
      if (thread.usagePause) await recoverOrphanedTurn(ctx, id);
      rows.push({ thread, turns: !heldOnly || thread.usagePause ? await ctx.store.readTurns(id) : [] });
    }
    return rows.sort((left, right) => left.thread.createdAt.localeCompare(right.thread.createdAt) || left.thread.id.localeCompare(right.thread.id));
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
    const driver = ctx.driverFor((turn.modelSelection ?? row.thread.modelSelection).instanceId);
    await Effect.runPromise(driver.interruptTurn(row.thread.id));
    await interruptTurn(ctx.store, row.thread.id, turn.id);
  }

  private async ensureRecovery(ctx: OperationContext, threadId: string, pause: UsagePause): Promise<void> {
    if (!(await ctx.store.readThreadRecord(threadId))?.usagePause) return;
    if (pause.recoveryTurnId || pause.error) return;
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

  private async begin(ctx: OperationContext, rows: Row[], provider: string, now = Date.now()): Promise<void> {
    const windows = usageLimitsSnapshot()[provider]?.windows ?? [];
    const relevant = windows.filter((window) => window.usedPercent >= 90);
    const resets = (relevant.length ? relevant : windows).map((window) => window.resetsAt);
    const resetsAt = resets.some((reset) => reset === null) ? null : resets.filter((reset): reset is string => reset !== null).sort().at(-1) ?? null;
    const eligible = rows.filter(({ thread, turns }) => !usageProtectionOverrideActive(thread.usageProtectionOverride, provider, now) && !openTurn(turns)?.queue?.summaryFor && (!thread.usagePause || thread.usagePause.phase === "resuming") && driverKindOfInstance((openTurn(turns)?.modelSelection ?? thread.modelSelection).instanceId) === provider && (openTurn(turns) || this.nativeWrap.has(thread.id))
      && (provider !== "claude" || ctx.config.providers?.claude?.usageWrapUp !== "provider" || this.nativeWrap.has(thread.id)));
    if (eligible.length) recordUsageProtection(provider);
    // Hold every queue before interrupting anything: settlement must not promote queued work.
    for (const [index, row] of eligible.entries()) await this.pause(ctx, row.thread.id, {
      provider, phase: this.nativeWrap.has(row.thread.id) ? (openTurn(row.turns) ? "wrapping" : "waiting") : "pending", resetsAt, order: Date.now() + index, handoff: false,
      ...(this.nativeWrap.has(row.thread.id) ? { native: true, ...(row.turns.at(-1) ? { turnId: row.turns.at(-1)!.id } : {}) } : {}),
    }, now);
    for (const row of eligible) {
      if (this.nativeWrap.has(row.thread.id)) continue;
      if (!(await ctx.store.readThreadRecord(row.thread.id))?.usagePause) continue;
      try { await this.stop(ctx, row); }
      catch {
        await this.pause(ctx, row.thread.id, { provider, phase: "waiting", resetsAt, order: Date.now(), handoff: false, error: "Could not pause this thread. Inspect it before continuing." });
      }
    }
    for (const row of eligible) {
      const pause = (await ctx.store.readThreadRecord(row.thread.id))?.usagePause;
      if (pause) await this.ensureRecovery(ctx, row.thread.id, pause);
    }
  }

  private async refresh(ctx: OperationContext, now: number): Promise<Row[]> {
    this.enabled = ctx.config.usageProtection === "notify" || ctx.config.usageProtection === "auto";
    const rows = await this.rows(ctx, !this.enabled, now);
    const elapsed = this.lastAt === null ? 0 : Math.max(0, Math.min(now - this.lastAt, 10_000));
    this.lastAt = now;
    const forecasts: UsageForecast[] = [];
    if (!this.enabled && !rows.some(({ thread }) => thread.usagePause)) {
      this.snapshot = { forecasts: [], queue: [] };
      this.activeCounts.clear();
      return rows;
    }
    for (const [provider, limits] of Object.entries(usageLimitsSnapshot(now))) {
      const members = rows.filter(({ thread, turns }) => driverKindOfInstance((openTurn(turns)?.modelSelection ?? thread.modelSelection).instanceId) === provider);
      const running = members.filter(({ thread, turns }) => openTurn(turns) && !thread.hasPendingApprovals && !thread.hasPendingUserInput);
      const activeMs = (this.activeMs.get(provider) ?? 0) + elapsed * Math.min(running.length, this.activeCounts.get(provider) ?? 0);
      this.activeCounts.set(provider, running.length);
      this.activeMs.set(provider, activeMs);
      let costUsd = 0;
      let wrapCostUsd: number | null = 0;
      for (const { thread, turns } of members) {
        const selection = openTurn(turns)?.modelSelection ?? thread.modelSelection;
        const fast = selection.options?.some((option) => (option.id === "fastMode" && option.value === true) || (option.id === "serviceTier" && option.value === "fast")) ?? false;
        const activities = await ctx.store.readActivities(thread.id);
        const context = activities.findLast((activity) => activity.kind === "context-window.updated")?.payload;
        const providerTurns = turns.filter((turn) => driverKindOfInstance((turn.modelSelection ?? selection).instanceId) === provider);
        // Claude totals include native tasks. Count gains, including session resets,
        // rather than adding cumulative snapshots or native child costs again.
        if (provider === "claude") {
          let previous = 0;
          for (const turn of providerTurns) {
            const cost = turn.usage?.costUsd;
            if (cost === undefined) continue;
            costUsd += cost >= previous ? cost - previous : cost;
            previous = cost;
          }
          if (typeof context?.costUsd === "number") costUsd += Math.max(0, context.costUsd - previous);
        }
        else {
          for (const turn of providerTurns) if (turn.usage) costUsd += usageCost((turn.modelSelection ?? selection).model, { ...turn.usage, input: Math.max(0, turn.usage.input - turn.usage.cacheRead - turn.usage.cacheCreate) }, fast)?.usd ?? 0;
          const live = this.live.get(thread.id);
          if (live && openTurn(turns)) costUsd += usageCost(selection.model, { ...live, input: Math.max(0, live.input - live.cacheRead - live.cacheCreate) }, fast)?.usd ?? 0;
        }
        if (!openTurn(turns)) continue;
        const used = typeof context?.usedTokens === "number" ? context.usedTokens : null;
        const cached = typeof context?.cachedInputTokens === "number" ? context.cachedInputTokens : 0;
        const estimate = used === null ? null : usageCost(selection.model, { input: 0, cacheRead: cached, cacheCreate: Math.max(0, used - cached), output: 4096, thinking: 0 }, fast);
        if (estimate === null) wrapCostUsd = null;
        else if (wrapCostUsd !== null) wrapCostUsd += estimate.usd;
      }
      for (const window of limits.windows) {
        const forecast = this.forecaster.forecast(provider, window, { activeMs, costUsd, wrapCostUsd, running: running.length });
        forecasts.push(provider === "claude" && ctx.config.providers?.claude?.usageWrapUp === "provider" ? { ...forecast, shouldWrap: false } : forecast);
      }
    }
    this.snapshot = { forecasts, queue: rows.flatMap(({ thread }) => thread.usagePause ? [{ ...thread.usagePause, threadId: thread.id, title: thread.title }] : []).sort((a, b) => a.order - b.order) };
    return rows;
  }

  private async step(now: number): Promise<void> {
    const ctx = await this.context();
    let rows = await this.refresh(ctx, now);
    if (ctx.config.usageProtection === "auto") {
      for (const provider of new Set(this.snapshot.forecasts.filter((forecast) => forecast.shouldWrap).map((forecast) => forecast.provider))) await this.begin(ctx, rows, provider, now);
      if (rows.some(({ thread }) => !thread.usagePause && this.nativeWrap.has(thread.id))) await this.begin(ctx, await this.rows(ctx), "claude", now);
      rows = await this.rows(ctx);
    }
    this.nativeWrap.clear();
    const queue = rows.filter((row) => row.thread.usagePause).sort((a, b) => a.thread.usagePause!.order - b.thread.usagePause!.order);
    const busy = new Set<string>();
    for (const row of queue) {
      const pause = row.thread.usagePause!;
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
          const sent = await startTurn(ctx, { threadId: row.thread.id, prompt: WRAP_UP_PROMPT, usageControl: true, origin: "usage-protection" });
          await this.pause(ctx, row.thread.id, { ...pause, phase: "wrapping", turnId: sent.turn.id });
          busy.add(pause.provider);
        } catch {
          await this.pause(ctx, row.thread.id, { ...pause, phase: "waiting", error: "Could not start wrap-up. Cancel recovery and inspect the thread before continuing." });
        }
      }
      if (pause.phase !== "waiting" || pause.error) continue;
      let waiting = pause;
      if (pause.resetsAt === null) {
        const resets = windows.filter((window) => window.usedPercent >= 90).map((window) => window.resetsAt);
        if (resets.length && resets.every((reset) => reset !== null)) {
          waiting = { ...waiting, resetsAt: resets.sort().at(-1)! };
          await this.pause(ctx, row.thread.id, waiting);
        }
      }
      await this.ensureRecovery(ctx, row.thread.id, waiting);
    }
    await runWorkQueue(ctx, now);
    await this.refresh(ctx, now);
  }
}

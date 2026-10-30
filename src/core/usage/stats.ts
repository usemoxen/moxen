/**
 * Usage statistics across threads and providers: the numbers behind a
 * stats screen. Pure — callers hand in each thread with its turns and
 * messages (`StatsThreadInput`) and a clock, so the result is
 * deterministic. Days and the peak hour are in the machine's local time.
 * Turns whose driver reported no usage add activity but no tokens —
 * graceful degradation, never invention. See docs/threads.md.
 */
import type { StoredMessage, StoredThread, StoredTurn, TurnUsage } from "../threads/types.js";
import { type UsageTotals, emptyUsageTotals, summarizeUsage } from "./usage.js";

export type StatsRange = "7d" | "30d" | "all";

export interface StatsThreadInput {
  readonly thread: Pick<StoredThread, "id" | "modelSelection">;
  readonly turns: ReadonlyArray<StoredTurn>;
  readonly messages: ReadonlyArray<Pick<StoredMessage, "role" | "createdAt" | "origin">>;
}

/** Tokens plus the activity behind them, for one provider, one model, or one day. */
export interface StatsBucket {
  readonly key: string;
  readonly usage: UsageTotals;
  /** input + cacheRead + cacheCreate + output + thinking. */
  readonly tokens: number;
  /** Share of all tokens in the range, 0..1; 0 when there are none. */
  readonly share: number;
  readonly sessions: number;
  /** Provider-reported cost in USD (an estimate); null when no turn here reported one — unpriced, never 0. */
  readonly costUsd: number | null;
  /** Turns here that reported no cost, so `costUsd` covers only the rest. */
  readonly unpricedTurns: number;
}

export interface DailyStats {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly tokens: number;
  readonly byModel: Readonly<Record<string, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
}

export interface UsageStats {
  readonly range: StatsRange;
  readonly sessions: number;
  readonly messages: number;
  readonly turns: number;
  readonly totals: UsageTotals;
  readonly totalTokens: number;
  /** Sum of the costs providers reported; null when none did. See `StatsBucket.costUsd`. */
  readonly costUsd: number | null;
  readonly unpricedTurns: number;
  readonly activeDays: number;
  /** Longest run of consecutive active days in the range. */
  readonly bestStreak: number;
  /** Local hour 0..23 with the most turns; null with no activity. */
  readonly peakHour: number | null;
  /** The model with the most tokens; null with none. */
  readonly favoriteModel: string | null;
  /** Sorted by tokens, largest first. Key is the provider instance id. */
  readonly byProvider: readonly StatsBucket[];
  /** Sorted by tokens, largest first. Key is the model id, `unknown` when a turn never recorded it. */
  readonly byModel: readonly StatsBucket[];
  /** Active days only, oldest first. */
  readonly daily: readonly DailyStats[];
}

export interface StatsOptions {
  /**
   * Provider instance ids whose turns store the thread's running total rather
   * than that turn's own spend (Claude). Each such turn's spend is the gain
   * over the thread's previous turn on the same instance; a total that went
   * down is a counter that restarted (a resumed process), so what it shows is
   * all that is known to have been spent since. Threads stored before turns
   * recorded their own spend read the same way, from their final value.
   */
  readonly runningTotals?: ReadonlySet<string>;
}

export const UNKNOWN_MODEL = "unknown";

export function totalTokens(usage: UsageTotals): number {
  return usage.input + usage.cacheRead + usage.cacheCreate + usage.output + usage.thinking;
}

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Start of the range as a local-midnight instant; null for `all`. */
export function rangeStart(range: StatsRange, now: Date): Date | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : 30;
  // The range covers today and the days-1 before it.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
}

function gain(before: number, after: number): number {
  return after >= before ? after - before : after;
}

/** What each turn spent, given that some providers' turns hold running totals (see `StatsOptions`). */
function spendPerTurn(
  thread: StatsThreadInput["thread"],
  turns: ReadonlyArray<StoredTurn>,
  runningTotals: ReadonlySet<string>,
): ReadonlyArray<StoredTurn> {
  if (runningTotals.size === 0) return turns;
  const previous = new Map<string, TurnUsage>();
  return turns.map((turn) => {
    const instance = (turn.modelSelection ?? thread.modelSelection).instanceId;
    const usage = turn.usage;
    if (!usage || !runningTotals.has(instance)) return turn;
    const before = previous.get(instance);
    previous.set(instance, usage);
    if (!before) return turn;
    const spent: TurnUsage = {
      input: gain(before.input, usage.input),
      cacheRead: gain(before.cacheRead, usage.cacheRead),
      cacheCreate: gain(before.cacheCreate, usage.cacheCreate),
      output: gain(before.output, usage.output),
      thinking: gain(before.thinking, usage.thinking),
      ...(usage.costUsd === undefined ? {} : { costUsd: gain(before.costUsd ?? 0, usage.costUsd) }),
    };
    return { ...turn, usage: spent };
  });
}

function activityTime(turn: StoredTurn): Date | null {
  const time = new Date(turn.startedAt ?? turn.createdAt);
  return Number.isNaN(time.getTime()) ? null : time;
}

/** Whether the turn did work: a turn still queued (or scheduled) hasn't. */
function ran(turn: StoredTurn): boolean {
  return turn.status !== "queued";
}

/** What providers reported for these turns: the sum, null when none reported, and how many did not. */
function costOf(turns: ReadonlyArray<StoredTurn>): { costUsd: number | null; unpricedTurns: number } {
  let costUsd: number | null = null;
  let unpricedTurns = 0;
  for (const turn of turns) {
    const cost = turn.usage?.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) costUsd = (costUsd ?? 0) + cost;
    else unpricedTurns += 1;
  }
  return { costUsd, unpricedTurns };
}

interface Accumulator {
  turns: StoredTurn[];
  sessions: Set<string>;
}

function bucketsFrom(groups: Map<string, Accumulator>, all: number): StatsBucket[] {
  const buckets: StatsBucket[] = [];
  for (const [key, group] of groups) {
    const usage = summarizeUsage(group.turns);
    const tokens = totalTokens(usage);
    buckets.push({
      key,
      usage,
      tokens,
      share: all > 0 ? tokens / all : 0,
      sessions: group.sessions.size,
      ...costOf(group.turns),
    });
  }
  return buckets.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

function add(groups: Map<string, Accumulator>, key: string, turn: StoredTurn, threadId: string): void {
  const group = groups.get(key) ?? { turns: [], sessions: new Set<string>() };
  group.turns.push(turn);
  group.sessions.add(threadId);
  groups.set(key, group);
}

function bestStreak(days: ReadonlyArray<string>): number {
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    // Calendar-day index via UTC, so a DST shift never splits a streak.
    const index = Math.round(Date.UTC(year, month - 1, date) / 86_400_000);
    run = previous !== null && index === previous + 1 ? run + 1 : 1;
    previous = index;
    best = Math.max(best, run);
  }
  return best;
}

export function computeUsageStats(
  inputs: ReadonlyArray<StatsThreadInput>,
  range: StatsRange,
  now: Date,
  options: StatsOptions = {},
): UsageStats {
  const runningTotals = options.runningTotals ?? new Set<string>();
  const start = rangeStart(range, now);
  const inRange = (time: Date): boolean => start === null || time.getTime() >= start.getTime();

  const providers = new Map<string, Accumulator>();
  const models = new Map<string, Accumulator>();
  const dailyTurns = new Map<string, StoredTurn[]>();
  const dailyModel = new Map<string, Map<string, number>>();
  const dailyProvider = new Map<string, Map<string, number>>();
  const hours = new Array<number>(24).fill(0);
  const sessions = new Set<string>();
  const counted: StoredTurn[] = [];
  let messages = 0;

  for (const { thread, turns: storedTurns, messages: threadMessages } of inputs) {
    const turns = spendPerTurn(thread, storedTurns, runningTotals);
    for (const message of threadMessages) {
      if (message.role === "system" || message.origin) continue;
      const time = new Date(message.createdAt);
      if (!Number.isNaN(time.getTime()) && inRange(time)) messages += 1;
    }
    for (const turn of turns) {
      if (!ran(turn)) continue;
      const time = activityTime(turn);
      if (!time || !inRange(time)) continue;
      const provider = (turn.modelSelection ?? thread.modelSelection).instanceId;
      const model = turn.modelSelection?.model ?? UNKNOWN_MODEL;
      sessions.add(thread.id);
      counted.push(turn);
      add(providers, provider, turn, thread.id);
      add(models, model, turn, thread.id);
      hours[time.getHours()] = (hours[time.getHours()] ?? 0) + 1;
      const day = dayKey(time);
      const tokens = turn.usage ? totalTokens({ ...emptyUsageTotals(), ...turn.usage }) : 0;
      dailyTurns.set(day, [...(dailyTurns.get(day) ?? []), turn]);
      for (const [map, key] of [
        [dailyModel, model],
        [dailyProvider, provider],
      ] as const) {
        const row = map.get(day) ?? new Map<string, number>();
        row.set(key, (row.get(key) ?? 0) + tokens);
        map.set(day, row);
      }
    }
  }

  const totals = summarizeUsage(counted);
  const all = totalTokens(totals);
  const byModel = bucketsFrom(models, all);
  const days = [...dailyTurns.keys()].sort();
  const peak = Math.max(...hours);

  return {
    range,
    sessions: sessions.size,
    messages,
    turns: counted.length,
    totals,
    totalTokens: all,
    ...costOf(counted),
    activeDays: days.length,
    bestStreak: bestStreak(days),
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    favoriteModel: byModel.find((bucket) => bucket.tokens > 0)?.key ?? null,
    byProvider: bucketsFrom(providers, all),
    byModel,
    daily: days.map((day) => ({
      day,
      tokens: totalTokens(summarizeUsage(dailyTurns.get(day) ?? [])),
      byModel: Object.fromEntries(dailyModel.get(day) ?? []),
      byProvider: Object.fromEntries(dailyProvider.get(day) ?? []),
    })),
  };
}

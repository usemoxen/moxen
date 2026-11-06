/**
 * Usage stats over the thread store: reads every thread's ledgers and hands
 * them to `computeUsageStats`. A thread the user deleted is not counted, one
 * that cannot be read is skipped rather than failing the whole picture.
 * Claude's turns store the thread's running total, so its instances are
 * passed as such (see `StatsOptions`).
 */
import type { ThreadStore } from "../threads/store.js";
import { driverKindOfInstance, type CliConfig } from "../types.js";
import { modelPriceFor } from "./prices.js";
import { type CardPalette, renderStatsCard } from "./card.js";
import { type StatsOptions, type StatsRange, type StatsThreadInput, type UsageStats, computeUsageStats, dayKey } from "./stats.js";

const READ_AT_ONCE = 16;

async function readThread(store: ThreadStore, threadId: string): Promise<StatsThreadInput | null> {
  try {
    const thread = await store.readThreadRecord(threadId);
    if (!thread || thread.deletedAt) return null;
    const [turns, messages] = await Promise.all([store.readTurns(threadId), store.readMessages(threadId)]);
    return { thread, turns, messages };
  } catch {
    return null;
  }
}

async function readInputs(store: ThreadStore, config?: Pick<CliConfig, "providers">): Promise<{ inputs: StatsThreadInput[]; options: StatsOptions }> {  const ids = await store.listThreadIds().catch(() => [] as string[]);
  const inputs: StatsThreadInput[] = [];
  for (let start = 0; start < ids.length; start += READ_AT_ONCE) {
    const batch = await Promise.all(ids.slice(start, start + READ_AT_ONCE).map((id) => readThread(store, id)));
    for (const input of batch) if (input) inputs.push(input);
  }
  const runningTotals = new Set<string>();
  for (const { thread, turns } of inputs) {
    for (const instanceId of [thread.modelSelection.instanceId, ...turns.map((turn) => turn.modelSelection?.instanceId)]) {
      if (instanceId && driverKindOfInstance(instanceId) === "claude") runningTotals.add(instanceId);
    }
  }
  // Turns that recorded no provider cost are priced at the current values:
  // the user's per-provider rows over Moxen's shipped list.
  const priceFor: StatsOptions["priceFor"] = config === undefined ? undefined : (kind, model) => modelPriceFor(config, kind, model);
  return { inputs, options: { runningTotals, ...(priceFor === undefined ? {} : { priceFor }) } };
}

export async function readUsageStats(store: ThreadStore, range: StatsRange, now: Date = new Date(), config?: Pick<CliConfig, "providers">): Promise<UsageStats> {
  const { inputs, options } = await readInputs(store, config);
  return computeUsageStats(inputs, range, now, options);
}

export interface UsageCard {
  /** The PNG, base64, so it travels in a JSON answer. */
  readonly png: string;
  readonly filename: string;
}

/** The shareable stats card for a range, in the client's colours when it sends them: all time is read too, so the heatmap keeps earlier days in grey. */
export async function readUsageCard(store: ThreadStore, range: StatsRange, now: Date = new Date(), palette?: CardPalette, config?: Pick<CliConfig, "providers">): Promise<UsageCard> {
  const { inputs, options } = await readInputs(store, config);
  const stats = computeUsageStats(inputs, range, now, options);
  const all = range === "all" ? stats : computeUsageStats(inputs, "all", now, options);
  return {
    png: Buffer.from(renderStatsCard(stats, all, now, palette)).toString("base64"),
    filename: `moxen-stats${range === "all" ? "" : `-${range}`}-${dayKey(now)}.png`,
  };
}

import type { ProviderUsageWindow } from "../catalog/summary.js";
import type { TurnUsage } from "../threads/types.js";

/** USD / million tokens; API equivalents, not subscription charges.
 * https://developers.openai.com/api/docs/pricing (2026-11-01).
 * Unknown models deliberately have no invented price. */
const PRICES: Record<string, readonly [number, number, number, number]> = {
  // https://platform.claude.com/docs/en/about-claude/pricing (2026-11-01).
  "claude-opus-5": [5, 0.5, 6.25, 25],
  "claude-opus-5-5": [4, 0.2, 5, 20],
  "claude-sonnet-5": [2, 0.2, 2.5, 10],
  "claude-sonnet-5-5": [2, 0.1, 2.5, 10],
  "claude-opus-4-8": [5, 0.5, 6.25, 25],
  "claude-opus-4-7": [5, 0.5, 6.25, 25],
  "claude-opus-4-6": [5, 0.5, 6.25, 25],
  "claude-sonnet-4-6": [3, 0.3, 3.75, 15],
  "claude-haiku-4-5": [1, 0.1, 1.25, 5],
  "claude-fable-5": [10, 1, 12.5, 50],
  "claude-fable-5-1": [10, 0.25, 12.5, 50],
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-6.1-sol": [2, 0.1, 2.5, 10],
  "gpt-6.1-terra": [1, 0.05, 1.25, 5],
  "gpt-6-sol": [2, 0.2, 2.5, 10],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2],
  "gpt-5.5": [5, 0.5, 5, 30],
  "gpt-5.4": [2.5, 0.25, 2.5, 15],
  "gpt-5.3-codex": [1.75, 0.175, 1.75, 14],
};

export function usageCost(model: string, usage: TurnUsage, fast = false): { usd: number; source: "reported" | "estimated" } | null {
  if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return { usd: usage.costUsd, source: "reported" };
  const price = PRICES[model];
  if (!price) return null;
  // The canonical usage excludes cached input from input; reasoning is already in output.
  const [input, read, write, output] = price;
  return { usd: (usage.input * input + usage.cacheRead * read + usage.cacheCreate * write + usage.output * output) / 1e6 * (fast ? 2 : 1), source: "estimated" };
}

export interface ForecastWork {
  readonly activeMs: number;
  readonly costUsd: number;
  readonly wrapCostUsd: number | null;
  readonly running: number;
}

export interface UsageForecast {
  readonly costSource: "reported" | "estimated";
  readonly wrapCostUsd: number | null;
  readonly provider: string;
  readonly windowId: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly remainingWorkMs: number | null;
  readonly reservePercent: number;
  readonly shouldWrap: boolean;
  readonly running: number;
}

interface Sample { percent: number; reset: string | null; activeMs: number; costUsd: number; msPerPercent: number | null; dollarsPerPercent: number | null }

/** Ratios are learned per account window, never shared between session and weekly quotas.
 * Active time is accumulated by the owner, excluding user/approval waits. */
export class UsageForecaster {
  private readonly samples = new Map<string, Sample>();

  forecast(provider: string, window: ProviderUsageWindow, work: ForecastWork): UsageForecast {
    const key = `${provider}:${window.id}`;
    let sample = this.samples.get(key);
    if (!sample || sample.reset !== window.resetsAt || window.usedPercent < sample.percent || work.costUsd < sample.costUsd) {
      sample = { percent: window.usedPercent, reset: window.resetsAt, activeMs: work.activeMs, costUsd: work.costUsd, msPerPercent: null, dollarsPerPercent: null };
      this.samples.set(key, sample);
    }
    const delta = window.usedPercent - sample.percent;
    if (delta > 0) {
      const elapsed = work.activeMs - sample.activeMs;
      const cost = work.costUsd - sample.costUsd;
      if (elapsed > 0) sample.msPerPercent = elapsed / delta;
      if (cost > 0) sample.dollarsPerPercent = cost / delta;
      sample.percent = window.usedPercent;
      sample.activeMs = work.activeMs;
      sample.costUsd = work.costUsd;
    }
    // Two points minimum for event/report lag; before calibration, reserve two per thread.
    const reservePercent = Math.max(2, work.wrapCostUsd !== null && sample.dollarsPerPercent !== null
      ? work.wrapCostUsd / sample.dollarsPerPercent * 1.5 : 2 * work.running);
    return {
      provider, windowId: window.id, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
      costSource: provider === "claude" ? "reported" : "estimated", wrapCostUsd: work.wrapCostUsd,
      remainingWorkMs: sample.msPerPercent === null ? null : Math.max(0, 97 - window.usedPercent) * sample.msPerPercent / Math.max(1, work.running),
      reservePercent, shouldWrap: work.running > 0 && window.usedPercent >= Math.max(0, 97 - reservePercent), running: work.running,
    };
  }
}

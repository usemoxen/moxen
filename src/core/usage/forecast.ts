import type { ProviderUsageWindow } from "../catalog/summary.js";

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

interface Sample {
  percent: number; reset: string | null; costUsd: number;
  initialPercent: number; initialActiveMs: number; initialCostUsd: number;
  msPerPercent: number | null; dollarsPerPercent: number | null;
}

/** Ratios are learned per account window, never shared between session and weekly quotas.
 * Active time is accumulated by the owner, excluding user/approval waits. */
export class UsageForecaster {
  private readonly samples = new Map<string, Sample>();

  forecast(provider: string, window: ProviderUsageWindow, work: ForecastWork): UsageForecast {
    const key = `${provider}:${window.id}`;
    let sample = this.samples.get(key);
    if (!sample || sample.reset !== window.resetsAt || window.usedPercent < sample.percent || work.costUsd < sample.costUsd) {
      sample = { percent: window.usedPercent, reset: window.resetsAt, costUsd: work.costUsd,
        initialPercent: window.usedPercent, initialActiveMs: work.activeMs, initialCostUsd: work.costUsd,
        msPerPercent: null, dollarsPerPercent: null };
      this.samples.set(key, sample);
    }
    if (window.usedPercent > sample.percent) {
      // Turn-end cost reports lag the quota's continuous rise. Learn over the
      // observed window, not an interval that may contain only a small report.
      const delta = window.usedPercent - sample.initialPercent;
      const elapsed = work.activeMs - sample.initialActiveMs;
      const cost = work.costUsd - sample.initialCostUsd;
      if (elapsed > 0) sample.msPerPercent = elapsed / delta;
      if (cost > 0) sample.dollarsPerPercent = cost / delta;
      sample.percent = window.usedPercent;
      sample.costUsd = work.costUsd;
    }
    // Two points minimum for event/report lag; before calibration, reserve two per thread.
    // Cap at ten points: even delayed/mismatched account telemetry must not
    // stop work before 87% (97 minus 10), while leaving room for a short wrap-up.
    const reservePercent = Math.min(10, Math.max(2, work.wrapCostUsd !== null && sample.dollarsPerPercent !== null
      ? work.wrapCostUsd / sample.dollarsPerPercent * 1.5 : 2 * work.running));
    return {
      provider, windowId: window.id, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
      costSource: provider === "claude" ? "reported" : "estimated", wrapCostUsd: work.wrapCostUsd,
      remainingWorkMs: sample.msPerPercent === null ? null : Math.max(0, 97 - window.usedPercent) * sample.msPerPercent / Math.max(1, work.running),
      reservePercent, shouldWrap: work.running > 0 && window.usedPercent >= Math.max(0, 97 - reservePercent), running: work.running,
    };
  }
}

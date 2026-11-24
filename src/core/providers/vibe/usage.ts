/**
 * Mistral Vibe usage & monthly Vibe Code budget accounting.
 *
 * `account/read` reads `/v1/billing/subscription` and `/v1/billing/budget`
 * through Vibe's own credentials and reports a monthly `usagePercentage` +
 * `resetAt` + `paygEnabled`. When `paygEnabled` is true, reaching 100% of the
 * included monthly budget bills pay-as-you-go rather than pausing the account.
 */
import type { RateLimitWindow, TokenUsageDelta } from "../spi.js";
import type { VibeAccountSnapshot, VibeStatsSnapshot } from "./protocol.js";

/** Map `account/read` into Moxen `RateLimitWindow[]` (empty when Vibe reports no budget). */
export function vibeWindowsOf(account: VibeAccountSnapshot | null): RateLimitWindow[] {
  if (!account || !account.budget) return [];
  const used = Math.max(0, Math.round(account.budget.usagePercentage * 10) / 10);
  const label = account.budget.paygEnabled ? "Monthly (PAYG)" : "Monthly";
  return [
    {
      id: "monthly",
      label,
      resetsAt: account.budget.resetAt,
      exhausted: !account.budget.paygEnabled && used >= 100,
      usedPercent: Math.min(100, used),
    },
  ];
}

export interface VibeTokenTotals {
  readonly prompt: number;
  readonly completion: number;
  readonly cached: number;
}

function zeroTotals(): VibeTokenTotals {
  return { prompt: 0, completion: 0, cached: 0 };
}

/**
 * Baseline-delta accumulator over `session/statsUpdated` cumulative session
 * counters. Backwards totals (e.g. after compaction/rewind handoff) reset the
 * baseline cleanly so deltas never go negative.
 */
export class VibeUsageAccumulator {
  private baseline: VibeTokenTotals | null = null;
  private turnTotals = new Map<string, TokenUsageDelta>();

  observe(turnId: string, stats: VibeStatsSnapshot): TokenUsageDelta {
    const current: VibeTokenTotals = {
      prompt: Math.max(0, stats.sessionPromptTokens),
      completion: Math.max(0, stats.sessionCompletionTokens),
      cached: Math.max(0, stats.sessionCachedTokens),
    };
    const prev = this.baseline;
    this.baseline = current;

    let deltaPrompt: number;
    let deltaCompletion: number;
    let deltaCached: number;
    if (prev === null) {
      deltaPrompt = Math.max(0, stats.lastTurnPromptTokens || current.prompt);
      deltaCompletion = Math.max(0, stats.lastTurnCompletionTokens || current.completion);
      deltaCached = Math.max(0, stats.lastTurnCachedTokens || current.cached);
    } else if (
      current.prompt < prev.prompt ||
      current.completion < prev.completion ||
      current.cached < prev.cached
    ) {
      deltaPrompt = Math.max(0, stats.lastTurnPromptTokens);
      deltaCompletion = Math.max(0, stats.lastTurnCompletionTokens);
      deltaCached = Math.max(0, stats.lastTurnCachedTokens);
    } else {
      deltaPrompt = current.prompt - prev.prompt;
      deltaCompletion = current.completion - prev.completion;
      deltaCached = current.cached - prev.cached;
    }

    const uncachedInput = Math.max(0, deltaPrompt - deltaCached);
    const existing = this.turnTotals.get(turnId);
    const next: TokenUsageDelta = {
      input: (existing?.input ?? 0) + uncachedInput,
      cacheRead: (existing?.cacheRead ?? 0) + deltaCached,
      cacheCreate: 0,
      output: (existing?.output ?? 0) + deltaCompletion,
      thinking: 0,
    };
    this.turnTotals.set(turnId, next);
    return next;
  }

  resetBaseline(): void {
    this.baseline = zeroTotals();
  }

  peek(turnId: string): TokenUsageDelta | null {
    const entry = this.turnTotals.get(turnId);
    return entry ? { ...entry } : null;
  }

  take(turnId: string): TokenUsageDelta {
    const entry = this.turnTotals.get(turnId) ?? {
      input: 0,
      cacheRead: 0,
      cacheCreate: 0,
      output: 0,
      thinking: 0,
    };
    this.turnTotals.delete(turnId);
    return entry;
  }
}

const LIMIT_ERROR_PATTERNS: readonly RegExp[] = [
  /usage.?limit/i,
  /rate.?limit/i,
  /budget/i,
  /quota/i,
  /\b429\b/,
];

export function isVibeLimitError(code: string | null, message: string): boolean {
  if (code === "rate_limit" || code === "usage_limit") return true;
  return LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function rewriteVibeLimitError(message: string, resetsAtIso: string | null): string {
  if (!LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return message;
  if (!resetsAtIso) return "Mistral Vibe usage limit exceeded.";
  const parsed = Date.parse(resetsAtIso);
  if (!Number.isFinite(parsed)) return "Mistral Vibe usage limit exceeded.";
  const minutes = Math.max(1, Math.round((parsed - Date.now()) / 60_000));
  if (minutes < 60) return `Mistral Vibe usage limit exceeded; resets in ${minutes}m.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Mistral Vibe usage limit exceeded; resets in ${hours}h ${minutes % 60}m.`;
  const days = Math.floor(hours / 24);
  return `Mistral Vibe usage limit exceeded; resets in ${days}d ${hours % 24}h.`;
}

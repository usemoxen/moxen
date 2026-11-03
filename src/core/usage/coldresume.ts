/**
 * Whether a usage recovery should continue in a new thread instead of its own.
 *
 * A provider keeps a conversation's prompt cache for minutes up to an hour.
 * When a usage reset comes later than that, continuing the same thread reads
 * the whole context again at full price. Past a size, a stored handoff into a
 * new thread (no model usage) is the cheaper way on.
 */
import type { CliConfig } from "../types.js";
import { durationMs } from "../threads/idle.js";

export const COLD_RESUME_AFTER_DEFAULT = "1h";
export const COLD_RESUME_TOKENS_DEFAULT = 65_536;

export interface ColdResumeFacts {
  /** When the thread last did anything; null when unknown. */
  readonly lastActivityAt: number | null;
  /** The context's size at its last reading; null when never read. */
  readonly usedTokens: number | null;
  readonly now: number;
}

/** True only when the setting asks for it and both facts are known: missing data keeps the thread where it is. */
export function prefersColdHandoff(config: Pick<CliConfig, "usageColdResume" | "usageColdResumeAfter" | "usageColdResumeTokens">, facts: ColdResumeFacts): boolean {
  if (config.usageColdResume !== "handoff" || facts.lastActivityAt === null || facts.usedTokens === null) return false;
  const after = durationMs(config.usageColdResumeAfter) ?? durationMs(COLD_RESUME_AFTER_DEFAULT)!;
  return facts.now - facts.lastActivityAt >= after && facts.usedTokens >= (config.usageColdResumeTokens ?? COLD_RESUME_TOKENS_DEFAULT);
}

/**
 * Antigravity subscription usage & credits probing via the official `agy` CLI:
 * `agy --print /usage --output-format json` and `agy --print /credits --output-format json`.
 * Both are local slash commands (`num_turns: 0`, `total_tokens: 0`) that use
 * `agy`'s own login — Moxen never reads or handles credentials.
 */
import { spawn } from "node:child_process";

import { killProcessTree } from "../../infra/process.js";
import { acpLaunchCommand } from "../acp/transport.js";
import type { RateLimitWindow } from "../spi.js";

export interface AntigravityUsageSnapshot {
  readonly windows: RateLimitWindow[];
  readonly credits: number | null;
}

export interface AntigravityQuotaError {
  /** Clean error message with the leading `⚠ ` warning glyph stripped. */
  readonly message: string;
  /** Parsed reset timestamp (ISO-8601), or null when no duration/timestamp was given. */
  readonly resetsAt: string | null;
  /** True when the turn text consisted solely of the warning line (no prior assistant text). */
  readonly pureWarning: boolean;
}

const QUOTA_ERROR_PATTERN =
  /\b(?:individual\s+quota\s+(?:reached|exceeded|exhausted)|quota\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)|exhausted\s+your\s+capacity|resource_exhausted|rate[\s_-]?limit(?:\s+(?:reached|exceeded|exhausted))?|usage\s+limit\s+(?:reached|exceeded))\b/i;

const RELATIVE_RESET_PATTERN =
  /(?:resets?\s+in|reset\s+after|try\s+again\s+in)\s+((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*)+)/i;

const DURATION_TOKEN_PATTERN = /(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)/gi;

const ABSOLUTE_RESET_PATTERN =
  /(?:resets?\s+at|until)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

function parseResetTimestamp(text: string, nowMs: number): string | null {
  const rel = RELATIVE_RESET_PATTERN.exec(text);
  if (rel?.[1]) {
    let totalMs = 0;
    DURATION_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DURATION_TOKEN_PATTERN.exec(rel[1])) !== null) {
      const value = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(value) || value < 0) continue;
      const unit = match[2]!.toLowerCase();
      if (unit.startsWith("d")) totalMs += value * 86_400_000;
      else if (unit.startsWith("h")) totalMs += value * 3_600_000;
      else if (unit.startsWith("m")) totalMs += value * 60_000;
      else if (unit.startsWith("s")) totalMs += value * 1_000;
    }
    if (totalMs > 0) return new Date(nowMs + totalMs).toISOString();
  }
  const abs = ABSOLUTE_RESET_PATTERN.exec(text);
  if (abs?.[1]) {
    const parsed = Date.parse(abs[1]);
    if (Number.isFinite(parsed) && parsed > nowMs) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Recognise Antigravity's quota-exhaustion error messages. Over ACP, `agy acp`
 * formats `CORTEX_STEP_TYPE_ERROR_MESSAGE` as plain assistant text using
 * `"\n⚠ %s\n"` (e.g. `"\n⚠ Individual quota reached. Please upgrade your
 * subscription to increase your limits. Resets in 17m8s.\n"`) and completes
 * the turn normally. By default (`requireWarningPrefix: true`), only a final
 * line beginning with `⚠` matches so ordinary assistant prose discussing quota
 * errors never false-positives.
 */
export function parseAntigravityQuotaError(
  text: string,
  nowMs: number = Date.now(),
  options: { readonly requireWarningPrefix?: boolean } = {},
): AntigravityQuotaError | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const requireWarningPrefix = options.requireWarningPrefix ?? true;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const candidate = requireWarningPrefix ? lines[lines.length - 1]! : trimmed;
  let body = candidate;
  const hasWarningPrefix = /^⚠\uFE0F?\s+/.test(candidate);
  if (requireWarningPrefix) {
    if (!hasWarningPrefix) return null;
    body = candidate.replace(/^⚠\uFE0F?\s+/, "").trim();
  } else if (hasWarningPrefix) {
    body = candidate.replace(/^⚠\uFE0F?\s+/, "").trim();
  }
  if (!body || !QUOTA_ERROR_PATTERN.test(body)) return null;

  return {
    message: body,
    resetsAt: parseResetTimestamp(body, nowMs),
    pureWarning: requireWarningPrefix ? lines.length === 1 : true,
  };
}

/**
 * Build a synthetic exhausted `RateLimitWindow` for the active Antigravity
 * model pool so `usage-limits.json`, `standingLimit`, work-queue admission,
 * and usage protection immediately see the hit before `/usage` finishes.
 */
export function antigravityQuotaWindowForModel(
  model: string | null | undefined,
  resetsAt: string | null,
  nowMs: number = Date.now(),
): RateLimitWindow {
  const rawModel = model?.trim().toLowerCase() ?? "";
  const isGemini =
    !rawModel ||
    rawModel === "default" ||
    rawModel === "antigravity-default" ||
    rawModel.startsWith("gemini");
  const resetMs = resetsAt !== null ? Date.parse(resetsAt) : Number.NaN;
  const isWeekly = Number.isFinite(resetMs) && resetMs - nowMs > 12 * 3_600_000;
  if (isGemini) {
    return isWeekly
      ? { id: "gemini-weekly", label: "Weekly – Gemini", usedPercent: 100, exhausted: true, resetsAt }
      : { id: "gemini-5h", label: "Session – Gemini", usedPercent: 100, exhausted: true, resetsAt };
  }
  return isWeekly
    ? { id: "3p-weekly", label: "Weekly – Claude & GPT", usedPercent: 100, exhausted: true, resetsAt }
    : { id: "3p-5h", label: "Session – Claude & GPT", usedPercent: 100, exhausted: true, resetsAt };
}

export type AntigravityCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string | null>;

/** Bounded inside the server's 6_000ms `USAGE_DRIVER_PROBE_TIMEOUT_MS` race. */
export const ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS = 5_500;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly fetchedAt: number;
  readonly snapshot: AntigravityUsageSnapshot;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<AntigravityUsageSnapshot | null>>();
const queuedForce = new Map<string, Promise<AntigravityUsageSnapshot | null>>();

export function forgetAntigravityUsageCache(): void {
  cache.clear();
  inFlight.clear();
  queuedForce.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isoOrNull(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function clampUsedPercent(remainingFraction: number): number {
  const clamped = Math.min(1, Math.max(0, remainingFraction));
  return Math.round((1 - clamped) * 1000) / 10;
}

/** Shorten Antigravity's verbose group headings to fit Moxen's inline plan-usage bars. */
function shortGroupName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "gemini models") return "Gemini";
  if (lower === "claude and gpt models") return "Claude & GPT";
  if (lower === "gemini 4 argon") return "Argon";
  return name.trim();
}

function labelForBucket(groupName: string, windowType: string | null, bucketName: string | null): string {
  const group = shortGroupName(groupName);
  const kind = windowType?.toLowerCase() ?? "";
  if (kind === "5h" || kind === "session" || kind === "five_hour") {
    return group ? `Session – ${group}` : "Session";
  }
  if (kind === "weekly" || kind === "7d" || kind === "seven_day") {
    return group ? `Weekly – ${group}` : "Weekly";
  }
  if (kind === "monthly") {
    return group ? `Monthly – ${group}` : "Monthly";
  }
  return bucketName ?? (group || "Quota");
}

/**
 * Extract `_meta.antigravity.tier.name` (e.g. `"Google AI Pro"`) from an ACP
 * `session/new` or `session/load` response.
 */
export function parseAntigravityTier(sessionResult: unknown): string | null {
  const root = asRecord(sessionResult);
  const meta = asRecord(root?.["_meta"]);
  const agy = asRecord(meta?.["antigravity"]);
  const tier = asRecord(agy?.["tier"]);
  return asNonEmptyString(tier?.["name"]);
}

/**
 * Parse `agy --print /usage --output-format json` stdout into Moxen
 * `RateLimitWindow`s. Returns an empty array when stdout cannot be parsed.
 */
export function parseAntigravityUsageJson(stdout: string): RateLimitWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  const command = asRecord(root?.["command"]);
  const data = asRecord(command?.["data"]);
  const groups = Array.isArray(data?.["groups"]) ? data["groups"] : [];
  const windows: RateLimitWindow[] = [];

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const groupName = asNonEmptyString(group["name"]) ?? "";
    const buckets = Array.isArray(group["buckets"]) ? group["buckets"] : [];
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const id = asNonEmptyString(bucket["id"]);
      const remaining = bucket["remaining_fraction"];
      if (!id || typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
      const windowType = asNonEmptyString(bucket["window"]);
      const bucketName = asNonEmptyString(bucket["name"]);
      windows.push({
        id,
        label: labelForBucket(groupName, windowType, bucketName),
        usedPercent: clampUsedPercent(remaining),
        exhausted: remaining <= 0,
        resetsAt: isoOrNull(bucket["reset_time"]),
      });
    }
  }
  return windows;
}

/**
 * Parse `agy --print /credits --output-format json` stdout into a finite
 * remaining-credits count, or null when unavailable/unparseable.
 */
export function parseAntigravityCreditsJson(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const command = asRecord(root?.["command"]);
  const data = asRecord(command?.["data"]);
  const credits = data?.["remaining_credits"];
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? credits : null;
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      const launch = acpLaunchCommand(command, args, env);
      child = spawn(launch.command, [...launch.args], {
        env: launch.env ? { ...env, ...launch.env } : env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    const timer = setTimeout(() => {
      try {
        killProcessTree(child, "SIGTERM");
      } catch {
        // Ignore already-exited processes.
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Probe Antigravity plan usage and remaining credits via `agy --print /usage`
 * and `agy --print /credits`. Single-flight and cached per executable path.
 */
export async function probeAntigravityUsage(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly force?: boolean;
    readonly useCache?: boolean;
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly run?: AntigravityCommandRunner;
  } = {},
): Promise<AntigravityUsageSnapshot | null> {
  const nowFn = options.now ?? Date.now;
  const now = nowFn();
  const useCache = options.useCache ?? options.run === undefined;
  if (useCache && !options.force) {
    const hit = cache.get(command);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.snapshot;
  }

  const runner = options.run ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS;
  const startProbe = (): Promise<AntigravityUsageSnapshot | null> => {
    const work = (async (): Promise<AntigravityUsageSnapshot | null> => {
      const [usageOut, creditsOut] = await Promise.all([
        runner(command, ["--print", "/usage", "--output-format", "json"], env, timeoutMs).catch(() => null),
        runner(command, ["--print", "/credits", "--output-format", "json"], env, timeoutMs).catch(() => null),
      ]);
      const windows = usageOut ? parseAntigravityUsageJson(usageOut) : [];
      const credits = creditsOut ? parseAntigravityCreditsJson(creditsOut) : null;
      if (windows.length === 0 && credits === null) return null;
      const snapshot: AntigravityUsageSnapshot = { windows, credits };
      if (useCache) cache.set(command, { fetchedAt: nowFn(), snapshot });
      return snapshot;
    })();
    if (useCache) {
      inFlight.set(command, work);
      void work.finally(() => {
        if (inFlight.get(command) === work) inFlight.delete(command);
      });
    }
    return work;
  };

  if (useCache) {
    const existing = inFlight.get(command);
    if (existing) {
      if (!options.force) return existing;
      // A forced probe arrived while an earlier probe was already running:
      // chain one fresh probe after it completes rather than returning stale data.
      const queued = queuedForce.get(command);
      if (queued) return queued;
      const next = existing
        .catch(() => null)
        .then(() => {
          if (queuedForce.get(command) === next) queuedForce.delete(command);
          return startProbe();
        });
      queuedForce.set(command, next);
      return next;
    }
  }

  return startProbe();
}

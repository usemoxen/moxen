/**
 * Antigravity subscription usage & credits probing via the official `agy` CLI:
 * `agy --print /usage --output-format json` and `agy --print /credits --output-format json`.
 * Both are local slash commands (`num_turns: 0`, `total_tokens: 0`) that use
 * `agy`'s own login — Moxen never reads or handles credentials.
 */
import { spawn } from "node:child_process";

import type { RateLimitWindow } from "../spi.js";

export interface AntigravityUsageSnapshot {
  readonly windows: RateLimitWindow[];
  readonly credits: number | null;
}

export type AntigravityCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string | null>;

const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly fetchedAt: number;
  readonly snapshot: AntigravityUsageSnapshot;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<AntigravityUsageSnapshot | null>>();

export function forgetAntigravityUsageCache(): void {
  cache.clear();
  inFlight.clear();
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
      child = spawn(command, [...args], {
        env,
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
        child.kill();
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
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly run?: AntigravityCommandRunner;
  } = {},
): Promise<AntigravityUsageSnapshot | null> {
  const now = (options.now ?? Date.now)();
  const useCache = options.run === undefined;
  if (useCache && !options.force) {
    const hit = cache.get(command);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.snapshot;
  }
  const existing = useCache ? inFlight.get(command) : undefined;
  if (existing) return existing;

  const runner = options.run ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const work = (async (): Promise<AntigravityUsageSnapshot | null> => {
    const [usageOut, creditsOut] = await Promise.all([
      runner(command, ["--print", "/usage", "--output-format", "json"], env, timeoutMs).catch(() => null),
      runner(command, ["--print", "/credits", "--output-format", "json"], env, timeoutMs).catch(() => null),
    ]);
    const windows = usageOut ? parseAntigravityUsageJson(usageOut) : [];
    const credits = creditsOut ? parseAntigravityCreditsJson(creditsOut) : null;
    if (windows.length === 0 && credits === null) return null;
    const snapshot: AntigravityUsageSnapshot = { windows, credits };
    if (useCache) cache.set(command, { fetchedAt: now, snapshot });
    return snapshot;
  })();

  if (useCache) {
    inFlight.set(command, work);
    void work.finally(() => {
      if (inFlight.get(command) === work) inFlight.delete(command);
    });
  }
  return work;
}

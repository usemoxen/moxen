/**
 * The latest subscription usage windows each provider reported (Claude's
 * session and weekly limits, OpenCode Go's five-hour, weekly and monthly
 * ones), merged from every `rate-limits.updated` event the drivers publish:
 * the start-up probe gives the full set, live events refresh one window at a
 * time.
 *
 * Kept per account, not per thread: the limits belong to the account the
 * provider CLI is logged into, so every thread on it shares them. For Claude
 * and Codex that account is the driver; OpenCode below its driver id is one
 * provider per instance, so an instance that reports its own plan (Go) is
 * recorded under its instance id (`usageKeyForInstance`). The process that
 * owns the sessions records them; clients read them through the `usage.limits`
 * query. Persisted next to the thread store so a fresh process shows the last
 * known numbers before its first turn.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameReplacing } from "../infra/atomic.js";

import type { ProviderUsageLimits, ProviderUsageWindow } from "../catalog/summary.js";
import type { RateLimitWindow } from "../providers/spi.js";
import { driverKindOfInstance } from "../types.js";

interface RecordedWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

interface RecordedProvider {
  exhaustedAt?: string;
  protectedAt?: string;
  checkedAt: string;
  windows: RecordedWindow[];
  credits?: number;
}

export interface UsageProtectionOverride {
  readonly provider: string;
  readonly since: string;
  readonly windows: readonly RecordedWindow[];
}

export function captureUsageProtectionOverride(provider: string, now: number): UsageProtectionOverride {
  return { provider, since: new Date(now).toISOString(), windows: (recorded.get(provider)?.windows ?? []).map((window) => ({ ...window })) };
}

/** A manual continuation opts out only until the next reported or timed reset. */
export function usageProtectionOverrideActive(override: UsageProtectionOverride | null | undefined, provider: string, now = Date.now()): boolean {
  if (!override || override.provider !== provider) return false;
  const current = recorded.get(provider)?.windows ?? [];
  if ([...override.windows, ...current].some((window) => window.resetsAt !== null && Date.parse(window.resetsAt) > Date.parse(override.since) && Date.parse(window.resetsAt) <= now)) return false;
  return !current.some((window) => {
    const before = override.windows.find((previous) => previous.id === window.id);
    return before && window.usedPercent < before.usedPercent && (before.resetsAt === null || before.resetsAt !== window.resetsAt);
  });
}

const FILE_NAME = "usage-limits.json";

let recorded = new Map<string, RecordedProvider>();
let persistFile: string | null = null;
let persistence: Promise<unknown> = Promise.resolve();

function persistRecorded(): void {
  const file = persistFile;
  if (file === null) return;
  const payload = JSON.stringify(Object.fromEntries(recorded), null, 2);
  persistence = persistence.catch(() => undefined).then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, payload);
    await renameReplacing(tmp, file);
  }).catch(() => undefined);
}

export function usageSignal(provider: string, state: "exhausted" | "protected"): string | null {
  return recorded.get(provider)?.[state === "exhausted" ? "exhaustedAt" : "protectedAt"] ?? null;
}

export function recordUsageProtection(provider: string, at = Date.now()): void {
  const previous = recorded.get(provider);
  if (!previous) return;
  recorded.set(provider, { ...previous, protectedAt: new Date(at).toISOString() });
  persistRecorded();
}

/** Where the registry persists, and loads what an earlier process left. */
export function persistUsageLimits(storeRoot: string): void {
  const file = path.join(storeRoot, FILE_NAME);
  if (persistFile === file) return;
  persistFile = file;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, RecordedProvider>;
    for (const [provider, entry] of Object.entries(raw)) {
      if (recorded.has(provider) || !entry || !Array.isArray(entry.windows)) continue;
      // Claude's extra-usage cap was once recorded as "unknown"; it is `overage` now, and the old row would never age out beside it.
      recorded.set(provider, { ...entry, windows: entry.windows.filter((window) => window.id !== "unknown") });
    }
  } catch {
    // No file yet, or unreadable: start empty.
  }
}

/**
 * Merge one report into the provider's windows. A window reported without a
 * percentage (a live event that only says "allowed") keeps the last known
 * one; a window never seen with a percentage is left out.
 */
export function recordUsageWindows(
  provider: string,
  windows: ReadonlyArray<RateLimitWindow>,
  at: number = Date.now(),
  options?: { readonly credits?: number | null | undefined },
): void {
  const existing = recorded.get(provider);
  const previous = existing?.windows ?? [];
  const merged = new Map(previous.map((window) => [window.id, window] as const));
  let changed = false;
  for (const window of windows) {
    const known = merged.get(window.id);
    const usedPercent = window.usedPercent ?? (window.exhausted ? 100 : known?.usedPercent);
    if (usedPercent === undefined || usedPercent === null) continue;
    merged.set(window.id, { id: window.id, label: window.label, usedPercent, resetsAt: window.resetsAt ?? known?.resetsAt ?? null });
    changed = true;
  }
  const credits =
    typeof options?.credits === "number" && Number.isFinite(options.credits)
      ? options.credits
      : existing?.credits;
  if (typeof options?.credits === "number" && Number.isFinite(options.credits)) {
    changed = true;
  }
  if (!changed) return;
  recorded.set(provider, {
    ...existing,
    checkedAt: new Date(at).toISOString(),
    windows: [...merged.values()],
    ...(credits === undefined ? {} : { credits }),
    ...(windows.some((window) => window.exhausted || (window.usedPercent ?? 0) >= 100) ? { exhaustedAt: new Date(at).toISOString() } : {}),
  });
  persistRecorded();
}

/** Drivers label windows "Session", "Weekly", "Weekly – Opus", "Monthly"; the kind follows. */
function windowKind(label: string): string {
  const head = label.toLowerCase();
  if (head.startsWith("session")) return "session";
  if (head.startsWith("weekly")) return "weekly";
  if (head.startsWith("monthly")) return "monthly";
  return "other";
}

/**
 * The key one thread's usage windows live under. Claude and Codex report for
 * their whole driver; an `opencode/<provider>` instance is its own provider,
 * so Go's windows are its instance's and no other OpenCode instance's.
 */
export function usageKeyForInstance(instanceId: string): string {
  const raw = instanceId.trim().toLowerCase();
  const kind = driverKindOfInstance(raw);
  return kind !== null ? (kind === "opencode" && raw.startsWith("opencode/") ? raw : kind) : raw;
}

/**
 * Every provider's windows, keyed by account (`usageKeyForInstance`). A window
 * whose reset time has passed reads 0% with no reset: the provider hasn't
 * reported the new one yet, but the old number no longer holds.
 */
export function usageLimitsSnapshot(now: number = Date.now()): Record<string, ProviderUsageLimits> {
  const result: Record<string, ProviderUsageLimits> = {};
  for (const [provider, entry] of recorded) {
    const windows: ProviderUsageWindow[] = entry.windows.map((window) => {
      const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
      const lapsed = Number.isFinite(reset) && reset <= now;
      return {
        id: window.id,
        kind: windowKind(window.label),
        label: window.label,
        usedPercent: lapsed ? 0 : window.usedPercent,
        resetsAt: lapsed ? null : window.resetsAt,
      };
    });
    const rank: Record<string, number> = { session: 0, weekly: 1, monthly: 2, other: 3 };
    windows.sort((left, right) => (rank[left.kind] ?? 3) - (rank[right.kind] ?? 3));
    result[provider] = {
      checkedAt: entry.checkedAt,
      windows,
      ...(typeof entry.credits === "number" && Number.isFinite(entry.credits) ? { credits: entry.credits } : {}),
      unavailable: null,
    };
  }
  return result;
}

function antigravityWindowMatchesModel(window: RecordedWindow, model: string | null | undefined): boolean {
  const id = window.id.toLowerCase();
  const label = window.label.toLowerCase();
  const is3pWindow = id.startsWith("3p-") || id.startsWith("claude-gpt") || /\bclaude\s*&\s*gpt\b/i.test(label);
  const isGeminiWindow = id.startsWith("gemini-") || /\bgemini\b|\bargon\b|\bneon\b/i.test(label);
  const isArgonWindow = id.includes("argon") || /\bargon\b/i.test(label);
  const rawModel = model?.trim().toLowerCase() ?? "";
  if (!rawModel) {
    // Without a specific model, keep the secondary 3p pool from blocking the primary Gemini pool.
    return !is3pWindow;
  }
  const isGeminiModel = rawModel.startsWith("gemini") || rawModel === "default";
  if (isGeminiModel) {
    if (is3pWindow) return false;
    if (isArgonWindow && !rawModel.includes("argon")) return false;
    return true;
  }
  // Third-party model (Claude / GPT / etc.) on Antigravity: only 3p or shared windows apply.
  if (isGeminiWindow && !is3pWindow) return false;
  return true;
}

/**
 * The window that is spent right now for an account, if any: at 100% with
 * a reset still ahead. A turn that fails while one stands was stopped by
 * it, whatever its error text says — the provider only reports a limit
 * when it *changes*, so the second turn into the same wall is told nothing.
 */
export function standingLimit(
  provider: string,
  now: number = Date.now(),
  model?: string | null,
): { label: string; resetsAt: string } | null {
  const entry = recorded.get(provider);
  if (!entry) return null;
  const spent = entry.windows
    .filter((window) => {
      if (window.usedPercent < 100 || window.resetsAt === null || Date.parse(window.resetsAt) <= now) return false;
      if (provider === "antigravity" && !antigravityWindowMatchesModel(window, model)) return false;
      return true;
    })
    // Every spent window blocks the account; a session reset cannot clear a weekly limit.
    .sort((left, right) => Date.parse(right.resetsAt!) - Date.parse(left.resetsAt!));
  const first = spent[0];
  return first ? { label: first.label, resetsAt: first.resetsAt! } : null;
}

/** Tests only: forget everything and stop persisting. */
export function resetUsageLimitsForTests(): void {
  recorded = new Map();
  persistFile = null;
}

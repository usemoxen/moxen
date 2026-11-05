/**
 * OpenCode Go's plan usage, from the server's experimental route
 * (`GET /api/experimental/usage/limits`) — the same server the driver already
 * runs, never a Console call of our own.
 *
 * The route is experimental and answers `data: null` when the location is not
 * signed in to the OpenCode Console, and omits `go` when the workspace has no
 * Go plan; an old server answers 404. All of those, and a body that no longer
 * matches, read as unknown: usage is advisory, so nothing here may fail a turn
 * or make noise.
 */
import type { RateLimitWindow } from "../spi.js";

/** The provider instance whose plan the OpenCode Go windows belong to. */
export const OPENCODE_GO_INSTANCE = "opencode/opencode-go";

/** Whether a session's instance uses the OpenCode Go plan. */
export function isOpencodeGo(instanceId: string): boolean {
  return instanceId.trim().toLowerCase() === OPENCODE_GO_INSTANCE;
}

const USAGE_LIMITS_PATH = "/api/experimental/usage/limits";
const USAGE_LIMITS_TIMEOUT_MS = 5_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A meter as a window; `limited` counts as spent whatever the percentage says. */
function windowOf(meter: unknown, id: string, label: string): RateLimitWindow | null {
  const entry = asRecord(meter);
  if (!entry) return null;
  const limited = entry.limited === true;
  const reported = typeof entry.percent === "number" && Number.isFinite(entry.percent)
    ? Math.min(100, Math.max(0, entry.percent))
    : null;
  // Limited means requests are refused: spent, whatever percentage the last
  // report showed. Every reader judges a window by its percentage.
  const percent = limited ? 100 : reported;
  if (percent === null) return null;
  const resets = typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt) && entry.resetsAt > 0
    ? new Date(entry.resetsAt).toISOString()
    : null;
  return { id, label, resetsAt: resets, exhausted: limited || percent >= 100, usedPercent: percent };}

/**
 * Map the route's answer to windows: `rolling` is the five-hour session window,
 * `weekly` the weekly one, `monthly` the plan's monthly allowance. Everything
 * sits under `data`. Null when the server has nothing to say.
 */
export function opencodeGoWindows(raw: unknown): RateLimitWindow[] | null {
  const data = asRecord(asRecord(raw)?.data);
  const go = asRecord(data?.go);
  if (!go) return null;
  const windows = [
    windowOf(go.rolling, "session", "Session"),
    windowOf(go.weekly, "weekly", "Weekly"),
    windowOf(go.monthly, "monthly", "Monthly"),
  ].flatMap((window) => (window ? [window] : []));
  return windows.length > 0 ? windows : null;
}

/**
 * Read and map the route, with the connection's own Basic auth. Any failure —
 * a 404 from a server that predates the route, a dropped connection, a body
 * that is not JSON — is unknown rather than an error.
 */
export async function readOpencodeUsageLimits(
  baseUrl: string,
  directory: string,
  headers: Readonly<Record<string, string>>,
  fetchImpl: typeof fetch = fetch,
): Promise<RateLimitWindow[] | null> {
  try {
    const url = new URL(USAGE_LIMITS_PATH, baseUrl);
    if (directory.length > 0) url.searchParams.set("location[directory]", directory);
    const response = await fetchImpl(url, {
      headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(USAGE_LIMITS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return opencodeGoWindows(await response.json());
  } catch {
    return null;
  }
}

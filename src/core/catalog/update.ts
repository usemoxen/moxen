/**
 * The vocabulary of a provider update, shared by the server and both clients:
 * which providers can be updated, what an update reports, and how to say it.
 * Pure; running the updater is `providers/update.ts`.
 */

export const UPDATABLE_PROVIDERS = ["claude", "opencode", "codex", "antigravity"] as const;
export type UpdatableProvider = (typeof UPDATABLE_PROVIDERS)[number];

export interface ProviderUpdate {
  readonly provider: UpdatableProvider;
  /** The version before and after, null where the binary could not say. */
  readonly before: string | null;
  readonly after: string | null;
  /** The version moved. False when it was already current, or when the tool could not update this install. */
  readonly updated: boolean;
  /** What the tool printed, trimmed: the reason, when nothing changed. */
  readonly output: string;
}

export type ProviderUpdateAllItem =
  | { readonly provider: UpdatableProvider; readonly ok: true; readonly update: ProviderUpdate }
  | { readonly provider: UpdatableProvider; readonly ok: false; readonly error: string };

export interface ProviderUpdateAllResult {
  readonly results: readonly ProviderUpdateAllItem[];
}

const LABELS: Record<UpdatableProvider, string> = { claude: "Claude Code", opencode: "OpenCode", codex: "Codex", antigravity: "Antigravity" };

/** What to tell the user once an update ran: what changed, and what still runs the old build. */
export function describeUpdate(update: ProviderUpdate): string {
  const label = LABELS[update.provider];
  if (update.updated) {
    const restart =
      update.provider !== "opencode"
        ? "New sessions use it; a session already running keeps the old build until it restarts."
        : "New sessions use it once the OpenCode server restarts; one already running keeps the old build.";
    return `${label} ${update.before} → ${update.after}. ${restart}`;
  }
  // Unchanged: say so in the tool's own words ("up to date", or why this install cannot update itself).
  const verdict = update.output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).pop();
  const at = update.after === null ? "" : ` (${update.after})`;
  return `${label} was not changed${at}${verdict === undefined ? "." : `: ${verdict}`}`;
}

export interface UpdateStatusSummary {
  readonly tone: "ok" | "warn" | "error";
  readonly label: string;
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const LEADING_DECORATION_RE = /^[│├└─┌┐┘┤┬┴┼✓✔•\s]+/u;
const UP_TO_DATE_RE =
  /up[\s-]+to[\s-]+date|already\s+(?:on\s+the\s+)?latest|latest\s+version.*already\s+installed|already\s+installed|not\s+upgrading.*already|nothing\s+to\s+upgrade/iu;

function cleanUpdateLine(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, "").replace(LEADING_DECORATION_RE, "").trim();
}

/**
 * Concise, UI-safe status line for a finished CLI update result, stripping raw
 * box-drawing glyphs and recognizing common "already up to date" outputs across
 * Claude Code, OpenCode, Codex (Homebrew/npm), and Antigravity.
 */
export function summarizeUpdateStatus(item: ProviderUpdateAllItem): UpdateStatusSummary {
  if (!item.ok) {
    const cleaned = cleanUpdateLine(item.error.split("\n")[0] ?? item.error);
    return { tone: "error", label: cleaned || "Update failed" };
  }
  const { update } = item;
  if (update.updated) {
    if (update.before && update.after) {
      return { tone: "ok", label: `Updated v${update.before} → v${update.after}` };
    }
    return { tone: "ok", label: update.after ? `Updated to v${update.after}` : "Updated" };
  }
  const lines = update.output
    .split("\n")
    .map(cleanUpdateLine)
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (
    lines.length === 0 ||
    lines.some((line) => UP_TO_DATE_RE.test(line)) ||
    (last !== undefined && /^done\.?$/iu.test(last))
  ) {
    return { tone: "ok", label: "Up to date" };
  }
  return { tone: "warn", label: last! };
}

/** The `x.y.z` in a `--version` line such as `opencode v2.0.19` or `2.1.292 (Claude Code)`, or null. */
export function versionNumber(line: string | null): string | null {
  return line?.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

export function parseSemver(raw: string): [number, number, number] | null {
  const match = raw.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `have < want`. Unparseable `have` reads as too old. */
export function compareSemver(have: string, want: string): number {
  const parsedHave = parseSemver(have);
  const parsedWant = parseSemver(want);
  if (!parsedHave) return -1;
  if (!parsedWant) return 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = (parsedHave[index] ?? 0) - (parsedWant[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/** The newest version a provider's channel offers, as the registry reports it. */
export interface LatestVersion {
  /** Null when it could not be asked (offline, a slow registry, the check is off). */
  readonly latest: string | null;
  /** The release channel it was read for (Claude Code: `latest` or `stable`); null where there are none. */
  readonly channel: string | null;
}

export interface LatestVersions {
  /** False when `updates.checkLatest` is off: nothing was asked. */
  readonly enabled: boolean;
  readonly claude: LatestVersion;
  readonly opencode: LatestVersion;
  /** Absent on older Moxen servers. */
  readonly codex?: LatestVersion;
  /** Absent on older Moxen servers. */
  readonly antigravity?: LatestVersion;
}

/**
 * Where an install stands against the newest on its channel. A version past it
 * (a stable channel lagging an install that took `latest`) is current: there is
 * nothing to update to.
 */
export function updateState(installed: string | null, latest: string | null): "available" | "current" | "unknown" {
  if (installed === null || latest === null) return "unknown";
  return compareSemver(installed, latest) < 0 ? "available" : "current";
}

/**
 * Which version of Claude Code and OpenCode is newest, for the settings page's
 * "update available" line. Neither tool can be asked without installing
 * (`claude update` and `opencode upgrade` both just do it), so this reads the
 * public npm registry, which publishes both: `@anthropic-ai/claude-code` with a
 * dist-tag per release channel, and `@opencode/cli` (the v2 CLI: it ships the
 * `opencode` binary, from the same repository, on the 2.0.x line).
 *
 * Claude Code has two channels, `latest` and `stable` (about a week behind), and
 * "newest" is the one the install follows; `claude doctor` says which. A failed
 * read is not an error: it is `null`, and the page says it could not check.
 * Answers are kept for a few minutes, so reopening the page does not ask again.
 */
import { runProcess } from "../infra/process.js";
import type { LatestVersion, LatestVersions } from "../catalog/update.js";

const REGISTRY = "https://registry.npmjs.org";
const PACKAGES = { claude: "@anthropic-ai/claude-code", opencode: "@opencode/cli" } as const;
const TIMEOUT_MS = 5_000;
const KEEP_MS = 10 * 60_000;

export interface LatestDeps {
  /** JSON of a URL, or throws; replaced in tests so nothing touches the network. */
  readonly fetchJson?: (url: string, timeoutMs: number) => Promise<unknown>;
  /** Runs a command to completion; replaced in tests. */
  readonly run?: (binary: string, args: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;
  readonly now?: () => number;
}

const defaultFetchJson = async (url: string, timeoutMs: number): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status}`);
  return await response.json();
};

const defaultRun: NonNullable<LatestDeps["run"]> = (binary, args) =>
  runProcess(binary, args, { timeoutMs: 15_000, allowFailure: true });

/** The channel an install follows, from `claude doctor` ("Auto-update channel: stable"); `latest` when it does not say. */
export async function claudeChannel(binaryPath: string, run: NonNullable<LatestDeps["run"]> = defaultRun): Promise<"latest" | "stable"> {
  try {
    const result = await run(binaryPath, ["doctor"]);
    const channel = /Auto-update channel:\s*(\w+)/iu.exec(result.stdout)?.[1]?.toLowerCase();
    return channel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

/** The version a package's dist-tag points at, or null. */
async function tagVersion(pkg: string, tag: string, deps: LatestDeps): Promise<string | null> {
  try {
    const body = await (deps.fetchJson ?? defaultFetchJson)(`${REGISTRY}/${pkg.replace("/", "%2F")}/${tag}`, TIMEOUT_MS);
    const version = (body as { version?: unknown } | null)?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/u.test(version) ? version : null;
  } catch {
    return null;
  }
}

const kept = new Map<string, { readonly at: number; readonly value: LatestVersion }>();

async function cached(key: string, deps: LatestDeps, read: () => Promise<LatestVersion>): Promise<LatestVersion> {
  const now = (deps.now ?? Date.now)();
  const hit = kept.get(key);
  if (hit !== undefined && now - hit.at < KEEP_MS) return hit.value;
  const value = await read();
  // A failed read is not kept: the next look asks again.
  if (value.latest !== null) kept.set(key, { at: now, value });
  return value;
}

export async function latestVersions(options: { readonly claudeBinaryPath?: string } = {}, deps: LatestDeps = {}): Promise<Omit<LatestVersions, "enabled">> {
  const claude = async (): Promise<LatestVersion> => {
    const binary = options.claudeBinaryPath?.trim() || "claude";
    const channel = await claudeChannel(binary, deps.run);
    return await cached(`claude:${channel}`, deps, async () => ({ latest: await tagVersion(PACKAGES.claude, channel, deps), channel }));
  };
  const opencode = (): Promise<LatestVersion> =>
    cached("opencode", deps, async () => ({ latest: await tagVersion(PACKAGES.opencode, "latest", deps), channel: null }));
  const [claudeResult, opencodeResult] = await Promise.all([claude(), opencode()]);
  return { claude: claudeResult, opencode: opencodeResult };
}

/** Forget what was kept (tests). */
export function forgetLatestVersions(): void {
  kept.clear();
}

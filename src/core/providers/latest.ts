/**
 * Which version of Claude Code, OpenCode, Codex and Antigravity is newest, for
 * the settings page's "update available" line. Claude Code, OpenCode and Codex
 * read the public npm registry (`@anthropic-ai/claude-code` with a dist-tag per
 * release channel, `@opencode/cli` on the 2.0.x line, and `@openai/codex`).
 * Antigravity (`agy`) is a standalone native binary published on GitHub
 * Releases (`google-antigravity/antigravity-cli`).
 *
 * Claude Code has two channels, `latest` and `stable` (about a week behind), and
 * "newest" is the one the install follows; `claude doctor` says which. A failed
 * read is not an error: it is `null`, and the page says it could not check.
 * Answers are kept for a few minutes, so reopening the page does not ask again.
 */
import { runProcess } from "../infra/process.js";
import type { LatestVersion, LatestVersions } from "../catalog/update.js";

const REGISTRY = "https://registry.npmjs.org";
const PACKAGES = { claude: "@anthropic-ai/claude-code", opencode: "@opencode/cli", codex: "@openai/codex" } as const;
export const ANTIGRAVITY_LATEST_RELEASE_URL = "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest";
export const VIBE_LATEST_RELEASE_URL = "https://api.github.com/repos/mistralai/mistral-vibe/releases/latest";
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
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/vnd.github+json, application/json", "user-agent": "moxen" },
  });
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

/** The newest non-draft, non-prerelease version on a GitHub repository's Releases page, or null. */
async function githubReleaseVersion(url: string, deps: LatestDeps): Promise<string | null> {
  try {
    const body = (await (deps.fetchJson ?? defaultFetchJson)(url, TIMEOUT_MS)) as {
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    } | null;
    if (!body || body.draft === true || body.prerelease === true) return null;
    const raw = typeof body.tag_name === "string" ? body.tag_name.trim().replace(/^v/u, "") : "";
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(raw) ? raw : null;
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
  const codex = (): Promise<LatestVersion> =>
    cached("codex", deps, async () => ({ latest: await tagVersion(PACKAGES.codex, "latest", deps), channel: null }));
  const antigravity = (): Promise<LatestVersion> =>
    cached("antigravity", deps, async () => ({ latest: await githubReleaseVersion(ANTIGRAVITY_LATEST_RELEASE_URL, deps), channel: null }));
  const vibe = (): Promise<LatestVersion> =>
    cached("vibe", deps, async () => ({ latest: await githubReleaseVersion(VIBE_LATEST_RELEASE_URL, deps), channel: null }));
  const [claudeResult, opencodeResult, codexResult, antigravityResult, vibeResult] = await Promise.all([claude(), opencode(), codex(), antigravity(), vibe()]);
  return { claude: claudeResult, opencode: opencodeResult, codex: codexResult, antigravity: antigravityResult, vibe: vibeResult };
}

/** Forget what was kept (tests). */
export function forgetLatestVersions(): void {
  kept.clear();
}

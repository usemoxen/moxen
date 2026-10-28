/**
 * OpenCode driver settings: own the serve spawn, never the auth.
 *
 * Auth is the `opencode` CLI's own: `opencode auth login` for OAuth (v2 has
 * built-in ChatGPT Pro/Plus, `opencode auth login openai`, and SuperGrok,
 * `opencode auth login xai`, logins), provider API keys via env. We spawn
 * `opencode serve` ourselves and always give it a password, because v2 puts
 * every `/api/*` route behind HTTP Basic auth. Version gating keeps the API
 * surface we call (OpenCode v2, `@opencode/client`) in reach.
 * See docs/providers.md.
 */
import { opencodeDisabledToolConfig } from "../../nativetools.js";
import { buildOpencodeSystemPrompt } from "./prompt.js";
import { randomBytes } from "node:crypto";

export const OPENCODE_DEFAULT_BINARY = "opencode";
export const OPENCODE_MIN_VERSION = "2.0.0";
/** The line `opencode serve` prints once it accepts connections (v1 prefixed it with `opencode `). The terminating whitespace keeps a chunk split mid-URL from matching. */
export const OPENCODE_SERVER_READY_PATTERN = /server listening on (https?:\/\/\S+)\s/;
export const OPENCODE_SERVER_START_TIMEOUT_MS = 30_000;
export const OPENCODE_DEFAULT_HOSTNAME = "127.0.0.1";

export interface OpencodeSettings {
  readonly binaryPath: string;
  /** Blank = spawn a server per working directory; set = use an external one. */
  readonly serverUrl: string;
  /** Password for an external server (never inherited from env there). */
  readonly serverPassword: string;
  readonly minVersion: string;
  /** Written into a spawned server's `compaction` config; null leaves OpenCode's own. */
  readonly autoCompact: boolean | null;
  readonly compactBuffer: number | null;
}

export function normalizeOpencodeSettings(raw: Partial<OpencodeSettings> = {}): OpencodeSettings {
  const binaryPath = raw.binaryPath?.trim() ? raw.binaryPath.trim() : OPENCODE_DEFAULT_BINARY;
  return {
    binaryPath,
    serverUrl: raw.serverUrl?.trim() ?? "",
    serverPassword: raw.serverPassword ?? "",
    minVersion: raw.minVersion?.trim() ? raw.minVersion.trim() : OPENCODE_MIN_VERSION,
    autoCompact: raw.autoCompact ?? null,
    compactBuffer: raw.compactBuffer ?? null,
  };
}

/**
 * Password for a *spawned* server, never empty: the explicit setting wins,
 * else the env the server itself honors (`OPENCODE_PASSWORD`, then
 * `OPENCODE_SERVER_PASSWORD`), else a fresh random one. v2 always
 * authenticates, and without one it invents a password and prints it on
 * stdout, which we would then have to scrape. External servers never inherit
 * the env password — leaking an ambient secret to a URL we didn't spawn would
 * be a confused-deputy grant.
 */
export function resolveSpawnedServerPassword(
  settings: OpencodeSettings,
  env: NodeJS.ProcessEnv,
  generate: () => string = () => randomBytes(32).toString("base64url"),
): string {
  if (settings.serverPassword.trim().length > 0) return settings.serverPassword;
  for (const name of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"] as const) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return generate();
}

/**
 * The `OPENCODE_CONFIG_CONTENT` for a spawned server: the user's own content
 * plus `share: "disabled"` and `update: "disable"` (we never share sessions or
 * let the server update itself under us). Every other user key is kept as is.
 * Permissions are deliberately not injected: v2's default (allow all) matches
 * what moxen has always run with.
 * `disabledNativeTools` (the provider's setting) switches OpenCode's own tools
 * off: `websearch: false`, and a `deny` rule per other tool, appended to the
 * user's own `permissions` (the last matching rule wins, so ours hold).
 * `moxenPrompt` sets the `system` of the `build` agent (the one Moxen's sessions run) to Moxen's prompt, which replaces the base
 * prompt OpenCode picks for the model family; an agent the user already gave a `system` keeps theirs.
 * Unparseable content is replaced, not merged — a corrupt config would
 * break the server boot either way, and replacing keeps the failure
 * legible at our layer instead of deep in the server.
 */
export function buildServerConfigContent(
  existing: string | undefined,
  compaction: { readonly auto?: boolean | null; readonly buffer?: number | null } = {},
  disabledNativeTools?: string,
  /** Replace OpenCode's base prompt for its `build` agent with Moxen's (`prompt.ts`). */
  moxenPrompt = false,
): string {
  let parsed: Record<string, unknown> = {};
  if (existing && existing.trim().length > 0) {
    try {
      const decoded = JSON.parse(existing) as unknown;
      if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
        parsed = decoded as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  // Only what Moxen's settings name overrides the user's own `compaction`; the rest of it stays.
  const own = parsed.compaction !== null && typeof parsed.compaction === "object" && !Array.isArray(parsed.compaction) ? (parsed.compaction as Record<string, unknown>) : {};
  const set = { ...(compaction.auto != null ? { auto: compaction.auto } : {}), ...(compaction.buffer != null ? { buffer: compaction.buffer } : {}) };
  const merged = { ...own, ...set };
  const off = opencodeDisabledToolConfig(disabledNativeTools);
  const agents = moxenPrompt ? withMoxenSystem(parsed.agents, buildOpencodeSystemPrompt(disabledNativeTools)) : parsed.agents;
  const ownRules = Array.isArray(parsed.permissions) ? (parsed.permissions as unknown[]) : [];
  return JSON.stringify({
    ...parsed,
    ...(Object.keys(merged).length > 0 ? { compaction: merged } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(off.websearch === false ? { websearch: false } : {}),
    ...(off.permissions ? { permissions: [...ownRules, ...off.permissions] } : {}),
    share: "disabled",
    update: "disable",
  });
}

/** The user's `agents`, with Moxen's prompt as the `system` of `build` unless they set one. */
function withMoxenSystem(raw: unknown, system: string): Record<string, unknown> {
  const own = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...own };
  for (const name of ["build"]) {
    const agent = own[name] !== null && typeof own[name] === "object" && !Array.isArray(own[name]) ? (own[name] as Record<string, unknown>) : {};
    const set = typeof agent.system === "string" && agent.system.trim() !== "";
    out[name] = set ? agent : { ...agent, system };
  }
  return out;
}

export { compareSemver, parseSemver } from "../semver.js";

const AUTH_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /401/,
  /unauthorized/i,
  /not authenticated/i,
  /invalid api key/i,
  /authentication required/i,
];

export function isOpencodeAuthErrorText(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function opencodeSignedOutMessage({ cwd }: { cwd: string }): string {
  return (
    `OpenCode is not authenticated for ${cwd}. ` +
    `Run \`opencode auth login\` (or set the provider API key), then retry. ` +
    `ChatGPT Pro/Plus (\`opencode auth login openai\`) and SuperGrok (\`opencode auth login xai\`) ` +
    `subscriptions are built in once connected.`
  );
}

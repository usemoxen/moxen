/**
 * OpenCode catalog: the models.dev long tail + stored-auth status.
 *
 * Own code, shaped by upstream `packages/core/src/models-dev.ts` and
 * `packages/core/src/plugin/models-dev.ts` (constants + behavior, not
 * text): `GET ${source}/api.json` (default
 * `https://models.opencode.ai`), 5-minute disk-cache freshness, pinned
 * snapshot fallback, 10s fetch timeout. Two deliberate differences from
 * upstream, both forced by our shape:
 * - Upstream serves disk/snapshot immediately and refreshes on a 60-min
 *   background poll (it is a long-lived server). We are request-scoped
 *   (one CLI invocation), so a stale cache triggers one blocking
 *   refresh with snapshot fallback on failure.
 * - Upstream caches in its own `Global.Path.cache`; we keep our own
 *   `~/.moxen/cache/opencode-models.json` so we never contend with the
 *   server's lock/refresh protocol.
 *
 * Auth status comes from `opencode auth list --format json --standalone` (v2 keeps
 * credentials in SQLite). Only the credential *type* per provider is
 * surfaced — the command itself emits no secrets, and we never log any.
 *
 * Snapshot provenance: `models-snapshot.json` is a verbatim
 * `GET https://models.opencode.ai/api.json` response pinned 2026-09-21
 * (222 providers, ~4.7MB). Refresh overwrites only our cache file, never
 * the pin.
 */
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { appHomeDir } from "../../config.js";
import { killProcessTreeAsync, resolveOnPath } from "../../infra/process.js";
import { OPENCODE_DEFAULT_BINARY } from "./config.js";

export const MODELS_DEV_DEFAULT_URL = "https://models.opencode.ai";
export const MODELS_DEV_API_PATH = "/api.json";
export const MODELS_DEV_CACHE_TTL_MS = 5 * 60 * 1000;
export const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;

/** A models.dev reasoning knob on one model. */
export interface ModelsDevReasoningOption {
  readonly type: string;
  readonly values?: ReadonlyArray<string> | undefined;
}

export interface ModelsDevModelCost {
  readonly input: number | null;
  readonly output: number | null;
}

export interface ModelsDevModel {
  readonly id: string;
  readonly name: string;
  readonly reasoningOptions: ReadonlyArray<ModelsDevReasoningOption>;
  readonly cost: ModelsDevModelCost | null;
}

/**
 * Zero-cost model (opencode's own `Free` label rule: `cost.input === 0`).
 * Missing cost data never reads as free.
 */
export function isFreeModel(model: ModelsDevModel): boolean {
  return model.cost !== null && model.cost.input === 0 && model.cost.output === 0;
}

export interface ModelsDevProvider {
  readonly id: string;
  readonly name: string;
  /** Env var names holding API keys for this provider (upstream `env[]`). */
  readonly env: ReadonlyArray<string>;
  readonly models: ReadonlyArray<ModelsDevModel>;
}

export type ModelsDevCatalog = ReadonlyArray<ModelsDevProvider>;

export type ModelsDevCatalogSource = "cache" | "live" | "snapshot" | "empty";

export interface LoadedModelsDevCatalog {
  readonly catalog: ModelsDevCatalog;
  readonly source: ModelsDevCatalogSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseReasoningOption(raw: unknown): ModelsDevReasoningOption | null {
  const entry = asRecord(raw);
  const type = entry ? asString(entry.type) : null;
  if (!type) return null;
  const values = entry?.values;
  if (values === undefined) return { type };
  if (!Array.isArray(values)) return { type };
  const names = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  return { type, values: names };
}

function parseCost(raw: unknown): ModelsDevModelCost | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const input = number(entry.input);
  const output = number(entry.output);
  if (input === null && output === null) return null;
  return { input, output };
}

function parseModel(id: string, raw: unknown): ModelsDevModel | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const name = asString(entry.name) ?? id;
  const reasoning = entry.reasoning_options;
  const reasoningOptions = Array.isArray(reasoning)
    ? reasoning.flatMap((option) => {
      const parsed = parseReasoningOption(option);
      return parsed ? [parsed] : [];
    })
    : [];
  return { id, name, reasoningOptions, cost: parseCost(entry.cost) };
}

function parseProvider(id: string, raw: unknown): ModelsDevProvider | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const env = entry.env;
  const envNames = Array.isArray(env)
    ? env.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  const models = asRecord(entry.models) ?? {};
  const parsed = Object.entries(models).flatMap(([modelId, model]) => {
    const parsedModel = parseModel(modelId, model);
    return parsedModel ? [parsedModel] : [];
  });
  return {
    id,
    name: asString(entry.name) ?? id,
    env: envNames,
    models: parsed,
  };
}

/** Defensive parse of a models.dev `api.json` payload (any shape in, catalog out). */
export function parseModelsDevCatalog(raw: unknown): ModelsDevCatalog {
  const root = asRecord(raw);
  if (!root) return [];
  return Object.entries(root).flatMap(([id, provider]) => {
    const parsed = parseProvider(id, provider);
    return parsed ? [parsed] : [];
  });
}

/**
 * Effort values for one model: the `values` of its first
 * `{type: "effort"}` reasoning option (upstream `transform.ts` maps these
 * per-provider at call time; the catalog only enumerates them).
 * `toggle`/`budget_tokens` knobs are not select-style efforts — skipped.
 */
export function effortValuesOf(model: ModelsDevModel): ReadonlyArray<string> {
  const option = model.reasoningOptions.find((entry) => entry.type === "effort");
  return option?.values ?? [];
}

/** Env-var key names from `provider.env` that are set in `env`. */
export function presentApiKeyEnvs(provider: ModelsDevProvider, env: NodeJS.ProcessEnv): string[] {
  return provider.env.filter((name) => (env[name] ?? "").trim().length > 0);
}

let snapshotCatalogCache: ModelsDevCatalog | null = null;

async function snapshotCatalog(): Promise<ModelsDevCatalog | null> {
  if (!snapshotCatalogCache) {
    try {
      const snapshot = (await import("./models-snapshot.json")).default as unknown;
      snapshotCatalogCache = parseModelsDevCatalog(snapshot);
    } catch {
      return null;
    }
  }
  return snapshotCatalogCache;
}

/**
 * Required API-key env names for one models.dev provider id, from the
 * pinned snapshot. Null when the provider is unknown (custom servers,
 * newer catalog) — callers must let the server decide then, never block.
 */
export async function providerEnvNames(providerID: string): Promise<ReadonlyArray<string> | null> {
  const catalog = await snapshotCatalog();
  if (!catalog) return null;
  const found = catalog.find((provider) => sameProviderId(provider.id, providerID));
  return found ? [...found.env] : null;
}

/**
 * Free-tier bypass for the `opencode` provider: upstream
 * `packages/opencode/src/provider/provider.ts` (the `opencode` hook)
 * keeps zero-input-cost models listed with `apiKey: "public"` when no
 * credential exists, dropping the paid models instead. The send-time
 * preflight must mirror that rule, or it blocks exactly the models the
 * server would serve — e.g. `opencode/muse-spark-1.3-contributor-free`
 * with an empty env (verified live: `opencode run` answers with only
 * an unrelated `opencode-go` entry in `auth.json`). Only the `opencode`
 * provider has this fallback; every other provider still requires its
 * key or stored auth. Missing cost data never bypasses — the server
 * decides those.
 */
export async function isFreeOpencodeModel(providerID: string, modelID: string): Promise<boolean> {
  if (providerID.toLowerCase() !== "opencode") return false;
  const catalog = await snapshotCatalog();
  if (!catalog) return false;
  const provider = catalog.find((entry) => entry.id.toLowerCase() === "opencode");
  if (!provider) return false;
  const model = provider.models.find(
    (entry) => entry.id === modelID || entry.id.toLowerCase() === modelID.toLowerCase(),
  );
  return model?.cost?.input === 0;
}

export function resolveModelsDevUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_MODELS_URL?.trim();
  return override && override.length > 0 ? override : MODELS_DEV_DEFAULT_URL;
}

export function defaultModelsDevCachePath(): string {
  return path.join(appHomeDir(), "cache", "opencode-models.json");
}

/** Provider ids v2 renamed; both spellings resolve to the current id. */
const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
  "azure-cognitive-services": "azure",
  "google-vertex-anthropic": "google-vertex",
};

/** Current v2 provider id for a v1 or v2 spelling (lower-cased). */
export function canonicalProviderId(providerId: string): string {
  const id = providerId.toLowerCase();
  return PROVIDER_ID_ALIASES[id] ?? id;
}

/** Whether two provider ids name the same provider across the v1→v2 renames. */
export function sameProviderId(a: string, b: string): boolean {
  return canonicalProviderId(a) === canonicalProviderId(b);
}

/** Credential type stored for `providerId`, tolerating the renamed ids. */
export function storedAuthTypeFor(stored: Readonly<Record<string, string>>, providerId: string): string | undefined {
  for (const [key, type] of Object.entries(stored)) {
    if (sameProviderId(key, providerId)) return type;
  }
  return undefined;
}

export const AUTH_LIST_TIMEOUT_MS = 5_000;
/** Grace between SIGTERM and SIGKILL when a probe's child does not exit on its own. */
export const AUTH_LIST_KILL_GRACE_MS = 250;
export const AUTH_LIST_CACHE_TTL_MS = 15_000;
/**
 * How long a successful credential read may keep deciding that a provider is
 * connected when the probe stops answering. A day is long enough that a
 * weekend of a busy or broken `opencode auth list` does not turn a working
 * account into an unknown one, and short enough that a credential removed
 * without a readable reply stops reading as current. Past it — or as soon as
 * the latest probe fails — the state is `unverified`, never silently current.
 */
export const OPENCODE_AUTH_TRUST_MS = 24 * 60 * 60 * 1000;

/** A clock that never goes backwards, for ages that decide freshness. */
export const defaultMonotonic = (): number => globalThis.performance?.now?.() ?? Date.now();

/** Runs `opencode auth list --format json --standalone`; stdout on success, null on any failure. */
export type AuthListRunner = (binary: string, env: NodeJS.ProcessEnv) => Promise<string | null>;

export interface AuthListRunnerOptions {
  /** How long the CLI has to answer; default `AUTH_LIST_TIMEOUT_MS`. Tests inject a short one. */
  readonly timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL; default `AUTH_LIST_KILL_GRACE_MS`. */
  readonly killGraceMs?: number;
}

/**
 * `--standalone` reads the credential store directly. Without it the CLI
 * connects to the user's shared background service and starts one when none
 * is running, leaving a daemon behind. Async, so a slow CLI never blocks the
 * event loop of the server or the TUI.
 *
 * The deadline bounds the request itself, not just the wait: a CLI that
 * ignores SIGTERM, or never exits, is settled as a failure at the deadline and
 * then reaped (SIGTERM, then SIGKILL after a grace). Output that arrives after
 * that is ignored. The output cap still applies.
 *
 * Only a clean exit makes stdout an answer. A probe that prints a plausible
 * list and then exits non-zero or dies on a signal was interrupted, and its
 * output cannot be told apart from a full reply — `[]` especially, which is an
 * explicit logout for every provider. So any non-zero code or signal is a
 * failed probe (`null`), never a snapshot replacement.
 *
 * The escalation timer is referenced on purpose. A one-shot caller (`moxen
 * models`, the TUI's first catalog) exits as soon as this promise resolves; an
 * unreferenced grace timer dies with it, leaving a SIGTERM-ignoring probe
 * alive. It is released when it fires, or when the child is confirmed gone.
 */
export function defaultAuthListRunner(
  binary: string,
  env: NodeJS.ProcessEnv,
  options: AuthListRunnerOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? AUTH_LIST_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? AUTH_LIST_KILL_GRACE_MS;
  return new Promise((resolve) => {
    let settled = false;
    let reaped = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let child: ChildProcess | null = null;
    let output = "";
    let overflow = false;
    const reap = (): void => {
      const probe = child;
      if (probe === null || reaped) return;
      reaped = true;
      // Off the response path: the answer is already resolved, and the reaper
      // itself is asynchronous (taskkill child on Windows, a group signal on
      // POSIX).
      void killProcessTreeAsync(probe, "SIGTERM");
      grace = setTimeout(() => {
        // Escalate on the group even if the leader has exited: descendants
        // may still be alive, and the leader's own exit does not prove they
        // are gone. The answer already went out, so this referenced timer is
        // what keeps a one-shot caller alive long enough to SIGKILL them; it
        // is bounded by the grace and drops off by itself once it fires.
        grace = null;
        void killProcessTreeAsync(probe, "SIGKILL");
      }, killGraceMs);
    };
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      // Release the parent's pipe ends and the handle: a descendant that keeps
      // the pipe open must not hold the test or the app after the answer.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref?.();
      resolve(value);
    };
    try {
      // A Windows `.cmd` shim (npm installs one) cannot be started directly, only through the shell.
      const file = process.platform === "win32" && !/[\\/]/.test(binary) ? (resolveOnPath(binary, env) ?? binary) : binary;
      const shim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file);
      child = spawn(shim ? `"${file}"` : file, ["auth", "list", "--format", "json", "--standalone"], {
        env,
        windowsHide: true,
        shell: shim,
        // POSIX: its own process group, so the whole group can be reaped after
        // the leader exits. Windows uses `taskkill /T` instead.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.end();
      // Same 4 MB cap `execFile` gave this probe.
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (settled) return; // late output after settlement is ignored
        if (output.length + chunk.length > 4 * 1024 * 1024) {
          overflow = true;
          settle(null);
          reap();
          return;
        }
        output += chunk;
      });
      // Nothing reads stderr, but it must be drained so the child cannot block.
      child.stderr?.resume();
      child.once("error", () => settle(null));
      // `close` waits for every stdio stream; after a deadline settlement the
      // streams are destroyed, so a lingering descendant cannot hold it open.
      // It carries the exit status, which is what makes stdout trustworthy.
      child.once("close", (code, signal) => {
        settle(overflow || code !== 0 || signal !== null ? null : output.length > 0 ? output : null);
      });
      deadline = setTimeout(() => {
        settle(null);
        reap();
      }, timeoutMs);
    } catch {
      settle(null);
    }
  });
}

export interface ReadStoredAuthOptions {
  /** Executable to ask (the `opencode.binaryPath` setting); default `opencode`. */
  readonly binaryPath?: string | undefined;
  readonly run?: AuthListRunner | undefined;
  /** Wall clock, for the display timestamps only. */
  readonly now?: () => number;
  /** Monotonic clock, for the retry and trust windows; default `defaultMonotonic`. */
  readonly monotonic?: () => number;
  /** Skip the per-process cache (tests). */
  readonly fresh?: boolean;
}

/**
 * One valid reply, split by the group whose snapshot it may replace. `others`
 * always holds every non-Go provider (empty for a full logout); `go` is null
 * when the reply does not mention Go at all.
 */
interface AuthReply {
  readonly others: Record<string, string>;
  readonly go: Record<string, string> | null;
}

/** The newest valid reply for one provider group. */
export interface AuthSnapshot {
  /** Sequence of the attempt that produced it. */
  readonly seq: number;
  /** When that attempt started, wall-clock ms since epoch (display only). */
  readonly verifiedAt: number;
  /** When that attempt started, on the monotonic clock (age checks). */
  readonly verifiedAtMono: number;
  /** Credential type per provider id that reply listed. */
  readonly value: Record<string, string>;
}

/** The latest started probe for one cache key. */
export interface AuthAttempt {
  readonly seq: number;
  readonly outcome: "pending" | "valid" | "failed";
  /** When it settled, wall-clock ms since epoch; null while pending (display only). */
  readonly completedAt: number | null;
  /** When it settled, on the monotonic clock; null while pending (the retry window). */
  readonly completedAtMono: number | null;
}

/** What the stored-credential probe knows: the latest attempt and the newest valid snapshot per group. */
export interface StoredAuth {
  readonly attempt: AuthAttempt;
  /** The newest valid reply that covered Go (a login or an explicit logout); null when none ever has. */
  readonly go: AuthSnapshot | null;
  /** The newest valid reply for every other provider; null when none ever has. */
  readonly others: AuthSnapshot | null;
}

interface AuthState {
  attempt: AuthAttempt;
  go: AuthSnapshot | null;
  others: AuthSnapshot | null;
}

/** OpenCode's own plan, kept visible while its credentials are unknown so a failed probe does not hide it on first run. */
export const GO_PROVIDER = "opencode-go";
const authStates = new Map<string, AuthState>();

/** Drop cached auth state (after a login, and between tests). In-flight probes from before this publish nothing. */
export function clearStoredAuthCache(): void {
  authStates.clear();
}

function emptyAuthState(): AuthState {
  return { attempt: { seq: 0, outcome: "pending", completedAt: null, completedAtMono: null }, go: null, others: null };
}

/**
 * One provider's view of the stored-credential state. The snapshot only
 * counts as *answered* when the latest started attempt is valid and is the
 * one that produced it; a pending, failed or Go-less attempt leaves a
 * remembered login usable but unconfirmed.
 */
export function authForProvider(auth: StoredAuth, providerId: string): {
  readonly types: Record<string, string>;
  readonly verifiedAt: number | null;
  readonly verifiedAtMono: number | null;
  readonly answered: boolean;
} {
  const snapshot = canonicalProviderId(providerId) === GO_PROVIDER ? auth.go : auth.others;
  if (snapshot === null) return { types: {}, verifiedAt: null, verifiedAtMono: null, answered: false };
  return {
    types: { ...snapshot.value },
    verifiedAt: snapshot.verifiedAt,
    verifiedAtMono: snapshot.verifiedAtMono,
    answered: auth.attempt.outcome === "valid" && auth.attempt.seq === snapshot.seq,
  };
}

/**
 * Stored OpenCode credentials per provider id, from v2's own
 * `opencode auth list --format json --standalone` (v2 keeps credentials in SQLite, so
 * `auth.json` is a stub). Output is `[{id, name, connections: [{type, name?}]}]`
 * — type and env-var name only, never a secret. Connection types map onto
 * the v1 vocabulary consumers already read: `key`→`api`, `oauth`→`oauth`,
 * `env`→`env` (a key found in the environment); an unknown type passes
 * through. Several connections: `oauth` wins, then `api`, then the rest.
 *
 * Each cache key keeps the latest started attempt (its sequence, outcome and
 * when it settled) and two snapshots — Go and every other provider. A valid
 * reply replaces the snapshot(s) it covers only when its sequence is newer;
 * a failure replaces nothing. An attempt can only answer for a snapshot with
 * the same sequence, so a later failure, pending probe or Go-less reply
 * leaves a remembered login usable but `unverified`. Reads serve the same
 * projection as completions, and for 15s after the latest attempt settles
 * they do not probe at all, even after a failure.
 *
 * Validation is all-or-nothing: a malformed entry or connection, or a
 * duplicate provider id after canonicalization, rejects the whole reply and
 * keeps every snapshot. `[]` is an explicit logout for every provider, and a
 * Go row with no connections is one for Go. Listing degrades, never throws.
 */
export async function readStoredAuth(
  env: NodeJS.ProcessEnv = process.env,
  options: ReadStoredAuthOptions = {},
): Promise<StoredAuth> {
  const binary = options.binaryPath?.trim() || OPENCODE_DEFAULT_BINARY;
  const wallNow = options.now ?? Date.now;
  const monoNow = options.monotonic ?? defaultMonotonic;
  const startedAt = wallNow();
  const startedMono = monoNow();
  const cacheKey = `${binary}\0${env.PATH ?? env.Path ?? ""}`;
  const state = options.fresh ? emptyAuthState() : (authStates.get(cacheKey) ?? emptyAuthState());
  // A settled attempt is served as it stands for the short TTL, including a
  // failed one; cache hits never move a timestamp. The window is measured on
  // the monotonic clock: a wall clock that moves backwards must never extend
  // it, and a negative or non-finite age is expired, never fresh.
  const retryAge = state.attempt.completedAtMono === null ? Number.NaN : startedMono - state.attempt.completedAtMono;
  if (!options.fresh && Number.isFinite(retryAge) && retryAge >= 0 && retryAge < AUTH_LIST_CACHE_TTL_MS) {
    return projectAuth(state);
  }
  const seq = state.attempt.seq + 1;
  state.attempt = { seq, outcome: "pending", completedAt: null, completedAtMono: null };
  if (!options.fresh) authStates.set(cacheKey, state);
  const text = await (options.run ?? defaultAuthListRunner)(binary, env);
  if (!options.fresh && authStates.get(cacheKey) !== state) {
    // The cache was cleared (or replaced) while this probe ran: this
    // completion is obsolete. Answer from the state that took its place, or
    // unknown when there is none, and publish nothing.
    return projectAuth(authStates.get(cacheKey) ?? emptyAuthState());
  }
  applyAuthReply(state, seq, startedAt, startedMono, wallNow(), monoNow(), text);
  return projectAuth(state);
}

function projectAuth(state: AuthState): StoredAuth {
  return { attempt: state.attempt, go: state.go, others: state.others };
}

function applyAuthReply(
  state: AuthState,
  seq: number,
  startedAt: number,
  startedMono: number,
  completedAt: number,
  completedAtMono: number,
  text: string | null,
): void {
  const reply = text === null ? null : parseStoredAuthReply(text);
  // Only the latest started attempt owns the outcome; an older completion
  // never overrides a newer attempt.
  if (state.attempt.seq === seq) {
    state.attempt = { seq, outcome: reply === null ? "failed" : "valid", completedAt, completedAtMono };
  }
  if (reply === null) return;
  if (state.others === null || seq > state.others.seq) {
    state.others = { seq, verifiedAt: startedAt, verifiedAtMono: startedMono, value: reply.others };
  }
  if (reply.go !== null && (state.go === null || seq > state.go.seq)) {
    state.go = { seq, verifiedAt: startedAt, verifiedAtMono: startedMono, value: reply.go };
  }
}

/** The credential types alone, for callers that only need the map (`doctor`, the driver's hint). */
export async function readStoredAuthTypes(
  env: NodeJS.ProcessEnv = process.env,
  options: ReadStoredAuthOptions = {},
): Promise<Record<string, string>> {
  const auth = await readStoredAuth(env, options);
  return { ...(auth.others?.value ?? {}), ...(auth.go?.value ?? {}) };
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The credential map from a probe's stdout, split by snapshot group, or null
 * when the reply must not replace any snapshot: unparseable, not an array, a
 * malformed entry or connection record, or a duplicate provider id after
 * canonicalization. A valid `[]` is an explicit logout for every provider; a
 * valid nonempty reply covers every other provider and covers Go only when it
 * has a Go row (with no connections counting as Go's logout).
 */
function parseStoredAuthReply(text: string): AuthReply | null {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || !parsed.every(isAuthEntry)) return null;
  const rows = parsed as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  for (const row of rows) {
    const id = canonicalProviderId(String(row.id));
    // One row per provider: two rows, even agreeing ones, are not a reply we
    // can trust to replace a snapshot.
    if (seen.has(id)) return null;
    seen.add(id);
  }
  if (rows.length === 0) return { others: {}, go: {} };
  const all = authTypesOf(rows);
  const goRow = rows.find((row) => canonicalProviderId(String(row.id)) === GO_PROVIDER);
  if (goRow === undefined) return { others: all, go: null };
  const goType = all[String(goRow.id)];
  const others = { ...all };
  delete others[String(goRow.id)];
  return { others, go: goType === undefined ? {} : { [GO_PROVIDER]: goType } };
}

/** One `opencode auth list` entry: an id and its readable connection records. */
function isAuthEntry(entry: unknown): boolean {
  const record = asRecord(entry);
  if (!record || typeof record.id !== "string" || record.id.trim() === "") return false;
  if (!Array.isArray(record.connections)) return false;
  return record.connections.every((connection) => {
    const conn = asRecord(connection);
    if (!conn || typeof conn.type !== "string" || conn.type.trim() === "") return false;
    // A stored credential names its method (`key` / `oauth`); the mapper reads it.
    return conn.type !== "credential" || (typeof conn.method === "string" && conn.method.trim() !== "");
  });
}

const AUTH_TYPE_RANK: Readonly<Record<string, number>> = { oauth: 0, api: 1 };

function mapConnectionType(type: string): string {
  return type === "key" ? "api" : type;
}

/**
 * Credential types per provider from a list of `{id, connections: [{type}]}`
 * entries: the output of `opencode auth list --format json`, and equally the
 * `data` of `GET /api/integration`, where a stored credential is
 * `{type: "credential", method: "key" | "oauth"}` and an env key `{type: "env"}`.
 */
export function authTypesOf(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const record = asRecord(entry);
    const id = record ? asString(record.id) : null;
    const connections = record?.connections;
    if (!id || !Array.isArray(connections)) continue;
    const types = connections
      .flatMap((connection) => {
        const record = asRecord(connection);
        const kind = asString(record?.type);
        const type = kind === "credential" ? asString(record?.method) : kind;
        return type ? [mapConnectionType(type)] : [];
      })
      .sort((a, b) => (AUTH_TYPE_RANK[a] ?? 2) - (AUTH_TYPE_RANK[b] ?? 2));
    if (types[0] !== undefined) out[id] = types[0];
  }
  return out;
}

export interface LoadModelsDevCatalogOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cachePath?: string;
  /** Pinned snapshot text (defaults to the bundled `models-snapshot.json`). */
  readonly snapshotText?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function cacheIsFresh(cachePath: string, now: number, statFile: (path: string) => number | null): boolean {
  const mtime = statFile(cachePath);
  if (mtime === null) return false;
  return now - mtime < MODELS_DEV_CACHE_TTL_MS;
}

function statMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function writeCacheBestEffort(cachePath: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, cachePath);
  } catch {
    // Cache is best-effort; the live payload is still returned.
  }
}

/**
 * Load the models.dev catalog: fresh cache → live fetch (cached on
 * success) → pinned snapshot → empty. Returns where the payload came
 * from so callers can label staleness honestly.
 */
export async function loadModelsDevCatalog(options: LoadModelsDevCatalogOptions = {}): Promise<LoadedModelsDevCatalog> {
  const env = options.env ?? process.env;
  const cachePath = options.cachePath ?? defaultModelsDevCachePath();
  const now = options.now ?? Date.now;
  const snapshotText = options.snapshotText === undefined ? (await import("./models-snapshot.json")).default as unknown : options.snapshotText;

  if (cacheIsFresh(cachePath, now(), statMtimeMs)) {
    const text = defaultReadFile(cachePath);
    if (text !== null) {
      const catalog = parseModelsDevCatalog(parseJson(text));
      if (catalog.length > 0) return { catalog, source: "cache" };
    }
  }

  const live = await fetchLiveCatalog(env, options.fetchImpl ?? fetch);
  if (live !== null) {
    writeCacheBestEffort(cachePath, live.text);
    const catalog = parseModelsDevCatalog(parseJson(live.text));
    if (catalog.length > 0) return { catalog, source: "live" };
  }

  if (typeof snapshotText === "string" && snapshotText.length > 0) {
    const catalog = parseModelsDevCatalog(parseJson(snapshotText));
    if (catalog.length > 0) return { catalog, source: "snapshot" };
  }
  return { catalog: [], source: "empty" };
}

async function fetchLiveCatalog(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<{ text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${resolveModelsDevUrl(env)}${MODELS_DEV_API_PATH}`, {
      headers: { "User-Agent": "moxen/models-dev-snapshot" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return { text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// -- the models OpenCode's own provider serves today ---------------------------

/**
 * models.dev keeps a model long after OpenCode stops serving it, so its
 * zero-cost list overstates the free tier (retired `*-free` models stay
 * listed). OpenCode's inference endpoint lists what it serves now, free and
 * paid alike; the free tier is models.dev's zero-cost models that are on it.
 */
export const OPENCODE_SERVED_MODELS_URL = "https://opencode.ai/inference/v1/models";

/** Where the served list came from: fresh cache, a fetch now, an out-of-date cache, or nothing (offline, first run). */
export type ServedModelsSource = "cache" | "live" | "stale" | "none";

export interface LoadedServedModels {
  /** Model ids (no provider prefix); null when nothing could be read. */
  readonly ids: ReadonlySet<string> | null;
  readonly source: ServedModelsSource;
}

export function defaultServedModelsCachePath(): string {
  return path.join(appHomeDir(), "cache", "opencode-served-models.json");
}

/** The ids in an OpenAI-style `{data: [{id}]}` list; null when it is not one. */
export function parseServedModels(raw: unknown): ReadonlySet<string> | null {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) return null;
  const ids = data.flatMap((entry) => {
    const id = asString(asRecord(entry)?.id);
    return id ? [id] : [];
  });
  return ids.length > 0 ? new Set(ids) : null;
}

/** Fresh cache, else a fetch (cached on success), else the cache however old, else nothing; same freshness as models.dev. */
export async function loadServedModels(options: Omit<LoadModelsDevCatalogOptions, "snapshotText" | "env"> = {}): Promise<LoadedServedModels> {
  const cachePath = options.cachePath ?? defaultServedModelsCachePath();
  const now = options.now ?? Date.now;
  const cached = (): ReadonlySet<string> | null => {
    const text = defaultReadFile(cachePath);
    return text === null ? null : parseServedModels(parseJson(text));
  };
  if (cacheIsFresh(cachePath, now(), statMtimeMs)) {
    const ids = cached();
    if (ids !== null) return { ids, source: "cache" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(OPENCODE_SERVED_MODELS_URL, { headers: { "User-Agent": "moxen/opencode-models" }, signal: controller.signal });
    if (response.ok) {
      const text = await response.text();
      const ids = parseServedModels(parseJson(text));
      if (ids !== null) {
        writeCacheBestEffort(cachePath, text);
        return { ids, source: "live" };
      }
    }
  } catch {
    // Offline or refused: an older answer, if any, follows.
  } finally {
    clearTimeout(timer);
  }
  const ids = cached();
  return ids !== null ? { ids, source: "stale" } : { ids: null, source: "none" };
}

/** `OPENCODE_DISABLE_FREE_MODELS=1` (or `true`): OpenCode hides its free models, so Moxen offers none. */
export function freeModelsDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPENCODE_DISABLE_FREE_MODELS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** The free tier of OpenCode's own provider: zero-cost on models.dev and served today; models.dev alone when the served list is unknown. */
export function freeTierModels(models: ReadonlyArray<ModelsDevModel>, served: ReadonlySet<string> | null): ModelsDevModel[] {
  return models.filter((model) => isFreeModel(model) && (served === null || served.has(model.id)));
}

/**
 * Antigravity catalog discovery: probes the official `agy` binary via ACP v1
 * `initialize`, and when `agy` supports `session/close` reads the user's live
 * models and per-model effort levels via a short-lived probe session (cached
 * per binary + version so repeated catalog reads stay fast).
 */
import fs from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelSummary, ProviderSummary } from "../../catalog/summary.js";
import { CliError } from "../../errors.js";
import { binaryOnPath } from "../../infra/process.js";
import { accountInstanceId, antigravityAccountBlockedReason, type AntigravityAccountConfig, type AntigravityProviderConfig } from "../../types.js";
import { AcpDriver } from "../acp/driver.js";
import type { AcpTransport } from "../acp/transport.js";
import { ANTIGRAVITY_DEFAULT_MODEL_SLUG, antigravityAccountEnv, antigravityLaunchSpec } from "./config.js";

const MODELS_CACHE_TTL_MS = 15 * 60_000;

interface CachedAntigravityModels {
  readonly key: string;
  readonly fetchedAt: number;
  readonly models: ModelSummary[];
  readonly tier?: string | null;
}

const memoryCache = new Map<string, CachedAntigravityModels>();

export function forgetAntigravityCatalogCache(): void {
  memoryCache.clear();
}

function cacheKeyOf(command: string, args: readonly string[], version: string | null, scope = ""): string {
  return `${command}\0${args.join("\0")}\0${version ?? ""}\0${scope}`;
}

function diskCachePath(storeRoot: string, accountId?: string): string {
  const safe = accountId?.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const filename = safe ? `antigravity-models-${safe}.json` : "antigravity-models.json";
  return path.join(storeRoot, "cache", filename);
}

async function readDiskCache(storeRoot: string | undefined, accountId?: string): Promise<CachedAntigravityModels | null> {
  if (!storeRoot) return null;
  try {
    const raw = JSON.parse(await readFile(diskCachePath(storeRoot, accountId), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec["key"] !== "string" || typeof rec["fetchedAt"] !== "number" || !Array.isArray(rec["models"])) {
      return null;
    }
    return {
      key: rec["key"],
      fetchedAt: rec["fetchedAt"],
      models: rec["models"] as ModelSummary[],
      ...(typeof rec["tier"] === "string" && rec["tier"].trim().length > 0 ? { tier: rec["tier"].trim() } : {}),
    };
  } catch {
    return null;
  }
}

async function writeDiskCache(storeRoot: string | undefined, entry: CachedAntigravityModels, accountId?: string): Promise<void> {
  if (!storeRoot) return;
  try {
    const file = diskCachePath(storeRoot, accountId);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(entry, null, 2));
    await rename(tmp, file);
  } catch {
    // Non-fatal: in-memory cache still holds the entry.
  }
}

/**
 * Antigravity's internal orchestrator models run opaque sub-loops inside `agy`
 * outside Moxen's tracked threads/subagents, so Moxen omits them from the
 * offered catalog (existing threads with an explicit slug still pass through).
 */
export function isOmittedAntigravityModel(model: Pick<ModelSummary, "slug" | "name">): boolean {
  return model.slug.startsWith("gemini-pro-orchestrator-") || /^orchestrator\b/i.test(model.name.trim());
}

/**
 * Disambiguate non-Gemini models offered through Antigravity (e.g. Claude
 * Sonnet 5.5, Claude Opus 5.5) so they never collide visually with Claude Code
 * or other providers in footers, turn headers, pickers, or Desktop views.
 * Idempotent for cached entries.
 */
export function disambiguateAntigravityModelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /\b(gemini|antigravity)\b/i.test(trimmed)) return trimmed;
  if (trimmed.endsWith(")")) {
    return `${trimmed.slice(0, -1)}, Antigravity)`;
  }
  return `${trimmed} (Antigravity)`;
}

function filterAntigravityModels(models: readonly ModelSummary[]): ModelSummary[] {
  const kept = models
    .filter((model) => !isOmittedAntigravityModel(model))
    .map((model) => {
      const name = disambiguateAntigravityModelName(model.name);
      return name === model.name ? model : { ...model, name };
    });
  if (kept.length > 0 && !kept.some((model) => model.isDefault === true)) {
    return kept.map((model, index) => (index === 0 ? { ...model, isDefault: true } : model));
  }
  return kept;
}

function fallbackModels(): ModelSummary[] {
  return [
    {
      slug: ANTIGRAVITY_DEFAULT_MODEL_SLUG,
      name: "Antigravity (default)",
      isCustom: false,
      isHidden: false,
      isDefault: true,
      efforts: [],
    },
  ];
}

function isInstalled(command: string, env: NodeJS.ProcessEnv): boolean {
  if (path.isAbsolute(command)) {
    try {
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  return binaryOnPath(command, env);
}

export async function antigravityProvider(
  config: AntigravityProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  transport?: AcpTransport,
  options: {
    readonly storeRoot?: string;
    readonly now?: () => number;
    readonly account?: AntigravityAccountConfig;
  } = {},
): Promise<ProviderSummary> {
  const account = options.account;
  const accountId = account?.id.trim().toLowerCase();
  const instanceId = accountId ? accountInstanceId("antigravity", accountId) : "antigravity";
  const displayName = account
    ? `Antigravity (${account.label?.trim() || account.id})`
    : "Antigravity";
  // Eligibility is decided before anything else touches the account: while
  // a gated account is disabled, no executable or path in its home is
  // checked (not even whether `agy` is installed there), and the reason is
  // reported independently of installation status rather than overrun by
  // "not installed".
  const blockedReason = antigravityAccountBlockedReason(config, instanceId);
  if (blockedReason !== null) {
    return {
      instanceId,
      driver: "antigravity",
      displayName,
      installed: false,
      enabled: false,
      status: blockedReason,
      authStatus: null,
      models: [],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
      disabledReason: blockedReason,
    };
  }
  const mergedConfig: AntigravityProviderConfig | undefined = account
    ? {
        ...(config ?? {}),
        ...(account.binaryPath !== undefined ? { binaryPath: account.binaryPath } : {}),
        ...(account.launchArgs !== undefined ? { launchArgs: account.launchArgs } : {}),
      }
    : config;
  const accountEnv = account
    ? antigravityAccountEnv(account.homePath, env, account.env)
    : env;
  const spec = antigravityLaunchSpec(mergedConfig, account
    ? {
        id: instanceId,
        name: displayName,
        homePath: account.homePath,
        env: account.env,
        baseEnv: env,
      }
    : undefined);
  const installed = transport ? true : isInstalled(spec.command, accountEnv);
  const disabled = account?.enabled === false;
  const base: ProviderSummary = {
    instanceId,
    driver: "antigravity",
    displayName,
    installed,
    enabled: false,
    status: !installed
      ? "not installed"
      : disabled
        ? "disabled"
        : null,
    authStatus: null,
    models: [],
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };
  // A gated account is disabled with the reason and never launched or
  // probed: the driver (and so `agy`) is not constructed.
  if (!installed || disabled) return base;

  const now = (options.now ?? Date.now)();
  const useCache = transport === undefined || options.storeRoot !== undefined;
  const cacheScope = account ? `${instanceId}\0${account.homePath ?? ""}` : "";
  const diskCache = useCache ? await readDiskCache(options.storeRoot, accountId) : null;
  let cachedHit: CachedAntigravityModels | null = null;

  const driver = new AcpDriver({
    provider: "antigravity",
    ...(accountId ? { instanceId } : {}),
    agents: { [instanceId]: spec },
    env: accountEnv,
    ...(transport ? { transport } : {}),
    initializeTimeoutMs: 5_000,
  });
  try {
    const { init, models: discovered, authError, tier } = await driver.probeAgentCatalog(instanceId, cwd, {
      shouldDiscover: (initializeResult) => {
        if (!useCache) return true;
        const key = cacheKeyOf(spec.command, spec.args, initializeResult.agentInfo.version, cacheScope);
        const mem = memoryCache.get(key);
        const hit = mem && now - mem.fetchedAt < MODELS_CACHE_TTL_MS
          ? mem
          : diskCache && diskCache.key === key && now - diskCache.fetchedAt < MODELS_CACHE_TTL_MS
            ? diskCache
            : null;
        if (hit && hit.models.length > 0) {
          cachedHit = hit;
          memoryCache.set(key, hit);
          return false;
        }
        return true;
      },
    });
    if (authError) {
      return {
        ...base,
        authStatus: "unauthenticated",
        status: "Run `agy` to sign in to Antigravity.",
      };
    }
    const resolvedTier = tier ?? (cachedHit as CachedAntigravityModels | null)?.tier ?? null;
    const authStatus = resolvedTier ?? (init.authMethods.length > 0 ? init.authMethods[0]!.id : "ready");
    let models: ModelSummary[];
    if (cachedHit) {
      models = filterAntigravityModels((cachedHit as CachedAntigravityModels).models);
    } else if (discovered.length > 0) {
      models = filterAntigravityModels(discovered);
      if (useCache && models.length > 0) {
        const key = cacheKeyOf(spec.command, spec.args, init.agentInfo.version, cacheScope);
        const entry: CachedAntigravityModels = { key, fetchedAt: now, models, ...(tier ? { tier } : {}) };
        memoryCache.set(key, entry);
        await writeDiskCache(options.storeRoot, entry, accountId);
      }
    } else {
      const staleKey = cacheKeyOf(spec.command, spec.args, init.agentInfo.version, cacheScope);
      const stale = useCache
        ? (memoryCache.get(staleKey) ?? (diskCache && diskCache.key === staleKey ? diskCache : null))
        : null;
      models = stale ? filterAntigravityModels(stale.models) : [];
    }
    if (models.length === 0) models = fallbackModels();
    return {
      ...base,
      enabled: true,
      status: null,
      authStatus,
      models,
    };
  } catch (cause) {
    if (cause instanceof CliError && cause.code === "ACP_PROTOCOL_VERSION_UNSUPPORTED") {
      return { ...base, status: cause.message };
    }
    return {
      ...base,
      status: "Could not query Antigravity; check `agy` login and the configured executable.",
    };
  }
}

/** Build one `ProviderSummary` per configured Antigravity profile (zero providers by default when none are configured). */
export async function antigravityProviders(
  config: AntigravityProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  transport?: AcpTransport,
  options: { readonly storeRoot?: string; readonly now?: () => number } = {},
): Promise<ProviderSummary[]> {
  const accounts = config?.accounts;
  if (!accounts || accounts.length === 0) {
    return [];
  }
  return Promise.all(
    accounts.map((account) => antigravityProvider(config, env, cwd, transport, { ...options, account })),
  );
}

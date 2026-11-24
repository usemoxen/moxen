/**
 * Mistral Vibe catalog discovery: probes the installed `vibe-app-server`
 * passively (`initialize` → `setup/status` + `config/read`) without creating a
 * persistent session or reading credentials, caching models per binary+version.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelSummary, ProviderSummary } from "../../catalog/summary.js";
import type { VibeProviderConfig } from "../../types.js";
import {
  normalizeVibeSettings,
  resolveVibeBinary,
  VIBE_DEFAULT_MODEL_SLUG,
} from "./config.js";
import { VibeDriver } from "./driver.js";
import {
  parseVibeConfigModels,
  parseVibeSetupStatus,
  VIBE_METHODS,
  vibeModelsToSummaries,
} from "./protocol.js";
import type { VibeTransport } from "./transport.js";

const MODELS_CACHE_TTL_MS = 15 * 60_000;

interface CachedVibeModels {
  readonly key: string;
  readonly fetchedAt: number;
  readonly models: ModelSummary[];
  readonly authStatus: string | null;
}

const memoryCache = new Map<string, CachedVibeModels>();

export function forgetVibeCatalogCache(): void {
  memoryCache.clear();
}

function cacheKeyOf(command: string, launchArgs: string, vibeHome: string, version: string | null): string {
  return `${command}\0${launchArgs}\0${vibeHome}\0${version ?? ""}`;
}

function diskCachePath(storeRoot: string): string {
  return path.join(storeRoot, "cache", "vibe-models.json");
}

async function readDiskCache(storeRoot: string | undefined): Promise<CachedVibeModels | null> {
  if (!storeRoot) return null;
  try {
    const raw = JSON.parse(await readFile(diskCachePath(storeRoot), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec["key"] !== "string" || typeof rec["fetchedAt"] !== "number" || !Array.isArray(rec["models"])) {
      return null;
    }
    return {
      key: rec["key"],
      fetchedAt: rec["fetchedAt"],
      models: rec["models"] as ModelSummary[],
      authStatus: typeof rec["authStatus"] === "string" ? rec["authStatus"] : null,
    };
  } catch {
    return null;
  }
}

async function writeDiskCache(storeRoot: string | undefined, entry: CachedVibeModels): Promise<void> {
  if (!storeRoot) return;
  try {
    const file = diskCachePath(storeRoot);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(entry, null, 2));
    await rename(tmp, file);
  } catch {
    // Non-fatal: in-memory cache still holds the entry.
  }
}

function fallbackModels(): ModelSummary[] {
  return [
    {
      slug: VIBE_DEFAULT_MODEL_SLUG,
      name: "Mistral Vibe (default)",
      isCustom: false,
      isHidden: false,
      isDefault: true,
      efforts: [],
    },
  ];
}

export async function vibeProvider(
  config: VibeProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  transport?: VibeTransport,
  options: {
    readonly storeRoot?: string;
    readonly now?: () => number;
  } = {},
): Promise<ProviderSummary> {
  const settings = normalizeVibeSettings(config);
  const resolved = resolveVibeBinary(settings.binaryPath, env);
  const installed = transport ? true : resolved.installed;
  const base: ProviderSummary = {
    instanceId: "vibe",
    driver: "vibe",
    displayName: "Mistral Vibe",
    installed,
    enabled: false,
    status: installed ? null : "not installed",
    authStatus: null,
    models: [],
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };
  if (!installed) return base;

  const now = options.now ?? Date.now;
  const driver = new VibeDriver({
    env,
    ...(transport ? { transport } : {}),
    ...(config ? { settings: config } : {}),
  });

  try {
    return await driver.withPeer(cwd, async (peer, serverVersion) => {
      const setupRaw = await peer.request(VIBE_METHODS.setupStatus, {}, 10_000);
      const setup = parseVibeSetupStatus(setupRaw);
      if (!setup.hasApiKey && !setup.activeCredentialSource) {
        return {
          ...base,
          status: "Run `vibe` to sign in",
          authStatus: "unauthenticated",
        };
      }

      const authStatus = setup.activeCredentialSource ?? "authenticated";
      const key = cacheKeyOf(resolved.command, settings.launchArgs, settings.vibeHome, serverVersion);
      const cached = memoryCache.get(key) ?? (await readDiskCache(options.storeRoot));
      if (
        cached &&
        cached.key === key &&
        now() - cached.fetchedAt < MODELS_CACHE_TTL_MS &&
        cached.models.length > 0
      ) {
        memoryCache.set(key, cached);
        return {
          ...base,
          enabled: true,
          authStatus,
          models: cached.models,
        };
      }

      const configRaw = await peer.request(VIBE_METHODS.configRead, {}, 10_000);
      const parsed = parseVibeConfigModels(configRaw);
      const models = vibeModelsToSummaries(parsed.models, parsed.activeAlias);
      const effectiveModels = models.length > 0 ? models : fallbackModels();

      const entry: CachedVibeModels = {
        key,
        fetchedAt: now(),
        models: effectiveModels,
        authStatus,
      };
      memoryCache.set(key, entry);
      await writeDiskCache(options.storeRoot, entry);

      return {
        ...base,
        enabled: true,
        authStatus,
        models: effectiveModels,
      };
    });
  } catch {
    // Provider errors can contain credentials. Never leak raw diagnostics.
    return {
      ...base,
      status: "Could not query Mistral Vibe; check `vibe` login and the configured executable.",
    };
  }
}

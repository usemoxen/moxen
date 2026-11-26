/**
 * Direct catalog: `providers/models/efforts list` straight from the drivers.
 *
 * Same `ProviderSummary[]` envelopes as the WS path (`catalog.ts`
 * extraction is wire-payload-specific, so this module builds the summaries
 * directly), values from our own sources (docs/providers.md):
 * - claude: binary presence + the model list (live or bundled).
 * - opencode: one entry per models.dev provider
 *   (`instanceId: "opencode/<providerId>"`, slugs already
 *   `providerID/modelID`, so send-time routing needs no translation),
 *   API-key presence from env, OAuth status from the stored auth file.
 *
 * Honest gaps (cutover/hardening items, not silent): usage windows are
 * session-live in every native driver so `usageLimits` is null here;
 * skills need a live server/session scan. Claude's models come from the
 * installed CLI's `supportedModels()` (cached; bundled list as fallback).
 */
import fs from "node:fs";
import path from "node:path";

import { acpProviders } from "../providers/acp/catalog.js";
import { loadAcpRegistryCatalog, type LoadedAcpRegistry } from "../providers/acp/registry.js";
import { accountDisplayName, probeClaudeAccountAuth } from "../providers/accounts.js";
import {
  discoverChatGptModels,
  hydrateChatGptModelsCache,
  recordDiscoveredChatGptModels,
  toChatGptModelSummary,
  type ChatGptModelInfo,
} from "../providers/chatgpt/catalog.js";
import { ensureFreshChatGptToken } from "../providers/chatgpt/oauth.js";
import { antigravityProviders } from "../providers/antigravity/catalog.js";
import { vibeProvider } from "../providers/vibe/catalog.js";
import { claudeCatalogModels, setLiveClaudeModels } from "../providers/claude/catalog.js";
import { resolveLiveModels } from "../providers/claude/livemodels.js";
import { binaryOnPath } from "../infra/process.js";
import { resolveStoreRoot } from "../threads/store.js";
import { isModelHidden, loadModelPrefs } from "./prefs.js";
import { OPENCODE_DEFAULT_BINARY } from "../providers/opencode/config.js";
import {
  OPENCODE_AUTH_TRUST_MS,
  authForProvider,
  defaultMonotonic,
  effortValuesOf,
  freeModelsDisabled,
  freeTierModels,
  loadModelsDevCatalog,
  loadServedModels,
  presentApiKeyEnvs,
  readStoredAuth,
  storedAuthTypeFor,
  type LoadedModelsDevCatalog,
  type LoadedServedModels,
  type ModelsDevModel,
  type ModelsDevProvider,
  type ReadStoredAuthOptions,
  type StoredAuth,
} from "../providers/opencode/catalog.js";
import { usageLimitsSnapshot } from "../usage/limits.js";
import {
  accountInstanceId,
  type AcpProviderConfig,
  type AntigravityProviderConfig,
  type ChatGptProviderConfig,
  type ClaudeProviderConfig,
  type CodexProviderConfig,
  type HarnessProviderConfig,
  type OpencodeProviderConfig,
  type VibeProviderConfig,
} from "../types.js";
import type { EffortDescriptor, ModelSummary, ProviderSummary, ProviderUsageLimits } from "./summary.js";

export interface DirectCatalogOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly claude?: ClaudeProviderConfig | undefined;
  readonly chatgpt?: ChatGptProviderConfig | undefined;
  readonly fetchChatGptModels?: ((accountId: string) => Promise<readonly ChatGptModelInfo[]>) | undefined;
  readonly codex?: CodexProviderConfig | undefined;
  readonly fetchCodexProvider?: () => Promise<ProviderSummary>;
  readonly antigravity?: AntigravityProviderConfig;
  readonly fetchAntigravityProvider?: () => Promise<ProviderSummary>;
  readonly fetchAntigravityProviders?: () => Promise<ProviderSummary[]>;
  readonly vibe?: VibeProviderConfig | undefined;
  readonly fetchVibeProvider?: () => Promise<ProviderSummary>;
  readonly acp?: AcpProviderConfig;
  readonly fetchAcpProviders?: () => Promise<ProviderSummary[]>;
  readonly acpRegistry?: () => Promise<LoadedAcpRegistry>;
  readonly workingDirectory?: string;
  readonly storeRoot?: string;
  readonly modelsDev?: () => Promise<LoadedModelsDevCatalog>;
  /** OpenCode config (`providers.opencode`); OpenCode is opt-in and only listed when `enabled === true`. */
  readonly opencode?: OpencodeProviderConfig | undefined;
  /** The models OpenCode's own provider serves today (`loadServedModels`); read only when its free tier is offered. */
  readonly opencodeServed?: () => Promise<LoadedServedModels>;
  /**
   * The `opencode` executable the driver starts servers with
   * (`providers.opencode.binaryPath`). Installation detection and the
   * credential probe use the same executable, so a configured one outside
   * PATH is not reported absent.
   */
  readonly opencodeBinaryPath?: string;
  /** How the stored OpenCode credentials are read; tests inject a runner and clock. */
  readonly storedAuth?: Omit<ReadStoredAuthOptions, "binaryPath">;
  /** The latest usage reading per account (`usageLimitsSnapshot`), which is evidence a provider is configured. */
  readonly usageLimits?: () => Readonly<Record<string, ProviderUsageLimits>>;
  /**
   * Asks the installed Claude Code for its models (`supportedModels()`).
   * Without it only a cached answer is read, so a catalog build never
   * spawns a CLI on its own.
   */
  readonly fetchClaudeModels?: () => Promise<unknown[] | null>;
  /** `providers.harness` from the config file: one entry per saved profile. */
  readonly harness?: HarnessProviderConfig | undefined;
}


function baseModel(slug: string, name: string): ModelSummary {
  return { slug, name, isCustom: false, isDefault: null, isHidden: false, efforts: [] };
}

function opencodeEfforts(model: ModelsDevModel): EffortDescriptor[] {
  const values = effortValuesOf(model);
  if (values.length === 0) return [];
  return [{
    id: "effort",
    label: "Effort",
    choices: values.map((id) => ({ id, label: id, isDefault: null })),
    currentValue: null,
  }];
}

/** The picker's effort choices for a profile model; the driver reads the pick from the `effort` option. */
function harnessEfforts(values: readonly string[] | undefined): EffortDescriptor[] {
  if (values === undefined || values.length === 0) return [];
  return [{ id: "effort", label: "Effort", choices: values.map((id) => ({ id, label: id, isDefault: null })), currentValue: null }];
}

/** What the free-tier status adds about OpenCode's served list when it is not current. */
const SERVED_NOTE: Readonly<Record<LoadedServedModels["source"], string>> = {
  cache: "",
  live: "",
  stale: "; OpenCode's list of served models is out of date",
  none: "; OpenCode's list of served models could not be read, so some may be retired",
};

/** Whether a provider executable is there: an absolute path as given, else a PATH lookup. */
function binaryPresent(binary: string, env: NodeJS.ProcessEnv): boolean {
  const file = binary.trim();
  if (file.length === 0) return false;
  if (!path.isAbsolute(file)) return binaryOnPath(file, env);
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** How long ago a reading was taken, in the shortest unit that stays honest. */
function elapsed(sinceMs: number): string {
  const minutes = Math.max(1, Math.floor(sinceMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Per-provider `opencode/<id>` entries: categorized, browsable sections.
 * Credentialed providers list everything. Without a credential only
 * OpenCode's own `opencode` provider serves anything — its free tier:
 * zero-cost on models.dev and still served (`freeTierModels`), none at all
 * under `OPENCODE_DISABLE_FREE_MODELS`; every other provider refuses every
 * request, so it is listed disabled with no models rather than offering a
 * long tail of models the user cannot run. With the free tier on but no free
 * model served, OpenCode's own row still stays listed (zero models): the
 * credential state is unknown, which is not the same as unusable.
 *
 * A probe that never answers is *unknown*, not "not connected": a provider a
 * stored usage reading proves runs here keeps its models and stays
 * delegable, and says the credentials are unknown. A credential read once
 * but not confirmed since (the latest probe failed, or the last success is
 * older than `OPENCODE_AUTH_TRUST_MS`) stays usable and is reported
 * `unverified` rather than passing an old answer off as current.
 */
async function opencodeProviders(
  loaded: LoadedModelsDevCatalog,
  env: NodeJS.ProcessEnv,
  installed: boolean,
  isHidden: (instanceId: string, slug: string) => boolean,
  binaryPath?: string,
  loadServed: () => Promise<LoadedServedModels> = loadServedModels,
  usage: Readonly<Record<string, ProviderUsageLimits>> = {},
  storedAuth: Omit<ReadStoredAuthOptions, "binaryPath"> = {},
): Promise<ProviderSummary[]> {
  const auth: StoredAuth = installed
    ? await readStoredAuth(env, { ...storedAuth, binaryPath })
    : { attempt: { seq: 0, outcome: "valid", completedAt: null, completedAtMono: null }, go: null, others: null };
  const now = (storedAuth.now ?? Date.now)();
  const monoNow = (storedAuth.monotonic ?? defaultMonotonic)();
  const freeOff = freeModelsDisabled(env);
  const storedOthers = auth.others?.value ?? {};
  const needsServed = installed && !freeOff && loaded.catalog.some((provider) => provider.id.toLowerCase() === "opencode" && storedAuthTypeFor(storedOthers, provider.id) === undefined && presentApiKeyEnvs(provider, env).length === 0);
  const served: LoadedServedModels = needsServed ? await loadServed().catch((): LoadedServedModels => ({ ids: null, source: "none" })) : { ids: null, source: "none" };
  return loaded.catalog.map((provider: ModelsDevProvider) => {
    const instanceId = `opencode/${provider.id}`;
    const keyEnvs = presentApiKeyEnvs(provider, env);
    // Go and every other provider have their own snapshot: a reply that did
    // not mention Go cannot reconfirm it, and an older Go login stays usable
    // when a later attempt fails.
    const providerAuth = authForProvider(auth, provider.id);
    const storedType = storedAuthTypeFor(providerAuth.types, provider.id);
    // No snapshot for this group at all: unknown, not none. A snapshot with an
    // empty map is a confirmed logout instead.
    const unknown = installed && providerAuth.verifiedAt === null;
    // A login read once is not re-confirmed now: past the trust bound, or as
    // soon as the latest attempt fails or does not cover this group, it is
    // reported unverified while staying usable. The age is monotonic: a wall
    // clock that moves backwards must not make an old login look confirmed.
    const trustAge = providerAuth.verifiedAtMono === null ? Number.NaN : monoNow - providerAuth.verifiedAtMono;
    const stale = providerAuth.verifiedAt !== null && (!providerAuth.answered || !Number.isFinite(trustAge) || trustAge < 0 || trustAge > OPENCODE_AUTH_TRUST_MS);
    const credential = storedType === "oauth"
      ? "oauth"
      : storedType === "api" || storedType === "env"
        ? "api-key"
        : typeof storedType === "string"
          ? storedType
          : keyEnvs.length > 0
            ? "api-key"
            : null;
    const ownProvider = credential === null && provider.id.toLowerCase() === "opencode";
    const freeTier = ownProvider && !freeOff;
    // A stored usage reading is evidence a session ran on this instance: with
    // the credential probe unknown, it is what keeps the provider listed.
    const evidence = usage[instanceId]?.windows.length ? "a usage reading exists for it" : null;
    const unknownButUsed = unknown && credential === null && !freeTier && evidence !== null;
    const connected = credential !== null || freeTier || unknownButUsed;
    const models = credential !== null || unknownButUsed
      ? provider.models
      : freeTier
        ? freeTierModels(provider.models, served.ids)
        : [];
    const keyHint = provider.env.length > 0 ? provider.env[0] : null;
    // An env key is live proof; a stored login is only as good as its last successful read.
    const unverified = credential !== null && storedType !== undefined && keyEnvs.length === 0 && stale;
    const authStatus = credential === null ? (unknown ? "unknown" : null) : unverified ? "unverified" : credential;
    return {
      instanceId,
      driver: "opencode",
      displayName: provider.name,
      enabled: installed && connected,
      installed,
      status: !installed
        ? "not installed"
        : freeTier
          ? `free models only (connect it for all ${provider.models.length})${SERVED_NOTE[served.source]}`
          : credential === null && unknownButUsed
            ? `credentials unknown (${evidence}; delegating may still work)`
            : credential === null && unknown
              ? "credentials unknown (run opencode auth login if a model refuses)"
              : !connected
                ? ownProvider
                  ? "free models off (OPENCODE_DISABLE_FREE_MODELS); connect it to use it"
                  : keyHint !== null
                    ? `not connected (set ${keyHint} or run opencode auth login)`
                    : "not connected (run opencode auth login)"
                : unverified
                  ? `credentials unverified (last confirmed ${elapsed(now - (providerAuth.verifiedAt ?? now))})`
                  : loaded.source === "live"
                    ? null
                    : `models.dev ${loaded.source}`,
      authStatus,
      models: models.map((model) => ({
        ...baseModel(slugOf(provider, model), model.name),
        isHidden: isHidden(instanceId, slugOf(provider, model)),
        efforts: opencodeEfforts(model),
      })),
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    };
  });
}

/** Instance addressing: source ids keep their slash, bare ids gain the provider. */
function slugOf(provider: ModelsDevProvider, model: ModelsDevModel): string {
  return model.id.includes("/") ? model.id : `${provider.id}/${model.id}`;
}

/**
 * The single `opencode` instance: every models.dev model with
 * legacy addressing, ALL marked hidden. Invisible in the creating-picker (its
 * section drops for having zero offerable models) but resolvable for
 * migrated threads, favorites, effort lookups, and `selectProvider` —
 * the raw find paths ignore `isHidden`, only the pickers filter on it.
 */
function opencodeCompatInstance(
  loaded: LoadedModelsDevCatalog,
  installed: boolean,
): ProviderSummary {
  return {
    instanceId: "opencode",
    driver: "opencode",
    displayName: "OpenCode",
    // Compat shell, not a pickable provider: disabled so it never offers
    // rows, while selectProvider and the raw model lookups (migrated
    // threads, favorites, effort labels) keep resolving through it.
    enabled: false,
    installed,
    status: !installed ? "not installed" : loaded.source === "live" ? null : `models.dev ${loaded.source}`,
    authStatus: null,
    models: loaded.catalog.flatMap((provider: ModelsDevProvider) =>
      provider.models.map((model) => ({
        ...baseModel(slugOf(provider, model), model.name),
        isHidden: true,
        efforts: opencodeEfforts(model),
      })),
    ),
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };
}

/**
 * One `harness/<profile>` entry per saved profile. A profile is usable as soon as
 * it exists; the key's environment variable, when it names one, only decides
 * the status line, because an endpoint may take no key at all.
 */
function harnessProviders(
  config: HarnessProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
  isHidden: (instanceId: string, slug: string) => boolean,
): ProviderSummary[] {
  return (config?.profiles ?? []).map((profile) => {
    const instanceId = `harness/${profile.id}`;
    const keyName = profile.apiKeyEnv;
    const keySet = keyName !== undefined && (env[keyName] ?? "").trim() !== "";
    return {
      instanceId,
      driver: "harness",
      displayName: profile.label ?? profile.id,
      enabled: true,
      installed: true,
      status: keyName !== undefined && !keySet ? `${keyName} is not set` : null,
      authStatus: keySet ? "api-key" : null,
      models: profile.models.map((model) => ({ ...baseModel(model.id, model.id), isHidden: isHidden(instanceId, model.id), efforts: harnessEfforts(model.efforts) })),
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    };
  });
}

/**
 * Build the direct-backend provider summaries. Always probes live sources;
 * every failure degrades into its entry's `status`, never a throw — a
 * broken OpenCode login must not hide the working Claude install.
 */
export async function buildDirectProviders(options: DirectCatalogOptions = {}): Promise<ProviderSummary[]> {
  const env = options.env ?? process.env;
  // The same executable the driver starts servers with: a configured path
  // outside PATH counts, and is what the credential probe asks.
  const opencodeBinary = options.opencode?.binaryPath?.trim() || options.opencodeBinaryPath?.trim() || OPENCODE_DEFAULT_BINARY;
  const opencodeInstalled = binaryPresent(opencodeBinary, env);
  const storeRoot = options.storeRoot ?? resolveStoreRoot();

  const [claudeInstalled, modelsDev, prefs] = await Promise.all([
    Promise.resolve(binaryOnPath("claude", env)),
    (options.modelsDev ?? loadModelsDevCatalog)().catch((): LoadedModelsDevCatalog => ({ catalog: [], source: "empty" })),
    // Our own model prefs; hidden models feed the pickers through
    // `isHidden` below.
    loadModelPrefs(storeRoot),
  ]);

  // The installed Claude Code's own list when known (cached, or fetched when
  // `fetchClaudeModels` is given); the bundled file otherwise. When multi-account
  // Claude accounts are configured, each appears under `claude/<id>`; otherwise
  // the historical `claudeAgent` summary stays active.
  setLiveClaudeModels(
    claudeInstalled ? await resolveLiveModels({ storeRoot, fetch: options.fetchClaudeModels }) : null,
  );
  const claudeModelsFor = (instanceId: string): ModelSummary[] =>
    claudeCatalogModels().map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      isDefault: model.isDefault,
      isHidden: isModelHidden(prefs, instanceId, model.slug),
      efforts: model.efforts.map((effort) => ({
        id: effort.id,
        label: effort.label,
        choices: effort.choices.map((choice) => ({ id: choice.id, label: choice.label, isDefault: choice.isDefault })),
        currentValue: effort.currentValue,
      })),
    }));
  const configuredClaudeAccounts = options.claude?.accounts ?? [];
  const claudeList: ProviderSummary[] = configuredClaudeAccounts.map((account) => {
    const instanceId = accountInstanceId("claude", account.id);
    const binary = account.binaryPath?.trim() || "claude";
    const accountInstalled = path.isAbsolute(binary)
      ? (() => { try { return fs.statSync(binary).isFile(); } catch { return false; } })()
      : binary === "claude"
        ? claudeInstalled
        : binaryOnPath(binary, env);
    const disabled = account.enabled === false;
    const auth = accountInstalled && !disabled ? probeClaudeAccountAuth(account, env) : null;
    return {
      instanceId,
      driver: "claude",
      displayName: accountDisplayName("claude", account),
      enabled: accountInstalled && !disabled,
      installed: accountInstalled,
      status: !accountInstalled ? "not installed" : disabled ? "disabled" : null,
      authStatus: auth?.signedIn ? (auth.email ? "oauth" : "authenticated") : null,
      models: accountInstalled && !disabled ? claudeModelsFor(instanceId) : [],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    };
  });

  hydrateChatGptModelsCache(storeRoot);
  const chatgptList: ProviderSummary[] = await Promise.all(
    (options.chatgpt?.accounts ?? []).map(async (account): Promise<ProviderSummary> => {
      const instanceId = accountInstanceId("chatgpt", account.id);
      const disabled = account.enabled === false;
      const signedIn = Boolean(account.authRef);
      let discovered: readonly ChatGptModelInfo[] = [];
      let status: string | null = disabled
        ? "disabled"
        : !signedIn
          ? "Sign in with ChatGPT to use this account."
          : null;
      if (!disabled && signedIn) {
        try {
          discovered = await (
            options.fetchChatGptModels
              ? options.fetchChatGptModels(account.id)
              : (async () => {
                  const { accessToken } = await ensureFreshChatGptToken(account.id);
                  return await discoverChatGptModels(accessToken);
                })()
          );
          recordDiscoveredChatGptModels(account.id, discovered, storeRoot);
        } catch (cause) {
          status = cause instanceof Error ? cause.message : String(cause);
        }
      }
      const preferred = account.model?.trim() || options.chatgpt?.model?.trim();
      const models: ModelSummary[] = discovered.map((info, idx) => {
        const isDefault = preferred ? info.id === preferred : idx === 0;
        return {
          ...toChatGptModelSummary(info, isDefault),
          isHidden: isModelHidden(prefs, instanceId, info.id),
        };
      });
      return {
        instanceId,
        driver: "chatgpt",
        displayName: accountDisplayName("chatgpt", account),
        enabled: !disabled && signedIn,
        installed: true,
        status,
        authStatus: signedIn ? (account.planType ?? "chatgpt") : "unauthenticated",
        models,
        supportedRuntimeModes: null,
        usageLimits: null,
        skills: [],
      };
    }),
  );

  // OpenCode is opt-in (`providers.opencode.enabled`). Once it is on, each of
  // its providers is listed from the credential state — a probe that does not
  // answer is unknown, not "logged out" — so a failed read cannot drop them.
  const opencodeEnabled = options.opencode?.enabled === true;
  const opencode = opencodeEnabled
    ? await opencodeProviders(
        modelsDev,
        env,
        opencodeInstalled,
        (instanceId, slug) => isModelHidden(prefs, instanceId, slug),
        opencodeBinary,
        options.opencodeServed,
        (options.usageLimits ?? usageLimitsSnapshot)(),
        options.storedAuth ?? {},
      )
    : [];
  const compat = opencodeEnabled ? [opencodeCompatInstance(modelsDev, opencodeInstalled)] : [];

  const harness = harnessProviders(options.harness, env, (instanceId, slug) => isModelHidden(prefs, instanceId, slug));

  const antigravityList = await (
    options.fetchAntigravityProviders
      ?? (options.fetchAntigravityProvider ? async () => [await options.fetchAntigravityProvider!()] : undefined)
      ?? (() => antigravityProviders(options.antigravity, env, options.workingDirectory ?? process.cwd(), undefined, { storeRoot }))
  )();
  const mappedAntigravity = antigravityList.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model, isHidden: isModelHidden(prefs, provider.instanceId, model.slug) })),
  }));
  const vibeEnabled = options.vibe?.enabled === true;
  const vibeList: ProviderSummary[] = vibeEnabled
    ? [
        await (
          options.fetchVibeProvider ??
          (() => vibeProvider(options.vibe, env, options.workingDirectory ?? process.cwd(), undefined, { storeRoot }))
        )(),
      ].map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, isHidden: isModelHidden(prefs, provider.instanceId, model.slug) })),
      }))
    : [];
  const acp = await (options.fetchAcpProviders ?? (async () => {
    const registry = options.acpRegistry
      ? await options.acpRegistry().catch((): LoadedAcpRegistry => ({ agents: [], source: "empty" }))
      : { agents: [], source: "empty" as const };
    return acpProviders(options.acp, env, options.workingDirectory ?? process.cwd(), undefined, registry.agents);
  }))();
  const mappedAcp = acp.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model, isHidden: isModelHidden(prefs, provider.instanceId, model.slug) })),
  }));
  // Standalone `codex` is retired from user-facing provider lists (kept strictly as a
  // companion under `chatgpt/<id>` for live usage windows and locked-down image_generation).
  return [
    ...claudeList,
    ...chatgptList,
    ...mappedAntigravity,
    ...vibeList,
    ...mappedAcp,
    ...harness,
    ...opencode,
    ...compat,
  ];
}

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

import { codexProvider } from "../providers/codex/catalog.js";
import { claudeCatalogModels, setLiveClaudeModels } from "../providers/claude/catalog.js";
import { resolveLiveModels } from "../providers/claude/livemodels.js";
import { binaryOnPath } from "../infra/process.js";
import { resolveStoreRoot } from "../threads/store.js";
import { isModelHidden, loadModelPrefs } from "./prefs.js";
import {
  effortValuesOf,
  freeModelsDisabled,
  freeTierModels,
  loadModelsDevCatalog,
  loadServedModels,
  presentApiKeyEnvs,
  readStoredAuthTypes,
  storedAuthTypeFor,
  type LoadedModelsDevCatalog,
  type LoadedServedModels,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "../providers/opencode/catalog.js";
import type { CodexProviderConfig, HarnessProviderConfig } from "../types.js";
import type { EffortDescriptor, ModelSummary, ProviderSummary } from "./summary.js";

export interface DirectCatalogOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly codex?: CodexProviderConfig;
  readonly fetchCodexProvider?: () => Promise<ProviderSummary>;
  readonly workingDirectory?: string;
  readonly storeRoot?: string;
  readonly modelsDev?: () => Promise<LoadedModelsDevCatalog>;
  /** The models OpenCode's own provider serves today (`loadServedModels`); read only when its free tier is offered. */
  readonly opencodeServed?: () => Promise<LoadedServedModels>;
  /**
   * The `opencode` executable to ask for stored credentials. No setting feeds
   * this today (the OpenCode driver is built with its defaults too), so it is
   * the bare `opencode` on PATH until one exists.
   */
  readonly opencodeBinaryPath?: string;
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

/**
 * Per-provider `opencode/<id>` entries: categorized, browsable sections.
 * Credentialed providers list everything. Without a credential only
 * OpenCode's own `opencode` provider serves anything — its free tier:
 * zero-cost on models.dev and still served (`freeTierModels`), none at all
 * under `OPENCODE_DISABLE_FREE_MODELS`; every other provider refuses every
 * request, so it is listed disabled with no models rather than offering a
 * long tail of models the user cannot run.
 */
async function opencodeProviders(
  loaded: LoadedModelsDevCatalog,
  env: NodeJS.ProcessEnv,
  installed: boolean,
  isHidden: (instanceId: string, slug: string) => boolean,
  binaryPath?: string,
  loadServed: () => Promise<LoadedServedModels> = loadServedModels,
): Promise<ProviderSummary[]> {
  const stored = installed ? await readStoredAuthTypes(env, { binaryPath }) : {};
  const freeOff = freeModelsDisabled(env);
  const needsServed = installed && !freeOff && loaded.catalog.some((provider) => provider.id.toLowerCase() === "opencode" && storedAuthTypeFor(stored, provider.id) === undefined && presentApiKeyEnvs(provider, env).length === 0);
  const served: LoadedServedModels = needsServed ? await loadServed().catch((): LoadedServedModels => ({ ids: null, source: "none" })) : { ids: null, source: "none" };
  return loaded.catalog.map((provider: ModelsDevProvider) => {
    const keyEnvs = presentApiKeyEnvs(provider, env);
    const storedType = storedAuthTypeFor(stored, provider.id);
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
    const connected = credential !== null || freeTier;
    const models = credential !== null ? provider.models : freeTier ? freeTierModels(provider.models, served.ids) : [];
    const keyHint = provider.env.length > 0 ? provider.env[0] : null;
    return {
      instanceId: `opencode/${provider.id}`,
      driver: "opencode",
      displayName: provider.name,
      enabled: installed && connected,
      installed,
      status: !installed
        ? "not installed"
        : freeTier
          ? `free models only (connect it for all ${provider.models.length})${SERVED_NOTE[served.source]}`
          : !connected
            ? ownProvider
              ? "free models off (OPENCODE_DISABLE_FREE_MODELS); connect it to use it"
              : keyHint !== null
                ? `not connected (set ${keyHint} or run opencode auth login)`
                : "not connected (run opencode auth login)"
            : loaded.source === "live"
              ? null
              : `models.dev ${loaded.source}`,
      authStatus: credential,
      models: models.map((model) => ({
        ...baseModel(slugOf(provider, model), model.name),
        isHidden: isHidden(`opencode/${provider.id}`, slugOf(provider, model)),
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
  const opencodeInstalled = binaryOnPath("opencode", env);
  const storeRoot = options.storeRoot ?? resolveStoreRoot();

  const [claudeInstalled, modelsDev, prefs] = await Promise.all([
    Promise.resolve(binaryOnPath("claude", env)),
    (options.modelsDev ?? loadModelsDevCatalog)().catch((): LoadedModelsDevCatalog => ({ catalog: [], source: "empty" })),
    // Our own model prefs; hidden models feed the pickers through
    // `isHidden` below.
    loadModelPrefs(storeRoot),
  ]);

  // The installed Claude Code's own list when known (cached, or fetched when
  // `fetchClaudeModels` is given); the bundled file otherwise. The
  // instance id stays `claudeAgent` so existing threads and the
  // manifest's provider key resolve without translation.
  setLiveClaudeModels(
    claudeInstalled ? await resolveLiveModels({ storeRoot, fetch: options.fetchClaudeModels }) : null,
  );
  const claude: ProviderSummary = {
    instanceId: "claudeAgent",
    driver: "claude",
    displayName: "Claude Code",
    enabled: claudeInstalled,
    installed: claudeInstalled,
    status: claudeInstalled ? null : "not installed",
    authStatus: null,
    models: claudeCatalogModels().map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      isDefault: model.isDefault,
      isHidden: isModelHidden(prefs, "claudeAgent", model.slug),
      efforts: model.efforts.map((effort) => ({
        id: effort.id,
        label: effort.label,
        choices: effort.choices.map((choice) => ({ id: choice.id, label: choice.label, isDefault: choice.isDefault })),
        currentValue: effort.currentValue,
      })),
    })),
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };

  const opencode = await opencodeProviders(
    modelsDev,
    env,
    opencodeInstalled,
    (instanceId, slug) => isModelHidden(prefs, instanceId, slug),
    options.opencodeBinaryPath,
    options.opencodeServed,
  );
  const compat = opencodeCompatInstance(modelsDev, opencodeInstalled);

  const harness = harnessProviders(options.harness, env, (instanceId, slug) => isModelHidden(prefs, instanceId, slug));

  const codex = await (options.fetchCodexProvider ?? (() => codexProvider(options.codex, env, options.workingDirectory ?? process.cwd())))();
  return [claude, { ...codex, models: codex.models.map((model) => ({ ...model, isHidden: isModelHidden(prefs, "codex", model.slug) })) }, ...harness, ...opencode, compat];
}

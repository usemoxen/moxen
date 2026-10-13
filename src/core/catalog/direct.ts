/**
 * Direct catalog: `providers/models/efforts list` straight from the drivers.
 *
 * Same `ProviderSummary[]` envelopes as the WS path (`catalog.ts`
 * extraction is wire-payload-specific, so this module builds the summaries
 * directly), values from our own sources (docs/providers.md):
 * - claude: binary presence + the bundled model catalog.
 * - opencode: one entry per models.dev provider
 *   (`instanceId: "opencode/<providerId>"`, slugs already
 *   `providerID/modelID`, so send-time routing needs no translation),
 *   API-key presence from env, OAuth status from the stored auth file.
 *
 * Honest gaps (cutover/hardening items, not silent): usage windows are
 * session-live in every native driver so `usageLimits` is null here;
 * skills need a live server/session scan; Claude exposes no model catalog
 * API so its models resolve at send time.
 */
import fs from "node:fs";
import path from "node:path";

import { claudeCatalogModels } from "../providers/claude/catalog.js";
import { binaryOnPath } from "../infra/process.js";
import { resolveStoreRoot } from "../threads/store.js";
import { isModelHidden, loadModelPrefs } from "./prefs.js";
import {
  effortValuesOf,
  isFreeModel,
  loadModelsDevCatalog,
  presentApiKeyEnvs,
  readStoredAuthTypes,
  storedAuthTypeFor,
  type LoadedModelsDevCatalog,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "../providers/opencode/catalog.js";
import type { EffortDescriptor, ModelSummary, ProviderSummary } from "./summary.js";

export interface DirectCatalogOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly storeRoot?: string;
  readonly modelsDev?: () => Promise<LoadedModelsDevCatalog>;
  /**
   * The `opencode` executable to ask for stored credentials. No setting feeds
   * this today (the OpenCode driver is built with its defaults too), so it is
   * the bare `opencode` on PATH until one exists.
   */
  readonly opencodeBinaryPath?: string;
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

/**
 * Per-provider `opencode/<id>` entries: categorized, browsable sections.
 * Credentialed providers list everything. Without a credential only
 * OpenCode's own `opencode` provider serves anything — its zero-cost
 * models, upstream's free tier (`isFreeOpencodeModel`); every other
 * provider refuses every request, so it is listed disabled with no models
 * rather than offering a long tail of models the user cannot run.
 */
async function opencodeProviders(
  loaded: LoadedModelsDevCatalog,
  env: NodeJS.ProcessEnv,
  installed: boolean,
  isHidden: (instanceId: string, slug: string) => boolean,
  binaryPath?: string,
): Promise<ProviderSummary[]> {
  const stored = installed ? await readStoredAuthTypes(env, { binaryPath }) : {};
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
    const freeTier = credential === null && provider.id.toLowerCase() === "opencode";
    const connected = credential !== null || freeTier;
    const models = credential !== null ? provider.models : freeTier ? provider.models.filter(isFreeModel) : [];
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
          ? `free models only (connect it for all ${provider.models.length})`
          : !connected
            ? keyHint !== null
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

  // Claude has no list API; the bundled model file is the catalog. The
  // instance id stays `claudeAgent` so existing threads and the
  // manifest's provider key resolve without translation.
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
  );
  const compat = opencodeCompatInstance(modelsDev, opencodeInstalled);

  return [claude, ...opencode, compat];
}

import { CliError } from "../errors.js";
import { driverKindOfInstance, parseAccountInstanceId } from "../types.js";
import { binaryOnPath } from "../infra/process.js";
import { parseClaudeModels } from "../providers/claude/catalog.js";
import type {
  CliConfig,
  ModelSelection,
  ProviderOptionSelection,
  SpeedMode,
  RuntimeMode,
} from "../types.js";

/** Pins the installation default: `<instanceId>/<model>`, e.g. `claudeAgent/claude-opus-5-5`. */
export const DEFAULT_MODEL_ENV = "MOXEN_DEFAULT_MODEL";

export interface ModelSelectionRequest {
  prompt: string;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
}

export interface InstallationDefaultOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Whether a provider CLI is installed; `PATH` lookup by default. */
  readonly installed?: (binary: string) => boolean;
}

/**
 * The installation default: the model a thread gets when nothing more
 * specific names one — flags, config `provider`/`model`, the project's
 * default and the thread's own selection all win over it.
 *
 * `MOXEN_DEFAULT_MODEL` pins it outright. Otherwise it is Claude's bundled
 * catalog default when Claude Code is installed, never a model slug of ours
 * that ages with every release. OpenCode routes to many providers, so
 * picking one would be a guess; it is never chosen here.
 *
 * With none installed there is no model to fall back to, and saying so
 * beats addressing a provider that cannot start.
 */
export function defaultModelSelection(options: InstallationDefaultOptions = {}): ModelSelection {
  const env = options.env ?? process.env;
  const pinned = env[DEFAULT_MODEL_ENV]?.trim();
  if (pinned) {
    const slash = pinned.indexOf("/");
    if (slash <= 0 || slash === pinned.length - 1) {
      throw new CliError(
        "INVALID_CONFIG",
        `${DEFAULT_MODEL_ENV} must be <provider-instance>/<model>, e.g. claudeAgent/claude-opus-5-5.`,
        { exitCode: 2, details: { value: pinned } },
      );
    }
    return { instanceId: pinned.slice(0, slash), model: pinned.slice(slash + 1) };
  }
  const installed = options.installed ?? ((binary: string) => binaryOnPath(binary, env));
  if (installed("claude")) {
    const models = parseClaudeModels();
    const model = models.find((candidate) => candidate.isDefault === true) ?? models[0];
    if (model) return { instanceId: "claudeAgent", model: model.slug };
  }
  throw new CliError(
    "NO_DEFAULT_MODEL",
    "No model is configured and Claude Code is not installed. " +
      "Install one, or name a model: moxen config set provider <instance> and moxen config set model <model>.",
    { exitCode: 3, details: { checked: ["claude"] } },
  );
}

export function nonEmptyOption(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CliError("INVALID_THREAD_OPTION", `${name} must be a non-empty string.`);
  return trimmed;
}

function normalizeProviderOptions(options: unknown): ProviderOptionSelection[] {
  if (Array.isArray(options)) {
    return options.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      const value = candidate.value;
      return id && (typeof value === "string" || typeof value === "boolean") ? [{ id, value }] : [];
    });
  }
  if (options !== null && typeof options === "object") {
    return Object.entries(options).flatMap(([id, value]) =>
      id.trim() && (typeof value === "string" || typeof value === "boolean") ? [{ id: id.trim(), value }] : [],
    );
  }
  return [];
}

function setProviderOption(
  selections: ProviderOptionSelection[],
  id: string,
  value: string | boolean,
): void {
  const existing = selections.find((selection) => selection.id === id);
  if (existing) existing.value = value;
  else selections.push({ id, value });
}

export function asModelSelection(value: unknown): ModelSelection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.trim().length === 0) return null;
  if (typeof candidate.model !== "string" || candidate.model.trim().length === 0) return null;
  return candidate as unknown as ModelSelection;
}

/** The defaults the user set on a provider's own settings page (with per-account model/effort overrides winning over provider-level defaults). */
export function providerDefaults(config: Pick<CliConfig, "providers">, instanceId: string): { runtimeMode?: RuntimeMode; model?: string; thinkingEffort?: string } {
  const kind = driverKindOfInstance(instanceId);
  if (kind === null) return {};
  const base = config.providers?.[kind] ?? {};
  const parsed = parseAccountInstanceId(instanceId);
  if (!parsed) return base;
  const accounts =
    parsed.kind === "claude"
      ? config.providers?.claude?.accounts
      : parsed.kind === "chatgpt"
        ? config.providers?.chatgpt?.accounts
        : config.providers?.antigravity?.accounts;
  const account = accounts?.find((entry) => entry.id.trim().toLowerCase() === parsed.accountId);
  if (!account) return base;
  return {
    ...base,
    ...(account.model !== undefined ? { model: account.model } : {}),
    ...(account.thinkingEffort !== undefined ? { thinkingEffort: account.thinkingEffort } : {}),
  };
}

/** The permission mode a new thread on `instanceId` starts in: the provider's own default, else the global one. */
export function defaultRuntimeMode(config: CliConfig, instanceId: string): RuntimeMode {
  return providerDefaults(config, instanceId).runtimeMode ?? config.runtimeMode;
}

/**
 * Whether the global Model is aimed at threads on `instanceId`. A model
 * belongs to one provider, so the global Model belongs to the global
 * Provider: it applies to threads on that provider (or another instance of
 * the same driver) and to no other. With no global Provider it applies to none.
 */
export function globalModelAimsAt(config: Pick<CliConfig, "provider">, instanceId: string): boolean {
  const aimed = config.provider?.trim();
  if (!aimed) return false;
  if (aimed === instanceId) return true;
  const kind = driverKindOfInstance(instanceId);
  return kind !== null && driverKindOfInstance(aimed) === kind;
}

/**
 * The model the settings start a new thread on `instanceId` with: the
 * provider tab's Model, else the global Model when it is aimed at this
 * provider. Undefined leaves it to the project's model or the catalog's
 * default. The server resolves new threads with this, and a client marks the
 * same model as the default in its picker, so the two cannot disagree.
 */
export function configuredModel(config: Pick<CliConfig, "provider" | "model" | "providers">, instanceId: string): string | undefined {
  const own = providerDefaults(config, instanceId).model?.trim();
  if (own) return own;
  const global = config.model?.trim();
  return global && globalModelAimsAt(config, instanceId) ? global : undefined;
}

/**
 * The selection a new thread starts on. One rule, most specific first
 * (`docs/threads.md`, "Which model a new thread gets"):
 *
 * - Provider: the request, the stored selection's (`base`: the project's
 *   default, or the thread's own for a follow-up), the global Provider, then
 *   the installation default.
 * - Model: the request; the stored selection's model when it is on that
 *   provider; the provider tab's Model; the global Model when it is aimed at
 *   that provider; the installation default's model when it is.
 * - Effort: the request, the provider tab's Effort, then the global Effort.
 *
 * `installation` is only asked when nothing else names a provider or a
 * model, so a configured provider and model work with Claude Code absent.
 */
export function resolveModelSelection(
  base: ModelSelection | null,
  config: CliConfig,
  options: ModelSelectionRequest,
  installation: () => ModelSelection = () => defaultModelSelection(),
): ModelSelection {
  const requested = nonEmptyOption(options.provider, "provider");
  const configured = nonEmptyOption(config.provider, "provider");
  let fallback: ModelSelection | undefined;
  const installed = (): ModelSelection => (fallback ??= installation());
  const instanceId = requested ?? base?.instanceId ?? configured ?? installed().instanceId;
  const stored = base !== null && base.instanceId === instanceId ? base : null;
  const requestedModel = nonEmptyOption(options.model, "model") ?? stored?.model ?? configuredModel(config, instanceId);
  const own = providerDefaults(config, instanceId);
  const thinkingEffort = nonEmptyOption(options.thinkingEffort ?? own.thinkingEffort ?? config.thinkingEffort, "thinking effort");
  let model = requestedModel;
  if (model === undefined) {
    // Only the installation default is left; it names a model only for its own provider.
    const install = fallback ?? tryInstallation(installed);
    if (install?.instanceId === instanceId) model = install.model;
  }
  if (model === undefined) {
    throw new CliError(
      "MODEL_REQUIRED_FOR_PROVIDER",
      `No model is set for provider instance ${instanceId}; select one with --model, or set its Model in the settings.`,
      { details: { provider: instanceId, ...(base !== null ? { projectProvider: base.instanceId } : {}) } },
    );
  }
  const selectionChanged = base === null || instanceId !== base.instanceId || model !== base.model;
  const selections = selectionChanged ? [] : normalizeProviderOptions(base.options);
  const speedMode = options.speedMode ?? config.speedMode;

  if (speedMode !== undefined) {
    setProviderOption(selections, "serviceTier", speedMode === "fast" ? "fast" : "default");
    setProviderOption(selections, "fastMode", speedMode === "fast");
  }
  if (thinkingEffort !== undefined) {
    // Provider drivers use different descriptor ids for the same user-facing control.
    setProviderOption(selections, "reasoningEffort", thinkingEffort);
    setProviderOption(selections, "effort", thinkingEffort);
    setProviderOption(selections, "reasoning", thinkingEffort);
  }

  return {
    instanceId,
    model,
    ...(selections.length > 0 ? { options: selections } : {}),
  };
}

/** The installation default when there is one; null when none can be had (it is only a last resort here). */
function tryInstallation(installed: () => ModelSelection): ModelSelection | null {
  try {
    return installed();
  } catch {
    return null;
  }
}

/** Flag-level model request, resolved against the config and a base selection. */
export interface ModelRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly speedMode?: SpeedMode;
  readonly thinkingEffort?: string;
}

function hasModelRequest(request: ModelRequest | undefined): request is ModelRequest {
  return (
    request !== undefined &&
    (request.provider !== undefined ||
      request.model !== undefined ||
      request.speedMode !== undefined ||
      request.thinkingEffort !== undefined)
  );
}

/**
 * The selection a follow-up turn runs on, or undefined to keep the
 * thread's own. A follow-up keeps its thread's model unless the request
 * overrides it: the config's default provider/model must not flip an
 * existing thread's model, so they are stripped before resolving.
 */
export function followUpSelection(
  base: ModelSelection,
  config: CliConfig,
  request: ModelRequest | undefined,
  prompt: string,
): ModelSelection | undefined {
  if (!hasModelRequest(request)) return undefined;
  const scoped: CliConfig = { ...config };
  delete scoped.provider;
  delete scoped.model;
  delete scoped.speedMode;
  delete scoped.thinkingEffort;
  delete scoped.providers;
  // A switch to another provider names its model: the installation default is for new threads only.
  return resolveModelSelection(base, scoped, { prompt, ...request }, () => {
    throw new CliError("NO_DEFAULT_MODEL", "A follow-up does not fall back to the installation default.");
  });
}

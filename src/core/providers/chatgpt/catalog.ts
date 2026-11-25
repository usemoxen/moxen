/**
 * Sign in with ChatGPT model discovery (`GET https://api.openai.com/v1/models`)
 * and Moxen Harness target synthesis for `chatgpt/<id>` instances.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ModelSummary } from "../../catalog/summary.js";
import { renameReplacing } from "../../infra/atomic.js";
import { parseAccountInstanceId, type HarnessModelConfig, type HarnessProfileConfig } from "../../types.js";
import { HarnessDriver, type HarnessDriverOptions } from "../harness/driver.js";
import {
  chatgptContextWindowFor,
  recordChatGptContextWindows,
  resetChatGptContextWindowsForTests,
  resolveHarnessTarget,
  type ResolvedHarnessTarget,
} from "../harness/profiles.js";
import { DEFAULT_QUIRKS, type ModelQuirks } from "../harness/quirks.js";
import { ensureFreshChatGptToken, OPENAI_API_RESOURCE, type OAuthDeps } from "./oauth.js";

export const CHATGPT_BASE_URL = OPENAI_API_RESOURCE;

const NON_CHAT_MODEL_RE =
  /^(?:whisper|tts|dall-e|text-embedding|text-moderation|omni-moderation|babbage|davinci|ada|curie|gpt-image|sora|computer-use|realtime|audio|transcribe)/i;

const NON_CHAT_SUBSTRING_RE = /(?:embedding|moderation|realtime|audio|transcribe|tts|whisper|image-gen|search-preview)/i;

const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export interface ChatGptCatalogDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ChatGptModelInfo {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly vision: boolean;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function isChatGptChatModel(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;
  if (NON_CHAT_MODEL_RE.test(trimmed)) return false;
  if (NON_CHAT_SUBSTRING_RE.test(trimmed)) return false;
  return /^(?:gpt-|o[1-9]|chatgpt-)/i.test(trimmed);
}

function parseSupportedEfforts(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    const effort =
      typeof item === "string"
        ? item.trim()
        : typeof asRecord(item)?.effort === "string"
          ? (asRecord(item)!.effort as string).trim()
          : "";
    if (effort && !out.includes(effort)) out.push(effort);
  }
  return out;
}

export function inferChatGptModelMetadata(
  id: string,
  raw?: Record<string, unknown>,
  accountId?: string,
): ChatGptModelInfo {
  const lower = id.toLowerCase();
  const displayName = typeof raw?.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : undefined;
  const advertisedWindow = Math.max(
    positiveInt(raw?.max_context_window) ?? 0,
    positiveInt(raw?.context_window) ?? 0,
    positiveInt(raw?.context_length) ?? 0,
    positiveInt(raw?.max_model_len) ?? 0,
  );
  const contextWindow = advertisedWindow > 0 ? advertisedWindow : chatgptContextWindowFor(id, accountId);
  const maxOutput = positiveInt(raw?.max_output_tokens) ?? 32_768;
  const reasoningModel = /^(?:gpt-5|gpt-6|o[1-9])/.test(lower);
  const parsedEfforts = parseSupportedEfforts(raw?.supported_reasoning_levels);
  const efforts = parsedEfforts ?? (reasoningModel ? DEFAULT_EFFORTS : []);
  const rawDefaultEffort =
    typeof raw?.default_reasoning_level === "string" && raw.default_reasoning_level.trim()
      ? raw.default_reasoning_level.trim()
      : undefined;
  const defaultEffort = rawDefaultEffort && efforts.includes(rawDefaultEffort) ? rawDefaultEffort : undefined;
  const vision = Array.isArray(raw?.input_modalities)
    ? raw.input_modalities.some((m) => typeof m === "string" && m.toLowerCase() === "image")
    : /^(?:gpt-4o|gpt-4\.1|gpt-5|gpt-6|o3|o4|chatgpt-4o)/.test(lower);
  return {
    id,
    ...(displayName !== undefined ? { displayName } : {}),
    contextWindow,
    maxOutput,
    vision,
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

export function toChatGptHarnessModel(info: ChatGptModelInfo): HarnessModelConfig {
  return {
    id: info.id,
    contextWindow: info.contextWindow,
    maxOutput: info.maxOutput,
    vision: info.vision,
    ...(info.efforts.length > 0 ? { efforts: [...info.efforts] } : {}),
  };
}

export function toChatGptModelSummary(info: ChatGptModelInfo, isDefault: boolean): ModelSummary {
  const label =
    info.displayName ??
    info.id
      .split("-")
      .map((part) => (part === "gpt" ? "GPT" : part === "codex" ? "Codex" : part === "mini" ? "Mini" : part === "nano" ? "Nano" : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ");
  const defaultEffort =
    info.defaultEffort && info.efforts.includes(info.defaultEffort)
      ? info.defaultEffort
      : info.efforts.includes("medium")
        ? "medium"
        : info.efforts[0] ?? null;
  return {
    slug: info.id,
    name: label,
    isCustom: false,
    isDefault,
    isHidden: false,
    efforts:
      info.efforts.length > 0
        ? [
            {
              id: "effort",
              label: "Effort",
              currentValue: defaultEffort,
              choices: info.efforts.map((effort) => ({
                id: effort,
                label: effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1),
                isDefault: effort === defaultEffort,
              })),
            },
          ]
        : [],
  };
}

/** Discover chat/reasoning models available to a signed-in ChatGPT account via `GET /v1/models`. */
export async function discoverChatGptModels(
  accessToken: string,
  deps: ChatGptCatalogDeps = {},
): Promise<readonly ChatGptModelInfo[]> {
  const base = (deps.baseUrl ?? CHATGPT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models`;
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI models discovery failed (HTTP ${response.status}).`);
  }
  const json = asRecord(await response.json().catch(() => null));
  // ChatGPT OAuth tokens return `{ models: [{ slug, display_name, visibility, ... }] }`;
  // standard OpenAI API responses return `{ data: [{ id, ... }] }`.
  const rawList = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
  const seen = new Set<string>();
  const collected: Array<{ readonly info: ChatGptModelInfo; readonly priority: number; readonly index: number }> = [];
  for (let index = 0; index < rawList.length; index++) {
    const rec = asRecord(rawList[index]);
    if (!rec) continue;
    if (typeof rec.visibility === "string" && rec.visibility.trim().toLowerCase() === "hide") continue;
    if (rec.supported_in_api === false) continue;
    const rawId = typeof rec.slug === "string" ? rec.slug : typeof rec.id === "string" ? rec.id : "";
    const id = rawId.trim();
    if (!id || seen.has(id) || !isChatGptChatModel(id)) continue;
    seen.add(id);
    const priority = typeof rec.priority === "number" && Number.isFinite(rec.priority) ? rec.priority : Number.MAX_SAFE_INTEGER;
    collected.push({ info: inferChatGptModelMetadata(id, rec), priority, index });
  }
  collected.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.index - b.index));
  return collected.map((entry) => entry.info);
}

const MODELS_CACHE_FILE = "chatgpt-models-cache.json";

const discoveredByAccount = new Map<string, Map<string, ChatGptModelInfo>>();
const discoveredByModel = new Map<string, ChatGptModelInfo>();
const hydratedStoreRoots = new Set<string>();
let cachePersistChain: Promise<unknown> = Promise.resolve();

function parseCachedModelInfo(raw: unknown): ChatGptModelInfo | null {
  const rec = asRecord(raw);
  const id = typeof rec?.id === "string" ? rec.id.trim() : "";
  const contextWindow = positiveInt(rec?.contextWindow);
  const maxOutput = positiveInt(rec?.maxOutput);
  if (!id || contextWindow === undefined || maxOutput === undefined) return null;
  const displayName = typeof rec?.displayName === "string" && rec.displayName.trim() ? rec.displayName.trim() : undefined;
  const efforts = Array.isArray(rec?.efforts)
    ? rec.efforts.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const defaultEffort =
    typeof rec?.defaultEffort === "string" && efforts.includes(rec.defaultEffort) ? rec.defaultEffort : undefined;
  return {
    id,
    ...(displayName !== undefined ? { displayName } : {}),
    contextWindow,
    maxOutput,
    vision: rec?.vision === true,
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

function storeDiscoveredInMemory(accountId: string, models: readonly ChatGptModelInfo[]): void {
  const normAccount = accountId.trim().toLowerCase();
  if (!normAccount || models.length === 0) return;
  let bucket = discoveredByAccount.get(normAccount);
  if (!bucket) {
    bucket = new Map<string, ChatGptModelInfo>();
    discoveredByAccount.set(normAccount, bucket);
  }
  for (const model of models) {
    const normModel = model.id.trim().toLowerCase();
    if (!normModel) continue;
    bucket.set(normModel, model);
    discoveredByModel.set(normModel, model);
  }
  recordChatGptContextWindows(normAccount, models);
}

/** Load previously discovered ChatGPT model metadata from `<storeRoot>/chatgpt-models-cache.json` (best-effort, once per store root). */
export function hydrateChatGptModelsCache(storeRoot: string): void {
  const file = path.join(storeRoot, MODELS_CACHE_FILE);
  if (hydratedStoreRoots.has(file)) return;
  hydratedStoreRoots.add(file);
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(file, "utf8")));
    const accounts = asRecord(parsed?.accounts);
    if (!accounts) return;
    for (const [accountId, list] of Object.entries(accounts)) {
      if (!Array.isArray(list)) continue;
      const models = list.map(parseCachedModelInfo).filter((entry): entry is ChatGptModelInfo => entry !== null);
      if (models.length > 0) storeDiscoveredInMemory(accountId, models);
    }
  } catch {
    // No cache yet or unreadable: start fresh.
  }
}

/** Record discovered ChatGPT models in memory and persist to `<storeRoot>/chatgpt-models-cache.json` when given. */
export function recordDiscoveredChatGptModels(
  accountId: string,
  models: readonly ChatGptModelInfo[],
  storeRoot?: string,
): void {
  if (models.length === 0) return;
  storeDiscoveredInMemory(accountId, models);
  if (!storeRoot) return;
  const file = path.join(storeRoot, MODELS_CACHE_FILE);
  hydratedStoreRoots.add(file);
  const accounts: Record<string, readonly ChatGptModelInfo[]> = {};
  for (const [id, map] of discoveredByAccount) {
    accounts[id] = [...map.values()];
  }
  const payload = JSON.stringify({ accounts }, null, 2);
  cachePersistChain = cachePersistChain
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await fs.promises.writeFile(tmp, payload);
      await renameReplacing(tmp, file);
    })
    .catch(() => undefined);
}

/** Look up cached discovered metadata for a ChatGPT model (account-specific first, then any account). */
export function cachedChatGptModelInfo(modelId: string, accountId?: string): ChatGptModelInfo | null {
  const normModel = modelId.trim().toLowerCase();
  if (!normModel) return null;
  const normAccount = accountId?.trim().toLowerCase();
  if (normAccount) {
    const hit = discoveredByAccount.get(normAccount)?.get(normModel);
    if (hit) return hit;
  }
  return discoveredByModel.get(normModel) ?? null;
}

/** Tests only: clear cached discovered ChatGPT model metadata. */
export function resetChatGptModelCacheForTests(): void {
  discoveredByAccount.clear();
  discoveredByModel.clear();
  hydratedStoreRoots.clear();
  resetChatGptContextWindowsForTests();
}

export function chatgptOAuthQuirks(): ModelQuirks {
  return {
    ...DEFAULT_QUIRKS,
    images: "native",
    sendReasoning: true,
    chatgptOAuth: true,
  };
}

/** Synthesize a `ResolvedHarnessTarget` for a `chatgpt/<id>` account so `HarnessDriver` runs it natively. */
export function synthesizeChatGptTarget(
  instanceId: string,
  modelId: string,
  baseUrl = CHATGPT_BASE_URL,
): ResolvedHarnessTarget | null {
  const parsed = parseAccountInstanceId(instanceId);
  const accountId = parsed?.kind === "chatgpt" ? parsed.accountId : instanceId.trim().toLowerCase() === "chatgpt" ? "default" : null;
  if (accountId === null) return null;
  const cached = cachedChatGptModelInfo(modelId, accountId);
  const info = cached ? { ...cached, id: modelId } : inferChatGptModelMetadata(modelId, undefined, accountId);
  const profile: HarnessProfileConfig = {
    id: accountId,
    label: `ChatGPT (${accountId})`,
    baseUrl,
    apiFormat: "responses",
    quirks: {
      images: "native",
      sendReasoning: true,
      chatgptOAuth: true,
    },
    models: [toChatGptHarnessModel(info)],
  };
  return resolveHarnessTarget({ profiles: [profile] }, `harness/${accountId}`, info.id);
}

/** Create a `HarnessDriver` pre-wired to execute `chatgpt/<id>` turns & zero-tool completions with fresh OAuth tokens. */
export function createChatGptHarnessDriver(
  options: HarnessDriverOptions & {
    readonly oauth?: OAuthDeps | undefined;
    readonly baseUrl?: string | undefined;
  } = {},
): HarnessDriver {
  return new HarnessDriver({
    ...options,
    resolveTarget: (instanceId, model) => synthesizeChatGptTarget(instanceId, model, options.baseUrl),
    resolveBearerToken: async (instanceId) => {
      const parsed = parseAccountInstanceId(instanceId);
      const accountId = parsed?.kind === "chatgpt" ? parsed.accountId : null;
      if (!accountId) return undefined;
      const { accessToken } = await ensureFreshChatGptToken(accountId, options.oauth);
      return accessToken;
    },
  });
}

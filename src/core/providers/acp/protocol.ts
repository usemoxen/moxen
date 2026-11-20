/**
 * Agent Client Protocol (ACP) v1 wire contract + defensive payload readers.
 *
 * Moxen pins a single ACP protocol version (`ACP_PROTOCOL_VERSION = 1`).
 * During `initialize`, the agent's negotiated `protocolVersion` must equal
 * `ACP_PROTOCOL_VERSION`; any missing, older, or newer version is refused
 * loudly with `ACP_PROTOCOL_VERSION_UNSUPPORTED` rather than running in a
 * fuzzy or silently degraded mode.
 */
import { createTwoFilesPatch } from "diff";

import { imageMention } from "../../attachments.js";
import type { ModelSummary } from "../../catalog/summary.js";
import { CliError } from "../../errors.js";
import { outOfProcess, type McpServerSpec } from "../../mcp.js";
import type { ModelSelection } from "../../types.js";
import type { ProviderApprovalDecision, ProviderImage } from "../spi.js";
import type { TerminalTurnStatus } from "../turnsettle.js";

/** Pinned ACP wire protocol version supported by this driver. */
export const ACP_PROTOCOL_VERSION = 1 as const;

export const ACP_METHODS = {
  // Client -> Agent requests
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  // Client -> Agent notifications
  sessionCancel: "session/cancel",
  // Agent -> Client notifications
  sessionUpdate: "session/update",
  // Agent -> Client requests
  requestPermission: "session/request_permission",
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
} as const;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validate the agent's negotiated `protocolVersion` against the pinned version.
 * Refuses missing, non-integer, older, or newer versions so ACP never drifts
 * silently behind Moxen.
 */
export function assertSupportedAcpProtocolVersion(
  negotiated: unknown,
  agentLabel = "ACP agent",
): number {
  if (typeof negotiated !== "number" || !Number.isInteger(negotiated)) {
    throw new CliError(
      "ACP_PROTOCOL_VERSION_UNSUPPORTED",
      `${agentLabel} returned an invalid ACP protocolVersion (${String(negotiated)}). Moxen requires ACP protocol v${ACP_PROTOCOL_VERSION}.`,
      { details: { expected: ACP_PROTOCOL_VERSION, actual: negotiated } },
    );
  }
  if (negotiated !== ACP_PROTOCOL_VERSION) {
    throw new CliError(
      "ACP_PROTOCOL_VERSION_UNSUPPORTED",
      `${agentLabel} negotiated ACP protocol v${negotiated}, but Moxen only supports ACP protocol v${ACP_PROTOCOL_VERSION}.`,
      { details: { expected: ACP_PROTOCOL_VERSION, actual: negotiated } },
    );
  }
  return negotiated;
}

export interface AcpPromptCapabilities {
  readonly image: boolean;
  readonly audio: boolean;
  readonly embeddedContext: boolean;
}

export interface AcpMcpCapabilities {
  readonly http: boolean;
  readonly sse: boolean;
}

export interface AcpAgentCapabilities {
  readonly loadSession: boolean;
  readonly canCloseSession: boolean;
  readonly promptCapabilities: AcpPromptCapabilities;
  readonly mcpCapabilities: AcpMcpCapabilities;
}

export interface AcpAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AcpAgentInfo {
  readonly name: string | null;
  readonly title: string | null;
  readonly version: string | null;
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: AcpAgentCapabilities;
  readonly agentInfo: AcpAgentInfo;
  readonly authMethods: ReadonlyArray<AcpAuthMethod>;
}

export function parseAcpInitializeResult(raw: unknown, agentLabel?: string): AcpInitializeResult {
  const record = asRecord(raw);
  const protocolVersion = assertSupportedAcpProtocolVersion(record?.["protocolVersion"], agentLabel);
  const caps = asRecord(record?.["agentCapabilities"]) ?? {};
  const promptCaps = asRecord(caps["promptCapabilities"]) ?? {};
  const mcpCaps = asRecord(caps["mcpCapabilities"]) ?? {};
  const sessionCaps = asRecord(caps["sessionCapabilities"]) ?? asRecord(caps["session_capabilities"]) ?? {};
  const info = asRecord(record?.["agentInfo"]) ?? {};
  const rawAuth = Array.isArray(record?.["authMethods"]) ? record!["authMethods"] : [];
  const authMethods: AcpAuthMethod[] = [];
  for (const entry of rawAuth) {
    const item = asRecord(entry);
    const id = asNonEmptyString(item?.["id"]);
    if (!id) continue;
    authMethods.push({
      id,
      name: asNonEmptyString(item?.["name"]) ?? id,
      description: asNonEmptyString(item?.["description"]),
    });
  }
  return {
    protocolVersion,
    agentCapabilities: {
      loadSession: caps["loadSession"] === true || caps["load_session"] === true,
      canCloseSession: asRecord(sessionCaps["close"]) !== null || sessionCaps["close"] === true,
      promptCapabilities: {
        image: promptCaps["image"] === true,
        audio: promptCaps["audio"] === true,
        embeddedContext: promptCaps["embeddedContext"] === true,
      },
      mcpCapabilities: {
        http: mcpCaps["http"] === true,
        sse: mcpCaps["sse"] === true,
      },
    },
    agentInfo: {
      name: asNonEmptyString(info["name"]),
      title: asNonEmptyString(info["title"]),
      version: asNonEmptyString(info["version"]),
    },
    authMethods,
  };
}

export interface AcpAvailableCommand {
  readonly name: string;
  readonly description: string;
  readonly inputHint: string | null;
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AcpSessionModesState {
  readonly currentModeId: string | null;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpConfigOptionChoice {
  readonly value: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AcpConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly currentValue: string | null;
  readonly options: ReadonlyArray<AcpConfigOptionChoice>;
}

export function parseAcpModesState(raw: unknown): AcpSessionModesState | null {
  const record = asRecord(raw);
  if (!record) return null;
  const rawModes = Array.isArray(record["availableModes"]) ? record["availableModes"] : [];
  const availableModes: AcpSessionMode[] = [];
  for (const entry of rawModes) {
    const item = asRecord(entry);
    const id = asNonEmptyString(item?.["id"]);
    if (!id) continue;
    availableModes.push({
      id,
      name: asNonEmptyString(item?.["name"]) ?? id,
      description: asNonEmptyString(item?.["description"]),
    });
  }
  const currentModeId = asNonEmptyString(record["currentModeId"]);
  if (currentModeId === null && availableModes.length === 0) return null;
  return { currentModeId, availableModes };
}

export function parseAcpConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const result: AcpConfigOption[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    const id = asNonEmptyString(item?.["id"]);
    if (!id) continue;
    const rawOptions = Array.isArray(item?.["options"]) ? item!["options"] : [];
    const options: AcpConfigOptionChoice[] = [];
    for (const opt of rawOptions) {
      const optRec = asRecord(opt);
      if (!optRec) continue;
      // ACP config options may be flat choices or grouped choices (`options: [...]`).
      if (Array.isArray(optRec["options"])) {
        for (const nested of optRec["options"]) {
          const n = asRecord(nested);
          const value = asNonEmptyString(n?.["value"]);
          if (!value) continue;
          options.push({
            value,
            name: asNonEmptyString(n?.["name"]) ?? value,
            description: asNonEmptyString(n?.["description"]),
          });
        }
        continue;
      }
      const value = asNonEmptyString(optRec["value"]);
      if (!value) continue;
      options.push({
        value,
        name: asNonEmptyString(optRec["name"]) ?? value,
        description: asNonEmptyString(optRec["description"]),
      });
    }
    result.push({
      id,
      name: asNonEmptyString(item?.["name"]) ?? id,
      description: asNonEmptyString(item?.["description"]),
      category: asNonEmptyString(item?.["category"]),
      currentValue: asNonEmptyString(item?.["currentValue"]),
      options,
    });
  }
  return result;
}

export function parseAcpAvailableCommands(raw: unknown): AcpAvailableCommand[] {
  if (!Array.isArray(raw)) return [];
  const commands: AcpAvailableCommand[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    const name = asNonEmptyString(item?.["name"]);
    if (!name) continue;
    const input = asRecord(item?.["input"]);
    commands.push({
      name,
      description: asString(item?.["description"]) ?? "",
      inputHint: asNonEmptyString(input?.["hint"]),
    });
  }
  return commands;
}

export interface AcpAvailableModel {
  readonly modelId: string;
  readonly name: string;
}

export interface AcpModelsState {
  readonly currentModelId: string | null;
  readonly availableModels: ReadonlyArray<AcpAvailableModel>;
}

export function parseAcpModelsState(raw: unknown): AcpModelsState | null {
  const record = asRecord(raw);
  if (!record) return null;
  const rawModels = Array.isArray(record["availableModels"]) ? record["availableModels"] : [];
  const availableModels: AcpAvailableModel[] = [];
  for (const entry of rawModels) {
    const item = asRecord(entry);
    const modelId = asNonEmptyString(item?.["modelId"]);
    if (!modelId) continue;
    availableModels.push({
      modelId,
      name: asNonEmptyString(item?.["name"]) ?? modelId,
    });
  }
  const currentModelId = asNonEmptyString(record["currentModelId"]);
  if (currentModelId === null && availableModels.length === 0) return null;
  return { currentModelId, availableModels };
}

const CANONICAL_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CANONICAL_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

export function findAcpEffortOption(configOptions: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return configOptions.find(
    (opt) =>
      opt.category === "thought_level" ||
      opt.id === "thought_level" ||
      opt.id === "effort" ||
      opt.id === "reasoning_effort",
  );
}

export function extractSelectionEffort(selection: ModelSelection | undefined): string | null {
  const opts = selection?.options;
  if (!opts) return null;
  const keys = ["effort", "reasoningEffort", "reasoning", "thought_level"];
  if (Array.isArray(opts)) {
    for (const key of keys) {
      const hit = opts.find((entry) => entry.id === key && typeof entry.value === "string" && entry.value.trim().length > 0);
      if (hit && typeof hit.value === "string") return hit.value.trim();
    }
    return null;
  }
  if (typeof opts === "object") {
    const rec = opts as Record<string, unknown>;
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}

/**
 * Derive Moxen `ModelSummary[]` (base models + per-model effort choices) from
 * an ACP `session/new` response's `configOptions` and `models`.
 *
 * When both `configOptions` (`category: "model"` + `thought_level`) and
 * `models.availableModels` are present (as `agy acp` sends), each base model
 * gets only the effort levels its `<slug>-<level>` variants actually support,
 * so models without effort (e.g. Orchestrator, GPT-OSS) show no effort slider.
 */
export function parseAcpCatalogModels(
  configOptions: readonly AcpConfigOption[],
  modelsState: AcpModelsState | null,
): ModelSummary[] {
  const modelOpt = configOptions.find((opt) => opt.category === "model" || opt.id === "model");
  const effortOpt = findAcpEffortOption(configOptions);
  const available = modelsState?.availableModels ?? [];

  if (modelOpt && modelOpt.options.length > 0) {
    const knownEfforts = new Map<string, { id: string; label: string; order: number }>();
    (effortOpt?.options ?? []).forEach((choice, idx) => {
      knownEfforts.set(choice.value.toLowerCase(), { id: choice.value, label: choice.name, order: idx });
    });
    CANONICAL_EFFORT_ORDER.forEach((level, idx) => {
      if (!knownEfforts.has(level)) {
        knownEfforts.set(level, {
          id: level,
          label: CANONICAL_EFFORT_LABELS[level] ?? level,
          order: 100 + idx,
        });
      }
    });

    const defaultSlug = modelOpt.currentValue ?? null;
    const currentEffort = effortOpt?.currentValue ?? null;
    const seen = new Set<string>();
    const out: ModelSummary[] = [];

    for (const entry of modelOpt.options) {
      if (seen.has(entry.value)) continue;
      seen.add(entry.value);

      let matchedLevels: Array<{ id: string; label: string; order: number }> = [];
      if (available.length > 0) {
        const prefix = `${entry.value}-`;
        const seenLevels = new Set<string>();
        for (const variant of available) {
          if (!variant.modelId.startsWith(prefix)) continue;
          const suffix = variant.modelId.slice(prefix.length).toLowerCase();
          const info = knownEfforts.get(suffix);
          if (!info || seenLevels.has(info.id)) continue;
          seenLevels.add(info.id);
          matchedLevels.push(info);
        }
        matchedLevels.sort((a, b) => a.order - b.order);
      } else if (effortOpt && effortOpt.options.length > 0) {
        matchedLevels = effortOpt.options.map((choice, idx) => ({
          id: choice.value,
          label: choice.name,
          order: idx,
        }));
      }

      const isDefaultModel = defaultSlug !== null ? entry.value === defaultSlug : out.length === 0;
      const defaultEffort = (() => {
        if (matchedLevels.length === 0) return null;
        if (isDefaultModel && currentEffort && matchedLevels.some((c) => c.id === currentEffort)) {
          return currentEffort;
        }
        if (modelsState?.currentModelId?.startsWith(`${entry.value}-`)) {
          const curSuffix = modelsState.currentModelId.slice(entry.value.length + 1).toLowerCase();
          const curHit = matchedLevels.find((c) => c.id.toLowerCase() === curSuffix);
          if (curHit) return curHit.id;
        }
        if (matchedLevels.some((c) => c.id === "medium")) return "medium";
        if (currentEffort && matchedLevels.some((c) => c.id === currentEffort)) return currentEffort;
        return matchedLevels[0]!.id;
      })();

      out.push({
        slug: entry.value,
        name: entry.name,
        isCustom: false,
        isHidden: false,
        isDefault: isDefaultModel,
        efforts:
          matchedLevels.length === 0
            ? []
            : [
                {
                  id: "effort",
                  label: effortOpt?.name || "Effort",
                  choices: matchedLevels.map((level) => ({
                    id: level.id,
                    label: level.label,
                    isDefault: level.id === defaultEffort ? true : null,
                  })),
                  currentValue: null,
                },
              ],
      });
    }
    return out;
  }

  if (available.length > 0) {
    const seen = new Set<string>();
    const out: ModelSummary[] = [];
    for (const entry of available) {
      if (seen.has(entry.modelId)) continue;
      seen.add(entry.modelId);
      out.push({
        slug: entry.modelId,
        name: entry.name,
        isCustom: false,
        isHidden: false,
        isDefault: modelsState?.currentModelId ? entry.modelId === modelsState.currentModelId : out.length === 0,
        efforts: [],
      });
    }
    return out;
  }

  return [];
}

/**
 * Convert Moxen `McpServerSpec`s into ACP v1 `McpServer` entries, dropping any
 * transport the agent did not advertise in `mcpCapabilities` (per `spi.ts`).
 */
export function acpMcpServersOf(
  servers: readonly McpServerSpec[] | undefined,
  capabilities: AcpMcpCapabilities,
): Array<Record<string, unknown>> {
  if (!servers || servers.length === 0) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const spec of servers) {
    const server = outOfProcess(spec);
    if (server.type === "stdio") {
      const env = Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }));
      out.push({
        name: server.name,
        command: server.command,
        args: [...(server.args ?? [])],
        env,
      });
      continue;
    }
    if (server.type === "http") {
      if (!capabilities.http) continue;
      const headers = Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }));
      out.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers,
      });
    }
  }
  return out;
}

/**
 * Build ACP v1 `ContentBlock[]` for `session/prompt`.
 * Uses native `{ type: "image", data, mimeType }` when the agent advertises
 * `promptCapabilities.image`; otherwise appends `imageMention` so images are
 * never silently dropped.
 */
export function buildAcpPromptBlocks(
  prompt: string,
  images: readonly ProviderImage[] | undefined,
  supportsImages: boolean,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (images && images.length > 0 && !supportsImages) {
    const text = imageMention(prompt, images.map((img) => img.name));
    blocks.push({ type: "text", text });
    return blocks;
  }
  blocks.push({ type: "text", text: prompt });
  if (images && images.length > 0) {
    for (const img of images) {
      blocks.push({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      });
    }
  }
  return blocks;
}

export function acpStopReasonToStatus(stopReason: unknown): TerminalTurnStatus {
  if (stopReason === "cancelled") return "interrupted";
  if (stopReason === "refusal") return "failed";
  // end_turn, max_tokens, max_turn_requests all end a turn normally.
  return "completed";
}

/** Canonical Moxen tool name for an ACP `toolCall.kind`, so TUI/Desktop render identical badges & verbs. */
export function acpCanonicalToolName(kind: string | null, title: string | null): string {
  switch (kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Edit";
    case "move":
      return "Edit";
    case "search":
      return "Grep";
    case "execute":
      return "Bash";
    case "fetch":
      return "WebFetch";
    case "think":
      return "Think";
    default:
      return title && title.length > 0 ? title : "Tool";
  }
}

export interface AcpExtractedContent {
  readonly output: string | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly diff?: string }>;
  readonly patch: string | null;
}

/**
 * Extract readable text output and unified diffs from ACP `tool_call` /
 * `tool_call_update` `content` blocks and `locations`.
 */
export function extractAcpToolContent(
  content: unknown,
  locations: unknown,
): AcpExtractedContent {
  const texts: string[] = [];
  const files: Array<{ path: string; diff?: string }> = [];
  const patches: string[] = [];
  const seenFiles = new Set<string>();

  if (Array.isArray(content)) {
    for (const entry of content) {
      const item = asRecord(entry);
      if (!item) continue;
      const type = asString(item["type"]);
      if (type === "diff") {
        const filePath = asNonEmptyString(item["path"]);
        if (!filePath) continue;
        const oldText = asString(item["oldText"]) ?? "";
        const newText = asString(item["newText"]) ?? "";
        const patch = createTwoFilesPatch(filePath, filePath, oldText, newText, "", "", { context: 3 });
        patches.push(patch);
        files.push({ path: filePath, diff: patch });
        seenFiles.add(filePath);
        continue;
      }
      if (type === "content") {
        const inner = asRecord(item["content"]);
        const text = asNonEmptyString(inner?.["text"]);
        if (text) texts.push(text);
        continue;
      }
      if (type === "text") {
        const text = asNonEmptyString(item["text"]);
        if (text) texts.push(text);
        continue;
      }
      if (type === "terminal") {
        const termId = asNonEmptyString(item["terminalId"]);
        if (termId) texts.push(`[terminal ${termId}]`);
      }
    }
  }

  if (Array.isArray(locations)) {
    for (const entry of locations) {
      const loc = asRecord(entry);
      const filePath = asNonEmptyString(loc?.["path"]);
      if (filePath && !seenFiles.has(filePath)) {
        seenFiles.add(filePath);
        files.push({ path: filePath });
      }
    }
  }

  return {
    output: texts.length > 0 ? texts.join("\n") : null,
    files,
    patch: patches.length > 0 ? patches.join("\n") : null,
  };
}

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export function parseAcpPermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AcpPermissionOption[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    const optionId = asNonEmptyString(item?.["optionId"]);
    if (!optionId) continue;
    options.push({
      optionId,
      name: asNonEmptyString(item?.["name"]) ?? optionId,
      kind: asNonEmptyString(item?.["kind"]) ?? "allow_once",
    });
  }
  return options;
}

/**
 * Translate a Moxen `ProviderApprovalDecision` into an ACP v1
 * `RequestPermissionResponse` (`{ outcome: { outcome: "selected", optionId } }`
 * or `{ outcome: { outcome: "cancelled" } }`).
 */
export function selectAcpPermissionOutcome(
  decision: ProviderApprovalDecision,
  options: readonly AcpPermissionOption[],
): { readonly outcome: { readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" } } {
  if (decision.kind === "cancel") {
    return { outcome: { outcome: "cancelled" } };
  }
  const preferredKinds: readonly string[] =
    decision.kind === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision.kind === "accept"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const match = options.find((opt) => opt.kind === kind);
    if (match) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

export function isAcpAuthErrorText(text: string): boolean {
  return /\b(auth(?:entication|orization)?\s+required|unauthenticated|unauthorized|not\s+logged\s+in|sign\s+in|login\s+required)\b/i.test(text);
}

export function isAcpSessionNotFoundText(text: string): boolean {
  return /\b(session\s+not\s+found|unknown\s+session|no\s+such\s+session|invalid\s+session|not\s+found)\b/i.test(text);
}

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
  sessionResume: "session/resume",
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
  elicitationCreate: "elicitation/create",
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
  readonly canResumeSession: boolean;
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
      canResumeSession: asRecord(sessionCaps["resume"]) !== null || sessionCaps["resume"] === true,
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

export interface NormalizedAcpToolCall {
  readonly canonicalTool: string;
  readonly kind: string | null;
  readonly title: string;
  readonly input: Record<string, unknown>;
}

function unwrapMcpArguments(rawInput: Record<string, unknown>): Record<string, unknown> {
  const rawArgs = rawInput["Arguments"] ?? rawInput["arguments"];
  const recordArgs = asRecord(rawArgs);
  if (recordArgs) return recordArgs;
  if (typeof rawArgs === "string" && rawArgs.trim().startsWith("{")) {
    try {
      const parsed = asRecord(JSON.parse(rawArgs));
      if (parsed) return parsed;
    } catch {
      // Keep rawInput when Arguments is not valid JSON.
    }
  }
  return rawInput;
}

function canonicalMcpName(server: string | null, tool: string): string {
  const cleanTool = tool.trim();
  if (/^mcp__(.+?)__(.+)$/iu.test(cleanTool)) return cleanTool;
  if (server && server.trim().length > 0) {
    return `mcp__${server.trim()}__${cleanTool}`;
  }
  const single = /^mcp_([a-z0-9][a-z0-9-]*)_([a-z0-9_-]+)$/iu.exec(cleanTool);
  if (single) {
    return `mcp__${single[1]}__${single[2]}`;
  }
  return `mcp__mcp__${cleanTool}`;
}

/**
 * Normalize an ACP `tool_call` / `tool_call_update` notification's `(kind, title, rawInput)`
 * into Moxen's canonical tool vocabulary and unwrapped input record.
 *
 * Handles `agy acp` conventions from `stepview.KindTitleAndLocations`:
 * - Lazy MCP calls (`call_mcp_tool`) arrive with `kind: "execute"`, `title: "MCP Tool <name>"`,
 *   and `rawInput: { ServerName, ToolName, Arguments }`.
 * - Eager MCP tools and built-in orchestration tools arrive with `kind: "other"` and
 *   `title: "Run <tool>"` (e.g. `"Run mcp_linear_get_issue"`, `"Run manage_task"`).
 * - `list_dir` arrives with `kind: "read"` and `title: "Directory <path>"`.
 * - `read_url_content` arrives with `kind: "read"` and `title: "URL <url>"`.
 * - `search_web` arrives with `kind: "search"` and `title: "<query> on Web"`.
 * - `find_by_name` arrives with `kind: "search"` and `title: "Files named <pattern>"`.
 * - `write_file` arrives with `kind: "edit"` and `Content` (without `Target`/`old_string`).
 * - `run_command` passes PascalCase `CommandLine`.
 */
export function normalizeAcpToolCall(
  kind: string | null,
  title: string | null,
  rawInput: Record<string, unknown> = {},
): NormalizedAcpToolCall {
  const trimmedTitle = title?.trim() ?? "";

  // 1. Lazy MCP tool call (`call_mcp_tool` / `"MCP Tool <name>"`).
  const mcpTitleMatch = /^MCP Tool\s+(.+)$/iu.exec(trimmedTitle);
  const inputServer = asNonEmptyString(
    rawInput["ServerName"] ?? rawInput["serverName"] ?? rawInput["server_name"],
  );
  const inputTool = asNonEmptyString(
    rawInput["ToolName"] ?? rawInput["toolName"] ?? rawInput["tool_name"],
  );
  if (mcpTitleMatch !== null || (inputServer !== null && inputTool !== null)) {
    const toolName = inputTool ?? asNonEmptyString(rawInput["name"]) ?? mcpTitleMatch?.[1]?.trim() ?? "tool";
    const canonicalTool = canonicalMcpName(inputServer, toolName);
    return {
      canonicalTool,
      kind: "other",
      title: canonicalTool,
      input: unwrapMcpArguments(rawInput),
    };
  }

  // 2. Leading `"Run <tool>"` prefix emitted by `agy acp` for `kind: "other"` tools.
  const runMatch = /^Run\s+(.+)$/iu.exec(trimmedTitle);
  if (runMatch !== null && (kind === null || kind === "other")) {
    const bare = runMatch[1]!.trim();
    if (/^mcp__(.+?)__(.+)$/iu.test(bare)) {
      return { canonicalTool: bare, kind: "other", title: bare, input: rawInput };
    }
    const singleMcp = /^mcp_([a-z0-9][a-z0-9-]*)_([a-z0-9_-]+)$/iu.exec(bare);
    if (singleMcp !== null) {
      const canonicalTool = `mcp__${singleMcp[1]}__${singleMcp[2]}`;
      return { canonicalTool, kind: "other", title: canonicalTool, input: rawInput };
    }
    const lowerBare = bare.toLowerCase();
    if (lowerBare === "invoke_subagent") {
      const role = asNonEmptyString(rawInput["Role"] ?? rawInput["role"] ?? rawInput["TypeName"]);
      const prompt = asNonEmptyString(rawInput["Prompt"] ?? rawInput["prompt"]);
      return {
        canonicalTool: "Agent",
        kind: "other",
        title: role ?? "Agent",
        input: {
          ...rawInput,
          ...(role && rawInput["subagent_type"] === undefined ? { subagent_type: role } : {}),
          ...(prompt && rawInput["description"] === undefined ? { description: prompt } : {}),
        },
      };
    }
    if (lowerBare === "ask_question") {
      return { canonicalTool: "AskUserQuestion", kind: "other", title: "AskUserQuestion", input: rawInput };
    }
    return { canonicalTool: bare, kind: "other", title: bare, input: rawInput };
  }

  switch (kind) {
    case "read": {
      if (
        /^Directory\s+/iu.test(trimmedTitle) ||
        asNonEmptyString(rawInput["DirectoryPath"] ?? rawInput["directoryPath"]) !== null
      ) {
        const clean = trimmedTitle.replace(/^Directory\s+/iu, "").trim();
        const dirPath = asNonEmptyString(rawInput["DirectoryPath"] ?? rawInput["directoryPath"]) ?? (clean || null);
        return {
          canonicalTool: "List",
          kind: "read",
          title: clean || dirPath || "List",
          input: dirPath && rawInput["path"] === undefined ? { ...rawInput, path: dirPath } : rawInput,
        };
      }
      if (
        /^URL\s+/iu.test(trimmedTitle) ||
        asNonEmptyString(rawInput["Url"] ?? rawInput["url"]) !== null
      ) {
        const clean = trimmedTitle.replace(/^URL\s+/iu, "").trim();
        const url = asNonEmptyString(rawInput["Url"] ?? rawInput["url"]) ?? (clean || null);
        return {
          canonicalTool: "WebFetch",
          kind: "fetch",
          title: clean || url || "WebFetch",
          input: url && rawInput["url"] === undefined ? { ...rawInput, url } : rawInput,
        };
      }
      const cleanRead = trimmedTitle.replace(/^File\s+/iu, "").trim();
      const readPath = asNonEmptyString(
        rawInput["file_path"] ??
          rawInput["Path"] ??
          rawInput["TargetFile"] ??
          rawInput["FilePath"] ??
          rawInput["filePath"] ??
          rawInput["path"] ??
          rawInput["target"],
      );
      return {
        canonicalTool: "Read",
        kind: "read",
        title: cleanRead || "Read",
        input: readPath && rawInput["file_path"] === undefined ? { ...rawInput, file_path: readPath } : rawInput,
      };
    }
    case "edit":
    case "delete":
    case "move": {
      const cleanEdit = trimmedTitle.replace(/^File\s+/iu, "").trim();
      const editPath = asNonEmptyString(
        rawInput["file_path"] ??
          rawInput["Path"] ??
          rawInput["TargetFile"] ??
          rawInput["FilePath"] ??
          rawInput["filePath"] ??
          rawInput["path"] ??
          rawInput["target"],
      );
      const hasContent = asNonEmptyString(rawInput["Content"] ?? rawInput["content"]) !== null;
      const hasTarget =
        rawInput["Target"] !== undefined ||
        rawInput["old_string"] !== undefined ||
        rawInput["oldString"] !== undefined;
      const canonicalTool = kind === "edit" && hasContent && !hasTarget ? "Write" : "Edit";
      return {
        canonicalTool,
        kind,
        title: cleanEdit || canonicalTool,
        input: editPath && rawInput["file_path"] === undefined ? { ...rawInput, file_path: editPath } : rawInput,
      };
    }
    case "search": {
      if (/\s+on Web$/iu.test(trimmedTitle)) {
        const stripped = trimmedTitle.replace(/\s+on Web$/iu, "").replace(/^"(.*)"$/u, "$1").trim();
        const query = asNonEmptyString(rawInput["query"] ?? rawInput["Query"]) ?? (stripped || trimmedTitle);
        return {
          canonicalTool: "WebSearch",
          kind: "search",
          title: query,
          input: rawInput["query"] === undefined ? { ...rawInput, query } : rawInput,
        };
      }
      if (
        /^Files named\s+/iu.test(trimmedTitle) ||
        asNonEmptyString(
          rawInput["Pattern"] ?? rawInput["SearchDirectory"] ?? rawInput["searchDirectory"],
        ) !== null
      ) {
        const pattern =
          asNonEmptyString(rawInput[" pattern"] ?? rawInput["pattern"] ?? rawInput["Pattern"]) ??
          (/^Files named\s+"([^"]+)"/iu.exec(trimmedTitle)?.[1] ?? null);
        const searchDir = asNonEmptyString(rawInput["SearchDirectory"] ?? rawInput["searchDirectory"]);
        return {
          canonicalTool: "Glob",
          kind: "search",
          title: pattern ?? (trimmedTitle || "Glob"),
          input: {
            ...rawInput,
            ...(pattern && rawInput["pattern"] === undefined ? { pattern } : {}),
            ...(searchDir && rawInput["path"] === undefined ? { path: searchDir } : {}),
          },
        };
      }
      const query =
        asNonEmptyString(rawInput["pattern"] ?? rawInput["Pattern"] ?? rawInput["query"] ?? rawInput["Query"]) ??
        (/^Grep\s+"([^"]+)"/iu.exec(trimmedTitle)?.[1] ??
          /^"([^"]+)"\s+on\s+(?:Code Search|Moma)$/iu.exec(trimmedTitle)?.[1] ??
          null);
      const searchPath = asNonEmptyString(rawInput["SearchPath"] ?? rawInput["searchPath"]);
      return {
        canonicalTool: "Grep",
        kind: "search",
        title: query ?? (trimmedTitle || "Grep"),
        input: {
          ...rawInput,
          ...(query && rawInput["pattern"] === undefined ? { pattern: query } : {}),
          ...(searchPath && rawInput["path"] === undefined ? { path: searchPath } : {}),
        },
      };
    }
    case "execute": {
      const cmd =
        asNonEmptyString(rawInput["command"] ?? rawInput["CommandLine"] ?? rawInput["commandLine"] ?? rawInput["cmd"]) ??
        (trimmedTitle || null);
      const execCwd = asNonEmptyString(
        rawInput["cwd"] ?? rawInput["Cwd"] ?? rawInput["WorkingDirectory"] ?? rawInput["workingDirectory"],
      );
      const input =
        (cmd && rawInput["command"] === undefined) || (execCwd && rawInput["cwd"] === undefined)
          ? {
              ...rawInput,
              ...(cmd && rawInput["command"] === undefined ? { command: cmd } : {}),
              ...(execCwd && rawInput["cwd"] === undefined ? { cwd: execCwd } : {}),
            }
          : rawInput;
      return {
        canonicalTool: "Bash",
        kind: "execute",
        title: cmd ?? "Bash",
        input,
      };
    }
    case "fetch":
      return {
        canonicalTool: "WebFetch",
        kind: "fetch",
        title: trimmedTitle || "WebFetch",
        input: rawInput,
      };
    case "think":
      return {
        canonicalTool: "Think",
        kind: "think",
        title: trimmedTitle || "Think",
        input: rawInput,
      };
    default: {
      const fallback = trimmedTitle.length > 0 ? trimmedTitle : "Tool";
      return {
        canonicalTool: fallback,
        kind,
        title: fallback,
        input: rawInput,
      };
    }
  }
}

/** Canonical Moxen tool name for an ACP `toolCall.kind`, so TUI/Desktop render identical badges & verbs. */
export function acpCanonicalToolName(
  kind: string | null,
  title: string | null,
  rawInput?: Record<string, unknown>,
): string {
  return normalizeAcpToolCall(kind, title, rawInput).canonicalTool;
}

export interface AcpExtractedContent {
  readonly output: string | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly diff?: string }>;
  readonly patch: string | null;
  readonly terminalId: string | null;
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
  let terminalId: string | null = null;

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
        if (termId) terminalId = termId;
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
    terminalId,
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

export interface AcpElicitationOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

export interface AcpElicitationQuestion {
  readonly id: string;
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly allowCustomAnswer: boolean;
  readonly options: ReadonlyArray<AcpElicitationOption>;
}

function parseSchemaChoices(raw: unknown): AcpElicitationOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AcpElicitationOption[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const rawConst = rec["const"];
    if (rawConst === undefined || rawConst === null) continue;
    const value = String(rawConst);
    const label = asNonEmptyString(rec["title"]) ?? value;
    const description = asNonEmptyString(rec["description"]);
    options.push({
      label,
      value,
      ...(description ? { description } : {}),
    });
  }
  return options;
}

function parseEnumChoices(rawEnum: unknown, rawNames: unknown): AcpElicitationOption[] {
  if (!Array.isArray(rawEnum)) return [];
  const names = Array.isArray(rawNames) ? rawNames : [];
  const options: AcpElicitationOption[] = [];
  for (let i = 0; i < rawEnum.length; i += 1) {
    const entry = rawEnum[i];
    if (entry === undefined || entry === null) continue;
    const value = String(entry);
    const label = asNonEmptyString(names[i]) ?? value;
    options.push({ label, value });
  }
  return options;
}

/**
 * Convert an ACP `elicitation/create` form payload (`{ message, requestedSchema }`)
 * into Moxen's normalized question list for `user-input.request.opened`.
 */
export function parseAcpElicitationQuestions(params: unknown): {
  readonly message: string;
  readonly questions: AcpElicitationQuestion[];
} {
  const rec = asRecord(params) ?? {};
  const message = asNonEmptyString(rec["message"]) ?? "Agent requested input";
  const schema = asRecord(rec["requestedSchema"]);
  const properties = asRecord(schema?.["properties"]);
  const entries = properties ? Object.entries(properties) : [];

  if (entries.length === 0) {
    return {
      message,
      questions: [
        {
          id: "response",
          question: message,
          header: "Question",
          multiSelect: false,
          allowCustomAnswer: true,
          options: [],
        },
      ],
    };
  }

  const questions: AcpElicitationQuestion[] = [];
  for (const [id, rawField] of entries) {
    const field = asRecord(rawField) ?? {};
    const type = asNonEmptyString(field["type"]);
    const title = asNonEmptyString(field["title"]);
    const description = asNonEmptyString(field["description"]);
    const question = title ?? description ?? (entries.length === 1 ? message : id);
    const header = title ? id : "Question";

    let multiSelect = false;
    let allowCustomAnswer = true;
    let options: AcpElicitationOption[] = [];

    if (type === "boolean") {
      allowCustomAnswer = false;
      options = [
        { label: "Yes", value: "true" },
        { label: "No", value: "false" },
      ];
    } else if (type === "array") {
      multiSelect = true;
      const items = asRecord(field["items"]);
      options = parseSchemaChoices(items?.["anyOf"] ?? items?.["oneOf"]);
      if (options.length === 0) {
        options = parseEnumChoices(items?.["enum"], items?.["enumNames"]);
      }
    } else {
      options = parseSchemaChoices(field["oneOf"] ?? field["anyOf"]);
      if (options.length === 0) {
        options = parseEnumChoices(field["enum"], field["enumNames"]);
      }
    }

    questions.push({
      id,
      question,
      header,
      multiSelect,
      allowCustomAnswer,
      options,
    });
  }

  return { message, questions };
}

function splitMultiSelectAnswer(value: string, knownValues: readonly string[]): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (knownValues.includes(trimmed)) return [trimmed];
  // Match known values greedily in case an option value itself contains ", ".
  if (knownValues.length > 0) {
    const sorted = [...knownValues].sort((a, b) => b.length - a.length);
    const matched: string[] = [];
    let rest = trimmed;
    while (rest.length > 0) {
      const hit = sorted.find(
        (candidate) =>
          rest === candidate ||
          rest.startsWith(`${candidate}, `) ||
          rest.startsWith(`${candidate},`),
      );
      if (hit) {
        matched.push(hit);
        rest = rest.slice(hit.length).replace(/^,\s*/, "").trim();
      } else {
        const comma = rest.indexOf(",");
        if (comma === -1) {
          matched.push(rest);
          break;
        }
        const part = rest.slice(0, comma).trim();
        if (part) matched.push(part);
        rest = rest.slice(comma + 1).trim();
      }
    }
    return matched;
  }
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Convert submitted Moxen `ProviderUserInputAnswers` into an ACP `elicitation/create`
 * `{ action: "accept", content }` payload conforming to `requestedSchema`.
 */
export function buildAcpElicitationResponse(
  params: unknown,
  answers: Readonly<Record<string, string>>,
): { readonly action: "accept"; readonly content: Record<string, unknown> } {
  const schema = asRecord(asRecord(params)?.["requestedSchema"]);
  const properties = asRecord(schema?.["properties"]);
  const content: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(answers)) {
    const field = asRecord(properties?.[key]);
    const type = asNonEmptyString(field?.["type"]);
    if (type === "boolean") {
      const lower = rawValue.trim().toLowerCase();
      content[key] = lower === "true" || lower === "yes" || lower === "1";
    } else if (type === "number" || type === "integer") {
      const num = Number(rawValue);
      if (!Number.isFinite(num) || (type === "integer" && !Number.isInteger(num))) {
        throw new CliError("INVALID_ANSWER", `Field "${key}" requires a ${type}.`);
      }
      content[key] = num;
    } else if (type === "array") {
      const items = asRecord(field?.["items"]);
      const choices = [
        ...parseSchemaChoices(items?.["anyOf"] ?? items?.["oneOf"]),
        ...parseEnumChoices(items?.["enum"], items?.["enumNames"]),
      ];
      content[key] = splitMultiSelectAnswer(
        rawValue,
        choices.map((choice) => choice.value),
      );
    } else {
      content[key] = rawValue;
    }
  }

  return { action: "accept", content };
}

export function isAcpAuthErrorText(text: string): boolean {
  return /\b(auth(?:entication|orization)?\s+required|unauthenticated|unauthorized|not\s+logged\s+in|sign\s+in|login\s+required)\b/i.test(text);
}

export function isAcpSessionNotFoundText(text: string): boolean {
  return /\b(session\s+not\s+found|unknown\s+session|no\s+such\s+session|invalid\s+session|not\s+found)\b/i.test(text);
}

export interface AcpUsageUpdate {
  readonly used: number;
  readonly size: number | null;
  readonly costUsd?: number;
}

function finiteNonNeg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseAcpCostUsd(raw: unknown): number | undefined {
  const direct = finiteNonNeg(raw);
  if (direct !== null) return direct;
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const currency = asNonEmptyString(rec["currency"]);
  if (currency !== null && currency.toUpperCase() !== "USD") return undefined;
  const amount = finiteNonNeg(rec["amount"]);
  return amount === null ? undefined : amount;
}

/**
 * Parse an ACP `sessionUpdate: "usage_update"` payload (`{ used, size, cost? }`).
 */
export function parseAcpUsageUpdate(update: unknown): AcpUsageUpdate | null {
  const rec = asRecord(update);
  if (!rec) return null;
  const used = finiteNonNeg(rec["used"]);
  if (used === null) return null;
  const rawSize = finiteNonNeg(rec["size"]);
  const size = rawSize !== null && rawSize > 0 ? Math.round(rawSize) : null;
  const costUsd = parseAcpCostUsd(rec["cost"]);
  return {
    used: Math.round(used),
    size,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * Parse per-turn token usage from an ACP `session/prompt` result (`result.usage`).
 * Accepts both ACP v1 camelCase (`inputTokens`, `cachedReadTokens`, `thoughtTokens`)
 * and snake_case variants defensively.
 */
export function parseAcpTurnUsage(raw: unknown): {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly output: number;
  readonly thinking: number;
  readonly costUsd?: number;
} | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const input = finiteNonNeg(rec["inputTokens"]) ?? finiteNonNeg(rec["input_tokens"]);
  const output = finiteNonNeg(rec["outputTokens"]) ?? finiteNonNeg(rec["output_tokens"]);
  const cacheRead =
    finiteNonNeg(rec["cachedReadTokens"])
    ?? finiteNonNeg(rec["cacheReadTokens"])
    ?? finiteNonNeg(rec["cache_read_tokens"])
    ?? 0;
  const cacheCreate =
    finiteNonNeg(rec["cachedWriteTokens"])
    ?? finiteNonNeg(rec["cacheWriteTokens"])
    ?? finiteNonNeg(rec["cache_write_tokens"])
    ?? 0;
  const thinking =
    finiteNonNeg(rec["thoughtTokens"])
    ?? finiteNonNeg(rec["thinkingTokens"])
    ?? finiteNonNeg(rec["thinking_tokens"])
    ?? 0;
  const total = finiteNonNeg(rec["totalTokens"]) ?? finiteNonNeg(rec["total_tokens"]);
  if (input === null && output === null && total === null && cacheRead === 0 && cacheCreate === 0 && thinking === 0) {
    return null;
  }
  const costUsd = parseAcpCostUsd(rec["cost"] ?? rec["costUsd"] ?? rec["cost_usd"]);
  return {
    input: Math.round(input ?? 0),
    cacheRead: Math.round(cacheRead),
    cacheCreate: Math.round(cacheCreate),
    output: Math.round(output ?? 0),
    thinking: Math.round(thinking),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

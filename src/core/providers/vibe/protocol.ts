/**
 * Mistral Vibe `vibe-app-server` JSON-RPC 2.0 wire contract, JSON-Patch
 * applicator, and defensive payload readers.
 *
 * Verified against `mistral-vibe` v3.1.4 (`vibe/app_server/protocol.py`,
 * `vibe/app_server/models.py`, `vibe/app_server/_effect_models.py`, and live
 * `vibe-app-server` probes). Every payload is read defensively to tolerate
 * additive fields across Vibe updates.
 */
import { createHash } from "node:crypto";

import { createTwoFilesPatch } from "diff";

import type { ModelSummary } from "../../catalog/summary.js";
import { outOfProcess, type McpServerSpec } from "../../mcp.js";
import type { ContextBreakdown, ProviderImage } from "../spi.js";
import type { RuntimeMode } from "../../types.js";

export const VIBE_METHODS = {
  // Lifecycle & passive host queries
  initialize: "initialize",
  initialized: "initialized",
  setupStatus: "setup/status",
  configRead: "config/read",
  agentsList: "agents/list",
  skillsList: "skills/list",
  // Session lifecycle
  sessionStart: "session/start",
  sessionResume: "session/resume",
  sessionStop: "session/stop",
  sessionDelete: "session/delete",
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionRewindRead: "session/rewind/read",
  sessionRewind: "session/rewind",
  sessionContextRead: "session/context/read",
  sessionTitleUpdate: "session/title/update",
  sessionRename: "session/rename",
  sessionApprovalPolicyUpdate: "session/approvalPolicy/update",
  sessionBackgroundProcessOutput: "session/backgroundProcess/output",
  sessionBackgroundProcessStop: "session/backgroundProcess/stop",
  // Account & runtime (session-scoped)
  accountRead: "account/read",
  providerAuthRead: "providerAuth/read",
  runtimeRead: "runtime/read",
  configModelWrite: "config/model/write",
  // Turns & callbacks
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
  callbackResult: "callback/result",
  // Server → Client requests
  callbackCall: "callback/call",
  clientToolReadTextFile: "clientTool/readTextFile",
  clientToolWriteTextFile: "clientTool/writeTextFile",
  clientToolTerminalCreate: "clientTool/terminal/create",
  clientToolTerminalWait: "clientTool/terminal/wait",
  clientToolTerminalOutput: "clientTool/terminal/output",
  clientToolTerminalKill: "clientTool/terminal/kill",
  clientToolTerminalRelease: "clientTool/terminal/release",
  // Server → Client notifications
  sessionSnapshot: "session/snapshot",
  sessionUpdated: "session/updated",
  sessionCompacted: "session/compacted",
  sessionContextCleared: "session/contextCleared",
  historyEntryAdded: "history/entryAdded",
  historyEntryUpdated: "history/entryUpdated",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnQueueUpdated: "turn/queueUpdated",
  statsUpdated: "session/statsUpdated",
  childSessionUpdated: "session/childSessionUpdated",
} as const;

/**
 * Vibe's built-in subagent tool (`task`) is always disabled so delegation runs
 * through Moxen's tracked `delegate` threads instead of hidden native subagents.
 */
export const VIBE_ALWAYS_DISABLED_TOOLS: readonly string[] = ["task"];

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

export interface VibeJsonPatchOp {
  readonly op: "add" | "append" | "replace" | "remove" | "test";
  readonly path: string;
  readonly value?: unknown;
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerSegments(pointer: string): string[] {
  if (!pointer || pointer === "/") return [];
  const trimmed = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  return trimmed.split("/").map(unescapePointerSegment);
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

/**
 * Apply `vibe-app-server`'s RFC 6902 + `append` JSON-Patch operations
 * (`vibe/app_server/_patch.py`) without mutating the input document.
 */
export function applyVibeJsonPatch(doc: unknown, rawOps: unknown): unknown {
  if (!Array.isArray(rawOps) || rawOps.length === 0) return doc;
  let root = cloneJson(doc);
  for (const rawOp of rawOps) {
    const rec = asRecord(rawOp);
    const op = asString(rec?.["op"]);
    const ptr = asString(rec?.["path"]);
    if (!op || ptr === null) continue;
    const value = rec?.["value"];
    const segments = pointerSegments(ptr);
    if (segments.length === 0) {
      if (op === "replace" || op === "add") root = cloneJson(value);
      else if (op === "append" && typeof root === "string" && typeof value === "string") root = root + value;
      continue;
    }
    let parent: unknown = root;
    let missing = false;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (Array.isArray(parent)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          missing = true;
          break;
        }
        parent = parent[idx];
      } else if (parent !== null && typeof parent === "object") {
        parent = (parent as Record<string, unknown>)[seg];
      } else {
        missing = true;
        break;
      }
    }
    if (missing || parent === null || typeof parent !== "object") continue;
    const leaf = segments[segments.length - 1]!;
    if (Array.isArray(parent)) {
      if (op === "add") {
        if (leaf === "-") {
          parent.push(cloneJson(value));
        } else {
          const idx = Number(leaf);
          if (Number.isInteger(idx) && idx >= 0 && idx <= parent.length) {
            parent.splice(idx, 0, cloneJson(value));
          }
        }
      } else if (op === "replace") {
        const idx = Number(leaf);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) {
          parent[idx] = cloneJson(value);
        }
      } else if (op === "remove") {
        const idx = Number(leaf);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) {
          parent.splice(idx, 1);
        }
      } else if (op === "append") {
        const idx = Number(leaf);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) {
          const cur = parent[idx];
          if (typeof cur === "string" && typeof value === "string") parent[idx] = cur + value;
        }
      }
    } else {
      const target = parent as Record<string, unknown>;
      if (op === "add" || op === "replace") {
        target[leaf] = cloneJson(value);
      } else if (op === "remove") {
        delete target[leaf];
      } else if (op === "append") {
        const cur = target[leaf];
        if (typeof cur === "string" && typeof value === "string") {
          target[leaf] = cur + value;
        } else if (cur === undefined && typeof value === "string") {
          target[leaf] = value;
        }
      }
    }
  }
  return root;
}

/** Map Moxen's `RuntimeMode` to Vibe's approval policies (`ask`, `accept-edits`, `auto-approve`). */
export function vibeApprovalPolicyForRuntimeMode(mode: RuntimeMode | undefined): string {
  switch (mode) {
    case "approval-required":
      return "ask";
    case "auto-accept-edits":
      return "accept-edits";
    case "auto":
      // Keep tool callbacks flowing to Moxen in `auto` mode so our worktree
      // and command-safety checks can gate risky calls cleanly.
      return "ask";
    case "full-access":
      return "auto-approve";
    default:
      return "accept-edits";
  }
}

/**
 * Convert Moxen `McpServerSpec[]` into `vibe-app-server`'s `SessionMCPServer[]`.
 * Vibe supports `stdio` and `streamable-http` (`http` / `streamable-http`).
 */
export function vibeMcpServersOf(servers: readonly McpServerSpec[] | undefined): Array<Record<string, unknown>> {
  if (!servers || servers.length === 0) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const spec of servers) {
    const server = outOfProcess(spec);
    if (server.type === "stdio") {
      out.push({
        transport: "stdio",
        name: server.name,
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
      });
    } else if (server.type === "http") {
      out.push({
        transport: "streamable-http",
        name: server.name,
        url: server.url,
        ...(Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
      });
    }
  }
  return out;
}

/**
 * Vibe's MCP server alias normalization (`normalize_mcp_server_name`,
 * `mistral-vibe` v3.1.4): characters outside `[a-zA-Z0-9_-]` become `_`,
 * leading/trailing `_`/`-` are stripped, and the result is cut to 256 chars.
 * Iterates code points so an astral character is one replacement, as Python
 * does (a UTF-16 `.replace` would emit two underscores).
 */
function vibeMcpServerAlias(name: string): string {
  const replaced = [...name].map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_")).join("");
  return replaced.replace(/^[_-]+/, "").replace(/[_-]+$/, "").slice(0, 256);
}

/**
 * Vibe's identifier normalization (`_normalize_identifier` in
 * `mistralai_vibe_local_harness/vibe/_mcp_naming.py`): code-point wise, every
 * character outside `[A-Za-z0-9_$]` becomes a single `_`, and a leading digit
 * gains a `_` prefix.
 */
function vibeMcpIdentifier(value: string): string {
  const normalized = [...value].map((ch) => (/[A-Za-z0-9_$]/.test(ch) ? ch : "_")).join("") || "_";
  return /^[0-9]/.test(normalized) ? `_${normalized}` : normalized;
}

/**
 * Map Moxen's per-tool MCP exclusions (`mcp__<server>__<tool>`) onto Vibe's
 * `disabledTools` filter. Verified against `mistral-vibe` v3.1.4 (unified
 * harness, the required default runtime): a tool is published under the
 * display name built from the normalized server alias and the remote tool
 * name (`_display_names`), and `disabledTools` entries are case-insensitive
 * fnmatch globs or `re:` regex full matches against that name
 * (`MCPToolFilter`). A disabled tool is left out of both the published tool
 * list and the route table, so it can neither be listed nor invoked.
 *
 * The published name is either the normalized `<alias>_<tool>` base, or — when
 * another identity claims the same base — that base plus this identity's own
 * `_<sha256(alias "\0" tool) hex>` collision suffix (a prefix of the digest,
 * length 8–64). The pattern matches the base and exactly those own-digest
 * forms, never an arbitrary hex suffix, so a sibling tool such as
 * `demo_write_file` or `demo_write_deadbeef`, and a different server's
 * colliding tool (a different digest), stay available.
 *
 * Limit: two offered servers whose aliases normalize identically (e.g. `demo`
 * and `_demo_`) produce the same digest for the same tool, so their published
 * names are indistinguishable and an exclusion of one necessarily covers the
 * other. Exclusions for a server that is not offered need no pattern: its
 * tools cannot run anyway.
 */
export function vibeDisabledMcpToolPatterns(
  servers: readonly McpServerSpec[] | undefined,
  disabled: readonly string[] | undefined,
): string[] {
  if (!servers || servers.length === 0 || !disabled || disabled.length === 0) return [];
  const patterns = new Set<string>();
  for (const server of servers) {
    const prefix = `mcp__${server.name}__`;
    const alias = vibeMcpServerAlias(server.name);
    for (const name of disabled) {
      if (!name.startsWith(prefix)) continue;
      const tool = name.slice(prefix.length);
      if (tool.length === 0) continue;
      const base = vibeMcpIdentifier(`${alias}_${tool}`);
      const digest = createHash("sha256").update(`${alias}\0${tool}`, "utf8").digest("hex");
      // Optional own-digest suffix: `_` + digest[:8] + an optional prefix of
      // digest[8:], i.e. digest[:n] for any n in 8..64 (nested optionals).
      let tail = "";
      for (let i = digest.length - 1; i >= 8; i -= 1) {
        tail = `(?:${digest[i]}${tail})?`;
      }
      const escaped = base.replace(/[^A-Za-z0-9_]/g, "\\$&");
      patterns.add(`re:${escaped}(?:_${digest.slice(0, 8)}${tail})?`);
    }
  }
  return [...patterns];
}

/** Build `TurnStartParams.message` / `TurnSteerParams.message` content blocks. */
export function buildVibeMessageBlocks(
  prompt: string,
  images?: readonly ProviderImage[],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (prompt.length > 0 || !images || images.length === 0) {
    blocks.push({ type: "text", text: prompt });
  }
  for (const image of images ?? []) {
    blocks.push({
      type: "image",
      attachment: {
        source: { kind: "inline", data: image.data },
        alias: image.name,
        mimeType: image.mimeType,
      },
    });
  }
  return blocks;
}

export interface VibeModelEntry {
  readonly alias: string;
  readonly name: string;
  readonly displayName: string;
  readonly thinking: string | null;
  readonly thinkingLevels: readonly string[];
  readonly maxContextLength: number | null;
  readonly autoCompactThreshold: number | null;
  readonly supportsImages: boolean;
  readonly locked: boolean;
}

export function parseVibeConfigModels(rawConfigRead: unknown): {
  readonly activeAlias: string | null;
  readonly models: VibeModelEntry[];
} {
  const root = asRecord(rawConfigRead);
  const cfg = asRecord(root?.["config"]) ?? root;
  if (!cfg) return { activeAlias: null, models: [] };
  const active = asRecord(cfg["activeModel"]);
  const activeAlias = asNonEmptyString(active?.["alias"]) ?? asNonEmptyString(cfg["defaultModelAlias"]);
  const rawModels = Array.isArray(cfg["models"]) ? cfg["models"] : [];
  const models: VibeModelEntry[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const item = asRecord(entry);
    if (!item) continue;
    const alias = asNonEmptyString(item["alias"]) ?? asNonEmptyString(item["name"]);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    const levels = Array.isArray(item["thinkingLevels"])
      ? item["thinkingLevels"].filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    models.push({
      alias,
      name: asNonEmptyString(item["name"]) ?? alias,
      displayName: asNonEmptyString(item["displayName"]) ?? alias,
      thinking: asNonEmptyString(item["thinking"]),
      thinkingLevels: levels,
      maxContextLength: asNumber(item["maxContextLength"]),
      autoCompactThreshold: asNumber(item["autoCompactThreshold"]),
      supportsImages: item["supportsImages"] === true,
      locked: item["requires"] !== null && item["requires"] !== undefined,
    });
  }
  return { activeAlias, models };
}

function titleCaseEffort(level: string): string {
  return level.length > 0 ? level[0]!.toUpperCase() + level.slice(1) : level;
}

export function vibeModelsToSummaries(
  entries: readonly VibeModelEntry[],
  activeAlias: string | null,
): ModelSummary[] {
  const unlocked = entries.filter((m) => !m.locked);
  const list = unlocked.length > 0 ? unlocked : entries;
  const summaries: ModelSummary[] = list.map((m) => {
    const choices = m.thinkingLevels.map((level) => ({
      id: level,
      label: titleCaseEffort(level),
      isDefault: level === m.thinking,
    }));
    return {
      slug: m.alias,
      name: m.displayName,
      isCustom: false,
      isHidden: false,
      isDefault: activeAlias !== null && m.alias === activeAlias,
      ...(m.maxContextLength !== null ? { contextWindow: m.maxContextLength } : {}),
      efforts: choices.length > 0
        ? [{ id: "effort", label: "Thinking", choices, currentValue: m.thinking }]
        : [],
    };
  });
  if (summaries.length > 0 && !summaries.some((s) => s.isDefault)) {
    summaries[0] = { ...summaries[0]!, isDefault: true };
  }
  return summaries;
}

export interface VibeAccountSnapshot {
  readonly status: string;
  readonly planKind: string | null;
  readonly planName: string | null;
  readonly planTitle: string | null;
  readonly budget: {
    readonly usagePercentage: number;
    readonly resetAt: string | null;
    readonly paygEnabled: boolean;
  } | null;
}

export function parseVibeAccountRead(raw: unknown): VibeAccountSnapshot | null {
  const root = asRecord(raw);
  const account = asRecord(root?.["account"]) ?? root;
  if (!account) return null;
  const status = asNonEmptyString(account["status"]);
  if (!status) return null;
  const plan = asRecord(account["plan"]);
  const budget = asRecord(account["budget"]);
  const pct = asNumber(budget?.["usagePercentage"]);
  return {
    status,
    planKind: asNonEmptyString(plan?.["kind"]),
    planName: asNonEmptyString(plan?.["name"]),
    planTitle: asNonEmptyString(plan?.["title"]),
    budget:
      pct !== null
        ? {
            usagePercentage: Math.max(0, pct),
            resetAt: asNonEmptyString(budget?.["resetAt"]),
            paygEnabled: budget?.["paygEnabled"] === true,
          }
        : null,
  };
}

export interface VibeSetupStatus {
  readonly hasApiKey: boolean;
  readonly activeCredentialSource: string | null;
  readonly activeModel: string | null;
  readonly supportsBrowserSignIn: boolean;
}

export function parseVibeSetupStatus(raw: unknown): VibeSetupStatus {
  const rec = asRecord(raw) ?? {};
  return {
    hasApiKey: rec["hasApiKey"] === true,
    activeCredentialSource: asNonEmptyString(rec["activeCredentialSource"]),
    activeModel: asNonEmptyString(rec["activeModel"]),
    supportsBrowserSignIn: rec["supportsBrowserSignIn"] === true,
  };
}

export interface VibeStatsSnapshot {
  readonly sessionPromptTokens: number;
  readonly sessionCompletionTokens: number;
  readonly sessionCachedTokens: number;
  readonly lastTurnPromptTokens: number;
  readonly lastTurnCompletionTokens: number;
  readonly lastTurnCachedTokens: number;
  readonly contextTokens: number;
  readonly contextWindow: number | null;
}

export function parseVibeStatsUpdated(raw: unknown): VibeStatsSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;
  const stats = asRecord(root["stats"]) ?? root;
  const contextWindow = asNumber(root["contextWindow"]);
  return {
    sessionPromptTokens: asNumber(stats["sessionPromptTokens"]) ?? 0,
    sessionCompletionTokens: asNumber(stats["sessionCompletionTokens"]) ?? 0,
    sessionCachedTokens: asNumber(stats["sessionCachedTokens"]) ?? 0,
    lastTurnPromptTokens: asNumber(stats["lastTurnPromptTokens"]) ?? 0,
    lastTurnCompletionTokens: asNumber(stats["lastTurnCompletionTokens"]) ?? 0,
    lastTurnCachedTokens: asNumber(stats["lastTurnCachedTokens"]) ?? 0,
    contextTokens: asNumber(stats["contextTokens"]) ?? 0,
    contextWindow,
  };
}

const CONTEXT_CATEGORY_LABELS: Record<string, string> = {
  system: "System prompt",
  tools: "Tools",
  skills: "Skills",
  conversation: "Conversation",
};

export function parseVibeContextBreakdown(raw: unknown): ContextBreakdown | null {
  const root = asRecord(raw);
  const b = asRecord(root?.["breakdown"]) ?? root;
  if (!b) return null;
  const usedTokens = asNumber(b["usedTokens"]);
  const maxTokens = asNumber(b["contextWindow"]);
  const threshold = asNumber(b["compactionThreshold"]);
  if (usedTokens === null) return null;
  const measured = b["measured"] === true;
  if (!measured && usedTokens === 0) return null;
  const rawCategories = Array.isArray(b["categories"]) ? b["categories"] : [];
  const categories: Array<{ readonly name: string; readonly tokens: number; readonly kind: "used" | "free" | "buffer" }> = [];
  for (const entry of rawCategories) {
    const rec = asRecord(entry);
    const id = asNonEmptyString(rec?.["id"]);
    const tokens = asNumber(rec?.["estimatedTokens"]);
    if (!id || tokens === null || tokens <= 0) continue;
    categories.push({
      name: CONTEXT_CATEGORY_LABELS[id] ?? id,
      tokens,
      kind: "used",
    });
  }
  if (maxTokens !== null && maxTokens > usedTokens) {
    const bufferTokens = threshold !== null && threshold < maxTokens ? Math.max(0, maxTokens - threshold) : 0;
    const freeTokens = Math.max(0, maxTokens - usedTokens - bufferTokens);
    if (freeTokens > 0) categories.push({ name: "Free space", tokens: freeTokens, kind: "free" });
    if (bufferTokens > 0) categories.push({ name: "Autocompact buffer", tokens: bufferTokens, kind: "buffer" });
  }
  return {
    usedTokens,
    maxTokens,
    cachedInputTokens: null,
    autoCompactThreshold: threshold,
    compactsAutomatically: threshold !== null && threshold > 0,
    categories,
    estimated: categories.length === 0 || !measured,
  };
}

export interface VibeNormalizedEffect {
  readonly callId: string;
  readonly tool: string;
  readonly rawToolName: string;
  readonly kind: string;
  readonly title: string;
  readonly status: "inProgress" | "completed" | "failed";
  readonly stopped: boolean;
  readonly input: Record<string, unknown>;
  readonly output: string | null;
  readonly exit: number | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly diff?: string }>;
  readonly patch: string | null;
  readonly durationMs: number | null;
  readonly todos: ReadonlyArray<{ readonly id: string; readonly content: string; readonly status: string; readonly priority?: string }> | null;
}

export function canonicalVibeToolName(rawToolName: string, kind: string): string {
  const lower = rawToolName.toLowerCase();
  if (kind === "shell" || lower === "bash" || lower === "git_bash" || lower === "powershell" || lower === "shell") {
    return "Bash";
  }
  if (kind === "file_read" || lower === "read_file") return "Read";
  if (kind === "file_write" || lower === "write_file") return "Write";
  if (kind === "file_edit" || lower === "edit") return "Edit";
  if (kind === "file_search" || lower === "grep") return "Grep";
  if (kind === "web_search" || lower === "web_search") return "WebSearch";
  if (kind === "web_fetch" || lower === "web_fetch") return "WebFetch";
  if (kind === "todo" || lower === "todo") return "TodoWrite";
  if (kind === "skill" || lower === "skill") return "Skill";
  if (kind === "user_question" || lower === "ask_user_question") return "AskUserQuestion";
  if (kind === "subagent" || lower === "task") return "Agent";
  return rawToolName;
}

function buildEditDiff(filePath: string, oldText: string, newText: string): string | null {
  try {
    return createTwoFilesPatch(filePath, filePath, oldText, newText, "", "", { context: 3 });
  } catch {
    return null;
  }
}

export function normalizeVibeEffectEntry(entry: Record<string, unknown>): VibeNormalizedEffect | null {
  const id = asNonEmptyString(entry["id"]);
  const detail = asRecord(entry["detail"]);
  const state = asRecord(entry["state"]);
  if (!id || !detail || !state) return null;
  const callId = asNonEmptyString(entry["toolCallId"]) ?? id;
  const kind = asNonEmptyString(detail["kind"]) ?? "tool";
  const rawToolName = asNonEmptyString(detail["toolName"]) ?? kind;
  const tool = canonicalVibeToolName(rawToolName, kind);
  const title = asNonEmptyString(entry["title"]) ?? tool;
  const rawStatus = asNonEmptyString(state["status"]) ?? "running";
  const status: "inProgress" | "completed" | "failed" =
    rawStatus === "completed"
      ? "completed"
      : rawStatus === "failed" || rawStatus === "cancelled" || rawStatus === "skipped"
        ? "failed"
        : "inProgress";
  const stopped = rawStatus === "cancelled";

  const rawInput = asRecord(detail["input"]) ?? {};
  const input: Record<string, unknown> = { ...rawInput };
  // Normalize camelCase Vibe filePath → snake_case file_path for Moxen's tool renderer.
  if (typeof input["filePath"] === "string" && input["file_path"] === undefined) {
    input["file_path"] = input["filePath"];
  }
  if (typeof input["oldString"] === "string" && input["old_string"] === undefined) {
    input["old_string"] = input["oldString"];
  }
  if (typeof input["newString"] === "string" && input["new_string"] === undefined) {
    input["new_string"] = input["newString"];
  }

  let output = asNonEmptyString(state["outputText"]);
  const structuredOutput = asRecord(state["output"]);
  if (!output && structuredOutput) {
    const transcript = asNonEmptyString(structuredOutput["output"]);
    const stdout = asString(structuredOutput["stdout"]) ?? "";
    const stderr = asString(structuredOutput["stderr"]) ?? "";
    if (transcript) {
      output = transcript;
    } else if (stdout || stderr) {
      output = stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : stdout + stderr;
    } else if (typeof structuredOutput["matches"] === "string") {
      output = structuredOutput["matches"];
    } else if (typeof structuredOutput["content"] === "string") {
      output = structuredOutput["content"];
    }
  }
  const errorRec = asRecord(state["error"]);
  if (!output && errorRec) {
    output = asNonEmptyString(errorRec["message"]);
  }

  const files: Array<{ readonly path: string; readonly diff?: string }> = [];
  let patch: string | null = null;
  const filePath =
    asNonEmptyString(input["file_path"]) ??
    asNonEmptyString(structuredOutput?.["file"]) ??
    asNonEmptyString(structuredOutput?.["filePath"]);
  if (kind === "file_edit" && filePath) {
    const oldStr = asString(input["old_string"]) ?? asString(structuredOutput?.["oldString"]);
    const newStr = asString(input["new_string"]) ?? asString(structuredOutput?.["newString"]);
    if (oldStr !== null && newStr !== null) {
      patch = buildEditDiff(filePath, oldStr, newStr);
      files.push(patch ? { path: filePath, diff: patch } : { path: filePath });
    } else {
      files.push({ path: filePath });
    }
  } else if (kind === "file_write" && filePath) {
    const prev = asString(structuredOutput?.["previousContent"]) ?? "";
    const next = asString(input["content"]) ?? asString(structuredOutput?.["content"]) ?? "";
    if (next.length > 0 || prev.length > 0) {
      patch = buildEditDiff(filePath, prev, next);
    }
    files.push(patch ? { path: filePath, diff: patch } : { path: filePath });
  }

  let todos: Array<{ readonly id: string; readonly content: string; readonly status: string; readonly priority?: string }> | null = null;
  if (kind === "todo") {
    const rawTodos = Array.isArray(structuredOutput?.["todos"])
      ? structuredOutput["todos"]
      : Array.isArray(rawInput["todos"])
        ? rawInput["todos"]
        : null;
    if (rawTodos) {
      todos = [];
      for (const item of rawTodos) {
        const rec = asRecord(item);
        const content = asNonEmptyString(rec?.["content"]);
        if (!content) continue;
        todos.push({
          id: asNonEmptyString(rec?.["id"]) ?? content,
          content,
          status: asNonEmptyString(rec?.["status"]) ?? "pending",
          ...(asNonEmptyString(rec?.["priority"]) ? { priority: asNonEmptyString(rec?.["priority"])! } : {}),
        });
      }
    }
  }

  return {
    callId,
    tool,
    rawToolName,
    kind,
    title,
    status,
    stopped,
    input,
    output,
    exit: asNumber(structuredOutput?.["exitCode"]) ?? (status === "failed" && kind === "shell" ? 1 : null),
    files,
    patch,
    durationMs: asNumber(state["durationMs"]),
    todos,
  };
}

export function extractVibeMessageText(entry: Record<string, unknown>): string {
  const blocks = Array.isArray(entry["content"]) ? entry["content"] : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (rec?.["type"] === "text" && typeof rec["text"] === "string") {
      parts.push(rec["text"]);
    }
  }
  return parts.join("\n\n");
}

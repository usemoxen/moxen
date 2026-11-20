/**
 * ACP driver: `ProviderAdapter` + `TurnDriver` over a per-session Agent Client
 * Protocol (ACP) v1 stdio JSON-RPC peer. Thin by design: no Effect Layers, no
 * host services.
 *
 * Pins `ACP_PROTOCOL_VERSION = 1`: `initialize` strictly validates the agent's
 * negotiated `protocolVersion` and refuses mismatches loudly with
 * `ACP_PROTOCOL_VERSION_UNSUPPORTED`. Supports `agy acp` and any configured or
 * registry-supplied ACP agent via `acp/<agent-id>` instance routing.
 */
import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ModelSummary } from "../../catalog/summary.js";
import { CliError } from "../../errors.js";
import { escapes, isolationViolation, rawInputViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import type { ModelSelection, RuntimeMode } from "../../types.js";
import { APP_VERSION } from "../../version.js";
import { assessCommandLine, classifyPath } from "../harness/commandsafety.js";
import { JsonRpcPeer } from "../stdio.js";
import type {
  ApprovalRequestId,
  BackgroundTaskSummary,
  ContextWindowUsage,
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderThreadSnapshot,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  RateLimitWindow,
  ThreadId,
  TokenUsageDelta,
  TurnId,
} from "../spi.js";
import {
  parseAntigravityTier,
  probeAntigravityUsage,
  type AntigravityUsageSnapshot,
} from "../antigravity/usage.js";
import {
  parkTurnWaiter,
  settleAndPublishTurn,
  terminalTurnEvent,
  type TerminalTurnStatus,
  type TurnWaiters,
} from "../turnsettle.js";
import { AcpClientHandlers } from "./clienthandlers.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  acpCanonicalToolName,
  acpMcpServersOf,
  acpStopReasonToStatus,
  asNonEmptyString,
  asRecord,
  asString,
  buildAcpElicitationResponse,
  buildAcpPromptBlocks,
  extractAcpToolContent,
  extractSelectionEffort,
  findAcpEffortOption,
  isAcpAuthErrorText,
  isAcpSessionNotFoundText,
  normalizeAcpToolCall,
  parseAcpAvailableCommands,
  parseAcpCatalogModels,
  parseAcpConfigOptions,
  parseAcpElicitationQuestions,
  parseAcpInitializeResult,
  parseAcpModelsState,
  parseAcpModesState,
  parseAcpPermissionOptions,
  parseAcpTurnUsage,
  parseAcpUsageUpdate,
  selectAcpPermissionOutcome,
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpAuthMethod,
  type AcpAvailableCommand,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpSessionModesState,
  type NormalizedAcpToolCall,
} from "./protocol.js";
import {
  AGY_ACP_LAUNCH_SPEC,
  SpawnAcpTransport,
  type AcpAgentLaunchSpec,
  type AcpTransport,
} from "./transport.js";

export interface AcpDriverOptions {
  /** Provider kind emitted on runtime events (`"acp"` or `"antigravity"`). */
  readonly provider?: "acp" | "antigravity";
  /** Configured ACP agents keyed by id (e.g. `agy`, `cline`). */
  readonly agents?: Readonly<Record<string, AcpAgentLaunchSpec>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly transport?: AcpTransport;
  readonly initializeTimeoutMs?: number;
  readonly promptTimeoutMs?: number;
  /** Idle settle delay (ms) for out-of-turn reactive wakeup turns (`origin: "background"`). */
  readonly backgroundTurnIdleMs?: number;
  /** Shorter settle grace (ms) after a `usage_update` following assistant text in a background turn. */
  readonly backgroundTurnPostUsageIdleMs?: number;
  /** Max time (ms) to wait for an agent to drain a cancelled `session/prompt`. */
  readonly cancelDrainTimeoutMs?: number;
  /** Quiet window (ms) after a timed-out/background cancel before re-enabling out-of-turn wakeups. */
  readonly cancelQuietMs?: number;
  /** Test seam for Antigravity `/usage` + `/credits` probing. */
  readonly probeUsage?: (command: string, env: NodeJS.ProcessEnv, options?: { readonly force?: boolean }) => Promise<AntigravityUsageSnapshot | null>;
}

export interface AcpTurnOutcome {
  readonly status: TerminalTurnStatus;
  readonly text: string;
  readonly usage: TokenUsageDelta | null;
  readonly generation?: { readonly characters: number; readonly durationMs: number };
  readonly error: string | null;
}

interface AcpTranscriptItem {
  readonly kind: "user" | "assistant" | "tool";
  readonly text: string;
  readonly tool?: string;
}

interface AcpMessageSegment {
  readonly id: string;
  text: string;
  isNote: boolean;
}

interface AcpToolState {
  readonly toolCallId: string;
  readonly turnId: TurnId;
  canonicalTool: string;
  rawTitle: string | null;
  rawKind: string | null;
  title: string;
  kind: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  rawInput: Record<string, unknown>;
  input: Record<string, unknown>;
  rawOutput: string | null;
  terminalId: string | null;
  files: ReadonlyArray<{ readonly path: string; readonly diff?: string }>;
  patch: string | null;
  startedAt: number;
  endedAt: number | null;
  recordedInItems: boolean;
}

interface AcpReasoningState {
  readonly id: string;
  text: string;
  readonly startedAt: number;
}

interface AcpTranscriptTurn {
  readonly id: TurnId;
  readonly prompt: string;
  readonly origin?: "user" | "background";
  readonly items: AcpTranscriptItem[];
  status: "running" | TerminalTurnStatus;
  text: string;
  error: string | null;
  readonly segments: AcpMessageSegment[];
  activeSegment: AcpMessageSegment | null;
  activeReasoning: AcpReasoningState | null;
  readonly tools: Map<string, AcpToolState>;
  usage: TokenUsageDelta | null;
  sawUsageUpdate: boolean;
  hasAssistantTextSinceLastTool: boolean;
  awaitingPostUsageSettle: boolean;
  generationChars: number;
  generationMs: number;
  generationStartedAt: number | null;
}

interface ParkedAcpPermission {
  readonly requestId: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly toolName: string;
  readonly sessionKey: string;
  readonly options: ReadonlyArray<AcpPermissionOption>;
  readonly resolve: (response: unknown) => void;
}

interface ParkedAcpUserInput {
  readonly requestId: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly params: unknown;
  readonly resolve: (response: unknown) => void;
}

interface InFlightAcpPrompt {
  readonly turn: AcpTranscriptTurn;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  abandoned: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface AcpSession {
  readonly threadId: ThreadId;
  readonly agent: AcpAgentLaunchSpec;
  readonly peer: JsonRpcPeer;
  readonly clientHandlers: AcpClientHandlers;
  readonly workingDirectory: string;
  readonly startedAt: string;
  readonly capabilities: AcpAgentCapabilities;
  readonly agentInfo: AcpAgentInfo;
  readonly authMethods: ReadonlyArray<AcpAuthMethod>;
  readonly isolation: WorktreeIsolation | null;
  readonly delegated: boolean;
  runtimeMode: RuntimeMode;
  acpSessionId: string;
  pendingInstructions: string | null;
  modes: AcpSessionModesState | null;
  configOptions: AcpConfigOption[];
  availableCommands: AcpAvailableCommand[];
  title: string | null;
  context: ContextWindowUsage | null;
  tier: string | null;
  readonly sessionAllowKeys: Set<string>;
  readonly transcript: AcpTranscriptTurn[];
  readonly waiters: TurnWaiters<AcpTurnOutcome>;
  readonly parked: Map<ApprovalRequestId, ParkedAcpPermission>;
  readonly parkedInputs: Map<ApprovalRequestId, ParkedAcpUserInput>;
  readonly backgroundTasks: Map<string, BackgroundTaskSummary>;
  readonly backgroundTimers: Map<string, ReturnType<typeof setTimeout>>;
  backgroundTurnIdleTimer: ReturnType<typeof setTimeout> | null;
  sendingTurn: boolean;
  inFlightPrompt: InFlightAcpPrompt | null;
  suppressingCancelledStream: boolean;
  cancelledStreamQuietTimer: ReturnType<typeof setTimeout> | null;
  cancelledStreamHardTimer: ReturnType<typeof setTimeout> | null;
  usageRefreshInFlight: Promise<void> | null;
  lastForcedUsageRefreshAt: number;
  closed: boolean;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
// Out-of-turn wakeup turns have no explicit ACP end-of-turn signal: wait long enough
// across thinking/streaming/post-tool LLM pauses so replies do not split mid-turn.
const DEFAULT_BACKGROUND_TURN_IDLE_MS = 10_000;
// Once `agy` emits `usage_update` after assistant text, any follow-up `tool_call` lands
// within milliseconds; settle promptly after a short grace window.
const DEFAULT_BACKGROUND_TURN_POST_USAGE_IDLE_MS = 1_500;
const DEFAULT_CANCEL_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_CANCEL_QUIET_MS = 500;
const USAGE_REFRESH_COALESCE_MS = 2_000;

function toCliError(code: string, message: string, cause: unknown, agentLabel?: string): CliError {
  // Auth patterns win even over transport wrappers (`PEER_REQUEST_FAILED`).
  const text = cause instanceof Error ? cause.message : String(cause);
  if (isAcpAuthErrorText(text)) {
    const who = agentLabel ?? "ACP agent";
    return new CliError("ACP_AUTH_REQUIRED", `${who} requires authentication: ${text.slice(0, 200)}`, { cause });
  }
  if (cause instanceof CliError) return cause;
  return new CliError(code, `${message}: ${text.slice(0, 200)}`, { cause });
}

function agentIdOfInstance(instanceId: string | undefined): string {
  if (!instanceId) return AGY_ACP_LAUNCH_SPEC.id;
  const trimmed = instanceId.trim().toLowerCase();
  if (trimmed === "acp") return AGY_ACP_LAUNCH_SPEC.id;
  if (trimmed.startsWith("acp/")) {
    const sub = trimmed.slice("acp/".length).trim();
    return sub.length > 0 ? sub : AGY_ACP_LAUNCH_SPEC.id;
  }
  return trimmed;
}

function permissionClassification(kind: string | null): "command" | "file-change" | "tool" {
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-change";
  return "tool";
}

const PERMISSION_PATH_KEYS: readonly string[] = [
  "file_path",
  "path",
  "filePath",
  "target",
  "targetFile",
  "target_file",
  "notebook_path",
  "directoryPath",
  "directory_path",
  "searchPath",
  "search_path",
  "searchDirectory",
  "search_directory",
  "Path",
  "TargetFile",
  "FilePath",
  "DirectoryPath",
  "SearchPath",
  "SearchDirectory",
];

function collectPermissionPaths(
  toolCall: Record<string, unknown>,
  normalized: NormalizedAcpToolCall,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const str = asNonEmptyString(value);
    if (str && !seen.has(str)) {
      seen.add(str);
      paths.push(str);
    }
  };
  const locations = Array.isArray(toolCall["locations"]) ? toolCall["locations"] : [];
  for (const loc of locations) {
    add(asRecord(loc)?.["path"]);
  }
  const rawInput = asRecord(toolCall["rawInput"]) ?? {};
  for (const source of [normalized.input, rawInput]) {
    for (const key of PERMISSION_PATH_KEYS) {
      add(source[key]);
    }
  }
  return paths;
}

function extractPermissionCommand(
  toolCall: Record<string, unknown>,
  normalized: NormalizedAcpToolCall,
  defaultCwd: string,
): { readonly command: string; readonly cwd: string; readonly hasExplicitCommand: boolean } {
  const rawInput = asRecord(toolCall["rawInput"]) ?? {};
  const explicitCommand =
    asNonEmptyString(
      rawInput["command"] ??
        rawInput["CommandLine"] ??
        rawInput["commandLine"] ??
        rawInput["cmd"] ??
        normalized.input["command"],
    );
  const command = explicitCommand ?? asNonEmptyString(toolCall["title"]) ?? "";
  const cwd =
    asNonEmptyString(
      rawInput["cwd"] ??
        rawInput["Cwd"] ??
        rawInput["WorkingDirectory"] ??
        rawInput["workingDirectory"] ??
        normalized.input["cwd"],
    ) ?? defaultCwd;
  return { command, cwd, hasExplicitCommand: explicitCommand !== null };
}

function checkPermissionIsolation(
  isolation: WorktreeIsolation,
  toolCall: Record<string, unknown>,
  normalized: NormalizedAcpToolCall,
  cwd: string,
): string | null {
  const kind = normalized.kind ?? asNonEmptyString(toolCall["kind"]);
  const rawInput = asRecord(toolCall["rawInput"]) ?? {};
  const isEdit =
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    normalized.canonicalTool === "Edit" ||
    normalized.canonicalTool === "Write";
  const isExec = kind === "execute" || normalized.canonicalTool === "Bash";
  const isRead = kind === "read" || kind === "search" || kind === "think";

  if (isEdit) {
    for (const target of collectPermissionPaths(toolCall, normalized)) {
      if (escapes(isolation, target, cwd)) {
        return `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. ${target} is outside it.`;
      }
    }
  }

  if (isExec) {
    const { command, cwd: commandCwd } = extractPermissionCommand(toolCall, normalized, cwd);
    const violation = isolationViolation(isolation, {
      tool: "Bash",
      input: { command },
      cwd: commandCwd,
    });
    if (violation) return violation;
  }

  if (!isRead) {
    const locations = Array.isArray(toolCall["locations"]) ? toolCall["locations"] : [];
    for (const loc of locations) {
      const target = asNonEmptyString(asRecord(loc)?.["path"]);
      if (target && escapes(isolation, target, cwd)) {
        return `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. ${target} is outside it.`;
      }
    }
    const { command, cwd: commandCwd, hasExplicitCommand } = extractPermissionCommand(toolCall, normalized, cwd);
    if (hasExplicitCommand || commandCwd !== cwd) {
      const violation = isolationViolation(isolation, {
        tool: "Bash",
        input: { command },
        cwd: commandCwd,
      });
      if (violation) return violation;
    }
    const rawViolation = rawInputViolation(isolation, { ...rawInput, ...normalized.input }, cwd);
    if (rawViolation) return rawViolation;
  }

  return null;
}

function resolveAcpModeIdForRuntime(
  modes: AcpSessionModesState | null,
  runtimeMode: RuntimeMode,
  isolated: boolean,
): string | null {
  const available = modes?.availableModes ?? [];
  if (available.length === 0) return null;
  const candidates: readonly string[] =
    runtimeMode === "approval-required"
      ? ["default", "ask", "supervised", "approval-required"]
      : runtimeMode === "auto-accept-edits"
        ? ["accept-edits", "auto-accept-edits", "acceptedits", "accept_edits"]
        : runtimeMode === "auto"
          ? ["auto", "default"]
          : isolated
            ? // Keep isolated sessions routing tool calls through Moxen's permission gate.
              ["default"]
            : ["full-access", "bypass", "bypasspermissions", "yolo", "auto", "accept-edits"];
  for (const candidate of candidates) {
    const hit = available.find((mode) => mode.id.toLowerCase() === candidate);
    if (hit) return hit.id;
  }
  return null;
}

function buildAnswerText(segments: readonly AcpMessageSegment[]): string {
  const answers = segments.filter((seg) => !seg.isNote && seg.text.length > 0);
  if (answers.length > 0) return answers.map((seg) => seg.text).join("\n\n");
  const last = segments.at(-1);
  return last?.text ?? "";
}

const MAX_BACKGROUND_OUTPUT_LINES = 500;

function extractRawOutputText(rawOutput: unknown): string | null {
  if (typeof rawOutput === "string") return rawOutput;
  const rec = asRecord(rawOutput);
  if (rec) {
    const output = asString(rec["output"]);
    if (output !== null) return output;
  }
  if (rawOutput !== undefined && rawOutput !== null) {
    return JSON.stringify(rawOutput);
  }
  return null;
}

function splitOutputLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length > MAX_BACKGROUND_OUTPUT_LINES
    ? lines.slice(lines.length - MAX_BACKGROUND_OUTPUT_LINES)
    : lines;
}

function isLeadingSlashCommand(prompt: string): boolean {
  return /^\/[A-Za-z0-9_:-]+(?:\s|$)/.test(prompt.trimStart());
}

export class AcpDriver implements ProviderAdapter<CliError> {
  readonly provider: "acp" | "antigravity";
  readonly capabilities: ProviderAdapterCapabilities = {
    sessionModelSwitch: "in-session",
    supportsConversationRollback: false,
  };

  private readonly agents: Map<string, AcpAgentLaunchSpec>;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly transport: AcpTransport;
  private readonly initializeTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly backgroundTurnIdleMs: number;
  private readonly backgroundTurnPostUsageIdleMs: number;
  private readonly cancelDrainTimeoutMs: number;
  private readonly cancelQuietMs: number;
  private readonly probeUsageFn: (command: string, env: NodeJS.ProcessEnv, options?: { readonly force?: boolean }) => Promise<AntigravityUsageSnapshot | null>;
  private readonly sessions = new Map<ThreadId, AcpSession>();
  /** ACP session id per Moxen thread, kept past session teardown for resume. */
  private readonly resumable = new Map<ThreadId, string>();
  /** Latest provider-generated session title keyed by ACP session id. */
  private readonly sessionTitles = new Map<string, string>();
  private readonly queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());

  constructor(options: AcpDriverOptions = {}) {
    this.provider = options.provider ?? "acp";
    this.agents = new Map<string, AcpAgentLaunchSpec>([
      [AGY_ACP_LAUNCH_SPEC.id, AGY_ACP_LAUNCH_SPEC],
    ]);
    if (options.agents) {
      for (const [id, spec] of Object.entries(options.agents)) {
        this.agents.set(id.trim().toLowerCase(), spec);
      }
    }
    this.baseEnv = options.env ?? process.env;
    this.transport = options.transport ?? new SpawnAcpTransport();
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.backgroundTurnIdleMs = options.backgroundTurnIdleMs ?? DEFAULT_BACKGROUND_TURN_IDLE_MS;
    this.backgroundTurnPostUsageIdleMs =
      options.backgroundTurnPostUsageIdleMs ??
      Math.min(this.backgroundTurnIdleMs, DEFAULT_BACKGROUND_TURN_POST_USAGE_IDLE_MS);
    this.cancelDrainTimeoutMs = options.cancelDrainTimeoutMs ?? DEFAULT_CANCEL_DRAIN_TIMEOUT_MS;
    this.cancelQuietMs = options.cancelQuietMs ?? DEFAULT_CANCEL_QUIET_MS;
    // When tests inject a fake transport without a custom usage probe, avoid spawning a real `agy` binary.
    this.probeUsageFn =
      options.probeUsage
      ?? (options.transport !== undefined
        ? async () => null
        : (command, env, opts) => probeAntigravityUsage(command, env, opts));
  }

  get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.queue);
  }

  /** Replace the configured ACP agent map live when `providers.acp.agents` changes. */
  setAgents(agents: Readonly<Record<string, AcpAgentLaunchSpec>>): void {
    this.agents.clear();
    this.agents.set(AGY_ACP_LAUNCH_SPEC.id, AGY_ACP_LAUNCH_SPEC);
    for (const [id, spec] of Object.entries(agents)) {
      this.agents.set(id.trim().toLowerCase(), spec);
    }
  }

  readonly sessionTitle = async (cursor: string, _workingDirectory: string): Promise<string | null> => {
    const cached = this.sessionTitles.get(cursor);
    if (cached) return cached;
    for (const session of this.sessions.values()) {
      if (session.acpSessionId === cursor && session.title) return session.title;
    }
    return null;
  };

  /** Probe an ACP agent's initialize handshake (protocol version, capabilities, auth methods) without creating a session. */
  async probeAgent(instanceId: string, cwd: string): Promise<AcpInitializeResult> {
    const result = await this.probeAgentCatalog(instanceId, cwd, { shouldDiscover: () => false });
    return result.init;
  }

  /**
   * Probe an ACP agent's `initialize` handshake and, when the agent supports
   * `session/close` and `shouldDiscover(init)` allows it, open and immediately
   * close a probe session to read live models and per-model effort levels from
   * `configOptions` / `models`.
   */
  async probeAgentCatalog(
    instanceId: string,
    cwd: string,
    options: { readonly shouldDiscover?: (init: AcpInitializeResult) => boolean } = {},
  ): Promise<{
    readonly init: AcpInitializeResult;
    readonly models: ModelSummary[];
    readonly authError: boolean;
    readonly tier: string | null;
  }> {
    const agent = this.resolveAgent(instanceId);
    const peer = this.transport.startPeer({ agent, cwd, env: this.baseEnv });
    try {
      const raw = await peer.request(
        ACP_METHODS.initialize,
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            elicitation: { form: {} },
          },
          clientInfo: { name: "moxen", title: "Moxen", version: APP_VERSION },
        },
        this.initializeTimeoutMs,
      );
      const init = parseAcpInitializeResult(raw, agent.name ?? agent.id);
      const wantModels = (options.shouldDiscover?.(init) ?? true) && init.agentCapabilities.canCloseSession;
      if (!wantModels) {
        return { init, models: [], authError: false, tier: null };
      }

      let probeSessionId: string | null = null;
      try {
        const newRaw = await peer.request(
          ACP_METHODS.sessionNew,
          { cwd, mcpServers: [] },
          Math.max(this.initializeTimeoutMs, 10_000),
        );
        const newRec = asRecord(newRaw);
        probeSessionId = asNonEmptyString(newRec?.["sessionId"]);
        const configOptions = parseAcpConfigOptions(newRec?.["configOptions"]);
        const modelsState = parseAcpModelsState(newRec?.["models"]);
        const models = parseAcpCatalogModels(configOptions, modelsState);
        const tier = parseAntigravityTier(newRec);
        return { init, models, authError: false, tier };
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        return { init, models: [], authError: isAcpAuthErrorText(text), tier: null };
      } finally {
        if (probeSessionId) {
          await peer.request(ACP_METHODS.sessionClose, { sessionId: probeSessionId }, 2_000).catch(() => undefined);
        }
      }
    } finally {
      peer.close();
    }
  }

  /** Read the live session metadata advertised by an active ACP session (commands, modes, config options). */
  sessionMetadata(threadId: ThreadId): {
    readonly agentInfo: AcpAgentInfo;
    readonly capabilities: AcpAgentCapabilities;
    readonly modes: AcpSessionModesState | null;
    readonly configOptions: ReadonlyArray<AcpConfigOption>;
    readonly availableCommands: ReadonlyArray<AcpAvailableCommand>;
  } | null {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    return {
      agentInfo: session.agentInfo,
      capabilities: session.capabilities,
      modes: session.modes,
      configOptions: session.configOptions,
      availableCommands: session.availableCommands,
    };
  }

  resumeCursor = (threadId: ThreadId): string | null => {
    return this.sessions.get(threadId)?.acpSessionId ?? this.resumable.get(threadId) ?? null;
  };

  readonly contextUsage = async (threadId: ThreadId): Promise<ContextWindowUsage | null> =>
    this.sessions.get(threadId)?.context ?? null;

  readonly backgroundTasks = (threadId: ThreadId): readonly BackgroundTaskSummary[] =>
    [...(this.sessions.get(threadId)?.backgroundTasks.values() ?? [])];

  /** Live buffer from a client-owned ACP terminal or accumulated output from `tool_call_update`. */
  readonly backgroundTaskOutput = async (
    threadId: ThreadId,
    taskId: string,
  ): Promise<{ readonly lines: readonly string[] } | null> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return null;
    const state = this.findTurnWithTool(session, taskId)?.tools.get(taskId) ?? null;
    let text: string | null = null;
    if (state?.terminalId) {
      const termOut = session.clientHandlers.readTerminalOutput(state.terminalId);
      if (termOut !== null && termOut.length > 0) {
        text = termOut;
      }
    } else if (session.clientHandlers.hasTerminal(taskId)) {
      const termOut = session.clientHandlers.readTerminalOutput(taskId);
      if (termOut !== null && termOut.length > 0) {
        text = termOut;
      }
    }
    if (text === null && state?.rawOutput && state.rawOutput.length > 0) {
      text = state.rawOutput;
    }
    if (text === null) return null;
    return { lines: splitOutputLines(text) };
  };

  /** Stop a client-terminal-backed ACP background task; refuse agent-internal tasks cleanly. */
  readonly stopBackgroundTask = (threadId: ThreadId, taskId: string): Effect.Effect<void, CliError> =>
    this.attempt("ACP_TASK_STOP_FAILED", `Could not stop ACP background task ${taskId}`, async () => {
      const session = this.requireSession(threadId);
      const task = session.backgroundTasks.get(taskId);
      if (!task) {
        throw new CliError(
          "BACKGROUND_TASK_NOT_FOUND",
          `No background task ${taskId} is running on thread ${threadId}.`,
          { exitCode: 3, details: { threadId, taskId } },
        );
      }
      const state = this.findTurnWithTool(session, taskId)?.tools.get(taskId) ?? null;
      const terminalId =
        state?.terminalId ?? (session.clientHandlers.hasTerminal(taskId) ? taskId : null);
      if (!task.stoppable || !terminalId || !session.clientHandlers.stopTerminal(terminalId)) {
        throw new CliError(
          "BACKGROUND_TASK_STOP_UNSUPPORTED",
          `ACP agent "${session.agent.name ?? session.agent.id}" runs this background task internally and cannot stop it independently.`,
          { exitCode: 4, details: { threadId, taskId } },
        );
      }
      this.clearBackgroundPromotionTimer(session, taskId);
      session.backgroundTasks.delete(taskId);
      this.publish({
        type: "background.task",
        provider: this.provider,
        threadId: session.threadId,
        turnId: state?.turnId ?? null,
        taskId,
        status: "stopped",
        description: task.description,
        taskType: task.taskType,
        toolUseId: taskId,
        summary: null,
      });
      this.publish({
        type: "background.tasks.changed",
        provider: this.provider,
        threadId: session.threadId,
        tasks: [...session.backgroundTasks.values()],
      });
    });

  readonly refreshUsage = async (): Promise<{
    readonly key: string;
    readonly windows: ReadonlyArray<RateLimitWindow>;
    readonly credits?: number | null;
  } | null> => {
    if (this.provider !== "antigravity") return null;
    const agent = this.agents.get("antigravity") ?? AGY_ACP_LAUNCH_SPEC;
    const snapshot = await this.probeUsageFn(agent.command, this.baseEnv, { force: true }).catch(() => null);
    if (!snapshot || (snapshot.windows.length === 0 && snapshot.credits === null)) return null;
    return {
      key: "antigravity",
      windows: snapshot.windows,
      ...(snapshot.credits === null ? {} : { credits: snapshot.credits }),
    };
  };

  startSession = (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, CliError> =>
    this.attempt("ACP_START_FAILED", `Could not start ACP session for thread ${input.threadId}`, async () => {
      const existing = this.sessions.get(input.threadId);
      if (existing && !existing.closed) {
        return {
          threadId: existing.threadId,
          provider: this.provider,
          workingDirectory: existing.workingDirectory,
          startedAt: existing.startedAt,
        };
      }

      const agent = this.resolveAgent(input.modelSelection?.instanceId);
      const agentLabel = agent.name ?? agent.id;
      const peer = this.transport.startPeer({
        agent,
        cwd: input.workingDirectory,
        env: this.baseEnv,
      });
      const clientHandlers = new AcpClientHandlers();
      let session: AcpSession | null = null;
      const earlyUpdates: unknown[] = [];

      // Register peer handlers before `session/new` / `session/load` so metadata
      // notifications emitted during session creation/loading are never dropped.
      peer.onNotification((method, params) => {
        if (method !== ACP_METHODS.sessionUpdate) return;
        if (session === null) {
          const updateKind = asNonEmptyString(asRecord(asRecord(params)?.["update"])?.["sessionUpdate"]);
          if (
            updateKind === "available_commands_update" ||
            updateKind === "current_mode_update" ||
            updateKind === "config_option_update" ||
            updateKind === "usage_update" ||
            updateKind === "session_info_update"
          ) {
            earlyUpdates.push(params);
          }
          return;
        }
        if (session.closed) return;
        this.handleSessionUpdate(session, params);
      });

      peer.onRequest(async (method, params) => {
        if (session !== null) {
          if (session.closed) {
            throw new CliError("SESSION_CLOSED", "ACP session is closed.");
          }
          return this.handlePeerRequest(session, method, params);
        }
        const clientCtx = {
          workingDirectory: input.workingDirectory,
          isolation: input.isolation ?? null,
          env: this.baseEnv,
        };
        return this.handleClientMethod(clientHandlers, clientCtx, method, params);
      });

      peer.onExit((code) => {
        if (!session || session.closed) return;
        this.closeSession(
          session,
          "failed",
          `ACP agent "${session.agent.name ?? session.agent.id}" exited unexpectedly (code ${String(code)}).`,
        );
      });

      try {
        const initRaw = await peer.request(
          ACP_METHODS.initialize,
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
              elicitation: { form: {} },
            },
            clientInfo: { name: "moxen", title: "Moxen", version: APP_VERSION },
          },
          this.initializeTimeoutMs,
        );
        const init = parseAcpInitializeResult(initRaw, agentLabel);

        const mcpServers = acpMcpServersOf(input.mcpServers, init.agentCapabilities.mcpCapabilities);
        let acpSessionId: string | null = null;
        let modes: AcpSessionModesState | null = null;
        let configOptions: AcpConfigOption[] = [];
        let tier: string | null = null;
        let initialTitle: string | null = null;
        let resumed = false;

        if (input.resumeCursor && init.agentCapabilities.loadSession) {
          try {
            const loadRaw = await peer.request(
              ACP_METHODS.sessionLoad,
              {
                sessionId: input.resumeCursor,
                cwd: input.workingDirectory,
                mcpServers,
              },
              this.initializeTimeoutMs,
            );
            const loadRec = asRecord(loadRaw);
            acpSessionId = asNonEmptyString(loadRec?.["sessionId"]) ?? input.resumeCursor;
            modes = parseAcpModesState(loadRec?.["modes"]);
            configOptions = parseAcpConfigOptions(loadRec?.["configOptions"]);
            tier = parseAntigravityTier(loadRec);
            initialTitle = asNonEmptyString(loadRec?.["title"])?.trim() ?? null;
            resumed = true;
          } catch (cause) {
            const text = cause instanceof Error ? cause.message : String(cause);
            // Never silently replace a conversation when resume fails for auth.
            if (isAcpAuthErrorText(text)) {
              throw toCliError("ACP_AUTH_REQUIRED", `Could not resume ACP session for ${agentLabel}`, cause, agentLabel);
            }
            if (!isAcpSessionNotFoundText(text)) {
              throw toCliError("ACP_RESUME_FAILED", `Could not resume ACP session for ${agentLabel}`, cause, agentLabel);
            }
          }
        }

        if (!acpSessionId) {
          const newRaw = await peer.request(
            ACP_METHODS.sessionNew,
            {
              cwd: input.workingDirectory,
              mcpServers,
            },
            this.initializeTimeoutMs,
          );
          const newRec = asRecord(newRaw);
          acpSessionId = asNonEmptyString(newRec?.["sessionId"]);
          if (!acpSessionId) {
            throw new CliError("ACP_SESSION_INVALID", `${agentLabel} returned no sessionId from session/new.`);
          }
          modes = parseAcpModesState(newRec?.["modes"]);
          configOptions = parseAcpConfigOptions(newRec?.["configOptions"]);
          tier = parseAntigravityTier(newRec);
          initialTitle = asNonEmptyString(newRec?.["title"])?.trim() ?? null;
        }

        if (initialTitle) {
          this.sessionTitles.set(acpSessionId, initialTitle);
        }

        const startedAt = new Date().toISOString();
        session = {
          threadId: input.threadId,
          agent,
          peer,
          clientHandlers,
          workingDirectory: input.workingDirectory,
          startedAt,
          capabilities: init.agentCapabilities,
          agentInfo: init.agentInfo,
          authMethods: init.authMethods,
          isolation: input.isolation ?? null,
          delegated: input.delegated === true,
          runtimeMode: input.runtimeMode ?? "auto",
          acpSessionId,
          pendingInstructions: !resumed && input.instructions?.trim() ? input.instructions.trim() : null,
          modes,
          configOptions,
          availableCommands: [],
          title: initialTitle,
          context: null,
          tier,
          sessionAllowKeys: new Set(),
          transcript: [],
          waiters: new Map(),
          parked: new Map(),
          parkedInputs: new Map(),
          backgroundTasks: new Map(),
          backgroundTimers: new Map(),
          backgroundTurnIdleTimer: null,
          sendingTurn: false,
          inFlightPrompt: null,
          suppressingCancelledStream: false,
          cancelledStreamQuietTimer: null,
          cancelledStreamHardTimer: null,
          usageRefreshInFlight: null,
          lastForcedUsageRefreshAt: 0,
          closed: false,
        };

        this.sessions.set(input.threadId, session);
        this.resumable.set(input.threadId, acpSessionId);

        // Flush startup notifications buffered during `session/new` or `session/load`.
        for (const buffered of earlyUpdates) {
          const updateSessionId = asNonEmptyString(asRecord(buffered)?.["sessionId"]);
          if (updateSessionId && updateSessionId !== acpSessionId) continue;
          this.handleSessionUpdate(session, buffered);
        }

        // Apply initial model and effort selections if the agent exposes config options.
        if (input.modelSelection) {
          await this.applySelectionConfigOptions(session, input.modelSelection);
        }

        // Apply configured defaultMode or the session's runtimeMode via `session/set_mode`.
        if (session.agent.defaultMode) {
          await this.applySessionMode(session, session.agent.defaultMode);
        } else {
          await this.syncSessionMode(session);
        }

        if (this.provider === "antigravity") {
          void this.refreshAntigravityUsage(session);
        }

        return {
          threadId: session.threadId,
          provider: this.provider,
          workingDirectory: session.workingDirectory,
          startedAt: session.startedAt,
        };
      } catch (cause) {
        clientHandlers.closeAll();
        peer.close();
        throw toCliError("ACP_START_FAILED", `Could not start ACP session for ${agentLabel}`, cause, agentLabel);
      }
    });

  sendTurn = (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, CliError> =>
    this.attempt("ACP_TURN_FAILED", `Could not send turn on thread ${input.threadId}`, async () => {
      const session = this.requireSession(input.threadId);
      if (session.sendingTurn || this.openTurn(session)) {
        throw new CliError("ACP_TURN_BUSY", `Thread ${input.threadId} already has a running ACP turn.`);
      }
      session.sendingTurn = true;
      try {
        // Wait for any cancelled prompt to finish flushing so trailing chunks cannot leak into this turn.
        if (session.inFlightPrompt?.abandoned) {
          await session.inFlightPrompt.done;
        }
        if (session.closed) {
          throw new CliError("SESSION_NOT_FOUND", `No active ACP session for thread ${input.threadId}.`);
        }
        if (this.openTurn(session)) {
          throw new CliError("ACP_TURN_BUSY", `Thread ${input.threadId} already has a running ACP turn.`);
        }
        if (input.runtimeMode && input.runtimeMode !== session.runtimeMode) {
          session.runtimeMode = input.runtimeMode;
          await this.syncSessionMode(session);
        } else if (input.runtimeMode) {
          session.runtimeMode = input.runtimeMode;
        }
        if (input.modelSelection) {
          await this.applySelectionConfigOptions(session, input.modelSelection);
        }
        if (session.closed) {
          throw new CliError("SESSION_NOT_FOUND", `No active ACP session for thread ${input.threadId}.`);
        }
        if (this.openTurn(session)) {
          throw new CliError("ACP_TURN_BUSY", `Thread ${input.threadId} already has a running ACP turn.`);
        }

        this.clearCancelledStreamSuppression(session);

        const turnId: TurnId = `acp-turn-${randomUUID()}`;
        const turn: AcpTranscriptTurn = {
          id: turnId,
          prompt: input.prompt,
          origin: "user",
          items: [{ kind: "user", text: input.prompt }],
          status: "running",
          text: "",
          error: null,
          segments: [],
          activeSegment: null,
          activeReasoning: null,
          tools: new Map(),
          usage: null,
          sawUsageUpdate: false,
          hasAssistantTextSinceLastTool: false,
          awaitingPostUsageSettle: false,
          generationChars: 0,
          generationMs: 0,
          generationStartedAt: null,
        };
        session.transcript.push(turn);

        const carriedInstructions =
          session.pendingInstructions && !isLeadingSlashCommand(input.prompt)
            ? session.pendingInstructions
            : null;
        const effectivePrompt = carriedInstructions
          ? `${carriedInstructions}\n\n${input.prompt}`
          : input.prompt;
        if (carriedInstructions !== null) {
          session.pendingInstructions = null;
        }

        const promptBlocks = buildAcpPromptBlocks(
          effectivePrompt,
          input.images,
          session.capabilities.promptCapabilities.image,
        );

        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        const inFlight: InFlightAcpPrompt = {
          turn,
          done,
          resolveDone,
          abandoned: false,
          graceTimer: null,
        };
        session.inFlightPrompt = inFlight;

        void session.peer
          .request(
            ACP_METHODS.sessionPrompt,
            {
              sessionId: session.acpSessionId,
              prompt: promptBlocks,
            },
            this.promptTimeoutMs,
          )
          .then(
            (result) => {
              this.finishInFlightPrompt(session, inFlight);
              if (inFlight.abandoned || turn.status !== "running" || session.closed) return;
              const record = asRecord(result);
              const usage = parseAcpTurnUsage(record?.["usage"]);
              if (usage) {
                turn.usage = usage;
                const fallbackUsed = usage.input + usage.cacheRead + usage.cacheCreate + usage.output;
                const prev = session.context;
                session.context = {
                  usedTokens: turn.sawUsageUpdate && prev ? prev.usedTokens : fallbackUsed,
                  maxTokens: prev?.maxTokens ?? null,
                  cachedInputTokens: usage.cacheRead > 0 ? usage.cacheRead : (prev?.cachedInputTokens ?? null),
                  autoCompactThreshold: prev?.autoCompactThreshold ?? null,
                  compactsAutomatically: prev?.compactsAutomatically ?? null,
                  ...(usage.costUsd !== undefined
                    ? { costUsd: usage.costUsd }
                    : prev?.costUsd !== undefined
                      ? { costUsd: prev.costUsd }
                      : {}),
                };
              }
              const stopReason = record?.["stopReason"];
              const status = acpStopReasonToStatus(stopReason);
              const error = status === "failed" ? `ACP agent refused the turn (${String(stopReason)}).` : null;
              if (
                status === "failed" &&
                carriedInstructions !== null &&
                session.pendingInstructions === null &&
                turn.segments.length === 0 &&
                turn.tools.size === 0
              ) {
                session.pendingInstructions = carriedInstructions;
              }
              this.settleTurn(session, turn, status, error, record ?? undefined);
              if (this.provider === "antigravity") {
                void this.refreshAntigravityUsage(session, true);
              }
            },
            (cause) => {
              this.finishInFlightPrompt(session, inFlight);
              if (inFlight.abandoned || turn.status !== "running" || session.closed) return;
              if (
                carriedInstructions !== null &&
                session.pendingInstructions === null &&
                turn.segments.length === 0 &&
                turn.tools.size === 0
              ) {
                session.pendingInstructions = carriedInstructions;
              }
              if (cause instanceof CliError && cause.code === "PEER_REQUEST_TIMEOUT") {
                this.cancelAllParked(session);
                session.peer.notify(ACP_METHODS.sessionCancel, { sessionId: session.acpSessionId });
                this.startCancelledStreamSuppression(session);
              }
              const agentLabel = session.agent.name ?? session.agent.id;
              const err = toCliError("ACP_TURN_FAILED", `ACP turn failed for ${agentLabel}`, cause, agentLabel);
              this.settleTurn(session, turn, "failed", err.message, { code: err.code, message: err.message });
            },
          );

        return { threadId: input.threadId, turnId };
      } finally {
        session.sendingTurn = false;
      }
    });

  awaitTurn(threadId: ThreadId, turnId: TurnId, signal?: AbortSignal): Promise<AcpTurnOutcome> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return Promise.reject(new CliError("SESSION_NOT_FOUND", `No ACP session for thread ${threadId}.`));
    }
    const turn = session.transcript.find((entry) => entry.id === turnId);
    if (!turn) {
      return Promise.reject(new CliError("TURN_NOT_FOUND", `No ACP turn ${turnId} on thread ${threadId}.`));
    }
    if (turn.status !== "running") {
      return Promise.resolve(this.outcomeOf(turn));
    }
    return parkTurnWaiter({
      waiters: session.waiters,
      turnId,
      signal,
      onAbort: () => new CliError("TURN_ABORTED", `Wait on ACP turn ${turnId} aborted.`),
    });
  }

  interruptTurn = (threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, CliError> =>
    this.attempt("ACP_INTERRUPT_FAILED", `Could not interrupt thread ${threadId}`, async () => {
      const session = this.sessions.get(threadId);
      if (!session || session.closed) return;
      // Settle parked approvals first so the agent's stdin loop never deadlocks.
      this.cancelAllParked(session);
      session.peer.notify(ACP_METHODS.sessionCancel, { sessionId: session.acpSessionId });
      const open = this.openTurn(session);
      if (open) {
        if (session.inFlightPrompt && session.inFlightPrompt.turn === open) {
          this.abandonInFlightPrompt(session, session.inFlightPrompt);
        } else if (open.origin === "background") {
          this.startCancelledStreamSuppression(session);
        }
        this.settleTurn(session, open, "interrupted", null);
      }
    });

  readonly setRuntimeMode = (threadId: ThreadId, mode: RuntimeMode): void => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return;
    session.runtimeMode = mode;
    void this.syncSessionMode(session);
  };

  respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Effect.Effect<void, CliError> =>
    this.attempt("ACP_APPROVAL_FAILED", `Could not answer permission request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      const parked = session.parked.get(requestId);
      if (parked) {
        session.parked.delete(requestId);
        if (decision.kind === "acceptForSession") {
          session.sessionAllowKeys.add(parked.sessionKey);
        }
        // Keep isolated sessions using `allow_once` on the wire so the agent never
        // caches `allow_always` past Moxen's worktree isolation checks.
        const wireDecision: ProviderApprovalDecision =
          decision.kind === "acceptForSession" && session.isolation ? { kind: "accept" } : decision;
        const response = selectAcpPermissionOutcome(wireDecision, parked.options);
        parked.resolve(response);
        this.publish({
          type: "permission.request.resolved",
          provider: this.provider,
          threadId,
          requestId,
          raw: {
            toolName: parked.toolName,
            behavior: decision.kind === "accept" || decision.kind === "acceptForSession" ? "allow" : "deny",
          },
        });
        return;
      }
      // Question dismissal (`userInputDismiss`) routes through `respondToRequest(..., { kind: "decline" })`.
      const parkedInput = session.parkedInputs.get(requestId);
      if (parkedInput) {
        session.parkedInputs.delete(requestId);
        parkedInput.resolve({ action: decision.kind === "cancel" ? "cancel" : "decline" });
        this.publish({
          type: "user-input.request.resolved",
          provider: this.provider,
          threadId,
          requestId,
          raw: { toolName: "AskUserQuestion", behavior: "deny" },
        });
        return;
      }
      throw new CliError("APPROVAL_NOT_FOUND", `No pending ACP approval ${requestId} on thread ${threadId}.`);
    });

  respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, CliError> =>
    this.attempt("ACP_USER_INPUT_FAILED", `Could not answer user input request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      const parked = session.parkedInputs.get(requestId);
      if (!parked) {
        throw new CliError("REQUEST_UNKNOWN", `No pending ACP user input request ${requestId} on thread ${threadId}.`);
      }
      const response = buildAcpElicitationResponse(parked.params, answers);
      session.parkedInputs.delete(requestId);
      parked.resolve(response);
      this.publish({
        type: "user-input.request.resolved",
        provider: this.provider,
        threadId,
        requestId,
        raw: { toolName: "AskUserQuestion", behavior: "allow" },
      });
    });

  stopSession = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    Effect.sync(() => {
      const session = this.sessions.get(threadId);
      if (!session) return;
      this.closeSession(session, "interrupted", null);
    });

  listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() =>
      [...this.sessions.values()]
        .filter((session) => !session.closed)
        .map((session) => ({
          threadId: session.threadId,
          provider: this.provider,
          workingDirectory: session.workingDirectory,
          startedAt: session.startedAt,
        })),
    );

  hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.sync(() => {
      const session = this.sessions.get(threadId);
      return session !== undefined && !session.closed;
    });

  readThread = (threadId: ThreadId): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("ACP_READ_FAILED", `Could not read ACP thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      return this.snapshotOf(session);
    });

  rollbackThread = (threadId: ThreadId, _numTurns: number): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    Effect.fail(
      new CliError(
        "REVERT_UNSUPPORTED",
        `The ${this.provider} driver cannot roll back a conversation: ACP v1 has no conversation rewind RPC.`,
        { exitCode: 4, details: { threadId, provider: this.provider } },
      ),
    );

  stopAll = (): Effect.Effect<void, CliError> =>
    Effect.sync(() => {
      for (const session of [...this.sessions.values()]) {
        this.closeSession(session, "interrupted", null);
      }
    });

  private resolveAgent(instanceId: string | undefined): AcpAgentLaunchSpec {
    const id = agentIdOfInstance(instanceId);
    const spec = this.agents.get(id);
    if (!spec) {
      throw new CliError("ACP_AGENT_UNKNOWN", `No ACP agent configured for "${id}".`, {
        details: { agentId: id },
      });
    }
    return spec;
  }

  private requireSession(threadId: ThreadId): AcpSession {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      throw new CliError("SESSION_NOT_FOUND", `No active ACP session for thread ${threadId}.`);
    }
    return session;
  }

  private openTurn(session: AcpSession): AcpTranscriptTurn | null {
    for (let i = session.transcript.length - 1; i >= 0; i -= 1) {
      const turn = session.transcript[i]!;
      if (turn.status === "running") return turn;
    }
    return null;
  }

  private publish(event: ProviderRuntimeEvent): void {
    Effect.runSync(Queue.offer(this.queue, event));
  }

  private attempt<T>(code: string, message: string, run: () => Promise<T>): Effect.Effect<T, CliError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => toCliError(code, message, cause),
    });
  }

  private async applySelectionConfigOptions(session: AcpSession, selection: ModelSelection): Promise<void> {
    let model = selection.model?.trim() || "";
    let effort = extractSelectionEffort(selection);
    const isSyntheticDefault = model === "" || model === "acp-default" || model === "antigravity-default";

    if (!isSyntheticDefault) {
      const modelOpt = session.configOptions.find((opt) => opt.category === "model" || opt.id === "model");
      if (modelOpt) {
        // Support legacy/CLI combined slugs such as `gemini-4-neon-high` by splitting
        // into base model + effort when the base model exists in `configOptions`.
        if (modelOpt.options.length > 0 && !modelOpt.options.some((opt) => opt.value === model)) {
          const split = modelOpt.options.find((opt) => model.startsWith(`${opt.value}-`));
          if (split) {
            const suffix = model.slice(split.value.length + 1).trim();
            model = split.value;
            if (!effort && suffix.length > 0) effort = suffix;
          }
        }
        await this.setConfigOption(session, modelOpt, model);
      }
    }

    if (effort) {
      // Re-read configOptions after any model switch so effort options match the chosen model.
      const effortOpt = findAcpEffortOption(session.configOptions);
      if (effortOpt) {
        await this.setConfigOption(session, effortOpt, effort);
      }
    }
  }

  private async setConfigOption(session: AcpSession, option: AcpConfigOption, value: string): Promise<void> {
    if (option.currentValue === value) return;
    if (option.options.length > 0 && !option.options.some((opt) => opt.value === value)) return;
    try {
      const updated = asRecord(
        await session.peer.request(
          ACP_METHODS.sessionSetConfigOption,
          {
            sessionId: session.acpSessionId,
            configId: option.id,
            value,
          },
          this.initializeTimeoutMs,
        ),
      );
      if (updated && Array.isArray(updated["configOptions"])) {
        session.configOptions = parseAcpConfigOptions(updated["configOptions"]);
      } else {
        session.configOptions = session.configOptions.map((opt) =>
          opt.id === option.id ? { ...opt, currentValue: value } : opt,
        );
      }
    } catch {
      // Agent declined option switch; keep session running with its current options.
    }
  }

  private async syncSessionMode(session: AcpSession): Promise<void> {
    const targetModeId = resolveAcpModeIdForRuntime(
      session.modes,
      session.runtimeMode,
      session.isolation !== null,
    );
    if (!targetModeId) return;
    await this.applySessionMode(session, targetModeId);
  }

  private async applySessionMode(session: AcpSession, modeId: string): Promise<void> {
    const trimmed = modeId.trim();
    if (!trimmed || session.closed) return;
    if (session.modes?.currentModeId === trimmed) return;
    try {
      await session.peer.request(
        ACP_METHODS.sessionSetMode,
        {
          sessionId: session.acpSessionId,
          modeId: trimmed,
        },
        this.initializeTimeoutMs,
      );
      if (!session.closed) {
        session.modes = {
          currentModeId: trimmed,
          availableModes: session.modes?.availableModes ?? [],
        };
      }
    } catch {
      // Agent declined mode switch or does not support `session/set_mode`; keep session running.
    }
  }

  private async handlePeerRequest(session: AcpSession, method: string, params: unknown): Promise<unknown> {
    if (method === ACP_METHODS.requestPermission) {
      return this.handlePermissionRequest(session, params);
    }
    if (method === ACP_METHODS.elicitationCreate) {
      return this.handleElicitationRequest(session, params);
    }
    const clientCtx = {
      workingDirectory: session.workingDirectory,
      isolation: session.isolation,
      env: this.baseEnv,
    };
    return this.handleClientMethod(session.clientHandlers, clientCtx, method, params);
  }

  private async handleClientMethod(
    clientHandlers: AcpClientHandlers,
    clientCtx: { readonly workingDirectory: string; readonly isolation: WorktreeIsolation | null; readonly env: NodeJS.ProcessEnv },
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case ACP_METHODS.fsReadTextFile:
        return clientHandlers.readTextFile(params, clientCtx);
      case ACP_METHODS.fsWriteTextFile:
        return clientHandlers.writeTextFile(params, clientCtx);
      case ACP_METHODS.terminalCreate:
        return clientHandlers.createTerminal(params, clientCtx);
      case ACP_METHODS.terminalOutput:
        return clientHandlers.terminalOutput(params);
      case ACP_METHODS.terminalWaitForExit:
        return clientHandlers.waitForTerminalExit(params);
      case ACP_METHODS.terminalKill:
        return clientHandlers.killTerminal(params);
      case ACP_METHODS.terminalRelease:
        return clientHandlers.releaseTerminal(params);
      default:
        throw new CliError("ACP_METHOD_NOT_FOUND", `Unsupported ACP client method: ${method}`);
    }
  }

  private handleSessionUpdate(session: AcpSession, params: unknown): void {
    const record = asRecord(params);
    const update = asRecord(record?.["update"]);
    if (!update) return;
    const kind = asNonEmptyString(update["sessionUpdate"]);
    if (!kind) return;

    if (kind === "available_commands_update") {
      session.availableCommands = parseAcpAvailableCommands(update["availableCommands"]);
      return;
    }
    if (kind === "session_info_update") {
      const title = asNonEmptyString(update["title"])?.trim() ?? null;
      if (title && title !== session.title) {
        session.title = title;
        this.sessionTitles.set(session.acpSessionId, title);
        this.publish({
          type: "session.title.updated",
          provider: this.provider,
          threadId: session.threadId,
          title,
        });
      }
      return;
    }
    if (kind === "current_mode_update") {
      const modeId = asNonEmptyString(update["currentModeId"]);
      if (modeId) {
        session.modes = {
          currentModeId: modeId,
          availableModes: session.modes?.availableModes ?? [],
        };
      }
      return;
    }
    if (kind === "config_option_update") {
      session.configOptions = parseAcpConfigOptions(update["configOptions"]);
      return;
    }
    if (kind === "usage_update") {
      const parsed = parseAcpUsageUpdate(update);
      if (parsed) {
        const activeTurn = this.openTurn(session);
        if (activeTurn) {
          activeTurn.sawUsageUpdate = true;
          if (activeTurn.origin === "background") {
            if (activeTurn.hasAssistantTextSinceLastTool) {
              activeTurn.awaitingPostUsageSettle = true;
            }
            this.scheduleBackgroundTurnSettle(session);
          }
        }
        const prev = session.context;
        session.context = {
          usedTokens: parsed.used,
          maxTokens: parsed.size ?? prev?.maxTokens ?? null,
          cachedInputTokens: prev?.cachedInputTokens ?? null,
          autoCompactThreshold: prev?.autoCompactThreshold ?? null,
          compactsAutomatically: prev?.compactsAutomatically ?? null,
          ...(parsed.costUsd !== undefined
            ? { costUsd: parsed.costUsd }
            : prev?.costUsd !== undefined
              ? { costUsd: prev.costUsd }
              : {}),
        };
      }
      return;
    }

    if (kind === "agent_thought_chunk") {
      const content = asRecord(update["content"]);
      const delta = asString(content?.["text"]) ?? asString(update["text"]);
      if (!delta) return;
      if (this.discardIfDrainingCancelledTurn(session)) return;
      const turn = this.openTurn(session) ?? this.startOutOfTurn(session);
      turn.awaitingPostUsageSettle = false;
      this.pauseGenerationTimer(turn);
      if (!turn.activeReasoning) {
        const reasoningId = `acp-reason-${randomUUID()}`;
        const startedAt = Date.now();
        turn.activeReasoning = { id: reasoningId, text: "", startedAt };
        this.publish({
          type: "reasoning.updated",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          reasoningId,
          status: "running",
          text: "",
          startedAt: new Date(startedAt).toISOString(),
          durationMs: null,
        });
      }
      turn.activeReasoning.text += delta;
      this.publish({
        type: "reasoning.delta",
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        reasoningId: turn.activeReasoning.id,
        text: delta,
      });
      this.scheduleBackgroundTurnSettle(session);
      return;
    }

    if (kind === "agent_message_chunk") {
      const content = asRecord(update["content"]);
      const delta = asString(content?.["text"]) ?? asString(update["text"]);
      if (!delta) return;
      if (this.discardIfDrainingCancelledTurn(session)) return;
      const turn = this.openTurn(session) ?? this.startOutOfTurn(session);
      turn.awaitingPostUsageSettle = false;
      turn.hasAssistantTextSinceLastTool = true;
      this.promoteInProgressTools(session, turn);
      this.finishReasoning(session, turn);
      if (!turn.activeSegment) {
        const segment: AcpMessageSegment = { id: `acp-msg-${randomUUID()}`, text: "", isNote: false };
        turn.segments.push(segment);
        turn.activeSegment = segment;
      }
      if (turn.generationStartedAt === null) {
        turn.generationStartedAt = Date.now();
      }
      turn.activeSegment.text += delta;
      turn.generationChars += delta.length;
      this.publish({
        type: "message.part.updated",
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        messageId: turn.activeSegment.id,
        text: delta,
        raw: update,
      });
      this.scheduleBackgroundTurnSettle(session);
      return;
    }

    if (kind === "plan") {
      if (this.discardIfDrainingCancelledTurn(session)) return;
      const turn = this.openTurn(session) ?? this.startOutOfTurn(session);
      turn.awaitingPostUsageSettle = false;
      const rawEntries = Array.isArray(update["entries"]) ? update["entries"] : [];
      const plan = rawEntries
        .map((entry) => {
          const item = asRecord(entry);
          const step = asNonEmptyString(item?.["content"]);
          if (!step) return null;
          const rawStatus = asNonEmptyString(item?.["status"]);
          const status =
            rawStatus === "completed" || rawStatus === "in_progress" ? rawStatus : "pending";
          return { step, status };
        })
        .filter((entry): entry is { step: string; status: "pending" | "in_progress" | "completed" } => entry !== null);
      this.publish({
        type: "turn.plan.updated",
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        raw: { plan },
      });
      this.scheduleBackgroundTurnSettle(session);
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = asNonEmptyString(update["toolCallId"]);
      if (!toolCallId) return;

      const ownerTurn = this.findTurnWithTool(session, toolCallId);
      const isTrackedBackground = ownerTurn !== null && session.backgroundTasks.has(toolCallId);
      if (!isTrackedBackground && this.discardIfDrainingCancelledTurn(session)) return;
      if (isTrackedBackground) {
        const incomingStatus = asNonEmptyString(update["status"]);
        if (incomingStatus === "completed" || incomingStatus === "failed") {
          // A real background task just completed; re-enable out-of-turn wakeup delivery.
          this.clearCancelledStreamSuppression(session);
        }
      }

      const openNow = this.openTurn(session);
      // A stray `tool_call_update` for an unknown pre-restart tool call (with no open turn)
      // must not open an empty phantom background turn; emit a standalone update/completion instead.
      if (kind === "tool_call_update" && ownerTurn === null && openNow === null) {
        const rawKind = asNonEmptyString(update["kind"]);
        const rawTitle = asNonEmptyString(update["title"]);
        const rawStatus = asNonEmptyString(update["status"]);
        const status: AcpToolState["status"] =
          rawStatus === "completed" || rawStatus === "failed" || rawStatus === "in_progress" || rawStatus === "pending"
            ? rawStatus
            : "completed";
        const rawInput = asRecord(update["rawInput"]) ?? {};
        const normalized = normalizeAcpToolCall(rawKind, rawTitle, rawInput);
        const extracted = extractAcpToolContent(update["content"], update["locations"]);
        const rawOutputFromField = extractRawOutputText(update["rawOutput"]);
        const output = extracted.output ?? rawOutputFromField ?? null;
        const terminal = status === "completed" || status === "failed";
        const now = Date.now();
        this.publish({
          type: terminal ? "tool.execute.completed" : "tool.execute.updated",
          provider: this.provider,
          threadId: session.threadId,
          turnId: null,
          tool: normalized.canonicalTool,
          raw: {
            toolCallId,
            title: normalized.title,
            kind: normalized.kind,
            status,
            input: normalized.input,
            output,
            files: extracted.files,
            patch: extracted.patch,
            startMs: now,
            endMs: terminal ? now : null,
          },
        });
        return;
      }

      const turn = ownerTurn ?? openNow ?? this.startOutOfTurn(session);
      const activeOpen = this.openTurn(session);
      if (activeOpen) {
        activeOpen.awaitingPostUsageSettle = false;
        activeOpen.hasAssistantTextSinceLastTool = false;
      }
      if (turn.status === "running") {
        this.finishReasoning(session, turn);
        this.flushActiveSegmentAsNote(session, turn);
        this.pauseGenerationTimer(turn);
      }

      const existing = turn.tools.get(toolCallId);
      const isNew = !existing;
      const now = Date.now();
      const incomingKind = asNonEmptyString(update["kind"]);
      const incomingTitle = asNonEmptyString(update["title"]);
      const incomingInput = asRecord(update["rawInput"]);
      const hasIncomingInput = incomingInput !== null && Object.keys(incomingInput).length > 0;
      const rawKind = incomingKind ?? existing?.rawKind ?? existing?.kind ?? null;
      const rawTitle = incomingTitle ?? existing?.rawTitle ?? null;
      const rawInput = hasIncomingInput
        ? { ...(existing?.rawInput ?? {}), ...incomingInput }
        : existing?.rawInput ?? {};
      const shouldNormalize =
        !existing || incomingKind !== null || incomingTitle !== null || hasIncomingInput;
      const normalized = shouldNormalize
        ? normalizeAcpToolCall(rawKind, rawTitle, rawInput)
        : {
            canonicalTool: existing.canonicalTool,
            title: existing.title,
            kind: existing.kind,
            input: existing.input,
          };
      const rawStatus = asNonEmptyString(update["status"]);
      const status: AcpToolState["status"] =
        rawStatus === "completed" || rawStatus === "failed" || rawStatus === "in_progress" || rawStatus === "pending"
          ? rawStatus
          : existing?.status ?? "in_progress";
      const extracted = extractAcpToolContent(update["content"], update["locations"]);
      const rawOutputFromField = extractRawOutputText(update["rawOutput"]);
      const output = extracted.output ?? rawOutputFromField ?? existing?.rawOutput ?? null;
      const terminalId = extracted.terminalId ?? existing?.terminalId ?? null;
      const files = extracted.files.length > 0 ? extracted.files : existing?.files ?? [];
      const patch = extracted.patch ?? existing?.patch ?? null;
      const terminal = status === "completed" || status === "failed";
      let recordedInItems = existing?.recordedInItems ?? false;

      if (terminal && !recordedInItems) {
        recordedInItems = true;
        turn.items.push({
          kind: "tool",
          tool: normalized.canonicalTool,
          text: output ?? normalized.title,
        });
      }

      const state: AcpToolState = {
        toolCallId,
        turnId: turn.id,
        canonicalTool: normalized.canonicalTool,
        rawTitle,
        rawKind,
        title: normalized.title,
        kind: normalized.kind,
        status,
        rawInput,
        input: normalized.input,
        rawOutput: output,
        terminalId,
        files,
        patch,
        startedAt: existing?.startedAt ?? now,
        endedAt: terminal ? (existing?.endedAt ?? now) : null,
        recordedInItems,
      };
      turn.tools.set(toolCallId, state);

      // If an already-promoted background task just acquired a live client terminal, mark it stoppable.
      if (!terminal && terminalId && session.clientHandlers.hasTerminal(terminalId)) {
        const existingBg = session.backgroundTasks.get(toolCallId);
        if (existingBg && !existingBg.stoppable) {
          session.backgroundTasks.set(toolCallId, { ...existingBg, stoppable: true });
          this.publish({
            type: "background.tasks.changed",
            provider: this.provider,
            threadId: session.threadId,
            tasks: [...session.backgroundTasks.values()],
          });
        }
      }

      const canonicalTool = state.canonicalTool;
      const eventType = terminal
        ? "tool.execute.completed"
        : isNew
          ? "tool.execute.started"
          : "tool.execute.updated";

      this.publish({
        type: eventType,
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        tool: canonicalTool,
        raw: {
          toolCallId: state.toolCallId,
          title: state.title,
          kind: state.kind,
          status: state.status,
          input: state.input,
          output: state.rawOutput,
          files: state.files,
          patch: state.patch,
          startMs: state.startedAt,
          endMs: state.endedAt,
        },
      });

      if (terminal) {
        this.clearBackgroundPromotionTimer(session, toolCallId);
        this.finishBackgroundTask(session, state, state.turnId);
      } else {
        this.scheduleBackgroundPromotion(session, state);
      }

      this.scheduleBackgroundTurnSettle(session);
    }
  }

  private findTurnWithTool(session: AcpSession, toolCallId: string): AcpTranscriptTurn | null {
    for (let i = session.transcript.length - 1; i >= 0; i -= 1) {
      const turn = session.transcript[i]!;
      if (turn.tools.has(toolCallId)) return turn;
    }
    return null;
  }

  private startOutOfTurn(session: AcpSession): AcpTranscriptTurn {
    const turnId: TurnId = `acp-turn-${randomUUID()}`;
    const turn: AcpTranscriptTurn = {
      id: turnId,
      prompt: "",
      origin: "background",
      items: [],
      status: "running",
      text: "",
      error: null,
      segments: [],
      activeSegment: null,
      activeReasoning: null,
      tools: new Map(),
      usage: null,
      sawUsageUpdate: false,
      hasAssistantTextSinceLastTool: false,
      awaitingPostUsageSettle: false,
      generationChars: 0,
      generationMs: 0,
      generationStartedAt: null,
    };
    session.transcript.push(turn);
    this.publish({
      type: "turn.started",
      provider: this.provider,
      threadId: session.threadId,
      turnId: turn.id,
      origin: "background",
    });
    return turn;
  }

  private clearBackgroundTurnIdleTimer(session: AcpSession): void {
    if (session.backgroundTurnIdleTimer !== null) {
      clearTimeout(session.backgroundTurnIdleTimer);
      session.backgroundTurnIdleTimer = null;
    }
  }

  private scheduleBackgroundTurnSettle(session: AcpSession): void {
    this.clearBackgroundTurnIdleTimer(session);
    const open = this.openTurn(session);
    if (!open || open.origin !== "background" || session.closed) return;
    // Hold the settle timer while any foreground tool owned by this turn is still
    // running, or while a turn-local backgrounded tool is running with no assistant
    // reply emitted after it yet.
    const hasBlockingToolRunning = [...open.tools.values()].some((tool) => {
      if (tool.status !== "in_progress" && tool.status !== "pending") return false;
      if (!session.backgroundTasks.has(tool.toolCallId)) return true;
      return !open.hasAssistantTextSinceLastTool;
    });
    if (hasBlockingToolRunning) return;
    const delayMs = open.awaitingPostUsageSettle
      ? this.backgroundTurnPostUsageIdleMs
      : this.backgroundTurnIdleMs;
    const timer = setTimeout(() => {
      session.backgroundTurnIdleTimer = null;
      if (session.closed || open.status !== "running") return;
      this.settleTurn(session, open, "completed", null);
      if (this.provider === "antigravity") {
        void this.refreshAntigravityUsage(session, true);
      }
    }, delayMs);
    timer.unref?.();
    session.backgroundTurnIdleTimer = timer;
  }

  private clearBackgroundPromotionTimer(session: AcpSession, toolCallId: string): void {
    const timer = session.backgroundTimers.get(toolCallId);
    if (timer !== undefined) {
      clearTimeout(timer);
      session.backgroundTimers.delete(toolCallId);
    }
  }

  private scheduleBackgroundPromotion(session: AcpSession, state: AcpToolState): void {
    if (session.closed || session.backgroundTasks.has(state.toolCallId)) return;
    if (state.canonicalTool !== "Bash" && state.canonicalTool !== "Agent") return;
    const immediate =
      state.canonicalTool === "Agent" ||
      state.rawInput["IsDaemon"] === true ||
      state.rawInput["run_in_background"] === true;
    if (immediate) {
      this.promoteToolToBackground(session, state);
      return;
    }
    const rawWait = state.rawInput["WaitMsBeforeAsync"];
    const waitMs =
      typeof rawWait === "number" && Number.isFinite(rawWait) && rawWait > 0
        ? rawWait
        : typeof rawWait === "string" && Number.isFinite(Number(rawWait)) && Number(rawWait) > 0
          ? Number(rawWait)
          : null;
    if (waitMs === null || session.backgroundTimers.has(state.toolCallId)) return;
    const toolCallId = state.toolCallId;
    const timer = setTimeout(() => {
      session.backgroundTimers.delete(toolCallId);
      const current = this.findTurnWithTool(session, toolCallId)?.tools.get(toolCallId);
      if (current && (current.status === "in_progress" || current.status === "pending")) {
        this.promoteToolToBackground(session, current);
      }
    }, waitMs);
    timer.unref?.();
    session.backgroundTimers.set(toolCallId, timer);
  }

  private promoteInProgressTools(session: AcpSession, turn: AcpTranscriptTurn): void {
    for (const state of turn.tools.values()) {
      if (state.status === "in_progress" || state.status === "pending") {
        this.promoteToolToBackground(session, state);
      }
    }
  }

  private promoteToolToBackground(session: AcpSession, state: AcpToolState): void {
    this.clearBackgroundPromotionTimer(session, state.toolCallId);
    if (session.closed || session.backgroundTasks.has(state.toolCallId)) return;
    if (state.status !== "in_progress" && state.status !== "pending") return;
    if (state.canonicalTool !== "Bash" && state.canonicalTool !== "Agent") return;
    const isAgent = state.canonicalTool === "Agent";
    const taskType = isAgent ? "local_agent" : "local_bash";
    const command = isAgent
      ? (asNonEmptyString(state.input["Prompt"] ?? state.input["prompt"]) ?? null)
      : (asNonEmptyString(state.input["command"] ?? state.input["CommandLine"]) ?? state.title);
    const description =
      asNonEmptyString(state.input["toolSummary"] ?? state.input["description"] ?? state.input["Role"]) ??
      (command ? command.split("\n")[0]!.trim() : state.title);
    const stoppable =
      state.terminalId !== null && session.clientHandlers.hasTerminal(state.terminalId);
    const summary: BackgroundTaskSummary = {
      taskId: state.toolCallId,
      taskType,
      toolName: state.canonicalTool,
      description,
      command,
      startedAt: new Date(state.startedAt).toISOString(),
      stoppable,
    };
    session.backgroundTasks.set(state.toolCallId, summary);
    this.publish({
      type: "background.task",
      provider: this.provider,
      threadId: session.threadId,
      turnId: state.turnId,
      taskId: state.toolCallId,
      status: "started",
      description,
      taskType,
      toolUseId: state.toolCallId,
      summary: null,
    });
    this.publish({
      type: "background.tasks.changed",
      provider: this.provider,
      threadId: session.threadId,
      tasks: [...session.backgroundTasks.values()],
    });
  }

  private finishBackgroundTask(session: AcpSession, state: AcpToolState, turnId: TurnId | null): void {
    const existing = session.backgroundTasks.get(state.toolCallId);
    if (!existing) return;
    session.backgroundTasks.delete(state.toolCallId);
    this.publish({
      type: "background.task",
      provider: this.provider,
      threadId: session.threadId,
      turnId,
      taskId: state.toolCallId,
      status: state.status === "failed" ? "failed" : "completed",
      description: existing.description,
      taskType: existing.taskType,
      toolUseId: state.toolCallId,
      summary: null,
    });
    this.publish({
      type: "background.tasks.changed",
      provider: this.provider,
      threadId: session.threadId,
      tasks: [...session.backgroundTasks.values()],
    });
  }

  private async handleElicitationRequest(session: AcpSession, params: unknown): Promise<unknown> {
    const rec = asRecord(params);
    // URL/OAuth elicitations need a browser flow Moxen cannot host, and delegated sessions have no user.
    if (asNonEmptyString(rec?.["mode"]) === "url" || session.delegated) {
      return { action: "decline" };
    }
    const parsed = parseAcpElicitationQuestions(params);
    const requestId: ApprovalRequestId = `acp-elicit-${randomUUID()}`;
    return new Promise<unknown>((resolve) => {
      session.parkedInputs.set(requestId, {
        requestId,
        threadId: session.threadId,
        params,
        resolve,
      });
      this.publish({
        type: "user-input.request.opened",
        provider: this.provider,
        threadId: session.threadId,
        requestId,
        raw: {
          toolName: "AskUserQuestion",
          message: parsed.message,
          questions: parsed.questions,
          requestedSchema: rec?.["requestedSchema"],
        },
      });
    });
  }

  private publishPermissionDenied(session: AcpSession, title: string, detail: string): void {
    const turn = this.openTurn(session);
    this.publish({
      type: "session.notice",
      provider: this.provider,
      threadId: session.threadId,
      turnId: turn?.id ?? null,
      notice: "permission-denied",
      title,
      detail,
    });
  }

  private async handlePermissionRequest(session: AcpSession, params: unknown): Promise<unknown> {
    const record = asRecord(params) ?? {};
    const toolCall = asRecord(record["toolCall"]) ?? {};
    const options = parseAcpPermissionOptions(record["options"]);
    const kind = asNonEmptyString(toolCall["kind"]);
    const rawInput = asRecord(toolCall["rawInput"]) ?? {};
    const rawTitle = asNonEmptyString(toolCall["title"]);
    const normalized = normalizeAcpToolCall(kind, rawTitle, rawInput);
    const title = normalized.title;
    const toolName = normalized.canonicalTool;
    const sessionKey = `${normalized.kind ?? "tool"}:${title}`;

    // Worktree isolation always wins, even in full-access mode.
    if (session.isolation) {
      const violation = checkPermissionIsolation(session.isolation, toolCall, normalized, session.workingDirectory);
      if (violation) {
        this.publishPermissionDenied(session, `Refused ${toolName} outside worktree`, violation);
        return selectAcpPermissionOutcome({ kind: "decline" }, options);
      }
    }

    // Automatic approvals always reply `allow_once` (`{ kind: "accept" }`), never
    // `allow_always`, so the agent keeps routing subsequent calls through Moxen's
    // worktree isolation and live runtime-mode gates.
    if (session.runtimeMode === "full-access") {
      return selectAcpPermissionOutcome({ kind: "accept" }, options);
    }

    if (session.sessionAllowKeys.has(sessionKey)) {
      return selectAcpPermissionOutcome(
        session.isolation ? { kind: "accept" } : { kind: "acceptForSession" },
        options,
      );
    }

    const effectiveKind = normalized.kind ?? kind;
    const isRead = effectiveKind === "read" || effectiveKind === "search" || effectiveKind === "think";
    const isEdit =
      effectiveKind === "edit" ||
      effectiveKind === "delete" ||
      effectiveKind === "move" ||
      toolName === "Edit" ||
      toolName === "Write";
    const isExec = effectiveKind === "execute" || toolName === "Bash";

    let decision: "allow" | "ask" | "deny" = "ask";
    let denyReason: string | null = null;

    if (isRead) {
      if (session.runtimeMode === "auto" || session.runtimeMode === "auto-accept-edits") {
        decision = "allow";
      } else if (session.delegated) {
        const readPaths = collectPermissionPaths(toolCall, normalized);
        const places = readPaths.map((p) => classifyPath(p, { cwd: session.workingDirectory }));
        const outside = places.some((place) => place !== "cwd" && place !== "tmp");
        decision = outside ? "ask" : "allow";
      }
    } else if (isEdit) {
      const editPaths = collectPermissionPaths(toolCall, normalized);
      const places = editPaths.map((p) => classifyPath(p, { cwd: session.workingDirectory }));
      const protectedPlace = places.find(
        (place) => place === "secret" || place === "startup" || place === "system" || place === "root" || place === "git",
      );
      const outside = places.some((place) => place !== "cwd" && place !== "tmp");
      if (session.runtimeMode === "auto-accept-edits") {
        decision = outside ? "ask" : "allow";
      } else if (session.runtimeMode === "auto") {
        if (protectedPlace !== undefined) {
          decision = "deny";
          denyReason = `Auto mode refused ${toolName} on protected path (${protectedPlace}).`;
        } else {
          decision = outside ? "ask" : "allow";
        }
      }
    } else if (isExec) {
      const { command, cwd: commandCwd } = extractPermissionCommand(toolCall, normalized, session.workingDirectory);
      const risk = assessCommandLine(command, { cwd: commandCwd, shell: "posix" });
      if (risk.level === "catastrophic") {
        decision = "deny";
        denyReason = risk.reason ?? "This command is too risky to run unattended.";
      } else if (session.runtimeMode === "auto") {
        if (risk.level === "safe") {
          decision = "allow";
        } else if (risk.level === "dangerous") {
          decision = "deny";
          denyReason = risk.reason ?? "Auto mode refused a dangerous command.";
        } else {
          decision = "ask";
        }
      }
    } else if (session.runtimeMode === "auto") {
      // MCP, web fetch, and other non-shell/non-edit tools are auto-approved in Auto mode.
      decision = "allow";
    }

    if (decision === "allow") {
      return selectAcpPermissionOutcome({ kind: "accept" }, options);
    }

    if (decision === "deny") {
      if (denyReason) {
        this.publishPermissionDenied(session, `Refused ${toolName}`, denyReason);
      }
      return selectAcpPermissionOutcome({ kind: "decline" }, options);
    }

    // Only actions that genuinely require interactive approval are declined on delegated threads.
    if (session.delegated) {
      return selectAcpPermissionOutcome({ kind: "decline" }, options);
    }

    const firstLocationPath = collectPermissionPaths(toolCall, normalized)[0] ?? null;
    const permissionInput: Record<string, unknown> =
      firstLocationPath &&
      normalized.input["file_path"] === undefined &&
      normalized.input["path"] === undefined &&
      normalized.input["command"] === undefined
        ? { ...normalized.input, file_path: firstLocationPath }
        : normalized.input;

    const requestId: ApprovalRequestId = `acp-perm-${randomUUID()}`;
    return new Promise<unknown>((resolve) => {
      session.parked.set(requestId, {
        requestId,
        threadId: session.threadId,
        toolName,
        sessionKey,
        options,
        resolve,
      });
      this.publish({
        type: "permission.request.opened",
        provider: this.provider,
        threadId: session.threadId,
        requestId,
        raw: {
          toolName,
          classification: permissionClassification(effectiveKind),
          input: permissionInput,
          description: title,
          options,
        },
      });
    });
  }

  private pauseGenerationTimer(turn: AcpTranscriptTurn): void {
    if (turn.generationStartedAt !== null) {
      turn.generationMs += Math.max(0, Date.now() - turn.generationStartedAt);
      turn.generationStartedAt = null;
    }
  }

  private finishReasoning(session: AcpSession, turn: AcpTranscriptTurn): void {
    const active = turn.activeReasoning;
    if (!active) return;
    turn.activeReasoning = null;
    this.publish({
      type: "reasoning.updated",
      provider: this.provider,
      threadId: session.threadId,
      turnId: turn.id,
      reasoningId: active.id,
      status: "completed",
      text: active.text,
      startedAt: new Date(active.startedAt).toISOString(),
      durationMs: Math.max(0, Date.now() - active.startedAt),
    });
  }

  private flushActiveSegmentAsNote(session: AcpSession, turn: AcpTranscriptTurn): void {
    const active = turn.activeSegment;
    if (!active) return;
    turn.activeSegment = null;
    if (active.text.length === 0) return;
    active.isNote = true;
    this.publish({
      type: "assistant.note",
      provider: this.provider,
      threadId: session.threadId,
      turnId: turn.id,
      messageId: active.id,
      text: active.text,
    });
  }

  private async refreshAntigravityUsage(session: AcpSession, force = false): Promise<void> {
    if (this.provider !== "antigravity" || session.closed) return;
    if (session.usageRefreshInFlight) return session.usageRefreshInFlight;
    const now = Date.now();
    if (force && session.lastForcedUsageRefreshAt > 0 && now - session.lastForcedUsageRefreshAt < USAGE_REFRESH_COALESCE_MS) {
      return;
    }
    if (force) session.lastForcedUsageRefreshAt = now;
    const run = (async () => {
      const snapshot = await this.probeUsageFn(session.agent.command, this.baseEnv, { force }).catch(() => null);
      if (!snapshot || session.closed) return;
      if (snapshot.windows.length === 0 && snapshot.credits === null) return;
      this.publish({
        type: "rate-limits.updated",
        provider: this.provider,
        threadId: session.threadId,
        windows: snapshot.windows,
        ...(snapshot.credits === null ? {} : { credits: snapshot.credits }),
        ...(session.tier ? { raw: { subscriptionType: session.tier } } : {}),
      });
    })().finally(() => {
      if (session.usageRefreshInFlight === run) {
        session.usageRefreshInFlight = null;
      }
    });
    session.usageRefreshInFlight = run;
    return run;
  }

  private outcomeOf(turn: AcpTranscriptTurn): AcpTurnOutcome {
    const status: TerminalTurnStatus = turn.status === "running" ? "interrupted" : turn.status;
    return {
      status,
      text: turn.text,
      usage: turn.usage,
      ...(turn.generationChars > 0
        ? { generation: { characters: turn.generationChars, durationMs: turn.generationMs } }
        : {}),
      error: turn.error,
    };
  }

  private settleTurn(
    session: AcpSession,
    turn: AcpTranscriptTurn,
    status: TerminalTurnStatus,
    error: string | null,
    raw?: unknown,
  ): void {
    if (turn.status !== "running") return;
    this.clearBackgroundTurnIdleTimer(session);
    this.cancelAllParked(session);
    if (status === "completed") {
      this.promoteInProgressTools(session, turn);
    } else {
      this.failInProgressForegroundTools(session, turn, status, error);
    }
    this.finishReasoning(session, turn);
    this.pauseGenerationTimer(turn);
    turn.activeSegment = null;
    settleAndPublishTurn({
      open: turn,
      waiters: session.waiters,
      status,
      apply: (open) => {
        open.status = status;
        open.text = buildAnswerText(open.segments);
        open.error = error;
        if (open.text.length > 0) {
          open.items.push({ kind: "assistant", text: open.text });
        }
        return this.outcomeOf(open);
      },
      publish: (event) => this.publish(event),
      event: (turnId) => terminalTurnEvent(this.provider, session.threadId, turnId, status, raw),
    });
  }

  private failInProgressForegroundTools(
    session: AcpSession,
    turn: AcpTranscriptTurn,
    status: "interrupted" | "failed",
    error: string | null,
  ): void {
    const now = Date.now();
    for (const state of turn.tools.values()) {
      if (state.status !== "in_progress" && state.status !== "pending") continue;
      this.clearBackgroundPromotionTimer(session, state.toolCallId);
      if (session.backgroundTasks.has(state.toolCallId)) continue;
      state.status = "failed";
      state.endedAt = now;
      state.rawOutput = state.rawOutput ?? (status === "interrupted" ? "Interrupted." : (error ?? "Turn failed."));
      if (!state.recordedInItems) {
        state.recordedInItems = true;
        turn.items.push({
          kind: "tool",
          tool: state.canonicalTool,
          text: state.rawOutput ?? state.title,
        });
      }
      this.publish({
        type: "tool.execute.completed",
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        tool: state.canonicalTool,
        raw: {
          toolCallId: state.toolCallId,
          title: state.title,
          kind: state.kind,
          status: state.status,
          input: state.input,
          output: state.rawOutput,
          files: state.files,
          patch: state.patch,
          startMs: state.startedAt,
          endMs: state.endedAt,
        },
      });
    }
  }

  private cancelAllParked(session: AcpSession): void {
    for (const [requestId, parked] of [...session.parked]) {
      session.parked.delete(requestId);
      parked.resolve(selectAcpPermissionOutcome({ kind: "cancel" }, parked.options));
      this.publish({
        type: "permission.request.resolved",
        provider: this.provider,
        threadId: session.threadId,
        requestId,
        raw: { toolName: parked.toolName, behavior: "deny" },
      });
    }
    for (const [requestId, parked] of [...session.parkedInputs]) {
      session.parkedInputs.delete(requestId);
      parked.resolve({ action: "cancel" });
      this.publish({
        type: "user-input.request.resolved",
        provider: this.provider,
        threadId: session.threadId,
        requestId,
        raw: { toolName: "AskUserQuestion", behavior: "deny" },
      });
    }
  }

  private finishInFlightPrompt(session: AcpSession, entry: InFlightAcpPrompt): void {
    if (entry.graceTimer !== null) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    if (session.inFlightPrompt === entry) {
      session.inFlightPrompt = null;
    }
    entry.resolveDone();
  }

  private abandonInFlightPrompt(session: AcpSession, entry: InFlightAcpPrompt): void {
    entry.abandoned = true;
    if (entry.graceTimer !== null) return;
    const timer = setTimeout(() => {
      entry.graceTimer = null;
      this.finishInFlightPrompt(session, entry);
    }, this.cancelDrainTimeoutMs);
    timer.unref?.();
    entry.graceTimer = timer;
  }

  private startCancelledStreamSuppression(session: AcpSession): void {
    this.clearCancelledStreamSuppression(session);
    if (session.closed) return;
    session.suppressingCancelledStream = true;
    const hardTimer = setTimeout(() => {
      this.clearCancelledStreamSuppression(session);
    }, this.cancelDrainTimeoutMs);
    hardTimer.unref?.();
    session.cancelledStreamHardTimer = hardTimer;
    this.bumpCancelledStreamQuietTimer(session);
  }

  private bumpCancelledStreamQuietTimer(session: AcpSession): void {
    if (session.cancelledStreamQuietTimer !== null) {
      clearTimeout(session.cancelledStreamQuietTimer);
      session.cancelledStreamQuietTimer = null;
    }
    if (!session.suppressingCancelledStream || session.closed) return;
    const timer = setTimeout(() => {
      this.clearCancelledStreamSuppression(session);
    }, this.cancelQuietMs);
    timer.unref?.();
    session.cancelledStreamQuietTimer = timer;
  }

  private clearCancelledStreamSuppression(session: AcpSession): void {
    session.suppressingCancelledStream = false;
    if (session.cancelledStreamQuietTimer !== null) {
      clearTimeout(session.cancelledStreamQuietTimer);
      session.cancelledStreamQuietTimer = null;
    }
    if (session.cancelledStreamHardTimer !== null) {
      clearTimeout(session.cancelledStreamHardTimer);
      session.cancelledStreamHardTimer = null;
    }
  }

  private discardIfDrainingCancelledTurn(session: AcpSession): boolean {
    if (session.inFlightPrompt?.abandoned) return true;
    if (session.suppressingCancelledStream) {
      this.bumpCancelledStreamQuietTimer(session);
      return true;
    }
    return false;
  }

  private closeSession(session: AcpSession, status: TerminalTurnStatus, error: string | null): void {
    if (session.closed) return;
    session.closed = true;
    this.clearBackgroundTurnIdleTimer(session);
    this.clearCancelledStreamSuppression(session);
    if (session.inFlightPrompt) {
      this.finishInFlightPrompt(session, session.inFlightPrompt);
    }
    for (const timer of session.backgroundTimers.values()) {
      clearTimeout(timer);
    }
    session.backgroundTimers.clear();
    if (session.backgroundTasks.size > 0) {
      session.backgroundTasks.clear();
      this.publish({
        type: "background.tasks.changed",
        provider: this.provider,
        threadId: session.threadId,
        tasks: [],
      });
    }
    this.cancelAllParked(session);
    const open = this.openTurn(session);
    if (open) {
      this.settleTurn(session, open, status, error);
    }
    session.clientHandlers.closeAll();
    session.peer.close();
    this.sessions.delete(session.threadId);
  }

  private snapshotOf(session: AcpSession): ProviderThreadSnapshot {
    return {
      threadId: session.threadId,
      turns: session.transcript.map((turn) => ({
        id: turn.id,
        items: turn.items,
      })),
    };
  }
}

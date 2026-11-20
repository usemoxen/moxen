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

import { CliError } from "../../errors.js";
import { escapes, isolationViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import type { ModelSelection, RuntimeMode } from "../../types.js";
import { APP_VERSION } from "../../version.js";
import { JsonRpcPeer } from "../stdio.js";
import type {
  ApprovalRequestId,
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
  ThreadId,
  TokenUsageDelta,
  TurnId,
} from "../spi.js";
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
  buildAcpPromptBlocks,
  extractAcpToolContent,
  isAcpAuthErrorText,
  isAcpSessionNotFoundText,
  parseAcpAvailableCommands,
  parseAcpConfigOptions,
  parseAcpInitializeResult,
  parseAcpModesState,
  parseAcpPermissionOptions,
  selectAcpPermissionOutcome,
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpAuthMethod,
  type AcpAvailableCommand,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpSessionModesState,
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
  title: string;
  kind: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  rawInput: Record<string, unknown>;
  rawOutput: string | null;
  files: ReadonlyArray<{ readonly path: string; readonly diff?: string }>;
  patch: string | null;
  startedAt: number;
  endedAt: number | null;
}

interface AcpReasoningState {
  readonly id: string;
  text: string;
  readonly startedAt: number;
}

interface AcpTranscriptTurn {
  readonly id: TurnId;
  readonly prompt: string;
  readonly items: AcpTranscriptItem[];
  status: "running" | TerminalTurnStatus;
  text: string;
  error: string | null;
  readonly segments: AcpMessageSegment[];
  activeSegment: AcpMessageSegment | null;
  activeReasoning: AcpReasoningState | null;
  readonly tools: Map<string, AcpToolState>;
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
  readonly sessionAllowKeys: Set<string>;
  readonly transcript: AcpTranscriptTurn[];
  readonly waiters: TurnWaiters<AcpTurnOutcome>;
  readonly parked: Map<ApprovalRequestId, ParkedAcpPermission>;
  closed: boolean;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

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

function checkPermissionIsolation(
  isolation: WorktreeIsolation,
  toolCall: Record<string, unknown>,
  cwd: string,
): string | null {
  const kind = asNonEmptyString(toolCall["kind"]);
  const rawInput = asRecord(toolCall["rawInput"]) ?? {};
  const locations = Array.isArray(toolCall["locations"]) ? toolCall["locations"] : [];

  if (kind === "edit" || kind === "delete" || kind === "move") {
    for (const loc of locations) {
      const target = asNonEmptyString(asRecord(loc)?.["path"]);
      if (target && escapes(isolation, target, cwd)) {
        return `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. ${target} is outside it.`;
      }
    }
    for (const key of ["path", "file_path", "filePath", "target"]) {
      const target = asNonEmptyString(rawInput[key]);
      if (target && escapes(isolation, target, cwd)) {
        return `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. ${target} is outside it.`;
      }
    }
  }

  if (kind === "execute") {
    const command = asNonEmptyString(rawInput["command"]) ?? asNonEmptyString(toolCall["title"]) ?? "";
    const commandCwd = asNonEmptyString(rawInput["cwd"]) ?? cwd;
    const violation = isolationViolation(isolation, {
      tool: "Bash",
      input: { command },
      cwd: commandCwd,
    });
    if (violation) return violation;
  }

  return null;
}

function buildAnswerText(segments: readonly AcpMessageSegment[]): string {
  const answers = segments.filter((seg) => !seg.isNote && seg.text.length > 0);
  if (answers.length > 0) return answers.map((seg) => seg.text).join("\n\n");
  const last = segments.at(-1);
  return last?.text ?? "";
}

export class AcpDriver implements ProviderAdapter<CliError> {
  readonly provider: "acp" | "antigravity";
  readonly capabilities: ProviderAdapterCapabilities = {
    sessionModelSwitch: "in-session",
  };

  private readonly agents: Map<string, AcpAgentLaunchSpec>;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly transport: AcpTransport;
  private readonly initializeTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly sessions = new Map<ThreadId, AcpSession>();
  /** ACP session id per Moxen thread, kept past session teardown for resume. */
  private readonly resumable = new Map<ThreadId, string>();
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
  }

  get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.queue);
  }

  /** Probe an ACP agent's initialize handshake (protocol version, capabilities, auth methods) without creating a session. */
  async probeAgent(instanceId: string, cwd: string): Promise<AcpInitializeResult> {
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
          },
          clientInfo: { name: "moxen", title: "Moxen", version: APP_VERSION },
        },
        this.initializeTimeoutMs,
      );
      return parseAcpInitializeResult(raw, agent.name ?? agent.id);
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

      try {
        const initRaw = await peer.request(
          ACP_METHODS.initialize,
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
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
          sessionAllowKeys: new Set(),
          transcript: [],
          waiters: new Map(),
          parked: new Map(),
          closed: false,
        };

        this.wirePeer(session);
        this.sessions.set(input.threadId, session);
        this.resumable.set(input.threadId, acpSessionId);

        // Apply initial model selection if the agent exposes a model config option.
        if (input.modelSelection?.model) {
          await this.applyModelConfigOption(session, input.modelSelection.model);
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
      if (this.openTurn(session)) {
        throw new CliError("ACP_TURN_BUSY", `Thread ${input.threadId} already has a running ACP turn.`);
      }
      if (input.runtimeMode) session.runtimeMode = input.runtimeMode;
      if (input.modelSelection?.model) {
        await this.applyModelConfigOption(session, input.modelSelection.model);
      }

      const turnId: TurnId = `acp-turn-${randomUUID()}`;
      const turn: AcpTranscriptTurn = {
        id: turnId,
        prompt: input.prompt,
        items: [{ kind: "user", text: input.prompt }],
        status: "running",
        text: "",
        error: null,
        segments: [],
        activeSegment: null,
        activeReasoning: null,
        tools: new Map(),
        generationChars: 0,
        generationMs: 0,
        generationStartedAt: null,
      };
      session.transcript.push(turn);

      const effectivePrompt = session.pendingInstructions
        ? `${session.pendingInstructions}\n\n${input.prompt}`
        : input.prompt;
      session.pendingInstructions = null;

      const promptBlocks = buildAcpPromptBlocks(
        effectivePrompt,
        input.images,
        session.capabilities.promptCapabilities.image,
      );

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
            const record = asRecord(result);
            const stopReason = record?.["stopReason"];
            const status = acpStopReasonToStatus(stopReason);
            const error = status === "failed" ? `ACP agent refused the turn (${String(stopReason)}).` : null;
            this.settleTurn(session, turn, status, error, record ?? undefined);
          },
          (cause) => {
            const agentLabel = session.agent.name ?? session.agent.id;
            const err = toCliError("ACP_TURN_FAILED", `ACP turn failed for ${agentLabel}`, cause, agentLabel);
            this.settleTurn(session, turn, "failed", err.message, { code: err.code, message: err.message });
          },
        );

      return { threadId: input.threadId, turnId };
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
        this.settleTurn(session, open, "interrupted", null);
      }
    });

  respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Effect.Effect<void, CliError> =>
    this.attempt("ACP_APPROVAL_FAILED", `Could not answer permission request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      const parked = session.parked.get(requestId);
      if (!parked) {
        throw new CliError("APPROVAL_NOT_FOUND", `No pending ACP approval ${requestId} on thread ${threadId}.`);
      }
      session.parked.delete(requestId);
      if (decision.kind === "acceptForSession") {
        session.sessionAllowKeys.add(parked.sessionKey);
      }
      const response = selectAcpPermissionOutcome(decision, parked.options);
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
    });

  respondToUserInput = (
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, CliError> => Effect.void;

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

  rollbackThread = (threadId: ThreadId, numTurns: number): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("ACP_ROLLBACK_FAILED", `Could not roll back ACP thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      const drop = Math.max(0, Math.min(numTurns, session.transcript.length));
      if (drop > 0) {
        session.transcript.splice(session.transcript.length - drop, drop);
      }
      return this.snapshotOf(session);
    });

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

  private async applyModelConfigOption(session: AcpSession, model: string): Promise<void> {
    const modelOpt = session.configOptions.find((opt) => opt.category === "model" || opt.id === "model");
    if (!modelOpt || modelOpt.currentValue === model) return;
    if (modelOpt.options.length > 0 && !modelOpt.options.some((opt) => opt.value === model)) return;
    try {
      const updated = asRecord(
        await session.peer.request(
          ACP_METHODS.sessionSetConfigOption,
          {
            sessionId: session.acpSessionId,
            configId: modelOpt.id,
            value: model,
          },
          this.initializeTimeoutMs,
        ),
      );
      if (updated && Array.isArray(updated["configOptions"])) {
        session.configOptions = parseAcpConfigOptions(updated["configOptions"]);
      } else {
        session.configOptions = session.configOptions.map((opt) =>
          opt.id === modelOpt.id ? { ...opt, currentValue: model } : opt,
        );
      }
    } catch {
      // Agent declined model switch; keep session running on its current model.
    }
  }

  private wirePeer(session: AcpSession): void {
    session.peer.onNotification((method, params) => {
      if (session.closed) return;
      if (method === ACP_METHODS.sessionUpdate) {
        this.handleSessionUpdate(session, params);
      }
    });

    session.peer.onRequest(async (method, params) => {
      if (session.closed) {
        throw new CliError("SESSION_CLOSED", "ACP session is closed.");
      }
      const clientCtx = {
        workingDirectory: session.workingDirectory,
        isolation: session.isolation,
        env: this.baseEnv,
      };
      switch (method) {
        case ACP_METHODS.requestPermission:
          return this.handlePermissionRequest(session, params);
        case ACP_METHODS.fsReadTextFile:
          return session.clientHandlers.readTextFile(params, clientCtx);
        case ACP_METHODS.fsWriteTextFile:
          return session.clientHandlers.writeTextFile(params, clientCtx);
        case ACP_METHODS.terminalCreate:
          return session.clientHandlers.createTerminal(params, clientCtx);
        case ACP_METHODS.terminalOutput:
          return session.clientHandlers.terminalOutput(params);
        case ACP_METHODS.terminalWaitForExit:
          return session.clientHandlers.waitForTerminalExit(params);
        case ACP_METHODS.terminalKill:
          return session.clientHandlers.killTerminal(params);
        case ACP_METHODS.terminalRelease:
          return session.clientHandlers.releaseTerminal(params);
        default:
          throw new CliError("ACP_METHOD_NOT_FOUND", `Unsupported ACP client method: ${method}`);
      }
    });

    session.peer.onExit((code) => {
      if (session.closed) return;
      this.closeSession(
        session,
        "failed",
        `ACP agent "${session.agent.name ?? session.agent.id}" exited unexpectedly (code ${String(code)}).`,
      );
    });
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

    const turn = this.openTurn(session);
    if (!turn) return;

    if (kind === "agent_thought_chunk") {
      const content = asRecord(update["content"]);
      const delta = asString(content?.["text"]) ?? asString(update["text"]);
      if (!delta) return;
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
      return;
    }

    if (kind === "agent_message_chunk") {
      const content = asRecord(update["content"]);
      const delta = asString(content?.["text"]) ?? asString(update["text"]);
      if (!delta) return;
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
      return;
    }

    if (kind === "plan") {
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
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      this.finishReasoning(session, turn);
      this.flushActiveSegmentAsNote(session, turn);
      this.pauseGenerationTimer(turn);

      const toolCallId = asNonEmptyString(update["toolCallId"]);
      if (!toolCallId) return;

      const existing = turn.tools.get(toolCallId);
      const isNew = !existing;
      const now = Date.now();
      const rawKind = asNonEmptyString(update["kind"]) ?? existing?.kind ?? null;
      const title = asNonEmptyString(update["title"]) ?? existing?.title ?? acpCanonicalToolName(rawKind, null);
      const rawStatus = asNonEmptyString(update["status"]);
      const status: AcpToolState["status"] =
        rawStatus === "completed" || rawStatus === "failed" || rawStatus === "in_progress" || rawStatus === "pending"
          ? rawStatus
          : existing?.status ?? "in_progress";
      const rawInput = asRecord(update["rawInput"]) ?? existing?.rawInput ?? {};
      const extracted = extractAcpToolContent(update["content"], update["locations"]);
      const rawOutputFromField =
        typeof update["rawOutput"] === "string"
          ? update["rawOutput"]
          : update["rawOutput"] !== undefined && update["rawOutput"] !== null
            ? JSON.stringify(update["rawOutput"])
            : null;
      const output = extracted.output ?? rawOutputFromField ?? existing?.rawOutput ?? null;
      const files = extracted.files.length > 0 ? extracted.files : existing?.files ?? [];
      const patch = extracted.patch ?? existing?.patch ?? null;
      const terminal = status === "completed" || status === "failed";

      const state: AcpToolState = {
        toolCallId,
        title,
        kind: rawKind,
        status,
        rawInput,
        rawOutput: output,
        files,
        patch,
        startedAt: existing?.startedAt ?? now,
        endedAt: terminal ? (existing?.endedAt ?? now) : null,
      };
      turn.tools.set(toolCallId, state);

      const canonicalTool = acpCanonicalToolName(state.kind, state.title);
      const eventType = terminal
        ? "tool.execute.completed"
        : isNew
          ? "tool.execute.started"
          : "tool.execute.updated";

      if (terminal) {
        turn.items.push({
          kind: "tool",
          tool: canonicalTool,
          text: state.rawOutput ?? state.title,
        });
      }

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
          input: state.rawInput,
          output: state.rawOutput,
          files: state.files,
          patch: state.patch,
          startMs: state.startedAt,
          endMs: state.endedAt,
        },
      });
    }
  }

  private async handlePermissionRequest(session: AcpSession, params: unknown): Promise<unknown> {
    const record = asRecord(params) ?? {};
    const toolCall = asRecord(record["toolCall"]) ?? {};
    const options = parseAcpPermissionOptions(record["options"]);
    const kind = asNonEmptyString(toolCall["kind"]);
    const title = asNonEmptyString(toolCall["title"]) ?? acpCanonicalToolName(kind, null);
    const toolName = acpCanonicalToolName(kind, title);
    const rawInput = asRecord(toolCall["rawInput"]) ?? {};
    const sessionKey = `${kind ?? "tool"}:${title}`;

    // Worktree isolation always wins, even in full-access mode.
    if (session.isolation) {
      const violation = checkPermissionIsolation(session.isolation, toolCall, session.workingDirectory);
      if (violation) {
        const turn = this.openTurn(session);
        this.publish({
          type: "session.notice",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn?.id ?? null,
          notice: "permission-denied",
          title: `Refused ${toolName} outside worktree`,
          detail: violation,
        });
        return selectAcpPermissionOutcome({ kind: "decline" }, options);
      }
    }

    if (session.runtimeMode === "full-access" || session.sessionAllowKeys.has(sessionKey)) {
      return selectAcpPermissionOutcome({ kind: "acceptForSession" }, options);
    }

    if (session.delegated) {
      return selectAcpPermissionOutcome({ kind: "decline" }, options);
    }

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
          classification: permissionClassification(kind),
          input: rawInput,
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

  private outcomeOf(turn: AcpTranscriptTurn): AcpTurnOutcome {
    const status: TerminalTurnStatus = turn.status === "running" ? "interrupted" : turn.status;
    return {
      status,
      text: turn.text,
      usage: null,
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
  }

  private closeSession(session: AcpSession, status: TerminalTurnStatus, error: string | null): void {
    if (session.closed) return;
    session.closed = true;
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

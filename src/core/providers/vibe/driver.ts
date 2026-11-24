/**
 * Mistral Vibe driver: `ProviderAdapter` + `TurnDriver` over a per-session
 * `vibe-app-server` stdio JSON-RPC 2.0 peer.
 *
 * Handshake is `initialize` → `initialized`, followed by `session/start` or
 * `session/resume` (falling back to `session/start` on `not_found`).
 *
 * Protocol invariants verified against `mistral-vibe` v3.1.4:
 * - `initialize.clientInfo` honestly identifies Moxen (`name: "moxen"`,
 *   `entrypoint: "unknown"`) — never spoofs `"cli"` or `"desktop"`.
 * - `callback/call` is two-phase: acknowledge `{ callbackId, accepted: true }`
 *   immediately, then deliver the decision via `callback/result`.
 * - `session/compact` and `session/rewind` are session handoffs: adopt the
 *   returned `state.session.id` as the live `vibeSessionId` / `resumeCursor`.
 * - Model/effort picks always pass `sessionOnly: true` so Moxen never mutates
 *   the user's global `vibe` CLI default.
 * - Vibe's native `task` subagent tool is always disabled (`disabledTools`) so
 *   delegation runs through Moxen's tracked `delegate` threads.
 * - Per-tool MCP exclusions ride the same `disabledTools` filter as patterns
 *   over Vibe's published `<server>_<tool>` names (`vibeDisabledMcpToolPatterns`),
 *   which removes the tool from both listing and invocation.
 * - `turn/completed` is correlated by session and server turn id; an event
 *   that arrives before the turn is identified is buffered, never applied
 *   blindly to the open turn.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { plainSkill, type SkillInventory, type SkillSummary } from "../../catalog/summary.js";
import { CliError } from "../../errors.js";
import { excludedSkills } from "../../skills/discovery.js";
import { escapes, isolationViolation, rawInputViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import type { ModelSelection, RuntimeMode, VibeProviderConfig } from "../../types.js";
import { APP_VERSION } from "../../version.js";
import { conversationContextBreakdown } from "../context.js";
import { assessCommandLine } from "../harness/commandsafety.js";
import { SIDE_QUESTION_RULES } from "../sidequestion.js";
import {
  isCompactCommand,
  type ApprovalRequestId,
  type BackgroundTaskSummary,
  type ContextBreakdown,
  type ContextWindowUsage,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderApprovalDecision,
  type ProviderCompaction,
  type ProviderImage,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderThreadSnapshot,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type RateLimitWindow,
  type SideAnswer,
  type SideQuestionInput,
  type ThreadId,
  type TokenUsageDelta,
  type TurnId,
  type UnconfirmedSteer,
} from "../spi.js";
import { JsonRpcPeer } from "../stdio.js";
import {
  parkTurnWaiter,
  settleAndPublishTurn,
  terminalTurnEvent,
  type TerminalTurnStatus,
  type TurnWaiters,
} from "../turnsettle.js";
import {
  isVibeAuthErrorText,
  normalizeVibeSettings,
  resolveVibeModel,
  vibeSignedOutMessage,
  type VibeSettings,
} from "./config.js";
import {
  applyVibeJsonPatch,
  asNonEmptyString,
  asNumber,
  asRecord,
  asString,
  buildVibeMessageBlocks,
  canonicalVibeToolName,
  extractVibeMessageText,
  normalizeVibeEffectEntry,
  parseVibeAccountRead,
  parseVibeContextBreakdown,
  parseVibeStatsUpdated,
  VIBE_ALWAYS_DISABLED_TOOLS,
  VIBE_METHODS,
  vibeApprovalPolicyForRuntimeMode,
  vibeDisabledMcpToolPatterns,
  vibeMcpServersOf,
} from "./protocol.js";
import { SpawnVibeTransport, type VibeTransport } from "./transport.js";
import {
  isVibeLimitError,
  rewriteVibeLimitError,
  VibeUsageAccumulator,
  vibeWindowsOf,
} from "./usage.js";

export interface VibeDriverOptions {
  readonly settings?: Partial<VibeSettings> & VibeProviderConfig;
  readonly instanceId?: string;
  readonly usageKey?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly transport?: VibeTransport;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface VibeTurnOutcome {
  readonly status: TerminalTurnStatus;
  readonly text: string;
  readonly usage: TokenUsageDelta;
  readonly generation?: { readonly characters: number; readonly durationMs: number };
  readonly error: string | null;
}

interface VibeTranscriptItem {
  readonly kind: "user" | "assistant" | "tool";
  readonly text: string;
  readonly tool?: string;
}

interface VibeAssistantSegment {
  readonly entryId: string;
  text: string;
  isNote: boolean;
}

interface VibeTranscriptTurn {
  readonly id: TurnId;
  serverTurnId: string | null;
  inputEntryId: string | null;
  readonly prompt: string;
  readonly items: VibeTranscriptItem[];
  status: "running" | TerminalTurnStatus;
  text: string;
  error: string | null;
  readonly segments: Map<string, VibeAssistantSegment>;
  activeSegment: VibeAssistantSegment | null;
  readonly reasoningStarts: Map<string, number>;
  readonly reasoningTexts: Map<string, string>;
  readonly emittedEffects: Set<string>;
  usage?: TokenUsageDelta;
  generationChars: number;
  generationMs: number;
  generationStartedAt: number | null;
}

interface ParkedVibeApproval {
  readonly callbackId: string;
  readonly threadId: ThreadId;
  readonly toolName: string;
  readonly isolated: boolean;
}

interface ParkedVibeUserInput {
  readonly callbackId: string;
  readonly threadId: ThreadId;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly question: string;
    readonly options: ReadonlyArray<string>;
  }>;
}

interface PendingSteer {
  readonly id: string;
  readonly text: string;
  readonly images: readonly ProviderImage[];
  confirmed: boolean;
}

interface VibeSession {
  readonly threadId: ThreadId;
  readonly peer: JsonRpcPeer;
  readonly workingDirectory: string;
  readonly startedAt: string;
  readonly isolation: WorktreeIsolation | null;
  readonly delegated: boolean;
  vibeSessionId: string;
  model: string | null;
  effort: string | null;
  runtimeMode: RuntimeMode;
  title: string | null;
  context: ContextWindowUsage | null;
  readonly entries: Map<string, Record<string, unknown>>;
  readonly transcript: VibeTranscriptTurn[];
  readonly waiters: TurnWaiters<VibeTurnOutcome>;
  readonly parkedApprovals: Map<ApprovalRequestId, ParkedVibeApproval>;
  readonly parkedInputs: Map<ApprovalRequestId, ParkedVibeUserInput>;
  readonly pendingSteers: PendingSteer[];
  /** A policy update not yet acknowledged; local mode only follows the ack. */
  pendingPolicy: { readonly mode: RuntimeMode; readonly promise: Promise<void> } | null;
  /** turn/completed events that arrived before the open turn was identified. */
  readonly pendingCompletions: Map<string, Record<string, unknown>>;
  readonly usage: VibeUsageAccumulator;
  backgroundProcesses: Map<string, BackgroundTaskSummary>;
  lastWindows: RateLimitWindow[];
  lastResetsAt: string | null;
  lastUsageRefreshAt: number;
  closed: boolean;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const USAGE_REFRESH_COALESCE_MS = 2_000;
const PASSIVE_USAGE_COALESCE_MS = 30_000;

function extractEffortOption(selection: ModelSelection | undefined): string | null {
  if (!selection?.options) return null;
  for (const option of selection.options) {
    const id = option.id.toLowerCase();
    if ((id === "effort" || id === "thinking" || id === "reasoning_effort") && typeof option.value === "string") {
      const val = option.value.trim();
      if (val.length > 0) return val;
    }
  }
  return null;
}

function toCliError(code: string, message: string, cause: unknown): CliError {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (isVibeAuthErrorText(text)) {
    return new CliError("VIBE_AUTH_REQUIRED", vibeSignedOutMessage(), { cause });
  }
  if (cause instanceof CliError) return cause;
  return new CliError(code, `${message}: ${text.slice(0, 240)}`, { cause });
}

function isSessionNotFoundError(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/not_found|session not found/i.test(text)) return true;
  if (cause instanceof CliError) {
    const details = asRecord(cause.details);
    if (details?.["code"] === "not_found") return true;
  }
  return false;
}

function vibeClientInfo(): Record<string, unknown> {
  return {
    name: "moxen",
    title: "Moxen",
    version: APP_VERSION,
    entrypoint: "unknown",
  };
}

function mergeDisabledTools(input: ProviderSessionStartInput): string[] {
  const disabled = new Set<string>(VIBE_ALWAYS_DISABLED_TOOLS);
  if (input.checklist === false) disabled.add("todo");
  if (input.delegated === true) disabled.add("ask_user_question");
  for (const raw of input.disabledNativeTools ?? []) {
    const name = raw.trim();
    if (name.length > 0) disabled.add(name);
  }
  for (const pattern of vibeDisabledMcpToolPatterns(input.mcpServers, input.disabledMcpTools)) {
    disabled.add(pattern);
  }
  return [...disabled];
}

function extractIsolationTargetPath(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== "Edit" && tool !== "Write") return null;
  return asNonEmptyString(input["file_path"]) ?? asNonEmptyString(input["filePath"]) ?? asNonEmptyString(input["path"]);
}

function checkWorktreeIsolation(
  isolation: WorktreeIsolation,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  const targetPath = extractIsolationTargetPath(tool, input);
  if (targetPath && escapes(isolation, targetPath, cwd)) {
    return `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. ${targetPath} is outside it.`;
  }
  const violation = isolationViolation(isolation, { tool, input, cwd });
  if (violation) return violation;
  return rawInputViolation(isolation, input, cwd);
}

function approvalShouldAutoAllow(
  mode: RuntimeMode,
  tool: string,
  kind: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  if (mode === "full-access") return true;
  if (kind === "file_read" || kind === "file_search" || kind === "todo" || kind === "skill" || kind === "scratchpad") {
    return true;
  }
  if (mode === "auto-accept-edits") {
    return kind === "file_edit" || kind === "file_write";
  }
  if (mode === "auto") {
    if (kind === "file_edit" || kind === "file_write" || kind === "web_search" || kind === "web_fetch") {
      return true;
    }
    if (kind === "shell" || tool === "Bash") {
      const command = asString(input["command"]) ?? "";
      const verdict = assessCommandLine(command, { cwd });
      return verdict.level === "safe";
    }
    return false;
  }
  return false;
}

function parseBackgroundProcesses(raw: unknown): Map<string, BackgroundTaskSummary> {
  const map = new Map<string, BackgroundTaskSummary>();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = asNonEmptyString(rec?.["processId"]);
    const status = asNonEmptyString(rec?.["status"]);
    if (!id || status !== "running") continue;
    const command = asNonEmptyString(rec?.["command"]) ?? id;
    map.set(id, {
      taskId: id,
      taskType: "shell",
      toolName: "Bash",
      description: command,
      command,
      startedAt: asNonEmptyString(rec?.["createdAt"]),
      stoppable: true,
    });
  }
  return map;
}

export class VibeDriver implements ProviderAdapter<CliError> {
  readonly provider = "vibe" as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    sessionModelSwitch: "in-session",
    supportsConversationRollback: true,
  };

  readonly compaction: ProviderCompaction<CliError> = {
    type: "native",
    start: (threadId) => this.compactSession(threadId),
  };

  private readonly settings: VibeSettings;
  private readonly instanceId: string | undefined;
  private readonly usageKey: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: VibeTransport;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sessions = new Map<ThreadId, VibeSession>();
  private readonly eventQueue: Queue.Queue<ProviderRuntimeEvent>;
  private lastPassiveWindows: RateLimitWindow[] = [];
  private lastPassiveUsageAt = 0;
  private inflightPassiveUsage: Promise<RateLimitWindow[]> | null = null;

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  constructor(options: VibeDriverOptions = {}) {
    this.settings = normalizeVibeSettings(options.settings);
    this.instanceId = options.instanceId;
    this.usageKey = options.usageKey ?? options.instanceId ?? "vibe";
    this.env = options.env ?? process.env;
    this.transport = options.transport ?? new SpawnVibeTransport();
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.eventQueue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    this.streamEvents = Stream.fromQueue(this.eventQueue);
  }

  /**
   * Run a short-lived passive `vibe-app-server` connection (`initialize` →
   * `initialized`), invoke `fn`, and tear down cleanly without leaving an open
   * session behind.
   */
  async withPeer<T>(cwd: string, fn: (peer: JsonRpcPeer, serverVersion: string | null) => Promise<T>): Promise<T> {
    const peer = this.transport.startPeer({
      settings: this.settings,
      env: this.env,
      cwd,
    });
    try {
      const init = asRecord(
        await peer.request(
          VIBE_METHODS.initialize,
          { clientInfo: vibeClientInfo(), capabilities: {} },
          this.initializeTimeoutMs,
        ),
      );
      peer.notify(VIBE_METHODS.initialized, {});
      const serverVersion = asNonEmptyString(asRecord(init?.["serverInfo"])?.["version"]);
      return await fn(peer, serverVersion);
    } finally {
      peer.close();
    }
  }

  private publish(event: ProviderRuntimeEvent): void {
    Effect.runSync(Queue.offer(this.eventQueue, event));
  }

  startSession = (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const existing = this.sessions.get(input.threadId);
        if (existing && !existing.closed) {
          return {
            threadId: existing.threadId,
            provider: this.provider,
            workingDirectory: existing.workingDirectory,
            startedAt: existing.startedAt,
          };
        }

        const peer = this.transport.startPeer({
          settings: this.settings,
          env: this.env,
          cwd: input.workingDirectory,
        });

        try {
          await peer.request(
            VIBE_METHODS.initialize,
            {
              clientInfo: vibeClientInfo(),
              capabilities: {
                callbackKinds: ["approval", "user_input"],
              },
            },
            this.initializeTimeoutMs,
          );
          peer.notify(VIBE_METHODS.initialized, {});

          const runtimeMode: RuntimeMode = input.runtimeMode ?? "auto-accept-edits";
          const model = resolveVibeModel(input.modelSelection?.model);
          const effort = extractEffortOption(input.modelSelection);
          // Worktree-isolated sessions use `ask` so every tool call reaches
          // Moxen's approval callback where we enforce worktree boundaries.
          const approvalPolicy = input.isolation
            ? "ask"
            : vibeApprovalPolicyForRuntimeMode(runtimeMode);
          const disabledTools = mergeDisabledTools(input);
          const mcpServers = vibeMcpServersOf(input.mcpServers);

          const agentConfig: Record<string, unknown> = {
            cwd: input.workingDirectory,
            trustWorkspace: true,
            approvalPolicy,
            disabledTools,
            ...(input.instructions && input.instructions.trim().length > 0
              ? { instructions: input.instructions }
              : {}),
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
          };

          const startedAt = new Date().toISOString();
          const session: VibeSession = {
            threadId: input.threadId,
            peer,
            workingDirectory: input.workingDirectory,
            startedAt,
            isolation: input.isolation ?? null,
            delegated: input.delegated === true,
            vibeSessionId: "",
            model,
            effort,
            runtimeMode,
            title: null,
            context: null,
            entries: new Map(),
            transcript: [],
            waiters: new Map(),
            parkedApprovals: new Map(),
            parkedInputs: new Map(),
            pendingSteers: [],
            pendingPolicy: null,
            pendingCompletions: new Map(),
            usage: new VibeUsageAccumulator(),
            backgroundProcesses: new Map(),
            lastWindows: [],
            lastResetsAt: null,
            lastUsageRefreshAt: 0,
            closed: false,
          };

          // Attach handlers BEFORE session/start or session/resume so startup
          // snapshots and callbacks are never missed.
          this.wirePeer(session);

          let response: Record<string, unknown> | null = null;
          if (input.resumeCursor) {
            try {
              response = asRecord(
                await peer.request(
                  VIBE_METHODS.sessionResume,
                  {
                    sessionId: input.resumeCursor,
                    agentConfig,
                    interruptLeftTurn: true,
                  },
                  this.requestTimeoutMs,
                ),
              );
            } catch (cause) {
              if (!isSessionNotFoundError(cause)) throw cause;
            }
          }

          if (!response) {
            response = asRecord(
              await peer.request(
                VIBE_METHODS.sessionStart,
                {
                  agentConfig,
                  sessionOnly: true,
                  ...(model ? { model } : {}),
                  ...(effort ? { reasoningEffort: effort } : {}),
                },
                this.requestTimeoutMs,
              ),
            );
          }

          const state = asRecord(response?.["state"]);
          const sessionMeta = asRecord(state?.["session"]);
          const vibeSessionId = asNonEmptyString(sessionMeta?.["id"]);
          if (!vibeSessionId) {
            throw new CliError("VIBE_START_FAILED", "vibe-app-server returned no session id.");
          }
          session.vibeSessionId = vibeSessionId;
          this.adoptSessionState(session, state);
          this.sessions.set(input.threadId, session);

          // Best-effort initial monthly budget read; never blocks or fails session startup.
          void this.refreshSessionAccount(session, true);

          return {
            threadId: session.threadId,
            provider: this.provider,
            workingDirectory: session.workingDirectory,
            startedAt: session.startedAt,
          };
        } catch (cause) {
          peer.close();
          throw cause;
        }
      },
      catch: (cause) => toCliError("VIBE_SESSION_START_FAILED", "Could not start Mistral Vibe session", cause),
    });

  private wirePeer(session: VibeSession): void {
    session.peer.onRequest((method, params) => {
      if (method === VIBE_METHODS.callbackCall) {
        return this.handleCallbackCall(session, params);
      }
      throw new CliError("VIBE_UNSUPPORTED_REQUEST", `Unsupported client method: ${method}`);
    });

    session.peer.onNotification((method, params) => {
      this.handleNotification(session, method, params);
    });

    session.peer.onExit((code) => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(session.threadId);
      const running = this.runningTurn(session);
      if (running) {
        this.failTurn(
          session,
          running,
          `Mistral Vibe exited unexpectedly${code !== null ? ` (code ${code})` : ""}.`,
        );
      }
    });
  }

  private adoptSessionState(session: VibeSession, state: Record<string, unknown> | null): void {
    if (!state) return;
    const meta = asRecord(state["session"]);
    const newId = asNonEmptyString(meta?.["id"]);
    if (newId) session.vibeSessionId = newId;
    const title = asNonEmptyString(meta?.["title"]);
    if (title && title !== session.title) {
      session.title = title;
      this.publish({
        type: "session.title.updated",
        provider: this.provider,
        threadId: session.threadId,
        title,
      });
    }
    const rawHistory = Array.isArray(state["history"]) ? state["history"] : null;
    if (rawHistory) {
      session.entries.clear();
      for (const item of rawHistory) {
        const rec = asRecord(item);
        const id = asNonEmptyString(rec?.["id"]);
        if (id && rec) session.entries.set(id, rec);
      }
    }
    if (Array.isArray(state["backgroundProcesses"])) {
      this.syncBackgroundProcesses(session, state["backgroundProcesses"]);
    }
  }

  private syncBackgroundProcesses(session: VibeSession, rawList: unknown): void {
    const next = parseBackgroundProcesses(rawList);
    const prev = session.backgroundProcesses;
    let changed = next.size !== prev.size;
    if (!changed) {
      for (const [id] of next) {
        if (!prev.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    session.backgroundProcesses = next;
    this.publish({
      type: "background.tasks.changed",
      provider: this.provider,
      threadId: session.threadId,
      tasks: [...next.values()],
    });
  }

  private handleCallbackCall(session: VibeSession, params: unknown): Record<string, unknown> {
    const rec = asRecord(params);
    const callback = asRecord(rec?.["callback"]);
    const callbackId = asNonEmptyString(callback?.["callbackId"]);
    const detail = asRecord(callback?.["detail"]);
    if (!callbackId || !detail) {
      return { callbackId: callbackId ?? "", accepted: false };
    }

    const kind = asNonEmptyString(detail["kind"]);
    if (kind === "approval") {
      this.processApprovalCallback(session, callbackId, detail);
      return { callbackId, accepted: true };
    }
    if (kind === "user_input") {
      this.processUserInputCallback(session, callbackId, detail);
      return { callbackId, accepted: true };
    }

    // Unsupported callback kinds (e.g. connector_auth): accept delivery and
    // decline cleanly so the turn never hangs.
    void this.sendCallbackResult(session, callbackId, null, {
      message: `Moxen does not support ${kind ?? "unknown"} callbacks interactively.`,
      code: "unsupported_callback",
    });
    return { callbackId, accepted: true };
  }

  private processApprovalCallback(
    session: VibeSession,
    callbackId: string,
    detail: Record<string, unknown>,
  ): void {
    const effect = asRecord(detail["effect"]) ?? {};
    const effectKind = asNonEmptyString(effect["kind"]) ?? "tool";
    const rawToolName = asNonEmptyString(effect["toolName"]) ?? effectKind;
    const toolName = canonicalVibeToolName(rawToolName, effectKind);
    const rawInput = asRecord(effect["input"]) ?? {};
    const input: Record<string, unknown> = { ...rawInput };
    if (typeof input["filePath"] === "string" && input["file_path"] === undefined) {
      input["file_path"] = input["filePath"];
    }

    // 1. Worktree isolation is absolute — deny before checking runtime mode.
    if (session.isolation) {
      const violation = checkWorktreeIsolation(session.isolation, toolName, input, session.workingDirectory);
      if (violation) {
        this.publish({
          type: "session.notice",
          provider: this.provider,
          threadId: session.threadId,
          turnId: this.runningTurn(session)?.id ?? null,
          notice: "permission-denied",
          title: `Blocked ${toolName} outside worktree`,
          detail: violation,
        });
        void this.sendCallbackResult(session, callbackId, {
          type: "approval",
          decision: { type: "deny" },
          feedback: violation,
        });
        return;
      }
    }

    // 2. Automatic approval based on runtime mode and Harness command safety.
    if (approvalShouldAutoAllow(session.runtimeMode, toolName, effectKind, input, session.workingDirectory)) {
      void this.sendCallbackResult(session, callbackId, {
        type: "approval",
        decision: { type: "approve" },
      });
      return;
    }

    // 3. Delegated threads cannot prompt a human — deny anything not auto-allowed.
    if (session.delegated) {
      void this.sendCallbackResult(session, callbackId, {
        type: "approval",
        decision: { type: "deny" },
        feedback: `Tool ${toolName} requires interactive approval and cannot run in a delegated thread under ${session.runtimeMode}.`,
      });
      return;
    }

    // 4. Park for user approval in Moxen's permission panel.
    session.parkedApprovals.set(callbackId, {
      callbackId,
      threadId: session.threadId,
      toolName,
      isolated: session.isolation !== null,
    });
    this.publish({
      type: "permission.request.opened",
      provider: this.provider,
      threadId: session.threadId,
      requestId: callbackId,
      raw: {
        toolName,
        input,
        reason: asNonEmptyString(detail["reason"]),
      },
    });
  }

  private processUserInputCallback(
    session: VibeSession,
    callbackId: string,
    detail: Record<string, unknown>,
  ): void {
    if (session.delegated) {
      void this.sendCallbackResult(session, callbackId, {
        type: "user_input",
        result: { answers: [], cancelled: true },
      });
      return;
    }
    const request = asRecord(detail["request"]);
    const rawQuestions = Array.isArray(request?.["questions"]) ? request!["questions"] : [];
    const normalized: Array<{
      readonly id: string;
      readonly question: string;
      readonly header: string;
      readonly multiSelect: boolean;
      readonly allowCustomAnswer: boolean;
      readonly options: Array<{ readonly label: string; readonly description?: string }>;
    }> = [];
    const parkedMeta: Array<{
      readonly id: string;
      readonly question: string;
      readonly options: ReadonlyArray<string>;
    }> = [];

    for (const entry of rawQuestions) {
      const q = asRecord(entry);
      const question = asNonEmptyString(q?.["question"]);
      if (!question) continue;
      const rawOpts = Array.isArray(q?.["options"]) ? q!["options"] : [];
      const options: Array<{ readonly label: string; readonly description?: string }> = [];
      const optionLabels: string[] = [];
      for (const opt of rawOpts) {
        const o = asRecord(opt);
        const label = asNonEmptyString(o?.["label"]);
        if (!label) continue;
        const desc = asNonEmptyString(o?.["description"]);
        options.push(desc ? { label, description: desc } : { label });
        optionLabels.push(label);
      }
      normalized.push({
        id: question,
        question,
        header: asNonEmptyString(q?.["header"]) ?? "Question",
        multiSelect: q?.["multiSelect"] === true,
        allowCustomAnswer: q?.["hideOther"] !== true,
        options,
      });
      parkedMeta.push({ id: question, question, options: optionLabels });
    }

    if (normalized.length === 0) {
      void this.sendCallbackResult(session, callbackId, {
        type: "user_input",
        result: { answers: [], cancelled: true },
      });
      return;
    }

    session.parkedInputs.set(callbackId, {
      callbackId,
      threadId: session.threadId,
      questions: parkedMeta,
    });
    this.publish({
      type: "user-input.request.opened",
      provider: this.provider,
      threadId: session.threadId,
      requestId: callbackId,
      raw: { questions: normalized },
    });
  }

  private async sendCallbackResult(
    session: VibeSession,
    callbackId: string,
    output: unknown,
    error?: { readonly message: string; readonly code?: string },
  ): Promise<void> {
    if (session.closed) return;
    try {
      await session.peer.request(
        VIBE_METHODS.callbackResult,
        {
          sessionId: session.vibeSessionId,
          result: {
            callbackId,
            ...(output !== null && output !== undefined ? { output } : {}),
            ...(error ? { error } : {}),
          },
        },
        this.requestTimeoutMs,
      );
    } catch {
      // Callback may already have closed on cancel/interrupt.
    }
  }

  private handleNotification(session: VibeSession, method: string, params: unknown): void {
    const rec = asRecord(params);
    if (!rec) return;

    switch (method) {
      case VIBE_METHODS.sessionSnapshot: {
        this.adoptSessionState(session, asRecord(rec["state"]));
        break;
      }
      case VIBE_METHODS.sessionUpdated: {
        const patch = rec["patch"];
        if (Array.isArray(patch)) {
          for (const op of patch) {
            const o = asRecord(op);
            const ptr = asString(o?.["path"]);
            if (ptr === "/title") {
              const title = asNonEmptyString(o?.["value"]);
              if (title && title !== session.title) {
                session.title = title;
                this.publish({
                  type: "session.title.updated",
                  provider: this.provider,
                  threadId: session.threadId,
                  title,
                });
              }
            } else if (ptr === "/backgroundProcesses") {
              this.syncBackgroundProcesses(session, o?.["value"]);
            }
          }
        }
        break;
      }
      case VIBE_METHODS.sessionCompacted: {
        const state = asRecord(rec["state"]);
        this.adoptSessionState(session, state);
        session.usage.resetBaseline();
        this.publish({
          type: "session.notice",
          provider: this.provider,
          threadId: session.threadId,
          turnId: this.runningTurn(session)?.id ?? null,
          notice: "compacted",
          title: "Compacted conversation history",
          detail: null,
        });
        break;
      }
      case VIBE_METHODS.historyEntryAdded: {
        const entry = asRecord(rec["entry"]);
        if (entry) this.onHistoryEntry(session, entry, null);
        break;
      }
      case VIBE_METHODS.historyEntryUpdated: {
        const entryId = asNonEmptyString(rec["entryId"]);
        if (!entryId) break;
        const previous = session.entries.get(entryId);
        if (!previous) break;
        const next = asRecord(applyVibeJsonPatch(previous, rec["patch"]));
        if (!next) break;
        this.onHistoryEntry(session, next, previous);
        break;
      }
      case VIBE_METHODS.turnStarted: {
        const turnMeta = asRecord(rec["turn"]);
        const sid = asNonEmptyString(turnMeta?.["id"]);
        if (!sid || !this.notificationMatchesSession(session, rec)) break;
        const running = this.runningTurn(session);
        if (running && running.serverTurnId === null) {
          running.serverTurnId = sid;
          const inputId = asNonEmptyString(turnMeta!["inputEntryId"]);
          if (inputId) running.inputEntryId = inputId;
          this.drainBufferedCompletion(session, running);
        }
        break;
      }
      case VIBE_METHODS.turnCompleted: {
        const turnMeta = asRecord(rec["turn"]);
        if (!turnMeta || !this.notificationMatchesSession(session, rec)) break;
        const running = this.runningTurn(session);
        if (!running) break;
        const sid = asNonEmptyString(turnMeta["id"]);
        if (running.serverTurnId === null) {
          // The start response has not identified the turn yet: hold the
          // event until it has, then apply it only if it names this turn.
          if (sid) {
            session.pendingCompletions.set(sid, turnMeta);
            if (session.pendingCompletions.size > 16) {
              const oldest = session.pendingCompletions.keys().next().value;
              if (oldest !== undefined) session.pendingCompletions.delete(oldest);
            }
          }
          break;
        }
        // A stale or foreign completion must never settle the open turn.
        if (sid !== running.serverTurnId) break;
        this.onTurnCompleted(session, turnMeta);
        break;
      }
      case VIBE_METHODS.statsUpdated: {
        const stats = parseVibeStatsUpdated(rec);
        if (!stats) break;
        const running = this.runningTurn(session);
        if (stats.contextTokens > 0 || stats.contextWindow !== null) {
          session.context = {
            usedTokens: stats.contextTokens,
            maxTokens: stats.contextWindow ?? session.context?.maxTokens ?? null,
            cachedInputTokens: stats.lastTurnCachedTokens > 0 ? stats.lastTurnCachedTokens : null,
            autoCompactThreshold: session.context?.autoCompactThreshold ?? null,
            compactsAutomatically: session.context?.compactsAutomatically ?? null,
          };
        }
        if (running) {
          const delta = session.usage.observe(running.id, stats);
          running.usage = delta;
          this.publish({
            type: "token-usage.updated",
            provider: this.provider,
            threadId: session.threadId,
            usage: delta,
            raw: rec,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private onHistoryEntry(
    session: VibeSession,
    entry: Record<string, unknown>,
    previous: Record<string, unknown> | null,
  ): void {
    const id = asNonEmptyString(entry["id"]);
    const type = asNonEmptyString(entry["type"]);
    if (!id || !type) return;
    session.entries.set(id, entry);

    const turn = this.runningTurn(session);
    if (!turn) return;

    if (type === "message") {
      const role = asNonEmptyString(entry["role"]);
      if (role === "user") {
        const source = asNonEmptyString(entry["source"]);
        const text = extractVibeMessageText(entry);
        if (source === "turn_steer") {
          // Vibe echoes the steer under its `clientUserMessageId` as the entry
          // id (verified on v3.1.4); exact text is the fallback for a server
          // that does not. Never confirm an unrelated steer blindly.
          const match = session.pendingSteers.find((s) => !s.confirmed && s.id === id)
            ?? session.pendingSteers.find((s) => !s.confirmed && s.text === text);
          if (match) match.confirmed = true;
        } else if (!turn.inputEntryId) {
          turn.inputEntryId = id;
        }
        return;
      }
      if (role === "assistant") {
        // Ignore discarded assistant entries (e.g. output-limit retries).
        const outcome = asRecord(entry["outcome"]);
        if (outcome?.["type"] === "discarded") return;

        const prevText = previous ? extractVibeMessageText(previous) : "";
        const nextText = extractVibeMessageText(entry);
        const delta = nextText.startsWith(prevText) ? nextText.slice(prevText.length) : nextText;

        let seg = turn.segments.get(id);
        if (!seg) {
          // If a prior assistant segment already exists and a new one starts,
          // demote the previous segment to an interim note.
          if (turn.activeSegment && turn.activeSegment.entryId !== id && !turn.activeSegment.isNote && turn.activeSegment.text.trim().length > 0) {
            turn.activeSegment.isNote = true;
            this.publish({
              type: "assistant.note",
              provider: this.provider,
              threadId: session.threadId,
              turnId: turn.id,
              messageId: turn.activeSegment.entryId,
              text: turn.activeSegment.text,
            });
          }
          seg = { entryId: id, text: "", isNote: false };
          turn.segments.set(id, seg);
          turn.activeSegment = seg;
        }
        seg.text = nextText;

        if (delta.length > 0) {
          if (turn.generationStartedAt === null) turn.generationStartedAt = Date.now();
          turn.generationChars += delta.length;
          this.publish({
            type: "message.part.updated",
            provider: this.provider,
            threadId: session.threadId,
            turnId: turn.id,
            messageId: id,
            text: delta,
            raw: entry,
          });
        }
        if (entry["generationStatus"] === "completed" && turn.generationStartedAt !== null) {
          turn.generationMs += Math.max(0, Date.now() - turn.generationStartedAt);
          turn.generationStartedAt = null;
        }
      }
      return;
    }

    if (type === "reasoning") {
      const prevText = previous ? asString(previous["text"]) ?? "" : "";
      const nextText = asString(entry["text"]) ?? "";
      const delta = nextText.startsWith(prevText) ? nextText.slice(prevText.length) : nextText;
      const done = entry["generationStatus"] === "completed";
      let startedAt = turn.reasoningStarts.get(id);
      if (startedAt === undefined) {
        startedAt = Date.now();
        turn.reasoningStarts.set(id, startedAt);
        this.publish({
          type: "reasoning.updated",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          reasoningId: id,
          status: "running",
          text: nextText,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: null,
        });
      }
      turn.reasoningTexts.set(id, nextText);
      if (delta.length > 0) {
        this.publish({
          type: "reasoning.delta",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          reasoningId: id,
          text: delta,
        });
      }
      if (done) {
        this.publish({
          type: "reasoning.updated",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          reasoningId: id,
          status: "completed",
          text: nextText,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      }
      return;
    }

    if (type === "effect") {
      // A tool call starting after assistant text means that text was an interim note.
      if (turn.activeSegment && !turn.activeSegment.isNote && turn.activeSegment.text.trim().length > 0) {
        turn.activeSegment.isNote = true;
        this.publish({
          type: "assistant.note",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          messageId: turn.activeSegment.entryId,
          text: turn.activeSegment.text,
        });
        turn.activeSegment = null;
      }

      const norm = normalizeVibeEffectEntry(entry);
      if (!norm) return;
      const alreadyEmitted = turn.emittedEffects.has(norm.callId);
      turn.emittedEffects.add(norm.callId);
      const eventType =
        norm.status === "inProgress"
          ? alreadyEmitted
            ? "tool.execute.updated"
            : "tool.execute.started"
          : "tool.execute.completed";

      this.publish({
        type: eventType,
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        tool: norm.tool,
        raw: {
          toolCallId: norm.callId,
          status: norm.status === "inProgress" ? "in_progress" : norm.status,
          stopped: norm.stopped,
          input: norm.input,
          output: norm.output,
          exit: norm.exit,
          endMs: norm.durationMs,
          files: norm.files,
          patch: norm.patch,
          title: norm.title,
        },
      });

      if (norm.todos) {
        this.publish({
          type: "turn.plan.updated",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          raw: {
            plan: norm.todos.map((item) => ({
              step: item.content,
              status:
                item.status === "in_progress"
                  ? "inProgress"
                  : item.status === "completed"
                    ? "completed"
                    : "pending",
            })),
          },
        });
      }
    }
  }

  /** Notifications carry `sessionId`; a stale one from a handed-off session is ignored. */
  private notificationMatchesSession(session: VibeSession, rec: Record<string, unknown>): boolean {
    const sid = asNonEmptyString(rec["sessionId"]);
    return sid === null || sid === session.vibeSessionId;
  }

  /** Apply a completion buffered before the turn was identified, if it names this turn. */
  private drainBufferedCompletion(session: VibeSession, turn: VibeTranscriptTurn): void {
    const buffered = turn.serverTurnId ? session.pendingCompletions.get(turn.serverTurnId) : undefined;
    session.pendingCompletions.clear();
    if (buffered && turn.status === "running") this.onTurnCompleted(session, buffered);
  }

  private onTurnCompleted(session: VibeSession, turnMeta: Record<string, unknown>): void {
    const running = this.runningTurn(session);
    if (!running) return;
    const rawStatus = asNonEmptyString(turnMeta["status"]) ?? "completed";
    const errRec = asRecord(turnMeta["error"]);
    const errCode = asNonEmptyString(errRec?.["code"]);
    const rawErrMsg = asNonEmptyString(errRec?.["message"]);

    // Settle any remaining generation timer.
    if (running.generationStartedAt !== null) {
      running.generationMs += Math.max(0, Date.now() - running.generationStartedAt);
      running.generationStartedAt = null;
    }

    // Cancel any parked callbacks left behind.
    this.clearParkedCallbacks(session);

    const status: TerminalTurnStatus =
      rawStatus === "interrupted"
        ? "interrupted"
        : rawStatus === "failed"
          ? "failed"
          : "completed";

    let error: string | null = rawErrMsg;
    if (status === "failed" && error && isVibeLimitError(errCode, error)) {
      error = rewriteVibeLimitError(error, session.lastResetsAt);
      this.publish({
        type: "thread.state.changed",
        provider: this.provider,
        threadId: session.threadId,
        state: "rate-limited",
        raw: { code: errCode, message: rawErrMsg },
      });
      void this.refreshSessionAccount(session, true);
    } else {
      void this.refreshSessionAccount(session, false);
    }

    const answerSegments = [...running.segments.values()].filter((s) => !s.isNote);
    const text =
      answerSegments.length > 0
        ? answerSegments.map((s) => s.text).join("\n\n")
        : [...running.segments.values()].at(-1)?.text ?? "";

    const usage = session.usage.take(running.id);
    settleAndPublishTurn({
      open: running,
      waiters: session.waiters,
      status,
      apply: (turn) => {
        turn.status = status;
        turn.text = text;
        turn.error = error;
        turn.usage = usage;
        if (text.length > 0) {
          turn.items.push({ kind: "assistant", text });
        }
        return {
          status,
          text,
          usage,
          ...(turn.generationChars > 0
            ? { generation: { characters: turn.generationChars, durationMs: Math.max(1, turn.generationMs) } }
            : {}),
          error,
        };
      },
      publish: (event) => this.publish(event),
      event: (turnId) =>
        terminalTurnEvent(this.provider, session.threadId, turnId, status, {
          ...(error ? { error } : {}),
          raw: turnMeta,
        }),
    });
  }

  private failTurn(session: VibeSession, turn: VibeTranscriptTurn, error: string): void {
    this.clearParkedCallbacks(session);
    const usage = session.usage.take(turn.id);
    settleAndPublishTurn({
      open: turn,
      waiters: session.waiters,
      status: "failed",
      apply: (openTurn) => {
        openTurn.status = "failed";
        openTurn.error = error;
        openTurn.usage = usage;
        return { status: "failed" as const, text: openTurn.text, usage, error };
      },
      publish: (event) => this.publish(event),
      event: (turnId) => terminalTurnEvent(this.provider, session.threadId, turnId, "failed", { error }),
    });
  }

  private clearParkedCallbacks(session: VibeSession): void {
    for (const [id, approval] of session.parkedApprovals) {
      session.parkedApprovals.delete(id);
      this.publish({
        type: "permission.request.resolved",
        provider: this.provider,
        threadId: session.threadId,
        requestId: id,
        raw: { toolName: approval.toolName, behavior: "cancel" },
      });
    }
    for (const [id] of session.parkedInputs) {
      session.parkedInputs.delete(id);
      this.publish({
        type: "user-input.request.resolved",
        provider: this.provider,
        threadId: session.threadId,
        requestId: id,
      });
    }
  }

  private async refreshSessionAccount(session: VibeSession, force: boolean): Promise<RateLimitWindow[]> {
    if (session.closed || !session.vibeSessionId) return session.lastWindows;
    const now = Date.now();
    if (!force && now - session.lastUsageRefreshAt < USAGE_REFRESH_COALESCE_MS) {
      return session.lastWindows;
    }
    session.lastUsageRefreshAt = now;
    try {
      const raw = await session.peer.request(
        VIBE_METHODS.accountRead,
        { sessionId: session.vibeSessionId },
        10_000,
      );
      const account = parseVibeAccountRead(raw);
      const windows = vibeWindowsOf(account);
      session.lastWindows = windows;
      session.lastResetsAt = account?.budget?.resetAt ?? session.lastResetsAt;
      if (windows.length > 0) {
        this.publish({
          type: "rate-limits.updated",
          provider: this.provider,
          threadId: session.threadId,
          windows,
          ...(this.instanceId ? { instanceId: this.instanceId } : {}),
          raw,
        });
      }
      return windows;
    } catch {
      return session.lastWindows;
    }
  }

  private runningTurn(session: VibeSession): VibeTranscriptTurn | undefined {
    for (let i = session.transcript.length - 1; i >= 0; i--) {
      if (session.transcript[i]!.status === "running") return session.transcript[i];
    }
    return undefined;
  }

  private requireSession(threadId: ThreadId): VibeSession {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      throw new CliError("SESSION_NOT_FOUND", `No active Mistral Vibe session for thread ${threadId}.`);
    }
    return session;
  }

  sendTurn = (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(input.threadId);
        const turnId: TurnId = `vibe-turn-${randomUUID()}`;
        const turn: VibeTranscriptTurn = {
          id: turnId,
          serverTurnId: null,
          inputEntryId: null,
          prompt: input.prompt,
          items: [{ kind: "user", text: input.prompt }],
          status: "running",
          text: "",
          error: null,
          segments: new Map(),
          activeSegment: null,
          reasoningStarts: new Map(),
          reasoningTexts: new Map(),
          emittedEffects: new Set(),
          generationChars: 0,
          generationMs: 0,
          generationStartedAt: null,
        };
        session.transcript.push(turn);
        session.pendingSteers.length = 0;
        session.pendingCompletions.clear();

        try {
          // Native `/compact` inside a turn.
          if (isCompactCommand(input.prompt)) {
            try {
              const compacted = asRecord(
                await session.peer.request(
                  VIBE_METHODS.sessionCompact,
                  { sessionId: session.vibeSessionId, extraInstructions: "" },
                  120_000,
                ),
              );
              this.adoptSessionState(session, asRecord(compacted?.["state"]));
              session.usage.resetBaseline();
              const summary = asNonEmptyString(compacted?.["summary"]) ?? "Compacted conversation history.";
              this.publish({
                type: "session.notice",
                provider: this.provider,
                threadId: session.threadId,
                turnId,
                notice: "compacted",
                title: "Compacted conversation history",
                detail: summary,
              });
              const usage = session.usage.take(turnId);
              settleAndPublishTurn({
                open: turn,
                waiters: session.waiters,
                status: "completed",
                apply: (openTurn) => {
                  openTurn.status = "completed";
                  openTurn.text = summary;
                  openTurn.usage = usage;
                  return { status: "completed" as const, text: summary, usage, error: null };
                },
                publish: (event) => this.publish(event),
                event: (id) => terminalTurnEvent(this.provider, session.threadId, id, "completed", { summary }),
              });
              return { threadId: session.threadId, turnId };
            } catch (cause) {
              const msg = cause instanceof Error ? cause.message : String(cause);
              this.failTurn(session, turn, msg);
              return { threadId: session.threadId, turnId };
            }
          }

          // Apply mid-session model/effort switch with `sessionOnly: true`.
          const nextModel = resolveVibeModel(input.modelSelection?.model);
          const nextEffort = extractEffortOption(input.modelSelection);
          if ((nextModel && nextModel !== session.model) || (nextEffort && nextEffort !== session.effort)) {
            await session.peer.request(
              VIBE_METHODS.configModelWrite,
              {
                sessionId: session.vibeSessionId,
                ...(nextModel ? { modelAlias: nextModel } : {}),
                ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
                sessionOnly: true,
              },
              this.requestTimeoutMs,
            );
            if (nextModel) session.model = nextModel;
            if (nextEffort) session.effort = nextEffort;
          }

          // A mode change only takes effect once the server acknowledges the
          // matching approval policy; a turn never starts under a policy the
          // server refused or has not confirmed.
          const targetMode = input.runtimeMode ?? session.pendingPolicy?.mode ?? session.runtimeMode;
          await this.ensureRuntimeMode(session, targetMode);

          let startResult: Record<string, unknown> | null;
          try {
            startResult = asRecord(
              await session.peer.request(
                VIBE_METHODS.turnStart,
                {
                  sessionId: session.vibeSessionId,
                  message: buildVibeMessageBlocks(input.prompt, input.images),
                },
                this.requestTimeoutMs,
              ),
            );
          } catch (cause) {
            if (cause instanceof CliError && cause.code === "PEER_REQUEST_TIMEOUT") {
              // The server may have begun a turn we can neither name nor
              // interrupt: close the peer rather than leave it running.
              this.invalidateSession(session);
              throw new CliError(
                "VIBE_TURN_START_FAILED",
                "Mistral Vibe turn start timed out; the session was closed because the server may still be running a turn Moxen cannot identify.",
                { cause },
              );
            }
            throw cause;
          }
          const serverTurn = asRecord(startResult?.["turn"]);
          const serverTurnId = asNonEmptyString(serverTurn?.["id"]);
          if (!serverTurnId) {
            this.invalidateSession(session);
            throw new CliError(
              "VIBE_TURN_START_FAILED",
              "vibe-app-server returned no turn id; the session was closed because the turn cannot be identified or interrupted.",
            );
          }
          turn.serverTurnId = serverTurnId;
          const inputEntryId = asNonEmptyString(serverTurn?.["inputEntryId"]);
          if (inputEntryId) turn.inputEntryId = inputEntryId;
          this.drainBufferedCompletion(session, turn);

          return { threadId: session.threadId, turnId };
        } catch (cause) {
          // A startup failure must never leave a running transcript row (and
          // its parked waiters) behind.
          this.failTurn(session, turn, cause instanceof Error ? cause.message : String(cause));
          throw cause;
        }
      },
      catch: (cause) => toCliError("VIBE_TURN_START_FAILED", "Could not start Mistral Vibe turn", cause),
    });

  steerTurn = (
    threadId: ThreadId,
    text: string,
    images?: readonly ProviderImage[],
    steerId?: string,
  ): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        const running = this.runningTurn(session);
        if (!running || !running.serverTurnId) {
          throw new CliError("NO_RUNNING_TURN", "Cannot steer: no turn is currently running.");
        }
        const id = steerId ?? `steer-${randomUUID()}`;
        const pending: PendingSteer = { id, text, images: images ? [...images] : [], confirmed: false };
        session.pendingSteers.push(pending);
        await session.peer.request(
          VIBE_METHODS.turnSteer,
          {
            sessionId: session.vibeSessionId,
            expectedTurnId: running.serverTurnId,
            message: buildVibeMessageBlocks(text, images),
            // Vibe echoes this id as the steer entry's id, so the
            // acknowledgement can be scoped to this exact message.
            clientUserMessageId: id,
          },
          this.requestTimeoutMs,
        );
      },
      catch: (cause) => toCliError("VIBE_STEER_FAILED", "Could not steer Mistral Vibe turn", cause),
    });

  takeUnconfirmedSteers = (threadId: ThreadId): ReadonlyArray<UnconfirmedSteer> => {
    const session = this.sessions.get(threadId);
    if (!session) return [];
    const unconfirmed = session.pendingSteers
      .filter((s) => !s.confirmed)
      .map((s) => ({ id: s.id, text: s.text, images: s.images }));
    session.pendingSteers.length = 0;
    return unconfirmed;
  };

  setRuntimeMode = (threadId: ThreadId, mode: RuntimeMode): void => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return;
    if (session.isolation) {
      session.runtimeMode = mode;
      return;
    }
    if (mode === session.runtimeMode && !session.pendingPolicy) return;
    // The error is kept in pendingPolicy, not swallowed: the next turn start
    // retries the update and refuses to run until the server acknowledges it.
    void this.applyRuntimeMode(session, mode).catch(() => undefined);
  };

  /**
   * Bring the session to `mode`, waiting for any in-flight policy update
   * first. The local mode only ever follows a server acknowledgement, so a
   * downgrade the server refused can never let a turn run under the old
   * wider policy: the retry below throws and the turn start fails instead.
   */
  private async ensureRuntimeMode(session: VibeSession, mode: RuntimeMode): Promise<void> {
    const pending = session.pendingPolicy;
    if (pending) {
      await pending.promise.catch(() => undefined);
      if (session.pendingPolicy === pending && mode === session.runtimeMode) {
        // The pending change failed and is no longer asked for.
        session.pendingPolicy = null;
        return;
      }
    }
    if (session.runtimeMode !== mode) await this.applyRuntimeMode(session, mode);
  }

  private applyRuntimeMode(session: VibeSession, mode: RuntimeMode): Promise<void> {
    if (session.isolation) {
      // Isolated sessions always run `ask`; the mode only gates Moxen's own
      // auto-approval, so no server acknowledgement is needed.
      session.runtimeMode = mode;
      return Promise.resolve();
    }
    const promise = session.peer
      .request(
        VIBE_METHODS.sessionApprovalPolicyUpdate,
        {
          sessionId: session.vibeSessionId,
          approvalPolicy: vibeApprovalPolicyForRuntimeMode(mode),
        },
        this.requestTimeoutMs,
      )
      .then(() => {
        // A superseded update must not roll the local mode back.
        if (session.pendingPolicy?.promise !== promise) return;
        session.runtimeMode = mode;
        session.pendingPolicy = null;
      });
    session.pendingPolicy = { mode, promise };
    return promise;
  }

  /** Close a session whose server state can no longer be trusted or identified. */
  private invalidateSession(session: VibeSession): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.threadId);
    this.clearParkedCallbacks(session);
    session.peer.close();
  }

  awaitTurn = (threadId: ThreadId, turnId: TurnId, signal?: AbortSignal): Promise<VibeTurnOutcome> => {
    const session = this.sessions.get(threadId);
    if (!session) {
      return Promise.reject(new CliError("SESSION_NOT_FOUND", `No Mistral Vibe session for thread ${threadId}.`));
    }
    const existing = session.transcript.find((t) => t.id === turnId);
    if (existing && existing.status !== "running") {
      return Promise.resolve({
        status: existing.status,
        text: existing.text,
        usage: existing.usage ?? { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 },
        ...(existing.generationChars > 0
          ? { generation: { characters: existing.generationChars, durationMs: Math.max(1, existing.generationMs) } }
          : {}),
        error: existing.error,
      });
    }
    return parkTurnWaiter({
      waiters: session.waiters,
      turnId,
      signal,
      onAbort: () => new CliError("TURN_ABORTED", "Mistral Vibe turn wait aborted."),
    });
  };

  interruptTurn = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        // Settle parked callbacks before interrupting so the server never deadlocks.
        for (const [id, approval] of [...session.parkedApprovals]) {
          session.parkedApprovals.delete(id);
          await this.sendCallbackResult(session, id, {
            type: "approval",
            decision: { type: "cancel_turn" },
          });
          this.publish({
            type: "permission.request.resolved",
            provider: this.provider,
            threadId: session.threadId,
            requestId: id,
            raw: { toolName: approval.toolName, behavior: "cancel" },
          });
        }
        for (const [id] of [...session.parkedInputs]) {
          session.parkedInputs.delete(id);
          await this.sendCallbackResult(session, id, {
            type: "user_input",
            result: { answers: [], cancelled: true },
          });
          this.publish({
            type: "user-input.request.resolved",
            provider: this.provider,
            threadId: session.threadId,
            requestId: id,
          });
        }
        const running = this.runningTurn(session);
        if (!running?.serverTurnId) return;
        await session.peer.request(
          VIBE_METHODS.turnInterrupt,
          {
            sessionId: session.vibeSessionId,
            expectedTurnId: running.serverTurnId,
          },
          this.requestTimeoutMs,
        );
      },
      catch: (cause) => toCliError("VIBE_INTERRUPT_FAILED", "Could not interrupt Mistral Vibe turn", cause),
    });

  respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        const parked = session.parkedApprovals.get(requestId);
        if (!parked) return;
        session.parkedApprovals.delete(requestId);
        // Never grant session-wide approvals inside worktree-isolated sessions.
        const vibeDecisionType =
          decision.kind === "accept"
            ? "approve"
            : decision.kind === "acceptForSession"
              ? parked.isolated
                ? "approve"
                : "approve_for_session"
              : decision.kind === "cancel"
                ? "cancel_turn"
                : "deny";
        await this.sendCallbackResult(session, parked.callbackId, {
          type: "approval",
          decision: { type: vibeDecisionType },
        });
        this.publish({
          type: "permission.request.resolved",
          provider: this.provider,
          threadId: session.threadId,
          requestId,
          raw: { toolName: parked.toolName, behavior: decision.kind },
        });
      },
      catch: (cause) => toCliError("VIBE_APPROVAL_FAILED", "Could not answer Mistral Vibe approval", cause),
    });

  respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        const parked = session.parkedInputs.get(requestId);
        if (!parked) return;
        session.parkedInputs.delete(requestId);
        const mapped = parked.questions.map((q) => {
          const answer = (answers[q.id] ?? answers[q.question] ?? "").trim();
          const isOther = answer.length > 0 && !q.options.includes(answer);
          return { question: q.question, answer, isOther };
        });
        await this.sendCallbackResult(session, parked.callbackId, {
          type: "user_input",
          result: { answers: mapped, cancelled: false },
        });
        this.publish({
          type: "user-input.request.resolved",
          provider: this.provider,
          threadId: session.threadId,
          requestId,
        });
      },
      catch: (cause) => toCliError("VIBE_USER_INPUT_FAILED", "Could not answer Mistral Vibe question", cause),
    });

  private compactSession = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        const compacted = asRecord(
          await session.peer.request(
            VIBE_METHODS.sessionCompact,
            { sessionId: session.vibeSessionId, extraInstructions: "" },
            120_000,
          ),
        );
        this.adoptSessionState(session, asRecord(compacted?.["state"]));
        session.usage.resetBaseline();
        this.publish({
          type: "session.notice",
          provider: this.provider,
          threadId: session.threadId,
          turnId: null,
          notice: "compacted",
          title: "Compacted conversation history",
          detail: asNonEmptyString(compacted?.["summary"]),
        });
      },
      catch: (cause) => toCliError("VIBE_COMPACT_FAILED", "Could not compact Mistral Vibe session", cause),
    });

  resumeCursor = (threadId: ThreadId): string | null =>
    this.sessions.get(threadId)?.vibeSessionId || null;

  contextUsage = async (threadId: ThreadId): Promise<ContextWindowUsage | null> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return null;
    try {
      const breakdown = parseVibeContextBreakdown(
        await session.peer.request(
          VIBE_METHODS.sessionContextRead,
          { sessionId: session.vibeSessionId },
          5_000,
        ),
      );
      if (breakdown) {
        session.context = {
          usedTokens: breakdown.usedTokens,
          maxTokens: breakdown.maxTokens,
          cachedInputTokens: session.context?.cachedInputTokens ?? null,
          autoCompactThreshold: breakdown.autoCompactThreshold,
          compactsAutomatically: breakdown.compactsAutomatically,
        };
        return session.context;
      }
    } catch {
      // Fall back to latest stats snapshot.
    }
    return session.context;
  };

  contextBreakdown = async (threadId: ThreadId): Promise<ContextBreakdown | null> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return null;
    try {
      const raw = await session.peer.request(
        VIBE_METHODS.sessionContextRead,
        { sessionId: session.vibeSessionId },
        5_000,
      );
      const breakdown = parseVibeContextBreakdown(raw);
      if (breakdown) return breakdown;
    } catch {
      // Fall back to transcript estimate.
    }
    if (!session.context) return null;
    const messages: Array<{ readonly info: Record<string, unknown>; readonly parts: ReadonlyArray<Record<string, unknown>> }> = [];
    for (const turn of session.transcript) {
      messages.push({ info: { role: "user" }, parts: [{ type: "text", text: turn.prompt }] });
      if (turn.text) messages.push({ info: { role: "assistant" }, parts: [{ type: "text", text: turn.text }] });
    }
    return conversationContextBreakdown(session.context, messages);
  };

  liveTurnUsage = (threadId: ThreadId): TokenUsageDelta | null => {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    const running = this.runningTurn(session);
    return running ? session.usage.peek(running.id) : null;
  };

  refreshUsage = async (options?: { readonly force?: boolean }): Promise<{
    readonly key: string;
    readonly windows: ReadonlyArray<RateLimitWindow>;
  } | null> => {
    const open = [...this.sessions.values()].find((s) => !s.closed && s.vibeSessionId.length > 0);
    if (open) {
      const windows = await this.refreshSessionAccount(open, options?.force === true);
      if (windows.length > 0) {
        this.lastPassiveWindows = windows;
        this.lastPassiveUsageAt = Date.now();
        return { key: this.usageKey, windows };
      }
      return null;
    }
    const now = Date.now();
    if (!options?.force && this.lastPassiveWindows.length > 0 && now - this.lastPassiveUsageAt < PASSIVE_USAGE_COALESCE_MS) {
      return { key: this.usageKey, windows: this.lastPassiveWindows };
    }
    if (!this.inflightPassiveUsage) {
      this.inflightPassiveUsage = this.probeIdleAccount().finally(() => {
        this.inflightPassiveUsage = null;
      });
    }
    const windows = await this.inflightPassiveUsage;
    return windows.length > 0 ? { key: this.usageKey, windows } : null;
  };

  /**
   * Read monthly Vibe Code budget when no live session is open yet: starts a
   * tool-free zero-turn probe session, calls `account/read`, and immediately
   * closes it via `session/stop` (zero-turn sessions are never persisted).
   */
  private async probeIdleAccount(): Promise<RateLimitWindow[]> {
    try {
      const cwd = os.tmpdir();
      const windows = await this.withPeer(cwd, async (peer) => {
        const started = asRecord(
          await peer.request(
            VIBE_METHODS.sessionStart,
            {
              agentConfig: {
                cwd,
                trustWorkspace: false,
                approvalPolicy: "ask",
                enabledTools: [],
                disabledTools: [...VIBE_ALWAYS_DISABLED_TOOLS],
              },
              sessionOnly: true,
            },
            10_000,
          ),
        );
        const vibeSessionId = asNonEmptyString(asRecord(asRecord(started?.["state"])?.["session"])?.["id"]);
        if (!vibeSessionId) return [];
        try {
          const raw = await peer.request(VIBE_METHODS.accountRead, { sessionId: vibeSessionId }, 10_000);
          return vibeWindowsOf(parseVibeAccountRead(raw));
        } finally {
          await peer.request(VIBE_METHODS.sessionStop, { sessionId: vibeSessionId }, 3_000).catch(() => {});
        }
      });
      this.lastPassiveUsageAt = Date.now();
      if (windows.length > 0) this.lastPassiveWindows = windows;
      return windows;
    } catch {
      return this.lastPassiveWindows;
    }
  }

  sessionTitle = async (cursor: string): Promise<string | null> => {
    const match = [...this.sessions.values()].find((s) => !s.closed && s.vibeSessionId === cursor);
    return match?.title ?? null;
  };

  renameSession = async (cursor: string, _workingDirectory: string, title: string): Promise<void> => {
    const match = [...this.sessions.values()].find((s) => !s.closed && s.vibeSessionId === cursor);
    if (match) {
      await match.peer.request(
        VIBE_METHODS.sessionTitleUpdate,
        { sessionId: match.vibeSessionId, title },
        this.requestTimeoutMs,
      );
      match.title = title;
      this.publish({
        type: "session.title.updated",
        provider: this.provider,
        threadId: match.threadId,
        title,
      });
      return;
    }
    await this.withPeer(_workingDirectory, async (peer) => {
      await peer.request(VIBE_METHODS.sessionTitleUpdate, { sessionId: cursor, title }, this.requestTimeoutMs);
    });
  };

  /** Fork an existing Vibe session cursor into an independent session cursor. */
  forkSession = async (cursor: string, workingDirectory: string): Promise<string> => {
    const live = [...this.sessions.values()].find((s) => !s.closed && s.vibeSessionId === cursor);
    if (live) {
      const res = asRecord(
        await live.peer.request(
          VIBE_METHODS.sessionFork,
          { sourceSessionId: cursor, attach: false },
          this.requestTimeoutMs,
        ),
      );
      const forkedId = asNonEmptyString(asRecord(asRecord(res?.["state"])?.["session"])?.["id"]);
      if (!forkedId) throw new CliError("VIBE_FORK_FAILED", "vibe-app-server returned no forked session id.");
      return forkedId;
    }
    return await this.withPeer(workingDirectory, async (peer) => {
      const res = asRecord(
        await peer.request(
          VIBE_METHODS.sessionFork,
          { sourceSessionId: cursor, attach: false },
          this.requestTimeoutMs,
        ),
      );
      const forkedId = asNonEmptyString(asRecord(asRecord(res?.["state"])?.["session"])?.["id"]);
      if (!forkedId) throw new CliError("VIBE_FORK_FAILED", "vibe-app-server returned no forked session id.");
      return forkedId;
    });
  };

  /** Disposable tool-free `/btw` side question via `session/fork` (with `enabledTools: []`). */
  sideQuestion = async (input: SideQuestionInput): Promise<SideAnswer> => {
    return await this.withPeer(input.workingDirectory, async (peer) => {
      let vibeSessionId: string | null = null;
      let withContext = false;
      const sideAgentConfig: Record<string, unknown> = {
        cwd: input.workingDirectory,
        trustWorkspace: true,
        approvalPolicy: "ask",
        enabledTools: [],
        disabledTools: [...VIBE_ALWAYS_DISABLED_TOOLS],
        instructions: SIDE_QUESTION_RULES,
      };
      const model = resolveVibeModel(input.model);

      if (input.cursor) {
        try {
          const forked = asRecord(
            await peer.request(
              VIBE_METHODS.sessionFork,
              {
                sourceSessionId: input.cursor,
                agentConfig: sideAgentConfig,
                attach: true,
              },
              this.requestTimeoutMs,
            ),
          );
          vibeSessionId = asNonEmptyString(asRecord(asRecord(forked?.["state"])?.["session"])?.["id"]);
          withContext = vibeSessionId !== null;
        } catch {
          vibeSessionId = null;
        }
      }

      if (!vibeSessionId) {
        const started = asRecord(
          await peer.request(
            VIBE_METHODS.sessionStart,
            {
              agentConfig: sideAgentConfig,
              sessionOnly: true,
              ...(model ? { model } : {}),
            },
            this.requestTimeoutMs,
          ),
        );
        vibeSessionId = asNonEmptyString(asRecord(asRecord(started?.["state"])?.["session"])?.["id"]);
      }

      if (!vibeSessionId) {
        throw new CliError("VIBE_SIDE_QUESTION_FAILED", "Could not open disposable Mistral Vibe session for /btw.");
      }

      const entries = new Map<string, Record<string, unknown>>();
      const assistantIds: string[] = [];
      let resolveDone!: (err: string | null) => void;
      const donePromise = new Promise<string | null>((resolve) => {
        resolveDone = resolve;
      });

      const onAbort = (): void => {
        peer.close();
        resolveDone("Aborted");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      peer.onNotification((method, params) => {
        const rec = asRecord(params);
        if (!rec) return;
        if (method === VIBE_METHODS.historyEntryAdded) {
          const entry = asRecord(rec["entry"]);
          const id = asNonEmptyString(entry?.["id"]);
          if (id && entry) {
            entries.set(id, entry);
            if (entry["type"] === "message" && entry["role"] === "assistant") assistantIds.push(id);
          }
        } else if (method === VIBE_METHODS.historyEntryUpdated) {
          const id = asNonEmptyString(rec["entryId"]);
          const prev = id ? entries.get(id) : undefined;
          if (id && prev) {
            const next = asRecord(applyVibeJsonPatch(prev, rec["patch"]));
            if (next) entries.set(id, next);
          }
        } else if (method === VIBE_METHODS.turnCompleted) {
          const t = asRecord(rec["turn"]);
          const st = asNonEmptyString(t?.["status"]);
          const errMsg = asNonEmptyString(asRecord(t?.["error"])?.["message"]);
          resolveDone(st === "failed" ? (errMsg ?? "Side question failed.") : null);
        }
      });

      try {
        await peer.request(
          VIBE_METHODS.turnStart,
          {
            sessionId: vibeSessionId,
            message: buildVibeMessageBlocks(input.question),
          },
          this.requestTimeoutMs,
        );
        const err = await donePromise;
        if (err) throw new CliError("VIBE_SIDE_QUESTION_FAILED", err);
        const texts = assistantIds
          .map((id) => entries.get(id))
          .filter((e): e is Record<string, unknown> => e !== undefined)
          .map((e) => extractVibeMessageText(e))
          .filter((t) => t.trim().length > 0);
        return { text: texts.join("\n\n").trim(), withContext };
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        await peer
          .request(VIBE_METHODS.sessionStop, { sessionId: vibeSessionId }, 5_000)
          .catch(() => {});
      }
    });
  };

  backgroundTasks = (threadId: ThreadId): readonly BackgroundTaskSummary[] => {
    const session = this.sessions.get(threadId);
    return session ? [...session.backgroundProcesses.values()] : [];
  };

  backgroundTaskOutput = async (threadId: ThreadId, taskId: string): Promise<{ readonly lines: readonly string[] } | null> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return null;
    try {
      const raw = asRecord(
        await session.peer.request(
          VIBE_METHODS.sessionBackgroundProcessOutput,
          {
            sessionId: session.vibeSessionId,
            processId: taskId,
            fromEnd: true,
            cursor: 0,
            waitMs: 0,
            maxBytes: 64_000,
          },
          5_000,
        ),
      );
      if (raw?.["availability"] !== "available") return null;
      const b64 = asString(raw["outputBase64"]);
      if (b64 === null) return null;
      const text = Buffer.from(b64, "base64").toString("utf8");
      return { lines: text.length === 0 ? [] : text.split(/\r?\n/) };
    } catch {
      return null;
    }
  };

  stopBackgroundTask = (threadId: ThreadId, taskId: string): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        await session.peer.request(
          VIBE_METHODS.sessionBackgroundProcessStop,
          { sessionId: session.vibeSessionId, processId: taskId },
          this.requestTimeoutMs,
        );
        if (session.backgroundProcesses.delete(taskId)) {
          this.publish({
            type: "background.tasks.changed",
            provider: this.provider,
            threadId: session.threadId,
            tasks: [...session.backgroundProcesses.values()],
          });
        }
      },
      catch: (cause) => toCliError("VIBE_BG_STOP_FAILED", "Could not stop Mistral Vibe background process", cause),
    });

  skillInventory = async (workingDirectory: string): Promise<SkillInventory> => {
    const excluded = new Set(excludedSkills(workingDirectory, "vibe").map((entry) => entry.name));
    try {
      const raw = await this.withPeer(workingDirectory, async (peer) =>
        asRecord(await peer.request(VIBE_METHODS.skillsList, {}, 10_000)),
      );
      const list = Array.isArray(raw?.["skills"]) ? raw!["skills"] : [];
      const skills: SkillSummary[] = [];
      for (const entry of list) {
        const rec = asRecord(entry);
        const name = asNonEmptyString(rec?.["name"]);
        if (!name || excluded.has(name)) continue;
        skills.push(plainSkill(name, asNonEmptyString(rec?.["description"])));
      }
      return { trigger: "/", skills, commands: [] };
    } catch {
      return { trigger: "/", skills: [], commands: [] };
    }
  };

  stopSession = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.sessions.get(threadId);
        if (!session) return;
        // Settle the open turn and its waiters before closing: a waiter
        // parked on awaitTurn must never hang on a session that is going away.
        const running = this.runningTurn(session);
        if (running) {
          const usage = session.usage.take(running.id);
          settleAndPublishTurn({
            open: running,
            waiters: session.waiters,
            status: "interrupted",
            apply: (turn) => {
              turn.status = "interrupted";
              turn.usage = usage;
              return { status: "interrupted" as const, text: turn.text, usage, error: null };
            },
            publish: (event) => this.publish(event),
            event: (turnId) => terminalTurnEvent(this.provider, session.threadId, turnId, "interrupted"),
          });
        }
        session.closed = true;
        this.sessions.delete(threadId);
        this.clearParkedCallbacks(session);
        if (session.vibeSessionId) {
          await session.peer
            .request(VIBE_METHODS.sessionStop, { sessionId: session.vibeSessionId }, 3_000)
            .catch(() => {});
        }
        session.peer.close();
      },
      catch: (cause) => toCliError("VIBE_STOP_FAILED", "Could not stop Mistral Vibe session", cause),
    });

  listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() =>
      [...this.sessions.values()]
        .filter((s) => !s.closed)
        .map((s) => ({
          threadId: s.threadId,
          provider: this.provider,
          workingDirectory: s.workingDirectory,
          startedAt: s.startedAt,
        })),
    );

  hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.sync(() => {
      const s = this.sessions.get(threadId);
      return s !== undefined && !s.closed;
    });

  readThread = (threadId: ThreadId): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    Effect.try({
      try: () => {
        const session = this.requireSession(threadId);
        return {
          threadId: session.threadId,
          turns: session.transcript.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      },
      catch: (cause) => toCliError("VIBE_READ_THREAD_FAILED", "Could not read Mistral Vibe thread", cause),
    });

  rollbackThread = (threadId: ThreadId, numTurns: number): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    Effect.tryPromise({
      try: async () => {
        const session = this.requireSession(threadId);
        const count = Math.max(0, Math.floor(numTurns));
        if (count === 0 || session.transcript.length === 0) {
          return {
            threadId: session.threadId,
            turns: session.transcript.map((turn) => ({ id: turn.id, items: [...turn.items] })),
          };
        }
        const targetIndex = Math.max(0, session.transcript.length - count);
        const targetTurn = session.transcript[targetIndex];
        const entryId = targetTurn?.inputEntryId;
        if (!entryId) {
          throw new CliError("VIBE_ROLLBACK_FAILED", "No recorded Mistral Vibe entry id for rollback target.");
        }
        const rewound = asRecord(
          await session.peer.request(
            VIBE_METHODS.sessionRewind,
            {
              sessionId: session.vibeSessionId,
              entryId,
              restoreFiles: false,
              inplace: true,
            },
            this.requestTimeoutMs,
          ),
        );
        this.adoptSessionState(session, asRecord(rewound?.["state"]));
        session.usage.resetBaseline();
        session.transcript.splice(targetIndex);
        return {
          threadId: session.threadId,
          turns: session.transcript.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      },
      catch: (cause) => toCliError("VIBE_ROLLBACK_FAILED", "Could not roll back Mistral Vibe thread", cause),
    });

  stopAll = (): Effect.Effect<void, CliError> =>
    Effect.forEach([...this.sessions.keys()], (id) => this.stopSession(id), { discard: true });
}

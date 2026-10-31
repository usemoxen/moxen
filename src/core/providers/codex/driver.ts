/**
 * Codex driver: `ProviderAdapter` over a per-session `codex app-server`
 * stdio JSON-RPC peer. Thin by design: no Effect Layers, no host services.
 *
 * Handshake is initialize → initialized → account/read; each thread maps to
 * one app-server thread started with the static approval/sandbox policy for
 * its runtime mode. Server-driven approvals park until `respondToRequest` /
 * `respondToUserInput` resolve them (interrupt settles parked first, or the
 * stdin loop deadlocks). Token usage is a baseline delta over thread-wide
 * cumulative totals; compaction is native; rollback resolves retained turns
 * through the paginated API and uses `thread/revert`. Codex owns its login
 * under `CODEX_HOME`; Moxen never reads credential files. See docs/providers.md.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { rawInputViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import { codexMethodUnavailable, readCodexHistory, readCodexTurns } from "./history.js";
import { codexDisabledToolConfig } from "../../nativetools.js";
import { CliError } from "../../errors.js";
import { plainSkill, type SkillInventory, type SkillSummary } from "../../catalog/summary.js";
import type { CodexProviderConfig, InteractionMode, ModelSelection, RuntimeMode } from "../../types.js";
import { JsonRpcPeer } from "../stdio.js";
import type {
  SideQuestionInput,
  SideAnswer,
  SubagentHistoryItem,
  ApprovalRequestId,
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderApprovalDecision,
  ContextWindowUsage,
  ContextBreakdown,
  ProviderImage,
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
import { CodexBackground } from "./background.js";
import { CodexHarnessTools, CODEX_HARNESS_CONFIG, CODEX_HARNESS_SERVER } from "./tools.js";
import { resolveStoreRoot } from "../../threads/store.js";
import { codexAsyncQuestions } from "./questions.js";
import { conversationContextBreakdown } from "../context.js";
import { isCompactCommand } from "../spi.js";
import { outOfProcess, type McpServerSpec } from "../../mcp.js";
import {
  codexAccountTypeOf,
  codexSignedOutMessage,
  isCodexAuthErrorText,
  normalizeCodexSettings,
  resolveCodexHome,
  resolveCodexModel,
  type CodexAccountType,
  type CodexSettings,
} from "./config.js";
import { approvalKindForMethod, staticPolicyForRuntimeMode, type CodexApprovalKind } from "./permissions.js";
import {
  asRecord,
  asString,
  CODEX_METHODS,
  codexTokenBreakdownOf,
  codexTurnStateOf,
} from "./protocol.js";
import { SpawnCodexTransport, type CodexTransport } from "./transport.js";
import {
  CodexUsageAccumulator,
  codexWindowsOf,
  rewriteLimitError,
} from "./usage.js";

export interface CodexDriverOptions {
  readonly settings?: Partial<CodexSettings> & CodexProviderConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly transport?: CodexTransport;
  readonly rateLimitsTimeoutMs?: number;
}

export type CodexTurnStatus = "completed" | "failed" | "interrupted";

export interface CodexListedModel {
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoningEfforts?: ReadonlyArray<string> | undefined;
  readonly defaultEffort?: string;
  readonly isDefault?: boolean;
}

export interface CodexTurnOutcome {
  readonly status: CodexTurnStatus;
  readonly text: string;
  readonly usage: TokenUsageDelta;
  readonly error: string | null;
}

interface TranscriptItem {
  readonly kind: "user" | "assistant" | "tool";
  readonly text: string;
  readonly tool?: string;
}

interface TranscriptTurn {
  readonly id: TurnId;
  serverTurnId: string | null;
  readonly prompt: string;
  readonly items: TranscriptItem[];
  status: "running" | CodexTurnStatus;
  text: string;
  error: string | null;
  /**
   * The turn's `agentMessage` items by id, in arrival order. A turn can hold
   * several: interim `commentary` updates between tool calls, then the
   * `final_answer`. Only non-commentary messages make up the turn's text.
   */
  readonly messages: Map<string, AgentMessage>;
  usage?: TokenUsageDelta;
}

interface AgentMessage {
  text: string;
  phase: string | null;
  delivery?: string | null;
}

interface ParkedCodex {
  readonly threadId: ThreadId;
  readonly kind: CodexApprovalKind;
  readonly method: string;
  readonly params: unknown;
  readonly resolve: (result: unknown) => void;
}

interface CodexSession {
  readonly threadId: ThreadId;
  /** Latest `thread/tokenUsage/updated` reading of the context window. */
  context: ContextWindowUsage | null;
  codexThreadId: string | null;
  readonly peer: JsonRpcPeer;
  readonly workingDirectory: string;
  closed: boolean;
  accountType: CodexAccountType;
  delegated: boolean;
  isolation: WorktreeIsolation | null;
  checklist: boolean;
  background: CodexBackground;
  harness: CodexHarnessTools;
  reasoning: Map<string, { text: string; startedAt: number; summaryParts: Map<number, string> }>;
  tools: Map<string, Record<string, unknown>>;
  model: string | null;
  runtimeMode: RuntimeMode;
  transcript: TranscriptTurn[];
  waiters: Map<TurnId, Array<{ resolve: (outcome: CodexTurnOutcome) => void; reject: (cause: unknown) => void }>>;
  parked: Map<string, ParkedCodex>;
  usage: CodexUsageAccumulator;
  lastWindows: ReturnType<typeof codexWindowsOf>;
  lastResetsAt: string | null;
  lastActiveAt: number;
  lastActiveThreadId: ThreadId | null;
  startedAt: string;
}

const CLIENT_INFO = { name: "moxen", title: "moxen", version: "0.0.0" };

// Serialized per CODEX_HOME so concurrent reset-credit consumes never race.
const resetCreditLocks = new Map<string, Promise<void>>();

function toCliError(code: string, message: string, cause: unknown): CliError {
  // Auth patterns win even over transport wrappers: a failed account/read
  // surfaces as PEER_REQUEST_FAILED whose message still names the cause.
  const text = cause instanceof Error ? cause.message : String(cause);
  if (isCodexAuthErrorText(text)) {
    return new CliError("CODEX_AUTH_REQUIRED", codexSignedOutMessage({ home: "~/.codex" }), {
      cause,
    });
  }
  if (cause instanceof CliError) return cause;
  return new CliError(code, `${message}: ${text.slice(0, 200)}`, { cause });
}

function textOfDelta(params: unknown): string | null {
  const record = asRecord(params);
  if (!record) return typeof params === "string" ? params : null;
  for (const key of ["text", "delta", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const content = asRecord(record["content"]);
  if (content && typeof content["text"] === "string") return content["text"] as string;
  return null;
}

/**
 * The turn's answer: its non-`commentary` agent messages. Codex marks
 * interim progress updates `phase: "commentary"`; folding those in put the
 * model's working narration into the final output. A phase of `null` is
 * "unknown" (older models) and counts as answer text. A turn whose every
 * message is commentary falls back to the last one rather than to nothing.
 */
function answerText(messages: ReadonlyMap<string, AgentMessage>): string {
  const all = [...messages.values()].filter((message) => message.delivery !== "async");
  const answer = all.filter((message) => message.phase !== "commentary");
  if (answer.length > 0) return answer.map((message) => message.text).join("\n\n");
  return all.at(-1)?.text ?? "";
}

/** The `agentMessage` item a notification carries, if any. */
function agentMessageItem(params: unknown): { id: string; text: string | null; phase: string | null; delivery: string | null; questions: Record<string, unknown>[] } | null {
  const item = asRecord(asRecord(params)?.["item"]);
  if (!item || item["type"] !== "agentMessage") return null;
  const id = asString(item["id"]);
  if (!id) return null;
  return {
    id,
    text: typeof item["text"] === "string" ? (item["text"] as string) : null,
    phase: asString(item["phase"]),
    delivery: asString(item["delivery"]),
    questions: codexAsyncQuestions(item),
  };
}

/** `UserInput[]`: the text, then each image as an `image` input with a data URL. */
function userInputBlocks(prompt: string, images: readonly ProviderImage[] = []): Array<Record<string, unknown>> {
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
  ];
}

/** Explicit selections use Codex's native skill input, resolved by its own inventory. */
async function codexUserInput(peer: JsonRpcPeer, cwd: string, prompt: string, images: readonly ProviderImage[] = []): Promise<Array<Record<string, unknown>>> {
  const blocks = userInputBlocks(prompt, images);
  const name = /^\s*[$/]([\w.:-]+)(?=\s|$)/u.exec(prompt)?.[1];
  if (!name) return blocks;
  try {
    const inventory = asRecord(await peer.request(CODEX_METHODS.skillsList, { cwds: [cwd] }));
    for (const entry of Array.isArray(inventory?.["data"]) ? inventory["data"] : []) {
      const skills = asRecord(entry)?.["skills"];
      for (const raw of Array.isArray(skills) ? skills : []) {
        const skill = asRecord(raw);
        const path = asString(skill?.["path"]);
        if (skill?.["name"] === name && skill["enabled"] !== false && path) return [...blocks, { type: "skill", name, path }];
      }
    }
  } catch {
    // Discovery is optional; retain the user's prompt when the runtime cannot list skills.
  }
  return blocks;
}

export class CodexDriver implements ProviderAdapter<CliError> {
  readonly provider = "codex" as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    sessionModelSwitch: "in-session",
    supportsConversationRollback: true,
  };

  private readonly settings: CodexSettings;
  private readonly providerConfig: CodexProviderConfig;

  /** Metadata operations never create an empty provider thread. */
  async withPeer<T>(cwd: string, run: (peer: JsonRpcPeer) => Promise<T>): Promise<T> {
    const peer = this.transport.startPeer({ settings: this.settings, env: this.baseEnv, cwd });
    try {
      await peer.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, 10_000);
      peer.notify("initialized");
      return await run(peer);
    } finally { peer.close(); }
  }
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly transport: CodexTransport;
  private readonly rateLimitsTimeoutMs: number;
  private secretEnv: readonly string[] = [];
  private readonly sessions = new Map<ThreadId, CodexSession>();
  /** Codex thread id per thread, kept past session teardown (see `resumeCursor`). */
  private readonly titleJobs = new Map<string, Promise<string | null>>();
  private readonly titleVersions = new Map<string, number>();
  private readonly titleAborts = new Map<string, AbortController>();
  private readonly resumable = new Map<ThreadId, string>();
  private readonly queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());

  constructor(options: CodexDriverOptions = {}) {
    this.settings = normalizeCodexSettings(options.settings);
    this.providerConfig = options.settings ?? {};
    this.baseEnv = options.env ?? process.env;
    this.transport = options.transport ?? new SpawnCodexTransport();
    this.rateLimitsTimeoutMs = options.rateLimitsTimeoutMs ?? 3000;
  }

  /** Custom Harness profile keys must not reach application-owned shell commands. */
  setSecretEnv(names: readonly string[]): void { this.secretEnv = names; }

  get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.queue);
  }

  readonly compaction = {
    type: "native" as const,
    start: (threadId: ThreadId, _modelSelection?: ModelSelection): Effect.Effect<void, CliError> =>
      this.attempt("CODEX_TURN_FAILED", `Could not compact thread ${threadId}`, async () => {
        const session = this.requireSession(threadId);
        const codexThreadId = this.requireCodexThread(session);
        await session.peer.request(CODEX_METHODS.threadCompactStart, { threadId: codexThreadId });
      }),
  };

  private publish(event: ProviderRuntimeEvent): void {
    Effect.runSync(Queue.offer(this.queue, event));
  }

  private attempt<T>(code: string, message: string, run: () => Promise<T>): Effect.Effect<T, CliError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => toCliError(code, message, cause),
    });
  }

  private requireSession(threadId: ThreadId): CodexSession {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      throw new CliError("CODEX_NOT_STARTED", `No Codex session exists for thread ${threadId}.`, {
        details: { threadId },
      });
    }
    return session;
  }

  private requireCodexThread(session: CodexSession): string {
    if (!session.codexThreadId) {
      throw new CliError("CODEX_NOT_STARTED", `The Codex thread for ${session.threadId} is not started.`, {
        details: { threadId: session.threadId },
      });
    }
    return session.codexThreadId;
  }

  // -- session lifecycle -------------------------------------------------

  readonly startSession = (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, CliError> =>
    this.attempt("CODEX_SPAWN_FAILED", `Could not start a Codex session for thread ${input.threadId}`, async () => {
      const existing = this.sessions.get(input.threadId);
      if (existing && !existing.closed) return this.describeSession(existing);
      if (existing) this.sessions.delete(input.threadId);

      const peer = this.transport.startPeer({
        settings: this.settings,
        env: this.baseEnv,
        cwd: input.workingDirectory,
      });
      const session: CodexSession = {
        threadId: input.threadId,
        codexThreadId: null,
        context: null,
        peer,
        workingDirectory: input.workingDirectory,
        closed: false,
        accountType: "unknown",
        delegated: input.delegated === true,
        isolation: input.isolation ?? null,
        checklist: input.checklist !== false,
        tools: new Map(),
        reasoning: new Map(),
        background: new CodexBackground(input.threadId, (event) => this.publish(event.type === "background.tasks.changed" ? { ...event, tasks: [...event.tasks, ...session.harness.backgroundTasks()] } : event)),
        harness: new CodexHarnessTools({
          threadId: input.threadId, cwd: input.workingDirectory,
          artifactDir: path.join(resolveStoreRoot(), "codex", "artifacts", randomUUID()),
          delegated: input.delegated === true, shellDisabled: input.disabledNativeTools?.includes("shell") === true,
          isolation: input.isolation ?? null,
          secretEnv: () => this.secretEnv,
          mode: () => session.runtimeMode,
          publish: (event) => this.publish(event.type === "background.tasks.changed" ? { ...event, tasks: [...session.background.list(), ...event.tasks] } : event),
        }),
        model: resolveCodexModel(input.modelSelection?.model),
        runtimeMode: input.runtimeMode ?? "full-access",
        transcript: [],
        waiters: new Map(),
        parked: new Map(),
        usage: new CodexUsageAccumulator(),
        lastWindows: [],
        lastResetsAt: null,
        lastActiveAt: Date.now(),
        lastActiveThreadId: null,
        startedAt: new Date().toISOString(),
      };
      peer.onRequest((method, params) => this.onServerRequest(session, method, params));
      peer.onNotification((method, params) => this.onNotification(session, method, params));
      peer.onExit(() => {
        if (!session.closed) {
          session.closed = true;
          void session.harness.close();
          this.settleOpenTurn(session, "failed", "The Codex process exited.");
          session.background.clear();
          this.denyParked(session, "Codex exited.");
          this.sessions.delete(session.threadId);
        }
      });
      this.sessions.set(input.threadId, session);
      try {
        if ((input.mcpServers ?? []).some((server) => server.name === CODEX_HARNESS_SERVER)) throw new CliError("CODEX_TOOL_NAMESPACE_CONFLICT", `${CODEX_HARNESS_SERVER} is reserved for Moxen's Codex tools.`);
        const harnessConfig = await session.harness.start();
        await peer.request("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
        peer.notify(CODEX_METHODS.initialized, undefined);
        const account = await peer.request(CODEX_METHODS.accountRead, {});
        session.accountType = codexAccountTypeOf(account);
        await this.probeRateLimits(session);
        const requestedPolicy = staticPolicyForRuntimeMode(session.runtimeMode);
        const policy = session.isolation && requestedPolicy.sandbox === "danger-full-access" ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : requestedPolicy;
        const overrides = {
          cwd: input.workingDirectory,
          ...(session.model ? { model: session.model } : {}),
          approvalPolicy: policy.approvalPolicy,
          approvalsReviewer: session.runtimeMode === "auto" ? "auto_review" : "user",
          sandbox: policy.sandbox,
          config: {
            ...codexMcpConfig(input.mcpServers ?? [], input.disabledMcpTools),
            ...((this.providerConfig.compactionModels?.[input.modelSelection?.model ?? ""] ?? this.providerConfig.compaction ?? "provider") !== "provider" ? { model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER } : {}),
            ...codexDisabledToolConfig(input.disabledNativeTools ?? []),
            ...CODEX_HARNESS_CONFIG,
            [`mcp_servers.${CODEX_HARNESS_SERVER}`]: harnessConfig,
            ...(input.moxenMemory ? { "features.memories": false } : {}),
          },
          // `ThreadStartParams` / `ThreadResumeParams.developerInstructions`.
          developerInstructions: [input.instructions, `Moxen supplies shell and question tools through ${CODEX_HARNESS_SERVER}. Use its bash or powershell for commands, reading and search, ask for questions, and task_output/task_stop for background commands. Native shell and question tools are disabled.`, input.checklist === false ? "Moxen's to-do list is off. Do not call update_plan." : null].filter(Boolean).join("\n\n"),
        };
        const codexThreadId =
          (await this.resumeThread(peer, this.resumable.get(input.threadId) ?? input.resumeCursor, overrides)) ??
          codexThreadIdOf(await peer.request(CODEX_METHODS.threadStart, overrides));
        if (!codexThreadId) {
          throw new CliError("CODEX_START_FAILED", "The app-server did not return a thread id.", {
            details: { threadId: input.threadId },
          });
        }
        session.codexThreadId = codexThreadId;
        this.resumable.set(input.threadId, codexThreadId);
        return this.describeSession(session);
      } catch (cause) {
        session.closed = true;
        await session.harness.close();
        this.sessions.delete(session.threadId);
        try {
          peer.close();
        } catch {
          // Best effort.
        }
        throw cause;
      }
    });

  readonly resumeCursor = (threadId: ThreadId): string | null => this.resumable.get(threadId) ?? null;

  readonly contextUsage = async (threadId: ThreadId): Promise<ContextWindowUsage | null> =>
    this.sessions.get(threadId)?.context ?? null;

  readonly contextBreakdown = async (threadId: string): Promise<ContextBreakdown | null> => {
    const session = this.sessions.get(threadId);
    if (!session?.context || !session.codexThreadId) return null;
    const history = await readCodexHistory(session.peer, session.codexThreadId);
    const compacted = history.findLastIndex((entry) => entry.kind === "tool" && asRecord(asRecord(entry.raw)?.["item"])?.["type"] === "contextCompaction");
    const messages = history.slice(compacted + 1).map((entry) => ({ info: { role: entry.kind === "prompt" ? "user" : "assistant" }, parts: entry.kind === "tool" ? [{ type: "tool", tool: entry.tool, state: { input: asRecord(entry.raw)?.["item"] } }] : [{ type: entry.kind === "reasoning" ? "reasoning" : "text", text: entry.text }] }));
    return conversationContextBreakdown(session.context, messages);
  };

  /**
   * `turn/steer`, pinned to the running turn by `expectedTurnId`: if that
   * turn ended in the meantime the app-server refuses rather than steering
   * whatever runs next.
   */
  readonly steerTurn = (threadId: ThreadId, text: string, images?: readonly ProviderImage[]): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_STEER_FAILED", `Could not steer the turn on thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      const open = session.transcript.find((turn) => turn.status === "running");
      if (!open || !open.serverTurnId) {
        throw new CliError("TURN_NOT_RUNNING", `Thread ${threadId} has no running turn to steer.`, {
          details: { threadId },
        });
      }
      await session.peer.request(CODEX_METHODS.turnSteer, {
        threadId: this.requireCodexThread(session),
        expectedTurnId: open.serverTurnId,
        input: await codexUserInput(session.peer, session.workingDirectory, text, images),
      });
      open.items.push({ kind: "user", text });
    });

  /**
   * Reattach to a Codex thread a previous session created, history intact
   * on the app-server side. `excludeTurns` because the transcript already
   * lives in our ledger. A thread the app-server no longer knows (rollout
   * pruned, another machine) yields null and the caller starts fresh.
   */
  private async resumeThread(
    peer: CodexSession["peer"],
    cursor: string | undefined,
    overrides: Record<string, unknown>,
  ): Promise<string | null> {
    if (!cursor) return null;
    try {
      const resumed = await peer.request(CODEX_METHODS.threadResume, {
        ...overrides,
        threadId: cursor,
        excludeTurns: true,
      });
      return codexThreadIdOf(resumed);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/no rollout found|thread (?:was )?not found|unknown thread|session .*not found/i.test(message)) return null;
      throw cause;
    }
  }

  private describeSession(session: CodexSession): ProviderSession {
    return {
      threadId: session.threadId,
      provider: "codex",
      workingDirectory: session.workingDirectory,
      startedAt: session.startedAt,
    };
  }

  private async probeRateLimits(session: CodexSession): Promise<void> {
    try {
      const snapshot = await session.peer.request(
        CODEX_METHODS.rateLimitsRead,
        {},
        this.rateLimitsTimeoutMs,
      );
      this.applyRateSnapshot(session, snapshot);
    } catch {
      // Degrade to a message: live updates still arrive mid-turn.
    }
  }

  private applyRateSnapshot(session: CodexSession, snapshot: unknown): void {
    const record = asRecord(snapshot) ?? {};
    const inner = asRecord(record["rateLimits"]) ?? record;
    const windows = codexWindowsOf({
      limitId: asString(inner["limitId"]) ?? undefined,
      planType: asString(inner["planType"]) ?? undefined,
      primary: inner["primary"],
      secondary: inner["secondary"],
    });
    session.lastWindows = windows;
    const resets = windows.map((window) => window.resetsAt).filter((value): value is string => value !== null);
    session.lastResetsAt = resets.length > 0 ? resets.sort()[0]! : session.lastResetsAt;
    this.publish({
      type: "rate-limits.updated",
      provider: "codex",
      threadId: session.threadId,
      windows,
      raw: { planType: inner["planType"] ?? null },
    });
  }

  readonly stopSession = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_SPAWN_FAILED", `Could not stop the Codex session for thread ${threadId}`, async () => {
      const session = this.sessions.get(threadId);
      if (!session) return;
      await this.closeSession(session, "session-stopped");
    });

  readonly stopAll = (): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_SPAWN_FAILED", "Could not stop Codex sessions", async () => {
      for (const abort of this.titleAborts.values()) abort.abort();
      for (const session of [...this.sessions.values()]) {
        await this.closeSession(session, "session-stopped");
      }
    });

  private async closeSession(session: CodexSession, reason: string): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    await session.harness.close();
    this.denyParked(session, "Session ended.");
    this.settleOpenTurn(session, "interrupted", "Session ended.");
    session.background.clear();
    try {
      session.peer.close();
    } catch {
      // Best effort.
    }
    this.sessions.delete(session.threadId);
    this.publish({
      type: "thread.state.changed",
      provider: "codex",
      threadId: session.threadId,
      state: reason,
    });
  }

  readonly listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.succeed([...this.sessions.values()].map((session) => this.describeSession(session)));

  readonly hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(this.sessions.has(threadId));

  // -- turns ---------------------------------------------------------------

  readonly sendTurn = (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, CliError> =>
    this.attempt("CODEX_TURN_FAILED", `Could not send a turn on thread ${input.threadId}`, async () => {
      const session = this.requireSession(input.threadId);
      const codexThreadId = this.requireCodexThread(session);
      const open = session.transcript.find((turn) => turn.status === "running");
      if (open) {
        throw new CliError("TURN_BUSY", `Thread ${input.threadId} already has a running turn.`, {
          details: { threadId: input.threadId, turnId: open.id },
        });
      }
      const model = input.modelSelection ? resolveCodexModel(input.modelSelection.model) : session.model;
      session.model = model;
      if (input.runtimeMode) session.runtimeMode = input.runtimeMode;
      const requestedPolicy = staticPolicyForRuntimeMode(session.runtimeMode);
      const policy = session.isolation && requestedPolicy.sandbox === "danger-full-access" ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : requestedPolicy;
      const turnApprovalPolicy = policy.approvalPolicy;
      const options = input.modelSelection?.options ?? [];
      const optionValue = (ids: string[]): string | null => {
        for (const id of ids) {
          const found = options.find((option) => option.id === id);
          if (found && typeof found.value === "string" && found.value.trim()) return found.value.trim();
        }
        return null;
      };
      const effort = optionValue(["reasoningEffort", "effort"]) ?? "medium";
      const serviceTier = optionValue(["serviceTier", "tier"]);
      const turn: TranscriptTurn = {
        id: randomUUID(),
        serverTurnId: null,
        prompt: input.prompt,
        items: [{ kind: "user", text: input.prompt }],
        status: "running",
        text: "",
        error: null,
        messages: new Map(),
      };
      session.transcript.push(turn);
      session.harness.beginTurn(turn.id);
      session.lastActiveAt = Date.now();
      session.lastActiveThreadId = session.threadId;
      try {
        const compact = isCompactCommand(input.prompt);
        const notes = session.harness.takeNotes();
        const result = asRecord(await session.peer.request(compact ? CODEX_METHODS.threadCompactStart : CODEX_METHODS.turnStart, compact ? { threadId: codexThreadId } : {
          threadId: codexThreadId,
          input: [...await codexUserInput(session.peer, session.workingDirectory, input.prompt, input.images), ...(notes ? userInputBlocks(notes) : [])],
          ...(effort ? { effort } : {}),
          summary: this.providerConfig.reasoningSummary ?? "detailed",
          ...(model ? { model } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          approvalPolicy: turnApprovalPolicy,
          approvalsReviewer: session.runtimeMode === "auto" ? "auto_review" : "user",
          sandboxPolicy: policy.sandbox === "danger-full-access" ? { type: "dangerFullAccess" } : policy.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [session.workingDirectory], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        }));
        turn.serverTurnId ??= asString(asRecord(result?.["turn"])?.["id"]);
      } catch (cause) {
        this.settleOpenTurn(session, "failed", "Codex could not start the turn.");
        throw cause;
      }
      return { threadId: session.threadId, turnId: turn.id };
    });

  readonly interruptTurn = (threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_TURN_FAILED", `Could not interrupt the turn on thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      // Settle parked approvals/inputs first: interrupting while they park
      // deadlocks the server's stdin loop.
      session.harness.endTurn();
      this.denyParked(session, "Interrupted.");
      const open = session.transcript.find((turn) => turn.status === "running");
      if (!open) return;
      try {
        await session.peer.request(CODEX_METHODS.turnInterrupt, {
          threadId: this.requireCodexThread(session),
          turnId: open.serverTurnId,
        });
      } catch (cause) {
        if (!session.closed) throw cause;
      }
      this.settleOpenTurn(session, "interrupted", "Interrupted.");
    });

  async awaitTurn(threadId: ThreadId, turnId: TurnId, signal?: AbortSignal): Promise<CodexTurnOutcome> {
    const session = this.requireSession(threadId);
    const turn = session.transcript.find((candidate) => candidate.id === turnId);
    if (!turn) {
      throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turnId}.`, {
        details: { threadId, turnId },
      });
    }
    if (turn.status !== "running") {
      return {
        status: turn.status,
        text: turn.text,
        usage: this.usageOf(session, turnId),
        error: turn.error,
      };
    }
    if (signal?.aborted === true) {
      throw new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {
        details: { threadId, turnId },
      });
    }
    return await new Promise<CodexTurnOutcome>((resolve, reject) => {
      const list = session.waiters.get(turnId) ?? [];
      list.push({ resolve, reject });
      session.waiters.set(turnId, list);
      signal?.addEventListener(
        "abort",
        () => {
          const pending = session.waiters.get(turnId) ?? [];
          session.waiters.delete(turnId);
          for (const waiter of pending) {
            waiter.reject(
              new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {
                details: { threadId, turnId },
              }),
            );
          }
        },
        { once: true },
      );
    });
  }

  private usageOf(session: CodexSession, turnId: TurnId): TokenUsageDelta {
    const saved = session.transcript.find((turn) => turn.id === turnId)?.usage;
    if (saved) return saved;
    const totals = session.usage.peek(turnId);
    return {
      input: totals.input,
      cacheRead: totals.cacheRead,
      cacheCreate: totals.cacheCreate,
      output: totals.output,
      thinking: totals.reasoning,
    };
  }

  private settleOpenTurn(session: CodexSession, status: CodexTurnStatus, detail: string): void {
    session.harness.endTurn();
    const open = session.transcript.find((turn) => turn.status === "running");
    const usage = open ? this.usageOf(session, open.id) : null;
    if (open) {
      if (usage) open.usage = usage;
      open.status = status;
      open.error = status === "completed" ? null : detail;
      if (status !== "completed") open.text = open.text || detail;
      session.usage.take(open.id);
    }
    const waiters = open ? (session.waiters.get(open.id) ?? []) : [];
    if (open) session.waiters.delete(open.id);
    const outcome: CodexTurnOutcome = {
      status,
      text: open?.text ?? "",
      usage: usage ?? { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 },
      error: open?.error ?? detail,
    };
    for (const waiter of waiters) waiter.resolve(outcome);
    if (open) {
      this.publish({
        type: status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted",
        provider: "codex",
        threadId: session.threadId,
        turnId: open.id,
        ...(status === "failed" ? { raw: { error: open.error } } : {}),
      });
    }
  }

  // -- server requests (approvals) --------------------------------------------

  private sessionForPayload(params: unknown): CodexSession | null {
    const record = asRecord(params);
    const threadId =
      asString(record?.["threadId"]) ?? asString(record?.["conversationId"]) ?? null;
    if (threadId) {
      for (const session of this.sessions.values()) {
        if (session.codexThreadId === threadId) return session;
      }
    }
    if (this.sessions.size === 1) return [...this.sessions.values()][0]!;
    for (const session of this.sessions.values()) {
      if (session.lastActiveThreadId === session.threadId) return session;
    }
    return null;
  }

  private onServerRequest(
    session: CodexSession,
    method: string,
    params: unknown,
  ): Promise<unknown> | unknown {
    const kind = approvalKindForMethod(method);
    if (!kind) throw new Error(`Method not found: ${method}`);
    const target = this.sessionForPayload(params) ?? session;
    if (kind === "dynamic_tool_call") return { success: false, contentItems: [{ type: "inputText", text: "This client does not provide dynamic tools. Use the attached MCP tools." }] };
    if (target.isolation && rawInputViolation(target.isolation, params, target.workingDirectory)) return this.cancelResponse(kind, "The main checkout is outside this worktree.");
    if (target.delegated) return this.cancelResponse(kind, "No user is available for this delegated task.");
    const request = asRecord(params);
    // URL/OAuth elicitations need a browser flow, which Moxen cannot host.
    if (kind === "elicitation" && request?.["mode"] === "url") return { action: "decline" };
    const properties = asRecord(asRecord(request?.["requestedSchema"])?.["properties"]);
    const questions = kind === "elicitation" ? Object.entries(properties ?? { response: { type: "string", title: asString(request?.["message"]) ?? "MCP server input" } }).map(([id, raw]) => {
      const field = asRecord(raw) ?? {};
      const choices = Array.isArray(field["enum"]) ? field["enum"] : field["type"] === "boolean" ? [true, false] : [];
      return { id, question: asString(field["title"]) ?? asString(field["description"]) ?? id, header: id, options: choices.map((value) => ({ label: String(value), value: String(value) })) };
    }) : undefined;
    // Native question IDs survive the shared answer-panel projection.

    const requestId = randomUUID();
    const opened = kind === "user_input" || kind === "elicitation" ? "user-input.request.opened" : "permission.request.opened";
    this.publish({
      type: opened,
      provider: "codex",
      threadId: target.threadId,
      requestId,
      raw: { method, kind, params, ...(questions ? { questions } : {}), toolName: kind === "command_execution" ? "shell" : kind === "file_change" ? "apply_patch" : kind, input: params, classification: kind },
    } as ProviderRuntimeEvent);
    return new Promise<unknown>((resolve) => {
      target.parked.set(requestId, {
        threadId: target.threadId,
        kind,
        method,
        params,
        resolve: (result) => {
          target.parked.delete(requestId);
          const resolved = kind === "user_input" || kind === "elicitation" ? "user-input.request.resolved" : "permission.request.resolved";
          this.publish({
            type: resolved,
            provider: "codex",
            threadId: target.threadId,
            requestId,
            raw: { method, kind },
          } as ProviderRuntimeEvent);
          resolve(result);
        },
      });
    });
  }

  private denyParked(session: CodexSession, message: string): void {
    for (const [requestId, parked] of [...session.parked]) {
      session.parked.delete(requestId);
      try {
        parked.resolve(this.cancelResponse(parked.kind, message));
      } catch {
        // Handler already gone.
      }
    }
  }

  private cancelResponse(kind: CodexApprovalKind, message: string): unknown {
    void message;
    if (kind === "permissions") return { permissions: {}, scope: "turn" };
    if (kind === "user_input") return { answers: {} };
    if (kind === "elicitation") return { action: "cancel" };
    if (kind === "dynamic_tool_call") {
      return { success: false, contentItems: [{ type: "text", text: "Cancelled." }] };
    }
    return { decision: "cancel" };
  }

  readonly respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_TURN_FAILED", `Could not answer permission request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      if (session.harness.respond(requestId, decision)) return;
      const parked = session.parked.get(requestId);
      if (!parked || parked.threadId !== threadId) {
        throw new CliError("REQUEST_UNKNOWN", `No pending permission request ${requestId}.`, {
          details: { threadId, requestId },
        });
      }
      // A *dismissed question* arrives here, not only a miscalled
      // permission: the panel closes a question the same way it declines a
      // permission, and the request is still blocking the server call.
      // Throwing left the turn parked until the next interrupt, so release
      // it with this kind's own empty-answer shape instead.
      if (parked.kind === "user_input" || parked.kind === "elicitation") {
        if (decision.kind === "decline" || decision.kind === "cancel") {
          parked.resolve(
            decision.kind === "cancel"
              ? this.cancelResponse(parked.kind, "Cancelled.")
              : this.declineResponse(parked.kind),
          );
          return;
        }
        // Accepting is still a miscall: there is no answer to accept.
        throw new CliError("REQUEST_MISMATCH", `Request ${requestId} needs user input, not a permission decision.`, {
          details: { threadId, requestId, kind: parked.kind },
        });
      }
      if (parked.kind === "permissions") {
        const accepted = decision.kind === "accept" || decision.kind === "acceptForSession";
        parked.resolve({ permissions: accepted ? asRecord(parked.params)?.["permissions"] ?? {} : {}, scope: decision.kind === "acceptForSession" ? "session" : "turn" });
        return;
      }
      if (decision.kind === "accept") parked.resolve(this.acceptResponse(parked.kind, false));
      else if (decision.kind === "acceptForSession") {
        parked.resolve(this.acceptResponse(parked.kind, true));
      } else if (decision.kind === "decline") parked.resolve(this.declineResponse(parked.kind));
      else parked.resolve(this.cancelResponse(parked.kind, "Cancelled."));
    });

  private acceptResponse(kind: CodexApprovalKind, _forSession: boolean): unknown {
    if (kind === "dynamic_tool_call") return { success: true, contentItems: [] };
    return { decision: _forSession ? "acceptForSession" : "accept" };
  }

  private declineResponse(kind: CodexApprovalKind): unknown {
    if (kind === "dynamic_tool_call") {
      return { success: false, contentItems: [{ type: "text", text: "Declined." }] };
    }
    // A declined question answers nothing rather than refusing a
    // permission: `{ decision }` is not a shape either request understands,
    // and sending it would fail the call we are trying to release.
    if (kind === "permissions") return { permissions: {}, scope: "turn" };
    if (kind === "user_input") return { answers: {} };
    if (kind === "elicitation") return { action: "decline" };
    return { decision: "decline" };
  }

  readonly respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_TURN_FAILED", `Could not answer user input request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      if (session.harness.answer(requestId, answers)) return;
      const parked = session.parked.get(requestId);
      if (!parked || parked.threadId !== threadId) {
        throw new CliError("REQUEST_UNKNOWN", `No pending user input request ${requestId}.`, {
          details: { threadId, requestId },
        });
      }
      if (parked.kind === "user_input") {
        const mapped: Record<string, { answers: string[] }> = {};
        for (const [key, value] of Object.entries(answers)) mapped[key] = { answers: [value] };
        parked.resolve({ answers: mapped });
        return;
      }
      if (parked.kind === "elicitation") {
        const properties = asRecord(asRecord(asRecord(parked.params)?.["requestedSchema"])?.["properties"]);
        const content: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(answers)) {
          const field = asRecord(properties?.[key]);
          if (field?.["type"] === "boolean") content[key] = value === "true";
          else if (field?.["type"] === "number" || field?.["type"] === "integer") {
            const number = Number(value);
            if (!Number.isFinite(number) || (field["type"] === "integer" && !Number.isInteger(number))) throw new CliError("INVALID_ANSWER", "This field requires a number.");
            content[key] = number;
          } else content[key] = value;
        }
        parked.resolve({ action: "accept", content });
        return;
      }
      throw new CliError("REQUEST_MISMATCH", `Request ${requestId} needs a permission decision, not user input.`, {
        details: { threadId, requestId, kind: parked.kind },
      });
    });

  // -- notifications ------------------------------------------------------------

  private onNotification(session: CodexSession, method: string, params: unknown): void {
    if (session.closed) return;
    const notification = asRecord(params);
    const nativeThread = asString(notification?.["threadId"]);
    if (nativeThread && session.codexThreadId && nativeThread !== session.codexThreadId) {
      if (session.background.hasChild(nativeThread)) session.background.childNotification(nativeThread, method, notification);
      return;
    }
    const active = session.transcript.find((turn) => turn.status === "running");
    const nativeTurn = asString(notification?.["turnId"]) ?? asString(asRecord(notification?.["turn"])?.["id"]);
    if (method !== CODEX_METHODS.turnStarted && nativeTurn && active?.serverTurnId && nativeTurn !== active.serverTurnId) return;
    session.lastActiveAt = Date.now();
    switch (method) {
      case "error": {
        if (notification?.["willRetry"] === false) this.settleOpenTurn(session, "failed", this.turnErrorOf(session, notification));
        return;
      }
      case "thread/prediction/updated": {
        const result = asRecord(notification?.["result"]);
        const text = asString(result?.["text"]);
        if (result?.["type"] === "completed" && text) this.publish({ type: "prompt.suggested", provider: "codex", threadId: session.threadId, suggestion: text });
        return;
      }
      case "turn/plan/updated": {
        if (!session.checklist) return;
        this.publish({ type: "turn.plan.updated", provider: "codex", threadId: session.threadId, turnId: session.transcript.find((turn) => turn.status === "running")?.id ?? null, raw: params });
        return;
      }
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const id = asString(notification?.["itemId"]);
        let delta = asString(notification?.["delta"]) ?? "";
        if (id) {
          const stretch = session.reasoning.get(id) ?? { text: "", startedAt: Date.now(), summaryParts: new Map<number, string>() };
          if (method !== "item/reasoning/textDelta") {
            const index = typeof notification?.["summaryIndex"] === "number" ? notification["summaryIndex"] : 0;
            const boundary = !stretch.summaryParts.has(index) && stretch.summaryParts.size > 0;
            stretch.summaryParts.set(index, `${stretch.summaryParts.get(index) ?? ""}${delta}`);
            stretch.text = [...stretch.summaryParts].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n\n");
            if (boundary) delta = `\n\n${delta}`;
          } else if (stretch.summaryParts.size === 0) stretch.text += delta;
          else delta = "";
          session.reasoning.set(id, stretch);
        }
        if (id && delta) this.publish({ type: "reasoning.delta", provider: "codex", threadId: session.threadId, turnId: session.transcript.find((turn) => turn.status === "running")?.id ?? null, reasoningId: id, text: delta });
        return;
      }
      case CODEX_METHODS.turnStarted: {
        const record = asRecord(params);
        const turn = asRecord(record?.["turn"]);
        const serverId = asString(turn?.["id"]) ?? asString(record?.["turnId"]);
        const open = session.transcript.find((candidate) => candidate.status === "running");
        if (open && serverId) open.serverTurnId = serverId;
        if (!open && serverId) {
          const turn: TranscriptTurn = { id: randomUUID(), serverTurnId: serverId, prompt: "", items: [], status: "running", text: "", error: null, messages: new Map() };
          session.transcript.push(turn);
          this.publish({ type: "turn.started", provider: "codex", threadId: session.threadId, turnId: turn.id, origin: "background" });
        }
        return;
      }
      case CODEX_METHODS.turnCompleted: {
        const record = asRecord(params);
        const turn = asRecord(record?.["turn"]);
        const state = codexTurnStateOf(turn);
        const open = session.transcript.find((candidate) => candidate.status === "running");
        const usage = open ? this.usageOf(session, open.id) : null;
        if (usage && open) {
          this.publish({
            type: "token-usage.updated",
            provider: "codex",
            threadId: session.threadId,
            usage,
          });
        }
        if (state === "completed") this.settleOpenTurn(session, "completed", "");
        else if (state === "interrupted") this.settleOpenTurn(session, "interrupted", "Interrupted.");
        else this.settleOpenTurn(session, "failed", this.turnErrorOf(session, turn));
        return;
      }
      case CODEX_METHODS.turnFailed:
      case CODEX_METHODS.turnInterrupted: {
        const failed = method === CODEX_METHODS.turnFailed;
        this.settleOpenTurn(
          session,
          failed ? "failed" : "interrupted",
          failed ? rewriteLimitError(textOfDelta(params) ?? "Turn failed.", session.lastResetsAt) : "Interrupted.",
        );
        return;
      }
      case CODEX_METHODS.agentMessageDelta: {
        const text = textOfDelta(params);
        const open = session.transcript.find((candidate) => candidate.status === "running");
        const itemId = asString(asRecord(params)?.["itemId"]) ?? "";
        if (open?.messages.get(itemId)?.delivery === "async") return;
        if (text && open) {
          const message = open.messages.get(itemId) ?? { text: "", phase: null };
          message.text += text;
          open.messages.set(itemId, message);
          open.text = answerText(open.messages);
          open.items.push({ kind: "assistant", text });
        }
        // Commentary streams live like any message; once complete it is
        // recorded as a note (on item/completed), never as the turn's answer.
        if (text) {
          this.publish({
            type: "message.part.updated",
            provider: "codex",
            threadId: session.threadId,
            turnId: open?.id ?? null,
            messageId: itemId || "codex-message",
            text,
          });
        }
        return;
      }
      case CODEX_METHODS.commandOutputDelta:
      case CODEX_METHODS.itemStarted:
      case CODEX_METHODS.itemCompleted: {
        const record = asRecord(params);
        // The item is nested: `{ item: { id, type, tool?, … } }`. Reading
        // the notification's own top level found none of these keys, so
        // every Codex tool event published the bare name "tool" and the
        // transcript could not tell a shell call from a file edit.
        let item = asRecord(record?.["item"]) ?? record;
        const itemId = asString(item?.["id"]) ?? asString(record?.["itemId"]);
        if (method === CODEX_METHODS.commandOutputDelta && itemId) {
          const prior = session.tools.get(itemId);
          if (prior) item = { ...prior, aggregatedOutput: `${asString(prior["aggregatedOutput"]) ?? ""}${textOfDelta(params) ?? ""}` };
        }
        if (itemId && item) {
          if (method === CODEX_METHODS.itemCompleted) session.tools.delete(itemId);
          else session.tools.set(itemId, item);
        }
        if (item?.["type"] === "commandExecution") session.background.command(item, method === CODEX_METHODS.itemCompleted);
        const tool =
          asString(item?.["tool"]) ??
          asString(item?.["kind"]) ??
          asString(item?.["type"]) ??
          "tool";
        const open = session.transcript.find((candidate) => candidate.status === "running");
        if (item?.["type"] === "reasoning") {
          const done = method === CODEX_METHODS.itemCompleted;
          const id = asString(item["id"]);
          if (id) {
            const stretch = session.reasoning.get(id) ?? { text: "", startedAt: Date.now(), summaryParts: new Map<number, string>() };
            const summary = Array.isArray(item["summary"]) ? item["summary"].join("\n\n") : "";
            const content = Array.isArray(item["content"]) ? item["content"].join("\n\n") : "";
            if (!done) session.reasoning.set(id, stretch);
            else session.reasoning.delete(id);
            this.publish({ type: "reasoning.updated", provider: "codex", threadId: session.threadId, turnId: open?.id ?? null, reasoningId: id, status: done ? "completed" : "running", text: summary || stretch.text || content, startedAt: new Date(stretch.startedAt).toISOString(), durationMs: done ? Math.max(0, Date.now() - stretch.startedAt) : null });
          }
          return;
        }
        if (item?.["type"] === "contextCompaction" && method === CODEX_METHODS.itemCompleted) {
          this.publish({ type: "session.notice", provider: "codex", threadId: session.threadId, turnId: open?.id ?? null, notice: "compacted", title: "Conversation compacted", detail: null });
          return;
        }
        if (item?.["type"] === "subAgentActivity") {
          const agentId = asString(item["agentThreadId"]);
          const kind = asString(item["kind"]);
          if (agentId && kind !== "interacted") session.background.agent(agentId, kind === "started", null, null);
          if (agentId && kind !== "interacted") this.publish({ type: "subagent.updated", provider: "codex", threadId: session.threadId, turnId: open?.id ?? null, agentId, agentType: asString(item["agentPath"]) ?? "codex", status: kind === "started" ? "started" : "stopped", lastMessage: null });
          return;
        }
        if (item?.["type"] === "collabAgentToolCall") {
          const states = asRecord(item["agentsStates"]) ?? {};
          const receivers = Array.isArray(item["receiverThreadIds"]) ? item["receiverThreadIds"] : [];
          for (const agentId of receivers) {
            if (typeof agentId !== "string") continue;
            const state = asRecord(states[agentId]);
            const status = asString(state?.["status"]);
            session.background.agent(agentId, status !== "completed" && status !== "errored" && status !== "shutdown", asString(item["prompt"]), asString(state?.["message"]));
            this.publish({ type: "subagent.updated", provider: "codex", threadId: session.threadId, turnId: open?.id ?? null, agentId, agentType: "codex", status: status === "completed" || status === "errored" || status === "shutdown" ? "stopped" : "started", lastMessage: asString(state?.["message"]), description: asString(item["prompt"]) });
          }
        }
        const agentMessage = method === CODEX_METHODS.commandOutputDelta ? null : agentMessageItem(params);
        if (open && agentMessage) {
          const message = open.messages.get(agentMessage.id) ?? { text: "", phase: null };
          message.phase = agentMessage.phase ?? message.phase;
          message.delivery = agentMessage.delivery ?? message.delivery ?? null;
          // The completed item carries the whole message; prefer it to the
          // deltas we pieced together.
          if (method === CODEX_METHODS.itemCompleted && agentMessage.text !== null) message.text = agentMessage.text;
          open.messages.set(agentMessage.id, message);
          open.text = answerText(open.messages);
          // A finished `commentary` message is the model narrating its work.
          if (method === CODEX_METHODS.itemCompleted && (message.phase === "commentary" || message.delivery === "async" && agentMessage.questions.length === 0) && message.text.trim()) {
            this.publish({
              type: "assistant.note",
              provider: "codex",
              threadId: session.threadId,
              turnId: open.id,
              messageId: agentMessage.id,
              text: message.text,
            });
          }
        }
        if (agentMessage?.delivery === "async" && agentMessage.questions.length > 0 && method === CODEX_METHODS.itemCompleted && !session.delegated) {
          this.publish({
            type: "user-input.request.opened", provider: "codex", threadId: session.threadId,
            requestId: `codex-async:${session.codexThreadId}:${agentMessage.id}`,
            raw: { delivery: "async", nativeThreadId: session.codexThreadId, questions: agentMessage.questions },
          });
        }
        if (agentMessage) return;
        if (open && method === CODEX_METHODS.itemCompleted) {
          open.items.push({ kind: "tool", tool, text: textOfDelta(params) ?? tool });
        }
        this.publish({
          type:
            method === CODEX_METHODS.itemStarted
              ? "tool.execute.started"
              : method === CODEX_METHODS.itemCompleted
                ? "tool.execute.completed"
                : "tool.execute.updated",
          provider: "codex",
          threadId: session.threadId,
          turnId: open?.id ?? null,
          tool,
          raw: { ...record, item },
        });
        return;
      }
      case CODEX_METHODS.threadCompacted: {
        this.publish({
          type: "thread.state.changed",
          provider: "codex",
          threadId: session.threadId,
          state: "compacted",
          raw: params,
        });
        return;
      }
      case CODEX_METHODS.tokenUsageUpdated: {
        const record = asRecord(params);
        const usage = asRecord(record?.["tokenUsage"]) ?? record;
        const open = session.transcript.find((candidate) => candidate.status === "running");
        const total = codexTokenBreakdownOf(usage?.["total"] ?? usage);
        const last = codexTokenBreakdownOf(usage?.["last"] ?? {});
        const totals = session.usage.observe(open?.id ?? "unknown", total, last);
        session.context = codexContextUsageOf(usage) ?? session.context;
        this.publish({
          type: "token-usage.updated",
          provider: "codex",
          threadId: session.threadId,
          usage: {
            input: totals.input,
            cacheRead: totals.cacheRead,
            cacheCreate: totals.cacheCreate,
            output: totals.output,
            thinking: totals.reasoning,
          },
        });
        return;
      }
      case CODEX_METHODS.rateLimitsUpdated: {
        const record = asRecord(params);
        this.applyRateSnapshot(session, record?.["rateLimits"] ?? params);
        return;
      }
      default:
        return;
    }
  }

  private turnErrorOf(session: CodexSession, turn: Record<string, unknown> | null): string {
    const message =
      asString(turn?.["error"]) ??
      asString(asRecord(turn?.["error"])?.["message"]) ??
      "Turn failed.";
    return rewriteLimitError(message, session.lastResetsAt);
  }

  // -- state ----------------------------------------------------------------------

  readonly readThread = (threadId: ThreadId): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("CODEX_TURN_FAILED", `Could not read thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      return {
        threadId,
        turns: session.transcript.map((turn) => ({
          id: turn.id,
          items: turn.items.map((item) => ({ ...item })),
        })),
      };
    });

  readonly rollbackThread = (
    threadId: ThreadId,
    numTurns: number,
  ): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("ROLLBACK_FAILED", `Could not roll back thread ${threadId}`, async () => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        throw new CliError("INVALID_ROLLBACK", "numTurns must be an integer >= 1.", {
          details: { threadId, numTurns },
        });
      }
      const session = this.requireSession(threadId);
      const codexThreadId = this.requireCodexThread(session);
      const turns = await readCodexTurns(session.peer, codexThreadId, numTurns);
      const boundary = turns[numTurns - 1];
      if (!boundary) throw new CliError("ROLLBACK_UNAVAILABLE", "Codex has fewer retained turns than requested.");
      try { await session.peer.request(CODEX_METHODS.threadRevert, { threadId: codexThreadId, beforeTurnId: boundary["id"] }); }
      catch (cause) {
        if (!codexMethodUnavailable(cause)) throw cause;
        await session.peer.request(CODEX_METHODS.threadRollback, { threadId: codexThreadId, numTurns });
      }
      session.transcript = session.transcript.slice(0, Math.max(0, session.transcript.length - numTurns));
      return {
        threadId,
        turns: session.transcript.map((turn) => ({
          id: turn.id,
          items: turn.items.map((item) => ({ ...item })),
        })),
      };
    });

  readonly uploadFeedback = (
    input: { threadId: ThreadId },
  ): Effect.Effect<{ threadId: ThreadId; url: string | null }, CliError> =>
    this.attempt("CODEX_TURN_FAILED", `Could not upload feedback for thread ${input.threadId}`, async () => {
      const session = this.requireSession(input.threadId);
      const result = await session.peer.request(CODEX_METHODS.feedbackUpload, {
        threadId: this.requireCodexThread(session),
      });
      return { threadId: input.threadId, url: asString(asRecord(result)?.["url"]) };
    });

  /** Live model list; no allowlist — the server is the source of truth. */
  /**
   * `skills/list` for `cwd` (app-server `SkillsListParams.cwds`), on a
   * catalog session of its own. Codex invokes a skill as `$name`.
   */
  readonly skillInventory = async (cwd: string): Promise<SkillInventory> => {
    return await this.withPeer(cwd, async (peer) => {
      const result = asRecord(await peer.request(CODEX_METHODS.skillsList, { cwds: [cwd] }));
      const entries = Array.isArray(result?.["data"]) ? (result["data"] as unknown[]) : [];
      const skills: SkillSummary[] = [];
      for (const entry of entries) {
        const list = asRecord(entry)?.["skills"];
        for (const raw of Array.isArray(list) ? list : []) {
          const skill = asRecord(raw);
          const name = asString(skill?.["name"]);
          if (!skill || !name) continue;
          const face = asRecord(skill["interface"]);
          skills.push(
            plainSkill(name, asString(skill["description"]), {
              displayName: asString(face?.["displayName"]),
              shortDescription: asString(face?.["shortDescription"]) ?? asString(skill["shortDescription"]),
              enabled: skill["enabled"] !== false,
            }),
          );
        }
      }
      return { trigger: "$", skills, commands: [] };
    });
  };

  async listModels(threadId: ThreadId): Promise<ReadonlyArray<CodexListedModel>> {
    const session = this.requireSession(threadId);
    const result = await session.peer.request(CODEX_METHODS.modelList, {});
    const record = asRecord(result);
    // Local CLIs disagree on the envelope key: observed `models` and
    // `items` during development, `data` on codex-cli 0.153.4 (paginated).
    const rawList = Array.isArray(result)
      ? result
      : (record?.["models"] ?? record?.["items"] ?? record?.["data"] ?? []);
    const list = Array.isArray(rawList) ? rawList : [];
    const models: Array<CodexListedModel> = [];
    for (const entry of list) {
      const item = asRecord(entry);
      const id = asString(item?.["id"]) ?? asString(item?.["model"]) ?? asString(item?.["slug"]);
      if (!id) continue;
      const name = asString(item?.["displayName"]) ?? asString(item?.["name"]) ?? id;
      const efforts = asRecord(item)?.["supportedReasoningEfforts"];
      const reasoningEfforts = Array.isArray(efforts)
        ? efforts.flatMap((effort) => {
          const value = asString(asRecord(effort)?.["reasoningEffort"]);
          return value ? [value] : [];
        })
        : [];
      models.push({
        id,
        ...(name !== id ? { name } : {}),
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      });
    }
    return models;
  }

  /** Serialized per CODEX_HOME: consume one reset credit, then re-probe. */
  async consumeResetCredit(threadId: ThreadId): Promise<unknown> {
    const session = this.requireSession(threadId);
    const home = resolveCodexHome(this.settings.homePath, this.baseEnv);
    const previous = resetCreditLocks.get(home) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    resetCreditLocks.set(home, current);
    await previous;
    try {
      const outcome = await session.peer.request(CODEX_METHODS.rateLimitResetCreditConsume, { idempotencyKey: randomUUID() });
      await this.probeRateLimits(session);
      return outcome;
    } finally {
      release();
      if (resetCreditLocks.get(home) === current) {
        resetCreditLocks.delete(home);
      }
    }
  }

  readonly backgroundTasks = (threadId: string) => {
    const session = this.sessions.get(threadId);
    return session ? [...session.background.list(), ...session.harness.backgroundTasks()] : [];
  };

  readonly backgroundTaskOutput = async (threadId: string, taskId: string): Promise<{ lines: readonly string[] } | null> => {
    const session = this.sessions.get(threadId);
    const lines = session?.harness.output(taskId) ?? session?.background.lines(taskId);
    return lines ? { lines } : null;
  };

  readonly stopBackgroundTask = (threadId: string, taskId: string): Effect.Effect<void, CliError> =>
    this.attempt("CODEX_TASK_STOP_FAILED", "Could not stop Codex background work", async () => {
      const session = this.requireSession(threadId);
      if (await session.harness.stop(taskId)) return;
      if (!taskId.startsWith("agent:") || !session.background.hasChild(taskId.slice(6))) throw new CliError("BACKGROUND_TASK_STOP_UNSUPPORTED", "Codex cannot stop this command independently of its turn.");
      const id = taskId.slice(6);
      const turn = (await readCodexTurns(session.peer, id, 1))[0];
      const turnId = asString(turn?.["id"]);
      if (turnId && turn?.["status"] === "inProgress") await session.peer.request("turn/interrupt", { threadId: id, turnId });
      session.background.agent(id, false, null, null);
      this.publish({ type: "subagent.updated", provider: "codex", threadId, turnId: null, agentId: id, agentType: "codex", status: "stopped", lastMessage: null });
    });

  readonly subagentHistory = async (threadId: string, agentId: string): Promise<readonly SubagentHistoryItem[] | null> => {
    const session = this.sessions.get(threadId);
    if (!session) return this.withPeer(process.cwd(), (peer) => readCodexHistory(peer, agentId));
    return readCodexHistory(session.peer, agentId);
  };

  /** A side answer runs in a disposable, read-only fork, with external tools disabled. */
  readonly sideQuestion = async (input: SideQuestionInput): Promise<SideAnswer> => this.withPeer(input.workingDirectory, async (peer) => {
    if (input.signal?.aborted) throw new CliError("TURN_ABORTED", "Side question cancelled.");
    const configRead = asRecord(await peer.request("config/read", { includeLayers: false }));
    const config = asRecord(configRead?.["config"]);
    const mcp = asRecord(config?.["mcp_servers"]) ?? {};
    const overrides = {
      cwd: input.workingDirectory, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      ...(input.model ? { model: input.model } : {}),
      developerInstructions: "Answer the side question from the conversation. Do not use tools or change anything. Return only the answer.",
      config: { "features.shell_tool": false, "features.multi_agent": false, "features.memories": false, "web_search": "disabled", "features.view_image": false, "apps._default.enabled": false, "features.apps": false, "features.plugins": false, "features.browser_use": false, "features.computer_use": false, "features.image_generation": false, "features.sleep_tool": false, "features.goals": false, ...Object.fromEntries(Object.keys(mcp).map((name) => [`mcp_servers.${name}.enabled`, false])) },
    };
    const result = await peer.request(input.cursor ? "thread/fork" : "thread/start", { ...overrides, ...(input.cursor ? { threadId: input.cursor, excludeTurns: true } : {}) });
    const id = codexThreadIdOf(result);
    if (!id) throw new CliError("CODEX_START_FAILED", "Codex returned no side-question thread.");
    const messages = new Map<string, AgentMessage>();
    return await new Promise<SideAnswer>((resolve, reject) => {
      const timer = setTimeout(() => finish(new CliError("CODEX_TURN_FAILED", "Codex side question timed out.")), 90_000);
      const abort = () => finish(new CliError("TURN_ABORTED", "Side question cancelled."));
      const off = peer.onNotification((method, raw) => {
        const params = asRecord(raw);
        if (params?.["threadId"] !== id) return;
        if (method === "item/agentMessage/delta") {
          const key = asString(params["itemId"]) ?? "answer";
          const message = messages.get(key) ?? { text: "", phase: null };
          message.text += asString(params["delta"]) ?? "";
          messages.set(key, message);
        } else if (method === "item/completed") {
          const item = agentMessageItem(raw);
          if (item) messages.set(item.id, { text: item.text ?? "", phase: item.phase });
        } else if (method === "turn/completed") {
          const turn = asRecord(params["turn"]);
          if (turn?.["status"] !== "completed") finish(new CliError("CODEX_TURN_FAILED", "Codex could not answer the side question."));
          else finish();
        }
      });
      const onExit = peer.onExit(() => finish(new CliError("CODEX_TURN_FAILED", "Codex exited before answering.")));
      function finish(error?: Error): void {
        clearTimeout(timer); off(); onExit(); input.signal?.removeEventListener("abort", abort);
        const text = answerText(messages).trim();
        if (error) reject(error);
        else if (!text) reject(new CliError("CODEX_TURN_FAILED", "Codex side answer came back empty."));
        else resolve({ text, withContext: input.cursor !== null });
      }
      peer.onRequest((method) => this.cancelResponse(approvalKindForMethod(method) ?? "dynamic_tool_call", "Side questions cannot use tools."));
      input.signal?.addEventListener("abort", abort, { once: true });
      void peer.request("turn/start", { threadId: id, input: userInputBlocks(input.question) }).catch((cause: unknown) => finish(cause instanceof Error ? cause : new Error("Codex side question failed.")));
    });
  });

  readonly regenerateSessionTitle = async (cursor: string, cwd: string): Promise<string | null> => {
    const answer = await this.sideQuestion({ cursor, workingDirectory: cwd, question: "Give this conversation a concise title of at most eight words. Return only the title." });
    const title = answer.text.split("\n")[0]?.trim().replace(/^["']|["']$/g, "").slice(0, 120) ?? null;
    if (title) await this.renameSession(cursor, cwd, title);
    return title;
  };

  readonly forkSession = async (cursor: string, cwd: string): Promise<string> => this.withPeer(cwd, async (peer) => {
    const id = codexThreadIdOf(await peer.request("thread/fork", { threadId: cursor, cwd, excludeTurns: true }));
    if (!id) throw new CliError("CODEX_FORK_FAILED", "Codex returned no forked thread.");
    return id;
  });

  readonly sessionTitle = async (cursor: string, cwd: string): Promise<string | null> => {
    const existing = await this.withPeer(cwd, async (peer) => {
      const result = asRecord(await peer.request("thread/read", { threadId: cursor }));
      return asString(asRecord(result?.["thread"])?.["name"]);
    });
    if (existing) return existing;
    const pending = this.titleJobs.get(cursor);
    if (pending) return pending;
    const abort = new AbortController();
    this.titleAborts.set(cursor, abort);
    const version = this.titleVersions.get(cursor) ?? 0;
    const job = this.sideQuestion({ cursor, workingDirectory: cwd, signal: abort.signal, question: "Write a concise title of three to seven words naming the work in this conversation, in the user's language. Return only the title." }).then(async (answer) => {
      const title = answer.text.split("\n").find((line) => line.trim())?.trim().replace(/^["'`*#]+|["'`*]+$/g, "").slice(0, 80) ?? null;
      if (!title || (this.titleVersions.get(cursor) ?? 0) !== version) return null;
      await this.renameSession(cursor, cwd, title);
      const threadId = [...this.resumable].find(([, id]) => id === cursor)?.[0];
      if (threadId) this.publish({ type: "session.title.updated", provider: "codex", threadId, title });
      return title;
    }).finally(() => { this.titleJobs.delete(cursor); this.titleAborts.delete(cursor); });
    this.titleJobs.set(cursor, job);
    return job;
  };

  readonly renameSession = async (cursor: string, cwd: string, title: string): Promise<void> => {
    this.titleVersions.set(cursor, (this.titleVersions.get(cursor) ?? 0) + 1);
    await this.withPeer(cwd, async (peer) => { await peer.request("thread/name/set", { threadId: cursor, name: title }); });
  };

  /** Test hook: account type observed at session start. */
  accountTypeOf(threadId: ThreadId): CodexAccountType {
    return this.requireSession(threadId).accountType;
  }
}

/** `thread/start` and `thread/resume` both answer `{ thread: { id } }`; older builds used flatter shapes. */
function codexThreadIdOf(response: unknown): string | null {
  const record = asRecord(response);
  return (
    asString(record?.["threadId"]) ??
    asString(asRecord(record?.["thread"])?.["id"]) ??
    asString(record?.["id"])
  );
}

/**
 * `ThreadTokenUsage` → `ContextWindowUsage`. `last` is the most recent
 * request — the one whose prompt is what the window holds now — and
 * `modelContextWindow` its size. Codex reports no auto-compact policy.
 */
export function codexContextUsageOf(raw: unknown): ContextWindowUsage | null {
  const usage = asRecord(raw);
  const last = asRecord(usage?.["last"]);
  if (!last) return null;
  const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const used = number(last["totalTokens"]) ?? (number(last["inputTokens"]) ?? 0) + (number(last["outputTokens"]) ?? 0);
  if (used <= 0) return null;
  return {
    usedTokens: used,
    maxTokens: number(usage?.["modelContextWindow"]),
    cachedInputTokens: number(last["cachedInputTokens"]),
    autoCompactThreshold: null,
    compactsAutomatically: null,
  };
}

/**
 * moxen's MCP servers as `thread/start` / `thread/resume` config
 * overrides. Each server is its own dotted key, `mcp_servers.<name>`, so
 * it is added next to the user's `config.toml` servers rather than
 * replacing the whole table (names are validated dot-free in `core/mcp`).
 */
function codexMcpConfig(servers: readonly McpServerSpec[], disabled: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(
    // Codex hosts nothing in-process: moxen's own tools come over their fallback.
    servers.map(outOfProcess).map((server) => [
      `mcp_servers.${server.name}`,
      server.type === "http"
        ? { disabled_tools: disabled.filter((name) => name.startsWith(`mcp__${server.name}__`)).map((name) => name.slice(`mcp__${server.name}__`.length)), url: server.url, ...(Object.keys(server.headers).length > 0 ? { http_headers: { ...server.headers } } : {}) }
        : {
            disabled_tools: disabled.filter((name) => name.startsWith(`mcp__${server.name}__`)).map((name) => name.slice(`mcp__${server.name}__`.length)),
            command: server.command,
            args: [...server.args],
            ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
          },
    ]),
  );
}

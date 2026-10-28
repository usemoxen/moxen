/**
 * Moxen Harness driver: `ProviderAdapter` over our own agent loop
 * (`loop.ts`) against an endpoint the user configured (`profiles.ts`).
 *
 * One session per thread, held in memory with its transcript on disk
 * (`session.ts`); the file name is the resume cursor. A turn runs in the
 * background after `sendTurn` returns, publishes what the loop reports as the
 * same runtime events the other drivers publish, and settles `awaitTurn`.
 *
 * A tool call that needs approval for the thread's runtime mode is parked
 * here until the client answers (`respondToRequest`); so is the model's own
 * question (`ask`, `respondToUserInput`). Both resolve when the turn is
 * interrupted. Compaction (`compact.ts`) runs here, because it needs the session:
 * its transcript, read state, checklist and the model it talks to. So do
 * subagents (a second loop that borrows this session's permissions), background
 * commands, `/btw` and titles (one-shot requests over a copy of the transcript).
 * Gaps, stated so they are not mistaken for features: nothing here has run
 * against a live API, and the key is never read from anywhere but the profile's
 * environment variable.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CliError } from "../../errors.js";
import { isolationViolation, rawInputViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import { mcpSignature, type McpServerSpec } from "../../mcp.js";
import { resolveStoreRoot } from "../../threads/store.js";
import type { TurnUsage } from "../../threads/types.js";
import type { HarnessProfileConfig, HarnessProviderConfig, InteractionMode, ModelSelection, RuntimeMode, WebConfig } from "../../types.js";
import type {
  ApprovalRequestId,
  BackgroundTaskSummary,
  ContextBreakdown,
  ContextWindowUsage,
  ProviderAdapter,
  ProviderApprovalDecision,
  ProviderAdapterCapabilities,
  ProviderImage,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderThreadSnapshot,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  SideAnswer,
  SideQuestionInput,
  SubagentHistoryItem,
  ThreadId,
  TurnId,
} from "../spi.js";
import { BackgroundShells, type BackgroundEvent, type BackgroundTask } from "./background.js";
import { compact, leadLength, MAX_CONSECUTIVE_FAILURES, type CompactReason, type Summarise } from "./compact.js";
import { autoCompactThreshold, loopCompactThreshold } from "./compactsettings.js";
import { contextBreakdownOf, contextUsageOf, estimateTokens, messagesTokens, type ContextInput } from "./context.js";
import { runTurn, type Authorization, type CompactionReport, type LoopEvent, type TurnConfig } from "./loop.js";
import { CANCELLED_MESSAGE, classificationOf, declinedMessage, decidePermission, sessionAllowKey } from "./permissions.js";
import { instructionsChangedReminder, instructionsIn, buildSystemPrompt, MCP_SECTION_HEADING, mcpSection } from "./prompt.js";
import { openMcpPool, untrustedContext, type ConnectMcp, type McpPool } from "./mcp.js";
import { discoverSkills, skillTool, type Skill } from "./skills.js";
import { primeProfileKey, readProfileApiKey, resolveCompactionSettings, resolveHarnessTarget, type ResolvedHarnessTarget } from "./profiles.js";
import { HarnessTranscript } from "./session.js";
import { cleanTitle, settledPrefix, SIDE_QUESTION_INSTRUCTION, SIDE_QUESTION_NO_CONTEXT, TITLE_INSTRUCTION } from "./sidequery.js";
import { askTool, todoTool } from "./tools/index.js";
import { subagentTool, type SubagentArgs } from "./tools/subagent.js";
import { webFetchTool, webSearchTool } from "./tools/web.js";
import { resolveWebSettings } from "./web/settings.js";
import { subagentHistory, subagentRole, subagentTools } from "./subagent.js";
import { RequestLimiter } from "./limiter.js";
import type { AskQuestion, AskReply, HarnessTool, TodoItem, ToolContext, ToolIntent, ToolResult } from "./tools/index.js";
import { copySessionState, loadSessionState, saveSessionState } from "./sessionstate.js";
import { applyToolDescriptions, builtinTools, ReadState } from "./tools/index.js";
import type { ChatRequest } from "./transport/chat.js";
import { conversationFields, streamModel } from "./transport/model.js";
import type { ModelUsage, ToolCall, ToolDefinition, TranscriptMessage } from "./types.js";

export interface HarnessDriverOptions {
  readonly config?: HarnessProviderConfig | undefined;
  /** Where transcripts are kept; defaults to `<store root>/harness`. */
  readonly sessionsDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Swapped out in tests. */
  readonly transport?: TurnConfig["transport"];
  readonly sleep?: TurnConfig["sleep"];
  /** Swapped out in tests. */
  readonly connectMcp?: ConnectMcp;
  /** The home directory whose skill folders count as the user's own. */
  readonly home?: string;
}

interface HarnessTurn {
  readonly id: TurnId;
  status: "running" | "completed" | "failed" | "interrupted";
  text: string;
  error: string | null;
  usage: TurnUsage | null;
  readonly controller: AbortController;
  readonly reasoningStarted: Set<string>;
  /** What the turn's subagents used, which the loop's own totals do not include. */
  readonly subagentUsage: { input: number; cacheRead: number; output: number; thinking: number };
  readonly waiters: Array<{ resolve: (outcome: HarnessTurnOutcome) => void; reject: (error: Error) => void }>;
}

export interface HarnessTurnOutcome {
  readonly status: "completed" | "failed" | "interrupted";
  readonly text: string;
  readonly usage: TurnUsage | null;
  readonly error: string | null;
}

interface HarnessSession {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly transcript: HarnessTranscript;
  readonly readState: ReadState;
  readonly artifactDir: string;
  readonly isolation: WorktreeIsolation | null;
  readonly startedAt: string;
  instanceId: string;
  modelSlug: string | null;
  modelOptions: ModelSelection["options"];
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  instructions: string;
  /** False for a delegated task: nobody is there to answer, so nothing may wait on the user. */
  readonly interactive: boolean;
  closed: boolean;
  turns: Map<TurnId, HarnessTurn>;
  /** The newest usage the server reported for this transcript; null until one comes, and after a rollback. */
  lastUsage: ModelUsage | null;
  /** Approvals and questions the running turn waits on. */
  readonly parked: Map<ApprovalRequestId, ParkedRequest>;
  /** What "allow for this session" answers cover (`permissions.ts`). */
  readonly allowed: Set<string>;
  /** Text sent mid-turn, waiting for the loop's next step. */
  readonly steering: { readonly text: string; readonly images: readonly ProviderImage[] }[];
  /** False when the user switched the to-do list off: the model is given no `todo` tool. */
  readonly checklist: boolean;
  /** The model's checklist as it last sent it. Lives only in memory, so a compaction can carry it forward. */
  todos: readonly TodoItem[];
  /** Compactions in a row that made no summary or freed too little room; reset by one that did. */
  compactFailures: number;
  /** The MCP servers this session was started with: connected once, and the tool list they gave is fixed. */
  readonly mcp: McpPool;
  /** A hash of the configured servers at start (their `env` and `headers` may hold secrets, so the signature itself is not kept); a later difference is told to the user, not applied. */
  readonly mcpSignature: string;
  /** The last configured set the user was told will wait for a new session. */
  mcpNoticed: string;
  /** The `skill` tool (null when there are no skills), fixed at start like the MCP tools. */
  readonly skillTool: HarnessTool<never> | null;
  /** Commands started with `run_in_background`; they end with the session. */
  readonly background: BackgroundShells;
  /** Every running subagent's switch, so one can be stopped by id whether it runs in the foreground or not. */
  readonly subagents: Map<string, AbortController>;
  /** The timer that wakes an idle session for a finished background task, and how many wakes in a row there have been since the user last spoke. */
  wakeTimer: ReturnType<typeof setTimeout> | null;
  wakeStreak: number;
  /** What the model should be told before its next request (a background command ended). */
  readonly modelNotes: Array<{ readonly taskId: string; readonly text: string }>;
  /** Things to tell the user at the next turn (a server that did not come up); a session has no turn to attach them to before. */
  readonly notices: Array<{ readonly title: string; readonly detail: string | null }>;
}

/** What compaction works on: the thread's conversation, or a subagent's own. */
interface CompactionUnit {
  readonly transcript: HarnessTranscript;
  readonly readState: ReadState;
  readonly interactionMode: InteractionMode;
  readonly todos: readonly TodoItem[];
  compactFailures: number;
  lastUsage: ModelUsage | null;
  definitions(): ToolDefinition[];
}

type ParkedRequest =
  | { readonly kind: "permission"; readonly resolve: (decision: ProviderApprovalDecision | "interrupted") => void }
  | { readonly kind: "input"; readonly resolve: (reply: AskReply | "cancelled") => void };

/** Tools whose activity is shown by their own surface (the tasks panel, the answer panel), not as a tool row. */
const SILENT_TOOLS: ReadonlySet<string> = new Set(["todo", "ask"]);
/** What the system prompt may say about tools that exist only in some sessions. */
const SESSION_TOOL_NAMES = ["subagent", "web_fetch", "web_search", "todo"] as const;

/** The tool names `isolationViolation` knows, by ours. */
const ISOLATION_TOOL_NAMES: Readonly<Record<string, string>> = { edit: "Edit", write: "Write", bash: "Bash" };

/** A hash of what makes a set of servers the same set, to compare sets without keeping the specs (they may hold secrets). */
function fingerprint(servers: readonly McpServerSpec[]): string {
  return createHash("sha256").update(mcpSignature(servers)).digest("hex");
}

/** A tool call's arguments in one short line, for a subagent's progress log. */
function summarizeArguments(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

const WAKE_DEBOUNCE_MS = 600;
const MAX_WAKES_IN_A_ROW = 6;
/** How much of a finished task's output goes into the message that tells the model. */
const NOTE_OUTPUT_CHARS = 3500;

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toCliError(code: string, message: string, cause: unknown): CliError {
  if (cause instanceof CliError) return cause;
  return new CliError(code, `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

export class HarnessDriver implements ProviderAdapter<CliError> {
  readonly provider = "harness" as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    sessionModelSwitch: "in-session",
    supportsConversationRollback: true,
  };

  /** `/compact` as a client sends it; the work is the same as a turn that is only a compaction. */
  readonly compaction = {
    type: "native" as const,
    start: (threadId: ThreadId, modelSelection?: ModelSelection): Effect.Effect<void, CliError> =>
      Effect.asVoid(this.sendTurn({ threadId, prompt: "/compact", ...(modelSelection ? { modelSelection } : {}) })),
  };

  private config: HarnessProviderConfig | undefined;
  /** The shared web settings (`web`), which the Harness's web tools follow like every provider's. */
  private web: WebConfig | undefined;
  private readonly sessionsDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: TurnConfig["transport"] | undefined;
  private readonly sleep: TurnConfig["sleep"] | undefined;
  private readonly sessions = new Map<ThreadId, HarnessSession>();
  /** Sessions being started (their MCP servers are connecting): a second start for the thread waits for the first. */
  private readonly starting = new Map<ThreadId, Promise<ProviderSession>>();
  private readonly connectMcp: ConnectMcp | undefined;
  private readonly home: string | undefined;
  private readonly queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  /** Titles being made, by session id, so a second ask waits for the first instead of paying for another request. */
  private readonly titling = new Map<string, Promise<string | null>>();
  /** Automatic title attempts that made nothing, by session id; after a few the session is left untitled until asked again. */
  private readonly titleFailures = new Map<string, number>();

  constructor(options: HarnessDriverOptions = {}) {
    this.config = options.config;
    this.sessionsDir = options.sessionsDir ?? path.join(resolveStoreRoot(), "harness");
    this.env = options.env ?? process.env;
    this.transport = options.transport;
    this.sleep = options.sleep;
    this.connectMcp = options.connectMcp;
    this.home = options.home;
  }

  /** Profiles and compaction settings are read on every use, so an edit reaches the next turn of a running session. */
  /** Environment variables that hold keys moxen uses; commands the model runs do not inherit them. */
  private secretEnvNames(): string[] {
    const names = (this.config?.profiles ?? []).map((profile) => profile.apiKeyEnv);
    names.push(this.config?.webSearchKeyEnv, ...Object.values(this.config?.webSearchKeyEnvs ?? {}));
    return names.filter((name): name is string => typeof name === "string" && name !== "");
  }

  setConfig(config: HarnessProviderConfig | undefined, web?: WebConfig): void {
    this.config = config;
    this.web = web;
  }

  get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.queue);
  }

  private publish(event: ProviderRuntimeEvent): void {
    Effect.runSync(Queue.offer(this.queue, event));
  }

  private attempt<T>(code: string, message: string, run: () => Promise<T> | T): Effect.Effect<T, CliError> {
    return Effect.tryPromise({ try: async () => await run(), catch: (cause) => toCliError(code, message, cause) });
  }

  private requireSession(threadId: ThreadId): HarnessSession {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      throw new CliError("HARNESS_NOT_STARTED", `No harness session exists for thread ${threadId}.`, { details: { threadId } });
    }
    return session;
  }

  private openTurn(session: HarnessSession): HarnessTurn | undefined {
    return [...session.turns.values()].find((turn) => turn.status === "running");
  }

  private describe(session: HarnessSession): ProviderSession {
    return { threadId: session.threadId, provider: "harness", workingDirectory: session.workingDirectory, startedAt: session.startedAt };
  }

  // -- session lifecycle -------------------------------------------------------

  readonly startSession = (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, CliError> =>
    this.attempt("HARNESS_START_FAILED", `Could not start a harness session for thread ${input.threadId}`, async () => {
      const existing = this.sessions.get(input.threadId);
      if (existing && !existing.closed) return this.describe(existing);
      const pending = this.starting.get(input.threadId);
      if (pending) return await pending;
      const started = this.openSession(input);
      this.starting.set(input.threadId, started);
      try {
        return await started;
      } finally {
        this.starting.delete(input.threadId);
      }
    });

  private async openSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const sessionId = input.resumeCursor && /^[A-Za-z0-9_-]+$/.test(input.resumeCursor) ? input.resumeCursor : `hs_${randomUUID()}`;
    const transcript = HarnessTranscript.open(HarnessTranscript.pathFor(this.sessionsDir, sessionId));
    const interactionMode = input.interactionMode ?? "default";
    const instructions = [input.instructions ?? ""].join("").trim();
    const artifactDir = path.join(this.sessionsDir, "artifacts", sessionId);
    const servers = input.mcpServers ?? [];
    const saved = loadSessionState(this.sessionsDir, sessionId);
    // Connected before the first request, so the tool list (and the prompt that mentions it) is whole from the start and stays that way.
    const mcp = await openMcpPool(servers, { cwd: input.workingDirectory, artifactDir, ...(input.disabledMcpTools ? { disabled: input.disabledMcpTools } : {}), ...(this.connectMcp ? { connect: this.connectMcp } : {}) });
    try {
      const session: HarnessSession = {
        threadId: input.threadId,
        sessionId,
        workingDirectory: input.workingDirectory,
        transcript,
        readState: new ReadState(),
        artifactDir,
        isolation: input.isolation ?? null,
        startedAt: new Date().toISOString(),
        instanceId: input.modelSelection?.instanceId ?? "harness",
        modelSlug: input.modelSelection?.model ?? null,
        modelOptions: input.modelSelection?.options,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode,
        instructions,
        interactive: input.delegated !== true,
        closed: false,
        turns: new Map(),
        lastUsage: null,
        parked: new Map(),
        allowed: new Set(saved.allowed),
        steering: [],
        todos: saved.todos,
        checklist: input.checklist !== false,
        compactFailures: 0,
        mcp,
        mcpSignature: fingerprint(servers),
        mcpNoticed: fingerprint(servers),
        skillTool: skillTool(discoverSkills({ cwd: input.workingDirectory, ...(this.home !== undefined ? { home: this.home } : {}) })),
        subagents: new Map(),
        background: new BackgroundShells({ artifactDir, onEvent: (event) => this.onBackgroundEvent(session, event) }),
        wakeTimer: null,
        wakeStreak: 0,
        modelNotes: [],
        notices: mcp.problems.length > 0 ? [{ title: mcp.problems.length === 1 ? "An MCP server or tool is unavailable" : `${mcp.problems.length} MCP problems`, detail: mcp.problems.join("\n") }] : [],
      };
      if (transcript.messages.length === 0) {
        transcript.append({ role: "system", content: this.systemPrompt(session) });
      } else {
        // A resumed session keeps the prompt it was built with (the server's cache is keyed on it);
        // what changed since is said in a reminder instead.
        const first = transcript.messages[0];
        const stored = first?.role === "system" ? first.content : "";
        const before = instructionsIn(stored) ?? "";
        if (before !== instructions) transcript.append({ role: "system", content: instructionsChangedReminder(instructions) });
        if (!stored.includes(MCP_SECTION_HEADING)) {
          const guidance = mcpSection({ tools: new Set(session.mcp.tools.map((tool) => tool.definition.name)), mcpServers: session.mcp.servers });
          if (guidance !== "") transcript.append({ role: "system", content: `This session now has tools from MCP servers. ${guidance}` });
        }
      }
      this.sessions.set(input.threadId, session);
      return this.describe(session);
    } catch (error) {
      await mcp.close();
      throw error;
    }
  }

  private systemPrompt(session: HarnessSession): string {
    const target = this.tryTarget(session);
    const names = [
      ...builtinTools().map((tool) => tool.definition.name),
      ...SESSION_TOOL_NAMES.filter((name) => name !== "todo" || session.checklist),
      ...(session.interactive ? ["ask"] : []),
      ...(session.skillTool ? ["skill"] : []),
      ...session.mcp.tools.map((tool) => tool.definition.name),
    ];
    return buildSystemPrompt({
      cwd: session.workingDirectory,
      tools: new Set(names),
      instructions: session.instructions,
      append: target?.profile.systemPromptAppend,
      mcpServers: session.mcp.servers,
      serverSlots: target ? target.profile.slots ?? this.config?.slots : undefined,
    });
  }

  /**
   * Called at each send with the servers configured now. A live session keeps
   * the tools it started with: changing them would rewrite the tool list the
   * server has cached for the whole conversation. So a difference is said
   * once, and applies to the next session.
   */
  readonly updateMcpServers = async (threadId: ThreadId, servers: readonly McpServerSpec[]): Promise<void> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return;
    const now = fingerprint(servers);
    if (now === session.mcpNoticed) return;
    session.mcpNoticed = now;
    if (now === session.mcpSignature) return;
    session.notices.push({ title: "MCP servers changed", detail: "This conversation keeps the MCP tools it started with, so the change takes effect in a new thread or after the app restarts." });
  };

  private tryTarget(session: HarnessSession): ReturnType<typeof resolveHarnessTarget> | null {
    if (session.modelSlug === null) return null;
    try {
      return resolveHarnessTarget(this.config, session.instanceId, session.modelSlug);
    } catch {
      return null;
    }
  }

  readonly resumeCursor = (threadId: ThreadId): string | null => this.sessions.get(threadId)?.sessionId ?? null;

  readonly hasSession = (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(this.sessions.get(threadId)?.closed === false);

  readonly listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.succeed([...this.sessions.values()].filter((session) => !session.closed).map((session) => this.describe(session)));

  readonly forkSession = async (cursor: string, _workingDirectory: string): Promise<string> => {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CliError("HARNESS_FORK_FAILED", "That is not a harness session id.");
    const source = HarnessTranscript.pathFor(this.sessionsDir, cursor);
    if (!fs.existsSync(source)) throw new CliError("HARNESS_FORK_FAILED", `No harness session ${cursor} to copy.`);
    const copy = `hs_${randomUUID()}`;
    HarnessTranscript.open(source).copyTo(HarnessTranscript.pathFor(this.sessionsDir, copy));
    copySessionState(this.sessionsDir, cursor, copy);
    return copy;
  };

  // -- turns -------------------------------------------------------------------

  readonly sendTurn = (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, CliError> =>
    this.attempt("HARNESS_TURN_FAILED", `Could not send a turn on thread ${input.threadId}`, async () => {
      const first = this.requireSession(input.threadId);
      // A key kept in the OS keychain is read once, here, before anything else: the rest of the call does not wait again.
      const wanted = input.modelSelection ?? (first.modelSlug !== null ? { instanceId: first.instanceId, model: first.modelSlug } : null);
      if (wanted) await primeProfileKey(resolveHarnessTarget(this.config, wanted.instanceId, wanted.model).profile).catch(() => undefined);
      const session = this.requireSession(input.threadId);
      if (this.openTurn(session)) {
        throw new CliError("TURN_BUSY", `Thread ${input.threadId} already has a running turn.`, { details: { threadId: input.threadId } });
      }
      if (input.modelSelection) {
        session.instanceId = input.modelSelection.instanceId;
        session.modelSlug = input.modelSelection.model;
        session.modelOptions = input.modelSelection.options;
      }
      if (input.runtimeMode) session.runtimeMode = input.runtimeMode;
      session.wakeStreak = 0;
      if (session.modelSlug === null) throw new CliError("HARNESS_NO_MODEL", "No model is selected for this harness thread.");
      const target = resolveHarnessTarget(this.config, session.instanceId, session.modelSlug);

      const turn = this.newTurn(session);
      for (const notice of session.notices.splice(0)) this.publish({ type: "session.notice", provider: "harness", threadId: session.threadId, turnId: turn.id, notice: "mcp", title: notice.title, detail: notice.detail });

      const manual = manualCompaction(input.prompt);
      if (manual) {
        void this.compactSession(session, turn, target, "manual", manual.focus)
          .then((report) => {
            for (const steer of session.steering.splice(0)) session.transcript.append({ role: "user", content: steer.text, ...(steer.images.length > 0 ? { images: steer.images } : {}) });
            const ok = report.status === "compacted";
            this.settle(session, turn, { status: ok ? "completed" : "failed", text: "", error: ok ? null : report.message, usage: null });
          })
          .catch((error: unknown) => this.settle(session, turn, { status: "failed", text: "", error: error instanceof Error ? error.message : String(error), usage: null }));
        return { threadId: input.threadId, turnId: turn.id };
      }

      if (input.interactionMode !== undefined) session.interactionMode = input.interactionMode;
      this.launchTurn(session, turn, target, { text: input.prompt, images: input.images });
      return { threadId: input.threadId, turnId: turn.id };
    });

  private newTurn(session: HarnessSession): HarnessTurn {
    const turn: HarnessTurn = {
      id: `turn-${randomUUID()}`,
      status: "running",
      text: "",
      error: null,
      usage: null,
      controller: new AbortController(),
      reasoningStarted: new Set(),
      subagentUsage: { input: 0, cacheRead: 0, output: 0, thinking: 0 },
      waiters: [],
    };
    session.turns.set(turn.id, turn);
    return turn;
  }

  /**
   * A background task ended while nobody was talking to the model: start a turn
   * of our own so it hears of it. The message is what the user would otherwise
   * have had to relay: the task, how it ended, the end of its output, and where
   * the rest is. Several endings close together make one turn. Moxen records it
   * like any turn (it sees `turn.started` with origin background). At most a few
   * in a row without the user: a model that keeps starting tasks to wait for
   * should not be able to run forever on its own.
   */
  private scheduleWake(session: HarnessSession): void {
    if (session.closed || session.wakeTimer !== null || session.modelNotes.length === 0) return;
    session.wakeTimer = setTimeout(() => {
      session.wakeTimer = null;
      this.wake(session);
    }, WAKE_DEBOUNCE_MS);
    session.wakeTimer.unref?.();
  }

  private wake(session: HarnessSession): void {
    // A running turn takes the notes itself, before its next request; a settled one calls this again.
    if (session.closed || this.openTurn(session) || session.wakeStreak >= MAX_WAKES_IN_A_ROW) return;
    const target = this.tryTarget(session);
    if (!target) return;
    const notes = session.modelNotes.splice(0).filter((note) => !session.background.endSeen(note.taskId));
    if (notes.length === 0) return;
    session.wakeStreak += 1;
    const turn = this.newTurn(session);
    this.publish({ type: "turn.started", provider: "harness", threadId: session.threadId, turnId: turn.id, origin: "background" });
    const text = `<system-reminder>\n${notes.map((note) => note.text).join("\n\n")}\n\nYou started these earlier; the user did not just write to you. Carry on with whatever they affect. If nothing needs doing, say briefly what finished and stop.\n</system-reminder>`;
    this.launchTurn(session, turn, target, { text });
  }

  /** Run the loop for a turn that exists, in the background of the call that made it: the settle comes through `settle`. */
  private launchTurn(session: HarnessSession, turn: HarnessTurn, target: ResolvedHarnessTarget, prompt: { readonly text: string; readonly images?: readonly ProviderImage[] | undefined }): void {
  const effort = session.modelOptions?.find((option) => option.id === "effort");

    const config: TurnConfig = {
      baseUrl: target.profile.baseUrl,
      apiKey: () => readProfileApiKey(target.profile, this.env),
      model: target.model.id,
      format: target.profile.apiFormat,
      quirks: target.quirks,
      sampling: target.profile.sampling,
      effort: typeof effort?.value === "string" ? effort.value : undefined,
      maxOutput: target.model.maxOutput,
      tools: () => this.toolsFor(session, turn),
      takeSteering: () => session.steering.splice(0),
      takeNotes: () => session.modelNotes.splice(0).filter((note) => !session.background.endSeen(note.taskId)).map((note) => note.text),
      toolContext: { cwd: session.workingDirectory, readState: session.readState, artifactDir: session.artifactDir, acceptsImages: target.quirks.images === "native", secretEnv: this.secretEnvNames(), background: session.background },
      authorize: (call, intent) => this.authorize(session, turn, call, intent),
      compaction: {
        threshold: loopCompactThreshold(target.model.contextWindow, resolveCompactionSettings(this.config, target.profile, target.model.id)),
        contextWindow: target.model.contextWindow ?? null,
        run: (reason) => this.compactSession(session, turn, target, reason),
      },
      transport: this.transportFor(target.profile),
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(target.profile.loopGuard ? { loopGuard: target.profile.loopGuard } : {}),
    };
    void runTurn(session.transcript, prompt, turn.id, config, (event) => this.onLoopEvent(session, turn, event), turn.controller.signal)
      .then(async (result) => {
        if (result.lastUsage) session.lastUsage = result.lastUsage;
        // Room is made while the turn is still open, so nothing else can start on the transcript meanwhile.
        if (result.status === "completed") await this.compactAfterTurn(session, turn, target);
        // Text sent after the model's last step was never read: keep it where the next turn will.
        for (const steer of session.steering.splice(0)) session.transcript.append({ role: "user", content: steer.text, ...(steer.images.length > 0 ? { images: steer.images } : {}) });
        this.settle(session, turn, { status: result.status, text: result.text, error: result.error, usage: { input: result.usage.input + turn.subagentUsage.input, cacheRead: result.usage.cacheRead + turn.subagentUsage.cacheRead, output: result.usage.output + turn.subagentUsage.output, thinking: result.usage.thinking + turn.subagentUsage.thinking, cacheCreate: 0 } });
      })
      .catch((error: unknown) => {
        this.settle(session, turn, { status: "failed", text: "", error: error instanceof Error ? error.message : String(error), usage: null });
      });
  }

  /** The tools the model may call right now. */
  private toolsFor(session: HarnessSession, turn: HarnessTurn | null): readonly HarnessTool<never>[] {
    return this.allTools(session, turn);
  }

  /** Every tool this session has, in the order the model is shown them; `turn` is null only when the definitions alone are wanted. */
  private allTools(session: HarnessSession, turn: HarnessTurn | null): readonly HarnessTool<never>[] {
    const extra: unknown[] = session.checklist ? [todoTool((items) => this.publishTodos(session, turn, items))] : [];
    if (session.interactive) extra.push(askTool((questions, signal) => this.askUser(session, turn, questions, signal)));
    if (session.skillTool) extra.push(session.skillTool);
    // Last, and in a fixed order: the part of the list that depends on configuration comes after the part that does not.
    const subagent = subagentTool((args, context) => (turn ? this.runSubagent(session, turn, args, context) : Promise.resolve({ content: "No turn is running.", isError: true })));
    const all = [...builtinTools(), subagent as unknown as HarnessTool<never>, ...this.webTools(), ...(extra as Array<HarnessTool<never>>), ...session.mcp.tools];
    return applyToolDescriptions(all, this.tryTarget(session)?.profile.toolDescriptions);
  }

  /** The web tools; they read the web settings on every call, so a change applies to the next one. */
  private webTools(): Array<HarnessTool<never>> {
    const settings = () => resolveWebSettings(this.config, this.env, this.web);
    return [webFetchTool(settings), webSearchTool(settings)] as unknown as Array<HarnessTool<never>>;
  }

  /**
   * Reading is always allowed. Changing files or running commands follows the
   * runtime mode: allowed outright, allowed because the user said "for this
   * session" to the same kind of call, or parked until the client answers.
   * A session nobody can answer refuses instead of waiting. A refusal is a
   * result the model reads, with the way forward in it.
   */
  private async authorize(session: HarnessSession, turn: HarnessTurn, call: ToolCall, intent: ToolIntent): Promise<Authorization> {
    if (session.isolation) {
      // A tool whose arguments we cannot read the meaning of (an MCP tool) is held to the weaker, wider check: any path in them, and any command.
      const reason = intent.mcp
        ? rawInputViolation(session.isolation, parseArguments(call.arguments), session.workingDirectory)
        : isolationViolation(session.isolation, { tool: ISOLATION_TOOL_NAMES[call.name] ?? call.name, input: parseArguments(call.arguments), cwd: session.workingDirectory });
      if (reason) return { allow: false, reason };
    }
    if (intent.action === "read") return { allow: true };
    const verdict = decidePermission({ mode: session.runtimeMode, intent, cwd: session.workingDirectory, interactive: session.interactive, shell: call.name === "powershell" ? "powershell" : "posix" });
    if (verdict.kind === "deny") return { allow: false, reason: verdict.reason };
    if (verdict.kind === "allow") return { allow: true };
    const key = sessionAllowKey(call.name, intent, session.workingDirectory);
    if (session.allowed.has(key)) return { allow: true };
    if (!session.interactive) {
      const what = intent.mcp ? `Calling ${call.name}` : intent.web ? "Reaching the web" : intent.action === "edit" ? "Changing files" : "Running commands";
      return { allow: false, reason: `${what} needs approval in the current permission mode (${session.runtimeMode}), and this task runs without anyone to ask. Say what you wanted to do and what is left undone.` };
    }
    const decision = await this.park(session, turn, call, intent, verdict.risk);
    if (decision === "interrupted") return { allow: false, reason: "[Interrupted before it ran.]" };
    switch (decision.kind) {
      case "acceptForSession":
        session.allowed.add(key);
        this.saveState(session);
        return { allow: true };
      case "accept":
        return { allow: true };
      case "cancel":
        turn.controller.abort();
        return { allow: false, reason: CANCELLED_MESSAGE };
      case "decline":
        return { allow: false, reason: declinedMessage(call.name) };
    }
  }

  /** Publish the approval prompt and wait for the answer (or the interrupt). */
  private park(session: HarnessSession, turn: HarnessTurn, call: ToolCall, intent: ToolIntent, risk?: { readonly level: string; readonly reason?: string }): Promise<ProviderApprovalDecision | "interrupted"> {
    const requestId = randomUUID();
    const args = parseArguments(call.arguments);
    const description = typeof args.description === "string" ? args.description : undefined;
    const input = intent.mcp ? args : intent.web ? { command: intent.command ?? "" } : intent.action === "exec" ? { command: intent.command ?? "", ...(description ? { description } : {}) } : { file_path: intent.paths[0] ?? "" };
    const base = { provider: "harness" as const, threadId: session.threadId, requestId };
    // An MCP tool has no classification of its own: the prompt then names the tool and shows what it was called with.
    this.publish({ ...base, type: "permission.request.opened", raw: { toolName: call.name, ...(intent.mcp ? {} : { classification: classificationOf(intent) }), input, ...(risk && risk.level !== "safe" ? { risk: { level: risk.level, reason: risk.reason ?? "" } } : {}) } });
    return new Promise((resolve) => {
      const settle = (decision: ProviderApprovalDecision | "interrupted"): void => {
        if (!session.parked.delete(requestId)) return;
        turn.controller.signal.removeEventListener("abort", onAbort);
        const allowed = decision !== "interrupted" && (decision.kind === "accept" || decision.kind === "acceptForSession");
        this.publish({ ...base, type: "permission.request.resolved", raw: { toolName: call.name, behavior: allowed ? "allow" : "deny" } });
        resolve(decision);
      };
      const onAbort = (): void => settle("interrupted");
      session.parked.set(requestId, { kind: "permission", resolve: settle });
      turn.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (turn.controller.signal.aborted) onAbort();
    });
  }

  /** Publish the model's questions in the shape the answer panel reads and wait for the answers (or the interrupt). */
  private askUser(session: HarnessSession, turn: HarnessTurn | null, questions: readonly AskQuestion[], signal: AbortSignal): Promise<AskReply> {
    const requestId = randomUUID();
    const base = { provider: "harness" as const, threadId: session.threadId, requestId };
    this.publish({ ...base, type: "user-input.request.opened", raw: { toolName: "ask", input: { questions } } });
    return new Promise((resolve) => {
      const settle = (reply: AskReply | "cancelled"): void => {
        if (!session.parked.delete(requestId)) return;
        signal.removeEventListener("abort", onAbort);
        this.publish({ ...base, type: "user-input.request.resolved", raw: { toolName: "ask", behavior: reply !== "cancelled" && reply.kind === "answered" ? "allow" : "deny" } });
        if (reply === "cancelled") turn?.controller.abort();
        resolve(reply === "cancelled" ? { kind: "dismissed" } : reply);
      };
      const onAbort = (): void => settle({ kind: "dismissed" });
      session.parked.set(requestId, { kind: "input", resolve: settle });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  /** One limiter per profile: the requests its server is asked to take at once (`slots`, else the Moxen Harness default, else no limit). */
  private readonly limiters = new Map<string, RequestLimiter>();

  private limiterFor(profile: HarnessProfileConfig): RequestLimiter {
    let limiter = this.limiters.get(profile.id);
    if (!limiter) {
      limiter = new RequestLimiter();
      this.limiters.set(profile.id, limiter);
    }
    limiter.setCapacity(profile.slots ?? this.config?.slots ?? Number.POSITIVE_INFINITY);
    return limiter;
  }

  /** The model transport, queued behind the profile's slots so the main turn, its subagents, a summary and a title share a server politely. */
  private transportFor(profile: HarnessProfileConfig): NonNullable<TurnConfig["transport"]> {
    const base = this.transport ?? streamModel;
    const limiter = this.limiterFor(profile);
    return async function* limited(request) {
      const release = await limiter.acquire(request.signal);
      try {
        yield* base(request);
      } finally {
        release();
      }
    };
  }

  /** Keep the checklist and the session's approvals beside the transcript. */
  private saveState(session: HarnessSession): void {
    saveSessionState(this.sessionsDir, session.sessionId, { todos: session.todos, allowed: [...session.allowed] });
  }

  private publishTodos(session: HarnessSession, turn: HarnessTurn | null, items: readonly TodoItem[]): void {
    session.todos = items;
    this.saveState(session);
    // The statuses are spelled the way the Claude driver spells them, which is what the tasks panel reads.
    const status = { pending: "pending", in_progress: "inProgress", completed: "completed" } as const;
    this.publish({
      provider: "harness",
      threadId: session.threadId,
      turnId: turn?.id ?? null,
      type: "turn.plan.updated",
      raw: { plan: items.map((item) => ({ step: item.content, status: status[item.status] })) },
    });
  }

  private onLoopEvent(session: HarnessSession, turn: HarnessTurn, event: LoopEvent): void {
    const base = { provider: "harness" as const, threadId: session.threadId, turnId: turn.id };
    switch (event.type) {
      case "text":
        this.publish({ ...base, type: "message.part.updated", messageId: event.messageId, text: event.text });
        break;
      case "note":
        this.publish({ ...base, type: "assistant.note", messageId: event.messageId, text: event.text });
        break;
      case "reasoning.delta":
        if (!turn.reasoningStarted.has(event.reasoningId)) {
          turn.reasoningStarted.add(event.reasoningId);
          this.publish({ ...base, type: "reasoning.updated", reasoningId: event.reasoningId, status: "running", text: "", startedAt: new Date().toISOString(), durationMs: null });
        }
        this.publish({ ...base, type: "reasoning.delta", reasoningId: event.reasoningId, text: event.text });
        break;
      case "reasoning.done":
        this.publish({ ...base, type: "reasoning.updated", reasoningId: event.reasoningId, status: "completed", text: event.text, startedAt: event.startedAt, durationMs: event.durationMs });
        break;
      case "tool.started":
        if (SILENT_TOOLS.has(event.call.name)) break;
        this.publish({ ...base, type: "tool.execute.started", tool: event.call.name, raw: { toolUseId: event.call.id, input: event.args } });
        break;
      case "tool.completed":
        if (SILENT_TOOLS.has(event.call.name)) break;
        this.publish({ ...base, type: "tool.execute.completed", tool: event.call.name, raw: toolRaw(event.call, event.args, event.result) });
        break;
      case "usage":
        session.lastUsage = event.usage;
        this.publish({
          provider: "harness",
          threadId: session.threadId,
          type: "token-usage.updated",
          usage: {
            input: Math.max(0, event.usage.inputTokens - event.usage.cachedInputTokens),
            cacheRead: event.usage.cachedInputTokens,
            cacheCreate: 0,
            output: event.usage.outputTokens,
            thinking: event.usage.reasoningTokens,
          },
        });
        break;
      case "retry":
      case "steered":
        break;
    }
  }

  private settle(session: HarnessSession, turn: HarnessTurn, outcome: HarnessTurnOutcome): void {
    if (turn.status !== "running") return;
    turn.status = outcome.status;
    turn.text = outcome.text;
    turn.error = outcome.error;
    turn.usage = outcome.usage;
    this.publish({
      provider: "harness",
      threadId: session.threadId,
      turnId: turn.id,
      type: outcome.status === "completed" ? "turn.completed" : outcome.status === "failed" ? "turn.failed" : "turn.interrupted",
      ...(outcome.error ? { raw: { error: outcome.error } } : {}),
    });
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(outcome);
    // Something may have ended after the model's last request: tell it now rather than at its next turn.
    this.scheduleWake(session);
  }

  async awaitTurn(threadId: ThreadId, turnId: TurnId, signal?: AbortSignal): Promise<HarnessTurnOutcome> {
    const session = this.requireSession(threadId);
    const turn = session.turns.get(turnId);
    if (!turn) throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turnId}.`, { details: { threadId, turnId } });
    if (turn.status !== "running") return { status: turn.status, text: turn.text, usage: turn.usage, error: turn.error };
    if (signal?.aborted === true) throw new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, { details: { threadId, turnId } });
    return await new Promise<HarnessTurnOutcome>((resolve, reject) => {
      const waiter = { resolve, reject };
      turn.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const at = turn.waiters.indexOf(waiter);
          if (at >= 0) turn.waiters.splice(at, 1);
          reject(new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, { details: { threadId, turnId } }));
        },
        { once: true },
      );
    });
  }

  readonly interruptTurn = (threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, CliError> =>
    this.attempt("HARNESS_TURN_FAILED", `Could not interrupt the turn on thread ${threadId}`, () => {
      const session = this.requireSession(threadId);
      // The loop notices the abort, gives every pending tool call a result and reports "interrupted", which settles the turn.
      this.openTurn(session)?.controller.abort();
    });

  // -- subagents -------------------------------------------------------------------

  /**
   * Run a subagent: a second agent over its own saved conversation, on the
   * session's model, with the parent's tools (MCP tools included) minus the few
   * that make no sense below it (asking the user, planning, the parent's to-do
   * list, more subagents, Moxen's delegation tools). What it wants to do is
   * authorized exactly as the parent's calls are: same mode, same session
   * approvals, same isolation, and an approval prompt reaches the user the
   * same way. It may compact its own conversation, runs as long as it needs,
   * queues behind the model server's slots, and several in one reply run side
   * by side. Run in the background it outlives the turn: the model carries on,
   * and is told (and the thread woken) when it ends. Its report comes back as
   * untrusted data.
   */
  private async runSubagent(session: HarnessSession, turn: HarnessTurn, args: SubagentArgs, context: ToolContext): Promise<ToolResult> {
    const target = this.tryTarget(session);
    if (!target) return { content: "No model is selected, so a subagent cannot run.", isError: true };
    const kind = (args.kind ?? "").trim() || "general";
    const agentId = `sa_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const background = args.run_in_background === true;
    const controller = new AbortController();
    // In the foreground the turn's interrupt stops it too; in the background nothing but task_stop or the session ending does.
    const signal = background ? controller.signal : AbortSignal.any([context.signal, controller.signal]);
    const owner: HarnessTurn = background ? { ...turn, controller } : turn;
    session.subagents.set(agentId, controller);
    const transcript = HarnessTranscript.open(this.subagentFile(session.sessionId, agentId));
    const tools = (): readonly HarnessTool<never>[] => subagentTools(this.toolsFor(session, owner));
    transcript.append({
      role: "system",
      content: buildSystemPrompt({
        cwd: session.workingDirectory,
        tools: new Set(tools().map((tool) => tool.definition.name)),
        instructions: session.instructions,
        append: subagentRole(kind),
        mcpServers: session.mcp.servers.filter((server) => server.name !== "moxen"),
      }),
    });
    const base = { provider: "harness" as const, threadId: session.threadId, turnId: turn.id, agentId, agentType: kind };
    this.publish({ ...base, type: "subagent.updated", status: "started", lastMessage: null, description: args.description });

    let handle: ReturnType<BackgroundShells["startExternal"]> | null = null;
    if (background) {
      try {
        handle = session.background.startExternal({ id: agentId, tool: "subagent", description: args.description, toolUseId: context.callId ?? null, stop: () => controller.abort() });
      } catch (error) {
        session.subagents.delete(agentId);
        this.publish({ ...base, type: "subagent.updated", status: "stopped", lastMessage: null });
        return { content: (error as Error).message, isError: true };
      }
    }

    const unit: CompactionUnit = { transcript, readState: new ReadState(), interactionMode: "default", todos: [], compactFailures: 0, lastUsage: null, definitions: () => tools().map((tool) => tool.definition) };
    const config: TurnConfig = {
      baseUrl: target.profile.baseUrl,
      apiKey: () => readProfileApiKey(target.profile, this.env),
      model: target.model.id,
      format: target.profile.apiFormat,
      quirks: target.quirks,
      sampling: target.profile.sampling,
      effort: this.sessionEffort(session),
      maxOutput: target.model.maxOutput,
      tools,
      // Its own read state: an edit is checked against what this agent read, and the parent has to read again what the agent changed.
      toolContext: { cwd: session.workingDirectory, readState: unit.readState, artifactDir: session.artifactDir, acceptsImages: target.quirks.images === "native", secretEnv: this.secretEnvNames(), background: session.background },
      authorize: (call, intent) => this.authorize(session, owner, call, intent),
      compaction: {
        threshold: loopCompactThreshold(target.model.contextWindow, resolveCompactionSettings(this.config, target.profile, target.model.id)),
        contextWindow: target.model.contextWindow ?? null,
        run: (reason) => this.compactUnit(unit, session, owner, target, reason, signal, undefined, "Subagent: "),
      },
      transport: this.transportFor(target.profile),
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(target.profile.loopGuard ? { loopGuard: target.profile.loopGuard } : {}),
    };

    const work = async (): Promise<{ readonly status: "completed" | "failed" | "interrupted"; readonly report: string; readonly error: string | null }> => {
      const result = await runTurn(
        transcript,
        { text: args.prompt },
        `${turn.id}-${agentId}`,
        config,
        (event) => {
          if (event.type === "tool.started") handle?.append(`[${event.call.name}] ${summarizeArguments(event.call.arguments)}\n`);
          if (event.type === "usage") {
            unit.lastUsage = event.usage;
            const usage = { input: Math.max(0, event.usage.inputTokens - event.usage.cachedInputTokens), cacheRead: event.usage.cachedInputTokens, cacheCreate: 0, output: event.usage.outputTokens, thinking: event.usage.reasoningTokens };
            turn.subagentUsage.input += usage.input;
            turn.subagentUsage.cacheRead += usage.cacheRead;
            turn.subagentUsage.output += usage.output;
            turn.subagentUsage.thinking += usage.thinking;
            this.publish({ provider: "harness", threadId: session.threadId, type: "token-usage.updated", usage });
          }
        },
        signal,
      );
      return { status: result.status, report: result.text.trim(), error: result.error };
    };
    const describe = (outcome: { status: string; report: string; error: string | null }): ToolResult => {
      if (outcome.status === "interrupted") return { content: "[The subagent was interrupted.]", isError: true };
      if (outcome.status === "failed") {
        return { content: `The subagent stopped before finishing: ${outcome.error ?? "unknown reason"}${outcome.report ? `\n\nWhat it had said:\n${untrustedContext(outcome.report, "subagent")}` : ""}`, isError: true };
      }
      return { content: outcome.report === "" ? "The subagent finished without writing a report." : untrustedContext(outcome.report, "subagent"), ...(outcome.report === "" ? { isError: true } : {}) };
    };
    const stopped = (report: string): void => {
      session.subagents.delete(agentId);
      this.publish({ ...base, type: "subagent.updated", status: "stopped", lastMessage: report === "" ? null : report.slice(0, 2000) });
    };

    if (handle !== null) {
      const running = handle;
      void work()
        .then((outcome) => {
          running.append(`\n${outcome.status === "completed" ? "Report" : `Stopped (${outcome.status}${outcome.error ? `: ${outcome.error}` : ""})`}:\n${outcome.report === "" ? "(no report)" : outcome.report}\n`);
          stopped(outcome.report);
          running.end(outcome.status === "completed" ? "completed" : outcome.status === "interrupted" ? "stopped" : "failed");
        })
        .catch((error: unknown) => {
          running.append(`\nThe subagent failed: ${error instanceof Error ? error.message : String(error)}\n`);
          stopped("");
          running.end("failed");
        });
      return { content: `Started subagent ${agentId} (${args.description}) in the background. Its progress and report are written to ${handle.task.logFile}; read them with task_output (wait_ms waits for news) and stop it with task_stop. You will be told when it finishes.` };
    }

    let report = "";
    try {
      const outcome = await work();
      report = outcome.report;
      return describe(outcome);
    } finally {
      stopped(report);
    }
  }

  private subagentFile(sessionId: string, agentId: string): string {
    return path.join(this.sessionsDir, "subagents", sessionId, `${agentId}.jsonl`);
  }

  /** A subagent's saved conversation. `cursor` is the thread's session when the driver holds none (after a restart). */
  readonly subagentHistory = async (threadId: ThreadId, agentId: string, cursor?: string | null): Promise<readonly SubagentHistoryItem[] | null> => {
    const sessionId = this.sessions.get(threadId)?.sessionId ?? cursor ?? null;
    if (sessionId === null || !/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^sa_[a-f0-9]+$/.test(agentId)) return null;
    const file = this.subagentFile(sessionId, agentId);
    if (!fs.existsSync(file)) return null;
    return subagentHistory(HarnessTranscript.open(file).messages, agentId);
  };

  // -- background commands -------------------------------------------------------

  private backgroundSummary(task: BackgroundTask): BackgroundTaskSummary {
    return { taskId: task.id, taskType: "local_bash", description: task.description, toolName: task.tool, command: task.command, startedAt: task.startedAt };
  }

  private onBackgroundEvent(session: HarnessSession, event: BackgroundEvent): void {
    const { task } = event;
    const base = { provider: "harness" as const, threadId: session.threadId };
    const ended = event.type === "ended";
    if (ended) {
      session.modelNotes.push({ taskId: task.id, text: this.backgroundNote(session, task) });
      this.scheduleWake(session);
    }
    this.publish({
      ...base,
      type: "background.task",
      turnId: this.openTurn(session)?.id ?? null,
      taskId: task.id,
      status: event.type === "started" ? "started" : task.status === "running" ? "stopped" : task.status,
      description: task.description,
      taskType: task.tool === "subagent" ? "local_agent" : "local_bash",
      toolUseId: task.toolUseId,
      summary: ended ? (task.exitCode === null ? null : `exit code ${task.exitCode}`) : null,
    });
    this.publish({ ...base, type: "background.tasks.changed", tasks: session.background.running().map((running) => this.backgroundSummary(running)) });
  }

  /** What the model is told when a background task ends: how, the end of its output, and where the rest is. */
  private backgroundNote(session: HarnessSession, task: BackgroundTask): string {
    const agent = task.tool === "subagent";
    const how = task.status === "completed" ? (agent ? "finished" : "finished (exit code 0)") : task.status === "stopped" ? "was stopped" : task.exitCode === null ? "failed" : `finished with exit code ${task.exitCode}`;
    const tail = (session.background.tail(task.id, agent ? 120 : 40) ?? []).join("\n");
    const shown = tail.length > NOTE_OUTPUT_CHARS ? `[…]\n${tail.slice(tail.length - NOTE_OUTPUT_CHARS)}` : tail;
    const body = shown.trim() === "" ? "It printed nothing." : `${agent ? "Its progress and report" : `The last lines it printed`}:\n${agent ? untrustedContext(shown, "subagent") : shown}`;
    return `Background ${agent ? "subagent" : "command"} ${task.id} (${task.description}) ${how}.\n${body}\nThe whole log is at ${task.logFile}: read it in pieces with read (offset and limit), or with task_output.`;
  }

  /** The commands the thread's session is running in the background. */
  readonly backgroundTasks = (threadId: ThreadId): readonly BackgroundTaskSummary[] => {
    const session = this.sessions.get(threadId);
    return session && !session.closed ? session.background.running().map((task) => this.backgroundSummary(task)) : [];
  };

  readonly stopBackgroundTask = (threadId: ThreadId, taskId: string): Effect.Effect<void, CliError> =>
    this.attempt("HARNESS_TASK_STOP_FAILED", `Could not stop background task ${taskId}`, async () => {
      const session = this.requireSession(threadId);
      // A foreground subagent is no background task; its own switch ends it, and its row settles when it unwinds.
      const subagent = session.subagents.get(taskId);
      if (subagent && !(await session.background.stop(taskId))) {
        subagent.abort();
        return;
      }
      if (subagent) return;
      if (!(await session.background.stop(taskId))) {
        throw new CliError("BACKGROUND_TASK_NOT_FOUND", `No background task ${taskId} is running on thread ${threadId}.`, { exitCode: 3, details: { threadId, taskId } });
      }
    });

  /** The end of a background command's log, running or finished. */
  readonly backgroundTaskOutput = async (threadId: ThreadId, taskId: string): Promise<{ readonly lines: readonly string[] } | null> => {
    const session = this.sessions.get(threadId);
    const lines = session && !session.closed ? session.background.tail(taskId, 500) : null;
    return lines === null ? null : { lines };
  };

  // -- side requests: /btw and titles ------------------------------------------------

  private liveSessionByCursor(cursor: string | null): HarnessSession | undefined {
    if (cursor === null) return undefined;
    return [...this.sessions.values()].find((session) => !session.closed && session.sessionId === cursor);
  }

  /**
   * One request over a copy of a conversation and an instruction, with the
   * session's tool list and no tool calls allowed (the same trick compaction
   * uses to keep the server's cache), answered in text. Nothing is written to
   * the transcript, and it can run beside a turn.
   */
  private async askAside(target: ResolvedHarnessTarget, session: HarnessSession | undefined, messages: readonly TranscriptMessage[], instruction: string, options: { readonly maxTokens?: number | undefined; readonly effort?: string | undefined; readonly signal?: AbortSignal | undefined }): Promise<string> {
    const definitions = session ? this.toolsFor(session, null).map((tool) => tool.definition) : [];
    const request: ChatRequest = {
      baseUrl: target.profile.baseUrl,
      apiKey: readProfileApiKey(target.profile, this.env),
      model: target.model.id,
      ...conversationFields(target.profile.apiFormat, [...settledPrefix(messages), { role: "user", content: instruction }], target.quirks),
      tools: definitions,
      ...(definitions.length > 0 ? { toolChoice: "none" as const } : {}),
      quirks: target.quirks,
      sampling: target.profile.sampling,
      maxTokens: options.maxTokens ?? target.model.maxOutput,
      effort: options.effort,
      signal: options.signal,
    };
    let text = "";
    for await (const event of this.transportFor(target.profile)(request)) {
      if (event.type === "text.delta") text += event.text;
    }
    return text.trim();
  }

  private sessionEffort(session: HarnessSession | undefined): string | undefined {
    const effort = session?.modelOptions?.find((option) => option.id === "effort");
    return typeof effort?.value === "string" ? effort.value : undefined;
  }

  /** `/btw`: the thread's model answers on a copy of its conversation, with no tools; the thread itself never sees the question. */
  readonly sideQuestion = async (input: SideQuestionInput): Promise<SideAnswer> => {
    const question = input.question.trim();
    const session = this.liveSessionByCursor(input.cursor);
    let history: readonly TranscriptMessage[] = session?.transcript.messages ?? [];
    if (!session && input.cursor !== null && /^[A-Za-z0-9_-]+$/.test(input.cursor)) {
      history = HarnessTranscript.open(HarnessTranscript.pathFor(this.sessionsDir, input.cursor)).messages;
    }
    let target: ResolvedHarnessTarget;
    try {
      if (session) {
        target = resolveHarnessTarget(this.config, session.instanceId, input.model ?? session.modelSlug ?? "");
      } else {
        // Without the live session there is no instance id, only the model; it has to name one profile.
        const profiles = (this.config?.profiles ?? []).filter((profile) => input.model !== undefined && profile.models.some((model) => model.id === input.model));
        if (profiles.length !== 1 || input.model === undefined) {
          throw new CliError("SIDE_QUESTION_NO_PROFILE", "Open the thread first: /btw needs to know which harness profile this thread's model belongs to.");
        }
        target = resolveHarnessTarget(this.config, `harness/${profiles[0]!.id}`, input.model);
      }
    } catch (error) {
      throw toCliError("SIDE_QUESTION_FAILED", "Could not answer the side question", error);
    }
    await primeProfileKey(target.profile).catch(() => undefined);
    // A server with one slot cannot answer a side question while the turn is using it; with more, the question queues behind the slots.
    if (session && this.openTurn(session) && this.limiterFor(target.profile).capacity === 1) {
      throw new CliError("SIDE_QUESTION_BUSY", "This model server takes one request at a time and a turn is running on it, so /btw has to wait. Ask again when the turn finishes.");
    }
    const withContext = history.some((message) => message.role === "user");
    const messages: readonly TranscriptMessage[] = withContext ? history : [{ role: "system", content: SIDE_QUESTION_NO_CONTEXT }];
    const instruction = withContext ? `${SIDE_QUESTION_INSTRUCTION}\n\nQuestion: ${question}` : question;
    let text: string;
    try {
      text = await this.askAside(target, session, messages, instruction, { effort: this.sessionEffort(session), signal: input.signal });
    } catch (error) {
      throw toCliError("SIDE_QUESTION_FAILED", "Could not answer the side question", error);
    }
    if (text === "") throw new CliError("SIDE_QUESTION_EMPTY", "The model sent no answer to the side question.");
    return { text, withContext };
  };

  private titleFile(sessionId: string): string {
    return path.join(this.sessionsDir, "titles", `${sessionId}.txt`);
  }

  private readStoredTitle(sessionId: string): string | null {
    try {
      return cleanTitle(fs.readFileSync(this.titleFile(sessionId), "utf8"));
    } catch {
      return null;
    }
  }

  /** The title kept for a session, made on first ask once the model has answered. Null while there is none to give. */
  readonly sessionTitle = async (cursor: string, _workingDirectory: string): Promise<string | null> => {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    const stored = this.readStoredTitle(cursor);
    if (stored !== null) return stored;
    if ((this.titleFailures.get(cursor) ?? 0) >= 2) return null;
    return await this.makeTitle(cursor);
  };

  /** A new title from the conversation as it stands, replacing the kept one. */
  readonly regenerateSessionTitle = async (cursor: string, _workingDirectory: string): Promise<string | null> => {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    this.titleFailures.delete(cursor);
    return await this.makeTitle(cursor);
  };

  private makeTitle(sessionId: string): Promise<string | null> {
    const running = this.titling.get(sessionId);
    if (running) return running;
    const work = this.writeTitle(sessionId)
      .then((title) => {
        if (title === null) this.titleFailures.set(sessionId, (this.titleFailures.get(sessionId) ?? 0) + 1);
        return title;
      })
      .finally(() => this.titling.delete(sessionId));
    this.titling.set(sessionId, work);
    return work;
  }

  private async writeTitle(sessionId: string): Promise<string | null> {
    // Only a live session knows which profile and model to ask; one that has not been answered yet has nothing to title.
    const session = this.liveSessionByCursor(sessionId);
    if (!session || !session.transcript.messages.some((message) => message.role === "assistant")) return null;
    const target = this.tryTarget(session);
    if (!target || target.profile.titles === false) return null;
    await primeProfileKey(target.profile).catch(() => undefined);
    try {
      const reply = await this.askAside(target, session, session.transcript.messages, TITLE_INSTRUCTION, {
        maxTokens: Math.min(target.model.maxOutput ?? 4096, 4096),
        effort: resolveCompactionSettings(this.config, target.profile, target.model.id).effort,
      });
      const title = cleanTitle(reply);
      if (title === null) return null;
      fs.mkdirSync(path.dirname(this.titleFile(sessionId)), { recursive: true });
      fs.writeFileSync(this.titleFile(sessionId), `${title}\n`, "utf8");
      return title;
    } catch {
      // A title is a nicety: the endpoint being busy or down costs the title, not the turn.
      return null;
    }
  }

  // -- compaction -----------------------------------------------------------------

  /** Says a compaction happened (or why an automatic one stopped) in the thread. */
  private publishNotice(session: HarnessSession, turn: HarnessTurn, notice: "compacted" | "compaction-stopped", title: string, detail: string | null): void {
    this.publish({ type: "session.notice", provider: "harness", threadId: session.threadId, turnId: turn.id, notice, title, detail });
  }

  /**
   * Make room in the session's conversation, whoever asked: clear old tool
   * output if that is enough, otherwise summarise (and trim when the summary
   * cannot be had), then tell the session and the thread. Applies the result to
   * the transcript only once it is whole, and leaves the transcript alone on
   * any failure.
   */
  private compactSession(session: HarnessSession, turn: HarnessTurn, target: ResolvedHarnessTarget, reason: CompactReason, focus?: string): Promise<CompactionReport> {
    const driver = this;
    // The session itself, seen as the thing being compacted; its fields stay where they are.
    const unit: CompactionUnit = {
      get transcript() {
        return session.transcript;
      },
      get readState() {
        return session.readState;
      },
      get interactionMode() {
        return session.interactionMode;
      },
      get todos() {
        return session.todos;
      },
      get compactFailures() {
        return session.compactFailures;
      },
      set compactFailures(value: number) {
        session.compactFailures = value;
      },
      get lastUsage() {
        return session.lastUsage;
      },
      set lastUsage(value: ModelUsage | null) {
        session.lastUsage = value;
      },
      definitions: () => driver.toolsFor(session, turn).map((tool) => tool.definition),
    };
    return this.compactUnit(unit, session, turn, target, reason, turn.controller.signal, focus);
  }

  /** The same work for a subagent's own conversation as for the thread's. `label` starts the notice's title. */
  private async compactUnit(unit: CompactionUnit, session: HarnessSession, turn: HarnessTurn, target: ResolvedHarnessTarget, reason: CompactReason, signal: AbortSignal, focus?: string, label = ""): Promise<CompactionReport> {
    const settings = resolveCompactionSettings(this.config, target.profile, target.model.id);
    const window = target.model.contextWindow ?? null;
    const threshold = autoCompactThreshold(window, settings);
    const transcript = unit.transcript;
    const definitions = unit.definitions();
    const overheadTokens = estimateTokens(JSON.stringify(definitions));
    // The server's count of the last prompt says how far our character estimates are off; use that to read ours.
    const estimated = messagesTokens(transcript.messages) + overheadTokens;
    const scale = unit.lastUsage ? Math.min(3, Math.max(0.5, (unit.lastUsage.inputTokens + unit.lastUsage.outputTokens) / Math.max(1, estimated))) : 1;
    const transport = this.transportFor(target.profile);

    // The same conversation and the same tool definitions, so the server's cache applies; the model is told not to call any.
    const summarise: Summarise = async (messages) => {
      const request: ChatRequest = {
        baseUrl: target.profile.baseUrl,
        apiKey: readProfileApiKey(target.profile, this.env),
        model: target.model.id,
        ...conversationFields(target.profile.apiFormat, messages, target.quirks),
        tools: definitions,
        toolChoice: "none",
        quirks: target.quirks,
        sampling: target.profile.sampling,
        maxTokens: target.model.maxOutput,
        effort: settings.effort,
        signal,
      };
      let text = "";
      let finish = "stop";
      for await (const event of transport(request)) {
        if (event.type === "text.delta") text += event.text;
        else if (event.type === "finish") finish = event.reason;
      }
      return { text, finish };
    };

    const auto = reason !== "manual";
    const outcome = await compact({
      messages: transcript.messages,
      n: transcript.compactions + 1,
      reason,
      keepRecentTokens: settings.keepRecentTokens,
      focus,
      contextWindow: window,
      threshold,
      overheadTokens,
      scale,
      todos: unit.todos.length > 0 ? unit.todos.map((item) => `- [${item.status === "completed" ? "x" : item.status === "in_progress" ? "~" : " "}] ${item.content}`).join("\n") : null,
      // A manual compaction always tries; automatic ones stop asking a summariser that keeps failing.
      trimOnly: auto && unit.compactFailures >= MAX_CONSECUTIVE_FAILURES,
      summarise,
      signal,
    }).catch((error: unknown) => ({ kind: "failed" as const, message: error instanceof Error ? error.message : String(error) }));
    if (signal.aborted) return { status: "failed", message: "Interrupted." };

    // What the model remembers reading, and what the server last counted, no longer describe the transcript.
    const applied = (): void => {
      unit.lastUsage = null;
      unit.readState.clear();
    };
    switch (outcome.kind) {
      case "nothing":
        return { status: "nothing", message: outcome.message };
      case "failed":
        unit.compactFailures += 1;
        return { status: "failed", message: `Could not compact the conversation: ${outcome.message}` };
      case "compacted": {
        // The dropped history is written first: a crash between the two steps loses nothing.
        transcript.archive(transcript.compactions + 1, outcome.dropped);
        transcript.replace(outcome.messages);
        applied();
        const trimmed = outcome.method === "trimmed";
        unit.compactFailures = !trimmed && (outcome.madeProgress || !auto) ? 0 : unit.compactFailures + 1;
        const title = `${label}${trimmed ? "Conversation trimmed (no summary)" : auto ? "Conversation compacted automatically" : "Conversation compacted"}`;
        this.publishNotice(session, turn, "compacted", title, trimmed ? `A summary could not be made (${outcome.failure}), so older history was cut down to the user's messages and the recent turns.` : outcome.summary);
        if (!outcome.madeProgress && auto) {
          return {
            status: "stalled",
            message: `Compacting left the conversation at about ${outcome.afterTokens} of the model's ${window ?? "unknown"} tokens, which is too little room to carry on. Stopped instead of compacting again and again: run /compact, roll back some turns, or start a new thread.`,
          };
        }
        return { status: "compacted", message: "" };
      }
    }
  }

  /**
   * After a turn: if the conversation has grown past the threshold, make room now rather than at the start of the next one.
   * On "ask" that is the server's to offer (`planLongThreadAction`), so only the hard line is acted on here.
   */
  private async compactAfterTurn(session: HarnessSession, turn: HarnessTurn, target: ResolvedHarnessTarget): Promise<void> {
    const threshold = loopCompactThreshold(target.model.contextWindow, resolveCompactionSettings(this.config, target.profile, target.model.id));
    if (threshold === null || session.closed || turn.controller.signal.aborted) return;
    const used = session.lastUsage ? session.lastUsage.inputTokens + session.lastUsage.outputTokens : messagesTokens(session.transcript.messages);
    if (used < threshold) return;
    const report = await this.compactSession(session, turn, target, "threshold");
    if (report.status === "stalled" || report.status === "failed") {
      this.publishNotice(session, turn, "compaction-stopped", `Automatic compaction stopped: ${report.message}`, null);
    }
  }

  // -- requests the running turn waits on ---------------------------------------

  readonly respondToRequest = (threadId: ThreadId, requestId: ApprovalRequestId, decision: ProviderApprovalDecision): Effect.Effect<void, CliError> =>
    this.attempt("HARNESS_REQUEST_FAILED", `Could not answer permission request ${requestId}`, () => {
      const parked = this.requireSession(threadId).parked.get(requestId);
      if (!parked) throw new CliError("REQUEST_UNKNOWN", `No pending permission request ${requestId}.`, { details: { threadId, requestId } });
      if (parked.kind === "permission") return parked.resolve(decision);
      // The panel closes a question the way it declines a permission; accepting one is a miscall, since there is no answer to accept.
      if (decision.kind === "accept" || decision.kind === "acceptForSession") {
        throw new CliError("REQUEST_MISMATCH", `Request ${requestId} needs user input, not a permission decision.`, { details: { threadId, requestId } });
      }
      parked.resolve(decision.kind === "cancel" ? "cancelled" : { kind: "dismissed" });
    });

  readonly respondToUserInput = (threadId: ThreadId, requestId: ApprovalRequestId, answers: ProviderUserInputAnswers): Effect.Effect<void, CliError> =>
    this.attempt("HARNESS_REQUEST_FAILED", `Could not answer user input request ${requestId}`, () => {
      const parked = this.requireSession(threadId).parked.get(requestId);
      if (!parked) throw new CliError("REQUEST_UNKNOWN", `No pending user input request ${requestId}.`, { details: { threadId, requestId } });
      if (parked.kind !== "input") {
        throw new CliError("REQUEST_MISMATCH", `Request ${requestId} is a permission request, not a question.`, { details: { threadId, requestId } });
      }
      parked.resolve({ kind: "answered", answers });
    });

  /** The permission mode takes effect at the next permission check, so a running turn follows it from its next tool call. */
  readonly setRuntimeMode = (threadId: ThreadId, mode: RuntimeMode): void => {
    const session = this.sessions.get(threadId);
    if (session && !session.closed) session.runtimeMode = mode;
  };

  /** Hand the running turn more input: the loop reads it as a user message at its next step. */
  readonly steerTurn = (threadId: ThreadId, text: string, images: readonly ProviderImage[] = []): Effect.Effect<void, CliError> =>
    this.attempt("HARNESS_STEER_FAILED", `Could not steer the turn on thread ${threadId}`, () => {
      const session = this.requireSession(threadId);
      if (!this.openTurn(session)) throw new CliError("TURN_NOT_RUNNING", `Thread ${threadId} has no running turn to steer.`, { details: { threadId } });
      session.steering.push({ text, images });
    });

  // -- stopping ------------------------------------------------------------------

  readonly stopSession = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    this.attempt("HARNESS_STOP_FAILED", `Could not stop the harness session for thread ${threadId}`, () => {
      const session = this.sessions.get(threadId);
      if (!session || session.closed) return;
      session.closed = true;
      if (session.wakeTimer) clearTimeout(session.wakeTimer);
      const turn = this.openTurn(session);
      turn?.controller.abort();
      if (turn) this.settle(session, turn, { status: "interrupted", text: "", error: "Session stopped.", usage: null });
      this.sessions.delete(threadId);
      // The servers' processes end with the session; the signals go out now, the wait is only for the tidy-up.
      session.background.stopAll();
      void session.mcp.close();
    });

  readonly stopAll = (): Effect.Effect<void, CliError> =>
    Effect.sync(() => {
      for (const session of this.sessions.values()) {
        session.closed = true;
        const turn = this.openTurn(session);
        turn?.controller.abort();
        if (turn) this.settle(session, turn, { status: "interrupted", text: "", error: "Driver stopped.", usage: null });
        session.background.stopAll();
        void session.mcp.close();
      }
      this.sessions.clear();
    });

  // -- reading and rewinding -------------------------------------------------------

  /** What the model's next request would hold; null before anything has been said. */
  private contextInput(threadId: ThreadId): ContextInput | null {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return null;
    if (session.lastUsage === null && !session.transcript.messages.some((message) => message.role === "user")) return null;
    const target = this.tryTarget(session);
    const window = target?.model.contextWindow ?? null;
    return {
      messages: session.transcript.messages,
      tools: this.toolsFor(session, null).map((tool) => tool.definition),
      reported: session.lastUsage,
      maxTokens: window,
      autoCompactThreshold: target ? autoCompactThreshold(window, resolveCompactionSettings(this.config, target.profile, target.model.id)) : null,
    };
  }

  readonly contextUsage = async (threadId: ThreadId): Promise<ContextWindowUsage | null> => {
    const input = this.contextInput(threadId);
    return input ? contextUsageOf(input) : null;
  };

  readonly contextBreakdown = async (threadId: ThreadId): Promise<ContextBreakdown | null> => {
    const input = this.contextInput(threadId);
    return input ? contextBreakdownOf(input) : null;
  };

  readonly readThread = (threadId: ThreadId): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("HARNESS_READ_FAILED", `Could not read the harness thread ${threadId}`, () => {
      const session = this.requireSession(threadId);
      const turns: Array<{ id: string; items: unknown[] }> = [];
      // What compactions dropped comes first, so the thread reads as it was lived; the summary that replaced it is not a turn.
      const live = session.transcript.messages;
      for (const message of [...session.transcript.archived(), ...live.slice(leadLength(live))]) {
        if (message.role === "user" && message.compactSummary) continue;
        if (message.role === "user") turns.push({ id: `${session.sessionId}-${turns.length + 1}`, items: [] });
        turns.at(-1)?.items.push(message);
      }
      return { threadId, turns };
    });

  readonly rollbackThread = (threadId: ThreadId, numTurns: number): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("HARNESS_ROLLBACK_FAILED", `Could not roll back the harness thread ${threadId}`, async () => {
      if (!Number.isInteger(numTurns) || numTurns < 1) throw new CliError("INVALID_ROLLBACK", "numTurns must be an integer >= 1.", { details: { threadId, numTurns } });
      const session = this.requireSession(threadId);
      if (this.openTurn(session)) throw new CliError("TURN_BUSY", `Thread ${threadId} already has a running turn.`, { details: { threadId } });
      const prompts = session.transcript.promptCount;
      if (prompts < numTurns) {
        const compacted = session.transcript.compactions > 0;
        throw new CliError(
          "ROLLBACK_UNAVAILABLE",
          compacted ? "Turn boundaries before the last compaction are gone; cannot roll back that far." : "Cannot roll back more turns than the session holds.",
          { details: { threadId, numTurns, turns: prompts } },
        );
      }
      session.transcript.rollback(numTurns);
      session.lastUsage = null;
      // What the model read earlier may no longer be what it remembers; make it read again before editing.
      session.readState.clear();
      return await Effect.runPromise(this.readThread(threadId));
    });
}

/** `/compact`, alone or with what the summary should pay attention to. */
function manualCompaction(prompt: string): { focus: string | undefined } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return null;
  const focus = match[1]?.trim();
  return { focus: focus ? focus : undefined };
}

function toolRaw(call: ToolCall, args: Record<string, unknown>, result: ToolResult): Record<string, unknown> {
  return { toolUseId: call.id, input: args, output: result.content, isError: result.isError === true };
}

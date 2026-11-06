/**
 * OpenCode driver: `ProviderAdapter` over `opencode serve` + the generated
 * v2 client (serve-first; see docs/providers.md).
 *
 * One server per working directory (shared across that cwd's threads),
 * one native session per thread, one SSE `event.subscribe` pump per
 * server demuxed by `sessionID`. The transport translates v2's events into
 * the vocabulary read here (`translate.ts`). Turns run through
 * `session.prompt` and settle on `session.idle` / `session.error` (v2's
 * `session.execution.*`, once no steered input is still queued); permission
 * and question requests park until `respondToRequest` / `respondToUserInput`
 * resolve them (`permission.reply` once/always/reject, a question form is
 * replied to or cancelled). v2 prompts carry only text and files, so the
 * model, agent and runtime instructions are session state,
 * applied before a prompt only when they changed. Rollback forks the native
 * session; compaction is native (`session.compact`). Token usage is read
 * best-effort off the latest assistant message at turn end, so mid-turn
 * usage stays silent (the §13 "per-message only" row).
 * Auth is never ours: the CLI's own login.
 */
import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { Done } from "effect/Cause";

import { TIMED_OUT, abortRace, withinMs } from "../timeout.js";

import { CliError } from "../../errors.js";
import { permissionEscapes, type WorktreeIsolation } from "../../threads/isolation.js";
import { modeInstructionKey, modeProcedure, PROCEDURE_MODES } from "../../threads/modes.js";
import { plainSkill, type SkillInventory, type SkillSummary } from "../../catalog/summary.js";
import { excludedSkills } from "../../skills/discovery.js";
import type { InteractionMode, ModelSelection, ProviderOptionSelection, RuntimeMode } from "../../types.js";
import { CONTINUE_AFTER_OVERFLOW } from "../../compaction/summaryprompt.js";
import { dropTurnWaiter, isCompactCommand } from "../spi.js";
import type {
  ApprovalRequestId,
  BackgroundTaskSummary,
  ContextBreakdown,
  ContextWindowUsage,
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderImage,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderThreadSnapshot,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  RateLimitWindow,
  SideAnswer,
  SideQuestionInput,
  SubagentHistoryItem,
  TextCompletionInput,
  ThreadId,
  TokenUsageDelta,
  TurnId,
} from "../spi.js";
import { mcpSignature, outOfProcess, outOfProcessWithChecklist, type McpServerSpec, type OutOfProcessMcpServerSpec } from "../../mcp.js";
import { opencodeContextBreakdown } from "./context.js";
import {
  isContextOverflowText,
  isOpencodeAuthErrorText,
  normalizeOpencodeSettings,
  opencodeSignedOutMessage,
  type OpencodeSettings,
} from "./config.js";
import { isFreeOpencodeModel, providerEnvNames, readStoredAuthTypes, storedAuthTypeFor } from "./catalog.js";
import { SIDE_QUESTION_RULES } from "../sidequestion.js";
import {
  newOpencodeMessageId,
  SpawnOpencodeTransport,
  type OpencodeContextSettings,
  type OpencodeMcpConfig,
  type OpencodeModelInfo,
  type OpencodeModelRef,
  type OpencodeServerConnection,
  type OpencodeSessionState,
  type OpencodeSubscribedEvent,
  type OpencodeTransport,
  isServerUnreachable,
} from "./transport.js";
import { registerOpencodeMcpServer, type OpencodeMessage } from "./translate.js";
import { isOpencodeGo, OPENCODE_GO_INSTANCE } from "./usage.js";

/**
 * The shortest gap between two reads of OpenCode Go's usage on one server.
 * Codex probes its account once at session start and then hears live updates;
 * OpenCode publishes no account event, so a turn end is the one moment its
 * plan can have moved. Once a minute is closer than that is worth (Claude
 * reprobes its own account at most every 25 s) and still catches a plan spent
 * mid-conversation.
 */
const GO_USAGE_REFRESH_MS = 60_000;

export interface OpenCodeDriverOptions {
  readonly settings?: Partial<OpencodeSettings>;
  readonly env?: NodeJS.ProcessEnv;
  readonly transport?: OpencodeTransport;
  /** Silence budget per turn before it fails loudly (default 10 minutes, mirroring the Grok watchdog). */
  readonly stallTimeoutMs?: number;
  /**
   * The silence budget while a tool call is in flight (default 6× `stallTimeoutMs`): a build, a Code Mode
   * script or a subagent can work for a long time without the server saying a word about it.
   */
  readonly toolStallTimeoutMs?: number;
  /** How long an interrupt waits for the server to confirm before settling the turn itself (default 3 s). */
  readonly interruptAckTimeoutMs?: number;
  /** How long a server stays quiet before a pending tool-settings restart (default 1.5 s; see `reconcileServers`). */
  readonly reconcileDelayMs?: number;
  /** How long an interrupt or stop waits for an abort connection and the abort itself (default 1 s); a timeout skips the abort. */
  readonly abortWaitMs?: number;
  /** How long a stop waits for an in-flight start before abandoning it (default 1 s, well under the server's per-driver stop budget). */
  readonly stopWaitMs?: number;
}

/** Default `stallTimeoutMs`: a turn with zero provider events for this long is failed, never left running. */
export const OPENCODE_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export type OpenCodeTurnStatus = "completed" | "failed" | "interrupted";

export interface OpenCodeTurnOutcome {
  readonly status: OpenCodeTurnStatus;
  readonly text: string;
  readonly usage: TokenUsageDelta;
  readonly generation?: { readonly characters: number; readonly durationMs: number };
  readonly error: string | null;
}

interface OpenCodeTurn {
  readonly id: TurnId;
  readonly prompt: string;
  status: "running" | OpenCodeTurnStatus;
  text: string;
  error: string | null;
  /**
   * Id of the user message this turn sent. Parts of it stream back on the
   * same `message.part.updated` channel as the answer, so the accumulator
   * skips them — otherwise the prompt is echoed into the reply text.
   * Assigned before the send so no part can arrive unattributed.
   */
  readonly userMessageId: string;
  /** User messages steered into this turn: skipped like the prompt's own. */
  readonly steerMessageIds: Set<string>;
  /** Text parts by part id, in arrival order, with the message each belongs to. */
  partTexts: Map<string, { messageId: string | null; text: string }>;
  /** The assistant message (one per model step) that last streamed text. */
  lastTextMessageId: string | null;
  /** Setup step to append if the server rejects this turn (see `missingCredentialHint`). */
  credentialHint: string | null;
  usage: TokenUsageDelta;
  /** When the server last said anything about this turn; the stall watchdog measures silence from here. */
  lastActivityAt: number;
  /** Tool calls started and not yet finished: while any is, silence is the tool working, not a stall. */
  readonly activeTools: Set<string>;
  /** The thinking summary each reasoning part has shown so far, so a cumulative part is sent on as its delta. */
  reasoningTexts?: Map<string, string>;
  generationParts?: Map<string, { characters: number; start: number; end: number }>;
  /** Set once an interrupt is on its way: the server's idle then acknowledges it rather than completes the turn. */
  interrupting: boolean;
  /** The server has confirmed the interrupt (recorded even when it beats the HTTP reply, before anyone waits). */
  interruptAcked: boolean;
  interruptAck: (() => void) | null;
  /** A `/compact` turn: it asks the server to compact instead of prompting, and ends when the compaction does. */
  compacting?: boolean;
  /** The server rejected a request as too long and Moxen compacted to make room: once per turn. */
  overflowRescued?: boolean;
  /** That compaction is under way: the turn stays open, and the server's idle in between is not its end. */
  rescuing?: boolean;
}

function generationOf(turn: OpenCodeTurn): { characters: number; durationMs: number } | undefined {
  const parts = [...(turn.generationParts?.values() ?? [])].sort((a, b) => a.start - b.start);
  if (parts.length === 0) return undefined;
  let end = -Infinity;
  let durationMs = 0;
  let characters = 0;
  for (const part of parts) {
    characters += part.characters;
    durationMs += Math.max(0, part.end - Math.max(end, part.start));
    end = Math.max(end, part.end);
  }
  return { characters, durationMs };
}

type ParkedKind = "permission" | "question";

interface ParkedOpenCode {
  readonly threadId: ThreadId;
  readonly kind: ParkedKind;
  /** Native `permission.asked` / `question.asked` id (doubles as requestId). */
  readonly nativeId: string;
  readonly detail: string;
}

interface OpenCodeSession {
  readonly threadId: ThreadId;
  nativeSessionId: string;
  readonly workingDirectory: string;
  /** Set when the session runs in its own worktree: a permission that reaches the checkout it came from is rejected, even in full access. */
  readonly isolation: WorktreeIsolation | null;
  closed: boolean;
  /** Catalog instance id (`opencode` or `opencode/<provider>`); supplies the provider for bare model slugs. */
  instanceId: string;
  /** Raw model slug; parsed per send so instance-id context applies. */
  modelSlug: string | null;
  /** The thread's model options (reasoning effort); read as a v2 variant when the model has one. */
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** Runtime instructions, kept as the session's `moxen` instruction entry (v2 prompts carry no `system`). */
  instructions: string | null;
  /** moxen's MCP servers, re-registered on a replacement server (see `dropConnection`). */
  mcpServers: readonly McpServerSpec[];
  /** Whether moxen's server lends this session its checklist tool (the user's to-do list setting). */
  readonly checklist: boolean;
  /** What the native session is already set to; a prompt only changes what differs. */
  applied: AppliedSessionState;
  turns: Map<TurnId, OpenCodeTurn>;
  waiters: Map<TurnId, Array<{ resolve: (outcome: OpenCodeTurnOutcome) => void; reject: (cause: unknown) => void; signal?: AbortSignal; onAbort?: () => void }>>;
  parked: Map<string, ParkedOpenCode>;
  /** Latest context-window reading, taken when a turn goes idle. */
  context: ContextWindowUsage | null;
  /** Output arriving before this is the tail of a run we just interrupted, not a run the server started itself. */
  ignoreOutputUntil?: number;
  /** Commands the model sent to the background that have not ended, by shell id. */
  backgroundShells?: Map<string, { readonly command: string; readonly startedAt: string }>;
  /** Every message id whose parts this session has handled: late updates to a finished message are not a new run. */
  seenMessageIds?: Set<string>;
  startedAt: string;
}

/** The native session's model, agent, `moxen` instruction entry and mode entry, as last known. `undefined` = not known. */
interface AppliedSessionState {
  model: OpencodeModelRef | undefined;
  agent: string | undefined;
  instructions: string | null | undefined;
  /** The mode whose procedure entry (`moxen-research`, `moxen-orchestrate`) is set; Build has none. */
  mode: InteractionMode | undefined;
}

/** A child session OpenCode's `subagent` tool started for a thread's session. */
interface OpenCodeChild {
  readonly parent: OpenCodeSession;
  readonly agentType: string;
  readonly description: string | null;
  readonly background: boolean;
  stopped: boolean;
}

/** A `subagent` call's result without its `<subagent …>` wrapper: the child's report. */
function subagentReport(output: string | null): string | null {
  if (!output) return null;
  const report = output.replace(/^\s*<subagent\b[^>]*>/u, "").replace(/<\/subagent>\s*$/u, "").trim();
  return report.length > 0 ? report : null;
}

/** The text of the newest assistant message that said anything. */
function lastAssistantText(messages: ReadonlyArray<OpencodeMessage>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.info.role !== "assistant") continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}

function isoAt(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/** A child session's timeline as subagent history: its prompt, thoughts, tool calls and words. */
function subagentHistoryItems(messages: ReadonlyArray<OpencodeMessage>): SubagentHistoryItem[] {
  const items: SubagentHistoryItem[] = [];
  for (const message of messages) {
    const at = isoAt(asRecord(message.info.time)?.created);
    const user = message.info.role === "user";
    for (const part of message.parts) {
      const id = asString(part.id) ?? `${asString(message.info.id) ?? "message"}:${items.length}`;
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string" && part.text.trim()) {
        items.push({ kind: user ? "prompt" : part.type === "reasoning" ? "reasoning" : "text", id, at, text: part.text });
      } else if (part.type === "tool" && !user) {
        const started = isoAt(asRecord(asRecord(part.state)?.time)?.start);
        items.push({ kind: "tool", id, at: started ?? at, tool: asString(part.tool) ?? "tool", raw: part });
      }
    }
  }
  return items;
}

/** How long a server stays up after it goes quiet before a pending tool-settings restart (see `reconcileServers`). */
const RECONCILE_DELAY_MS = 1_500;

/** How long an interrupt or stop waits for an abort connection and the abort itself (see `abortWaitMs`). */
const ABORT_WAIT_MS = 1_000;

/** How long `stopAll` waits for live servers to dispose, in parallel (see `stopAll`). */
const STOP_DISPOSE_BUDGET_MS = 2_000;

/** How long a stop waits for an in-flight start before abandoning it (see `stopWaitMs`). */
const STOP_WAIT_MS = 1_000;

/** An `openSession` still running: a stop waits for it, bounded, then abandons it (see `abandonStart`). */
interface PendingStart {
  readonly promise: Promise<ProviderSession>;
  /** A stop is waiting on this start: whatever it registers will be closed, so a joiner starts fresh instead. */
  stopping: boolean;
  /** The session this start registered, once it has: a stop closes only its own start's session. */
  session?: OpenCodeSession;
  /** Fired on abandon so joiners on a wedged start go fresh at once instead of hanging on the zombie entry. */
  readonly aborter: AbortController;
}

/** What the server's config holds that Moxen decides: the tools left off, and whether its own prompt replaces OpenCode's. */
interface ServerShape {
  readonly tools: string;
  readonly moxenPrompt: boolean;
}

const serverShape = (names: string | readonly string[] | undefined, moxenPrompt: boolean | undefined): ServerShape => ({ tools: canonicalToolList(names), moxenPrompt: moxenPrompt === true });
const serverShapeKey = (shape: ServerShape | undefined): string => `${shape?.tools ?? ""}|${shape?.moxenPrompt === true}`;

/** A list of tool names as one comparable string: lower-cased, sorted, no repeats. */
function canonicalToolList(names: string | readonly string[] | undefined): string {
  const list = typeof names === "string" ? names.split(",") : (names ?? []);
  return [...new Set(list.map((name) => name.trim().toLowerCase()).filter((name) => name !== ""))].sort().join(",");
}

/** The instruction entry key runtime instructions live under. */
const INSTRUCTIONS_KEY = "moxen";

/**
 * The name agents see moxen's tools under (`MOXEN_MCP_SERVER_NAME` in
 * `src/server/mcp/main.ts`, which core cannot import — the layering test
 * pins that direction). Kept as the literal here so the driver can keep the
 * directory's single `moxen` entry stable while other servers dedupe by key.
 */
const MOXEN_MCP_SERVER_NAME = "moxen";

/**
 * The `mcp.add` payload for one out-of-process server, in the `name:config`
 * key form `registerMcpServers` dedupes by.
 */
function mcpRegistration(server: OutOfProcessMcpServerSpec): { key: string; config: OpencodeMcpConfig } {
  const config: OpencodeMcpConfig =
    server.type === "http"
      ? { type: "remote", url: server.url, ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}) }
      : {
          type: "local",
          command: [server.command, ...server.args],
          ...(Object.keys(server.env).length > 0 ? { environment: server.env } : {}),
        };
  return { key: `${server.name}:${JSON.stringify(config)}`, config };
}

/**
 * The turn's answer: the text of its last assistant message. OpenCode opens
 * one assistant message per model step, so a turn that calls tools leaves
 * interim notes in the earlier steps; joining every step's text put that
 * working narration into the final output.
 */
function answerText(parts: ReadonlyMap<string, { messageId: string | null; text: string }>): string {
  const all = [...parts.values()];
  const last = all.findLast((part) => part.text.length > 0);
  if (!last) return "";
  return all.filter((part) => part.messageId === last.messageId).map((part) => part.text).join("");
}

/**
 * OpenCode v2's auto-compaction trigger for a model: the usable window (the
 * input limit when the model has one, else the context limit) less a buffer —
 * `compaction.buffer` when configured, else 10% of the window, never under
 * 16k on windows of 32k and up. 200k → 180k, 128k → 112k, 20k → 18k. Null
 * when there is no usable window (v2 never auto-compacts then).
 */
export function opencodeCompactionThreshold(
  limit: { readonly context: number; readonly input?: number },
  buffer: number | null,
): number | null {
  const usable = limit.input || limit.context;
  if (!(usable > 0)) return null;
  const reserved = buffer !== null ? buffer : Math.max(Math.floor(usable * 0.1), usable >= 32_000 ? 16_000 : 0);
  return Math.max(0, usable - reserved);
}

/**
 * The context window after a turn, the way OpenCode v2 itself counts it: the
 * latest assistant message's `input + cache.read + cache.write + output +
 * reasoning`, against the model's `limit.context`, with the auto-compact
 * threshold from `opencodeCompactionThreshold`.
 */
export function opencodeContextOf(
  messages: ReadonlyArray<{ info: Record<string, unknown> }>,
  settings: OpencodeContextSettings | null,
): ContextWindowUsage | null {
  const info = [...messages].reverse().find((message) => message.info.role === "assistant" && asRecord(message.info.tokens))?.info;
  const tokens = asRecord(info?.tokens);
  if (!info || !tokens) return null;
  const cache = asRecord(tokens.cache);
  const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cacheRead = number(cache?.read);
  const used = number(tokens.input) + cacheRead + number(cache?.write) + number(tokens.output) + number(tokens.reasoning);
  if (used <= 0) return null;
  const providerId = asString(info.providerID);
  const modelId = asString(info.modelID);
  const limit = providerId && modelId ? settings?.limits.get(`${providerId}/${modelId}`) : undefined;
  return {
    usedTokens: used,
    // The window the model can actually be given: some are served with an input
    // cap well under their context (Space Bunny: 1M context, 512k input), and
    // OpenCode compacts against that cap — a bar out of the bigger number would
    // show a compaction at "half full".
    maxTokens: limit && limit.context > 0 ? (limit.input && limit.input < limit.context ? limit.input : limit.context) : null,
    cachedInputTokens: cacheRead,
    autoCompactThreshold: limit ? opencodeCompactionThreshold(limit, settings?.buffer ?? null) : null,
    compactsAutomatically: settings ? settings.autoCompact : null,
  };
}

/** Whether the session's latest user message has a finished assistant reply. */
function lastUserAnswered(messages: ReadonlyArray<{ info: Record<string, unknown> }>): boolean {
  const lastUser = [...messages].reverse().find((message) => message.info.role === "user");
  const userId = lastUser ? asString(lastUser.info.id) : null;
  if (!userId) return true;
  // The timeline's own `idle` marker after the prompt: answered, even when the run left no reply.
  if (lastUser?.info.settled === true) return true;
  return messages.some((message) =>
    message.info.role === "assistant" &&
    message.info.parentID === userId &&
    asRecord(message.info.time)?.completed !== undefined,
  );
}

function emptyUsage(): TokenUsageDelta {
  return { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 };
}

function toCliError(code: string, message: string, cause: unknown, cwd?: string): CliError {
  // Auth patterns win even over SDK wrappers carrying the message.
  const text = cause instanceof Error ? cause.message : String(cause);
  if (isOpencodeAuthErrorText(text)) {
    return new CliError("OPENCODE_AUTH_REQUIRED", opencodeSignedOutMessage({ cwd: cwd ?? process.cwd() }), {
      cause,
    });
  }
  if (cause instanceof CliError) return cause;
  return new CliError(code, `${message}: ${text.slice(0, 200)}`, { cause });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the native `providerID/modelID` address. `modelSelection.model`
 * is either already `providerID/modelID` or a bare models.dev id, in
 * which case the `opencode/<providerId>` instance id supplies the
 * provider. Anything else means "server default".
 */
export function parseOpencodeModel(
  modelSelection?: ModelSelection,
  instanceId?: string,
): { providerID: string; modelID: string } | null {
  const raw = modelSelection?.model?.trim() ?? "";
  if (raw.length === 0) return null;
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
  const instance = (instanceId ?? modelSelection?.instanceId ?? "").trim().toLowerCase();
  const match = instance.match(/^opencode\/(.+)$/);
  if (match?.[1]) return { providerID: match[1], modelID: raw };
  return null;
}

/** Timeline items read when a turn goes idle (see `onSessionIdle`). */
const IDLE_READ_ITEMS = 60;

/** Option ids a thread's reasoning effort may be stored under. */
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort", "reasoning", "variant"]);

/**
 * The v2 variant for a thread's reasoning effort: the option's value, when
 * this model lists a variant with that id (a variant the model lacks is a
 * model-resolution error on the server, so it is never sent).
 */
function variantFor(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  model: OpencodeModelInfo,
): string | null {
  const value = options?.find((option) => EFFORT_OPTION_IDS.has(option.id) && typeof option.value === "string")?.value;
  return typeof value === "string" && model.variants.includes(value) ? value : null;
}

/** Same model and variant; "no variant" and the server's `default` are one. */
function sameModel(applied: OpencodeModelRef | undefined, target: OpencodeModelRef): boolean {
  return (
    applied !== undefined &&
    applied.providerID === target.providerID &&
    applied.modelID === target.modelID &&
    (applied.variant ?? "default") === (target.variant ?? "default")
  );
}

export class OpenCodeDriver implements ProviderAdapter<CliError> {
  readonly provider = "opencode" as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    sessionModelSwitch: "in-session",
    supportsConversationRollback: true,
  };
  readonly compaction = {
    start: (threadId: ThreadId, modelSelection?: ModelSelection): Effect.Effect<void, CliError> =>
      this.attempt("OPENCODE_COMPACT_FAILED", `Could not compact the session for thread ${threadId}`, async () => {
        const session = this.requireSession(threadId);
        const connection = await this.connectionFor(session);
        if (modelSelection) {
          // v2's compact runs on the session's own model, so switch first —
          // through the applied-state cache, which a direct switch would leave stale.
          session.instanceId = modelSelection.instanceId;
          session.modelSlug = modelSelection.model;
          session.modelOptions = modelSelection.options;
          const wanted = parseOpencodeModel(modelSelection, session.instanceId);
          await this.applySessionState(session, connection, wanted, undefined, null);
        }
        await connection.summarizeSession(session.nativeSessionId);
      }),
    type: "native" as const,
  };

  /**
   * The servers this thread should have now, for a session already running:
   * the ones that are new or changed are added to the server. A server taken
   * out of the config stays registered with the OpenCode server until it
   * stops, since v2's API has no way to remove one at runtime.
   */
  readonly updateMcpServers = async (threadId: ThreadId, servers: readonly McpServerSpec[]): Promise<void> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return;
    if (mcpSignature(servers) === mcpSignature(session.mcpServers)) return;
    session.mcpServers = servers;
    await this.registerMcpServers(await this.connectionFor(session), servers, session.checklist, threadId);
  };

  /**
   * The thread whose live native session this is, for routing the directory's
   * single `moxen` entry to the session that made each call: OpenCode sends
   * its session id in `CallToolRequest.params._meta["ai.opencode/sessionID"]`.
   * Follows OpenCode's own child sessions to the thread whose session started
   * them. Null when no live session matches: the caller must fail safe, never
   * serve another thread.
   */
  readonly threadForNativeSession = (nativeSessionId: string): string | null => {
    const session = this.sessionForNative(nativeSessionId);
    if (session) return session.threadId;
    const child = this.children.get(nativeSessionId);
    if (child && !child.parent.closed) return child.parent.threadId;
    return null;
  };

  /**
   * Live sessions that could place calls on this thread's entry: every live
   * session on its server, since the directory's single `moxen` entry serves
   * them all. More than one makes a call without session identity ambiguous,
   * so it fails instead of running as the entry owner's thread. A thread
   * with no live session is not provably single, so it counts as shared.
   */
  readonly entrySessionCount = (threadId: string): number => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return 2;
    let count = 0;
    for (const candidate of this.sessions.values()) {
      if (!candidate.closed && candidate.workingDirectory === session.workingDirectory) count += 1;
    }
    return count;
  };

  /**
   * The tools to leave off, for a session already running: what the setting says now. The server was started with
   * the set of its day, so a difference waits for it to be quiet and then restarts it. Not for an external server,
   * whose config is not ours.
   */
  readonly updateNativeTools = async (threadId: ThreadId, names: readonly string[], moxenPrompt = false): Promise<void> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return;
    this.wantedServerConfig.set(session.workingDirectory, serverShape(names, moxenPrompt));
    this.reconcileServers();
  };

  /** Nothing is running on this server: no turn, no background command or subagent, nothing waiting on the user. */
  private serverIdle(key: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.workingDirectory !== key || session.closed) continue;
      if (this.openTurn(session) || session.parked.size > 0 || (session.backgroundShells?.size ?? 0) > 0) return false;
    }
    for (const child of this.children.values()) {
      if (!child.stopped && child.parent.workingDirectory === key) return false;
    }
    return true;
  }

  /**
   * Restart each server whose tool settings differ from what it started with, once it is idle. Called when a setting
   * is seen and whenever something that was running stops; a short wait first, so a queued message that is about to
   * start does not meet a server being shut down.
   */
  private reconcileServers(): void {
    if (this.reconcileTimer !== null) return;
    const stale = [...this.liveConnections].filter(([key, connection]) => !connection.external && serverShapeKey(this.spawnedServerConfig.get(key)) !== serverShapeKey(this.wantedServerConfig.get(key)));
    if (stale.length === 0) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      for (const [key, connection] of stale) {
        if (this.liveConnections.get(key) !== connection || !this.serverIdle(key)) continue;
        this.dropConnection(key, connection, "its tool settings changed");
      }
    }, this.reconcileDelayMs);
    this.reconcileTimer.unref?.();
  }

  private readonly settings: OpencodeSettings;
  private readonly baseEnv: NodeJS.ProcessEnv;
  /**
   * Child sessions OpenCode's `subagent` tool started, by session id. Kept
   * after they stop so the call's later updates (which still name the
   * child) do not start it again.
   */
  private readonly children = new Map<string, OpenCodeChild>();
  private readonly transport: OpencodeTransport;
  private readonly stallTimeoutMs: number;
  private readonly toolStallTimeoutMs: number;
  /** How long after an interrupt the server's trailing output is still the aborted run's. */
  private readonly interruptTailMs = 3_000;
  private readonly interruptAckTimeoutMs: number;
  private readonly reconcileDelayMs: number;
  private readonly abortWaitMs: number;
  private readonly stopWaitMs: number;
  private readonly stallTimers = new Map<TurnId, ReturnType<typeof setTimeout>>();
  private readonly sessions = new Map<ThreadId, OpenCodeSession>();
  /** Starts in flight, by thread: a stop waits for the start bounded, then abandons it (see `abandonStart`). */
  private readonly starting = new Map<ThreadId, PendingStart>();
  private readonly connections = new Map<string, Promise<OpencodeServerConnection>>();
  /**
   * Establishes a stop discarded while in flight: their late frames dispose
   * the connection instead of registering it (see `connectionForSession`),
   * then delete the entry here. Only `stopAll` adds to it; frames delete on
   * observe, so it cannot grow.
   */
  private readonly discarded = new Set<Promise<OpencodeServerConnection>>();
  /**
   * The tools OpenCode's own server is told to leave off, and whether Moxen's prompt replaces its own, are part of
   * its config, fixed when it starts. `wanted` is what the settings say now (per server, which is per directory);
   * `spawned` is what each live server started with. A difference restarts the server once nothing is running on it
   * (`reconcileServers`).
   */
  private readonly wantedServerConfig = new Map<string, ServerShape>();
  private readonly spawnedServerConfig = new Map<string, ServerShape>();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** The connection behind each `connections` entry once it resolved, for identity checks. */
  private readonly liveConnections = new Map<string, OpencodeServerConnection>();
  /** `name:config` already registered per server connection (see `registerMcpServers`). */
  private readonly mcpRegistered = new WeakMap<OpencodeServerConnection, Set<string>>();
  /**
   * The `moxen` entry each connection's live entry last registered with, and
   * which thread registered it: one stable entry per OpenCode server. Every
   * call is routed per call by the session id OpenCode sends in
   * `CallToolRequest.params._meta`, so a session starting later on the same
   * server never replaces the entry (replacing it restarts the server with
   * `mcp.add`, killing in-flight calls). Only the thread that registered the
   * entry re-registers it, when its own spec changes.
   */
  private readonly moxenEntry = new WeakMap<OpencodeServerConnection, { owner: ThreadId; key: string }>();
  /** When each server (by working directory) last had its OpenCode Go usage read. */
  private readonly goUsageReadAt = new Map<string, number>();
  private readonly pumps = new Map<string, { controller: AbortController; ready: Promise<void>; done: Promise<void> }>();
  /**
   * Unfinished until `stopAll` ends it, so the event stream ends instead of
   * hanging: `Queue.end` needs the `Done` channel the stream strips back off.
   */
  private readonly queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent, Done>());

  constructor(options: OpenCodeDriverOptions = {}) {
    this.settings = normalizeOpencodeSettings(options.settings);
    this.baseEnv = options.env ?? process.env;
    this.transport = options.transport ?? new SpawnOpencodeTransport();
    this.stallTimeoutMs = options.stallTimeoutMs ?? OPENCODE_STALL_TIMEOUT_MS;
    this.toolStallTimeoutMs = options.toolStallTimeoutMs ?? this.stallTimeoutMs * 6;
    this.interruptAckTimeoutMs = options.interruptAckTimeoutMs ?? 3000;
    this.reconcileDelayMs = options.reconcileDelayMs ?? RECONCILE_DELAY_MS;
    this.abortWaitMs = options.abortWaitMs ?? ABORT_WAIT_MS;
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
  }

  get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.queue);
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

  private requireSession(threadId: ThreadId): OpenCodeSession {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) {
      throw new CliError("OPENCODE_NOT_STARTED", `No OpenCode session exists for thread ${threadId}.`, {
        details: { threadId },
      });
    }
    return session;
  }

  private openTurn(session: OpenCodeSession): OpenCodeTurn | null {
    for (const turn of session.turns.values()) {
      if (turn.status === "running") return turn;
    }
    return null;
  }

  private async connectionForSession(threadId: ThreadId, workingDirectory: string): Promise<OpencodeServerConnection> {
    const key = workingDirectory;
    const existing = this.connections.get(key);
    if (existing) {
      const connection = await existing;
      if (this.discarded.has(existing)) {
        // A stop discarded this establish while it was in flight: never
        // register it, dispose it instead.
        this.discarded.delete(existing);
        void connection.dispose().catch(() => undefined);
        throw new CliError("OPENCODE_START_ABANDONED", `Its server was discarded by a stop.`, {
          details: { workingDirectory },
        });
      }
      // A pump that died (dropped stream) is restarted before anything is sent:
      // v2 replays nothing, so an event stream that is not live loses answers.
      await this.ensurePump(key, connection);
      return connection;
    }
    const shape = this.wantedServerConfig.get(key) ?? serverShape(undefined, false);
    this.spawnedServerConfig.set(key, shape);
    const pending = this.transport.ensureServer({
      settings: this.settings,
      workingDirectory,
      env: this.baseEnv,
      ...(shape.tools !== "" ? { disabledNativeTools: shape.tools } : {}),
      ...(shape.moxenPrompt ? { moxenPrompt: true } : {}),
    });
    this.connections.set(key, pending);
    try {
      const connection = await pending;
      if (this.discarded.has(pending)) {
        // A stop discarded this establish while it was in flight: never
        // register it, dispose it instead.
        this.discarded.delete(pending);
        void connection.dispose().catch(() => undefined);
        throw new CliError("OPENCODE_START_ABANDONED", `Its server was discarded by a stop.`, {
          details: { workingDirectory },
        });
      }
      this.liveConnections.set(key, connection);
      // A spawned server that exits is forgotten, so the next call respawns it.
      void connection.closed.then(() => this.dropConnection(key, connection, "the server exited"));
      await this.ensurePump(key, connection);
      return connection;
    } catch (cause) {
      if (this.connections.get(key) === pending) this.connections.delete(key);
      throw cause;
    }
  }

  /**
   * MCP in OpenCode belongs to the directory's instance, not to a session,
   * so moxen's servers are added once per connection and again only when
   * their config changes — `mcp.add` restarts the server on every call.
   * Same rule as OpenCode's own ACP server (`acp/service.ts`,
   * `mcpRegistrationKey`), including that a failed add does not fail the
   * session: it is retried on the next start. The `moxen` entry is the one
   * exception to "changed": it stays the first thread's, and later sessions
   * on the same server never replace it — their calls are routed per call by
   * the session id OpenCode sends in `CallToolRequest.params._meta` instead.
   */
  private async registerMcpServers(
    connection: OpencodeServerConnection,
    servers: readonly McpServerSpec[],
    checklist = true,
    owner: ThreadId,
  ): Promise<void> {
    if (servers.length === 0) return;
    let done = this.mcpRegistered.get(connection);
    if (!done) {
      done = new Set();
      this.mcpRegistered.set(connection, done);
    }
    // v2 has no `todowrite`: moxen's server lends its checklist tool.
    for (const server of servers.map(checklist ? outOfProcessWithChecklist : outOfProcess)) {
      if (server.name === MOXEN_MCP_SERVER_NAME) {
        await this.registerMoxenServer(connection, server, owner);
        continue;
      }
      const { key, config } = mcpRegistration(server);
      if (done.has(key)) continue;
      try {
        await connection.addMcpServer(server.name, config);
        registerOpencodeMcpServer(server.name);
        done.add(key);
      } catch {
        // Retried on the next session start.
      }
    }
  }

  /**
   * One stable `moxen` entry per server: the first thread's registration
   * wins, and only that thread re-registers it when its own spec changes. A
   * same-directory session (a shared or fork delegate) registering its own
   * config here would flip the entry mid-call, killing the in-flight call
   * with `Connection closed` and landing later calls on the wrong thread's
   * tools; those calls are routed per call instead.
   *
   * Residual shared fate: the owner's own re-registration still restarts the
   * server with `mcp.add`, which kills whatever else is in flight on it —
   * the price of the owner's entry genuinely changing. Nothing else on the
   * server re-registers, so nothing else pays it.
   */
  private async registerMoxenServer(
    connection: OpencodeServerConnection,
    server: OutOfProcessMcpServerSpec,
    owner: ThreadId,
  ): Promise<void> {
    const { key, config } = mcpRegistration(server);
    const entry = this.moxenEntry.get(connection);
    if (entry !== undefined && (entry.owner !== owner || entry.key === key)) return;
    try {
      await connection.addMcpServer(server.name, config);
      registerOpencodeMcpServer(server.name);
      this.moxenEntry.set(connection, { owner, key });
    } catch {
      // Retried on the next session start.
    }
  }

  /**
   * Forget a server that is gone (its process exited, or its event stream
   * died) so the next call starts a fresh one instead of failing against the
   * dead one forever. Turns open on it fail; the connection's caches (MCP
   * registered, context settings, model list) are keyed by the connection and
   * go with it. A no-op when the key already holds a different connection.
   */
  private dropConnection(key: string, connection: OpencodeServerConnection, reason: string): void {
    if (this.liveConnections.get(key) !== connection) return;
    this.liveConnections.delete(key);
    this.connections.delete(key);
    this.spawnedServerConfig.delete(key);
    const pump = this.pumps.get(key);
    this.pumps.delete(key);
    pump?.controller.abort();
    this.failServerTurns(key, `Lost the OpenCode server (${reason.slice(0, 200)}).`);
    void connection.dispose().catch(() => undefined);
  }

  /**
   * Wait for in-flight starts, at most `stopWaitMs`: a wedged transport must
   * not hang a stop. Unsettled entries stay registered, so the caller can
   * abandon exactly those.
   */
  private async awaitStarts(starts: ReadonlyArray<PendingStart>): Promise<void> {
    if (starts.length === 0) return;
    await withinMs(Promise.allSettled(starts.map((start) => start.promise)), this.stopWaitMs);
  }

  /**
   * Give up on a wedged start: wake its joiners at once and delete the map
   * entry so later starts go fresh instead of hanging on the zombie. The
   * shared connection is never dropped here: sibling sessions may be using
   * it, and a stop must not fail their turns. The late start tears down only
   * its own native session instead of registering (see `openSession`).
   */
  private abandonStart(threadId: ThreadId, entry: PendingStart): void {
    entry.aborter.abort();
    if (this.starting.get(threadId) === entry) this.starting.delete(threadId);
  }

  /**
   * The connection an abort may use: a live one, one already being
   * established, or a reattach to an external server (whose address is
   * configured, so no process is spawned). Null when reaching the server
   * would spawn a process, or when reaching it takes longer than
   * `abortWaitMs`: never start a server, nor hang, just to deliver an abort.
   */
  private async connectionForAbort(session: OpenCodeSession): Promise<OpencodeServerConnection | null> {
    const key = session.workingDirectory;
    const live = this.liveConnections.get(key);
    if (live) return live;
    const inFlight = this.connections.get(key);
    if (inFlight) {
      try {
        const raced = await withinMs(inFlight, this.abortWaitMs);
        return raced === TIMED_OUT ? null : raced;
      } catch {
        return null;
      }
    }
    if (this.settings.serverUrl.trim().length === 0) return null;
    try {
      const raced = await withinMs(this.connectionFor(session), this.abortWaitMs);
      return raced === TIMED_OUT ? null : raced;
    } catch {
      return null;
    }
  }

  private async connectionFor(session: OpenCodeSession): Promise<OpencodeServerConnection> {
    return await this.connectionForSession(session.threadId, session.workingDirectory);
  }

  /**
   * OpenCode Go's plan windows, read from the server this session already
   * talks to (never a new one) and at most once per server per
   * `GO_USAGE_REFRESH_MS`. Fire and forget: a slow or refused read costs the
   * reading, never the turn. Only the Go instance reports a plan; every other
   * OpenCode provider shares the server but not those windows.
   */
  private refreshGoUsage(session: OpenCodeSession): void {
    if (session.closed || !isOpencodeGo(session.instanceId)) return;
    const key = session.workingDirectory;
    // Only a server that is already up: a reading is never a reason to start
    // one, and a lost server's sessions still settle here.
    const connection = this.liveConnections.get(key);
    if (!connection) return;
    const now = Date.now();
    if (now - (this.goUsageReadAt.get(key) ?? 0) < GO_USAGE_REFRESH_MS) return;
    this.goUsageReadAt.set(key, now);
    void connection
      .usageLimits()
      .then((windows) => {
        if (session.closed || windows === null) return;
        this.publish({ type: "rate-limits.updated", provider: this.provider, threadId: session.threadId, windows, instanceId: OPENCODE_GO_INSTANCE });
      })
      .catch(() => undefined);
  }

  /** Model limits + compaction config, fetched once per server connection. */
  private readonly contextSettings = new WeakMap<OpencodeServerConnection, Promise<OpencodeContextSettings>>();

  private async contextSettingsFor(session: OpenCodeSession): Promise<OpencodeContextSettings> {
    const connection = await this.connectionFor(session);
    let pending = this.contextSettings.get(connection);
    if (!pending) {
      pending = connection.contextSettings();
      // A failed fetch is retried on the next turn rather than cached.
      pending.catch(() => this.contextSettings.delete(connection));
      this.contextSettings.set(connection, pending);
    }
    return await pending;
  }

  /** `model.list`, fetched once per connection and again when a model is not in it (a provider connected since). */
  private readonly modelLists = new WeakMap<OpencodeServerConnection, Promise<ReadonlyArray<OpencodeModelInfo>>>();

  private async modelListFor(connection: OpencodeServerConnection, refresh: boolean): Promise<ReadonlyArray<OpencodeModelInfo>> {
    let pending = this.modelLists.get(connection);
    if (!pending || refresh) {
      pending = connection.listModels();
      pending.catch(() => this.modelLists.delete(connection));
      this.modelLists.set(connection, pending);
    }
    return await pending;
  }

  /**
   * The server does not validate `session.switchModel`: a bogus model is
   * accepted and only fails the next run. So the model is checked against
   * `model.list` here and the send fails clearly. A list that cannot be read
   * skips the check (the server then answers `Model unavailable`).
   */
  private async resolveModel(
    connection: OpencodeServerConnection,
    model: { providerID: string; modelID: string },
    options: ReadonlyArray<ProviderOptionSelection> | undefined,
    credentialHint: string | null,
  ): Promise<OpencodeModelRef> {
    const find = (list: ReadonlyArray<OpencodeModelInfo>) =>
      list.find((entry) => entry.providerID === model.providerID && entry.modelID === model.modelID);
    let info: OpencodeModelInfo | undefined;
    try {
      info = find(await this.modelListFor(connection, false));
      if (!info) info = find(await this.modelListFor(connection, true));
    } catch {
      return model;
    }
    if (!info) {
      throw new CliError(
        "OPENCODE_MODEL_UNAVAILABLE",
        `OpenCode has no model "${model.providerID}/${model.modelID}".${credentialHint ? ` ${credentialHint}` : " Check the model id, or connect its provider with `opencode auth login`."}`,
        { details: { providerID: model.providerID, modelID: model.modelID } },
      );
    }
    const variant = variantFor(options, info);
    return { ...model, ...(variant ? { variant } : {}) };
  }

  /**
   * Bring the native session to this send's model, agent and instructions.
   * v2 prompts carry none of them, so they are session state; each call is
   * made only when the state it sets differs from what is already applied.
   * The thread's mode is applied as a procedure entry (`threads/modes.ts`).
   * Moxen has no plan mode (MXN-136): a session an older build left on
   * OpenCode's read-only `plan` agent goes back to `build`; a session on any
   * other agent (the user's `default_agent`) is left alone.
   */
  private async applySessionState(
    session: OpenCodeSession,
    connection: OpencodeServerConnection,
    wantedModel: { providerID: string; modelID: string } | null,
    interactionMode: InteractionMode | undefined,
    credentialHint: string | null,
  ): Promise<void> {
    if (interactionMode) session.interactionMode = interactionMode;
    const nativeId = session.nativeSessionId;
    const applied = session.applied;
    if (wantedModel) {
      const target = await this.resolveModel(connection, wantedModel, session.modelOptions, credentialHint);
      if (!sameModel(applied.model, target)) {
        await connection.switchModel(nativeId, target);
        applied.model = target;
      }
    }
    if (applied.agent === "plan") {
      await connection.switchAgent(nativeId, "build");
      applied.agent = "build";
    }
    if (applied.instructions !== session.instructions) {
      try {
        await connection.setInstructions(nativeId, INSTRUCTIONS_KEY, session.instructions);
      } catch (cause) {
        // Clearing an entry the session never had is not a failure.
        if (session.instructions !== null) throw cause;
      }
      applied.instructions = session.instructions;
    }
    // Research and Orchestrate (`threads/modes.ts`): the mode's procedure is an entry of its own, which OpenCode
    // adds after the conversation so far; switching back to Build removes it.
    const mode = session.interactionMode;
    if (applied.mode !== mode) {
      for (const candidate of PROCEDURE_MODES) {
        const key = modeInstructionKey(candidate)!;
        if (candidate === mode) await connection.setInstructions(nativeId, key, modeProcedure(candidate));
        else if (applied.mode === undefined || applied.mode === candidate) {
          // Removing an entry the session never had is not a failure.
          await connection.setInstructions(nativeId, key, null).catch(() => undefined);
        }
      }
      applied.mode = mode;
    }
  }

  /**
   * Skills and slash commands from the directory's own server
   * (`command.list`, the SDK route upstream serves — never `opencode debug
   * skill`, whose piped output truncates at 64KB). Everything there runs as
   * `/name`; `source: "skill"` marks skills, the rest are commands.
   */
  readonly skillInventory = async (cwd: string): Promise<SkillInventory> => {
    const connection = await this.connectionForSession(`moxen-skills-${cwd}` as ThreadId, cwd);
    const entries = await connection.listCommands();
    return {
      trigger: "/",
      skills: entries.filter((entry) => entry.source === "skill").map((entry) => plainSkill(entry.name, entry.description)),
      commands: entries
        .filter((entry) => entry.source !== "skill")
        .map((entry) => ({
          name: entry.name,
          description: entry.description,
          argumentHint: entry.hints.length > 0 ? entry.hints.join(" ") : null,
          builtin: false,
        })),
    };
  };

  /**
   * The latest reading. While a turn runs it is taken fresh off the server —
   * every finished step moves it — instead of waiting for the idle that ends
   * the turn, so a long turn's context indicator climbs as it goes.
   */
  readonly contextUsage = async (threadId: ThreadId): Promise<ContextWindowUsage | null> => {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    if (this.openTurn(session)) await this.refreshContext(session);
    return session.context;
  };

  /** Re-read the session's context from its newest messages; the last reading stands when the server says nothing. */
  private async refreshContext(session: OpenCodeSession): Promise<void> {
    try {
      const connection = await this.connectionFor(session);
      const messages = await connection.sessionMessages(session.nativeSessionId, { tail: IDLE_READ_ITEMS });
      const settings = await this.contextSettingsFor(session).catch(() => null);
      session.context = opencodeContextOf(messages, settings) ?? session.context;
    } catch {
      // Advisory, like every context reading.
    }
  }

  /**
   * Explicit freshness ask: re-read Go's experimental route on servers
   * already running, never start one. Other OpenCode providers have no
   * quota feed, so a directory serving only those answers nothing.
   */
  readonly refreshUsage = async (): Promise<{ key: string; windows: readonly RateLimitWindow[] } | null> => {
    for (const [directory, connection] of this.liveConnections) {
      const windows = await connection.usageLimits().catch(() => null);
      if (windows && windows.length > 0) {
        this.goUsageReadAt.set(directory, Date.now());
        return { key: OPENCODE_GO_INSTANCE, windows };
      }
    }
    return null;
  };

  /** The reading above, broken down by estimate from the session's messages. */
  readonly contextBreakdown = async (threadId: ThreadId): Promise<ContextBreakdown | null> => {
    const session = this.sessions.get(threadId);
    if (session && this.openTurn(session)) await this.refreshContext(session);
    if (!session?.context) return null;
    const connection = await this.connectionFor(session);
    // Only what the model still sees: nothing before the last compaction.
    const messages = await connection.sessionContext(session.nativeSessionId).catch(() => []);
    return opencodeContextBreakdown(session.context, messages);
  };

  // -- session lifecycle -------------------------------------------------

  readonly startSession = (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, CliError> =>
    this.attempt("OPENCODE_SPAWN_FAILED", `Could not start an OpenCode session for thread ${input.threadId}`, async () => {
      // `fresh` skips the live check once: a joiner whose start a stop
      // overlapped must not return the session that stop is closing.
      let fresh = false;
      for (;;) {
        const existing = this.sessions.get(input.threadId);
        if (existing && !existing.closed && !fresh) return this.describeSession(existing);
        fresh = false;
        // A start in flight is not in `sessions` yet: a second start for the
        // thread waits for the first instead of opening a second session.
        const pending = this.starting.get(input.threadId);
        if (!pending) {
          const aborter = new AbortController();
          const started = this.openSession(input, existing, aborter.signal);
          const entry: PendingStart = {
            promise: started.then((session) => {
              // Recorded on the captured entry (not looked up): an abandon
              // may have deleted it and a fresh start replaced it, and the
              // late resolution must not tag that entry.
              entry.session = session;
              return this.describeSession(session);
            }),
            stopping: false,
            aborter,
          };
          this.starting.set(input.threadId, entry);
          try {
            return await entry.promise;
          } finally {
            if (this.starting.get(input.threadId) === entry) this.starting.delete(input.threadId);
          }
        }
        // Join the in-flight start, waking at once if a stop abandons it. A
        // stop may have overlapped it (`stopping`): whatever it registered is
        // being closed, so loop and start fresh instead of handing back a
        // dead session — including when the join fails with that.
        try {
          await abortRace(pending.promise, pending.aborter.signal);
        } catch (cause) {
          if (!pending.stopping) throw cause;
          fresh = true;
          continue;
        }
        if (pending.stopping) {
          fresh = true;
          continue;
        }
        const joined = this.sessions.get(input.threadId);
        if (joined && !joined.closed) return this.describeSession(joined);
      }
    });

  private async openSession(input: ProviderSessionStartInput, existing: OpenCodeSession | undefined, signal: AbortSignal): Promise<OpenCodeSession> {
      this.wantedServerConfig.set(input.workingDirectory, serverShape(input.disabledNativeTools, input.moxenPrompt));
      this.reconcileServers();
      // A server that died unnoticed is dropped and replaced once, rather than failing the first message to it.
      let connection: OpencodeServerConnection;
      let resumed: OpencodeSessionState | null;
      let native: OpencodeSessionState;
      for (let attempt = 0; ; attempt += 1) {
        connection = await this.connectionForSession(input.threadId, input.workingDirectory);
        try {
          await this.registerMcpServers(connection, input.mcpServers ?? [], input.checklist !== false, input.threadId);
          // OpenCode keeps sessions on disk, so the previous one — from this
          // process or an earlier one — is reattached with its history rather
          // than replaced by an empty session.
          const cursor = existing?.nativeSessionId ?? input.resumeCursor;
          resumed = cursor ? await connection.getSession(cursor).catch((cause: unknown) => {
            if (isServerUnreachable(cause)) throw cause;
            return null;
          }) : null;
          native = resumed ?? (await connection.createSession({}));
          const excluded = excludedSkills(input.workingDirectory, "opencode");
          if (excluded.length > 0) await connection.restrictSkills(native.sessionID, excluded.map((skill) => skill.folder));
          break;
        } catch (cause) {
          if (attempt > 0 || !isServerUnreachable(cause)) throw cause;
          this.dropConnection(input.workingDirectory, connection, "it stopped answering");
        }
      }
      const nativeSessionId = native.sessionID;
      const session: OpenCodeSession = {
        threadId: input.threadId,
        nativeSessionId,
        workingDirectory: input.workingDirectory,
        isolation: input.isolation ?? null,
        closed: false,
        instanceId: input.modelSelection?.instanceId ?? "opencode",
        modelSlug: input.modelSelection?.model ?? null,
        modelOptions: input.modelSelection?.options,
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? "default",
        instructions: input.instructions ?? null,
        mcpServers: input.mcpServers ?? [],
        checklist: input.checklist !== false,
        // A session we just made has no instruction entry; a resumed one may
        // still hold the previous process's, which the first send reconciles.
        applied: { model: native.model, agent: native.agent, instructions: resumed ? undefined : null, mode: resumed ? undefined : "default" },
        turns: new Map(),
        waiters: new Map(),
        parked: new Map(),
        context: null,
        startedAt: new Date().toISOString(),
      };
      // A stop that gave up waiting abandons the start: tear down instead of
      // registering a session nobody owns. Checked on the captured signal
      // (not the map: an abandon deletes the entry, and a fresh start may
      // have replaced it), synchronously with the `set`, so no stop can slip
      // between the check and the registration.
      if (signal.aborted) {
        // Tear down only this start's own native session: the warm
        // connection stays live as a spare for the next start, and the shared
        // server is never dropped out from under sibling sessions.
        await withinMs(connection.abortSession(nativeSessionId).catch(() => undefined), this.abortWaitMs);
        throw new CliError("OPENCODE_START_ABANDONED", `Start for thread ${input.threadId} was abandoned by a stop.`, {
          details: { threadId: input.threadId },
        });
      }
      this.sessions.set(input.threadId, session);
      // A Go thread learns its plan from the server it just started or attached to,
      // without making the first message wait for that reading.
      this.refreshGoUsage(session);
      return session;
  }

  readonly resumeCursor = (threadId: ThreadId): string | null =>
    this.sessions.get(threadId)?.nativeSessionId ?? null;

  /**
   * `/btw` through OpenCode's own `session.generate`: the session's context
   * and model, a single reply, nothing written to its history. It runs beside
   * the thread's turn, so no fork is needed.
   */
  readonly sideQuestion = async (input: SideQuestionInput): Promise<SideAnswer> => {
    const connection = await this.connectionForSession(`btw:${input.cursor ?? "none"}` as ThreadId, input.workingDirectory);
    const prompt = input.cursor ? `${SIDE_QUESTION_RULES}\n\nQuestion: ${input.question}` : input.question;
    const text = await connection.generate(input.cursor, prompt);
    if (!text) throw new CliError("SIDE_QUESTION_FAILED", "The side question came back empty.");
    return { text, withContext: input.cursor !== null };
  };

  /**
   * A prompt improvement request: OpenCode's stateless `generate.text`,
   * which takes a prompt and a model and nothing else — no session, history,
   * agent, MCP server or tool. The model is the `provider/model` address the
   * catalog lists.
   */
  readonly completeText = async (input: TextCompletionInput): Promise<string> => {
    input.signal?.throwIfAborted();
    const model = parseOpencodeModel({ instanceId: "opencode", model: input.model });
    if (model === null) throw new CliError("TEXT_COMPLETION_FAILED", `OpenCode needs a model address like provider/model; "${input.model}" is not one.`);
    const connection = await this.connectionForSession(`complete:${input.workingDirectory}` as ThreadId, input.workingDirectory);
    const text = await connection.generateText(`${input.instructions}\n\n${input.prompt}`, model, input.signal);
    if (text.trim() === "") throw new CliError("TEXT_COMPLETION_FAILED", "Text completion came back empty.");
    return text;
  };

  readonly sessionTitle = async (cursor: string, workingDirectory: string): Promise<string | null> =>
    await (await this.connectionForSession(`title:${cursor}` as ThreadId, workingDirectory)).sessionTitle(cursor);

  readonly renameSession = async (cursor: string, workingDirectory: string, title: string): Promise<void> => {
    await (await this.connectionForSession(`title:${cursor}` as ThreadId, workingDirectory)).renameSession(cursor, title);
  };

  readonly regenerateSessionTitle = async (cursor: string, workingDirectory: string): Promise<string | null> =>
    await (await this.connectionForSession(`title:${cursor}` as ThreadId, workingDirectory)).regenerateSessionTitle(cursor);

  /** A whole copy of a native session, on the server for `workingDirectory` (where it lives). */
  readonly forkSession = async (cursor: string, workingDirectory: string): Promise<string> => {
    const connection = await this.connectionForSession(`fork:${cursor}` as ThreadId, workingDirectory);
    return (await connection.forkSession(cursor)).sessionID;
  };

  readonly sendTurn = (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, CliError> =>
    this.attempt("OPENCODE_TURN_FAILED", `Could not send a turn on thread ${input.threadId}`, async () => {
      const session = this.requireSession(input.threadId);
      if (this.openTurn(session)) {
        throw new CliError("TURN_BUSY", `Thread ${input.threadId} already has a running turn.`, {
          details: { threadId: input.threadId },
        });
      }
      if (input.modelSelection) {
        session.instanceId = input.modelSelection.instanceId;
        session.modelSlug = input.modelSelection.model;
        session.modelOptions = input.modelSelection.options;
      }
      const model = session.modelSlug
        ? parseOpencodeModel(
          { instanceId: session.instanceId, model: session.modelSlug },
          session.instanceId,
        )
        : null;
      const userMessageId = newOpencodeMessageId();
      const turn: OpenCodeTurn = {
        id: `turn-${randomUUID()}`,
        prompt: input.prompt,
        userMessageId,
        steerMessageIds: new Set(),
        status: "running",
        text: "",
        error: null,
        partTexts: new Map(),
        lastTextMessageId: null,
        credentialHint: null,
        usage: emptyUsage(),
        lastActivityAt: Date.now(),
        activeTools: new Set(),
        interrupting: false,
        interruptAcked: false,
        interruptAck: null,
        ...(isCompactCommand(input.prompt) ? { compacting: true } : {}),
      };
      session.turns.set(turn.id, turn);
      try {
        const connection = await this.connectionFor(session);
        // A replacement server (see `dropConnection`) has lost the runtime MCP registrations.
        await this.registerMcpServers(connection, session.mcpServers, session.checklist, session.threadId);
        turn.credentialHint = await this.missingCredentialHint(model, connection);
        await this.applySessionState(session, connection, model, input.interactionMode, turn.credentialHint);
        if (turn.compacting) {
          // Accepted, not done: `session.compaction.ended` (see `onCompacted`) ends the turn.
          await connection.summarizeSession(session.nativeSessionId);
        } else await connection.prompt({
          sessionID: session.nativeSessionId,
          messageID: userMessageId,
          text: input.prompt,
          files: (input.images ?? []).map((image) => ({
            uri: `data:${image.mimeType};base64,${image.data}`,
            name: image.name,
          })),
        });
      } catch (cause) {
        this.clearStallTimer(turn.id);
        session.turns.delete(turn.id);
        throw cause;
      }
      this.armStallTimer(session, turn);
      return { threadId: input.threadId, turnId: turn.id };
    });

  /**
   * Setup hint for a model whose provider looks uncredentialed here —
   * advisory only, never a gate.
   *
   * An earlier version blocked the send outright, on the theory that the
   * server accepts credential-less prompts and then goes silent. It does
   * not: it answers `session.error` within seconds ("Model not found:
   * <provider>/<model>" when the provider never loaded, or a 401 for a
   * rejected key). The silence that motivated the gate came from our own
   * vendored plugin modules, which no longer exist (v2 has the ChatGPT and
   * SuperGrok logins built in).
   *
   * Blocking on this guess is strictly worse than letting the server
   * answer, because the guess only models two of the credential
   * arrangements upstream honors — `env[]` names and stored logins — and
   * misses `opencode.json`'s `provider.<id>.options.apiKey`, OAuth stored
   * under another id, and anything a newer catalog adds.
   * Each miss blocks a model the server would have served: exactly the
   * `opencode/muse-spark-1.3-contributor-free` report this replaced.
   *
   * So we keep only the useful half — the actionable setup step — and
   * attach it to the server's own failure. Computed at send time, where
   * the model is known; null whenever the provider is unknown to the
   * pinned snapshot (the server decides those) or credentialed, and for
   * free `opencode` models, which upstream serves with `apiKey: "public"`
   * and no credential at all (see `isFreeOpencodeModel`).
   */
  private async missingCredentialHint(
    model: { providerID: string; modelID: string } | null,
    connection: OpencodeServerConnection,
  ): Promise<string | null> {
    if (!model) return null;
    if (await isFreeOpencodeModel(model.providerID, model.modelID)) return null;
    const envNames = await providerEnvNames(model.providerID);
    if (envNames === null) return null;
    // Renamed provider ids (`azure-cognitive-services` → `azure`, …) count as the same credential.
    const stored = await this.storedAuthTypes(connection);
    if (storedAuthTypeFor(stored, model.providerID) !== undefined) return null;
    if (envNames.some((name) => (this.baseEnv[name] ?? "").trim().length > 0)) return null;
    const how = envNames.length > 0
      ? `set ${envNames.join(" or ")}`
      : "add an API key";
    return `No credential found for provider "${model.providerID}" — ${how}, or run \`opencode auth login\`.`;
  }

  /**
   * Credential types as the server we already talk to knows them (connection
   * types only). Only when that cannot answer do we run the CLI, which is
   * async, `--standalone` and cached (see `readStoredAuthTypes`).
   */
  private async storedAuthTypes(connection: OpencodeServerConnection): Promise<Record<string, string>> {
    try {
      return await connection.storedAuthTypes();
    } catch {
      return await readStoredAuthTypes(this.baseEnv, { binaryPath: this.settings.binaryPath });
    }
  }

  /**
   * Cancel what this turn still has queued on the server: its own prompt and
   * any steer that was not yet delivered. An interrupt discards the turn, so
   * a leftover steer must not reach the model with the next turn. Delivered
   * items cannot be cancelled; those requests fail and are ignored.
   */
  private async cancelQueuedInput(session: OpenCodeSession, connection: OpencodeServerConnection, turn: OpenCodeTurn): Promise<void> {
    const ids = [turn.userMessageId, ...turn.steerMessageIds];
    await Promise.all(ids.map((id) => connection.cancelInbox(session.nativeSessionId, id).catch(() => undefined)));
  }

  readonly interruptTurn = (threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, CliError> =>
    this.attempt("OPENCODE_TURN_FAILED", `Could not interrupt the turn on thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      const turn = this.openTurn(session);
      if (turn) turn.interrupting = true;
      // Parked permission/question prompts hold the turn open server-side;
      // reject them first so abort settles instead of hanging.
      // Only a connection that needs no spawn can have anything to stop:
      // never start a server just to deliver an abort.
      const connection = await this.connectionForAbort(session);
      await this.rejectParked(session, connection);
      if (connection) {
        try {
          // Every wait here is bounded: a wedged server must not hang the interrupt.
          if (turn) await withinMs(this.cancelQueuedInput(session, connection, turn), this.abortWaitMs);
          await withinMs(connection.abortSession(session.nativeSessionId), this.abortWaitMs);
          // The parent's turn is waiting on its subagents (a foreground call
          // returns only when its child does), and aborting the parent does not
          // reach them: they would run on, unseen. Stop them with it.
          await withinMs(this.stopChildren(session, connection), this.abortWaitMs);
        } catch (cause) {
          if (!session.closed) throw cause;
        }
      }
      // The server confirms an interrupt with its own event, which arrives
      // after this call returns. Settling before it would let a prompt sent
      // right away be completed by the old run's confirmation.
      // (It may already have: the event can beat the HTTP reply.)
      // Without a connection no server can confirm: settle at once. An abort
      // that timed out still waits below: its late confirmation must not
      // complete the next turn.
      if (connection && turn && turn.status === "running" && !turn.interruptAcked) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.interruptAckTimeoutMs);
          (timer as { unref?: () => void }).unref?.();
          turn.interruptAck = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      if (!turn || this.openTurn(session) === turn) {
        // What the aborted run still has in flight is not a new run.
        session.ignoreOutputUntil = Date.now() + this.interruptTailMs;
        this.settleOpenTurn(session, "interrupted", "Interrupted.");
      }
    });

  /**
   * Abort a native subagent's own session — OpenCode's server runs it apart
   * from its parent's — and report it stopped: nothing else will, as an
   * aborted child ends without the idle its background form is watched by.
   */
  private async stopChild(connection: OpencodeServerConnection, childId: string, child: OpenCodeChild): Promise<void> {
    child.stopped = true;
    await connection.abortSession(childId).catch(() => undefined);
    this.publishSubagent(child, childId, this.openTurn(child.parent)?.id ?? null, "stopped", null);
  }

  private async stopChildren(session: OpenCodeSession, connection: OpencodeServerConnection): Promise<void> {
    const running = [...this.children].filter(([, child]) => child.parent === session && !child.stopped);
    await Promise.all(running.map(([childId, child]) => this.stopChild(connection, childId, child)));
  }

  /**
   * The background work this thread's session is still running: background
   * subagents and background `shell` commands. Only what the server told
   * this driver about — a shell background process started any other way
   * is invisible here — so callers must never read an empty list as proof
   * that nothing is running.
   */
  readonly backgroundTasks = (threadId: ThreadId): readonly BackgroundTaskSummary[] => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return [];
    const agents = [...this.children]
      .filter(([, other]) => other.parent === session && other.background && !other.stopped)
      .map(([taskId, other]) => ({ taskId, taskType: "local_agent", description: other.description ?? other.agentType, toolName: "Agent" }));
    const shells = [...(session.backgroundShells ?? [])].map(([taskId, shell]) => ({
      taskId,
      taskType: "local_bash",
      description: shell.command.split("\n")[0]?.trim() ?? "",
      toolName: "Bash",
      command: shell.command,
      startedAt: shell.startedAt,
    }));
    return [...agents, ...shells];
  };

  /**
   * Stop one background task without touching its parent turn: a native
   * subagent's call comes back with whatever the child had, and carries on;
   * a background command is killed and the model is told it ended.
   */
  readonly stopBackgroundTask = (threadId: ThreadId, taskId: string): Effect.Effect<void, CliError> =>
    this.attempt("OPENCODE_TASK_STOP_FAILED", `Could not stop background task ${taskId}`, async () => {
      const session = this.requireSession(threadId);
      const child = this.children.get(taskId);
      if (child && child.parent === session && !child.stopped) {
        await this.stopChild(await this.connectionFor(session), taskId, child);
        return;
      }
      const shell = session.backgroundShells?.get(taskId);
      if (shell) {
        await (await this.connectionFor(session)).stopShell(taskId);
        // The server's own `shell.exited` follows; saying so now keeps the panel from showing a dead command.
        this.onBackgroundShell(session, { type: "session.shell.ended", properties: { sessionID: session.nativeSessionId, shellID: taskId, command: shell.command, status: "killed" } });
        return;
      }
      throw new CliError("BACKGROUND_TASK_NOT_FOUND", `No background task ${taskId} is running on thread ${threadId}.`, {
        exitCode: 3,
        details: { threadId, taskId },
      });
    });

  async awaitTurn(threadId: ThreadId, turnId: TurnId, signal?: AbortSignal): Promise<OpenCodeTurnOutcome> {
    const session = this.requireSession(threadId);
    const turn = session.turns.get(turnId);
    if (!turn) {
      throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turnId}.`, {
        details: { threadId, turnId },
      });
    }
    if (turn.status !== "running") {
      return { status: turn.status, text: turn.text, usage: turn.usage, ...(generationOf(turn) ? { generation: generationOf(turn)! } : {}), error: turn.error };
    }
    if (signal?.aborted === true) {
      throw new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {
        details: { threadId, turnId },
      });
    }
    return await new Promise<OpenCodeTurnOutcome>((resolve, reject) => {
      const waiter: { resolve: (outcome: OpenCodeTurnOutcome) => void; reject: (cause: unknown) => void; signal?: AbortSignal; onAbort?: () => void } = { resolve, reject };
      const list = session.waiters.get(turnId) ?? [];
      list.push(waiter);
      session.waiters.set(turnId, list);
      if (signal) {
        const onAbort = (): void => {
          dropTurnWaiter(session.waiters.get(turnId) ?? [], waiter);
          reject(
            new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {
              details: { threadId, turnId },
            }),
          );
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  readonly respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Effect.Effect<void, CliError> =>
    this.attempt("OPENCODE_REQUEST_FAILED", `Could not answer permission request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      const parked = session.parked.get(requestId);
      if (!parked) {
        throw new CliError("REQUEST_UNKNOWN", `No pending permission request ${requestId}.`, {
          details: { threadId, requestId },
        });
      }
      // A *dismissed question* arrives here, not only a miscalled
      // permission: the panel closes a question the same way it declines a
      // permission, and the request is still blocking the server. Replying
      // with no answers releases the turn — throwing left it parked until
      // the next interrupt.
      if (parked.kind === "question") {
        if (decision.kind !== "decline" && decision.kind !== "cancel") {
          // Accepting is a miscall: there is no answer to accept.
          throw new CliError("REQUEST_MISMATCH", `Request ${requestId} needs user input, not a permission decision.`, {
            details: { threadId, requestId },
          });
        }
        const connection = await this.connectionFor(session);
        // Cancelling the form is how v2 says "no answer"; a reply with none is invalid.
        await connection.rejectQuestion(session.nativeSessionId, parked.nativeId);
        session.parked.delete(requestId);
        this.publish({ type: "user-input.request.resolved", provider: this.provider, threadId, requestId });
        return;
      }
      if (parked.kind !== "permission") {
        throw new CliError("REQUEST_MISMATCH", `Request ${requestId} needs user input, not a permission decision.`, {
          details: { threadId, requestId },
        });
      }
      const connection = await this.connectionFor(session);
      const reply = decision.kind === "accept"
        ? ("once" as const)
        : decision.kind === "acceptForSession"
          ? ("always" as const)
          : ("reject" as const);
      await connection.replyToPermission(session.nativeSessionId, parked.nativeId, reply);
      session.parked.delete(requestId);
      this.publish({ type: "permission.request.resolved", provider: this.provider, threadId, requestId });
    });

  readonly respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, CliError> =>
    this.attempt("OPENCODE_REQUEST_FAILED", `Could not answer user input request ${requestId}`, async () => {
      const session = this.requireSession(threadId);
      const parked = session.parked.get(requestId);
      if (!parked) {
        throw new CliError("REQUEST_UNKNOWN", `No pending user input request ${requestId}.`, {
          details: { threadId, requestId },
        });
      }
      if (parked.kind !== "question") {
        throw new CliError("REQUEST_MISMATCH", `Request ${requestId} needs a permission decision, not user input.`, {
          details: { threadId, requestId },
        });
      }
      const connection = await this.connectionFor(session);
      await connection.replyToQuestion(session.nativeSessionId, parked.nativeId, answersFor(answers, parked.detail));
      session.parked.delete(requestId);
      this.publish({ type: "user-input.request.resolved", provider: this.provider, threadId, requestId });
    });

  readonly stopSession = (threadId: ThreadId): Effect.Effect<void, CliError> =>
    this.attempt("OPENCODE_STOP_FAILED", `Could not stop the OpenCode session for thread ${threadId}`, async () => {
      // A start in flight is not in `sessions` yet: wait for its outcome
      // bounded, then stop what it made. On timeout the start is abandoned:
      // its late resolution tears itself down instead of registering.
      const entry = this.starting.get(threadId);
      if (entry) {
        // Marked before waiting: a joiner resolving alongside this stop
        // starts fresh, since whatever this start registers is closed below.
        entry.stopping = true;
        await this.awaitStarts([entry]);
        // Still registered means still unsettled (only the wrapper or an
        // abandon deletes); a start that settled just in time is stopped below.
        if (this.starting.get(threadId) === entry) this.abandonStart(threadId, entry);
      }
      const session = this.sessions.get(threadId);
      if (!session || session.closed) return;
      // A stop that overlapped a start closes only that start's session: a
      // joiner's fresh start that already replaced it is not this stop's.
      if (entry?.session && session !== entry.session) return;
      session.closed = true;
      this.settleOpenTurn(session, "interrupted", "Session stopped.");
      // Best effort and bounded, and never a reason to spawn a server: the server may already be gone.
      const connection = await this.connectionForAbort(session);
      if (connection) {
        try {
          await withinMs(connection.abortSession(session.nativeSessionId), this.abortWaitMs);
        } catch {
          // Best effort: the server may already be gone.
        }
      }
      // A successor may have registered while the abort was awaited: delete
      // only the session this stop closed.
      if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
      this.transferMoxenEntry(session);
    });

  /**
   * Ownership of the directory's `moxen` entry follows liveness, without
   * touching the entry itself (re-registering would restart the server and
   * kill in-flight calls): when the owning thread's session closes, the
   * earliest surviving session on the server may re-register it when its own
   * spec changes. With no live session left the next start registers fresh.
   * The entry's own config — and so the fallback for a call without session
   * identity — stays the first owner's until anything re-registers.
   */
  private transferMoxenEntry(session: OpenCodeSession): void {
    const connection = this.liveConnections.get(session.workingDirectory);
    const entry = connection ? this.moxenEntry.get(connection) : undefined;
    if (!connection || !entry || entry.owner !== session.threadId) return;
    const heir = [...this.sessions.values()].find(
      (candidate) => !candidate.closed && candidate.workingDirectory === session.workingDirectory,
    );
    if (heir) this.moxenEntry.set(connection, { owner: heir.threadId, key: entry.key });
    else this.moxenEntry.delete(connection);
  }

  readonly listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.succeed([...this.sessions.values()].filter((session) => !session.closed).map((session) => this.describeSession(session)));

  readonly hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(this.sessions.get(threadId)?.closed === false);

  readonly readThread = (threadId: ThreadId): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("OPENCODE_READ_FAILED", `Could not read the OpenCode thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      const connection = await this.connectionFor(session);
      const messages = await connection.sessionMessages(session.nativeSessionId);
      return {
        threadId,
        turns: messages.flatMap((message) => {
          const id = asString(message.info.id);
          if (!id) return [];
          return [{ id, items: [...message.parts] }];
        }),
      };
    });

  readonly rollbackThread = (threadId: ThreadId, numTurns: number): Effect.Effect<ProviderThreadSnapshot, CliError> =>
    this.attempt("OPENCODE_ROLLBACK_FAILED", `Could not roll back the OpenCode thread ${threadId}`, async () => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        throw new CliError("INVALID_ROLLBACK", "numTurns must be an integer >= 1.", {
          details: { threadId, numTurns },
        });
      }
      const session = this.requireSession(threadId);
      if (this.openTurn(session)) {
        throw new CliError("TURN_BUSY", `Thread ${threadId} already has a running turn.`, {
          details: { threadId },
        });
      }
      const connection = await this.connectionFor(session);
      // A turn is one user message plus its replies; `session.fork` copies
      // every message *before* the one named, so the fork point is the
      // first user message to drop.
      const messages = await connection.sessionMessages(session.nativeSessionId);
      const prompts = messages.flatMap((message) => {
        const id = asString(message.info.id);
        return id && message.info.role === "user" ? [id] : [];
      });
      if (prompts.length < numTurns) {
        throw new CliError("ROLLBACK_UNAVAILABLE", "Cannot roll back more turns than the session holds.", {
          details: { threadId, numTurns, turns: prompts.length },
        });
      }
      const forkPoint = prompts[prompts.length - numTurns];
      const previous = session.applied;
      const forked = await connection.forkSession(session.nativeSessionId, forkPoint);
      session.nativeSessionId = forked.sessionID;
      // The fork copies the session's state (instructions included); what the
      // server does not report about it is what it was.
      session.applied = {
        model: forked.model ?? previous.model,
        agent: forked.agent ?? previous.agent,
        instructions: previous.instructions,
        mode: previous.mode,
      };
      return await Effect.runPromise(this.readThread(threadId));
    });

  readonly stopAll = (): Effect.Effect<void, CliError> =>
    Effect.tryPromise({
      try: async () => {
        // A start in flight is not in `sessions` yet: wait for the outcomes
        // bounded, then stop what they made. Timed-out starts are abandoned:
        // their late resolutions tear themselves down instead of registering.
        const entries = [...this.starting.entries()];
        if (entries.length > 0) {
          for (const [, entry] of entries) entry.stopping = true;
          await this.awaitStarts(entries.map(([, entry]) => entry));
          for (const [threadId, entry] of entries) {
            if (this.starting.get(threadId) === entry) this.abandonStart(threadId, entry);
          }
        }
        for (const session of this.sessions.values()) {
          session.closed = true;
          this.settleOpenTurn(session, "interrupted", "Driver stopped.");
        }
        this.sessions.clear();
        for (const pump of this.pumps.values()) pump.controller.abort();
        this.pumps.clear();
        // Disposing is parallel and never awaited one by one: a wedged
        // establish must not hang the stop. Settled servers are disposed now;
        // a late success finds its pending discarded and disposes itself
        // (see `connectionForSession`) instead of registering.
        const pendings = [...this.connections.entries()];
        const live = [...this.liveConnections.values()];
        this.connections.clear();
        this.liveConnections.clear();
        for (const [, pending] of pendings) this.discarded.add(pending);
        const disposeBy = Date.now() + STOP_DISPOSE_BUDGET_MS;
        await Promise.allSettled(
          live.map((connection) => withinMs(connection.dispose(), Math.max(0, disposeBy - Date.now()))),
        );
        // Signal completion on the event stream: buffered events are still
        // delivered, the stream then ends so the pump in `threads/execute.ts`
        // releases its fiber instead of waiting on a driver that is gone.
        // Offers after this return false and are dropped, never a crash.
        Effect.runSync(Queue.end(this.queue));
      },
      catch: (cause) => toCliError("OPENCODE_STOP_FAILED", "Could not stop the OpenCode driver", cause),
    });

  // -- event pump ----------------------------------------------------------

  /**
   * The one event pump per server, demuxed by session. Resolves once the
   * subscription is live (v2 replays nothing, so nothing may be sent before
   * that); a pump whose start fails (no first frame, lost stream) rejects,
   * so the caller fails instead of sending once on a dead connection. The
   * dead server is dropped, so the next call starts a fresh one — with no
   * retry loop against a server that keeps failing.
   */
  private ensurePump(key: string, connection: OpencodeServerConnection): Promise<void> {
    const existing = this.pumps.get(key);
    if (existing) return existing.ready;
    const controller = new AbortController();
    let markReady!: () => void;
    let failReady!: (cause: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    const entry = { controller, ready, done: Promise.resolve() };
    this.pumps.set(key, entry);
    entry.done = (async () => {
      try {
        const subscription = await connection.subscribeEvents({ signal: controller.signal });
        markReady();
        // Enqueue only: the shared iterator waits for this loop, and a
        // subscriber that falls behind is cut off, so handlers never await.
        for await (const event of subscription.stream) {
          if (controller.signal.aborted) break;
          this.onServerEvent(event, key);
        }
        if (!controller.signal.aborted) this.onPumpLost(key, "the stream ended");
      } catch (cause) {
        // A stop aborts the pump: that is shutdown, not a failure.
        if (controller.signal.aborted) markReady();
        else {
          this.onPumpLost(key, cause instanceof Error ? cause.message : String(cause));
          failReady(cause);
        }
      } finally {
        if (this.pumps.get(key) === entry) this.pumps.delete(key);
      }
    })();
    return ready;
  }

  private onPumpLost(key: string, reason: string): void {
    this.failServerTurns(key, `Lost the OpenCode event stream (${reason.slice(0, 200)}).`);
    // A server whose stream died is not trusted again: the next call starts a fresh one.
    const connection = this.liveConnections.get(key);
    if (connection) this.dropConnection(key, connection, `event stream lost: ${reason}`);
  }

  private failServerTurns(key: string, message: string): void {
    this.onServerError(key, { type: "session.error", properties: { error: { message } } });
  }

  private sessionForNative(nativeSessionId: string): OpenCodeSession | null {
    for (const session of this.sessions.values()) {
      if (!session.closed && session.nativeSessionId === nativeSessionId) return session;
    }
    return null;
  }

  private onServerEvent(event: OpencodeSubscribedEvent, serverKey: string): void {
    const nativeSessionId = asString(event.properties.sessionID);
    if (!nativeSessionId) {
      // A fault with no session attached: v2's `location.shutdown`, or a
      // lost event stream (both arrive as `session.error`, see `translate.ts`
      // and `ensurePump`). Dropping those strands every turn on that server
      // until the stall watchdog fires, ten minutes later, with nothing to
      // show for it.
      if (event.type === "session.error") this.onServerError(serverKey, event);
      return;
    }
    const session = this.sessionForNative(nativeSessionId);
    if (!session) {
      // A subagent working is its parent's turn working: the parent's call is waiting on it.
      const child = this.children.get(nativeSessionId);
      const waiting = child ? this.openTurn(child.parent) : null;
      if (waiting) waiting.lastActivityAt = Date.now();
      this.onChildEvent(nativeSessionId, event, serverKey);
      return;
    }
    if (!this.openTurn(session)) this.adoptBackgroundTurn(session, event);
    const active = this.openTurn(session);
    if (active) active.lastActivityAt = Date.now();
    switch (event.type) {
      case "generation.measured": {
        const turn = this.openTurn(session);
        const { id, characters, start, end } = event.properties;
        if (turn && typeof id === "string" && typeof characters === "number" && typeof start === "number" && typeof end === "number") {
          (turn.generationParts ??= new Map()).set(id, { characters, start, end });
        }
        return;
      }
      case "message.part.updated":
        this.onPartUpdated(session, event);
        break;
      case "permission.asked":
        this.onPermissionAsked(session, event);
        break;
      case "question.asked":
        this.onQuestionAsked(session, event);
        break;
      case "permission.replied":
        this.onRequestSettled(session, asString(event.properties.requestID), "permission");
        break;
      case "question.replied":
      case "question.rejected":
        this.onRequestSettled(session, asString(event.properties.requestID), "question");
        break;
      case "session.idle":
        this.onSessionIdle(session);
        break;
      case "session.interrupted":
        this.onSessionInterrupted(session, event);
        break;
      case "session.error":
        this.onSessionError(session, event);
        break;
      case "session.compacted":
        this.onCompacted(session, event);
        break;
      case "session.shell.started":
      case "session.shell.ended":
        this.onBackgroundShell(session, event);
        break;
      default:
        break;
    }
  }

  /**
   * The server finished compacting the session. Said in the transcript
   * whoever asked (a `/compact` turn, or the server's own threshold); a
   * `/compact` turn ends here, since a bare compaction may never run a
   * model step to go idle on.
   */
  private onCompacted(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const open = this.openTurn(session);
    const summary = asString(event.properties.summary);
    this.publish({
      type: "session.notice",
      provider: this.provider,
      threadId: session.threadId,
      turnId: open?.id ?? null,
      notice: "compacted",
      title: event.properties.reason === "auto" ? "Conversation compacted automatically" : "Conversation compacted",
      detail: summary,
    });
    if (open?.compacting) this.settleOpenTurn(session, "completed", "");
    else if (open?.rescuing) void this.continueAfterOverflow(session, open);
  }

  /**
   * A request was rejected as too long. OpenCode's own recovery is off (Moxen
   * runs the compaction), so Moxen compacts and carries the task on, once per
   * turn: a second rejection, or a compaction that fails, ends the turn with
   * the error.
   */
  private rescueOverflow(session: OpenCodeSession, message: string): boolean {
    const turn = this.openTurn(session);
    if (!turn || turn.overflowRescued || turn.compacting || !isContextOverflowText(message)) return false;
    turn.overflowRescued = true;
    turn.rescuing = true;
    void this.connectionFor(session)
      .then((connection) => connection.summarizeSession(session.nativeSessionId))
      .catch((cause: unknown) => {
        turn.rescuing = false;
        this.settleOpenTurn(session, "failed", `${message.slice(0, 300)} (compacting to make room failed: ${cause instanceof Error ? cause.message : String(cause)})`.slice(0, 500));
      });
    return true;
  }

  private async continueAfterOverflow(session: OpenCodeSession, turn: OpenCodeTurn): Promise<void> {
    const messageID = newOpencodeMessageId();
    // Registered before the send so no echoed part is read as answer text.
    turn.steerMessageIds.add(messageID);
    try {
      const connection = await this.connectionFor(session);
      await connection.prompt({ sessionID: session.nativeSessionId, messageID, text: CONTINUE_AFTER_OVERFLOW });
      // Only now: an idle from the compaction itself, arriving before the server
      // took the continue prompt, would otherwise read the turn as answered.
      turn.rescuing = false;
    } catch (cause) {
      turn.rescuing = false;
      turn.steerMessageIds.delete(messageID);
      this.settleOpenTurn(session, "failed", `The conversation was compacted, but the task could not be continued: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500));
    }
  }

  /**
   * Whether a message is one of our own prompts (or steers): its parts are our
   * words coming back, never the model's.
   */
  private isOwnMessage(session: OpenCodeSession, messageId: string): boolean {
    for (const turn of session.turns.values()) {
      if (turn.userMessageId === messageId || turn.steerMessageIds.has(messageId)) return true;
    }
    return false;
  }

  /**
   * The server went on working with no turn of ours open: a background
   * subagent finished and woke its parent, or the loop took another step after
   * an idle. Its output used to be dropped here — a reply that stopped
   * partway, with the rest (and its tool calls) never shown. It becomes a turn
   * the provider started on its own, the way Claude Code's wake-ups do.
   */
  private adoptBackgroundTurn(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    if (event.type !== "message.part.updated" || session.closed) return;
    if (session.ignoreOutputUntil !== undefined && Date.now() < session.ignoreOutputUntil) return;
    const part = asRecord(event.properties.part);
    const kind = asString(part?.type);
    const messageId = asString(part?.messageID);
    if (!part || (kind !== "text" && kind !== "reasoning" && kind !== "tool") || !messageId || this.isOwnMessage(session, messageId)) return;
    // A step the session has not seen: the loop going on. The trailing updates of a message it already
    // handled arrive after its turn settles too, and are not.
    if (session.seenMessageIds?.has(messageId)) return;
    const turn: OpenCodeTurn = {
      id: `turn-${randomUUID()}`,
      prompt: "",
      userMessageId: "",
      steerMessageIds: new Set(),
      status: "running",
      text: "",
      error: null,
      partTexts: new Map(),
      lastTextMessageId: null,
      credentialHint: null,
      usage: emptyUsage(),
      lastActivityAt: Date.now(),
      activeTools: new Set(),
      interrupting: false,
      interruptAcked: false,
      interruptAck: null,
    };
    session.turns.set(turn.id, turn);
    this.armStallTimer(session, turn);
    this.publish({ type: "turn.started", provider: this.provider, threadId: session.threadId, turnId: turn.id, origin: "background", wakeUpPrompt: JSON.stringify(event) });
  }

  /**
   * The model's thinking summary: a `running` row as it starts, its text as
   * it streams, and a `completed` row with the whole of it and how long it
   * took. Without this a normal thread showed no thinking at all — only a
   * subagent's, read back from its stored messages.
   */
  private onReasoningPart(session: OpenCodeSession, turn: OpenCodeTurn, partId: string, part: Record<string, unknown>): void {
    const shown = (turn.reasoningTexts ??= new Map());
    const text = typeof part.text === "string" ? part.text : "";
    const time = asRecord(part.time) ?? {};
    const start = typeof time.start === "number" ? time.start : null;
    const end = typeof time.end === "number" ? time.end : null;
    const startedAt = new Date(start ?? Date.now()).toISOString();
    const base = { provider: this.provider, threadId: session.threadId, turnId: turn.id, reasoningId: partId } as const;
    const previous = shown.get(partId);
    if (previous === undefined) {
      this.publish({ type: "reasoning.updated", ...base, status: "running", text: "", startedAt, durationMs: null });
    }
    const delta = text.startsWith(previous ?? "") ? text.slice((previous ?? "").length) : text;
    shown.set(partId, text);
    if (delta) this.publish({ type: "reasoning.delta", ...base, text: delta });
    if (asString(asRecord(part.state)?.status) === "completed") {
      if (start !== null && end !== null && end > start && text.length > 0) {
        (turn.generationParts ??= new Map()).set(partId, { characters: text.length, start, end });
      }
      this.publish({
        type: "reasoning.updated",
        ...base,
        status: "completed",
        text,
        startedAt,
        durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      });
    }
  }

  private onPartUpdated(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const part = asRecord(event.properties.part);
    if (!part) return;
    const turn = this.openTurn(session);
    if (!turn) return;
    // Our own prompt streams back as parts of the user message; never
    // accumulate those into the assistant text.
    const messageId = asString(part.messageID);
    if (messageId) (session.seenMessageIds ??= new Set()).add(messageId);
    if (messageId === turn.userMessageId || (messageId && turn.steerMessageIds.has(messageId))) return;
    const partId = asString(part.id) ?? `part-${turn.partTexts.size}`;
    const kind = asString(part.type) ?? "unknown";
    if (kind === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      const messageId = asString(part.messageID) ?? "opencode-message";
      // Parts stream as cumulative snapshots; subscribers want the delta.
      const previous = turn.partTexts.get(partId)?.text ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      if (part.ignored !== true) {
        // A new step speaking means the previous step's text was a note.
        if (text && turn.lastTextMessageId !== null && turn.lastTextMessageId !== messageId) {
          const note = [...turn.partTexts.values()]
            .filter((entry) => entry.messageId === turn.lastTextMessageId)
            .map((entry) => entry.text)
            .join("");
          if (note.trim()) {
            this.publish({
              type: "assistant.note",
              provider: this.provider,
              threadId: session.threadId,
              turnId: turn.id,
              messageId: turn.lastTextMessageId,
              text: note,
            });
          }
        }
        if (text) turn.lastTextMessageId = messageId;
        turn.partTexts.set(partId, { messageId: asString(part.messageID), text });
        turn.text = answerText(turn.partTexts);
      }
      if (delta) {
        this.publish({
          type: "message.part.updated",
          provider: this.provider,
          threadId: session.threadId,
          turnId: turn.id,
          messageId,
          text: delta,
          raw: part,
        });
      }
      return;
    }
    if (kind === "reasoning") {
      this.onReasoningPart(session, turn, partId, part);
      return;
    }
    if (kind === "tool") {
      const tool = asString(part.tool ?? part.name) ?? "tool";
      // The part's own `state.status` is the lifecycle, not the channel it
      // arrives on: every tool part streams as `message.part.updated`, so
      // publishing a flat `updated` left subscribers unable to tell a
      // started call from a finished one.
      const status = asString(asRecord(part.state)?.status);
      const callId = asString(part.callID) ?? asString(part.id);
      if (callId !== null) {
        if (status === "completed" || status === "error") turn.activeTools.delete(callId);
        else turn.activeTools.add(callId);
      }
      this.publish({
        type: status === "completed" || status === "error"
          ? "tool.execute.completed"
          : status === "pending"
            ? "tool.execute.started"
            : "tool.execute.updated",
        provider: this.provider,
        threadId: session.threadId,
        turnId: turn.id,
        tool,
        raw: part,
      });
      if (tool === "subagent") this.onSubagentCall(session, turn.id, part);
    }
  }

  /**
   * OpenCode's `subagent` tool runs a child session: a native subagent. Its
   * first progress update names the child (`metadata.sessionID`). A
   * foreground call ends with the child's report as its result; a
   * background call returns at launch, so its child's own idle ends it.
   */
  private onSubagentCall(session: OpenCodeSession, turnId: TurnId, part: Record<string, unknown>): void {
    const state = asRecord(part.state) ?? {};
    const childId = asString(asRecord(state.metadata)?.sessionID);
    const input = asRecord(state.input) ?? {};
    const status = asString(state.status);
    const finished = status === "completed" || status === "error";
    if (!childId) return;
    let child = this.children.get(childId);
    if (!child) {
      child = {
        parent: session,
        agentType: asString(input.agent) ?? "subagent",
        description: asString(input.description),
        background: input.background === true,
        stopped: false,
      };
      this.children.set(childId, child);
      this.publishSubagent(child, childId, turnId, "started", null);
    }
    if (finished && !child.background && !child.stopped) {
      child.stopped = true;
      // A call that ends in error was cut short — OpenCode answers "Subagent cancelled (sessionID: …)" — and
      // that says nothing of the child session behind it, which can run on, its tool calls still appearing under
      // a row that reads finished. Make "stopped" true.
      if (status !== "completed") {
        void this.connectionFor(session)
          .then((connection) => connection.abortSession(childId))
          .catch(() => undefined);
      }
      this.publishSubagent(child, childId, turnId, "stopped", status === "completed" ? subagentReport(asString(state.output)) : null);
    }
  }

  /**
   * An event from a session no thread owns. A subagent's own prompts are
   * answered here — nobody sees them, so left alone they would hang the
   * child and the call waiting on it. Its ending is news.
   */
  private onChildEvent(childId: string, event: OpencodeSubscribedEvent, serverKey: string): void {
    if (event.type === "permission.asked" || event.type === "question.asked") {
      void this.answerChildRequest(childId, event, serverKey);
      return;
    }
    const child = this.children.get(childId);
    if (!child || child.stopped || !child.background) return;
    const ended =
      event.type === "session.idle" ||
      event.type === "session.error" ||
      (event.type === "session.interrupted" && event.properties.pendingInbox !== true);
    if (!ended) return;
    child.stopped = true;
    const turnId = this.openTurn(child.parent)?.id ?? null;
    if (event.type !== "session.idle") {
      this.publishSubagent(child, childId, turnId, "stopped", null);
      return;
    }
    // Its report is its last word; best effort, the stop is news either way.
    void this.connectionFor(child.parent)
      .then((connection) => connection.sessionMessages(childId, { tail: IDLE_READ_ITEMS }))
      .then((messages) => lastAssistantText(messages))
      .catch(() => null)
      .then((report) => this.publishSubagent(child, childId, turnId, "stopped", report));
  }

  /**
   * Subagents run with full access, always: a permission is allowed (once —
   * never saved as a project rule), and a question, which no one could
   * see, is dismissed so the child carries on without it. Only a child of
   * one of this driver's sessions: a shared server runs other clients'
   * sessions too. A child seen before its call named it is looked up.
   */
  private async answerChildRequest(childId: string, event: OpencodeSubscribedEvent, serverKey: string): Promise<void> {
    const requestId = asString(event.properties.id);
    if (!requestId) return;
    const connection = this.liveConnections.get(serverKey);
    if (!connection) return;
    try {
      let parent = this.children.get(childId)?.parent ?? null;
      if (!parent) {
        const parentId = (await connection.getSession(childId))?.parentID;
        parent = parentId ? this.sessionForNative(parentId) : null;
        if (!parent) return;
      }
      if (event.type === "permission.asked") {
        // A subagent works in its parent's checkout, so it is held to the parent's isolation.
        await connection.replyToPermission(childId, requestId, this.reachesProtectedCheckout(parent, event) ? "reject" : "once");
      }
      else await connection.rejectQuestion(childId, requestId);
    } catch {
      // Best effort: the child's own call fails or times out as it would have.
    }
  }

  private publishSubagent(child: OpenCodeChild, agentId: string, turnId: TurnId | null, status: "started" | "stopped", lastMessage: string | null): void {
    if (child.background) this.publishBackgroundTask(child, agentId, turnId, status, lastMessage);
    this.publish({
      type: "subagent.updated",
      provider: this.provider,
      threadId: child.parent.threadId,
      turnId,
      agentId,
      agentType: child.agentType,
      status,
      lastMessage,
      ...(status === "started" ? { description: child.description } : {}),
    });
  }

  /** A background subagent is a background task: its edge, and the live set the side panel lists. */
  private publishBackgroundTask(child: OpenCodeChild, agentId: string, turnId: TurnId | null, status: "started" | "stopped", summary: string | null): void {
    if (status === "stopped") this.publish({ type: "background.wake-up", provider: this.provider, threadId: child.parent.threadId,
      requestId: `opencode-agent:${agentId}`, prompt: JSON.stringify({ taskId: agentId, description: child.description, status, summary }) });
    this.publish({
      type: "background.task",
      provider: this.provider,
      threadId: child.parent.threadId,
      turnId,
      taskId: agentId,
      status,
      description: child.description ?? child.agentType,
      taskType: "local_agent",
      toolUseId: null,
      summary,
    });
    this.publishBackgroundTasks(child.parent);
  }

  /** A command the model sent to the background starting or ending. */
  private onBackgroundShell(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const shellId = asString(event.properties.shellID);
    if (!shellId) return;
    const shells = (session.backgroundShells ??= new Map());
    const command = asString(event.properties.command) ?? "";
    const started = event.type === "session.shell.started";
    if (started) shells.set(shellId, { command, startedAt: new Date().toISOString() });
    else if (!shells.delete(shellId)) return;
    const exitStatus = asString(event.properties.status);
    if (!started) this.publish({ type: "background.wake-up", provider: this.provider, threadId: session.threadId,
      requestId: `opencode-shell:${shellId}`, prompt: JSON.stringify(event.properties) });
    this.publish({
      type: "background.task",
      provider: this.provider,
      threadId: session.threadId,
      turnId: this.openTurn(session)?.id ?? null,
      taskId: shellId,
      status: started ? "started" : exitStatus === "failed" || exitStatus === "error" ? "failed" : exitStatus === "killed" ? "stopped" : "completed",
      description: command.split("\n")[0]?.trim() ?? "",
      taskType: "local_bash",
      toolUseId: null,
      summary: null,
    });
    this.publishBackgroundTasks(session);
  }

  /** The full live set the side panel lists: background subagents and background commands. */
  private publishBackgroundTasks(session: OpenCodeSession): void {
    this.reconcileServers();
    this.publish({ type: "background.tasks.changed", provider: this.provider, threadId: session.threadId, tasks: this.backgroundTasks(session.threadId) });
  }

  /** A child session's conversation, for the subagent view. */
  readonly subagentHistory = async (threadId: ThreadId, agentId: string): Promise<readonly SubagentHistoryItem[] | null> => {
    const session = this.sessions.get(threadId);
    if (!session || session.closed) return null;
    const connection = await this.connectionFor(session);
    const child = await connection.getSession(agentId).catch(() => null);
    // Only this thread's own subagents: a child of its session.
    if (!child || child.parentID !== session.nativeSessionId) return null;
    return subagentHistoryItems(await connection.sessionMessages(agentId));
  };

  /** Whether a permission request is for a path in the checkout this session's worktree was cut from. */
  private reachesProtectedCheckout(session: OpenCodeSession, event: OpencodeSubscribedEvent): boolean {
    if (!session.isolation) return false;
    const patterns = event.properties.patterns;
    return permissionEscapes(
      session.isolation,
      {
        action: asString(event.properties.permission) ?? "",
        resources: Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === "string") : [],
      },
      session.workingDirectory,
    );
  }

  private onPermissionAsked(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const nativeId = asString(event.properties.id);
    if (!nativeId || session.parked.has(nativeId)) return;
    if (this.reachesProtectedCheckout(session, event)) {
      void this.connectionFor(session)
        .then((connection) => connection.replyToPermission(session.nativeSessionId, nativeId, "reject"))
        .catch(() => undefined);
      return;
    }
    if (session.runtimeMode === "full-access") {
      // Full access means no prompts. v2 still asks by default for paths
      // outside the project and for `.env` reads; allow them once, never
      // saving a project rule. A configured `deny` never reaches here.
      void this.connectionFor(session)
        .then((connection) => connection.replyToPermission(session.nativeSessionId, nativeId, "once"))
        .catch(() => undefined);
      return;
    }
    const permission = asString(event.properties.permission) ?? "tool";
    session.parked.set(nativeId, {
      threadId: session.threadId,
      kind: "permission",
      nativeId,
      detail: permission,
    });
    this.publish({
      type: "permission.request.opened",
      provider: this.provider,
      threadId: session.threadId,
      requestId: nativeId,
      raw: { ...event.properties, toolName: permission },
    });
  }

  private onQuestionAsked(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const nativeId = asString(event.properties.id);
    if (!nativeId || session.parked.has(nativeId)) return;
    session.parked.set(nativeId, {
      threadId: session.threadId,
      kind: "question",
      nativeId,
      detail: JSON.stringify(event.properties.questions ?? []),
    });
    this.publish({
      type: "user-input.request.opened",
      provider: this.provider,
      threadId: session.threadId,
      requestId: nativeId,
      raw: event.properties,
    });
  }

  private onRequestSettled(session: OpenCodeSession, nativeId: string | null, kind: ParkedKind): void {
    if (!nativeId) return;
    const parked = session.parked.get(nativeId);
    if (!parked || parked.kind !== kind) return;
    session.parked.delete(nativeId);
    this.publish({
      type: kind === "permission" ? "permission.request.resolved" : "user-input.request.resolved",
      provider: this.provider,
      threadId: session.threadId,
      requestId: nativeId,
    });
  }

  /**
   * `session.execution.interrupted`. Our own interrupt is acknowledged, always.
   * Otherwise the server stopped the run itself: for `inactivity` and
   * `superseded` that is a failure, never a completed turn; any other reason
   * (a dismissed form's cancel, a shutdown) ends the turn like a finished run
   * — unless a steer is still queued, whose run will settle it.
   */
  private onSessionInterrupted(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const turn = this.openTurn(session);
    if (!turn) return;
    if (turn.rescuing) return;
    if (turn.interrupting) {
      turn.interruptAcked = true;
      turn.interruptAck?.();
      return;
    }
    const reason = asString(event.properties.reason);
    if (reason === "inactivity" || reason === "superseded") {
      this.settleOpenTurn(
        session,
        "failed",
        reason === "inactivity"
          ? "OpenCode stopped the run after a period of inactivity."
          : "OpenCode replaced this run with another prompt on the same session.",
      );
      return;
    }
    if (event.properties.pendingInbox === true) return;
    this.onSessionIdle(session);
  }

  private onSessionIdle(session: OpenCodeSession): void {
    const turn = this.openTurn(session);
    if (!turn) return;
    // The failed run's idle, while the compaction that makes room is under way, is not the end of the turn.
    if (turn.rescuing) return;
    if (turn.interrupting) {
      turn.interruptAcked = true;
      turn.interruptAck?.();
      return;
    }
    let settle = true;
    // Best-effort usage: read the latest assistant message tokens off the
    // server. Failures stay silent — usage is advisory, never load-bearing.
    void this.connectionFor(session)
      // The newest items are all this reads: the last reply's usage and whether the last prompt is answered.
      .then((connection) => connection.sessionMessages(session.nativeSessionId, { tail: IDLE_READ_ITEMS }))
      .then(async (messages) => {
        // A steer that landed as the loop was finishing starts a second run
        // (and a second idle). The turn is over only once its latest user
        // message has a finished reply.
        if (turn.steerMessageIds.size > 0 && !lastUserAnswered(messages)) {
          settle = false;
          return;
        }
        const settings = await this.contextSettingsFor(session).catch(() => null);
        session.context = opencodeContextOf(messages, settings) ?? session.context;
        const usage = turnAssistantUsage(messages, [turn.userMessageId, ...turn.steerMessageIds]) ?? latestAssistantUsage(messages);
        if (usage) {
          turn.usage = usage;
          this.publish({
            type: "token-usage.updated",
            provider: this.provider,
            threadId: session.threadId,
            usage,
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (settle) this.settleOpenTurn(session, "completed", "");
      });
  }

  /**
   * Mid-turn steering. A prompt sent to a busy v2 session is delivered as
   * `steer` (the default) and taken up at the next step boundary of the same
   * run — no restart. If it lands as the run finishes, the run ends and a
   * second one delivers it; the translator holds the idle until nothing is
   * queued, so the turn still settles once.
   */
  readonly steerTurn = (threadId: ThreadId, text: string, images: readonly ProviderImage[] = []): Effect.Effect<void, CliError> =>
    this.attempt("OPENCODE_STEER_FAILED", `Could not steer the turn on thread ${threadId}`, async () => {
      const session = this.requireSession(threadId);
      const turn = this.openTurn(session);
      if (!turn) {
        throw new CliError("TURN_NOT_RUNNING", `Thread ${threadId} has no running turn to steer.`, {
          details: { threadId },
        });
      }
      const messageID = newOpencodeMessageId();
      // Registered before the send so no echoed part is read as answer text.
      turn.steerMessageIds.add(messageID);
      const connection = await this.connectionFor(session);
      try {
        // The session's model, agent and instructions are already those of the running turn.
        await connection.prompt({
          sessionID: session.nativeSessionId,
          messageID,
          text,
          files: images.map((image) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: image.name })),
        });
      } catch (cause) {
        turn.steerMessageIds.delete(messageID);
        throw cause;
      }
    });

  /** Fail every open turn on one server: a fault with no session to blame. */
  private onServerError(serverKey: string, event: OpencodeSubscribedEvent): void {
    for (const session of this.sessions.values()) {
      if (session.closed || session.workingDirectory !== serverKey) continue;
      if (!this.openTurn(session)) continue;
      this.onSessionError(session, event);
    }
  }

  private onSessionError(session: OpenCodeSession, event: OpencodeSubscribedEvent): void {
    const error = asRecord(event.properties.error);
    const message = (error ? asString(error.message ?? error.data ?? error.name) : null) ?? "OpenCode turn failed.";
    if (isOpencodeAuthErrorText(message)) {
      this.settleOpenTurn(session, "failed", opencodeSignedOutMessage({ cwd: session.workingDirectory }));
      return;
    }
    const rescuing = this.openTurn(session)?.rescuing === true;
    if (!rescuing && this.rescueOverflow(session, message)) return;
    if (rescuing) {
      // The compaction that was to make room failed (or the request was refused again): the turn ends with it.
      const open = this.openTurn(session);
      if (open) open.rescuing = false;
    }
    // A provider that never loaded reads as a missing model, which tells
    // the user nothing about the key they actually need.
    const hint = this.openTurn(session)?.credentialHint;
    const detail = hint && /model not found/i.test(message) ? `${message} ${hint}` : message;
    this.settleOpenTurn(session, "failed", detail.slice(0, 500));
  }

  private settleOpenTurn(session: OpenCodeSession, status: OpenCodeTurnStatus, detail: string): void {
    this.reconcileServers();
    // A turn is when the plan can have moved: refresh a Go thread's windows,
    // paced per server so a burst of short turns cannot become a request each.
    this.refreshGoUsage(session);
    const open = this.openTurn(session);
    if (open) {
      this.clearStallTimer(open.id);
      open.interruptAck?.();
      open.status = status;
      open.error = status === "completed" ? null : detail;
      if (status !== "completed") open.text = open.text || detail;
      // The other drivers announce the end of a turn; this one used to only
      // resolve its waiter. Without the event the live text buffered for the
      // turn (`trackLiveText`) was never cleared, so a later subscription
      // replayed a finished reply as though it were still streaming.
      this.publish({
        type: status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted",
        provider: this.provider,
        threadId: session.threadId,
        turnId: open.id,
        ...(status === "failed" ? { raw: { error: open.error } } : {}),
      });
    }
    const waiters = open ? (session.waiters.get(open.id) ?? []) : [];
    if (open) session.waiters.delete(open.id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({
        status,
        text: open?.text ?? "",
        usage: open?.usage ?? emptyUsage(),
        ...(open && generationOf(open) ? { generation: generationOf(open)! } : {}),
        error: open?.error ?? null,
      });
    }
  }

  private clearStallTimer(turnId: TurnId): void {
    const timer = this.stallTimers.get(turnId);
    if (timer) {
      clearTimeout(timer);
      this.stallTimers.delete(turnId);
    }
  }

  /**
   * Silence watchdog: the server can accept a prompt and then emit
   * nothing at all (observed with unauthenticated async prompts — 204
   * followed by zero events, where the sync endpoint 500s). Without
   * this the turn reads `running` forever.
   */
  private armStallTimer(session: OpenCodeSession, turn: OpenCodeTurn, delayMs = this.stallTimeoutMs): void {
    this.clearStallTimer(turn.id);
    const timer = setTimeout(() => {
      this.stallTimers.delete(turn.id);
      const current = this.sessions.get(session.threadId);
      if (!current || current.closed) return;
      const open = current.turns.get(turn.id);
      if (!open || open.status !== "running") return;
      // Any event since the timer was armed is proof of life: wait out the rest of the silence budget.
      // A tool call still in flight is the server doing the work the turn asked for, however quietly, so it
      // gets the longer budget.
      const budget = open.activeTools.size > 0 ? this.toolStallTimeoutMs : this.stallTimeoutMs;
      const silentFor = Date.now() - open.lastActivityAt;
      if (silentFor < budget) {
        this.armStallTimer(current, open, budget - silentFor);
        return;
      }
      this.settleOpenTurn(
        current,
        "failed",
        open.activeTools.size > 0
          ? `A tool call has been running with no word from the provider for ${Math.round(budget / 60000)} minutes — ` +
              "the turn was failed. Stop it and retry if it should have finished."
          : `No response from the provider for ${Math.round(budget / 60000)} minutes — ` +
              "the turn was failed. Check authentication and network, then retry.",
      );
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.stallTimers.set(turn.id, timer);
  }

  private async rejectParked(session: OpenCodeSession, connection: OpencodeServerConnection | null): Promise<void> {
    const parked = [...session.parked.values()];
    session.parked.clear();
    for (const request of parked) {
      // Bounded like every other wait on the interrupt path: a wedged
      // server must not hang the interrupt. The resolved event is
      // published whether or not the server answered.
      if (connection) {
        const reply =
          request.kind === "permission"
            ? connection.replyToPermission(session.nativeSessionId, request.nativeId, "reject")
            : connection.rejectQuestion(session.nativeSessionId, request.nativeId);
        await withinMs(reply.catch(() => undefined), this.abortWaitMs);
      }
      this.publish({
        type: request.kind === "permission" ? "permission.request.resolved" : "user-input.request.resolved",
        provider: this.provider,
        threadId: session.threadId,
        requestId: request.nativeId,
      });
    }
  }

  private describeSession(session: OpenCodeSession): ProviderSession {
    return {
      threadId: session.threadId,
      provider: this.provider,
      workingDirectory: session.workingDirectory,
      startedAt: session.startedAt,
    };
  }
}

/**
 * Split a multiselect answer back into its values. The panel joins them with
 * `", "`; a value that itself contains `", "` survives when it is one of the
 * field's option labels (longest match first), else each piece stands alone.
 */
function splitMultiselect(joined: string, labels: readonly string[]): string[] {
  const tokens = joined.split(", ");
  const known = new Set(labels);
  const values: string[] = [];
  let at = 0;
  while (at < tokens.length) {
    let taken = 1;
    for (let end = tokens.length; end > at + 1; end -= 1) {
      if (known.has(tokens.slice(at, end).join(", "))) {
        taken = end - at;
        break;
      }
    }
    values.push(tokens.slice(at, at + taken).join(", "));
    at += taken;
  }
  return values.filter((value) => value.length > 0);
}

/**
 * Map the panel's flat `Record<question id, answer>` onto the server's
 * per-question `string[][]`. The panel keys each answer by the question's
 * own text (`requestactivity.ts`: `id` is the text, `"<text> (n)"` for a
 * repeat), so that comes first; then the header, then `q<index>`. A question
 * with no answer gets an empty selection. A multiselect answer arrives joined
 * with `", "` and is split back into its values.
 */
export function answersFor(
  answers: ProviderUserInputAnswers,
  questionsJson: string,
): ReadonlyArray<ReadonlyArray<string>> {
  let questions: readonly unknown[];
  try {
    const parsed = JSON.parse(questionsJson) as unknown;
    questions = Array.isArray(parsed) ? parsed : [];
  } catch {
    questions = [];
  }
  if (questions.length === 0) return Object.values(answers).map((value) => [value]);
  const seen = new Set<string>();
  return questions.map((entry, index) => {
    const question = asRecord(entry);
    // Mirrors `normalizeQuestions` in requestactivity.ts, id for id.
    const text = question ? (asString(question.question) ?? asString(question.prompt) ?? asString(question.text)) : null;
    const id = text === null ? null : seen.has(text) ? `${text} (${index + 1})` : text;
    if (text !== null) seen.add(text);
    const key = [id, question ? asString(question.header) : null, `q${index}`].find(
      (candidate) => candidate !== null && answers[candidate] !== undefined,
    );
    const answer = key === undefined || key === null ? undefined : answers[key];
    if (answer === undefined || answer === "") return [];
    if (question?.multiple !== true && question?.multiSelect !== true) return [answer];
    const labels = (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
      const record = asRecord(option);
      return [asString(record?.label), asString(record?.value)].filter((label): label is string => label !== null);
    });
    return splitMultiselect(answer, labels);
  });
}

/**
 * What the turn spent: every assistant step that answers one of its user
 * messages (the prompt and any steers), tokens and `cost` summed. Null when
 * none of them reports tokens — the caller then falls back to the latest
 * reply. Only the newest `IDLE_READ_ITEMS` messages are read, so a turn that
 * ran longer than that is counted from its recent steps.
 */
function turnAssistantUsage(
  messages: ReadonlyArray<{ info: Record<string, unknown> }>,
  userMessageIds: ReadonlyArray<string>,
): TokenUsageDelta | null {
  const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  let total: TokenUsageDelta | null = null;
  let cost: number | null = null;
  for (const { info } of messages) {
    if (info.role !== "assistant" || !userMessageIds.includes(asString(info.parentID) ?? "")) continue;
    const tokens = asRecord(info.tokens);
    if (!tokens) continue;
    const cache = asRecord(tokens.cache);
    const prior: TokenUsageDelta = total ?? emptyUsage();
    total = {
      input: prior.input + number(tokens.input),
      cacheRead: prior.cacheRead + number(cache?.read),
      cacheCreate: prior.cacheCreate + number(cache?.write),
      output: prior.output + number(tokens.output),
      thinking: prior.thinking + number(tokens.reasoning),
    };
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) cost = (cost ?? 0) + info.cost;
  }
  // A model the server cannot price reports no cost: absent, never zero.
  return total === null ? null : cost === null ? total : { ...total, costUsd: cost };
}

function latestAssistantUsage(
  messages: ReadonlyArray<{ info: Record<string, unknown>; parts: ReadonlyArray<Record<string, unknown>> }>,
): TokenUsageDelta | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (!info || info.role !== "assistant") continue;
    const tokens = asRecord(info.tokens);
    // A step cut short reports no tokens; the reply before it still does.
    if (!tokens) continue;
    const cache = asRecord(tokens.cache);
    const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return {
      input: number(tokens.input),
      cacheRead: number(cache?.read),
      cacheCreate: number(cache?.write),
      output: number(tokens.output),
      thinking: number(tokens.reasoning),
    };
  }
  return null;
}

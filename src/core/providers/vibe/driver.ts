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
 * - Per-tool MCP exclusions (`mcp__<server>__<tool>`) ride the same
 *   `disabledTools` filter over Vibe's published `<server>_<tool>` display
 *   names (`vibeMcpExclusionPlan`): with every offered tool list known
 *   (in-process servers) the excluded tool's display name — digest suffixes
 *   included — is computed exactly and blocked by an anchored pattern;
 *   otherwise the server that holds the excluded tool is not offered rather
 *   than risking a pattern that misses its target.
 * - Policy writes and turn admission share one per-session queue; each turn
 *   carries its own requested mode and is only sent once that policy is
 *   acknowledged, the session is still open, and no newer narrower selection
 *   overtook the admission.
 * - `turn/completed` is routed by server turn id first and otherwise
 *   correlated against the active server turn; an event that arrives before
 *   the turn is identified is buffered, never applied blindly to the open
 *   turn, and never stranded by a queued send behind it.
 * - Startup notices (withheld MCP servers) are held on the session and
 *   published with the first sendTurn, so the turn subscriber — which
 *   attaches after session start — still sees them once.
 * - An interrupt requested before the turn id was bound and refused by the
 *   server is reported as a lost interruption, never as a failed start: the
 *   server accepted the turn.
 */
import { randomBytes, randomUUID } from "node:crypto";
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
import type { McpServerSpec } from "../../mcp.js";
import type { ConnectMcp } from "../harness/mcp.js";
import { LazyMcpGateway } from "../lazymcp.js";
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
  unwrapVibeGatewayApproval,
  isVibeGatewayToolName,
  VIBE_ALWAYS_DISABLED_TOOLS,
  VIBE_METHODS,
  vibeApprovalPolicyForRuntimeMode,
  vibeGatewayIdentityFree,
  vibeMcpExclusionPlan,
  vibeMcpGatewayRoute,
  vibeMcpServerAlias,
  vibeMcpServersOf,
  parseVibeEffectiveConfig,
  type VibeEffectiveMcpRestrictions,
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
  /** Test seam for upstream MCP connections inside the lazy MCP gateway. */
  readonly connectMcp?: ConnectMcp;
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
  /** An interrupt asked for while the server turn id was still being bound. */
  interruptRequested: boolean;
  /**
   * A row only becomes the session's active server turn when its admission
   * sends turn/start; until then it is a queued send. Events, completions
   * and interrupts route to the active row, never to a queued one, and a
   * queued row is settled (interrupted) when the session closes.
   */
  admitted: boolean;
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

/**
 * Runtime-mode state for turn admission
 * =====================================
 *
 * Three separate facts, kept deliberately apart:
 *
 * (a) `desiredMode` — the latest mode a caller selected: `setRuntimeMode`, a
 *     `sendTurn` with an explicit mode, or session start. A mode-less send
 *     borrows it at call time. Policy writes NEVER touch it.
 * (b) the mode being written — local to the `setRuntimeMode` task or turn
 *     admission whose `sessionApprovalPolicyUpdate` request is in flight.
 * (c) `acknowledgedPolicy` — the wire approval policy the server has
 *     DEFINITELY acknowledged for this session; `null` once uncertain:
 *     any `pending`/unrecognized answer, a superseded outcome or an unknown
 *     state means no cached shortcut may admit a turn.
 *
 * Inputs and outcomes (one admission chain serializes policy writes and
 * turn admissions; admissions run in send order):
 *
 * | Input                              | (a) latest | (b) writing     | (c) ack'd                          | Outcome |
 * |------------------------------------|------------|-----------------|------------------------------------|---------|
 * | session start with mode m          | m          | policy(m) in the start config | policy(m)            | session opens |
 * | setRuntimeMode(m)                  | := m       | queued write of m | unchanged                       | write queued behind the chain |
 * | sendTurn with explicit mode        | := mode    | —               | unchanged                          | admission queued for that mode |
 * | sendTurn without explicit mode     | unchanged  | —               | unchanged                          | admission queued for (a) at call time |
 * | write → `applied`                  | unchanged  | done            | := policy(b)                       | before turn/start, recheck (a): if its wire policy is narrower than the captured mode's, re-write to (a) and start under it; if (a) narrowed again during that re-write, the admission is rejected instead of starting wide |
 * | write → `pending` / unrecognized   | unchanged  | done            | := null (unknown)                  | Vibe 3.1.4 applies the live approval change BEFORE parking the rest of the config, so `pending` does NOT mean the previous policy still holds; this admission fails, the next one writes fresh and needs a definite ack |
 * | write → rejected (error reply)     | unchanged  | done            | unchanged (the previous policy still stands) | admission fails; a later send retries |
 * | write → timeout                    | unchanged  | —               | —                                  | the session is invalidated (peer closed): nothing admits on this peer again |
 * | session stop / restart / peer exit | —          | —               | —                                  | every running transcript row settles, all waiters resolve, admitted-but-unbound turns fail, and pending admissions refuse (`assertAdmissible`) |
 *
 * Invariants this buys: an admission only ever starts a turn once its own
 * write (or the definite-`acknowledgedPolicy` shortcut) holds, and never
 * wider than the latest selection; a `pending` can never leave a stale ack
 * cached; and an older queued task can never overwrite the caller's latest
 * selection.
 */

interface ParkedVibeApproval {
  readonly callbackId: string;
  readonly threadId: ThreadId;
  readonly toolName: string;
  readonly isolated: boolean;
  /**
   * Whether a "for the session" grant may be remembered. A call routed through
   * the lazy MCP gateway is not rememberable: Vibe remembers a provided tool's
   * session grant for the WHOLE tool, which would approve every server and
   * tool behind the gateway's `call_tool` (LOCAL-032).
   */
  readonly rememberable: boolean;
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
  /** Moxen's lazy MCP gateway when excluded-tool servers are routed through it (LOCAL-032); null otherwise. */
  readonly gateway: LazyMcpGateway | null;
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
  /** The latest requested mode (see the admission-state table above). */
  desiredMode: RuntimeMode;
  /** The widening write the live-turn check deferred, to replay once idle; null when nothing was deferred. */
  deferredWidening: RuntimeMode | null;
  /** The wire approval policy the server has definitely acknowledged; null once uncertain. */
  acknowledgedPolicy: string | null;
  /** Startup notices (e.g. withheld MCP servers) kept until the first turn subscriber can see them. */
  readonly startupNotices: string[];
  /** Serialized tail of policy writes and turn admissions (one mutex). */
  admissionChain: Promise<void>;
  /** turn/completed events that arrived before the open turn was identified. */
  readonly pendingCompletions: Map<string, Record<string, unknown>>;
  /** turn/started metadata that arrived before the open turn was identified. */
  readonly pendingStarted: Map<string, Record<string, unknown>>;
  readonly usage: VibeUsageAccumulator;
  backgroundProcesses: Map<string, BackgroundTaskSummary>;
  lastWindows: RateLimitWindow[];
  lastResetsAt: string | null;
  lastUsageRefreshAt: number;
  closed: boolean;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Reading `config/effective/read` to arm the lazy gateway: a short, bounded wait (LOCAL-032). */
const GATEWAY_ARM_TIMEOUT_MS = 10_000;
const USAGE_REFRESH_COALESCE_MS = 2_000;
const PASSIVE_USAGE_COALESCE_MS = 30_000;

/**
 * The exact Vibe releases the lazy-gateway route is verified against. An
 * allowlist, not a prefix regex: an unverified build such as `3.1.5.post1` or
 * `3.1.40` must fall back to withholding, never admit itself by resemblance
 * (LOCAL-032). 3.1.4/3.1.5's `SessionMCPServer` offers no per-server
 * disabled_tools, session options merge into the config as overrides, and
 * `config/effective/read` needs a live session.
 */
const GATEWAY_VIBE_VERSIONS: ReadonlySet<string> = new Set(["3.1.4", "3.1.5"]);

/** A deny-everything `disabledTools` entry: pins a zero-tool session even against Vibe's own native MCP servers. */
const DENY_ALL_TOOLS_PATTERN = "re:.*";

/** Fresh random gateway identities tried before failing closed on an unavoidable collision. */
const GATEWAY_NAME_ATTEMPTS = 16;

/**
 * Allocate a gateway identity guaranteed unused against the inspected native
 * catalog and the session's own offers: 12 hex characters of `crypto`
 * randomness, retried until `vibeGatewayIdentityFree` proves no server-name
 * collision and no tool display-name reflow. Returns null when no candidate
 * passes (e.g. a native server literally named `moxen`), so the caller fails
 * closed rather than merging a colliding identity (LOCAL-032).
 */
function vibeGatewayName(
  nativeAliases: ReadonlySet<string>,
  offered: readonly McpServerSpec[],
): string | null {
  for (let attempt = 0; attempt < GATEWAY_NAME_ATTEMPTS; attempt += 1) {
    const candidate = `moxen-mcp-${randomBytes(6).toString("hex")}`;
    if (vibeGatewayIdentityFree(candidate, nativeAliases, offered)) return candidate;
  }
  return null;
}

/** Strictness order of Moxen's runtime modes, least permissive first. */
const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  "auto": 2,
  "full-access": 3,
};

/** Strictness order of Vibe's wire approval policies, least permissive first. */
const WIRE_POLICY_RANK: Record<string, number> = {
  ask: 0,
  "accept-edits": 1,
  "auto-approve": 2,
};

function modeRank(mode: RuntimeMode): number {
  return RUNTIME_MODE_RANK[mode] ?? 0;
}

function policyRank(policy: string): number {
  return WIRE_POLICY_RANK[policy] ?? 0;
}

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

function mergeDisabledTools(input: ProviderSessionStartInput, mcpPatterns: readonly string[]): string[] {
  const disabled = new Set<string>(VIBE_ALWAYS_DISABLED_TOOLS);
  if (input.checklist === false) disabled.add("todo");
  if (input.delegated === true) disabled.add("ask_user_question");
  for (const raw of input.disabledNativeTools ?? []) {
    const name = raw.trim();
    if (name.length > 0) disabled.add(name);
  }
  for (const pattern of mcpPatterns) disabled.add(pattern);
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
  /** Swapped out in tests for the lazy MCP gateway's upstream connections. */
  private readonly connectMcp: ConnectMcp | undefined;
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
    this.connectMcp = options.connectMcp;
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

  /**
   * Publish notices retained at session start (withheld MCP servers): they
   * were held back so a subscriber attaching after session/start — the normal
   * send path's turn subscriber — still sees them once.
   */
  private publishStartupNotices(session: VibeSession): void {
    for (const note of session.startupNotices.splice(0)) {
      this.publish({
        type: "session.notice",
        provider: this.provider,
        threadId: session.threadId,
        turnId: null,
        notice: "mcp",
        title: "MCP servers not offered",
        detail: note,
      });
    }
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
        // The lazy MCP gateway for excluded-tool servers (LOCAL-032), closed
        // again if the session fails to start.
        let lazyGateway: LazyMcpGateway | null = null;

        try {
          const init = asRecord(
            await peer.request(
              VIBE_METHODS.initialize,
              {
                clientInfo: vibeClientInfo(),
                capabilities: {
                  callbackKinds: ["approval", "user_input"],
                },
              },
              this.initializeTimeoutMs,
            ),
          );
          peer.notify(VIBE_METHODS.initialized, {});
          const serverVersion = asNonEmptyString(asRecord(init?.["serverInfo"])?.["version"]);

          const runtimeMode: RuntimeMode = input.runtimeMode ?? "auto-accept-edits";
          const model = resolveVibeModel(input.modelSelection?.model);
          const effort = extractEffortOption(input.modelSelection);
          // Worktree-isolated sessions use `ask` so every tool call reaches
          // Moxen's approval callback where we enforce worktree boundaries.
          const approvalPolicy = input.isolation
            ? "ask"
            : vibeApprovalPolicyForRuntimeMode(runtimeMode);
          // LOCAL-032: servers that hold an individually excluded tool used to
          // be withheld whole. When the Vibe peer is verified, they are routed
          // through Moxen's lazy MCP gateway instead: Vibe only ever sees the
          // gateway (`search_tools` / `call_tool`) and the exclusions are
          // enforced inside it — together with the tool restrictions of the
          // user's own Vibe configuration, read from `config/effective/read`
          // below. Anything less than the verified 3.1.4/3.1.5 wire contract
          // keeps today's withholding, which never gets less strict.
          const servers = input.mcpServers ?? [];
          const excludedTools = input.disabledMcpTools ?? [];
          const route = vibeMcpGatewayRoute(servers, excludedTools);
          const versionVerified = serverVersion !== null && GATEWAY_VIBE_VERSIONS.has(serverVersion);
          const useGateway = route !== null && versionVerified;
          const mcpPlan = useGateway && route !== null
            ? route.plan
            : vibeMcpExclusionPlan(servers, excludedTools);
          if (!useGateway && mcpPlan.unsatisfiable) {
            // Vibe 3.1.4 sends no MCP override for an empty `mcpServers` list
            // (`_runtime.py` guards `if options.mcp_servers:`), so withholding
            // every offered server would fall back to the native Vibe MCP
            // configuration — where the excluded tools may stay callable, with
            // no deny at all. Refuse instead of sending an empty override.
            // (With the gateway route the offer is never empty: the gateway
            // itself is offered, so this refusal is unreachable there.)
            const listed = mcpPlan.unsatisfiableExclusions.map((name) => `"${name}"`).join(", ");
            throw new CliError(
              "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
              `The MCP tool exclusion${mcpPlan.unsatisfiableExclusions.length > 1 ? "s" : ""} ${listed} cannot be enforced: it would withhold every offered MCP server, and Mistral Vibe would then fall back to its native MCP configuration, which may still expose the excluded tool. Remove the exclusion or rename the conflicting tools, then send the session again.`,
            );
          }
          const startupNotices = [...mcpPlan.notes];
          if (route !== null && !versionVerified) {
            startupNotices.push(
              `Mistral Vibe ${serverVersion ?? "with no version reported"} is not a release this build's lazy MCP gateway is verified against, so MCP servers with individually excluded tools (${route.servers.map((s) => s.name).join(", ")}) are withheld this session.`,
            );
          }
          if (useGateway && route !== null) {
            // Inspect the native Vibe catalog BEFORE merging the gateway: a
            // short tool-free preflight session on its own short-lived peer
            // answers `config/effective/read` with the user's own merged
            // config (the only verified read path for it) and then stops that
            // preflight peer — real `vibe-app-server` closes the whole process
            // on `session/stop`, so reusing the main session peer would kill
            // it before `session/start` (LOCAL-032, LOCAL-038). Without it we
            // can neither prove a collision-free gateway identity nor prove the
            // exclusions stay enforced on a surviving native copy, so refuse.
            const native = await this.readNativeVibeCatalog(input.workingDirectory, serverVersion);
            if (!native) {
              throw new CliError(
                "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
                `The MCP tool exclusions for ${route.servers.map((s) => `"${s.name}"`).join(", ")} cannot be enforced: Mistral Vibe's native MCP configuration could not be read before starting the session, so a surviving native copy of the server may still expose the excluded tool. Try again, or remove the exclusion.`,
              );
            }
            // Every routed exclusion must also be denied on any surviving
            // native route: Vibe's `MergeStrategy.UNION` keeps a native
            // same-name entry we do not override, and omission is not a deny.
            const exposed = this.nativeExclusionsExposed(route.servers.map((s) => s.name), excludedTools, native);
            if (exposed.length > 0) {
              const listed = exposed.map((name) => `"${name}"`).join(", ");
              throw new CliError(
                "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
                `The MCP tool exclusion${exposed.length > 1 ? "s" : ""} ${listed} cannot be enforced: the same server is configured natively in Mistral Vibe, and that surviving native route still exposes the excluded tool directly. Disable the tool in your Vibe configuration (or the whole native server), or remove the exclusion, then send the session again.`,
              );
            }
            // Allocate an identity guaranteed unused against the native catalog
            // and the offers: no server-name collision (UNION would replace a
            // native entry whole) and no tool display-name reflow.
            const gatewayName = vibeGatewayName(native.nativeServers, servers);
            if (gatewayName === null) {
              throw new CliError(
                "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
                `The MCP tool exclusions for ${route.servers.map((s) => `"${s.name}"`).join(", ")} cannot be enforced: no collision-free lazy MCP gateway identity is available against your native Mistral Vibe MCP configuration. Rename the conflicting native server, or remove the exclusion, then send the session again.`,
              );
            }
            const taken = new Set<string>(servers.map((server) => server.name));
            taken.add("moxen");
            lazyGateway = await LazyMcpGateway.start({
              specs: route.servers,
              cwd: input.workingDirectory,
              disabledTools: route.denyTools,
              name: gatewayName,
              takenNames: taken,
              failClosed: true,
              ...(this.connectMcp ? { connect: this.connectMcp } : {}),
            });
            startupNotices.push(route.note);
          }
          const gatewayServerNames = new Set((useGateway ? route?.servers ?? [] : []).map((server) => server.name));
          const disabledTools = mergeDisabledTools(input, mcpPlan.patterns);
          const directServers = servers.filter(
            (server) => !mcpPlan.dropServers.has(server.name) && !gatewayServerNames.has(server.name),
          );
          // The gateway rides the SAME `SessionMCPServer` serializer as every
          // other HTTP server: a valid `streamable-http` entry, never the raw
          // internal spec (`type`/`alwaysLoad` are not wire fields and Vibe
          // 3.1.5's discriminated union rejects them) (LOCAL-032).
          const mcpServers = [
            ...vibeMcpServersOf(directServers),
            ...(lazyGateway ? vibeMcpServersOf([lazyGateway.spec]) : []),
          ];
          const gatewayInstructions = lazyGateway
            ? [
                `External MCP servers (${lazyGateway.serverNames.join(", ")}) are attached through the \`${lazyGateway.name}\` lazy MCP gateway so individually excluded tools stay hidden.`,
                "Call its `search_tools` tool to list tools or load exact parameter schemas, then its `call_tool` tool with `{ server, tool, arguments }`."
              ].join("\n")
            : null;

          const agentConfig: Record<string, unknown> = {
            cwd: input.workingDirectory,
            trustWorkspace: true,
            approvalPolicy,
            disabledTools,
            ...(input.instructions && input.instructions.trim().length > 0
              ? { instructions: gatewayInstructions ? `${input.instructions}\n\n${gatewayInstructions}` : input.instructions }
              : gatewayInstructions
                ? { instructions: gatewayInstructions }
                : {}),
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
          };

          const startedAt = new Date().toISOString();
          const session: VibeSession = {
            threadId: input.threadId,
            peer,
            workingDirectory: input.workingDirectory,
            startedAt,
            gateway: lazyGateway,
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
            desiredMode: runtimeMode,
            deferredWidening: null,
            acknowledgedPolicy: approvalPolicy,
            admissionChain: Promise.resolve(),
            pendingCompletions: new Map(),
            pendingStarted: new Map(),
            startupNotices,
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

          // Verify the merged catalog and arm the gateway BEFORE the session
          // goes live: a turn can never run against a half-configured gateway,
          // and an unenforceable exclusion refuses the start (the catch below
          // closes the gateway and peer) (LOCAL-032).
          await this.armGateway(session, excludedTools);
          this.sessions.set(input.threadId, session);

          // Startup notices are kept on the session and published with the
          // first sendTurn: a subscriber that attaches after session/start
          // (the normal send path's turn subscriber) would otherwise miss
          // notices the global pump already consumed.

          // Best-effort initial monthly budget read; never blocks or fails session startup.
          void this.refreshSessionAccount(session, true);

          return {
            threadId: session.threadId,
            provider: this.provider,
            workingDirectory: session.workingDirectory,
            startedAt: session.startedAt,
          };
        } catch (cause) {
          // Close the peer BEFORE awaiting gateway shutdown so any in-flight
          // HTTP request the peer holds open against the loopback gateway is
          // dropped and cannot stall `server.close()` (LOCAL-038).
          peer.close();
          await lazyGateway?.close().catch(() => undefined);
          throw cause;
        }
      },
      catch: (cause) => toCliError("VIBE_SESSION_START_FAILED", "Could not start Mistral Vibe session", cause),
    });

  /**
   * Read Mistral Vibe's native MCP catalog through a short tool-free preflight
   * session on its own passive peer (`withPeer`): `session/start` with
   * `sessionOnly: true` (no offer, no turn, no persisted history), then
   * `config/effective/read` (the only verified read path for the merged native
   * config — it needs a live session), then `session/stop`. Running on a
   * separate peer is required because `vibe-app-server` closes the server on
   * `session/stop` (LOCAL-038). Returns null when the catalog or preflight
   * peer version cannot be proven, so the caller refuses the gateway route
   * rather than guessing (LOCAL-032).
   */
  private async readNativeVibeCatalog(
    cwd: string,
    expectedVersion: string,
  ): Promise<VibeEffectiveMcpRestrictions | null> {
    try {
      return await this.withPeer(cwd, async (preflightPeer, preflightVersion) => {
        if (preflightVersion !== expectedVersion || !GATEWAY_VIBE_VERSIONS.has(preflightVersion)) {
          return null;
        }
        let preflightId: string | null = null;
        try {
          const started = asRecord(
            await preflightPeer.request(
              VIBE_METHODS.sessionStart,
              { agentConfig: { cwd, trustWorkspace: true, approvalPolicy: "ask" }, sessionOnly: true },
              this.requestTimeoutMs,
            ),
          );
          preflightId = asNonEmptyString(asRecord(asRecord(started?.["state"])?.["session"])?.["id"]);
          if (!preflightId) return null;
          const raw = await preflightPeer.request(
            VIBE_METHODS.configEffectiveRead,
            { sessionId: preflightId },
            GATEWAY_ARM_TIMEOUT_MS,
          );
          return parseVibeEffectiveConfig(raw);
        } finally {
          if (preflightId) {
            await preflightPeer
              .request(VIBE_METHODS.sessionStop, { sessionId: preflightId }, this.requestTimeoutMs)
              .catch(() => undefined);
          }
        }
      });
    } catch {
      return null;
    }
  }

  /**
   * The routed exclusions a surviving native Vibe route still exposes: a
   * native same-name server (kept by `MergeStrategy.UNION` because the gateway
   * route does not offer it) whose own restrictions do not deny the excluded
   * tool. Omission from the offer is not a deny (LOCAL-032).
   *
   * This answers the opposite question from the gateway's `allows`: it must
   * prove Vibe denies the tool natively, so it uses the exposure-leaning
   * `provenDeniedNatively` — every uncertainty counts as exposed.
   */
  private nativeExclusionsExposed(
    routedServerNames: readonly string[],
    excludedTools: readonly string[],
    restrictions: VibeEffectiveMcpRestrictions,
  ): string[] {
    const exposed: string[] = [];
    for (const name of routedServerNames) {
      const alias = vibeMcpServerAlias(name).toLowerCase();
      if (!restrictions.nativeServers.has(alias)) continue;
      const prefix = `mcp__${name}__`;
      for (const exclusion of excludedTools) {
        if (!exclusion.startsWith(prefix) || exclusion.length <= prefix.length) continue;
        if (!restrictions.provenDeniedNatively(name, exclusion.slice(prefix.length))) exposed.push(exclusion);
      }
    }
    return [...new Set(exposed)];
  }

  /**
   * Verify the merged catalog and arm the session's lazy MCP gateway from
   * `config/effective/read` — the merged Mistral Vibe configuration (user,
   * trusted project, env, session overrides, agent profile, admin policy;
   * credentials redacted), which the installed 3.1.5 only answers for a live
   * session. The gateway's own entry is excluded by its exact name and URL so
   * it is never mistaken for a pre-existing native server (LOCAL-032).
   *
   * Fails closed three ways: an unreadable merge, an unrecognized shape, or a
   * native route that now exposes a routed exclusion all refuse the start
   * (locking the gateway alone cannot restrict a native server that appeared
   * between preflight and `session/start` — LOCAL-038); a missing/mismatched
   * gateway entry or a native sibling sharing its alias, once native
   * enforcement is proven, locks the gateway. A locked gateway reaches no tool,
   * which is at least as strict as today's withholding.
   */
  private async armGateway(session: VibeSession, excludedTools: readonly string[]): Promise<void> {
    const gateway = session.gateway;
    if (!gateway) return;
    const lock = (reason: string): void => {
      gateway.lock(reason);
      session.startupNotices.push(
        `MCP servers (${gateway.serverNames.join(", ")}) are not available this session: ${reason}.`,
      );
    };
    let restrictions: VibeEffectiveMcpRestrictions | null;
    try {
      const raw = await session.peer.request(
        VIBE_METHODS.configEffectiveRead,
        { sessionId: session.vibeSessionId },
        GATEWAY_ARM_TIMEOUT_MS,
      );
      restrictions = parseVibeEffectiveConfig(raw, { name: gateway.name, url: gateway.spec.url });
    } catch {
      throw new CliError(
        "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
        "The MCP tool exclusions cannot be enforced: Mistral Vibe's effective configuration could not be read after the session started, so a surviving native route cannot be ruled out. Try again, or remove the exclusion.",
      );
    }
    if (!restrictions) {
      throw new CliError(
        "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
        "The MCP tool exclusions cannot be enforced: Mistral Vibe's effective configuration shape was not recognized after the session started. Try again, or remove the exclusion.",
      );
    }
    const exposed = this.nativeExclusionsExposed(gateway.serverNames, excludedTools, restrictions);
    if (exposed.length > 0) {
      const listed = exposed.map((name) => `"${name}"`).join(", ");
      throw new CliError(
        "VIBE_MCP_EXCLUSION_UNENFORCEABLE",
        `The MCP tool exclusion${exposed.length > 1 ? "s" : ""} ${listed} cannot be enforced: a surviving native Mistral Vibe route still exposes the excluded tool directly. Disable the tool in your Vibe configuration (or the whole native server), or remove the exclusion, then send the session again.`,
      );
    }
    if (!restrictions.gatewayEntryFound) {
      lock("the lazy MCP gateway's merged entry could not be verified in Mistral Vibe's effective configuration");
      return;
    }
    if (restrictions.nativeServers.has(vibeMcpServerAlias(gateway.name).toLowerCase())) {
      lock("the gateway's name collides with a natively configured Mistral Vibe server");
      return;
    }
    gateway.arm((server, tool) => restrictions.allows(server, tool));
  }

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
      void session.gateway?.close().catch(() => undefined);
      for (const row of this.runningRows(session)) {
        this.failTurn(
          session,
          row,
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
    const rawInput = asRecord(effect["input"]) ?? {};
    // LOCAL-032: a call through the lazy MCP gateway is judged and shown under
    // the real server and tool with its real arguments, never as a generic
    // `call_tool` — every gate below (isolation, runtime mode, delegated
    // denial, the permission panel) sees the unwrapped call. And a session-wide
    // grant never reaches Vibe as rememberable for the gateway's tool, since
    // Vibe would remember it for `call_tool` as a whole (every server and
    // tool behind the gateway).
    let toolName = canonicalVibeToolName(rawToolName, effectKind);
    let input: Record<string, unknown> = { ...rawInput };
    let rememberable = true;
    if (session.gateway !== null) {
      const gateway = session.gateway;
      // Identify the gateway's call_tool STRICTLY by the session-allocated
      // name, independently of its arguments. A malformed or unknown target is
      // denied before any approval opens — it must never park as a generic,
      // rememberable `call_tool` (which `approve_for_session` would grant for
      // every server and tool behind the gateway) (LOCAL-032).
      if (isVibeGatewayToolName(rawToolName, gateway.name, "call_tool")) {
        const routed = new Set(gateway.serverNames.map((name) => name.toLowerCase()));
        const unwrapped = unwrapVibeGatewayApproval(gateway.name, routed, rawToolName, rawInput);
        if (unwrapped === null) {
          void this.sendCallbackResult(session, callbackId, {
            type: "approval",
            decision: { type: "deny" },
            feedback: "The lazy MCP gateway call names no routable server and tool; it cannot be approved.",
          });
          return;
        }
        toolName = `mcp__${unwrapped.server}__${unwrapped.tool}`;
        input = unwrapped.arguments;
        // A session-wide grant never reaches Vibe as rememberable for the
        // gateway's call_tool: Vibe remembers a provided tool's session grant
        // for the WHOLE tool (every server and tool behind the gateway).
        rememberable = false;
      }
    }
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
    // The gate is the stricter of the mode the server is believed to run and
    // the caller's latest selection: a tightening Vibe answered `pending` is
    // already live on the running turn, and a widening write that is still
    // deferred or unacknowledged must never loosen the local gate.
    const gatingMode =
      modeRank(session.desiredMode) < modeRank(session.runtimeMode) ? session.desiredMode : session.runtimeMode;
    if (approvalShouldAutoAllow(gatingMode, toolName, effectKind, input, session.workingDirectory)) {
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
      rememberable,
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
        // Only the turn/start response binds the server turn id. Buffer the
        // metadata by id and consume the matching entry once the RPC binds it,
        // so an early turn/started keeps its inputEntryId without letting an
        // uncorrelated one bind or drain anything.
        const running = this.runningTurn(session);
        if (running && running.serverTurnId === sid) {
          const inputId = asNonEmptyString(turnMeta!["inputEntryId"]);
          if (inputId && !running.inputEntryId) running.inputEntryId = inputId;
        } else if (running && running.serverTurnId === null) {
          session.pendingStarted.set(sid, turnMeta!);
          if (session.pendingStarted.size > 16) {
            const oldest = session.pendingStarted.keys().next().value;
            if (oldest !== undefined) session.pendingStarted.delete(oldest);
          }
        }
        break;
      }
      case VIBE_METHODS.turnCompleted: {
        const turnMeta = asRecord(rec["turn"]);
        if (!turnMeta || !this.notificationMatchesSession(session, rec)) break;
        const sid = asNonEmptyString(turnMeta["id"]);
        // A completion for an identified running turn settles THAT turn, even
        // when a later send queued another row: routing by server turn id
        // first keeps a queued admission from stranding the previous turn's
        // completion (its awaiter would hang forever otherwise).
        if (sid) {
          const bound = [...session.transcript]
            .reverse()
            .find((turn) => turn.status === "running" && turn.serverTurnId === sid);
          if (bound) {
            this.onTurnCompleted(session, bound, turnMeta);
            break;
          }
        }
        const running = this.runningTurn(session);
        if (!running) break;
        if (running.serverTurnId === null) {
          // The start response has not identified the turn yet. Drop
          // completions for turns already settled here (verifiably stale) and
          // hold the rest until the id is known. The cap counts only new
          // distinct ids — a duplicate replaces its entry without a slot. On a
          // genuine overflow fail the turn and close the session, so a server
          // turn that may have been accepted is not left running behind a
          // locally failed row.
          if (sid && !this.isSettledServerTurn(session, sid)) {
            if (session.pendingCompletions.has(sid)) {
              session.pendingCompletions.set(sid, turnMeta);
            } else if (session.pendingCompletions.size >= 16) {
              session.pendingCompletions.clear();
              this.failTurn(session, running, "Too many uncorrelated turn completions arrived before the turn was identified.");
              this.invalidateSession(session);
            } else {
              session.pendingCompletions.set(sid, turnMeta);
            }
          }
          break;
        }
        // A stale or foreign completion must never settle the open turn.
        if (sid !== running.serverTurnId) break;
        this.onTurnCompleted(session, running, turnMeta);
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

      const gatewayNorm = this.unwrapGatewayEffect(session, normalizeVibeEffectEntry(entry));
      if (!gatewayNorm) return;
      const norm = gatewayNorm;
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

  /**
   * The effect the timeline shows: a call through the lazy MCP gateway is
   * projected under the real server and tool with its real arguments, exactly
   * like the approval judged for the same call (LOCAL-032).
   */
  private unwrapGatewayEffect(session: VibeSession, norm: ReturnType<typeof normalizeVibeEffectEntry>): ReturnType<typeof normalizeVibeEffectEntry> {
    if (!norm || session.gateway === null || norm.kind !== "tool") return norm;
    const routed = new Set(session.gateway.serverNames.map((name) => name.toLowerCase()));
    const unwrapped = unwrapVibeGatewayApproval(session.gateway.name, routed, norm.rawToolName, norm.input);
    if (unwrapped === null || unwrapped.kind !== "call") return norm;
    const tool = `mcp__${unwrapped.server}__${unwrapped.tool}`;
    return { ...norm, tool, title: tool, input: unwrapped.arguments };
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
    if (buffered && turn.status === "running") this.onTurnCompleted(session, turn, buffered);
  }

  /** Whether a server turn id already belongs to a settled turn of this session. */
  private isSettledServerTurn(session: VibeSession, sid: string): boolean {
    return session.transcript.some((turn) => turn.serverTurnId === sid && turn.status !== "running");
  }

  private onTurnCompleted(session: VibeSession, running: VibeTranscriptTurn, turnMeta: Record<string, unknown>): void {
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
    // The session may now be idle with a widening write still unapplied.
    this.applySelectedModeWhenIdle(session);
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
          // One account reading (its whole budget), so it replaces the list.
          complete: true,
          ...(this.instanceId ? { instanceId: this.instanceId } : {}),
          raw,
        });
      }
      return windows;
    } catch {
      return session.lastWindows;
    }
  }

  private runningRows(session: VibeSession): VibeTranscriptTurn[] {
    return session.transcript.filter((turn) => turn.status === "running");
  }

  /** The transcript row a live provider event belongs to: the active (admitted) running turn, never a queued one. */
  private runningTurn(session: VibeSession): VibeTranscriptTurn | undefined {
    for (let i = session.transcript.length - 1; i >= 0; i--) {
      const turn = session.transcript[i]!;
      if (turn.status === "running" && turn.admitted) return turn;
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
          admitted: false,
          inputEntryId: null,
          interruptRequested: false,
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
        session.pendingStarted.clear();
        // Retained startup notices go out here, where the turn subscriber is
        // already attached (execute.ts subscribes before sending).
        this.publishStartupNotices(session);
        // Capture THIS turn's requested mode now: a later overlapping send must
        // not substitute its own mode when this turn is admitted. An explicit
        // mode is also the caller's latest selection (a); a mode-less send borrows it.
        const requestedMode = input.runtimeMode ?? session.desiredMode;
        if (input.runtimeMode) session.desiredMode = input.runtimeMode;

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
              // A stop may have landed while the RPC was in flight (logical
              // close, peer still open): do not adopt state or publish a
              // notice for a session that is gone or a turn already settled.
              if (session.closed || turn.status !== "running") {
                return { threadId: session.threadId, turnId };
              }
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

          // Serialize policy validation and turn/start admission together so a
          // turn is only sent once THIS turn's requested policy is acknowledged
          // and the session is still open. Each queued admission carries its
          // own requested mode; none reads a shared mutable mode at start time.
          await this.enqueueAdmission(session, async () => {
            this.assertAdmissible(session, turn);

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

            await this.writePolicyAndRecheck(session, requestedMode);
            // A stop may have landed during the policy write: recheck before
            // sending turn/start on a peer whose session is gone.
            this.assertAdmissible(session, turn);
            // The row becomes the session's active server turn only now: events
            // and completions that arrive before turn/start replies reach it,
            // while rows queued behind later sends stay out of its way.
            turn.admitted = true;

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
            // Consume the matching early turn/started metadata, if any.
            const startedMeta = session.pendingStarted.get(serverTurnId);
            if (startedMeta) {
              const startedEntryId = asNonEmptyString(startedMeta["inputEntryId"]);
              if (startedEntryId && !turn.inputEntryId) turn.inputEntryId = startedEntryId;
            }
            session.pendingStarted.clear();
            this.drainBufferedCompletion(session, turn);
            // An interrupt asked for while binding was pending goes out now.
            // A failure here must not fail the turn: the server ACCEPTED this
            // turn (a valid turn id above), so its identity and completion
            // tracking stay; only the interruption is reported as lost, and a
            // later turn/completed still settles the turn normally.
            if (turn.interruptRequested && turn.status === "running") {
              turn.interruptRequested = false;
              try {
                await this.sendInterrupt(session, serverTurnId);
              } catch (cause) {
                this.publish({
                  type: "session.notice",
                  provider: this.provider,
                  threadId: session.threadId,
                  turnId: turn.id,
                  notice: "interrupt-failed",
                  title: "Could not interrupt the Vibe turn",
                  detail: cause instanceof Error ? cause.message : String(cause),
                });
              }
            }
          });

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
    session.desiredMode = mode;
    if (session.isolation) {
      session.runtimeMode = mode;
      return;
    }
    // The queued write is skipped when a newer selection supersedes it and
    // deferred when it would widen a live turn (see applySelectedMode). A
    // refused write is not swallowed: the next turn start queues another
    // admission and refuses to run until the desired policy is acknowledged.
    void this.enqueueAdmission(session, () => this.applySelectedMode(session, mode)).catch(() => undefined);
  };

  /**
   * One queued `setRuntimeMode` write, running on the admission chain. A
   * selection the caller has since replaced is skipped before any RPC. A
   * write that would widen the live policy is deferred while a turn is
   * running (Vibe 3.1.4 applies a policy change to the running turn live) and
   * recorded as the session's deferred widening; the turn-completion hook
   * replays exactly that one write once the session is idle. A narrowing
   * write goes out at once, mid-turn included.
   */
  private async applySelectedMode(session: VibeSession, mode: RuntimeMode): Promise<void> {
    if (session.desiredMode !== mode) return; // superseded by a newer selection
    const target = vibeApprovalPolicyForRuntimeMode(mode);
    const believed = vibeApprovalPolicyForRuntimeMode(session.runtimeMode);
    if (policyRank(target) > policyRank(believed) && this.runningTurn(session) !== undefined) {
      session.deferredWidening = mode;
      return;
    }
    session.deferredWidening = null; // this selection is written now, not deferred
    await this.writePolicy(session, mode);
  }

  /**
   * After a turn settles, replay ONLY the widening write the live-turn check
   * actually deferred, and only while it is still EXACTLY the caller's
   * latest selection — never a pending tightening (Vibe already applied it
   * live and answered `pending`, so a replay would issue a redundant write
   * whose failure would invalidate a healthy session) and never a superseded
   * selection: the moment any newer selection exists the deferral is dropped
   * and the newer setter's own queued write takes over — replaying the older
   * policy would send a wire write the caller no longer wants, and a timeout
   * on it would close a session the current selection never needed to widen.
   */
  private applySelectedModeWhenIdle(session: VibeSession): void {
    if (session.closed || session.isolation) return;
    if (this.runningTurn(session) !== undefined) return;
    const mode = session.deferredWidening;
    if (!mode) return;
    if (session.desiredMode !== mode) {
      // Superseded by a newer selection: drop the deferral — the newer
      // selection's own queued write takes over, so the stale deferral is
      // never replayed (a replay of it would be a write the caller no longer
      // wants, and a timeout on it would close a healthy session).
      session.deferredWidening = null;
      return;
    }
    void this.enqueueAdmission(session, async () => {
      if (session.closed || session.deferredWidening !== mode) return;
      // The deferred selection must still be EXACTLY the latest one, not
      // merely within its rank: any newer selection (wider or narrower)
      // issues its own write, so replaying the stale deferral would only
      // write a superseded policy a timeout could then close the session
      // over.
      if (session.desiredMode !== mode) {
        session.deferredWidening = null;
        return;
      }
      if (this.runningTurn(session) !== undefined) return; // a new turn beat us; the deferral replays after it
      session.deferredWidening = null;
      await this.writePolicy(session, mode);
    }).catch(() => undefined);
  }

  /**
   * Append one task to the session's serialized admission chain (policy writes
   * and turn admissions share one mutex). The chain itself never rejects; each
   * caller sees its own task's error.
   */
  private enqueueAdmission<T>(session: VibeSession, task: () => Promise<T>): Promise<T> {
    const run = session.admissionChain.then(task);
    session.admissionChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Throw unless the session is still open, registered, and the turn running. */
  private assertAdmissible(session: VibeSession, turn: VibeTranscriptTurn): void {
    if (session.closed || this.sessions.get(session.threadId) !== session || turn.status !== "running") {
      throw new CliError("SESSION_NOT_FOUND", "The Mistral Vibe session stopped before the turn could start.");
    }
  }

  /** Write the mode's approval policy (see writePolicy) and recheck the latest selection. */
  private async writePolicyAndRecheck(session: VibeSession, requestedMode: RuntimeMode): Promise<void> {
    await this.writePolicy(session, requestedMode);
    // Recheck AFTER the awaited write: a newer selection (setRuntimeMode, or a
    // later send with an explicit mode queued behind this admission) outranks
    // this admission's captured mode. A newer WIDER selection never widens
    // this turn; a newer NARROWER one is applied here — re-written and
    // acknowledged before turn/start — so this turn runs no wider than the
    // latest selection. A newest-narrowest that landed mid-re-write rejects
    // the admission instead of starting an unacknowledged policy.
    let effective = requestedMode;
    for (let round = 0; round < 2; round += 1) {
      if (
        policyRank(vibeApprovalPolicyForRuntimeMode(session.desiredMode))
        >= policyRank(vibeApprovalPolicyForRuntimeMode(effective))
      ) {
        // The latest selection is not narrower on the wire: run this turn as
        // captured, with Moxen's own gating at the stricter of the two modes.
        if (modeRank(session.desiredMode) < modeRank(effective)) session.runtimeMode = session.desiredMode;
        return;
      }
      effective = session.desiredMode;
      await this.writePolicy(session, effective);
    }
    throw new CliError(
      "VIBE_TURN_START_FAILED",
      `The Mistral Vibe mode changed to ${session.desiredMode} while this turn waited; send it again.`,
    );
  }

  /**
   * Write `mode`'s approval policy and adopt it only on a definite applied
   * acknowledgement. Runs inside the admission chain; never touches
   * `desiredMode` — that is the caller's latest selection, not this write's.
   * A timeout is ambiguous (the server may have applied the policy while the
   * reply was lost), so the cached acknowledgement is unsafe: invalidate the
   * session rather than admit another turn on that peer. A `pending` response
   * does NOT mean the previous approval policy is still in effect (Vibe 3.1.4
   * applies the live approval change before parking the rest of the
   * configuration), so the cached acknowledgement is discarded: the next turn
   * needs a fresh definite acknowledgement. A definite rejection keeps the
   * previous ack (the server refused the change) and the retry behaviour.
   */
  private async writePolicy(session: VibeSession, mode: RuntimeMode): Promise<void> {
    if (session.isolation) {
      // Isolated sessions always run `ask`; the mode only gates Moxen's own
      // auto-approval, so no server acknowledgement is needed.
      session.runtimeMode = mode;
      return;
    }
    const target = vibeApprovalPolicyForRuntimeMode(mode);
    if (session.acknowledgedPolicy !== null && session.acknowledgedPolicy === target) {
      session.runtimeMode = mode;
      return;
    }
    let result: Record<string, unknown> | null;
    try {
      result = asRecord(
        await session.peer.request(
          VIBE_METHODS.sessionApprovalPolicyUpdate,
          { sessionId: session.vibeSessionId, approvalPolicy: target },
          this.requestTimeoutMs,
        ),
      );
    } catch (cause) {
      if (cause instanceof CliError && cause.code === "PEER_REQUEST_TIMEOUT") {
        this.invalidateSession(session);
        throw new CliError(
          "VIBE_POLICY_ACK_TIMEOUT",
          "Mistral Vibe approval policy update timed out; the session was closed because the server policy is uncertain.",
          { cause },
        );
      }
      throw cause;
    }
    if (asNonEmptyString(result?.["status"]) !== "applied") {
      // `pending` (or an unrecognized answer): the server's approval policy is
      // being changed live, so no cached acknowledgement can be trusted.
      session.acknowledgedPolicy = null;
      throw new CliError(
        "VIBE_POLICY_PENDING",
        "Mistral Vibe held the approval policy change (pending); the turn was not started under an unconfirmed policy.",
      );
    }
    session.acknowledgedPolicy = target;
    session.runtimeMode = mode;
  }

  /** Send turn/interrupt for an identified server turn. */
  private async sendInterrupt(session: VibeSession, serverTurnId: string): Promise<void> {
    await session.peer.request(
      VIBE_METHODS.turnInterrupt,
      { sessionId: session.vibeSessionId, expectedTurnId: serverTurnId },
      this.requestTimeoutMs,
    );
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
        const running = this.runningTurn(session)
          // No active server turn: a stop that lands while a send is still
          // queued defers onto that send's row, to fire once it binds.
          ?? [...session.transcript].reverse().find((turn) => turn.status === "running");
        if (!running) return;
        if (!running.serverTurnId) {
          // The turn/start response has not bound the id yet: record the
          // request and send it once the id is known.
          running.interruptRequested = true;
          return;
        }
        await this.sendInterrupt(session, running.serverTurnId);
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
        // Never grant session-wide approvals inside worktree-isolated sessions
        // (already handled above), and never for a call through the lazy MCP
        // gateway: Vibe would remember it for `call_tool` as a whole, which
        // is every server and tool behind the gateway (LOCAL-032).
        const vibeDecisionType =
          decision.kind === "accept"
            ? "approve"
            : decision.kind === "acceptForSession"
              ? parked.isolated || !parked.rememberable
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
                disabledTools: [...VIBE_ALWAYS_DISABLED_TOOLS, DENY_ALL_TOOLS_PATTERN],
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
        disabledTools: [...VIBE_ALWAYS_DISABLED_TOOLS, DENY_ALL_TOOLS_PATTERN],
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
        // Settle every outstanding row and its waiters before closing: a
        // waiter parked on awaitTurn must never hang on a session that is
        // going away, and a row queued behind a policy write is outstanding
        // too — its completion would otherwise only ever bind to a closed
        // session.
        for (const row of this.runningRows(session)) {
          const usage = session.usage.take(row.id);
          settleAndPublishTurn({
            open: row,
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
        void session.gateway?.close().catch(() => undefined);
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

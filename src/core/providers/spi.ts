/**
 * Provider SPI — the driver contract for direct provider runtimes.
 *
 * Own code, mirroring the shape of the upstream reference's
 * `provider/Services/ProviderAdapter.ts` (capabilities, lifecycle, state,
 * streaming) without lifting its Layers or host services. Imports only our
 * own root types plus `effect` type-level modules, so drivers stay
 * dependency-clean. See docs/providers.md.
 */
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { McpServerSpec } from "../mcp.js";
import type { WorktreeIsolation } from "../threads/isolation.js";
import type { InteractionMode, ModelSelection, RuntimeMode } from "../types.js";

/** Provider surfaces we own. */
export type ProviderDriverKind = "claude" | "codex" | "chatgpt" | "opencode" | "harness" | "acp" | "antigravity" | "vibe";

export const PROVIDER_DRIVER_KINDS: readonly ProviderDriverKind[] = [
  "claude",
  "codex",
  "chatgpt",
  "opencode",
  "harness",
  "acp",
  "antigravity",
  "vibe",
];

export function isProviderDriverKind(value: unknown): value is ProviderDriverKind {
  return (
    typeof value === "string" &&
    (PROVIDER_DRIVER_KINDS as readonly string[]).includes(value)
  );
}

export { driverKindOfInstance } from "../types.js";

export type ThreadId = string;
export type TurnId = string;
export type ApprovalRequestId = string;

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderSessionStartInput {
  readonly threadId: ThreadId;
  readonly workingDirectory: string;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
  /**
   * The native session handle a previous process left behind (see
   * `ProviderAdapter.resumeCursor`). A driver resumes that provider-side
   * session — history included — when it still exists, and starts fresh
   * when it does not; a stale cursor must never fail the start.
   */
  readonly resumeCursor?: string;
  /**
   * MCP servers to expose in this session (`core/mcp.ts`), in addition to
   * whatever the provider's own config already loads. Each driver maps
   * them to its native form; a server the provider cannot run (Grok
   * without `mcpCapabilities.http`) is dropped rather than failing.
   */
  readonly mcpServers?: readonly McpServerSpec[];
  /** MCP tools to hide, as `mcp__<server>__<tool>` (a server's `disabledTools`). A driver that cannot hide single tools ignores it. */
  readonly disabledMcpTools?: readonly string[];
  /** The provider's own tools the user switched off (`core/nativetools.ts`). A driver that cannot remove them ignores it. */
  readonly disabledNativeTools?: readonly string[];
  /** Moxen's own base system prompt in place of the provider's (OpenCode; others keep theirs). Absent or false: the provider's. */
  readonly moxenPrompt?: boolean;
  /** False when the user switched the to-do list off for this provider: the driver offers the model none. Absent means on. */
  readonly checklist?: boolean;
  /**
   * Runtime instructions (`core/threads/instructions.ts`), appended to the
   * provider's own system prompt through its native channel. Absent when
   * none apply; a driver must then leave the prompt exactly as it is.
   */
  readonly instructions?: string;
  /**
   * Set when the session runs in its own worktree (`core/threads/isolation.ts`).
   * A driver must refuse tool calls that reach the checkout the worktree was
   * cut from, through whatever its provider offers natively; its standing
   * instruction is already part of `instructions`.
   */
  readonly isolation?: WorktreeIsolation;
  /** A delegated task: nobody is there to answer a question, so the driver asks none. */
  readonly delegated?: boolean;
  /**
   * Moxen memory is on for this session (`core/memory/`): a provider with a
   * memory of its own keeps it off here (Claude Code's auto memory), so the
   * agent has one memory, not two that disagree.
   */
  readonly moxenMemory?: boolean;
}

/**
 * How full the provider's context window is right now — what the model
 * will see on its next request, not tokens spent (`TokenUsageDelta`).
 * Every field but `usedTokens` is null when the provider does not say.
 */
export interface ContextWindowUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  /** Of `usedTokens`, how much the last request read from the prompt cache. */
  readonly cachedInputTokens: number | null;
  /** Where the provider compacts on its own, when it does. */
  readonly autoCompactThreshold: number | null;
  readonly compactsAutomatically: boolean | null;
  /** True when `usedTokens` is moxen's own count rather than one the provider reported. Absent means reported. */
  readonly estimated?: boolean;
  /**
   * Running thread total in USD — from the provider's own accounting where
   * reported (Claude: the SDK's `total_cost_usd`, ACP `cost`), or estimated
   * from Moxen's model prices when the provider reports none. Always an
   * estimate, not a bill; absent when no turn can be priced.
   */
  readonly costUsd?: number;
}

/**
 * What fills the context window, by category — the detail behind a
 * `ContextWindowUsage` reading. `estimated` is true when the shares are
 * moxen's estimate (message sizes scaled to the provider's real total)
 * rather than the provider's own count.
 */
export interface ContextBreakdown extends ContextWindowUsage {
  readonly categories: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
    /** `used` fills the window; `free` is what is left; `buffer` is held back for compaction. */
    readonly kind: "used" | "free" | "buffer";
  }>;
  readonly estimated: boolean;
  /** Per-tool shares of the conversation, heaviest first, when the provider reports them. */
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly tokens: number }>;
  /**
   * The provider's own per-model spend for this session, costliest first —
   * Claude Code's `modelUsage`, which prices every call it made (subagents and
   * auxiliary calls included), so it does not always match the thread's turns.
   * Absent where the provider reports no such split.
   */
  readonly costByModel?: ReadonlyArray<{ readonly model: string; readonly costUsd: number }>;
}

export interface ProviderSession {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly workingDirectory: string;
  readonly startedAt: string;
}

/** An image sent with a prompt: raw base64, not a data URL. */
export interface ProviderImage {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

/**
 * A steer pushed to the provider's running turn that the provider never
 * confirmed reaching the conversation. `id` is the `steerId` the push
 * carried (the ledger message id), or the driver's own when the push came
 * without one. Taking is destructive: each steer is reported once, so a
 * turn settling reports nothing twice.
 */
export interface UnconfirmedSteer {
  readonly id: string;
  readonly text: string;
  readonly images: readonly ProviderImage[];
}

/**
 * What a steer's text is, when it is not the user or another agent speaking:
 * Moxen's own runtime notice (a task settling, a background wake). Passed to
 * a driver that can tell its provider, so the turn reads it as a task
 * delivery rather than as a message the user sent mid-turn.
 */
export interface SteerOrigin {
  readonly notice: true;
  /** Report consumption, not just acceptance into the provider's input queue. */
  readonly onArrival?: () => void;
}

export interface ProviderSendTurnInput {
  readonly threadId: ThreadId;
  /** What the user said. A driver with `developerNotices` sends it unchanged, however this turn's notices read. */
  readonly prompt: string;
  /**
   * Moxen's own instruction for the model rather than the user's: a runtime
   * instruction update, a mode procedure, a rule-file patch, the continue
   * after a usage limit. Report data — a settled task's notice, captured
   * background output, a model's wrap-up notes — is not one of these: it stays
   * in `prompt`, tagged as the user text it is. A driver with
   * `developerNotices` delivers each notice on its developer-role channel and
   * sends `prompt` as it is. Empty `prompt` with notices is a notice-only turn.
   */
  readonly notices?: readonly string[];
  /** The original text prompt, in its composed order, for runtimes without notice injection. */
  readonly fallbackPrompt?: string;
  /** Logical delivery identity for retrying notice injection, independent of the provider turn ID. */
  readonly storeTurnId?: string;
  /**
   * Images for the model to see, in each provider's native form. A driver
   * whose provider cannot take them names them in the prompt instead —
   * see `imageMention` — so an image is never silently dropped.
   */
  readonly images?: readonly ProviderImage[];
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
}

/**
 * What a driver without a developer channel sends: Moxen's notices ahead of
 * the prompt, the tagged-block convention (`<moxen-mode>`,
 * `<moxen-instructions-update>`, `<moxen-context-update>`). A notice-only turn
 * has no prompt, so its text is the notices themselves. A blank notice carries
 * nothing to say and is dropped rather than adding an empty paragraph.
 */
export function promptWithNotices(prompt: string, notices: readonly string[] | undefined): string {
  const kept = (notices ?? []).filter((notice) => notice.trim().length > 0);
  if (kept.length === 0) return prompt;
  if (prompt.length === 0) return kept.join("\n\n");
  return `${kept.map((notice) => `${notice}\n\n`).join("")}${prompt}`;
}

export interface ProviderTurnStartResult {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export type ProviderApprovalDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "acceptForSession" }
  | { readonly kind: "decline" }
  | { readonly kind: "cancel" };

export type ProviderUserInputAnswers = Record<string, string>;

export interface ProviderUploadFeedbackInput {
  readonly threadId: ThreadId;
}

export interface ProviderUploadFeedbackResult {
  readonly threadId: ThreadId;
  readonly url: string | null;
}

/**
 * How a driver runs manual context compaction. Native drivers expose a
 * start call; slash-command drivers get the command sent as a turn.
 */
export type ProviderCompaction<TError> =
  | {
      readonly type: "native";
      readonly start: (
        threadId: ThreadId,
        modelSelection?: ModelSelection,
      ) => Effect.Effect<void, TError>;
    }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

/**
 * Whether a prompt is the bare `/compact` maintenance command (what every
 * client sends). A native driver runs it as the provider's own compaction
 * inside an ordinary turn; text after the command is not a bare command.
 */
export function isCompactCommand(prompt: string): boolean {
  return prompt.trim() === "/compact";
}

/**
 * One `awaitTurn` caller aborted: drop only its waiter, so the turn's other
 * waiters still settle. Removing the whole list (as aborting used to) rejects
 * every waiter on the turn with TURN_ABORTED, including callers that never
 * aborted.
 */
export function dropTurnWaiter<T>(waiters: T[], waiter: T): void {
  const at = waiters.indexOf(waiter);
  if (at >= 0) waiters.splice(at, 1);
}

export interface ProviderAdapterCapabilities {
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Starts a resumed turn with no synthetic user prompt when true. */
  readonly promptlessTurnContinuation?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
  /**
   * `ProviderSendTurnInput.notices` reach the model as developer-role items
   * rather than riding ahead of the user's prompt. The driver falls back on
   * the text convention itself when the runtime it talks to turns out not to
   * take them (an older Codex app-server, say), so a turn is never lost.
   */
  readonly developerNotices?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface TokenUsageDelta {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly output: number;
  readonly thinking: number;
  /** The turn's cost in USD when the provider reports one — an estimate, not a bill. */
  readonly costUsd?: number;
}

export interface RateLimitWindow {
  readonly id: string;
  readonly label: string;
  readonly resetsAt: string | null;
  readonly exhausted: boolean;
  /** How much of the window is spent (0–100), when the provider says. */
  readonly usedPercent?: number | null;
}

/**
 * Canonical runtime events. Every event carries its `provider` source tag;
 * `raw` preserves the provider-native payload for debugging (the
 * `providerRuntime.ts` raw-tag pattern). The typed bus in `src/events/`
 * transports these plus thread-lifecycle events.
 */
export type ProviderRuntimeEvent =
  | { readonly type: "session.title.updated"; readonly provider: ProviderDriverKind; readonly threadId: ThreadId; readonly title: string }
  | {
      /**
       * Streamed assistant text. `text` is a *delta*, appended to the
       * message named by `messageId` (one assistant message of possibly
       * several in a turn); a driver that only sees cumulative snapshots
       * sends the difference.
       */
      readonly type: "message.part.updated";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly messageId?: string;
      readonly text: string;
      readonly raw?: unknown;
    }
  | {
      /**
       * An assistant message that turned out *not* to be the turn's answer:
       * the notes the model writes between tool calls ("Now checking X…").
       * Sent once, whole, when the next tool call or message shows it was
       * interim. The turn's final message is never sent as a note.
       */
      readonly type: "assistant.note";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly messageId: string;
      readonly text: string;
    }
  | {
      /**
       * A turn the provider started on its own — Claude Code waking the
       * session for a finished background task or a Monitor event. It is
       * awaited and settled like any other turn (`awaitTurn`).
       */
      readonly type: "turn.started";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly origin: "background";
      /** Native start metadata when the provider does not expose the triggering message. */
      readonly wakeUpPrompt?: string;
    }
  | {
      /** Content of a provider-native automatic delivery, before its turn starts. */
      readonly type: "background.wake-up";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly requestId: string;
      readonly prompt: string;
    }
  | {
      /** One background task (a `run_in_background` command, a Monitor watch, a background subagent) starting or ending. */
      readonly type: "background.task";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly taskId: string;
      readonly status: "started" | "completed" | "failed" | "stopped";
      readonly description: string;
      readonly taskType: string | null;
      readonly toolUseId: string | null;
      readonly summary: string | null;
    }
  | {
      /** The full live set of background tasks (a level, not an edge). */
      readonly type: "background.tasks.changed";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly tasks: ReadonlyArray<BackgroundTaskSummary>;
    }
  | {
      readonly type: "tool.execute.started" | "tool.execute.updated" | "tool.execute.completed";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly tool: string;
      readonly raw?: unknown;
    }
  | {
      readonly type: "turn.plan.updated";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly raw?: unknown;
    }
  | {
      readonly type: "permission.request.opened" | "permission.request.resolved";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
      readonly raw?: unknown;
    }
  | {
      readonly type: "user-input.request.opened" | "user-input.request.resolved";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
      readonly raw?: unknown;
    }
  | {
      readonly type: "token-usage.updated";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly usage: TokenUsageDelta;
      readonly raw?: unknown;
    }
  | {
      /**
       * One stretch of the model's reasoning: sent as it starts (`running`)
       * and once it ends (`completed`, with how long it took). `text` is the
       * whole readable summary so far — empty when the provider shows none.
       * The same `reasoningId` names both, so they fold into one row.
       */
      readonly type: "reasoning.updated";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly reasoningId: string;
      readonly status: "running" | "completed";
      readonly text: string;
      readonly startedAt: string | null;
      readonly durationMs: number | null;
    }
  | {
      /**
       * Readable reasoning as it streams, between a `reasoning.updated`
       * `running` and its `completed`: `text` is a delta of the
       * `reasoningId` stretch. Live only — the completed event carries the
       * whole text for the record.
       */
      readonly type: "reasoning.delta";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly reasoningId: string;
      readonly text: string;
    }
  | {
      /**
       * The provider switched models on its own mid-turn — Claude re-running
       * a request its safety classifiers flagged (`refusal-fallback`). With
       * `scope: "session"` the switch sticks: later turns run on `to`.
       * `local` means only a subagent's or side question's response moved.
       */
      readonly type: "model.changed";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly from: string | null;
      readonly to: string;
      /** Display names for `from` / `to`, when the driver knows them. */
      readonly fromLabel?: string | null;
      readonly toLabel?: string | null;
      /** `auto`: any other switch the provider made itself (an overloaded model's fallback, say). */
      readonly reason: "refusal-fallback" | "auto";
      readonly scope: "session" | "local";
      /** Why the request was flagged ("bio", "cyber", …), when the provider says. */
      readonly category: string | null;
    }
  | {
      /**
       * Something the provider did to the session that the transcript should
       * say: it compacted the conversation (`detail` is the summary it kept),
       * or its auto mode refused a tool call (`detail` is why). A harness
       * session whose automatic compaction gave up says so too, in `title`, and one
       * whose MCP servers did not all come up, or were reconfigured while it ran, says
       * that as `mcp`. A turn the provider accepted whose deferred interrupt failed
       * says so as `interrupt-failed` (`detail` is the provider's error): the turn
       * keeps running under its own completion tracking.
       */
      readonly type: "session.notice";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly notice: "compacted" | "permission-denied" | "compaction-stopped" | "mcp" | "interrupt-failed";
      readonly title: string;
      readonly detail: string | null;
    }
  | {
      /**
       * What the user will likely ask next, predicted after a turn ends
       * (Claude's prompt suggestions). Arrives after the turn has settled.
       */
      readonly type: "prompt.suggested";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly suggestion: string;
    }
  | {
      /**
       * A provider-native subagent (Claude's Agent tool, OpenCode's
       * `subagent` tool) starting or stopping, with the last thing it said.
       * Moxen's own delegated threads are threads, not this.
       */
      readonly type: "subagent.updated";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly agentId: string;
      readonly agentType: string;
      readonly status: "started" | "stopped";
      readonly lastMessage: string | null;
      /** What it was sent to do, where the provider says so as it starts (OpenCode). */
      readonly description?: string | null;
    }
  | {
      /**
       * Output already streamed that the provider took back — the partial a
       * refused request produced before it was re-run. `messageIds` name
       * assistant messages (as `message.part.updated` / `assistant.note`
       * carried them); `toolUseIds` name tool calls.
       */
      readonly type: "message.retracted";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly messageIds: ReadonlyArray<string>;
      readonly toolUseIds: ReadonlyArray<string>;
    }
  | {
      readonly type: "rate-limits.updated";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly windows: ReadonlyArray<RateLimitWindow>;
      /**
       * The provider instance whose account these windows belong to, when it
       * is narrower than the driver (OpenCode Go: one instance, not every
       * OpenCode provider). Absent means the driver's own account.
       */
      readonly instanceId?: string;
      /**
       * This report listed every window the account has (a probe, or a
       * driven refresh), so it replaces the recorded list: a window it leaves
       * out was withdrawn by the provider. Absent means it refreshed only the
       * windows it names and the rest keep their last reading.
       */
      readonly complete?: boolean;
      /** Optional remaining credit balance reported alongside quota windows (e.g. Antigravity `/credits`). */
      readonly credits?: number | null;
      readonly raw?: unknown;
    }
  | {
      readonly type: "turn.completed" | "turn.failed" | "turn.interrupted";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly raw?: unknown;
    }
  | {
      readonly type: "thread.state.changed";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly state: string;
      readonly raw?: unknown;
    };

/** A live background task, as a driver reports it. */
/**
 * One entry of a native subagent's conversation, oldest first, as a driver
 * that keeps it elsewhere than Claude's on-disk transcripts reads it back
 * (OpenCode: the child session). Tool entries carry the provider's own tool
 * payload, mapped by `toolActivityRow` exactly as live calls are.
 */
export type SubagentHistoryItem =
  | { readonly kind: "prompt" | "text" | "reasoning"; readonly id: string; readonly at: string | null; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly at: string | null; readonly tool: string; readonly raw: Record<string, unknown> };

export interface BackgroundTaskSummary {
  /** False when the native runtime reports work but cannot stop it independently. */
  readonly stoppable?: boolean;
  readonly taskId: string;
  readonly taskType: string | null;
  readonly description: string;
  /** The tool that started it ("Bash", "Monitor", …) — same `taskType` covers both, so this is what tells them apart. */
  readonly toolName?: string | null;
  /** The originating command/script text, when the driver can recover it. */
  readonly command?: string | null;
  readonly startedAt?: string | null;
}

/**
 * The provider's own session title, for the drivers whose provider keeps
 * one (Claude Code, OpenCode). `cursor` is the native session handle
 * (`resumeCursor`); `workingDirectory` is where that session lives. Each
 * method is omitted where the provider lacks the capability: moxen never
 * generates a title itself, it reads or asks the provider to.
 */
export interface ProviderSessionTitles {
  /** The session's title, or null while the provider has not titled it. Never a first-prompt fallback. */
  readonly sessionTitle?: (cursor: string, workingDirectory: string) => Promise<string | null>;
  /** Set the session's title natively. */
  readonly renameSession?: (cursor: string, workingDirectory: string, title: string) => Promise<void>;
  /** Have the provider title the session again from its conversation; resolves to the new title, null when it made none. */
  readonly regenerateSessionTitle?: (cursor: string, workingDirectory: string) => Promise<string | null>;
}

export interface ProviderAdapter<TError = unknown> extends ProviderSessionTitles {
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;
  /** A fresh tool-free completion, where the native runtime can enforce an empty tool set. */
  readonly completeText?: (input: TextCompletionInput) => Promise<string>;

  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * The native handle that resumes this thread's provider-side session in a
   * later process, or null while there is none yet. The turn runner
   * persists it on the thread; without it every restart of the host
   * process silently started the provider with an empty history.
   */
  readonly resumeCursor: (threadId: ThreadId) => string | null;

  /**
   * The thread's current context-window reading, or null when the driver
   * has none. Read by the turn runner as a turn settles and recorded as a
   * `context-window.updated` activity, which is what the TUI's context
   * indicator shows. Omitted by drivers whose provider reports nothing.
   */
  readonly contextUsage?: (threadId: ThreadId) => Promise<ContextWindowUsage | null>;

  /**
   * Tokens the currently running turn has spent so far, before it settles into
   * the thread store — or, with a driver turn id, that specific turn's usage
   * (its settled outcome usage once it terminated), so an interrupted run can
   * ask for its own turn and never whatever turn the session happens to have
   * open (LOCAL-009). Null when the turn is unknown or the driver has not
   * observed any usage for it yet.
   */
  readonly liveTurnUsage?: (threadId: ThreadId, driverTurnId?: ThreadId) => TokenUsageDelta | null;

  /**
   * Hand the running turn more input without interrupting it: the model
   * picks the text up at its next step (Claude folds it in between tool
   * rounds; Codex `turn/steer`). Fails when no turn is running. Omitted by
   * drivers whose provider cannot take input mid-turn (Grok's ACP has no
   * such request) — a steer then stays recorded in the ledger only.
   *
   * `steerId` is the ledger message id core filed the steer under, when the
   * caller has one: a driver that can confirm provider-side arrival keys its
   * pending steers by it, so the turn runner can match a confirmation (or a
   * redelivery) back to the recorded message exactly. Drivers without a
   * confirmation signal ignore it.
   *
   * `origin` says what the text is: Moxen's own runtime notice, rather than
   * something the user or another agent typed. A driver that can tell its
   * provider passes the provenance on, so the turn reads the notice as a task
   * delivery instead of a message from the user sent mid-turn.
   */
  readonly steerTurn?: (threadId: ThreadId, text: string, images?: readonly ProviderImage[], steerId?: string, origin?: SteerOrigin) => Effect.Effect<void, TError>;

  /**
   * Whether this driver can say that a steer reached the conversation for the
   * thread's current session: it has proven the provider reports what it
   * consumed (Claude's `user_message_uuid` echoes), so a push is not trusted
   * blindly. False before that proof, and absent for drivers with no arrival
   * signal at all. Core uses it to deliver a runtime notice as a durable turn
   * rather than trusting a push that may be dropped — a notice must never be
   * lost, so it is only trusted to a driver that reports arrivals.
   */
  readonly reportsSteerArrival?: (threadId: ThreadId) => boolean;

  /**
   * A steer handed to the provider's running turn that the provider has not
   * confirmed reaching the conversation.
   */
  readonly takeUnconfirmedSteers?: (threadId: ThreadId) => ReadonlyArray<UnconfirmedSteer>;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Omitted when the driver does not support manual context compaction. */
  readonly compaction?: ProviderCompaction<TError>;

  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<void, TError>;

  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  readonly stopAll: () => Effect.Effect<void, TError>;

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/** A side question (`/btw`); see `TurnDriver.sideQuestion`. */
export interface SideQuestionInput {
  /** The thread's native session (`resumeCursor`); null answers without its context. */
  readonly cursor: string | null;
  readonly workingDirectory: string;
  readonly question: string;
  /** The thread's model, so the side answer comes from the same one. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface SideAnswer {
  readonly text: string;
  /** False when there was no session to copy, so the answer had no thread context. */
  readonly withContext: boolean;
}

/** A fresh, tool-free text request, independent of any thread or provider session. */
export interface TextCompletionInput {
  readonly workingDirectory: string;
  readonly model: string;
  readonly prompt: string;
  readonly instructions: string;
  readonly instanceId?: string;
  readonly signal?: AbortSignal;
}

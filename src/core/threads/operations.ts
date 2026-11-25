/**
 * Thread operations: the store, the drivers, and the turn runner composed
 * into the things a client actually asks for — start a turn, hand over to
 * a new thread, delegate a task, list and read threads.
 *
 * The CLI used to own these, one copy per command, and the server had its
 * own thinner copy of some of them. That is how they drifted: the CLI
 * resolved model selections from config while the server hardcoded one,
 * the server's turn start left a turn `running` forever when its session
 * failed to start, and only the CLI knew about worktrees, project policy
 * or delegation. Every client now calls these; `server/connection.ts`
 * exposes them over `ClientApi`.
 *
 * Results are domain values, not CLI envelopes: the envelope keys the CLI
 * prints (`runtime`, `auth`, `dispatch`, `verification`, `opened`) are its
 * own compatibility surface and stay there.
 */
import { removeProjectSkills } from "../skills/projectskills.js";
import { sessionTtlFor, durationMs } from "./idle.js";
import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import os from "node:os";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { decodeDataUrl, imageMention, type ImageAttachmentUpload } from "../attachments.js";
import {
  defaultModelSelection,
  followUpSelection,
  resolveModelSelection,
  type ModelRequest,
  defaultRuntimeMode,
} from "../catalog/selection.js";
import { resolveDelegatedRuntimeMode } from "../catalog/permissions.js";
import { APP_NAME } from "../config.js";
import { CliError } from "../errors.js";
import { storedInteractionMode } from "../interactionmode.js";
import { disabledNativeToolNames, effectiveDisabledNativeTools } from "../nativetools.js";
import { codexImageGenDisabledTools } from "../providers/chatgpt/companion.js";
import { resolveProfileProviderConfig } from "../providers/accounts.js";
import { moxenToolsOf, outOfProcess, parseNameList, resolveMcpServers, routeMcpServers, type McpServerEntry, type McpServerSpec, type OutOfProcessMcpServerSpec } from "../mcp.js";
import { runProcess } from "../infra/process.js";
import { renameReplacing, writeAtomic } from "../infra/atomic.js";
import {
  ensureStoredProject,
  listStoredProjects,
  projectForWorkspace,
  resolveStoredProject,
  type StoredProject,
} from "../projects/projects.js";
import { createScratchDir, ensureScratchProject, scratchDirFor, scratchRoot } from "../projects/scratch.js";
import { resolveWorkspace } from "../projects/workspace.js";
import type {
  CliConfig,
  EffectiveThreadEnvMode,
  InteractionMode,
  ModelSelection,
  ProjectPolicy,
  RuntimeMode,
  ThreadEnvelope,
  ThreadEnvMode,
  WorkspaceMode,
  WorkspaceResolution,
} from "../types.js";
import { isCompactCommand, type BackgroundTaskSummary, type ContextWindowUsage, type ProviderImage, type ProviderRuntimeEvent } from "../providers/spi.js";
import { antigravityUnsupportedUseAllowed, driverKindOfInstance } from "../types.js";
import { prefersColdHandoff } from "../usage/coldresume.js";
import { usageKeyForInstance } from "../usage/limits.js";
import { driverKey, ensureDriverSession, executeTurn, imagesOf, runPromotedTurn, type TurnDriver } from "./execute.js";
import { pendingRuleUpdate, withRuleUpdate, type PendingRuleUpdate } from "./rulefiles.js";
import { SELF_QUEUED_HEADER, TASK_MESSAGE_HEADER, buildRuntimeInstructions, planInstructions, projectInstructions, projectMemorySetting, runningModelOf, withInstructionsUpdate, type InstructionState } from "./instructions.js";
import { modeChange, withModeChange } from "./modes.js";
import { ranTurns, toThreadEnvelope } from "./project.js";
import type { ThreadStore } from "./store.js";
import { readThread, threadStatus } from "./threads.js";
import {
  adoptProviderTitle,
  continuationInFlight,
  createThread,
  continuationBusyError,
  deleteThread,
  delegationForChild,
  failTurn,
  hiddenTurnsProblem,
  hiddenLedgerProblem,
  isContinuationBusy,
  isStaleContinueTurn,
  reconcileOrphanedTurn,
  holdStrandedPromotions,
  inspectThread,
  interruptTurn,
  listThreads,
  liveTurn,
  openTurn,
  applySnoozeCheck,
  promoteDueScheduledTurn,
  promoteQueuedTurn,
  redeliverOrphanedSteers,
  requeueUnownedTurn,
  sendTurn,
  settleThread,
  snoozeKey,
  snoozeThread,
  threadFamily,
  trackContinuation,
  turnPrompt,
  unsettleThread,
  untrackContinuation,
  unsnoozeThread,
  unreadableTurnsError,
  updateThreadMeta,
  wakeUpHasRiders,
  type SendTurnResult,
} from "./threads.js";
import { armScheduledTurn, disarmScheduledTurn } from "./schedule.js";
import { parseScheduledTime } from "./scheduledtime.js";
import { QUEUE_ADMISSION_LOCK, conditionBlockers, hasSnoozeConditions, isTransferDestinationRequestId, isTransferLanded, isTransferredTurn, loadTurnOrigins, queueAdmission, parseQueuePolicy, providerExhausted, resolveQueueResetConditions, snoozeActive, transferDestinationRequestId, transferRequestId, turnOriginKey, type QueueCondition, type QueuePolicy, type QueueRow, type WorkQueueEntry } from "./queue.js";
import { buildHandoff, continuedTitle } from "./handoff.js";
import { COMPACTED_CONTINUE_PROMPT, COMPACT_PROMPT, planLongThreadAction, type LongThreadAction, type LongThreadSnapshot } from "./longthreads.js";
import { USAGE_CONTINUE_GRACE_MS, USAGE_CONTINUE_PROMPT } from "./views.js";
import { reportHeadline, reviewFactsOf, reviewVerdictOf, taskNotificationText, type BackgroundWorkNote, type ReviewFacts, type ReviewVerdict, type TaskNotification } from "./notify.js";
import { CHECKPOINT_REF_NAMESPACE, diffCheckpointStat, restoreWorktreeTo } from "../checkpoints/git.js";
import { readStatus } from "../git/history.js";
import { RESEARCH_LENSES, RESEARCH_SIZE_MESSAGE, isValidResearchSize, type ResearchLens } from "./researchvocab.js";
import type { ResearchMessage, ResearchPlan, ResearchModels, ResearchSize, ResearchRole, StoredMessage, StoredResearchRun, SendTurnInput, StoredActivity, StoredDelegation, StoredThread, StoredTurn, UsagePause } from "./types.js";
import {
  delegatedStatusOf,
  delegatedWorkStateOf,
  isThreadActive,
  isVisibleThread,
  latestAssistantText,
  normalizeReadView,
  threadInspectionView,
  threadListStatus,
  threadReadView,
  type DelegatedTaskStatus,
  type DelegatedTaskWorkState,
  type ThreadInspection,
  type ThreadListStatus,
  type ThreadReadView,
  type ThreadReading,
} from "./views.js";

/** A thread with its full ledger projected — messages, activities, checkpoints. */
export async function threadWithLedger(store: ThreadStore, threadId: string): Promise<ThreadEnvelope> {
  const read = await readThread(store, threadId, { view: "messages" });
  return toThreadEnvelope(read.thread, read.turns, {
    messages: read.messages,
    activities: read.activities,
    checkpoints: read.checkpoints,
  });
}

/** What every operation runs against. One per connection (or CLI process). */
export interface OperationContext {
  readonly store: ThreadStore;
  readonly storeRoot: string;
  readonly config: CliConfig;
  /** The driver for a model-selection instance id, shared per context. */
  readonly driverFor: (instanceId: string) => TurnDriver;
  /**
   * MCP servers every top-level thread gets from moxen itself (the
   * `moxen` delegate tools). Config and the project's `moxen.json` layer
   * over them by name, so `"moxen": null` there removes them. Delegated
   * threads get none: a subagent does not spawn subagents.
   */
  readonly builtinMcpServers?: (threadId: string, options?: BuiltinMcpOptions) => readonly McpServerSpec[] | Promise<readonly McpServerSpec[]>;
}


/** Which of Moxen's own tools a session's `moxen` server offers. */
export interface BuiltinMcpOptions {
  /** No delegation tools: a delegated task, or a provider with orchestration off. */
  readonly delegated: boolean;
  readonly webFetch?: boolean;
  /** Moxen memory's tools: all three, `memory_read` alone (a delegated task), or none. Absent: write. */
  readonly memory?: "read" | "write" | "off";
}

/** Runtime instructions the model has not seen yet: put before the next prompt, then recorded as delivered. */
interface InstructionsUpdate {
  readonly text: string;
  /** Record the update as delivered; called once the provider has answered the prompt that carried it. */
  readonly delivered: () => Promise<void>;
}

/** The part of a session setup `ensureDriverSession` takes. */
function sessionStart(setup: { mcpServers: McpServerSpec[]; disabledMcpTools: string[]; disabledNativeTools: string[]; moxenPrompt: boolean; checklist: boolean; instructions: string; store: ThreadStore; delegated: boolean; idleTtlMs: number | null; moxenMemory: boolean }) {
  return {
    mcpServers: setup.mcpServers,
    disabledMcpTools: setup.disabledMcpTools,
    disabledNativeTools: setup.disabledNativeTools,
    moxenPrompt: setup.moxenPrompt,
    checklist: setup.checklist,
    instructions: setup.instructions,
    store: setup.store,
    delegated: setup.delegated,
    idleTtlMs: setup.idleTtlMs,
    moxenMemory: setup.moxenMemory,
  };
}

/** A mode change the conversation has not heard of yet (`modes.ts`): put before the next prompt, then recorded. */
interface ModeUpdate extends InstructionsUpdate {
  readonly mode: InteractionMode;
}

interface PendingUpdates {
  readonly instructionsUpdate: InstructionsUpdate | null;
  readonly modeUpdate: ModeUpdate | null;
}

/** The prompt a turn sends the provider: what was typed, with any instruction update and mode change ahead of it. */
function promptWithUpdate(prompt: string, setup: PendingUpdates): string {
  const withMode = setup.modeUpdate ? withModeChange(prompt, setup.modeUpdate.text, setup.modeUpdate.mode) : prompt;
  return withInstructionsUpdate(withMode, setup.instructionsUpdate?.text ?? null);
}

async function withUsageProtectionContext(ctx: OperationContext, thread: StoredThread, prompt: string): Promise<string> {
  if (!thread.usagePause) return prompt;
  const tasks = (await ctx.store.readActivities(thread.id)).filter((row) => row.kind === "usage.background" && row.payload?.order === thread.usagePause!.order);
  const wrapTurnId = thread.usagePause.turnId;
  const replies = wrapTurnId ? (await ctx.store.readMessages(thread.id)).filter((row) => row.turnId === wrapTurnId && row.role === "assistant" && row.text.trim()) : [];
  // An interrupted provider session may not retain its final streamed text.
  // Give recovery the durable notes even when resuming that same session.
  if (replies.length) prompt += `\n\n## Usage-protection wrap-up notes\n\n${replies.map((row) => row.text).join("\n\n")}`;
  if (!tasks.length) return prompt;
  const notes = tasks.map(({ payload }) => ({ taskId: payload!.taskId, description: payload!.description, status: payload!.status, output: Array.isArray(payload!.output) ? payload!.output.slice(-40) : null }));
  return `${prompt}\n\nUsage protection stopped or detached background work. Check it again before relying on its result or restarting it. Detached means the stop was not confirmed; it may still be running. The last 40 output lines follow; the thread keeps the full captured output:\n${notes.map((note) => JSON.stringify(note)).join("\n")}`;
}

/** What to record once the provider answered a prompt `promptWithUpdate` built. */
function deliveredSteps(setup: PendingUpdates): Array<() => Promise<void>> {
  return [setup.instructionsUpdate?.delivered, setup.modeUpdate?.delivered].filter((step): step is () => Promise<void> => step !== undefined);
}

/**
 * What an unanswered continue still owes its conversation: never the
 * automatic nudge itself, but any user messages folded into its turn —
 * without them the re-ask would leave that content in neither the new
 * prompt nor any live session.
 */
function unansweredContinueText(messages: readonly StoredMessage[], turn: StoredTurn): string | null {
  const riders = messages
    .filter((message) => message.turnId === turn.id && message.role === "user" && message.id !== turn.messageId && message.text.trim().length > 0)
    .map((message) => message.text.trim());
  const first = messages.find((message) => message.id === turn.messageId);
  if (first && first.text.trim().length > 0 && first.text.trim() !== USAGE_CONTINUE_PROMPT.trim()) riders.unshift(first.text.trim());
  return riders.length > 0 ? riders.join("\n\n") : null;
}

/**
 * A conversation with no history starts clean, but an earlier turn on it may
 * have ended with no output from the provider (a usage limit; see `unanswered`
 * on the turn): the provider never read that prompt, and the work is in it
 * (a handoff document, say). Those prompts go ahead of this one, up to the
 * last turn the provider did answer. A usage continue is only a nudge and stays out.
 * An interrupted turn is not one of these if it ran: the provider may have read it.
 * One stopped while it waited (no owner, so it never ran) says nothing either way.
 */
async function withUnansweredPrompts(
  ctx: OperationContext,
  thread: StoredThread,
  turnId: string,
  setup: { fresh: boolean; key: string },
  prompt: string,
): Promise<string> {
  // A slash command has to stay first for the provider to read it as one.
  if (!setup.fresh || prompt.trimStart().startsWith("/")) return prompt;
  const turns = await ctx.store.readTurns(thread.id);
  if (!turns.some((turn) => turn.unanswered)) return prompt;
  const messages = await ctx.store.readMessages(thread.id);
  let owed: string[] = [];
  for (const turn of turns) {
    if (turn.id === turnId || driverKey((turn.modelSelection ?? thread.modelSelection).instanceId) !== setup.key) continue;
    if (turn.unanswered) {
      // A usage continue is only a nudge and stays out — but user messages
      // folded into its turn still need asking.
      const own = turn.scheduleReason === "usage-reset" ? unansweredContinueText(messages, turn) : turnPrompt(messages, turn)?.text;
      if (own) owed.push(own);
    } else if (turn.owner && (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")) owed = [];
  }
  return owed.length === 0 ? prompt : `${owed.join("\n\n")}\n\n${prompt}`;
}

/**
 * The mode change a provider's conversation is owed: the thread's mode
 * against the one it was last told (`StoredThread.modeState`; nothing said
 * means Build). A conversation with no history has heard nothing. OpenCode
 * keeps the mode as an instruction entry its driver sets, so it owes none.
 */
function pendingModeUpdate(ctx: OperationContext, thread: StoredThread, key: string, history: boolean): ModeUpdate | null {
  if (key === "opencode") return null;
  const told = (history ? thread.modeState?.[key] : undefined) ?? "default";
  const text = modeChange(told, thread.interactionMode);
  if (text === null) return null;
  return {
    text,
    mode: thread.interactionMode,
    delivered: async () => {
      await ctx.store.withThreadLock(thread.id, async () => {
        const fresh = await ctx.store.readThreadRecord(thread.id);
        if (!fresh) return;
        await ctx.store.writeThreadRecord({ ...fresh, modeState: { ...fresh.modeState, [key]: thread.interactionMode } });
      });
    },
  };
}

/**
 * What a session on this thread starts with beyond its model: the MCP
 * servers and the runtime instructions. Both are read per session start,
 * like config, so an edit applies to the next session without a restart.
 *
 * The instructions a session *starts with* are the ones its conversation
 * began with, not the current ones: rewriting the system prompt of a
 * conversation with history would have the provider read all of it afresh.
 * A change since then comes back as `instructionsUpdate`, to ride ahead of
 * the next prompt (`planInstructions`).
 */
async function sessionSetup(
  ctx: OperationContext,
  thread: StoredThread,
  instanceId: string = thread.modelSelection.instanceId,
): Promise<{ mcpServers: McpServerSpec[]; disabledMcpTools: string[]; disabledNativeTools: string[]; moxenPrompt: boolean; checklist: boolean; instructions: string; store: ThreadStore; instructionsUpdate: InstructionsUpdate | null; modeUpdate: ModeUpdate | null; fresh: boolean; key: string; delegated: boolean; idleTtlMs: number | null; moxenMemory: boolean }> {
  const project = await projectById(ctx.storeRoot, thread.projectId);
  const workspaceRoot = project?.workspaceRoot ?? (thread.env.path.trim() || null);
  const delegation = await delegationOf(ctx.store, thread.id);
  const kind = driverKindOfInstance(instanceId);
  const providerConfig = resolveProfileProviderConfig(ctx.config, instanceId);
  // A delegated thread gets Moxen's tools less the ones that delegate (it does not delegate again), and so does a provider
  // the user turned orchestration off for; `web_fetch` is switched on its own. With both off, the server is left out.
  const reach = moxenToolsOf(providerConfig);
  // Moxen memory: the config's switch and the project's moxen.json (`"memory": false`); a delegated task only reads it.
  const memoryOn = ctx.config.memory !== false && providerConfig?.memory !== false && (await projectMemorySetting(workspaceRoot)) !== false;
  const memory = !memoryOn ? "off" : delegation !== null ? "read" : "write";
  const builtin =
    !reach.orchestration && !reach.webFetch && memory === "off"
      ? []
      : (await ctx.builtinMcpServers?.(thread.id, {
          delegated: delegation !== null || isResearchRunActive(thread.researchRun) || !reach.orchestration,
          webFetch: reach.webFetch, memory,
        }) ?? []);
  const base: Record<string, McpServerEntry> = {};
  for (const built of builtin) {
    // Layered by name like any configured server, in the form a config entry has.
    const spec = outOfProcess(built);
    if (spec.type === "stdio") base[spec.name] = { type: "stdio", command: spec.command, args: spec.args, env: spec.env };
    else base[spec.name] = { type: "http", url: spec.url, headers: spec.headers };
  }
  const [resolved, fromProject] = await Promise.all([
    resolveMcpServers({ ...base, ...ctx.config.mcpServers }, workspaceRoot),
    projectInstructions(workspaceRoot),
    // Moxen ships no skills now: copies an older Moxen made in this checkout (`.moxen-skill.json`) come out.
    thread.env.path.trim() === "" ? Promise.resolve([]) : removeProjectSkills(thread.env.path),
  ]);
  // A built-in server the config left as it was keeps everything its
  // config-shaped entry dropped: in-process hosting, `alwaysLoad`. One the
  // config replaced (or removed, with `null`) is the config's.
  const merged = resolved.map((spec) => {
    const built = builtin.find((candidate) => candidate.name === spec.name);
    return built !== undefined && sameEndpoint(outOfProcess(built), spec) ? built : spec;
  });
  // Servers switched off, or not offered to this provider, drop out; tools switched off are hidden by the driver.
  const { servers: mcpServers, disabledTools: disabledMcpTools } = kind === null ? { servers: merged, disabledTools: [] } : routeMcpServers(merged, kind, providerConfig?.mcpExclude);
  // Providers that ship built-in tools to switch off or web-tool order guidance; the Harness has its own.
  const nativeKind = kind === "codex" || kind === "claude" || kind === "opencode" || kind === "vibe" ? kind : null;
  const nativeConfig = nativeKind === null ? undefined : (providerConfig as { readonly disabledNativeTools?: string; readonly webSearchOrder?: string; readonly webFetchOrder?: string } | undefined);
  // Global, then this provider's, then the project's (a Harness profile's own come after, in its driver).
  const user = [ctx.config.instructions, providerConfig?.instructions, fromProject].filter((entry): entry is string => Boolean(entry?.trim()));
  const running = runningModelOf(thread.modelSelection, instanceId);
  const criticLens = thread.researchRole?.role === "critic" ? await criticLensOf(ctx, thread.researchRole.leadThreadId, thread.id) : undefined;
  const current = buildRuntimeInstructions({
    instanceId: thread.modelSelection.instanceId,
    ...(running ? { running } : {}),
    env: thread.env,
    delegation,
    researchLead: isResearchRunActive(thread.researchRun),
    ...(thread.researchRole ? { researchRole: thread.researchRole.role } : {}),
    ...(criticLens ? { criticLens } : {}),
    userInstructions: user,
    checklist: providerConfig?.todos !== false,
    delegationTools: !isResearchRunActive(thread.researchRun) && reach.orchestration && builtin.some((server) => server.name === "moxen"),
    knowledge: mcpServers.some((server) => server.name === "moxen" && builtin.includes(server)) &&
      !disabledMcpTools.includes("mcp__moxen__knowledge_search") && !disabledMcpTools.includes("mcp__moxen__knowledge_read"),
    ...(memory !== "off" && builtin.some((server) => server.name === "moxen") ? { memory } : {}),
    ...(nativeKind === null ? {} : { web: { provider: nativeKind, disabledNativeTools: nativeConfig?.disabledNativeTools, searchOrder: parseNameList(nativeConfig?.webSearchOrder), fetchOrder: parseNameList(nativeConfig?.webFetchOrder), servers: mcpServers } }),
  });
  // What this provider's conversation was given. With no history behind it (no session handle yet) there
  // is nothing cached to protect, so the current text starts it.
  const key = driverKey(instanceId);
  const history = thread.providerSessions?.[key] !== undefined;
  const state = history ? thread.instructionState?.[key] : undefined;
  const plan = planInstructions(state, current, thread.id);
  const next: InstructionState = plan.next;
  const record = async (state: InstructionState): Promise<void> => {
    await ctx.store.withThreadLock(thread.id, async () => {
      const fresh = await ctx.store.readThreadRecord(thread.id);
      if (!fresh) return;
      await ctx.store.writeThreadRecord({ ...fresh, instructionState: { ...fresh.instructionState, [key]: state } });
    });
  };
  const recorded = thread.instructionState?.[key];
  if (recorded?.baseline !== next.baseline || recorded?.delivered !== next.delivered) await record(next);
  const baseDisabledTools =
    nativeKind === null
      ? []
      : disabledNativeToolNames(effectiveDisabledNativeTools(nativeKind, nativeConfig?.disabledNativeTools));
  const disabledNativeTools =
    thread.hidden === true && nativeKind === "codex"
      ? [...new Set([...baseDisabledTools, ...codexImageGenDisabledTools(true)])]
      : baseDisabledTools;
  return {
    mcpServers,
    disabledMcpTools,
    disabledNativeTools,
    // OpenCode's own base prompt is replaced by Moxen's unless the user switched that off.
    moxenPrompt: nativeKind === "opencode" && ctx.config.providers?.opencode?.moxenPrompt !== false,
    checklist: providerConfig?.todos !== false,
    instructions: plan.systemPrompt,
    // So the session is watched between turns (background turns and tasks).
    store: ctx.store,
    delegated: delegation !== null,
    idleTtlMs: sessionTtlFor(ctx.config, instanceId),
    moxenMemory: memory !== "off",
    instructionsUpdate:
      plan.update === null
        ? null
        : { text: plan.update, delivered: () => record({ ...next, delivered: plan.update! }) },
    modeUpdate: pendingModeUpdate(ctx, thread, key, history),
    fresh: !history,
    key,
  };
}

/** Whether two out-of-process specs reach the same server the same way. */
function sameEndpoint(left: OutOfProcessMcpServerSpec, right: McpServerSpec): boolean {
  if (right.type === "in-process" || left.type !== right.type) return false;
  if (left.type === "http" && right.type === "http") {
    return left.url === right.url && JSON.stringify(left.headers) === JSON.stringify(right.headers);
  }
  if (left.type === "stdio" && right.type === "stdio") {
    return left.command === right.command && JSON.stringify(left.args) === JSON.stringify(right.args) && JSON.stringify(left.env) === JSON.stringify(right.env);
  }
  return false;
}

/**
 * Recover a thread whose running turn was orphaned — its process died
 * mid-turn, so nothing will ever settle it and every later send would
 * queue or steer into it forever. The orphan is interrupted; a queued turn
 * behind it is promoted and run here, on its own provider. Cheap when
 * there is nothing to do (one read of the turns ledger), so every entry
 * point that touches a thread can call it. Never throws.
 */
export async function recoverOrphanedTurn(ctx: OperationContext, threadId: string): Promise<boolean> {
  const result = await reconcileOrphanedTurn(ctx.store, threadId).catch(() => null);
  if (!result) return false;
  // Its process died with steers mid-flight whose arrival died with it: the
  // ledger still holds them, so they go out again as queued turns of their
  // own rather than vanishing. Marked, so a repeated recovery sends nothing
  // twice. They queue behind the promoted turn's run when there is one, and
  // run after it; with nothing promoted the first copy is run here, or the
  // copies would sit running with no runner and never heal in-process.
  const copies = await redeliverOrphanedSteers(ctx.store, threadId, result.interrupted.id, ctx.config).catch(() => [] as string[]);
  if (result.promoted && ctx.store.claimRun(result.promoted.id)) {
    await runRecoveredTurn(ctx, threadId, result.promoted).catch(() => undefined);
    return true;
  }
  if (!result.promoted && copies.length > 0) {
    for (const id of copies) await requeueUnownedTurn(ctx.store, threadId, id).catch(() => false);
    const next = await promoteQueuedTurn(ctx.store, threadId).catch(() => null);
    if (next && ctx.store.claimRun(next.id)) await runRecoveredTurn(ctx, threadId, next).catch(() => undefined);
  }
  return true;
}

/** The caller has claimed `turn` (`claimRun`); every way out here settles or frees it. */
async function runRecoveredTurn(ctx: OperationContext, threadId: string, turn: StoredTurn): Promise<void> {
  const { store } = ctx;
  try {
    const thread = await store.readThreadRecord(threadId);
    if (!thread) { store.untrackRunning(turn.id); return; }
    // Turns queued behind this one if it settles below with no runner to take
    // a promotion: settled without promoting, held for admission instead.
    const queuedBefore = new Set((await store.readTurns(threadId)).filter((candidate) => candidate.status === "queued").map((candidate) => candidate.id));
    // One message, or several queued ones batched into this turn at promotion.
    const message = turnPrompt(await store.readMessages(threadId), turn);
    if (message === null) {
      // A moved entry still being repaired (a crash between its turn and
      // message writes) must wait for the repair, not fail and not run: put
      // it back queued for the next continue on its source to complete.
      if (isTransferDestinationRequestId(turn.queue?.requestId)) {
        try {
          await store.withThreadLock(threadId, async () => {
            const fresh = (await store.readTurns(threadId)).find((candidate) => candidate.id === turn.id);
            if (fresh && fresh.status === "running") {
              await store.updateTurn(threadId, turn.id, { status: "queued", owner: null, updatedAt: store.nowIso() });
            }
          });
        } finally {
          store.untrackRunning(turn.id);
        }
        return;
      }
      await failTurn(store, threadId, turn.id, { error: "Its queued message is missing." }).catch(() => undefined);
      store.untrackRunning(turn.id);
      await holdStrandedPromotions(store, threadId, queuedBefore).catch(() => undefined);
      return;
    }
    const selection = turn.modelSelection ?? thread.modelSelection;
    const turnThread: StoredThread = { ...thread, modelSelection: selection, interactionMode: turn.interactionMode };
    let driver: TurnDriver;
    let setup: Awaited<ReturnType<typeof sessionSetup>>;
    try {
      driver = ctx.driverFor(selection.instanceId);
      // Codex and Harness fix MCP definitions at session creation. Resume the
      // same provider conversation with the request-scoped submission tool.
      if (turn.queue?.summaryFor && driver.stopSession) await Effect.runPromise(driver.stopSession(threadId));
      setup = await sessionSetup(ctx, turnThread, selection.instanceId);
      await ensureDriverSession(driver, turnThread, { modelSelection: selection, config: ctx.config, ...sessionStart(setup), ...longThreadHook(ctx, threadId), ...usageLimitHook(ctx, threadId, selection.instanceId) });
      await driver.updateMcpServers?.(threadId, setup.mcpServers).catch(() => undefined);
      // Config or rule files changed while the session sat idle: a live session
      // takes them now, like a fresh send does — never a reason to fail the resume.
      await driver.updateNativeTools?.(threadId, setup.disabledNativeTools, setup.moxenPrompt).catch(() => undefined);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      await failTurn(store, threadId, turn.id, { error: error.slice(0, 500) }).catch(() => undefined);
      store.untrackRunning(turn.id);
      // The failed start settled nothing that runs: a promotion it made has no
      // runner to take it, so hand those turns back to the admission path.
      await holdStrandedPromotions(store, threadId, queuedBefore).catch(() => undefined);
      return;
    }
    // Rule files edited while the session lived: a patch ahead of the prompt, like a fresh send.
    const rules = await pendingRuleUpdate(driver, threadId, driverKey(selection.instanceId), thread.env.path).catch(() => null);
    const images = await imagesOf(message.attachments);
    const steps = [...deliveredSteps(setup), ...(rules ? [async () => rules.commit()] : [])];
    void executeTurn({
      store,
      driver,
      threadId,
      storeTurnId: turn.id,
      prompt: withRuleUpdate(promptWithUpdate(await withUsageProtectionContext(ctx, thread, await withUnansweredPrompts(ctx, thread, turn.id, setup, message.text)), setup), rules?.text ?? null),
      ...(steps.length > 0 ? { afterAnswer: async () => void (await Promise.all(steps.map((step) => step()))) } : {}),
      ...(setup.fresh ? { freshConversation: true } : {}),
      interactionMode: turn.interactionMode,
      ...(images.length > 0 ? { images } : {}),
      modelSelection: selection,
      config: ctx.config,
      workingDirectory: thread.env.path,
      ...(turn.queue?.summaryFor ? {} : usageLimitHook(ctx, threadId, selection.instanceId)),
      ...(turn.queue?.summaryFor ? {} : longThreadHook(ctx, threadId)),
    })
      // A delegated task resumed after a usage limit (or recovered after a crash)
      // still owes its parent the report when it finally ends.
      .then(async () => {
        await syncResearchRun(ctx, threadId).catch(() => undefined);
        await notifyParentOfResumedTask(ctx, threadId).catch(() => undefined);
        // This thread's own recovery may have released task notices queued
        // while it could not receive them: they go out now, together.
        await flushTaskNotifications(ctx, threadId).catch(() => undefined);
        // Fresh work settling clears a cancelled mark, so task_status reads
        // the new outcome instead of the old cancellation.
        await clearCancelledOnSettle(ctx, threadId).catch(() => undefined);
      })
      .catch(() => undefined);
  } catch (cause) {
    // A ledger read (or prompt build) failed before any runner took the turn:
    // free the admission claim — the turn stays running for orphan recovery
    // to reap later — and let the caller see the failure.
    store.untrackRunning(turn.id);
    throw cause;
  }
}

// -- scheduled turns --------------------------------------------------------------

/**
 * Run the thread's scheduled turn once it is due and the thread is free.
 * Called by the schedule timer and by the shell poll; safe to call any time
 * — nothing happens when nothing is due or a turn is already running.
 * A candidate snapshot (threads with work, as the usage tick keeps) avoids
 * rereading idle history; idle dependencies of queued conditions are loaded
 * on top, as for the work queue.
 */
export async function runDueScheduledTurn(ctx: OperationContext, threadId: string, now = Date.now(), snapshot?: readonly QueueRow[]): Promise<boolean> {
  return ctx.store.withThreadLock(QUEUE_ADMISSION_LOCK, async () => {
    const rows = snapshot ? [...snapshot] : await queueRows(ctx);
    if (snapshot) await queueDependencies(ctx, rows);
    return admitQueuedTurn(ctx, threadId, rows, now);
  });
}

async function admitQueuedTurn(ctx: OperationContext, threadId: string, rows: QueueRow[], now: number): Promise<boolean> {
  await recoverOrphanedTurn(ctx, threadId);
  const thread = await ctx.store.readThreadRecord(threadId);
  let index = rows.findIndex((r) => r.thread.id === threadId);
  if (thread && index < 0) {
    // A snapshot that never contained this thread must not delay its
    // admission to the next rescan (cross-process scheduled work would wait
    // up to 60s): include it directly, the same fallback queueAgentMessage uses.
    rows.push({ thread, turns: await ctx.store.readTurns(threadId) });
    index = rows.length - 1;
  } else if (thread && index >= 0) {
    rows[index] = { thread, turns: await ctx.store.readTurns(threadId) };
  }
  const at = rows.findIndex((r) => r.thread.id === threadId);
  if (at < 0) return false;
  // A snooze that waits on conditions ends here as soon as they are met: the
  // passage that would start this thread's queued work is the one that wakes
  // it. A thread with nothing queued never reaches here — the periodic watch
  // (`SnoozeWatch`) covers it.
  const wake = await wakeSnoozeNow(ctx, threadId, rows, now);
  if (wake.thread) rows[at] = { ...rows[at]!, thread: wake.thread };
  const row = rows[at]!;
  // Provenance the admission pass reads: a turn whose origin lives only on
  // its message (pre-origin rows) is an automatic prompt when the ledger
  // says so, not a fresh user send.
  const origins = await loadTurnOrigins(ctx.store, rows, ctx.config);
  // An entry or thread condition can name a thread whose owner died
  // mid-turn: nothing there will ever settle it, so recover those threads
  // too instead of holding the waiter forever. Cheap when there is nothing
  // to do, like recovering the thread itself.
  const depended = new Set<string>();
  for (const turn of row.turns) {
    if (turn.status !== "queued" || !turn.queue) continue;
    for (const condition of turn.queue.conditions) {
      if ((condition.type === "entry" || condition.type === "thread") && condition.threadId !== threadId) depended.add(condition.threadId);
    }
  }
  for (const dependency of depended) await recoverOrphanedTurn(ctx, dependency);
  for (const dependency of depended) {
    // Recovery settles the dependency after the snapshot above was taken;
    // refresh its row so admission reads the settled turn, not the orphan.
    const thread = await ctx.store.readThreadRecord(dependency);
    if (!thread || thread.deletedAt) continue;
    const turns = await ctx.store.readTurns(dependency);
    const at = rows.findIndex((r) => r.thread.id === dependency);
    if (at >= 0) rows[at] = { thread, turns };
    else rows.push({ thread, turns });
  }
  const idle = !openTurn([...row.turns]);
  let messages: readonly StoredMessage[] | null = null;
  for (const candidate of [...row.turns].sort((a, b) => (a.queue?.order ?? Date.parse(a.createdAt)) - (b.queue?.order ?? Date.parse(b.createdAt)))) {
    if (candidate.status !== "queued") continue;
    // A plain turn still waits for the running turn's settle unless settle
    // held it for admission (a snoozed or settled thread, or an exhausted
    // provider) and the thread is idle now.
    if (!candidate.queue && !candidate.scheduledFor && (!candidate.heldAtSettle || !idle)) continue;
    // A stale automatic continue never fires as a pointless turn: the
    // thread's work already resumed, so it is taken back before it runs and
    // the loop moves on to whatever waits behind it.
    if (isStaleContinueTurn(row.turns, candidate, now)) {
      if (candidate.queue?.wakeUp === true) {
        messages ??= await ctx.store.readMessages(threadId).catch(() => []);
        if (wakeUpHasRiders(messages, candidate)) continue;
      }
      await interruptTurn(ctx.store, threadId, candidate.id).catch(() => undefined);
      rows[index] = { thread: (await ctx.store.readThreadRecord(threadId))!, turns: await ctx.store.readTurns(threadId) };
      continue;
    }
    const pause = row.thread.usagePause;
    if (pause?.forced) continue;
    if (candidate.queue?.continuation && candidate.queue.continuation !== "same-thread") continue;
    const summary = candidate.queue?.summaryFor && row.turns.find((t) => t.id === candidate.queue!.summaryFor && t.handoff?.summaryTurnId === candidate.id && t.status === "queued");
    if (candidate.queue?.summaryFor && !summary) continue;
    if (pause && pause.phase !== "resuming" && !summary && (pause.phase !== "waiting" || pause.error || pause.recoveryTurnId !== candidate.id)) continue;
    // A moved entry whose message never landed is incomplete: it must not
    // run, not even once, until a continue on its source repairs the copy.
    // Park it here with no activity; runRecoveredTurn's requeue stays as
    // backstop for anything that reaches a runner anyway.
    if (isTransferDestinationRequestId(candidate.queue?.requestId)) {
      messages ??= await ctx.store.readMessages(threadId).catch(() => []);
      if (!messages.some((message) => message.id === candidate.messageId)) continue;
    }
    const admission = queueAdmission(row, candidate, rows, ctx.config, now, origins);
    if (candidate.queue && (JSON.stringify(admission.latched) !== JSON.stringify(candidate.queue.latched ?? []) || JSON.stringify(admission.conditions) !== JSON.stringify(candidate.queue.conditions))) await ctx.store.withThreadLock(threadId, () => ctx.store.updateTurn(threadId, candidate.id, { queue: { ...candidate.queue!, latched: admission.latched, conditions: admission.conditions } }));
    if (admission.blocked.length) continue;
    if (await switchColdRecovery(ctx, row, candidate, now)) continue;
    const turn = await promoteDueScheduledTurn(ctx.store, threadId, candidate.id, !!summary);
    if (!turn || !ctx.store.claimRun(turn.id)) return false;
    await runRecoveredTurn(ctx, threadId, turn);
    rows[index] = { thread: (await ctx.store.readThreadRecord(threadId))!, turns: await ctx.store.readTurns(threadId) };
    return true;
  }
  return false;
}

/**
 * An automatic usage recovery that is due, on a thread whose prompt cache has
 * gone cold (`usageColdResume`), becomes a stored handoff instead: the work
 * queue prepares the new thread on its next pass. Returns whether it switched.
 */
async function switchColdRecovery(ctx: OperationContext, row: QueueRow, candidate: StoredTurn, now: number): Promise<boolean> {
  const queue = candidate.queue;
  if (!queue?.automatic || !queue.requestId?.startsWith("usage:") || queue.continuation !== "same-thread" || ctx.config.usageColdResume !== "handoff") return false;
  const times = row.turns.flatMap((turn) => (turn.id === candidate.id ? [] : [turn.completedAt, turn.startedAt].filter((at): at is string => typeof at === "string").map(Date.parse)));
  const lastActivityAt = times.length > 0 ? Math.max(...times) : null;
  const reading = (await ctx.store.readActivities(row.thread.id)).findLast((activity) => activity.kind === "context-window.updated")?.payload as Record<string, unknown> | undefined;
  const usedTokens = typeof reading?.usedTokens === "number" ? reading.usedTokens : null;
  if (!prefersColdHandoff(ctx.config, { lastActivityAt, usedTokens, now })) return false;
  await ctx.store.withThreadLock(row.thread.id, async () => {
    await ctx.store.updateTurn(row.thread.id, candidate.id, { queue: { ...queue, continuation: "stored" } });
    await ctx.store.appendLedger(row.thread.id, "activity", { id: ctx.store.newId(), threadId: row.thread.id, turnId: candidate.id, kind: "usage.cold-resume", summary: "Prompt cache expired; continuing in a new thread", payload: { lastActivityAt: new Date(lastActivityAt!).toISOString(), usedTokens }, createdAt: ctx.store.nowIso() });
  });
  ctx.store.emit(row.thread.id, "queue-changed");
  return true;
}

async function queueRows(ctx: OperationContext): Promise<QueueRow[]> {
  const rows: QueueRow[] = [];
  for (const id of await ctx.store.listThreadIds()) {
    const thread = await ctx.store.readThreadRecord(id);
    if (thread && !thread.deletedAt) rows.push({ thread, turns: await ctx.store.readTurns(id) });
  }
  return rows;
}

/**
 * Candidate snapshots omit idle dependencies; load only those referenced by
 * work or by a snooze. One loader for both, so an `entry` condition follows
 * every handoff its entry made whether a queued turn or a snooze is waiting on
 * it.
 */
async function queueDependencies(ctx: OperationContext, rows: QueueRow[]): Promise<void> {
  const known = new Set(rows.map((row) => row.thread.id));
  const load = async (id: string): Promise<QueueRow | undefined> => {
    if (!known.has(id)) {
      known.add(id);
      const thread = await ctx.store.readThreadRecord(id);
      if (thread && !thread.deletedAt) rows.push({ thread, turns: await ctx.store.readTurns(id) });
    }
    return rows.find((row) => row.thread.id === id);
  };
  const follow = async (condition: QueueCondition): Promise<void> => {
    if (condition.type !== "thread" && condition.type !== "entry") return;
    const dependency = await load(condition.threadId);
    if (condition.type !== "entry") return;
    let target = dependency?.turns.find((turn) => turn.id === condition.turnId);
    const seen = new Set<string>();
    while (target?.handoff && !seen.has(target.id)) {
      seen.add(target.id);
      const { destinationThreadId, requestId } = target.handoff;
      const destination = await load(destinationThreadId);
      target = destination?.turns.find((turn) => turn.queue?.requestId === `handoff:${requestId}`);
    }
  };
  for (const row of rows) {
    for (const turn of row.turns) {
      if (turn.status !== "queued") continue;
      for (const condition of turn.queue?.conditions ?? []) await follow(condition);
    }
    for (const condition of row.thread.snoozeConditions ?? []) await follow(condition);
  }
}

export async function readWorkQueue(ctx: OperationContext, snapshot?: readonly QueueRow[]): Promise<WorkQueueEntry[]> {
  const rows = snapshot ? [...snapshot] : await queueRows(ctx);
  if (snapshot) await queueDependencies(ctx, rows);
  const entries: WorkQueueEntry[] = [];
  for (const row of rows) {
    if (!row.turns.some((turn) => turn.status === "queued" || turn.queue && turn.status !== "completed")) continue;
    const messages = await ctx.store.readMessages(row.thread.id);
    const origins = await loadTurnOrigins(ctx.store, [row], ctx.config);
    for (const turn of row.turns) {
      if (turn.queue?.summaryFor || turn.status !== "queued" && !(turn.queue && turn.status !== "completed")) continue;
      const stopped = turn.status === "failed" || turn.status === "interrupted";
      let policy = turn.queue ? { ...turn.queue, ...(stopped ? { removed: true } : {}) } : parseQueuePolicy({ conditions: [], order: Date.parse(turn.createdAt), sequential: false });
      // The server-owned handoff wait is real for admission but hidden from
      // the projected policy: clients must neither see it as removable nor
      // echo it back through the 16-condition cap. Every core write
      // reattaches it, so the projection never loses it.
      if (isTransferDestinationRequestId(turn.queue?.requestId)) {
        const handoffTurn = [...row.turns]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .find((candidate) => !isTransferDestinationRequestId(candidate.queue?.requestId));
        const last = policy.conditions.at(-1);
        if (handoffTurn !== undefined && last?.type === "entry" && last.threadId === row.thread.id && last.turnId === handoffTurn.id) {
          policy = { ...policy, conditions: policy.conditions.slice(0, -1) };
        }
      }
      const blocked = queueAdmission(row, turn, rows, ctx.config, undefined, origins).blocked;
      if (stopped && !turn.queue?.removed) blocked.unshift(turn.error ?? "Stopped before completion; add back held to retry");
      if (policy.continuation !== "same-thread") blocked.unshift(turn.handoff?.fallback ? "Using stored handoff: model summary unavailable" : turn.handoff?.summary ? "Model handoff received" : policy.continuation === "model" ? "Preparing model handoff" : "Preparing stored handoff");
      if (row.thread.usagePause && row.thread.usagePause.phase !== "resuming") blocked.unshift("Waiting for usage protection");
      // A moved entry whose message never landed cannot run yet: it waits for
      // a continue on its source to repair the copy.
      if (isTransferDestinationRequestId(turn.queue?.requestId) && !messages.some((message) => message.id === turn.messageId)) blocked.unshift("Waiting for its move to finish");
      entries.push({ threadId: row.thread.id, turnId: turn.id, title: row.thread.title, prompt: messages.find((m) => m.id === turn.messageId)?.text ?? "", provider: driverKindOfInstance((turn.modelSelection ?? row.thread.modelSelection).instanceId) ?? "unknown", status: turn.status, policy, blocked, scheduledFor: turn.scheduledFor ?? null });
    }
  }
  return entries.sort((a, b) => a.policy.order - b.policy.order || a.turnId.localeCompare(b.turnId));
}

export async function editWorkQueue(ctx: OperationContext, threadId: string, turnId: string, action: "first" | "last" | "up" | "down" | "hold" | "release" | "remove" | "restore" | "edit", policy?: QueuePolicy, notifyParent?: boolean): Promise<void> {
  await ctx.store.withThreadLock(QUEUE_ADMISSION_LOCK, async () => {
    const allEntries = await readWorkQueue(ctx);
    const selected = allEntries.find((entry) => entry.threadId === threadId && entry.turnId === turnId);
    if (!selected || selected.status !== "queued" && !selected.policy.removed) throw new CliError("QUEUE_ENTRY_NOT_WAITING", "Only a waiting or removed entry can be edited.");
    const entries = allEntries.filter((entry) => !!entry.policy.removed === !!selected.policy.removed);
    let movedOrder: number | undefined;
    // The projected policy hides the server-owned handoff wait of moved
    // entries; reorder writes go through the real queue, so reattach it.
    const waitsByThread = new Map<string, Extract<QueueCondition, { type: "entry" }> | null>();
    const serverWait = async (threadId: string): Promise<Extract<QueueCondition, { type: "entry" }> | null> => {
      if (!waitsByThread.has(threadId)) {
        const siblings = await ctx.store.readTurns(threadId);
        const handoffTurn = [...siblings]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .find((candidate) => !isTransferDestinationRequestId(candidate.queue?.requestId));
        // Reattach the stored condition itself when it carries the server's
        // ownership mark, so a reorder keeps a later move able to replace
        // exactly that condition; an older row's wait reattaches unmarked.
        const stored = handoffTurn
          ? siblings.flatMap((turn) => [...(turn.queue?.conditions ?? [])]).find((condition): condition is Extract<QueueCondition, { type: "entry" }> => condition.type === "entry" && condition.threadId === threadId && condition.turnId === handoffTurn!.id && condition.serverWait === true)
          : undefined;
        waitsByThread.set(threadId, stored ?? (handoffTurn ? { type: "entry", threadId, turnId: handoffTurn.id } : null));
      }
      return waitsByThread.get(threadId)!;
    };
    if (action === "up" || action === "down") {
      const at = entries.findIndex((entry) => entry.turnId === turnId && entry.threadId === threadId);
      const destination = at + (action === "up" ? -1 : 1);
      if (at >= 0 && destination >= 0 && destination < entries.length) {
        for (const [index, entry] of entries.entries()) {
          let reordered: QueuePolicy = { ...entry.policy, order: index * 2 };
          const wait = isTransferDestinationRequestId(reordered.requestId) ? await serverWait(entry.threadId) : null;
          if (wait && !reordered.conditions.some((c) => c.type === "entry" && c.threadId === wait.threadId && c.turnId === wait.turnId)) {
            reordered = { ...reordered, conditions: [...reordered.conditions, wait] };
          }
          await ctx.store.withThreadLock(entry.threadId, () => ctx.store.updateTurn(entry.threadId, entry.turnId, { queue: reordered }));
        }
        movedOrder = destination * 2 + (action === "up" ? -1 : 1);
      }
    }
    let summaryToStop: StoredTurn | undefined;
    let cancelProtection = false;
    const rows = policy ? await queueRows(ctx) : [];
    await ctx.store.withThreadLock(threadId, async () => {
      const turn = (await ctx.store.readTurns(threadId)).find((t) => t.id === turnId);
      if (!turn || turn.status !== "queued" && !(turn.queue && (turn.status === "interrupted" || turn.status === "failed"))) throw new CliError("QUEUE_ENTRY_NOT_WAITING", "Only a waiting or removed entry can be edited.");
      let clearStagedTransfer = false;
      if (turn.handoff) {
        let destinationTurns: StoredTurn[] | null;
        try {
          destinationTurns = await ctx.store.readTurns(turn.handoff.destinationThreadId, { reportTornTail: true });
        } catch (cause) {
          throw new CliError("STORE_READ_FAILED", `Could not read the turns ledger for thread ${turn.handoff.destinationThreadId}.`, { cause });
        }
        if (hiddenTurnsProblem(ctx.store, turn.handoff.destinationThreadId)) {
          // A skipped destination row could be the entry itself: unknown,
          // not absent. Refuse before any change, like a failed read.
          throw new CliError("STORE_READ_FAILED", `Could not verify the turns ledger for thread ${turn.handoff.destinationThreadId}: it skips unreadable rows.`, { details: { threadId: turn.handoff.destinationThreadId } });
        }
        // A staged transfer whose entry does not exist yet is still this
        // thread's to edit: the migration copies the fresh policy. Anything
        // already prepared is managed on the destination instead.
        const prepared = isTransferredTurn(turn)
          ? destinationTurns.some((candidate) => candidate.queue?.requestId === transferDestinationRequestId(turn.id))
          : destinationTurns.length > 0;
        if (prepared) throw new CliError("HANDOFF_ALREADY_PREPARED", "The new thread is already prepared. Manage its queue entry instead.");
        // Restoring or removing a staged claim unmarks it, so the next
        // migrate does not move what the user took back.
        if (isTransferredTurn(turn) && (action === "remove" || action === "restore")) clearStagedTransfer = true;
      }
      const existing = turn.queue ?? parseQueuePolicy({ conditions: [], order: Date.parse(turn.createdAt), sequential: false });
      const row = rows.find((candidate) => candidate.thread.id === threadId);
      const editThread = row?.thread ?? await ctx.store.readThreadRecord(threadId);
      const editSelection = turn.modelSelection ?? editThread?.modelSelection;
      const observed = row ? queueAdmission(row, turn, rows, ctx.config).latched : existing.latched ?? [];
      // A moved entry carries one internal condition — the wait on the
      // destination's first turn. It is an invariant, not a user condition:
      // retain it exactly once whether the incoming policy echoed it, moved
      // it, or omitted it. Client conditions alone must fit the 16-cap, so
      // strip the wait before validating and re-append it after.
      let incoming = policy;
      let internalWait: Extract<QueueCondition, { type: "entry" }> | undefined;
      if (policy && isTransferDestinationRequestId(turn.queue?.requestId)) {
        const siblings = await ctx.store.readTurns(threadId);
        const handoffTurn = [...siblings]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .find((candidate) => !isTransferDestinationRequestId(candidate.queue?.requestId));
        if (handoffTurn !== undefined) {
          const isWait = (condition: QueueCondition): boolean =>
            condition.type === "entry" && condition.threadId === threadId && condition.turnId === handoffTurn.id;
          incoming = { ...policy, conditions: policy.conditions.filter((condition) => !isWait(condition)) };
          // Re-attach the stored condition itself where it is marked, so the
          // server's ownership survives the edit; an older row's unmarked
          // wait is re-attached unmarked (a later move then preserves it).
          const stored = turn.queue?.conditions.find((condition): condition is Extract<QueueCondition, { type: "entry" }> => isWait(condition));
          internalWait = { type: "entry", threadId, turnId: handoffTurn.id, ...(stored?.serverWait === true ? { serverWait: true } : {}) };
        }
      }
      const parsedPolicy = incoming
        ? (editSelection ? resolveQueueResetConditions(parseQueuePolicy(incoming, { deferReset: true }), editSelection) : parseQueuePolicy(incoming))
        : undefined;
      const stripWait = (conditions: readonly QueueCondition[]): QueueCondition[] =>
        internalWait === undefined
          ? [...conditions]
          : conditions.filter((condition) => !(condition.type === "entry" && condition.threadId === threadId && condition.turnId === internalWait!.turnId));
      let next: QueuePolicy = parsedPolicy ? { ...existing, ...parsedPolicy, eventAfter: ctx.store.nowIso(), latched: observed.filter((index) => { const left = stripWait(existing.conditions ?? []); const right = stripWait(parsedPolicy.conditions); return index < left.length && index < right.length && JSON.stringify(left[index]) === JSON.stringify(right[index]); }) } : existing;
      if (internalWait) next = { ...next, conditions: [...stripWait(next.conditions), internalWait] };
      if (next.conditions.some((c) => c.type === "thread" && c.threadId === threadId || c.type === "entry" && c.threadId === threadId && c.turnId === turnId)) throw new CliError("QUEUE_DEPENDENCY_CYCLE", "An entry cannot wait for itself or its own thread.");
      if (action === "first" || action === "last") next = { ...next, order: action === "first" ? Math.min(...entries.map((e) => e.policy.order)) - 1 : Math.max(...entries.map((e) => e.policy.order)) + 1 };
      if (movedOrder !== undefined) next = { ...next, order: movedOrder };
      if (action === "hold" || action === "release") next = { ...next, held: action === "hold" };
      if (action === "remove" || action === "restore") next = { ...next, removed: action === "remove", held: action === "restore" ? true : next.held };
      if (action === "restore") {
        const thread = await ctx.store.readThreadRecord(threadId);
        if (thread?.usagePause?.recoveryTurnId === turnId) {
          const { error, ...pause } = thread.usagePause;
          if (error !== undefined || pause.phase !== "waiting") await ctx.store.writeThreadRecord({ ...thread, usagePause: { ...pause, phase: "waiting" } });
        }
      }
      if (action === "remove" || action === "hold" || next.continuation !== "model") summaryToStop = (await ctx.store.readTurns(threadId)).find((candidate) => candidate.id === turn.handoff?.summaryTurnId && (candidate.status === "queued" || candidate.status === "running"));
      const protection = (await ctx.store.readThreadRecord(threadId))?.usagePause;
      if (action === "remove" && !protection?.forced && protection?.recoveryTurnId === turnId) {
        cancelProtection = true;
        summaryToStop = openTurn(await ctx.store.readTurns(threadId)) ?? summaryToStop;
      }
      const patchedStatus = action === "remove" ? { status: "interrupted" as const, completedAt: ctx.store.nowIso() } : action === "restore" ? { status: "queued" as const, completedAt: null } : {};
      if (clearStagedTransfer) {
        // Drop the staging claim itself (updateTurn cannot delete a key):
        // a restored or removed staged entry reads as ordinary queue
        // history from here on.
        const current = await ctx.store.readTurns(threadId);
        await ctx.store.rewriteLedger(
          threadId,
          "turns",
          current.map((candidate) => {
            if (candidate.id !== turnId) return candidate;
            const { handoff: _clearedClaim, ...rest } = candidate;
            return { ...rest, queue: next, ...patchedStatus };
          }),
        );
      } else {
        await ctx.store.updateTurn(threadId, turnId, { queue: next, ...patchedStatus });
      }
      ctx.store.emit(threadId, "queue-edited");
    });
    if (summaryToStop) {
      const thread = await ctx.store.readThreadRecord(threadId);
      if (thread && summaryToStop.status === "running") await Effect.runPromise(ctx.driverFor((summaryToStop.modelSelection ?? thread.modelSelection).instanceId).interruptTurn(threadId));
      await interruptTurn(ctx.store, threadId, summaryToStop.id);
    }
    if (cancelProtection) await ctx.store.withThreadLock(threadId, async () => {
      const thread = await ctx.store.readThreadRecord(threadId);
      if (!thread?.usagePause?.forced && thread?.usagePause?.recoveryTurnId === turnId) await ctx.store.writeThreadRecord({ ...thread, usagePause: null });
    });
    // A cancelled recovery on a delegated task marks it and tells its parent, unless asked not to.
    if (cancelProtection) await noteAutoContinueCancelled(ctx, threadId, { notifyParent }).catch(() => undefined);
    // Putting the entry back re-arms the resume: the task no longer reads cancelled.
    if (action === "restore") await reviveCancelledDelegation(ctx, threadId).catch(() => undefined);
  });
}

export async function runWorkQueue(ctx: OperationContext, now = Date.now(), snapshot?: readonly QueueRow[]): Promise<void> {
  await ctx.store.withThreadLock(QUEUE_ADMISSION_LOCK, async () => {
    const rows = snapshot ? [...snapshot] : await queueRows(ctx);
    if (snapshot) await queueDependencies(ctx, rows);
    const origins = await loadTurnOrigins(ctx.store, rows, ctx.config);
    for (const row of rows) for (const turn of row.turns) {
      if (turn.status !== "queued" || !turn.queue) continue;
      const admission = queueAdmission(row, turn, rows, ctx.config, now, origins);
      if (JSON.stringify(admission.latched) === JSON.stringify(turn.queue.latched ?? []) && JSON.stringify(admission.conditions) === JSON.stringify(turn.queue.conditions)) continue;
      await ctx.store.withThreadLock(row.thread.id, () => ctx.store.updateTurn(row.thread.id, turn.id, { queue: { ...turn.queue!, latched: admission.latched, conditions: admission.conditions } }));
    }
    const entries = await readWorkQueue(ctx, rows);
    for (const entry of entries) if (entry.status === "queued" && !entry.policy.removed) {
      if (!entry.policy.held && entry.policy.continuation !== "same-thread") {
        try { await prepareQueuedHandoff(ctx, entry.threadId, entry.turnId, now); }
        catch (cause) {
          // A manual handoff in flight refuses the handoff preparation: leave
          // the entry queued — a later pass prepares it, once the claim
          // clears — instead of failing it for the user to re-add. The
          // contention is classified at the throw site (see
          // isContinuationBusy), never re-read here: the claim may not be
          // persisted yet when a racing manual run refuses, or may already
          // have cleared, and either re-read misclassifies a genuine
          // handoff failure as contention or vice versa.
          if (isContinuationBusy(cause)) continue;
          await ctx.store.withThreadLock(entry.threadId, () => ctx.store.updateTurn(entry.threadId, entry.turnId, { status: "failed", error: cause instanceof CliError ? cause.message : "Handoff preparation failed. Add the entry back to retry.", completedAt: ctx.store.nowIso() }));
          ctx.store.emit(entry.threadId, "handoff-failed");
          continue;
        }
        const handoff = (await ctx.store.readTurns(entry.threadId)).find((turn) => turn.id === entry.turnId)?.handoff;
        const destination = handoff ? await ctx.store.readThreadRecord(handoff.destinationThreadId) : null;
        if (destination) {
          const row = { thread: destination, turns: await ctx.store.readTurns(destination.id) };
          const index = rows.findIndex((candidate) => candidate.thread.id === destination.id);
          if (index < 0) rows.push(row); else rows[index] = row;
        }
      }
      await admitQueuedTurn(ctx, entry.threadId, rows, now);
    }
  });
}

export async function pendingHandoff(ctx: OperationContext, threadId: string): Promise<string | null> {
  const turns = await ctx.store.readTurns(threadId);
  const running = openTurn(turns);
  if (!running) return null;
  return turns.find((turn) => turn.status === "queued" && turn.queue?.continuation === "model" && turn.handoff?.summaryTurnId === running?.id)?.handoff?.requestId ?? null;
}

export async function submitHandoff(ctx: OperationContext, threadId: string, requestId: string, summary: string): Promise<void> {
  if (!summary.trim() || summary.length > 64_000) throw new CliError("INVALID_HANDOFF", "Submit a non-empty handoff of at most 64000 characters.");
  await ctx.store.withThreadLock(threadId, async () => {
    const turns = await ctx.store.readTurns(threadId);
    const target = turns.find((turn) => turn.handoff?.requestId === requestId);
    if (target?.handoff?.summary === summary.trim()) return;
    if (!target?.handoff || target.status !== "queued" || target.queue?.continuation !== "model" || target.handoff.summaryTurnId !== openTurn(turns)?.id) throw new CliError("HANDOFF_NOT_ACTIVE", "This handoff request is not active for this thread.");
    if (target.handoff.summary) throw new CliError("HANDOFF_ALREADY_SUBMITTED", "The handoff has already been accepted.");
    await ctx.store.updateTurn(threadId, target.id, { handoff: { ...target.handoff, summary: summary.trim() } });
    ctx.store.emit(threadId, "handoff-submitted");
  });
}

const HANDOFF_SUMMARY_BUDGET_MS = 120_000;

/** @internal Exported for tests: the queue pass prepares one entry's handoff. */
export async function prepareQueuedHandoff(ctx: OperationContext, threadId: string, turnId: string, now: number): Promise<void> {
  const store = ctx.store;
  const source = await store.readThreadRecord(threadId);
  const turns = await store.readTurns(threadId);
  let turn = turns.find((t) => t.id === turnId);
  // A snooze takes the thread out of the active set: preparing the handoff
  // would start a summary turn and queue a destination for work the snooze
  // holds. The live snooze is what holds it, so a passed time does not.
  if (!source || source.usagePause?.forced || !turn?.queue || turn.status !== "queued" || turn.queue.held || turn.queue.removed || source.archivedAt || source.deletedAt || source.settledAt || snoozeActive(source, now)) return;
  // A moved entry's own onward handoff waits like its dispatch does: no
  // summary turn and no next destination until the destination's first
  // turn settles and the entry's message reads durable. The admission
  // gate only covers same-thread dispatch while preparation runs before
  // it, so transfer entries gate here; ordinary model/stored handoffs
  // keep their existing prep semantics untouched.
  if (isTransferDestinationRequestId(turn.queue?.requestId)) {
    const entry = turn;
    const siblings = await store.readTurns(threadId);
    const handoffTurn = [...siblings]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .find((candidate) => !isTransferDestinationRequestId(candidate.queue?.requestId));
    const handoffSettled = handoffTurn !== undefined && (handoffTurn.status === "completed" || handoffTurn.status === "failed" || handoffTurn.status === "interrupted");
    const landed = handoffSettled && (await store.readMessages(threadId)).some((message) => message.id === entry.messageId);
    if (!landed) return;
  }
  // The entry's provenance, made whole with the message ledger for turns
  // written before the turn row carried an origin: an automatic handoff is
  // one even when its turn predates the origin column.
  const origins = await loadTurnOrigins(store, [{ thread: source, turns }], ctx.config);
  const origin = turn.origin ?? origins.get(turnOriginKey(threadId, turn.id));
  const userAuthorized = origin === undefined && turn.queue.automatic !== true && turn.queue.wakeUp !== true
    && turn.scheduleReason !== "usage-reset" && turn.scheduleReason !== "usage-hold";
  // A handoff into a held Antigravity is one of the automatic prompts off
  // forbids: an automatic entry of any continuation (model or stored) is
  // held here — before preparation creates the handoff request, starts a
  // summary, or touches a destination thread.
  const destinationHeld = antigravityAutoPromptsHeld(ctx.config, (turn.modelSelection ?? source.modelSelection).instanceId);
  if (destinationHeld && !userAuthorized) return;
  // A model summary is a prompt on the source thread, so the source's gate
  // holds it as surely as the destination's: while the source runs on a
  // held Antigravity the summary could only ever sit queued. A handoff the
  // user queued themselves completes on its stored summary instead; an
  // automatic one is held before any mutation.
  const handoffHeldOff = turn.queue.continuation === "model" && antigravityAutoPromptsHeld(ctx.config, source.modelSelection.instanceId);
  if (handoffHeldOff && !userAuthorized) return;
  if (!turn.handoff) {
    const handoff = { requestId: store.newId(), destinationThreadId: store.newId() };
    await store.withThreadLock(threadId, () => store.updateTurn(threadId, turnId, { handoff }));
    turn = { ...turn, handoff };
  }
  let handoff = turn.handoff!;
  if (handoff.summary && handoff.summaryTurnId) {
    const summaryTurn = (await store.readTurns(threadId)).find((candidate) => candidate.id === handoff.summaryTurnId);
    if (summaryTurn?.status === "running") {
      await Effect.runPromise(ctx.driverFor((summaryTurn.modelSelection ?? source.modelSelection).instanceId).interruptTurn(threadId));
      await interruptTurn(store, threadId, summaryTurn.id);
    }
  }
  // A manual handoff in flight owns the checkout: the queue pass waits for
  // its claim to clear rather than preparing beside it, and a dead claim
  // heals here instead of deferring the entry. The queue pass retries this
  // entry once a live claim clears.
  const claimBlocked = await store.withThreadLock(threadId, async () => {
    const record = await store.readThreadRecord(threadId);
    return record ? (await continuationInFlight(store, record)).blocked : false;
  });
  if (claimBlocked) return;
  if (turn.queue!.continuation === "model" && !handoff.summary && !handoff.fallback) {
    const summaryProvider = usageKeyForInstance(source.modelSelection.instanceId);
    const exhausted = providerExhausted(summaryProvider, now, source.modelSelection.model);
    if (handoffHeldOff) {
      // The model summary never starts while the Antigravity gate is off, so
      // waiting on it would stall the user's handoff forever: a summary
      // turn begun before the setting turned off is stopped, and the entry
      // takes the stored summary now.
      const staleSummary = handoff.summaryTurnId
        ? (await store.readTurns(threadId)).find((candidate) => candidate.id === handoff.summaryTurnId)
        : undefined;
      if (staleSummary?.status === "running") {
        await Effect.runPromise(ctx.driverFor((staleSummary.modelSelection ?? source.modelSelection).instanceId).interruptTurn(threadId));
        await interruptTurn(store, threadId, staleSummary.id);
      } else if (staleSummary?.status === "queued") {
        await interruptTurn(store, threadId, staleSummary.id);
      }
      await store.withThreadLock(threadId, async () => {
        const current = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
        handoff = { ...current!.handoff!, fallback: !current!.handoff!.summary };
        await store.updateTurn(threadId, turnId, { handoff });
      });
    } else {
      if (!handoff.summaryTurnId && !exhausted) {
        if (openTurn(await store.readTurns(threadId))) return;
        const sent = await sendTurn(store, threadId, {
          prompt: `Prepare a concise handoff for the unfinished task: goal, completed work, changed files, checks/failures, next steps, outstanding requests and important images. Do not perform more task work. Deliver the summary ONLY through the Moxen submit_handoff tool with requestId ${handoff.requestId}. After the tool acknowledges it, finish with no extra prose (or just Done). If you cannot call that tool, stop; Moxen will use its stored handoff.`,
          origin: "handoff-summary", usageControl: true,
          queue: { ...parseQueuePolicy({ conditions: [], order: turn.queue!.order - 0.5, sequential: false }), requestId: `summary:${handoff.requestId}`, summaryFor: turnId },
        }, ctx.config);
        handoff = { ...handoff, summaryTurnId: sent.turn.id };
        await store.withThreadLock(threadId, () => store.updateTurn(threadId, turnId, { handoff }));
        return;
      }
      const summaryTurn = (await store.readTurns(threadId)).find((t) => t.id === handoff.summaryTurnId);
      if (summaryTurn?.status === "queued" && !exhausted) return;
      if (summaryTurn?.status === "running") {
        if (now - Date.parse(summaryTurn.startedAt ?? summaryTurn.createdAt) < HANDOFF_SUMMARY_BUDGET_MS && !exhausted) return;
        await Effect.runPromise(ctx.driverFor((summaryTurn.modelSelection ?? source.modelSelection).instanceId).interruptTurn(threadId));
        await interruptTurn(store, threadId, summaryTurn.id);
      }
      if (summaryTurn?.status === "queued") await interruptTurn(store, threadId, summaryTurn.id);
      await store.withThreadLock(threadId, async () => {
        const current = (await store.readTurns(threadId)).find((candidate) => candidate.id === turnId);
        handoff = { ...current!.handoff!, fallback: !current!.handoff!.summary };
        await store.updateTurn(threadId, turnId, { handoff });
      });
    }
  }
  if (openTurn(await store.readTurns(threadId))) return;
  const policy: QueuePolicy = { ...turn.queue!, continuation: "same-thread", requestId: `handoff:${handoff.requestId}`, eventAfter: turn.queue!.eventAfter ?? turn.createdAt };
  // A moved entry keeps its own schedule: wrapping it in a next destination
  // before its due time would lose the move's time constraint. Ordinary
  // handoffs pass no schedule here, as before.
  const continued = await continueThread(ctx, { threadId, destinationThreadId: handoff.destinationThreadId, queue: policy, queuedTurnIds: [turnId], modelSelection: turn.modelSelection ?? source.modelSelection, runtimeMode: turn.runtimeMode, interactionMode: turn.interactionMode, ...(turn.queue!.continuation === "model" && handoff.summary ? { modelSummary: handoff.summary } : {}), ...(isTransferDestinationRequestId(turn.queue?.requestId) && typeof turn.scheduledFor === "string" ? { scheduledFor: turn.scheduledFor } : {}) });
  if (continued.threadId !== handoff.destinationThreadId) {
    // The call joined another run's destination instead of preparing this
    // entry's own: leave the entry queued for a later pass rather than
    // marking it completed against a destination that never holds it.
    return;
  }
  await store.withThreadLock(threadId, async () => {
    const current = await store.readThreadRecord(threadId);
    await store.updateTurn(threadId, turnId, { status: "completed", completedAt: store.nowIso() });
    if (current?.usagePause?.recoveryTurnId === turnId) await store.writeThreadRecord({ ...current, usagePause: null });
    await store.appendLedger(threadId, "activity", { id: store.newId(), threadId, turnId, kind: "handoff.prepared", summary: handoff.fallback ? "Model summary unavailable; used stored handoff" : handoff.summary ? "Model handoff accepted" : "Stored handoff prepared", payload: { destinationThreadId: handoff.destinationThreadId, fallback: handoff.fallback === true }, createdAt: store.nowIso() });
    store.emit(threadId, "handoff-prepared");
  });
  // A handoff that carried the recovery released the hold: queued notices go out now, together.
  await flushTaskNotifications(ctx, threadId).catch(() => undefined);
}

/** Arm timers for every pending scheduled turn on disk (a starting owner process calls this once). */
export async function armPendingScheduledTurns(ctx: OperationContext): Promise<void> {
  const ids = await ctx.store.listThreadIds().catch(() => [] as string[]);
  for (const threadId of ids) {
    const turns = await ctx.store.readTurns(threadId).catch(() => [] as StoredTurn[]);
    for (const turn of turns) {
      if (turn.status === "queued" && typeof turn.scheduledFor === "string") armScheduledTurn(threadId, turn.id, turn.scheduledFor);
    }
  }
}

/** Automatic continues in a row before moxen stops trying, unless `usageLimitContinues` says otherwise (Claude Code's own cap). */
export const MAX_USAGE_CONTINUES = 2;

/** Whether a usage limit on this instance's provider (or independent profile) is waited out: its own switch, else the global one. */
export function autoContinuesAt(config: OperationContext["config"], instanceId: string): boolean {
  return resolveProfileProviderConfig(config, instanceId)?.autoContinueAtUsageLimit ?? config.autoContinueAtUsageLimit === true;
}

/** The runner hook that schedules a continue after a usage limit, when config asks for it on this turn's provider. */
function usageLimitHook(
  ctx: OperationContext,
  threadId: string,
  instanceId: string,
): { onUsageLimit?: (storeTurnId: string, resetsAt: string | null) => void } {
  if (!autoContinuesAt(ctx.config, instanceId)) return {};
  return {
    onUsageLimit: (storeTurnId, resetsAt) => void scheduleUsageContinue(ctx, threadId, storeTurnId, resetsAt).catch(() => undefined),
  };
}

/**
 * Queue a "continue" for just after the limit resets. At most one pending,
 * and at most `usageLimitContinues` in a row: a continue that hits the limit
 * again counts up, and past the cap a notice says it stopped.
 */
export async function scheduleUsageContinue(
  ctx: OperationContext,
  threadId: string,
  storeTurnId: string,
  resetsAt: string | null,
): Promise<StoredTurn | null> {
  const { store } = ctx;
  if (resetsAt === null || !Number.isFinite(Date.parse(resetsAt))) return null;
  if ((await store.readThreadRecord(threadId))?.usagePause) return null;
  const turns = await store.readTurns(threadId);
  if (turns.some((turn) => turn.status === "queued" && turn.scheduleReason === "usage-reset")) return null;
  const stopped = turns.find((turn) => turn.id === storeTurnId);
  const attempt = stopped?.scheduleReason === "usage-reset" ? (stopped.continueAttempt ?? 1) + 1 : 1;
  const cap = ctx.config.usageLimitContinues ?? MAX_USAGE_CONTINUES;
  if (attempt > cap) {
    await store.appendLedger(threadId, "activity", {
      id: store.newId(),
      threadId,
      turnId: storeTurnId,
      kind: "notice",
      summary: "Automatic continue stopped after repeated usage-limit hits",
      payload: { notice: "other", detail: `It tried ${cap === 1 ? "once" : `${cap} times in a row`}. Send a message to pick the task up again.` },
      createdAt: store.nowIso(),
    });
    store.emit(threadId, "activity");
    return null;
  }
  const at = new Date(Date.parse(resetsAt) + USAGE_CONTINUE_GRACE_MS).toISOString();
  const sent = await sendTurn(store, threadId, {
    prompt: USAGE_CONTINUE_PROMPT,
    queue: { ...parseQueuePolicy({ conditions: [], sequential: ctx.config.usageRecovery === "sequential" }), automatic: true },
    scheduledFor: at,
    scheduleReason: "usage-reset",
    continueAttempt: attempt,
  }, ctx.config);
  armScheduledTurn(threadId, sent.turn.id, at);
  // A delegated task runs out of usage: its parent hears now, with the
  // expected resume time, and still gets the normal report when the task
  // finishes. Best effort, like the continue itself.
  await queueTaskPauseNotification(ctx, threadId, at).catch(() => undefined);
  return sent.turn;
}

/** Options for cancelling an automatic continue: the TUI's "without notifying" sets `notifyParent` false. */
export interface CancelAutoContinueOptions {
  readonly notifyParent?: boolean | undefined;
}

/** A thread's pending automatic continue after a usage limit, if any. */
async function pendingAutoContinue(
  ctx: OperationContext,
  threadId: string,
): Promise<{ continues: StoredTurn[]; recoveryTurnId: string | null }> {
  const turns = await ctx.store.readTurns(threadId).catch(() => [] as StoredTurn[]);
  const continues = turns.filter((turn) => turn.status === "queued" && turn.scheduleReason === "usage-reset");
  const pause = (await ctx.store.readThreadRecord(threadId).catch(() => null))?.usagePause;
  const recoveryTurnId =
    pause?.recoveryTurnId && turns.some((turn) => turn.id === pause.recoveryTurnId && turn.status === "queued") ? pause.recoveryTurnId : null;
  return { continues, recoveryTurnId };
}

/**
 * Mark a delegated task's automatic continue cancelled so `task_status`
 * says so either way, and tell its parent unless asked not to. The mark
 * applies only when the child has no live work left: a follow-up still
 * running reports on its own when it settles. No-op when the thread is not
 * a live delegated task.
 */
export async function noteAutoContinueCancelled(ctx: OperationContext, threadId: string, opts: CancelAutoContinueOptions = {}): Promise<boolean> {
  const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === threadId && candidate.continuedIn === undefined);
  if (!row) return false;
  if (await taskHasSettledForGood(ctx, threadId)) {
    if (row.status !== "cancelled") await ctx.store.updateDelegation(row.id, { status: "cancelled" }).catch(() => null);
  }
  if (row.notify === true && opts.notifyParent !== false) await queueTaskCancelNotification(ctx, threadId);
  return true;
}

/**
 * Revive a cancelled delegation row when fresh work starts on the task, so
 * the new work reports on its own instead of reading cancelled. Returns
 * whether a mark was cleared.
 */
async function reviveCancelledDelegation(ctx: OperationContext, threadId: string): Promise<boolean> {
  const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === threadId && candidate.continuedIn === undefined);
  if (!row || row.status !== "cancelled") return false;
  await ctx.store.updateDelegation(row.id, { status: "running" }).catch(() => null);
  return true;
}

/**
 * A cancelled mark reflects no live work, so fresh work settling clears it
 * and `task_status` reads the new outcome instead of the old cancellation.
 * Runs after every turn started here or admitted from the queue.
 */
async function clearCancelledOnSettle(ctx: OperationContext, threadId: string): Promise<void> {
  const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === threadId && candidate.continuedIn === undefined);
  if (!row || row.status !== "cancelled") return;
  if (await taskHasSettledForGood(ctx, threadId)) await ctx.store.updateDelegation(row.id, { status: "running" }).catch(() => null);
}

/**
 * Cancel a thread's pending automatic continue after a usage limit: the
 * queued usage-reset continue and the protection recovery entry. A
 * delegated task is marked cancelled and its parent told, unless the call
 * opts out. Returns whether anything was pending.
 */
export async function cancelAutoContinue(ctx: OperationContext, threadId: string, opts: CancelAutoContinueOptions = {}): Promise<boolean> {
  const { continues, recoveryTurnId } = await pendingAutoContinue(ctx, threadId);
  if (continues.length === 0 && recoveryTurnId === null) return false;
  for (const turn of continues) await interruptTurn(ctx.store, threadId, turn.id).catch(() => undefined);
  if (recoveryTurnId !== null) {
    const pause = (await ctx.store.readThreadRecord(threadId).catch(() => null))?.usagePause;
    if (pause?.forced) throw new CliError("THREAD_PROTECTED", "Send a message to end manual protection.");
    // Removal clears the hold (the work queue's cancel-protection path);
    // it also marks and notifies through the same helper below.
    await editWorkQueue(ctx, threadId, recoveryTurnId, "remove", undefined, opts.notifyParent);
  } else {
    await noteAutoContinueCancelled(ctx, threadId, opts);
  }
  return true;
}

// -- long threads --------------------------------------------------------------

/**
 * Threads whose running turn Moxen interrupted because the context crossed
 * the compaction line: once that turn settles the thread is compacted, and
 * the work is picked up again.
 */
const compactingMidTurn = new Set<string>();

/**
 * The runner's hooks for a long thread: once a turn settles, hand off or
 * compact it when the settings say to do it unasked; and while a turn runs,
 * compact when its context crosses the line, which waiting for the turn to
 * end would let run on past it.
 */
function longThreadHook(
  ctx: OperationContext,
  threadId: string,
): { afterSettle: () => Promise<void>; onContextReading: (usage: ContextWindowUsage) => void } {
  return {
    afterSettle: async () => {
      const resume = compactingMidTurn.delete(threadId);
      if ((await ctx.store.readThreadRecord(threadId))?.usagePause) return;
      const action = await actOnLongThread(ctx, threadId, { wait: resume });
      if (resume) await resumeAfterCompaction(ctx, threadId, action);
    },
    onContextReading: (usage) => void compactMidTurn(ctx, threadId, usage).catch(() => undefined),
  };
}

/**
 * A running turn's context reading past the line Moxen compacts at: stop the
 * turn at once (its settling compacts the thread, `afterSettle`) so the
 * thread never goes on past the line, and the work resumes afterwards. Only
 * where the turn's end would compact: Moxen's own compaction, on Automatic or
 * past its hard line, and not when a hand-off is due first. The rule that
 * keeps a compaction that did not help from repeating (`usedSinceCompact`)
 * is the loop's guard.
 */
export async function compactMidTurn(ctx: OperationContext, threadId: string, usage: ContextWindowUsage): Promise<boolean> {
  if ((await ctx.store.readThreadRecord(threadId))?.usagePause) return false;
  if (compactingMidTurn.has(threadId)) return false;
  const snapshot = await readLongThreadSnapshot(ctx.store, threadId);
  if (snapshot === null || !snapshot.turnRunning) return false;
  // Compacting mid-turn stops the running turn so the `/compact` and its
  // follow-up can take its place: while Antigravity's automatic prompts are
  // held there is no place for them, so the running turn is left alone.
  if (antigravityAutoPromptsHeld(ctx.config, snapshot.instanceId)) return false;
  // As it will stand when the turn has settled.
  const action = planLongThreadAction(ctx.config, { ...snapshot, turnRunning: false, usedTokens: usage.usedTokens, maxTokens: usage.maxTokens });
  if (action?.kind !== "compact") return false;
  compactingMidTurn.add(threadId);
  const interrupted = await interruptTurn(ctx.store, threadId).catch(() => null);
  if (interrupted === null || !interrupted.interrupted) {
    compactingMidTurn.delete(threadId);
    return false;
  }
  await ctx.store.appendLedger(threadId, "activity", {
    id: ctx.store.newId(),
    threadId,
    turnId: interrupted.turn?.id ?? null,
    kind: "notice",
    summary: "Compacting: the thread reached its line mid-turn",
    payload: { notice: "other", detail: "Moxen stopped the turn to compact the conversation, and will carry on with the task afterwards." },
    createdAt: ctx.store.nowIso(),
  });
  ctx.store.emit(threadId, "activity");
  return true;
}

/** After a mid-turn compaction: the task goes on from where it stopped. Marked at its source, so the Antigravity off gate holds it like any automatic prompt. */
async function resumeAfterCompaction(ctx: OperationContext, threadId: string, action: LongThreadAction | null): Promise<void> {
  // A hand-off in its place moved the work to a new thread: nothing to resume here.
  if (action?.kind === "handoff") return;
  await startTurn(ctx, { threadId, prompt: COMPACTED_CONTINUE_PROMPT, origin: "compaction", onEvent: () => undefined });
}

/**
 * Hand off or compact `threadId` now if `planLongThreadAction` says the
 * server should, without anyone asking. Returns what it did. Called after
 * every turn settles, so a thread no client has open is looked after too.
 */
export async function actOnLongThread(ctx: OperationContext, threadId: string, options: { wait?: boolean } = {}): Promise<LongThreadAction | null> {
  const snapshot = await readLongThreadSnapshot(ctx.store, threadId);
  if (snapshot === null) return null;
  const action = planLongThreadAction(ctx.config, snapshot);
  if (action === null) return null;
  if (action.kind === "handoff") {
    // An automatic hand-off is a prompt the user did not write: held while
    // Antigravity delegation is off. The work stays in this thread; a notice
    // says why, once until something else lands in the ledger.
    if (antigravityAutoPromptsHeld(ctx.config, snapshot.instanceId)) {
      const activities = await ctx.store.readActivities(threadId);
      const last = activities.at(-1);
      if (!(last?.kind === "notice" && last.payload?.held === "antigravity-delegation")) {
        await ctx.store.appendLedger(threadId, "activity", {
          id: ctx.store.newId(), threadId, turnId: null,
          kind: "notice",
          summary: "Hand-off held: Antigravity delegation and automatic prompts are off",
          payload: { notice: "other", held: "antigravity-delegation", detail: "Turn on providers.antigravity.allowUnsupportedUse to let Moxen hand off automatically, or continue the thread yourself." },
          createdAt: ctx.store.nowIso(),
        });
        ctx.store.emit(threadId, "activity");
      }
      return null;
    }
    await continueThread(ctx, { threadId, automatic: true });
    return action;
  }
  if (action.reason !== "auto") {
    // An "ask" Moxen did not wait for: say why, so the card that never got an answer is accounted for.
    const providerName =
      ({
        claude: "Claude Code",
        codex: "Codex",
        opencode: "OpenCode",
        harness: "Moxen Harness",
        antigravity: "Antigravity",
        vibe: "Mistral Vibe",
        acp: "ACP",
      } as Record<string, string>)[driverKey(snapshot.instanceId)] ?? snapshot.instanceId;
    await ctx.store.appendLedger(threadId, "activity", {
      id: ctx.store.newId(),
      threadId,
      turnId: null,
      kind: "notice",
      summary: action.reason === "delegated" ? "Compacting: a delegated task has no one to ask" : "Compacting: the thread is nearly full",
      payload: { notice: "other", detail: `${providerName}'s own compaction is off while Moxen compacts, so Moxen does it rather than let the next turn hit the limit.` },
      createdAt: ctx.store.nowIso(),
    });
    ctx.store.emit(threadId, "activity");
  }
  const started = await startTurn(ctx, { threadId, prompt: COMPACT_PROMPT, origin: "compaction", onEvent: () => undefined });
  // A turn waiting to go on after it needs the compaction done first.
  if (options.wait === true) await started.run;
  return action;
}

/** How many background tasks the latest `background.tasks` row lists. */
function runningBackgroundTasks(activities: readonly StoredActivity[]): number {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== "background.tasks") continue;
    const payload = activity.payload as { tasks?: unknown } | null | undefined;
    return Array.isArray(payload?.tasks) ? payload.tasks.length : 0;
  }
  return 0;
}

/** The latest context reading the turn runner recorded (`context-window.updated`). */
function latestUsage(activities: readonly StoredActivity[]): { usedTokens: number | null; maxTokens: number | null } {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== "context-window.updated") continue;
    const payload = activity.payload as { usedTokens?: unknown; maxTokens?: unknown } | null | undefined;
    return {
      usedTokens: typeof payload?.usedTokens === "number" ? payload.usedTokens : null,
      maxTokens: typeof payload?.maxTokens === "number" ? payload.maxTokens : null,
    };
  }
  return { usedTokens: null, maxTokens: null };
}

/** Read a thread back from the store as `planLongThreadAction` takes it. Null when the thread is gone. */
export async function readLongThreadSnapshot(store: ThreadStore, threadId: string): Promise<LongThreadSnapshot | null> {
  const thread = await store.readThreadRecord(threadId);
  if (!thread) return null;
  const [turns, messages, activities, delegations] = await Promise.all([
    store.readTurns(threadId),
    store.readMessages(threadId),
    store.readActivities(threadId),
    store.readDelegations().catch(() => []),
  ]);
  const children = delegations.filter((row) => row.parentThreadId === threadId && row.status === "running");
  const lastTurn = turns.filter((turn) => turn.status !== "queued").at(-1);
  const lastPrompt = lastTurn === undefined ? undefined : messages.find((message) => message.id === lastTurn.messageId);
  const promptOf = (turnId: string): string => messages.find((message) => message.turnId === turnId && message.role === "user")?.text ?? "";
  const lastCompact = turns.findLastIndex((turn) => turn.status !== "queued" && isCompactCommand(promptOf(turn.id)));
  const sinceCompact = lastCompact === -1 ? null : new Set(turns.slice(lastCompact).map((turn) => turn.id));
  const selection = lastTurn?.modelSelection ?? thread.modelSelection;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...latestUsage(activities),
    hasReply: messages.some((message) => message.role === "assistant"),
    turnRunning: turns.some((turn) => turn.status === "running"),
    runningSubthreads: children.length,
    runningBackgroundTasks: runningBackgroundTasks(activities),
    queuedMessages: turns.filter((turn) => turn.status === "queued" && typeof turn.scheduledFor !== "string").length,
    delegated: delegations.some((row) => row.childThreadId === threadId),
    lastWasCompact: lastPrompt !== undefined && isCompactCommand(lastPrompt.text),
    usedSinceCompact: sinceCompact === null ? null : activities.flatMap((activity) => {
      const used = (activity.payload as { usedTokens?: unknown } | null | undefined)?.usedTokens;
      return activity.kind === "context-window.updated" && activity.turnId !== null && sinceCompact.has(activity.turnId) && typeof used === "number" ? [used] : [];
    }),
    continued: activities.some((activity) => activity.kind === "thread.continued"),
  };
}

export interface ContinueThreadRequest {
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
  readonly destinationThreadId?: string;
  readonly queue?: QueuePolicy;
  readonly modelSummary?: string;
  readonly queuedTurnIds?: readonly string[];
  readonly threadId: string;
  /** Start the new thread's first turn at this time rather than now (after a usage limit resets). */
  readonly scheduledFor?: string;
  /** The server did it on its own (hand-off set to Automatic), not a client. */
  readonly automatic?: boolean;
  /** An agent's opening instruction for the new thread, folded into its first turn. */
  readonly firstMessage?: string;
  /** Mark the continuation as an agent's own doing (loop guard, activity note). */
  readonly byAgent?: boolean;
  /**
   * A client-generated idempotency key: a retry with the same key rejoins
   * the reserved destination instead of refusing as a repeat.
   */
  readonly idempotencyKey?: string;
}

export interface ContinuedThread {
  readonly threadId: string;
  readonly title: string;
  readonly scheduledFor: string | null;
}

/**
 * In-flight continuations by source thread. Overlapping `continueThread`
 * calls on one source (two queue passes, two palette actions) share one
 * execution: the second awaits the first instead of creating a second
 * destination. The reservation below is what makes a retry after a crash
 * rejoin rather than duplicate.
 *
 * A manual continue never joins a non-manual run: the agent's or server's
 * handoff carries its own ordering, while the user's action must refuse a
 * running source at once instead of inheriting the agent's destination. The
 * manual request waits for the in-flight run to settle and then retries
 * through the normal path, without disturbing the map entry it waited on.
 */
const continuationRuns = new Map<string, { manual: boolean; run: Promise<ContinuedThread> }>();

/**
 * A new thread that carries on from `threadId`: same project, model,
 * modes and checkout — the work so far is on that disk — opened with a
 * handoff document built from the old thread's ledger. The old thread is
 * left as it is, with a note pointing at its continuation.
 *
 * A manual continue (the user's own action, not the server's recovery, a
 * queued handoff or an agent's) refuses a source with an active turn
 * (`THREAD_BUSY`), then claims the source until the handoff lands: while
 * the claim stands, admission starts no turn there, so the destination
 * never runs beside one. The claim is registered against this process for
 * the handoff's whole life — no timeout bounds a live handoff — and clears
 * when this returns (or fails): a later send on the old thread is the
 * user's own choice. A claim whose handoff died with it heals on the next
 * admission. Queued or scheduled work is not active, so an idle thread with
 * schedules still continues.
 *
 * Concurrent calls on one source share a single destination (see
 * `continuationRuns`), and a retry after a crash rejoins the reserved
 * destination instead of creating another (`reserveContinuation`) — except a
 * manual request never joins an agent's or the server's in-flight run. It
 * waits for that run to settle and then retries through the normal path, so
 * it always passes its own busy check and writes its own claim.
 */
export function continueThread(ctx: OperationContext, request: ContinueThreadRequest): Promise<ContinuedThread> {
  const manual = isManualContinue(request);
  const ongoing = continuationRuns.get(request.threadId);
  // A manual request joins only an in-flight manual run. Joining an agent's
  // or the server's run would hand its destination back with no busy check
  // and no claim — and replacing the entry would divert later non-manual
  // requests into the manual run, or run two handoffs at once on one
  // destination. Instead the manual request leaves the entry alone, waits
  // for it to settle, and retries through the normal path: it joins a manual
  // run if one now exists, else starts fresh and refuses a running source in
  // reserveContinuation. Mirrored the other way, a non-manual request never
  // joins a manual run either: joining would resolve with the manual
  // destination while the caller records its own reserved id, stranding its
  // work — the queue pass leaves the entry queued on THREAD_BUSY for a
  // later pass instead.
  if (ongoing && ongoing.manual && !manual) {
    return Promise.reject(continuationBusyError(request.threadId));
  }
  if (ongoing && (!manual || ongoing.manual)) return ongoing.run;
  if (ongoing) {
    const retry = (): Promise<ContinuedThread> => continueThread(ctx, request);
    return ongoing.run.then(retry, retry);
  }
  const entry: { manual: boolean; run: Promise<ContinuedThread> } = { manual, run: null! };
  entry.run = continueThreadInner(ctx, request).finally(() => {
    if (continuationRuns.get(request.threadId) === entry) continuationRuns.delete(request.threadId);
  });
  continuationRuns.set(request.threadId, entry);
  return entry.run;
}

/**
 * Whether this request is the user's own Continue action (the palette row,
 * the modal behind it, `threads continue`): neither the server's own
 * recovery nor a queued handoff's, nor an agent's. Only those refuse a
 * running source: the automatic paths run after a settle, and the queued
 * and agent paths carry their own ordering (an entry condition on the
 * source, a thread condition on it).
 */
function isManualContinue(request: ContinueThreadRequest): boolean {
  return request.automatic !== true && request.byAgent !== true && request.destinationThreadId === undefined;
}

/**
 * Pick the destination before creating it, persisting a new id on the
 * source under its thread lock. An explicit id (a queued handoff's) is
 * its own reservation; otherwise a usage-recovery reservation wins, then
 * a note an earlier call left, then a fresh id recorded now — so a second
 * overlapping call, or a retry after a crash between reservation and
 * creation, finds the same destination instead of creating another.
 *
 * A manual continue refuses a running source inside the same lock, before
 * any note or destination exists: serialized with active-turn admission
 * (`sendTurn` takes this same lock), a turn starting now either lands first
 * and refuses this call, or is refused by the claim below. Queued work is
 * not a running turn, so an idle thread with schedules still continues.
 *
 * A manual continue also claims the source for the handoff: admission starts
 * no turn here until the handoff lands and clears the claim (see
 * `continueThreadInner`), so the destination never runs beside a turn the
 * race admitted. The caller preallocates the claim token and owns cleanup
 * for the whole reservation — including a ledger failure after the claim is
 * written — so a failed reserve never leaves a registered token or a
 * blocking record behind. Returns the destination.
 */
async function reserveContinuation(store: ThreadStore, source: StoredThread, request: ContinueThreadRequest, title: string, noteSummary: string, claimToken: string | null): Promise<string> {
  const manual = claimToken !== null;
  if (!manual) {
    if (request.destinationThreadId) return request.destinationThreadId;
    if (source.usagePause?.continuedThreadId) return source.usagePause.continuedThreadId;
  }
  return await store.withThreadLock(source.id, async () => {
    const current = await store.readThreadRecord(source.id);
    const live = current ?? source;
    if (manual) {
      // Refuse what a send would refuse: read the turns first — a first
      // sight of corruption is reported by the read itself — then refuse a
      // turn hidden in an unreadable ledger line (it may be active), a
      // running turn, or a stuck one no build writes (it never settles on
      // its own, so the destination would start beside work that never ends).
      // The admission read reports even an unterminated torn tail at once:
      // it runs under the reservation lock, where the handoff decision is
      // made, so an unreadable snapshot fails closed here while
      // observational reads keep their pending grace for a crash still in
      // flight.
      const turns = await store.readTurns(live.id, { reportTornTail: true });
      const unreadable = hiddenTurnsProblem(store, live.id);
      if (unreadable) throw unreadableTurnsError(live.id, unreadable);
      const running = liveTurn(turns);
      if (running) {
        throw new CliError("THREAD_BUSY", `Thread ${live.id} has an active turn. Retry when idle.`, {
          exitCode: 4,
          details: { threadId: live.id, turnId: running.id },
        });
      }
      // Claim the source before any note or destination exists: from here
      // until the handoff lands, admission starts no turn here (see
      // `continuationInFlight`). Registered against this process by the
      // caller, so the claim stays effective however long the handoff takes;
      // the handoff clears it when it lands, and admission heals it if this
      // handoff dies with it.
      await store.writeThreadRecord({
        ...live,
        continueClaim: { token: claimToken!, pid: process.pid, host: os.hostname(), at: store.nowIso() },
        updatedAt: store.nowIso(),
      });
      if (live.usagePause?.continuedThreadId) return live.usagePause.continuedThreadId;
    } else if (current?.usagePause?.continuedThreadId) return current.usagePause.continuedThreadId;
    const notes = await store.readActivities(source.id);
    const prior = notes.find((activity) => activity.kind === "thread.continued" && typeof activity.payload?.threadId === "string");
    if (prior) return prior.payload!.threadId as string;
    const id = store.newId();
    await store.appendLedger(source.id, "activity", {
      id: store.newId(),
      threadId: source.id,
      turnId: null,
      kind: "thread.continued",
      summary: noteSummary,
      payload: {
        threadId: id,
        title,
        scheduledFor: request.scheduledFor ?? null,
        automatic: request.automatic === true,
        ...(request.byAgent === true ? { byAgent: true } : {}),
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      },
      createdAt: store.nowIso(),
    });
    store.emit(source.id, "thread-continued");
    return id;
  });
}

/** The delegation row a handoff's continuation reports through, when the parent asked to be told. */
async function continuationNotifier(store: ThreadStore, destinationId: string): Promise<string | null> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === destinationId && candidate.notify === true && candidate.continuedIn === undefined);
  return row ? row.parentThreadId : null;
}

/** Tell the parent when a rejoined continuation settles: now if it already did, or by watching it. */
async function watchContinuation(ctx: OperationContext, parentThreadId: string, destinationId: string): Promise<void> {
  if (await taskHasSettledForGood(ctx, destinationId)) await queueTaskNotification(ctx, parentThreadId, destinationId);
  else notifyWhenTaskSettles(ctx, parentThreadId, destinationId);
}

/** An agent's opening instruction for the new thread, folded into its first turn. */
export function firstMessageNote(firstMessage: string | undefined): string {
  const text = firstMessage?.trim();
  if (!text) return "";
  return `\n\n## What to do first\n\n${text}`;
}

/**
 * Whether a source's usage-limit hold applies to its continuation: the
 * destination runs on the same account (usage key), and the limit still
 * stands — a reset already past, or windows with room again, release it.
 * Otherwise the scheduled turn is created without the hold: it must not
 * wait for a limit that does not apply to it.
 */
function continuedHoldApplies(pause: UsagePause, selection: ModelSelection, now = Date.now()): boolean {
  if (usageKeyForInstance(selection.instanceId) !== pause.provider) return false;
  if (pause.resetsAt !== null && Number.isFinite(Date.parse(pause.resetsAt)) && Date.parse(pause.resetsAt) <= now) return false;
  return providerExhausted(pause.provider, now, selection.model);
}

/**
 * Finish inheriting a usage-limit hold on a continuation held for the reset:
 * the destination's oldest queued scheduled turn becomes its recovery entry,
 * so the admission path runs it once nothing blocks it; and the source's
 * limit marker travels along, so the new thread shows the block from the
 * start and holds notifications without spending a turn. A retry rejoining
 * the destination links the same turn rather than duplicating anything.
 */
async function linkScheduledContinuation(ctx: OperationContext, sourceId: string, destinationId: string): Promise<void> {
  const { store } = ctx;
  await store.withThreadLock(destinationId, async () => {
    const destination = await store.readThreadRecord(destinationId);
    if (!destination) return;
    const pause = destination.usagePause;
    if (pause && pause.phase === "waiting" && !pause.recoveryTurnId) {
      const first = (await store.readTurns(destinationId)).find((turn) => turn.status === "queued" && typeof turn.scheduledFor === "string");
      if (first) await store.writeThreadRecord({ ...destination, usagePause: { ...pause, recoveryTurnId: first.id } });
    }
    const source = await store.readThreadRecord(sourceId).catch(() => null);
    if (!source?.usagePause || !continuedHoldApplies(source.usagePause, destination.modelSelection)) return;
    const activities = await store.readActivities(destinationId);
    if (activities.some((activity) => activity.kind === "usage.limit" || activity.kind === "usage.wrap-up")) return;
    const marker = await scheduledContinuationMarker(store, sourceId);
    if (!marker) return;
    await store.appendLedger(destinationId, "activity", {
      id: store.newId(),
      threadId: destinationId,
      turnId: null,
      kind: marker.kind,
      summary: marker.summary,
      payload: marker.payload,
      createdAt: store.nowIso(),
    });
  });
}

/**
 * The limit marker a continuation held for the reset shows from the start:
 * the source's latest hit, or the hold's own reset when the hit predates the
 * marker rows. Null when the source names no limit at all.
 */
async function scheduledContinuationMarker(
  store: ThreadStore,
  sourceId: string,
): Promise<{ kind: "usage.limit" | "usage.wrap-up"; summary: string; payload: Record<string, unknown> } | null> {
  const source = await store.readThreadRecord(sourceId).catch(() => null);
  const hit = (await store.readActivities(sourceId).catch(() => [] as StoredActivity[])).findLast(
    (activity) => activity.kind === "usage.limit" || activity.kind === "usage.wrap-up",
  );
  if (hit) {
    const payload = (hit.payload ?? {}) as Record<string, unknown>;
    return {
      kind: hit.kind as "usage.limit" | "usage.wrap-up",
      summary: hit.kind === "usage.wrap-up" ? "Usage limit reached, wrapping up" : "Usage limit reached",
      payload: {
        provider: payload.provider ?? source?.usagePause?.provider ?? null,
        rateLimitType: payload.rateLimitType ?? null,
        label: payload.label ?? null,
        resetsAt: payload.resetsAt ?? source?.usagePause?.resetsAt ?? null,
      },
    };
  }
  const pause = source?.usagePause;
  if (!pause) return null;
  const latestWindow = [...(pause.windows ?? [])].sort((a, b) => String(a.resetsAt ?? "").localeCompare(String(b.resetsAt ?? ""))).at(-1);
  return {
    kind: "usage.limit",
    summary: "Usage limit reached",
    payload: { provider: pause.provider, rateLimitType: null, label: latestWindow?.label ?? null, resetsAt: pause.resetsAt },
  };
}

/**
 * Whether a manual "Continue in a new thread" (the palette row and
 * `threads continue`, which share `continueThread` without the queue
 * machinery's own markers) moves the source's pending messages along. The
 * queue's own handoff preparation (`destinationThreadId` + `queuedTurnIds`),
 * automatic continuations, and the agent's `thread_continue` (`byAgent`,
 * whose waiting semantics stay as they are) never transfer.
 */
function transfersQueuedMessages(request: ContinueThreadRequest): boolean {
  return (
    request.automatic !== true &&
    request.byAgent !== true &&
    request.destinationThreadId === undefined &&
    request.queuedTurnIds === undefined &&
    request.modelSummary === undefined
  );
}

/**
 * A source turn a manual continue moves to the new thread's Work queue: an
 * ordinary pending user or agent message. Provider-generated usage, control
 * and summary traffic stays with its own semantics — usage continues and
 * protection wake-ups (automatic, wake-up, usage-reset, usage-control and
 * usage origins), summary turns, and queue-selected model/stored handoffs
 * (another continuation, prepared by their own pass) — as do removed and
 * already-moved turns.
 */
function isTransferableQueuedTurn(turn: StoredTurn, primary: StoredMessage | undefined): boolean {
  if (turn.queue?.removed === true) return false;
  if (isTransferredTurn(turn) || turn.handoff !== undefined) return false;
  return isMovableTurnShape(turn, primary);
}

/**
 * The shape a staged turn must still have to move: ordinary and pending,
 * ignoring the staging marker and its removed flag (both expected by then).
 * A staged entry the user reconfigured onto wake-up or automatic traffic,
 * or onto a summary, no longer qualifies — its own flow owns it. A changed
 * continuation alone does not disqualify: completing the in-flight move
 * with the user's policy (preparable on the destination by its own flow)
 * beats stranding the entry removed forever, while staging itself never
 * claims such entries.
 */
function isMovableTurnShape(turn: StoredTurn, primary: StoredMessage | undefined, ignoreContinuation = false): boolean {
  if (turn.status !== "queued") return false;
  if (turn.queue?.summaryFor !== undefined) return false;
  if (turn.queue?.wakeUp === true || turn.queue?.automatic === true) return false;
  if (turn.scheduleReason === "usage-reset") return false;
  if (!ignoreContinuation && turn.queue !== undefined && turn.queue.continuation !== "same-thread") return false;
  if (primary === undefined || primary.role !== "user" || primary.text.trim().length === 0) return false;
  return primary.origin === undefined || primary.origin === "agent-message";
}

/**
 * The claim every view of a manual continue shares — eligibility, the
 * handoff document, and the migration below. Under the queue admission
 * lock and the source lock, each transferable turn is staged: removed from
 * the runnable set and marked with the transfer, keeping status `queued`
 * so entry conditions elsewhere stay blocked on it until the destination
 * entry exists. A claimed turn can no longer be admitted on the source, so
 * promotion between claim and migration simply cannot take one.
 *
 * Null when the source is busy: a running turn owns its queue, so a busy
 * source stages nothing — its queued messages stay and run there, and the
 * handoff keeps its old shape. Only idle sources move work. Liveness (not
 * just openness) matches the rest of the queue machinery: an unknown-status
 * turn blocks the world the same way a running one does.
 */
export interface StageClaim {
  readonly claimed: string[];
  /**
   * Turns an earlier attempt already staged for this same destination (an
   * abort between staging and migration): still claimed, so the handoff
   * must exclude them too — otherwise the retry assigns their text as
   * immediate work while the migration also moves them. Never spans
   * destinations, and staging touches nothing here (no un-removing).
   */
  readonly restaged: string[];
  readonly known: string[];
}
export async function stageQueuedMessages(ctx: OperationContext, sourceId: string, destinationId: string): Promise<StageClaim | null> {
  const { store } = ctx;
  return await store.withThreadLock(QUEUE_ADMISSION_LOCK, async () =>
    store.withThreadLock(sourceId, async () => {
      const [turns, messages] = await Promise.all([store.readTurns(sourceId), store.readMessages(sourceId)]);
      if (liveTurn(turns)) return null;
      const byId = new Map(messages.map((message) => [message.id, message]));
      const claimed: string[] = [];
      for (const turn of turns
        .filter((candidate) => isTransferableQueuedTurn(candidate, byId.get(candidate.messageId)))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
        const queue = turn.queue ?? {
          conditions: [],
          held: false,
          order: Date.parse(turn.createdAt),
          sequential: false,
          continuation: "same-thread" as const,
        };
        await store.updateTurn(sourceId, turn.id, {
          queue: { ...queue, removed: true },
          handoff: { requestId: transferRequestId(turn.id), destinationThreadId: destinationId },
        });
        claimed.push(turn.id);
      }
      // Prior valid staging for this same destination survives the retry:
      // still queued and removed under this destination's marker, so the
      // handoff below keeps excluding it. Another target's abandoned
      // staging never matches the destination filter.
      const claimedNow = new Set(claimed);
      const restaged = turns
        .filter((turn) => turn.status === "queued" && turn.queue !== undefined && isTransferredTurn(turn) && turn.handoff?.destinationThreadId === destinationId && !claimedNow.has(turn.id))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((turn) => turn.id);
      if (claimed.length > 0) store.emit(sourceId, "queue-changed");
      return { claimed, restaged, known: turns.map((turn) => turn.id) };
    }),
  );
}

/** One moved message as the destination stores it. */
interface TransferMessage {
  readonly text: string;
  readonly createdAt: string;
  readonly attachments?: StoredMessage["attachments"];
  readonly origin?: StoredMessage["origin"];
  readonly notification?: StoredMessage["notification"];
}

/**
 * The destination rows for one staged turn: the entry (waiting on the
 * handoff first), its message, and its queued/scheduled activity. The
 * source's staged `removed` flag never travels: the entry is live.
 *
 * One turn carries exactly one message here. Rider messages cannot occur on
 * a transferable turn: mid-turn input only appends to a *running* turn
 * (never staged), the request-id merge needs an internal request id these
 * turns never carry, and settle batching removes folded turns instead of
 * merging into a queued one — so there is nothing else to copy or repair.
 */
function buildTransferEntry(
  store: ThreadStore,
  destination: StoredThread,
  sourceTurn: StoredTurn,
  primary: TransferMessage,
  requestId: string,
  destinationId: string,
  handoffTurnId: string,
  now: string,
): { turn: StoredTurn; messages: StoredMessage[]; activity: StoredActivity } {
  const primaryId = store.newId();
  const base: QueuePolicy = sourceTurn.queue
    ? { ...sourceTurn.queue, removed: false }
    : {
        conditions: [],
        held: false,
        order: Date.parse(sourceTurn.createdAt),
        sequential: false,
        continuation: "same-thread" as const,
      };
  // A second move (A→B→C) carries the settled wait of the first: when the
  // last condition is the server-owned one this machinery itself appends
  // (an entry condition on the source's own handoff turn — a client cannot
  // write one, the edit guard refuses self-thread conditions), it is
  // A second move (A→B→C) carries the wait the first move added. The
  // server owns exactly the condition its `serverWait` mark names — a mark
  // no client edit can forge or preserve, since parseQueuePolicy rebuilds
  // conditions without it — so replace that condition, wherever it sits
  // among siblings it may have been echoed or reordered beside; a
  // client-authored wait reads the same on disk and never drops (a
  // sibling dependency named by a same-thread entry condition is
  // indistinguishable otherwise). That marked wait is the settled one,
  // already satisfied, and would otherwise stack beside the destination's
  // — 16 client conditions, B's stale wait, C's wait, while the projection
  // hides only C's. Rows written before the mark carry none: whatever they
  // hold is preserved, stale wait included — keeping a harmless condition is
  // the safe direction; dropping a real dependency is not. The marked wait
  // is always last (every core write re-appends it), so the latched
  // positions before it keep their indices.
  const carried = sourceTurn.queue !== undefined && isTransferDestinationRequestId(sourceTurn.queue.requestId)
    ? base.conditions.filter((condition) => !(condition.type === "entry" && condition.serverWait === true))
    : base.conditions;
  const policy: QueuePolicy = {
    ...base,
    requestId,
    // Latched "after" observations were made against the source turn's own
    // time: without the same baseline a refresh would read them as not yet
    // happened and drop the latch.
    eventAfter: base.eventAfter ?? sourceTurn.createdAt,
    conditions: [...carried, { type: "entry", threadId: destinationId, turnId: handoffTurnId, serverWait: true }],
  };
  const turn: StoredTurn = {
    id: store.newId(),
    threadId: destinationId,
    status: "queued",
    delivery: "queued",
    queue: policy,
    messageId: primaryId,
    runtimeMode: sourceTurn.runtimeMode,
    interactionMode: sourceTurn.interactionMode,
    ...(sourceTurn.interactionModeExplicit === true ? { interactionModeExplicit: true as const } : {}),
    modelSelection: sourceTurn.modelSelection ?? destination.modelSelection,
    parentTurnId: sourceTurn.parentTurnId,
    ...(sourceTurn.scheduledFor !== undefined && sourceTurn.scheduledFor !== null
      ? {
          scheduledFor: sourceTurn.scheduledFor,
          ...(sourceTurn.scheduleReason !== undefined && sourceTurn.scheduleReason !== null ? { scheduleReason: sourceTurn.scheduleReason } : {}),
          ...(sourceTurn.continueAttempt !== undefined ? { continueAttempt: sourceTurn.continueAttempt } : {}),
        }
      : {}),
    error: null,
    usage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  const messages: StoredMessage[] = [
    {
      id: primaryId,
      threadId: destinationId,
      turnId: turn.id,
      role: "user",
      text: primary.text,
      createdAt: primary.createdAt,
      ...(primary.attachments ? { attachments: primary.attachments } : {}),
      ...(primary.origin !== undefined ? { origin: primary.origin } : {}),
      ...(primary.notification ? { notification: primary.notification } : {}),
    },
  ];
  const activity: StoredActivity = {
    id: store.newId(),
    threadId: destinationId,
    turnId: turn.id,
    kind: typeof turn.scheduledFor === "string" ? "turn.scheduled" : "turn.queued",
    summary: primary.text.slice(0, 120),
    ...(typeof turn.scheduledFor === "string" ? { payload: { scheduledFor: turn.scheduledFor, reason: turn.scheduleReason ?? "user" } } : {}),
    createdAt: now,
  };
  return { turn, messages, activity };
}

/** Whether this destination entry has every row its turn needs to run: the turn row and its message. */
function transferEntryComplete(entry: StoredTurn, destinationMessages: readonly StoredMessage[], primaryText: string): boolean {
  const own = destinationMessages.filter((message) => message.turnId === entry.id);
  return own.some((message) => message.id === entry.messageId && message.text === primaryText);
}

/**
 * Fill the gap a crash left in a destination entry — a turn row with no
 * message — reusing the turn's recorded message id, so a retry never
 * duplicates a row.
 */
async function repairTransferEntry(
  store: ThreadStore,
  destinationId: string,
  entry: StoredTurn,
  primary: TransferMessage,
  destinationMessages: StoredMessage[],
  destinationActivities: StoredActivity[],
): Promise<void> {
  const own = destinationMessages.filter((message) => message.turnId === entry.id);
  if (!own.some((message) => message.id === entry.messageId)) {
    const repaired: StoredMessage = {
      id: entry.messageId,
      threadId: destinationId,
      turnId: entry.id,
      role: "user",
      text: primary.text,
      createdAt: primary.createdAt,
      ...(primary.attachments ? { attachments: primary.attachments } : {}),
      ...(primary.origin !== undefined ? { origin: primary.origin } : {}),
      ...(primary.notification ? { notification: primary.notification } : {}),
    };
    await store.appendLedger(destinationId, "messages", repaired);
    destinationMessages.push(repaired);
  }
  if (!destinationActivities.some((activity) => activity.turnId === entry.id && (activity.kind === "turn.queued" || activity.kind === "turn.scheduled"))) {
    const activity: StoredActivity = {
      id: store.newId(),
      threadId: destinationId,
      turnId: entry.id,
      kind: typeof entry.scheduledFor === "string" ? "turn.scheduled" : "turn.queued",
      summary: primary.text.slice(0, 120),
      ...(typeof entry.scheduledFor === "string" ? { payload: { scheduledFor: entry.scheduledFor, reason: entry.scheduleReason ?? "user" } } : {}),
      createdAt: store.nowIso(),
    };
    await store.appendLedger(destinationId, "activity", activity);
    destinationActivities.push(activity);
  }
}

/** The source side of a completed move: inert history pointing at the new entry. */
async function markTransferMoved(
  store: ThreadStore,
  sourceId: string,
  sourceTurn: StoredTurn,
  destinationId: string,
  entryId: string,
  now: string,
): Promise<void> {
  const queue = sourceTurn.queue ?? {
    conditions: [],
    held: false,
    order: Date.parse(sourceTurn.createdAt),
    sequential: false,
    continuation: "same-thread" as const,
  };
  await store.updateTurn(sourceId, sourceTurn.id, {
    status: "interrupted",
    completedAt: now,
    queue: { ...queue, removed: true },
    handoff: { requestId: transferRequestId(sourceTurn.id), destinationThreadId: destinationId, landed: true },
  });
  // A moved schedule must not fire on the source afterwards: the entry runs
  // on the destination now. (A timer armed in another process finds nothing
  // runnable and stands down on its own.)
  if (typeof sourceTurn.scheduledFor === "string") disarmScheduledTurn(sourceId, sourceTurn.id);
  await store.appendLedger(sourceId, "activity", {
    id: store.newId(),
    threadId: sourceId,
    turnId: sourceTurn.id,
    kind: "turn.interrupted",
    summary: sourceTurn.id,
    // Taken back before it ran: clients drop it from the transcript,
    // while the ledger keeps the history and the transfer target.
    payload: { beforeStart: true, transferredTo: { threadId: destinationId, turnId: entryId } },
    createdAt: now,
  });
}

/**
 * Unstage transfer claims whose destination entry provably never landed, so a
 * later continue reads them as ordinary source work instead of a move that
 * already happened. Only entries with no destination entry at all are
 * touched: a whole, live destination entry keeps its marker so cross-thread
 * dependents keep following it to the new thread. Runs on every non-manual
 * continue, which never runs the migration itself — without this, a crash
 * between staging and destination creation would leave the source rows
 * removed and hidden forever.
 *
 * Absence must be proven on a complete snapshot. A failed destination read
 * is unknown, not empty — and a skipped destination row could be the entry
 * itself — so either leaves that destination's markers staged rather than
 * risking two runnable copies once reads recover. A clean empty read (the
 * destination was never created) still unstages, so actual abandoned claims
 * keep recovering.
 *
 * Takes only the source thread lock, never the queue-admission lock: the
 * queue-handoff preparation path reaches here holding the admission lock
 * already, and taking it again would deadlock. The source lock alone
 * suffices — every writer of these rows serializes on it, and a staged turn
 * carries `removed` so admission cannot promote it mid-reconcile; whichever
 * snapshot a concurrent admission pass reads, the turn is either still
 * removed (skipped) or already ordinary work again (rightly runnable).
 */
export async function reconcileAbandonedTransferClaims(ctx: OperationContext, sourceId: string): Promise<void> {
  const { store } = ctx;
  await store.withThreadLock(sourceId, async () => {
    const turns = await store.readTurns(sourceId);
    const marked = turns.filter((turn) => isTransferredTurn(turn));
    if (marked.length === 0) return;
    const proven = new Map<string, StoredTurn[]>();
    const unproven = new Set<string>();
    const unstage = new Set<string>();
    for (const turn of marked) {
      const destinationId = turn.handoff!.destinationThreadId;
      if (unproven.has(destinationId)) continue;
      let existing = proven.get(destinationId);
      if (!existing) {
        let reads: StoredTurn[];
        try {
          // Report a torn tail at once: the admission read cannot proceed
          // on an unreadable snapshot, and this decision cannot either.
          reads = await store.readTurns(destinationId, { reportTornTail: true });
        } catch {
          // Unknown, not empty: leave this destination's markers staged.
          unproven.add(destinationId);
          continue;
        }
        if (hiddenTurnsProblem(store, destinationId)) {
          // A skipped destination row could be the entry itself.
          unproven.add(destinationId);
          continue;
        }
        existing = reads;
        proven.set(destinationId, existing);
      }
      if (existing.some((candidate) => candidate.queue?.requestId === transferDestinationRequestId(turn.id))) continue;
      unstage.add(turn.id);
    }
    if (unstage.size === 0) return;
    await store.rewriteLedger(
      sourceId,
      "turns",
      turns.map((candidate) => {
        if (!unstage.has(candidate.id)) return candidate;
        const { handoff: _abandoned, ...rest } = candidate;
        return rest.queue ? { ...rest, queue: { ...rest.queue, removed: false } } : rest;
      }),
    );
    store.emit(sourceId, "queue-changed");
  });
}

/**
 * Finish moving the staged turns to the destination's Work queue as entries
 * of their own, preserving each one's scheduled time, queue conditions and
 * latched state, user hold, order, per-turn overrides (model, runtime and
 * interaction modes, schedule reason), origin and notification facts, and
 * attachments. Every entry also waits on the destination's first (handoff)
 * turn, so a scheduled continuation still runs its handoff before anything
 * that moved — the appended condition keeps the original indices, and with
 * them the latched positions, intact.
 *
 * Each staged source turn moves at most once: an entry already there is
 * verified and repaired (a crash between its turn and message writes leaves
 * a turn row with no message), never duplicated, and the source row is
 * marked moved — interrupted, removed, keeping its transfer marker — only
 * once its destination entry is whole. An entry that cannot be completed
 * stays staged: still removed on the source, still excluded from handoffs,
 * still blocking waiters, until a later continue repairs it. Staged turns
 * the source took back meanwhile keep their marker while their destination
 * entry still stands, so cross-thread dependents stay blocked on the move
 * instead of releasing early; only truly undone moves (no live destination
 * entry) are unmarked back to ordinary removed history, with a partial
 * destination entry taken back too.
 *
 * The whole migration runs under the queue admission lock, so admission
 * cannot dispatch a half-written entry mid-loop; and a destination entry
 * that somehow reaches a runner before its repair is skipped rather than
 * failed (see `runRecoveredTurn`).
 */
export async function migrateQueuedMessages(ctx: OperationContext, sourceId: string, destinationId: string): Promise<void> {
  const { store } = ctx;
  await store.withThreadLock(QUEUE_ADMISSION_LOCK, async () => {
    await store.withThreadLock(sourceId, async () => {
      const [turns, messages] = await Promise.all([store.readTurns(sourceId), store.readMessages(sourceId)]);
      const byId = new Map(messages.map((message) => [message.id, message]));
      const order = (left: StoredTurn, right: StoredTurn): number =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
      // A staged claim stays staged even when its source message row is
      // unreadable: without it there is nothing to move yet, and unmarking
      // would drop the waiters that followed the marker. The staged loop
      // below skips such turns until the ledger heals.
      const isStaged = (turn: StoredTurn): boolean => {
        if (turn.status !== "queued" || !isTransferredTurn(turn) || turn.handoff?.destinationThreadId !== destinationId || turn.queue === undefined) {
          return false;
        }
        const primary = byId.get(turn.messageId);
        return primary === undefined || isMovableTurnShape(turn, primary, true);
      };
      const staged = turns.filter(isStaged).sort(order);
      const stagedIds = new Set(staged.map((turn) => turn.id));
      const abandoned = turns.filter(
        (turn) => isTransferredTurn(turn) && turn.handoff?.destinationThreadId === destinationId && !stagedIds.has(turn.id),
      );
      if (staged.length === 0 && abandoned.length === 0) return;
      await store.withThreadLock(destinationId, async () => {
        const destination = await store.readThreadRecord(destinationId);
        if (!destination) return;
        // Fail closed on an unreadable destination snapshot: a skipped row
        // could be the entry being moved, and appending into a torn tail
        // would concatenate garbage instead of a readable row. No writes
        // until a readable durable snapshot exists; a later retry completes
        // the move.
        let existing: StoredTurn[];
        let destinationMessages: StoredMessage[];
        let destinationActivities: StoredActivity[];
        try {
          [existing, destinationMessages, destinationActivities] = await Promise.all([
            store.readTurns(destinationId, { reportTornTail: true }),
            store.readMessages(destinationId, { reportTornTail: true }),
            store.readActivities(destinationId, { reportTornTail: true }),
          ]);
        } catch {
          return;
        }
        if (
          hiddenTurnsProblem(store, destinationId) !== null ||
          hiddenLedgerProblem(store, destinationId, store.messagesFile(destinationId)) !== null ||
          hiddenLedgerProblem(store, destinationId, store.activitiesFile(destinationId)) !== null
        ) {
          return;
        }
        // The handoff turn stays first: moved entries wait on it even when
        // the continuation itself is scheduled, so nothing runs ahead of it.
        const handoffTurn = [...existing].sort(order).find((turn) => !isTransferDestinationRequestId(turn.queue?.requestId)) ?? null;
        if (!handoffTurn) return;
        const handoffTurnId = handoffTurn.id;
        const now = store.nowIso();
        for (const sourceTurn of staged) {
          const requestId = transferDestinationRequestId(sourceTurn.id);
          const entry = existing.find((turn) => turn.queue?.requestId === requestId) ?? null;
          if (entry && (entry.status !== "queued" || entry.queue?.removed === true)) {
            // Already settled or taken back on the destination: the move is
            // over, whatever the source still says.
            await markTransferMoved(store, sourceId, sourceTurn, destinationId, entry.id, now);
            continue;
          }
          const primary = byId.get(sourceTurn.messageId);
          // A source message lost to a skipped bad line stays staged: a
          // retry can still move it once the ledger heals.
          if (!primary) continue;
          if (!entry) {
            const built = buildTransferEntry(store, destination, sourceTurn, primary, requestId, destinationId, handoffTurnId, now);
            await store.appendLedger(destinationId, "turns", built.turn);
            existing.push(built.turn);
            destinationMessages.push(...built.messages);
            for (const row of built.messages) await store.appendLedger(destinationId, "messages", row);
            await store.appendLedger(destinationId, "activity", built.activity);
            destinationActivities.push(built.activity);
          } else {
            await repairTransferEntry(store, destinationId, entry, primary, destinationMessages, destinationActivities);
          }
          const target = existing.find((turn) => turn.queue?.requestId === requestId) ?? null;
          // A destination entry that is still incomplete stays staged: it
          // must not run until its repair lands.
          if (!target || !transferEntryComplete(target, destinationMessages, primary.text)) continue;
          // A moved schedule fires on the destination now, so arm it where
          // the scheduler owns this process (a no-op elsewhere); the source
          // timer is disarmed with the moved mark below.
          if (typeof target.scheduledFor === "string") armScheduledTurn(destinationId, target.id, target.scheduledFor);
          await markTransferMoved(store, sourceId, sourceTurn, destinationId, target.id, now);
        }
        for (const sourceTurn of abandoned) {
          // Taken back on the source after staging, or moved by an earlier
          // pass. A destination entry that is already whole and still live
          // stands: unmarking now would release cross-thread dependents
          // early, while the move is still queued ahead of them — so its
          // marker stays until the entry settles. The same goes for an
          // entry that carried the work onward (A→B→C): it is a transfer
          // row of its own now, and the marker here is the durable alias a
          // cross-thread dependent still follows — unmarking would let the
          // dependent run while the work is still pending (a retry continue
          // on A rejoins B and reads B's interrupted transfer row as
          // terminal) and would also resurrect the moved text in this
          // thread's handoff projection. Everything else reads as ordinary
          // removed history from here on, and a partial entry, which can
          // never complete now, is taken back too.
          const primary = byId.get(sourceTurn.messageId);
          const requestId = transferDestinationRequestId(sourceTurn.id);
          const entry = existing.find((turn) => turn.queue?.requestId === requestId) ?? null;
          // Wholeness is judged from the destination's own rows: the source
          // message may be unreadable while the copy is whole, and only a
          // whole destination entry keeps dependents waiting.
          const whole = entry !== null && (primary !== undefined
            ? transferEntryComplete(entry, destinationMessages, primary.text)
            : destinationMessages.some((message) => message.id === entry.messageId));
          const live = entry !== null && (entry.status === "running" || (entry.status === "queued" && entry.queue !== undefined && entry.queue.removed !== true));
          const movedOnward = entry !== null && isTransferredTurn(entry);
          if (whole && (live || movedOnward)) continue;
          const current = await store.readTurns(sourceId);
          await store.rewriteLedger(
            sourceId,
            "turns",
            current.map((candidate) => {
              if (candidate.id !== sourceTurn.id) return candidate;
              const { handoff: _moved, ...rest } = candidate;
              return rest;
            }),
          );
          if (!whole && entry && entry.status === "queued" && entry.queue && entry.queue.removed !== true) {
            const updated = await store.updateTurn(destinationId, entry.id, {
              status: "interrupted",
              completedAt: now,
              queue: { ...entry.queue, removed: true },
            });
            if (updated) {
              existing.splice(
                existing.findIndex((turn) => turn.id === entry.id),
                1,
                updated,
              );
              await store.appendLedger(destinationId, "activity", {
                id: store.newId(),
                threadId: destinationId,
                turnId: entry.id,
                kind: "turn.interrupted",
                summary: entry.id,
                payload: { beforeStart: true },
                createdAt: now,
              });
            }
          }
        }
        store.emit(destinationId, "turn-queued");
      });
      store.emit(sourceId, "queue-changed");
    });
  });
}

async function continueThreadInner(ctx: OperationContext, request: ContinueThreadRequest): Promise<ContinuedThread> {
  const { store } = ctx;
  const source = await store.readThreadRecord(request.threadId);
  if (!source) throw new CliError("THREAD_NOT_FOUND", `No thread ${request.threadId}.`, { exitCode: 2 });
  // An agent continuing its own thread onto Antigravity starts delegated
  // work there: refused while the setting is off, before a destination is
  // reserved. The user's own Continue action and queued handoffs are not
  // this path (their first turn is held by admission when automatic).
  if (request.byAgent === true) requireAntigravityDelegation(ctx.config, (request.modelSelection ?? source.modelSelection).instanceId);
  const title = continuedTitle(source.title);
  // Review never stays on a thread: a continued review child, or a carried
  // one-off review turn, starts the new thread in Build instead.
  const carriedMode = request.interactionMode ?? source.interactionMode;
  const interactionMode = carriedMode === "review" ? "default" : carriedMode;
  const noteSummary = carriedMode === "review" ? `Continued in "${title}" (Review mode reset to Build: a one-off or delegate mode never stays on a thread)` : `Continued in "${title}"`;
  // The claim token is owned by the cleanup below, which spans the whole
  // reservation: a failure after the claim is written — a ledger throw
  // between the record write and the note — still untracks and clears.
  // Tracking before the lock is safe: admission only consults the registry
  // alongside a claim record, which does not exist yet.
  const claimToken = isManualContinue(request) ? store.newId() : null;
  if (claimToken !== null) trackContinuation(claimToken);
  try {
    const destinationId = await reserveContinuation(store, source, request, title, noteSummary, claimToken);
    return await continueThreadReserved(ctx, request, source, title, interactionMode, noteSummary, destinationId);
  } finally {
    // The handoff landed (or failed): the source takes work again. A later
    // send on the old thread is the user's own choice, as before. Untrack
    // first — a racing admission in this process then heals our record
    // instead of blocking on it (its owner is gone), while other owners
    // still block until the TTL — then clear the record, which admission
    // heals on its own if this write dies (a stall of at most
    // CONTINUE_CLAIM_TTL_MS, never a wedge; our own dead claim heals
    // immediately without waiting out the TTL).
    if (claimToken !== null) {
      untrackContinuation(claimToken);
      // Best effort by design: if this write dies, the record keeps a claim
      // whose owner is gone, so the next admission heals it instead of
      // blocking — a stall of at most CONTINUE_CLAIM_TTL_MS, never a wedge.
      await clearContinuationClaim(store, source.id, claimToken).catch(() => undefined);
    }
  }
}

/**
 * Release a manual handoff's admission claim, by token so a newer claim is
 * never lifted. Best effort: admission heals a leftover claim on its own.
 */
async function clearContinuationClaim(store: ThreadStore, threadId: string, token: string): Promise<void> {
  await store.withThreadLock(threadId, async () => {
    const current = await store.readThreadRecord(threadId);
    if (current?.continueClaim?.token === token) {
      await store.writeThreadRecord({ ...current, continueClaim: null, updatedAt: store.nowIso() });
    }
  });
}

async function continueThreadReserved(
  ctx: OperationContext,
  request: ContinueThreadRequest,
  source: StoredThread,
  title: string,
  interactionMode: InteractionMode,
  noteSummary: string,
  destinationId: string,
): Promise<ContinuedThread> {
  const { store } = ctx;
  const project = (await listStoredProjects(ctx.storeRoot)).find((candidate) => candidate.id === source.projectId);
  // Anything but a manual continue never runs the migration, so reconcile
  // stale staging claims first: without this a crash between staging and
  // destination creation would leave the source rows removed and hidden
  // forever. The handoff below then reads them as ordinary pending work.
  if (!transfersQueuedMessages(request)) await reconcileAbandonedTransferClaims(ctx, source.id);
  // A manual continue moves the source's pending ordinary messages with it:
  // staging claims the set under lock before the handoff is written, and the
  // handoff projects exactly the claim-time source, so work accepted after
  // the claim stays on the source and out of the destination snapshot.
  const claim = transfersQueuedMessages(request) ? await stageQueuedMessages(ctx, source.id, destinationId) : null;
  const handoff = await buildHandoff(store, source.id, { projectTitle: project?.title ?? null, preferModelSummary: !request.destinationThreadId && source.usagePause?.handoff === true, ...(request.modelSummary ? { modelSummary: request.modelSummary } : {}), ...(request.queuedTurnIds ? { queuedTurnIds: request.queuedTurnIds } : {}), ...(claim ? { knownTurnIds: claim.known, excludedTurnIds: [...claim.claimed, ...claim.restaged] } : {}) });
  const existing = await store.readThreadRecord(destinationId);
  const created = existing ?? await createThread(store, {
    id: destinationId,
    projectId: source.projectId,
    title,
    modelSelection: request.modelSelection ?? source.modelSelection,
    runtimeMode: request.runtimeMode ?? source.runtimeMode,
    interactionMode,
    env: source.env,
    continuedFrom: source.id,
  });
  if (existing && existing.continuedFrom === undefined) {
    await store.withThreadLock(existing.id, async () => {
      const current = await store.readThreadRecord(existing.id);
      if (current) await store.writeThreadRecord({ ...current, continuedFrom: source.id });
    });
  }
  const live = await store.readThreadRecord(source.id);
  // A continuation held for the reset inherits the hold; one starting now does not.
  // The hold has to apply to the destination: same account, limit still standing.
  const scheduledHold = request.scheduledFor !== undefined && !request.destinationThreadId
    && live?.usagePause != null
    && continuedHoldApplies(live.usagePause, request.modelSelection ?? source.modelSelection);
  if (live?.usagePause && !request.destinationThreadId) {
    if (live.usagePause.continuedThreadId !== created.id) {
      await store.withThreadLock(source.id, async () => {
        const current = await store.readThreadRecord(source.id);
        if (current?.usagePause && current.usagePause.continuedThreadId !== created.id) {
          await store.writeThreadRecord({ ...current, usagePause: { ...current.usagePause, continuedThreadId: created.id } });
        }
      });
    }
    if (scheduledHold) {
      // Waiting, not resuming: until the reset nothing starts on the new
      // thread — notifications and sends queue behind the hold — and its
      // first turn becomes the recovery entry below. Written before that
      // turn starts so a notification racing it still waits.
      await store.withThreadLock(created.id, async () => {
        const [destination, pause] = await Promise.all([store.readThreadRecord(created.id), store.readThreadRecord(source.id)]);
        if (destination && !destination.usagePause && pause?.usagePause) {
          await store.writeThreadRecord({ ...destination, usagePause: { provider: pause.usagePause.provider, resetsAt: pause.usagePause.resetsAt, order: pause.usagePause.order, phase: "waiting", handoff: false } });
        }
      });
    } else if (request.scheduledFor === undefined) {
      await store.withThreadLock(created.id, async () => {
        const [destination, pause] = await Promise.all([store.readThreadRecord(created.id), store.readThreadRecord(source.id)]);
        if (destination && !destination.usagePause && pause?.usagePause) {
          await store.writeThreadRecord({ ...destination, usagePause: { provider: pause.usagePause.provider, resetsAt: pause.usagePause.resetsAt, order: pause.usagePause.order, phase: "resuming", handoff: false } });
        }
      });
    }
    // A scheduled continuation the hold does not apply to gets no pause at
    // all: its turn runs at its time, not behind another account's reset.
  }
  // An unclaimed run-size question moves with the thread: the continuation
  // has not been offered one either, so its first real prompt still asks.
  if (source.researchPicker === true) {
    const targetId = existing ? existing.id : created.id;
    await store.withThreadLock(targetId, async () => {
      const current = await store.readThreadRecord(targetId);
      if (current && current.researchPicker !== true) await store.writeThreadRecord({ ...current, researchPicker: true });
    });
  }
  const notifyParent = await carryDelegation(store, source.id, created.id);
  await endContinuedSession(ctx, source);
  const adopted = await adoptTasks(store, source.id, created.id);
  if ((await store.readTurns(created.id)).length === 0) {
    const started = await startTurn(ctx, {
      threadId: created.id,
      prompt: handoff + runningTasksNote(adopted) + firstMessageNote(request.firstMessage),
      ...(request.queue ? { queue: request.queue } : {}),
      ...(request.scheduledFor !== undefined ? { scheduledFor: request.scheduledFor, scheduleReason: "user" as const } : {}),
      // Noop subscriber: the driver's shared pump exists before any client subscribes.
      onEvent: () => undefined,
    });
    // A queued continuation reports through `runRecoveredTurn` when it is admitted; one started now reports here.
    if (notifyParent && started.run !== null) void started.run.then(() => queueTaskNotification(ctx, notifyParent, created.id)).catch(() => undefined);
    else if (existing !== null) {
      // A retry rejoining a reserved destination: the first attempt may have
      // died before wiring the parent's notification, so watch the turn.
      const parent = notifyParent ?? (await continuationNotifier(store, created.id));
      if (parent) await watchContinuation(ctx, parent, created.id);
    }
  } else if (existing !== null) {
    // A retry after the first turn was already started: make sure the parent
    // still hears when the continuation settles.
    const parent = notifyParent ?? (await continuationNotifier(store, created.id));
    if (parent) await watchContinuation(ctx, parent, created.id);
  }
  // The migration runs after the first turn exists, so moved entries can
  // wait on it; it repairs and completes staged claims, including ones a
  // crashed earlier attempt left behind.
  if (transfersQueuedMessages(request)) await migrateQueuedMessages(ctx, source.id, created.id);
  if (scheduledHold) await linkScheduledContinuation(ctx, source.id, created.id);
  if (!(await store.readActivities(source.id)).some((activity) => activity.kind === "thread.continued" && activity.payload?.threadId === created.id)) {
    await store.appendLedger(source.id, "activity", {
      id: store.newId(),
      threadId: source.id,
      turnId: null,
      kind: "thread.continued",
      summary: noteSummary,
      payload: { threadId: created.id, title, scheduledFor: request.scheduledFor ?? null, automatic: request.automatic === true, ...(request.byAgent === true ? { byAgent: true } : {}), ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}) },
      createdAt: store.nowIso(),
    });
  }
  store.emit(source.id, "thread-continued");
  return { threadId: created.id, title, scheduledFor: request.scheduledFor ?? null };
}

export interface ContinueOwnThreadRequest {
  /** The calling thread: an agent may only continue its own thread, never another one. */
  readonly threadId: string;
  /** The handoff summary the agent wrote: the new thread's handoff, replacing the generated record. */
  readonly summary: string;
  /** What the new thread should do first, folded into its first turn. */
  readonly firstMessage?: string;
  /** The model the new thread runs on: resolved like a follow-up, or the source's when absent. */
  readonly modelSelection?: ModelSelection;
  /**
   * A client-generated idempotency key: repeating the same continuation
   * with the same key returns the original thread instead of refusing as
   * a repeat. Generate one UUID per new continuation.
   */
  readonly idempotencyKey?: string;
}

export interface ContinuedOwnThread extends ContinuedThread {
  readonly adoptedTasks: readonly { readonly taskId: string; readonly title: string }[];
  /** Present on an idempotent replay naming a different summary: the first handoff was kept. */
  readonly note?: string;
}

/** At most this many agent continuations in a row with no user message between them. */
export const MAX_CONSECUTIVE_AGENT_CONTINUATIONS = 3;

/**
 * Trailing agent hops ending at this thread: each hop the thread's own
 * `thread.continued` note marked `byAgent`, stopping at a user-driven hop,
 * at a thread carrying a real user message (the streak is only consecutive
 * while the user stays out of it), or at the lineage root. A reservation
 * whose destination was never created cannot appear here: the walk follows
 * existing threads through `continuedFrom`.
 */
async function countConsecutiveAgentContinuations(store: ThreadStore, caller: StoredThread): Promise<number> {
  if (await hasRealUserMessage(store, caller)) return 0;
  let streak = 0;
  let current: StoredThread = caller;
  while (current.continuedFrom) {
    const parentId: string = current.continuedFrom;
    const childId: string = current.id;
    const parent: StoredThread | null = await store.readThreadRecord(parentId).catch(() => null);
    if (!parent) break;
    const hop = (await store.readActivities(parent.id).catch(() => [] as StoredActivity[])).some(
      (activity) => activity.kind === "thread.continued" && activity.payload?.threadId === childId && activity.payload?.byAgent === true,
    );
    if (!hop) break;
    streak += 1;
    current = parent;
    if (await hasRealUserMessage(store, current)) break;
  }
  return streak;
}

/**
 * Whether a real user message landed in this thread: role `user` with no
 * origin (agent, notification and usage messages carry one). The thread's
 * handoff prompt is skipped: on a continued thread that is what Moxen
 * wrote to open it, not the user speaking — while a user steer into that
 * same first turn still counts.
 */
async function hasRealUserMessage(store: ThreadStore, thread: StoredThread): Promise<boolean> {
  const [turns, messages] = await Promise.all([
    store.readTurns(thread.id).catch(() => [] as StoredTurn[]),
    store.readMessages(thread.id).catch(() => [] as StoredMessage[]),
  ]);
  const firstMessageId = [...turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.messageId;
  return messages.some((message) => message.role === "user" && message.origin == null && message.id !== firstMessageId);
}

/**
 * An agent continuing its own thread in a new one, through the same
 * `continueThread` the palette action uses: the agent's summary replaces
 * the generated handoff record, running delegated children move to the
 * new thread, and the new thread's first turn waits until the source has
 * nothing running or queued (it shares the source's checkout, so the two
 * must not start side by side). A later plain send on the source is the
 * user's own choice, as after the palette action, and is not refused. The
 * caller must then end its turn promptly; once it settles its provider
 * session is closed so nothing wakes the old thread again.
 *
 * Refuses what the palette path refuses (no thread, archived, settled),
 * plus what only applies to an agent: a usage hold, research runs,
 * delegated tasks, more than a few consecutive agent hops, and anyone
 * but the thread's own agent (the tool names no thread, so reaching
 * another thread — a parent included — is not expressible).
 */
export async function continueOwnThread(ctx: OperationContext, request: ContinueOwnThreadRequest): Promise<ContinuedOwnThread> {
  const callerId = requireThreadId(request.threadId);
  const summary = request.summary.trim();
  if (!summary || summary.length > 64_000) throw new CliError("INVALID_HANDOFF", "Submit a non-empty handoff of at most 64000 characters.");
  const firstMessage = request.firstMessage?.trim();
  if (request.firstMessage !== undefined && !firstMessage) throw new CliError("INVALID_HANDOFF", "The new thread's first message must be non-empty.");
  const caller = await ctx.store.readThreadRecord(callerId);
  if (!caller || caller.deletedAt) throw new CliError("THREAD_NOT_FOUND", `No thread exists with id ${callerId}.`, { exitCode: 3 });
  if (caller.archivedAt) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${callerId} is archived and cannot be continued.`, {
      exitCode: 4,
      details: { threadId: callerId, archivedAt: caller.archivedAt },
    });
  }
  if (caller.settledAt) {
    throw new CliError("THREAD_SETTLED", `Thread ${callerId} is settled and cannot be continued. Unsettle it first.`, {
      exitCode: 4,
      details: { threadId: callerId, settledAt: caller.settledAt },
    });
  }
  if (caller.usagePause) {
    throw new CliError(
      "THREAD_CONTINUE_PROTECTED",
      `Thread ${callerId} is held by usage protection and cannot be continued now. Send a message to end the hold, or wait for its recovery, then continue it in a new thread.`,
      { exitCode: 4, details: { threadId: callerId, phase: caller.usagePause.phase } },
    );
  }
  if (caller.researchRole || isResearchRunActive(caller.researchRun)) {
    throw new CliError(
      "THREAD_CONTINUE_RESEARCH",
      "A research run's roles and lead continue only through the run (research_message_submit, and the lead's follow-ups), which are scoped and capped: thread_continue does not reach them.",
      { exitCode: 4, details: { threadId: callerId } },
    );
  }
  if (await delegationOf(ctx.store, callerId)) {
    throw new CliError(
      "THREAD_CONTINUE_DELEGATED",
      "A delegated task cannot continue itself in a new thread: finish with a report and let the thread that delegated it decide what runs next. A full context there is compacted in place.",
      { exitCode: 4, details: { threadId: callerId } },
    );
  }
  const key = request.idempotencyKey?.trim() || undefined;
  const notes = await ctx.store.readActivities(callerId);
  if (key) {
    const replay = notes.find((activity) => activity.kind === "thread.continued" && activity.payload?.idempotencyKey === key);
    if (replay && typeof replay.payload?.threadId === "string") {
      const destination = await ctx.store.readThreadRecord(replay.payload.threadId);
      if (destination) {
        return {
          threadId: destination.id,
          title: destination.title,
          scheduledFor: null,
          adoptedTasks: await adoptedTasksOf(ctx, destination.id),
          note: `Already continued as ${destination.id} for this key; the first summary was kept.`,
        };
      }
      // A crash between reservation and creation names a thread that was
      // never created: fall through and finish the job below.
    }
  }
  const streak = await countConsecutiveAgentContinuations(ctx.store, caller);
  if (streak >= MAX_CONSECUTIVE_AGENT_CONTINUATIONS) {
    throw new CliError(
      "THREAD_CONTINUE_LIMIT",
      `Thread ${callerId} was already continued by its agent ${streak} times in a row with no user message since. Ask the user how to proceed (they can continue it in a new thread).`,
      { exitCode: 4, details: { threadId: callerId, consecutiveAgentContinuations: streak } },
    );
  }
  const running = openTurn(await ctx.store.readTurns(callerId));
  const continued = await continueThread(ctx, {
    threadId: callerId,
    modelSummary: summary,
    ...(firstMessage ? { firstMessage } : {}),
    ...(request.modelSelection ? { modelSelection: request.modelSelection } : {}),
    ...(running
      ? {
          queue: {
            // The new thread shares the source checkout: it waits until the
            // source has nothing running or queued, not just until this turn
            // ends. A later plain send on the source is the user's own
            // choice, as after the palette action, and is not refused.
            conditions: [
              { type: "entry", threadId: callerId, turnId: running.id },
              { type: "thread", threadId: callerId },
            ],
            held: false,
            order: Date.now(),
            sequential: false,
            continuation: "same-thread" as const,
          },
        }
      : {}),
    byAgent: true,
    ...(key ? { idempotencyKey: key } : {}),
  });
  if (running) closeContinuedSessionWhenSettled(ctx, callerId, continued.threadId);
  return { ...continued, adoptedTasks: await adoptedTasksOf(ctx, continued.threadId) };
}

/** The tasks the new thread took over: every delegation row re-pointed at it, except history rows. Research roles are excluded, like the transfer itself. */
async function adoptedTasksOf(ctx: OperationContext, destinationId: string): Promise<readonly { taskId: string; title: string }[]> {
  const rows = (await ctx.store.readDelegations().catch(() => [] as StoredDelegation[])).filter(
    (row) => row.parentThreadId === destinationId && row.continuedIn === undefined,
  );
  const children = await Promise.all(rows.map((row) => ctx.store.readThreadRecord(row.childThreadId).catch(() => null)));
  return rows.flatMap((row, index) => {
    const child = children[index];
    if (child?.researchRole !== undefined) return [];
    return [{ taskId: row.childThreadId, title: child?.title ?? row.childThreadId }];
  });
}

/**
 * Close the continued thread's provider session once its calling turn
 * settles — any terminal state, not only a clean finish — watched from the
 * settle path's own ledger events, not a session subscription. The session
 * is left alone while a turn runs (stopping it would cut the turn off), and
 * a newer running turn keeps it too: only an idle thread is closed, checked
 * again under the thread lock so a turn that starts in between wins, so a
 * background task or late notification can no longer wake the old thread.
 * The watch also ends when the destination starts (the source is idle by
 * admission then): after that the source is the user's revived thread and
 * its session is left alone. After a restart there is nothing to close —
 * sessions live in the process, so no live session means no wake-up, and
 * orphan recovery owns the ledger. Best effort throughout: losing the race
 * never fails the continuation.
 */
function closeContinuedSessionWhenSettled(ctx: OperationContext, sourceId: string, destinationId: string): void {
  let done = false;
  let checking = false;
  let again = false;
  const stop = ctx.store.subscribe((event) => {
    if (event.type !== "backend.thread.changed") return;
    if (event.threadId === sourceId) {
      if (event.reason !== "turn-completed" && event.reason !== "turn-failed" && event.reason !== "turn-interrupted") return;
    } else if (event.threadId !== destinationId) return;
    void check();
  });
  const check = async (): Promise<void> => {
    if (done) return;
    if (checking) { again = true; return; }
    checking = true;
    try {
      do {
        again = false;
        if (done) continue;
        const closed = await ctx.store.withThreadLock(sourceId, async () => {
          const turns = await ctx.store.readTurns(sourceId).catch(() => []);
          if (turns.some((turn) => turn.status === "running")) return false;
          try {
            const source = await ctx.store.readThreadRecord(sourceId).catch(() => null);
            const driver = source ? ctx.driverFor(source.modelSelection.instanceId) : null;
            if (driver?.stopSession) await Effect.runPromise(driver.stopSession(sourceId)).catch(() => undefined);
          } catch {
            // Best effort: the continuation stands whether or not the old session could be ended.
          }
          return true;
        }).catch(() => false);
        if (!closed) continue;
        done = true;
        stop();
      } while (again);
    } finally {
      checking = false;
    }
  };
  void check();
}

/**
 * The thread that was continued is done: its provider session ends, so a
 * background task (a CI watcher, a Monitor) cannot finish later and start a
 * turn in it with no message from the user — the new thread carries the work
 * on, and two threads must not act on the same news. A turn still open on it
 * is left to finish (stopping the session would cut it off), so only the
 * tasks the provider lets us name are stopped then. Nothing here touches the
 * delegations: delegated children were re-pointed (`adoptTasks`), running
 * and idle alike. A thread that merely finished a turn never
 * comes through here, so its wake-ups stay.
 */
async function endContinuedSession(ctx: OperationContext, source: StoredThread): Promise<void> {
  try {
    const driver = ctx.driverFor(source.modelSelection.instanceId);
    const open = openTurn(await ctx.store.readTurns(source.id)) !== null;
    if (open) {
      for (const task of driver.backgroundTasks?.(source.id) ?? []) {
        if (driver.stopBackgroundTask) await Effect.runPromise(driver.stopBackgroundTask(source.id, task.taskId)).catch(() => undefined);
      }
      return;
    }
    if (driver.stopSession) await Effect.runPromise(driver.stopSession(source.id));
  } catch {
    // Best effort: the continuation is made whether or not the old session could be ended.
  }
}

/**
 * A delegated task that carries on in a new thread stays the parent's task:
 * the continuation gets its own delegation row (so the parent is told when it
 * ends), and the source's row records where the work went (so the source
 * settling by handing off is not reported as the task finishing).
 * Idempotent: a handoff retried after a restart adds no second row.
 */
async function carryDelegation(store: ThreadStore, sourceId: string, destinationId: string): Promise<string | null> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === sourceId && candidate.status === "running");
  if (!row || row.continuedIn !== undefined || rows.some((candidate) => candidate.childThreadId === destinationId)) return null;
  const now = store.nowIso();
  await store.appendDelegation({
    id: randomUUID(),
    parentThreadId: row.parentThreadId,
    childThreadId: destinationId,
    prompt: row.prompt,
    status: "running",
    ...(row.baseBranch !== undefined ? { baseBranch: row.baseBranch } : {}),
    ...(row.notify ? { notify: true } : {}),
    // The continuation is the same task lineage: it inherits who the
    // reviewer shared a model with, but pins its own verdict when it settles.
    ...(row.modelSnapshot ? { modelSnapshot: row.modelSnapshot } : {}),
    continuesTaskId: row.continuesTaskId ?? row.childThreadId,
    createdAt: now,
    updatedAt: now,
  });
  await store.updateDelegation(row.id, { continuedIn: destinationId });
  return row.notify ? row.parentThreadId : null;
}

/**
 * An orchestrator that carries on in a new thread hands over every task it
 * delegated — running, idle, finished, cancelled, and ones that themselves
 * continued: their delegations name the continuation as parent, so
 * `task_send`, `task_ask`, `message_queue`, `task_cancel`, `task_status` and
 * completion notifications from then on resolve against the conversation
 * that is still working. The old thread owns nothing afterwards: every one
 * of those reads as `TASK_NOT_FOUND` there. A task keeps its own provider,
 * model and modes; only the parent link moves, so this grants the new
 * thread no extra access. Research roles stay out: the run owns their
 * traffic, and the lead still reaches them through it.
 *
 * The re-pointing is one atomic file rewrite, so a notification deciding
 * mid-transfer sees every row before or every row after it, never a mixture
 * that would tell the old parent about a task that already reports to the
 * new one. A notification queued and fully delivered just before the
 * transfer still reaches the old thread; the task's next report — and
 * `task_status` on the new parent at any time — cover it.
 */
async function adoptTasks(store: ThreadStore, sourceId: string, destinationId: string): Promise<{ taskId: string; title: string }[]> {
  const rows = (await store.readDelegations().catch(() => [] as StoredDelegation[])).filter(
    (row) => row.parentThreadId === sourceId,
  );
  const moved: { taskId: string; title: string }[] = [];
  const patches: { id: string; patch: { parentThreadId: string } }[] = [];
  for (const row of rows) {
    // A research role's messages go through its run, never through the
    // delegation row: re-pointing it would only list run traffic as the new
    // thread's tasks.
    const child = await store.readThreadRecord(row.childThreadId).catch(() => null);
    if (child?.researchRole !== undefined) continue;
    patches.push({ id: row.id, patch: { parentThreadId: destinationId } });
    moved.push({ taskId: row.childThreadId, title: child?.title ?? row.childThreadId });
  }
  await store.updateDelegations(patches);
  return moved;
}

/** The handoff's note of delegated tasks that moved with it, which now report to the new thread. */
export function runningTasksNote(tasks: readonly { taskId: string; title: string }[]): string {
  if (tasks.length === 0) return "";
  return [
    "",
    "",
    "## Delegated tasks that moved with this thread",
    "These tasks were delegated from the previous thread and now report here; a task-notification arrives as each settles.",
    ...tasks.map((task) => `- "${task.title}" (taskId ${task.taskId})`),
  ].join("\n");
}

/** The delegation that created this thread, with its parent's title, if it is a delegated task. */
async function delegationOf(
  store: ThreadStore,
  threadId: string,
): Promise<{ parentTitle: string; baseBranch: string | null } | null> {
  const rows = await store.readDelegations().catch(() => []);
  const row = [...rows].reverse().find((candidate) => candidate.childThreadId === threadId);
  if (!row) return null;
  const parent = await store.readThreadRecord(row.parentThreadId).catch(() => null);
  return { parentTitle: parent?.title ?? row.parentThreadId, baseBranch: row.baseBranch ?? null };
}

/**
 * The live thread this one continued in, following the continuation chain
 * to its end. Null when the thread never continued, or nothing of the chain
 * is left (a deleted continuation owns nothing, so there is nothing to
 * split with). A continued thread starts no new delegations: they would
 * answer to a dormant thread while its continuation steers beside them.
 */
async function continuedLiveThread(store: ThreadStore, threadId: string): Promise<string | null> {
  let current: string | undefined = threadId;
  let latest: string | null = null;
  for (let hops = 0; current !== undefined && hops < 16; hops += 1) {
    const notes = await store.readActivities(current).catch(() => []);
    const next = notes.findLast((activity) => activity.kind === "thread.continued" && typeof activity.payload?.threadId === "string")?.payload?.threadId as string | undefined;
    if (next === undefined) break;
    latest = next;
    current = (await store.readThreadRecord(next).catch(() => null)) === null ? undefined : next;
  }
  return latest !== null && current !== undefined ? latest : null;
}

async function projectById(storeRoot: string, projectId: string): Promise<StoredProject | null> {
  return (await listStoredProjects(storeRoot)).find((candidate) => candidate.id === projectId) ?? null;
}

/** What one thread is offered from Moxen's own tools, for routing the directory's shared `moxen` entry to the session that made each call. */
export interface MoxenSessionRouting {
  readonly threadId: string;
  /** No delegation tools: a delegated task, a research run, or orchestration switched off. */
  readonly delegated: boolean;
  readonly webFetch: boolean;
  readonly memory: "write" | "read" | "off";
  readonly checklist: boolean;
}

/**
 * The gating one thread's calls run under: the same shape its session
 * started with (`sessionSetup`). Null when the thread is gone — the call
 * must then fail safe, never land on another thread.
 */
export async function moxenRoutingFor(ctx: OperationContext, threadId: string): Promise<MoxenSessionRouting | null> {
  const thread = await ctx.store.readThreadRecord(threadId);
  if (!thread) return null;
  const delegation = await delegationOf(ctx.store, thread.id);
  const kind = driverKindOfInstance(thread.modelSelection.instanceId);
  const providerConfig = kind === null ? undefined : ctx.config.providers?.[kind];
  const reach = moxenToolsOf(providerConfig);
  const project = await projectById(ctx.storeRoot, thread.projectId);
  const workspaceRoot = project?.workspaceRoot ?? (thread.env.path.trim() || null);
  const memoryOn = ctx.config.memory !== false && providerConfig?.memory !== false && (await projectMemorySetting(workspaceRoot)) !== false;
  return {
    threadId,
    delegated: delegation !== null || isResearchRunActive(thread.researchRun) || !reach.orchestration,
    webFetch: reach.webFetch,
    memory: !memoryOn ? "off" : delegation !== null ? "read" : "write",
    checklist: providerConfig?.todos !== false,
  };
}

function requireThreadId(value: string): string {
  const threadId = value.trim();
  if (!threadId) {
    throw new CliError("THREAD_ID_REQUIRED", "A non-empty thread id is required.", { exitCode: 2 });
  }
  return threadId;
}

// -- turns --------------------------------------------------------------------

export interface StartTurnInput extends SendTurnInput {
  readonly threadId: string;
  /** What the driver is sent, when it differs from the recorded prompt (attachment mentions). */
  readonly driverPrompt?: string;
  readonly onEvent?: (event: ProviderRuntimeEvent) => void;
}

export interface StartedTurn extends SendTurnResult {
  /**
   * The provider run, when this send opened a fresh turn. Null for a
   * queued turn (the runner of the turn ahead of it starts it once it is
   * promoted) and for a steer/inject, which lands on the turn already
   * running rather than starting a second provider run against it.
   */
  readonly run: Promise<void> | null;
  /**
   * For a steer/inject: whether the steer was handed to the running provider
   * turn. A handoff, not an arrival: the provider confirms arrivals
   * separately, and whatever settles unconfirmed goes out again as a queued
   * turn of its own. False when it could not even be handed over — the
   * provider has no mid-turn input, or the turn runs in another process —
   * and the message is only recorded. Absent for other deliveries.
   */
  readonly steerDelivered?: boolean;
}

/**
 * Record a turn and, when it opens a fresh one, run it.
 *
 * The four entry points that used to do this each had their own copy, and
 * two of their bugs came from that: a steer or inject started a *second*
 * provider run against the turn already running (whose settle could then
 * complete or fail the original), and a failed session start left the
 * turn `running` with nothing to ever settle it.
 */
export async function startTurn(ctx: OperationContext, input: StartTurnInput): Promise<StartedTurn> {
  const { store } = ctx;
  // A dead process's turn must not swallow this send as a steer.
  await recoverOrphanedTurn(ctx, input.threadId);
  await syncResearchRun(ctx, input.threadId);
  const thread = await inspectThread(store, input.threadId);
  // Resolved before the ledger is touched: an unknown provider fails
  // without recording a turn.
  const turnSelection = input.modelSelection ?? thread.modelSelection;
  const driver = ctx.driverFor(turnSelection.instanceId);
  const { threadId: _threadId, driverPrompt, onEvent, ...send } = input;
  const resolvedQueue = input.queue ? resolveQueueResetConditions(input.queue, turnSelection) : undefined;
  const automaticQueue = input.scheduleReason === "usage-reset" ? { ...(resolvedQueue ?? parseQueuePolicy({ conditions: [], sequential: ctx.config.usageRecovery === "sequential" })), automatic: true } : resolvedQueue;
  const sent = await sendTurn(store, thread.id, { ...send, ...(automaticQueue ? { queue: automaticQueue } : {}) }, ctx.config);
  const uploads = input.attachments ?? [];
  if (sent.delivery === "steered" || sent.delivery === "injected") {
    // Drivers that cannot take images mid-turn still get them named in the text.
    const text = imageMention(input.driverPrompt ?? input.prompt.trim(), uploads.map((upload) => upload.name));
    return { ...sent, run: null, steerDelivered: await deliverSteer(driver, thread.id, text, providerImages(uploads), sent.messageId) };
  }
  if (sent.turn.status === "queued" && typeof sent.turn.scheduledFor === "string") {
    armScheduledTurn(thread.id, sent.turn.id, sent.turn.scheduledFor);
  }
  const fresh = (sent.delivery === "started" || sent.delivery === "restarted") && sent.turn.status === "running";
  if (!fresh) {
    // A send that queued behind an older held turn: start the older now when
    // it is admissible, so it goes first without waiting for the next tick.
    // Anything still blocked simply stays queued.
    // This keeps a full scan on purpose: the held turn's provider and usage
    // conditions read global state (other threads' holds and windows), which
    // a single-thread snapshot cannot see and would misreport as blocking.
    // The repeating poll paths (shell poll, schedule timer, agent message,
    // queue read) share the usage tick's maintained snapshot instead.
    if (sent.turn.status === "queued" && sent.turn.heldAtSettle === true && sent.delivery === "queued" && !input.queue && input.scheduledFor === undefined) {
      await runDueScheduledTurn(ctx, thread.id).catch(() => undefined);
    }
    return { ...sent, run: null };
  }
  // The turn is live in this process from here until `executeTurn` takes it:
  // a stop landing while the session starts still promotes the turn queued
  // behind it, and this claim is what tells that stop a runner is coming.
  // Every exit below either hands the turn to `executeTurn` (which replaces
  // the claim with its abort) or releases it.
  const claimed = store.claimRun(sent.turn.id);

  const turnModel = sent.turn.modelSelection ?? sent.thread.modelSelection;
  // The turn's own mode: a one-off (`/research`) differs from the thread's, which stays as it was.
  const turnThread: StoredThread = { ...sent.thread, modelSelection: turnModel, interactionMode: sent.turn.interactionMode };
  // Whether this send opened the session: a turn stopped while it started
  // leaves a session nobody will use, so it is closed again below.
  const hadSession = await Effect.runPromise(driver.hasSession(thread.id)).catch(() => false);
  let setup: Awaited<ReturnType<typeof sessionSetup>> | null = null;
  let startFailure: unknown = null;
  try {
    setup = await sessionSetup(ctx, turnThread, turnModel.instanceId);
    await ensureDriverSession(driver, turnThread, { modelSelection: turnModel, config: ctx.config, ...sessionStart(setup), ...longThreadHook(ctx, sent.thread.id), ...usageLimitHook(ctx, sent.thread.id, turnModel.instanceId) });
  } catch (cause) {
    startFailure = cause;
  }
  if (startFailure !== null || setup === null) {
    // Nothing will ever run this turn: settle it now, with the reason,
    // rather than leaving it `running` for the next send to trip over.
    const message = startFailure instanceof Error ? startFailure.message : String(startFailure ?? "no session setup");
    const queuedBefore = new Set((await store.readTurns(thread.id)).filter((turn) => turn.status === "queued").map((turn) => turn.id));
    if (claimed) store.untrackRunning(sent.turn.id);
    await failTurn(store, thread.id, sent.turn.id, { error: message.slice(0, 500) }).catch(() => undefined);
    // The failed start settled nothing that runs: a promotion it made has no
    // runner to take it, so hand those turns back to the admission path.
    await holdStrandedPromotions(store, thread.id, queuedBefore).catch(() => undefined);
    return { ...sent, run: Promise.resolve() };
  }
  // A stop that landed while the session was starting already settled the
  // turn: sending now would orphan a provider run with no store turn.
  const current = (await store.readTurns(thread.id)).find((turn) => turn.id === sent.turn.id);
  if (!current || current.status !== "running") {
    // The session may since have a newer turn on it: only stop a session
    // nobody uses. Checked and stopped under the thread lock, so a send
    // cannot start on it in between; driver stops never take the store
    // lock, so this cannot deadlock.
    const stopSession = !hadSession ? driver.stopSession : undefined;
    if (stopSession) {
      await store.withThreadLock(thread.id, async () => {
        if (openTurn(await store.readTurns(thread.id)) !== null) return;
        await Effect.runPromise(stopSession(thread.id)).catch(() => undefined);
      });
    }
    // The stop may have promoted a queued turn: it has an owner but no
    // runner, and this send never reached `executeTurn` to hand it one.
    // Run it through the same claim path as a settling runner, and wait
    // for the handoff before returning, so the promoted turn is claimed
    // by the time the stop is acknowledged.
    await runPromotedTurn({
      store,
      driver,
      threadId: thread.id,
      storeTurnId: sent.turn.id,
      prompt: "",
      modelSelection: turnModel,
      runtimeMode: sent.thread.runtimeMode,
      interactionMode: sent.turn.interactionMode,
      workingDirectory: sent.thread.env.path,
      ...(onEvent ? { onEvent } : {}),
      ...usageLimitHook(ctx, thread.id, turnModel.instanceId),
      ...longThreadHook(ctx, thread.id),
    });
    if (claimed) store.untrackRunning(sent.turn.id);
    return { ...sent, run: Promise.resolve() };
  }
  const images = providerImages(uploads);
  // MCP servers added, changed or removed in config since the session started: a live session takes them now,
  // not at its next start. A server that will not connect is the provider's to report, never a reason to fail the send.
  await driver.updateMcpServers?.(sent.thread.id, setup.mcpServers).catch(() => undefined);
  await driver.updateNativeTools?.(sent.thread.id, setup.disabledNativeTools, setup.moxenPrompt).catch(() => undefined);
  // Rule files edited while the session lived: a patch ahead of the prompt (Claude; see `rulefiles.ts`).
  const rules: PendingRuleUpdate | null = await pendingRuleUpdate(driver, sent.thread.id, driverKey(turnModel.instanceId), sent.thread.env.path).catch(() => null);
  const delivered = [...deliveredSteps(setup), ...(rules ? [async () => rules.commit()] : [])];
  let run: Promise<void>;
  try {
    run = executeTurn({
      store,
      driver,
      threadId: thread.id,
      storeTurnId: sent.turn.id,
      prompt: withRuleUpdate(promptWithUpdate(await withUsageProtectionContext(ctx, thread, await withUnansweredPrompts(ctx, thread, sent.turn.id, setup, driverPrompt ?? input.prompt.trim())), setup), rules?.text ?? null),
      ...(delivered.length > 0 ? { afterAnswer: async () => void (await Promise.all(delivered.map((step) => step()))) } : {}),
      ...(setup.fresh ? { freshConversation: true } : {}),
      ...(images.length > 0 ? { images } : {}),
      // Always the turn's own model, so a live session switches when the
      // thread's model changed since it started.
      modelSelection: turnModel,
      config: ctx.config,
      runtimeMode: sent.thread.runtimeMode,
      interactionMode: sent.turn.interactionMode,
      workingDirectory: sent.thread.env.path,
      ...(onEvent ? { onEvent } : {}),
      ...usageLimitHook(ctx, thread.id, turnModel.instanceId),
      ...longThreadHook(ctx, thread.id),
    }).then(() => syncResearchRun(ctx, thread.id).catch(() => undefined)).then(() => clearCancelledOnSettle(ctx, thread.id)).catch(() => undefined);
  } catch (cause) {
    // The prompt never reached a runner (a ledger read failed while building
    // it): release the claim rather than leaving the turn tracked forever.
    if (claimed) store.untrackRunning(sent.turn.id);
    throw cause;
  }
  // The user's own message spends fresh allowance and ends a usage hold, so
  // task notices queued while the thread could not receive them go out with
  // it, together — steered into the turn just started when the provider
  // takes mid-turn input, else queued behind it. Internal sends (recovery,
  // notifications, agent messages) never pull other threads' notices along.
  if (input.origin === undefined && !input.usageControl) {
    await flushTaskNotifications(ctx, thread.id).catch(() => undefined);
  }
  return { ...sent, run };
}

function providerImages(uploads: readonly ImageAttachmentUpload[]): ProviderImage[] {
  return uploads.flatMap((upload) => {
    const decoded = decodeDataUrl(upload.dataUrl);
    return decoded ? [{ name: upload.name, mimeType: decoded.mimeType, data: decoded.data }] : [];
  });
}

/**
 * Give the running provider turn the steer, when this process holds its
 * session. Never starts a session: a session opened just for this would be
 * a second, empty conversation, not the one doing the work.
 *
 * True is the push being accepted, not the arrival: the steer carries the
 * ledger message id, and a driver with an arrival signal confirms it later
 * (`takeUnconfirmedSteers`); whatever settles unconfirmed goes out again
 * as a queued turn of its own.
 */
async function deliverSteer(driver: TurnDriver, threadId: string, text: string, images: readonly ProviderImage[], steerId: string): Promise<boolean> {
  if (!driver.steerTurn) return false;
  const live = await Effect.runPromise(driver.hasSession(threadId)).catch(() => false);
  if (!live) return false;
  return await Effect.runPromise(driver.steerTurn(threadId, text, images, steerId)).then(
    () => true,
    () => false,
  );
}

// -- revert -------------------------------------------------------------------------

export interface RevertResult {
  readonly threadId: string;
  readonly keptTurns: number;
  readonly removedTurns: number;
  /** Drivers whose provider-side conversation was rolled back too. */
  readonly providers: readonly string[];
  /**
   * Present only when files were asked back too: how many the restore
   * touched, and the ref holding the worktree as it was just before — the
   * way to undo the restore.
   */
  readonly filesRestored?: { readonly files: number; readonly undoRef: string };
}

export interface RevertOptions {
  /**
   * Put the files back too, to how they were before the first dropped turn
   * (its pre-turn checkpoint) — untracked ones included. Refused, before
   * anything changes, when that checkpoint is unavailable.
   */
  readonly restoreFiles?: boolean;
}

/**
 * Whether a turn reached the provider: a promoted turn records `startedAt`,
 * and a turn that ran at once is not `queued` delivery. A message that never
 * left the queue carries no provider prompts and no checkpoint.
 */
function startedTurn(turn: StoredTurn): boolean {
  return turn.delivery !== "queued" || turn.startedAt !== undefined;
}

/**
 * Revert a thread's conversation so its first `keepTurns` turns remain, in the
 * order they ran (the same numbering `checkpointTurnCount` and `turnDiff` use).
 * Files are left as they are unless `restoreFiles` asks for them too; the
 * checkpoints stay available to diff against either way.
 *
 * The provider has to forget the dropped turns too, or the next turn
 * answers from a history the thread no longer shows. So every provider
 * that saw a dropped turn is rolled back first — by the prompts it
 * received, which a steer makes more than one per turn — and only then is
 * the ledger cut. A provider that cannot roll back would refuse the
 * whole revert before anything changes.
 *
 * A message that never ran is not one of the turns being counted: an
 * interrupted-before-start row is left in the ledger, and a terminal row
 * that never reached the provider contributes no prompts and no file
 * snapshot.
 */
export async function revertThread(
  ctx: OperationContext,
  rawThreadId: string,
  keepTurns: number,
  options: RevertOptions = {},
): Promise<RevertResult> {
  const { store } = ctx;
  const threadId = requireThreadId(rawThreadId);
  if (!Number.isInteger(keepTurns) || keepTurns < 0) {
    throw new CliError("INVALID_THREAD_OPTION", "The number of turns to keep must be a whole number, 0 or more.", {
      exitCode: 2,
      details: { keepTurns },
    });
  }
  const thread = await inspectThread(store, threadId);
  if (thread.archivedAt != null) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${threadId} is archived and cannot be reverted.`, {
      exitCode: 4,
      details: { threadId, archivedAt: thread.archivedAt },
    });
  }
  const busy = (turns: readonly StoredTurn[]) => turns.some((turn) => turn.status === "running" || turn.status === "queued");
  const turns = await store.readTurns(threadId);
  if (busy(turns)) {
    throw new CliError("THREAD_BUSY", `Thread ${threadId} has a turn in progress; revert once it settles.`, {
      exitCode: 4,
      details: { threadId },
    });
  }
  const ran = ranTurns(turns);
  const removed = ran.slice(keepTurns);
  if (removed.length === 0) {
    // The turns that ran are all kept; a queued or cancelled-before-start row
    // is not a turn and stays as it is.
    return { threadId, keptTurns: Math.min(keepTurns, ran.length), removedTurns: 0, providers: [] };
  }

  // What each provider saw of the dropped turns, in prompts.
  const messages = await store.readMessages(threadId);
  const byDriver = new Map<string, { instanceId: string; selection: ModelSelection; prompts: number }>();
  for (const turn of removed) {
    if (!startedTurn(turn)) continue;
    const selection = turn.modelSelection ?? thread.modelSelection;
    const key = driverKey(selection.instanceId);
    const prompts = messages.filter((message) => message.turnId === turn.id && message.role === "user").length || 1;
    const entry = byDriver.get(key) ?? { instanceId: selection.instanceId, selection, prompts: 0 };
    entry.prompts += prompts;
    byDriver.set(key, entry);
  }
  // The files' target: the worktree as it was before the first dropped turn
  // that reached the provider. A never-started row has no snapshot to name.
  const firstStarted = removed.find(startedTurn) ?? null;
  const filesTarget =
    options.restoreFiles === true
      ? ((await store.readCheckpoints(threadId)).find((checkpoint) => checkpoint.turnId === firstStarted?.id && checkpoint.baseRef)?.baseRef ?? null)
      : null;
  // Checked before anything changes, so a revert that cannot restore files
  // leaves the conversation alone too.
  if (options.restoreFiles === true && filesTarget === null) {
    throw new CliError(
      "REVERT_FILES_UNAVAILABLE",
      "There is no snapshot of the files from before that turn (not a git repository, or taken before snapshots existed). Revert the conversation alone.",
      { exitCode: 4, details: { threadId } },
    );
  }

  const rolledBack: string[] = [];
  for (const [key, entry] of byDriver) {
    const driver = ctx.driverFor(entry.instanceId);
    const live = await Effect.runPromise(driver.hasSession(threadId)).catch(() => false);
    // No live session and nothing to resume: no provider remembers these turns.
    if (!live && !thread.providerSessions?.[key]) continue;
    if (!driver.rollbackThread || driver.capabilities?.supportsConversationRollback === false) {
      throw new CliError("REVERT_UNSUPPORTED", `The ${key} driver cannot roll back a conversation.`, {
        exitCode: 4,
        details: { threadId, provider: key },
      });
    }
    await ensureDriverSession(driver, thread, {
      modelSelection: entry.selection,
      config: ctx.config,
      ...sessionStart(await sessionSetup(ctx, thread, entry.instanceId)),
      ...longThreadHook(ctx, threadId),
      ...usageLimitHook(ctx, threadId, entry.instanceId),
    });
    await Effect.runPromise(driver.rollbackThread(threadId, entry.prompts));
    rolledBack.push(key);
    // A rollback can move the resume handle (Claude and OpenCode fork).
    const cursor = driver.resumeCursor?.(threadId) ?? null;
    await store.withThreadLock(threadId, async () => {
      const current = await store.readThreadRecord(threadId);
      if (!current) return;
      const sessions = { ...current.providerSessions };
      if (cursor) sessions[key] = cursor;
      else delete sessions[key];
      // The provider forgot the dropped turns, and an instruction update may have ridden one of them: the model
      // has certainly seen only what the conversation began with, so the next prompt carries any update again.
      const state = current.instructionState?.[key];
      const instructionState = state
        ? { ...current.instructionState, [key]: { ...state, delivered: state.baseline } }
        : current.instructionState;
      // Likewise a mode change: forget what this provider was told, so the next prompt says it again if it still applies.
      const { [key]: _told, ...modeState } = current.modeState ?? {};
      await store.writeThreadRecord({ ...current, providerSessions: sessions, ...(instructionState ? { instructionState } : {}), modeState });
    });
  }

  // Files after the providers: a failed rollback above leaves the files alone.
  let filesRestored: { files: number; undoRef: string } | undefined;
  if (filesTarget !== null) {
    const restored = await restoreWorktreeTo(thread.env.path, filesTarget);
    if (restored === null) {
      throw new CliError("REVERT_FILES_FAILED", "The conversation was rolled back, but its files could not be restored.", {
        exitCode: 1,
        details: { threadId },
      });
    }
    const undoRef = `${CHECKPOINT_REF_NAMESPACE}/${threadId.replace(/[^A-Za-z0-9._-]+/g, "-")}/revert-${Date.now()}`;
    await runProcess("git", ["update-ref", undoRef, restored.before], { cwd: thread.env.path }).catch(() => undefined);
    filesRestored = { files: restored.files, undoRef };
  }

  const dropped = new Set(removed.map((turn) => turn.id));
  const keep = <T extends { turnId?: string | null }>(rows: readonly T[]) =>
    rows.filter((row) => row.turnId == null || !dropped.has(row.turnId));
  await store.withThreadLock(threadId, async () => {
    const latest = await store.readTurns(threadId);
    if (busy(latest)) {
      throw new CliError("THREAD_BUSY", `Thread ${threadId} started a turn during the revert; revert again once it settles.`, {
        exitCode: 4,
        details: { threadId },
      });
    }
    const [activities, checkpoints, currentMessages] = await Promise.all([
      store.readActivities(threadId),
      store.readCheckpoints(threadId),
      store.readMessages(threadId),
    ]);
    await store.rewriteLedger(threadId, "turns", latest.filter((turn) => !dropped.has(turn.id)));
    await store.rewriteLedger(threadId, "messages", keep(currentMessages));
    await store.rewriteLedger(threadId, "activity", keep(activities));
    await store.rewriteLedger(threadId, "checkpoints", keep(checkpoints));
    const record = await store.readThreadRecord(threadId);
    if (record) await store.writeThreadRecord({ ...record, updatedAt: store.nowIso() });
  });
  store.emit(threadId, "reverted");
  return {
    threadId,
    keptTurns: keepTurns,
    removedTurns: removed.length,
    providers: rolledBack,
    ...(filesRestored ? { filesRestored } : {}),
  };
}

/** Resolves true when `run` settles first, false on timeout. */
async function settlesWithin(run: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([run.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// -- reads --------------------------------------------------------------------

export interface ThreadListQuery {
  readonly projectId?: string;
  readonly cwd?: string;
  readonly workspaceMode?: WorkspaceMode;
  readonly status?: ThreadListStatus;
}

export async function listThreadsView(ctx: OperationContext, query: ThreadListQuery = {}) {
  const requestedProjectId = query.projectId?.trim();
  if (query.projectId !== undefined && !requestedProjectId) {
    throw new CliError("PROJECT_ID_REQUIRED", "--project requires a non-empty project id.", { exitCode: 2 });
  }
  if (requestedProjectId && query.cwd) {
    throw new CliError("THREAD_FILTER_CONFLICT", "Use either --project or --cwd, not both.", { exitCode: 2 });
  }
  const projects = (await listStoredProjects(ctx.storeRoot)).filter((candidate) => candidate.deletedAt == null);
  let project: StoredProject | null = null;
  let workspace: WorkspaceResolution | null = null;
  if (requestedProjectId) {
    project = projects.find((candidate) => candidate.id === requestedProjectId) ?? null;
  } else if (query.cwd) {
    workspace = await resolveWorkspace(query.cwd, query.workspaceMode ?? ctx.config.workspaceMode);
    project = projectForWorkspace(projects, workspace.workspaceRoot);
  }
  if ((requestedProjectId || query.cwd) && !project) {
    throw new CliError(
      "PROJECT_NOT_FOUND",
      requestedProjectId
        ? `No active Moxen project exists with id ${requestedProjectId}.`
        : `No Moxen project exists for ${workspace!.workspaceRoot}.`,
      { exitCode: 3 },
    );
  }
  const status = query.status ?? "all";
  const stored = await listThreads(ctx.store, { status, ...(project ? { projectId: project.id } : {}) });
  const threads = await Promise.all(
    stored.map(async (entry) => toThreadEnvelope(entry, await ctx.store.readTurns(entry.id))),
  );
  return {
    filter: { status, projectId: project?.id ?? null, workspaceRoot: workspace?.workspaceRoot ?? null },
    projects,
    threads: threads
      .filter(isVisibleThread)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .map((thread) => ({ ...thread, status: threadListStatus(thread) })),
  };
}

export type ThreadList = Awaited<ReturnType<typeof listThreadsView>>;

export async function inspectThreadView(
  ctx: OperationContext,
  rawThreadId: string,
): Promise<{ project: StoredProject | null; thread: ThreadInspection }> {
  const thread = await threadWithLedger(ctx.store, requireThreadId(rawThreadId));
  return { project: await projectById(ctx.storeRoot, thread.projectId), thread: threadInspectionView(thread) };
}

export async function readThreadView(
  ctx: OperationContext,
  rawThreadId: string,
  options: { readonly lastTurn?: boolean; readonly view?: ThreadReadView } = {},
): Promise<{ project: StoredProject | null; thread: ThreadReading }> {
  const threadId = requireThreadId(rawThreadId);
  const view = normalizeReadView(options.view);
  const thread = await threadWithLedger(ctx.store, threadId);
  return {
    project: await projectById(ctx.storeRoot, thread.projectId),
    thread: threadReadView(thread, { lastTurn: options.lastTurn ?? false, view }),
  };
}

// -- projects -----------------------------------------------------------------

export interface WorkspaceQuery {
  readonly cwd: string;
  readonly workspaceMode?: WorkspaceMode;
}

export async function resolveProjectView(ctx: OperationContext, query: WorkspaceQuery) {
  const workspace = await resolveWorkspace(query.cwd, query.workspaceMode ?? ctx.config.workspaceMode);
  return { workspace, project: await resolveStoredProject(ctx.storeRoot, workspace.workspaceRoot) };
}

/** The `project.create` command a project write corresponds to (envelope compat). */
export type ProjectCommand = NonNullable<Awaited<ReturnType<typeof ensureStoredProject>>["command"]>;

export interface EnsureProjectRequest extends WorkspaceQuery {
  readonly projectPolicy?: ProjectPolicy;
  readonly dryRun?: boolean;
}

export interface EnsuredProject {
  readonly workspace: WorkspaceResolution;
  readonly project: StoredProject;
  readonly created: boolean;
  readonly command: ProjectCommand | null;
}

function previewProject(workspaceRoot: string): { project: StoredProject; command: ProjectCommand } {
  const createdAt = new Date().toISOString();
  const project: StoredProject = {
    id: randomUUID(),
    title: path.basename(workspaceRoot) || "project",
    workspaceRoot,
    defaultModelSelection: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  return {
    project,
    command: {
      type: "project.create" as const,
      commandId: randomUUID(),
      projectId: project.id,
      title: project.title,
      workspaceRoot,
      createWorkspaceRootIfMissing: true as const,
      defaultModelSelection: null,
      createdAt,
    },
  };
}

/**
 * The project for a workspace, created under the `create` policy. A dry
 * run resolves the same way and reports what it would create, without
 * writing; `existing` fails identically either way.
 */
async function ensureProjectFor(
  ctx: OperationContext,
  workspace: WorkspaceResolution,
  policy: ProjectPolicy,
  dryRun: boolean,
): Promise<{ project: StoredProject; created: boolean; command: ProjectCommand | null }> {
  if (!dryRun) {
    const ensured = await ensureStoredProject(ctx.storeRoot, { workspaceRoot: workspace.workspaceRoot, policy });
    return { project: ensured.project, created: ensured.created, command: ensured.command };
  }
  const existing = await resolveStoredProject(ctx.storeRoot, workspace.workspaceRoot);
  if (existing) return { project: existing, created: false, command: null };
  if (policy === "existing") {
    // Throws PROJECT_NOT_FOUND through the same path a real run takes.
    await ensureStoredProject(ctx.storeRoot, { workspaceRoot: workspace.workspaceRoot, policy });
  }
  // Key order is printed by `--json`: project, created, command.
  const preview = previewProject(workspace.workspaceRoot);
  return { project: preview.project, created: true, command: preview.command };
}

export async function ensureProject(ctx: OperationContext, request: EnsureProjectRequest): Promise<EnsuredProject> {
  const workspace = await resolveWorkspace(request.cwd, request.workspaceMode ?? ctx.config.workspaceMode);
  const policy = request.projectPolicy ?? ctx.config.projectPolicy;
  const ensured = await ensureProjectFor(ctx, workspace, policy, request.dryRun === true);
  if (ensured.created && request.dryRun !== true) {
    // The old `createWorkspaceRootIfMissing` contract, honored locally.
    await mkdir(workspace.workspaceRoot, { recursive: true }).catch(() => undefined);
  }
  return { workspace, ...ensured };
}

// -- handover: a new thread with its first turn --------------------------------

export interface WorktreeProvision {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly startFromOrigin: boolean;
}

async function gitOk(cwd: string, args: ReadonlyArray<string>): Promise<boolean> {
  try {
    await runProcess("git", [...args], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** A branch-name slug for a short task name: lowercase words joined by `-`, at most 40 characters. */
export function branchSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length <= 40 ? slug : slug.slice(0, 40).replace(/-[^-]*$/, "") || slug.slice(0, 40).replace(/-+$/, "");
}

/**
 * Provision `moxen/<name>` (`moxen/<thread-short>` without a usable name) off the base branch (or its origin
 * when `startFromOrigin`) under the store worktrees dir. Throws
 * WORKTREE_PROVISION_FAILED with best-effort cleanup; callers create the
 * thread only after this resolves, so failures leave nothing behind.
 */
export async function provisionWorktree(input: {
  projectCwd: string;
  baseBranch: string;
  startFromOrigin: boolean;
  threadId: string;
  storeRoot: string;
  /** A short task name that becomes the branch name. */
  name?: string;
}): Promise<WorktreeProvision> {
  const short =
    (input.name ? branchSlug(input.name) : "") || input.threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "thread";
  // Inside the store root so store cleanup owns the checkout too.
  const dir = path.join(input.storeRoot, "worktrees", input.threadId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const branch = attempt === 0 ? `moxen/${short}` : `moxen/${short}-${attempt + 1}`;
    try {
      let startPoint = input.baseBranch;
      if (input.startFromOrigin) {
        await gitOk(input.projectCwd, ["fetch", "origin", input.baseBranch]);
        if (await gitOk(input.projectCwd, ["rev-parse", "--verify", `origin/${input.baseBranch}`])) {
          startPoint = `origin/${input.baseBranch}`;
        }
      }
      await runProcess("git", ["worktree", "add", "-b", branch, dir, startPoint], { cwd: input.projectCwd });
      return { path: dir, branch, baseBranch: input.baseBranch, startFromOrigin: input.startFromOrigin };
    } catch (cause) {
      await runProcess("git", ["worktree", "remove", "--force", dir], { cwd: input.projectCwd }).catch(() => undefined);
      if (attempt === 2) {
        throw new CliError("WORKTREE_PROVISION_FAILED", `Could not provision a worktree for ${input.baseBranch}.`, {
          cause,
          details: { baseBranch: input.baseBranch, startFromOrigin: input.startFromOrigin },
        });
      }
    }
  }
  throw new CliError("WORKTREE_PROVISION_FAILED", `Could not provision a worktree for ${input.baseBranch}.`, {
    details: { baseBranch: input.baseBranch },
  });
}

/**
 * Free a finished thread's worktree checkout. Build output (`target/`,
 * `node_modules/`, …) is gitignored but lives in every worktree, so they pile
 * up; the branch and its commits stay. No `--force`: git refuses when the
 * checkout has uncommitted or untracked work, and then it is left in place.
 * Returns whether the directory was removed.
 */
export async function removeThreadWorktree(storeRoot: string, thread: StoredThread): Promise<boolean> {
  if (thread.env.mode !== "worktree" || !thread.env.path.trim()) return false;
  const dir = path.resolve(thread.env.path);
  // Only checkouts Moxen provisioned; never a worktree the user pointed a thread at.
  if (path.dirname(dir) !== path.join(path.resolve(storeRoot), "worktrees")) return false;
  try {
    const common = (await runProcess("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir })).stdout.trim();
    await runProcess("git", ["worktree", "remove", dir], { cwd: path.dirname(common) });
    return true;
  } catch {
    return false;
  }
}

/** Reattach the original branch when archive freed its clean checkout. */
export async function restoreThreadWorktree(storeRoot: string, thread: StoredThread): Promise<void> {
  if (thread.env.mode !== "worktree" || existsSync(thread.env.path)) return;
  const dir = path.resolve(thread.env.path);
  const project = await projectById(storeRoot, thread.projectId);
  if (path.dirname(dir) !== path.join(path.resolve(storeRoot), "worktrees") || !thread.env.branch || !project) {
    throw new CliError("THREAD_WORKTREE_MISSING", "The thread's original checkout is missing and could not be restored.");
  }
  await runProcess("git", ["worktree", "add", "--", dir, thread.env.branch], { cwd: project.workspaceRoot });
}

/** Per-project settings file, read from the workspace root. */
export const PROJECT_FILE = `${APP_NAME}.json` as const;

function asEffectiveThreadEnvMode(value: unknown): EffectiveThreadEnvMode | null {
  return value === "local" || value === "worktree" ? value : null;
}

async function projectFileEnvMode(workspaceRoot: string): Promise<EffectiveThreadEnvMode | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(workspaceRoot, PROJECT_FILE), "utf8")) as Record<string, unknown>;
    return asEffectiveThreadEnvMode(raw.defaultThreadEnvMode);
  } catch {
    return null;
  }
}

function firstLineTitle(prompt: string, fallback: string): string {
  const title = prompt.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, " ").trim() || fallback;
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

export interface HandoverRequest extends WorkspaceQuery, ModelRequest {
  readonly prompt: string;
  readonly projectPolicy?: ProjectPolicy;
  readonly threadEnvMode?: ThreadEnvMode;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
  readonly dryRun?: boolean;
  /** No project: run in a fresh directory of its own (`core/projects/scratch.ts`); `cwd` is ignored. */
  readonly scratch?: boolean;
}

export interface HandoverSettings {
  readonly defaultThreadEnvMode: EffectiveThreadEnvMode;
  readonly newWorktreesStartFromOrigin: true;
  readonly projectDefaultThreadEnvMode: EffectiveThreadEnvMode | null;
  readonly projectFileDefaultThreadEnvMode: EffectiveThreadEnvMode | null;
  readonly effectiveThreadEnvMode: EffectiveThreadEnvMode;
  readonly threadEnvModeSource: "request" | "project" | typeof PROJECT_FILE | "global";
}

export interface Handover {
  readonly workspace: WorkspaceResolution;
  readonly settings: HandoverSettings;
  readonly project: StoredProject;
  readonly projectCreated: boolean;
  readonly projectCommand: ProjectCommand | null;
  readonly threadId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly branch: string | null;
  /** Provisioned worktree; on a dry run only the plan (no path or branch yet). */
  readonly worktree:
    | WorktreeProvision
    | { readonly path: null; readonly branch: null; readonly baseBranch: string | null; readonly startFromOrigin: true }
    | null;
  /** The first turn; absent on a dry run. */
  readonly started: StartedTurn | null;
}

/**
 * Hand a prompt to a new thread: resolve the workspace to a project
 * (under the project policy), pick local vs worktree (request → project →
 * `moxen.json` → global config), resolve the model from config and flags,
 * provision the worktree, then create the thread and start its first turn
 * — unwinding the thread and worktree if that turn cannot be recorded.
 */
export async function handover(ctx: OperationContext, request: HandoverRequest): Promise<Handover> {
  const prompt = request.prompt.trim();
  if (!prompt) throw new CliError("PROMPT_REQUIRED", "A non-empty handover prompt is required.");
  const { config } = ctx;
  const dryRun = request.dryRun === true;
  const scratch = request.scratch === true;
  const threadId = randomUUID();
  const scratchDir = scratchDirFor(ctx.storeRoot, threadId);
  const workspace: WorkspaceResolution = scratch
    ? { inputPath: scratchDir, workspaceRoot: scratchDir, mode: "folder", isGitRepository: false, branch: null }
    : await resolveWorkspace(request.cwd, request.workspaceMode ?? config.workspaceMode);
  const fileMode = scratch ? null : await projectFileEnvMode(workspace.workspaceRoot);
  const ensured: { project: StoredProject; created: boolean; command: ProjectCommand | null } = scratch
    ? {
        project: dryRun
          ? ((await resolveStoredProject(ctx.storeRoot, scratchRoot(ctx.storeRoot))) ??
            previewProject(scratchRoot(ctx.storeRoot)).project)
          : await ensureScratchProject(ctx.storeRoot),
        created: false,
        command: null,
      }
    : await ensureProjectFor(ctx, workspace, request.projectPolicy ?? config.projectPolicy, dryRun);
  const { project } = ensured;

  const globalDefault: EffectiveThreadEnvMode =
    scratch || config.threadEnvMode === "auto" ? "local" : config.threadEnvMode;
  const projectMode = asEffectiveThreadEnvMode(project.defaultThreadEnvMode);
  const requestMode =
    request.threadEnvMode !== undefined && request.threadEnvMode !== "auto" ? request.threadEnvMode : undefined;
  const envResolution =
    requestMode !== undefined
      ? { mode: requestMode, source: "request" as const }
      : projectMode
        ? { mode: projectMode, source: "project" as const }
        : fileMode
          ? { mode: fileMode, source: PROJECT_FILE }
          : { mode: globalDefault, source: "global" as const };
  const envMode = envResolution.mode;
  if (envMode === "worktree" && (!workspace.isGitRepository || workspace.branch === null)) {
    throw new CliError(
      "WORKTREE_REQUIRES_BRANCH",
      "A new worktree requires a Git repository with a current branch. Use --checkout current for this handover.",
      { details: { isGitRepository: workspace.isGitRepository, currentBranch: workspace.branch } },
    );
  }
  const settings: HandoverSettings = {
    defaultThreadEnvMode: globalDefault,
    newWorktreesStartFromOrigin: true,
    projectDefaultThreadEnvMode: projectMode,
    projectFileDefaultThreadEnvMode: fileMode,
    effectiveThreadEnvMode: envMode,
    threadEnvModeSource: envResolution.source,
  };

  const modelSelection = resolveModelSelection(project.defaultModelSelection, config, {
    prompt,
    ...(request.provider !== undefined ? { provider: request.provider } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.speedMode !== undefined ? { speedMode: request.speedMode } : {}),
    ...(request.thinkingEffort !== undefined ? { thinkingEffort: request.thinkingEffort } : {}),
  });
  const title = firstLineTitle(prompt, "New thread");
  const runtimeMode = request.runtimeMode ?? defaultRuntimeMode(config, modelSelection.instanceId);
  const interactionMode = request.interactionMode ?? config.interactionMode;
  const plan = {
    workspace,
    settings,
    project,
    projectCreated: ensured.created,
    projectCommand: ensured.command,
    threadId,
    title,
    modelSelection,
    runtimeMode,
    interactionMode,
  };
  if (dryRun) {
    return {
      ...plan,
      branch: workspace.branch,
      worktree:
        envMode === "worktree"
          ? { path: null, branch: null, baseBranch: workspace.branch, startFromOrigin: true as const }
          : null,
      started: null,
    };
  }

  const worktree =
    envMode === "worktree"
      ? await provisionWorktree({
          projectCwd: workspace.workspaceRoot,
          baseBranch: workspace.branch!,
          startFromOrigin: true,
          threadId,
          storeRoot: ctx.storeRoot,
          // "New thread" is only the title's fallback: no name to give the branch.
          ...(prompt.trim() ? { name: title } : {}),
        })
      : null;
  const removeWorktree = async (): Promise<void> => {
    if (worktree) {
      await runProcess("git", ["worktree", "remove", "--force", worktree.path], { cwd: workspace.workspaceRoot }).catch(
        () => undefined,
      );
    }
  };
  try {
    // Resolved before writing: an unknown provider fails clean.
    ctx.driverFor(modelSelection.instanceId);
  } catch (cause) {
    await removeWorktree();
    throw cause;
  }
  if (scratch) await createScratchDir(ctx.storeRoot, threadId);
  const created = await createThread(ctx.store, {
    id: threadId,
    projectId: project.id,
    title,
    modelSelection,
    runtimeMode,
    interactionMode,
    env: worktree
      ? { mode: "worktree", path: worktree.path, branch: worktree.branch }
      : { mode: "local", path: workspace.workspaceRoot, branch: workspace.branch },
  });
  let started: StartedTurn;
  try {
    started = await startTurn(ctx, { threadId: created.id, prompt });
  } catch (cause) {
    await deleteThread(ctx.store, created.id).catch(() => undefined);
    await removeWorktree();
    throw new CliError("THREAD_START_FAILED", "Created the thread but could not start its handover prompt.", {
      cause,
      details: { threadId, cleanup: "deleted" },
    });
  }
  return { ...plan, title: created.title, branch: worktree?.branch ?? workspace.branch, worktree, started };
}

// -- delegation ---------------------------------------------------------------

const DELEGATE_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Whether Moxen must hold automatic prompts on this instance: Antigravity
 * with `providers.antigravity.allowUnsupportedUse` off (the default). Google's
 * consumer sign-in covers only prompts the user types themselves, so a
 * delegated task or an automatic turn is refused or held, never started.
 */
function antigravityAutoPromptsHeld(config: CliConfig, instanceId: string): boolean {
  return driverKindOfInstance(instanceId) === "antigravity" && !antigravityUnsupportedUseAllowed(config);
}

/** Refuse starting delegated work on Antigravity while the setting is off, before anything is created. */
function requireAntigravityDelegation(config: CliConfig, instanceId: string): void {
  if (!antigravityAutoPromptsHeld(config, instanceId)) return;
  throw new CliError(
    "ANTIGRAVITY_DELEGATION_OFF",
    "Delegation and automatic prompts are off for Antigravity: Google does not support them on consumer plans and may suspend the account. Turn on providers.antigravity.allowUnsupportedUse to allow them.",
    { exitCode: 4, details: { instanceId, setting: "providers.antigravity.allowUnsupportedUse" } },
  );
}

export interface DelegateRequest extends ModelRequest {
  /** A size explicitly supplied by the user, never copied from a model proposal. */
  readonly research?: ResearchPlan;
  /** A model suggestion: the server must obtain a user answer before spending it. */
  readonly researchProposal?: ResearchPlan;
  readonly parentThreadId: string;
  readonly task: string;
  readonly title?: string;
  /** Block until the child's turn settles (default), up to `timeoutMs`. */
  readonly wait?: boolean;
  readonly timeoutMs?: number;
  readonly dryRun?: boolean;
  /**
   * A client-generated idempotency key: repeating the same delegation with
   * the same key returns the original task instead of starting a duplicate.
   * For a retry after the call's transport died (which cannot double-spend):
   * generate one UUID per new task, and reuse it only when retrying that task.
   */
  readonly idempotencyKey?: string;
  /**
   * `shared` (the default) runs the child in the parent's checkout.
   * `worktree` gives it its own git worktree on a new branch cut from the
   * parent's, so two agents never edit the same files at once.
   */
  readonly isolation?: DelegateIsolation;
  /**
   * For a delegation not waited on: tell the parent thread when the task
   * settles (default). False leaves it to `task_status`.
   */
  readonly notify?: boolean;
  /**
   * Start the task from a copy of the parent's conversation instead of an
   * empty one: same provider, the parent's checkout (`shared`).
   */
  readonly fork?: boolean;
  /**
   * The permission mode the child runs in: one at most the parent's, or the
   * parent's own when omitted. `auto` and `full-access` count as equal, so
   * an Auto parent may delegate a Full-access child that runs with real
   * Full access (intended). Asking for more access is refused
   * (`RUNTIME_MODE_ESCALATION`), never quietly lowered.
   */
  readonly runtimeMode?: RuntimeMode;
  /** The mode the task runs in: Build (the default), Research or Review. Orchestrate is for the one delegating, so it is refused. */
  readonly interactionMode?: InteractionMode;
}

export type DelegateIsolation = "shared" | "worktree";

/**
 * Copy the parent's native session for a forked task: same provider only
 * (a conversation cannot cross providers), on a driver that can fork, from
 * a parent that has a conversation yet.
 */
async function forkParentSession(
  ctx: OperationContext,
  parentThreadId: string,
  childSelection: ModelSelection,
  workingDirectory: string,
): Promise<{ key: string; cursor: string }> {
  const parent = await ctx.store.readThreadRecord(parentThreadId);
  const key = driverKey((parent?.modelSelection ?? childSelection).instanceId);
  if (driverKey(childSelection.instanceId) !== key) {
    throw new CliError("FORK_PROVIDER_MISMATCH", "A forked task runs on its parent's provider: a conversation cannot move between providers.", {
      exitCode: 2,
      details: { threadId: parentThreadId },
    });
  }
  const driver = ctx.driverFor(childSelection.instanceId);
  if (!driver.forkSession) {
    throw new CliError("FORK_UNSUPPORTED", `${childSelection.instanceId} cannot fork a conversation; delegate without fork.`, {
      exitCode: 4,
      details: { threadId: parentThreadId },
    });
  }
  const cursor = driver.resumeCursor?.(parentThreadId) ?? parent?.providerSessions?.[key] ?? null;
  if (!cursor) {
    throw new CliError("FORK_UNAVAILABLE", `Thread ${parentThreadId} has no conversation to fork yet.`, {
      exitCode: 4,
      details: { threadId: parentThreadId },
    });
  }
  return { key, cursor: await driver.forkSession(cursor, workingDirectory, childSelection.instanceId) };
}

// -- task notifications -----------------------------------------------------------

/** Tasks settling within this long of each other reach their parent as one message. */
export const TASK_NOTIFICATION_BATCH_MS = 2_000;

const pendingNotifications = new Map<string, { timer: ReturnType<typeof setTimeout>; entries: PendingTaskNotification[] }>();

/** Pending notification batches beside the thread store, so a server restart inside the batch window loses nothing. */
const TASK_NOTIFICATION_BATCHES_FILE = "task-notification-batches.json";

function taskNotificationBatchesFile(storeRoot: string): string {
  return path.join(storeRoot, TASK_NOTIFICATION_BATCHES_FILE);
}

/**
 * One parent's pending task notice: a settle report, a usage-pause heads-up
 * (with the expected resume time, null when unknown), or a cancelled
 * auto-continue. All three wait the same way when the parent cannot receive
 * them yet, and go out together as one message.
 */
export interface PendingTaskNotification {
  readonly child: string;
  readonly resumesAt?: string | null;
  readonly cancelled?: true;
}

/** Settle entries report; pause entries carry `resumesAt` (possibly null), cancel entries `cancelled`. */
function pendingEntryKind(entry: PendingTaskNotification): "settle" | "pause" | "cancel" {
  return entry.cancelled === true ? "cancel" : entry.resumesAt !== undefined ? "pause" : "settle";
}

/** Union pending entries: one entry per child and kind; a repeat carries the latest facts. */
function unionTaskEntries(
  left: readonly PendingTaskNotification[],
  right: readonly PendingTaskNotification[],
): PendingTaskNotification[] {
  const merged = new Map<string, PendingTaskNotification>();
  for (const entry of [...left, ...right]) merged.set(`${pendingEntryKind(entry)}:${entry.child}`, entry);
  return [...merged.values()];
}

function normalizeTaskEntries(value: unknown): PendingTaskNotification[] | null {
  if (!Array.isArray(value)) return null;
  const entries: PendingTaskNotification[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      if (raw.length > 0) entries.push({ child: raw });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.child !== "string" || record.child.length === 0) return null;
    const entry: PendingTaskNotification = { child: record.child };
    if (record.resumesAt !== undefined) {
      if (record.resumesAt !== null && (typeof record.resumesAt !== "string" || !Number.isFinite(Date.parse(record.resumesAt)))) return null;
      entries.push({ ...entry, resumesAt: record.resumesAt });
      continue;
    }
    if (record.cancelled !== undefined) {
      if (record.cancelled !== true) return null;
      entries.push({ ...entry, cancelled: true });
      continue;
    }
    entries.push(entry);
  }
  return unionTaskEntries(entries, []);
}

async function readTaskNotificationBatches(storeRoot: string): Promise<Record<string, PendingTaskNotification[]>> {
  const file = taskNotificationBatchesFile(storeRoot);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // Missing (or unreadable for now): no batches pending.
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a batch map");
  } catch {
    // Never silently drop every pending batch: move the corrupt file aside
    // and leave a warning where the server's own warnings go.
    await quarantineTaskNotificationBatches(storeRoot, file, text).catch(() => undefined);
    return {};
  }
  const batches: Record<string, PendingTaskNotification[]> = {};
  for (const [parent, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof parent !== "string") continue;
    const normalized = normalizeTaskEntries(entries);
    if (normalized === null || normalized.length === 0) continue;
    batches[parent] = normalized;
  }
  return batches;
}

/** A corrupt batch file is moved aside (never deleted) with a server.log warning, so its batches are visibly dropped, not silently lost. */
async function quarantineTaskNotificationBatches(storeRoot: string, file: string, text: string): Promise<void> {
  const quarantined = `${file}.corrupt-${process.pid}-${Date.now()}`;
  try {
    await renameReplacing(file, quarantined);
  } catch {
    await writeAtomic(quarantined, text);
  }
  const line = `${new Date().toISOString()} task notifications: ${path.basename(file)} was corrupt; moved to ${path.basename(quarantined)} and its pending batches were dropped. The tasks must settle again to be reported.\n`;
  await appendFile(path.join(storeRoot, "server.log"), line, "utf8");
}

/** File writes chain behind each other, so batches queued on different parents cannot drop each other's entries. */
let batchFileChain: Promise<unknown> = Promise.resolve();

async function updateTaskNotificationBatches(storeRoot: string, update: (batches: Record<string, PendingTaskNotification[]>) => void): Promise<void> {
  const run = batchFileChain.then(async () => {
    const batches = await readTaskNotificationBatches(storeRoot);
    update(batches);
    await writeAtomic(taskNotificationBatchesFile(storeRoot), `${JSON.stringify(batches)}\n`);
  });
  batchFileChain = run.catch(() => undefined);
  await run.catch(() => undefined);
}

/** A parent held by usage protection cannot receive a notification yet: it waits with the batch instead. */
function parentNotificationsHeld(parent: StoredThread | null): boolean {
  return !!parent?.usagePause && parent.usagePause.phase !== "resuming";
}

/**
 * A parent that ran out of usage with no hold to wait behind: a notification
 * delivered now would start its own turn into the same wall (or fail there),
 * so it waits too — for the recovery, or for the user's next message.
 */
async function parentMustWaitForUsage(ctx: OperationContext, parent: StoredThread): Promise<boolean> {
  if (parentNotificationsHeld(parent)) return true;
  const turns = await ctx.store.readTurns(parent.id).catch(() => [] as StoredTurn[]);
  const selection = openTurn(turns)?.modelSelection ?? parent.modelSelection;
  // An Antigravity parent with delegation off takes no automatic prompt:
  // the notice waits in the batch for the user's next message (or the
  // setting turning on), exactly as a usage-held parent's does.
  if (antigravityAutoPromptsHeld(ctx.config, selection.instanceId)) return true;
  return providerExhausted(usageKeyForInstance(selection.instanceId), Date.now(), selection.model);
}

/** Deliver a parent's pending notification batch, unless it still cannot receive it. */
export async function flushTaskNotifications(ctx: OperationContext, parentThreadId: string): Promise<void> {
  await ctx.store.withThreadLock(`\0task-notification:${parentThreadId}`, async () => {
    const pending = pendingNotifications.get(parentThreadId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingNotifications.delete(parentThreadId);
    }
    // Delivered before it is forgotten: a crash between the two replays the
    // batch on restart (at-least-once), while forgetting first could lose it
    // with the dying process. The union below keeps one flush to one message.
    let replay: PendingTaskNotification[] = [];
    await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
      replay = batches[parentThreadId] ?? [];
    });
    const entries = unionTaskEntries(pending?.entries ?? [], replay);
    if (entries.length === 0) {
      await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
        delete batches[parentThreadId];
      });
      return;
    }
    // A task whose parent continued in a new thread reports there instead —
    // even when this thread is held: the batches belong to the live
    // conversation now, not the dormant one.
    const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
    const liveParent = (id: string) => rows.find((row) => row.childThreadId === id && row.continuedIn === undefined)?.parentThreadId;
    const moved = entries.filter((entry) => {
      const live = liveParent(entry.child);
      return live !== undefined && live !== parentThreadId;
    });
    for (const entry of moved) await enqueueTaskNotification(ctx, liveParent(entry.child)!, entry);
    const mine = entries.filter((entry) => !moved.includes(entry));
    if (mine.length === 0) {
      await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
        delete batches[parentThreadId];
      });
      return;
    }
    const held = await ctx.store.withThreadLock(parentThreadId, async () => ctx.store.readThreadRecord(parentThreadId));
    if (held !== null) {
      const turns = await ctx.store.readTurns(parentThreadId).catch(() => [] as StoredTurn[]);
      const running = openTurn(turns) !== null;
      const activeSelection = openTurn(turns)?.modelSelection ?? held.modelSelection;
      const spent = providerExhausted(usageKeyForInstance(activeSelection.instanceId), Date.now(), activeSelection.model);
      // An archived or deleted parent can never receive again: drop the
      // batch at once instead of keeping what no flush could deliver.
      const receivable = held.archivedAt == null && held.deletedAt == null;
      // A running turn is the user's own (the flush rides their send): the
      // notice goes out with it. Idle, an Antigravity parent with delegation
      // off keeps the batch for the next message or the setting turning on.
      const antigravityHeld = !running && antigravityAutoPromptsHeld(ctx.config, activeSelection.instanceId);
      if (receivable && (parentNotificationsHeld(held) || antigravityHeld || (!running && spent))) {
        // Still held, or spent with no live turn to steer into: stay durable
        // in the batch file instead of starting a turn into the same wall —
        // startTurn resolves even when the session fails, and the batch would
        // be forgotten. A live running turn still takes the notice by steer;
        // the recovery, the user's next message, and the next restart each
        // flush again, so a settled spent parent waits for activity, not forever.
        await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
          batches[parentThreadId] = mine;
        });
        return;
      }
    }
    await deliverTaskNotifications(ctx, parentThreadId, mine);
    await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
      delete batches[parentThreadId];
    });
  });
}

/**
 * Deliver notification batches a restarted server inherited: tasks that
 * settled inside the batch window before the previous process died. Called
 * once at startup; each batch is forgotten once delivered, so replaying
 * finds nothing left and delivers nothing twice. No need to wait for the
 * first usage tick: the registry loads its persisted pre-restart windows in
 * the constructor, and exhaustion is only ever concluded from recorded
 * windows — an early snapshot yields "not exhausted" only when no data
 * says spent, in which case delivering is correct. A spent parent keeps its
 * batch for the recovery or the next message instead.
 */
export async function recoverTaskNotifications(ctx: OperationContext): Promise<void> {
  const batches = await readTaskNotificationBatches(ctx.storeRoot);
  for (const parentThreadId of Object.keys(batches)) {
    await flushTaskNotifications(ctx, parentThreadId).catch(() => undefined);
  }
}

/** Note a settled task for its parent; the batch goes out once no other task settles for a moment. */
export async function queueTaskNotification(ctx: OperationContext, parentThreadId: string, childThreadId: string): Promise<void> {
  await enqueueTaskNotification(ctx, parentThreadId, { child: childThreadId });
}

/**
 * Tell a parent its task paused for usage instead of settling, with the
 * expected resume time. Still gets the normal report when the task finishes.
 * No-op when the task is not a notifying delegation (nobody waits to hear).
 */
export async function queueTaskPauseNotification(ctx: OperationContext, childThreadId: string, resumesAt: string | null): Promise<void> {
  const parentThreadId = await notifyDelegationParent(ctx, childThreadId);
  if (parentThreadId === null) return;
  await enqueueTaskNotification(ctx, parentThreadId, { child: childThreadId, resumesAt });
}

/** Tell a parent its task's automatic continue was cancelled: no resume will come on its own. */
export async function queueTaskCancelNotification(ctx: OperationContext, childThreadId: string): Promise<void> {
  const parentThreadId = await notifyDelegationParent(ctx, childThreadId);
  if (parentThreadId === null) return;
  await enqueueTaskNotification(ctx, parentThreadId, { child: childThreadId, cancelled: true });
}

/** The live parent a task reports to: its notifying row's parent. Null when nobody should be told. */
async function notifyDelegationParent(ctx: OperationContext, childThreadId: string): Promise<string | null> {
  const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === childThreadId && candidate.continuedIn === undefined);
  return row?.notify === true ? row.parentThreadId : null;
}

/** Batch a task notice for its parent; held or spent parents keep it durably until they can receive it. */
async function enqueueTaskNotification(ctx: OperationContext, parentThreadId: string, entry: PendingTaskNotification): Promise<void> {
  await ctx.store.withThreadLock(`\0task-notification:${parentThreadId}`, async () => {
    // Serialize fact collection too: a later, faster report cannot overtake an
    // earlier one. Registered under the thread lock so protection's flush
    // cannot race a report that read the old, unprotected record.
    const parent = await ctx.store.withThreadLock(parentThreadId, async () => ctx.store.readThreadRecord(parentThreadId));
    if (parent !== null && (await parentMustWaitForUsage(ctx, parent))) {
      // Held or spent: keep it durably in the batch file for the recovery or
      // the user's next message, instead of starting its own turn into the wall.
      await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
        batches[parentThreadId] = unionTaskEntries(batches[parentThreadId] ?? [], [entry]);
      });
      return;
    }
    const pending = pendingNotifications.get(parentThreadId);
    if (pending) clearTimeout(pending.timer);
    const entries = unionTaskEntries(pending?.entries ?? [], [entry]);
    // Persisted before the timer is armed: a restart inside the batch
    // window replays the file, and the replay unions what is on disk.
    await updateTaskNotificationBatches(ctx.storeRoot, (batches) => {
      batches[parentThreadId] = unionTaskEntries(batches[parentThreadId] ?? [], entries);
    });
    const timer = setTimeout(() => void flushTaskNotifications(ctx, parentThreadId).catch(() => undefined), TASK_NOTIFICATION_BATCH_MS);
    timer.unref?.();
    pendingNotifications.set(parentThreadId, { timer, entries });
  });
}

/**
 * A resumed turn of a delegated task ended: tell the parent, if it asked to be
 * told and the task is not simply waiting for another resume.
 */
async function notifyParentOfResumedTask(ctx: OperationContext, childThreadId: string): Promise<void> {
  const delegation = (await ctx.store.readDelegations()).find((row) => row.childThreadId === childThreadId && row.notify === true && row.continuedIn === undefined);
  if (delegation) await queueTaskNotification(ctx, delegation.parentThreadId, childThreadId);
}

/** Whether a task has nothing left to run: no turn running, and none waiting (a usage-limit resume is a queued, scheduled turn). */
async function taskHasSettledForGood(ctx: OperationContext, childThreadId: string): Promise<boolean> {
  const turns = await ctx.store.readTurns(childThreadId).catch(() => [] as StoredTurn[]);
  return !turns.some((turn) => turn.status === "running" || turn.status === "queued");
}

/** A usage pause is not an end: a queued continue or recovery means the task still has work to run. */
function hasQueuedResume(turns: readonly StoredTurn[], recoveryTurnId: string | undefined): boolean {
  return (
    turns.some((turn) => turn.status === "queued" && turn.scheduleReason === "usage-reset") ||
    (recoveryTurnId !== undefined && turns.some((turn) => turn.id === recoveryTurnId && turn.status === "queued"))
  );
}

/** How many of a task's turns have settled: the generation a notification snapshot was taken at. */
async function settledTurnCount(ctx: OperationContext, childThreadId: string): Promise<number> {
  const turns = await ctx.store.readTurns(childThreadId).catch(() => [] as StoredTurn[]);
  return turns.filter((turn) => turn.completedAt !== null).length;
}

/** Past this age, background work a task left running is flagged as probably forgotten. Moxen never stops it. */
const BACKGROUND_FORGOTTEN_AFTER_DEFAULT_MS = 30 * 60_000;

/** Past this age, background work a task left running is flagged as probably forgotten (`backgroundForgottenAfter`). */
export function backgroundForgottenAfterMs(config: CliConfig): number {
  return durationMs(config.backgroundForgottenAfter) ?? BACKGROUND_FORGOTTEN_AFTER_DEFAULT_MS;
}

/** One background task still running on a delegated task's thread. */
export interface TaskBackgroundWork extends BackgroundWorkNote {
  /** How long it had been running when read; null when its start is unknown. */
  readonly ageMs: number | null;
  /** Past `backgroundForgottenAfter`: worth asking about, never stopped. */
  readonly probablyForgotten: boolean;
}

/** The background work a delegated task's thread is still running, if Moxen can tell. */
export interface TaskBackgroundState {
  /** True when Moxen could not check (no live session here, or the provider cannot report it all). */
  readonly unknown: boolean;
  readonly tasks: readonly TaskBackgroundWork[];
}

/**
 * What background work a task's thread is still running. Best-effort and
 * never blocking: no live session in this process (or no driver support)
 * reads as unknown rather than empty, and OpenCode's list is partial — it
 * reports only the background shells and subagents its own server started,
 * so its list never proves nothing is running.
 */
async function taskBackgroundState(
  ctx: OperationContext,
  childThreadId: string,
  modelSelection: ModelSelection | null,
  nowMs: number = Date.now(),
): Promise<TaskBackgroundState> {
  const unknown: TaskBackgroundState = { unknown: true, tasks: [] };
  if (!modelSelection) return unknown;
  let driver: TurnDriver;
  try {
    driver = ctx.driverFor(modelSelection.instanceId);
  } catch {
    return unknown;
  }
  const live = await Effect.runPromise(driver.hasSession(childThreadId)).catch(() => false);
  if (!live) return unknown;
  let summaries: readonly BackgroundTaskSummary[];
  try {
    summaries = driver.backgroundTasks?.(childThreadId) ?? [];
  } catch {
    return unknown;
  }
  const forgottenAfter = backgroundForgottenAfterMs(ctx.config);
  const kind = driverKey(modelSelection.instanceId);
  return {
    unknown: driver.backgroundTasks === undefined || kind === "opencode" || kind === "acp" || kind === "antigravity",
    tasks: summaries.map((task) => {
      const startedAt = task.startedAt ?? null;
      const rawAge = startedAt === null ? null : nowMs - Date.parse(startedAt);
      const ageMs = rawAge === null || !Number.isFinite(rawAge) || rawAge < 0 ? null : rawAge;
      return {
        taskId: task.taskId,
        description: task.description,
        command: task.command ?? null,
        startedAt,
        ageMs,
        probablyForgotten: ageMs !== null && ageMs >= forgottenAfter,
      };
    }),
  };
}

/**
 * A review child's facts for its parent, pinned at settle. The pin lives on
 * the delegation row — the verdict and report of the newest settled turn
 * whose final message carries a `VERDICT` line — so a conversational
 * follow-up turn cannot rewrite the settled verdict, while a follow-up
 * that settles with its own verdict re-pins. The same-model comparison
 * reads the delegation-time snapshot, never the live records. While the
 * task runs, the facts are computed live and nothing is pinned.
 */
async function reviewFactsForTask(
  ctx: OperationContext,
  child: ThreadEnvelope,
  parent: { modelSelection?: { instanceId: string; model: string } } | null,
  row: StoredDelegation | undefined | null,
  task: TaskView,
): Promise<(ReviewFacts & { report: string | null }) | null> {
  if (child.interactionMode !== "review") return null;
  const modelOf = (selection: { instanceId: string; model: string } | undefined | null) =>
    selection ? `${selection.instanceId}/${selection.model}` : null;
  const snapshot = row?.modelSnapshot;
  const childModel = snapshot?.child ?? modelOf(child.modelSelection);
  const parentModel = snapshot?.parent ?? (parent === null ? null : modelOf(parent.modelSelection));
  if (task.status === "running") {
    return { ...reviewFactsOf({ finished: false, interactionMode: "review", report: null, childModel, parentModel })!, report: null };
  }
  const pinned = await settledReviewPin(ctx, child);
  const report = pinned?.report ?? task.summary;
  const facts = reviewFactsOf({ finished: true, interactionMode: "review", report, childModel, parentModel })!;
  const owned = row ?? null;
  if (owned !== null && (owned.review?.verdict !== facts.verdict || owned.review?.report !== report)) {
    await ctx.store.updateDelegation(owned.id, { review: { verdict: facts.verdict, report } }).catch(() => undefined);
  }
  return { ...facts, report };
}

/**
 * The newest settled turn whose final message carries a verdict, newest
 * first. A conversational follow-up settles without one, so the search
 * walks past it to the settled review; a follow-up that is itself a
 * review re-pins with its own verdict. Null when no settled turn carries
 * one — the missing-verdict path then says so visibly.
 */
async function settledReviewPin(
  ctx: OperationContext,
  child: ThreadEnvelope,
): Promise<{ verdict: ReviewVerdict; report: string } | null> {
  const [turns, messages] = await Promise.all([
    ctx.store.readTurns(child.id).catch(() => [] as StoredTurn[]),
    ctx.store.readMessages(child.id).catch(() => [] as StoredMessage[]),
  ]);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.status !== "completed") continue;
    // The completion text lands last, so the first match walking back is
    // the turn's final message rather than a mid-turn progress note.
    const text = [...messages].reverse().find((message) => message.turnId === turn.id && message.role === "assistant" && message.text.trim().length > 0)?.text ?? null;
    const verdict = reviewVerdictOf(text);
    if (verdict !== null && text !== null) return { verdict, report: text };
  }
  return null;
}

/** One task's settled facts: status, time, model, branch, headline, and what it changed. */
export async function taskNotificationOf(ctx: OperationContext, childThreadId: string): Promise<TaskNotification | null> {
  const child = await threadWithLedger(ctx.store, childThreadId).catch(() => null);
  if (!child) return null;
  const record = await ctx.store.readThreadRecord(childThreadId);
  const turns = await ctx.store.readTurns(childThreadId);
  const first = turns[0] ?? null;
  const last = [...turns].reverse().find((turn) => turn.completedAt !== null) ?? null;
  const durationMs =
    first && last?.completedAt ? Math.max(0, Date.parse(last.completedAt) - Date.parse(first.createdAt)) : null;
  // What the task changed: its turns' checkpoints, first base to last head.
  let changes: { files: number; additions: number; deletions: number } | null = null;
  const checkpoints = (await ctx.store.readCheckpoints(childThreadId).catch(() => [])).filter((row) => row.status === "available");
  const base = checkpoints[0]?.baseRef ?? null;
  const head = checkpoints.at(-1)?.ref ?? null;
  if (record && base && head) {
    const stat = await diffCheckpointStat(record.env.path, base, head);
    changes = {
      files: stat.length,
      additions: stat.reduce((sum, row) => sum + row.additions, 0),
      deletions: stat.reduce((sum, row) => sum + row.deletions, 0),
    };
  }
  const task = taskOf(child);
  if (isStoppedBySettle(record, task.status)) return null;
  // A usage pause is not an end: a queued continue or recovery reads running.
  const status = hasQueuedResume(turns, record?.usagePause?.recoveryTurnId) ? ("running" as const) : task.status;
  const background = await taskBackgroundState(ctx, childThreadId, child.modelSelection ?? null);
  // A review task's verdict and findings ride in the notification itself, and a
  // missing verdict (or a reviewer on the parent's own model) is said visibly.
  // The facts are pinned at settle on the delegation row, so a follow-up
  // turn cannot rewrite the settled verdict.
  const rows = child.interactionMode === "review" ? await ctx.store.readDelegations().catch(() => []) : [];
  const row = rows.find((candidate) => candidate.childThreadId === childThreadId && candidate.continuedIn === undefined) ??
    rows.find((candidate) => candidate.childThreadId === childThreadId);
  const parent = row ? await ctx.store.readThreadRecord(row.parentThreadId).catch(() => null) : null;
  const facts = await reviewFactsForTask(ctx, child, parent, row, { ...task, status });
  return {
    taskId: childThreadId,
    title: child.title,
    status,
    durationMs,
    model: child.modelSelection ? `${child.modelSelection.instanceId}/${child.modelSelection.model}` : null,
    branch: record?.env.mode === "worktree" ? record.env.branch : null,
    headline: reportHeadline(task.summary),
    filesChanged: changes?.files ?? null,
    additions: changes?.additions ?? null,
    deletions: changes?.deletions ?? null,
    background: background.tasks.map((work) => ({
      taskId: work.taskId,
      description: work.description,
      command: work.command,
      startedAt: work.startedAt,
    })),
    backgroundUnknown: background.unknown,
    ...(facts === null ? {} : { review: facts }),
  };
}

/**
 * Settling a task stops it on purpose, and the person who settled it knows:
 * telling its parent it "was stopped" would only wake an agent about work that
 * was put away. A task stopped any other way (the stop button, a crash)
 * still reaches the parent, as does one that finished on its own.
 */
export function isStoppedBySettle(child: StoredThread | null, status: TaskNotification["status"]): boolean {
  return status === "interrupted" && child !== null && threadStatus(child) === "settled";
}

/**
 * Send the parent its settled tasks: into its running turn when the
 * provider takes input mid-turn (Claude, OpenCode) and this process
 * holds that session; otherwise as a turn of its own, queued behind any
 * running one. It wakes a settled parent — the work is the parent's own.
 * Pause and cancellation notices ride along in the same message: a pause a
 * settle covers is stale and dropped, and a settle a cancellation covers
 * wins over it, so each child reads once.
 */
async function deliverTaskNotifications(ctx: OperationContext, parentThreadId: string, entries: readonly PendingTaskNotification[]): Promise<void> {
  const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
  // A task whose parent continued in a new thread reports there instead.
  const liveParent = (id: string) => rows.find((row) => row.childThreadId === id && row.continuedIn === undefined)?.parentThreadId;
  for (const entry of entries) {
    const parent = liveParent(entry.child);
    if (parent !== undefined && parent !== parentThreadId) await enqueueTaskNotification(ctx, parent, entry);
  }
  const mine = entries.filter((entry) => (liveParent(entry.child) ?? parentThreadId) === parentThreadId);
  // A task paused by a usage limit has not finished: its parent hears when the resumed run ends instead.
  // One that handed off to a new thread has not finished either: its parent hears from the continuation.
  const movedOn = (id: string) => rows.some((row) => row.childThreadId === id && row.parentThreadId === parentThreadId && row.continuedIn !== undefined);
  const settleIds = mine.filter((entry) => pendingEntryKind(entry) === "settle").map((entry) => entry.child);
  const final = (await Promise.all(settleIds.map(async (id) => (!movedOn(id) && (await taskHasSettledForGood(ctx, id)) ? id : null)))).filter(
    (id): id is string => id !== null,
  );
  const settled = new Set(final);
  // A pause or cancellation a settle report covers is stale: the settle says where the task stands.
  // One whose task handed off is the continuation's to report.
  const pauseIds = mine.filter((entry) => pendingEntryKind(entry) === "pause" && !settled.has(entry.child) && !movedOn(entry.child)).map((entry) => entry.child);
  // A pause batched for a task that has since continued belongs to the live
  // conversation when that conversation is itself held for the reset: report
  // the continuation as paused. Otherwise (no inherited hold, nothing left to
  // resume) dropping stays correct.
  const continuedPauses = (await Promise.all(mine.filter((entry) => pendingEntryKind(entry) === "pause" && movedOn(entry.child)).map(async (entry) => {
    const seen = new Set([entry.child]);
    let next = rows.find((row) => row.childThreadId === entry.child && row.parentThreadId === parentThreadId)?.continuedIn;
    while (next !== undefined && !seen.has(next)) {
      seen.add(next);
      const record = await ctx.store.readThreadRecord(next).catch(() => null);
      if (record?.usagePause?.phase === "waiting") return { ...entry, child: next };
      next = rows.find((row) => row.childThreadId === next && row.parentThreadId === parentThreadId)?.continuedIn;
    }
    return null;
  }))).filter((entry): entry is PendingTaskNotification => entry !== null);
  pauseIds.push(...continuedPauses.map((entry) => entry.child));
  const pauseEntries = [...mine, ...continuedPauses];
  const cancelIds = mine.filter((entry) => pendingEntryKind(entry) === "cancel" && !settled.has(entry.child) && !movedOn(entry.child)).map((entry) => entry.child);
  const continuesTaskId = (id: string) => rows.find((row) => row.childThreadId === id && row.parentThreadId === parentThreadId)?.continuesTaskId;
  // The settle generation each snapshot was taken at: a turn settling between
  // the snapshot and the arming below must still report at once (finding: the
  // gap), rather than arming a watcher that only hears future settles.
  const generations = new Map<string, number>();
  const tasks = (await Promise.all(final.map(async (id) => {
    const since = await settledTurnCount(ctx, id);
    const task = await taskNotificationOf(ctx, id);
    const from = continuesTaskId(id);
    if (task) generations.set(task.taskId, since);
    return task && from ? { ...task, continuedFrom: from } : task;
  }))).filter(
    (task): task is TaskNotification => task !== null,
  );
  const pauseTasks = (await Promise.all(pauseIds.map(async (id): Promise<TaskNotification | null> => {
    const task = await taskNotificationOf(ctx, id);
    if (!task || movedOn(id) || (await taskHasSettledForGood(ctx, id))) return null;
    const resumesAt = pauseEntries.find((entry) => entry.child === id && pendingEntryKind(entry) === "pause")?.resumesAt ?? null;
    return { ...task, status: "running" as const, resumesAt };
  }))).filter(
    (task): task is TaskNotification => task !== null,
  );
  const cancelTasks = (await Promise.all(cancelIds.map(async (id): Promise<TaskNotification | null> => {
    const task = await taskNotificationOf(ctx, id);
    if (!task) return null;
    return { ...task, status: "cancelled" as const, cancelled: true as const };
  }))).filter(
    (task): task is TaskNotification => task !== null,
  );
  const all = [...tasks, ...pauseTasks, ...cancelTasks];
  if (all.length === 0) return;
  // A task that ended its turn with background work still running is not
  // done: when that work ends, the provider wakes the task where it can, and
  // the parent hears again once the task next has nothing left to run. Work
  // that never ends wakes nothing, so it sends nothing further and blocks nothing.
  for (const task of tasks) {
    const row = rows.find(
      (candidate) =>
        candidate.childThreadId === task.taskId &&
        candidate.parentThreadId === parentThreadId &&
        candidate.notify === true &&
        candidate.continuedIn === undefined,
    );
    if (!row) continue;
    const child = await ctx.store.readThreadRecord(task.taskId);
    if (!child || threadStatus(child) === "settled") continue;
    if (task.background.length > 0 || task.backgroundUnknown) {
      notifyWhenTaskSettles(ctx, parentThreadId, task.taskId, true, generations.get(task.taskId) ?? null);
    }
  }
  const parent = await ctx.store.readThreadRecord(parentThreadId);
  if (!parent || parent.archivedAt != null) return;
  if (parent.deletedAt != null) {
    // Dropped, not queued and not thrown: the conversation is gone. One
    // line in the server log; nothing more (MXN-290 review).
    await appendFile(
      path.join(ctx.storeRoot, "server.log"),
      `${new Date().toISOString()} task notification: parent ${parentThreadId} is deleted; dropping ${all.length} task(s)\n`,
      "utf8",
    ).catch(() => undefined);
    return;
  }
  const running = openTurn(await ctx.store.readTurns(parentThreadId))?.status === "running";
  const steerable = running && (await canSteer(ctx, parent));
  await startTurn(ctx, {
    threadId: parentThreadId,
    prompt: taskNotificationText(all),
    origin: "task-notification",
    notification: { tasks: all },
    delivery: steerable ? "steer" : "queue",
    wakeSettled: true,
  });
}

/**
 * Rename a thread, or have its title regenerated. A name is pushed to the
 * provider's own session title too where the provider can take it (best
 * effort: a failed push never fails the rename). Regeneration is the
 * provider's own (Claude's `/rename`, OpenCode's title agent) where it has
 * one, else moxen's seed from the first message; moxen never asks a model
 * for a title itself.
 */
export async function retitleThread(
  ctx: OperationContext,
  threadId: string,
  change: { readonly title: string } | { readonly regenerate: true },
): Promise<void> {
  const thread = await ctx.store.readThreadRecord(threadId);
  if (thread === null) {
    await updateThreadMeta(ctx.store, threadId, "title" in change ? { title: change.title } : { regenerateTitle: true });
    return;
  }
  const driver = ctx.driverFor(thread.modelSelection.instanceId);
  const cursor = thread.providerSessions?.[driverKey(thread.modelSelection.instanceId)] ?? null;
  const cwd = thread.env.path.trim() || process.cwd();
  if ("title" in change) {
    const updated = await updateThreadMeta(ctx.store, threadId, { title: change.title });
    if (cursor !== null) await driver.renameSession?.(cursor, cwd, updated.title).catch(() => undefined);
    return;
  }
  if (cursor !== null && driver.regenerateSessionTitle) {
    const title = await driver.regenerateSessionTitle(cursor, cwd).catch(() => null);
    if (title && (await adoptProviderTitle(ctx.store, threadId, title, { force: true })) !== null) return;
  }
  await updateThreadMeta(ctx.store, threadId, { regenerateTitle: true });
}

/** Whether a steer would reach the parent's live provider turn from this process. */
async function canSteer(ctx: OperationContext, thread: StoredThread): Promise<boolean> {
  const driver = ctx.driverFor(thread.modelSelection.instanceId);
  if (!driver.steerTurn) return false;
  return await Effect.runPromise(driver.hasSession(thread.id)).catch(() => false);
}

export interface TaskView {
  readonly taskId: string;
  readonly childThreadId: string;
  readonly childRunId: string | null;
  readonly status: DelegatedTaskStatus;
  readonly workState: DelegatedTaskWorkState;
  readonly summary: string | null;
}

export interface Delegation {
  readonly project: StoredProject | null;
  readonly parent: ThreadEnvelope;
  /** The child as it stands after the wait; on a dry run, a plan with a fresh id. */
  readonly child: { readonly id: string; readonly projectId: string; readonly title: string };
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: InteractionMode;
  readonly branch: string | null;
  readonly task: TaskView & { readonly waitTimedOut: boolean };
  /** The child's first user message; null on a dry run. */
  readonly messageId: string | null;
  /** The child's own worktree under `isolation: "worktree"`; on a dry run, the plan (no path yet). */
  readonly worktree?: { readonly path: string | null; readonly branch: string | null; readonly baseBranch: string };
}

function delegateTitle(task: string, explicit: string | undefined): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79)}…`;
  return firstLineTitle(task, "Delegated task");
}

function requireParentModes(thread: ThreadEnvelope): { runtimeMode: RuntimeMode; interactionMode: InteractionMode } {
  const { runtimeMode, interactionMode } = thread;
  if (
    !["approval-required", "auto", "auto-accept-edits", "full-access"].includes(runtimeMode ?? "") ||
    interactionMode === undefined
  ) {
    throw new CliError("INVALID_THREAD", `Thread ${thread.id} is missing its runtime or interaction mode.`, {
      details: { threadId: thread.id },
    });
  }
  return { runtimeMode: runtimeMode as RuntimeMode, interactionMode: storedInteractionMode(interactionMode) };
}

function taskOf(child: ThreadEnvelope, taskId = child.id): TaskView {
  const status = delegatedStatusOf(child);
  return {
    taskId,
    childThreadId: child.id,
    childRunId: child.latestTurn?.turnId ?? null,
    status,
    workState: delegatedWorkStateOf(status),
    summary: latestAssistantText(child),
  };
}

/**
 * Run a task in a new child thread of the same project — same env, same
 * modes, the parent's model unless the request overrides it — and by
 * default wait for its turn to settle. The task id is the child thread id.
 *
 * Waiting awaits the run itself; this used to be a 200ms ledger poll.
 */
export async function delegate(ctx: OperationContext, request: DelegateRequest, options: {
  readonly hidden?: boolean;
  readonly fullResearchRun?: boolean;
  readonly researchSize?: ResearchSize;
  readonly researchModels?: ResearchModels;
  readonly researchRole?: ResearchRole;
} = {}): Promise<Delegation> {
  if (request.research) options = {
    ...options, fullResearchRun: true, researchSize: request.research.size,
    ...(request.research.models ? { researchModels: request.research.models } : {}),
  };
  const parentThreadId = requireThreadId(request.parentThreadId);
  if (options.researchRole !== undefined) await requireResearchLead(ctx, parentThreadId);
  else {
    await syncResearchRun(ctx, parentThreadId);
    const parent = await ctx.store.readThreadRecord(parentThreadId);
    if (isResearchRunActive(parent?.researchRun) || parent?.researchRole || await delegationOf(ctx.store, parentThreadId) !== null) {
      throw new CliError("DELEGATION_REFUSED", "A delegated task or research lead cannot delegate again. Use role tools inside a full run.");
    }
  }
  if (options.fullResearchRun && request.interactionMode !== "research") throw new CliError("INVALID_THREAD_OPTION", "A full research run must use Research mode.");
  const size = options.researchSize ?? { researchers: 8, critics: 3 };
  if (options.fullResearchRun && !isValidResearchSize(size)) throw new CliError("INVALID_THREAD_OPTION", RESEARCH_SIZE_MESSAGE);
  const task = request.task.trim();
  if (!task) throw new CliError("PROMPT_REQUIRED", "A non-empty delegated task is required.", { exitCode: 2 });
  const timeoutMs = request.timeoutMs ?? DELEGATE_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError("INVALID_THREAD_OPTION", "--timeout-ms must be a positive integer.", {
      exitCode: 2,
      details: { timeoutMs: request.timeoutMs },
    });
  }
  const title = delegateTitle(task, request.title);
  const parent = await threadWithLedger(ctx.store, parentThreadId);
  if (parent.archivedAt != null) {
    throw new CliError("THREAD_ARCHIVED", `Thread ${parentThreadId} is archived and cannot delegate work.`, {
      exitCode: 4,
      details: { threadId: parentThreadId, archivedAt: parent.archivedAt },
    });
  }
  // A thread that continued in a new one starts no new tasks: the row would
  // answer to a dormant thread while its continuation steers beside it.
  // Research roles start through the run, not through here, so the run's
  // own machinery is exempt.
  if (options.researchRole === undefined) {
    const live = await continuedLiveThread(ctx.store, parentThreadId);
    if (live !== null) {
      throw new CliError("THREAD_CONTINUED", `Thread ${parentThreadId} was continued in ${live}; delegate from ${live} instead.`, {
        exitCode: 4,
        details: { threadId: parentThreadId, continuedIn: live },
      });
    }
  }
  const project = await projectById(ctx.storeRoot, parent.projectId);
  const base = parent.modelSelection ?? project?.defaultModelSelection ?? defaultModelSelection();
  const modelSelection = followUpSelection(base, ctx.config, request, task) ?? base;
  // Refused before anything is created — no thread, no worktree, no fork —
  // on every path that starts a task here: single, batch entry, research
  // role, review and fork alike.
  requireAntigravityDelegation(ctx.config, modelSelection.instanceId);
  const research = options.fullResearchRun ? resolveResearchPlan(modelSelection, ctx.config, {
    size, ...(options.researchModels ? { models: options.researchModels } : {}),
  }) : null;
  const { runtimeMode: parentRuntimeMode } = requireParentModes(parent);
  const runtimeMode = resolveDelegatedRuntimeMode(parentRuntimeMode, request.runtimeMode);
  // A task's mode is the delegating model's choice, Build unless it asks for Research or Review. Orchestrate delegates, and a task never does.
  if (request.interactionMode === "orchestrate") {
    throw new CliError("INVALID_THREAD_OPTION", "A delegated task runs in Build, Research or Review, never Orchestrate: only the thread that delegates orchestrates.", {
      exitCode: 2,
      details: { interactionMode: request.interactionMode },
    });
  }
  const interactionMode: InteractionMode = request.interactionMode ?? "default";
  const parentEnv = (await inspectThread(ctx.store, parentThreadId)).env;
  const isolated = request.isolation === "worktree";
  // When isolated, the branch always comes from the checkout, never the
  // record: the record can name a branch the checkout has left (detached
  // HEAD, or moved to another branch since), or none at all (threads the
  // TUI creates record none).
  const parentBranch = isolated
    ? ((await readStatus(parentEnv.path))?.branch ?? null)
    : parentEnv.branch;
  if (isolated && !parentBranch) {
    throw new CliError(
      "WORKTREE_UNAVAILABLE",
      `Thread ${parentThreadId} is not on a git branch, so its task cannot get its own worktree. Delegate with isolation "shared".`,
      { exitCode: 4, details: { threadId: parentThreadId } },
    );
  }
  const shape = { project, parent, modelSelection, runtimeMode, interactionMode, branch: parentBranch };
  if (request.fork === true && isolated) {
    // A native session belongs to the directory it runs in (Claude keeps its
    // transcripts per project directory, OpenCode per server), so a copy
    // cannot move into a worktree of its own.
    throw new CliError("FORK_NEEDS_SHARED", "A forked task runs in its parent's checkout: delegate it with isolation \"shared\".", {
      exitCode: 2,
      details: { threadId: parentThreadId },
    });
  }

  if (request.dryRun === true) {
    const childThreadId = randomUUID();
    return {
      ...shape,
      ...(isolated ? { worktree: { path: null, branch: null, baseBranch: parentBranch! } } : {}),
      child: { id: childThreadId, projectId: parent.projectId, title },
      task: {
        taskId: childThreadId,
        childThreadId,
        childRunId: null,
        status: "running",
        workState: "working",
        summary: null,
        waitTimedOut: false,
      },
      messageId: null,
    };
  }

  // An idempotent retry's answer: the original task as it stands now, without
  // starting anything new. The first attempt's reply carried the child's
  // first message; a retry only needs where the task stands. The stored
  // child's mode wins over a retry's requested one: a retry naming a
  // different allowed mode still describes the original task.
  const describeDelegation = async (childId: string, row: StoredDelegation): Promise<Delegation> => {
    const existing = await threadWithLedger(ctx.store, childId);
    const status = delegatedStatusOf(existing);
    return {
      ...shape,
      runtimeMode: existing.runtimeMode ?? shape.runtimeMode,
      child: { id: existing.id, projectId: existing.projectId, title: existing.title },
      task: { ...taskOf(existing), waitTimedOut: status === "running" },
      messageId: null,
      ...(existing.worktreePath && row.baseBranch
        ? { worktree: { path: existing.worktreePath, branch: existing.branch ?? null, baseBranch: row.baseBranch } }
        : {}),
    };
  };

  const idempotencyKey = request.idempotencyKey?.trim() || undefined;
  if (idempotencyKey !== undefined) {
    const rows = await ctx.store.readDelegations();
    // The caller's own lineage, as in `ownedDelegation`: a continuation
    // retries under its own name, but never into another home.
    const lineage = await threadLineage(ctx, parentThreadId);
    const initial = [...rows].reverse().find(
      (row) => lineage.has(row.parentThreadId) && row.idempotencyKey === idempotencyKey,
    );
    if (initial) {
      // A retry after the task handed off finds the original row (which now
      // carries `continuedIn`) and follows it to the current incarnation,
      // whose continuation row holds no key (MXN-290).
      let row = initial;
      let current = true;
      for (let hops = 0; row.continuedIn !== undefined && hops < 16; hops += 1) {
        const next = rows.find((candidate) => lineage.has(candidate.parentThreadId) && candidate.childThreadId === row.continuedIn);
        if (!next) {
          current = false;
          break;
        }
        row = next;
      }
      // A broken chain, the hop cap, or a gone child falls through to a
      // fresh delegate rather than returning a superseded row.
      if (current && row.continuedIn === undefined && (await ctx.store.readThreadRecord(row.childThreadId))) {
        return await describeDelegation(row.childThreadId, row);
      }
    }
  }

  // A fork starts from a copy of the parent's own conversation, made before
  // anything is created so a provider that cannot fork leaves nothing behind.
  const forked = request.fork === true ? await forkParentSession(ctx, parentThreadId, modelSelection, parentEnv.path) : null;

  const childThreadId = randomUUID();
  // Cut from the parent's branch as the parent's checkout has it — not from
  // origin: the task builds on what the parent has committed so far.
  const worktree = isolated
    ? await provisionWorktree({
        projectCwd: parentEnv.path,
        baseBranch: parentBranch!,
        startFromOrigin: false,
        threadId: childThreadId,
        storeRoot: ctx.storeRoot,
        ...(request.title?.trim() ? { name: request.title } : {}),
      })
    : null;
  let created: StoredThread;
  const now = ctx.store.nowIso();
  const recordDelegation = async (): Promise<void> => {
    const modelOf = (selection: { instanceId: string; model: string } | undefined) =>
      selection ? `${selection.instanceId}/${selection.model}` : null;
    const parentModel = modelOf(parent.modelSelection);
    const childModel = modelOf(modelSelection);
    await ctx.store.appendDelegation({
      id: randomUUID(), parentThreadId, childThreadId, prompt: task, status: "running",
      ...(worktree ? { baseBranch: worktree.baseBranch } : {}),
      ...(request.wait === false && request.notify !== false ? { notify: true } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      // Both sides' models as they stand now: the review same-model check
      // reads this snapshot, never the live records.
      ...(parentModel !== null && childModel !== null ? { modelSnapshot: { parent: parentModel, child: childModel } } : {}),
      createdAt: now, updatedAt: now,
    }).catch((cause: unknown) => {
      if (options.fullResearchRun || options.researchRole !== undefined) throw cause;
    });
  };
  const createChild = async (): Promise<StoredThread> => {
    const lead = options.researchRole === undefined ? null : await requireResearchLead(ctx, parentThreadId);
    if (lead) await checkResearchStart(lead.researchRun, options.researchRole!);
    // In the record's first write: a shell poll can rewrite a new thread from what it read, so a second write could be lost.
    const child = await createThread(ctx.store, {
      id: childThreadId,
      ...(options.hidden === true ? { hidden: true } : {}),
      projectId: parent.projectId,
      title,
      ...(request.title?.trim() ? { titleSource: "user" as const } : {}),
      modelSelection,
      runtimeMode,
      interactionMode,
      env: worktree ? { mode: "worktree", path: worktree.path, branch: worktree.branch } : { ...parentEnv },
      ...(research ? { researchRun: {
        leadThreadId: childThreadId, ...research, messages: [], roles: [], state: "running" as const, createdAt: now, updatedAt: now,
      } } : {}),
      ...(options.researchRole === undefined ? {} : { researchRole: { leadThreadId: parentThreadId, role: options.researchRole } }),
    });
    if (lead) {
      // Publish membership only once clients can describe this delegated task.
      await recordDelegation();
      const run = lead.researchRun;
      await ctx.store.writeThreadRecord({ ...lead, researchRun: { ...run,
        roles: [...run.roles, { threadId: child.id, role: options.researchRole!, question: task }],
        messages: [...(run.messages ?? []), { id: randomUUID(), threadId: child.id, kind: "handoff", text: task, findings: findingsOf(run), createdAt: now }], updatedAt: now,
      } });
      ctx.store.emit(parentThreadId, "research-role-started");
    }
    return child;
  };
  try {
    created = options.researchRole === undefined ? await createChild() : await ctx.store.withThreadLock(parentThreadId, createChild);
  } catch (cause) {
    if (worktree) {
      await runProcess("git", ["worktree", "remove", "--force", worktree.path], { cwd: parentEnv.path }).catch(() => undefined);
    }
    throw cause;
  }
  if (forked !== null) {
    // The child's session resumes the copy instead of starting empty.
    created = { ...created, providerSessions: { ...created.providerSessions, [forked.key]: forked.cursor } };
    await ctx.store.writeThreadRecord(created);
  }
  // Recorded before the child's session starts: that start reads it to tell
  // the child it is a delegated task (`core/threads/instructions.ts`).
  if (options.researchRole === undefined) await recordDelegation();
  const started = await startTurn(ctx, { threadId: created.id, prompt: task }).catch((cause: unknown) => {
    throw new CliError(
      "THREAD_START_FAILED",
      `Created delegated thread ${created.id} but could not start its task turn. The child thread was left untouched.`,
      { cause, details: { threadId: created.id } },
    );
  });

  // A shared child runs on the parent's OpenCode server, whose single `moxen`
  // entry stays the parent's: the child's session start never replaces it,
  // and each call is routed per call by the session id OpenCode sends in
  // `CallToolRequest.params._meta` instead.

  // A delegation nobody waits on reports back by itself once the task
  // settles: the parent gets a message instead of having to poll for it.
  if (request.wait === false && request.notify !== false && started.run !== null) {
    void started.run.then(() => queueTaskNotification(ctx, parentThreadId, created.id)).catch(() => undefined);
  }

  let waitTimedOut = false;
  if (request.wait ?? true) {
    waitTimedOut = started.run === null ? true : !(await settlesWithin(started.run, timeoutMs));
  }
  const child = await threadWithLedger(ctx.store, created.id);
  if (!waitTimedOut && (request.wait ?? true) && delegatedStatusOf(child) === "running") waitTimedOut = true;
  return {
    ...shape,
    child: { id: child.id, projectId: child.projectId, title: child.title },
    task: { ...taskOf(child), waitTimedOut },
    messageId: started.messageId,
    ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch, baseBranch: worktree.baseBranch } } : {}),
  };
}

/** Delegated leads retain their task lifecycle; user-thread runs explicitly end. */
export function isResearchRunActive(run: StoredResearchRun | null | undefined): boolean {
  return run !== undefined && run !== null && run.endedAt === undefined;
}

export async function requireResearchLead(ctx: OperationContext, threadId: string): Promise<StoredThread & { readonly researchRun: StoredResearchRun }> {
  const thread = await ctx.store.readThreadRecord(requireThreadId(threadId));
  if (!thread?.researchRun || !isResearchRunActive(thread.researchRun) || thread.researchRun.leadThreadId !== threadId || thread.researchRole) {
    throw new CliError("RESEARCH_LEAD_REQUIRED", "Only the lead of a full research run may use role tools.");
  }
  return { ...thread, researchRun: thread.researchRun };
}

/** Freeze defaults before approval/start so a lead cannot silently change role models. */
export function resolveResearchPlan(base: ModelSelection, config: CliConfig, plan: ResearchPlan): ResearchPlan {
  const models = Object.fromEntries((["researcher", "critic", "finalizer"] as const).map((role) => {
    const model = followUpSelection(base, config, plan.models?.[role], "") ?? base;
    const effort = model.options?.find((option) => option.id === "effort")?.value;
    const fastMode = model.options?.find((option) => option.id === "fastMode")?.value;
    return [role, {
      provider: model.instanceId, model: model.model,
      ...(effort === undefined ? {} : { thinkingEffort: String(effort) }),
      ...(typeof fastMode === "boolean" ? { speedMode: fastMode ? "fast" : "standard" } : {}),
    }];
  }));
  return { size: plan.size, models };
}

/** The user's own conversation can lead a run without becoming a delegated task. */
export async function beginResearchRun(ctx: OperationContext, threadId: string, plan: ResearchPlan): Promise<void> {
  await ctx.store.withThreadLock(threadId, async () => {
    const thread = await ctx.store.readThreadRecord(requireThreadId(threadId));
    if (!thread || thread.researchRole || await delegationOf(ctx.store, threadId)) {
      throw new CliError("RESEARCH_LEAD_REQUIRED", "Only a user's own thread can begin a research run here.");
    }
    if (isResearchRunActive(thread.researchRun)) throw new CliError("RESEARCH_RUN_EXISTS", "This thread already leads a research run.");
    if (thread.archivedAt || (await ctx.store.readTurns(threadId)).some((turn) => turn.status === "running" || turn.status === "queued")) {
      throw new CliError("THREAD_BUSY", "Start a research run in an unarchived thread with no pending turn.");
    }
    const approved = resolveResearchPlan(thread.modelSelection, ctx.config, plan);
    const now = ctx.store.nowIso();
    await ctx.store.writeThreadRecord({ ...thread,
      ...(thread.researchRun ? { pastResearchRuns: [...(thread.pastResearchRuns ?? []), thread.researchRun] } : {}),
      researchRun: {
      leadThreadId: threadId, ...approved, messages: [], roles: [], state: "running", createdAt: now, updatedAt: now,
      startedAfterTurnId: (await ctx.store.readTurns(threadId)).at(-1)?.id ?? null,
    } });
    ctx.store.emit(threadId, "research-run-started");
  });
}

async function syncResearchRun(ctx: OperationContext, threadId: string): Promise<void> {
  const record = await ctx.store.readThreadRecord(threadId);
  if (record?.researchRole) return await syncResearchRun(ctx, record.researchRole.leadThreadId);
  if (!record?.researchRun) return;
  await ctx.store.withThreadLock(threadId, async () => {
    const thread = await ctx.store.readThreadRecord(threadId);
    if (!thread?.researchRun || !isResearchRunActive(thread.researchRun)) return;
    const own = await delegationOf(ctx.store, threadId) === null;
    const turns = await ctx.store.readTurns(threadId);
    if (own && (thread.researchRun.startedAfterTurnId !== undefined
      ? (turns.at(-1)?.id ?? null) === thread.researchRun.startedAfterTurnId
      : !turns.some((turn) => turn.createdAt >= thread.researchRun!.createdAt))) return;
    const task = taskOf(await threadWithLedger(ctx.store, threadId));
    const settled = await taskHasSettledForGood(ctx, threadId) && (!own ||
      (await Promise.all(thread.researchRun.roles.map((role) => taskHasSettledForGood(ctx, role.threadId)))).every(Boolean));
    // A run's own states predate task cancellation: a cancelled lead reads interrupted here.
    const state = settled ? (task.status === "cancelled" ? "interrupted" : task.status) : "running";
    if (state === thread.researchRun.state && !(own && settled)) return;
    const now = ctx.store.nowIso();
    await ctx.store.writeThreadRecord({ ...thread, researchRun: { ...thread.researchRun, state, updatedAt: now,
      ...(own && settled ? { endedAt: now, report: task.summary } : {}),
    } });
    ctx.store.emit(threadId, "research-run-changed");
  });
}

export interface ResearchRoleRequest extends ModelRequest {
  readonly leadThreadId: string;
  readonly role: ResearchRole;
  readonly question: string;
}

function findingsOf(run: StoredResearchRun): number {
  return Math.max(0, ...(run.messages ?? []).map((message) => message.findings));
}

/**
 * What a critic reviews: every lens when the run has one critic, otherwise the
 * lens of its place among the run's critics (evidence, risks, alternatives).
 */
async function criticLensOf(ctx: OperationContext, leadThreadId: string, threadId: string): Promise<ResearchLens | "all" | undefined> {
  const run = (await ctx.store.readThreadRecord(leadThreadId))?.researchRun;
  if (!run) return undefined;
  const critics = run.roles.filter((entry) => entry.role === "critic");
  if ((run.size?.critics ?? 3) === 1) return "all";
  const index = critics.findIndex((entry) => entry.threadId === threadId);
  return index < 0 ? undefined : RESEARCH_LENSES[index % RESEARCH_LENSES.length];
}

/** Called with the lead lock held, before creating a child. Membership consumes capacity for good. */
async function checkResearchStart(run: StoredResearchRun, role: ResearchRole): Promise<void> {
  const size = run.size ?? { researchers: 8, critics: 3 };
  if (role === "researcher") {
    const cap = Math.min(8, size.researchers);
    if (run.roles.filter((entry) => entry.role === role).length >= cap) {
      throw new CliError("RESEARCH_CAP", `Researcher total cap is ${cap} (maximum 8).`);
    }
  }
  if (role === "critic") {
    const cap = Math.min(3, size.critics);
    if (run.roles.filter((entry) => entry.role === role).length >= cap) throw new CliError("RESEARCH_CAP", `Critic agent cap is ${cap} (maximum 3).`);
  }
  if (role === "finalizer") {
    const critics = run.roles.filter((entry) => entry.role === "critic");
    const verdicts = (run.messages ?? []).filter((message) => message.kind === "verdict");
    if (!critics.length || critics.some((critic) => {
      const mine = verdicts.filter((message) => message.threadId === critic.threadId);
      return mine.length < 3 && !mine.some((message) => message.findings === findingsOf(run));
    })) {
      throw new CliError("RESEARCH_CAP", "Finalizer requires every started critic to have a current verdict or exhaust its 3 rounds, and at least one critic.");
    }
    if (run.roles.some((entry) => entry.role === role)) throw new CliError("RESEARCH_CAP", "Finalizer agent cap is 1.");
  }
}

async function researchMembership(ctx: OperationContext, threadId: string): Promise<string> {
  const thread = await ctx.store.readThreadRecord(requireThreadId(threadId));
  const leadId = thread?.researchRole?.leadThreadId ?? threadId;
  const lead = await requireResearchLead(ctx, leadId);
  if (threadId !== leadId && !lead.researchRun.roles.some((entry) => entry.threadId === threadId && entry.role === thread?.researchRole?.role)) {
    throw new CliError("RESEARCH_ROLE_REQUIRED", "Only a member of this research run may read or submit its messages.");
  }
  return leadId;
}

export async function readResearchMessages(ctx: OperationContext, threadId: string): Promise<{ leadThreadId: string; messages: readonly ResearchMessage[] }> {
  const leadThreadId = await researchMembership(ctx, threadId);
  const lead = await requireResearchLead(ctx, leadThreadId);
  return { leadThreadId, messages: lead.researchRun.messages ?? [] };
}

/** Explicit submissions, not arbitrary transcript text, become reports and verdicts. */
export async function submitResearchMessage(ctx: OperationContext, threadId: string, text: string): Promise<ResearchMessage> {
  if (typeof text !== "string" || !text.trim()) throw new CliError("INVALID_TOOL_INPUT", "A non-empty research message is required.");
  await syncResearchRun(ctx, threadId);
  const leadId = await researchMembership(ctx, threadId);
  return await ctx.store.withThreadLock(leadId, async () => {
    // A user can replace an ended run between the initial check and this lock.
    await researchMembership(ctx, threadId);
    const lead = await requireResearchLead(ctx, leadId);
    const run = lead.researchRun;
    const role = run.roles.find((entry) => entry.threadId === threadId)?.role;
    const kind = role === "critic" ? "verdict" : role === "finalizer" ? "final" : threadId === leadId ? "followup" : "report";
    // Only researchers change the findings under review; a final report does not reopen review.
    const current = findingsOf(run);
    const reviewed = (run.messages ?? []).some((message) => message.kind === "verdict" && message.findings === current);
    const findings = role === "researcher" && (current === 0 || reviewed) ? current + 1 : current;
    const round = kind === "verdict" ? (run.messages ?? []).filter((message) => message.kind === "verdict" && message.threadId === threadId).length + 1 : undefined;
    if (round !== undefined && round > 3) throw new CliError("RESEARCH_CAP", "Critic round cap is 3 per critic for the whole run.");
    const message: ResearchMessage = { id: randomUUID(), threadId, kind, text: text.trim(), findings, ...(round === undefined ? {} : { round }), createdAt: ctx.store.nowIso() };
    await ctx.store.writeThreadRecord({ ...lead, researchRun: { ...run, messages: [...(run.messages ?? []), message], updatedAt: message.createdAt } });
    ctx.store.emit(leadId, "research-message-submitted");
    return message;
  });
}

export async function startResearchRole(ctx: OperationContext, request: ResearchRoleRequest): Promise<Delegation> {
  await syncResearchRun(ctx, request.leadThreadId);
  const lead = await requireResearchLead(ctx, request.leadThreadId);
  if (!["researcher", "critic", "finalizer"].includes(request.role)) throw new CliError("INVALID_THREAD_OPTION", "Unknown research role.");
  const chosen = lead.researchRun.models?.[request.role];
  if (chosen) {
    const { provider: _provider, model: _model, thinkingEffort: _effort, speedMode: _speed, ...rest } = request;
    request = { ...rest, ...chosen };
  }
  return await delegate(ctx, { ...request, parentThreadId: request.leadThreadId, task: request.question, title: `${request.role}: ${request.question}`, interactionMode: "research", isolation: "shared", wait: false, notify: false }, { researchRole: request.role });
}

export async function requireResearchRole(ctx: OperationContext, leadThreadId: string, taskId: string): Promise<void> {
  const lead = await requireResearchLead(ctx, leadThreadId);
  if (!lead.researchRun.roles.some((role) => role.threadId === taskId)) throw new CliError("TASK_NOT_FOUND", "No such role in this research run.");
}

export interface ResearchRunView extends StoredResearchRun {
  readonly pastResearchRuns?: readonly StoredResearchRun[];
  readonly report: string | null;
  readonly lead: ThreadEnvelope;
  readonly roles: readonly { readonly threadId: string; readonly role: ResearchRole; readonly question: string; readonly thread: ThreadEnvelope; readonly task: TaskView }[];
}

/** Client read surface; role tools separately check lead ownership before calling it. */
export async function readResearchRun(ctx: OperationContext, threadId: string): Promise<ResearchRunView | null> {
  const thread = await ctx.store.readThreadRecord(requireThreadId(threadId));
  const leadId = thread?.researchRole?.leadThreadId ?? threadId;
  await syncResearchRun(ctx, leadId);
  const lead = await ctx.store.readThreadRecord(leadId);
  if (!lead?.researchRun) return null;
  const run = threadId === leadId ? lead.researchRun : [lead.researchRun, ...(lead.pastResearchRuns ?? [])]
    .find((entry) => entry.roles.some((role) => role.threadId === threadId));
  if (!run) return null;
  const envelope = await threadWithLedger(ctx.store, leadId);
  return { ...run, ...(threadId === leadId ? { pastResearchRuns: lead.pastResearchRuns ?? [] } : {}), lead: envelope,
    report: run.report !== undefined ? run.report : taskOf(envelope).summary,
    roles: await Promise.all(run.roles.map(async (role) => {
      const described = await describeTask(ctx, leadId, role.threadId);
      return { ...role, thread: described.child, task: described.task };
    })),
  };
}

export interface DescribedTask {
  readonly project: StoredProject | null;
  readonly parent: ThreadEnvelope;
  readonly child: ThreadEnvelope;
  readonly task: TaskView;
  /** Background work still running on the task's thread, if Moxen can tell. */
  readonly background: TaskBackgroundState;
  /**
   * A review child's verdict, warnings and finished state; null for any
   * other task. `task_status` and the task notification read this rather
   * than recomputing it, so a finished review with no `VERDICT` line is
   * said visibly everywhere instead of passed on as finished.
   */
  readonly review: ReviewFacts | null;
}

/** A delegated task a caller may read, with the threads the read needs. */
export interface AgentTaskThread {
  readonly parent: ThreadEnvelope;
  /** The task id it was asked for, which is the child's thread id. */
  readonly taskId: string;
  /** The live thread holding the task: the one it carried on in, else its own. */
  readonly child: ThreadEnvelope;
  /** The direct delegation row, null when the task is reachable through the caller's lineage only. */
  readonly delegation: StoredDelegation | null;
}

/**
 * The delegated task `parentThreadId` may read — the gate behind `task_status`
 * and every other read of a task's state, so one rule governs them all: the
 * task it delegated (a continuation inheriting what was delegated to its
 * lineage included, and a research run's roles), and nothing else. A thread
 * that did not delegate it, a task in another project, and a task that does
 * not exist are all the same `TASK_NOT_FOUND`.
 */
export async function requireAgentTaskThread(
  ctx: OperationContext,
  rawParentThreadId: string,
  rawTaskId: string,
): Promise<AgentTaskThread> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const taskId = requireThreadId(rawTaskId);
  const parent = await threadWithLedger(ctx.store, parentThreadId);
  const delegation = await delegationForChild(ctx.store, parentThreadId, taskId);
  if (!delegation && !(await isTaskVisibleToParent(ctx, parentThreadId, taskId))) {
    throw new CliError("TASK_NOT_FOUND", `No delegated task exists with id ${taskId} for thread ${parentThreadId}.`, {
      exitCode: 3,
      details: { taskId, parentThreadId },
    });
  }
  const child = await threadWithLedger(ctx.store, delegation?.childThreadId ?? taskId).catch(() => null);
  if (!child || child.projectId !== parent.projectId) {
    throw new CliError("TASK_NOT_FOUND", `No delegated task exists with id ${taskId} for thread ${parentThreadId}.`, {
      exitCode: 3,
      details: { taskId, parentThreadId },
    });
  }
  return { parent, taskId, child, delegation };
}

/** The one refusal a task telemetry read gives, whatever the reason. */
function taskReadRefused(taskId: string, parentThreadId: string): CliError {
  return new CliError("TASK_NOT_FOUND", `No delegated task exists with id ${taskId} for thread ${parentThreadId}.`, {
    exitCode: 3,
    details: { taskId, parentThreadId },
  });
}

/**
 * The record behind a task telemetry read, or the refusal: it must exist, must
 * not be deleted, and must sit in the caller's project.
 */
async function taskThreadOrThrow(
  ctx: OperationContext,
  taskId: string,
  parentThreadId: string,
  threadId: string,
  projectId: string,
): Promise<StoredThread> {
  const target = await ctx.store.readThreadRecord(threadId).catch(() => null);
  if (!target || target.deletedAt != null || target.projectId !== projectId) {
    throw taskReadRefused(taskId, parentThreadId);
  }
  return target;
}

/**
 * The thread an agent reads a delegated task's context and cost from
 * (`context_usage` with a task id): the task, followed to the thread it
 * carried on in, under the ownership rule `task_status` uses. On top of that
 * rule this read validates what it resolved to, because telemetry about a
 * thread that is gone or belongs to another project is not the caller's to
 * read: the thread must exist, must not be deleted, and must sit in the
 * caller's own project. Every refusal here is the same `TASK_NOT_FOUND` a
 * thread that never delegated the task gets, so an id it may not read and an
 * id that does not exist are indistinguishable. `task_status` keeps its own
 * behaviour — a settled task stays readable, and it does not police a deleted
 * one — since the parent already reads that task's report.
 *
 * The check is only true of the moment it ran: a caller that gathers telemetry
 * afterwards confirms it again with `confirmAgentTaskThread` before answering.
 */
export async function agentTaskThread(
  ctx: OperationContext,
  rawCallerThreadId: string,
  rawTaskId: string,
): Promise<{ readonly threadId: string; readonly projectId: string }> {
  const { parent, taskId, child } = await requireAgentTaskThread(ctx, rawCallerThreadId, rawTaskId);
  const live = await ownedDelegation(ctx, rawCallerThreadId, rawTaskId).catch(() => null);
  const threadId = live?.childThreadId ?? child.id;
  await taskThreadOrThrow(ctx, taskId, parent.id, threadId, parent.projectId);
  return { threadId, projectId: parent.projectId };
}

/**
 * The same check, run again after a read gathered the telemetry: a deletion
 * that lands in between is not served the data it produced. Same refusal, same
 * details, so the caller cannot tell a race from a stranger.
 */
export async function confirmAgentTaskThread(
  ctx: OperationContext,
  rawCallerThreadId: string,
  rawTaskId: string,
  threadId: string,
  projectId: string,
): Promise<void> {
  await taskThreadOrThrow(ctx, requireThreadId(rawTaskId), requireThreadId(rawCallerThreadId), threadId, projectId);
}

/** A delegated task by parent + task id; the task id is the child thread id. */
export async function describeTask(ctx: OperationContext, rawParentThreadId: string, rawTaskId: string): Promise<DescribedTask> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const { parent, taskId, child, delegation } = await requireAgentTaskThread(ctx, rawParentThreadId, rawTaskId);
  // The live thread, following the same continuedIn chain task control
  // resolves: asking about a task that carried on reads the continuation,
  // the thread a send would steer — never the dormant source.
  const live = await ownedDelegation(ctx, parentThreadId, taskId).catch(() => null);
  const target = live !== null ? await threadWithLedger(ctx.store, live.childThreadId).catch(() => null) : null;
  const seen = target ?? child;
  const ledger = taskOf(seen, taskId);
  // A usage pause is not an end: a queued continue or recovery reads running
  // until it settles, so `task_status` waits rather than reporting it failed.
  const childTurns = await ctx.store.readTurns(seen.id).catch(() => [] as StoredTurn[]);
  const childPause = (await ctx.store.readThreadRecord(seen.id).catch(() => null))?.usagePause;
  const resume = hasQueuedResume(childTurns, childPause?.recoveryTurnId);
  // A cancelled automatic continue — or the whole task — reads cancelled,
  // however the child's turns settled, until a wake revives it. The mark
  // applies only when the child has no live work: a follow-up still running
  // reports on its own, and its settle clears the mark.
  const settledForGood = !childTurns.some((turn) => turn.status === "running" || turn.status === "queued");
  const status =
    (live ?? delegation)?.status === "cancelled" && settledForGood
      ? ("cancelled" as const)
      : resume
        ? ("running" as const)
        : ledger.status;
  const task = { ...ledger, status, workState: delegatedWorkStateOf(status) };
  // A review child's verdict, warnings and finished state ride with the
  // status. The settled verdict is pinned on the (live) delegation row, so a
  // follow-up turn cannot rewrite it; `task_status` and the task
  // notification read the same pinned facts.
  const facts = await reviewFactsForTask(ctx, seen, parent, live ?? delegation ?? undefined, task);
  return {
    project: await projectById(ctx.storeRoot, parent.projectId),
    parent,
    child: seen,
    task,
    background: await taskBackgroundState(ctx, child.id, child.modelSelection ?? null),
    review: facts === null ? null : { verdict: facts.verdict, sameModel: facts.sameModel, note: facts.note },
  };
}

/**
 * Whether `parentThreadId` may ask after `taskId` without a direct
 * delegation row: a task delegated from an earlier thread in its lineage
 * (a continuation inherits what was delegated to it), or a research role
 * of a run this thread leads (roles are published to the run, and older
 * delegations may predate the row).
 */
async function isTaskVisibleToParent(ctx: OperationContext, parentThreadId: string, taskId: string): Promise<boolean> {
  const rows = await ctx.store.readDelegations();
  const lineage = await threadLineage(ctx, parentThreadId);
  let current: string | undefined = taskId;
  for (let hops = 0; current !== undefined && hops < 16; hops += 1) {
    if (rows.some((row) => row.childThreadId === current && lineage.has(row.parentThreadId))) return true;
    current = rows.find((row) => row.childThreadId === current)?.continuedIn;
  }
  const lead = await ctx.store.readThreadRecord(parentThreadId);
  const runs = lead?.researchRun === undefined ? [] : [lead.researchRun, ...(lead.pastResearchRuns ?? [])];
  return runs.some((run) => run.roles.some((role) => role.threadId === taskId));
}

/** A thread and the threads it continued, nearest first: one conversation, carried on. */
async function threadLineage(ctx: OperationContext, threadId: string): Promise<ReadonlySet<string>> {
  const lineage = new Set([threadId]);
  let from = (await ctx.store.readThreadRecord(threadId))?.continuedFrom;
  while (from !== undefined && !lineage.has(from)) {
    lineage.add(from);
    from = (await ctx.store.readThreadRecord(from))?.continuedFrom;
  }
  return lineage;
}

/**
 * The delegation `parentThreadId` holds on `rawTaskId`, followed to the thread
 * the task carried on in (`continuedIn`). Refuses with `TASK_NOT_FOUND`, the
 * same for a real id and a fake one, when that thread did not delegate it.
 */
async function ownedDelegation(ctx: OperationContext, parentThreadId: string, rawTaskId: string): Promise<StoredDelegation> {
  const rows = await ctx.store.readDelegations();
  const lineage = await threadLineage(ctx, parentThreadId);
  const owned = rows.find((row) => lineage.has(row.parentThreadId) && row.childThreadId === requireThreadId(rawTaskId));
  if (!owned) {
    throw new CliError("TASK_NOT_FOUND", `No delegated task exists with id ${rawTaskId.trim()} for thread ${parentThreadId}.`, { exitCode: 3, details: { taskId: rawTaskId.trim(), parentThreadId } });
  }
  // A task that carried on in a new thread is that thread now.
  let row = owned;
  for (let hops = 0; row.continuedIn !== undefined && hops < 16; hops += 1) {
    const next = rows.find((candidate) => lineage.has(candidate.parentThreadId) && candidate.childThreadId === row.continuedIn);
    if (!next) break;
    row = next;
  }
  return row;
}

export interface DelegationInfo {
  readonly parentThreadId: string;
  readonly notify: boolean;
}

/**
 * The live delegation that made this thread a task, if any: which thread it
 * reports to and whether it notifies. Lets a client cancelling an automatic
 * continue ask before telling the parent. Null for threads that are
 * nobody's task, or whose task carried on elsewhere.
 */
export async function delegationInfo(ctx: OperationContext, rawThreadId: string): Promise<DelegationInfo | null> {
  const threadId = requireThreadId(rawThreadId);
  const rows = await ctx.store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = [...rows].reverse().find((candidate) => candidate.childThreadId === threadId && candidate.continuedIn === undefined);
  return row ? { parentThreadId: row.parentThreadId, notify: row.notify === true } : null;
}

export type CancelledTaskStatus = DelegatedTaskStatus | "cancel_requested";

export interface CancelledTask extends Omit<DescribedTask, "task"> {
  readonly task: Omit<TaskView, "status"> & { readonly status: CancelledTaskStatus };
  /** Whether an interrupt was sent; false when the task had already ended. */
  readonly interruptRequested: boolean;
  /** The child's latest turn state after the interrupt. */
  readonly stateAfter: string | null;
}

/**
 * Interrupt a running task. Cancelling one that already ended is a no-op that reports how it ended.
 * Only the thread that owns the task may: the one that delegated it, or the continuation a continue handed it to.
 * Cancelling also ends a pending automatic continue after a usage limit — without this the task would
 * resume on the reset after being cancelled — and tells the parent, unless asked not to.
 */
export async function cancelTask(ctx: OperationContext, rawParentThreadId: string, rawTaskId: string, opts: CancelAutoContinueOptions = {}): Promise<CancelledTask> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const row = await ownedDelegation(ctx, parentThreadId, rawTaskId);
  const described = await describeTask(ctx, parentThreadId, row.childThreadId);
  const { child } = described;
  if (isThreadActive(child)) {
    try {
      await interruptTurn(ctx.store, child.id);
    } catch (cause) {
      throw new CliError(
        "TASK_CANCEL_UNSUPPORTED",
        `Could not interrupt delegated task ${described.task.taskId}; cancellation is unsupported for this thread.`,
        { exitCode: 4, cause, details: { taskId: described.task.taskId, childThreadId: child.id } },
      );
    }
  } else {
    const terminal = child.latestTurn?.state;
    // A queued automatic continue still waits: ending here would leave the
    // task to resume on the reset after being cancelled.
    const { continues, recoveryTurnId } = await pendingAutoContinue(ctx, child.id);
    for (const turn of continues) await interruptTurn(ctx.store, child.id, turn.id).catch(() => undefined);
    if (recoveryTurnId !== null) {
      const pause = (await ctx.store.readThreadRecord(child.id).catch(() => null))?.usagePause;
      if (!pause?.forced) await editWorkQueue(ctx, child.id, recoveryTurnId, "remove", undefined, opts.notifyParent).catch(() => undefined);
    }
    const hadAutoContinue = continues.length > 0 || recoveryTurnId !== null;
    if (hadAutoContinue) await noteAutoContinueCancelled(ctx, child.id, opts).catch(() => undefined);
    // task_cancel always marks: the whole task was stopped, even where live
    // work remains and the mark alone would not apply.
    if (row.status !== "cancelled") await ctx.store.updateDelegation(row.id, { status: "cancelled" }).catch(() => null);
    if (hadAutoContinue) {
      return { ...described, task: { ...described.task, status: "cancelled" as const }, interruptRequested: false, stateAfter: terminal ?? null };
    }
    const status: CancelledTaskStatus =
      terminal === "completed" ? "completed"
      : terminal === "error" ? "failed"
      : terminal === "interrupted" ? "interrupted"
      : "cancelled";
    return { ...described, task: { ...described.task, status }, interruptRequested: false, stateAfter: terminal ?? null };
  }
  const { continues, recoveryTurnId } = await pendingAutoContinue(ctx, child.id);
  for (const turn of continues) await interruptTurn(ctx.store, child.id, turn.id).catch(() => undefined);
  if (recoveryTurnId !== null) {
    const pause = (await ctx.store.readThreadRecord(child.id).catch(() => null))?.usagePause;
    if (!pause?.forced) await editWorkQueue(ctx, child.id, recoveryTurnId, "remove", undefined, opts.notifyParent).catch(() => undefined);
  }
  const hadAutoContinue = continues.length > 0 || recoveryTurnId !== null;
  if (hadAutoContinue) {
    await noteAutoContinueCancelled(ctx, child.id, opts).catch(() => undefined);
  }
  if (row.status !== "cancelled") {
    await ctx.store.updateDelegation(row.id, { status: "cancelled" }).catch(() => null);
  }
  const after = await threadWithLedger(ctx.store, child.id);
  const state = after.latestTurn?.state ?? null;
  return {
    ...described,
    task: { ...described.task, status: state === "interrupted" ? "interrupted" : "cancel_requested" },
    interruptRequested: true,
    stateAfter: state,
  };
}

export interface SettledTask extends Omit<DescribedTask, "task"> {
  readonly task: Omit<TaskView, "status"> & { readonly status: DelegatedTaskStatus };
  /** A running task is refused without `stop`; true when this call ended running work first. */
  readonly stopped: boolean;
  /** Only with `removeWorktree`: whether the task's checkout is gone. A refusal still settled the task. */
  readonly worktreeRemoved?: boolean;
  /** Only with `removeWorktree`, when the checkout was kept: why. */
  readonly worktreeReason?: string;
}

/**
 * Settle a delegated task through the same path as `threads settle`: the
 * task and its own delegated tasks settle, the parent and siblings are
 * untouched, and running or blocked work refuses (`THREAD_SETTLE_BLOCKED`)
 * unless `stop` ends it first. Only the thread that owns the task may — the
 * one that delegated it, or the continuation a continue handed it to —
 * exactly like `task_cancel`: a research run's roles and lead have no
 * delegation rows, so they are refused with the same `TASK_NOT_FOUND`.
 * With `removeWorktree`
 * the task's worktree checkout goes too, once it is safe; the branch stays.
 */
export async function settleTask(
  ctx: OperationContext,
  rawParentThreadId: string,
  rawTaskId: string,
  options: { readonly stop?: boolean; readonly removeWorktree?: boolean } = {},
): Promise<SettledTask> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const row = await ownedDelegation(ctx, parentThreadId, rawTaskId);
  const described = await describeTask(ctx, parentThreadId, row.childThreadId);
  const family = await threadFamily(ctx.store, described.child.id);
  let hadRunning = false;
  for (const id of family) {
    if (openTurn(await ctx.store.readTurns(id)) !== null) {
      hadRunning = true;
      break;
    }
  }
  await settleThread(ctx.store, described.child.id, options.stop === true ? { stop: true } : {});
  const after = await describeTask(ctx, parentThreadId, row.childThreadId);
  const stopped = options.stop === true && hadRunning;
  if (options.removeWorktree !== true) return { ...after, stopped };
  const parentRecord = await ctx.store.readThreadRecord(parentThreadId);
  const childRecord = await ctx.store.readThreadRecord(after.child.id);
  const removal =
    parentRecord && childRecord
      ? await removeSettledTaskWorktree(ctx, parentRecord, childRecord)
      : { removed: false as const, reason: "the task's thread no longer exists" };
  return {
    ...after,
    stopped,
    worktreeRemoved: removal.removed,
    ...(removal.reason === undefined ? {} : { worktreeReason: removal.reason }),
  };
}

/** A task marked active again by `task_unsettle`. */
export interface UnsettledTask extends Omit<DescribedTask, "task"> {
  readonly task: Omit<TaskView, "status"> & { readonly status: DelegatedTaskStatus };
  /** The task thread's lifecycle status after the call: always `active`. */
  readonly status: "active";
  /** The task's own work status, which unsettling does not change: the last turn's outcome. */
  readonly workStatus: DelegatedTaskStatus;
  /** Always false: unsettling marks the thread active without starting a turn. */
  readonly startedTurn: false;
  /**
   * The task's worktree checkout is gone (cleared at settle): the task is
   * active again, but a message cannot start work in a missing directory.
   */
  readonly worktreeRemoved: boolean;
}

/**
 * The mirror of `settleTask`, through the same path as `threads unsettle`: the
 * task and its own delegated tasks go back to active, and no turn is started
 * (a reopened task takes work when you send it one, or when its queued work is
 * admitted). Only the thread that owns the task may (`requireTaskControl`, the
 * `task_send` rule): a research run's roles and lead are refused like any
 * other task control, and a stranger or a task that does not exist reads
 * `TASK_NOT_FOUND`. A task that is not settled is refused — an active (or
 * snoozed) task has nothing to reopen.
 */
export async function unsettleTask(ctx: OperationContext, rawParentThreadId: string, rawTaskId: string): Promise<UnsettledTask> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const { row, target } = await requireTaskControl(ctx, parentThreadId, rawTaskId, "task_unsettle");
  const status = threadStatus(target);
  if (status !== "settled") {
    throw new CliError(
      "TASK_NOT_SETTLED",
      `Task ${row.childThreadId} is ${status === "snoozed" ? "snoozed, not settled" : "active, not settled"}: there is nothing to unsettle.${status === "snoozed" ? " Its snooze ends on its own, or the task can be unsettled once it settles." : ""}`,
      { exitCode: 4, details: { taskId: row.childThreadId, status } },
    );
  }
  await unsettleThread(ctx.store, row.childThreadId);
  const after = await describeTask(ctx, parentThreadId, row.childThreadId);
  return {
    ...after,
    status: "active",
    workStatus: after.task.status,
    startedTurn: false,
    // A reopened task whose checkout was cleared at settle cannot take a
    // message: the caller says so instead of advising a send that would refuse.
    worktreeRemoved: taskWorktreeGone(target),
  };
}

/** Whether a task's own worktree checkout is gone, so nothing can run in it. */
function taskWorktreeGone(thread: StoredThread): boolean {
  return thread.env.mode === "worktree" && thread.env.path.trim() !== "" && !existsSync(thread.env.path);
}

export interface SnoozeTaskRequest {
  /** Raw `at` text (ISO date-time or HH:MM), read by the one shared reader `--at` uses. */
  readonly at?: string;
  /** Queue conditions, as the work queue takes them (already parsed by `parseQueuePolicy`). */
  readonly conditions?: readonly QueueCondition[];
}

/** A task taken out of the active set by `task_snooze`. */
export interface SnoozedTask extends Omit<DescribedTask, "task"> {
  readonly task: Omit<TaskView, "status"> & { readonly status: DelegatedTaskStatus };
  readonly status: "snoozed";
  /** The task's own work status, which a snooze does not change: the last turn's outcome. */
  readonly workStatus: DelegatedTaskStatus;
  /** The time it wakes at, when `at` (or a `reset` condition) named one; else null. */
  readonly snoozedUntil: string | null;
  /** What it waits for, in the queue's own condition shapes: empty for a snooze that ends on the clock. */
  readonly conditions: readonly QueueCondition[];
  /** When it comes back, in words. */
  readonly wakes: string;
  readonly note: string;
}

/**
 * Take a delegated task out of the active set until a time, or until queue
 * conditions are met (`wakeDueSnoozes` decides those, with the admission
 * pass's own condition rules, so a snoozed task and a queued message wait for
 * exactly the same things). It is the `threads snooze` lifecycle, reached
 * through the task-control ownership rule: your own tasks, continuations
 * included, never a research run's roles or lead, and `TASK_NOT_FOUND` for a
 * stranger or a task that does not exist.
 *
 * A running task may be snoozed: its turn is not touched, and the mark takes
 * effect for what comes after it. A settled task is refused — it is already
 * out of the active set, and wakes by being unsettled or sent a `wake` message.
 */
export async function snoozeTask(ctx: OperationContext, rawParentThreadId: string, rawTaskId: string, request: SnoozeTaskRequest): Promise<SnoozedTask> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const { row, target } = await requireTaskControl(ctx, parentThreadId, rawTaskId, "task_snooze");
  const status = threadStatus(target);
  if (status === "settled") {
    throw new CliError(
      "TASK_SETTLED",
      `Task ${row.childThreadId} is settled, so it is already out of the active set. Unsettle it (task_unsettle) to work on it again, or wake it with a message (task_send with wake: true).`,
      { exitCode: 4, details: { taskId: row.childThreadId, settledAt: target.settledAt } },
    );
  }
  const at = request.at === undefined ? null : parseScheduledTime(request.at, new Date(), "at");
  const asked = request.conditions ?? [];
  if (at === null && asked.length === 0) {
    throw new CliError("INVALID_THREAD_OPTION", "A snooze needs a time (at) or conditions to wait for.", { exitCode: 2, details: { taskId: row.childThreadId } });
  }
  // The same reading of `conditions` the queue makes, against the task's own
  // model so a `reset` waits for the quota pool that model draws on.
  const conditions = asked.length === 0
    ? asked
    : resolveQueueResetConditions(parseQueuePolicy({ conditions: asked, sequential: ctx.config.usageRecovery === "sequential" }, { deferReset: true }), target.modelSelection).conditions;
  const snoozed = await snoozeThread(ctx.store, row.childThreadId, at, conditions);
  const after = await describeTask(ctx, parentThreadId, row.childThreadId);
  const wakes = conditions.length === 0
    ? `at ${snoozed.snoozedUntil}`
    : at === null
      ? "when its conditions are met"
      : `at ${at} at the earliest, once its conditions are met`;
  return {
    ...after,
    status: "snoozed",
    workStatus: after.task.status,
    snoozedUntil: snoozed.snoozedUntil,
    conditions,
    wakes,
    note: `The task is out of the active set until ${wakes}, and comes back on its own: nothing starts a turn on it, and work queued on it (message_queue) waits behind the snooze instead of running. A message you send with task_send still reaches it. task_snooze again to change the time, or task_status to see it.`,
  };
}

/**
 * Wake the threads whose condition-snooze is due: the queue admission's own
 * condition pass decides, so a snooze and a queued message wait for exactly
 * the same things (a reset, headroom, another thread or entry finishing, a
 * provider state). Unsnoozing starts no turn — it puts the thread back in the
 * active set, and its queued entries are admitted on the next pass. A snooze
 * that ends on the clock needs nothing here: a past-due `snoozedUntil` already
 * reads as active. This is the reconciliation pass, over every thread; the
 * periodic watch judges the candidates it knows of instead. Returns the ids it
 * woke.
 */
export async function wakeDueSnoozes(ctx: OperationContext, now = Date.now(), snapshot?: readonly QueueRow[]): Promise<string[]> {
  const rows = snapshot ? [...snapshot] : [];
  const woken: string[] = [];
  for (const id of await ctx.store.listThreadIds().catch(() => [] as string[])) {
    const wake = await wakeSnoozeNow(ctx, id, rows, now);
    if (wake.woken) woken.push(id);
  }
  return woken;
}

/** What one thread's wake pass did. */
export interface SnoozeWake {
  readonly threadId: string;
  /** The thread as the pass left it: active again when the snooze was due. Null when it has none to judge. */
  readonly thread: StoredThread | null;
  /** The snooze was due: it is cleared and the thread is active again. */
  readonly woken: boolean;
  /** The thread still waits on conditions (so a watch should keep it). */
  readonly waiting: boolean;
}

/**
 * Judge one thread's condition-snooze and record the verdict: the periodic
 * watch, the admission pass and the reconciliation pass all come through here,
 * so what a snooze waits for and when it ends cannot differ between them.
 *
 * `rows` is the caller's queue snapshot, extended here with the thread and the
 * dependencies its conditions name — the same loader admission uses, so an
 * entry condition follows every handoff the entry made.
 */
export async function wakeSnoozeNow(
  ctx: OperationContext,
  rawThreadId: string,
  rows: QueueRow[],
  now = Date.now(),
): Promise<SnoozeWake> {
  const threadId = requireThreadId(rawThreadId);
  const thread = await ctx.store.readThreadRecord(threadId).catch(() => null);
  if (!thread || !hasSnoozeConditions(thread) || thread.settledAt != null || thread.deletedAt != null || thread.archivedAt != null) {
    return { threadId, thread: null, woken: false, waiting: false };
  }
  const found = rows.findIndex((row) => row.thread.id === threadId);
  const row: QueueRow = { thread, turns: await ctx.store.readTurns(threadId) };
  const at = found < 0 ? rows.push(row) - 1 : (rows[found] = row, found);
  await queueDependencies(ctx, rows);
  const selection = thread.modelSelection;
  const pass = conditionBlockers({
    conditions: thread.snoozeConditions ?? [],
    since: thread.snoozedAt ?? thread.updatedAt,
    provider: usageKeyForInstance(selection.instanceId),
    model: selection.model,
    rows,
    now,
    latched: thread.snoozeLatched,
  });
  // A snooze with both a time and conditions waits for both: met conditions are
  // not due while the clock still holds the task.
  const held = typeof thread.snoozedUntil === "string" && Date.parse(thread.snoozedUntil) > now;
  const due = !held && pass.blocked.length === 0;
  const applied = await applySnoozeCheck(ctx.store, threadId, { key: snoozeKey(thread), conditions: pass.conditions, latched: pass.latched, due }).catch(() => null);
  if (applied) {
    rows[at] = { ...rows[at]!, thread: applied };
    return { threadId, thread: applied, woken: due, waiting: !due };
  }
  // A newer snooze replaced this one between the read and the lock: it decides
  // its own end, and nothing here touched it.
  const current = await ctx.store.readThreadRecord(threadId).catch(() => null);
  return { threadId, thread: current, woken: false, waiting: current !== null && hasSnoozeConditions(current) && current.settledAt == null };
}

/** Running `git` for a worktree-removal check: null when it cannot answer. */
async function removalGit(cwd: string, args: readonly string[], options: { readonly timeoutMs?: number; readonly noPrompt?: boolean } = {}): Promise<string | null> {
  try {
    const result = await runProcess("git", [...args], {
      cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      allowFailure: true,
      // A fetch must never wait on a credential prompt inside a tool call.
      ...(options.noPrompt === true ? { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } } : {}),
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The default branch's up-to-date ref to judge a removed worktree against:
 * `origin/<name>` (fetched first, best effort) when there is one, else the
 * local `<name>`. Null when no default branch can be named — refusing then
 * is safer than guessing.
 */
async function removalDefaultRef(repo: string): Promise<{ readonly name: string; readonly ref: string } | null> {
  const originHead = await removalGit(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const names = originHead?.startsWith("origin/") ? [originHead.slice("origin/".length)] : ["main", "master"];
  for (const name of names) {
    if (originHead?.startsWith("origin/")) {
      // Best effort: a squash-merge that landed on the forge is not in a stale local ref yet.
      await removalGit(repo, ["fetch", "origin", name], { timeoutMs: 20_000, noPrompt: true });
      if ((await removalGit(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])) !== null) {
        return { name, ref: `refs/remotes/origin/${name}` };
      }
    }
    if ((await removalGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== null) {
      return { name, ref: `refs/heads/${name}` };
    }
  }
  return null;
}

/**
 * Whether the checkout at `repo` holds nothing worth keeping against
 * `defRef`: every commit of its own is already there. Ancestry alone says
 * "not merged" for squash-merged work, so a `-` from `git cherry` (an
 * equivalent patch upstream) and an empty merge ( folding the branch changes
 * nothing) count as merged too. Anything inconclusive refuses: a false
 * refusal keeps a checkout, a false removal loses work.
 */
async function removalMergedState(repo: string, defRef: string): Promise<{ readonly merged: boolean; readonly unmergedCommits: number | null }> {
  if ((await removalGit(repo, ["merge-base", "--is-ancestor", "HEAD", defRef])) !== null) return { merged: true, unmergedCommits: 0 };
  const cherry = await removalGit(repo, ["cherry", defRef, "HEAD"]);
  const marks = cherry === null ? null : cherry.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (marks !== null && marks.every((line) => line.startsWith("-"))) return { merged: true, unmergedCommits: 0 };
  // A rename or rewrite can read as `+` to cherry while the merge is empty, so the tree still gets its say.
  const tree = await removalGit(repo, ["merge-tree", "--write-tree", defRef, "HEAD"]);
  const base = tree === null ? null : await removalGit(repo, ["rev-parse", `${defRef}^{tree}`]);
  if (tree !== null && base !== null && tree === base) return { merged: true, unmergedCommits: 0 };
  return { merged: false, unmergedCommits: marks === null ? null : marks.filter((line) => line.startsWith("+")).length };
}

/**
 * Clear a settled task's worktree checkout. Only a Moxen-managed checkout
 * belonging to that task's own thread (`thread.env.mode === "worktree"`,
 * under the store's `worktrees` dir — the helper `removeThreadWorktree`
 * enforces this too); never a shared checkout, never the parent's own
 * directory, and never outside what that helper manages. Refuses, with the
 * reason, when the checkout has uncommitted or untracked work (ignored files
 * don't count) or its commits are not merged — the branch stays either way.
 * A removal that still fails (a locked directory on Windows refuses) is a
 * `false` with a reason, never a thrown error: the task already settled.
 */
async function removeSettledTaskWorktree(
  ctx: OperationContext,
  parent: StoredThread,
  child: StoredThread,
): Promise<{ readonly removed: boolean; readonly reason?: string }> {
  if (child.env.mode !== "worktree" || !child.env.path.trim()) {
    return { removed: false, reason: "the task has no worktree checkout of its own to remove (it shares a checkout)" };
  }
  const dir = path.resolve(child.env.path);
  if (path.dirname(dir) !== path.join(path.resolve(ctx.storeRoot), "worktrees")) {
    return { removed: false, reason: "the task's checkout is not a Moxen-managed worktree" };
  }
  if (parent.env.path.trim() !== "" && dir === path.resolve(parent.env.path)) {
    return { removed: false, reason: "the task's checkout is the parent's own directory" };
  }
  if (!existsSync(dir)) return { removed: false, reason: "the task's worktree checkout is already gone" };
  const dirty = await removalGit(dir, ["status", "--porcelain"]);
  if (dirty === null) return { removed: false, reason: "the checkout could not be inspected for uncommitted work" };
  if (dirty !== "") {
    return { removed: false, reason: "the checkout has uncommitted or untracked changes (ignored files don't count): commit, stash or discard them first" };
  }
  const target = await removalDefaultRef(dir);
  if (target === null) return { removed: false, reason: "no default branch could be named to judge the task's commits against" };
  const state = await removalMergedState(dir, target.ref);
  if (!state.merged) {
    const count = state.unmergedCommits === null ? "unresolved" : `${state.unmergedCommits}`;
    return { removed: false, reason: `the task's branch holds ${count === "1" ? "1 commit" : `${count} commits`} not in ${target.name}: merge it there first` };
  }
  // An idle provider session survives settle with the checkout as its working
  // directory; close it before the directory goes, best effort like elsewhere.
  try {
    const driver = ctx.driverFor(child.modelSelection.instanceId);
    if (driver.stopSession) await Effect.runPromise(driver.stopSession(child.id)).catch(() => undefined);
  } catch {
    // Best effort: the removal below refuses on its own when the checkout is held.
  }
  if (!(await removeThreadWorktree(ctx.storeRoot, child))) {
    return { removed: false, reason: "git could not remove the checkout — often a file another process still holds open, which locks the directory on Windows; the branch is kept" };
  }
  return { removed: true };
}

/** The task controls that share `requireTaskControl`'s ownership rule, and how each names its research refusal. */
const TASK_CONTROL_TOOLS = {
  task_send: { code: "TASK_SEND_RESEARCH", verb: "take messages" },
  task_ask: { code: "TASK_ASK_RESEARCH", verb: "take side questions" },
  task_unsettle: { code: "TASK_UNSETTLE_RESEARCH", verb: "be unsettled" },
  task_snooze: { code: "TASK_SNOOZE_RESEARCH", verb: "be snoozed" },
} as const;

export type TaskControlTool = keyof typeof TASK_CONTROL_TOOLS;

/** A task a caller may act on with `requireTaskControl`: its delegation row and the task thread. */
export interface ControlledTask {
  readonly row: StoredDelegation;
  readonly target: StoredThread;
}

/**
 * The task a caller may act on with `task_send` or `task_ask`: only the
 * delegation it holds (`ownedDelegation`), so a task that continued in a new
 * thread is still reachable, and never a research run's lead or role, whose
 * traffic goes through the run's scoped and capped messages. A task that was
 * deleted is gone to every control: the same `TASK_NOT_FOUND` a task that
 * never existed gets.
 */
export async function requireTaskControl(
  ctx: OperationContext,
  rawParentThreadId: string,
  rawTaskId: string,
  tool: TaskControlTool,
): Promise<ControlledTask> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const row = await ownedDelegation(ctx, parentThreadId, rawTaskId);
  const caller = await ctx.store.readThreadRecord(parentThreadId);
  const target = await ctx.store.readThreadRecord(row.childThreadId);
  if (!caller || !target || target.deletedAt != null) {
    throw new CliError("TASK_NOT_FOUND", `No delegated task exists with id ${rawTaskId.trim()} for thread ${parentThreadId}.`, { exitCode: 3 });
  }
  if (caller.researchRole || isResearchRunActive(caller.researchRun) || target.researchRole || target.researchRun) {
    const { code, verb } = TASK_CONTROL_TOOLS[tool];
    throw new CliError(
      code,
      `A research run's roles and lead ${verb} only through the run (research_message_submit, and the lead's follow-ups), which are scoped and capped: ${tool} does not reach them.`,
      { exitCode: 4, details: { taskId: row.childThreadId } },
    );
  }
  return { row, target };
}

/** What became of a message sent to a delegated task. */
export type TaskMessageOutcome =
  /** The running turn took it and reads it at its next step; if the turn ends without it reaching the conversation, it is sent again as its own turn. */
  | "steered"
  /** The task is busy and cannot take input mid-turn (here): it runs as the task's next turn, once the current one ends. Not read yet. */
  | "queued"
  /** The task was idle, finished or settled: a new turn started on it. */
  | "started"
  /** It was recorded on the running turn but never reached it, and nothing will resend it. */
  | "not_delivered";

export interface SentTaskMessage extends Omit<DescribedTask, "task"> {
  readonly task: TaskView;
  readonly outcome: TaskMessageOutcome;
  readonly turnId: string;
  readonly messageId: string;
  /** A finished or settled task was woken by this message. */
  readonly woke: boolean;
  /** What the caller should and should not assume. */
  readonly note: string;
}

/** An answer to a side question asked of a delegated task (`task_ask`). */
export interface AskedTask {
  readonly taskId: string;
  /** The task's status when the question was asked; a finished task can still answer from its recorded session. */
  readonly status: DelegatedTaskStatus;
  /** The answer, from a tool-less copy of the task's thread. */
  readonly text: string;
  /** False when the task had no session to answer from, so the answer is not about this task. */
  readonly withContext: boolean;
  readonly provider: string;
}

/**
 * A message from the thread that owns a task, into that task. Only the
 * delegating thread (or the continuation a continue handed the task to)
 * reaches it, and never a research run's role or lead: their messages are
 * scoped and capped (`research*`), and a free message would be a way round
 * both.
 *
 * It takes the same path as every send (`startTurn`), then reports from what
 * that returned, not from what the provider is known for: a steer counts only
 * when `steerDelivered` says the running provider turn received it.
 */
export async function sendTaskMessage(
  ctx: OperationContext,
  rawParentThreadId: string,
  rawTaskId: string,
  rawMessage: string,
  wake: boolean,
): Promise<SentTaskMessage> {
  const parentThreadId = requireThreadId(rawParentThreadId);
  const message = rawMessage.trim();
  if (!message) throw new CliError("PROMPT_REQUIRED", "A non-empty thread message is required.", { exitCode: 2 });
  const { row, target } = await requireTaskControl(ctx, parentThreadId, rawTaskId, "task_send");
  // An agent's message (or wake) starts a turn on the task: delegated work
  // on Antigravity, refused while the setting is off.
  requireAntigravityDelegation(ctx.config, target.modelSelection.instanceId);
  if (taskWorktreeGone(target)) {
    throw new CliError(
      "TASK_WORKTREE_REMOVED",
      `Task ${row.childThreadId} cannot take the message: its worktree checkout was removed after it settled, and its branch ${target.env.branch ?? "(unknown)"} is kept. Re-delegate the follow-up as a new task.`,
      { exitCode: 4, details: { taskId: row.childThreadId, branch: target.env.branch } },
    );
  }

  const before = await describeTask(ctx, parentThreadId, row.childThreadId);
  const turns = await ctx.store.readTurns(target.id);
  const running = openTurn(turns);
  const idle = running === null;
  if (idle && (before.task.status !== "running" || threadStatus(target) === "settled") && !wake) {
    throw new CliError(
      "TASK_SETTLED",
      `Task ${row.childThreadId} has ${threadStatus(target) === "settled" ? "been settled" : "finished"}. Pass wake: true to start a new turn on it; it then reports back with a task notification when it settles again.`,
      { exitCode: 4, details: { taskId: row.childThreadId, status: before.task.status } },
    );
  }
  // A busy task takes the message mid-turn only where this process holds a session whose provider can; otherwise it waits as the next turn.
  const steerable = running !== null && (await canSteer(ctx, target));
  const started = await startTurn(ctx, {
    threadId: target.id,
    prompt: `${TASK_MESSAGE_HEADER}\n\n${message}`,
    origin: "task-message",
    delivery: running === null ? "auto" : steerable ? "steer" : "queue",
    wakeSettled: wake,
    onEvent: () => undefined,
  });
  const outcome: TaskMessageOutcome =
    started.delivery === "steered" || started.delivery === "injected"
      ? started.steerDelivered === true ? "steered" : "not_delivered"
      : started.turn.status === "queued" ? "queued" : "started";
  // A task delegated from the old thread in the race between the transfer's
  // row snapshot and a refusal that landed too late is back in work: it
  // reports to the thread that sent this, not the older one.
  if (outcome !== "not_delivered" && row.parentThreadId !== parentThreadId) await ctx.store.updateDelegation(row.id, { parentThreadId });
  // A message that reaches the task revives a cancelled auto-continue: the
  // fresh work reports on its own, not as cancelled — including a steer,
  // which reaches the live turn without starting one.
  if (outcome !== "not_delivered" && row.status === "cancelled") {
    await reviveCancelledDelegation(ctx, target.id);
  }
  // The parent hears again when the task settles for good, whichever turn that is: the first report was one-shot.
  if (row.notify === true && (outcome === "started" || outcome === "queued" || outcome === "steered")) notifyWhenTaskSettles(ctx, parentThreadId, target.id);
  const after = await describeTask(ctx, parentThreadId, row.childThreadId);
  const notes: Record<TaskMessageOutcome, string> = {
    steered: "The running turn took it and reads it at its next step. If the turn ends without it reaching the conversation, it is sent again as its own turn.",
    queued: "The task is busy and cannot take input mid-turn, so the message waits and runs as its next turn once the current one ends. It has not read it yet.",
    started: wake && idle ? "The task was idle or settled; the message started a new turn on it. A task notification arrives when it settles again." : "The message started a new turn on the task.",
    not_delivered: "The message is recorded in the task's thread but did not reach its running turn, and nothing will resend it. Send it again once the task settles.",
  };
  return { ...after, outcome, turnId: started.turn.id, messageId: started.messageId, woke: idle && (before.task.status !== "running" || threadStatus(target) === "settled"), note: notes[outcome] };
}

export interface QueueAgentMessageInput {
  readonly message: string;
  /** The thread to queue on; the caller's own when absent. */
  readonly threadId?: string;
  /** Raw `--at` text (ISO date-time or HH:MM); parsed by the one shared reader. */
  readonly at?: string;
  /** Queue conditions, as the work queue accepts them (already parsed by `parseQueuePolicy`). */
  readonly conditions?: QueuePolicy["conditions"];
}

export interface QueuedAgentMessage {
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  /** `queued`, or `running` when the thread was idle and nothing held the message back. */
  readonly status: "queued" | "running";
  /** Whether the target is the calling thread. */
  readonly self: boolean;
  /** When it is expected to run, in words: now, at a time, once the current turn ends, or when its conditions are met. */
  readonly expectedRun: string;
  /** The time it is held to, when `at` was given. */
  readonly scheduledFor: string | null;
  /** What it still waits for. */
  readonly waitingFor: readonly string[];
  readonly note: string;
}

/**
 * An agent's message into a thread's queue (`message_queue`): its own thread,
 * or a task it delegated (the `task_send` rule, continuations included, and
 * never a research run's lead or roles). It takes the composer's path
 * (`startTurn`), so the durable queue owns admission and the entry shows in the
 * Work queue. It is always `queue` delivery: never a steer, so a thread
 * queueing for itself mid-turn waits for that turn instead of joining it, and
 * it takes no lock of its own (the send locks only for its ledger writes).
 *
 * The message carries `origin: "agent-message"`, which is what keeps it from
 * ending a usage hold (`manualContinuation` needs no origin): a protected
 * thread keeps it as an automatic wake-up that waits behind the hold.
 */
export async function queueAgentMessage(ctx: OperationContext, rawCallerThreadId: string, input: QueueAgentMessageInput, snapshot?: readonly QueueRow[]): Promise<QueuedAgentMessage> {
  const callerId = requireThreadId(rawCallerThreadId);
  const message = input.message.trim();
  if (!message) throw new CliError("PROMPT_REQUIRED", "A non-empty thread message is required.", { exitCode: 2 });
  const caller = await ctx.store.readThreadRecord(callerId);
  if (!caller) throw new CliError("THREAD_NOT_FOUND", `No thread exists with id ${callerId}.`, { exitCode: 3 });
  const requested = input.threadId === undefined ? callerId : requireThreadId(input.threadId);
  const self = requested === callerId;
  const targetId = self ? callerId : (await ownedDelegation(ctx, callerId, requested)).childThreadId;
  const target = self ? caller : await ctx.store.readThreadRecord(targetId);
  if (!target) throw new CliError("TASK_NOT_FOUND", `No delegated task exists with id ${requested} for thread ${callerId}.`, { exitCode: 3 });
  if (caller.researchRole || isResearchRunActive(caller.researchRun) || target.researchRole || target.researchRun) {
    throw new CliError(
      "QUEUE_MESSAGE_RESEARCH",
      "A research run's roles and lead take messages only through the run (research_message_submit, and the lead's follow-ups), which are scoped and capped: message_queue does not reach them.",
      { exitCode: 4, details: { threadId: targetId } },
    );
  }
  const scheduledFor = input.at === undefined ? undefined : parseScheduledTime(input.at, new Date(), "at");
  const conditions = input.conditions ?? [];
  const queue = conditions.length > 0 ? resolveQueueResetConditions(parseQueuePolicy({ conditions, sequential: ctx.config.usageRecovery === "sequential" }, { deferReset: true }), target.modelSelection) : undefined;
  const started = await startTurn(ctx, {
    threadId: targetId,
    prompt: `${self ? SELF_QUEUED_HEADER : TASK_MESSAGE_HEADER}\n\n${message}`,
    origin: "agent-message",
    delivery: "queue",
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(queue ? { queue } : {}),
    onEvent: () => undefined,
  });
  const turn = (await ctx.store.readTurns(targetId)).find((candidate) => candidate.id === started.turn.id) ?? started.turn;
  const thread = (await ctx.store.readThreadRecord(targetId)) ?? started.thread;
  // A snoozed task is out of the active set, so the message waits for the
  // snooze to end (or a time it names) rather than for a turn to finish.
  const snoozed = snoozeActive(thread, Date.now());
  let waitingFor: string[] = [];
  if (turn.status === "queued") {
    const rows = snapshot ? [...snapshot] : await queueRows(ctx);
    if (snapshot) await queueDependencies(ctx, rows);
    const row = rows.find((candidate) => candidate.thread.id === targetId) ?? { thread, turns: await ctx.store.readTurns(targetId) };
    waitingFor = turn.queue ? queueAdmission(row, turn, rows, ctx.config, undefined, await loadTurnOrigins(ctx.store, [row], ctx.config)).blocked : [];
    if (!turn.queue && thread.usagePause) waitingFor = ["Waiting for thread protection"];
    else if (!turn.queue && snoozed) waitingFor = ["Waiting for the task's snooze to end"];
  }
  const held = typeof turn.scheduledFor === "string" && Date.parse(turn.scheduledFor) > Date.now() ? turn.scheduledFor : null;
  const expectedRun =
    turn.status === "running" ? "now: the thread was idle and nothing held the message back"
    : turn.queue || thread.usagePause || snoozed ? `when it is admitted: ${waitingFor.length ? waitingFor.join("; ") : "its conditions are met"}${held ? `, no earlier than ${held}` : ""}`
    : held ? `at ${held}, once the thread is free`
    : "when the current turn ends";
  return {
    threadId: targetId,
    turnId: turn.id,
    messageId: started.messageId,
    status: turn.status === "running" ? "running" : "queued",
    self,
    expectedRun,
    scheduledFor: held,
    waitingFor,
    note: turn.status === "running"
      ? "The thread was idle with nothing to wait for, so the message started a turn now."
      : "The message is in the thread's queue (Work queue); it runs once, when it is admitted. The user can edit or remove it there.",
  };
}

/**
 * Tell a task's parent when the task next has nothing left to run. Watches the
 * ledger's turn events rather than one run: a message queued behind a running
 * turn is run by that turn's runner, which nothing awaits.
 *
 * `onlyFutureSettles` skips the check of the task as it stands: the caller
 * just reported this settle, so only a later turn settling may report again.
 * Without it, arming on an already-settled task would notify at once.
 * `sinceGeneration` is the settle generation the caller's snapshot was taken
 * at: when set, a settle that landed between the snapshot and this arming
 * reports at once instead of being lost. A task that has not settled since
 * keeps waiting for a future one.
 */
function notifyWhenTaskSettles(
  ctx: OperationContext,
  parentThreadId: string,
  childThreadId: string,
  onlyFutureSettles = false,
  sinceGeneration: number | null = null,
): void {
  let done = false;
  let checking = false;
  let again = false;
  const stop = ctx.store.subscribe((event) => {
    if (event.type !== "backend.thread.changed" || event.threadId !== childThreadId) return;
    if (event.reason !== "turn-completed" && event.reason !== "turn-failed" && event.reason !== "turn-interrupted") return;
    void check();
  });
  const check = async (): Promise<void> => {
    if (done) return;
    if (checking) { again = true; return; }
    checking = true;
    try {
      do {
        again = false;
        if (done || !(await taskHasSettledForGood(ctx, childThreadId))) continue;
        if (sinceGeneration !== null && (await settledTurnCount(ctx, childThreadId)) <= sinceGeneration) {
          // No settle since the caller's snapshot: a turn settling in the gap
          // would have moved the generation. Keep waiting for a future one.
          continue;
        }
        done = true;
        stop();
        await queueTaskNotification(ctx, parentThreadId, childThreadId);
      } while (again);
    } finally {
      checking = false;
    }
  };
  if (!onlyFutureSettles) void check();
  else if (sinceGeneration !== null) void check();
}

/** One checklist item, as the tasks panel reads it (`turn.plan.updated`'s `plan`). */
export interface ChecklistStep {
  readonly step: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface RecordedChecklist {
  readonly threadId: string;
  /** The turn it was recorded on: the running one, else the latest. Null before any turn. */
  readonly turnId: string | null;
  readonly steps: number;
}

/**
 * An agent's checklist, for a provider that keeps none of its own (OpenCode
 * v2 has no `todowrite`): recorded as the thread's plan the way a native
 * checklist is, so the tasks panel shows it. The whole list each time.
 */
export async function recordChecklist(
  ctx: OperationContext,
  rawThreadId: string,
  plan: readonly ChecklistStep[],
): Promise<RecordedChecklist> {
  const thread = await inspectThread(ctx.store, rawThreadId);
  const turns = await ctx.store.readTurns(thread.id);
  const turn = [...turns].reverse().find((entry) => entry.status === "running") ?? turns.at(-1) ?? null;
  await ctx.store.appendLedger(thread.id, "activity", {
    id: ctx.store.newId(),
    threadId: thread.id,
    turnId: turn?.id ?? null,
    kind: "turn.plan.updated",
    summary: "Plan updated",
    payload: { plan: plan.map((entry) => ({ step: entry.step, status: entry.status })) },
    createdAt: ctx.store.nowIso(),
  });
  ctx.store.emit(thread.id, "activity");
  return { threadId: thread.id, turnId: turn?.id ?? null, steps: plan.length };
}


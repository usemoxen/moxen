/**
 * In-process implementation of `ClientApi` (`./api.ts`) over the own
 * store, drivers, and git checkpoints — no server, no websocket.
 *
 * - Subscriptions are poll-based snapshots in the exact frame shapes the
 *   existing projectors consume (`{kind:"snapshot",…}`,
 *   `{kind:"synchronized"}`, `{kind:"event",…}`), plus live
 *   `thread.message-sent` deltas bridged from provider events while a
 *   turn runs. Tool calls are appended to the activity ledger as they
 *   land, so they survive resubscription; message text streams live and
 *   converges from the ledger at settle.
 * - `dispatch` maps the command types the TUI sends onto store ops and
 *   the shared turn runner. Image attachments degrade to file-name
 *   mentions in the driver prompt (per-driver image plumbing is a
 *   Stage 6 item); validation limits still apply client-side.
 * - `getConfig` serves the direct catalog translated into the
 *   `server.getConfig` payload shape, so `extractProviders` (and the
 *   effort picker) works unmodified.
 */
import path from "node:path";
import { appendFile, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { importManagedSkill, listManagedSkills, readManagedSkill, removeManagedSkill, saveManagedSkill, setManagedSkillEnabled, setManagedSkillProviders, type SkillRoots } from "../core/skills/management.js";
import { excludedSkills } from "../core/skills/discovery.js";
import { randomUUID } from "node:crypto";
import { readExperience, updateExperience } from "../core/experience/experience.js";
import { discoverModels } from "../core/providers/harness/discover.js";
import { primeProfileKey } from "../core/providers/harness/profiles.js";
import { exportProfileDocument, freeProfileId, parseProfileDocument } from "../core/providers/harness/profileio.js";
import { testMcpServer } from "../core/mcptest.js";
import { searchThreadsView } from "../core/threads/search.js";
import { turnThroughput } from "../core/threads/throughput.js";
import * as Effect from "effect/Effect";

import { buildDirectProviders } from "../core/catalog/direct.js";
import { fetchLiveModels } from "../core/providers/claude/livemodels.js";
import { SdkTransport } from "../core/providers/claude/transport.js";
import { diagnose } from "../core/diagnostics/doctor.js";
import { updateProvider, type ProviderUpdate, type UpdatableProvider } from "../core/providers/update.js";
import { latestVersions } from "../core/providers/latest.js";
import { checkForUpdate } from "../core/selfupdate/check.js";
import { rollbackRelease, updateRelease, type UpdateOptions } from "../core/selfupdate/update.js";
import type { RollbackResult, UpdateCheck, UpdateProgress, UpdateResult } from "../core/selfupdate/vocabulary.js";
import { readInstall } from "../core/selfupdate/install.js";
import type { LatestVersions } from "../core/catalog/update.js";
import { EMPTY_SKILL_INVENTORY, type ProviderSummary, type ProviderUsageLimits } from "../core/catalog/summary.js";
import { loadModelPrefs, providerModelPreferences, setModelHidden } from "../core/catalog/prefs.js";
import { defaultRuntimeMode, followUpSelection, resolveModelSelection, type ModelRequest } from "../core/catalog/selection.js";
import { appHomeDir, defaultConfigPath, loadConfig, normalizeConfig, saveConfig, setConfigValueSecure } from "../core/config.js";
import { duplicateListItem } from "../core/configlist.js";
import { DEFAULT_REMOTE_PORT, describeSettings, listTarget } from "../core/configschema.js";
import { HarnessDriver } from "../core/providers/harness/driver.js";
import { CodexDriver } from "../core/providers/codex/driver.js";
import { imageGenerationAvailability, imageGenerationModel, type ImageGenerationModel } from "../core/providers/codex/imagegeneration.js";
import { isNativeToolDisabled } from "../core/nativetools.js";
import { moxenToolsOf } from "../core/mcp.js";
import { readKnowledge, searchKnowledge } from "../core/knowledge/knowledge.js";
import { mergeProbed, probeSettledSomething, runProbe, testProfile } from "../core/providers/harness/probe.js";
import { readCommitDetail, readCommitDiff, readOverview } from "../core/git/history.js";
import {
  commentOnRequest,
  commitChecks,
  commitRuns,
  createRequest,
  detectForge,
  requestStatus,
  listRequests,
  mergeRequest,
  viewRequest,
  type ForgeDetection,
} from "../core/forge/forge.js";
import { toWsConfigPayload } from "./config-payload.js";
import { MOXEN_MCP_SERVER_NAME, moxenMcpServerSpec } from "./mcp/main.js";
import { MOXEN_CHECKLIST_ARG, MOXEN_CHECKLIST_QUERY, MOXEN_DELEGATED_ARG, MOXEN_DELEGATED_QUERY, MOXEN_MEMORY_ARG, MOXEN_MEMORY_QUERY, MOXEN_NO_WEB_FETCH_ARG, MOXEN_NO_WEB_FETCH_QUERY, moxenInstructions } from "./mcp/stdio.js";
import { startMcpHttpServer, type McpHttpServer } from "./mcp/http.js";
import { MOXEN_MCP_INSTRUCTIONS } from "./mcp/stdio.js";
import { callMoxenTool, moxenToolsFor, type MemoryAccess } from "./mcp/tools.js";
import { isVisibleThread, noteMessageId } from "../core/threads/views.js";
import { respondToAsyncInput } from "../core/threads/asyncinput.js";
import { driverProviders } from "../core/threads/longthreads.js";
import { redactMcpServers, type McpServerSpec } from "../core/mcp.js";
import { ensureStoredProject, listStoredProjects, workspaceRootsEqual } from "../core/projects/projects.js";
import { agentReadBudget, readThreadForAgent, type CallerContext } from "../core/threads/agentread.js";
import { appendMemory, claudeMemoryDir, deleteMemory, editMemory, importClaudeMemories, listMemories, memoryIndexText, readMemory, saveMemory, searchMemories, type MemoryLocation } from "../core/memory/memory.js";
import { EmbeddingRuntime } from "../core/memory/embedding-runtime.js";
import { SemanticMemory } from "../core/memory/semantic.js";
import { projectMemorySetting } from "../core/threads/instructions.js";
import { improvePrompt } from "../core/threads/promptimprover.js";
import { resolveClaudeHomePath } from "../core/providers/claude/config.js";
import { readAttachment, readImageFile, workspaceGit, workspaceRead } from "./workspace.js";
import { createScratchDir, ensureScratchProject, removeScratchDir } from "../core/projects/scratch.js";
import { diffCheckpointRange, diffCheckpointStat } from "../core/checkpoints/git.js";
import { CliError } from "../core/errors.js";
import { buildIdentity } from "../core/build.js";
import {
  archiveThread,
  createThread,
  deleteThread,
  inspectThread,
  interruptTurn,
  listThreads,
  readThread,
  settleThread,
  snoozeThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMeta,
} from "../core/threads/threads.js";
import {
  driverForInstance,
  driverKey,
  ensureDriverSession,
  subscribeDriverThread,
  liveTurnText,
  type TurnDriver,
  type TurnDriverFactories,
} from "../core/threads/execute.js";
import { onScheduledTurnDue } from "../core/threads/schedule.js";
import { onThreadFailure } from "../core/threads/failures.js";
import {
  armPendingScheduledTurns,
  recoverTaskNotifications,
  readWorkQueue,
  editWorkQueue,
  pendingHandoff,
  submitHandoff,
  cancelTask,
  sendTaskMessage,
  settleTask,
  requireTaskControl,
  continueThread,
  continueOwnThread,
  delegate,
  beginResearchRun,
  isResearchRunActive,
  moxenRoutingFor,
  resolveResearchPlan,
  startResearchRole,
  requireResearchRole,
  readResearchRun,
  readResearchMessages,
  submitResearchMessage,
  type DelegateRequest,
  recordChecklist,
  describeTask,
  ensureProject,
  handover,
  inspectThreadView,
  recoverOrphanedTurn,
  listThreadsView,
  readThreadView,
  resolveProjectView,
  retitleThread,
  removeThreadWorktree,
  revertThread,
  runDueScheduledTurn,
  queueAgentMessage,
  startTurn,
  delegationInfo,
  flushTaskNotifications,
  noteAutoContinueCancelled,
  type BuiltinMcpOptions,
  type OperationContext,
  type StartedTurn,
} from "../core/threads/operations.js";
import { toThreadEnvelope } from "../core/threads/project.js";
import { backfillNativeSubagents, subagentTranscript } from "../core/threads/subagents.js";
import { openThreadStore, resolveStoreRoot, type ThreadStore } from "../core/threads/store.js";
import type { ProviderRuntimeEvent } from "../core/providers/spi.js";
import { isCompactCommand } from "../core/providers/spi.js";
import { pruneFinishedWorktrees } from "../core/threads/prune.js";
import type { CheckpointFileStat, ResearchPlan, ResearchSize, StoredCheckpoint, StoredThread, StoredTurn, TurnStatus } from "../core/threads/types.js";
import type { CliConfig, ForgeConfig, ModelSelection, ProvidersConfig, ThreadEnvelope, WebConfig } from "../core/types.js";
import { driverKindOfInstance } from "../core/types.js";
import { persistUsageLimits, recordUsageWindows, usageKeyForInstance, usageLimitsSnapshot } from "../core/usage/limits.js";
import { UsageProtection } from "../core/usage/protection.js";
import { subscribeDriverUsage } from "../core/threads/execute.js";
import { readUsageCard, readUsageStats } from "../core/usage/statsstore.js";
import type { ClientApi } from "./api.js";
import type { RemoteAccess } from "./transport/remoteaccess.js";
import { DeviceRegistry } from "./transport/devices.js";
import { remoteServerName } from "./servermode.js";
import {
  decodeCommand,
  decodeQuery,
  type ResearchProposal,
  type Command,
  type CommandOf,
  type CommandResult,
  type CommandType,
  type ConfigPayload,
  type SettingsSnapshot,
  type Query,
  type QueryOf,
  type QueryResult,
  type QueryResults,
  type QueryType,
  type ShellFrame,
  type StartedTurnSummary,
  type ThreadFrame,
  type PermissionDecision,
  type UserInputAnswers,
} from "./protocol.js";

/** How often finished worktree threads are tidied while the server runs. */
const PRUNE_INTERVAL_MS = 6 * 3_600_000;
/**
 * Bound for one driver's freshness probe inside `usage.refresh`: covers the
 * slowest healthy probe (OpenCode Go's five-second HTTP read) with margin,
 * well inside the tool's outer eight-second race. A probe slower than this is
 * cut here, while its late completion still freshens the next call through
 * the normal event path.
 */
const USAGE_DRIVER_PROBE_TIMEOUT_MS = 6_000;

/**
 * Bound for every driver's `stopAll` inside `close()`: shutdown (SIGTERM,
 * `server stop`) must not hang on one stuck driver, nor starve the rest
 * behind it. Every driver is still asked — all stops start together — only
 * the wait is bounded. A stop slower than this loses the race (its late
 * completion is dropped, never awaited) and shutdown resolves without it,
 * so the server process exits on schedule; a stuck driver is left for the
 * process exit to reap rather than shut down cleanly.
 */
const CLOSE_DRIVER_TIMEOUT_MS = 5_000;

/** Config writes in flight, by resolved file: two writers to one file queue, others run together. */
const configWrites = new Map<string, Promise<unknown>>();

/** An aborted wait ends the wait, never the turn: the run carries on for whoever still listens. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CliError("CONNECTION_CLOSED", "The connection closed while waiting for the turn to settle.");
  }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CliError("CONNECTION_CLOSED", "The connection closed while waiting for the turn to settle."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortableRun(run: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return run;
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new CliError("CONNECTION_CLOSED", "The connection closed while waiting for the turn to settle."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void run.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

/** The file beside the threads recording which build's server owns the store. */
const STORE_LOCK_FILE = "server.lock";

interface StoreLock {
  readonly build: string;
  readonly display: string;
  readonly pid: number;
  readonly startedAt: string;
}

/**
 * Stores claimed by a connection in this process. The lock file below
 * guards across processes; this guards the same process, where the pid
 * check would wave a second owner through (in-process mode is the server
 * and tests only — production never claims twice).
 */
const claimedStores = new Map<string, { token: string; display: string; pid: number }>();

/** Whether a pid names a live process. Portable: no shell, no `ps`, no signal sent. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process that exists but cannot be signalled is still alive; only a
    // missing process (`ESRCH`) is gone. Matches `core/selfupdate/update.ts`.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The store's lock as it stands: null when no claim is recorded, or it cannot be read. */
export async function readStoreLock(storeRoot: string): Promise<StoreLock | null> {
  const raw = await readFile(path.join(storeRoot, STORE_LOCK_FILE), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const lock = JSON.parse(raw) as Partial<StoreLock>;
    if (typeof lock.pid !== "number" || typeof lock.build !== "string") return null;
    return {
      build: lock.build,
      display: typeof lock.display === "string" ? lock.display : lock.build,
      pid: lock.pid,
      startedAt: typeof lock.startedAt === "string" ? lock.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** Whether a starting server may take the store: no lock, or its holder is gone (or this process). */
export async function storeLockGone(storeRoot: string): Promise<boolean> {
  const lock = await readStoreLock(storeRoot);
  return lock === null || lock.pid === process.pid || !processAlive(lock.pid);
}

export type { TurnDriverFactories } from "../core/threads/execute.js";

export interface DirectConnectionOptions {
  readonly storeRoot?: string;
  readonly drivers?: TurnDriverFactories;
  readonly shellPollMs?: number;
  readonly threadPollMs?: number;
  /** Bound for every driver's `stopAll` inside `close()`; defaults to `CLOSE_DRIVER_TIMEOUT_MS` (tests pass milliseconds). */
  readonly closeDriverTimeoutMs?: number;
  /** Provider source override (tests); defaults to probing the live providers. */
  readonly providers?: () => Promise<ProviderSummary[]>;
  /** Catalog source override (tests); defaults to the providers above, reshaped. */
  readonly catalog?: () => Promise<ConfigPayload>;
  /** Config source override (tests); defaults to the user's config file. */
  readonly config?: () => Promise<CliConfig>;
  /** Which file `settings.set` writes; defaults to the resolved config path. */
  readonly configPath?: string;
  /** The `moxen` tools' MCP server per thread; defaults to `mcp/main.ts`. Null turns them off. */
  readonly builtinMcpServers?: ((threadId: string, options?: BuiltinMcpOptions) => readonly McpServerSpec[] | Promise<readonly McpServerSpec[]>) | null;
  /** Runs a provider CLI's own updater (tests); defaults to the real one. */
  readonly updateProvider?: (provider: UpdatableProvider, binaryPath?: string) => Promise<ProviderUpdate>;
  /** Reads the newest provider versions (tests); defaults to the npm registry. */
  readonly latestVersions?: (claudeBinaryPath?: string) => Promise<Omit<LatestVersions, "enabled">>;
  /** Checks GitHub Releases for a newer Moxen (tests); defaults to the real check of the running install. */
  readonly checkAppUpdate?: () => Promise<UpdateCheck>;
  /** Updates Moxen itself (tests); defaults to the real `updateRelease` on this install. */
  readonly updateApp?: (options: UpdateOptions) => Promise<UpdateResult>;
  /** Rolls Moxen itself back (tests); defaults to the real `rollbackRelease`. */
  readonly rollbackApp?: (options: UpdateOptions) => Promise<RollbackResult>;
  /** The `fetch` the harness test and probe use; tests hand in a fake server. */
  readonly harnessFetch?: typeof fetch;
}

export class DirectConnection implements ClientApi {
  private readonly usageProtection = new UsageProtection(() => this.context());
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private usageTickRunning = false;
  private readonly usageFailures = new Set<string>();
  /** Detached core failures already written to the server log, by line: a subscriber that throws on every event must not fill the disk. */
  private readonly threadFailures = new Set<string>();
  /** Removes this connection's detached-failure sink; set in the constructor, run in `close`. */
  private readonly stopThreadFailureSink: () => void;
  private readonly usageSubscriptions: Array<() => void> = [];
  private readonly storeRoot: string;
  private readonly embeddingRuntime: EmbeddingRuntime;
  private readonly semanticMemory: SemanticMemory;
  private embeddingSetup: Promise<{ readonly indexed: number }> | null = null;
  private embeddingIndexed = 0;
  private embeddingGeneration = 0;
  private remoteAccess: RemoteAccess | null = null;
  private readonly factories: TurnDriverFactories;
  private readonly shellPollMs: number;
  private readonly threadPollMs: number;
  private readonly closeDriverTimeoutMs: number;
  private readonly catalog: () => Promise<ConfigPayload>;
  private readonly providers: () => Promise<ProviderSummary[]>;
  private readonly loadConfig: () => Promise<CliConfig>;
  private readonly readConfigFile: () => Promise<{ config: CliConfig; path: string; exists: boolean }>;
  /** The per-provider settings the last config read saw; see `driverFor`. */
  private lastProviders: ProvidersConfig | undefined;
  private lastWeb: WebConfig | undefined;
  private readonly builtinMcpServers: DirectConnectionOptions["builtinMcpServers"];
  private readonly readLatestVersions: (claudeBinaryPath?: string) => Promise<Omit<LatestVersions, "enabled">>;
  private readonly runProviderUpdate: (provider: UpdatableProvider, binaryPath?: string) => Promise<ProviderUpdate>;
  private readonly harnessFetch: typeof fetch | undefined;
  private readonly checkAppUpdate: () => Promise<UpdateCheck>;
  private readonly updateApp: (options: UpdateOptions) => Promise<UpdateResult>;
  private readonly rollbackApp: (options: UpdateOptions) => Promise<RollbackResult>;
  /** Shell subscribers, who are told where an update is. */
  private readonly updateListeners = new Set<(frame: ShellFrame) => void>();
  /** Poll intervals with a live subscription; `close()` clears them all. */
  private readonly pollTimers = new Set<ReturnType<typeof setInterval>>();
  /** Profiles with a probe running: two at once would fight over a single-slot server. */
  private readonly probing = new Set<string>();
  private storePromise: Promise<ThreadStore> | null = null;
  /** Set once an update or rollback has landed: the running code is stale. */
  private restartPending = false;
  /** Distinguishes this connection's claim from another's in the same process. */
  private readonly claimToken = randomUUID();
  private readonly driversOwner = {};
  private readonly ownedDrivers = new Set<TurnDriver>();
  private closed = false;
  private readonly researchResponders = new Map<string, number>();
  private readonly researchProposals = new Map<string, {
    proposal: ResearchProposal;
    answer: (plan: ResearchPlan | null) => void;
  }>();
  private researchRevision = 0;
  /** Backfilled per-file stats for checkpoints recorded without them, by ref pair (immutable). */
  private readonly checkpointFiles = new Map<string, ReadonlyArray<CheckpointFileStat>>();

  constructor(options: DirectConnectionOptions = {}) {
    this.storeRoot = options.storeRoot ?? resolveStoreRoot();
    this.embeddingRuntime = new EmbeddingRuntime(this.storeRoot);
    this.semanticMemory = new SemanticMemory(this.embeddingRuntime);
    persistUsageLimits(this.storeRoot);
    this.factories = options.drivers ?? {};
    this.harnessFetch = options.harnessFetch;
    this.shellPollMs = options.shellPollMs ?? 1500;
    this.threadPollMs = options.threadPollMs ?? 750;
    this.closeDriverTimeoutMs = options.closeDriverTimeoutMs ?? CLOSE_DRIVER_TIMEOUT_MS;
    this.providers = options.providers ?? (async () => {
      // A config that cannot be read must not hide the providers that need none of it.
      const providers = await this.readConfigFile().then((read) => read.config.providers, () => undefined);
      const claudeBinary = providers?.claude?.binaryPath || "claude";
      return await buildDirectProviders({
        harness: providers?.harness,
        ...(providers?.codex ? { codex: providers.codex } : {}),
        fetchClaudeModels: () => fetchLiveModels({ transport: new SdkTransport(), binaryPath: claudeBinary }),
      });
    });
    this.catalog = options.catalog ?? (async () => toWsConfigPayload(await this.providers()));
    // One reader, two shapes: operations want the config alone, while
    // `settings.set` also needs the path to write back to. A test that
    // overrides the config supplies values only, so its path falls back to
    // the resolved default and is never written unless it asks for one.
    const override = options.config;
    this.readConfigFile = override
      ? async () => ({ config: await override(), path: options.configPath ?? defaultConfigPath(), exists: true })
      : async () => await loadConfig(options.configPath);
    this.loadConfig = async () => {
      const { config } = await this.readConfigFile();
      // What the drivers read, with the long-thread lines already resolved (global ones included).
      this.lastProviders = driverProviders(config);
      this.lastWeb = config.web;
      return config;
    };
    void this.applyEmbeddingPolicy().catch(() => undefined);
    this.harnessFetch = options.harnessFetch;
    this.readLatestVersions = options.latestVersions ?? ((claudeBinaryPath) => latestVersions(claudeBinaryPath === undefined ? {} : { claudeBinaryPath }));
    this.checkAppUpdate = options.checkAppUpdate ?? (() => checkForUpdate({ install: readInstall() }));
    this.updateApp = options.updateApp ?? updateRelease;
    this.rollbackApp = options.rollbackApp ?? rollbackRelease;
    this.runProviderUpdate = options.updateProvider ?? ((provider, binaryPath) => updateProvider(provider, binaryPath === undefined ? {} : { binaryPath }));
    this.builtinMcpServers =
      options.builtinMcpServers === undefined ? async (threadId, serverOptions) => [await this.moxenToolsFor(threadId, serverOptions?.delegated === true, serverOptions?.webFetch !== false, serverOptions?.memory ?? "write")] : options.builtinMcpServers;
    // Detached core failures (a throwing event subscriber, an abort-time
    // interrupt, a failed idle probe) have no caller to return them to:
    // they land in the server log, where the usage tick's own failures go.
    this.stopThreadFailureSink = onThreadFailure((area, message) => {
      void this.logThreadFailure(area, message);
    });
  }

  /**
   * One detached core failure in the server log. Each distinct line once,
   * like the usage tick's failures: a subscriber that throws on every
   * event is one bug, not one line per event.
   */
  private async logThreadFailure(area: string, message: string): Promise<void> {
    const key = `${area}: ${message}`;
    if (this.threadFailures.has(key)) return;
    this.threadFailures.add(key);
    await appendFile(path.join(this.storeRoot, "server.log"), `${new Date().toISOString()} ${key}\n`, "utf8").catch(() => undefined);
  }

  /** Where a memory request points: the thread's project, the project named, or neither (global alone). */
  private async memoryLocation(address: { readonly threadId?: string; readonly projectId?: string }): Promise<MemoryLocation> {
    if (address.threadId !== undefined) {
      const thread = await (await this.store()).readThreadRecord(address.threadId);
      if (!thread) throw new CliError("THREAD_NOT_FOUND", `Thread ${address.threadId} was not found.`, { exitCode: 4, details: { threadId: address.threadId } });
      return { storeRoot: this.storeRoot, projectId: thread.projectId || null };
    }
    return { storeRoot: this.storeRoot, projectId: address.projectId ?? null };
  }

  private async memoryEmbeddingsEnabled(location: MemoryLocation): Promise<boolean> {
    const config = await this.loadConfig();
    if (config.memory === false) return false;
    const project = location.projectId === null ? undefined : (await listStoredProjects(this.storeRoot)).find((entry) => entry.id === location.projectId);
    const root = project?.workspaceRoot ?? null;
    if (await projectMemorySetting(root) === false) return false;
    return (await projectMemorySetting(root, "memoryEmbeddings") ?? config.memoryEmbeddings) === true;
  }

  /**
   * Whether memory writes are allowed here. The global switch and the
   * project's own `moxen.json` gate agents, so they gate user writes too —
   * a write agents can never read back is refused rather than silently kept.
   * Reads stay allowed either way.
   */
  private async memoryWritable(location: MemoryLocation): Promise<boolean> {
    const config = await this.loadConfig();
    if (config.memory === false) return false;
    if (location.projectId === null) return true;
    const project = (await listStoredProjects(this.storeRoot)).find((entry) => entry.id === location.projectId);
    return (await projectMemorySetting(project?.workspaceRoot ?? null)) !== false;
  }

  private async requireMemoryWritable(location: MemoryLocation): Promise<void> {
    if (!(await this.memoryWritable(location))) {
      throw new CliError("MEMORY_DISABLED", "Memory is turned off.");
    }
  }

  private async applyEmbeddingPolicy(): Promise<void> {
    const config = await this.loadConfig();
    if (this.closed) return;
    const keep = config.memory !== false && config.memoryEmbeddings === true && config.memoryEmbeddingLoading !== "on-demand";
    this.embeddingRuntime.setKeepLoaded(keep);
    if (keep) await this.embeddingRuntime.warm();
  }

  private async setupEmbeddings(command: Extract<Command, { readonly type: "memory.embeddings.setup" | "memory.embeddings.rebuild" }>): Promise<{ readonly indexed: number }> {
    if (this.embeddingSetup) {
      const pending = this.embeddingSetup;
      await pending;
      if (this.embeddingSetup === pending) this.embeddingSetup = null;
      return await this.setupEmbeddings({ ...command, type: "memory.embeddings.rebuild" });
    }
    const generation = this.embeddingGeneration;
    this.embeddingSetup = (async () => {
      const config = await this.loadConfig();
      const location = await this.memoryLocation(command);
      const project = location.projectId === null ? undefined : (await listStoredProjects(this.storeRoot)).find((entry) => entry.id === location.projectId);
      if (config.memory === false || (!command.all && await projectMemorySetting(project?.workspaceRoot ?? null) === false)) {
        throw new CliError("MEMORY_DISABLED", "Memory is turned off.");
      }
      if (generation !== this.embeddingGeneration || this.closed) throw new Error("Memory indexing cancelled");
      if (command.type === "memory.embeddings.setup") {
        this.semanticMemory.cancel();
        await this.embeddingRuntime.setup();
        await this.embeddingRuntime.validate();
      }
      if (generation !== this.embeddingGeneration || this.closed) throw new Error("Memory indexing cancelled");
      let indexed = 0;
      this.embeddingRuntime.status = { ...this.embeddingRuntime.status, phase: "indexing" };
      if (command.all) {
        indexed = await this.semanticMemory.backfill({ storeRoot: this.storeRoot, projectId: null });
        for (const project of await listStoredProjects(this.storeRoot)) {
          if (this.closed || generation !== this.embeddingGeneration) throw new Error("Memory indexing cancelled");
          if (await projectMemorySetting(project.workspaceRoot) === false) continue;
          const memories = await listMemories({ storeRoot: this.storeRoot, projectId: project.id });
          await this.semanticMemory.backfill({ storeRoot: this.storeRoot, projectId: project.id });
          indexed += memories.filter((memory) => memory.scope === "project").length;
        }
      } else indexed = await this.semanticMemory.backfill(location);
      this.embeddingIndexed = indexed;
      this.embeddingRuntime.status = { ...this.embeddingRuntime.status, phase: "idle" };
      return { indexed };
    })();
    try { return await this.embeddingSetup; }
    catch (error) {
      const message = this.embeddingRuntime.status.state === "failed" ? this.embeddingRuntime.status.message : "Memory setup could not finish. Retry setup or use keyword memory.";
      this.embeddingRuntime.close();
      this.embeddingRuntime.status = { ...this.embeddingRuntime.status, state: "failed", phase: "idle", message };
      throw error;
    }
    finally { this.embeddingSetup = null; }
  }

  /**
   * The moxen tools for one thread. Its environment names this store (and
   * config and server mode) outright: providers hand MCP servers a filtered
   * environment (some do), and the tools must reach the same threads.
   */
  private async moxenToolsFor(threadId: string, delegated = false, webFetch = true, memory: MemoryAccess = "write"): Promise<McpServerSpec> {
    const researchRun = await readResearchRun(await this.context(), threadId);
    const researchLead = isResearchRunActive(researchRun) && researchRun?.leadThreadId === threadId;
    const imageGeneration = !delegated && (await this.imageAvailability(threadId)).available;
    const handoff = await pendingHandoff(await this.context(), threadId);
    // Hosted in this process: Claude calls the tools in-process, the other
    // providers over loopback HTTP served here — so a delegation always runs
    // in the process that owns its parent's session. Until the HTTP server
    // is up (or in a process that never starts it), the stdio child.
    const base = this.mcpHttp
      ? { name: MOXEN_MCP_SERVER_NAME, type: "http" as const, ...this.mcpHttp.specFor(threadId), alwaysLoad: true }
      : { ...this.moxenStdioFor(threadId), alwaysLoad: true };
    // A delegated task asks for the tools without the delegation ones; the server holds to it as well.
    const flags = [
      ...(delegated ? [{ query: MOXEN_DELEGATED_QUERY, arg: MOXEN_DELEGATED_ARG }] : []),
      ...(webFetch ? [] : [{ query: MOXEN_NO_WEB_FETCH_QUERY, arg: MOXEN_NO_WEB_FETCH_ARG }]),
      ...(memory === "write" ? [] : [{ query: `${MOXEN_MEMORY_QUERY}=${memory}`, arg: `${MOXEN_MEMORY_ARG}${memory}` }]),
    ];
    const fallback =
      flags.length === 0 ? base : base.type === "http" ? { ...base, url: `${base.url}?${flags.map((flag) => flag.query).join("&")}` } : { ...base, args: [...base.args, ...flags.map((flag) => flag.arg)] };
    // The same endpoint, also offering `todos`: for a provider with no checklist.
    const checklist =
      fallback.type === "http"
        ? { ...fallback, url: `${fallback.url}${fallback.url.includes("?") ? "&" : "?"}${MOXEN_CHECKLIST_QUERY}` }
        : { ...fallback, args: [...fallback.args, MOXEN_CHECKLIST_ARG] };
    return {
      name: MOXEN_MCP_SERVER_NAME,
      type: "in-process",
      instructions: moxenInstructions({ delegated, webFetch, memory }),
      tools: moxenToolsFor({ delegated, webFetch, memory, imageGeneration, handoff: handoff !== null, researchLead, researchMember: isResearchRunActive(researchRun) }),
      call: (tool, args) => callMoxenTool(this, threadId, tool, args, { delegated, webFetch, memory }),
      fallback,
      checklist,
      // Delegation is what these tools are for: never behind a tool search.
      alwaysLoad: true,
    };
  }

  private async imageAvailability(threadId: string): Promise<
    { readonly available: false; readonly reason: string } |
    { readonly available: true; readonly reason: null; readonly selection: ImageGenerationModel }
  > {
    const ctx = await this.context();
    const thread = await ctx.store.readThreadRecord(threadId);
    const unavailable = (reason: string) => ({ available: false as const, reason });
    if (!thread || thread.modelSelection.instanceId === "codex") return unavailable("Codex threads use their native image-generation tool.");
    const kind = driverKindOfInstance(thread.modelSelection.instanceId);
    if (!moxenToolsOf(kind === null ? undefined : ctx.config.providers?.[kind]).orchestration ||
        (await ctx.store.readDelegations()).some((row) => row.childThreadId === threadId)) return unavailable("Image generation is unavailable in delegated tasks or with orchestration switched off.");
    if (isNativeToolDisabled(ctx.config.providers?.codex?.disabledNativeTools, "image_generation", "codex")) return unavailable("Codex image generation is switched off.");
    try {
      const driver = this.driverFor("codex");
      if (!(driver instanceof CodexDriver)) return unavailable("The Codex driver cannot check image-generation eligibility.");
      const provider = (await this.providers()).find((entry) => entry.instanceId === "codex");
      if (!provider?.enabled || !provider.installed) return unavailable("Codex must be installed and enabled for image generation.");
      const selection = imageGenerationModel(provider.models);
      if (!selection) return unavailable("Image generation requires a released Luna model in Codex's catalog with a supported reasoning effort other than none.");
      const availability = await driver.withPeer(thread.env.path, imageGenerationAvailability);
      return availability.available ? { available: true, reason: null, selection } : unavailable(availability.reason!);
    }
    catch { return unavailable("Could not verify Codex subscription and usage; check Codex login and try again."); }
  }

  private async skillRoots(projectId?: string): Promise<SkillRoots> {
    if (projectId !== undefined) {
      const project = (await listStoredProjects(this.storeRoot)).find((entry) => entry.id === projectId);
      if (!project?.workspaceRoot) throw new CliError("PROJECT_NOT_FOUND", "Choose an existing project with a workspace to manage its skills.");
      return { agents: path.join(project.workspaceRoot, ".agents", "skills"), claude: path.join(project.workspaceRoot, ".claude", "skills") };
    }
    const config = await this.loadConfig();
    return { agents: path.join(os.homedir(), ".agents", "skills"), claude: path.join(resolveClaudeHomePath(config.providers?.claude?.homePath ?? ""), "skills") };
  }

  private moxenStdioFor(threadId: string): Extract<McpServerSpec, { type: "stdio" }> {
    const spec = moxenMcpServerSpec(threadId);
    const env: Record<string, string> = { ...spec.env, MOXEN_STORE_ROOT: this.storeRoot };
    for (const name of ["MOXEN_CONFIG", "MOXEN_SERVER", "MOXEN_SERVER_ENDPOINT"]) {
      const value = process.env[name];
      // A paired server's name in MOXEN_SERVER is this process's client
      // choice; the tools must reach the server that owns the thread.
      if (value && !(name === "MOXEN_SERVER" && remoteServerName() !== null)) env[name] = value;
    }
    return { ...spec, env };
  }

  /** Best-effort: a finished thread gives its worktree checkout back (the branch stays). */
  private async freeWorktree(thread: StoredThread): Promise<void> {
    await removeThreadWorktree(this.storeRoot, thread).catch(() => false);
  }

  /**
   * What the core operations run against. The store is opened once; the
   * config is read per operation, because a server outlives any one
   * command and a config edit must not need a restart to apply.
   */
  private async context(): Promise<OperationContext> {
    const [store, config] = await Promise.all([this.store(), this.loadConfig()]);
    return {
      store,
      storeRoot: this.storeRoot,
      config,
      driverFor: (instanceId: string) => this.driverFor(instanceId),
      ...(this.builtinMcpServers ? { builtinMcpServers: this.builtinMcpServers } : {}),
    };
  }

  /** A user-supplied size starts a run without a proposal. */
  async startResearchRun(request: DelegateRequest, size: ResearchSize) {
    return await this.dispatch({ type: "thread.delegate", ...request, interactionMode: "research", research: { ...request.research, size } });
  }

  /**
   * How long a user's own Research send waits for a client to listen for the
   * run-size question before parking it. The send can win the race against
   * the client's opt-in (`subscribeShell({ researchProposals })`); without
   * the wait the question would be parked even though a client is already
   * opening the thread.
   */
  private static readonly researchResponderWaitMs = 1_000;

  /** True once a client listens for this thread's run-size question (or the connection closed meanwhile). */
  private async awaitResearchResponder(threadId: string): Promise<boolean> {
    const start = Date.now();
    while (!this.closed && (this.researchResponders.get(threadId) ?? 0) <= 0) {
      if (Date.now() - start >= DirectConnection.researchResponderWaitMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !this.closed;
  }

  private async chooseResearch(
    threadId: string,
    task: string,
    target: ResearchProposal["target"],
    options: { suggested?: ResearchPlan; modelRequest?: ModelRequest; modelSelection?: ModelSelection } = {},
  ): Promise<ResearchPlan | null> {
    if (this.closed || !this.researchResponders.get(threadId)) return null;
    const thread = await (await this.store()).readThreadRecord(threadId);
    if (!thread || thread.researchRole || isResearchRunActive(thread.researchRun) || (await (await this.store()).readDelegations()).some((row) => row.childThreadId === threadId)) {
      throw new CliError("DELEGATION_REFUSED", "Only a user's own thread may propose a research run.");
    }
    const config = await this.loadConfig();
    const selection = options.modelSelection ?? followUpSelection(thread.modelSelection, config, options.modelRequest, task) ?? thread.modelSelection;
    const plan = resolveResearchPlan(selection, config, options.suggested ?? { size: { researchers: 2, critics: 1 } });
    // A delegation is a tool call, which cannot wait forever: it has a
    // user-answer deadline, not provider timing. `/research` in the user's own
    // thread has none while the client stays connected; a disconnect resolves it.
    const answerWindowMs = target === "delegation" ? 45_000 : null;
    const proposal: ResearchProposal = {
      id: randomUUID(), threadId, task, target, plan, leadModel: selection,
      expiresAt: answerWindowMs === null ? null : new Date(Date.now() + answerWindowMs).toISOString(),
    };
    return await new Promise((resolve) => {
      const timer = answerWindowMs === null ? null : setTimeout(() => answer(null), answerWindowMs);
      const answer = (chosen: ResearchPlan | null): void => {
        if (timer !== null) clearTimeout(timer);
        this.researchProposals.delete(proposal.id);
        this.researchRevision++;
        resolve(chosen);
      };
      this.researchProposals.set(proposal.id, { proposal, answer });
      this.researchRevision++;
      if (!this.researchResponders.get(threadId) || this.closed) answer(null);
    });
  }

  private expireResearchProposals(): void {
    for (const entry of this.researchProposals.values()) {
      if (entry.proposal.expiresAt !== null && Date.parse(entry.proposal.expiresAt) <= Date.now()) entry.answer(null);
    }
  }

  /**
   * A thread's checkout. Worktree threads have their own, so this is the
   * only correct place to resolve it: a client that guessed the project
   * root would read the wrong branch for half the threads open.
   */
  private async workspaceFor(threadId: string): Promise<string> {
    const store = await this.store();
    const thread = await store.readThreadRecord(threadId);
    if (!thread) throw new CliError("THREAD_NOT_FOUND", `No thread ${threadId}.`, { exitCode: 2 });
    return thread.env.path;
  }

  /** `root` when it is the thread's checkout or its project's root; anything else is refused. */
  private async liveRoot(threadId: string, root: string): Promise<string> {
    const store = await this.store();
    const thread = await store.readThreadRecord(threadId);
    if (!thread) throw new CliError("THREAD_NOT_FOUND", `No thread ${threadId}.`, { exitCode: 2 });
    const project = (await listStoredProjects(this.storeRoot)).find((entry) => entry.id === thread.projectId);
    const allowed = [thread.env.path, project?.workspaceRoot].filter((entry): entry is string => typeof entry === "string");
    if (!allowed.some((entry) => workspaceRootsEqual(entry, root))) {
      throw new CliError("WORKSPACE_OUTSIDE_THREAD", "That folder is not this thread's.", { details: { threadId } });
    }
    return root;
  }

  private async forgeFor(threadId: string, config: ForgeConfig | undefined): Promise<ForgeDetection> {
    return await detectForge(await this.workspaceFor(threadId), config);
  }

  /** Detection plus the checkout, for the three write commands. */
  private async forgeContext(threadId: string): Promise<{ cwd: string; detection: ForgeDetection }> {
    const config = await this.loadConfig();
    const cwd = await this.workspaceFor(threadId);
    return { cwd, detection: await detectForge(cwd, config.forge) };
  }

  /** A profile and one of its models. The test may name a model the profile does not list (it is sent as asked); a probe stores its findings on the entry, so it must be listed. */
  private async harnessModel(profileId: string, modelId: string | undefined, listed: boolean) {
    const { config, path } = await this.readConfigFile();
    const profile = config.providers?.harness?.profiles?.find((entry) => entry.id === profileId.toLowerCase());
    if (!profile) throw new CliError("PROVIDER_UNKNOWN", `No harness profile "${profileId}".`, { details: { profileId } });
    const model = modelId === undefined ? profile.models[0]! : (profile.models.find((entry) => entry.id === modelId) ?? (listed ? undefined : { id: modelId }));
    if (!model) throw new CliError("INVALID_CONFIG", `Profile "${profile.id}" does not list the model "${modelId}". Add it first.`, { details: { profileId: profile.id } });
    // A key kept in the keychain is read here, so the test or probe can send it.
    await primeProfileKey(profile);
    return { profile, model, config, path };
  }

  private async settingsSnapshot(): Promise<SettingsSnapshot> {
    const { config, path, exists } = await this.readConfigFile();
    return { path, exists, settings: describeSettings(config) };
  }

  /**
   * Config writes run one at a time per file: two `settings.set` at once
   * must not read the same file and revert each other. The path is peeked
   * first so concurrent writers to one file share a queue, then the queued
   * body re-reads, so it never writes from a stale read.
   */
  private async withConfigWrite<T>(write: () => Promise<T>): Promise<T> {
    const { path: configPath } = await this.readConfigFile();
    const key = path.resolve(configPath);
    const next = (configWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(write);
    configWrites.set(key, next);
    try {
      return await next;
    } finally {
      if (configWrites.get(key) === next) configWrites.delete(key);
    }
  }

  private async store(): Promise<ThreadStore> {
    if (!this.storePromise) this.storePromise = openThreadStore(this.storeRoot);
    return await this.storePromise;
  }

  /** Whether an update or rollback has landed since this server started. */
  get serverRestartRequired(): boolean {
    return this.restartPending;
  }

  /**
   * Take ownership of the store root for this process. The endpoint refuses
   * a second server on it, but two servers on different endpoints (or a
   * second checkout) can still open one store, where the per-thread
   * in-process locks protect nothing — so the store has one owning build,
   * recorded beside it. A live owner is refused, naming its build and pid;
   * a lock from a dead process is taken over. `close()` releases the claim.
   */
  async claimStore(): Promise<ThreadStore> {
    const store = await this.store();
    const file = path.join(this.storeRoot, STORE_LOCK_FILE);
    const own = buildIdentity();
    // Another connection in this process already owns it: refused without
    // touching the file, which stays that owner's to release.
    const known = claimedStores.get(this.storeRoot);
    if (known && known.token !== this.claimToken) {
      throw new CliError(
        "STORE_OWNED",
        `This store is owned by ${known.display} (process ${known.pid}); this server runs ${own.display}. Stop that server first, then start this one.`,
        { details: { storeRoot: this.storeRoot, owner: { display: known.display, pid: known.pid }, current: { build: own.id, pid: process.pid } } },
      );
    }
    const contents = `${JSON.stringify({ build: own.id, display: own.display, pid: process.pid, startedAt: new Date().toISOString() })}\n`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(file, "wx");
        await handle.writeFile(contents);
        await handle.close();
        claimedStores.set(this.storeRoot, { token: this.claimToken, display: own.display, pid: process.pid });
        return store;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const raw = await readFile(file, "utf8").catch(() => null);
      let lock: Partial<StoreLock> | null = null;
      try {
        lock = raw === null ? null : (JSON.parse(raw) as Partial<StoreLock>);
      } catch {
        lock = null;
      }
      const holder = typeof lock?.pid === "number" ? lock.pid : null;
      if (holder !== null && holder !== process.pid && processAlive(holder)) {
        const owner = typeof lock?.display === "string" && lock.display.length > 0 ? lock.display : "another server";
        throw new CliError(
          "STORE_OWNED",
          `This store is owned by ${owner} (process ${holder}); this server runs ${own.display}. Stop that server first, then start this one.`,
          { details: { storeRoot: this.storeRoot, owner: lock, current: { build: own.id, pid: process.pid } } },
        );
      }
      // Stale (its process is gone), corrupt, or this process's own: take it over.
      await rm(file, { force: true }).catch(() => undefined);
    }
    throw new CliError("STORE_OWNED", `Another moxen server just took the store at ${this.storeRoot}; stop it first, then start this one.`, {
      details: { storeRoot: this.storeRoot },
    });
  }

  /** Release the store claim, so the next server starts without meeting a stale lock. */
  private async releaseStore(): Promise<void> {
    // Only the owner releases: a refused second claimant shares this
    // process's pid, so pid alone cannot tell its close from the owner's —
    // without this, its close deletes the live owner's lock file.
    const owned = claimedStores.get(this.storeRoot)?.token === this.claimToken;
    if (!owned) return;
    claimedStores.delete(this.storeRoot);
    await rm(path.join(this.storeRoot, STORE_LOCK_FILE), { force: true }).catch(() => undefined);
  }

  private schedulingStarted = false;
  private mcpHttp: McpHttpServer | null = null;
  private readonly dueRunning = new Set<string>();
  private readonly onDue = (threadId: string): void => void this.runDue(threadId);

  /**
   * Become the process that runs scheduled turns: due timers call back here,
   * and every pending schedule on disk gets a timer. Only a process that
   * stays up does this — the shared server, or a client watching the shell —
   * never a one-shot CLI command.
   */
  startScheduling(): void {
    if (this.schedulingStarted || this.closed) return;
    this.schedulingStarted = true;
    for (const driver of this.ownedDrivers) this.usageSubscriptions.push(subscribeDriverUsage(driver, (event) => this.usageProtection.observe(event)));
    const usageTick = async (): Promise<void> => {
      if (this.closed || this.usageTickRunning) return;
      this.usageTickRunning = true;
      try { await this.usageProtection.tick(); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!this.usageFailures.has(message)) {
          this.usageFailures.add(message);
          await appendFile(path.join(this.storeRoot, "server.log"),
            `${new Date().toISOString()} usage protection: ${message}\n`, "utf8").catch(() => undefined);
        }
      }
      finally { this.usageTickRunning = false; }
    };
    this.usageTimer = setInterval(() => { void usageTick().catch(() => undefined); }, 2000);
    this.usageTimer.unref?.();
    void usageTick().catch(() => undefined);
    onScheduledTurnDue(this.onDue);
    void this.context()
      .then((ctx) => armPendingScheduledTurns(ctx))
      .catch(() => undefined);
    // A restart inside a task notification's batch window left its batch on
    // disk: deliver it now, once, rather than losing it.
    void this.context()
      .then((ctx) => recoverTaskNotifications(ctx))
      .catch(() => undefined);
    // Finished worktree threads give their checkouts and merged branches back: now, then every few hours.
    void this.pruneFinished();
    this.pruneTimer = setInterval(() => void this.pruneFinished(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
    // The same long-lived owner serves the moxen tools over loopback HTTP
    // for providers that cannot host them in-process.
    if (this.builtinMcpServers !== null) {
      void startMcpHttpServer(this)
        .then((server) => {
          if (this.closed) void server.close();
          else this.mcpHttp = server;
        })
        .catch(() => undefined);
    }
  }

  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  private async pruneFinished(): Promise<void> {
    try {
      const ctx = await this.context();
      await pruneFinishedWorktrees({ store: ctx.store, storeRoot: this.storeRoot, config: ctx.config });
    } catch {
      // Housekeeping only; the next round tries again.
    }
  }

  private async runDue(threadId: string): Promise<void> {
    if (this.closed || this.dueRunning.has(threadId)) return;
    this.dueRunning.add(threadId);
    try {
      const ctx = await this.context();
      await runDueScheduledTurn(ctx, threadId, Date.now(), await this.usageProtection.snapshotRows(ctx));
    } catch {
      // The turn stays queued; the next poll or timer tries again.
    } finally {
      this.dueRunning.delete(threadId);
    }
  }

  private driverFor(instanceId: string): TurnDriver {
    // `driverFor` is synchronous and config reads are not, so it uses the
    // copy the last operation loaded. Every path that reaches a driver
    // goes through `context()` first, so this is never staler than the
    // operation asking for it.
    const driver = driverForInstance(this.driversOwner, instanceId, this.factories, this.lastProviders);
    // The harness reads its profiles on every turn, so it is handed the config this operation saw.
    // Profiles are edited while the server runs; the harness driver reads its config on every use.
    if (driver instanceof HarnessDriver) driver.setConfig(this.lastProviders?.harness, this.lastWeb);
    if (this.schedulingStarted && !this.ownedDrivers.has(driver)) this.usageSubscriptions.push(subscribeDriverUsage(driver, (event) => this.usageProtection.observe(event)));
    this.ownedDrivers.add(driver);
    return driver;
  }

  /**
   * Explicit freshness ask behind `usage_status`: every owned driver re-reads
   * its subscription windows where that is cheap (an open session or live
   * connection - never a new session, never a model call), in parallel, and
   * a probe that lands is recorded under its key. Each probe races its own
   * deadline, so one hung or slow driver cannot stall the rest: what lands is
   * recorded, the round returns a partial snapshot, and one driver's failure
   * never stops the rest. Drivers with nothing cheap to read sit the round out.
   */
  private async refreshUsageWindows(): Promise<Record<string, ProviderUsageLimits>> {
    await Promise.allSettled(
      [...this.ownedDrivers].map(async (driver) => {
        // Records on landing, even past the deadline: the round answers from
        // the partial snapshot, and a late probe freshens the next call.
        const landed = (async () => await driver.refreshUsage?.())().then(
          (refreshed) => {
            if (refreshed && refreshed.windows.length > 0) recordUsageWindows(refreshed.key, refreshed.windows);
            return refreshed;
          },
          () => null,
        );
        const deadline = new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), USAGE_DRIVER_PROBE_TIMEOUT_MS);
          timer.unref?.();
        });
        await Promise.race([landed, deadline]);
      }),
    );
    return usageLimitsSnapshot();
  }

  // -- subscriptions -------------------------------------------------------

  subscribeShell(
    options: { afterSequence?: number; researchProposals?: readonly string[] },
    onItem: (item: ShellFrame) => void,
    onError: (error: unknown) => void,
  ): () => void {
    const answering = new Set(options.researchProposals ?? []);
    for (const threadId of answering) this.researchResponders.set(threadId, (this.researchResponders.get(threadId) ?? 0) + 1);
    let lastHash: string | null = null;
    // What the store and the project list looked like when `lastHash` was
    // taken, and when the next scheduled turn comes due. While the first
    // holds and the second has not passed, the rows cannot have changed:
    // skip the read of every thread's turns (and the stringify of them all).
    let lastFingerprint: string | null = null;
    let nextDueAt = Number.POSITIVE_INFINITY;
    // Turns ledgers are megabytes on long threads: reread one only when its
    // version moved, reusing the last read for idle history otherwise, so the
    // cost of a poll no longer grows with idle threads. Records stay fresh
    // from `listThreads` every poll (small files), and envelopes are rebuilt
    // from them, so renames, delegation and research runs still update.
    const turnCache = new Map<string, { version: string; turns: StoredTurn[] }>();
    let stopped = false;
    let polling = false;
    this.startScheduling();
    const onUpdateFrame = (frame: ShellFrame): void => {
      if (!stopped && !this.closed) onItem(frame);
    };
    this.updateListeners.add(onUpdateFrame);
    const poll = async (): Promise<void> => {
      if (stopped || this.closed || polling) return;
      polling = true;
      try {
        const store = await this.store();
        const [version, projects] = await Promise.all([store.shellVersion(), listStoredProjects(this.storeRoot)]);
        if (stopped || this.closed) return;
        const fingerprint = `${version}#${this.researchRevision}#${JSON.stringify(projects)}`;
        if (fingerprint === lastFingerprint && Date.now() < nextDueAt) return;
        const threads = await listThreads(store, { status: "all" });
        const now = Date.now();
        nextDueAt = Number.POSITIVE_INFINITY;
        // Who delegated whom: the sidebar nests a task under its parent.
        const parents = new Map((await store.readDelegations().catch(() => [])).map((row) => [row.childThreadId, row.parentThreadId] as const));
        const seen = new Set<string>();
        const rows = await Promise.all(
          threads.map(async (entry) => {
            seen.add(entry.id);
            // Only the changed ledgers are reread: `threadVersion` stats five
            // small files, while `readTurns` parses megabytes of history.
            const version = await store.threadVersion(entry.id);
            const cached = turnCache.get(entry.id);
            const turns = cached && cached.version === version ? cached.turns : await store.readTurns(entry.id);
            if (!cached || cached.version !== version) turnCache.set(entry.id, { version, turns });
            // This poll already reads every changed thread's turns: a scheduled turn
            // that came due — even one another process scheduled — starts here.
            if (turns.some((turn) => turn.status === "queued" && typeof turn.scheduledFor === "string" && Date.parse(turn.scheduledFor) <= now)) {
              void this.runDue(entry.id);
            }
            for (const turn of turns) {
              if (turn.status === "queued" && typeof turn.scheduledFor === "string") {
                // One already due that is still queued is retried every poll, as before.
                const due = Math.max(Date.parse(turn.scheduledFor), now);
                if (due < nextDueAt) nextDueAt = due;
              }
            }
            // Threads from before the record kept its native subagents get
            // the list folded from their ledger once; the next poll shows it.
            if (entry.nativeSubagents === undefined) void backfillNativeSubagents(store, entry.id);
            return toThreadEnvelope(entry, turns, { parentThreadId: parents.get(entry.id) });
          }),
        );
        for (const id of [...turnCache.keys()]) if (!seen.has(id)) turnCache.delete(id);
        const visible = rows.filter(isVisibleThread);
        const researchRuns = threads.flatMap((thread) => [...(thread.pastResearchRuns ?? []), ...(thread.researchRun ? [thread.researchRun] : [])]);
        const researchProposals = [...this.researchProposals.values()].map((entry) => entry.proposal).filter((proposal) => answering.has(proposal.threadId));
        lastFingerprint = fingerprint;
        const hash = JSON.stringify({ projects, threads: visible, researchRuns, researchProposals });
        if (!stopped && !this.closed && hash !== lastHash) {
          lastHash = hash;
          onItem({
            kind: "snapshot",
            snapshot: { snapshotSequence: 0, projects, threads: visible, ...(researchRuns.length ? { researchRuns } : {}), ...(answering.size ? { researchProposals } : {}) },
          });
        }
      } catch (cause) {
        if (!stopped && !this.closed) onError(cause);
      } finally {
        polling = false;
      }
    };
    void poll().then(() => {
      if (!stopped && !this.closed) onItem({ kind: "synchronized" });
    });
    const timer = setInterval(() => void poll(), this.shellPollMs);
    this.pollTimers.add(timer);
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.pollTimers.delete(timer);
      this.updateListeners.delete(onUpdateFrame);
      for (const threadId of answering) {
        const count = (this.researchResponders.get(threadId) ?? 1) - 1;
        if (count) this.researchResponders.set(threadId, count);
        else {
          this.researchResponders.delete(threadId);
          for (const entry of this.researchProposals.values()) if (entry.proposal.threadId === threadId) entry.answer(null);
        }
      }
    };
  }

  subscribeThread(
    threadId: string,
    _options: { afterSequence?: number },
    onItem: (item: ThreadFrame) => void,
    onError: (error: unknown) => void,
  ): () => void {
    let lastHash: string | null = null;
    // What the store looked like when `lastHash` was taken: while it holds
    // there is nothing new to read, hash or send.
    let lastVersion: string | null = null;
    let stopped = false;
    let polling = false;
    // A thread created just after its view opens is still that view's
    // thread: the first poll says it is missing, later polls send it.
    let firstPoll = true;
    // When each streamed message first appeared: its place in the
    // timeline, between the tool calls around it.
    const firstSeen = new Map<string, string>();
    // The stored turn now running. Driver events carry the *driver's* turn
    // id, which no stored row shares; streamed text must group with the turn
    // the transcript shows.
    let runningTurnId: string | null = null;
    const poll = async (): Promise<void> => {
      if (stopped || this.closed || polling) return;
      polling = true;
      try {
        // The poll runs every few hundred ms for as long as the thread is
        // open, and a long thread's ledgers are megabytes: read, parse and
        // stringify them only when a stat says something was written.
        // (Recovering an orphaned turn comes first — it is what writes.)
        await recoverOrphanedTurn(await this.context(), threadId);
        const version = await (await this.store()).threadVersion(threadId);
        if (stopped || this.closed) return;
        if (version === lastVersion) return;
        const detail = await this.threadDetail(threadId);
        if (!detail) {
          lastVersion = version;
          if (firstPoll && !stopped && !this.closed) {
            onError(new CliError("THREAD_NOT_FOUND", `No thread exists with id ${threadId}.`, { exitCode: 3, details: { threadId } }));
          }
          firstPoll = false;
          return;
        }
        firstPoll = false;
        lastVersion = version;
        const latest = detail.latestTurn;
        runningTurnId = latest && latest.state === "running" ? latest.turnId : null;
        const hash = JSON.stringify(detail);
        if (!stopped && !this.closed && hash !== lastHash) {
          lastHash = hash;
          onItem({ kind: "snapshot", snapshot: { snapshotSequence: 0, thread: detail } });
        }
      } catch (cause) {
        if (!stopped && !this.closed) onError(cause);
      } finally {
        polling = false;
      }
    };
    // Live assistant text only. Tool calls are *not* recorded here: the
    // turn runner already writes them to the activity ledger with their
    // full payload (`threads/toolactivity.ts`), and the poll above picks
    // them up. A second recorder on this path wrote a payload-less row per
    // event — undeduped, and with no `toolCallId` for the transcript to
    // fold — so any turn run with the TUI attached got bare rows beside
    // the real tool cards.
    const onEvent = (event: ProviderRuntimeEvent): void => {
      if (stopped || this.closed) return;
      if (event.type === "message.part.updated") {
        // Each event is a delta of one assistant message. It streams under
        // the id the message is stored with if it turns out to be a note
        // (`noteMessageId`), so the stored row replaces the stream in place.
        const turnId = runningTurnId ?? event.turnId;
        if (!turnId || event.text.length === 0) return;
        const id = noteMessageId(turnId, event.messageId ?? "message");
        const now = new Date().toISOString();
        const createdAt = firstSeen.get(id) ?? now;
        firstSeen.set(id, createdAt);
        onItem({
          kind: "event",
          event: {
            type: "thread.message-sent",
            payload: {
              message: { id, role: "assistant", text: event.text, turnId, streaming: true, createdAt, updatedAt: now },
            },
          },
        });
        return;
      }
      if (event.type === "reasoning.delta" && event.text.length > 0) {
        // Same `toolCallId` as the runner's reasoning rows, so the client
        // shows the text in the row it already has for this thought.
        onItem({
          kind: "event",
          event: {
            type: "thread.reasoning-delta",
            payload: { toolCallId: `reasoning:${event.reasoningId}`, turnId: runningTurnId ?? event.turnId, text: event.text },
          },
        });
      }
    };
    // A thread opened mid-turn: replay what the provider streamed before this
    // subscription existed, through the same path live events take, so the
    // message keeps its place (`firstAt`) and the thought its text.
    const replayLiveText = (driver: Parameters<typeof liveTurnText>[0]): void => {
      // Buffered text belongs to a turn that is still running. With none, it is
      // a finished turn's reply, already in the snapshot just sent: replaying
      // it after that snapshot left the reply on screen twice — the streamed
      // copy under the provider's id, the stored one under the store's — and
      // nothing changes the store afterwards to take the stray copy away.
      if (runningTurnId === null) return;
      const live = liveTurnText(driver, threadId);
      if (!live) return;
      for (const message of live.messages) {
        const turnId = runningTurnId;
        firstSeen.set(noteMessageId(turnId, message.id), message.firstAt);
        onEvent({ type: "message.part.updated", provider: live.provider, threadId, turnId, messageId: message.id, text: message.text } as ProviderRuntimeEvent);
      }
      for (const thought of live.reasoning) {
        onEvent({ type: "reasoning.delta", provider: live.provider, threadId, turnId: thought.turnId, reasoningId: thought.id, text: thought.text } as ProviderRuntimeEvent);
      }
    };
    // The bridge attaches lazily per active driver session: poll for a
    // session and subscribe once it exists, so events flow even when the
    // turn was started elsewhere (CLI) while the TUI watches.
    let unsubscribeBridge: (() => void) | null = null;
    let attachingBridge = false;
    const ensureBridge = async (): Promise<void> => {
      if (stopped || this.closed || unsubscribeBridge || attachingBridge) return;
      attachingBridge = true;
      try {
        const store = await this.store();
        const thread = await store.readThreadRecord(threadId).catch(() => null);
        if (!thread) return;
        // The last poll's idea of the running turn can be a poll behind; the
        // replay below must not present a settled turn's text as live.
        const running = (await store.readTurns(threadId).catch(() => [])).find((turn) => turn.status === "running") ?? null;
        runningTurnId = running?.id ?? null;
        const driver = this.driverFor(thread.modelSelection.instanceId);
        const hasSession = await Effect.runPromise(driver.hasSession(threadId)).catch(() => false);
        if (!hasSession || stopped || this.closed) return;
        unsubscribeBridge = subscribeDriverThread(driver, threadId, onEvent);
        // Same tick as the subscribe: nothing slips between what the turn had
        // already streamed (while this thread was not open) and what follows.
        replayLiveText(driver);
      } catch {
        // Retry on the next poll.
      } finally {
        attachingBridge = false;
      }
    };
    void poll().then(() => {
      if (!stopped && !this.closed) {
        onItem({ kind: "synchronized" });
        void ensureBridge();
      }
    });
    const timer = setInterval(() => {
      void poll();
      void ensureBridge();
    }, this.threadPollMs);
    this.pollTimers.add(timer);
    return () => {
      stopped = true;
      clearInterval(timer);
      this.pollTimers.delete(timer);
      unsubscribeBridge?.();
    };
  }

  private async threadDetail(threadId: string): Promise<ThreadEnvelope | null> {
    const store = await this.store();
    const read = await readThread(store, threadId, { view: "messages" }).catch(() => null);
    if (!read) return null;
    return { ...toThreadEnvelope(read.thread, read.turns, {
      messages: read.messages,
      activities: read.activities,
      checkpoints: await this.withCheckpointFiles(read.thread.env.path, read.checkpoints),
    }), turnThroughput: turnThroughput(read.turns) };
  }

  /**
   * Checkpoints written before turns recorded their changed files get them
   * from git here — once per ref pair, since a capture never changes — so
   * older turns still show their diff row. A ref already pruned reads as
   * no files.
   */
  private async withCheckpointFiles(cwd: string | null | undefined, checkpoints: StoredCheckpoint[]): Promise<StoredCheckpoint[]> {
    if (!cwd) return checkpoints;
    return await Promise.all(
      checkpoints.map(async (checkpoint) => {
        const { ref, baseRef } = checkpoint;
        if (checkpoint.files !== undefined || checkpoint.status !== "available" || !ref || !baseRef) return checkpoint;
        const key = `${baseRef}..${ref}`;
        let files = this.checkpointFiles.get(key);
        if (files === undefined) {
          files = await diffCheckpointStat(cwd, baseRef, ref);
          this.checkpointFiles.set(key, files);
        }
        return { ...checkpoint, files };
      }),
    );
  }

  // -- dispatch --------------------------------------------------------------

  /**
   * Typed callers are checked at compile time; the argument is decoded
   * anyway, because not every caller is typed — a transport hands this
   * whatever arrived on the wire — and decoding is also where defaults
   * (runtime mode, interaction mode) are applied.
   */
  /**
   * What an update here needs: progress goes to shell subscribers tagged with the command's id, and the version
   * this server runs is never pruned (an update elsewhere could not know it, which is why this runs in the server).
   */
  private updateOptions(commandId: string | undefined): UpdateOptions {
    const onProgress = (progress: UpdateProgress): void => {
      const frame: ShellFrame = { kind: "event", event: { type: "app.update-progress", payload: { commandId: commandId ?? null, progress } } };
      for (const listener of this.updateListeners) listener(frame);
    };
    return { onProgress, runningVersions: async () => [readInstall().version] };
  }

  /**
   * After an update or rollback lands, every shell subscriber is told the
   * server needs a restart: the running code is stale, and only the client
   * that started it follows the progress. New clients learn it from the
   * hello (or hit another build's mismatch); this reaches the ones already
   * connected.
   */
  private announceRestart(version: string, from: string | null): void {
    this.restartPending = true;
    const frame: ShellFrame = { kind: "event", event: { type: "app.server-restart-required", payload: { version, from } } };
    for (const listener of this.updateListeners) listener(frame);
  }

  async dispatch<T extends CommandType>(command: CommandOf<T>, options?: { signal?: AbortSignal }): Promise<CommandResult<T>> {
    if (this.closed) throw new CliError("CONNECTION_CLOSED", "The direct connection is closed.");
    const decoded = decodeCommand(command);
    const result = await this.run(decoded, options?.signal);
    if (decoded.type === "memory.save" || decoded.type === "memory.edit" || decoded.type === "memory.append" || decoded.type === "memory.delete" || decoded.type === "memory.import-claude") {
      // Writes remain available even when native setup or inference failed.
      const generation = this.embeddingGeneration;
      void this.memoryLocation(decoded).then(async (location) => {
        const enabled = await this.memoryEmbeddingsEnabled(location);
        if (!this.closed && generation === this.embeddingGeneration && enabled && this.embeddingSetup === null) await this.semanticMemory.backfill(location);
      }).catch(() => undefined);
    }
    return result as CommandResult<T>;
  }

  private async run(command: Command, signal?: AbortSignal): Promise<CommandResult> {
    const accepted = { accepted: true } as const;
    switch (command.type) {
      case "skills.import":
        return await importManagedSkill(await this.skillRoots(command.projectId), command.source, command.from);
      case "skills.save":
        await saveManagedSkill(await this.skillRoots(command.projectId), command, command.text, command.previous);
        return accepted;
      case "skills.enabled.set":
        await setManagedSkillEnabled(await this.skillRoots(command.projectId), command, command.enabled);
        return accepted;
      case "skills.providers.set":
        await setManagedSkillProviders(await this.skillRoots(command.projectId), command, command.providers);
        return accepted;
      case "skills.remove":
        return await removeManagedSkill(await this.skillRoots(command.projectId), command);
      case "memory.embeddings.setup":
      case "memory.embeddings.rebuild":
        return await this.setupEmbeddings(command);
      case "memory.embeddings.unload":
        this.embeddingGeneration++;
        this.semanticMemory.cancel();
        this.embeddingRuntime.close();
        return accepted;
      case "project.create":
        return await this.projectCreate(command);
      case "thread.create":
        return await this.threadCreate(command);
      case "thread.turn.start":
        return await this.turnStart(command, signal);
      case "thread.turn.interrupt": {
        const store = await this.store();
        // Cancelling a queued usage-reset continue ends the automatic
        // continue, not a running turn: a delegated task is marked cancelled
        // and its parent told, unless asked not to.
        const turns = await store.readTurns(command.threadId).catch(() => []);
        const target = command.turnId === undefined ? null : (turns.find((turn) => turn.id === command.turnId) ?? null);
        const result = await interruptTurn(store, command.threadId, command.turnId);
        if (result.interrupted && target !== null && target.status === "queued" && target.scheduleReason === "usage-reset") {
          await noteAutoContinueCancelled(await this.context(), command.threadId, { notifyParent: command.notifyParent }).catch(() => undefined);
        }
        return accepted;
      }
      case "usage.wrap":
        await this.usageProtection.wrap(command.provider);
        return accepted;
      case "thread.protect":
        await this.usageProtection.protect(command.threadId);
        return accepted;
      case "queue.edit":
        await editWorkQueue(await this.context(), command.threadId, command.turnId, command.action, command.policy, command.notifyParent);
        return accepted;
      case "handoff.submit":
        await submitHandoff(await this.context(), command.threadId, command.requestId, command.summary);
        return accepted;
      case "usage.queue":
        await this.usageProtection.reorder(command.threadId, command.direction, command.notifyParent ?? true);
        return accepted;
      case "thread.settle":
        await settleThread(await this.store(), command.threadId, command.stop === true ? { stop: true } : {});
        // A settle can release notices queued while the thread was held; they go out now, together.
        await flushTaskNotifications(await this.context(), command.threadId).catch(() => undefined);
        return accepted;
      case "thread.unsettle":
        await unsettleThread(await this.store(), command.threadId);
        return accepted;
      case "thread.snooze":
        await snoozeThread(await this.store(), command.threadId, command.snoozedUntil);
        return accepted;
      case "thread.unsnooze":
        await unsnoozeThread(await this.store(), command.threadId);
        return accepted;
      case "thread.archive":
        await this.freeWorktree(await archiveThread(await this.store(), command.threadId));
        return accepted;
      case "thread.delete":
        {
          const deleted = await deleteThread(await this.store(), command.threadId);
          await this.freeWorktree(deleted);
          await removeScratchDir(this.storeRoot, deleted.env.path).catch(() => false);
        }
        return accepted;
      case "thread.meta.update":
        if (command.title !== undefined) await retitleThread(await this.context(), command.threadId, { title: command.title });
        else if (command.regenerateTitle === true) await retitleThread(await this.context(), command.threadId, { regenerate: true });
        return accepted;
      case "thread.model-selection.set":
        await updateThreadMeta(await this.store(), command.threadId, { modelSelection: command.modelSelection });
        return accepted;
      case "thread.runtime-mode.set":
        await updateThreadMeta(await this.store(), command.threadId, { runtimeMode: command.runtimeMode });
        // A session that is already open follows it too: a running turn from its next tool call.
        {
          const thread = await (await this.store()).readThreadRecord(command.threadId).catch(() => null);
          if (thread) this.driverFor(thread.modelSelection.instanceId).setRuntimeMode?.(command.threadId, command.runtimeMode);
        }
        return accepted;
      case "thread.interaction-mode.set":
        await updateThreadMeta(await this.store(), command.threadId, { interactionMode: command.interactionMode });
        return accepted;
      case "thread.user-input.respond":
        await this.userInputRespond(command.threadId, command.requestId, command.answers);
        return accepted;
      case "thread.user-input.dismiss":
        await this.userInputDismiss(command.threadId, command.requestId);
        return accepted;
      case "thread.permission.respond":
        await this.permissionRespond(command.threadId, command.requestId, command.decision);
        return accepted;
      case "app.update.apply": {
        const result = await this.updateApp(this.updateOptions(command.commandId));
        if (result.action === "updated") this.announceRestart(result.version, result.from);
        return result;
      }
      case "app.update.rollback": {
        const result = await this.rollbackApp(this.updateOptions(command.commandId));
        this.announceRestart(result.version, result.from);
        return result;
      }
      case "thread.handover": {
        const { type: _type, commandId: _id, wait, ...request } = command;
        const result = await handover(await this.context(), request);
        return { ...result, started: result.started ? await this.settle(result.started, wait === true, signal) : null };
      }
      case "thread.delegate": {
        const { type: _type, commandId: _id, ...request } = command;
        if (request.researchProposal && request.interactionMode !== "research") {
          throw new CliError("INVALID_THREAD_OPTION", "A research proposal requires Research mode.");
        }
        const research = request.research ?? (request.researchProposal && !request.dryRun
          ? await this.chooseResearch(request.parentThreadId, request.task, "delegation", { suggested: request.researchProposal, modelRequest: request }) : null);
        if (this.closed) throw new CliError("CONNECTION_CLOSED", "The server closed before research could start.");
        return await delegate(await this.context(), { ...request, ...(research ? { research } : {}) });
      }
      case "research.proposal.answer": {
        this.expireResearchProposals();
        const pending = this.researchProposals.get(command.proposalId);
        if (!pending) throw new CliError("RESEARCH_PROPOSAL_EXPIRED", "This research proposal is no longer pending.");
        pending.answer(command.choice === "start" ? command.plan : null);
        return accepted;
      }
      case "research.role.start":
        return await startResearchRole(await this.context(), command);
      case "research.message.submit":
        return await submitResearchMessage(await this.context(), command.threadId, command.text);
      case "research.role.cancel": {
        const ctx = await this.context();
        await requireResearchRole(ctx, command.leadThreadId, command.taskId);
        return await cancelTask(ctx, command.leadThreadId, command.taskId);
      }
      case "thread.image.generate": {
        const availability = await this.imageAvailability(command.parentThreadId);
        if (!availability.available) throw new CliError("IMAGE_GENERATION_UNAVAILABLE", availability.reason!);
        const references = command.references ?? [];
        if (references.length > 5 || references.some((file) => !path.isAbsolute(file))) throw new CliError("INVALID_THREAD_OPTION", "Reference images must be at most five absolute paths.");
        const task = [
          "Generate or edit an image using your native image_generation tool. Do not draw it with code, use another service, change source files, or commit anything. If generation is unavailable or fails, report the failure without substituting another approach.",
          "Save the generated image and report its absolute file path. Only actual image-generation results count as success.",
          ...(references.length ? ["Reference image paths (read these before editing):", ...references.map((file) => JSON.stringify(file))] : []),
          "Image request:", command.prompt,
        ].join("\n\n");
        return await delegate(await this.context(), { parentThreadId: command.parentThreadId, task, title: "Image generation", provider: "codex", ...availability.selection, isolation: "shared", wait: false }, { hidden: true });
      }
      case "thread.task.cancel":
        return await cancelTask(await this.context(), command.parentThreadId, command.taskId, { notifyParent: command.notifyParent });
      case "thread.task.settle":
        return await settleTask(await this.context(), command.parentThreadId, command.taskId, {
          ...(command.stop === true ? { stop: true } : {}),
          ...(command.removeWorktree === true ? { removeWorktree: true } : {}),
        });
      case "thread.task.send":
        return await sendTaskMessage(await this.context(), command.parentThreadId, command.taskId, command.message, command.wake === true);
      case "thread.task.ask":
        return await this.taskAsk(command);
      case "thread.message.queue": {
        const ctx = await this.context();
        return await queueAgentMessage(ctx, command.callerThreadId, { message: command.message, ...(command.threadId !== undefined ? { threadId: command.threadId } : {}), ...(command.at !== undefined ? { at: command.at } : {}), ...(command.conditions ? { conditions: command.conditions } : {}) }, await this.usageProtection.snapshotRows(ctx));
      }
      case "thread.plan.set":
        return await recordChecklist(await this.context(), command.threadId, command.plan);
      case "thread.background.stop": {
        const driver = await this.sessionDriver(command.threadId);
        if (!driver?.stopBackgroundTask) {
          throw new CliError(
            "REQUEST_NOT_OWNED",
            `Thread ${command.threadId} has no live session here to stop background work in. Its session runs in another process; start a shared server (moxen server start) so every client can reach it.`,
            { exitCode: 4, details: { threadId: command.threadId } },
          );
        }
        await Effect.runPromise(driver.stopBackgroundTask(command.threadId, command.taskId));
        return { stopped: true as const, taskId: command.taskId };
      }
      case "project.ensure": {
        const { type: _type, commandId: _id, ...request } = command;
        return await ensureProject(await this.context(), request);
      }
      case "model.visibility.set":
        return { hidden: await setModelHidden(this.storeRoot, command.instanceId, command.model, command.hidden) };
      case "memory.save": {
        const location = await this.memoryLocation(command);
        await this.requireMemoryWritable(location);
        return await saveMemory(location, {
          name: command.name,
          description: command.description,
          type: command.memoryType,
          body: command.body,
          scope: command.scope,
        });
      }
      case "memory.edit": {
        const location = await this.memoryLocation(command);
        await this.requireMemoryWritable(location);
        return await editMemory(location, { name: command.name, scope: command.scope, oldText: command.oldText, newText: command.newText, description: command.description });
      }
      case "memory.append": {
        const location = await this.memoryLocation(command);
        await this.requireMemoryWritable(location);
        return await appendMemory(location, { name: command.name, scope: command.scope, text: command.text });
      }
      case "memory.delete": {
        const location = await this.memoryLocation(command);
        await this.requireMemoryWritable(location);
        return await deleteMemory(location, command.name, command.scope);
      }
      case "memory.import-claude": {
        const location = await this.memoryLocation(command);
        await this.requireMemoryWritable(location);
        const project = location.projectId === null ? undefined : (await listStoredProjects(this.storeRoot)).find((entry) => entry.id === location.projectId);
        if (project === undefined || project.scratch === true) {
          throw new CliError("MEMORY_PROJECT_REQUIRED", "Importing Claude Code's memory needs a project: its memory is kept per folder.", { exitCode: 2 });
        }
        const config = await this.loadConfig();
        const from = claudeMemoryDir(resolveClaudeHomePath(config.providers?.claude?.homePath ?? ""), project.workspaceRoot);
        return await importClaudeMemories(location, from);
      }
      case "forge.request.create": {
        const { cwd, detection } = await this.forgeContext(command.threadId);
        const created = await createRequest(cwd, detection, {
          title: command.title,
          ...(command.body !== undefined ? { body: command.body } : {}),
          ...(command.targetBranch !== undefined ? { targetBranch: command.targetBranch } : {}),
          ...(command.sourceBranch !== undefined ? { sourceBranch: command.sourceBranch } : {}),
          ...(command.draft !== undefined ? { draft: command.draft } : {}),
        });
        return { ...created, accepted: true };
      }
      case "forge.request.comment": {
        const { cwd, detection } = await this.forgeContext(command.threadId);
        await commentOnRequest(cwd, detection, command.number, command.body);
        return accepted;
      }
      case "forge.request.merge": {
        const { cwd, detection } = await this.forgeContext(command.threadId);
        await mergeRequest(cwd, detection, command.number, {
          ...(command.strategy !== undefined ? { strategy: command.strategy } : {}),
          ...(command.deleteBranch !== undefined ? { deleteBranch: command.deleteBranch } : {}),
        });
        return accepted;
      }
      case "thread.continue":
        return await this.continueThread(command);
      case "thread.continue-agent":
        return await this.continueAgentThread(command);
      case "thread.side-question":
        return await this.sideQuestion(command);
      case "prompt.improve":
        return await improvePrompt(await this.loadConfig(), command, async (input, selection) => {
          const driver = this.driverFor(selection.instanceId);
          if (!driver.completeText) throw new CliError("PROMPT_IMPROVER_UNAVAILABLE", `${selection.provider}/${selection.model} cannot run a completion without tools, so it cannot improve a draft. Your original draft is unchanged. Choose a Claude Code or OpenCode model in the prompt improver settings (promptImprover.provider, promptImprover.model).`);
          return await driver.completeText(input);
        });
      case "remote.pairing.start":
        return this.requireRemoteAccess().startPairing();
      case "remote.pairing.cancel":
        this.remoteAccess?.cancelPairing();
        return accepted;
      case "remote.device.revoke":
        // Without a server there are no sockets to drop, but the device can still be forgotten.
        if (this.remoteAccess) await this.remoteAccess.revoke(command.deviceId);
        else if (!(await new DeviceRegistry().revoke(command.deviceId))) {
          throw new CliError("REMOTE_DEVICE_NOT_FOUND", `No paired device ${command.deviceId}.`, { details: { deviceId: command.deviceId } });
        }
        return accepted;
      case "experience.update":
        return await updateExperience(this.storeRoot, command);
      case "settings.set": {
        if (command.key === "memoryEmbeddings") {
          // Enabling downloads and validates a model, which takes minutes:
          // it runs outside the write queue so other clients keep writing
          // meanwhile, and the queued write below re-reads first.
          const enabling = (await setConfigValueSecure((await this.readConfigFile()).config, command.key, command.value)).memoryEmbeddings === true;
          if (enabling) {
            try {
              await this.setupEmbeddings({ type: "memory.embeddings.setup", all: true });
            } catch (error) {
              await this.withConfigWrite(async () => {
                const { config, path } = await this.readConfigFile();
                await saveConfig(path, await setConfigValueSecure(config, "memoryEmbeddings", "false"));
              });
              throw error;
            }
          }
        }
        return await this.withConfigWrite(async () => {
          // Re-read rather than reusing a cached copy: another client may
          // have written since, and a settings page that silently reverts a
          // neighbour's edit is worse than one that is a beat behind.
          // The queue above makes even that re-read fresh.
          const { config, path } = await this.readConfigFile();
          const next = await setConfigValueSecure(config, command.key, command.value);
          await saveConfig(path, next);
          if (command.key === "memoryEmbeddings" || command.key === "memoryEmbeddingLoading" || command.key === "memory") {
            void this.applyEmbeddingPolicy().catch(() => undefined);
          }
          if ((command.key === "memoryEmbeddings" && next.memoryEmbeddings !== true) || (command.key === "memory" && next.memory === false)) {
            this.embeddingGeneration++;
            this.semanticMemory.cancel();
            this.embeddingRuntime.close();
          }
          if (this.remoteAccess && command.key.startsWith("remote.")) {
            try {
              await this.remoteAccess.apply(next.remote);
            } catch (cause) {
              // Put back what was listening: a setting that says "on" while
              // nothing listens would be a lie the next restart repeats.
              await saveConfig(path, config);
              await this.remoteAccess.apply(config.remote).catch(() => undefined);
              throw cause;
            }
          }
          return { ...(await this.settingsSnapshot()), accepted: true };
        });
      }
      case "settings.duplicate": {
        return await this.withConfigWrite(async () => {
          const { config, path } = await this.readConfigFile();
          const entry = listTarget(`${command.key}[${command.id}]`);
          if (!entry) throw new CliError("INVALID_CONFIG_KEY", `${command.key} is not a list setting.`);
          await saveConfig(path, normalizeConfig(duplicateListItem(config, entry, command.newId, command.key)));
          return { ...(await this.settingsSnapshot()), accepted: true };
        });
      }
      case "mcp.server.test": {
        const { config } = await this.readConfigFile();
        return await testMcpServer(command.name, config.mcpServers, process.cwd());
      }
      case "harness.profile.import": {
        const parsed = parseProfileDocument(command.text);
        return await this.withConfigWrite(async () => {
          const { config, path } = await this.readConfigFile();
          const existing = config.providers?.harness?.profiles ?? [];
          const wanted = (command.id ?? parsed.id).toLowerCase();
          const taken = new Set(existing.map((entry) => entry.id));
          const mode = command.onConflict ?? "error";
          if (taken.has(wanted) && mode === "error") {
            throw new CliError("INVALID_CONFIG", `A harness profile "${wanted}" already exists. Import it under another id, or replace it.`, { details: { profileId: wanted } });
          }
          const id = taken.has(wanted) && mode === "rename" ? freeProfileId(wanted, taken) : wanted;
          const next = { ...parsed, id };
          const profiles = taken.has(id) ? existing.map((entry) => (entry.id === id ? next : entry)) : [...existing, next];
          await saveConfig(path, normalizeConfig({ ...config, providers: { ...config.providers, harness: { ...config.providers?.harness, profiles } } }));
          return { ...(await this.settingsSnapshot()), accepted: true, id, fileId: parsed.id };
        });
      }
      case "harness.profile.test": {
        const { profile, model } = await this.harnessModel(command.profileId, command.model, false);
        return await testProfile({ profile, model, ...(this.harnessFetch ? { fetch: this.harnessFetch } : {}) });
      }
      case "harness.models.discover":
        return await discoverModels({ baseUrl: command.baseUrl, apiFormat: command.apiFormat, apiKeyEnv: command.apiKeyEnv, ...(this.harnessFetch ? { fetch: this.harnessFetch } : {}) });
      case "harness.profile.probe": {
        const { profile, model } = await this.harnessModel(command.profileId, command.model, true);
        if (this.probing.has(profile.id)) throw new CliError("PROBE_RUNNING", `A probe of "${profile.id}" is already running.`);
        this.probing.add(profile.id);
        try {
          const report = await runProbe({ profile, model, ...(this.harnessFetch ? { fetch: this.harnessFetch } : {}) });
          const save = command.dryRun !== true && probeSettledSomething(report);
          if (save) {
            // Re-read: the file may have changed during the minutes the probe took.
            await this.withConfigWrite(async () => {
              const fresh = await this.readConfigFile();
              const profiles = (fresh.config.providers?.harness?.profiles ?? []).map((entry) =>
                entry.id !== profile.id
                  ? entry
                  : { ...entry, models: entry.models.map((m) => (m.id === model.id ? { ...m, probed: mergeProbed(m.probed, report) } : m)) },
              );
              await saveConfig(fresh.path, normalizeConfig({ ...fresh.config, providers: { ...fresh.config.providers, harness: { ...fresh.config.providers?.harness, profiles } } }));
            });
          }
          return { ...report, saved: save };
        } finally {
          this.probing.delete(profile.id);
        }
      }
      case "provider.update": {
        // The binary the sessions are configured to use, which is the one to update.
        const providers = (await this.loadConfig()).providers;
        return await this.runProviderUpdate(command.provider, providers?.[command.provider]?.binaryPath);
      }
      case "thread.conversation.revert":
        return {
          ...(await revertThread(await this.context(), command.threadId, command.turnCount, {
            ...(command.restoreFiles === true ? { restoreFiles: true } : {}),
          })),
          accepted: true,
        };
    }
  }

  private async projectCreate(command: CommandOf<"project.create">): Promise<CommandResult<"project.create">> {
    const { workspaceRoot } = command;
    const existing = await listStoredProjects(this.storeRoot).then(
      (projects) => projects.find((candidate) => candidate.workspaceRoot === workspaceRoot) ?? null,
    );
    if (existing) return { projectId: existing.id, created: false };
    const ensured = await ensureStoredProject(this.storeRoot, {
      ...(command.projectId ? { id: command.projectId } : {}),
      workspaceRoot,
      ...(command.title ? { title: command.title } : {}),
    });
    return { projectId: ensured.project.id, created: true };
  }

  /**
   * `task_ask`: a side question to a task the caller delegated. The same
   * ownership and research-run rules as `task_send` (`requireTaskControl`),
   * then the task's own provider answers on a copy of its thread
   * (`sideQuestion`), so nothing is added to the task and its turn is not
   * touched.
   */
  private async taskAsk(command: CommandOf<"thread.task.ask">): Promise<CommandResult<"thread.task.ask">> {
    const ctx = await this.context();
    const { row, target } = await requireTaskControl(ctx, command.parentThreadId, command.taskId, "task_ask");
    const described = await describeTask(ctx, command.parentThreadId, row.childThreadId);
    const answer = await this.sideQuestion({ threadId: target.id, question: command.question });
    return { ...answer, taskId: target.id, status: described.task.status };
  }

  /**
   * `/btw`. The thread's own provider answers, on a copy of its session so
   * the thread never sees the question. Providers that cannot copy a
   * session into a tool-less one-shot say so rather than falling back to
   * something that would touch the thread.
   */
  private async sideQuestion(input: { readonly threadId: string; readonly question: string }): Promise<CommandResult<"thread.side-question">> {
    const { store } = await this.context();
    const thread = await store.readThreadRecord(input.threadId);
    if (!thread) throw new CliError("THREAD_NOT_FOUND", `No thread ${input.threadId}.`, { exitCode: 2 });
    const selection = thread.modelSelection;
    const provider = driverKey(selection.instanceId);
    const driver = this.driverFor(selection.instanceId);
    if (!driver.sideQuestion) {
      throw new CliError(
        "SIDE_QUESTION_UNSUPPORTED",
        `/btw needs a provider that can copy a session into a tool-less one-shot; ${provider} cannot. Ask in the thread instead.`,
        { exitCode: 2, details: { provider } },
      );
    }
    // The live session's handle if this process holds one, else the one
    // the thread last recorded — either way a copy, never the session itself.
    const cursor = driver.resumeCursor?.(thread.id) ?? thread.providerSessions?.[provider] ?? null;
    const answer = await driver.sideQuestion({
      cursor,
      workingDirectory: thread.env.path,
      question: input.question.trim(),
      model: selection.model,
    });
    return { ...answer, provider };
  }

  /** A new thread that carries on from `threadId`, opened with a handoff of it (`continueThread`). */
  private async continueThread(command: CommandOf<"thread.continue">): Promise<CommandResult<"thread.continue">> {
    const ctx = await this.context();
    const source = await ctx.store.readThreadRecord(command.threadId);
    if (!source) throw new CliError("THREAD_NOT_FOUND", `No thread ${command.threadId}.`, { exitCode: 2 });
    // A model handoff resolves like a follow-up: the old thread's model
    // unless the request overrides it, never the settings default. Its tasks
    // keep their own provider and model either way.
    const modelRequested = command.modelSelection !== undefined || command.provider !== undefined
      || command.model !== undefined || command.speedMode !== undefined || command.thinkingEffort !== undefined;
    const modelSelection = command.modelSelection ?? followUpSelection(source.modelSelection, ctx.config, command, "") ?? source.modelSelection;
    const continued = await continueThread(ctx, {
      threadId: command.threadId,
      ...(modelRequested ? { modelSelection } : {}),
      ...(command.scheduledFor !== undefined ? { scheduledFor: command.scheduledFor } : {}),
    });
    return { ...continued, accepted: true };
  }

  /**
   * An agent continuing its own thread in a new one (`continueOwnThread`):
   * the same `continueThread` the palette action runs, with the
   * agent-written handoff and first message. The model resolves like a
   * follow-up: the source thread's model unless the request overrides it.
   */
  private async continueAgentThread(command: CommandOf<"thread.continue-agent">): Promise<CommandResult<"thread.continue-agent">> {
    const ctx = await this.context();
    const source = await ctx.store.readThreadRecord(command.threadId);
    if (!source) throw new CliError("THREAD_NOT_FOUND", `No thread ${command.threadId}.`, { exitCode: 2 });
    const modelRequested = command.modelSelection !== undefined || command.provider !== undefined
      || command.model !== undefined || command.speedMode !== undefined || command.thinkingEffort !== undefined;
    const modelSelection = command.modelSelection ?? followUpSelection(source.modelSelection, ctx.config, command, "") ?? source.modelSelection;
    const continued = await continueOwnThread(ctx, {
      threadId: command.threadId,
      summary: command.summary,
      ...(command.firstMessage !== undefined ? { firstMessage: command.firstMessage } : {}),
      ...(command.idempotencyKey !== undefined ? { idempotencyKey: command.idempotencyKey } : {}),
      ...(modelRequested ? { modelSelection } : {}),
    });
    return { ...continued, accepted: true };
  }

  private async threadCreate(command: CommandOf<"thread.create">): Promise<CommandResult<"thread.create">> {
    const { store, config } = await this.context();
    const scratch = command.scratch === true;
    const projectId = scratch ? (await ensureScratchProject(this.storeRoot)).id : command.projectId;
    const project = (await listStoredProjects(this.storeRoot)).find((candidate) => candidate.id === projectId);
    if (!project || projectId === undefined) {
      throw new CliError("PROJECT_NOT_FOUND", `No project exists with id ${projectId}.`, {
        exitCode: 3,
        details: { projectId },
      });
    }
    // No explicit selection: the project's default, then the config's
    // provider/model, the same resolution a CLI handover applies.
    const modelSelection =
      command.modelSelection ??
      resolveModelSelection(project.defaultModelSelection, config, { prompt: "" });
    const threadId = command.threadId ?? randomUUID();
    const created = await createThread(store, {
      id: threadId,
      projectId,
      title: command.title ?? "New thread",
      modelSelection,
      runtimeMode: command.runtimeMode ?? defaultRuntimeMode(config, modelSelection.instanceId),
      interactionMode: command.interactionMode ?? config.interactionMode,
      env: {
        mode: "local",
        path: scratch ? await createScratchDir(this.storeRoot, threadId) : project.workspaceRoot,
        branch: scratch ? null : (command.branch ?? null),
      },
    });
    // A thread born in Research mode has not been offered a run size yet, so
    // its first prompt asks — the same mark a switch into Research mode
    // leaves, claimed by the same first prompt. Only `thread.create` marks:
    // delegated children, research role threads and handoffs never come
    // through here, so they stay unmarked and never ask.
    if (created.interactionMode === "research") {
      await store.withThreadLock(created.id, async () => {
        const current = await store.readThreadRecord(created.id);
        if (current && current.researchPicker !== true) {
          await store.writeThreadRecord({ ...current, researchPicker: true });
        }
      });
    }
    return { threadId: created.id, accepted: true };
  }

  private async turnStart(command: CommandOf<"thread.turn.start">, signal?: AbortSignal): Promise<CommandResult<"thread.turn.start">> {
    const { threadId, message } = command;
    await readResearchRun(await this.context(), threadId);
    const thread = await (await this.store()).readThreadRecord(threadId);
    const mode = command.interactionMode ?? thread?.interactionMode;
    const pending = (await (await this.store()).readTurns(threadId)).some((turn) => turn.status === "running" || turn.status === "queued");
    // The picker shows for `/research` (a prompt-only Research mode) and for the first
    // prompt after the user switched the thread into Research mode, not for every message in it.
    // Maintenance sends never ask and never spend the mark — a bare `/compact`
    // (palette or typed), a usage-limit continue, and a held work-queue entry
    // run as they are — so the first real prompt still asks afterwards. No
    // client can opt out this way: the exemption is recognised here, never passed in.
    const maintenance = isCompactCommand(message.text) || command.scheduleReason === "usage-reset" || command.queue?.held === true;
    const asksSize = !maintenance && (command.interactionMode === "research" || (thread?.researchPicker === true && mode === "research"));
    // Asked unless a run is already active (or the thread cannot lead one).
    // Never spent without asking: while the thread is busy, or no client is
    // listening for the question yet, the flag survives this send and the
    // result says the run size is still to choose.
    const askable = asksSize && mode === "research" && !isResearchRunActive(thread?.researchRun) && !thread?.researchRole &&
      !(await (await this.store()).readDelegations()).some((row) => row.childThreadId === threadId);
    let researchSizePending = false;
    if (askable && !pending && await this.awaitResearchResponder(threadId)) {
      // The one-shot flag is claimed under the thread lock: a concurrent send
      // may have claimed it first, in which case this send just goes out.
      let claim = command.interactionMode === "research";
      if (thread?.researchPicker === true) {
        await (await this.store()).withThreadLock(threadId, async () => {
          const current = await (await this.store()).readThreadRecord(threadId);
          if (current?.researchPicker) {
            const { researchPicker: _asked, ...rest } = current;
            await (await this.store()).writeThreadRecord(rest);
            claim = true;
          }
        });
      }
      if (claim) {
        const plan = await this.chooseResearch(threadId, message.text, "user-thread", command.modelSelection ? { modelSelection: command.modelSelection } : {});
        if (this.closed) throw new CliError("CONNECTION_CLOSED", "The server closed before research could start.");
        if (plan) {
          const ctx = await this.context();
          const approved = resolveResearchPlan(command.modelSelection ?? thread!.modelSelection, ctx.config, plan);
          await beginResearchRun(ctx, threadId, approved);
        }
      }
    } else if (askable && thread?.researchPicker === true) {
      researchSizePending = true;
    } else if (asksSize && thread?.researchPicker === true) {
      await (await this.store()).withThreadLock(threadId, async () => {
        const current = await (await this.store()).readThreadRecord(threadId);
        if (current?.researchPicker) {
          const { researchPicker: _asked, ...rest } = current;
          await (await this.store()).writeThreadRecord(rest);
        }
      });
    }
    const started = await startTurn(await this.context(), {
      threadId,
      prompt: message.text,
      ...(command.queue ? { queue: command.queue } : {}),
      // Saved with the message and sent to the provider as images.
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
      ...(command.interactionMode ? { interactionMode: command.interactionMode } : {}),
      ...(command.ifBusy ? { ifBusy: command.ifBusy } : {}),
      ...(command.delivery ? { delivery: command.delivery } : {}),
      ...(command.wakeSettled !== undefined ? { wakeSettled: command.wakeSettled } : {}),
      ...(command.handoffNote !== undefined ? { handoffNote: command.handoffNote } : {}),
      ...(command.scheduledFor !== undefined ? { scheduledFor: command.scheduledFor } : {}),
      ...(command.scheduleReason !== undefined ? { scheduleReason: command.scheduleReason } : {}),
      // Noop subscriber: guarantees the driver's shared pump exists (drain
      // discipline) even before any thread subscription opens. Open
      // subscriptions register their own callbacks alongside this one.
      onEvent: () => undefined,
    });
    return { ...(await this.settle(started, command.wait === true, signal)), accepted: true, ...(researchSizePending ? { researchSizePending: true as const } : {}) };
  }

  /**
   * A started turn as a client sees it, after optionally waiting for it
   * to settle. Waiting follows the ledger rather than the run handle: a
   * queued turn has no run yet, and is started by whichever runner
   * settles the turn ahead of it.
   */
  private async settle(started: StartedTurn, wait: boolean, signal?: AbortSignal): Promise<StartedTurnSummary> {
    if (wait && started.run !== null) await abortableRun(started.run, signal);
    return {
      turnId: started.turn.id,
      messageId: started.messageId,
      delivery: started.delivery,
      status: wait ? await this.turnSettled(started.turn.threadId, started.turn.id, signal) : await this.turnStatus(started.turn.threadId, started.turn.id),
      ...(started.steerDelivered === undefined ? {} : { steerDelivered: started.steerDelivered }),
    };
  }

  private async turnStatus(threadId: string, turnId: string): Promise<TurnStatus> {
    const turn = (await (await this.store()).readTurns(threadId)).find((candidate) => candidate.id === turnId);
    if (!turn) {
      throw new CliError("TURN_NOT_FOUND", `No turn exists with id ${turnId}.`, { exitCode: 3, details: { threadId, turnId } });
    }
    return turn.status;
  }

  /**
   * Follows the ledger rather than a run handle: a queued turn has no run
   * yet, and a turn started by another process has none here at all.
   * An aborted wait throws: the turn itself is untouched.
   */
  private async turnSettled(threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnStatus> {
    for (let poll = 0; ; poll += 1) {
      throwIfAborted(signal);
      const status = await this.turnStatus(threadId, turnId);
      if ((status !== "running" && status !== "queued") || this.closed) return status;
      // Every couple of seconds: a turn whose process died never settles.
      if (poll % 20 === 19) await recoverOrphanedTurn(await this.context(), threadId);
      await abortableSleep(100, signal);
    }
  }


  /**
   * The driver that owns the live session for a thread. Answering a parked
   * request has to reach the *same* driver instance that parked it, so this
   * resolves through the thread's own instance id rather than guessing.
   */
  /** The driver holding this thread's live session in this process, or null. */
  private async sessionDriver(threadId: string): Promise<TurnDriver | null> {
    const store = await this.store();
    const thread = await inspectThread(store, threadId);
    const turns = await store.readTurns(threadId);
    const latest = [...turns].reverse().find((turn) => turn.modelSelection)?.modelSelection ?? thread.modelSelection;
    const driver = this.driverFor(latest.instanceId);
    return (await Effect.runPromise(driver.hasSession(threadId)).catch(() => false)) ? driver : null;
  }

  /**
   * The driver to read a native subagent through. After a restart no driver
   * holds the thread's OpenCode session, yet the subagent's conversation
   * still lives in OpenCode's own store: resume the session, as a send
   * would, so the history can be read. Null for a thread with nothing to
   * resume (Claude reads its subagents from disk), or when the resume fails
   * (the working directory is gone, OpenCode will not start).
   */
  private async subagentDriver(threadId: string): Promise<TurnDriver | null> {
    const live = await this.sessionDriver(threadId);
    if (live !== null) return live;
    const store = await this.store();
    const thread = await store.readThreadRecord(threadId);
    if (thread === null) return null;
    const turns = await store.readTurns(threadId);
    const selection = [...turns].reverse().find((turn) => turn.modelSelection)?.modelSelection ?? thread.modelSelection;
    // The harness keeps subagent conversations in files named by the thread's session: no session needs to be running to read one.
    if (driverKey(selection.instanceId) === "harness" && thread.providerSessions?.["harness"] !== undefined) {
      await this.context();
      return this.driverFor(selection.instanceId);
    }
    if (driverKey(selection.instanceId) === "codex" && thread.providerSessions?.["codex"] !== undefined) {
      await this.context();
      return this.driverFor(selection.instanceId);
    }
    if (thread.providerSessions?.["opencode"] === undefined) return null;
    if (driverKey(selection.instanceId) !== "opencode") return null;
    await this.context();
    const driver = this.driverFor(selection.instanceId);
    try {
      await ensureDriverSession(driver, thread, { modelSelection: selection });
    } catch {
      return null;
    }
    return driver;
  }

  private async driverForThread(threadId: string): Promise<TurnDriver> {
    const store = await this.store();
    const thread = await inspectThread(store, threadId);
    // The running turn's own model: the thread's may have been switched
    // since the turn started, and the parked question is on this driver.
    const running = (await store.readTurns(threadId)).find((turn) => turn.status === "running");
    const driver = this.driverFor((running?.modelSelection ?? thread.modelSelection).instanceId);
    if (!(await Effect.runPromise(driver.hasSession(threadId)).catch(() => false))) {
      throw new CliError(
        "REQUEST_NOT_OWNED",
        `The question on thread ${threadId} belongs to a turn running in another process. Start a shared server (moxen server start) so every client can reach it.`,
        { exitCode: 4, details: { threadId } },
      );
    }
    return driver;
  }

  /**
   * Answers arrive from the panel as `string | string[]` (multi-select),
   * while the SPI carries one string per question; a multi-select answer
   * joins on the same separator the options are listed with.
   */
  private async userInputRespond(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    if (await respondToAsyncInput(await this.context(), threadId, requestId, answers)) return;
    const driver = await this.driverForThread(threadId);
    if (!driver.respondToUserInput) {
      throw new CliError("REQUEST_UNSUPPORTED", "This provider cannot be answered.");
    }
    const joined = Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [key, typeof value === "string" ? value : value.join(", ")]),
    );
    await Effect.runPromise(driver.respondToUserInput(threadId, requestId, joined));
  }

  /**
   * Dismissal denies the parked request rather than answering it: the
   * provider is still blocked on `canUseTool` and would hang forever if we
   * only closed the panel. The model sees a declined tool call and carries
   * on, which is what "the agent is not messaged" means in practice.
   */
  private async userInputDismiss(threadId: string, requestId: string): Promise<void> {
    if (await respondToAsyncInput(await this.context(), threadId, requestId, null)) return;
    const driver = await this.driverForThread(threadId);
    if (!driver.respondToRequest) {
      throw new CliError("REQUEST_UNSUPPORTED", "This provider cannot be answered.");
    }
    await Effect.runPromise(driver.respondToRequest(threadId, requestId, { kind: "decline" }));
  }

  /** Answers a parked tool approval on the provider that is blocked on it. */
  private async permissionRespond(threadId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    const driver = await this.driverForThread(threadId);
    if (!driver.respondToRequest) {
      throw new CliError("REQUEST_UNSUPPORTED", "This provider cannot be answered.");
    }
    const kind = decision === "accept-session" ? "acceptForSession" : decision;
    await Effect.runPromise(driver.respondToRequest(threadId, requestId, { kind }));
  }

  // -- reads -----------------------------------------------------------------

  async turnDiff(threadId: string, toTurnCount: number): Promise<string | null> {
    const store = await this.store();
    const [turns, checkpoints] = await Promise.all([
      store.readTurns(threadId).catch(() => []),
      store.readCheckpoints(threadId).catch(() => []),
    ]);
    const turn = turns[toTurnCount - 1];
    if (!turn) return null;
    const checkpoint = checkpoints.find((row) => row.turnId === turn.id);
    if (!checkpoint || checkpoint.status !== "available" || !checkpoint.ref || !checkpoint.baseRef) return null;
    const thread = await store.readThreadRecord(threadId).catch(() => null);
    const cwd = thread?.env.path?.trim() ? thread.env.path : null;
    if (!cwd) return null;
    return await diffCheckpointRange(cwd, checkpoint.baseRef, checkpoint.ref);
  }

  // -- queries ---------------------------------------------------------------

  /** Reads; decoded like commands, for the same reason. */
  async query<T extends QueryType>(query: QueryOf<T>, options?: { signal?: AbortSignal }): Promise<QueryResult<T>> {
    if (this.closed) throw new CliError("CONNECTION_CLOSED", "The direct connection is closed.");
    return (await this.answer(decodeQuery(query), options?.signal)) as QueryResult<T>;
  }

  private async answer(query: Query, signal?: AbortSignal): Promise<QueryResult> {
    // The shipped manual must still work when configuration cannot be loaded.
    if (query.type === "knowledge.search") return searchKnowledge(query.query);
    if (query.type === "knowledge.read") return readKnowledge(query.id, query.section);
    // Routing a call without session identity needs no configuration either:
    // the thread record names the driver, which counts the sessions sharing
    // the entry — so an offline knowledge call never fails on config. A
    // thread with no record (or no driver) keeps the entry owner's fallback:
    // the entry serves it alone until anything proves otherwise.
    if (query.type === "thread.entry-sessions") {
      const record = await (await this.store()).readThreadRecord(query.threadId).catch(() => null);
      const instanceId = record?.modelSelection.instanceId ?? null;
      if (!record || !instanceId) return { count: 1 };
      return { count: this.driverFor(instanceId).entrySessionCount?.(query.threadId) ?? 1 };
    }
    const ctx = await this.context();
    switch (query.type) {
      case "projects.list":
        return { projects: await listStoredProjects(this.storeRoot) };
      case "project.resolve":
        return await resolveProjectView(ctx, query);
      case "threads.list": {
        const { type: _type, ...filter } = query;
        return await listThreadsView(ctx, filter);
      }
      case "threads.search": {
        const { type: _type, ...request } = query;
        return await searchThreadsView(ctx, request);
      }
      case "thread.agent-read": {
        const store = await this.store();
        const [caller, target] = await Promise.all([store.readThreadRecord(query.callerThreadId), store.readThreadRecord(query.threadId)]);
        if (!target) throw new CliError("THREAD_NOT_FOUND", `No thread ${query.threadId}.`, { exitCode: 4, details: { threadId: query.threadId } });
        if (!caller) throw new CliError("THREAD_NOT_FOUND", `No thread ${query.callerThreadId}.`, { exitCode: 4, details: { threadId: query.callerThreadId } });
        if ((query.scope ?? "project") === "project" && caller.projectId !== target.projectId) {
          throw new CliError("THREAD_OUT_OF_SCOPE", `Thread ${query.threadId} belongs to another project: read it with scope "all".`, { exitCode: 2, details: { threadId: query.threadId } });
        }
        const budget = agentReadBudget(await latestContextUsage(store, query.callerThreadId), query.maxChars);
        const { type: _type, callerThreadId: _caller, scope: _scope, maxChars: _max, ...request } = query;
        return { text: await readThreadForAgent(store, request, budget) };
      }
      case "memory.list": {
        const location = await this.memoryLocation(query);
        return { projectId: location.projectId, memories: await listMemories(location), index: await memoryIndexText(location) };
      }
      case "memory.read":
        return await readMemory(await this.memoryLocation(query), query.name, query.scope);
      case "memory.search":
      {
        const location = await this.memoryLocation(query);
        const generation = this.embeddingGeneration;
        const enabled = await this.memoryEmbeddingsEnabled(location);
        return await searchMemories(location, query, enabled && generation === this.embeddingGeneration ? (memories) => {
          if (this.embeddingSetup !== null) return Promise.reject(new Error("Memory setup is busy"));
          return this.semanticMemory.scores(location, query.query, memories);
        } : undefined);
      }
      case "memory.embeddings.status":
        return { ...this.embeddingRuntime.status, validation: this.embeddingRuntime.status.validation ?? await this.embeddingRuntime.readValidation(), busy: this.embeddingSetup !== null, indexed: this.embeddingIndexed };
      case "thread.inspect":
        await recoverOrphanedTurn(ctx, query.threadId);
        return await inspectThreadView(ctx, query.threadId);
      case "thread.read":
        await recoverOrphanedTurn(ctx, query.threadId);
        return await readThreadView(ctx, query.threadId, {
          ...(query.view !== undefined ? { view: query.view } : {}),
          ...(query.lastTurn !== undefined ? { lastTurn: query.lastTurn } : {}),
        });
      case "thread.task.status":
        return await describeTask(ctx, query.parentThreadId, query.taskId);
      case "thread.delegation":
        return await delegationInfo(ctx, query.threadId);
      case "research.run":
        return await readResearchRun(ctx, query.threadId);
      case "opencode.session-thread": {
        // The thread behind a live OpenCode session, for routing the
        // directory's shared `moxen` entry to the session that made each
        // call. The drivers that own live sessions answer; null fails the
        // call safe rather than serving another thread.
        for (const driver of this.ownedDrivers) {
          const threadId = driver.threadForNativeSession?.(query.nativeSessionId) ?? null;
          if (threadId === null) continue;
          return await moxenRoutingFor(ctx, threadId);
        }
        return null;
      }
      case "research.proposals":
        this.expireResearchProposals();
        return [...this.researchProposals.values()].map((entry) => entry.proposal).filter((proposal) => proposal.threadId === query.threadId);
      case "research.messages":
        return await readResearchMessages(ctx, query.threadId);
      case "research.role.report":
        await requireResearchRole(ctx, query.leadThreadId, query.taskId);
        return await describeTask(ctx, query.leadThreadId, query.taskId);
      case "thread.turn.await":
        return { status: await this.turnSettled(query.threadId, query.turnId, signal) };
      case "providers.list":
        return { providers: withLiveUsage(await this.providers()) };
      case "doctor": {
        const providers = (await this.loadConfig()).providers;
        return await diagnose(this.storeRoot, providers?.opencode?.binaryPath, providers?.claude?.binaryPath, providers?.codex?.binaryPath);
      }
      case "thread.background.list": {
        const driver = await this.sessionDriver(query.threadId);
        if (!driver) return { live: false, partial: false, tasks: [] };
        // OpenCode reports only the background shells and subagents its own
        // server started: a live empty list from it never proves nothing runs.
        const store = await this.store();
        const thread = await store.readThreadRecord(query.threadId);
        const turns = await store.readTurns(query.threadId);
        const latest = [...turns].reverse().find((turn) => turn.modelSelection)?.modelSelection ?? thread?.modelSelection;
        const partial = latest !== undefined && driverKey(latest.instanceId) === "opencode";
        return { live: true, partial, tasks: driver.backgroundTasks?.(query.threadId) ?? [] };
      }
      case "thread.context-reading":
        return await readContextReading(await this.store(), query.threadId);
      case "thread.context": {
        const driver = await this.sessionDriver(query.threadId);
        if (!driver) return { live: false, breakdown: null };
        const breakdown = driver.contextBreakdown ? await driver.contextBreakdown(query.threadId).catch(() => null) : null;
        if (breakdown) return { live: true, breakdown };
        // Totals only: the reading without categories.
        const usage = driver.contextUsage ? await driver.contextUsage(query.threadId).catch(() => null) : null;
        return { live: true, breakdown: usage ? { ...usage, categories: [], estimated: false } : null };
      }
      case "thread.subagent": {
        // OpenCode keeps each subagent as a child session only a driver holding the thread's session can read.
        const driver = await this.subagentDriver(query.threadId);
        const store = await this.store();
        const thread = await store.readThreadRecord(query.threadId);
        const selection = [...(await store.readTurns(query.threadId))].reverse().find((turn) => turn.modelSelection)?.modelSelection ?? thread?.modelSelection;
        const harness = selection !== undefined && driverKey(selection.instanceId) === "harness";
        const historyProvider = harness ? "harness" : selection && driverKey(selection.instanceId) === "codex" ? "codex" : "opencode";
        const cursor = thread?.providerSessions?.[historyProvider] ?? null;
        const readHistory = driver?.subagentHistory ? (agentId: string) => driver.subagentHistory!(query.threadId, agentId, cursor) : undefined;
        return await subagentTranscript(store, query.threadId, query.agentId, readHistory, historyProvider);
      }
      case "provider.latest": {
        // Off by choice (`updates.checkLatest`): nothing is asked, and the answer says so.
        const config = await this.loadConfig();
        if (config.updates?.checkLatest === false) {
          return { enabled: false, claude: { latest: null, channel: null }, opencode: { latest: null, channel: null }, codex: { latest: null, channel: null } };
        }
        return { enabled: true, ...(await this.readLatestVersions(config.providers?.claude?.binaryPath)) };
      }
      case "app.update.check":
        return await this.checkAppUpdate();
      case "usage.limits":
        return { providers: usageLimitsSnapshot() };
      case "usage.refresh":
        return { providers: await this.refreshUsageWindows() };
      case "usage.protection":
        return this.usageProtection.read();
      case "queue.read": {
        const ctx = await this.context();
        return { entries: await readWorkQueue(ctx, await this.usageProtection.snapshotRows(ctx)) };
      }
      case "handoff.pending":
        return { requestId: await pendingHandoff(await this.context(), query.threadId) };
      case "usage.stats":
        return await readUsageStats(await this.store(), query.range ?? "all", new Date(), ctx.config);
      case "usage.card":
        return await readUsageCard(await this.store(), query.range ?? "all", new Date(), query.palette, ctx.config);
      case "remote.devices":
        return {
          devices: this.remoteAccess
            ? await this.remoteAccess.listDevices()
            : (await new DeviceRegistry().list()).map((device) => ({ ...device, connections: 0 })),
        };
      case "remote.status": {
        if (this.remoteAccess) return { available: true, ...this.remoteAccess.status() };
        const remote = (await this.loadConfig()).remote;
        return { available: false, enabled: remote?.enabled === true, interfaces: remote?.interfaces ?? "both", port: remote?.port ?? DEFAULT_REMOTE_PORT, listening: [] };
      }
      case "experience.read":
        return await readExperience(this.storeRoot);
      case "settings.read":
        return await this.settingsSnapshot();
      case "config.read": {
        const { config, path, exists } = await this.readConfigFile();
        return { path, exists, config: config.mcpServers ? { ...config, mcpServers: redactMcpServers(config.mcpServers) } : config };
      }
      case "harness.profile.export": {
        const { config } = await this.readConfigFile();
        const profile = config.providers?.harness?.profiles?.find((entry) => entry.id === query.profileId.toLowerCase());
        if (!profile) throw new CliError("PROVIDER_UNKNOWN", `No harness profile "${query.profileId}".`, { details: { profileId: query.profileId } });
        return { id: profile.id, text: `${JSON.stringify(exportProfileDocument(profile), null, 2)}\n` };
      }
      case "workspace.git":
        return { stdout: await workspaceGit(await this.liveRoot(query.threadId, query.root), query.call, query.paths ?? []) };
      case "workspace.read":
        return { content: await workspaceRead(await this.liveRoot(query.threadId, query.root), query.path) };
      case "attachment.read":
        // The store's folder, then where older builds saved them.
        return await readAttachment([path.join(this.storeRoot, "attachments"), path.join(appHomeDir(), "attachments")], query.attachmentId);
      case "image.read":
        return await readImageFile(await this.workspaceFor(query.threadId), query.path);
      case "git.overview": {
        const cwd = await this.workspaceFor(query.threadId);
        return await readOverview(cwd, {
          ...(query.branch !== undefined ? { branch: query.branch } : {}),
          limit: query.limit ?? ctx.config.git?.historyLimit ?? 50,
          ...(ctx.config.git?.autoFetch === true ? { autoFetch: true } : {}),
        });
      }
      case "git.commit.diff": {
        const cwd = await this.workspaceFor(query.threadId);
        return { sha: query.sha, diff: await readCommitDiff(cwd, query.sha) };
      }
      case "forge.detect":
        return await this.forgeFor(query.threadId, ctx.config.forge);
      case "forge.requests.list": {
        const cwd = await this.workspaceFor(query.threadId);
        const detection = await this.forgeFor(query.threadId, ctx.config.forge);
        // No forge is an ordinary state for a checkout, not a failure:
        // the panel shows why, rather than an error toast.
        if (detection.kind === null) return { requests: [] };
        return {
          requests: await listRequests(cwd, detection, {
            ...(query.state !== undefined ? { state: query.state } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
          }),
        };
      }
      case "forge.request.view": {
        const cwd = await this.workspaceFor(query.threadId);
        const detection = await this.forgeFor(query.threadId, ctx.config.forge);
        if (detection.kind === null) return { request: null };
        return { request: await viewRequest(cwd, detection, query.number) };
      }
      case "git.commit.detail": {
        const cwd = await this.workspaceFor(query.threadId);
        return { commit: await readCommitDetail(cwd, query.sha) };
      }
      case "forge.request.status": {
        const cwd = await this.workspaceFor(query.threadId);
        const detection = await detectForge(cwd, ctx.config.forge);
        if (detection.kind === null || !detection.authenticated) return { request: null };
        return { request: await requestStatus(cwd, detection, query.branch) };
      }
      case "forge.commits.checks": {
        const cwd = await this.workspaceFor(query.threadId);
        const detection = await detectForge(cwd, ctx.config.forge);
        if (detection.kind === null || !detection.authenticated) return { checks: {} };
        return { checks: await commitChecks(cwd, detection, query.branch, query.limit ?? 30) };
      }
      case "forge.commit.runs": {
        const cwd = await this.workspaceFor(query.threadId);
        const detection = await detectForge(cwd, ctx.config.forge);
        if (detection.kind === null || !detection.authenticated) return { runs: [] };
        return { runs: await commitRuns(cwd, detection, query.sha) };
      }
      case "thread.background.output": {
        const driver = await this.sessionDriver(query.threadId);
        const output = driver?.backgroundTaskOutput ? await driver.backgroundTaskOutput(query.threadId, query.taskId).catch(() => null) : null;
        return output ? { available: true, lines: output.lines } : { available: false, lines: [] };
      }
      case "skills.list": {
        const driver = this.driverFor(query.instanceId);
        const inventory = driver.skillInventory ? await driver.skillInventory(query.cwd) : EMPTY_SKILL_INVENTORY;
        const kind = driverKindOfInstance(query.instanceId);
        const excluded = new Set(kind ? excludedSkills(query.cwd, kind).flatMap((skill) => [skill.name, skill.folder]) : []);
        return { ...inventory, skills: inventory.skills.filter((skill) => !excluded.has(skill.name)) };
      }
      case "image-generation.availability": {
        const { available, reason } = await this.imageAvailability(query.threadId);
        return { available, reason };
      }
      case "skills.manage.list": {
        const roots = await this.skillRoots(query.projectId);
        return { skills: await listManagedSkills(roots), roots };
      }
      case "skills.manage.read":
        return await readManagedSkill(await this.skillRoots(query.projectId), query);
    }
  }

  /**
   * The catalog plus the user's model preferences, in the settings shape
   * the catalog decoder reads hidden models from — so hiding a model (from
   * any client) takes it out of every picker.
   */
  async getConfig(): Promise<ConfigPayload> {
    const [payload, prefs] = await Promise.all([this.catalog(), loadModelPrefs(this.storeRoot)]);
    const preferences = providerModelPreferences(prefs);
    if (Object.keys(preferences).length === 0) return payload;
    return { ...payload, settings: { ...payload.settings, providerModelPreferences: preferences } };
  }

  /**
   * The server's remote listener (`./transport/remoteaccess.ts`), when this
   * connection is served by one: `remote.*` settings then apply at once.
   * Applies the current config; a failure is kept in `remote.status`
   * rather than stopping the server, which still serves this machine.
   */
  private requireRemoteAccess(): RemoteAccess {
    if (this.remoteAccess) return this.remoteAccess;
    throw new CliError("REMOTE_NEEDS_SERVER", "Remote access is part of the moxen server. Start it (moxen server start) and try again.");
  }

  async attachRemoteAccess(remoteAccess: RemoteAccess): Promise<void> {
    this.remoteAccess = remoteAccess;
    const remote = await this.loadConfig().then((config) => config.remote, () => undefined);
    await remoteAccess.apply(remote).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopThreadFailureSink();
    for (const entry of this.researchProposals.values()) entry.answer(null);
    for (const timer of this.pollTimers) clearInterval(timer);
    this.pollTimers.clear();
    if (this.usageTimer !== null) clearInterval(this.usageTimer);
    this.usageProtection.close();
    for (const unsubscribe of this.usageSubscriptions) unsubscribe();
    this.embeddingGeneration++;
    this.semanticMemory.cancel();
    this.embeddingRuntime.close();
    await this.remoteAccess?.close().catch(() => undefined);
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.schedulingStarted) onScheduledTurnDue(null);
    await this.mcpHttp?.close().catch(() => undefined);
    this.mcpHttp = null;
    // Every stop starts before any is awaited, so one stuck driver cannot
    // starve the rest; each then races its own deadline, so one stuck
    // driver cannot hang shutdown either.
    await Promise.allSettled(
      [...this.ownedDrivers].map(async (driver) => {
        const stopping = (async () => {
          await Effect.runPromise(driver.stopAll?.() ?? Effect.void);
        })().catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.closeDriverTimeoutMs);
          timer.unref?.();
        });
        try {
          await Promise.race([stopping, deadline]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }),
    );
    this.ownedDrivers.clear();
    // The store is free for the next server: without this a fast restart
    // would meet this process's own lock and have to take it over.
    await this.releaseStore().catch(() => undefined);
  }
}

/**
 * The catalog with each provider's recorded plan usage filled in where the
 * catalog itself has none (the direct catalog never does: usage arrives
 * live from sessions). An instance that reports its own plan (OpenCode Go)
 * is recorded under its instance id; every other provider shares its
 * driver's account.
 */
function withLiveUsage(providers: readonly ProviderSummary[]): ProviderSummary[] {
  const live = usageLimitsSnapshot();
  return providers.map((provider) => {
    if (provider.usageLimits !== null) return provider;
    const limits = live[usageKeyForInstance(provider.instanceId)] ?? live[provider.driver];
    return limits === undefined ? provider : { ...provider, usageLimits: limits };
  });
}

/** A thread's latest context reading (`context-window.updated`), or null when its provider never reported one. */
async function latestContextUsage(store: ThreadStore, threadId: string): Promise<CallerContext | null> {
  const activities = await store.readActivities(threadId).catch(() => []);
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== "context-window.updated") continue;
    const used = activity.payload?.["usedTokens"];
    const max = activity.payload?.["maxTokens"];
    if (typeof used === "number") return { usedTokens: used, maxTokens: typeof max === "number" ? max : null };
  }
  return null;
}

/**
 * The latest reading the turn runner recorded, with when it was taken, for
 * `thread.context-reading`. A compaction reported after that reading (every
 * driver publishes one, for a `/compact` turn or its own threshold) makes it
 * out of date: the old figure still stands in the store until the next
 * reading lands, so it is marked rather than dropped. The times are compared
 * rather than the row order, since tool activity is written through a chain
 * and a notice can land after a reading it was emitted before.
 */
async function readContextReading(store: ThreadStore, threadId: string): Promise<QueryResults["thread.context-reading"]> {
  const activities = await store.readActivities(threadId).catch(() => []);
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== "context-window.updated") continue;
    const used = activity.payload?.["usedTokens"];
    if (typeof used !== "number") continue;
    const max = activity.payload?.["maxTokens"];
    const compactedSince = activities.some((later, at) => {
      if (later.kind !== "notice" || later.payload?.["notice"] !== "compacted") return false;
      return later.createdAt === activity.createdAt ? at > index : later.createdAt > activity.createdAt;
    });
    return { reading: { usedTokens: used, maxTokens: typeof max === "number" ? max : null, takenAt: activity.createdAt, compactedSince } };
  }
  return { reading: null };
}

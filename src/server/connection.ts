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
import { randomUUID } from "node:crypto";
import { discoverModels } from "../core/providers/harness/discover.js";
import { primeProfileKey } from "../core/providers/harness/profiles.js";
import { exportProfileDocument, freeProfileId, parseProfileDocument } from "../core/providers/harness/profileio.js";
import { testMcpServer } from "../core/mcptest.js";
import { searchThreadsView } from "../core/threads/search.js";
import * as Effect from "effect/Effect";

import { buildDirectProviders } from "../core/catalog/direct.js";
import { fetchLiveModels } from "../core/providers/claude/livemodels.js";
import { SdkTransport } from "../core/providers/claude/transport.js";
import { diagnose } from "../core/diagnostics/doctor.js";
import { updateProvider, type ProviderUpdate, type UpdatableProvider } from "../core/providers/update.js";
import { latestVersions } from "../core/providers/latest.js";
import type { LatestVersions } from "../core/catalog/update.js";
import { EMPTY_SKILL_INVENTORY, type ProviderSummary } from "../core/catalog/summary.js";
import { loadModelPrefs, providerModelPreferences, setModelHidden } from "../core/catalog/prefs.js";
import { defaultRuntimeMode, resolveModelSelection } from "../core/catalog/selection.js";
import { appHomeDir, defaultConfigPath, loadConfig, normalizeConfig, saveConfig, setConfigValueSecure } from "../core/config.js";
import { duplicateListItem } from "../core/configlist.js";
import { DEFAULT_REMOTE_PORT, describeSettings, listTarget } from "../core/configschema.js";
import { HarnessDriver } from "../core/providers/harness/driver.js";
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
import { MOXEN_CHECKLIST_ARG, MOXEN_CHECKLIST_QUERY, MOXEN_DELEGATED_ARG, MOXEN_DELEGATED_QUERY, MOXEN_NO_WEB_FETCH_ARG, MOXEN_NO_WEB_FETCH_QUERY, moxenInstructions } from "./mcp/stdio.js";
import { startMcpHttpServer, type McpHttpServer } from "./mcp/http.js";
import { MOXEN_MCP_INSTRUCTIONS } from "./mcp/stdio.js";
import { callMoxenTool, moxenToolsFor } from "./mcp/tools.js";
import { noteMessageId } from "../core/threads/views.js";
import { driverProviders } from "../core/threads/longthreads.js";
import { redactMcpServers, type McpServerSpec } from "../core/mcp.js";
import { ensureStoredProject, listStoredProjects, workspaceRootsEqual } from "../core/projects/projects.js";
import { readAttachment, workspaceGit, workspaceRead } from "./workspace.js";
import { createScratchDir, ensureScratchProject, removeScratchDir } from "../core/projects/scratch.js";
import { diffCheckpointRange, diffCheckpointStat } from "../core/checkpoints/git.js";
import { CliError } from "../core/errors.js";
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
import {
  armPendingScheduledTurns,
  cancelTask,
  continueThread,
  delegate,
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
  startTurn,
  type OperationContext,
  type StartedTurn,
} from "../core/threads/operations.js";
import { toThreadEnvelope } from "../core/threads/project.js";
import { backfillNativeSubagents, subagentTranscript } from "../core/threads/subagents.js";
import { openThreadStore, resolveStoreRoot, type ThreadStore } from "../core/threads/store.js";
import type { ProviderRuntimeEvent } from "../core/providers/spi.js";
import { pruneFinishedWorktrees } from "../core/threads/prune.js";
import type { CheckpointFileStat, StoredCheckpoint, StoredThread, TurnStatus } from "../core/threads/types.js";
import type { CliConfig, ForgeConfig, ProvidersConfig, ThreadEnvelope, WebConfig } from "../core/types.js";
import { persistUsageLimits, usageLimitsSnapshot } from "../core/usage/limits.js";
import type { ClientApi } from "./api.js";
import type { RemoteAccess } from "./transport/remoteaccess.js";
import { DeviceRegistry } from "./transport/devices.js";
import { remoteServerName } from "./servermode.js";
import {
  decodeCommand,
  decodeQuery,
  type Command,
  type CommandOf,
  type CommandResult,
  type CommandType,
  type ConfigPayload,
  type SettingsSnapshot,
  type Query,
  type QueryOf,
  type QueryResult,
  type QueryType,
  type ShellFrame,
  type StartedTurnSummary,
  type ThreadFrame,
  type PermissionDecision,
  type UserInputAnswers,
} from "./protocol.js";

/** How often finished worktree threads are tidied while the server runs. */
const PRUNE_INTERVAL_MS = 6 * 3_600_000;

export type { TurnDriverFactories } from "../core/threads/execute.js";

export interface DirectConnectionOptions {
  readonly storeRoot?: string;
  readonly drivers?: TurnDriverFactories;
  readonly shellPollMs?: number;
  readonly threadPollMs?: number;
  /** Provider source override (tests); defaults to probing the live providers. */
  readonly providers?: () => Promise<ProviderSummary[]>;
  /** Catalog source override (tests); defaults to the providers above, reshaped. */
  readonly catalog?: () => Promise<ConfigPayload>;
  /** Config source override (tests); defaults to the user's config file. */
  readonly config?: () => Promise<CliConfig>;
  /** Which file `settings.set` writes; defaults to the resolved config path. */
  readonly configPath?: string;
  /** The `moxen` tools' MCP server per thread; defaults to `mcp/main.ts`. Null turns them off. */
  readonly builtinMcpServers?: ((threadId: string, options?: { readonly delegated: boolean; readonly webFetch?: boolean }) => readonly McpServerSpec[]) | null;
  /** Runs a provider CLI's own updater (tests); defaults to the real one. */
  readonly updateProvider?: (provider: UpdatableProvider, binaryPath?: string) => Promise<ProviderUpdate>;
  /** Reads the newest provider versions (tests); defaults to the npm registry. */
  readonly latestVersions?: (claudeBinaryPath?: string) => Promise<Omit<LatestVersions, "enabled">>;
  /** The `fetch` the harness test and probe use; tests hand in a fake server. */
  readonly harnessFetch?: typeof fetch;
}

export class DirectConnection implements ClientApi {
  private readonly storeRoot: string;
  private remoteAccess: RemoteAccess | null = null;
  private readonly factories: TurnDriverFactories;
  private readonly shellPollMs: number;
  private readonly threadPollMs: number;
  private readonly catalog: () => Promise<ConfigPayload>;
  private readonly providers: () => Promise<ProviderSummary[]>;
  private readonly loadConfig: () => Promise<CliConfig>;
  private readonly readConfigFile: () => Promise<{ config: CliConfig; path: string; exists: boolean }>;
  /** The per-provider settings the last config read saw; see `driverFor`. */
  private lastProviders: ProvidersConfig | undefined;
  private lastWeb: WebConfig | undefined;
  private readonly builtinMcpServers: ((threadId: string, options?: { readonly delegated: boolean; readonly webFetch?: boolean }) => readonly McpServerSpec[]) | null;
  private readonly readLatestVersions: (claudeBinaryPath?: string) => Promise<Omit<LatestVersions, "enabled">>;
  private readonly runProviderUpdate: (provider: UpdatableProvider, binaryPath?: string) => Promise<ProviderUpdate>;
  private readonly harnessFetch: typeof fetch | undefined;
  /** Profiles with a probe running: two at once would fight over a single-slot server. */
  private readonly probing = new Set<string>();
  private storePromise: Promise<ThreadStore> | null = null;
  private readonly driversOwner = {};
  private readonly ownedDrivers = new Set<TurnDriver>();
  private closed = false;
  /** Backfilled per-file stats for checkpoints recorded without them, by ref pair (immutable). */
  private readonly checkpointFiles = new Map<string, ReadonlyArray<CheckpointFileStat>>();

  constructor(options: DirectConnectionOptions = {}) {
    this.storeRoot = options.storeRoot ?? resolveStoreRoot();
    persistUsageLimits(this.storeRoot);
    this.factories = options.drivers ?? {};
    this.harnessFetch = options.harnessFetch;
    this.shellPollMs = options.shellPollMs ?? 1500;
    this.threadPollMs = options.threadPollMs ?? 750;
    this.providers = options.providers ?? (async () => {
      // A config that cannot be read must not hide the providers that need none of it.
      const providers = await this.readConfigFile().then((read) => read.config.providers, () => undefined);
      const claudeBinary = providers?.claude?.binaryPath || "claude";
      return await buildDirectProviders({
        harness: providers?.harness,
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
    this.harnessFetch = options.harnessFetch;
    this.readLatestVersions = options.latestVersions ?? ((claudeBinaryPath) => latestVersions(claudeBinaryPath === undefined ? {} : { claudeBinaryPath }));
    this.runProviderUpdate = options.updateProvider ?? ((provider, binaryPath) => updateProvider(provider, binaryPath === undefined ? {} : { binaryPath }));
    this.builtinMcpServers =
      options.builtinMcpServers === undefined ? (threadId, serverOptions) => [this.moxenToolsFor(threadId, serverOptions?.delegated === true, serverOptions?.webFetch !== false)] : options.builtinMcpServers;
  }

  /**
   * The moxen tools for one thread. Its environment names this store (and
   * config and server mode) outright: providers hand MCP servers a filtered
   * environment (some do), and the tools must reach the same threads.
   */
  private moxenToolsFor(threadId: string, delegated = false, webFetch = true): McpServerSpec {
    // Hosted in this process: Claude calls the tools in-process, the other
    // providers over loopback HTTP served here — so a delegation always runs
    // in the process that owns its parent's session. Until the HTTP server
    // is up (or in a process that never starts it), the stdio child.
    const base = this.mcpHttp
      ? { name: MOXEN_MCP_SERVER_NAME, type: "http" as const, ...this.mcpHttp.specFor(threadId), alwaysLoad: true }
      : { ...this.moxenStdioFor(threadId), alwaysLoad: true };
    // A delegated task asks for the tools without the delegation ones; the server holds to it as well.
    const flags = [...(delegated ? [{ query: MOXEN_DELEGATED_QUERY, arg: MOXEN_DELEGATED_ARG }] : []), ...(webFetch ? [] : [{ query: MOXEN_NO_WEB_FETCH_QUERY, arg: MOXEN_NO_WEB_FETCH_ARG }])];
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
      instructions: moxenInstructions({ delegated, webFetch }),
      tools: moxenToolsFor({ delegated, webFetch }),
      call: (tool, args) => callMoxenTool(this, threadId, tool, args, { delegated, webFetch }),
      fallback,
      checklist,
      // Delegation is what these tools are for: never behind a tool search.
      alwaysLoad: true,
    };
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

  private async store(): Promise<ThreadStore> {
    if (!this.storePromise) this.storePromise = openThreadStore(this.storeRoot);
    return await this.storePromise;
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
    onScheduledTurnDue(this.onDue);
    void this.context()
      .then((ctx) => armPendingScheduledTurns(ctx))
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
      await runDueScheduledTurn(await this.context(), threadId);
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
    this.ownedDrivers.add(driver);
    return driver;
  }

  // -- subscriptions -------------------------------------------------------

  subscribeShell(
    _options: { afterSequence?: number },
    onItem: (item: ShellFrame) => void,
    onError: (error: unknown) => void,
  ): () => void {
    let lastHash: string | null = null;
    // What the store and the project list looked like when `lastHash` was
    // taken, and when the next scheduled turn comes due. While the first
    // holds and the second has not passed, the rows cannot have changed:
    // skip the read of every thread's turns (and the stringify of them all).
    let lastFingerprint: string | null = null;
    let nextDueAt = Number.POSITIVE_INFINITY;
    let stopped = false;
    this.startScheduling();
    const poll = async (): Promise<void> => {
      if (stopped || this.closed) return;
      try {
        const store = await this.store();
        const [version, projects] = await Promise.all([store.shellVersion(), listStoredProjects(this.storeRoot)]);
        const fingerprint = `${version}#${JSON.stringify(projects)}`;
        if (fingerprint === lastFingerprint && Date.now() < nextDueAt) return;
        const threads = await listThreads(store, { status: "all" });
        const now = Date.now();
        nextDueAt = Number.POSITIVE_INFINITY;
        // Who delegated whom: the sidebar nests a task under its parent.
        const parents = new Map((await store.readDelegations().catch(() => [])).map((row) => [row.childThreadId, row.parentThreadId] as const));
        const rows = await Promise.all(
          threads.map(async (entry) => {
            const turns = await store.readTurns(entry.id);
            // This poll already reads every thread's turns: a scheduled turn
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
        const visible = rows.filter((row) => row.archivedAt == null && row.deletedAt == null);
        lastFingerprint = fingerprint;
        const hash = JSON.stringify({ projects, threads: visible });
        if (hash !== lastHash) {
          lastHash = hash;
          onItem({
            kind: "snapshot",
            snapshot: { snapshotSequence: 0, projects, threads: visible },
          });
        }
      } catch (cause) {
        onError(cause);
      }
    };
    void poll().then(() => {
      if (!stopped && !this.closed) onItem({ kind: "synchronized" });
    });
    const timer = setInterval(() => void poll(), this.shellPollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
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
    // When each streamed message first appeared: its place in the
    // timeline, between the tool calls around it.
    const firstSeen = new Map<string, string>();
    // The stored turn now running. Driver events carry the *driver's* turn
    // id, which no stored row shares; streamed text must group with the turn
    // the transcript shows.
    let runningTurnId: string | null = null;
    const poll = async (): Promise<void> => {
      if (stopped || this.closed) return;
      try {
        // The poll runs every few hundred ms for as long as the thread is
        // open, and a long thread's ledgers are megabytes: read, parse and
        // stringify them only when a stat says something was written.
        // (Recovering an orphaned turn comes first — it is what writes.)
        await recoverOrphanedTurn(await this.context(), threadId);
        const version = await (await this.store()).threadVersion(threadId);
        if (version === lastVersion) return;
        const detail = await this.threadDetail(threadId);
        if (!detail) return;
        lastVersion = version;
        const latest = detail.latestTurn;
        runningTurnId = latest && latest.state === "running" ? latest.turnId : null;
        const hash = JSON.stringify(detail);
        if (hash !== lastHash) {
          lastHash = hash;
          onItem({ kind: "snapshot", snapshot: { snapshotSequence: 0, thread: detail } });
        }
      } catch (cause) {
        onError(cause);
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
      const live = liveTurnText(driver, threadId);
      if (!live) return;
      for (const message of live.messages) {
        const turnId = runningTurnId ?? message.turnId;
        if (!turnId) continue;
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
    const ensureBridge = async (): Promise<void> => {
      if (stopped || this.closed || unsubscribeBridge) return;
      try {
        const store = await this.store();
        const thread = await store.readThreadRecord(threadId).catch(() => null);
        if (!thread) return;
        const driver = this.driverFor(thread.modelSelection.instanceId);
        const hasSession = await Effect.runPromise(driver.hasSession(threadId)).catch(() => false);
        if (!hasSession) return;
        unsubscribeBridge = subscribeDriverThread(driver, threadId, onEvent);
        // Same tick as the subscribe: nothing slips between what the turn had
        // already streamed (while this thread was not open) and what follows.
        replayLiveText(driver);
      } catch {
        // Retry on the next poll.
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
    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribeBridge?.();
    };
  }

  private async threadDetail(threadId: string): Promise<ThreadEnvelope | null> {
    const store = await this.store();
    const read = await readThread(store, threadId, { view: "messages" }).catch(() => null);
    if (!read) return null;
    return toThreadEnvelope(read.thread, read.turns, {
      messages: read.messages,
      activities: read.activities,
      checkpoints: await this.withCheckpointFiles(read.thread.env.path, read.checkpoints),
    });
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
  async dispatch<T extends CommandType>(command: CommandOf<T>): Promise<CommandResult<T>> {
    if (this.closed) throw new CliError("CONNECTION_CLOSED", "The direct connection is closed.");
    return (await this.run(decodeCommand(command))) as CommandResult<T>;
  }

  private async run(command: Command): Promise<CommandResult> {
    const accepted = { accepted: true } as const;
    switch (command.type) {
      case "project.create":
        return await this.projectCreate(command);
      case "thread.create":
        return await this.threadCreate(command);
      case "thread.turn.start":
        return await this.turnStart(command);
      case "thread.turn.interrupt":
        await interruptTurn(await this.store(), command.threadId, command.turnId);
        return accepted;
      case "thread.settle":
        await settleThread(await this.store(), command.threadId, command.stop === true ? { stop: true } : {});
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
      case "thread.handover": {
        const { type: _type, commandId: _id, wait, ...request } = command;
        const result = await handover(await this.context(), request);
        return { ...result, started: result.started ? await this.settle(result.started, wait === true) : null };
      }
      case "thread.delegate": {
        const { type: _type, commandId: _id, ...request } = command;
        return await delegate(await this.context(), request);
      }
      case "thread.task.cancel":
        return await cancelTask(await this.context(), command.parentThreadId, command.taskId);
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
      case "thread.side-question":
        return await this.sideQuestion(command);
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
      case "settings.set": {
        // Re-read rather than reusing a cached copy: another client may
        // have written since, and a settings page that silently reverts a
        // neighbour's edit is worse than one that is a beat behind.
        const { config, path } = await this.readConfigFile();
        const next = await setConfigValueSecure(config, command.key, command.value);
        await saveConfig(path, next);
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
      }
      case "settings.duplicate": {
        const { config, path } = await this.readConfigFile();
        const entry = listTarget(`${command.key}[${command.id}]`);
        if (!entry) throw new CliError("INVALID_CONFIG_KEY", `${command.key} is not a list setting.`);
        await saveConfig(path, normalizeConfig(duplicateListItem(config, entry, command.newId, command.key)));
        return { ...(await this.settingsSnapshot()), accepted: true };
      }
      case "mcp.server.test": {
        const { config } = await this.readConfigFile();
        return await testMcpServer(command.name, config.mcpServers, process.cwd());
      }
      case "harness.profile.import": {
        const parsed = parseProfileDocument(command.text);
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
            const fresh = await this.readConfigFile();
            const profiles = (fresh.config.providers?.harness?.profiles ?? []).map((entry) =>
              entry.id !== profile.id
                ? entry
                : { ...entry, models: entry.models.map((m) => (m.id === model.id ? { ...m, probed: mergeProbed(m.probed, report) } : m)) },
            );
            await saveConfig(fresh.path, normalizeConfig({ ...fresh.config, providers: { ...fresh.config.providers, harness: { ...fresh.config.providers?.harness, profiles } } }));
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
   * `/btw`. The thread's own provider answers, on a copy of its session so
   * the thread never sees the question. Providers that cannot copy a
   * session into a tool-less one-shot say so rather than falling back to
   * something that would touch the thread.
   */
  private async sideQuestion(command: CommandOf<"thread.side-question">): Promise<CommandResult<"thread.side-question">> {
    const { store } = await this.context();
    const thread = await store.readThreadRecord(command.threadId);
    if (!thread) throw new CliError("THREAD_NOT_FOUND", `No thread ${command.threadId}.`, { exitCode: 2 });
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
      question: command.question.trim(),
      model: selection.model,
    });
    return { ...answer, provider };
  }

  /** A new thread that carries on from `threadId`, opened with a handoff of it (`continueThread`). */
  private async continueThread(command: CommandOf<"thread.continue">): Promise<CommandResult<"thread.continue">> {
    const continued = await continueThread(await this.context(), {
      threadId: command.threadId,
      ...(command.scheduledFor !== undefined ? { scheduledFor: command.scheduledFor } : {}),
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
    return { threadId: created.id, accepted: true };
  }

  private async turnStart(command: CommandOf<"thread.turn.start">): Promise<CommandResult<"thread.turn.start">> {
    const { threadId, message } = command;
    const started = await startTurn(await this.context(), {
      threadId,
      prompt: message.text,
      // Saved with the message and sent to the provider as images.
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
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
    return { ...(await this.settle(started, command.wait === true)), accepted: true };
  }

  /**
   * A started turn as a client sees it, after optionally waiting for it
   * to settle. Waiting follows the ledger rather than the run handle: a
   * queued turn has no run yet, and is started by whichever runner
   * settles the turn ahead of it.
   */
  private async settle(started: StartedTurn, wait: boolean): Promise<StartedTurnSummary> {
    if (wait) await started.run;
    return {
      turnId: started.turn.id,
      messageId: started.messageId,
      delivery: started.delivery,
      status: wait ? await this.turnSettled(started.turn.threadId, started.turn.id) : await this.turnStatus(started.turn.threadId, started.turn.id),
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
   */
  private async turnSettled(threadId: string, turnId: string): Promise<TurnStatus> {
    for (let poll = 0; ; poll += 1) {
      const status = await this.turnStatus(threadId, turnId);
      if ((status !== "running" && status !== "queued") || this.closed) return status;
      // Every couple of seconds: a turn whose process died never settles.
      if (poll % 20 === 19) await recoverOrphanedTurn(await this.context(), threadId);
      await new Promise((resolve) => setTimeout(resolve, 100));
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
  async query<T extends QueryType>(query: QueryOf<T>): Promise<QueryResult<T>> {
    if (this.closed) throw new CliError("CONNECTION_CLOSED", "The direct connection is closed.");
    return (await this.answer(decodeQuery(query))) as QueryResult<T>;
  }

  private async answer(query: Query): Promise<QueryResult> {
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
      case "thread.turn.await":
        return { status: await this.turnSettled(query.threadId, query.turnId) };
      case "providers.list":
        return { providers: withLiveUsage(await this.providers()) };
      case "doctor": {
        const providers = (await this.loadConfig()).providers;
        return await diagnose(this.storeRoot, providers?.opencode?.binaryPath, providers?.claude?.binaryPath);
      }
      case "thread.background.list": {
        const driver = await this.sessionDriver(query.threadId);
        return driver ? { live: true, tasks: driver.backgroundTasks?.(query.threadId) ?? [] } : { live: false, tasks: [] };
      }
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
        const cursor = thread?.providerSessions?.[harness ? "harness" : "opencode"] ?? null;
        const readHistory = driver?.subagentHistory ? (agentId: string) => driver.subagentHistory!(query.threadId, agentId, cursor) : undefined;
        return await subagentTranscript(store, query.threadId, query.agentId, readHistory, harness ? "harness" : "opencode");
      }
      case "provider.latest": {
        // Off by choice (`updates.checkLatest`): nothing is asked, and the answer says so.
        const config = await this.loadConfig();
        if (config.updates?.checkLatest === false) {
          return { enabled: false, claude: { latest: null, channel: null }, opencode: { latest: null, channel: null } };
        }
        return { enabled: true, ...(await this.readLatestVersions(config.providers?.claude?.binaryPath)) };
      }
      case "usage.limits":
        return { providers: usageLimitsSnapshot() };
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
        return driver.skillInventory ? await driver.skillInventory(query.cwd) : EMPTY_SKILL_INVENTORY;
      }
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
    await this.remoteAccess?.close().catch(() => undefined);
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.schedulingStarted) onScheduledTurnDue(null);
    await this.mcpHttp?.close().catch(() => undefined);
    this.mcpHttp = null;
    for (const driver of this.ownedDrivers) {
      try {
        await Effect.runPromise(driver.stopAll?.() ?? Effect.void);
      } catch {
        // Best effort: servers may already be gone.
      }
    }
    this.ownedDrivers.clear();
  }
}

/**
 * The catalog with each provider's recorded plan usage filled in where the
 * catalog itself has none (the direct catalog never does: usage arrives
 * live from sessions).
 */
function withLiveUsage(providers: readonly ProviderSummary[]): ProviderSummary[] {
  const live = usageLimitsSnapshot();
  return providers.map((provider) =>
    provider.usageLimits === null && live[provider.driver] !== undefined ? { ...provider, usageLimits: live[provider.driver]! } : provider,
  );
}

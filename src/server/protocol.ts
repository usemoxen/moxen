/**
 * The command protocol: what a client may ask the server to do.
 *
 * `dispatch` used to be `(command: unknown) => Promise<unknown>`. Every
 * caller hand-built `{ type, commandId, ... }` object literals and the
 * server re-derived their shape at runtime through a drift of `asRecord`
 * casts, so a misspelled field was a silent no-op rather than a compile
 * error. That is survivable with one client. With two — and then over a
 * wire, where the object really does arrive as `unknown` — it is not.
 *
 * So the shapes live here once, in two halves that must agree:
 *
 * - `Command` / `CommandResults` are the *compile-time* contract. Clients
 *   get narrowing and a typed result per command type.
 * - `decodeCommand` is the *runtime* contract, for input that genuinely
 *   arrives untyped: a socket frame, or a client that skipped the types.
 *   It is the only place allowed to guess at an unknown shape.
 *
 * Deliberately hand-written rather than schema-library-generated. Nothing
 * in the tree uses `effect/Schema` today; a discriminated union plus these
 * decoders costs less and breaks in more obvious ways.
 */
import type { SubagentTranscript } from "../core/threads/subagents.js";
import type { ImageAttachmentUpload } from "../core/attachments.js";
import { CliError } from "../core/errors.js";
import { MEMORY_SCOPES, MEMORY_TYPES, type ImportResult, type Memory, type MemoryScope, type MemoryType } from "../core/memory/memory.js";
import { requestedInteractionMode } from "../core/interactionmode.js";
import type { RemoteAccessStatus, RemoteDevice, RemotePairing } from "./transport/remoteaccess.js";
import { UPDATABLE_PROVIDERS, type LatestVersions, type ProviderUpdate, type UpdatableProvider } from "../core/catalog/update.js";
import type {
  CancelledTask,
  ChecklistStep,
  DelegateRequest,
  Delegation,
  DescribedTask,
  EnsuredProject,
  EnsureProjectRequest,
  Handover,
  HandoverRequest,
  RecordedChecklist,
  RevertResult,
  ThreadList,
  ThreadListQuery,
  WorkspaceQuery,
} from "../core/threads/operations.js";
import type { ThreadSearch, ThreadSearchQuery } from "../core/threads/search.js";
import type { ModelRequest } from "../core/catalog/selection.js";
import type { SettingView } from "../core/configschema.js";
import type { McpTestResult } from "../core/mcptest.js";
import type { HarnessTestResult, ProbeReport } from "../core/providers/harness/probe.js";
import type { CliConfig, DiscoverResult, HarnessApiFormat } from "../core/types.js";
import type { GitBranch, GitCommit, GitCommitDetail, GitOverview, GitWorktreeStatus } from "../core/git/history.js";
import type {
  ForgeCheckRun,
  ForgeChecks,
  ForgeDetection,
  ForgeRequest,
  ForgeRequestDetail,
  ForgeRequestStatus,
  MergeStrategy,
} from "../core/forge/forge.js";
import type { Diagnosis } from "../core/diagnostics/doctor.js";
import type { ProviderSummary, ProviderUsageLimits, SkillInventory } from "../core/catalog/summary.js";
import type { BackgroundTaskSummary, ContextBreakdown } from "../core/providers/spi.js";
import type { StoredProject } from "../core/projects/projects.js";
import type { SendDelivery, SendIfBusy, TurnDelivery, TurnStatus } from "../core/threads/types.js";
import type { ThreadInspection, ThreadListStatus, ThreadReadView, ThreadReading } from "../core/threads/views.js";
import type {
  InteractionMode,
  MessageEnvelope,
  ModelSelection,
  ProjectEnvelope,
  RuntimeMode,
  SpeedMode,
  ThreadEnvelope,
  WorkspaceResolution,
} from "../core/types.js";

/**
 * The git and forge vocabulary, re-exported so a client can name what
 * these queries return without importing `core/` past the shared kernel
 * (`src/tests/layering.test.ts`). Types only — the implementations stay
 * behind `ClientApi`.
 */
export type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitOverview,
  GitWorktreeStatus,
} from "../core/git/history.js";
export type {
  ForgeCheckRun,
  ForgeCheckState,
  ForgeRequestStatus,
  ForgeChecks,
  ForgeDetection,
  ForgeKind,
  ForgeRequest,
  ForgeRequestDetail,
  ForgeRequestState,
  MergeStrategy,
} from "../core/forge/forge.js";

export interface ThreadMessageInput {
  readonly text: string;
  readonly attachments?: readonly ImageAttachmentUpload[];
}

/**
 * An answer per question. The panel carries `string[]` for a multi-select;
 * the provider SPI wants one string per question, and the server joins
 * them rather than making every driver handle both.
 */
/** How a tool approval is answered. */
export type PermissionDecision = "accept" | "accept-session" | "decline";

export type UserInputAnswers = Readonly<Record<string, string | readonly string[]>>;

export type CommandBody =
  | { readonly type: "project.create"; readonly workspaceRoot: string; readonly projectId?: string; readonly title?: string }
  | {
      readonly type: "thread.create";
      /** Required unless `scratch` is set. */
      readonly projectId?: string;
      /** Start in a fresh directory of its own, under no project (`core/projects/scratch.ts`). */
      readonly scratch?: boolean;
      readonly threadId?: string;
      readonly title?: string;
      readonly modelSelection?: ModelSelection;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: InteractionMode;
      readonly branch?: string | null;
    }
  | {
      readonly type: "thread.turn.start";
      readonly threadId: string;
      readonly message: ThreadMessageInput;
      readonly modelSelection?: ModelSelection;
      /** What a busy thread does with a plain send: refuse (default) or take it as a steer. */
      readonly ifBusy?: SendIfBusy;
      readonly delivery?: SendDelivery;
      /** Settled threads refuse turns unless woken by the send itself. */
      readonly wakeSettled?: boolean;
      readonly handoffNote?: string;
      /** Resolve once the turn settles rather than at acceptance. */
      readonly wait?: boolean;
      /** Hold the message until this ISO instant (a scheduled send); it is queued until then. */
      readonly scheduledFor?: string;
      /** Why it is scheduled; `usage-reset` marks a continue after a usage limit. */
      readonly scheduleReason?: "user" | "usage-reset";
    }
  /** Interrupts the running turn — or, given a queued turn's id, cancels that queued message. */
  | { readonly type: "thread.turn.interrupt"; readonly threadId: string; readonly turnId?: string }
  /** `stop`: end the family's running work first instead of refusing to settle past it. */
  | { readonly type: "thread.settle"; readonly threadId: string; readonly reason?: string; readonly stop?: boolean }
  | { readonly type: "thread.unsettle"; readonly threadId: string; readonly reason?: string }
  | { readonly type: "thread.snooze"; readonly threadId: string; readonly snoozedUntil: string }
  | { readonly type: "thread.unsnooze"; readonly threadId: string }
  | { readonly type: "thread.archive"; readonly threadId: string }
  | { readonly type: "thread.delete"; readonly threadId: string }
  | {
      readonly type: "thread.meta.update";
      readonly threadId: string;
      readonly title?: string;
      readonly regenerateTitle?: boolean;
    }
  | {
      readonly type: "thread.model-selection.set";
      readonly threadId: string;
      readonly modelSelection: ModelSelection;
    }
  | {
      readonly type: "thread.runtime-mode.set";
      readonly threadId: string;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode?: InteractionMode;
    }
  /** Build, Research or Orchestrate. The session hears of it with the next prompt (`core/threads/modes.ts`). */
  | { readonly type: "thread.interaction-mode.set"; readonly threadId: string; readonly interactionMode: InteractionMode }
  | {
      readonly type: "thread.user-input.respond";
      readonly threadId: string;
      readonly requestId: string;
      readonly answers: UserInputAnswers;
    }
  | { readonly type: "thread.user-input.dismiss"; readonly threadId: string; readonly requestId: string }
  /** Answer a parked tool approval; `accept-session` also allows that tool for the rest of the session. */
  | {
      readonly type: "thread.permission.respond";
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: PermissionDecision;
    }
  /** Revert the conversation so its first `turnCount` turns remain; files are left as they are. */
  /** `restoreFiles`: put the files back too, to before the first dropped turn. */
  | { readonly type: "thread.conversation.revert"; readonly threadId: string; readonly turnCount: number; readonly restoreFiles?: boolean }
  /** A new thread for a prompt: project policy, local vs worktree, model from config and flags. */
  | ({ readonly type: "thread.handover"; readonly wait?: boolean } & HandoverRequest)
  /** A task run in a child thread of the same project. The task id is the child thread id. */
  | ({ readonly type: "thread.delegate" } & DelegateRequest)
  | { readonly type: "thread.task.cancel"; readonly parentThreadId: string; readonly taskId: string }
  /** Stop one background task (a `run_in_background` command, a Monitor watch, a background subagent). */
  | { readonly type: "thread.background.stop"; readonly threadId: string; readonly taskId: string }
  /** The agent's checklist, for a provider with none of its own (moxen's `todos` tool). The whole list. */
  | { readonly type: "thread.plan.set"; readonly threadId: string; readonly plan: readonly ChecklistStep[] }
  | ({ readonly type: "project.ensure" } & EnsureProjectRequest)
  /**
   * Moxen memory (`core/memory/`). Addressed by a thread (its project) or a
   * project; with neither, only the global scope is there. Saving and
   * deleting rewrite the scope's index.
   */
  | ({ readonly type: "memory.save"; readonly name: string; readonly description: string; readonly memoryType: MemoryType; readonly body: string; readonly scope: MemoryScope } & MemoryAddress)
  | ({ readonly type: "memory.delete"; readonly name: string; readonly scope: MemoryScope } & MemoryAddress)
  /** Copy Claude Code's auto memory for the project into Moxen's: only ever when the user asks. */
  | ({ readonly type: "memory.import-claude" } & MemoryAddress)
  | {
      readonly type: "model.visibility.set";
      readonly instanceId: string;
      readonly model: string;
      readonly hidden: boolean;
    }
  /**
   * Set one config key. Goes through the server rather than a client
   * writing the file, because a shared server reads config per operation
   * and two clients editing the same file would clobber each other.
   * `value` is always text — the schema's parser owns the conversion.
   */
  | { readonly type: "settings.set"; readonly key: string; readonly value: string }
  /**
   * Remote access (`transport/remoteaccess.ts`). Turning it on or off is
   * `settings.set` on `remote.enabled`; these pair and forget devices.
   * Starting a pairing needs the server and remote access on.
   */
  | { readonly type: "remote.pairing.start" }
  | { readonly type: "remote.pairing.cancel" }
  | { readonly type: "remote.device.revoke"; readonly deviceId: string }
  /** Copy one entry of a list setting (`key` is the list's, e.g. `providers.harness.profiles`) under a new id. */
  | { readonly type: "settings.duplicate"; readonly key: string; readonly id: string; readonly newId: string }
  /**
   * Add a harness profile from an exported document (`harness.profile.export`). `text` is the file's
   * contents; the server checks it as it checks the config file. A saved key or probe results in it
   * are ignored. `onConflict`: a taken id is an error, a new `-2` id, or overwritten.
   */
  | { readonly type: "harness.profile.import"; readonly text: string; readonly id?: string; readonly onConflict?: "error" | "rename" | "replace" }
  /** One tiny request to a harness profile's endpoint: does it work at all. Spends a request, so never retried. */
  | { readonly type: "harness.profile.test"; readonly profileId: string; readonly model?: string }
  /** Starts one configured MCP server, lists its tools and stops it again. Never retried. */
  | { readonly type: "mcp.server.test"; readonly name: string }
  /**
   * The harness probe battery against one model of a profile. Writes the
   * findings to the model's `probed` block unless `dryRun`. Never retried.
   */
  | { readonly type: "harness.profile.probe"; readonly profileId: string; readonly model?: string; readonly dryRun?: boolean }
  /**
   * Which models a server lists (`GET /v1/models`), before any profile exists. Takes the NAME of the
   * environment variable holding a key, never a key. Failures come back as a result, not an error.
   */
  | { readonly type: "harness.models.discover"; readonly baseUrl: string; readonly apiFormat: HarnessApiFormat; readonly apiKeyEnv?: string }
  /** Runs a provider CLI's own updater (`claude update`, `opencode upgrade`) on the machine the sessions run on. */
  | { readonly type: "provider.update"; readonly provider: UpdatableProvider }
  /**
   * Continue a thread in a new one: same project, model and modes, opened
   * with a handoff written from the old thread's ledger. `scheduledFor`
   * holds that first message until then (after a usage limit resets, say);
   * without it the new thread starts at once.
   */
  | { readonly type: "thread.continue"; readonly threadId: string; readonly scheduledFor?: string }
  /**
   * `/btw`: a side question answered on a copy of the thread's context,
   * with no tools, and never recorded in the thread. A command rather than
   * a query although it changes nothing here: it spends the account's
   * usage, so a transport must never retry it.
   */
  | { readonly type: "thread.side-question"; readonly threadId: string; readonly question: string }
  /**
   * Forge writes. These reach the network and are visible to other
   * people the moment they land, so a client confirms with the user
   * before dispatching one — nothing below prompts, and both CLIs are
   * driven with their non-interactive flags.
   */
  | {
      readonly type: "forge.request.create";
      readonly threadId: string;
      readonly title: string;
      readonly body?: string;
      readonly targetBranch?: string;
      readonly sourceBranch?: string;
      readonly draft?: boolean;
    }
  | { readonly type: "forge.request.comment"; readonly threadId: string; readonly number: number; readonly body: string }
  | {
      readonly type: "forge.request.merge";
      readonly threadId: string;
      readonly number: number;
      readonly strategy?: MergeStrategy;
      readonly deleteBranch?: boolean;
    };

/**
 * `commandId` is client-assigned correlation, carried for every command
 * and read by none of them yet. It exists so a transport can match a
 * response to its request without the command bodies knowing about it.
 */
export type Command = CommandBody & { readonly commandId?: string };

export type CommandType = CommandBody["type"];

/** `accepted` means the server took the command, not that the work finished. */
interface Accepted {
  readonly accepted: true;
}

/** The git reads the live diff overlay makes: changed names, status, and the diff of some paths. */
export type WorkspaceGitCall = "changed" | "status" | "diff";

export interface CommandResults {
  "project.create": { readonly projectId: string; readonly created: boolean };
  "thread.create": { readonly threadId: string } & Accepted;
  "thread.turn.start": StartedTurnSummary & Accepted;
  "thread.turn.interrupt": Accepted;
  "thread.settle": Accepted;
  "thread.unsettle": Accepted;
  "thread.snooze": Accepted;
  "thread.unsnooze": Accepted;
  "thread.archive": Accepted;
  "thread.delete": Accepted;
  "thread.meta.update": Accepted;
  "thread.model-selection.set": Accepted;
  "thread.runtime-mode.set": Accepted;
  "thread.interaction-mode.set": Accepted;
  "thread.user-input.respond": Accepted;
  "thread.user-input.dismiss": Accepted;
  "thread.permission.respond": Accepted;
  "thread.conversation.revert": RevertResult & Accepted;
  "thread.handover": Omit<Handover, "started"> & { readonly started: StartedTurnSummary | null };
  "thread.delegate": Delegation;
  "thread.task.cancel": CancelledTask;
  "thread.background.stop": { readonly stopped: true; readonly taskId: string };
  "thread.plan.set": RecordedChecklist;
  "project.ensure": EnsuredProject;
  "model.visibility.set": { readonly hidden: boolean };
  "memory.save": { readonly name: string; readonly scope: MemoryScope; readonly replaced: boolean };
  "memory.delete": { readonly name: string; readonly scope: MemoryScope };
  "memory.import-claude": ImportResult;
  "settings.set": SettingsSnapshot & Accepted;
  "remote.pairing.start": RemotePairing;
  "remote.pairing.cancel": Accepted;
  "remote.device.revoke": Accepted;
  "settings.duplicate": SettingsSnapshot & Accepted;
  "harness.profile.import": SettingsSnapshot & Accepted & { readonly id: string; readonly fileId: string };
  "harness.profile.test": HarnessTestResult;
  "mcp.server.test": McpTestResult;
  "harness.profile.probe": ProbeReport & { readonly saved: boolean };
  "harness.models.discover": DiscoverResult;
  "provider.update": ProviderUpdate;
  "thread.continue": { readonly threadId: string; readonly title: string; readonly scheduledFor: string | null } & Accepted;
  "thread.side-question": { readonly text: string; readonly withContext: boolean; readonly provider: string };
  "forge.request.create": { readonly url: string | null } & Accepted;
  "forge.request.comment": Accepted;
  "forge.request.merge": Accepted;
}

/** A started turn, minus the in-process run handle that cannot cross a wire. */
export interface StartedTurnSummary {
  readonly turnId: string;
  readonly messageId: string;
  readonly delivery: TurnDelivery;
  readonly status: TurnStatus;
  /** Steer/inject only: whether the running provider turn received it, or it was only recorded. */
  readonly steerDelivered?: boolean;
}

// -- queries ------------------------------------------------------------------

/**
 * Reads. Kept apart from `Command` so a client can tell from the type
 * alone that asking cannot change anything — which is also what lets a
 * transport retry one after a dropped connection.
 */
export type Query =
  | { readonly type: "projects.list" }
  | ({ readonly type: "project.resolve" } & WorkspaceQuery)
  | ({ readonly type: "threads.list" } & ThreadListQuery)
  /**
   * Find threads by what is in them — title, messages, tool calls — settled
   * ones included, active first. Read-only, so a transport may retry it.
   */
  | ({ readonly type: "threads.search" } & ThreadSearchQuery)
  | { readonly type: "thread.inspect"; readonly threadId: string }
  | {
      readonly type: "thread.read";
      readonly threadId: string;
      readonly view?: ThreadReadView;
      readonly lastTurn?: boolean;
    }
  | { readonly type: "thread.task.status"; readonly parentThreadId: string; readonly taskId: string }
  /**
   * Resolves once the turn is no longer running or queued. A read that
   * blocks: it changes nothing, so a client can abandon it (or, over a
   * wire, retry it) freely — the turn runs on regardless.
   */
  | { readonly type: "thread.turn.await"; readonly threadId: string; readonly turnId: string }
  /** The live provider catalog, probed on every call, with hidden-model preferences applied. */
  | { readonly type: "providers.list" }
  /** Binaries, git, store and stored-credential presence on the machine running the sessions. */
  | { readonly type: "doctor" }
  /** Skills and slash commands one provider resolves for a working directory. */
  | { readonly type: "skills.list"; readonly instanceId: string; readonly cwd: string }
  /** Background work running in a thread's live session; `live: false` when no session runs here. */
  | { readonly type: "thread.background.list"; readonly threadId: string }
  /**
   * Another thread as an agent reads it (`thread_read`): the outline, turns,
   * or one tool call, held to a budget that shrinks as the caller's context
   * fills. `scope: "project"` (the default) refuses a thread from another project.
   */
  | {
      readonly type: "thread.agent-read";
      readonly callerThreadId: string;
      readonly threadId: string;
      readonly scope?: "project" | "all";
      readonly turns?: string;
      readonly item?: string;
      readonly offset?: number;
      readonly before?: number;
      readonly maxChars?: number;
    }
  /** Every memory a thread or project sees, global first, with the index a session would start with. */
  | ({ readonly type: "memory.list" } & MemoryAddress)
  /** One memory; without a scope, the project's first, then the global. */
  | ({ readonly type: "memory.read"; readonly name: string; readonly scope?: MemoryScope } & MemoryAddress)
  /**
   * What fills the thread's context window now, by category, from its live
   * session; `live: false` when no session runs here (read the last recorded
   * total off the thread instead).
   */
  | { readonly type: "thread.context"; readonly threadId: string }
  /**
   * One native subagent's own conversation (Claude's Agent tool), read from
   * the transcript the provider keeps for it; `available: false` when it
   * keeps none this machine can read.
   */
  | { readonly type: "thread.subagent"; readonly threadId: string; readonly agentId: string }
  /**
   * The latest subscription usage windows each provider reported, keyed by
   * driver kind (`claude`, `opencode`): the account's limits, shared by
   * every thread on it. Empty until a session reports.
   */
  | { readonly type: "usage.limits" }
  /** Remote access as the server sees it; `available` false when there is no server (in-process). */
  | { readonly type: "remote.status" }
  /** Paired devices, with how many sockets each has open (0 without a server). */
  | { readonly type: "remote.devices" }
  /**
   * A background task's output, best-effort: the driver may have no way to
   * read it (unsupported provider, task gone, file not yet written).
   */
  | { readonly type: "thread.background.output"; readonly threadId: string; readonly taskId: string }
  /**
   * Every setting with its descriptor and current value. Descriptors ride
   * along rather than being read from the client's own copy of the table,
   * so a client talking to a newer server renders the settings that server
   * actually honours.
   */
  | { readonly type: "settings.read" }
  /** The server's whole config as `moxen config show` prints it: MCP `env`/`headers` values redacted. */
  | { readonly type: "config.read" }
  /** One harness profile as a shareable JSON document (no saved key, no probe results); see `profileio.ts`. */
  | { readonly type: "harness.profile.export"; readonly profileId: string }
  /** The newest Claude Code and OpenCode the registry offers (read when `updates.checkLatest` is on). */
  | { readonly type: "provider.latest" }
  /**
   * The Git panel's whole first paint for a thread's working directory:
   * status, branches and one branch's commits. Keyed by thread rather
   * than a path so a worktree thread reads its own checkout and no client
   * has to work out where that is.
   */
  | {
      readonly type: "git.overview";
      readonly threadId: string;
      /** Defaults to the checked-out branch. */
      readonly branch?: string;
      readonly limit?: number;
    }
  | { readonly type: "git.commit.diff"; readonly threadId: string; readonly sha: string }
  /**
   * The running turn's live diff overlay, for a client on another machine
   * (the TUI's `model/gitdiff.ts` and `model/filecache.ts` read the disk
   * directly when the server is local). `root` must be the thread's own
   * folder (its checkout or its project's root): `workspace.git` runs one of
   * three fixed git reads there, `workspace.read` reads one file under it,
   * capped like the overlay's own reads.
   */
  | {
      readonly type: "workspace.git";
      readonly threadId: string;
      readonly root: string;
      readonly call: WorkspaceGitCall;
      /** `diff` only: the repo-relative paths to diff. */
      readonly paths?: readonly string[];
    }
  | { readonly type: "workspace.read"; readonly threadId: string; readonly root: string; readonly path: string }
  /** A sent message's image by its attachment id: what copying the message takes along. */
  | { readonly type: "attachment.read"; readonly attachmentId: string }
  /** Which forge this checkout belongs to, and whether its CLI is usable. */
  | { readonly type: "forge.detect"; readonly threadId: string }
  | {
      readonly type: "forge.requests.list";
      readonly threadId: string;
      readonly state?: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }
  | { readonly type: "forge.request.view"; readonly threadId: string; readonly number: number }
  /** One commit in full for the commit view: message body, committer, parents, files, patch. */
  | { readonly type: "git.commit.detail"; readonly threadId: string; readonly sha: string }
  /** The request a branch has (the checked-out one by default), with its CI and mergeability. */
  | { readonly type: "forge.request.status"; readonly threadId: string; readonly branch?: string }
  /** CI tallies for a branch's recent commits, by sha (GitHub only; empty elsewhere). */
  | { readonly type: "forge.commits.checks"; readonly threadId: string; readonly branch: string; readonly limit?: number }
  /** One commit's CI runs, by name. */
  | { readonly type: "forge.commit.runs"; readonly threadId: string; readonly sha: string };

export type QueryType = Query["type"];

export type QueryOf<T extends QueryType> = Extract<Query, { readonly type: T }>;

export interface QueryResults {
  "projects.list": { readonly projects: readonly StoredProject[] };
  "project.resolve": { readonly workspace: WorkspaceResolution; readonly project: StoredProject | null };
  "threads.list": ThreadList;
  "threads.search": ThreadSearch;
  "thread.inspect": { readonly project: StoredProject | null; readonly thread: ThreadInspection };
  "thread.read": { readonly project: StoredProject | null; readonly thread: ThreadReading };
  "thread.task.status": DescribedTask;
  "thread.turn.await": { readonly status: TurnStatus };
  "providers.list": { readonly providers: readonly ProviderSummary[] };
  doctor: Diagnosis;
  "skills.list": SkillInventory;
  "thread.background.list": { readonly live: boolean; readonly tasks: readonly BackgroundTaskSummary[] };
  "thread.agent-read": { readonly text: string };
  "memory.list": { readonly projectId: string | null; readonly memories: readonly Memory[]; readonly index: string | null };
  "memory.read": Memory;
  "thread.context": { readonly live: boolean; readonly breakdown: ContextBreakdown | null };
  "thread.subagent": SubagentTranscript;
  "usage.limits": { readonly providers: Readonly<Record<string, ProviderUsageLimits>> };
  "remote.status": RemoteAccessStatus & { readonly available: boolean };
  "remote.devices": { readonly devices: readonly RemoteDevice[] };
  "thread.background.output": { readonly available: boolean; readonly lines: readonly string[] };
  "settings.read": SettingsSnapshot;
  "config.read": { readonly path: string; readonly exists: boolean; readonly config: CliConfig };
  "harness.profile.export": { readonly id: string; readonly text: string };
  "provider.latest": LatestVersions;
  "git.overview": GitOverview;
  "workspace.git": { readonly stdout: string };
  "workspace.read": { readonly content: string };
  "attachment.read": { readonly mimeType: string; readonly dataUrl: string };
  "git.commit.diff": { readonly sha: string; readonly diff: string | null };
  "forge.detect": ForgeDetection;
  "forge.requests.list": { readonly requests: readonly ForgeRequest[] };
  "forge.request.view": { readonly request: ForgeRequestDetail | null };
  "git.commit.detail": { readonly commit: GitCommitDetail | null };
  "forge.request.status": { readonly request: ForgeRequestStatus | null };
  "forge.commits.checks": { readonly checks: Readonly<Record<string, ForgeChecks>> };
  "forge.commit.runs": { readonly runs: readonly ForgeCheckRun[] };
}

export type QueryResult<T extends QueryType = QueryType> = QueryResults[T];

/** The command with a given `type` — what `dispatch` narrows a literal to. */
export type CommandOf<T extends CommandType> = Extract<Command, { readonly type: T }>;

export type CommandResult<T extends CommandType = CommandType> = CommandResults[T];

// -- subscription frames -----------------------------------------------------

/**
 * `snapshotSequence` is a resume cursor for a transport that replays; the
 * in-process connection re-snapshots on change and always sends 0.
 */
export type ShellFrame =
  | {
      readonly kind: "snapshot";
      readonly snapshot: {
        readonly snapshotSequence: number;
        readonly projects: readonly ProjectEnvelope[];
        readonly threads: readonly ThreadEnvelope[];
      };
    }
  | { readonly kind: "synchronized" };

export type ThreadFrame =
  | { readonly kind: "snapshot"; readonly snapshot: { readonly snapshotSequence: number; readonly thread: ThreadEnvelope } }
  | { readonly kind: "synchronized" }
  /** Live assistant text between snapshots: `text` is the delta, not the whole reply. */
  | {
      readonly kind: "event";
      readonly event: { readonly type: "thread.message-sent"; readonly payload: { readonly message: MessageEnvelope } };
    }
  /**
   * Live reasoning text for the running thought whose activity rows carry
   * `toolCallId`: `text` is a delta. Never stored — the thought's completed
   * row holds the whole text.
   */
  | {
      readonly kind: "event";
      readonly event: {
        readonly type: "thread.reasoning-delta";
        readonly payload: { readonly toolCallId: string; readonly turnId: string | null; readonly text: string };
      };
    };

// -- getConfig ---------------------------------------------------------------

export interface ConfigOptionChoice {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean | null;
}

export interface ConfigModel {
  readonly slug: string;
  readonly name: string;
  readonly isCustom: boolean;
  readonly isDefault?: boolean | null;
  readonly capabilities?: {
    readonly optionDescriptors: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly type: "select";
      readonly options: readonly ConfigOptionChoice[];
      readonly currentValue?: string | null;
    }>;
  };
}

export interface ConfigProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string | null;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string | null;
  readonly auth: { readonly status: string | null };
  readonly models: readonly ConfigModel[];
  readonly supportedRuntimeModes?: readonly string[] | null;
  readonly usageLimits?: unknown;
  readonly skills?: unknown;
}

/**
 * The `getConfig` payload. `extractProviders` still decodes it defensively
 * (it was the desktop server's shape first), so the optional fields here
 * are the ones that decoder tolerates missing, not ones the server omits.
 */
export interface ConfigPayload {
  readonly providers: readonly ConfigProvider[];
  readonly settings: Readonly<Record<string, unknown>>;
}

/** What both the settings query and a successful set answer with. */
export interface SettingsSnapshot {
  /** The config file these values came from, whether or not it exists yet. */
  readonly path: string;
  readonly exists: boolean;
  readonly settings: readonly SettingView[];
}

// -- runtime decoding --------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto",
  "auto-accept-edits",
  "full-access",
];

export function asRuntimeMode(value: unknown): RuntimeMode {
  return typeof value === "string" && (RUNTIME_MODES as readonly string[]).includes(value)
    ? (value as RuntimeMode)
    : "full-access";
}


export function asModelSelection(value: unknown): ModelSelection | null {
  const record = asRecord(value);
  const instanceId = record ? asString(record.instanceId) : null;
  const model = record ? asString(record.model) : null;
  if (!instanceId || !model) return null;
  const options = record?.options;
  const normalized = Array.isArray(options)
    ? options.flatMap((entry) => {
        const row = asRecord(entry);
        const id = row ? asString(row.id) : null;
        const optionValue = row?.value;
        if (!id || (typeof optionValue !== "string" && typeof optionValue !== "boolean")) return [];
        return [{ id, value: optionValue }];
      })
    : [];
  return { instanceId, model, ...(normalized.length > 0 ? { options: normalized } : {}) };
}

export function requireThreadId(value: unknown): string {
  const threadId = typeof value === "string" ? value.trim() : "";
  if (!threadId) {
    throw new CliError("THREAD_ID_REQUIRED", "A non-empty thread id is required.", { exitCode: 2 });
  }
  return threadId;
}

export function unknownCommand(type: string): CliError {
  return new CliError("UNKNOWN_COMMAND", `Unsupported command type: ${type}.`, { details: { type } });
}

/** Which memory a request means: a thread's project, a project, or (neither) the global scope alone. */
export interface MemoryAddress {
  readonly threadId?: string;
  readonly projectId?: string;
}

function decodeMemoryAddress(record: Record<string, unknown>): MemoryAddress {
  return { ...optionalString(record, "threadId"), ...optionalString(record, "projectId") };
}

function requireField(value: unknown, command: string, field: string): string {
  const text = asString(value);
  if (text === null) {
    throw new CliError("INVALID_THREAD_OPTION", `${command} requires ${field}.`, { exitCode: 2 });
  }
  return text;
}

const CHECKLIST_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

function decodeChecklist(value: unknown, command: string): ChecklistStep[] {
  if (!Array.isArray(value)) throw new CliError("INVALID_THREAD_OPTION", `${command} requires plan: an array of {step, status}.`, { exitCode: 2 });
  return value.map((entry, index) => {
    const record = asRecord(entry) ?? {};
    const status = asString(record.status) ?? "";
    if (!CHECKLIST_STATUSES.has(status)) {
      throw new CliError("INVALID_THREAD_OPTION", `${command} plan[${index}].status must be pending, in_progress or completed.`, { exitCode: 2 });
    }
    return { step: requireField(record.step, command, `plan[${index}].step`), status: status as ChecklistStep["status"] };
  });
}

function decodeAnswers(value: unknown, command: string): UserInputAnswers {
  const record = asRecord(value);
  if (record === null) {
    throw new CliError("INVALID_THREAD_OPTION", `${command} requires answers.`, { exitCode: 2 });
  }
  const answers: Record<string, string | readonly string[]> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") answers[key] = raw;
    else if (Array.isArray(raw)) {
      answers[key] = raw.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return answers;
}

function decodeMessage(value: unknown): ThreadMessageInput {
  const message = asRecord(value);
  const text = message ? (asString(message.text) ?? "") : "";
  if (!text.trim()) {
    throw new CliError("PROMPT_REQUIRED", "A non-empty thread message is required.", { exitCode: 2 });
  }
  const attachments =
    message && Array.isArray(message.attachments) ? (message.attachments as ImageAttachmentUpload[]) : [];
  return { text, ...(attachments.length > 0 ? { attachments } : {}) };
}

/**
 * Turn an untrusted value into a `Command`, or throw the same `CliError`
 * the handler would have thrown. Every check that used to be scattered
 * through the dispatch handlers happens here, once, before any of them
 * runs — which is what lets a transport validate a frame without also
 * executing it.
 */
export function decodeCommand(value: unknown): Command {
  const record = asRecord(value);
  const type = record ? asString(record.type) : null;
  if (record === null || type === null) {
    throw unknownCommand(String(asRecord(value)?.type ?? "missing"));
  }
  const commandId = asString(record.commandId);
  const meta = commandId === null ? {} : { commandId };
  const threadId = (): string => requireThreadId(record.threadId);

  switch (type) {
    case "project.create":
      return {
        ...meta,
        type,
        workspaceRoot: requireField(record.workspaceRoot, type, "workspaceRoot"),
        ...(asString(record.projectId) ? { projectId: asString(record.projectId) as string } : {}),
        ...(asString(record.title) ? { title: asString(record.title) as string } : {}),
      };
    case "thread.create": {
      const projectId = asString(record.projectId);
      const scratch = record.scratch === true;
      if (projectId === null && !scratch) {
        throw new CliError("PROJECT_ID_REQUIRED", "thread.create requires projectId.", { exitCode: 2 });
      }
      const selection = asModelSelection(record.modelSelection);
      return {
        ...meta,
        type,
        ...(projectId !== null && !scratch ? { projectId } : {}),
        ...(scratch ? { scratch: true } : {}),
        ...(asString(record.threadId) ? { threadId: asString(record.threadId) as string } : {}),
        ...(asString(record.title) ? { title: asString(record.title) as string } : {}),
        ...(selection ? { modelSelection: selection } : {}),
        // Absent modes stay absent: the server fills them from config.
        ...optionalEnum(record, "runtimeMode", RUNTIME_MODES, type),
        ...(record.interactionMode !== undefined ? { interactionMode: requestedInteractionMode(record.interactionMode, type) } : {}),
        ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
      };
    }
    case "thread.turn.start": {
      const selection = asModelSelection(record.modelSelection);
      return {
        ...meta,
        type,
        threadId: threadId(),
        message: decodeMessage(record.message),
        ...(selection ? { modelSelection: selection } : {}),
        ...optionalEnum(record, "ifBusy", ["reject", "inject"] as const, type),
        ...optionalEnum(record, "delivery", ["auto", "steer", "restart", "queue"] as const, type),
        ...optionalBoolean(record, "wakeSettled"),
        ...optionalString(record, "handoffNote"),
        ...optionalBoolean(record, "wait"),
        ...optionalString(record, "scheduledFor"),
        ...optionalEnum(record, "scheduleReason", ["user", "usage-reset"] as const, type),
      };
    }
    case "thread.turn.interrupt":
      return {
        ...meta,
        type,
        threadId: threadId(),
        ...(asString(record.turnId) ? { turnId: asString(record.turnId) as string } : {}),
      };
    case "thread.settle":
      return {
        ...meta,
        type,
        threadId: threadId(),
        ...(asString(record.reason) ? { reason: asString(record.reason) as string } : {}),
        ...(record.stop === true ? { stop: true } : {}),
      };
    case "thread.unsettle":
      return {
        ...meta,
        type,
        threadId: threadId(),
        ...(asString(record.reason) ? { reason: asString(record.reason) as string } : {}),
      };
    case "thread.snooze": {
      const until = asString(record.snoozedUntil);
      if (until === null) {
        throw new CliError("SNOOZE_UNTIL_INVALID", "Use --until with a valid ISO-8601 datetime.", { exitCode: 2 });
      }
      return { ...meta, type, threadId: threadId(), snoozedUntil: until };
    }
    case "thread.unsnooze":
    case "thread.archive":
    case "thread.delete":
      return { ...meta, type, threadId: threadId() };
    case "thread.meta.update":
      return {
        ...meta,
        type,
        threadId: threadId(),
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(record.regenerateTitle === true ? { regenerateTitle: true } : {}),
      };
    case "thread.model-selection.set": {
      const selection = asModelSelection(record.modelSelection);
      if (selection === null) {
        throw new CliError("INVALID_THREAD_OPTION", "model-selection.set requires a model selection.");
      }
      return { ...meta, type, threadId: threadId(), modelSelection: selection };
    }
    case "thread.runtime-mode.set": {
      const mode = record.runtimeMode;
      if (typeof mode !== "string" || !(RUNTIME_MODES as readonly string[]).includes(mode)) {
        throw new CliError("INVALID_THREAD_OPTION", "runtime-mode.set requires a known runtime mode.", {
          exitCode: 2,
        });
      }
      return {
        ...meta,
        type,
        threadId: threadId(),
        runtimeMode: mode as RuntimeMode,
        ...(record.interactionMode !== undefined ? { interactionMode: requestedInteractionMode(record.interactionMode, type) } : {}),
      };
    }
    case "thread.interaction-mode.set":
      if (record.interactionMode === undefined) {
        throw new CliError("INVALID_THREAD_OPTION", `${type} requires interactionMode.`, { exitCode: 2 });
      }
      return { ...meta, type, threadId: threadId(), interactionMode: requestedInteractionMode(record.interactionMode, type) };
    case "thread.user-input.respond":
      return {
        ...meta,
        type,
        threadId: threadId(),
        requestId: requireField(record.requestId, type, "requestId"),
        answers: decodeAnswers(record.answers, type),
      };
    case "thread.user-input.dismiss":
      return {
        ...meta,
        type,
        threadId: threadId(),
        requestId: requireField(record.requestId, type, "requestId"),
      };
    case "thread.permission.respond": {
      const decision = record.decision;
      if (decision !== "accept" && decision !== "accept-session" && decision !== "decline") {
        throw new CliError("INVALID_THREAD_OPTION", `${type} requires decision accept, accept-session, or decline.`, {
          exitCode: 2,
        });
      }
      return {
        ...meta,
        type,
        threadId: threadId(),
        requestId: requireField(record.requestId, type, "requestId"),
        decision,
      };
    }
    case "thread.conversation.revert": {
      const turnCount = record.turnCount;
      if (typeof turnCount !== "number" || !Number.isInteger(turnCount) || turnCount < 0) {
        throw new CliError("INVALID_THREAD_OPTION", `${type} requires a non-negative integer turnCount.`, {
          exitCode: 2,
        });
      }
      return { ...meta, type, threadId: threadId(), turnCount, ...optionalBoolean(record, "restoreFiles") };
    }
    case "thread.handover":
      return {
        ...meta,
        type,
        cwd: requireField(record.cwd, type, "cwd"),
        // Emptiness is the operation's to reject, with its own PROMPT_REQUIRED.
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        ...optionalEnum(record, "workspaceMode", ["repo", "folder"] as const, type),
        ...optionalEnum(record, "projectPolicy", ["create", "existing"] as const, type),
        ...optionalEnum(record, "threadEnvMode", ["auto", "local", "worktree"] as const, type),
        ...optionalEnum(record, "runtimeMode", RUNTIME_MODES, type),
        ...(record.interactionMode !== undefined ? { interactionMode: requestedInteractionMode(record.interactionMode, type) } : {}),
        ...decodeModelRequest(record, type),
        ...optionalBoolean(record, "dryRun"),
        ...optionalBoolean(record, "scratch"),
        ...optionalBoolean(record, "wait"),
      };
    case "thread.delegate":
      return {
        ...meta,
        type,
        parentThreadId: requireThreadId(record.parentThreadId),
        task: typeof record.task === "string" ? record.task : "",
        ...optionalString(record, "title"),
        ...decodeModelRequest(record, type),
        ...optionalBoolean(record, "wait"),
        ...optionalNumber(record, "timeoutMs", type),
        ...optionalBoolean(record, "dryRun"),
        ...optionalEnum(record, "isolation", ["shared", "worktree"] as const, type),
        ...optionalBoolean(record, "notify"),
        ...optionalBoolean(record, "fork"),
      };
    case "thread.task.cancel":
      return {
        ...meta,
        type,
        parentThreadId: requireThreadId(record.parentThreadId),
        taskId: requireField(record.taskId, type, "taskId"),
      };
    case "thread.background.stop":
      return {
        ...meta,
        type,
        threadId: requireThreadId(record.threadId),
        taskId: requireField(record.taskId, type, "taskId"),
      };
    case "thread.plan.set":
      return { ...meta, type, threadId: requireThreadId(record.threadId), plan: decodeChecklist(record.plan, type) };
    case "project.ensure":
      return {
        ...meta,
        type,
        cwd: requireField(record.cwd, type, "cwd"),
        ...optionalEnum(record, "workspaceMode", ["repo", "folder"] as const, type),
        ...optionalEnum(record, "projectPolicy", ["create", "existing"] as const, type),
        ...optionalBoolean(record, "dryRun"),
      };
    case "memory.save":
      return {
        ...meta,
        type,
        ...decodeMemoryAddress(record),
        name: requireField(record.name, type, "name"),
        description: requireField(record.description, type, "description"),
        memoryType: requireEnum(record.memoryType, type, "memoryType", MEMORY_TYPES),
        body: requireField(record.body, type, "body"),
        scope: requireEnum(record.scope, type, "scope", MEMORY_SCOPES),
      };
    case "memory.delete":
      return { ...meta, type, ...decodeMemoryAddress(record), name: requireField(record.name, type, "name"), scope: requireEnum(record.scope, type, "scope", MEMORY_SCOPES) };
    case "memory.import-claude":
      return { ...meta, type, ...decodeMemoryAddress(record) };
    case "model.visibility.set":
      if (typeof record.hidden !== "boolean") {
        throw new CliError("INVALID_THREAD_OPTION", `${type} requires hidden.`, { exitCode: 2 });
      }
      return {
        ...meta,
        type,
        instanceId: requireField(record.instanceId, type, "instanceId"),
        model: requireField(record.model, type, "model"),
        hidden: record.hidden,
      };
    case "thread.side-question":
      return {
        ...meta,
        type,
        threadId: requireThreadId(record.threadId),
        question: requireField(record.question, type, "question"),
      };
    case "thread.continue":
      return {
        ...meta,
        type,
        threadId: requireThreadId(record.threadId),
        ...optionalString(record, "scheduledFor"),
      };
    case "forge.request.create":
      return {
        ...meta,
        type,
        threadId: requireThreadId(record.threadId),
        title: requireField(record.title, type, "title"),
        ...optionalString(record, "body"),
        ...optionalString(record, "targetBranch"),
        ...optionalString(record, "sourceBranch"),
        ...optionalBoolean(record, "draft"),
      };
    case "forge.request.comment":
      return {
        ...meta,
        type,
        threadId: requireThreadId(record.threadId),
        number: requireNumber(record.number, type, "number"),
        body: requireField(record.body, type, "body"),
      };
    case "forge.request.merge":
      return {
        ...meta,
        type,
        threadId: requireThreadId(record.threadId),
        number: requireNumber(record.number, type, "number"),
        ...optionalEnum(record, "strategy", ["merge", "squash", "rebase"] as const, type),
        ...optionalBoolean(record, "deleteBranch"),
      };
    case "remote.pairing.start":
    case "remote.pairing.cancel":
      return { ...meta, type };
    case "remote.device.revoke":
      return { ...meta, type, deviceId: requireField(record.deviceId, type, "deviceId") };
    case "settings.set":
      return {
        ...meta,
        type,
        key: requireField(record.key, type, "key"),
        // Every value crosses as text: the schema's parser is the one
        // thing that decides what "false" or "120" means for a key.
        value: typeof record.value === "string" ? record.value : String(record.value ?? ""),
      };
    case "settings.duplicate":
      return { ...meta, type, key: requireField(record.key, type, "key"), id: requireField(record.id, type, "id"), newId: requireField(record.newId, type, "newId") };
    case "mcp.server.test":
      return { ...meta, type, name: requireField(record.name, type, "name") };
    case "harness.profile.import":
      return {
        ...meta,
        type,
        text: requireField(record.text, type, "text"),
        ...optionalString(record, "id"),
        ...(record.onConflict === "error" || record.onConflict === "rename" || record.onConflict === "replace" ? { onConflict: record.onConflict } : {}),
      };
    case "harness.profile.test":
      return { ...meta, type, profileId: requireField(record.profileId, type, "profileId"), ...(asString(record.model) !== null ? { model: asString(record.model)! } : {}) };
    case "harness.models.discover": {
      const format = asString(record.apiFormat);
      return {
        ...meta,
        type,
        baseUrl: requireField(record.baseUrl, type, "baseUrl"),
        apiFormat: format === "responses" || format === "anthropic" ? format : "chat",
        ...(asString(record.apiKeyEnv) !== null ? { apiKeyEnv: asString(record.apiKeyEnv)! } : {}),
      };
    }
    case "harness.profile.probe":
      return {
        ...meta,
        type,
        profileId: requireField(record.profileId, type, "profileId"),
        ...(asString(record.model) !== null ? { model: asString(record.model)! } : {}),
        ...optionalBoolean(record, "dryRun"),
      };
    case "provider.update":
      return {
        ...meta,
        type,
        provider: requireEnum(record.provider, type, "provider", UPDATABLE_PROVIDERS),
      };
    default:
      throw unknownCommand(type);
  }
}

// -- field decoders ------------------------------------------------------------

function optionalString<K extends string>(record: Record<string, unknown>, key: K): { [P in K]?: string } {
  const value = asString(record[key]);
  return (value === null ? {} : { [key]: value }) as { [P in K]?: string };
}

function optionalBoolean<K extends string>(record: Record<string, unknown>, key: K): { [P in K]?: boolean } {
  const value = record[key];
  return (typeof value === "boolean" ? { [key]: value } : {}) as { [P in K]?: boolean };
}

/** A required whole number — a PR number that arrived as text is refused. */
function requireNumber(value: unknown, command: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CliError("INVALID_THREAD_OPTION", `${command} requires ${field} as a whole number.`, { exitCode: 2 });
  }
  return value;
}

function optionalNumber<K extends string>(record: Record<string, unknown>, key: K, command: string): { [P in K]?: number } {
  const value = record[key];
  if (value === undefined) return {} as { [P in K]?: number };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliError("INVALID_THREAD_OPTION", `${command} ${key} must be a number.`, { exitCode: 2 });
  }
  return { [key]: value } as { [P in K]?: number };
}

/** One of the known values; absent or anything else is refused. */
function requireEnum<V extends string>(value: unknown, command: string, field: string, allowed: readonly V[]): V {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new CliError("INVALID_THREAD_OPTION", `${command} requires ${field} to be one of ${allowed.join(", ")}.`, {
      exitCode: 2,
      details: { [field]: value },
    });
  }
  return value as V;
}

/** A known value or absent; anything else is refused rather than defaulted. */
function optionalEnum<K extends string, V extends string>(
  record: Record<string, unknown>,
  key: K,
  allowed: readonly V[],
  command: string,
): { [P in K]?: V } {
  const value = record[key];
  if (value === undefined) return {} as { [P in K]?: V };
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new CliError("INVALID_THREAD_OPTION", `${command} ${key} must be one of ${allowed.join(", ")}.`, {
      exitCode: 2,
      details: { [key]: value },
    });
  }
  return { [key]: value as V } as { [P in K]?: V };
}

function decodeModelRequest(record: Record<string, unknown>, command: string): ModelRequest {
  return {
    ...optionalString(record, "provider"),
    ...optionalString(record, "model"),
    ...optionalEnum(record, "speedMode", ["standard", "fast"] as const satisfies readonly SpeedMode[], command),
    ...optionalString(record, "thinkingEffort"),
  };
}

/** `decodeCommand` for reads. */
export function decodeQuery(value: unknown): Query {
  const record = asRecord(value);
  const type = record ? asString(record.type) : null;
  if (record === null || type === null) {
    throw new CliError("UNKNOWN_QUERY", `Unsupported query type: ${String(asRecord(value)?.type ?? "missing")}.`);
  }
  switch (type) {
    case "projects.list":
      return { type };
    case "project.resolve":
      return {
        type,
        cwd: requireField(record.cwd, type, "cwd"),
        ...optionalEnum(record, "workspaceMode", ["repo", "folder"] as const, type),
      };
    case "threads.list":
      return {
        type,
        ...optionalString(record, "projectId"),
        ...optionalString(record, "cwd"),
        ...optionalEnum(record, "workspaceMode", ["repo", "folder"] as const, type),
        ...optionalEnum(record, "status", ["active", "settled", "snoozed", "all"] as const satisfies readonly ThreadListStatus[], type),
      };
    case "threads.search":
      return {
        type,
        query: requireField(record.query, type, "query"),
        ...optionalString(record, "projectId"),
        ...optionalString(record, "cwd"),
        ...optionalEnum(record, "workspaceMode", ["repo", "folder"] as const, type),
        ...optionalEnum(record, "status", ["active", "settled", "snoozed", "all"] as const satisfies readonly ThreadListStatus[], type),
        ...optionalNumber(record, "limit", type),
        ...optionalNumber(record, "hitsPerThread", type),
      };
    case "thread.inspect":
      return { type, threadId: requireThreadId(record.threadId) };
    case "thread.read":
      return {
        type,
        threadId: requireThreadId(record.threadId),
        // Validated by the read itself, whose error names the CLI flag
        // that `--json` consumers already match on.
        ...(typeof record.view === "string" ? { view: record.view as ThreadReadView } : {}),
        ...optionalBoolean(record, "lastTurn"),
      };
    case "thread.task.status":
      return {
        type,
        parentThreadId: requireThreadId(record.parentThreadId),
        taskId: requireField(record.taskId, type, "taskId"),
      };
    case "thread.turn.await":
      return {
        type,
        threadId: requireThreadId(record.threadId),
        turnId: requireField(record.turnId, type, "turnId"),
      };
    case "providers.list":
    case "doctor":
    case "usage.limits":
    case "remote.status":
    case "remote.devices":
    case "settings.read":
    case "config.read":
    case "provider.latest":
      return { type };
    case "harness.profile.export":
      return { type, profileId: requireField(record.profileId, type, "profileId") };
    case "workspace.git": {
      const call = requireField(record.call, type, "call");
      if (call !== "changed" && call !== "status" && call !== "diff") {
        throw new CliError("INVALID_QUERY", `workspace.git call must be changed, status or diff (got "${call}").`, { exitCode: 2 });
      }
      const paths = Array.isArray(record.paths) ? record.paths.filter((entry): entry is string => typeof entry === "string") : [];
      return { type, threadId: requireThreadId(record.threadId), root: requireField(record.root, type, "root"), call, ...(paths.length > 0 ? { paths } : {}) };
    }
    case "workspace.read":
      return { type, threadId: requireThreadId(record.threadId), root: requireField(record.root, type, "root"), path: requireField(record.path, type, "path") };
    case "attachment.read":
      return { type, attachmentId: requireField(record.attachmentId, type, "attachmentId") };
    case "git.overview":
      return {
        type,
        threadId: requireThreadId(record.threadId),
        ...optionalString(record, "branch"),
        ...optionalNumber(record, "limit", type),
      };
    case "git.commit.diff":
      return { type, threadId: requireThreadId(record.threadId), sha: requireField(record.sha, type, "sha") };
    case "forge.detect":
      return { type, threadId: requireThreadId(record.threadId) };
    case "forge.requests.list":
      return {
        type,
        threadId: requireThreadId(record.threadId),
        ...optionalEnum(record, "state", ["open", "closed", "merged", "all"] as const, type),
        ...optionalNumber(record, "limit", type),
      };
    case "forge.request.view":
      return { type, threadId: requireThreadId(record.threadId), number: requireNumber(record.number, type, "number") };
    case "git.commit.detail":
    case "forge.commit.runs":
      return { type, threadId: requireThreadId(record.threadId), sha: requireField(record.sha, type, "sha") };
    case "forge.request.status":
      return { type, threadId: requireThreadId(record.threadId), ...optionalString(record, "branch") };
    case "forge.commits.checks":
      return {
        type,
        threadId: requireThreadId(record.threadId),
        branch: requireField(record.branch, type, "branch"),
        ...optionalNumber(record, "limit", type),
      };
    case "skills.list":
      return {
        type,
        instanceId: requireField(record.instanceId, type, "instanceId"),
        cwd: requireField(record.cwd, type, "cwd"),
      };
    case "thread.background.list":
      return { type, threadId: requireThreadId(record.threadId) };
    case "thread.agent-read":
      return {
        type,
        callerThreadId: requireThreadId(record.callerThreadId),
        threadId: requireThreadId(record.threadId),
        ...optionalEnum(record, "scope", ["project", "all"] as const, type),
        ...optionalString(record, "turns"),
        ...optionalString(record, "item"),
        ...optionalNumber(record, "offset", type),
        ...optionalNumber(record, "before", type),
        ...optionalNumber(record, "maxChars", type),
      };
    case "memory.list":
      return { type, ...decodeMemoryAddress(record) };
    case "memory.read":
      return {
        type,
        ...decodeMemoryAddress(record),
        name: requireField(record.name, type, "name"),
        ...(record.scope !== undefined ? { scope: requireEnum(record.scope, type, "scope", MEMORY_SCOPES) } : {}),
      };
    case "thread.context":
      return { type, threadId: requireThreadId(record.threadId) };
    case "thread.subagent":
      return { type, threadId: requireThreadId(record.threadId), agentId: requireField(record.agentId, type, "agentId") };
    case "thread.background.output":
      return {
        type,
        threadId: requireThreadId(record.threadId),
        taskId: requireField(record.taskId, type, "taskId"),
      };
    default:
      throw new CliError("UNKNOWN_QUERY", `Unsupported query type: ${type}.`, { details: { type } });
  }
}

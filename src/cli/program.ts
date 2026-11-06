import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stderr as errorOutput } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command, Option } from "commander";

import {
  CONFIG_KEYS,
  expandHome,
  loadConfig,
} from "../core/config.js";
import { describeSettings, isSettingKey, listTarget, readSetting, restartRequired, secretKeyName } from "../core/configschema.js";
import { readListValue } from "../core/configlist.js";
import { addProfile, duplicateProfile, editProfile, exportProfile, importProfile, listProfiles, probeProfile, removeProfile, showProfile, testProfile } from "./harness/harness.js";
import type { UpdateProgress } from "../core/selfupdate/vocabulary.js";
import type { MergeStrategy } from "../server/api.js";
import {
  commentOnForgeRequest,
  createForgeRequest,
  forgeStatus,
  gitStatus,
  listForgeRequests,
  mergeForgeRequest,
  viewForgeRequest,
} from "./git/git.js";
import { cliClient } from "./infra/client.js";
import { doctor } from "./doctor.js";
import { parseUpdatable, updateCommand } from "./update.js";
import { describeInstall, describeProgress, describeRollback, describeSelfUpdate, describeUpdate, selfUpdateCheck, selfUpdateInstall, selfUpdateMode, selfUpdateRollback, selfUpdateRun } from "./selfupdate.js";
import { activeRemoteServer, configFlagGiven, useRemoteServer } from "./infra/client.js";
import { describeStatus, disableRemote, enableRemote, forgetServer, listDevices, listServers, pairingCode, pairServer, remoteStatus, revokeDevice } from "./remote.js";
import { serverStart, serverStatus, serverStop } from "./server.js";
import { CliError } from "../core/errors.js";
import { parseScheduledTime } from "../core/threads/scheduledtime.js";
import { APP_VERSION } from "../server/api.js";
import { requestedInteractionMode } from "../core/interactionmode.js";
import { deleteMemory, editMemory, importClaudeMemory, listMemory, memoryEmbeddings, readMemory, saveMemory, searchMemory } from "./memory/memory.js";
import { writeError, writeSuccess } from "./output.js";
import {
  createHandoverThread,
  type ThreadCreateOptions,
} from "./handover/handover.js";
import {
  ensureProject,
  listProjects,
  resolveProject,
} from "./projects/projects.js";
import {
  listEfforts,
  listModels,
  listProviders,
  listSkills,
  setModelHidden,
} from "./catalog/providers.js";
import type { ProviderUsageLimits } from "../core/catalog/summary.js";
import {
  answerQuestion,
  archiveThread,
  cancelTask,
  delegateTask,
  deleteThread,
  dismissQuestion,
  inspectThread,
  interruptThread,
  listQuestions,
  listBackgroundTasks,
  stopBackgroundTask,
  listThreads,
  searchThreads,
  readThread,
  renameThread,
  revertConversation,
  sendThreadMessage,
  settleThread,
  snoozeThread,
  taskStatus,
  unsettleThread,
  unsnoozeThread,
  type ThreadListStatus,
  type ThreadReadView,
  type ThreadSendDelivery,
} from "./threads/threads.js";
import type {
  CliConfig,
  InteractionMode,
  OpenMode,
  ProjectPolicy,
  RuntimeMode,
  SpeedMode,
  ProjectEnvelope,
  ThreadEnvelope,
  ThreadEnvMode,
  WorkspaceMode,
} from "../core/types.js";

export const program = new Command();
program
  .name("moxen")
  .description("Create projects and handover threads from the current folder.")
  .version(APP_VERSION)
  .option("--json", "Emit stable JSON envelopes.")
  .option("--config <path>", "Use a specific config file.")
  .option("--server <name>", "Talk to a paired moxen server on another machine (by name or address) instead of this one's. MOXEN_SERVER=<name> does the same.")
  ;

interface GlobalOptions {
  json?: boolean;
  config?: string;
  server?: string;
}

async function commandContext(): Promise<{
  config: CliConfig;
  configPath: string;
  configExists: boolean;
  json: boolean;
}> {
  const global = program.opts<GlobalOptions>();
  const loaded = await loadConfig(global.config);
  // The server's config: one this invocation starts runs on it, a running one must already.
  // The path as loaded — `~` expanded, which no Windows shell does for us.
  if (global.config !== undefined) process.env.MOXEN_CONFIG = loaded.path;
  const config = { ...loaded.config };
  configFlagGiven(global.config !== undefined);
  useRemoteServer(global.server ?? null);
  return { config, configPath: loaded.path, configExists: loaded.exists, json: global.json ?? false };
}

/** `moxen server …` manages this machine's server: a `--server` there is a mistake, not a target. */
function thisMachineOnly(command: string): void {
  if (program.opts<GlobalOptions>().server === undefined) return;
  throw new CliError("REMOTE_NOT_SUPPORTED", `moxen ${command} manages this machine's server. To check a paired one, use moxen --server <name> remote status; it can only be stopped on its own machine.`, { exitCode: 2 });
}

async function action(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const global = program.opts<GlobalOptions>();
    const cliError = writeError(error, { json: global.json ?? false });
    process.exitCode = cliError.exitCode;
  }
}

function addWorkspaceOptions(command: Command): Command {
  return command
    .option("--cwd <path>", "Folder to resolve (defaults to the current working directory).")
    .addOption(new Option("--workspace-mode <mode>").choices(["repo", "folder"]));
}

function addProjectPolicyOption(command: Command): Command {
  return command.addOption(
    new Option("--project-policy <policy>", "Create a missing project or require an existing one.").choices([
      "create",
      "existing",
    ]),
  );
}

function addThreadOptions(command: Command): Command {
  return addProjectPolicyOption(addWorkspaceOptions(command))
    .option("--prompt <text>", "Handover prompt.")
    .option("--prompt-file <path>", "Read the handover prompt from a UTF-8 file.")
    .option("--stdin", "Read the handover prompt from stdin.")
    .addOption(new Option("--open <mode>").choices(["auto", "desktop", "browser", "none"]))
    .option("--provider <instance-id>", "Provider instance id (for example opencode/openai or claudeAgent).")
    .option("--model <slug>", "Provider model slug.")
    .addOption(
      new Option("--speed, --speed-mode <mode>", "Model speed mode.")
        .choices(["standard", "fast"]),
    )
    .option("--thinking-effort <effort>", "Model-specific reasoning/thinking effort.")
    .addOption(
      new Option("--checkout, --env-mode <mode>", "Use the current checkout or create a new worktree.")
        .choices(["auto", "local", "current", "worktree"]),
    )
    .addOption(
      new Option("--permission, --runtime-mode <mode>", "Permission/access level.")
        .choices(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    )
    .addOption(
      // `plan` stays accepted here so the refusal is ours (PLAN_MODE_REMOVED, exit 2), not a bare "invalid choice".
      new Option("--mode, --interaction-mode <mode>", "Thread mode: build (default), research or orchestrate.")
        .choices(["default", "build", "research", "orchestrate", "plan"]),
    )
    .option("--no-project", "Start without a project, in a fresh scratch folder.")
    .option("--dry-run", "Resolve and print commands without dispatching them.")
    .option("--no-wait", "Return at turn acceptance without waiting for the provider run to settle.");
}

interface PromptOptions {
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
}

interface ThreadSendCommandOptions extends PromptOptions {
  thread?: string;
  threadId?: string;
  open?: OpenMode;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
  ifBusy?: "reject" | "inject";
  wakeSettled?: boolean;
  delivery?: ThreadSendDelivery;
  handoffNote?: string;
  dryRun?: boolean;
  /** Commander stores `--no-wait` as `wait: false` — there is no `noWait` key. */
  wait?: boolean;
  /** Hold the message until then (`--at`). */
  at?: string;
}

interface ThreadListCommandOptions extends WorkspaceCommandOptions {
  project?: string;
  status?: ThreadListStatus;
}

interface ThreadReadCommandOptions {
  thread: string;
  lastTurn?: boolean;
  view?: ThreadReadView;
}

interface ThreadDelegateCommandOptions extends PromptOptions {
  thread?: string;
  title?: string;
  open?: OpenMode;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
  wait?: boolean;
  timeoutMs?: string;
  dryRun?: boolean;
  isolation?: "shared" | "worktree";
  idempotencyKey?: string;
  mode?: "build" | "research";
  researchSize?: string;
  researchModels?: string;
}

interface ThreadTaskCommandOptions {
  thread: string;
  task: string;
}

function addSendOptions(command: Command): Command {
  return command
    .option("--thread <id>", "Existing thread id to message (alias: --thread-id).")
    .option("--thread-id <id>", "Existing thread id (alias: --thread).")
    .option("--prompt <text>", "Follow-up message text.")
    .option("--prompt-file <path>", "Read the follow-up message from a UTF-8 file.")
    .option("--stdin", "Read the follow-up message from stdin.")
    .addOption(new Option("--open <mode>").choices(["auto", "desktop", "browser", "none"]))
    .option("--provider <instance-id>", "Override the thread's provider instance for this turn.")
    .option("--model <slug>", "Override the thread's model for this turn.")
    .addOption(
      new Option("--speed, --speed-mode <mode>", "Model speed mode override.")
        .choices(["standard", "fast"]),
    )
    .option("--thinking-effort <effort>", "Model-specific reasoning/thinking effort override.")
    .addOption(
      new Option("--if-busy <behavior>", "Reject a busy thread or inject into its active work.")
        .choices(["reject", "inject"])
        .default("reject"),
    )
    .option("--wake-settled", "Explicitly allow this message to wake a settled thread.")
    .addOption(
      new Option("--delivery <mode>", "Follow-up delivery policy (V1 dispatches thread.turn.start; the mode selects client-side policy and reporting).")
        .choices(["auto", "steer", "restart", "queue"])
        .default("auto"),
    )
    .option("--handoff-note <text>", "Provider-switch note recorded with the send (CLI-side metadata; V1 sends no context-transfer row).")
    .option("--dry-run", "Build the turn command without dispatching it.")
    .option("--no-wait", "Return at turn acceptance without waiting for the provider run to settle.")
    .option("--at <time>", "Schedule the message: an ISO date-time, or HH:MM (today, or tomorrow once that has passed). It queues until then.");
}

interface WorkspaceCommandOptions {
  cwd?: string;
  workspaceMode?: WorkspaceMode;
  projectPolicy?: ProjectPolicy;
  dryRun?: boolean;
}

interface ThreadCommandOptions extends WorkspaceCommandOptions {
  /** Commander stores `--no-wait` as `wait: false` — there is no `noWait` key. */
  wait?: boolean;
  prompt?: string;
  promptFile?: string;
  stdin?: boolean;
  open?: OpenMode;
  envMode?: ThreadEnvMode | "current";
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode | "build" | "plan";
  /** Commander stores `--no-project` as `project: false`. */
  project?: boolean;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
}

async function readStdin(): Promise<string> {
  input.setEncoding("utf8");
  let value = "";
  for await (const chunk of input) value += chunk;
  return value;
}

async function resolvePrompt(options: PromptOptions): Promise<string> {
  const sources = [options.prompt !== undefined, options.promptFile !== undefined, options.stdin === true].filter(Boolean);
  if (sources.length !== 1) {
    throw new CliError("PROMPT_SOURCE_REQUIRED", "Use exactly one of --prompt, --prompt-file, or --stdin.");
  }
  if (options.prompt !== undefined) return options.prompt;
  if (options.promptFile !== undefined) return await readFile(path.resolve(options.promptFile), "utf8");
  return await readStdin();
}

/** A memory body (or an edit's replacement): `--body`, or stdin when asked or piped. */
async function resolveMemoryBody(options: { body?: string; stdin?: boolean }): Promise<string> {
  if (options.body !== undefined && options.stdin === true) {
    throw new CliError("BODY_SOURCE_REQUIRED", "Use exactly one of --body or --stdin.");
  }
  if (options.body !== undefined) return options.body;
  if (options.stdin === true || input.isTTY === false) return await readStdin();
  throw new CliError("BODY_SOURCE_REQUIRED", "Use --body <text> or --stdin for the body.", { exitCode: 2 });
}

async function confirmMemoryDelete(name: string, scope: string): Promise<boolean> {
  if (!input.isTTY || !errorOutput.isTTY) {
    throw new CliError(
      "MEMORY_DELETE_CONFIRMATION_REQUIRED",
      `Re-run with --yes to delete memory ${name} from the ${scope} scope.`,
      { exitCode: 4, details: { name, scope } },
    );
  }
  const readline = createInterface({ input, output: errorOutput });
  try {
    const answer = await readline.question(`Delete memory "${name}" from the ${scope} scope? [y/N] `);
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function confirmSettledThread(thread: ThreadEnvelope, project: ProjectEnvelope | null): Promise<boolean> {
  if (!input.isTTY || !errorOutput.isTTY) {
    throw new CliError(
      "SETTLED_THREAD_CONFIRMATION_REQUIRED",
      `Thread ${thread.id} is settled. Re-run with --wake-settled to send and wake it.`,
      { exitCode: 4, details: { threadId: thread.id, settledAt: thread.settledAt } },
    );
  }
  const readline = createInterface({ input, output: errorOutput });
  try {
    const projectLabel = project ? ` in ${project.title}` : "";
    const answer = await readline.question(
      `Thread “${thread.title}”${projectLabel} is settled. Send this message and wake it? [y/N] `,
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

function threadCreateOptions(options: ThreadCommandOptions, prompt: string): ThreadCreateOptions {
  return {
    prompt,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
    ...(options.projectPolicy ? { projectPolicy: options.projectPolicy } : {}),
    ...(options.open ? { openMode: options.open } : {}),
    ...(options.envMode ? { threadEnvMode: options.envMode === "current" ? "local" : options.envMode } : {}),
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(options.interactionMode
      ? { interactionMode: requestedInteractionMode(options.interactionMode === "build" ? "default" : options.interactionMode, "--mode") }
      : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.speedMode ? { speedMode: options.speedMode } : {}),
    ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
    ...(options.project === false ? { scratch: true } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.wait === false ? { noWait: true } : {}),
  };
}

program
  .command("tui")
  .description("Open the terminal UI for threads.")
  .action(() =>
    action(async () => {
      // For its effects: `--config` and `--server` for this invocation.
      await commandContext();
      const { runTui } = await import("../tui/index.js");
      await runTui(activeRemoteServer() ?? undefined);
    }),
  );

const server = program
  .command("server")
  .description("Run the moxen server: one process owning every provider session, shared by all clients.");

server
  .command("start")
  .description("Run the server in the foreground until Ctrl-C or `moxen server stop`.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      await serverStart(context, (result) => writeSuccess(result, context, `moxen server listening at ${result.endpoint} (pid ${result.pid}).`));
    }),
  );

server
  .command("status")
  .description("Report whether a server is running, and which protocol it speaks.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      thisMachineOnly("server status");
      const result = await serverStatus();
      writeSuccess(
        result,
        context,
        result.running ? `moxen server running at ${result.endpoint} (pid ${result.pid}).` : `No moxen server at ${result.endpoint}.`,
      );
    }),
  );

server
  .command("stop")
  .description("Stop the running server; its provider sessions end with it.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      thisMachineOnly("server stop");
      const result = await serverStop();
      writeSuccess(result, context, result.stopped ? `Stopped the moxen server at ${result.endpoint}.` : `No moxen server at ${result.endpoint}.`);
    }),
  );

const remote = program
  .command("remote")
  .description("Remote access: drive a moxen server on another machine, or let other machines drive this one's.");

remote
  .command("pair")
  .description("Pair this machine with a moxen server, using the code it shows (moxen remote code, or the TUI's command palette there).")
  .argument("<address>", "The server's address, host or host:port, as shown with the code.")
  .argument("<code>", "The pairing code, e.g. ABCD-EFGH.")
  .option("--name <name>", "What to call the server here (default: its host name).")
  .action((address: string, code: string, options: { name?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await pairServer({ address, code, ...(options.name ? { name: options.name } : {}) });
      const { server: paired } = result;
      writeSuccess(
        result,
        context,
        `Paired with ${paired.name} at ${paired.host}:${paired.port}.\nKey fingerprint: ${paired.fingerprint}\nCheck it matches the one the server showed. Use it with: moxen --server ${paired.name} …`,
      );
    }),
  );

remote
  .command("servers")
  .description("List the servers this machine has paired with.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const result = await listServers();
      writeSuccess(
        result,
        context,
        result.servers.length === 0
          ? "No paired servers."
          : result.servers.map((entry) => `${entry.name}  ${entry.host}:${entry.port}  paired ${entry.pairedAt}`).join("\n"),
      );
    }),
  );

remote
  .command("forget")
  .description("Forget a paired server here. To cut it off on the server's side too, revoke this device there.")
  .argument("<server>", "Its name or address.")
  .action((name: string) =>
    action(async () => {
      const context = await commandContext();
      const result = await forgetServer(name);
      writeSuccess(result, context, `Forgot ${result.forgotten.name}.`);
    }),
  );

remote
  .command("status")
  .description("Whether this machine's server accepts remote clients, and where.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const result = await remoteStatus(context.config);
      writeSuccess(result, context, describeStatus(result));
    }),
  );

remote
  .command("enable")
  .description("Let paired devices reach this machine's server over TLS.")
  .option("--interfaces <which>", "lan, tailscale or both.")
  .option("--port <port>", "TCP port to listen on.")
  .action((options: { interfaces?: string; port?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await enableRemote(context.config, options);
      writeSuccess(result, context, describeStatus(result));
    }),
  );

remote
  .command("disable")
  .description("Stop listening beyond this machine; paired devices stay paired.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const result = await disableRemote(context.config);
      writeSuccess(result, context, describeStatus(result));
    }),
  );

remote
  .command("code")
  .description("Show a pairing code for a new device: single-use, valid for five minutes.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const result = await pairingCode(context.config);
      writeSuccess(
        result,
        context,
        `Pairing code: ${result.code} (until ${result.expiresAt})\nOn the other machine: moxen remote pair ${result.addresses[0] ?? "<address>"} ${result.code}\nAddresses: ${result.addresses.join(", ")}\nKey fingerprint: ${result.fingerprint}`,
      );
    }),
  );

remote
  .command("devices")
  .description("List the devices paired with this machine's server.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const result = await listDevices(context.config);
      writeSuccess(
        result,
        context,
        result.devices.length === 0
          ? "No paired devices."
          : result.devices
              .map((device) => `${device.id}  ${device.name}  paired ${device.pairedAt}${device.lastSeenAt ? `, last seen ${device.lastSeenAt}` : ""}${device.connections > 0 ? `, ${device.connections} connected` : ""}`)
              .join("\n"),
      );
    }),
  );

remote
  .command("revoke")
  .description("Revoke a paired device: it is disconnected at once and can no longer connect.")
  .argument("<device-id>", "The id moxen remote devices shows.")
  .action((deviceId: string) =>
    action(async () => {
      const context = await commandContext();
      const result = await revokeDevice(context.config, deviceId);
      writeSuccess(result, context, `Revoked ${deviceId}.`);
    }),
  );

program.command("doctor").description("Check provider binaries, auth, store, and config.").action(() =>
  action(async () => {
    const context = await commandContext();
    const result = await doctor(context.config);
    writeSuccess(result, context, result.ok ? "moxen CLI is ready." : "moxen CLI has failing checks.");
    if (!result.ok) process.exitCode = 1;
  }),
);

program
  .command("update")
  .description("Update Claude Code, OpenCode or Codex with its own updater, and report the version before and after.")
  .argument("<provider>", "claude | opencode | codex")
  .action((provider: string) =>
    action(async () => {
      const context = await commandContext();
      const { update, text } = await updateCommand(context.config, parseUpdatable(provider));
      writeSuccess(update, context, text);
    }),
  );

/**
 * Text mode narrates an update's stages on stderr; `--json` stays silent so stdout holds the one final envelope.
 * A download reports every half megabyte, so only each tenth of it (or each 10 MiB when its size is unknown) is printed.
 */
function progressWriter(json: boolean): ((progress: UpdateProgress) => void) | undefined {
  if (json) return undefined;
  let lastStep = -1;
  return (progress) => {
    if (progress.stage === "downloading") {
      const bytes = progress.bytes ?? 0;
      const step = progress.total ? Math.floor((bytes / progress.total) * 10) : Math.floor(bytes / (10 * 1024 * 1024));
      if (step === lastStep) return;
      lastStep = step;
    }
    process.stderr.write(`${describeProgress(progress)}\n`);
  };
}

program
  .command("self-update")
  .description("Update Moxen to the latest GitHub release (downloaded, checked and started before it is switched to), go back to the previous version, or look for an update. This machine only.")
  .option("--check", "Only look for a newer release. Read-only; asks GitHub once.")
  .option("--install", "From an unpacked release: copy it to the app folder's versions, make it current and write the launcher.")
  .option("--rollback", "Go back to the version the last update replaced.")
  .action((options: { check?: boolean; install?: boolean; rollback?: boolean }) =>
    action(async () => {
      const mode = selfUpdateMode(options);
      const context = await commandContext();
      if (mode === "install") {
        const result = await selfUpdateInstall();
        writeSuccess(result, context, describeInstall(result));
      } else if (mode === "rollback") {
        const result = await selfUpdateRollback(context.config, progressWriter(context.json));
        writeSuccess(result, context, describeRollback(result));
      } else if (mode === "check") {
        const report = await selfUpdateCheck(context.config);
        writeSuccess(report, context, describeSelfUpdate(report));
      } else {
        const result = await selfUpdateRun(context.config, progressWriter(context.json));
        writeSuccess(result, context, describeUpdate(result));
      }
    }),
  );

/**
 * The server's config — this machine's or `--server`'s — as it reads it,
 * MCP `env`/`headers` values redacted. The config commands read and write
 * through the server only: it owns the file and the keychain, and applies
 * a change (remote access, say) as it is made.
 */
async function serverConfig(context: { config: CliConfig }) {
  return await (await cliClient(context.config)).query({ type: "config.read" });
}

const configCommand = program.command("config").description("Inspect or update the moxen server's settings.");
configCommand.command("path").action(() =>
  action(async () => {
    const context = await commandContext();
    const { path: file } = await serverConfig(context);
    writeSuccess({ path: file }, context, file);
  }),
);
configCommand.command("show").action(() =>
  action(async () => {
    const context = await commandContext();
    const { path: file, exists, config } = await serverConfig(context);
    writeSuccess({ path: file, exists, config }, context);
  }),
);
configCommand
  .command("set")
  .argument("<key>", `Setting key: ${CONFIG_KEYS.join(", ")}. List entries are addressed by id: providers.harness.profiles[<id>].baseUrl (empty value removes an entry or clears a field).`)
  .argument("<value>")
  .action((key: string, value: string) =>
    action(async () => {
      if (!isSettingKey(key)) {
        throw new CliError("INVALID_CONFIG_KEY", `Unknown config key: ${key}`);
      }
      const context = await commandContext();
      await (await cliClient(context.config)).dispatch({ type: "settings.set", key, value });
      const { path: file, config } = await serverConfig(context);
      // A secret is never echoed back.
      writeSuccess({ path: file, config }, context, secretKeyName(key) !== null ? `Saved ${key} to the OS keychain.` : `Saved ${key}=${value}.`);
    }),
  );

configCommand
  .command("get")
  .description("Read one setting: the value in force, or for a list entry its JSON.")
  .argument("<key>")
  .action((key: string) =>
    action(async () => {
      if (!isSettingKey(key)) throw new CliError("INVALID_CONFIG_KEY", `Unknown config key: ${key}`);
      const context = await commandContext();
      const { config } = await serverConfig(context);
      const entry = listTarget(key);
      const value: unknown = entry ? readListValue(config, entry) : readSetting(config, key);
      writeSuccess(
        { key, value: value ?? null, explicit: entry ? value !== undefined : (describeSettings(config).find((view) => view.descriptor.key === key)?.explicit ?? false) },
        context,
        value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value),
      );
    }),
  );

configCommand
  .command("list")
  .description("Every setting, with its current value and what it accepts.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const { config } = await serverConfig(context);
      // Straight off the schema table, so this listing and the TUI
      // settings page can never describe a key differently.
      const settings = describeSettings(config).map((view) => ({
        key: view.descriptor.key,
        section: view.descriptor.section,
        label: view.descriptor.label,
        description: view.descriptor.description,
        type: view.descriptor.kind.type,
        ...(view.descriptor.kind.type === "enum"
          ? { choices: view.descriptor.kind.choices.map((choice) => choice.value) }
          : {}),
        value: view.value ?? null,
        explicit: view.explicit,
        ...(view.items ? { items: view.items.map((item) => ({ id: item.id, label: item.title, summary: item.summary })) } : {}),
        ...(restartRequired(view.descriptor) ? { restartRequired: true } : {}),
        ...(view.descriptor.appliesAt !== undefined && view.descriptor.appliesAt !== "now" ? { appliesAt: view.descriptor.appliesAt } : {}),
        ...(view.effective ? { effective: view.effective } : {}),
      }));
      writeSuccess(
        { path: context.configPath, exists: context.configExists, settings },
        context,
        settings
          .map((setting) => `${setting.key.padEnd(34)} ${String(setting.value ?? "—")}`)
          .join("\n"),
      );
    }),
  );

const harness = program.command("harness").description("Moxen Harness: the endpoints it talks to.");
const harnessProfile = harness.command("profile").description("Saved endpoints (providers.harness.profiles). Keys are never stored: a profile names the environment variable that holds one.");
const collect = (value: string, previous: string[]): string[] => [...previous, value];

function profileLines(item: { id: string; title: string; summary: string; status: string | null }): string {
  return `${item.id}\t${item.title}\t${item.summary}${item.status ? `\t! ${item.status}` : ""}`;
}

harnessProfile
  .command("list")
  .description("List profiles.")
  .action(() =>
    action(async () => {
      const context = await commandContext();
      const result = await listProfiles(context);
      writeSuccess(result, context, result.profiles.length === 0 ? "No harness profiles. Add one with `moxen harness profile add`." : result.profiles.map((p) => `${p.id}\t${p.label}\t${p.baseUrl ?? "-"}\t${p.models.join(",")}${p.status ? `\t! ${p.status}` : ""}`).join("\n"));
    }),
  );
harnessProfile
  .command("export")
  .argument("<id>")
  .option("--out <file>", "Write the profile here instead of printing it.")
  .description("A profile as a JSON document to share. It never holds a saved key or probe results.")
  .action((id: string, options: { out?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await exportProfile(context, id, options.out !== undefined ? { out: options.out } : {});
      writeSuccess(result, context, result.path === null ? result.text.trimEnd() : `Wrote ${result.path}`);
    }),
  );
harnessProfile
  .command("import")
  .argument("<file>")
  .option("--id <id>", "Import it under this id instead of the one in the file.")
  .option("--replace", "Overwrite a profile that has the same id.")
  .description("Add a profile from a file made by `harness profile export`. A key is never imported: set one afterwards.")
  .action((file: string, options: { id?: string; replace?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const { profile } = await importProfile(context, file, { ...(options.id !== undefined ? { id: options.id } : {}), ...(options.replace === true ? { replace: true } : {}) });
      writeSuccess({ profile }, context, `Imported ${profile.id}. ${profile.status ?? "Set its key with `moxen config set` if the server needs one."}`);
    }),
  );
harnessProfile
  .command("show")
  .argument("<id>")
  .description("One profile with every field, what is in force and where it comes from, and its models' resolved quirks.")
  .action((id: string) =>
    action(async () => {
      const context = await commandContext();
      const { profile } = await showProfile(context, id);
      const lines = [profileLines(profile)];
      for (const field of profile.fields) {
        if (field.items) {
          for (const model of field.items) {
            lines.push(`  model ${model.id}: ${model.summary}`);
            for (const row of model.resolved) lines.push(`    ${row.label} = ${row.value} (${row.origin})`);
          }
        } else if (field.value !== undefined || field.effective) {
          const inForce = field.effective ? `  [in force: ${String(field.effective.value)}, from ${field.effective.origin}]` : "";
          lines.push(`  ${field.path} = ${field.value === undefined ? "(unset)" : String(field.value)}${inForce}`);
        }
      }
      writeSuccess({ profile }, context, lines.join("\n"));
    }),
  );
harnessProfile
  .command("add")
  .argument("<id>", "Lowercase letters, digits, '.', '_' or '-'.")
  .requiredOption("--base-url <url>", "The server's address, with or without /v1.")
  .option("--model <id>", "A model the endpoint serves (repeatable).", collect, [])
  .option("--label <text>", "Name shown in the model picker.")
  .option("--api-format <format>", "The API the server speaks: chat (default), responses or anthropic.")
  .option("--api-key-env <NAME>", "The NAME of the environment variable that holds the key (never the key).")
  .option("--slots <n>", "Concurrent requests the server takes (llama.cpp -np).", (value) => Number.parseInt(value, 10))
  .description("Add a profile. Tune it afterwards with `profile edit --set field=value`.")
  .action((id: string, options: { baseUrl: string; model: string[]; label?: string; apiKeyEnv?: string; apiFormat?: string; slots?: number }) =>
    action(async () => {
      const context = await commandContext();
      if (options.model.length === 0) throw new CliError("INVALID_CONFIG", "Give at least one --model.", { exitCode: 2 });
      const result = await addProfile(context, { id, baseUrl: options.baseUrl, models: options.model, ...(options.apiFormat ? { apiFormat: options.apiFormat } : {}), ...(options.label ? { label: options.label } : {}), ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}), ...(options.slots !== undefined ? { slots: options.slots } : {}) });
      writeSuccess(result, context, `Added ${id}.`);
    }),
  );
harnessProfile
  .command("edit")
  .argument("<id>")
  .option("--set <field=value>", "Set a field, e.g. baseUrl=…, sampling.topK=20, models[qwen3].contextWindow=262144, quirks.systemFirstOnly=false (repeatable).", collect, [])
  .option("--unset <field>", "Clear a field back to its default (repeatable).", collect, [])
  .option("--add-model <id>", "List another model (repeatable).", collect, [])
  .option("--remove-model <id>", "Stop listing a model (repeatable).", collect, [])
  .description("Edit a profile. Edits apply in the order add-model, set, unset, remove-model; the first one the server refuses stops the rest.")
  .action((id: string, options: { set: string[]; unset: string[]; addModel: string[]; removeModel: string[] }) =>
    action(async () => {
      const context = await commandContext();
      const result = await editProfile(context, id, { sets: options.set, unsets: options.unset, addModels: options.addModel, removeModels: options.removeModel });
      writeSuccess(result, context, result.applied.length === 0 ? "Nothing to change." : `Updated ${id}: ${result.applied.join(", ")}.`);
    }),
  );
harnessProfile
  .command("duplicate")
  .argument("<id>")
  .argument("<new-id>")
  .description("Copy a profile. Probe results stay behind: they describe one server.")
  .action((id: string, newId: string) =>
    action(async () => {
      const context = await commandContext();
      writeSuccess(await duplicateProfile(context, id, newId), context, `Copied ${id} to ${newId}.`);
    }),
  );
harnessProfile
  .command("remove")
  .argument("<id>")
  .description("Remove a profile from the config. Threads that used it keep their history but cannot send until it exists again.")
  .action((id: string) =>
    action(async () => {
      const context = await commandContext();
      const result = await removeProfile(context, id);
      writeSuccess(result, context, `Removed ${result.removed}.`);
    }),
  );
harnessProfile
  .command("test")
  .argument("<id>")
  .option("--model <id>", "Model to ask (default: the profile's first).")
  .description("Send one tiny request. Exits 1 when the endpoint does not answer.")
  .action((id: string, options: { model?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await testProfile(context, id, options.model);
      writeSuccess(result, context, `${result.ok ? "ok" : "failed"}: ${result.message}`);
      if (!result.ok) process.exitCode = 1;
    }),
  );
harness
  .command("probe")
  .argument("<profile>")
  .option("--model <id>", "Model to probe (default: the profile's first; it must be listed).")
  .option("--dry-run", "Report what was found without saving it.")
  .description(
    "Run a fixed battery of tiny requests (about a dozen, one at a time) and save what the server's chat template accepts to the model's `probed` block. Your own `quirks` are never touched. On a one-slot server the requests replace the cached prompt of the last conversation.",
  )
  .action((profile: string, options: { model?: string; dryRun?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const report = await probeProfile(context, profile, options);
      const lines = report.checks.map((check) => `${check.outcome.padEnd(12)} ${check.title}: ${check.finding}`);
      if (report.stopped) lines.push(`Stopped: ${report.stopped}`);
      for (const note of report.notes) lines.push(`Note: ${note}`);
      lines.push(report.saved ? `Saved to ${report.profileId}/${report.model}.` : "Nothing saved.");
      writeSuccess(report, context, lines.join("\n"));
      if (report.stopped) process.exitCode = 1;
    }),
  );

const git = program.command("git").description("Read this thread's checkout, and its pull or merge requests.");
git
  .command("status")
  .requiredOption("--thread <id>", "Thread whose checkout to read.")
  .option("--branch <name>", "Read history for this branch instead of the checked-out one.")
  .option("--limit <count>", "How many commits to read.", (value: string) => Number.parseInt(value, 10))
  .action((options: { thread: string; branch?: string; limit?: number }) =>
    action(async () => {
      const context = await commandContext();
      const result = await gitStatus(context.config, {
        threadId: options.thread,
        ...(options.branch !== undefined ? { branch: options.branch } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      writeSuccess(result, context);
    }),
  );

const forge = program.command("pr").description("Pull requests (GitHub) or merge requests (GitLab), via gh or glab.");
forge
  .command("status")
  .requiredOption("--thread <id>", "Thread whose remote to inspect.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      writeSuccess(await forgeStatus(context.config, options.thread), context);
    }),
  );
forge
  .command("list")
  .requiredOption("--thread <id>", "Thread whose remote to read.")
  .option("--state <state>", "open, closed, merged or all.")
  .option("--limit <count>", "How many to read.", (value: string) => Number.parseInt(value, 10))
  .action((options: { thread: string; state?: "open" | "closed" | "merged" | "all"; limit?: number }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listForgeRequests(context.config, {
        threadId: options.thread,
        ...(options.state !== undefined ? { state: options.state } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      writeSuccess(result, context);
    }),
  );
forge
  .command("view")
  .requiredOption("--thread <id>", "Thread whose remote to read.")
  .argument("<number>")
  .action((number: string, options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      writeSuccess(
        await viewForgeRequest(context.config, { threadId: options.thread, number: Number.parseInt(number, 10) }),
        context,
      );
    }),
  );
forge
  .command("create")
  .description("Open a request. This publishes to the remote.")
  .requiredOption("--thread <id>", "Thread whose checkout to open it from.")
  .requiredOption("--title <title>")
  .option("--body <text>")
  .option("--base <branch>", "Branch to merge into.")
  .option("--head <branch>", "Branch to merge from.")
  .option("--draft")
  .action((options: { thread: string; title: string; body?: string; base?: string; head?: string; draft?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await createForgeRequest(context.config, {
        threadId: options.thread,
        title: options.title,
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.base !== undefined ? { targetBranch: options.base } : {}),
        ...(options.head !== undefined ? { sourceBranch: options.head } : {}),
        ...(options.draft !== undefined ? { draft: options.draft } : {}),
      });
      writeSuccess(result, context, result.url ?? "Opened.");
    }),
  );
forge
  .command("comment")
  .description("Post a comment. This publishes to the remote.")
  .requiredOption("--thread <id>")
  .requiredOption("--body <text>")
  .argument("<number>")
  .action((number: string, options: { thread: string; body: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await commentOnForgeRequest(context.config, {
        threadId: options.thread,
        number: Number.parseInt(number, 10),
        body: options.body,
      });
      writeSuccess(result, context, `Commented on #${result.number}.`);
    }),
  );
forge
  .command("merge")
  .description("Merge a request. This changes the remote's default branch history.")
  .requiredOption("--thread <id>")
  .option("--strategy <strategy>", "merge, squash or rebase.")
  .option("--delete-branch", "Delete the source branch afterwards.")
  .argument("<number>")
  .action((number: string, options: { thread: string; strategy?: MergeStrategy; deleteBranch?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await mergeForgeRequest(context.config, {
        threadId: options.thread,
        number: Number.parseInt(number, 10),
        ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
        ...(options.deleteBranch !== undefined ? { deleteBranch: options.deleteBranch } : {}),
      });
      writeSuccess(result, context, `Merged #${result.number} (${result.strategy}).`);
    }),
  );

const projects = program.command("projects").description("Resolve and manage projects.");
projects.command("list").action(() =>
  action(async () => {
    const context = await commandContext();
    const result = await listProjects(context.config);
    const lines = result.projects.filter((project) => project.scratch !== true).map((project) => `${project.id}\t${project.workspaceRoot}\t${project.title}`);
    writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No active projects.");
  }),
);
addWorkspaceOptions(projects.command("resolve"))
  .description("Resolve a folder/repository to an existing project.")
  .action((options: WorkspaceCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await resolveProject(context.config, options);
      writeSuccess(
        result,
        context,
        result.project
          ? `${result.project.id}\t${result.project.workspaceRoot}\t${result.project.title}`
          : `No project for ${result.workspace.workspaceRoot}.`,
      );
    }),
  );
addProjectPolicyOption(addWorkspaceOptions(projects.command("ensure")))
  .description("Resolve a project and create it when policy permits.")
  .option("--dry-run", "Do not dispatch project.create.")
  .action((options: WorkspaceCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await ensureProject(context.config, options);
      writeSuccess(
        result,
        context,
        `${result.created ? "Created" : "Resolved"} ${result.project.id} (${result.project.title}) at ${result.project.workspaceRoot}.`,
      );
    }),
  );

const threads = program.command("threads").description("Create, inspect, and message threads.");
threads.command("list")
  .description("List active and settled threads.")
  .option("--cwd <path>", "Filter by the project resolved from this folder.")
  .addOption(new Option("--workspace-mode <mode>").choices(["repo", "folder"]))
  .option("--project <project-id>", "Filter by an exact project id.")
  .addOption(
    new Option("--status <status>", "Filter by thread lifecycle status.")
      .choices(["active", "settled", "snoozed", "all"])
      .default("all"),
  )
  .action((options: ThreadListCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await listThreads(context.config, options);
      const projectById = new Map(result.projects.map((project) => [project.id, project]));
      const lines = result.threads.map((thread) => {
        const project = projectById.get(thread.projectId);
        return [
          thread.status,
          thread.id,
          project?.title ?? thread.projectId,
          thread.title,
          thread.modelSelection?.model ?? "unknown-model",
          thread.updatedAt ?? "unknown-time",
        ].join("\t");
      });
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No matching threads.");
    }),
  );

threads
  .command("search <query...>")
  .description("Find threads by what is in them: title, messages, tool calls. Settled threads are included; active ones come first.")
  .option("--cwd <path>", "Only the project resolved from this folder.")
  .addOption(new Option("--workspace-mode <mode>").choices(["repo", "folder"]))
  .option("--project <project-id>", "Only an exact project id.")
  .addOption(new Option("--status <status>", "Only threads in this lifecycle status.").choices(["active", "settled", "snoozed", "all"]).default("all"))
  .option("--limit <n>", "Most threads to return.", (value) => Number.parseInt(value, 10))
  .action((words: string[], options: ThreadListCommandOptions & { limit?: number }) =>
    action(async () => {
      const context = await commandContext();
      const result = await searchThreads(context.config, words.join(" "), options);
      const lines = result.threads.flatMap((thread) => [
        `${thread.status}\t${thread.threadId}\t${thread.title}${thread.hitCount > thread.hits.length ? `\t(${thread.hitCount} matches)` : ""}`,
        ...thread.hits.map((hit) => `  ${hit.kind}${hit.source ? ` ${hit.source}` : ""}: ${hit.snippet}`),
      ]);
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No matching threads.");
    }),
  );

threads
  .command("inspect")
  .description("Inspect a thread before targeting it.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await inspectThread(context.config, options.thread);
      const latestTurn = result.thread.latestTurn as { state?: string; turnId?: string } | null | undefined;
      const snoozedUntil = (result.thread as { snoozedUntil?: string | null }).snoozedUntil ?? null;
      writeSuccess(
        result,
        context,
        [
          `Thread: ${result.thread.id}`,
          `Title: ${result.thread.title}`,
          `Project: ${result.project?.title ?? result.thread.projectId}`,
          `Status: ${result.thread.status}`,
          ...(snoozedUntil ? [`Snoozed until: ${snoozedUntil}`] : []),
          `Model: ${result.thread.modelSelection?.instanceId ?? "unknown"}/${result.thread.modelSelection?.model ?? "unknown"}`,
          `Session: ${result.thread.session?.status ?? "none"}`,
          `Latest turn: ${latestTurn ? `${latestTurn.state} (${latestTurn.turnId})` : "none"}`,
          `Updated: ${result.thread.updatedAt ?? "unknown"}`,
        ].join("\n"),
      );
    }),
  );

threads
  .command("btw")
  .description("Ask a side question on a copy of the thread's context: no tools, and never recorded in the thread. Runs alongside a turn in progress.")
  .requiredOption("--thread <thread-id>", "The thread whose context to ask from.")
  .argument("<question...>")
  .action((question: string[], options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const client = await cliClient(context.config);
      const answer = await client.dispatch({ type: "thread.side-question", threadId: options.thread, question: question.join(" ") });
      writeSuccess({ thread: options.thread, ...answer }, context, answer.text);
    }),
  );

threads
  .command("continue")
  .description("Continue a thread in a new one: same project, model and checkout, opened with a handoff written from the old thread.")
  .requiredOption("--thread <thread-id>", "The thread to continue.")
  .option("--at <time>", "Hold the handoff until then (e.g. just after a usage limit resets): an ISO date-time, or HH:MM.")
  .action((options: { thread: string; at?: string }) =>
    action(async () => {
      const context = await commandContext();
      const client = await cliClient(context.config);
      const result = await client.dispatch({
        type: "thread.continue",
        threadId: options.thread,
        ...(options.at ? { scheduledFor: parseScheduledTime(options.at) } : {}),
      });
      const { accepted: _accepted, ...envelope } = result;
      writeSuccess(
        { from: options.thread, ...envelope },
        context,
        envelope.scheduledFor === null
          ? `Continued in ${envelope.threadId} ("${envelope.title}").`
          : `Continues in ${envelope.threadId} ("${envelope.title}") at ${envelope.scheduledFor}.`,
      );
    }),
  );

threads
  .command("read")
  .description("Read a thread projection without truncation.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .option("--last-turn", "Return only entries assigned to the latest turn (messages and turn-items views).")
  .addOption(
    new Option("--view <view>", "Which thread projection to read.")
      .choices(["messages", "turn-items", "plans", "checkpoints", "transfers"])
      .default("messages"),
  )
  .action((options: ThreadReadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await readThread(context.config, options.thread, {
        lastTurn: options.lastTurn === true,
        ...(options.view ? { view: options.view } : {}),
      });
      const thread = result.thread as unknown as {
        id: string;
        title: string;
        projectId: string;
        view?: string;
        messageFilter?: { turnId?: string | null };
        messageCount?: number;
        messages?: Array<{ role: string; turnId: string | null; text: string }>;
        itemCount?: number;
        items?: Array<{ kind: string; summary: string; turnId?: string | null }>;
        planCount?: number;
        plans?: Array<{ id: string; turnId?: string | null }>;
        checkpointCount?: number;
        checkpoints?: Array<{ turnId: string; status: string }>;
        transferCount?: number;
        note?: string;
      };
      const header = [
        `Thread: ${thread.id}`,
        `Title: ${thread.title}`,
        `Project: ${result.project?.title ?? thread.projectId}`,
        ...(thread.messageFilter ? [`Turn: ${thread.messageFilter.turnId ?? "none"}`] : []),
      ];
      if (thread.view === "turn-items") {
        const lines = (thread.items ?? []).map(
          (item) => `[${item.kind}${item.turnId ? ` turn=${item.turnId}` : ""}]\n${item.summary}`,
        );
        writeSuccess(
          result,
          context,
          [...header, `Items: ${thread.itemCount ?? 0}`, "", lines.join("\n\n") || "No turn items."].join("\n"),
        );
        return;
      }
      if (thread.view === "plans") {
        const lines = (thread.plans ?? []).map(
          (plan) => `- ${plan.id}${plan.turnId ? ` (turn=${plan.turnId})` : ""}`,
        );
        writeSuccess(
          result,
          context,
          [...header, `Plans: ${thread.planCount ?? 0}`, "", lines.join("\n") || "No plans."].join("\n"),
        );
        return;
      }
      if (thread.view === "checkpoints") {
        const lines = (thread.checkpoints ?? []).map(
          (checkpoint) => `- turn=${checkpoint.turnId} status=${checkpoint.status}`,
        );
        writeSuccess(
          result,
          context,
          [...header, `Checkpoints: ${thread.checkpointCount ?? 0}`, "", lines.join("\n") || "No checkpoints."].join("\n"),
        );
        return;
      }
      if (thread.view === "transfers") {
        writeSuccess(
          result,
          context,
          [...header, `Transfers: ${thread.transferCount ?? 0}`, "", thread.note ?? "No transfers."].join("\n"),
        );
        return;
      }
      const transcript = (thread.messages ?? [])
        .map((message) => {
          const turn = message.turnId === null ? "" : ` turn=${message.turnId}`;
          return `[${message.role}${turn}]\n${message.text}`;
        })
        .join("\n\n");
      writeSuccess(
        result,
        context,
        [...header, `Messages: ${thread.messageCount ?? 0}`, "", transcript || "No messages."].join("\n"),
      );
    }),
  );

addThreadOptions(threads.command("create"))
  .description("Create a new project thread and start its first turn.")
  .action((options: ThreadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await createHandoverThread(context.config, threadCreateOptions(options, prompt));
      writeSuccess(
        result,
        context,
        `${result.dryRun ? "Would create" : "Created"} thread ${result.thread.id} in ${result.project.title}.`,
      );
    }),
  );
addSendOptions(threads.command("send"))
  .description("Send a follow-up message to an existing thread.")
  .action((options: ThreadSendCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const rawThreadId = options.thread ?? options.threadId;
      const threadId = rawThreadId?.trim();
      if (!threadId) {
        throw new CliError("THREAD_ID_REQUIRED", "Use --thread <id> or --thread-id <id> with a non-empty thread id.", { exitCode: 2 });
      }
      if (
        options.thread !== undefined &&
        options.threadId !== undefined &&
        options.thread.trim() !== options.threadId.trim()
      ) {
        throw new CliError("INVALID_THREAD_OPTION", "--thread and --thread-id must match when both are provided.");
      }
      const result = await sendThreadMessage(context.config, {
        threadId,
        prompt,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.speedMode ? { speedMode: options.speedMode } : {}),
        ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
        ...(options.open ? { openMode: options.open } : {}),
        ...(options.ifBusy ? { ifBusy: options.ifBusy } : {}),
        ...(options.wakeSettled ? { wakeSettled: true } : {}),
        ...(options.delivery ? { delivery: options.delivery } : {}),
        ...(options.handoffNote ? { handoffNote: options.handoffNote } : {}),
        ...(options.at ? { scheduledFor: parseScheduledTime(options.at) } : {}),
        ...(!context.json && !options.stdin ? { confirmSettled: confirmSettledThread } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.wait === false ? { noWait: true } : {}),
      });
      const projectLabel = result.project ? ` in ${result.project.title}` : "";
      writeSuccess(
        result,
        context,
        `${result.dryRun ? "Would send to" : "Sent to"} thread ${result.thread.id}${projectLabel}.`,
      );
    }),
  );

threads
  .command("settle")
  .description("Mark a thread as settled after verifying it can be settled.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .option("--stop", "Interrupt running work in the thread and its delegated tasks first, instead of refusing.")
  .action((options: { thread: string; stop?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await settleThread(context.config, options.thread, { stop: options.stop === true });
      writeSuccess(
        result,
        context,
        `Settled thread ${result.thread.id}.`,
      );
    }),
  );

threads
  .command("unsettle")
  .description("Mark a settled thread as active without starting a turn.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await unsettleThread(context.config, options.thread);
      writeSuccess(
        result,
        context,
        `Marked thread ${result.thread.id} active.`,
      );
    }),
  );

threads
  .command("background")
  .description("List the background work in a thread's live session, or stop one task.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .option("--stop <task-id>", "Stop this background task instead of listing.")
  .action((options: { thread: string; stop?: string }) =>
    action(async () => {
      const context = await commandContext();
      if (options.stop) {
        const stopped = await stopBackgroundTask(context.config, options.thread, options.stop);
        writeSuccess(stopped, context, `Stopped background task ${stopped.taskId}.`);
        return;
      }
      const result = await listBackgroundTasks(context.config, options.thread);
      const lines = result.tasks.map((task) => `${task.taskId}\t${task.taskType ?? "-"}\t${task.description}`);
      writeSuccess(
        result,
        context,
        !result.live
          ? `No live session for thread ${result.threadId} here.`
          : lines.length > 0
            ? lines.join("\n")
            : "No background tasks running.",
      );
    }),
  );

threads
  .command("questions")
  .description("List the questions a running turn is waiting on.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listQuestions(context.config, options.thread);
      const lines = result.requests.flatMap((request) => [
        `Request ${request.requestId}:`,
        ...request.questions.map(
          (question, index) =>
            `  ${index + 1}. ${question.question}${question.options.length > 0 ? ` [${question.options.map((option) => option.label).join(" | ")}]` : ""}`,
        ),
      ]);
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : `Thread ${result.thread.id} is not waiting on a question.`);
    }),
  );

threads
  .command("answer")
  .description("Answer the question a running turn is waiting on (one --answer per question, in order).")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .option("--request <request-id>", "Which open question, when there is more than one.")
  .requiredOption(
    "--answer <text>",
    "An answer; repeat for each question. Comma-separate a multi-select.",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action((options: { thread: string; request?: string; answer: string[] }) =>
    action(async () => {
      const context = await commandContext();
      const result = await answerQuestion(context.config, options.thread, {
        ...(options.request !== undefined ? { requestId: options.request } : {}),
        answers: options.answer,
      });
      writeSuccess(result, context, `Answered ${result.request.requestId} on thread ${result.thread.id}.`);
    }),
  );

threads
  .command("dismiss")
  .description("Decline the question a running turn is waiting on; the agent carries on without an answer.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .option("--request <request-id>", "Which open question, when there is more than one.")
  .action((options: { thread: string; request?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await dismissQuestion(context.config, options.thread, {
        ...(options.request !== undefined ? { requestId: options.request } : {}),
      });
      writeSuccess(result, context, `Dismissed ${result.request.requestId} on thread ${result.thread.id}.`);
    }),
  );

threads
  .command("revert")
  .description("Revert the conversation to its first N turns. Files are left as they are unless --restore-files.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .requiredOption("--keep <turns>", "How many turns to keep (0 clears the conversation).")
  .option("--restore-files", "Also put the files back to how they were before the first dropped turn (untracked ones included).")
  .action((options: { thread: string; keep: string; restoreFiles?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await revertConversation(context.config, options.thread, options.keep, {
        ...(options.restoreFiles === true ? { restoreFiles: true } : {}),
      });
      writeSuccess(
        result,
        context,
        result.removedTurns === 0
          ? `Thread ${result.thread.id} already has ${result.keptTurns} turn(s); nothing to revert.`
          : `Reverted thread ${result.thread.id} to ${result.keptTurns} turn(s), dropping ${result.removedTurns}.`,
      );
    }),
  );

threads
  .command("archive")
  .description("Archive a thread: it leaves the lists and refuses new turns.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await archiveThread(context.config, options.thread);
      writeSuccess(result, context, `Archived thread ${result.thread.id}.`);
    }),
  );

threads
  .command("delete")
  .description("Delete a thread. Its ledger stays on disk, marked deleted.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await deleteThread(context.config, options.thread);
      writeSuccess(result, context, `Deleted thread ${result.thread.id}.`);
    }),
  );

threads
  .command("rename")
  .description("Change a thread's title.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .requiredOption("--title <title>", "New title.")
  .action((options: { thread: string; title: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await renameThread(context.config, options.thread, options.title);
      writeSuccess(result, context, `Renamed thread ${result.thread.id} to "${result.thread.title}".`);
    }),
  );

threads
  .command("snooze")
  .description("Snooze an active thread until an ISO-8601 datetime.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .requiredOption("--until <datetime>", "Wake time as an ISO-8601 datetime.")
  .action((options: { thread: string; until: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await snoozeThread(context.config, options.thread, options.until);
      writeSuccess(
        result,
        context,
        `Snoozed thread ${result.thread.id} until ${result.thread.snoozedUntil}.`,
      );
    }),
  );

threads
  .command("unsnooze")
  .description("Clear the snooze on a thread.")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .action((options: { thread: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await unsnoozeThread(context.config, options.thread);
      writeSuccess(
        result,
        context,
        `Unsnoozed thread ${result.thread.id}.`,
      );
    }),
  );

threads
  .command("interrupt")
  .description("Interrupt the active turn on a thread (dispatches thread.turn.interrupt).")
  .requiredOption("--thread <thread-id>", "Exact thread id.")
  .option("--run <turn-id>", "Interrupt a specific turn; omit to target the active turn.")
  .action((options: { thread: string; run?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await interruptThread(context.config, options.thread, {
        ...(options.run ? { run: options.run } : {}),
      });
      writeSuccess(
        result,
        context,
        result.result === "no_active_run"
          ? `Thread ${result.thread.id} has no active turn; nothing was dispatched.`
          : `Interrupted thread ${result.thread.id}.`,
      );
    }),
  );

threads
  .command("delegate")
  .description("Delegate a self-contained task to a new child thread in the same project, then wait for its terminal turn.")
  .requiredOption("--thread <thread-id>", "Parent thread id that owns the delegated task.")
  .option("--prompt <text>", "Task prompt for the child thread.")
  .option("--prompt-file <path>", "Read the task prompt from a UTF-8 file.")
  .option("--stdin", "Read the task prompt from stdin.")
  .option("--title <title>", "Child thread title (defaults to the task's first line).")
  .addOption(new Option("--open <mode>").choices(["auto", "desktop", "browser", "none"]))
  .option("--provider <instance-id>", "Override the inherited provider instance for the child.")
  .option("--model <slug>", "Override the inherited model for the child.")
  .addOption(
    new Option("--speed, --speed-mode <mode>", "Model speed mode override.")
      .choices(["standard", "fast"]),
  )
  .option("--thinking-effort <effort>", "Model-specific reasoning/thinking effort override.")
  .addOption(new Option("--mode <mode>", "Build (default), or a single read-only researcher.").choices(["build", "research"]))
  .option("--research-size <researchers,critics>", "Start a full Research run with this user-chosen size: 1–8 researchers, 1 or 3 critics and one finalizer.")
  .option("--research-models <json>", "Role model defaults: a JSON object keyed by researcher, critic and finalizer, each with provider, model and thinkingEffort. Requires --research-size.")
  .option("--no-wait", "Return after dispatching without waiting for the child's terminal turn.")
  .option("--timeout-ms <ms>", "Wait budget in milliseconds (default 600000). Expiring it ends the wait without cancelling the child.")
  .option("--dry-run", "Build the child thread commands without dispatching them.")
  .option("--idempotency-key <uuid>", "Client-generated key: repeating the delegation with the same key returns the original task instead of starting a duplicate.")
  .addOption(
    new Option("--isolation <mode>", "shared: the parent's checkout (default). worktree: the child's own git worktree, on a branch cut from the parent's.")
      .choices(["shared", "worktree"]),
  )
  .action((options: ThreadDelegateCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const rawThreadId = options.thread?.trim();
      if (!rawThreadId) {
        throw new CliError("THREAD_ID_REQUIRED", "Use --thread <id> with a non-empty parent thread id.", { exitCode: 2 });
      }
      const rawTimeout = options.timeoutMs?.trim();
      const result = await delegateTask(context.config, {
        parentThreadId: rawThreadId,
        task: prompt,
        ...(options.mode ? { interactionMode: options.mode === "build" ? "default" as const : "research" as const } : {}),
        ...(options.researchSize !== undefined ? { researchSize: options.researchSize } : {}),
        ...(options.researchModels !== undefined ? { researchModels: options.researchModels } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.speedMode ? { speedMode: options.speedMode } : {}),
        ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
        ...(options.wait === false ? { wait: false } : {}),
        ...(rawTimeout !== undefined && rawTimeout.length > 0 ? { timeoutMs: Number(rawTimeout) } : {}),
        ...(options.open ? { openMode: options.open } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.isolation ? { isolation: options.isolation } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      const task = result.task as { status: string; waitTimedOut: boolean };
      writeSuccess(
        result,
        context,
        result.dryRun
          ? `Would delegate to thread ${result.child.id} in ${result.project?.title ?? result.child.projectId}.`
          : task.waitTimedOut
            ? `Delegated to thread ${result.child.id}; wait timed out (status ${task.status}). Re-poll with task-status.`
            : `Delegated to thread ${result.child.id}; child turn ${task.status}.`,
      );
    }),
  );

threads
  .command("task-status")
  .description("Read a delegated task's status from its parent thread and child thread id.")
  .requiredOption("--thread <thread-id>", "Parent thread id that owns the delegated task.")
  .requiredOption("--task <task-id>", "Delegated task id (the child thread id).")
  .action((options: ThreadTaskCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await taskStatus(context.config, options.thread, options.task);
      const task = result.task as { status: string; workState: string };
      writeSuccess(
        result,
        context,
        `Task ${result.task.taskId} is ${task.status} (${task.workState}).`,
      );
    }),
  );

threads
  .command("task-cancel")
  .description("Interrupt a delegated task's active turn.")
  .requiredOption("--thread <thread-id>", "Parent thread id that owns the delegated task.")
  .requiredOption("--task <task-id>", "Delegated task id (the child thread id).")
  .action((options: ThreadTaskCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const result = await cancelTask(context.config, options.thread, options.task);
      const task = result.task as { status: string };
      writeSuccess(
        result,
        context,
        `Task ${result.task.taskId} cancel result: ${task.status}.`,
      );
    }),
  );

addThreadOptions(program.command("handover"))
  .description("Resolve the current repo, ensure its project, and start a new thread.")
  .action((options: ThreadCommandOptions) =>
    action(async () => {
      const context = await commandContext();
      const prompt = await resolvePrompt(options);
      const result = await createHandoverThread(context.config, threadCreateOptions(options, prompt));
      writeSuccess(
        result,
        context,
        `${result.dryRun ? "Would hand over to" : "Handed over to"} thread ${result.thread.id} in ${result.project.title}.`,
      );
    }),
  );

function formatUsageSummary(usage: ProviderUsageLimits | null): string {
  if (!usage) return "-";
  if (usage.unavailable) return `unavailable (${usage.unavailable.reason})`;
  if (usage.windows.length === 0) return "-";
  return usage.windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(", ");
}

const providers = program.command("providers").description("List configured provider instances.");
const skills = program.command("skills").description("Inspect user skill packages and choose their providers.");
skills.command("list")
  .description("List global or registered-project skill packages.")
  .option("--project <project-id>", "Registered project; omit for global skills.")
  .action((options: { project?: string }) => action(async () => {
    const context = await commandContext();
    const result = await (await cliClient(context.config)).query({ type: "skills.manage.list", ...(options.project ? { projectId: options.project } : {}) });
    writeSuccess(result, context, result.skills.map((skill) => `${skill.source}\t${skill.folder}\t${skill.enabled ? "enabled" : "disabled"}\t${skill.providers?.join(",") || "all"}`).join("\n") || "No skill packages.");
  }));
skills.command("providers")
  .description("Choose providers for a skill package; all means every provider.")
  .requiredOption("--source <source>", "Skill source: agents or claude.")
  .requiredOption("--folder <folder>", "Skill package folder name.")
  .requiredOption("--providers <kinds>", "Comma-separated claude,codex,opencode,harness; all for every provider.")
  .option("--project <project-id>", "Registered project; omit for global skills.")
  .action((options: { source: string; folder: string; providers: string; project?: string }) => action(async () => {
    const context = await commandContext();
    // The server validates the source and provider names, including over remote connections.
    const command = { type: "skills.providers.set", source: options.source, folder: options.folder, providers: options.providers === "all" ? [] : options.providers.split(",").map((kind) => kind.trim()), ...(options.project ? { projectId: options.project } : {}) } as import("../server/api.js").CommandOf<"skills.providers.set">;
    const result = await (await cliClient(context.config)).dispatch(command);
    writeSuccess(result, context, "Skill providers saved. Start a new provider session to apply them.");
  }));

const usage = program.command("usage").description("Inspect shared quota forecasts and manage protected threads.");
usage.command("status").description("Show forecasts and the durable recovery queue.").action(() => action(async () => {
  const context = await commandContext();
  const client = await cliClient(context.config);
  const result = await client.query({ type: "usage.protection" });
  writeSuccess(result, context, [
    ...result.forecasts.map((row) => `${row.provider}\t${row.label}\t${row.usedPercent}%\t${row.remainingWorkMs === null ? "unknown" : `~${Math.ceil(row.remainingWorkMs / 60000)} min`}\treset ${row.resetsAt ?? "unknown"}`),
    ...result.queue.map((row, index) => `${index + 1}\t${row.threadId}\t${row.phase}\t${row.title}${row.error ? `\t${row.error}` : ""}`),
  ].join("\n") || "No usage forecasts or protected threads.");
}));
usage.command("wrap").description("Pause and wrap up every running thread on a provider account.").requiredOption("--provider <driver>", "The quota owner: claude or codex.").action((options: { provider: string }) => action(async () => {
  const context = await commandContext();
  const client = await cliClient(context.config);
  const result = await client.dispatch({ type: "usage.wrap", provider: options.provider });
  writeSuccess(result, context, "Threads queued for orderly wrap-up.");
}));
usage.command("queue").description("Reorder a protected thread or cancel its automatic recovery.").requiredOption("--thread <id>", "The protected thread.")
  .addOption(new Option("--move <direction>", "Where to move it, or cancel recovery.").choices(["first", "last", "cancel"]).makeOptionMandatory())
  .action((options: { thread: string; move: "first" | "last" | "cancel" }) => action(async () => {
    const context = await commandContext();
    const client = await cliClient(context.config);
    const result = await client.dispatch({ type: "usage.queue", threadId: options.thread, direction: options.move });
    writeSuccess(result, context, "Usage recovery queue updated.");
  }));
providers
  .command("list")
  .description("List provider instances with live status.")
  .option("--refresh", "Probe providers for fresh status before listing.")
  .action((options: { refresh?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listProviders(context.config, options);
      const lines = result.providers.map(
        (provider) =>
          `${provider.instanceId}\t${provider.driver}\t${provider.displayName ?? "-"}\t${provider.enabled ? "enabled" : "disabled"}\t${provider.status ?? "-"}\t${provider.authStatus ?? "-"}\t${provider.models.length} models\t${formatUsageSummary(provider.usageLimits)}`,
      );
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No provider instances.");
    }),
  );

providers
  .command("skills")
  .description("List the skills and slash commands a provider resolves for a directory.")
  .requiredOption("--provider <instance-id>", "Provider instance id (claudeAgent, opencode/<provider>, …).")
  .option("--cwd <path>", "Directory to resolve for (defaults to the current working directory).")
  .action((options: { provider: string; cwd?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listSkills(context.config, options);
      const lines = [
        ...result.skills.map((skill) => `skill\t${result.trigger}${skill.name}\t${skill.shortDescription ?? skill.description ?? ""}`),
        ...result.commands.map((command) => `command\t/${command.name}\t${command.description ?? ""}`),
      ];
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No skills or commands.");
    }),
  );

const models = program.command("models").description("List models on configured provider instances.");
models
  .command("list")
  .description("List models with their effort-option descriptors.")
  .option("--provider <instance-id>", "Only list models on this provider instance.")
  .option("--refresh", "Probe providers for fresh status before listing.")
  .action((options: { provider?: string; refresh?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listModels(context.config, options);
      const lines = result.providers.flatMap((provider) =>
        provider.models.map(
          (model) =>
            `${provider.instanceId}\t${model.slug}\t${model.name}\t${model.isCustom ? "custom" : "built-in"}\t${model.isDefault === true ? "default" : "-"}\t${model.isHidden ? "hidden" : "-"}`,
        ),
      );
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No models.");
    }),
  );
models
  .command("hide")
  .description("Hide a model slug from the pickers (still usable when named explicitly).")
  .requiredOption("--provider <instance-id>", "Provider instance id.")
  .requiredOption("--model <slug>", "Model slug.")
  .action((options: { provider: string; model: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await setModelHidden(context.config, { ...options, hidden: true });
      writeSuccess(result, context, `Hid ${result.model.slug} on ${result.provider.instanceId}.`);
    }),
  );
models
  .command("show")
  .description("Show a hidden model slug in the pickers again.")
  .requiredOption("--provider <instance-id>", "Provider instance id.")
  .requiredOption("--model <slug>", "Model slug.")
  .action((options: { provider: string; model: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await setModelHidden(context.config, { ...options, hidden: false });
      writeSuccess(result, context, `Showing ${result.model.slug} on ${result.provider.instanceId}.`);
    }),
  );

const memory = program.command("memory").description("Moxen memory: what agents keep across sessions, per project and global.");
const embeddings = memory.command("embeddings").description("Set up and inspect local semantic memory search on the server.");
for (const operation of ["setup", "rebuild", "status", "unload"] as const) {
  embeddings.command(operation)
    .description({ setup: "Download the optional q4 text model and runtime, then index existing memories.", rebuild: "Repair embeddings from current memory files without downloading.", status: "Show runtime readiness, download progress and the last indexing count.", unload: "Stop the model process and cancel its pending work." }[operation])
    .option("--cwd <path>", "The project resolved from this folder on the server.")
    .option("--all", "Index global memory and all registered projects; skip projects with memory off.")
    .action((options: { cwd?: string; all?: boolean }) => action(async () => {
      const context = await commandContext();
      const result = await memoryEmbeddings(context.config, operation, options);
      writeSuccess(result, context, JSON.stringify(result, null, 2));
    }));
}
memory
  .command("list")
  .description("List the memories a project's threads see: the global ones, then the project's.")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .action((options: { cwd?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listMemory(context.config, options);
      const lines = result.memories.map((entry) => `${entry.scope}\t${entry.name}\t${entry.type}\t${entry.description}`);
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No memories.");
    }),
  );
memory
  .command("read")
  .description("Read one memory in full. Without --scope, the project's first, then the global.")
  .argument("<name>", "The memory's name.")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .addOption(new Option("--scope <scope>").choices(["project", "global"]))
  .action((name: string, options: { cwd?: string; scope?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await readMemory(context.config, name, options);
      writeSuccess(result, context, result.body);
    }),
  );
memory
  .command("save")
  .description("Save (or replace) one memory. The body comes from --body or stdin.")
  .argument("<name>", "The memory's name (a short kebab-case slug).")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .addOption(new Option("--scope <scope>").choices(["project", "global"]).default("project"))
  .requiredOption("--description <text>", "One line saying what the memory is about.")
  .requiredOption("--type <type>", "One of user, feedback, project, reference.")
  .option("--body <text>", "The memory itself.")
  .option("--stdin", "Read the body from stdin.")
  .action((name: string, options: { cwd?: string; scope?: string; description: string; type: string; body?: string; stdin?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const body = await resolveMemoryBody(options);
      const result = await saveMemory(context.config, name, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        description: options.description,
        memoryType: options.type,
        body,
      });
      writeSuccess(result, context, result.replaced ? `Replaced ${result.name} in the ${result.scope} scope.` : `Saved ${result.name} to the ${result.scope} scope.`);
    }),
  );
memory
  .command("edit")
  .description("Replace one piece of a memory's body (old text must occur exactly once). The replacement comes from --new-text, --body, or stdin.")
  .argument("<name>", "The memory's name.")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .addOption(new Option("--scope <scope>").choices(["project", "global"]).default("project"))
  .requiredOption("--old-text <text>", "The text to replace.")
  .option("--new-text <text>", "What to put in its place (an empty string deletes the text).")
  .option("--body <text>", "Alias for --new-text.")
  .option("--stdin", "Read the replacement from stdin.")
  .option("--description <text>", "Replace the description too.")
  .action((name: string, options: { cwd?: string; scope?: string; oldText: string; newText?: string; body?: string; stdin?: boolean; description?: string }) =>
    action(async () => {
      const context = await commandContext();
      const newText = options.newText ?? options.body ?? await resolveMemoryBody({ ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
      const result = await editMemory(context.config, name, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        oldText: options.oldText,
        newText,
        ...(options.description !== undefined ? { description: options.description } : {}),
      });
      writeSuccess(result, context, `Edited ${result.name} in the ${result.scope} scope.`);
    }),
  );
memory
  .command("delete")
  .description("Delete one memory. Without --yes it asks first; outside a terminal --yes is required.")
  .argument("<name>", "The memory's name.")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .addOption(new Option("--scope <scope>").choices(["project", "global"]).default("project"))
  .option("--yes", "Delete without asking.")
  .action((name: string, options: { cwd?: string; scope?: string; yes?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await deleteMemory(context.config, name, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(options.yes === true ? {} : { confirm: confirmMemoryDelete }),
      });
      writeSuccess(result, context, `Deleted ${result.name} from the ${result.scope} scope.`);
    }),
  );
memory
  .command("search <query...>")
  .description("Search the current project's and global memories by keyword (semantic ranking when set up).")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .addOption(new Option("--scope <scope>").choices(["project", "global"]))
  .option("--limit <n>", "Most memories to return.", (value: string) => Number.parseInt(value, 10))
  .action((words: string[], options: { cwd?: string; scope?: string; limit?: number }) =>
    action(async () => {
      const context = await commandContext();
      const result = await searchMemory(context.config, words.join(" "), options);
      const lines = result.memories.map((entry) => `${entry.scope}\t${entry.name}\t${entry.description}\t${entry.excerpt}`);
      writeSuccess(result, context, lines.length > 0 ? lines.join("\n") : "No matching memories.");
    }),
  );
memory
  .command("import-claude")
  .description("Copy Claude Code's auto memory for this project into Moxen's (user memories go to the global scope). Never done unasked.")
  .option("--cwd <path>", "The project resolved from this folder (default: the current one).")
  .action((options: { cwd?: string }) =>
    action(async () => {
      const context = await commandContext();
      const result = await importClaudeMemory(context.config, options);
      const skipped = result.skipped.length > 0 ? ` Kept ${result.skipped.length} Moxen already had: ${result.skipped.join(", ")}.` : "";
      writeSuccess(result, context, `Imported ${result.imported.length} memor${result.imported.length === 1 ? "y" : "ies"} from ${result.from}.${skipped}`);
    }),
  );

const efforts = program.command("efforts").description("List effort options for a provider model.");
efforts
  .command("list")
  .description("List the selectable effort/option values a model supports.")
  .requiredOption("--provider <instance-id>", "Provider instance id.")
  .requiredOption("--model <slug>", "Model slug.")
  .option("--refresh", "Probe providers for fresh status before listing.")
  .action((options: { provider: string; model: string; refresh?: boolean }) =>
    action(async () => {
      const context = await commandContext();
      const result = await listEfforts(context.config, options);
      const lines = result.model.efforts.map(
        (effort) =>
          `${effort.id}\t${effort.label}\t${effort.currentValue ?? "-"}\t${effort.choices.map((choice) => `${choice.id}${choice.isDefault === true ? "*" : ""}`).join(",")}`,
      );
      writeSuccess(
        result,
        context,
        lines.length > 0 ? lines.join("\n") : `No effort options for ${options.model}.`,
      );
    }),
  );

/** Build-time reference only: constructing the command tree never runs an action. */
export function commandReference(): Array<{ id: string; title: string; sections: Array<{ id: string; title: string; text: string }> }> {
  const pages: ReturnType<typeof commandReference> = [];
  const walk = (command: Command, parents: readonly string[]): void => {
    const names = [...parents, command.name()];
    const title = names.join(" ");
    const argumentsText = command.registeredArguments.map((argument) =>
      `${argument.required ? "<" : "["}${argument.name()}${argument.variadic ? "..." : ""}${argument.required ? ">" : "]"}`,
    ).join(" ");
    const text = [
      `${title}${argumentsText ? ` ${argumentsText}` : ""}`,
      command.description(),
      ...command.registeredArguments.map((argument) => `${argument.name()}: ${argument.description}`),
      ...command.options.map((option) => `${option.flags}${option.mandatory ? " (required)" : ""}: ${option.description}${option.defaultValue !== undefined ? ` Default: ${JSON.stringify(option.defaultValue)}.` : ""}${option.argChoices ? ` Choices: ${option.argChoices.join(", ")}.` : ""}`),
      ...(command.commands.length ? [`Subcommands: ${command.commands.map((child) => child.name()).join(", ")}.`] : []),
      ...(parents.length ? ["Global options: see knowledge_read({id: 'cli-moxen'}). Parent options appear on the parent command's page."] : []),
    ].filter(Boolean).join("\n");
    pages.push({ id: `cli-${names.join("-")}`, title, sections: [{ id: "usage", title: "Usage", text }] });
    for (const child of command.commands) walk(child, names);
  };
  walk(program, []);
  return pages;
}

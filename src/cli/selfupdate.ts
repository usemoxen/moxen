/**
 * `moxen self-update`: `--check` says what Moxen this server is and whether GitHub Releases has a newer one (it
 * only reads; on `--server <name>` the answer is that paired server's install, labelled as remote). Installing,
 * updating and rolling back act on this machine's own app folder: the CLI refuses `--server` first, and the
 * server's transport refuses both commands to any remote client anyway. Updating and rolling back run in the
 * server (`app.update.apply`, `app.update.rollback`); `--install` runs from an unpacked archive, before there is
 * an installed Moxen, so it stays here.
 */
import { randomUUID } from "node:crypto";

import { CliError } from "../core/errors.js";
import { installRelease, type InstallResult } from "../core/selfupdate/installer.js";
import type { RollbackResult, UpdateCheck, UpdateProgress, UpdateResult } from "../core/selfupdate/vocabulary.js";
import type { CliConfig } from "../core/types.js";
import type { CommandOf, CommandResult } from "../server/api.js";
import { activeRemoteServer, cliClient } from "./infra/client.js";

/** The `--json` data: the server's answer, plus which server that was (null: this machine's). */
export interface SelfUpdateReport extends UpdateCheck {
  readonly remote: string | null;
}

export async function selfUpdateCheck(config: CliConfig): Promise<SelfUpdateReport> {
  const check = await (await cliClient(config)).query({ type: "app.update.check" });
  return { remote: activeRemoteServer(), ...check };
}

function requireLocal(what: string): void {
  const remote = activeRemoteServer();
  if (remote !== null) {
    throw new CliError("SELF_UPDATE_REMOTE", `${what} is done on the machine itself, not through a paired server (${remote}). Run it there.`, { exitCode: 2 });
  }
}

export type SelfUpdateMode = "update" | "check" | "install" | "rollback";

/** Which of the flags was given; combinations that make no sense are an argument error (exit 2). */
export function selfUpdateMode(options: { check?: boolean; install?: boolean; rollback?: boolean }): SelfUpdateMode {
  const given = (["check", "install", "rollback"] as const).filter((flag) => options[flag] === true);
  if (given.length > 1) throw new CliError("INVALID_ARGUMENT", `Use one of --${given.join(", --")}, not several together.`, { exitCode: 2 });
  return given[0] ?? "update";
}

/** `--install`: this machine only, never a paired server, and never from a source checkout (the installer refuses that first). */
export async function selfUpdateInstall(): Promise<InstallResult> {
  requireLocal("Installing");
  return await installRelease();
}

/**
 * Runs an update command on this machine's server and relays its stages to `onProgress`. The stages arrive as
 * shell events tagged with this command's id; the subscription is ready (`synchronized`) before the command goes,
 * so none is missed. The server starts if none runs, like for every command: it is what updates, and what knows
 * which version it runs so that one is never pruned.
 */
async function runOnServer<T extends "app.update.apply" | "app.update.rollback">(config: CliConfig, type: T, onProgress: ((progress: UpdateProgress) => void) | undefined): Promise<CommandResult<T>> {
  const client = await cliClient(config);
  const commandId = randomUUID();
  let unsubscribe: (() => void) | null = null;
  try {
    if (onProgress !== undefined) {
      await new Promise<void>((ready, failed) => {
        unsubscribe = client.subscribeShell(
          {},
          (frame) => {
            if (frame.kind === "synchronized") ready();
            else if (frame.kind === "event" && frame.event.type === "app.update-progress" && frame.event.payload.commandId === commandId) onProgress(frame.event.payload.progress);
          },
          failed,
        );
      });
    }
    return await client.dispatch({ type, commandId } as CommandOf<T>);
  } finally {
    (unsubscribe as (() => void) | null)?.();
  }
}

/** The plain command: download, test and switch to the latest release. This machine only. */
export async function selfUpdateRun(config: CliConfig, onProgress?: (progress: UpdateProgress) => void): Promise<UpdateResult> {
  requireLocal("Updating");
  return await runOnServer(config, "app.update.apply", onProgress);
}

/** `--rollback`: back to the recorded previous version. This machine only. */
export async function selfUpdateRollback(config: CliConfig, onProgress?: (progress: UpdateProgress) => void): Promise<RollbackResult> {
  requireLocal("Rolling back");
  return await runOnServer(config, "app.update.rollback", onProgress);
}

const MIB = 1024 * 1024;

/** One line per stage; a download says how far it is. */
export function describeProgress(progress: UpdateProgress): string {
  const version = progress.version === undefined ? "" : ` ${progress.version}`;
  switch (progress.stage) {
    case "checking":
      return "Checking for the latest release...";
    case "downloading": {
      const done = `${((progress.bytes ?? 0) / MIB).toFixed(1)} MiB`;
      return progress.total == null ? `Downloading Moxen${version}: ${done}` : `Downloading Moxen${version}: ${done} of ${(progress.total / MIB).toFixed(1)} MiB`;
    }
    case "verifying":
      return "Checking the download's SHA-256...";
    case "unpacking":
      return "Unpacking...";
    case "testing":
      return `Starting Moxen${version} to check it works...`;
    case "switching":
      return `Switching to Moxen${version}...`;
    case "done":
      return "Done.";
  }
}

const RESTART_NOTE = "Threads that are running keep the version they started on until the moxen server restarts. Nothing was restarted.";

export function describeUpdate(result: UpdateResult): string {
  const lines =
    result.action === "already-current"
      ? [`Moxen ${result.version} is already the current version. Nothing was changed.`]
      : [`Updated Moxen ${result.from ?? "(none)"} -> ${result.version}.`, `Version folder: ${result.folder}`, result.previous === null ? "There is no previous version to roll back to." : `Roll back to ${result.previous} with: moxen self-update --rollback`, "", RESTART_NOTE];
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

export function describeRollback(result: RollbackResult): string {
  return [`Rolled back Moxen ${result.from} -> ${result.version}. ${result.from} is kept: run moxen self-update --rollback again to return to it.`, `Version folder: ${result.folder}`, "", RESTART_NOTE].join("\n");
}

export function describeInstall(result: InstallResult): string {
  const did = result.alreadyInstalled ? `Moxen ${result.version} was already installed; it is now the current version.` : `Installed Moxen ${result.version}.`;
  return [did, `Version folder: ${result.folder}`, `Current: ${result.current}`, `Launcher: ${result.launcher}`, "", result.pathHint].join("\n");
}

export function describeSelfUpdate(report: SelfUpdateReport): string {
  const { install, latest } = report;
  const where = report.remote === null ? "This machine" : `Remote server ${report.remote}`;
  const kind = install.kind === "release" ? "release install" : "source checkout (never updated by moxen)";
  const platform = install.target === null ? "no release for this platform" : `${install.target.os}-${install.target.arch}`;
  const lines = [`${where}: Moxen ${install.version}, ${kind}`, `Folder: ${install.folder ?? "unknown"}`, `Platform: ${platform}`];
  switch (report.status) {
    case "up-to-date":
      lines.push(`Up to date: the latest release is ${latest?.version ?? install.version}.`);
      break;
    case "available":
      lines.push(`Update available: ${latest?.version ?? "?"}${latest ? ` (${latest.url})` : ""}.`);
      lines.push(report.updatable ? "This install can be updated." : "This install is not updated by moxen.");
      break;
    case "no-release":
      lines.push("No release has been published yet.");
      break;
    case "unavailable":
      lines.push(`Could not check: ${report.reason ?? "unknown reason"}.`);
      if (latest !== null) lines.push(`Latest release: ${latest.version} (${latest.url})`);
      break;
  }
  return lines.join("\n");
}

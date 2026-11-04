/**
 * `moxen self-update`: `--check` says what Moxen this server is and whether GitHub Releases has a newer one (it
 * only reads; on `--server <name>` the answer is that paired server's install, labelled as remote). Installing,
 * updating and rolling back act on this machine's own app folder and are refused on a paired server: no server
 * command does them, so a paired client can never reach them.
 */
import { CliError } from "../core/errors.js";
import { installRelease, type InstallResult } from "../core/selfupdate/installer.js";
import { rollbackRelease, updateRelease, type RollbackResult, type UpdateResult } from "../core/selfupdate/update.js";
import type { UpdateCheck } from "../core/selfupdate/vocabulary.js";
import type { CliConfig } from "../core/types.js";
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

/** The plain command: download, test and switch to the latest release. This machine only. */
export async function selfUpdateRun(): Promise<UpdateResult> {
  requireLocal("Updating");
  return await updateRelease();
}

/** `--rollback`: back to the recorded previous version. This machine only. */
export async function selfUpdateRollback(): Promise<RollbackResult> {
  requireLocal("Rolling back");
  return await rollbackRelease();
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

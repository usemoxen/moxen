/**
 * `moxen self-update --check`: what Moxen this server is and whether GitHub Releases has a newer one. It
 * only reads. On `--server <name>` the answer is that paired server's install, labelled as remote — a remote
 * client may look at it and that is all; installing is not offered here yet, and never escalates.
 */
import { CliError } from "../core/errors.js";
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

export function requireCheck(check: boolean | undefined): void {
  if (check === true) return;
  throw new CliError("SELF_UPDATE_UNAVAILABLE", "Installing an update from moxen is not available yet. Run moxen self-update --check to see whether one exists.", { exitCode: 1 });
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

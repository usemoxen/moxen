/**
 * Codex transport seam: spawning `codex app-server` is injected, so tests
 * run a scripted peer over a linked pair instead of a real CLI. Only the
 * default spawner touches `node:child_process` (via the shared peer).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOnPath } from "../../infra/process.js";
import { CliError } from "../../errors.js";
import { JsonRpcPeer, nodeProcessSpawner, type ProcessSpawner } from "../stdio.js";
import { codexAppServerArgs, resolveCodexHome, type CodexSettings } from "./config.js";

export interface CodexSpawnOptions {
  readonly settings: CodexSettings;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly spawner?: ProcessSpawner;
}

export interface CodexTransport {
  startPeer(options: CodexSpawnOptions): JsonRpcPeer;
}

/** Follow a standard Windows npm shim to its JS entry, keeping every argument out of a shell. */
export function codexLaunchCommand(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, options: { platform?: NodeJS.Platform; isFile?: (file: string) => boolean } = {}): { command: string; args: readonly string[] } {
  if ((options.platform ?? process.platform) !== "win32") return { command: binary, args };
  const resolved = path.win32.isAbsolute(binary) ? binary : resolveOnPath(binary, env) ?? binary;
  if (!/\.(cmd|bat|ps1)$/i.test(resolved)) return { command: resolved, args };
  const entry = path.win32.join(path.win32.dirname(resolved), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!(options.isFile ?? existsSync)(entry)) throw new CliError("CODEX_SPAWN_FAILED", "Codex's npm launcher has no package entry. Configure providers.codex.binaryPath with the native Codex executable.");
  return { command: process.execPath, args: [entry, ...args] };
}

export class SpawnCodexTransport implements CodexTransport {
  startPeer(options: CodexSpawnOptions): JsonRpcPeer {
    const spawner = options.spawner ?? nodeProcessSpawner();
    const baseEnv = options.env ?? process.env;
    const home = resolveCodexHome(options.settings.homePath, baseEnv);
    const launch = codexLaunchCommand(options.settings.binaryPath, codexAppServerArgs(options.settings.launchArgs, baseEnv), baseEnv);
    const child = spawner.spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...baseEnv, CODEX_HOME: home },
    });
    // One app-server per session; the peer owns its lifetime.
    return new JsonRpcPeer(child, { forceKillAfterMs: 2000 });
  }
}

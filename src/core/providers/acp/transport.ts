/**
 * ACP transport seam: spawning an ACP agent subprocess is injected so tests
 * run a scripted peer over `createLinkedPair()` instead of a real CLI.
 * Never builds shell commands by joining strings (`shell: false`, argv array).
 */
import path from "node:path";

import { expandHome } from "../../config.js";
import { resolveOnPath } from "../../infra/process.js";
import { JsonRpcPeer, nodeProcessSpawner, type ProcessSpawner } from "../stdio.js";

export interface AcpAgentLaunchSpec {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Built-in preset for Google Antigravity CLI (`agy acp`). */
export const AGY_ACP_LAUNCH_SPEC: AcpAgentLaunchSpec = {
  id: "agy",
  name: "Antigravity (agy)",
  command: "agy",
  args: ["acp"],
};

export interface AcpSpawnOptions {
  readonly agent: AcpAgentLaunchSpec;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawner?: ProcessSpawner;
}

export interface AcpTransport {
  startPeer(options: AcpSpawnOptions): JsonRpcPeer;
}

/** Resolve an ACP agent executable cleanly across macOS and Windows without a shell. */
export function acpLaunchCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: readonly string[] } {
  const expanded = expandHome(command.trim());
  if (platform !== "win32") return { command: expanded, args };
  const resolved = path.win32.isAbsolute(expanded)
    ? expanded
    : resolveOnPath(expanded, env) ?? expanded;
  return { command: resolved, args };
}

export class SpawnAcpTransport implements AcpTransport {
  startPeer(options: AcpSpawnOptions): JsonRpcPeer {
    const spawner = options.spawner ?? nodeProcessSpawner();
    const baseEnv = options.env ?? process.env;
    const launch = acpLaunchCommand(options.agent.command, options.agent.args, baseEnv);
    const child = spawner.spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...baseEnv, ...(options.agent.env ?? {}) },
    });
    return new JsonRpcPeer(child, { forceKillAfterMs: 2000 });
  }
}

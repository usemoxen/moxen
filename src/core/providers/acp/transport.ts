/**
 * ACP transport seam: spawning an ACP agent subprocess is injected so tests
 * run a scripted peer over `createLinkedPair()` instead of a real CLI.
 * Never builds shell commands by joining strings (`shell: false`, argv array).
 */
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

export class SpawnAcpTransport implements AcpTransport {
  startPeer(options: AcpSpawnOptions): JsonRpcPeer {
    const spawner = options.spawner ?? nodeProcessSpawner();
    const baseEnv = options.env ?? process.env;
    const child = spawner.spawn(options.agent.command, options.agent.args, {
      cwd: options.cwd,
      env: { ...baseEnv, ...(options.agent.env ?? {}) },
    });
    return new JsonRpcPeer(child, { forceKillAfterMs: 2000 });
  }
}

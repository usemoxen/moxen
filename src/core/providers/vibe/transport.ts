/**
 * Mistral Vibe `vibe-app-server` transport seam: spawning `vibe-app-server` is
 * injected so tests run a scripted in-memory peer instead of a real CLI.
 */
import { CliError } from "../../errors.js";
import { JsonRpcPeer, nodeProcessSpawner, type ProcessSpawner } from "../stdio.js";
import {
  resolveVibeBinary,
  vibeAppServerArgs,
  vibeProcessEnv,
  type VibeSettings,
} from "./config.js";

export interface VibeSpawnOptions {
  readonly settings: VibeSettings;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly spawner?: ProcessSpawner;
}

export interface VibeTransport {
  startPeer(options: VibeSpawnOptions): JsonRpcPeer;
}

export class SpawnVibeTransport implements VibeTransport {
  startPeer(options: VibeSpawnOptions): JsonRpcPeer {
    const spawner = options.spawner ?? nodeProcessSpawner();
    const baseEnv = options.env ?? process.env;
    const resolved = resolveVibeBinary(options.settings.binaryPath, baseEnv);
    if (!resolved.installed) {
      throw new CliError(
        "VIBE_NOT_INSTALLED",
        `Could not find Mistral Vibe executable (${options.settings.binaryPath}). Install it with \`uv tool install --python 3.14 mistral-vibe\` or set providers.vibe.binaryPath.`,
        { details: { binaryPath: options.settings.binaryPath } },
      );
    }
    const args = vibeAppServerArgs(options.settings.launchArgs, baseEnv);
    const env = vibeProcessEnv(options.settings.vibeHome, baseEnv);
    const child = spawner.spawn(resolved.command, args, {
      cwd: options.cwd,
      env,
    });
    return new JsonRpcPeer(child, { forceKillAfterMs: 2_000 });
  }
}

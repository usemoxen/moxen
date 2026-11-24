/**
 * Mistral Vibe `vibe-app-server` transport seam: spawning `vibe-app-server` is
 * injected so tests run a scripted in-memory peer instead of a real CLI.
 */
import { CliError } from "../../errors.js";
import { resolveWindowsLaunch } from "../../infra/process.js";
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
  /** Test seams: force the platform and file probes for launch resolution. */
  readonly platform?: NodeJS.Platform;
  readonly isFile?: (file: string) => boolean;
  readonly readText?: (file: string) => string | null;
}

export interface VibeTransport {
  startPeer(options: VibeSpawnOptions): JsonRpcPeer;
}

export class SpawnVibeTransport implements VibeTransport {
  startPeer(options: VibeSpawnOptions): JsonRpcPeer {
    const spawner = options.spawner ?? nodeProcessSpawner();
    const baseEnv = options.env ?? process.env;
    const resolved = resolveVibeBinary(options.settings.binaryPath, baseEnv, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.isFile ? { isFile: options.isFile } : {}),
    });
    if (!resolved.installed) {
      throw new CliError(
        "VIBE_NOT_INSTALLED",
        `Could not find Mistral Vibe executable (${options.settings.binaryPath}). Install it with \`uv tool install --python 3.14 mistral-vibe\` or set providers.vibe.binaryPath.`,
        { details: { binaryPath: options.settings.binaryPath } },
      );
    }
    const args = vibeAppServerArgs(options.settings.launchArgs, baseEnv);
    const env = vibeProcessEnv(options.settings.vibeHome, baseEnv);
    // A Windows `.cmd`/`.bat`/`.ps1` launcher cannot be spawned with
    // `shell: false`; unwrap it (or run it through cmd.exe) like every other
    // provider transport, never by joining a shell command string.
    const launch = resolveWindowsLaunch(resolved.command, args, env, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.isFile ? { isFile: options.isFile } : {}),
      ...(options.readText ? { readText: options.readText } : {}),
    });
    const child = spawner.spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...env, ...(launch.env ?? {}) },
    });
    return new JsonRpcPeer(child, { forceKillAfterMs: 2_000 });
  }
}

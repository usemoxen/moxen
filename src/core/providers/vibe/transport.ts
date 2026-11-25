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
  vibeDriveRelativePathError,
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
    const platform = options.platform ?? process.platform;
    const configured = options.settings.binaryPath;
    const driveRelative = vibeDriveRelativePathError(configured, platform);
    if (driveRelative) throw driveRelative;
    const resolved = resolveVibeBinary(configured, baseEnv, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.isFile ? { isFile: options.isFile } : {}),
    });
    if (!resolved.installed) {
      throw new CliError(
        "VIBE_NOT_INSTALLED",
        `Could not find Mistral Vibe executable (${configured}). Install it with \`uv tool install --python 3.14 mistral-vibe\` or set providers.vibe.binaryPath.`,
        { details: { binaryPath: configured } },
      );
    }
    const args = vibeAppServerArgs(options.settings.launchArgs, baseEnv);
    const env = vibeProcessEnv(options.settings.vibeHome, baseEnv);
    // A Windows `.cmd`/`.bat`/`.ps1` launcher cannot be spawned with
    // `shell: false`; unwrap recognized shims to the real executable (or run a
    // `.ps1` through `powershell -File`), never by joining a shell string.
    const launch = resolveWindowsLaunch(resolved.command, args, env, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.isFile ? { isFile: options.isFile } : {}),
      ...(options.readText ? { readText: options.readText } : {}),
    });
    // resolveWindowsLaunch's last resort for an unrecognized `.bat`/`.cmd` is
    // `cmd.exe /d /c <path> <args...>`. cmd.exe re-parses that line and would
    // not preserve argv boundaries (an argument with spaces splits), so Vibe
    // refuses it: only a direct executable or a shim it can unwrap is safe.
    const comspec = (env.ComSpec || env.COMSPEC || "cmd.exe").toLowerCase();
    if (launch.command.toLowerCase() === comspec && launch.args[0] === "/d" && launch.args[1] === "/c") {
      throw new CliError(
        "VIBE_UNSUPPORTED_LAUNCHER",
        `Mistral Vibe launcher "${resolved.command}" is a batch wrapper Moxen cannot unwrap, and running it through cmd.exe would not preserve argument boundaries. Set providers.vibe.binaryPath to the real executable it calls (such as vibe-app-server.exe).`,
        { details: { binaryPath: resolved.command } },
      );
    }
    const child = spawner.spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...env, ...(launch.env ?? {}) },
    });
    return new JsonRpcPeer(child, { forceKillAfterMs: 2_000 });
  }
}

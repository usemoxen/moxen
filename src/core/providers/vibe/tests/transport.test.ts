import path from "node:path";

import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import type { ProcessSpawner, SpawnedProcess } from "../../stdio.js";
import { resolveVibeBinary } from "../config.js";
import { SpawnVibeTransport, type VibeSpawnOptions } from "../transport.js";

function silentProcess(): SpawnedProcess {
  return {
    pid: 1,
    writeLine: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    kill: () => {},
  };
}

function capturingSpawner(): { spawner: ProcessSpawner; spawned: Array<{ command: string; args: readonly string[] }> } {
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  return {
    spawned,
    spawner: {
      spawn: (command, args) => {
        spawned.push({ command, args });
        return silentProcess();
      },
    },
  };
}

function winOptions(over: Partial<VibeSpawnOptions>): VibeSpawnOptions {
  return {
    settings: { binaryPath: "vibe-app-server", vibeHome: "", launchArgs: "" },
    env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    cwd: "C:\\repo",
    platform: "win32",
    isFile: () => true,
    readText: () => "@echo off\r\n",
    ...over,
  };
}

describe("vibe transport launch", () => {
  it("rejects an unrecognized Windows batch wrapper instead of spawning it through cmd.exe", () => {
    const { spawner, spawned } = capturingSpawner();
    const transport = new SpawnVibeTransport();
    let error: unknown;
    try {
      transport.startPeer(winOptions({
        spawner,
        settings: { binaryPath: "C:\\Program Files\\Vibe\\start.bat", vibeHome: "", launchArgs: '--label "two words"' },
      }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("VIBE_UNSUPPORTED_LAUNCHER");
    expect(spawned).toHaveLength(0);
  });

  it("rejects a drive-relative configured path rather than resolving it against PATH", () => {
    const { spawner } = capturingSpawner();
    const transport = new SpawnVibeTransport();
    let error: unknown;
    try {
      transport.startPeer(winOptions({ spawner, settings: { binaryPath: "C:tool.cmd", vibeHome: "", launchArgs: "" } }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("VIBE_INVALID_BINARY_PATH");
  });

  it("rejects a bare drive qualifier as drive-relative", () => {
    const { spawner } = capturingSpawner();
    const transport = new SpawnVibeTransport();
    let error: unknown;
    try {
      transport.startPeer(winOptions({ spawner, settings: { binaryPath: "C:", vibeHome: "", launchArgs: "" } }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("VIBE_INVALID_BINARY_PATH");
  });

  it("unwraps a recognized Windows shim to the real executable and spawns it without a shell", () => {
    const { spawner, spawned } = capturingSpawner();
    const transport = new SpawnVibeTransport();
    transport.startPeer(winOptions({
      spawner,
      settings: { binaryPath: "C:\\Tools\\vibe.cmd", vibeHome: "", launchArgs: "" },
      readText: () => '@echo off\r\n"%dp0%\\vibe-app-server.exe" %*\r\n',
    }));
    expect(spawned[0]?.command).toBe("C:\\Tools\\vibe-app-server.exe");
    expect(spawned[0]?.args).toEqual([]);
  });

  it("runs an unrecognized PowerShell shim through powershell -File, preserving argv", () => {
    const { spawner, spawned } = capturingSpawner();
    const transport = new SpawnVibeTransport();
    transport.startPeer(winOptions({
      spawner,
      settings: { binaryPath: "C:\\Tools\\vibe.ps1", vibeHome: "", launchArgs: "" },
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      isFile: (file) => file.endsWith("vibe.ps1"),
    }));
    expect(spawned[0]?.command).toBe("powershell.exe");
    expect(spawned[0]?.args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Tools\\vibe.ps1"]);
  });

  it("resolves a relative configured binary path once against the process working directory", () => {
    const resolved = resolveVibeBinary("bin/vibe-app-server", {}, {
      isFile: (file) => file === path.resolve("bin/vibe-app-server"),
    });
    expect(resolved.installed).toBe(true);
    expect(resolved.command).toBe(path.resolve("bin/vibe-app-server"));
  });
});

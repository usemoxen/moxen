import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProcessSpawner, SpawnedProcess } from "../../stdio.js";
import { resolveVibeBinary } from "../config.js";
import { SpawnVibeTransport } from "../transport.js";

function silentProcess(): SpawnedProcess {
  return {
    pid: 1,
    writeLine: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    kill: () => {},
  };
}

describe("vibe transport launch", () => {
  it("unwraps a Windows .cmd launcher instead of spawning it with shell:false", () => {
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const spawner: ProcessSpawner = {
      spawn: (command, args) => {
        spawned.push({ command, args });
        return silentProcess();
      },
    };
    const transport = new SpawnVibeTransport();
    transport.startPeer({
      settings: { binaryPath: "C:\\Tools\\vibe-app-server.cmd", vibeHome: "", launchArgs: "" },
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      cwd: "C:\\repo",
      spawner,
      platform: "win32",
      isFile: () => true,
      readText: () => "@echo off\r\n",
    });
    expect(spawned[0]?.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(spawned[0]?.args).toEqual(["/d", "/c", "C:\\Tools\\vibe-app-server.cmd"]);
  });

  it("resolves a relative configured binary path once against the process working directory", () => {
    const resolved = resolveVibeBinary("bin/vibe-app-server", {}, {
      isFile: (file) => file === path.resolve("bin/vibe-app-server"),
    });
    expect(resolved.installed).toBe(true);
    expect(resolved.command).toBe(path.resolve("bin/vibe-app-server"));
  });
});

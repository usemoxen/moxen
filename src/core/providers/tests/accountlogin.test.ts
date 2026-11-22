import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { extractLoginUrl, startProviderAccountLoginSession, type LoginChildSpawner } from "../accountlogin.js";
import { probeCodexCompanion, verifyCodexCompanion } from "../chatgpt/companion.js";
import { FakeCodexTransport } from "../codex/tests/fakes.js";

function makeFakeChild() {
  const proc = new EventEmitter() as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  return proc;
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("in-app account login, managed profile folders, and Codex companion userId parsing (MXN-470)", () => {
  it("extracts HTTPS OAuth URLs from ANSI-decorated CLI output", () => {
    expect(
      extractLoginUrl("Open \x1b[36mhttps://claude.ai/oauth/authorize?code_challenge=abc.\x1b[0m to continue"),
    ).toBe("https://claude.ai/oauth/authorize?code_challenge=abc");
    expect(extractLoginUrl("no link here")).toBeNull();
  });

  it("spawns `claude auth login` with isolated CLAUDE_CONFIG_DIR (leaving HOME untouched)", async () => {
    const dir = makeTempDir("moxen-claude-login-");
    const homeDir = path.join(dir, "claude-work");
    const child = makeFakeChild();
    let captured: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } | null = null;
    const spawnChild: LoginChildSpawner = (command, args, opts) => {
      captured = { command, args, env: opts.env };
      setTimeout(() => {
        child.stdout.write("Visit https://claude.ai/oauth/authorize?state=123 to finish login\n");
      }, 10);
      return child;
    };

    const session = await startProviderAccountLoginSession(
      { kind: "claude", accountId: "work", homePath: homeDir },
      { spawnChild, baseEnv: { HOME: "/Users/original", PATH: "/usr/bin" }, platform: "darwin", urlWaitMs: 500 },
    );

    expect(fs.existsSync(homeDir)).toBe(true);
    expect(captured!.command).toBe("claude");
    expect(captured!.args).toEqual(["auth", "login"]);
    expect(captured!.env.CLAUDE_CONFIG_DIR).toBe(path.resolve(homeDir));
    expect(captured!.env.HOME).toBe("/Users/original");
    expect(session.authorizationUrl).toBe("https://claude.ai/oauth/authorize?state=123");
    expect(session.openBrowser).toBe(false);

    const wait = session.waitForCompletion(5_000);
    child.emit("close", 0);
    await expect(wait).resolves.toMatchObject({ kind: "claude", accountId: "work", homePath: homeDir });
  });

  it("spawns `agy acp --login` with isolated HOME, USERPROFILE, and --gemini-dir", async () => {
    const dir = makeTempDir("moxen-agy-login-");
    const homeDir = path.join(dir, "agy-work");
    const child = makeFakeChild();
    let captured: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } | null = null;
    const spawnChild: LoginChildSpawner = (command, args, opts) => {
      captured = { command, args, env: opts.env };
      setTimeout(() => {
        child.stderr.write("Sign in at https://accounts.google.com/o/oauth2/auth?client_id=agy\n");
      }, 10);
      return child;
    };

    const session = await startProviderAccountLoginSession(
      { kind: "antigravity", accountId: "work", homePath: homeDir },
      { spawnChild, baseEnv: { HOME: "/Users/original" }, platform: "darwin", urlWaitMs: 500 },
    );

    expect(fs.existsSync(path.join(homeDir, ".gemini"))).toBe(true);
    expect(captured!.command).toBe("agy");
    expect(captured!.args).toEqual(["acp", "--login", "--gemini-dir", path.join(path.resolve(homeDir), ".gemini")]);
    expect(captured!.env.HOME).toBe(path.resolve(homeDir));
    expect(captured!.env.USERPROFILE).toBe(path.resolve(homeDir));
    expect(session.authorizationUrl).toBe("https://accounts.google.com/o/oauth2/auth?client_id=agy");
    expect(session.openBrowser).toBe(true);
    expect(session.needsCodeInput).toBe(true);

    let receivedStdin = "";
    child.stdin.on("data", (chunk: Buffer | string) => {
      receivedStdin += chunk.toString();
    });
    await session.submitCode?.("4/0AUn6Hd_test_code");
    expect(receivedStdin).toBe("4/0AUn6Hd_test_code\n");

    const wait = session.waitForCompletion(5_000);
    child.emit("close", 0);
    await expect(wait).resolves.toMatchObject({ kind: "antigravity", accountId: "work", homePath: homeDir });
  });

  it("reads top-level userId from GetAccountResponse and omits raw confirmWorkspace syntax from UI reason", async () => {
    const transport = new FakeCodexTransport({
      account: {
        requiresOpenaiAuth: true,
        userId: "usr_top_level_42",
        account: { type: "chatgpt", email: "dev@example.test", planType: "plus", workspaceName: null },
      },
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        },
      },
    });
    const peer = transport.startPeer({
      settings: { binaryPath: "codex", homePath: "", launchArgs: "" },
      cwd: process.cwd(),
    });
    const probed = await probeCodexCompanion(peer);
    peer.close();

    expect(probed.account.userId).toBe("usr_top_level_42");
    expect(
      verifyCodexCompanion(
        { userId: "usr_top_level_42", email: "dev@example.test", emailVerified: true },
        probed.account,
        probed.rateLimits,
      ),
    ).toMatchObject({ verified: true, needsConfirmation: false, reason: null });

    const manual = verifyCodexCompanion(
      { userId: "auth0|different", email: "dev@example.test", emailVerified: true },
      probed.account,
      probed.rateLimits,
    );
    expect(manual.needsConfirmation).toBe(true);
    expect(manual.reason).not.toContain("confirmWorkspace");
  });
});

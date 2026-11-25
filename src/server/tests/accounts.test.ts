import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../core/config.js";
import { managedAccountHomeDisplayPath } from "../../core/types.js";
import { queueAdmission, type QueueRow } from "../../core/threads/queue.js";
import type { StoredThread, StoredTurn } from "../../core/threads/types.js";
import type { TurnDriver } from "../../core/threads/execute.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../core/usage/limits.js";
import { DirectConnection } from "../connection.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetUsageLimitsForTests();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("DirectConnection account CRUD and update-all (MXN-458)", () => {
  it("creates, edits, toggles, lists, and removes multi-account entries while preserving ChatGPT OAuth metadata", async () => {
    const dir = makeTempDir("moxen-accounts-srv-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          chatgpt: {
            accounts: [
              {
                id: "personal",
                label: "Personal",
                email: "user@example.test",
                userId: "usr_1",
                workspaceName: "Personal",
                planType: "plus",
                authRef: "keychain:chatgpt.personal",
                codexHomePath: "~/.codex-personal",
                codexVerified: true,
              },
            ],
          },
        },
      }),
    );

    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
    });

    try {
      const initial = await conn.query({ type: "providers.accounts" });
      expect(initial.accounts).toHaveLength(1);
      expect(initial.accounts[0]).toMatchObject({
        kind: "chatgpt",
        id: "personal",
        instanceId: "chatgpt/personal",
        email: "user@example.test",
        planType: "plus",
        codexHomePath: "~/.codex-personal",
        codexVerified: true,
      });

      const created = await conn.dispatch({
        type: "provider.account.save",
        kind: "claude",
        id: "work",
        label: "Work",
        homePath: "~/.claude-work",
        launchArgs: "--verbose",
        env: { FOO: "1" },
      });
      expect(created.created).toBe(true);
      expect(created.account).toMatchObject({
        kind: "claude",
        id: "work",
        instanceId: "claude/work",
        label: "Work",
        enabled: true,
        homePath: "~/.claude-work",
        launchArgs: "--verbose",
        env: { FOO: "1" },
      });

      // Editing ChatGPT label preserves OAuth metadata and codexVerified when codexHomePath is untouched.
      const renamedChatGpt = await conn.dispatch({
        type: "provider.account.save",
        kind: "chatgpt",
        id: "personal",
        label: "My ChatGPT",
      });
      expect(renamedChatGpt.created).toBe(false);
      expect(renamedChatGpt.account).toMatchObject({
        label: "My ChatGPT",
        email: "user@example.test",
        codexVerified: true,
      });

      // Changing codexHomePath invalidates prior codexVerified.
      const rehomed = await conn.dispatch({
        type: "provider.account.save",
        kind: "chatgpt",
        id: "personal",
        codexHomePath: "~/.codex-other",
      });
      expect(rehomed.account.codexHomePath).toBe("~/.codex-other");
      expect(rehomed.account.codexVerified).toBe(false);

      const toggled = await conn.dispatch({
        type: "provider.account.toggle",
        kind: "claude",
        id: "work",
        enabled: false,
      });
      expect(toggled.account.enabled).toBe(false);

      const listed = await conn.query({ type: "providers.accounts" });
      expect(listed.accounts.map((a) => [a.instanceId, a.enabled])).toEqual([
        ["claude/work", false],
        ["chatgpt/personal", true],
      ]);

      const removed = await conn.dispatch({
        type: "provider.account.remove",
        kind: "claude",
        id: "work",
      });
      expect(removed.removed).toBe(true);
      const afterRemove = await conn.query({ type: "providers.accounts" });
      expect(afterRemove.accounts.map((a) => a.instanceId)).toEqual(["chatgpt/personal"]);
    } finally {
      await conn.close();
    }
  });

  it("runs provider.update-all in parallel and isolates individual failures", async () => {
    const dir = makeTempDir("moxen-update-all-");
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath: path.join(dir, "config.json"),
      builtinMcpServers: null,
      updateProvider: async (provider) => {
        if (provider === "opencode") throw new Error("network unreachable");
        return {
          provider,
          before: "1.0.0",
          after: provider === "claude" ? "1.1.0" : "1.0.0",
          updated: provider === "claude",
          output: provider === "claude" ? "updated" : "up to date",
        };
      },
    });

    try {
      const result = await conn.dispatch({
        type: "provider.update-all",
        providers: ["claude", "opencode", "antigravity"],
      });
      expect(result.results).toEqual([
        {
          provider: "claude",
          ok: true,
          update: { provider: "claude", before: "1.0.0", after: "1.1.0", updated: true, output: "updated" },
        },
        {
          provider: "opencode",
          ok: false,
          error: "network unreachable",
        },
        {
          provider: "antigravity",
          ok: true,
          update: { provider: "antigravity", before: "1.0.0", after: "1.0.0", updated: false, output: "up to date" },
        },
      ]);
    } finally {
      await conn.close();
    }
  });
});

describe("per-account work queue admission isolation (MXN-458)", () => {
  const NOW = Date.parse("2026-10-01T12:00:00.000Z");
  const IN_2H = new Date(NOW + 2 * 3_600_000).toISOString();

  function makeRow(id: string, instanceId: string, model: string, status: StoredTurn["status"] = "queued"): QueueRow {
    const thread = {
      id,
      projectId: "p1",
      title: id,
      modelSelection: { instanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      env: { kind: "local", path: "/tmp" },
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      archivedAt: null,
      deletedAt: null,
      settledAt: null,
      snoozedUntil: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    } as unknown as StoredThread;
    const turn = {
      id: `${id}-t1`,
      threadId: id,
      status,
      prompt: "do work",
      modelSelection: { instanceId, model },
      createdAt: new Date(NOW).toISOString(),
      scheduledFor: null,
      queue: { conditions: [], held: false, order: 1, sequential: true, continuation: "same-thread" },
    } as unknown as StoredTurn;
    return { thread, turns: [turn] };
  }

  it("does not block claude/work when claude/personal is exhausted or running sequentially", () => {
    recordUsageWindows("claude/personal", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: IN_2H }], NOW);
    recordUsageWindows("claude/work", [{ id: "session", label: "Session", usedPercent: 15, exhausted: false, resetsAt: IN_2H }], NOW);

    const personalRunning = makeRow("t-personal", "claude/personal", "claude-sonnet-5-5", "running");
    const personalQueued = makeRow("t-personal-2", "claude/personal", "claude-sonnet-5-5", "queued");
    const workQueued = makeRow("t-work", "claude/work", "claude-sonnet-5-5", "queued");
    const rows = [personalRunning, personalQueued, workQueued];

    expect(queueAdmission(personalQueued, personalQueued.turns[0]!, rows, DEFAULT_CONFIG, NOW).blocked).toContain("claude/personal: usage exhausted");
    expect(queueAdmission(workQueued, workQueued.turns[0]!, rows, DEFAULT_CONFIG, NOW).blocked).toEqual([]);
  });
});

describe("Antigravity multiple accounts behind allowUnsupportedUse (LOCAL-011)", () => {
  const SETTING = "providers.antigravity.allowUnsupportedUse";

  /** A folder that looks signed in to the auth probe (a real probe would say so). */
  function signedInAntigravityHome(): string {
    const home = makeTempDir("moxen-agy-away-");
    fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      JSON.stringify({ id_token_email: "alt@example.test", token: "present" }),
    );
    return home;
  }

  function antigravityConfig(
    accountPath: string,
    allow: boolean,
    options?: { defaultEnabled?: boolean; altHome?: string },
  ): void {
    fs.writeFileSync(
      accountPath,
      JSON.stringify({
        providers: {
          antigravity: {
            ...(allow ? { allowUnsupportedUse: true } : {}),
            accounts: [
              { id: "default", label: "Default", ...(options?.defaultEnabled === false ? { enabled: false } : {}) },
              { id: "alt", label: "Alt", homePath: options?.altHome ?? signedInAntigravityHome() },
            ],
          },
        },
      }),
    );
  }

  it("marks gated accounts disabled without reading their home folders, and behaves as today once on", async () => {
    const dir = makeTempDir("moxen-agy-gate-");
    const configPath = path.join(dir, "config.json");
    antigravityConfig(configPath, false);
    const conn = new DirectConnection({ storeRoot: path.join(dir, "store"), configPath, builtinMcpServers: null });
    try {
      const listed = await conn.query({ type: "providers.accounts" });
      const alt = listed.accounts.find((account) => account.instanceId === "antigravity/alt")!;
      const base = listed.accounts.find((account) => account.instanceId === "antigravity/default")!;
      expect(alt.disabledReason ?? "").toContain(SETTING);
      expect(alt.disabledReason ?? "").toContain("homePath");
      // While off nothing may read the gated account's folder: the sign-in
      // state it holds stays unread, rather than reported.
      expect(alt.signedIn).toBeNull();
      expect(base.disabledReason ?? null).toBeNull();

      // Turning the setting on restores today's behavior without rewriting config.
      antigravityConfig(configPath, true);
      const enabled = await conn.query({ type: "providers.accounts" });
      const altOn = enabled.accounts.find((account) => account.instanceId === "antigravity/alt")!;
      expect(altOn.disabledReason ?? null).toBeNull();
      expect(altOn.signedIn).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("signs an Antigravity account in on the host login while off, and keeps assigning its managed home once on", async () => {
    const dir = makeTempDir("moxen-agy-login-home-");
    const configPath = path.join(dir, "config.json");
    // A second account with no homePath of its own: the add flow's outcome
    // must not silently hand it one while the setting is off.
    const writeConfig = (allow: boolean): void => {
      fs.writeFileSync(configPath, JSON.stringify({ providers: { antigravity: {
        ...(allow ? { allowUnsupportedUse: true } : {}),
        accounts: [{ id: "default", label: "Default" }, { id: "team", label: "Team" }],
      } } }));
    };
    const spawnChildCalls: string[] = [];
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      providerAccountLoginDeps: {
        urlWaitMs: 0,
        ensureDir: () => {},
        spawnChild: (command) => {
          spawnChildCalls.push(command);
          const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
          (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
          (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
          (child as unknown as { stdin: unknown }).stdin = {
            write: (_data: string, _enc: string, cb: (err?: Error | null) => void) => cb(null),
          };
          return child;
        },
      },
    });
    try {
      // While off (the default) no managed isolated home is assigned or
      // written: the account signs in on the host `agy` login, like "default".
      writeConfig(false);
      const shared = await conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "team" });
      expect(shared.homePath).toBeNull();
      expect(spawnChildCalls).toEqual(["agy"]);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).providers.antigravity.accounts[1]).toEqual({ id: "team", label: "Team" });

      // Once the setting is on, the saved account still gets today's managed
      // home, written to the config before the login session starts.
      writeConfig(true);
      const isolated = await conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "team" });
      expect(isolated.homePath).toBe(managedAccountHomeDisplayPath("antigravity", "team"));
      const stored = JSON.parse(fs.readFileSync(configPath, "utf8")).providers.antigravity.accounts[1];
      expect(stored.homePath).toBe(managedAccountHomeDisplayPath("antigravity", "team"));
      await conn.dispatch({ type: "provider.account.login.cancel", sessionId: isolated.sessionId });
    } finally {
      await conn.close();
    }
  });

  it("refuses to start a login session for an isolated Antigravity account while off, and keeps the host account's sign-in", async () => {
    const dir = makeTempDir("moxen-agy-login-gate-");
    const configPath = path.join(dir, "config.json");
    antigravityConfig(configPath, false);
    const spawnChildCalls: string[] = [];
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      providerAccountLoginDeps: {
        urlWaitMs: 0,
        ensureDir: () => {},
        spawnChild: (command) => {
          spawnChildCalls.push(command);
          const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
          (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
          (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
          (child as unknown as { stdin: unknown }).stdin = {
            write: (_data: string, _enc: string, cb: (err?: Error | null) => void) => cb(null),
          };
          return child;
        },
      },
    });
    try {
      await expect(conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "alt" })).rejects.toMatchObject({
        code: "ANTIGRAVITY_ACCOUNT_OFF",
        message: expect.stringContaining(SETTING) as unknown as string,
      });
      // The one host-login account still signs in, with the environment untouched.
      const host = await conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "default" });
      expect(host.homePath).toBeNull();
      expect(spawnChildCalls).toEqual(["agy"]);
      await conn.dispatch({ type: "provider.account.login.cancel", sessionId: host.sessionId });
    } finally {
      await conn.close();
    }
  });

  it("never probes a gated Antigravity account for usage or credits while off", async () => {
    const dir = makeTempDir("moxen-agy-usage-gate-");
    const configPath = path.join(dir, "config.json");
    const altHome = signedInAntigravityHome();
    // Keep the host account disabled so this test does not depend on whether
    // the test runner's own host $HOME happens to hold an agy login.
    antigravityConfig(configPath, false, { defaultEnabled: false, altHome });
    let madeDrivers = 0;
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      drivers: {
        antigravity: () => {
          madeDrivers += 1;
          return { refreshUsage: async () => ({ key: "antigravity/alt", windows: [], credits: null }) } as unknown as TurnDriver;
        },
      } as never,
    });
    try {
      await conn.query({ type: "usage.refresh" });
      expect(madeDrivers).toBe(0);

      // Once the setting is on, the same account is probed again as today.
      antigravityConfig(configPath, true, { defaultEnabled: false, altHome });
      await conn.query({ type: "usage.refresh" });
      expect(madeDrivers).toBe(1);
    } finally {
      await conn.close();
    }
  });

  it("refuses an Antigravity login that would sign in a non-host environment (env or --gemini-dir), and keeps them once on", async () => {
    const dir = makeTempDir("moxen-agy-login-env-gate-");
    const configPath = path.join(dir, "config.json");
    const launched: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const writeConfig = (account: Record<string, unknown>, allow: boolean): void => {
      fs.writeFileSync(configPath, JSON.stringify({ providers: { antigravity: {
        ...(allow ? { allowUnsupportedUse: true } : {}),
        accounts: [{ id: "default", label: "Default", ...account }],
      } } }));
    };
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      providerAccountLoginDeps: {
        urlWaitMs: 0,
        ensureDir: () => {},
        spawnChild: (command, args, options) => {
          launched.push({ command, args, env: options.env });
          const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
          (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
          (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
          (child as unknown as { stdin: unknown }).stdin = {
            write: (_data: string, _enc: string, cb: (err?: Error | null) => void) => cb(null),
          };
          return child;
        },
      },
    });
    try {
      // Environment overrides select a non-host login: refused while off.
      writeConfig({ env: { HOME: "/ag/elsewhere" } }, false);
      await expect(conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "default" }))
        .rejects.toMatchObject({ code: "ANTIGRAVITY_ACCOUNT_OFF", message: expect.stringContaining("HOME") });
      // A --gemini-dir launch arg does too.
      writeConfig({ launchArgs: "--gemini-dir=/ag/elsewhere/.gemini" }, false);
      await expect(conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "default" }))
        .rejects.toMatchObject({ code: "ANTIGRAVITY_ACCOUNT_OFF", message: expect.stringContaining("--gemini-dir") });
      expect(launched).toEqual([]);

      // Once on, the same login keeps today's environment and arguments.
      writeConfig({ env: { HOME: "/ag/elsewhere" }, launchArgs: "--gemini-dir=/ag/elsewhere/.gemini --verbose" }, true);
      const allowed = await conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "default" });
      expect(allowed.homePath).toBeNull();
      expect(launched).toHaveLength(1);
      expect(launched[0]!.command).toBe("agy");
      expect(launched[0]!.env.HOME).toBe("/ag/elsewhere");
      expect(launched[0]!.args).toContain("--gemini-dir=/ag/elsewhere/.gemini");
      await conn.dispatch({ type: "provider.account.login.cancel", sessionId: allowed.sessionId });
    } finally {
      await conn.close();
    }
  });

  it("refuses a login that inherits provider-level --gemini-dir launch args while off, quoted or not", async () => {
    const dir = makeTempDir("moxen-agy-login-args-gate-");
    const configPath = path.join(dir, "config.json");
    // The launch args live at the provider level; the account sets none of its own.
    const writeConfig = (launchArgs?: string): void => {
      fs.writeFileSync(configPath, JSON.stringify({
        providers: { antigravity: {
          ...(launchArgs ? { launchArgs } : {}),
          accounts: [{ id: "default", label: "Default" }],
        } },
      }));
    };
    // A plain accounts file: the one-time profile migration has run against it,
    // so a provider-level edit made while the server runs is read as-is.
    writeConfig();
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      providerAccountLoginDeps: {
        urlWaitMs: 0,
        ensureDir: () => {},
        spawnChild: (() => {
          throw new Error("the login must be refused before anything is spawned");
        }) as never,
      },
    });
    try {
      await conn.query({ type: "providers.accounts" });
      for (const launchArgs of ["--gemini-dir /other/.gemini", '--verbose "--gemini-dir" /other/.gemini']) {
        writeConfig(launchArgs);
        await expect(conn.dispatch({ type: "provider.account.login.start", kind: "antigravity", id: "default" }))
          .rejects.toMatchObject({ code: "ANTIGRAVITY_ACCOUNT_OFF", message: expect.stringContaining("--gemini-dir") });
      }
    } finally {
      await conn.close();
    }
  });

  it("turning the setting off without a restart revokes the isolated driver, its probes, and its stored usage", async () => {
    const dir = makeTempDir("moxen-agy-usage-revoke-");
    const configPath = path.join(dir, "config.json");
    const altHome = signedInAntigravityHome();
    // Keep the host account disabled so only the isolated account is under test,
    // regardless of whether the host $HOME has a live agy login.
    antigravityConfig(configPath, true, { defaultEnabled: false, altHome }); // acquire while on
    let refreshCalls = 0;
    let stops = 0;
    const driver = {
      refreshUsage: async () => {
        refreshCalls += 1;
        return {
          key: "antigravity/alt",
          windows: [{ id: "weekly", label: "Weekly", usedPercent: 40, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }],
          credits: 5,
        };
      },
      stopAll: () => {
        stops += 1;
        return Effect.succeed(undefined);
      },
    } as unknown as TurnDriver;
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      drivers: { antigravity: () => driver } as never,
    });
    try {
      const on = await conn.query({ type: "usage.refresh" });
      expect(refreshCalls).toBe(1);
      expect(on.providers).toHaveProperty("antigravity/alt");

      // The user opts out, without restarting the server.
      antigravityConfig(configPath, false, { defaultEnabled: false, altHome });
      const off = await conn.query({ type: "usage.refresh" });
      // The owned isolated driver is neither probed nor served again...
      expect(refreshCalls).toBe(1);
      expect(off.providers).not.toHaveProperty("antigravity/alt");
      const limits = await conn.query({ type: "usage.limits" });
      expect(limits.providers).not.toHaveProperty("antigravity/alt");
      // ...and it was revoked, so no live isolated session keeps running.
      expect(stops).toBe(1);
    } finally {
      await conn.close();
    }
  });
});

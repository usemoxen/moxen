import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDirectProviders } from "../../catalog/direct.js";
import { providerDefaults, resolveModelSelection } from "../../catalog/selection.js";
import { DEFAULT_CONFIG, normalizeConfig, normalizeConfigLenient } from "../../config.js";
import { driverForInstance, driverKey } from "../../threads/execute.js";
import { accountInstanceId, driverKindOfInstance, parseAccountInstanceId } from "../../types.js";
import {
  normalizeAntigravityAccounts,
  normalizeChatGptAccounts,
  normalizeClaudeAccounts,
  resolveAntigravityAccount,
  resolveClaudeAccount,
} from "../accounts.js";
import { forgetAntigravityUsageCache, probeAntigravityUsage } from "../antigravity/usage.js";
import { ClaudeDriver } from "../claude/driver.js";
import type { ClaudeQuery, ClaudeQueryOptions, ClaudeTransport } from "../claude/transport.js";

describe("multi-account routing and instance ids (MXN-457)", () => {
  it("routes claude/<id>, chatgpt/<id>, antigravity/<id>, codex/<id>, and legacy ids consistently", () => {
    expect(driverKindOfInstance("claude/work")).toBe("claude");
    expect(driverKindOfInstance("claudeAgent")).toBe("claude");
    expect(driverKindOfInstance("chatgpt/personal")).toBe("chatgpt");
    expect(driverKindOfInstance("antigravity/work")).toBe("antigravity");
    expect(driverKindOfInstance("antigravity")).toBe("antigravity");
    expect(driverKindOfInstance("codex/companion")).toBe("codex");
    expect(driverKindOfInstance("codex")).toBe("codex");

    expect(parseAccountInstanceId("claude/Work")).toEqual({ kind: "claude", accountId: "work" });
    expect(parseAccountInstanceId("chatgpt/team-a")).toEqual({ kind: "chatgpt", accountId: "team-a" });
    expect(parseAccountInstanceId("antigravity/alt")).toEqual({ kind: "antigravity", accountId: "alt" });
    expect(parseAccountInstanceId("claudeAgent")).toBeNull();
    expect(parseAccountInstanceId("opencode/openai")).toBeNull();
    expect(accountInstanceId("chatgpt", "Work")).toBe("chatgpt/work");
  });

  it("isolates driverKey per account for multi-account providers while keeping shared keys for opencode/harness/acp", () => {
    expect(driverKey("claude/personal")).toBe("claude/personal");
    expect(driverKey("claude/work")).toBe("claude/work");
    expect(driverKey("claudeAgent")).toBe("claude");
    expect(driverKey("antigravity/personal")).toBe("antigravity/personal");
    expect(driverKey("antigravity/work")).toBe("antigravity/work");
    expect(driverKey("antigravity")).toBe("antigravity");
    expect(driverKey("chatgpt/personal")).toBe("chatgpt/personal");
    expect(driverKey("chatgpt/work")).toBe("chatgpt/work");
    expect(driverKey("opencode/openai")).toBe("opencode");
    expect(driverKey("harness/local")).toBe("harness");
    expect(driverKey("acp/cline")).toBe("acp");
  });

  it("caches separate drivers per account instance", () => {
    const owner = {};
    const created: string[] = [];
    const stubDriver = (tag: string) => ({
      id: tag,
      hasSession: () => { throw new Error("unused"); },
      startSession: () => { throw new Error("unused"); },
      sendTurn: () => { throw new Error("unused"); },
      interruptTurn: () => { throw new Error("unused"); },
      awaitTurn: async () => { throw new Error("unused"); },
      streamEvents: undefined as never,
    });
    let claudeCount = 0;
    const factories = {
      claude: () => {
        const tag = `claude-${++claudeCount}`;
        created.push(tag);
        return stubDriver(tag);
      },
    };
    const personal = driverForInstance(owner, "claude/personal", factories);
    const work = driverForInstance(owner, "claude/work", factories);
    const personalAgain = driverForInstance(owner, "claude/personal", factories);
    expect(personal).toBe(personalAgain);
    expect(personal).not.toBe(work);
    expect(created).toEqual(["claude-1", "claude-2"]);
  });
});

describe("multi-account config normalization and credential safety", () => {
  it("rejects plaintext secrets in account configs and non-keychain ChatGPT authRef", () => {
    expect(() => normalizeClaudeAccounts([{ id: "work", apiKey: "sk-ant-raw" }])).toThrow(/must not store credentials/);
    expect(() => normalizeAntigravityAccounts([{ id: "work", accessToken: "ya29.raw" }])).toThrow(/must not store credentials/);
    expect(() => normalizeChatGptAccounts([{ id: "work", refreshToken: "rt_raw" }])).toThrow(/must not store credentials/);
    expect(() => normalizeChatGptAccounts([{ id: "work", authRef: "raw-bearer-token" }])).toThrow(/keychain:<name>/);
  });

  it("round-trips valid multi-account configs and skips only invalid entries in lenient mode", () => {
    const raw = {
      ...DEFAULT_CONFIG,
      providers: {
        claude: {
          accounts: [
            { id: "Personal", label: "Personal", homePath: "~/.claude-personal", model: "claude-sonnet-5-5" },
            { id: "work", label: "Work", homePath: "~/.claude-work", enabled: false },
          ],
        },
        chatgpt: {
          model: "gpt-6.1-sol",
          accounts: [
            {
              id: "personal",
              label: "Personal",
              email: "a@example.test",
              authRef: "keychain:chatgpt.personal",
              codexHomePath: "~/.codex-personal",
              codexVerified: true,
            },
          ],
        },
        antigravity: {
          accounts: [
            { id: "main", label: "Main" },
            { id: "alt", label: "Alt", homePath: "~/.agy-alt" },
          ],
        },
      },
    };
    const strict = normalizeConfig(raw);
    expect(strict.providers?.claude?.accounts?.map((a) => a.id)).toEqual(["personal", "work"]);
    expect(strict.providers?.chatgpt?.accounts?.[0]).toMatchObject({
      id: "personal",
      email: "a@example.test",
      authRef: "keychain:chatgpt.personal",
      codexHomePath: "~/.codex-personal",
      codexVerified: true,
    });
    expect(strict.providers?.antigravity?.accounts?.map((a) => a.id)).toEqual(["main", "alt"]);

    const lenient = normalizeConfigLenient({
      ...DEFAULT_CONFIG,
      providers: {
        claude: {
          accounts: [
            { id: "good", label: "Good" },
            { id: "bad", apiKey: "leaked" },
            { id: "good", label: "Dup" },
          ],
        },
      },
    });
    expect(lenient.config.providers?.claude?.accounts?.map((a) => a.id)).toEqual(["good"]);
    expect(lenient.skipped.map((entry) => entry.path)).toEqual([
      "providers.claude.accounts[bad]",
      "providers.claude.accounts[good]",
    ]);
  });
});

describe("per-account runtime and cache isolation", () => {
  it("isolates Claude accounts via CLAUDE_CONFIG_DIR without overriding HOME, including completeText", async () => {
    const realHome = path.resolve(os.homedir());
    const workDir = path.resolve(path.join(os.tmpdir(), "moxen-claude-work"));
    const resolved = resolveClaudeAccount(
      { accounts: [{ id: "work", label: "Work", homePath: workDir }] },
      "claude/work",
      { HOME: realHome, PATH: "/usr/bin" },
    );
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(workDir);
    expect(resolved.env.HOME).toBe(realHome);

    let seenEnv: Record<string, string> | undefined;
    const transport: ClaudeTransport = {
      query(_prompt, options: ClaudeQueryOptions): ClaudeQuery {
        seenEnv = options.env;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", result: "improved" } as never;
          },
          close() {},
        } as unknown as ClaudeQuery;
      },
    };
    const driver = new ClaudeDriver({
      settings: resolved.settings,
      env: { HOME: realHome, PATH: "/usr/bin" },
      instanceId: resolved.usageKey,
      transport,
    });
    const text = await driver.completeText({
      workingDirectory: process.cwd(),
      model: "claude-haiku-5-5",
      prompt: "hi",
      instructions: "edit",
      instanceId: "claude/work",
    });
    expect(text).toBe("improved");
    expect(seenEnv?.CLAUDE_CONFIG_DIR).toBe(workDir);
    expect(seenEnv?.HOME).toBe(realHome);
  });

  it("isolates Antigravity extra accounts via HOME/USERPROFILE + --gemini-dir and leaves default account HOME untouched", () => {
    const baseHome = path.resolve(path.join(os.tmpdir(), "moxen-real-home"));
    const altHome = path.resolve(path.join(os.tmpdir(), "moxen-agy-alt"));
    const baseEnv: NodeJS.ProcessEnv = { HOME: baseHome, USERPROFILE: baseHome };

    const defaultAccount = resolveAntigravityAccount(
      { accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", homePath: altHome }] },
      "antigravity/default",
      baseEnv,
    );
    expect(defaultAccount.env.HOME).toBe(baseHome);
    expect(defaultAccount.env.USERPROFILE).toBe(baseHome);
    expect(defaultAccount.spec.args).toEqual(["acp"]);

    const altAccount = resolveAntigravityAccount(
      { accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", homePath: altHome }] },
      "antigravity/alt",
      baseEnv,
    );
    expect(altAccount.env.HOME).toBe(altHome);
    expect(altAccount.env.USERPROFILE).toBe(altHome);
    expect(altAccount.spec.args).toEqual(["acp", "--gemini-dir", path.join(altHome, ".gemini")]);
    expect(altAccount.spec.env).toMatchObject({ HOME: altHome, USERPROFILE: altHome });
  });

  it("scopes Antigravity usage cache per isolated account home", async () => {
    forgetAntigravityUsageCache();
    const calls: string[] = [];
    const run = async (_cmd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | null> => {
      if (args.includes("/credits")) return JSON.stringify({ command: { data: { remaining_credits: env.HOME === "/a" ? 10 : 90 } } });
      calls.push(env.HOME ?? "");
      return JSON.stringify({ command: { data: { groups: [] } } });
    };
    const first = await probeAntigravityUsage("agy", { HOME: "/a", USERPROFILE: "/a" }, { useCache: true, run });
    const second = await probeAntigravityUsage("agy", { HOME: "/b", USERPROFILE: "/b" }, { useCache: true, run });
    const firstCached = await probeAntigravityUsage("agy", { HOME: "/a", USERPROFILE: "/a" }, { useCache: true, run });
    expect(first?.credits).toBe(10);
    expect(second?.credits).toBe(90);
    expect(firstCached?.credits).toBe(10);
    expect(calls).toEqual(["/a", "/b"]);
  });

  it("applies per-account model and effort overrides in providerDefaults and buildDirectProviders", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      providers: {
        claude: {
          model: "claude-sonnet-5-5",
          thinkingEffort: "medium",
          accounts: [
            { id: "personal", label: "Personal" },
            { id: "work", label: "Work", model: "claude-opus-5-5", thinkingEffort: "high" },
          ],
        },
        chatgpt: {
          accounts: [
            { id: "personal", label: "Personal", authRef: "keychain:chatgpt.personal", planType: "plus" },
            { id: "work", label: "Work" },
          ],
        },
      },
    });

    expect(providerDefaults(config, "claude/personal").model).toBe("claude-sonnet-5-5");
    expect(providerDefaults(config, "claude/work").model).toBe("claude-opus-5-5");
    expect(providerDefaults(config, "claude/work").thinkingEffort).toBe("high");
    const sel = resolveModelSelection(null, config, { prompt: "hi", provider: "claude/work" });
    expect(sel.instanceId).toBe("claude/work");
    expect(sel.model).toBe("claude-opus-5-5");

    const providers = await buildDirectProviders({
      env: { PATH: "" },
      storeRoot: path.join(os.tmpdir(), "moxen-accounts-test-empty"),
      claude: config.providers?.claude,
      chatgpt: config.providers?.chatgpt,
      modelsDev: async () => ({ catalog: [], source: "empty" }),
      fetchCodexProvider: async () => ({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        installed: false,
        enabled: false,
        status: "not installed",
        authStatus: null,
        models: [],
        supportedRuntimeModes: null,
        usageLimits: null,
        skills: [],
      }),
      fetchAntigravityProvider: async () => ({
        instanceId: "antigravity",
        driver: "antigravity",
        displayName: "Antigravity",
        installed: false,
        enabled: false,
        status: "not installed",
        authStatus: null,
        models: [],
        supportedRuntimeModes: null,
        usageLimits: null,
        skills: [],
      }),
      fetchAcpProviders: async () => [],
    });
    expect(providers.filter((p) => p.driver === "claude").map((p) => [p.instanceId, p.displayName])).toEqual([
      ["claude/personal", "Claude Code (Personal)"],
      ["claude/work", "Claude Code (Work)"],
    ]);
    expect(providers.filter((p) => p.driver === "chatgpt").map((p) => [p.instanceId, p.enabled, p.authStatus])).toEqual([
      ["chatgpt/personal", true, "plus"],
      ["chatgpt/work", false, "unauthenticated"],
    ]);
  });
});

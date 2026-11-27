import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, normalizeFileConfig, saveConfig } from "../../config.js";
import { describeAllAccountSettings, readSetting } from "../../configschema.js";
import { setConfigValue } from "../../config.js";
import { ensureStoredProject, listStoredProjects } from "../../projects/projects.js";
import { createThread } from "../../threads/threads.js";
import { openThreadStore } from "../../threads/store.js";
import { migrateProviderProfiles } from "../migrate.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-migrate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateProviderProfiles", () => {
  it("leaves a fresh install untouched with zero profiles and no config file written", async () => {
    const root = makeTempDir();
    const configPath = path.join(root, "config.json");
    const storeRoot = path.join(root, "threads");
    const store = await openThreadStore(storeRoot);

    const result = await migrateProviderProfiles({ configPath, storeRoot, store });
    expect(result).toEqual({
      migrated: false,
      createdAccounts: [],
      enabledOpencode: false,
      migratedProjects: 0,
      migratedThreads: 0,
      backupPath: null,
    });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("migrates legacy provider config, projects, and threads once and stays idempotent", async () => {
    const root = makeTempDir();
    const configPath = path.join(root, "config.json");
    const storeRoot = path.join(root, "threads");
    const store = await openThreadStore(storeRoot);

    await saveConfig(
      configPath,
      normalizeFileConfig({
        provider: "claudeAgent",
        model: "claude-opus-5-5",
        promptImprover: { provider: "claudeAgent", model: "claude-haiku-5-5" },
        providers: {
          claude: {
            homePath: "~/.claude-custom",
            model: "claude-sonnet-5-5",
            compaction: "auto",
            compactAt: "150k",
            mcpExclude: "github",
          },
          antigravity: {
            binaryPath: "/usr/local/bin/agy",
            runtimeMode: "approval-required",
          },
          opencode: {
            model: "opencode/big-pickle",
          },
        },
      }),
    );

    const workspaceRoot = path.join(root, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const { project } = await ensureStoredProject(storeRoot, {
      workspaceRoot,
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    });
    const claudeThread = await createThread(store, {
      projectId: project.id,
      title: "Legacy Claude",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      env: { mode: "local", path: workspaceRoot },
    });
    await store.writeThreadRecord({
      ...claudeThread,
      providerSessions: { claude: "sess-claude-1" },
      instructionState: { claude: { baseline: "base", delivered: "base" } },
      modeState: { claude: "research" },
    });
    const agyThread = await createThread(store, {
      projectId: project.id,
      title: "Legacy Antigravity",
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
      env: { mode: "local", path: workspaceRoot },
    });
    await store.writeThreadRecord({
      ...agyThread,
      providerSessions: { antigravity: "sess-agy-1" },
    });

    const first = await migrateProviderProfiles({ configPath, storeRoot, store });
    expect(first.migrated).toBe(true);
    expect(first.createdAccounts).toEqual(["claude/default", "antigravity/default"]);
    expect(first.enabledOpencode).toBe(true);
    expect(first.migratedProjects).toBe(1);
    expect(first.migratedThreads).toBe(2);
    expect(first.backupPath).not.toBeNull();
    expect(fs.existsSync(first.backupPath!)).toBe(true);

    // Config migrated cleanly into independent profiles with no parent keys remaining.
    const loaded = await loadConfig(configPath);
    expect(loaded.fileConfig.providers?.profilesMigrated).toBe(true);
    expect(loaded.fileConfig.provider).toBe("claude/default");
    expect(loaded.fileConfig.promptImprover?.provider).toBe("claude/default");
    expect(loaded.fileConfig.providers?.claude?.homePath).toBeUndefined();
    expect(loaded.fileConfig.providers?.claude?.accounts).toHaveLength(1);
    expect(loaded.fileConfig.providers?.claude?.accounts?.[0]).toMatchObject({
      id: "default",
      label: "Default",
      homePath: "~/.claude-custom",
      model: "claude-sonnet-5-5",
      compaction: "auto",
      compactAt: "150K",
      mcpExclude: "github",
    });
    expect(loaded.fileConfig.providers?.antigravity?.binaryPath).toBeUndefined();
    expect(loaded.fileConfig.providers?.antigravity?.accounts?.[0]).toMatchObject({
      id: "default",
      label: "Default",
      binaryPath: "/usr/local/bin/agy",
      runtimeMode: "approval-required",
    });
    expect(loaded.fileConfig.providers?.opencode?.enabled).toBe(true);
    expect(loaded.fileConfig.providers?.opencode?.model).toBe("opencode/big-pickle");

    // Projects and threads rewritten, preserving session handles under the new driver keys.
    const projectsAfter = await listStoredProjects(storeRoot);
    expect(projectsAfter[0]?.defaultModelSelection?.instanceId).toBe("claude/default");
    const claudeAfter = await store.readThreadRecord(claudeThread.id);
    expect(claudeAfter?.modelSelection.instanceId).toBe("claude/default");
    expect(claudeAfter?.providerSessions?.["claude/default"]).toBe("sess-claude-1");
    expect(claudeAfter?.providerSessions?.claude).toBeUndefined();
    expect(claudeAfter?.instructionState?.["claude/default"]?.baseline).toBe("base");
    expect(claudeAfter?.modeState?.["claude/default"]).toBe("research");
    const agyAfter = await store.readThreadRecord(agyThread.id);
    expect(agyAfter?.modelSelection.instanceId).toBe("antigravity/default");
    expect(agyAfter?.providerSessions?.["antigravity/default"]).toBe("sess-agy-1");

    // Re-running is a no-op; removing a migrated profile never re-creates it.
    await saveConfig(
      configPath,
      normalizeFileConfig({
        ...loaded.fileConfig,
        providers: {
          ...loaded.fileConfig.providers,
          claude: undefined,
        },
      }),
    );
    const second = await migrateProviderProfiles({ configPath, storeRoot, store });
    expect(second.migrated).toBe(false);
    const afterDelete = await loadConfig(configPath);
    expect(afterDelete.fileConfig.providers?.claude).toBeUndefined();
  });

  it("carries providers.antigravity.allowUnsupportedUse across the legacy migration, and never adds it when unset", async () => {
    // A legacy singleton Antigravity config with the consumer-use switch on:
    // the switch is provider-level, so it must stay there (a migration never
    // turns it on either: it only preserves what the file said).
    const root = makeTempDir();
    const configPath = path.join(root, "config.json");
    const storeRoot = path.join(root, "threads");
    const store = await openThreadStore(storeRoot);
    await saveConfig(
      configPath,
      normalizeFileConfig({
        providers: {
          antigravity: {
            allowUnsupportedUse: true,
            binaryPath: "/usr/local/bin/agy",
          },
        },
      }),
    );
    const workspaceRoot = path.join(root, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const { project } = await ensureStoredProject(storeRoot, {
      workspaceRoot,
      defaultModelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });
    await createThread(store, {
      projectId: project.id,
      title: "Legacy Antigravity",
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
      env: { mode: "local", path: workspaceRoot },
    });

    const first = await migrateProviderProfiles({ configPath, storeRoot, store });
    expect(first.migrated).toBe(true);
    const migrated = await loadConfig(configPath);
    expect(migrated.fileConfig.providers?.antigravity?.allowUnsupportedUse).toBe(true);
    // It is never copied onto an account entry.
    expect(migrated.fileConfig.providers?.antigravity?.accounts?.[0]).not.toHaveProperty("allowUnsupportedUse");
    expect(migrated.fileConfig.providers?.antigravity?.accounts?.[0]).toMatchObject({ id: "default", binaryPath: "/usr/local/bin/agy" });

    // Without it, the migration never stamps the setting on.
    const root2 = makeTempDir();
    const configPath2 = path.join(root2, "config.json");
    const storeRoot2 = path.join(root2, "threads");
    const store2 = await openThreadStore(storeRoot2);
    await saveConfig(
      configPath2,
      normalizeFileConfig({
        providers: {
          antigravity: { accounts: [{ id: "default", label: "Default" }], binaryPath: "/usr/local/bin/agy" },
        },
      }),
    );
    await createThread(store2, {
      projectId: "p",
      title: "Legacy Antigravity",
      modelSelection: { instanceId: "agy", model: "gemini-4-neon" },
      env: { mode: "local", path: workspaceRoot },
    });
    await migrateProviderProfiles({ configPath: configPath2, storeRoot: storeRoot2, store: store2 });
    const after = await loadConfig(configPath2);
    expect(after.fileConfig.providers?.antigravity?.allowUnsupportedUse).toBeUndefined();
    expect(after.fileConfig.providers?.antigravity?.accounts?.[0]).not.toHaveProperty("allowUnsupportedUse");
  });

  it("reuses an existing host Antigravity profile during migration instead of creating a second default profile", async () => {
    const root = makeTempDir();
    const configPath = path.join(root, "config.json");
    const storeRoot = path.join(root, "threads");
    const store = await openThreadStore(storeRoot);
    await saveConfig(
      configPath,
      normalizeFileConfig({
        provider: "antigravity",
        providers: {
          antigravity: {
            allowUnsupportedUse: true,
            accounts: [{ id: "personal", label: "Personal" }],
          },
        },
      }),
    );
    const workspaceRoot = path.join(root, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const { project } = await ensureStoredProject(storeRoot, {
      workspaceRoot,
      defaultModelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });
    const thread = await createThread(store, {
      projectId: project.id,
      title: "Legacy Antigravity",
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
      env: { mode: "local", path: workspaceRoot },
    });

    const result = await migrateProviderProfiles({ configPath, storeRoot, store });
    expect(result.migrated).toBe(true);
    expect(result.createdAccounts).toEqual([]);
    const migrated = await loadConfig(configPath);
    expect(migrated.fileConfig.provider).toBe("antigravity/personal");
    expect(migrated.fileConfig.providers?.antigravity?.accounts?.map((a) => a.id)).toEqual(["personal"]);
    const updatedThread = await store.readThreadRecord(thread.id);
    expect(updatedThread?.modelSelection.instanceId).toBe("antigravity/personal");
  });

  it("carries legacy Antigravity settings into reused profiles and selects a target that remains eligible after reload", async () => {
    const root1 = makeTempDir();
    const configPath1 = path.join(root1, "config.json");
    const storeRoot1 = path.join(root1, "threads");
    const store1 = await openThreadStore(storeRoot1);
    await saveConfig(
      configPath1,
      normalizeFileConfig({
        provider: "agy",
        providers: {
          antigravity: {
            launchArgs: "--gemini-dir /fixture/isolated",
            accounts: [
              { id: "first", label: "First" },
              { id: "second", label: "Second", launchArgs: "--debug" },
            ],
          },
        },
      }),
    );
    await migrateProviderProfiles({ configPath: configPath1, storeRoot: storeRoot1, store: store1 });
    const reloaded1 = await loadConfig(configPath1);
    expect(reloaded1.fileConfig.provider).toBe("antigravity/second");
    expect(reloaded1.config.providers?.antigravity?.accounts?.[0]?.launchArgs).toBe("--gemini-dir /fixture/isolated");
    expect(reloaded1.config.providers?.antigravity?.accounts?.[1]?.launchArgs).toBe("--debug");
    const { antigravityAccountBlockedReason } = await import("../../types.js");
    expect(antigravityAccountBlockedReason(reloaded1.config.providers?.antigravity, "antigravity/first")).toContain("--gemini-dir");
    expect(antigravityAccountBlockedReason(reloaded1.config.providers?.antigravity, "antigravity/second")).toBeNull();

    const root2 = makeTempDir();
    const configPath2 = path.join(root2, "config.json");
    const storeRoot2 = path.join(root2, "threads");
    const store2 = await openThreadStore(storeRoot2);
    await saveConfig(
      configPath2,
      normalizeFileConfig({
        provider: "agy",
        providers: {
          antigravity: {
            binaryPath: "/fixture/agy",
            runtimeMode: "approval-required",
            accounts: [{ id: "personal", label: "Personal" }],
          },
        },
      }),
    );
    await migrateProviderProfiles({ configPath: configPath2, storeRoot: storeRoot2, store: store2 });
    const reloaded2 = await loadConfig(configPath2);
    expect(reloaded2.fileConfig.provider).toBe("antigravity/personal");
    expect(reloaded2.config.providers?.antigravity?.accounts?.[0]).toMatchObject({
      id: "personal",
      binaryPath: "/fixture/agy",
      runtimeMode: "approval-required",
    });
    expect(antigravityAccountBlockedReason(reloaded2.config.providers?.antigravity, "antigravity/personal")).toBeNull();
  });

  it("does not abort migration when legacy Antigravity top-level fields contain malformed values and keeps diagnostics on reload", async () => {
    const { antigravityAccountBlockedReason } = await import("../../types.js");
    const { resolveAntigravityAccount } = await import("../accounts.js");
    const cases: Array<{ badLegacy: Record<string, unknown>; problemPath: string }> = [
      { badLegacy: { launchArgs: '--debug "' }, problemPath: "providers.antigravity.launchArgs" },
      { badLegacy: { launchArgs: '--gemini-dir "' }, problemPath: "providers.antigravity.launchArgs" },
      { badLegacy: { homePath: false }, problemPath: "providers.antigravity.homePath" },
    ];
    for (const { badLegacy, problemPath } of cases) {
      for (const existingAccounts of [[{ id: "personal", label: "Personal" }], [] as Array<{ id: string; label: string }>]) {
        const root = makeTempDir();
        const configPath = path.join(root, "config.json");
        const storeRoot = path.join(root, "threads");
        const store = await openThreadStore(storeRoot);
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            provider: "antigravity",
            providers: {
              antigravity: {
                ...badLegacy,
                binaryPath: "/fixture/agy",
                accounts: existingAccounts,
              },
            },
          }),
          "utf8",
        );

        const expectedId = existingAccounts.length > 0 ? "personal" : "default";
        const expectedInstance = `antigravity/${expectedId}`;
        const result = await migrateProviderProfiles({ configPath, storeRoot, store });
        expect(result.migrated).toBe(true);
        expect(result.createdAccounts).toEqual(existingAccounts.length > 0 ? [] : ["antigravity/default"]);
        const reloaded = await loadConfig(configPath);
        expect(reloaded.fileConfig.providers?.profilesMigrated).toBe(true);
        expect(reloaded.fileConfig.provider).toBe(expectedInstance);
        expect(reloaded.problems.some((problem) => problem.path === problemPath)).toBe(true);
        expect(reloaded.config.providers?.antigravity?.launchArgs).toBeUndefined();
        expect((reloaded.config.providers?.antigravity as Record<string, unknown> | undefined)?.homePath).toBeUndefined();
        const account = reloaded.config.providers?.antigravity?.accounts?.[0];
        expect(account).toMatchObject({ id: expectedId, binaryPath: "/fixture/agy" });
        expect(account?.homePath).toBeUndefined();
        expect(account?.launchArgs).toBeUndefined();
        expect(antigravityAccountBlockedReason(reloaded.config.providers?.antigravity, expectedInstance)).toBeNull();
        expect(resolveAntigravityAccount(reloaded.config.providers?.antigravity, expectedInstance, { HOME: "/host" }).spec.command).toBe("/fixture/agy");
      }
    }
  });

  it("keeps per-profile settings completely independent and writable via account setting keys", () => {
    const base = normalizeFileConfig({
      providers: {
        claude: {
          // Even if legacy top-level keys somehow existed, accounts never inherit them.
          runtimeMode: "approval-required",
          mcpExclude: "legacy-server",
          accounts: [
            { id: "personal", label: "Personal" },
            { id: "work", label: "Work", runtimeMode: "auto-accept-edits" },
          ],
        },
      },
    });
    const updated = setConfigValue(
      setConfigValue(
        setConfigValue(base, "providers.claude.accounts[personal].modelInputPrices", "claude-sonnet-5-5=3"),
        "providers.claude.accounts[personal].compactAtModels",
        "claude-sonnet-5-5=120k",
      ),
      "providers.claude.accounts[personal].mcpExclude",
      "linear",
    );
    expect(updated.providers?.claude?.accounts?.[0]?.modelInputPrices).toEqual({ "claude-sonnet-5-5": 3 });
    expect(updated.providers?.claude?.accounts?.[0]?.compactAtModels).toEqual({ "claude-sonnet-5-5": 120_000 });
    expect(readSetting(updated, "providers.claude.accounts[personal].mcpExclude")).toBe("linear");
    expect(readSetting(updated, "providers.claude.accounts[work].mcpExclude")).toBeUndefined();

    const described = describeAllAccountSettings(updated);
    expect(Object.keys(described).sort()).toEqual(["claude/personal", "claude/work"]);
    const personalRuntime = described["claude/personal"]?.find(
      (view) => view.descriptor.key === "providers.claude.accounts[personal].runtimeMode",
    );
    // Falls back to global default ("full-access"), NOT parent providers.claude.runtimeMode ("approval-required").
    expect(personalRuntime?.value).toBeUndefined();
    expect(personalRuntime?.effective?.value).toBe("full-access");
    const workRuntime = described["claude/work"]?.find(
      (view) => view.descriptor.key === "providers.claude.accounts[work].runtimeMode",
    );
    expect(workRuntime?.value).toBe("auto-accept-edits");
  });
});

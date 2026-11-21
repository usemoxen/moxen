/**
 * One-shot, idempotent migration from legacy singleton provider config and
 * legacy thread/project `instanceId`s into explicit independent profiles:
 *
 * - Legacy `providers.claude.*` / `claudeAgent` threads -> `claude/default`
 * - Legacy `providers.antigravity.*` / `antigravity` threads -> `antigravity/default`
 * - Legacy `providers.opencode.*` / `opencode*` threads -> `providers.opencode.enabled = true`
 *
 * Fresh installs (no legacy provider config, no legacy projects, no legacy
 * threads) are untouched and stay completely empty (zero default providers).
 * Once migrated, `providers.profilesMigrated = true` is stamped so deleting
 * a profile later never re-creates it.
 */
import { copyFile } from "node:fs/promises";
import fs from "node:fs";

import { loadConfig, normalizeFileConfig, saveConfig } from "../config.js";
import { listStoredProjects, rewriteStoredProjects } from "../projects/projects.js";
import type { ThreadStore } from "../threads/store.js";
import type {
  AntigravityAccountConfig,
  ClaudeAccountConfig,
  CliConfig,
  ModelSelection,
  ProvidersConfig,
} from "../types.js";

export interface ProviderProfileMigrationInput {
  readonly configPath: string;
  readonly storeRoot: string;
  readonly store: ThreadStore;
}

export interface ProviderProfileMigrationResult {
  readonly migrated: boolean;
  readonly createdAccounts: readonly string[];
  readonly enabledOpencode: boolean;
  readonly migratedProjects: number;
  readonly migratedThreads: number;
  readonly backupPath: string | null;
}

function isLegacyClaudeId(value: string | undefined | null): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === "claudeagent" || lower === "claude";
}

function isLegacyAntigravityId(value: string | undefined | null): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === "antigravity" || lower === "agy";
}

function isOpencodeId(value: string | undefined | null): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === "opencode" || lower.startsWith("opencode/");
}

function hasOtherKeys(obj: object | undefined, ignored: ReadonlySet<string>): boolean {
  if (!obj) return false;
  return Object.keys(obj).some((key) => !ignored.has(key));
}

function renameRecordKey<T>(
  map: Readonly<Record<string, T>> | undefined,
  from: string,
  to: string,
): Record<string, T> | undefined {
  if (!map || !(from in map)) return undefined;
  const next: Record<string, T> = { ...map };
  if (!(to in next)) next[to] = next[from]!;
  delete next[from];
  return next;
}

function rewriteInstanceId(
  instanceId: string,
  migrateClaude: boolean,
  migrateAntigravity: boolean,
): string | null {
  if (migrateClaude && isLegacyClaudeId(instanceId)) return "claude/default";
  if (migrateAntigravity && isLegacyAntigravityId(instanceId)) return "antigravity/default";
  return null;
}

function rewriteModelSelection(
  selection: ModelSelection | null | undefined,
  migrateClaude: boolean,
  migrateAntigravity: boolean,
): ModelSelection | null {
  if (!selection) return null;
  const nextId = rewriteInstanceId(selection.instanceId, migrateClaude, migrateAntigravity);
  return nextId ? { ...selection, instanceId: nextId } : null;
}

/**
 * Migrate an existing legacy Moxen store and config into opt-in independent
 * provider profiles. Safe to call on every startup; performs zero writes when
 * already migrated or when running against a fresh install.
 */
export async function migrateProviderProfiles(
  input: ProviderProfileMigrationInput,
): Promise<ProviderProfileMigrationResult> {
  const loaded = await loadConfig(input.configPath);
  const fileConfig = loaded.fileConfig;
  if (fileConfig.providers?.profilesMigrated === true) {
    return {
      migrated: false,
      createdAccounts: [],
      enabledOpencode: false,
      migratedProjects: 0,
      migratedThreads: 0,
      backupPath: null,
    };
  }

  const projects = await listStoredProjects(input.storeRoot).catch(() => []);
  const threadIds = await input.store.listThreadIds().catch(() => []);
  const threads = (
    await Promise.all(threadIds.map((id) => input.store.readThreadRecord(id).catch(() => null)))
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const legacyClaude =
    hasOtherKeys(fileConfig.providers?.claude, new Set(["accounts"])) ||
    isLegacyClaudeId(fileConfig.provider) ||
    isLegacyClaudeId(fileConfig.promptImprover?.provider) ||
    projects.some((project) => isLegacyClaudeId(project.defaultModelSelection?.instanceId)) ||
    threads.some(
      (thread) =>
        isLegacyClaudeId(thread.modelSelection.instanceId) ||
        thread.providerSessions?.claude !== undefined,
    );

  const legacyAntigravity =
    hasOtherKeys(fileConfig.providers?.antigravity, new Set(["accounts"])) ||
    isLegacyAntigravityId(fileConfig.provider) ||
    isLegacyAntigravityId(fileConfig.promptImprover?.provider) ||
    projects.some((project) => isLegacyAntigravityId(project.defaultModelSelection?.instanceId)) ||
    threads.some(
      (thread) =>
        isLegacyAntigravityId(thread.modelSelection.instanceId) ||
        thread.providerSessions?.antigravity !== undefined,
    );

  const legacyOpencode =
    fileConfig.providers?.opencode?.enabled === undefined &&
    (hasOtherKeys(fileConfig.providers?.opencode, new Set(["enabled"])) ||
      isOpencodeId(fileConfig.provider) ||
      isOpencodeId(fileConfig.promptImprover?.provider) ||
      projects.some((project) => isOpencodeId(project.defaultModelSelection?.instanceId)) ||
      threads.some(
        (thread) =>
          isOpencodeId(thread.modelSelection.instanceId) ||
          thread.providerSessions?.opencode !== undefined,
      ));

  if (!legacyClaude && !legacyAntigravity && !legacyOpencode) {
    return {
      migrated: false,
      createdAccounts: [],
      enabledOpencode: false,
      migratedProjects: 0,
      migratedThreads: 0,
      backupPath: null,
    };
  }

  // Backup config.json before mutating it (never overwrite an existing backup).
  let backupPath: string | null = null;
  if (loaded.exists && fs.existsSync(loaded.path)) {
    const candidate = `${loaded.path}.pre-profiles-migration.bak`;
    if (!fs.existsSync(candidate)) {
      await copyFile(loaded.path, candidate);
      backupPath = candidate;
    }
  }

  const createdAccounts: string[] = [];
  const nextProviders: Record<string, unknown> = {
    ...(fileConfig.providers ?? {}),
    profilesMigrated: true,
  };

  if (legacyClaude) {
    const { accounts: existingAccounts = [], ...legacyFields } = fileConfig.providers?.claude ?? {};
    const hasDefault = existingAccounts.some((entry) => entry.id.trim().toLowerCase() === "default");
    const migratedDefault: ClaudeAccountConfig = {
      ...legacyFields,
      id: "default",
      label: "Default",
    };
    const accounts = hasDefault ? existingAccounts : [migratedDefault, ...existingAccounts];
    if (!hasDefault) createdAccounts.push("claude/default");
    nextProviders.claude = { accounts };
  }

  if (legacyAntigravity) {
    const { accounts: existingAccounts = [], ...legacyFields } = fileConfig.providers?.antigravity ?? {};
    const hasDefault = existingAccounts.some((entry) => entry.id.trim().toLowerCase() === "default");
    const migratedDefault: AntigravityAccountConfig = {
      ...legacyFields,
      id: "default",
      label: "Default",
    };
    const accounts = hasDefault ? existingAccounts : [migratedDefault, ...existingAccounts];
    if (!hasDefault) createdAccounts.push("antigravity/default");
    nextProviders.antigravity = { accounts };
  }

  let enabledOpencode = false;
  if (legacyOpencode) {
    nextProviders.opencode = {
      ...(fileConfig.providers?.opencode ?? {}),
      enabled: true,
    };
    enabledOpencode = true;
  }

  const nextProvider = fileConfig.provider
    ? (rewriteInstanceId(fileConfig.provider, legacyClaude, legacyAntigravity) ?? fileConfig.provider)
    : undefined;
  const nextPromptImprover = fileConfig.promptImprover
    ? {
        ...fileConfig.promptImprover,
        ...(fileConfig.promptImprover.provider
          ? {
              provider:
                rewriteInstanceId(fileConfig.promptImprover.provider, legacyClaude, legacyAntigravity) ??
                fileConfig.promptImprover.provider,
            }
          : {}),
      }
    : undefined;

  const nextConfig: CliConfig = normalizeFileConfig({
    ...fileConfig,
    ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    ...(nextPromptImprover !== undefined ? { promptImprover: nextPromptImprover } : {}),
    providers: nextProviders as ProvidersConfig,
  });
  await saveConfig(loaded.path, nextConfig, loaded.skipped);

  const migratedProjects = await rewriteStoredProjects(input.storeRoot, (project) => {
    const updated = rewriteModelSelection(project.defaultModelSelection, legacyClaude, legacyAntigravity);
    return updated ? { ...project, defaultModelSelection: updated } : null;
  });

  let migratedThreads = 0;
  for (const thread of threads) {
    const updatedSelection = rewriteModelSelection(thread.modelSelection, legacyClaude, legacyAntigravity);
    let providerSessions = thread.providerSessions;
    let instructionState = thread.instructionState;
    let modeState = thread.modeState;
    let changed = updatedSelection !== null;

    if (legacyClaude) {
      const nextSessions = renameRecordKey(providerSessions, "claude", "claude/default");
      if (nextSessions) {
        providerSessions = nextSessions;
        changed = true;
      }
      const nextInstructions = renameRecordKey(instructionState, "claude", "claude/default");
      if (nextInstructions) {
        instructionState = nextInstructions;
        changed = true;
      }
      const nextModes = renameRecordKey(modeState, "claude", "claude/default");
      if (nextModes) {
        modeState = nextModes;
        changed = true;
      }
    }
    if (legacyAntigravity) {
      const nextSessions = renameRecordKey(providerSessions, "antigravity", "antigravity/default");
      if (nextSessions) {
        providerSessions = nextSessions;
        changed = true;
      }
      const nextInstructions = renameRecordKey(instructionState, "antigravity", "antigravity/default");
      if (nextInstructions) {
        instructionState = nextInstructions;
        changed = true;
      }
      const nextModes = renameRecordKey(modeState, "antigravity", "antigravity/default");
      if (nextModes) {
        modeState = nextModes;
        changed = true;
      }
    }

    if (!changed) continue;
    await input.store.withThreadLock(thread.id, async () => {
      const fresh = await input.store.readThreadRecord(thread.id);
      if (!fresh) return;
      const freshSelection = rewriteModelSelection(fresh.modelSelection, legacyClaude, legacyAntigravity);
      let nextSessions = fresh.providerSessions;
      let nextInstructions = fresh.instructionState;
      let nextModes = fresh.modeState;
      if (legacyClaude) {
        nextSessions = renameRecordKey(nextSessions, "claude", "claude/default") ?? nextSessions;
        nextInstructions = renameRecordKey(nextInstructions, "claude", "claude/default") ?? nextInstructions;
        nextModes = renameRecordKey(nextModes, "claude", "claude/default") ?? nextModes;
      }
      if (legacyAntigravity) {
        nextSessions = renameRecordKey(nextSessions, "antigravity", "antigravity/default") ?? nextSessions;
        nextInstructions = renameRecordKey(nextInstructions, "antigravity", "antigravity/default") ?? nextInstructions;
        nextModes = renameRecordKey(nextModes, "antigravity", "antigravity/default") ?? nextModes;
      }
      await input.store.writeThreadRecord({
        ...fresh,
        ...(freshSelection ? { modelSelection: freshSelection } : {}),
        ...(nextSessions !== undefined ? { providerSessions: nextSessions } : {}),
        ...(nextInstructions !== undefined ? { instructionState: nextInstructions } : {}),
        ...(nextModes !== undefined ? { modeState: nextModes } : {}),
      });
    });
    migratedThreads += 1;
  }

  return {
    migrated: true,
    createdAccounts,
    enabledOpencode,
    migratedProjects,
    migratedThreads,
    backupPath,
  };
}

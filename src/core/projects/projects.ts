/**
 * Own projects registry: the ID table mapping folders to projects.
 *
 * Projects live in `<storeRoot>/projects.json` (`{version, projects}`),
 * keyed by normalized workspace root with soft deletes. `list/resolve`
 * are reads; `ensure` with `create` policy inserts (title = basename,
 * null default model — the explicit-default decision lands at send
 * time, replacing the old version-dependent passthrough).
 * See docs/overview.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { CliError } from "../errors.js";
import { renameReplacing } from "../infra/atomic.js";
import type {
  EffectiveThreadEnvMode,
  ModelSelection,
  ProjectPolicy,
  ProjectEnvelope,
} from "../types.js";

/**
 * A `type` (not interface) so values carry an implicit index signature and
 * stay assignable to `ProjectEnvelope` for envelope projection.
 */
export type StoredProject = {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultThreadEnvMode?: EffectiveThreadEnvMode | null;
  /** The one shared "No project" entry that threads started without a folder live under (`./scratch.ts`). */
  readonly scratch?: true;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
};

export function registryFile(root: string): string {
  return path.join(root, "projects.json");
}

/**
 * Workspace-root equality: resolved + normalized, trailing separators
 * stripped, case-insensitive on win32 only. The one path-equality rule for
 * workspace roots; `./workspace.ts` resolves them.
 */
/**
 * Trailing separators off a resolved root — except a Windows volume root
 * keeps its own: stripping `C:\` to `C:` would name the drive's *current
 * folder*, not the drive, so two different roots would compare equal and a
 * registered drive would key under the wrong path. Pure, so every platform
 * tests the same strings.
 */
export function stripTrailingSeparators(resolved: string): string {
  while (resolved.length > 1 && (resolved.endsWith(path.sep) || resolved.endsWith("/")) && !/^[A-Za-z]:[\\/]$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

export function workspaceRootsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = stripTrailingSeparators(path.normalize(path.resolve(value)));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function normalizeRoot(root: string): string {
  return stripTrailingSeparators(path.normalize(path.resolve(root)));
}

async function loadAll(root: string): Promise<StoredProject[]> {
  let text: string;
  try {
    text = await readFile(registryFile(root), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new CliError("STORE_READ_FAILED", `Could not read the projects registry at ${registryFile(root)}.`, {
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new CliError("STORE_CORRUPT", `Could not parse ${registryFile(root)}.`, { cause });
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) {
    throw new CliError("STORE_CORRUPT", `Projects registry at ${registryFile(root)} has no projects array.`, {});
  }
  return projects.filter((entry): entry is StoredProject => {
    if (entry === null || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.workspaceRoot === "string";
  });
}

async function saveAll(root: string, projects: ReadonlyArray<StoredProject>): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
    const file = registryFile(root);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, projects }, null, 2));
    await renameReplacing(tmp, file);
  } catch (cause) {
    throw new CliError("STORE_WRITE_FAILED", `Could not write the projects registry at ${registryFile(root)}.`, {
      cause,
    });
  }
}

export async function listStoredProjects(root: string): Promise<StoredProject[]> {
  return (await loadAll(root)).filter((project) => project.deletedAt == null);
}

export async function resolveStoredProject(root: string, workspaceRoot: string): Promise<StoredProject | null> {
  const projects = await listStoredProjects(root);
  return projects.find((project) => workspaceRootsEqual(project.workspaceRoot, workspaceRoot)) ?? null;
}

/**
 * Registry mutations serialize on one chain: a mutation is a read, a
 * transform and a whole-file rename, so two interleaved ones could each
 * acknowledge their write yet keep only the last. This makes mutations safe
 * within one process — the server, which is where every registry write goes
 * (clients drive it over `ClientApi`). Across processes the guarantee stays
 * what it was: the write itself is an atomic rename, so a reader never sees a
 * torn file, but two processes writing at once still keep only the last
 * write.
 */
let registryWriteQueue: Promise<unknown> = Promise.resolve();

async function serializeRegistryWrite<T>(work: () => Promise<T>): Promise<T> {
  const prior = registryWriteQueue;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registryWriteQueue = gate;
  await prior;
  try {
    return await work();
  } finally {
    release();
  }
}

export interface EnsureProjectInput {
  /** Explicit id (imports/tests); generated when omitted. */
  readonly id?: string;
  readonly workspaceRoot: string;
  readonly policy?: ProjectPolicy;
  readonly title?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: EffectiveThreadEnvMode | null;
  readonly scratch?: true;
  readonly now?: () => string;
}

export interface EnsureProjectResult {
  readonly project: StoredProject;
  readonly created: boolean;
  /**
   * Synthesized `project.create` command (envelope compat; applied
   * synchronously, so `dispatch` stays null). Null when the project
   * already existed, matching the old API behavior.
   */
  readonly command: {
    readonly type: "project.create";
    readonly commandId: string;
    readonly projectId: string;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createWorkspaceRootIfMissing: true;
    readonly defaultModelSelection: null;
    readonly createdAt: string;
  } | null;
}

export function projectTitle(workspaceRoot: string): string {
  return path.basename(workspaceRoot) || "project";
}

/**
 * Project-title equality: trim and collapse inner whitespace runs, like the
 * `oneLine` helper in `src/core/memory/memory.ts` and the desktop's rename
 * field. Comparisons stay case-sensitive.
 */
export function normalizeProjectTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim();
}

/** Non-deleted projects. Pure; kept for envelope assembly over ProjectEnvelope rows. */
export function activeProjects<P extends ProjectEnvelope>(projects: readonly P[]): P[] {
  return projects.filter((project) => project.deletedAt == null);
}

/** First active project whose normalized root matches. Pure. */
export function projectForWorkspace<P extends ProjectEnvelope>(projects: readonly P[], workspaceRoot: string): P | null {
  return activeProjects(projects).find((project) => workspaceRootsEqual(project.workspaceRoot, workspaceRoot)) ?? null;
}

export async function ensureStoredProject(root: string, input: EnsureProjectInput): Promise<EnsureProjectResult> {
  return await serializeRegistryWrite(() => ensureStoredProjectLocked(root, input));
}

async function ensureStoredProjectLocked(root: string, input: EnsureProjectInput): Promise<EnsureProjectResult> {
  const normalized = normalizeRoot(input.workspaceRoot);
  const existing = await resolveStoredProject(root, normalized);
  if (existing) return { project: existing, created: false, command: null };
  const policy = input.policy ?? "create";
  if (policy === "existing") {
    throw new CliError("PROJECT_NOT_FOUND", `No moxen project exists for ${normalized}.`, {
      details: { workspaceRoot: normalized, projectPolicy: policy },
    });
  }
  const all = await loadAll(root);
  // A removed project is a soft delete: reopening its folder revives it with
  // its id, so its threads and per-project settings come back. A supplied
  // title renames the revived row; a supplied id that differs from the
  // revived row's id is ignored — the revived row keeps its id.
  const deleted = all.find(
    (entry) => entry.deletedAt != null && workspaceRootsEqual(entry.workspaceRoot, normalized),
  );
  if (deleted) {
    const now = input.now ?? (() => new Date().toISOString());
    const title = normalizeProjectTitle(input.title ?? "") || deleted.title;
    const revived: StoredProject = { ...deleted, title, workspaceRoot: normalized, deletedAt: null, updatedAt: now() };
    await saveAll(
      root,
      all.map((entry) => (entry.id === deleted.id ? revived : entry)),
    );
    return { project: revived, created: false, command: null };
  }
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const title = normalizeProjectTitle(input.title ?? "") || projectTitle(normalized);
  const id = input.id?.trim() || randomUUID();
  if (input.id?.trim() && all.some((entry) => entry.id === id)) {
    throw new CliError("PROJECT_ALREADY_EXISTS", `A project already exists with id ${id}.`, {
      exitCode: 4,
      details: { projectId: id },
    });
  }
  const project: StoredProject = {
    id,
    title,
    workspaceRoot: normalized,
    defaultModelSelection: input.defaultModelSelection ?? null,
    ...(input.defaultThreadEnvMode !== undefined ? { defaultThreadEnvMode: input.defaultThreadEnvMode } : {}),
    ...(input.scratch ? { scratch: true as const } : {}),
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  await saveAll(root, [...all, project]);
  return { project, created: true, command: buildProjectCreateCommand(normalized, title, createdAt, project.id) };
}

/** Renames a project: only its title changes, threads keep pointing at it. */
export async function renameStoredProject(
  root: string,
  projectId: string,
  title: string,
  now: () => string = () => new Date().toISOString(),
): Promise<StoredProject> {
  return await serializeRegistryWrite(() => renameStoredProjectLocked(root, projectId, title, now));
}

async function renameStoredProjectLocked(
  root: string,
  projectId: string,
  title: string,
  now: () => string,
): Promise<StoredProject> {
  const normalized = normalizeProjectTitle(title);
  if (!normalized) {
    throw new CliError("INVALID_PROJECT", "A project title cannot be empty.", { exitCode: 2 });
  }
  const all = await loadAll(root);
  const at = all.findIndex((entry) => entry.id === projectId);
  if (at < 0 || all[at]?.deletedAt != null) {
    throw new CliError("PROJECT_NOT_FOUND", `No moxen project exists with id ${projectId}.`, {
      details: { projectId },
    });
  }
  const conflict = all.find(
    (entry) => entry.id !== projectId && entry.deletedAt == null && normalizeProjectTitle(entry.title) === normalized,
  );
  if (conflict) {
    throw new CliError("PROJECT_ALREADY_EXISTS", `A project already exists with title "${normalized}".`, {
      exitCode: 4,
      details: { projectId, title: normalized, conflictingProjectId: conflict.id },
    });
  }
  const renamed: StoredProject = { ...all[at]!, title: normalized, updatedAt: now() };
  await saveAll(root, all.map((entry, index) => (index === at ? renamed : entry)));
  return renamed;
}

/** Rewrite stored projects in place when a migration updates fields like `defaultModelSelection`. */
export async function rewriteStoredProjects(
  root: string,
  transform: (project: StoredProject) => StoredProject | null,
): Promise<number> {
  return await serializeRegistryWrite(async () => {
    const all = await loadAll(root);
    let changed = 0;
    const next = all.map((entry) => {
      const updated = transform(entry);
      if (updated === null) return entry;
      changed += 1;
      return updated;
    });
    if (changed > 0) await saveAll(root, next);
    return changed;
  });
}

/** Removes a project: a soft delete, so its threads stay readable. */
export async function removeStoredProject(
  root: string,
  projectId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<StoredProject> {
  return await serializeRegistryWrite(() => removeStoredProjectLocked(root, projectId, now));
}

async function removeStoredProjectLocked(
  root: string,
  projectId: string,
  now: () => string,
): Promise<StoredProject> {
  const all = await loadAll(root);
  const at = all.findIndex((entry) => entry.id === projectId);
  if (at < 0 || all[at]?.deletedAt != null) {
    throw new CliError("PROJECT_NOT_FOUND", `No moxen project exists with id ${projectId}.`, {
      details: { projectId },
    });
  }
  const removed: StoredProject = { ...all[at]!, deletedAt: now(), updatedAt: now() };
  await saveAll(root, all.map((entry, index) => (index === at ? removed : entry)));
  return removed;
}

function buildProjectCreateCommand(
  workspaceRoot: string,
  title: string,
  createdAt: string,
  projectId: string,
) {
  return {
    type: "project.create" as const,
    commandId: randomUUID(),
    projectId,
    title,
    workspaceRoot,
    createWorkspaceRootIfMissing: true as const,
    defaultModelSelection: null,
    createdAt,
  };
}

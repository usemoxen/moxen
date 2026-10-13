/**
 * Moxen's own skills, put where the project already keeps its skills.
 *
 * Claude Code reads `.claude/skills`; OpenCode reads that and `.agents/skills`.
 * A project that already has one of those folders gets Moxen's skills there,
 * once, and nowhere else:
 *
 *   `.claude` exists   -> `.claude/skills`   (both providers read it themselves)
 *   else `.agents`     -> `.agents/skills`   (OpenCode itself; Claude through the `agent-skills` mod)
 *   neither            -> nothing is written; the providers are told about the bundled folder instead
 *
 * Rules that keep a skill from being loaded twice, or a user's own from being touched:
 *   - a skill the user already has under the same name — in the project's other skills
 *     folder, or in `~/.claude/skills` or `~/.agents/skills` — is left alone and not installed;
 *   - a copy Moxen made (marked with `.moxen-skill.json`) is refreshed when the bundled skill
 *     changes, and removed from a folder that is no longer the target;
 *   - an unmarked folder is never overwritten or removed;
 *   - in a git checkout the copies are listed in `.git/info/exclude`, so they never show up as
 *     untracked files or get committed.
 *
 * Nothing here throws: a project that cannot be written to simply gets the fallback.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MARKER_FILE = ".moxen-skill.json";
const EXCLUDE_BEGIN = "# >>> moxen skills (managed)";
const EXCLUDE_END = "# <<< moxen skills (managed)";

export type SkillsFolder = ".claude" | ".agents";

export interface PrepareSkillsInput {
  /** The thread's checkout. */
  readonly workingDirectory: string;
  /** Moxen's `skills/` folder in the package; null when this copy ships without one. */
  readonly bundledDir: string | null;
  /** The home directory whose `.claude/skills` and `.agents/skills` count as the user's own. */
  readonly home?: string;
}

export interface PrepareSkillsResult {
  /** `.claude` or `.agents` when Moxen's skills live in the project, null when they are served from the package instead. */
  readonly target: SkillsFolder | null;
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  /** Skills left alone because the user already has one by that name. */
  readonly skipped: readonly string[];
}

const NOTHING: PrepareSkillsResult = { target: null, installed: [], updated: [], removed: [], skipped: [] };

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isDirectory() === true;
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}

/** Where a project keeps skills: `.claude` wins when both folders exist, as both providers read it themselves. */
export async function chooseSkillsFolder(workingDirectory: string): Promise<SkillsFolder | null> {
  if (await isDirectory(path.join(workingDirectory, ".claude"))) return ".claude";
  if (await isDirectory(path.join(workingDirectory, ".agents"))) return ".agents";
  return null;
}

/** The skills in a folder: its subfolders that hold a `SKILL.md`. */
async function skillNames(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    // A symlinked skill reads as a symlink, not a directory: follow it.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (await exists(path.join(folder, entry.name, "SKILL.md"))) names.push(entry.name);
  }
  return names.sort();
}

async function listFiles(dir: string, base: string = dir): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.name === MARKER_FILE) continue;
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)));
    else files.push(path.relative(base, full));
  }
  return files;
}

/** A skill's identity: its relative paths and contents. Equal hashes mean the installed copy is current. */
export async function hashSkill(dir: string): Promise<string> {
  const hash = createHash("sha1");
  for (const file of await listFiles(dir)) {
    hash.update(file.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readMarker(skillDir: string): Promise<{ version: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(skillDir, MARKER_FILE), "utf8")) as { managedBy?: unknown; version?: unknown };
    return parsed.managedBy === "moxen" && typeof parsed.version === "string" ? { version: parsed.version } : null;
  } catch {
    return null;
  }
}

/** Copies a bundled skill beside its destination, marks it, then swaps it in, so a reader never sees a half-written skill. */
async function installSkill(source: string, destination: string, version: string): Promise<void> {
  const staging = `${destination}.moxen-tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, dereference: true });
  await writeFile(path.join(staging, MARKER_FILE), `${JSON.stringify({ managedBy: "moxen", version }, null, 2)}\n`);
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
}

/** Keeps a block in `.git/info/exclude` naming exactly the copies Moxen made, so they stay out of `git status`. */
async function updateGitExclude(workingDirectory: string, relativeDirs: readonly string[]): Promise<void> {
  const git = (args: string[]): string | null => {
    const result = spawnSync("git", args, { cwd: workingDirectory, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const prefix = git(["rev-parse", "--show-prefix"]);
  const excludePath = git(["rev-parse", "--git-path", "info/exclude"]);
  if (prefix === null || excludePath === null) return;
  const file = path.resolve(workingDirectory, excludePath);
  const current = await readFile(file, "utf8").catch(() => "");
  const block = relativeDirs.length === 0 ? "" : `${[EXCLUDE_BEGIN, ...relativeDirs.map((dir) => `/${prefix}${dir}/`), EXCLUDE_END].join("\n")}\n`;
  const start = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END, start);
  const next =
    start !== -1 && end !== -1
      ? `${current.slice(0, start)}${block}${current.slice(end + EXCLUDE_END.length).replace(/^\n/, "")}`
      : block === ""
        ? current
        : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${block}`;
  if (next === current) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next);
}

/**
 * Brings the project's skills folder in line with Moxen's bundled skills (see the file comment).
 * Idempotent and cheap on a project that is already in line: it hashes the bundled skills and compares.
 */
export async function prepareProjectSkills(input: PrepareSkillsInput): Promise<PrepareSkillsResult> {
  try {
    const { workingDirectory, bundledDir } = input;
    if (bundledDir === null || !(await isDirectory(bundledDir))) return NOTHING;
    const folder = await chooseSkillsFolder(workingDirectory);
    if (folder === null) return NOTHING;

    const home = input.home ?? os.homedir();
    const targetDir = path.join(workingDirectory, folder, "skills");
    const otherFolder: SkillsFolder = folder === ".claude" ? ".agents" : ".claude";
    const otherDir = path.join(workingDirectory, otherFolder, "skills");
    // Where the user's own skills live: a same-named skill in any of these is theirs, and loads already.
    const owned = new Set<string>();
    for (const dir of [otherDir, path.join(home, ".claude", "skills"), path.join(home, ".agents", "skills")]) {
      for (const name of await skillNames(dir)) {
        // A copy Moxen itself made in the other folder is not "theirs": it is moved, below.
        if ((await readMarker(path.join(dir, name))) === null) owned.add(name);
      }
    }

    const installed: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    const managed: string[] = [];

    // Moved, never doubled: a copy Moxen made in the folder that is no longer the target goes.
    for (const name of await skillNames(otherDir)) {
      if ((await readMarker(path.join(otherDir, name))) !== null) {
        await rm(path.join(otherDir, name), { recursive: true, force: true });
        removed.push(name);
      }
    }

    const bundled = await skillNames(bundledDir);
    for (const name of bundled) {
      const destination = path.join(targetDir, name);
      const current = await readMarker(destination);
      const there = await exists(destination);
      if (owned.has(name) || (there && current === null)) {
        skipped.push(name);
        continue;
      }
      const version = await hashSkill(path.join(bundledDir, name));
      if (current?.version === version && (await exists(path.join(destination, "SKILL.md")))) {
        managed.push(name);
        continue;
      }
      await mkdir(targetDir, { recursive: true });
      await installSkill(path.join(bundledDir, name), destination, version);
      (there ? updated : installed).push(name);
      managed.push(name);
    }

    // A bundled skill that no longer exists leaves its copy behind otherwise.
    for (const name of await skillNames(targetDir)) {
      if (!bundled.includes(name) && (await readMarker(path.join(targetDir, name))) !== null) {
        await rm(path.join(targetDir, name), { recursive: true, force: true });
        removed.push(name);
      }
    }

    await updateGitExclude(workingDirectory, managed.map((name) => `${folder}/skills/${name}`)).catch(() => undefined);
    return { target: folder, installed, updated, removed, skipped };
  } catch {
    return NOTHING;
  }
}

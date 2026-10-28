/**
 * Copies an older Moxen made of its own skills in a project, taken back out.
 *
 * Moxen used to copy its bundled skills into a project's `.claude/skills` or
 * `.agents/skills`, marking each copy with `.moxen-skill.json` and listing them
 * in `.git/info/exclude`. It ships no skills now, so a session start removes
 * those copies: only folders carrying the marker, never a user's own skill,
 * and the managed block in `.git/info/exclude` with them.
 *
 * Nothing here throws.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MARKER_FILE = ".moxen-skill.json";
const EXCLUDE_BEGIN = "# >>> moxen skills (managed)";
const EXCLUDE_END = "# <<< moxen skills (managed)";

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
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

/** Whether a skill folder is a copy Moxen made: its marker says so. */
async function isMoxensCopy(skillDir: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path.join(skillDir, MARKER_FILE), "utf8")) as { managedBy?: unknown };
    return parsed.managedBy === "moxen";
  } catch {
    return false;
  }
}

/** Drops the block in `.git/info/exclude` that named Moxen's copies. */
async function dropGitExclude(workingDirectory: string): Promise<void> {
  const result = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: workingDirectory, encoding: "utf8" });
  if (result.status !== 0) return;
  const file = path.resolve(workingDirectory, result.stdout.trim());
  const current = await readFile(file, "utf8").catch(() => "");
  const start = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END, start);
  if (start === -1 || end === -1) return;
  await writeFile(file, `${current.slice(0, start)}${current.slice(end + EXCLUDE_END.length).replace(/^\n/, "")}`);
}

/** Takes Moxen's copies out of both skills folders, and its block out of `.git/info/exclude`. Returns what went. */
export async function removeProjectSkills(workingDirectory: string): Promise<readonly string[]> {
  try {
    const removed: string[] = [];
    for (const folder of [".claude", ".agents"] as const) {
      const dir = path.join(workingDirectory, folder, "skills");
      for (const name of await skillNames(dir)) {
        if (!(await isMoxensCopy(path.join(dir, name)))) continue;
        await rm(path.join(dir, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
    if (removed.length > 0) await dropGitExclude(workingDirectory).catch(() => undefined);
    return removed;
  } catch {
    return [];
  }
}

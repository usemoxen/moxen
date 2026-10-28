import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MARKER_FILE, removeProjectSkills } from "../projectskills.js";

let root: string;
let project: string;

async function skill(dir: string, name: string, marked: boolean): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
  if (marked) await writeFile(path.join(dir, name, MARKER_FILE), JSON.stringify({ managedBy: "moxen", version: "abc" }));
}

const exists = async (target: string): Promise<boolean> => (await stat(target).catch(() => null)) !== null;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "moxen-skills-"));
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("taking an older Moxen's copies out of a project", () => {
  it("removes the marked copies from both skills folders and leaves the user's own", async () => {
    await skill(path.join(project, ".claude", "skills"), "moxen-threads", true);
    await skill(path.join(project, ".agents", "skills"), "moxen-handoff", true);
    await skill(path.join(project, ".claude", "skills"), "mine", false);
    // A marker that is not Moxen's does not count.
    await skill(path.join(project, ".agents", "skills"), "theirs", false);
    await writeFile(path.join(project, ".agents", "skills", "theirs", MARKER_FILE), JSON.stringify({ managedBy: "someone" }));

    expect([...(await removeProjectSkills(project))].sort()).toEqual(["moxen-handoff", "moxen-threads"]);
    expect(await exists(path.join(project, ".claude", "skills", "moxen-threads"))).toBe(false);
    expect(await exists(path.join(project, ".agents", "skills", "moxen-handoff"))).toBe(false);
    expect(await exists(path.join(project, ".claude", "skills", "mine", "SKILL.md"))).toBe(true);
    expect(await exists(path.join(project, ".agents", "skills", "theirs", "SKILL.md"))).toBe(true);
    // Nothing left to take out the second time.
    expect(await removeProjectSkills(project)).toEqual([]);
  });

  it("leaves a linked skill alone", async () => {
    await skill(path.join(root, "elsewhere"), "linked", false);
    await mkdir(path.join(project, ".claude", "skills"), { recursive: true });
    await symlink(path.join(root, "elsewhere", "linked"), path.join(project, ".claude", "skills", "linked"));
    expect(await removeProjectSkills(project)).toEqual([]);
    expect(await exists(path.join(project, ".claude", "skills", "linked", "SKILL.md"))).toBe(true);
  });

  it("drops its block from .git/info/exclude and keeps the user's lines", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
    await skill(path.join(project, ".claude", "skills"), "moxen-threads", true);
    const exclude = path.join(project, ".git", "info", "exclude");
    await mkdir(path.dirname(exclude), { recursive: true });
    await writeFile(exclude, "*.log\n# >>> moxen skills (managed)\n/.claude/skills/moxen-threads/\n# <<< moxen skills (managed)\nbuild/\n");
    await removeProjectSkills(project);
    expect(await readFile(exclude, "utf8")).toBe("*.log\nbuild/\n");
  });

  it("does nothing in a project with no skills folders, git checkout or not", async () => {
    expect(await removeProjectSkills(project)).toEqual([]);
    expect(await removeProjectSkills(path.join(root, "missing"))).toEqual([]);
  });
});

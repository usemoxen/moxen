import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chooseSkillsFolder, MARKER_FILE, prepareProjectSkills } from "../projectskills.js";

let root: string;
let project: string;
let home: string;
let bundled: string;

async function skill(dir: string, name: string, body = "Body", extra: Record<string, string> = {}): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  for (const [file, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(dir, name, file)), { recursive: true });
    await writeFile(path.join(dir, name, file), text);
  }
}

const exists = async (target: string): Promise<boolean> => (await stat(target).catch(() => null)) !== null;
const run = () => prepareProjectSkills({ workingDirectory: project, bundledDir: bundled, home });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "moxen-skills-"));
  project = path.join(root, "project");
  home = path.join(root, "home");
  bundled = path.join(root, "bundled");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  await skill(bundled, "moxen-threads", "threads v1", { "references/notes.md": "notes" });
  await skill(bundled, "moxen-handoff");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("where a project keeps skills", () => {
  it("prefers .claude, then .agents, and has no answer for a project with neither", async () => {
    expect(await chooseSkillsFolder(project)).toBeNull();
    await mkdir(path.join(project, ".agents"));
    expect(await chooseSkillsFolder(project)).toBe(".agents");
    await mkdir(path.join(project, ".claude"));
    expect(await chooseSkillsFolder(project)).toBe(".claude");
  });
});

describe("installing moxen's skills into a project", () => {
  it("writes nothing for a project with neither folder, and says so", async () => {
    const result = await run();
    expect(result).toMatchObject({ target: null, installed: [] });
    expect(await exists(path.join(project, ".claude"))).toBe(false);
    expect(await exists(path.join(project, ".agents"))).toBe(false);
  });

  it("installs into .claude/skills when the project has .claude, supporting files and a marker included", async () => {
    await mkdir(path.join(project, ".claude"));
    const result = await run();
    expect(result).toMatchObject({ target: ".claude", installed: ["moxen-handoff", "moxen-threads"] });
    const dir = path.join(project, ".claude", "skills", "moxen-threads");
    expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toContain("threads v1");
    expect(await readFile(path.join(dir, "references", "notes.md"), "utf8")).toBe("notes");
    expect(JSON.parse(await readFile(path.join(dir, MARKER_FILE), "utf8"))).toMatchObject({ managedBy: "moxen" });
    expect(await exists(path.join(project, ".agents"))).toBe(false);
  });

  it("installs into .agents/skills when that is the only folder", async () => {
    await mkdir(path.join(project, ".agents"));
    expect(await run()).toMatchObject({ target: ".agents", installed: ["moxen-handoff", "moxen-threads"] });
    expect(await exists(path.join(project, ".agents", "skills", "moxen-threads", "SKILL.md"))).toBe(true);
  });

  it("uses .claude when both exist, and moves a copy it made in .agents instead of keeping two", async () => {
    await mkdir(path.join(project, ".agents"));
    await run();
    await mkdir(path.join(project, ".claude"));
    const result = await run();
    expect(result).toMatchObject({ target: ".claude", removed: ["moxen-handoff", "moxen-threads"], installed: ["moxen-handoff", "moxen-threads"] });
    expect(await exists(path.join(project, ".agents", "skills", "moxen-threads"))).toBe(false);
    expect(await exists(path.join(project, ".claude", "skills", "moxen-threads"))).toBe(true);
  });

  it("is a no-op the second time, and refreshes a skill that changed in the bundle", async () => {
    await mkdir(path.join(project, ".claude"));
    await run();
    expect(await run()).toMatchObject({ installed: [], updated: [], removed: [] });
    await skill(bundled, "moxen-threads", "threads v2");
    expect(await run()).toMatchObject({ updated: ["moxen-threads"], installed: [] });
    expect(await readFile(path.join(project, ".claude", "skills", "moxen-threads", "SKILL.md"), "utf8")).toContain("threads v2");
    // A skill dropped from the bundle takes its copy with it.
    await rm(path.join(bundled, "moxen-handoff"), { recursive: true });
    expect(await run()).toMatchObject({ removed: ["moxen-handoff"] });
    expect(await exists(path.join(project, ".claude", "skills", "moxen-handoff"))).toBe(false);
  });
});

describe("never doubling or touching a user's own skills", () => {
  it("leaves alone a same-named skill the user has in the project's other folder or in their home", async () => {
    await mkdir(path.join(project, ".claude"));
    await skill(path.join(project, ".agents", "skills"), "moxen-threads", "mine");
    await skill(path.join(home, ".claude", "skills"), "moxen-handoff", "also mine");
    const result = await run();
    expect(result).toMatchObject({ target: ".claude", installed: [], skipped: ["moxen-handoff", "moxen-threads"] });
    expect(await exists(path.join(project, ".claude", "skills", "moxen-threads"))).toBe(false);
    expect(await readFile(path.join(project, ".agents", "skills", "moxen-threads", "SKILL.md"), "utf8")).toContain("mine");
  });

  it("never overwrites or removes an unmarked folder in the target, even with a bundled name", async () => {
    await skill(path.join(project, ".claude", "skills"), "moxen-threads", "hand edited");
    const result = await run();
    expect(result.skipped).toEqual(["moxen-threads"]);
    expect(result.installed).toEqual(["moxen-handoff"]);
    expect(await readFile(path.join(project, ".claude", "skills", "moxen-threads", "SKILL.md"), "utf8")).toContain("hand edited");
    // And with the bundled skill gone, the hand-edited one stays.
    await rm(path.join(bundled, "moxen-threads"), { recursive: true });
    await run();
    expect(await exists(path.join(project, ".claude", "skills", "moxen-threads", "SKILL.md"))).toBe(true);
  });

  it("treats a linked skill (a symlink to a folder) as the user's own", async () => {
    await mkdir(path.join(project, ".claude"));
    await skill(path.join(root, "elsewhere"), "moxen-threads", "linked");
    await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(root, "elsewhere", "moxen-threads"), path.join(home, ".agents", "skills", "moxen-threads"));
    expect((await run()).skipped).toContain("moxen-threads");
  });
});

describe("keeping the copies out of git", () => {
  it("lists exactly the installed skills in .git/info/exclude, and updates the block rather than adding another", async () => {
    spawnSync("git", ["init", "-q"], { cwd: project });
    await mkdir(path.join(project, ".claude"));
    await run();
    const exclude = path.join(project, ".git", "info", "exclude");
    const first = await readFile(exclude, "utf8");
    expect(first).toContain("/.claude/skills/moxen-threads/");
    expect(first).toContain("/.claude/skills/moxen-handoff/");
    await rm(path.join(bundled, "moxen-handoff"), { recursive: true });
    await run();
    const second = await readFile(exclude, "utf8");
    expect(second).not.toContain("moxen-handoff");
    expect(second.match(/>>> moxen skills/g)).toHaveLength(1);
    // The status stays clean of the copies.
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).stdout;
    expect(status).not.toContain("moxen-threads");
  });

  it("works in a project that is not a git checkout", async () => {
    await mkdir(path.join(project, ".claude"));
    expect((await run()).target).toBe(".claude");
  });
});

describe("a missing bundle", () => {
  it("does nothing when the package ships no skills", async () => {
    await mkdir(path.join(project, ".claude"));
    expect(await prepareProjectSkills({ workingDirectory: project, bundledDir: null, home })).toMatchObject({ target: null });
    expect(await prepareProjectSkills({ workingDirectory: project, bundledDir: path.join(root, "nope"), home })).toMatchObject({ target: null });
  });
});

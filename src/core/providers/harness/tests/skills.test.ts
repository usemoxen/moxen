import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSkills, parseSkillFile } from "../skills.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skills-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (folder: string, name: string, text: string) => {
  fs.mkdirSync(path.join(folder, name), { recursive: true });
  fs.writeFileSync(path.join(folder, name, "SKILL.md"), text);
};

describe("parseSkillFile", () => {
  it("reads plain, quoted and folded frontmatter values, and returns the body without the frontmatter", () => {
    const parsed = parseSkillFile('---\nname: "quoted"\ndescription: >\n  First line\n  second line.\nother: x\n---\n# Title\nBody.\n');
    expect(parsed.fields).toMatchObject({ name: "quoted", description: "First line second line.", other: "x" });
    expect(parsed.body).toBe("# Title\nBody.\n");
    expect(parseSkillFile("no frontmatter").body).toBe("no frontmatter");
  });
});

describe("discoverSkills", () => {
  it("takes a skill of the same name from the project before the user's folder, and skips one with no description", () => {
    const cwd = path.join(dir, "work");
    const home = path.join(dir, "home");
    write(path.join(cwd, ".agents", "skills"), "same", "---\ndescription: project\n---\nbody");
    write(path.join(home, ".claude", "skills"), "same", "---\ndescription: user\n---\nbody");
    write(path.join(home, ".agents", "skills"), "no-description", "# Only a heading\n");
    const found = discoverSkills({ cwd, home });
    expect(found.map((skill) => [skill.name, skill.description])).toEqual([["same", "project"]]);
  });

  it("falls back to the folder's name, and to the first line of text, for a skill that states neither", () => {
    write(path.join(dir, "work", ".claude", "skills"), "plain", "Does the plain thing.\n\nMore.");
    expect(discoverSkills({ cwd: path.join(dir, "work"), home: path.join(dir, "home") })).toMatchObject([{ name: "plain", description: "Does the plain thing." }]);
  });

  it("skips a copy an older Moxen left in the project, never a user's own skill", () => {
    const cwd = path.join(dir, "work");
    const home = path.join(dir, "home");
    write(path.join(cwd, ".claude", "skills"), "moxen-orchestrate", "---\ndescription: copy\n---\nbody");
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "moxen-orchestrate", ".moxen-skill.json"), "{}");
    write(path.join(home, ".agents", "skills"), "mine", "---\nname: moxen-research\ndescription: mine\n---\nbody");
    const found = discoverSkills({ cwd, home });
    expect(found.map((skill) => skill.name)).toEqual(["moxen-research"]);
  });
});

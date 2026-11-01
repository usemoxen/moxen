import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importManagedSkill, listManagedSkills, readManagedSkill, removeManagedSkill, saveManagedSkill, setManagedSkillEnabled, type SkillRoots } from "../management.js";

let root: string;
let roots: SkillRoots;
const text = "---\nname: drawing\ndescription: Draws diagrams.\n---\nUse the resources.\n";
const address = { source: "agents", folder: "drawing" } as const;
async function packageAt(folder: string, content = text) {
  await mkdir(path.join(folder, "resources"), { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), content);
  await writeFile(path.join(folder, "resources", "guide.txt"), "A guide");
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "moxen-skill-management-"));
  roots = { agents: path.join(root, "home", ".agents", "skills"), claude: path.join(root, "home", ".claude", "skills") };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("user skills management", () => {
  it("imports resources without replacing an existing package, and keeps duplicate names from different sources", async () => {
    const from = path.join(root, "incoming");
    await packageAt(from);
    expect(await importManagedSkill(roots, "agents", from)).toEqual(address);
    expect(await readFile(path.join(roots.agents, "drawing", "resources", "guide.txt"), "utf8")).toBe("A guide");
    await expect(importManagedSkill(roots, "agents", from)).rejects.toThrow();
    await importManagedSkill(roots, "claude", from);
    expect((await listManagedSkills(roots)).map((skill) => [skill.name, skill.source, skill.enabled])).toEqual([["drawing", "agents", true], ["drawing", "claude", true]]);
    expect(await readFile(path.join(from, "SKILL.md"), "utf8")).toBe(text);
  });

  it("preserves disabled skills and resources, refuses counterpart collisions, and moves removals outside discovery", async () => {
    await packageAt(path.join(roots.agents, "drawing"));
    await setManagedSkillEnabled(roots, address, false);
    expect((await listManagedSkills(roots))[0]?.enabled).toBe(false);
    expect((await readManagedSkill(roots, address)).text).toBe(text);
    const disabled = path.join(roots.agents, "drawing", "SKILL.md.disabled");
    await writeFile(path.join(roots.agents, "drawing", "SKILL.md"), "another instruction");
    await expect(setManagedSkillEnabled(roots, address, false)).rejects.toThrow();
    expect(await readFile(disabled, "utf8")).toBe(text);
    await rm(path.join(roots.agents, "drawing", "SKILL.md"));
    await setManagedSkillEnabled(roots, address, true);
    const removed = await removeManagedSkill(roots, address);
    expect(await listManagedSkills(roots)).toEqual([]);
    expect(path.dirname(removed.movedTo)).toBe(path.join(path.dirname(roots.agents), "moxen-removed-skills"));
    expect(await readFile(path.join(removed.movedTo, "resources", "guide.txt"), "utf8")).toBe("A guide");
  });

  it("does not overwrite a concurrent edit or save invalid frontmatter", async () => {
    await packageAt(path.join(roots.agents, "drawing"));
    const next = text.replace("Use the resources.", "Read the guide first.");
    await saveManagedSkill(roots, address, next, text);
    await expect(saveManagedSkill(roots, address, text, text)).rejects.toThrow("changed outside Moxen");
    await expect(saveManagedSkill(roots, address, "no frontmatter", next)).rejects.toThrow("frontmatter");
    expect((await readManagedSkill(roots, address)).text).toBe(next);
  });

  it.each(["../outside", "..", "a/b", "a\\b", "", ".hidden"])("refuses a folder escape or hidden folder: %s", async (folder) => {
    await expect(readManagedSkill(roots, { source: "agents", folder })).rejects.toThrow("folder name");
    await expect(removeManagedSkill(roots, { source: "agents", folder })).rejects.toThrow("folder name");
  });

  it("refuses an import whose target lies inside its source", async () => {
    await packageAt(path.join(root, "incoming"));
    await expect(importManagedSkill({ ...roots, agents: path.join(root, "incoming", "nested") }, "agents", path.join(root, "incoming"))).rejects.toThrow("inside the imported skill");
  });

  it.skipIf(process.platform === "win32")("does not write through linked folders or files, or import linked resources (POSIX symlinks require Windows privileges)", async () => {
    const from = path.join(root, "incoming");
    await packageAt(from);
    await mkdir(roots.agents, { recursive: true });
    await symlink(from, path.join(roots.agents, "drawing"));
    expect((await listManagedSkills(roots))[0]?.editable).toBe(false);
    await expect(saveManagedSkill(roots, address, text, text)).rejects.toThrow("read-only");
    await expect(removeManagedSkill(roots, address)).rejects.toThrow("read-only");
    await symlink(path.join(from, "SKILL.md"), path.join(from, "resources", "linked.md"));
    await expect(importManagedSkill(roots, "claude", from)).rejects.toThrow("not links");
    expect(await readdir(roots.claude)).toEqual([]);
    await mkdir(path.join(roots.claude, "drawing"), { recursive: true });
    await symlink(path.join(from, "SKILL.md"), path.join(roots.claude, "drawing", "SKILL.md"));
    await expect(setManagedSkillEnabled(roots, { ...address, source: "claude" }, false)).rejects.toThrow("read-only");
    expect(await readFile(path.join(from, "SKILL.md"), "utf8")).toBe(text);
  });
});

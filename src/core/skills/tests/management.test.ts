import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as files from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importManagedSkill, listManagedSkills, readManagedSkill, removeManagedSkill, saveManagedSkill, setManagedSkillEnabled, setManagedSkillProviders, type SkillRoots } from "../management.js";
import { skillOfferedTo, skillProviders, SKILL_ROUTING_FILE } from "../routing.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

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
  it("keeps provider choices with a disabled package and refuses invalid provider names", async () => {
    const dir = path.join(roots.agents, address.folder);
    await packageAt(dir);
    for (const kind of ["claude", "codex", "opencode", "harness"] as const) expect(skillOfferedTo(dir, kind)).toBe(true);
    await setManagedSkillProviders(roots, address, ["codex", "codex"]);
    expect((await listManagedSkills(roots))[0]?.providers).toEqual(["codex"]);
    await setManagedSkillEnabled(roots, address, false);
    expect(skillProviders(dir)).toEqual(["codex"]);
    await expect(setManagedSkillProviders(roots, address, ["invalid" as "codex"])).rejects.toThrow("providers must be a list");
    expect(JSON.parse(await readFile(path.join(dir, SKILL_ROUTING_FILE), "utf8"))).toEqual({ providers: ["codex"] });
    await setManagedSkillProviders(roots, address, []);
    for (const kind of ["claude", "codex", "opencode", "harness"] as const) expect(skillOfferedTo(dir, kind)).toBe(true);
    expect((await listManagedSkills(roots))[0]?.providers).toBeUndefined();
  });

  it("does not truncate the previous skill when a save runs out of disk space", async () => {
    await packageAt(path.join(roots.agents, "drawing"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(files.writeFile).mockImplementationOnce(async (...args) => {
      await actual.writeFile(args[0], "partial");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    try {
      await expect(saveManagedSkill(roots, address, text.replace("Use the resources.", "New instructions."), text)).rejects.toThrow("disk full");
      expect((await readManagedSkill(roots, address)).text).toBe(text);
    } finally { vi.mocked(files.writeFile).mockImplementation(actual.writeFile); }
  });

  it("imports resources without replacing an existing package, and keeps duplicate names from different sources", async () => {
    const from = path.join(root, "incoming");
    await packageAt(from);
    await writeFile(path.join(from, SKILL_ROUTING_FILE), JSON.stringify({ providers: ["codex"] }));
    expect(await importManagedSkill(roots, "agents", from)).toEqual(address);
    expect(await readFile(path.join(roots.agents, "drawing", "resources", "guide.txt"), "utf8")).toBe("A guide");
    await expect(importManagedSkill(roots, "agents", from)).rejects.toThrow();
    await importManagedSkill(roots, "claude", from);
    expect(skillProviders(path.join(roots.claude, address.folder))).toEqual(["codex"]);
    expect((await listManagedSkills(roots)).map((skill) => [skill.name, skill.source, skill.enabled])).toEqual([["drawing", "agents", true], ["drawing", "claude", true]]);
    expect(await readFile(path.join(from, "SKILL.md"), "utf8")).toBe(text);
    await writeFile(path.join(from, SKILL_ROUTING_FILE), JSON.stringify({ providers: ["invalid"] }));
    await expect(importManagedSkill(roots, "claude", from)).rejects.toThrow("providers must be a list");
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

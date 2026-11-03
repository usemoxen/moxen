import { cp, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";
import { parseSkillFile } from "../providers/harness/skills.js";
import { writeAtomic } from "../infra/atomic.js";
import type { McpProviderKind } from "../mcp.js";
import { parseSkillProviders, readableSkillProviders, skillProviders, SKILL_ROUTING_FILE } from "./routing.js";

export const SKILL_SOURCES = ["agents", "claude"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];
export interface SkillRoots { readonly agents: string; readonly claude: string }
export interface SkillAddress { readonly source: SkillSource; readonly folder: string }
export interface ManagedSkill extends SkillAddress {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly providers?: readonly McpProviderKind[];
}
const FILE = "SKILL.md";
const DISABLED = "SKILL.md.disabled";
const MAX_TEXT = 200_000;

function failure(message: string): never { throw new CliError("INVALID_SKILL", message, { exitCode: 2 }); }

function folderPath(roots: SkillRoots, address: SkillAddress): string {
  if (!SKILL_SOURCES.includes(address.source) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(address.folder)) failure("A skill needs a source and a folder name of up to 64 letters, numbers, dots, hyphens or underscores.");
  return path.join(roots[address.source], address.folder);
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function skillFile(dir: string): Promise<{ file: string; enabled: boolean }> {
  const enabled = await exists(path.join(dir, FILE));
  return { file: path.join(dir, enabled ? FILE : DISABLED), enabled };
}

/** A linked skill can be inspected but never changed through its link. */
async function editableDirectory(roots: SkillRoots, address: SkillAddress): Promise<string> {
  const dir = folderPath(roots, address);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) failure("Linked skills are read-only. Manage the original folder instead.");
  const parent = realpathSync.native(path.dirname(dir));
  const root = realpathSync.native(roots[address.source]);
  if (parent !== root) failure("The skill must stay inside its source folder.");
  return dir;
}

function validateText(text: string): { name: string; description: string } {
  if (text.length > MAX_TEXT) failure("SKILL.md is too large to manage here (maximum 200000 characters).");
  const { fields } = parseSkillFile(text);
  if (!fields.name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fields.name) || !fields.description?.trim()) failure("SKILL.md needs frontmatter with a name (up to 64 letters, numbers, dots, hyphens or underscores) and a description.");
  return { name: fields.name, description: fields.description };
}

export async function listManagedSkills(roots: SkillRoots): Promise<ManagedSkill[]> {
  const skills: ManagedSkill[] = [];
  for (const source of SKILL_SOURCES) {
    let folders;
    try { folders = await readdir(roots[source], { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of folders) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
      const dir = path.join(roots[source], entry.name);
      if (await exists(path.join(dir, ".moxen-skill.json"))) continue;
      const { file, enabled } = await skillFile(dir);
      let text;
      try { text = await readFile(file, "utf8"); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
      const { fields } = parseSkillFile(text);
      const info = await lstat(file);
      const providers = readableSkillProviders(dir);
      skills.push({ source, folder: entry.name, name: fields.name || entry.name, description: fields.description || "", path: file, enabled, editable: !entry.isSymbolicLink() && info.isFile() && !info.isSymbolicLink() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name), ...(providers.length > 0 ? { providers } : {}) });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}

export async function readManagedSkill(roots: SkillRoots, address: SkillAddress): Promise<{ text: string }> {
  const { file } = await skillFile(folderPath(roots, address));
  const text = await readFile(file, "utf8");
  if (text.length > MAX_TEXT) failure("SKILL.md is too large to edit here (maximum 200000 characters).");
  return { text };
}

export async function saveManagedSkill(roots: SkillRoots, address: SkillAddress, text: string, previous: string): Promise<void> {
  validateText(text);
  const dir = await editableDirectory(roots, address);
  const { file } = await skillFile(dir);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) failure("Linked skill files are read-only.");
  if (await readFile(file, "utf8") !== previous) failure("The skill changed outside Moxen. Reload it before saving.");
  await writeAtomic(file, text);
}

export async function setManagedSkillProviders(roots: SkillRoots, address: SkillAddress, value: readonly McpProviderKind[]): Promise<void> {
  const providers = parseSkillProviders(value);
  const dir = await editableDirectory(roots, address);
  const info = await lstat((await skillFile(dir)).file);
  if (!info.isFile() || info.isSymbolicLink()) failure("Linked skill files are read-only.");
  const file = path.join(dir, SKILL_ROUTING_FILE);
  if (await exists(file)) {
    const routing = await lstat(file);
    if (!routing.isFile() || routing.isSymbolicLink()) failure("Linked skill routing files are read-only.");
  }
  await writeAtomic(file, `${JSON.stringify({ providers }, null, 2)}\n`);
}

export async function setManagedSkillEnabled(roots: SkillRoots, address: SkillAddress, enabled: boolean): Promise<void> {
  const dir = await editableDirectory(roots, address);
  const current = await skillFile(dir);
  if (current.enabled === enabled) return;
  const info = await lstat(current.file);
  if (!info.isFile() || info.isSymbolicLink()) failure("Linked skill files are read-only.");
  const target = path.join(dir, enabled ? FILE : DISABLED);
  // Exclusive creation refuses an existing counterpart instead of overwriting it.
  await writeFile(target, await readFile(current.file), { flag: "wx" });
  try { await unlink(current.file); }
  catch (error) { await unlink(target); throw error; }
}

/** Keep removed skills and their resources recoverable, outside every discovery root. */
export async function removeManagedSkill(roots: SkillRoots, address: SkillAddress): Promise<{ movedTo: string }> {
  const dir = await editableDirectory(roots, address);
  if (!(await exists((await skillFile(dir)).file))) failure("The folder no longer contains a skill.");
  const trash = path.join(path.dirname(roots[address.source]), "moxen-removed-skills");
  await mkdir(trash, { recursive: true });
  const movedTo = path.join(trash, `${address.folder}-${randomUUID()}`);
  await rename(dir, movedTo);
  return { movedTo };
}

/** Copy a user-selected package, including resources, without following links or replacing a skill. */
export async function importManagedSkill(roots: SkillRoots, source: SkillSource, from: string): Promise<SkillAddress> {
  if (!path.isAbsolute(from)) failure("Choose an absolute skill-folder path on the server machine.");
  if (!(await lstat(from)).isDirectory()) failure("Import a skill folder containing SKILL.md, not a file or a link.");
  if (await exists(path.join(from, ".moxen-skill.json"))) failure("This is an obsolete Moxen-managed skill, not a user skill package.");
  const { file } = await skillFile(from);
  const metadata = validateText(await readFile(file, "utf8"));
  skillProviders(from);
  const address = { source, folder: metadata.name };
  const destination = folderPath(roots, address);
  const origin = realpathSync.native(from);
  await mkdir(roots[source], { recursive: true });
  const root = realpathSync.native(roots[source]);
  const relative = path.relative(origin, root);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) failure("The destination cannot be inside the imported skill.");
  await mkdir(destination); // EEXIST is intentional: never overwrite an existing skill.
  try {
    for (const entry of await readdir(from)) {
      await cp(path.join(from, entry), path.join(destination, entry), { recursive: true, force: false, errorOnExist: true, filter: async (file) => {
        const info = await lstat(file);
        if (!info.isDirectory() && !info.isFile()) failure("Skill packages must contain regular files and directories, not links or special files.");
        return true;
      } });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return address;
}

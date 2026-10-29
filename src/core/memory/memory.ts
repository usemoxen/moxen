/**
 * Moxen memory (MXN-135): what an agent learns across sessions, kept by
 * Moxen for every provider and modelled on Claude Code's auto memory, so a
 * change on Claude's side never changes Moxen's.
 *
 * Two scopes, both on the server (a client on another machine sees the same
 * memory, and nothing goes into the repository):
 *
 * - `global`: `<store>/memory/global/`, about the user wherever they work
 *   (role, preferences, feedback that holds in every project);
 * - `project`: `<store>/memory/projects/<projectId>/`, about one codebase and
 *   the work on it.
 *
 * One file per memory, `<name>.md`, with frontmatter (`name`, `description`,
 * `type`), and `MEMORY.md`, the index: one line per memory. Moxen writes the
 * index itself on every save and delete, so its format cannot drift. Agents
 * reach all of it through the `memory_*` tools (`server/mcp/tools.ts`), never
 * through file writes, which would need permission prompts outside the
 * workspace.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliError } from "../errors.js";
import { renameReplacing } from "../infra/atomic.js";

export const MEMORY_SCOPES = ["project", "global"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** One memory's body; past this it is a document, not a memory. */
export const MAX_MEMORY_CHARS = 8_000;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_NAME_CHARS = 64;
/** Memories one scope holds; the index a session reads stays readable. */
export const MAX_MEMORIES = 200;
/** What of an index goes into a session, as Claude's auto memory caps its own. */
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_CHARS = 25_000;

const INDEX_FILE = "MEMORY.md";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface Memory {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly body: string;
  readonly scope: MemoryScope;
}

/** Where one scope's memories live. A project scope needs the project. */
export function memoryDir(storeRoot: string, scope: MemoryScope, projectId: string | null): string {
  if (scope === "global") return path.join(storeRoot, "memory", "global");
  if (projectId === null || projectId.trim() === "") {
    throw new CliError("MEMORY_PROJECT_REQUIRED", "This thread has no project, so it has no project memory. Save to the global scope instead.", { exitCode: 2 });
  }
  // A project id is ours (a UUID), but it still names a folder: keep it to one path segment.
  return path.join(storeRoot, "memory", "projects", projectId.replace(/[^A-Za-z0-9._-]+/gu, "-"));
}

export function memoryName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_CHARS) {
    throw new CliError("INVALID_MEMORY", `A memory name is a short kebab-case slug (a-z, 0-9 and -, at most ${MAX_NAME_CHARS} characters).`, {
      exitCode: 2,
      details: { name: raw },
    });
  }
  return name;
}

export function memoryScope(raw: unknown): MemoryScope {
  if (raw === "project" || raw === "global") return raw;
  throw new CliError("INVALID_MEMORY", "scope is project or global.", { exitCode: 2, details: { scope: raw } });
}

function memoryType(raw: unknown): MemoryType {
  if ((MEMORY_TYPES as readonly unknown[]).includes(raw)) return raw as MemoryType;
  throw new CliError("INVALID_MEMORY", `type is one of ${MEMORY_TYPES.join(", ")}.`, { exitCode: 2, details: { type: raw } });
}

/** One line, no newlines: a description is the index entry's hook. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function render(memory: Omit<Memory, "scope">): string {
  return ["---", `name: ${memory.name}`, `description: ${memory.description}`, `type: ${memory.type}`, "---", "", memory.body.trim(), ""].join("\n");
}

/** A memory file as written by `render`, or by Claude Code (whose frontmatter may nest `type` under `metadata`). */
export function parseMemoryFile(text: string, fallbackName: string): Omit<Memory, "scope"> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/u.exec(line);
    if (field && field[2]!.trim() !== "") fields.set(field[1]!, field[2]!.trim().replace(/^["']|["']$/gu, ""));
  }
  const type = fields.get("type");
  const description = fields.get("description");
  if (description === undefined) return null;
  return {
    name: fields.get("name") ?? fallbackName,
    description: oneLine(description),
    type: type !== undefined && (MEMORY_TYPES as readonly string[]).includes(type) ? (type as MemoryType) : "project",
    body: match[2]!.trim(),
  };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, text, "utf8");
  await renameReplacing(tmp, file);
}

/** Every memory in one folder, by name. A file that does not parse is skipped, not fatal. */
async function readAll(dir: string, scope: MemoryScope): Promise<Memory[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md") && name !== INDEX_FILE).sort();
  } catch {
    return [];
  }
  const memories = await Promise.all(
    names.map(async (file) => {
      const text = await readFile(path.join(dir, file), "utf8").catch(() => null);
      const parsed = text === null ? null : parseMemoryFile(text, file.slice(0, -3));
      return parsed === null ? null : { ...parsed, name: file.slice(0, -3), scope };
    }),
  );
  return memories.filter((memory): memory is Memory => memory !== null);
}

function indexLine(memory: Pick<Memory, "name" | "description">): string {
  return `- [${memory.name}](${memory.name}.md) — ${memory.description}`;
}

async function writeIndex(dir: string, scope: MemoryScope): Promise<void> {
  const memories = await readAll(dir, scope);
  if (memories.length === 0) {
    await rm(path.join(dir, INDEX_FILE), { force: true });
    return;
  }
  await writeAtomic(path.join(dir, INDEX_FILE), `${memories.map(indexLine).join("\n")}\n`);
}

export interface MemoryLocation {
  readonly storeRoot: string;
  /** The thread's project; null for none (only the global scope then). */
  readonly projectId: string | null;
}

export interface SaveMemoryInput {
  readonly name: unknown;
  readonly description: unknown;
  readonly type: unknown;
  readonly body: unknown;
  readonly scope: unknown;
}

/** Save (or replace) one memory and rewrite its scope's index. */
export async function saveMemory(location: MemoryLocation, input: SaveMemoryInput): Promise<{ readonly name: string; readonly scope: MemoryScope; readonly replaced: boolean; readonly total: number }> {
  const name = memoryName(input.name);
  const scope = memoryScope(input.scope);
  const type = memoryType(input.type);
  const description = typeof input.description === "string" ? oneLine(input.description) : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (description === "" || description.length > MAX_DESCRIPTION_CHARS) {
    throw new CliError("INVALID_MEMORY", `description is one line of at most ${MAX_DESCRIPTION_CHARS} characters: what the memory is about, to decide when it is relevant.`, { exitCode: 2 });
  }
  if (body === "" || body.length > MAX_MEMORY_CHARS) {
    throw new CliError("INVALID_MEMORY", `body is the memory itself, at most ${MAX_MEMORY_CHARS} characters. Keep one fact per memory.`, { exitCode: 2 });
  }
  const dir = memoryDir(location.storeRoot, scope, location.projectId);
  const existing = await readAll(dir, scope);
  const replaced = existing.some((memory) => memory.name === name);
  if (!replaced && existing.length >= MAX_MEMORIES) {
    throw new CliError("MEMORY_FULL", `The ${scope} memory holds ${MAX_MEMORIES} memories already. Update or delete one that is stale instead.`, { exitCode: 4 });
  }
  await writeAtomic(path.join(dir, `${name}.md`), render({ name, description, type, body }));
  await writeIndex(dir, scope);
  return { name, scope, replaced, total: existing.length + (replaced ? 0 : 1) };
}

/** One memory, looked for in `scope` or, without one, the project's first and then the global. */
export async function readMemory(location: MemoryLocation, rawName: unknown, rawScope?: unknown): Promise<Memory> {
  const name = memoryName(rawName);
  const scopes: MemoryScope[] = rawScope === undefined || rawScope === null ? (location.projectId ? ["project", "global"] : ["global"]) : [memoryScope(rawScope)];
  for (const scope of scopes) {
    const dir = memoryDir(location.storeRoot, scope, location.projectId);
    const text = await readFile(path.join(dir, `${name}.md`), "utf8").catch(() => null);
    const parsed = text === null ? null : parseMemoryFile(text, name);
    if (parsed !== null) return { ...parsed, name, scope };
  }
  throw new CliError("MEMORY_NOT_FOUND", `No memory named ${name}${scopes.length === 1 ? ` in the ${scopes[0]} scope` : ""}.`, { exitCode: 4, details: { name } });
}

export async function deleteMemory(location: MemoryLocation, rawName: unknown, rawScope: unknown): Promise<{ readonly name: string; readonly scope: MemoryScope; readonly total: number }> {
  const name = memoryName(rawName);
  const scope = memoryScope(rawScope);
  const dir = memoryDir(location.storeRoot, scope, location.projectId);
  const file = path.join(dir, `${name}.md`);
  const there = await readFile(file, "utf8").then(() => true, () => false);
  if (!there) throw new CliError("MEMORY_NOT_FOUND", `No memory named ${name} in the ${scope} scope.`, { exitCode: 4, details: { name, scope } });
  await rm(file, { force: true });
  await writeIndex(dir, scope);
  return { name, scope, total: (await readAll(dir, scope)).length };
}

/** Every memory a thread can see: the global ones, then its project's. */
export async function listMemories(location: MemoryLocation): Promise<Memory[]> {
  const global = await readAll(memoryDir(location.storeRoot, "global", null), "global");
  const project = location.projectId ? await readAll(memoryDir(location.storeRoot, "project", location.projectId), "project") : [];
  return [...global, ...project];
}

/** One scope's index as a session reads it: capped in lines and characters, with a note saying what was left out. */
function cappedIndex(memories: readonly Memory[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const memory of memories) {
    const line = indexLine(memory);
    if (lines.length >= MAX_INDEX_LINES || used + line.length + 1 > MAX_INDEX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const left = memories.length - lines.length;
  if (left > 0) lines.push(`(${left} more not listed: call memory_read with no name for the whole index.)`);
  return lines.join("\n");
}

/**
 * The indexes as a session starts with them, global first, each under its
 * own cap; null when there are no memories at all.
 */
export async function memoryIndexText(location: MemoryLocation): Promise<string | null> {
  const memories = await listMemories(location);
  const global = memories.filter((memory) => memory.scope === "global");
  const project = memories.filter((memory) => memory.scope === "project");
  const parts: string[] = [];
  if (global.length > 0) parts.push(`Global memory (about the user, for every project):\n${cappedIndex(global)}`);
  if (project.length > 0) parts.push(`Project memory (this codebase and its work):\n${cappedIndex(project)}`);
  return parts.length === 0 ? null : parts.join("\n\n");
}

// -- importing Claude Code's auto memory ---------------------------------------

/** Claude Code's auto-memory folder for a workspace: `~/.claude/projects/<slug>/memory/`, the slug being the path with every non-alphanumeric character a dash. */
export function claudeMemoryDir(claudeHome: string, workspaceRoot: string): string {
  return path.join(claudeHome, "projects", path.resolve(workspaceRoot).replace(/[^A-Za-z0-9]/gu, "-"), "memory");
}

export interface ImportResult {
  readonly from: string;
  readonly imported: readonly string[];
  /** Already in Moxen's memory under the same name: left as Moxen has it. */
  readonly skipped: readonly string[];
}

/**
 * Copy a project's Claude Code memories into Moxen's: `user` ones to the
 * global scope, the rest to the project. Only when the user asks
 * (`memory.import-claude`), never on its own. A memory Moxen already has
 * under the same name is kept as it is.
 */
export async function importClaudeMemories(location: MemoryLocation, from: string): Promise<ImportResult> {
  let files: string[];
  try {
    files = (await readdir(from)).filter((name) => name.endsWith(".md") && name !== INDEX_FILE).sort();
  } catch {
    throw new CliError("CLAUDE_MEMORY_NOT_FOUND", `Claude Code has no memory for this project (looked in ${from}).`, { exitCode: 4, details: { from } });
  }
  const existing = new Set((await listMemories(location)).map((memory) => `${memory.scope}:${memory.name}`));
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(from, file), "utf8").catch(() => null);
    const parsed = text === null ? null : parseMemoryFile(text, file.slice(0, -3));
    if (parsed === null) continue;
    let name: string;
    try {
      name = memoryName(parsed.name.replace(/[_\s]+/gu, "-"));
    } catch {
      name = memoryName(file.slice(0, -3).toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, MAX_NAME_CHARS));
    }
    const scope: MemoryScope = parsed.type === "user" || location.projectId === null ? "global" : "project";
    if (existing.has(`${scope}:${name}`)) {
      skipped.push(name);
      continue;
    }
    await saveMemory(location, { name, description: parsed.description.slice(0, MAX_DESCRIPTION_CHARS), type: parsed.type, body: parsed.body.slice(0, MAX_MEMORY_CHARS), scope });
    imported.push(name);
  }
  return { from, imported, skipped };
}

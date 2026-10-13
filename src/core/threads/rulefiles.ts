/**
 * Project rule files that change while a conversation is under way.
 *
 * Claude Code loads `CLAUDE.md` (or `AGENTS.md`, when there is no `CLAUDE.md`
 * above the working directory) when a session starts and again after a
 * compaction; an edit in between is not noticed — its context events have no
 * "file changed" reason. So a conversation that outlives an edit keeps working
 * from the old rules. Moxen tells it: the change goes ahead of the next prompt
 * as a patch, not the whole file, so what the provider has cached stays cached.
 *
 * Only Claude is covered, on purpose:
 * - OpenCode v2 watches `AGENTS.md` itself and adds its own instruction update
 *   before the next request (docs/external/opencode-v2/instructions.md); a second one
 *   from here would say it twice.
 *
 * What is watched: from the working directory up to the root, each directory's
 * `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`, or its `AGENTS.md` and
 * `.claude/AGENTS.md` when none of the first kind exists anywhere (Claude's
 * default `claude-md-or-agents-md`), plus the unconditional `.claude/rules/*.md`.
 * Not watched: `~/.claude/CLAUDE.md` (a session may run with another config
 * directory, and reading the wrong one would invent changes), `@path` imports,
 * and path-scoped rules, which load only when a matching file is read.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPatch } from "diff";

/** Providers whose conversations are told about rule-file edits (see the header for why only these). */
const WATCHED_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

/** A file bigger than this is not tracked: it could not be shown as a patch anyway. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 64;
const MAX_ANCESTORS = 40;
/** One file's patch (or new content) is cut here; the whole update is cut at `MAX_UPDATE_CHARS`. */
const MAX_PATCH_CHARS = 6_000;
const MAX_UPDATE_CHARS = 16_000;

/** Absolute path → text. */
export type RuleFiles = ReadonlyMap<string, string>;

async function readTracked(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** A rule file with `paths:` frontmatter loads only when a matching file is read, so it is not part of the ambient rules. */
function isPathScoped(text: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  return match !== null && /^paths\s*:/mu.test(match[1]!);
}

async function markdownUnder(dir: string, budget: { left: number }): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (budget.left <= 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownUnder(full, budget)));
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      budget.left -= 1;
      found.push(full);
    }
  }
  return found;
}

function ancestorsOf(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** The rule files Claude Code would load for a session in `cwd`, with their text. */
export async function readRuleFiles(cwd: string): Promise<RuleFiles> {
  const dirs = ancestorsOf(cwd);
  const files = new Map<string, string>();
  const add = async (file: string): Promise<boolean> => {
    const text = await readTracked(file);
    if (text === null) return false;
    files.set(file, text);
    return true;
  };
  let claudeFamily = false;
  for (const dir of dirs) {
    for (const name of ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
      if (await add(path.join(dir, name))) claudeFamily = true;
    }
  }
  if (!claudeFamily) {
    for (const dir of dirs) {
      for (const name of ["AGENTS.md", path.join(".claude", "AGENTS.md")]) await add(path.join(dir, name));
    }
  }
  const budget = { left: MAX_FILES };
  for (const dir of dirs) {
    for (const rule of await markdownUnder(path.join(dir, ".claude", "rules"), budget)) {
      const text = await readTracked(rule);
      if (text !== null && !isPathScoped(text)) files.set(rule, text);
    }
  }
  return files;
}

function display(file: string, root: string): string {
  const relative = path.relative(root, file);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~/${path.relative(home, file).split(path.sep).join("/")}` : file;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (cut: ${text.length - max} more characters)`;
}

function patchOf(label: string, before: string, after: string): string {
  // `createPatch` opens with an `Index:` line and a rule of `=`; the hunks are what matter.
  return createPatch(label, before, after, "before", "after", { context: 2 }).split("\n").slice(2).join("\n").trimEnd();
}

/**
 * What changed between two reads, as the update block a model reads — null
 * when nothing did. A modified file is a patch; a new one is its text; a
 * removed one is said to be gone, since a model told nothing keeps obeying it.
 */
export function describeRuleChanges(previous: RuleFiles, current: RuleFiles, root: string): string | null {
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const blocks: string[] = [];
  for (const file of paths) {
    const before = previous.get(file);
    const after = current.get(file);
    if (before === after) continue;
    const label = display(file, root);
    if (before === undefined && after !== undefined) {
      blocks.push(`<file-change path="${label}" kind="added">\nThis file is new. It now reads:\n${clip(after, MAX_PATCH_CHARS)}\n</file-change>`);
    } else if (after === undefined) {
      blocks.push(`<file-change path="${label}" kind="removed">\nThis file no longer exists; the guidance it gave no longer applies.\n</file-change>`);
    } else {
      const patch = patchOf(label, before!, after);
      blocks.push(
        patch.length > MAX_PATCH_CHARS
          ? `<file-change path="${label}" kind="modified">\nChanged too much to show as a patch. Read ${label} again before relying on it.\n</file-change>`
          : `<file-change path="${label}" kind="modified">\n${patch}\n</file-change>`,
      );
    }
  }
  if (blocks.length === 0) return null;
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.length > MAX_UPDATE_CHARS && kept.length > 0) break;
    kept.push(block);
    used += block.length;
  }
  const left = blocks.length - kept.length;
  if (left > 0) kept.push(`${left} more rule file${left === 1 ? "" : "s"} changed too; read them again before relying on them.`);
  return kept.join("\n\n");
}

/** A prompt with the rule-file changes ahead of it, for the provider only — the transcript keeps what was typed. */
export function withRuleUpdate(prompt: string, update: string | null): string {
  if (update === null) return prompt;
  return [
    "<moxen-context-update>",
    "Files that give you project instructions changed on disk since you last read them. This comes from Moxen, not from the person you are talking to: " +
      "the changes below update those instructions, a patch replacing what you read earlier. Follow them, and do not mention or quote this block.",
    "",
    update,
    "</moxen-context-update>",
    "",
    prompt,
  ].join("\n");
}

// -- what each live session last read ------------------------------------------

interface Baseline {
  readonly cwd: string;
  readonly files: RuleFiles;
}

/** Per driver, so a driver torn down takes its record with it. A session lives in one process, and so does this. */
const baselines = new WeakMap<object, Map<string, Baseline>>();

function recordsOf(owner: object): Map<string, Baseline> {
  let records = baselines.get(owner);
  if (!records) {
    records = new Map();
    baselines.set(owner, records);
  }
  return records;
}

/**
 * The rules as they stand now, taken as what the session has read. Called when
 * a session starts or resumes (Claude loads them then) and after a compaction
 * (it loads them again). Never throws: a read that fails leaves the old record.
 */
export async function captureRuleBaseline(owner: object, threadId: string, provider: string, cwd: string): Promise<void> {
  if (!WATCHED_PROVIDERS.has(provider)) return;
  const files = await readRuleFiles(cwd).catch(() => null);
  if (files !== null) recordsOf(owner).set(threadId, { cwd, files });
}

/** After a compaction: Claude re-read the files from disk, so what it holds is what is there now. */
export async function refreshRuleBaseline(owner: object, threadId: string): Promise<void> {
  const record = baselines.get(owner)?.get(threadId);
  if (record === undefined) return;
  await captureRuleBaseline(owner, threadId, "claude", record.cwd);
}

export interface PendingRuleUpdate {
  /** The update text, for `withRuleUpdate`. */
  readonly text: string;
  /** The model has the change: it is now what the session has read. Called once the provider accepted the prompt that carried it. */
  readonly commit: () => void;
}

/**
 * What changed in the rule files since this session last read them, or null.
 * A session never seen before is taken as current (nothing to compare with),
 * so an update appears only for a change made while the session lived.
 */
export async function pendingRuleUpdate(owner: object, threadId: string, provider: string, cwd: string): Promise<PendingRuleUpdate | null> {
  if (!WATCHED_PROVIDERS.has(provider)) return null;
  const record = baselines.get(owner)?.get(threadId);
  if (record === undefined || record.cwd !== cwd) {
    await captureRuleBaseline(owner, threadId, provider, cwd);
    return null;
  }
  const current = await readRuleFiles(cwd).catch(() => null);
  if (current === null) return null;
  const text = describeRuleChanges(record.files, current, cwd);
  if (text === null) return null;
  return { text, commit: () => void recordsOf(owner).set(threadId, { cwd, files: current }) };
}

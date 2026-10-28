/**
 * Skills for a harness session: folders holding a `SKILL.md` with a name and a
 * description. The model is told the names and descriptions (in the `skill`
 * tool's description) and loads a skill's text by calling the tool, so a
 * skill costs one line until it is used.
 *
 * Where they come from follows what the Claude and OpenCode drivers read, so a
 * project behaves the same under any of them: the project's `.claude/skills`
 * and `.agents/skills`, then the user's own in the same two folders of the
 * home directory. A skill by the same name is taken from the first of those
 * only. Moxen ships no skills of its own; a copy an older Moxen left in a
 * project (marked `.moxen-skill.json`) is skipped until the session start
 * takes it out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HarnessTool, ToolResult } from "./tools/index.js";

const MARKER_FILE = ".moxen-skill.json";
const MAX_SKILLS = 60;
const MAX_DESCRIPTION_CHARS = 300;
/** A skill's text is not pruned later, so it is capped when it is read. */
const MAX_BODY_CHARS = 40_000;

export interface Skill {
  readonly name: string;
  readonly description: string;
  /** The skill's folder. */
  readonly dir: string;
  readonly file: string;
}

export interface DiscoverSkillsInput {
  readonly cwd: string;
  readonly home?: string;
}

/** The frontmatter fields we read (single-line values, or a `>`/`|` block), and the body after it. */
export function parseSkillFile(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[index]!);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (index + 1 < lines.length && /^[ \t]+\S|^\s*$/.test(lines[index + 1]!)) block.push(lines[++index]!.trim());
      value = block.filter((line) => line !== "").join(folded ? " " : "\n");
    } else if (/^(".*"|'.*')$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[field[1]!] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

function readSkill(dir: string): Skill | null {
  const file = path.join(dir, "SKILL.md");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { fields, body } = parseSkillFile(text);
  const folder = path.basename(dir);
  const name = fields["name"] && /^[A-Za-z0-9._-]{1,64}$/.test(fields["name"]) ? fields["name"] : folder;
  const description = (fields["description"] || body.split(/\r?\n/).find((line) => line.trim() !== "" && !line.startsWith("#")) || "").replace(/\s+/g, " ").trim();
  if (description === "") return null;
  return { name, description: description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : description, dir, file };
}

function skillDirs(folder: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(folder, entry.name))
    .filter((dir) => !fs.existsSync(path.join(dir, MARKER_FILE)))
    .sort();
}

/** The skills this session offers, sorted by name; the list is fixed once the session starts. */
export function discoverSkills(input: DiscoverSkillsInput): Skill[] {
  const home = input.home ?? os.homedir();
  const folders = [
    path.join(input.cwd, ".claude", "skills"),
    path.join(input.cwd, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
  ];
  const found = new Map<string, Skill>();
  for (const folder of folders) {
    for (const dir of skillDirs(folder)) {
      const skill = readSkill(dir);
      if (!skill || found.has(skill.name)) continue;
      found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((left, right) => (left.name < right.name ? -1 : 1)).slice(0, MAX_SKILLS);
}

/** The `skill` tool, or null when there is nothing to offer (the prompt then does not mention it). */
export function skillTool(skills: readonly Skill[]): HarnessTool<never> | null {
  if (skills.length === 0) return null;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const tool: HarnessTool<{ name: string }> = {
    readOnly: true,
    definition: {
      name: "skill",
      description: [
        "Loads the full instructions of a skill: a packaged way of doing one kind of task. When the task matches a skill below, load it before you start and follow it. Load a skill once; its text stays in the conversation.",
        "",
        "Skills:",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
      parameters: {
        type: "object",
        properties: { name: { type: "string", enum: skills.map((skill) => skill.name), description: "The skill to load." } },
        required: ["name"],
      },
    },
    intent: (args) => ({ action: "read", paths: [byName.get(args.name)?.file ?? ""].filter((file) => file !== "") }),
    async run(args): Promise<ToolResult> {
      const skill = byName.get(args.name);
      if (!skill) return { content: `There is no skill named "${args.name}". The skills are: ${[...byName.keys()].join(", ")}.`, isError: true };
      let text: string;
      try {
        text = fs.readFileSync(skill.file, "utf8");
      } catch (error) {
        return { content: `Could not read the skill ${skill.name}: ${(error as Error).message}`, isError: true };
      }
      const body = parseSkillFile(text).body.trim();
      const shown = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[… the skill's text was cut at ${MAX_BODY_CHARS} characters]` : body;
      return { content: `# Skill: ${skill.name}\nThe skill's folder is ${skill.dir}; files it mentions are relative to it, and you can read them with read.\n\n${shown}` };
    },
  };
  return tool as unknown as HarnessTool<never>;
}

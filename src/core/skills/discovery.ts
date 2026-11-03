import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpProviderKind } from "../mcp.js";
import { parseSkillFile } from "../providers/harness/skills.js";
import { skillOfferedTo } from "./routing.js";

/** Native providers discover ancestor packages too; their deny rules must cover those roots. */
export function excludedSkills(cwd: string, provider: McpProviderKind, home = os.homedir()): { name: string; folder: string; file: string }[] {
  const roots = new Set<string>([home]);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    roots.add(dir);
    if (path.dirname(dir) === dir) break;
  }
  const excluded: { name: string; folder: string; file: string }[] = [];
  for (const root of roots) {
    for (const source of [".agents", ".claude"]) {
      const folder = path.join(root, source, "skills");
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
      for (const entry of entries) {
        if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
        const dir = path.join(folder, entry.name);
        const file = path.join(dir, "SKILL.md");
        if (!fs.existsSync(file) || fs.existsSync(path.join(dir, ".moxen-skill.json")) || skillOfferedTo(dir, provider)) continue;
        const { fields } = parseSkillFile(fs.readFileSync(file, "utf8"));
        excluded.push({ name: fields.name || entry.name, folder: entry.name, file });
      }
    }
  }
  return excluded;
}

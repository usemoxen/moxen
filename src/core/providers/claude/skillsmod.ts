/**
 * Where the `agent-skills` mod lives on disk, for a Claude session to be
 * started with: it rides in as a local plugin (`plugins`) and serves the
 * user's own `.agents/skills`, which Claude Code does not read itself. It
 * ships in the package (`mods` in `files`); the package root is found by
 * walking up to `package.json`, so it is the same folder in source and in the
 * bundled `dist`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillsMod {
  /** The mod's plugin directory. */
  readonly path: string;
}

/** The mod of this install, or null when the package has no mod folder (a trimmed copy). */
export function locateSkillsMod(from: string = path.dirname(fileURLToPath(import.meta.url))): SkillsMod | null {
  let root = from;
  while (!existsSync(path.join(root, "package.json"))) {
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  const mod = path.join(root, "mods", "agent-skills");
  if (!existsSync(path.join(mod, "hooks", "hooks.json"))) return null;
  return { path: mod };
}

/**
 * Where the `agent-skills` mod and moxen's bundled skills live on disk, for a
 * Claude session to be started with: the mod rides in as a local plugin
 * (`plugins`), and `MOXEN_SKILLS_DIR` tells it where moxen's own skills are.
 * Both ship in the package (`mods`, `skills` in `files`), at the same depth from
 * here in source and in `dist`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillsMod {
  /** The mod's plugin directory. */
  readonly path: string;
  /** Moxen's own skills, when the package carries them. */
  readonly bundledSkillsDir: string | null;
}

/** The mod and bundled skills of this install, or null when the package has no mod folder (a trimmed copy). */
export function locateSkillsMod(from: string = path.dirname(fileURLToPath(import.meta.url))): SkillsMod | null {
  const root = path.resolve(from, "..", "..", "..", "..");
  const mod = path.join(root, "mods", "agent-skills");
  if (!existsSync(path.join(mod, "hooks", "hooks.json"))) return null;
  const skills = path.join(root, "skills");
  return { path: mod, bundledSkillsDir: existsSync(skills) ? skills : null };
}

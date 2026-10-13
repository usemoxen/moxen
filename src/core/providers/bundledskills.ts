/**
 * Where moxen's own skills (`skills/` in the package) are on disk, for the
 * providers that are told about them. Found by walking up from this file to the
 * package root, so it is the same folder in source and in `dist`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package's `skills` folder, or null when this copy ships without one. */
export function locateBundledSkills(from: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, "package.json"))) {
      const skills = path.join(dir, "skills");
      return existsSync(skills) ? skills : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

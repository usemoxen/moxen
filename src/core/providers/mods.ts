/** Bundled mods live beside package.json in both the checkout and the installed package. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStandaloneExecutable, resolveAppRoot } from "../infra/standalone.js";

export function locateBundledMod(
  name: string,
  entry: string,
  from = path.dirname(fileURLToPath(import.meta.url)),
  execDir: string = path.dirname(process.execPath),
  standalone: boolean = isStandaloneExecutable(),
): string | null {
  const root = resolveAppRoot(from, execDir, standalone);
  if (root === null) return null;
  const mod = path.join(root, "mods", name);
  return existsSync(path.join(mod, entry)) ? mod : null;
}

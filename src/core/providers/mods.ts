/** Bundled mods live beside package.json in both the checkout and the installed package. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function locateBundledMod(name: string, entry: string, from = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let root = from;
  while (!existsSync(path.join(root, "package.json"))) {
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  const mod = path.join(root, "mods", name);
  return existsSync(path.join(mod, entry)) ? mod : null;
}

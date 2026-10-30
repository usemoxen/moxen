import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tui = fileURLToPath(new URL("../../../", import.meta.url));

function componentsIn(folder: string): string[] {
  const names: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests" && entry.name !== "scenes") walk(full);
      } else if (entry.name.endsWith(".tsx")) {
        for (const match of readFileSync(full, "utf8").matchAll(/^export function ([A-Z]\w*)/gm)) names.push(match[1]!);
      }
    }
  };
  walk(path.join(tui, folder));
  return names;
}

/**
 * Components the gallery does not draw yet; empty now. Give a new component an
 * entry rather than adding it here to dodge the test.
 */
const NOT_YET: string[] = [];

describe("component gallery", () => {
  const drawn = ["gallery/ui.tsx", "gallery/features.tsx", "gallery/settings.tsx", "gallery/scenes.tsx", "gallery/sidepanel.tsx", "gallery/editors.tsx", "gallery/panels.tsx"].map((file) => readFileSync(path.join(tui, "render-check", file), "utf8")).join("\n");
  const all = [...componentsIn("ui"), ...componentsIn("features")];

  it("draws every component, or names it as not yet drawn", () => {
    const missing = all.filter((name) => !drawn.includes(`<${name}`) && !NOT_YET.includes(name));
    expect(missing).toEqual([]);
  });

  it("does not list a component that is drawn, or that no longer exists", () => {
    expect(NOT_YET.filter((name) => drawn.includes(`<${name}`) || !all.includes(name))).toEqual([]);
  });
});

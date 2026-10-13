import { createAstraScene } from "./astra.js";
import { createFableScene } from "./fable.js";
import { createHaikuScene } from "./haiku.js";
import { createLunaScene } from "./luna.js";
import { createMythosScene } from "./mythos.js";
import { createOpusScene } from "./opus.js";
import { createSolScene } from "./sol.js";
import { createSonnetScene } from "./sonnet.js";
import { createTerraScene } from "./terra.js";
import type { SceneEngine } from "./raster.js";

/**
 * Which models have a scene of their own. A model without one keeps the
 * monitoring backdrop.
 */
export type SceneId = "haiku" | "sonnet" | "opus" | "fable" | "mythos" | "astra" | "sol" | "terra" | "luna";

const family = (word: string) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i");

const SCENE_BY_FAMILY: readonly [pattern: RegExp, scene: SceneId][] = [
  [family("haiku"), "haiku"],
  [family("opus"), "opus"],
  [family("fable"), "fable"],
  [family("mythos"), "mythos"],
  [family("sonnet"), "sonnet"],
  [family("astra"), "astra"],
  [family("sol"), "sol"],
  [family("terra"), "terra"],
  [family("luna"), "luna"],
];

/**
 * The scene for a model, matched on its family word in whatever names it —
 * the catalog's display name ("Claude Opus 5", "GPT-6.1 Sol"), a raw slug
 * (`claude-opus-5-5`), or an OpenCode-style `anthropic/claude-opus-…`.
 */
export function sceneForModel(model: string | null | undefined): SceneId | null {
  if (!model) return null;
  for (const [pattern, scene] of SCENE_BY_FAMILY) if (pattern.test(model)) return scene;
  return null;
}

export function createScene(id: SceneId): SceneEngine {
  switch (id) {
    case "haiku":
      return createHaikuScene();
    case "opus":
      return createOpusScene();
    case "sonnet":
      return createSonnetScene();
    case "fable":
      return createFableScene();
    case "mythos":
      return createMythosScene();
    case "astra":
      return createAstraScene();
    case "sol":
      return createSolScene();
    case "terra":
      return createTerraScene();
    case "luna":
      return createLunaScene();
  }
}

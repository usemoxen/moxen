import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { locateSkillsMod } from "../skillsmod.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("locating the agent-skills mod", () => {
  it("finds the mod and moxen's skills from the claude provider's folder", () => {
    const found = locateSkillsMod(path.resolve(here, ".."));
    expect(found).not.toBeNull();
    expect(existsSync(path.join(found!.path, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(path.join(found!.path, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(found!.bundledSkillsDir && existsSync(path.join(found!.bundledSkillsDir, "moxen-threads", "SKILL.md"))).toBe(true);
  });

  it("returns null where the package has no mod folder", () => {
    expect(locateSkillsMod(path.parse(here).root)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { buildCodexSystemPrompt } from "../prompt.js";

describe("Moxen's base prompt for Codex", () => {
  it("carries the working principles and leaves the runtime instructions' topics to them", () => {
    const prompt = buildCodexSystemPrompt();
    for (const heading of ["# Doing the work", "# Checking your work", "# Acting with care", "# Git", "# Delegation", "# Working with the user"]) expect(prompt).toContain(heading);
    for (const duplicated of ["# Showing images", "# Progress notes", "# Shell", "# Memory", "# Messages from Moxen", "# Look it up", "# Web"]) expect(prompt).not.toContain(duplicated);
    // Moxen's question tool is `ask`, and there is no Codex-native one.
    expect(prompt).not.toContain("question tool");
  });

  it("drops the plan guidance when the to-do list is off", () => {
    expect(buildCodexSystemPrompt()).toContain("keep a checklist with the todo tool");
    expect(buildCodexSystemPrompt({ checklist: false })).not.toContain("keep a checklist with the todo tool");
    // update_plan is never wanted, with the list on or off.
    expect(buildCodexSystemPrompt()).toContain("Never call update_plan");
    expect(buildCodexSystemPrompt({ checklist: false })).toContain("Never call update_plan");
  });
});

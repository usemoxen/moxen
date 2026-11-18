import { describe, expect, it } from "vitest";

import { CLAUDE_NATIVE_TOOLS, effectiveDisabledNativeTools } from "../nativetools.js";

describe("built-in tools off by default", () => {
  it("switches Codex's goals tools off until the user chooses, and only there", () => {
    expect(effectiveDisabledNativeTools("codex", undefined)).toBe("goals");
    expect(effectiveDisabledNativeTools("claude", undefined)).toBeUndefined();
    expect(effectiveDisabledNativeTools("opencode", undefined)).toBeUndefined();
  });

  it("takes an explicit choice as it stands, so clearing the list turns goals back on", () => {
    expect(effectiveDisabledNativeTools("codex", "")).toBe("");
    expect(effectiveDisabledNativeTools("codex", "shell")).toBe("shell");
  });

  it("leaves Claude's always-blocked subagent tool out of the settings catalogue", () => {
    // `Agent` is blocked in every Moxen-started session, so the settings page
    // must not offer it back; the rest of its group stays switchable.
    const names = CLAUDE_NATIVE_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain("Agent");
    expect(names).toEqual(expect.arrayContaining(["SendMessage", "Skill"]));
  });
});

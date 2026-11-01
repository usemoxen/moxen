import { describe, expect, it } from "vitest";

import { effectiveDisabledNativeTools } from "../nativetools.js";

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
});

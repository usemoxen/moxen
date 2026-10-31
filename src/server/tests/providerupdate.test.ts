import { describe, expect, it } from "vitest";

import { decodeCommand } from "../protocol.js";

describe("provider.update on the wire", () => {
  it("takes only a provider that can update", () => {
    expect(decodeCommand({ type: "provider.update", provider: "opencode" })).toMatchObject({ type: "provider.update", provider: "opencode" });
    expect(decodeCommand({ type: "provider.update", provider: "codex" })).toMatchObject({ provider: "codex" });
    for (const provider of ["grok", "", undefined, 3]) {
      expect(() => decodeCommand({ type: "provider.update", provider })).toThrow(/provider to be one of claude, opencode, codex/);
    }
  });
});

import { describe, expect, it } from "vitest";

import { parseAccountKind, parseEnvAssignments } from "../catalog/providers.js";

describe("CLI provider account argument parsing (MXN-459)", () => {
  it("accepts claude, chatgpt, and antigravity kinds and rejects codex or unknown kinds", () => {
    expect(parseAccountKind("claude")).toBe("claude");
    expect(parseAccountKind("ChatGPT")).toBe("chatgpt");
    expect(parseAccountKind("antigravity")).toBe("antigravity");
    expect(() => parseAccountKind("codex")).toThrow(/claude, chatgpt, antigravity/);
    expect(() => parseAccountKind("unknown")).toThrow(/claude, chatgpt, antigravity/);
  });

  it("parses KEY=VALUE environment variable assignments and rejects malformed entries", () => {
    expect(parseEnvAssignments(["FOO=bar", "URL=https://a=b"])).toEqual({ FOO: "bar", URL: "https://a=b" });
    expect(() => parseEnvAssignments(["NO_EQUALS"])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvAssignments(["=value"])).toThrow(/KEY=VALUE/);
  });
});

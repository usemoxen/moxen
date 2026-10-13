import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import { assertClaudeCodeVersion, CLAUDE_CODE_MIN_VERSION } from "../version.js";

describe("the Claude Code floor", () => {
  it("is the release the pinned Agent SDK is built against", () => {
    // Bumping @anthropic-ai/claude-agent-sdk without bumping CLAUDE_CODE_MIN_VERSION fails here:
    // the floor is how Moxen keeps up with Claude Code, so it must move with the SDK.
    // Read by path: the package's `exports` does not expose its own package.json. Tests run from the repo root.
    const manifest = path.join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    const sdk = JSON.parse(readFileSync(manifest, "utf8")) as { claudeCodeVersion?: string };
    expect(CLAUDE_CODE_MIN_VERSION).toBe(sdk.claudeCodeVersion);
  });
});

describe("assertClaudeCodeVersion", () => {
  const reading = (version: string | null) => async () => version;

  it("passes the floor and anything newer", async () => {
    await expect(assertClaudeCodeVersion("claude", {}, reading(CLAUDE_CODE_MIN_VERSION))).resolves.toBe(CLAUDE_CODE_MIN_VERSION);
    await expect(assertClaudeCodeVersion("claude", {}, reading("2.9.0"))).resolves.toBe("2.9.0");
  });

  it("refuses an older release, naming both versions and how to update", async () => {
    const refusal = await assertClaudeCodeVersion("claude", {}, reading("2.1.280")).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(CliError);
    expect(refusal).toMatchObject({ code: "CLAUDE_TOO_OLD", details: { version: "2.1.280", minVersion: CLAUDE_CODE_MIN_VERSION } });
    expect((refusal as CliError).message).toContain("claude update");
  });

  it("does not refuse a binary that cannot say its version: the spawn error that follows is clearer", async () => {
    await expect(assertClaudeCodeVersion("claude", {}, reading(null))).resolves.toBeNull();
  });
});

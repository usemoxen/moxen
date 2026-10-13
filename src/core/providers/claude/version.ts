/**
 * The Claude Code version Moxen supports. We drive the user's own `claude`
 * binary through the Agent SDK, and each SDK release is built against one
 * Claude Code release (its `claudeCodeVersion`); an older CLI can lack
 * protocol fields the SDK and our driver read. People also run Claude Code
 * directly and keep it current, so Moxen holds the floor at the release its
 * pinned SDK pairs with, and bumping the SDK means bumping this: a test
 * fails when they drift apart.
 */
import { CliError } from "../../errors.js";
import { runProcess } from "../../infra/process.js";
import { compareSemver, parseVersionNumber } from "../semver.js";

export const CLAUDE_CODE_MIN_VERSION = "2.1.292";

/** `claude --version`'s version number, or null when the binary cannot say (it is missing, or prints something else). */
export async function readClaudeCodeVersion(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await runProcess(binaryPath, ["--version"], { env, timeoutMs: 10_000 });
    return parseVersionNumber(result.stdout.split("\n")[0] ?? null);
  } catch {
    return null;
  }
}

/**
 * Refuses a Claude Code older than the floor, saying how to update it. A
 * version that cannot be read is not refused: the session that follows fails
 * with its own, clearer spawn error. Resolves to the version when it passes.
 */
export async function assertClaudeCodeVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  read: (binaryPath: string, env: NodeJS.ProcessEnv) => Promise<string | null> = readClaudeCodeVersion,
): Promise<string | null> {
  const version = await read(binaryPath, env);
  if (version !== null && compareSemver(version, CLAUDE_CODE_MIN_VERSION) < 0) {
    throw new CliError(
      "CLAUDE_TOO_OLD",
      `Claude Code v${version} is too old for Moxen. Update to v${CLAUDE_CODE_MIN_VERSION} or newer: run \`moxen update claude\`, use Update Claude Code in the command palette, or run \`claude update\`.`,
      { details: { version, minVersion: CLAUDE_CODE_MIN_VERSION, binaryPath } },
    );
  }
  return version;
}

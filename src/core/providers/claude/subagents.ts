/**
 * A native subagent's own conversation, read back from the transcript
 * Claude Code writes for it (`~/.claude/projects/<dir>/<session>/subagents/
 * agent-<id>.jsonl`) through the SDK's reader, which follows the message
 * chain the way resume does. Read-only: moxen never writes these files.
 */
import { getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import { withClaudeConfigDir } from "./transport.js";

export interface ClaudeTranscriptMessage {
  readonly type: "user" | "assistant" | "system";
  readonly uuid: string;
  /** The API message: `{ role, content }`, content a string or blocks. */
  readonly message: unknown;
  /** On disk and returned at runtime, though the SDK's type omits it. */
  readonly timestamp: string | null;
}

/**
 * The subagent's messages in order; empty when the transcript is not there
 * (yet, or any more). `configDir` is the account's `CLAUDE_CONFIG_DIR` —
 * the SDK reader looks there, not in the server process's environment.
 */
export async function readClaudeSubagent(sessionId: string, agentId: string, cwd: string, configDir?: string): Promise<ClaudeTranscriptMessage[]> {
  const messages = await withClaudeConfigDir(configDir, () => getSubagentMessages(sessionId, agentId, { dir: cwd })).catch(() => []);
  return messages.map((entry) => {
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    return { type: entry.type, uuid: entry.uuid, message: entry.message, timestamp: typeof timestamp === "string" ? timestamp : null };
  });
}

/**
 * Prints the system prompt Moxen builds for a session with every optional
 * part switched on, so a change to the instructions can be read in full.
 *
 *   bun scripts/system-prompt.ts             Claude Code session
 *   bun scripts/system-prompt.ts opencode    OpenCode session (adds its subagent and checklist sections)
 *
 * It calls the same builders the app does (`buildRuntimeInstructions`,
 * `memoryIndexSection`) with made-up inputs: a worktree, the Moxen, Brave and
 * Exa servers attached, delegation tools, writable memory, a search order, and
 * one line of user instructions. What the harness adds around it (Claude Code's
 * own preset prompt, OpenCode's base prompt) is the provider's, not Moxen's.
 */
import { APP_NAME } from "../src/core/config.js";
import type { McpServerSpec } from "../src/core/mcp.js";
import { buildRuntimeInstructions, memoryIndexSection } from "../src/core/threads/instructions.js";

const provider = process.argv[2] === "opencode" ? "opencode" : "claude";

const moxenServer: McpServerSpec = {
  name: APP_NAME,
  type: "in-process",
  tools: [],
  call: async () => ({ text: "", isError: false }),
  fallback: { name: APP_NAME, type: "stdio", command: APP_NAME, args: [], env: {} },
};
const braveServer: McpServerSpec = { name: "brave-search", type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: {} };
const exaServer: McpServerSpec = { name: "exa", type: "http", url: "https://mcp.exa.ai/mcp", headers: {} };

const instructions = buildRuntimeInstructions({
  instanceId: provider === "claude" ? "claudeAgent" : "opencode",
  env: { mode: "worktree", path: "/path/to/worktree", branch: "moxen/example" },
  userInstructions: ["(Your `instructions` from the config and the project's moxen.json go here.)"],
  checklist: true,
  delegationTools: true,
  memory: "write",
  web: {
    provider,
    searchOrder: ["exa", "brave", "native"],
    fetchOrder: ["moxen", "native", "exa"],
    servers: [moxenServer, braveServer, exaServer],
  },
});

process.stdout.write(`${instructions}\n\n${memoryIndexSection("- [example-memory](example-memory.md) — one line per saved memory")}\n`);

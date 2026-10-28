/**
 * The `moxen` MCP server process a provider session launches over stdio:
 * `bun src/server/mcp/main.ts --thread <parent-thread-id>`. It reaches
 * moxen the way every client does (`openClient`, per `MOXEN_SERVER`): with
 * a shared server running, delegated tasks live there and outlast this
 * process; without one they run in here, for as long as the parent's
 * provider session keeps this server up.
 *
 * Stdout is the protocol channel: nothing else may be written to it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { McpServerSpec } from "../../core/mcp.js";
import { openClient } from "../client.js";
import { memoryAccessOf, MOXEN_CHECKLIST_ARG, MOXEN_DELEGATED_ARG, MOXEN_MEMORY_ARG, MOXEN_NO_WEB_FETCH_ARG, serveMcp } from "./stdio.js";

/** The name agents see its tools under (`mcp__moxen__delegate`). */
export const MOXEN_MCP_SERVER_NAME = "moxen";

/**
 * This file in the source tree, `server/mcp/entry.js` beside `cli/` in the bundle
 * (where this code lives in a chunk under `chunks/` and has no `main.ts` next to it).
 */
function mcpEntry(): string {
  const source = fileURLToPath(new URL("./main.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("../server/mcp/entry.js", import.meta.url));
}

/** How a provider session launches the moxen tools for one thread. */
export function moxenMcpServerSpec(threadId: string): Extract<McpServerSpec, { type: "stdio" }> {
  const entry = mcpEntry();
  // Bun runs the TypeScript directly: this runtime when it is Bun, else `bun` from PATH.
  const runtime = process.versions.bun ? process.execPath : "bun";
  return { name: MOXEN_MCP_SERVER_NAME, type: "stdio", command: runtime, args: [entry, "--thread", threadId], env: {} };
}

function threadArg(argv: readonly string[]): string | null {
  const index = argv.indexOf("--thread");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && value.trim() ? value.trim() : null;
}

/** Serves the moxen tools over stdio for the thread named on the command line, then exits. */
export async function runMcpMain(argv: readonly string[] = process.argv.slice(2)): Promise<never> {
  const parentThreadId = threadArg(argv);
  if (!parentThreadId) {
    process.stderr.write("moxen mcp: --thread <thread-id> is required\n");
    process.exit(2);
  }
  const api = await openClient();
  try {
    const checklist = argv.includes(MOXEN_CHECKLIST_ARG);
    await serveMcp({ api, parentThreadId, checklist, delegated: argv.includes(MOXEN_DELEGATED_ARG), webFetch: !argv.includes(MOXEN_NO_WEB_FETCH_ARG), memory: memoryAccessOf(argv.find((arg) => arg.startsWith(MOXEN_MEMORY_ARG))?.slice(MOXEN_MEMORY_ARG.length)), input: process.stdin, output: process.stdout });
  } finally {
    await api.close().catch(() => undefined);
  }
  process.exit(0);
}

if (import.meta.main) await runMcpMain();

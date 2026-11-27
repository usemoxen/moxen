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
import type { AgentQueuedMessage, QueuedAgentMessage } from "../../core/threads/operations.js";
import { isStandaloneExecutable, STANDALONE_MCP_ARG } from "../../core/infra/standalone.js";
import { openClient } from "../client.js";
import { memoryAccessOf, MOXEN_CHECKLIST_ARG, MOXEN_DELEGATED_ARG, MOXEN_MCP_TOKEN_ENV, MOXEN_MCP_URL_ENV, MOXEN_MEMORY_ARG, MOXEN_NO_WEB_FETCH_ARG, serveMcp } from "./stdio.js";
import type { AgentQueueAccess, ProjectRegistrationAccess, RegisteredProject } from "./tools.js";

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
export function moxenMcpServerSpec(threadId: string, standalone: boolean = isStandaloneExecutable()): Extract<McpServerSpec, { type: "stdio" }> {
  // A standalone binary re-runs itself in its internal MCP mode; otherwise the entry runs on Bun.
  if (standalone) {
    return { name: MOXEN_MCP_SERVER_NAME, type: "stdio", command: process.execPath, args: [STANDALONE_MCP_ARG, "--thread", threadId], env: {} };
  }
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

/**
 * One relayed moxen tool call over the daemon-issued loopback MCP
 * credential. The credential names the thread; the `--thread` argument is
 * not proof of identity. No credential means no binding, and the tools
 * fail closed.
 */
function relayCredential(env: Readonly<Record<string, string | undefined>>): { readonly url: string; readonly token: string } | undefined {
  const url = env[MOXEN_MCP_URL_ENV];
  const token = env[MOXEN_MCP_TOKEN_ENV];
  return url && token ? { url, token } : undefined;
}

async function relayCall<T>(credential: { readonly url: string; readonly token: string }, name: string, args: Record<string, unknown>, send: typeof fetch): Promise<T> {
  const response = await send(credential.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`Relay refused (${response.status}).`);
  const body = await response.json() as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Relay failed.");
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

/** Agent queue management over the daemon-issued loopback MCP credential. */
export function relayAgentQueue(
  env: Readonly<Record<string, string | undefined>> = process.env,
  send: typeof fetch = fetch,
): AgentQueueAccess | undefined {
  const credential = relayCredential(env);
  if (!credential) return undefined;
  const call = <T>(name: string, args: Record<string, unknown>) => relayCall<T>(credential, name, args, send);
  return {
    queue: async (_callerThreadId, input) => await call<QueuedAgentMessage>("message_queue", { ...input }),
    list: async () => (await call<{ messages: AgentQueuedMessage[] }>("message_queue_list", {})).messages,
    edit: async (_callerThreadId, turnId, conditions) => await call("message_queue_edit", { turnId, conditions }),
    remove: async (_callerThreadId, turnId) => await call("message_queue_remove", { turnId }),
  };
}

/**
 * The project registration over the same credential: the write runs as the
 * thread the credential names — the relayed call carries no thread id at
 * all — and the server authorizes it inside the mutation (LOCAL-035). No
 * credential means no binding, and the write fails closed.
 */
export function relayProjectRegistration(
  env: Readonly<Record<string, string | undefined>> = process.env,
  send: typeof fetch = fetch,
): ProjectRegistrationAccess | undefined {
  const credential = relayCredential(env);
  if (!credential) return undefined;
  return {
    register: async (_callerThreadId, request) => {
      const result = await relayCall<RegisteredProject>(
        credential,
        "project_register",
        { cwd: request.cwd, ...(request.dryRun === true ? { dryRun: true } : {}) },
        send,
      );
      if (
        result === null
        || typeof result !== "object"
        || typeof result.workspaceRoot !== "string"
        || typeof result.created !== "boolean"
        || result.project === null
        || typeof result.project !== "object"
        || typeof result.project.id !== "string"
      ) {
        throw new Error("The moxen MCP server returned a malformed project_register response.");
      }
      return {
        project: {
          id: result.project.id,
          title: result.project.title,
          workspaceRoot: result.project.workspaceRoot,
          createdAt: result.project.createdAt,
        },
        workspaceRoot: result.workspaceRoot,
        created: result.created,
        ...(result.revived === true ? { revived: true } : {}),
      };
    },
  };
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
    const agentQueue = relayAgentQueue();
    const projectRegistration = relayProjectRegistration();
    await serveMcp({ api, parentThreadId, checklist, delegated: argv.includes(MOXEN_DELEGATED_ARG), webFetch: !argv.includes(MOXEN_NO_WEB_FETCH_ARG), memory: memoryAccessOf(argv.find((arg) => arg.startsWith(MOXEN_MEMORY_ARG))?.slice(MOXEN_MEMORY_ARG.length)), ...(agentQueue ? { agentQueue } : {}), ...(projectRegistration ? { projectRegistration } : {}), input: process.stdin, output: process.stdout });
  } finally {
    await api.close().catch(() => undefined);
  }
  process.exit(0);
}

if (import.meta.main) await runMcpMain();

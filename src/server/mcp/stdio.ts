/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, tools
 * only — `initialize`, `tools/list`, `tools/call`, `ping`. That is the
 * whole surface the moxen tools need, and it keeps us off a runtime
 * dependency we would otherwise only reach transitively. `answerMcp` is the
 * protocol itself, shared with the HTTP transport (`http.ts`).
 */
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

import type { ClientApi } from "../api.js";
import { callMoxenTool, moxenToolsFor, type MemoryAccess } from "./tools.js";

/** Newest first; an unknown client version is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** What the server tells a model about itself, whatever the transport. */
export const MOXEN_MCP_INSTRUCTIONS =
  "moxen runs coding agents as threads. Do not delegate unless the user asks you to (or put the thread in Research or Orchestrate mode): each subagent starts cold and costs the user usage, so do the work yourself by default. " +
  "When they do ask, use delegate to hand a self-contained task to a subagent thread " +
  "(any provider and model, in its own git worktree). When it settles, a <task-notification> message arrives in your conversation " +
  "with its headline and branch, mid-turn or as a turn of its own. Do not poll task_status: keep working or end your turn, " +
  "and call it once for the full report. " +
  "thread_search and thread_read find and read other threads, a step at a time. " +
  "The models tool lists the providers, models and efforts you can delegate to. " +
  "web_fetch reads a web page as text; it is not part of delegating.";

/** What a delegated task is told: it has no delegation tools, so only what is left is described. */
export const MOXEN_DELEGATED_MCP_INSTRUCTIONS = "web_fetch reads a web page as text, retrying through a browser for pages built by scripts.";

/** What a session with Moxen memory is told about its tools; the rules for using it are in the runtime instructions. */
export const MOXEN_MEMORY_MCP_INSTRUCTIONS = "memory_read, memory_save, memory_edit, memory_append and memory_delete are Moxen's persistent memory, kept across sessions and providers.";
export const MOXEN_MEMORY_READ_MCP_INSTRUCTIONS = "memory_read reads Moxen's persistent memory.";

/** The server's instructions for the tools a session has: the delegation tools, `web_fetch`, memory, any of them, or none. */
export function moxenInstructions(options: { readonly delegated?: boolean; readonly webFetch?: boolean; readonly memory?: MemoryAccess }): string {
  const web = options.webFetch !== false;
  const base =
    options.delegated === true
      ? web
        ? MOXEN_DELEGATED_MCP_INSTRUCTIONS
        : ""
      : web
        ? MOXEN_MCP_INSTRUCTIONS
        : MOXEN_MCP_INSTRUCTIONS.replace(/ web_fetch reads a web page as text; it is not part of delegating\.$/, "");
  const memory = options.memory ?? "write";
  const note = memory === "write" ? MOXEN_MEMORY_MCP_INSTRUCTIONS : memory === "read" ? MOXEN_MEMORY_READ_MCP_INSTRUCTIONS : "";
  return [base, note].filter((part) => part !== "").join(" ");
}

/** How a client asks for the `todos` tool too: the HTTP endpoint's query, the stdio server's flag. */
export const MOXEN_CHECKLIST_QUERY = "checklist=1";
export const MOXEN_CHECKLIST_ARG = "--checklist";
/** How a client asks for the tools of a delegated task (no delegation): the HTTP endpoint's query, the stdio server's flag. */
export const MOXEN_DELEGATED_QUERY = "delegated=1";
export const MOXEN_DELEGATED_ARG = "--delegated";
/** How a client asks for the tools without `web_fetch` (switched off for its provider): the HTTP endpoint's query, the stdio server's flag. */
export const MOXEN_NO_WEB_FETCH_QUERY = "webfetch=0";
export const MOXEN_NO_WEB_FETCH_ARG = "--no-web-fetch";
/** How a client asks for memory read-only or without it: the HTTP endpoint's `memory=` query, the stdio server's `--memory=` flag. Absent: every memory tool. */
export const MOXEN_MEMORY_QUERY = "memory";
export const MOXEN_MEMORY_ARG = "--memory=";

/** The memory access an HTTP query or argv asked for. */
export function memoryAccessOf(value: string | null | undefined): MemoryAccess {
  return value === "read" || value === "off" ? value : "write";
}

export interface McpSessionOptions {
  readonly api: ClientApi;
  /** The thread whose agent these tools act for. */
  readonly parentThreadId: string;
  readonly version?: string;
  /** Also offer `todos`: the provider keeps no checklist of its own. */
  readonly checklist?: boolean;
  /** No delegation tools: the thread is a delegated task (it does not delegate again), or its provider has them off. */
  readonly delegated?: boolean;
  /** False: no `web_fetch` (switched off for the thread's provider). */
  readonly webFetch?: boolean;
  /** Moxen memory's tools; absent: all of them. */
  readonly memory?: MemoryAccess;
}

export interface ServeMcpOptions extends McpSessionOptions {
  readonly input: Readable;
  readonly output: Writable;
}

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly params?: unknown;
}

/**
 * The JSON-RPC answer to one request, or null for a notification (no id),
 * which needs none. Never throws: a tool failure is a tool error result, an
 * internal failure a JSON-RPC error.
 */
export async function answerMcp(options: McpSessionOptions, raw: unknown): Promise<Record<string, unknown> | null> {
  const request = (raw !== null && typeof raw === "object" ? raw : {}) as JsonRpcRequest;
  const id = request.id;
  if (id === undefined) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = typeof request.method === "string" ? request.method : "";
  const params = request.params !== null && typeof request.params === "object" ? (request.params as Record<string, unknown>) : {};
  try {
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "moxen", version: options.version ?? "0.0.0" },
          instructions: moxenInstructions(options),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: moxenToolsFor({ checklist: options.checklist === true, delegated: options.delegated === true, webFetch: options.webFetch !== false, memory: options.memory ?? "write" }) });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          params.arguments !== null && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        const result = await callMoxenTool(options.api, options.parentThreadId, name, args, { delegated: options.delegated === true, webFetch: options.webFetch !== false, memory: options.memory ?? "write" });
        return reply({ content: [{ type: "text", text: result.text }], isError: result.isError });
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (cause) {
    return fail(-32603, cause instanceof Error ? cause.message : String(cause));
  }
}

/** Serve until `input` ends. Requests are answered concurrently; each reply is one line. */
export async function serveMcp(options: ServeMcpOptions): Promise<void> {
  const write = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const running = answerMcp(options, request).then((answer) => {
      if (answer !== null) write(answer);
    });
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
  }
  await Promise.all(inFlight);
}

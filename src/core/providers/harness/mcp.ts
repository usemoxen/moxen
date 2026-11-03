/**
 * The MCP servers a harness session was given, as tools next to the built-in
 * ones. `openMcpPool` connects them once, when the session starts, and the tool
 * list it returns is fixed for the session: the model's tools (and with them
 * the server's prompt cache) do not move mid-conversation. A change to the
 * configured servers reaches a new session.
 *
 * How the MCP rules land here:
 * - names: `mcp__<server>__<tool>`, as Claude spells them. A built-in never
 *   starts with `mcp__`, so none can be shadowed; two servers' tools can only
 *   meet through sanitising or shortening, and the first in sorted order wins.
 * - permissions: a tool the server marks read-only is a read; any other asks
 *   like a shell command does, and is refused in a session nobody can answer.
 * - output: bounded at the tool (head and tail, the whole saved to a file),
 *   then wrapped as untrusted data, so a result cannot pass for the user.
 * - a server that stops is not restarted on its own; a later call starts it
 *   again, at most `MAX_RESTARTS` times in a session.
 */
import { untrustedContext } from "../../untrusted.js";
import { createHash } from "node:crypto";

import type { InProcessMcpServerSpec, McpServerSpec, OutOfProcessMcpServerSpec } from "../../mcp.js";
import { McpClient, McpClosedError, type McpCallResult, type McpToolInfo } from "./mcpclient.js";
import { boundOutput } from "./tools/bash.js";
import type { HarnessTool, ToolResult } from "./tools/index.js";

export const MCP_TOOL_PREFIX = "mcp__";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_SCHEMA_CHARS = 16_000;
const MAX_RESTARTS = 3;

export type ConnectMcp = (spec: OutOfProcessMcpServerSpec, cwd: string) => Promise<McpClient>;

export interface McpPoolOptions {
  readonly cwd: string;
  /** Where a cut-off result is saved in full. */
  readonly artifactDir: string;
  /** Swapped out in tests. */
  readonly connect?: ConnectMcp;
  /** Tools the user switched off, as `mcp__<server>__<tool>` (the server's own tool name). */
  readonly disabled?: readonly string[];
}

export interface McpPool {
  /** Sorted by name; the same list for the life of the session. */
  readonly tools: readonly HarnessTool<never>[];
  /** Servers that are in the session, with what their operator said about using them (only moxen's own, which we trust). */
  readonly servers: ReadonlyArray<{ readonly name: string; readonly instructions: string | null }>;
  /** What did not come up or was left out, one line each, for the user. */
  readonly problems: readonly string[];
  close(): Promise<void>;
}

/** A server a session can call into, whichever way it is reached. */
interface ServerHandle {
  readonly name: string;
  readonly infos: readonly McpToolInfo[];
  /** Tools the server listed beyond what is offered. */
  readonly dropped: number;
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

function inProcessHandle(spec: InProcessMcpServerSpec): ServerHandle {
  return {
    name: spec.name,
    dropped: 0,
    infos: spec.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema, type: "object" }, readOnly: tool.annotations?.readOnlyHint === true })),
    call: (tool, args) => spec.call(tool, args),
    close: async () => {},
  };
}

class RemoteHandle implements ServerHandle {
  private restarts = 0;

  constructor(
    readonly name: string,
    private client: McpClient,
    private readonly spec: OutOfProcessMcpServerSpec,
    private readonly cwd: string,
    private readonly connect: ConnectMcp,
  ) {}

  get infos(): readonly McpToolInfo[] {
    return this.client.tools;
  }

  get dropped(): number {
    return this.client.dropped;
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    if (!this.client.alive) {
      if (this.restarts >= MAX_RESTARTS) return { text: `The MCP server "${this.name}" has stopped and was already restarted ${MAX_RESTARTS} times this session, so it is not started again. Carry on without it.`, isError: true };
      this.restarts += 1;
      try {
        // The tools the model was shown stay as they were; a restarted server that now lists others is not followed.
        this.client = await this.connect(this.spec, this.cwd);
      } catch (error) {
        return { text: `The MCP server "${this.name}" had stopped and could not be started again: ${(error as Error).message}.`, isError: true };
      }
    }
    try {
      return await this.client.call(tool, args, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const why = error instanceof McpClosedError ? `stopped (${error.message}) while this call was running; whether it took effect is unknown` : `failed (${(error as Error).message})`;
      return { text: `The MCP server "${this.name}" ${why}.`, isError: true };
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** A tool name the chat APIs accept (letters, digits, `_`, `-`, at most 64), the same for the same inputs. */
export function mcpToolName(server: string, tool: string): string {
  const name = `${MCP_TOOL_PREFIX}${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (name.length <= MAX_NAME_LENGTH) return name;
  const suffix = createHash("sha1").update(`${server}\0${tool}`).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_NAME_LENGTH - 7)}_${suffix}`;
}

export { untrustedContext };

function describe(info: McpToolInfo): { description: string; parameters: Record<string, unknown> } {
  const text = info.description.length > MAX_DESCRIPTION_CHARS ? `${info.description.slice(0, MAX_DESCRIPTION_CHARS)}…` : info.description;
  if (JSON.stringify(info.inputSchema).length <= MAX_SCHEMA_CHARS) return { description: text, parameters: info.inputSchema };
  return { description: `${text}\n(The argument schema was too large to list; pass the arguments this description names.)`.trim(), parameters: { type: "object", additionalProperties: true } };
}

function adapt(name: string, server: ServerHandle, info: McpToolInfo, artifactDir: string): HarnessTool<never> {
  const { description, parameters } = describe(info);
  const tool: HarnessTool<Record<string, unknown>> = {
    definition: { name, description: description === "" ? `The ${info.name} tool of the ${server.name} MCP server.` : description, parameters },
    readOnly: info.readOnly,
    intent: () => ({ action: info.readOnly ? "read" : "exec", paths: [], command: name, mcp: true }),
    async run(args, context): Promise<ToolResult> {
      const result = await server.call(info.name, args, context.signal);
      const images = context.acceptsImages ? result.parts?.flatMap((part) => part.image ? [part.image] : []) : undefined;
      // Position markers keep mixed results readable; transports send pictures using the same path as built-in tools.
      const text = context.acceptsImages && result.parts ? result.parts.map((part) => part.image ? `[image: ${part.image.mimeType}, attached as ${part.image.name}]` : part.text).join("\n") : result.text;
      if (text === "") return { content: result.isError ? "The tool failed and said nothing." : "(no output)", isError: result.isError };
      // Bounded first, so the saved file holds the server's own words, then marked as data.
      return { content: untrustedContext(boundOutput(text, artifactDir, "mcp"), `mcp:${server.name}/${info.name}`), isError: result.isError, ...(images && images.length > 0 ? { images } : {}) };
    },
  };
  return tool as unknown as HarnessTool<never>;
}

/** Connects every spec, in parallel, and builds the session's MCP tools. Never throws: a server that will not come up is a problem line. */
export async function openMcpPool(specs: readonly McpServerSpec[], options: McpPoolOptions): Promise<McpPool> {
  const connect = options.connect ?? ((spec, cwd) => McpClient.connect(spec, cwd));
  const problems: string[] = [];
  const sorted = [...specs].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const outcomes = await Promise.all(
    sorted.map(async (spec): Promise<{ spec: McpServerSpec; handle: ServerHandle | null }> => {
      if (spec.type === "in-process") return { spec, handle: inProcessHandle(spec) };
      try {
        return { spec, handle: new RemoteHandle(spec.name, await connect(spec, options.cwd), spec, options.cwd, connect) };
      } catch (error) {
        problems.push(`MCP server "${spec.name}" is not available: ${(error as Error).message}.`);
        return { spec, handle: null };
      }
    }),
  );

  const handles = outcomes.flatMap((outcome) => (outcome.handle ? [outcome.handle] : []));
  const taken = new Set<string>();
  const tools: HarnessTool<never>[] = [];
  for (const handle of handles) {
    for (const info of [...handle.infos].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (options.disabled?.includes(`mcp__${handle.name}__${info.name}`)) continue;
      const name = mcpToolName(handle.name, info.name);
      if (taken.has(name)) {
        problems.push(`MCP tool "${info.name}" of "${handle.name}" was left out: another tool is already called ${name}.`);
        continue;
      }
      taken.add(name);
      tools.push(adapt(name, handle, info, options.artifactDir));
    }
  }
  for (const handle of handles) {
    if (handle.dropped > 0) problems.push(`MCP server "${handle.name}" has more tools than the ${handle.infos.length} that are offered; ${handle.dropped} were left out.`);
  }
  tools.sort((left, right) => (left.definition.name < right.definition.name ? -1 : 1));

  return {
    tools,
    servers: outcomes.flatMap(({ spec, handle }) => (handle ? [{ name: spec.name, instructions: spec.type === "in-process" ? (spec.instructions ?? null) : null }] : [])),
    problems,
    close: async () => {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    },
  };
}

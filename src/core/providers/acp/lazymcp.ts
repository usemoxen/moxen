/**
 * Loopback HTTP lazy MCP gateway for Antigravity (`agy acp`).
 *
 * `agy acp` hardcodes `ForceAllToolsEager = true` on every MCP server passed
 * via ACP `session/new` / `session/load` / `session/resume`, and enforces a
 * 20,000-token `defaultCustomizationBudget` that silently evicts the largest
 * MCP tool schemas first (with no `call_mcp_tool` fallback). Large servers
 * like Linear (78 tools, ~30k tokens alone) blow past that budget and wipe out
 * `get_issue`, `list_issues`, `save_issue`, `delegate`, and `brave-search`.
 *
 * This gateway hosts all external (non-`moxen`) MCP servers behind two compact
 * tools (`search_tools` and `call_tool`, ~1.3 KB total) served on loopback
 * HTTP with a per-session Bearer token. Upstream servers connect lazily on
 * first use through Moxen's own `McpClient` (using the host environment and
 * keeping all credentials in-process, never written to disk), and `disabledTools`
 * is enforced here as well.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { outOfProcess, type McpServerSpec, type OutOfProcessMcpServerSpec } from "../../mcp.js";
import type { ConnectMcp } from "../harness/mcp.js";
import { McpClient, McpClosedError, type McpCallResult, type McpToolInfo } from "../harness/mcpclient.js";
import { freeName } from "../harness/presets.js";

export const LAZY_MCP_GATEWAY_BASE_NAME = "moxen-mcp";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_BODY_BYTES = 1_000_000;
const MAX_RESTARTS = 3;
const MAX_FULL_SCHEMA_RESULTS = 15;
const AUTO_INLINE_SERVER_TOOL_LIMIT = 12;

export interface AcpLazyMcpGatewayOptions {
  readonly specs: readonly McpServerSpec[];
  readonly cwd: string;
  /** Disabled tools as `mcp__<server>__<tool>`. */
  readonly disabledTools?: readonly string[];
  /** Existing server names to avoid colliding with (e.g. `moxen`). */
  readonly takenNames?: ReadonlySet<string>;
  /** Swapped out in tests. */
  readonly connect?: ConnectMcp;
}

interface UpstreamEntry {
  readonly spec: OutOfProcessMcpServerSpec;
  client: McpClient | null;
  connecting: Promise<McpClient> | null;
  restarts: number;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstLine(text: string, maxChars = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}

function formatSchemaEntry(server: string, tool: McpToolInfo): string {
  const lines = [`### ${server} / ${tool.name}`];
  if (tool.description.trim() !== "") lines.push(tool.description.trim());
  lines.push("Parameters (JSON Schema):");
  lines.push(JSON.stringify(tool.inputSchema));
  return lines.join("\n");
}

function toMcpContent(result: McpCallResult): Array<Record<string, unknown>> {
  if (result.parts && result.parts.length > 0) {
    const blocks: Array<Record<string, unknown>> = [];
    for (const part of result.parts) {
      if (part.image) {
        blocks.push({ type: "image", data: part.image.data, mimeType: part.image.mimeType });
      } else if (part.text !== "") {
        blocks.push({ type: "text", text: part.text });
      }
    }
    if (blocks.length > 0) return blocks;
  }
  return [{ type: "text", text: result.text || (result.isError ? "The tool failed without output." : "(no output)") }];
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

export function antigravityLazyMcpInstruction(gatewayName: string, serverNames: readonly string[]): string {
  const list = serverNames.join(", ");
  return [
    "# External MCP servers",
    `External MCP servers (${list}) are attached through the \`${gatewayName}\` lazy gateway so none of their tools are dropped by Antigravity's tool-schema budget.`,
    `Call \`mcp_${gatewayName}_search_tools\` to list tools or load exact parameter schemas, then call \`mcp_${gatewayName}_call_tool\` with \`{ server, tool, arguments }\`.`,
  ].join("\n");
}

export class AcpLazyMcpGateway {
  readonly name: string;
  readonly serverNames: readonly string[];
  readonly spec: Extract<OutOfProcessMcpServerSpec, { type: "http" }>;

  private readonly entries = new Map<string, UpstreamEntry>();
  private readonly disabled: ReadonlySet<string>;
  private readonly cwd: string;
  private readonly connectFn: ConnectMcp;
  private readonly token: string;
  private readonly server: Server;
  private readonly abort = new AbortController();
  private closed = false;
  private closingPromise: Promise<void> | null = null;

  private constructor(
    name: string,
    serverNames: readonly string[],
    url: string,
    token: string,
    server: Server,
    entries: Map<string, UpstreamEntry>,
    disabled: ReadonlySet<string>,
    cwd: string,
    connectFn: ConnectMcp,
  ) {
    this.name = name;
    this.serverNames = serverNames;
    this.token = token;
    this.server = server;
    this.entries = entries;
    this.disabled = disabled;
    this.cwd = cwd;
    this.connectFn = connectFn;
    this.spec = {
      name,
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
      alwaysLoad: true,
    };
  }

  static async start(options: AcpLazyMcpGatewayOptions): Promise<AcpLazyMcpGateway> {
    const sorted = [...options.specs]
      .map(outOfProcess)
      .sort((a, b) => a.name.localeCompare(b.name));
    const taken = new Set<string>(options.takenNames ?? []);
    for (const s of sorted) taken.add(s.name);
    const name = freeName(LAZY_MCP_GATEWAY_BASE_NAME, taken);
    const serverNames = sorted.map((s) => s.name);
    const entries = new Map<string, UpstreamEntry>();
    for (const s of sorted) {
      entries.set(s.name, { spec: s, client: null, connecting: null, restarts: 0 });
    }
    const disabled = new Set(options.disabledTools ?? []);
    const token = randomBytes(24).toString("hex");
    const connectFn: ConnectMcp = options.connect ?? ((spec, cwd) => McpClient.connect(spec, cwd));

    let gateway: AcpLazyMcpGateway | null = null;
    const server = createServer((request, response) => {
      if (!gateway) {
        response.writeHead(503).end();
        return;
      }
      void gateway.handleHttp(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const url = `http://127.0.0.1:${port}/mcp`;

    gateway = new AcpLazyMcpGateway(name, serverNames, url, token, server, entries, disabled, options.cwd, connectFn);
    return gateway;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (pathname !== "/mcp" || !sameSecret(given, this.token)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const body = await readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      respondJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (Array.isArray(parsed)) {
      const answers = (await Promise.all(parsed.map((item) => this.answerRpc(item)))).filter((item) => item !== null);
      if (answers.length === 0) response.writeHead(202).end();
      else respondJson(response, 200, answers);
      return;
    }
    const answer = await this.answerRpc(parsed);
    if (answer === null) response.writeHead(202).end();
    else respondJson(response, 200, answer);
  }

  private toolDefinitions(): Array<Record<string, unknown>> {
    const serverList = this.serverNames.join(", ");
    return [
      {
        name: "search_tools",
        description: `List or search tools from external MCP servers (${serverList}) and inspect their exact parameter schemas before calling call_tool.`,
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: `Optional MCP server name (${serverList}).`,
            },
            query: {
              type: "string",
              description: "Optional keywords to match tool names and descriptions; returns full parameter schemas for matching tools.",
            },
            tools: {
              type: "array",
              items: { type: "string" },
              description: "Optional exact tool names whose full parameter schemas to return.",
            },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "call_tool",
        description: `Call a tool on an external MCP server (${serverList}). Use search_tools first if you need its exact parameter schema.`,
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: `MCP server name (${serverList}).`,
            },
            tool: {
              type: "string",
              description: "Exact tool name on that server.",
            },
            arguments: {
              type: "object",
              description: "JSON arguments matching the tool's inputSchema.",
              additionalProperties: true,
            },
          },
          required: ["server", "tool"],
        },
      },
    ];
  }

  private async answerRpc(raw: unknown): Promise<Record<string, unknown> | null> {
    const request = isRecord(raw) ? raw : {};
    const id = request["id"];
    if (id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const method = typeof request["method"] === "string" ? request["method"] : "";
    const params = isRecord(request["params"]) ? request["params"] : {};

    try {
      switch (method) {
        case "initialize": {
          const asked = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
          const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          return reply({
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: "1.0.0" },
            instructions: `External MCP servers available via search_tools and call_tool: ${this.serverNames.join(", ")}.`,
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: this.toolDefinitions() });
        case "tools/call": {
          const toolName = typeof params["name"] === "string" ? params["name"] : "";
          const args = isRecord(params["arguments"]) ? params["arguments"] : {};
          if (toolName === "search_tools") {
            return reply(await this.handleSearchTools(args));
          }
          if (toolName === "call_tool") {
            return reply(await this.handleCallTool(args));
          }
          return reply({ content: [{ type: "text", text: `Unknown gateway tool "${toolName}".` }], isError: true });
        }
        default:
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (cause) {
      return fail(-32603, cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async ensureConnected(entry: UpstreamEntry): Promise<McpClient> {
    if (this.closed) throw new Error("gateway is closed");
    if (entry.client && entry.client.alive) return entry.client;
    if (entry.connecting) return entry.connecting;

    if (entry.client !== null) {
      if (entry.restarts >= MAX_RESTARTS) {
        throw new Error(`stopped and was already restarted ${MAX_RESTARTS} times this session`);
      }
      entry.restarts += 1;
      entry.client = null;
    }

    const pending = this.connectFn(entry.spec, this.cwd).then(
      (client) => {
        entry.connecting = null;
        if (this.closed) {
          void client.close().catch(() => undefined);
          throw new Error("gateway is closed");
        }
        entry.client = client;
        return client;
      },
      (error) => {
        entry.connecting = null;
        throw error;
      },
    );
    entry.connecting = pending;
    return pending;
  }

  private enabledToolsOf(serverName: string, client: McpClient): McpToolInfo[] {
    return client.tools.filter((tool) => !this.disabled.has(`mcp__${serverName}__${tool.name}`));
  }

  private async handleSearchTools(args: Record<string, unknown>): Promise<{ content: Array<Record<string, unknown>>; isError: boolean }> {
    const serverArg = typeof args["server"] === "string" ? args["server"].trim().toLowerCase() : "";
    const queryArg = typeof args["query"] === "string" ? args["query"].trim() : "";
    const toolsArg = Array.isArray(args["tools"])
      ? args["tools"].filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
      : [];

    let targetNames: string[];
    if (serverArg !== "") {
      if (!this.entries.has(serverArg)) {
        return {
          content: [{ type: "text", text: `Unknown MCP server "${serverArg}". Configured servers: ${this.serverNames.join(", ")}.` }],
          isError: true,
        };
      }
      targetNames = [serverArg];
    } else {
      targetNames = [...this.serverNames];
    }

    const loaded = await Promise.all(
      targetNames.map(async (name): Promise<{ name: string; tools: McpToolInfo[]; error: string | null }> => {
        const entry = this.entries.get(name)!;
        try {
          const client = await this.ensureConnected(entry);
          return { name, tools: this.enabledToolsOf(name, client), error: null };
        } catch (error) {
          return { name, tools: [], error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    const errors = loaded.filter((item) => item.error !== null).map((item) => `MCP server "${item.name}" unavailable: ${item.error}`);
    const allTools = loaded.flatMap((item) => item.tools.map((tool) => ({ server: item.name, tool })));

    // 1. Exact tool name lookup: return full schemas.
    if (toolsArg.length > 0) {
      const wanted = new Set(toolsArg.map((t) => t.toLowerCase()));
      const matches = allTools.filter(({ server, tool }) => {
        const bare = tool.name.toLowerCase();
        return wanted.has(bare) || wanted.has(`${server}/${bare}`) || wanted.has(`mcp__${server}__${bare}`);
      });
      if (matches.length === 0) {
        const text = [`No matching tools found for: ${toolsArg.join(", ")}.`, ...errors].join("\n");
        return { content: [{ type: "text", text }], isError: false };
      }
      const shown = matches.slice(0, MAX_FULL_SCHEMA_RESULTS);
      const blocks = shown.map(({ server, tool }) => formatSchemaEntry(server, tool));
      if (matches.length > shown.length) {
        blocks.push(`(${matches.length - shown.length} more matches omitted: ${matches.slice(shown.length).map((m) => `${m.server}/${m.tool.name}`).join(", ")})`);
      }
      if (errors.length > 0) blocks.push(...errors);
      return { content: [{ type: "text", text: blocks.join("\n\n") }], isError: false };
    }

    // 2. Keyword search: rank and return full schemas for top matches.
    if (queryArg !== "") {
      const terms = queryArg.toLowerCase().split(/\s+/).filter((term) => term !== "");
      const scored = allTools
        .map((item) => {
          const haystackName = `${item.server} ${item.tool.name}`.toLowerCase();
          const haystackAll = `${haystackName} ${item.tool.description.toLowerCase()}`;
          let matchedTerms = 0;
          let score = 0;
          for (const term of terms) {
            if (haystackName.includes(term)) {
              matchedTerms += 1;
              score += 3;
            } else if (haystackAll.includes(term)) {
              matchedTerms += 1;
              score += 1;
            }
          }
          if (matchedTerms === terms.length) score += 10;
          return { item, matchedTerms, score };
        })
        .filter((entry) => entry.matchedTerms > 0)
        .sort((a, b) => b.score - a.score || a.item.server.localeCompare(b.item.server) || a.item.tool.name.localeCompare(b.item.tool.name));

      if (scored.length === 0) {
        const text = [`No MCP tools matched "${queryArg}".`, ...errors].join("\n");
        return { content: [{ type: "text", text }], isError: false };
      }
      const shown = scored.slice(0, MAX_FULL_SCHEMA_RESULTS);
      const blocks = shown.map(({ item }) => formatSchemaEntry(item.server, item.tool));
      if (scored.length > shown.length) {
        blocks.push(
          `(${scored.length - shown.length} more matches: ${scored.slice(shown.length).map(({ item }) => `${item.server}/${item.tool.name}`).join(", ")})`,
        );
      }
      if (errors.length > 0) blocks.push(...errors);
      return { content: [{ type: "text", text: blocks.join("\n\n") }], isError: false };
    }

    // 3. Single small server: inline full schemas directly to save a round-trip.
    if (serverArg !== "" && loaded.length === 1 && loaded[0]!.error === null && loaded[0]!.tools.length <= AUTO_INLINE_SERVER_TOOL_LIMIT) {
      const { name, tools } = loaded[0]!;
      if (tools.length === 0) {
        return { content: [{ type: "text", text: `MCP server "${name}" exposes no enabled tools.` }], isError: false };
      }
      return {
        content: [{ type: "text", text: tools.map((tool) => formatSchemaEntry(name, tool)).join("\n\n") }],
        isError: false,
      };
    }

    // 4. Compact catalog grouped by server.
    const sections: string[] = [];
    for (const item of loaded) {
      if (item.error !== null) {
        sections.push(`## ${item.name}\nUnavailable: ${item.error}`);
        continue;
      }
      if (item.tools.length === 0) {
        sections.push(`## ${item.name} (0 tools)`);
        continue;
      }
      const lines = item.tools.map((tool) => {
        const summary = firstLine(tool.description);
        return summary ? `- ${tool.name}: ${summary}` : `- ${tool.name}`;
      });
      sections.push(`## ${item.name} (${item.tools.length} tools)\n${lines.join("\n")}`);
    }
    sections.push('Call search_tools with `tools: ["<name>", ...]` or `query: "<keywords>"` to inspect full parameter schemas before calling call_tool.');
    return { content: [{ type: "text", text: sections.join("\n\n") }], isError: false };
  }

  private async handleCallTool(args: Record<string, unknown>): Promise<{ content: Array<Record<string, unknown>>; isError: boolean }> {
    const serverName = typeof args["server"] === "string" ? args["server"].trim().toLowerCase() : "";
    const toolName = typeof args["tool"] === "string" ? args["tool"].trim() : "";
    const toolArgs = isRecord(args["arguments"]) ? args["arguments"] : {};

    if (serverName === "" || !this.entries.has(serverName)) {
      return {
        content: [{ type: "text", text: `Unknown MCP server "${serverName}". Configured servers: ${this.serverNames.join(", ")}.` }],
        isError: true,
      };
    }
    if (toolName === "") {
      return { content: [{ type: "text", text: "Parameter `tool` must be a non-empty string." }], isError: true };
    }
    if (this.disabled.has(`mcp__${serverName}__${toolName}`)) {
      return { content: [{ type: "text", text: `Tool "${toolName}" on MCP server "${serverName}" is disabled.` }], isError: true };
    }

    const entry = this.entries.get(serverName)!;
    let client: McpClient;
    try {
      client = await this.ensureConnected(entry);
    } catch (error) {
      return {
        content: [{ type: "text", text: `MCP server "${serverName}" is not available: ${error instanceof Error ? error.message : String(error)}.` }],
        isError: true,
      };
    }

    try {
      const result = await client.call(toolName, toolArgs, this.abort.signal);
      return { content: toMcpContent(result), isError: result.isError };
    } catch (error) {
      if (this.abort.signal.aborted) {
        return { content: [{ type: "text", text: "MCP call cancelled because the session closed." }], isError: true };
      }
      const why = error instanceof McpClosedError
        ? `stopped (${error.message}) while this call was running`
        : `failed (${error instanceof Error ? error.message : String(error)})`;
      return { content: [{ type: "text", text: `MCP server "${serverName}" ${why}.` }], isError: true };
    }
  }

  close(): Promise<void> {
    this.closingPromise ??= (async () => {
      this.closed = true;
      this.abort.abort(new Error("lazy MCP gateway closed"));
      const closeHttp = new Promise<void>((resolve) => this.server.close(() => resolve()));
      const closeClients = [...this.entries.values()].map(async (entry) => {
        const client = entry.client ?? (entry.connecting ? await entry.connecting.catch(() => null) : null);
        entry.client = null;
        if (client) await client.close().catch(() => undefined);
      });
      await Promise.allSettled([closeHttp, ...closeClients]);
    })();
    return this.closingPromise;
  }
}

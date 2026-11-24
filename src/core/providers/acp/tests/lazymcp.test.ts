import { describe, expect, it } from "vitest";

import type { McpServerSpec } from "../../../mcp.js";
import type { McpCallResult, McpClient, McpToolInfo } from "../../harness/mcpclient.js";
import { AcpLazyMcpGateway } from "../lazymcp.js";

function fakeClient(
  tools: readonly McpToolInfo[],
  onCall: (tool: string, args: Record<string, unknown>) => Promise<McpCallResult>,
): McpClient & { closed: boolean; kill: () => void } {
  let alive = true;
  let closed = false;
  return {
    get alive() {
      return alive;
    },
    get closed() {
      return closed;
    },
    kill() {
      alive = false;
    },
    tools,
    dropped: 0,
    async call(tool: string, args: Record<string, unknown>) {
      return onCall(tool, args);
    },
    async close() {
      alive = false;
      closed = true;
    },
  } as unknown as McpClient & { closed: boolean; kill: () => void };
}

describe("AcpLazyMcpGateway", () => {
  it("exposes all external MCP servers behind two compact tools, connects lazily, honors disabledTools, preserves images, and restarts crashed servers", async () => {
    const specs: McpServerSpec[] = [
      { name: "exa", type: "http", url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": "secret" } },
      { name: "linear", type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], env: {} },
    ];

    const linearTools: McpToolInfo[] = Array.from({ length: 15 }, (_, idx) => ({
      name: idx === 0 ? "get_issue" : idx === 1 ? "delete_issue" : `linear_tool_${idx}`,
      description: idx === 0 ? "Retrieve detailed information about an issue by ID." : `Tool number ${idx}.`,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      readOnly: idx !== 1,
    }));
    const exaTools: McpToolInfo[] = [
      {
        name: "web_search_exa",
        description: "Search the web using Exa.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        readOnly: true,
      },
    ];

    const connects: string[] = [];
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const clients = new Map<string, ReturnType<typeof fakeClient>>();

    const gateway = await AcpLazyMcpGateway.start({
      specs,
      cwd: process.cwd(),
      disabledTools: ["mcp__linear__delete_issue"],
      connect: async (spec) => {
        connects.push(spec.name);
        const tools = spec.name === "linear" ? linearTools : exaTools;
        const client = fakeClient(tools, async (tool, args) => {
          calls.push({ server: spec.name, tool, args });
          if (tool === "get_issue") {
            return {
              text: "MXN-77",
              isError: false,
              parts: [
                { text: "Issue MXN-77" },
                { text: "[image]", image: { name: "shot.png", mimeType: "image/png", data: "AAAA" } },
              ],
            };
          }
          return { text: `ok:${tool}`, isError: false };
        });
        clients.set(spec.name, client);
        return client;
      },
    });

    const post = (body: unknown, headers: Record<string, string> = gateway.spec.headers) =>
      fetch(gateway.spec.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    try {
      // Auth and transport checks.
      expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, {})).status).toBe(401);
      expect((await fetch(gateway.spec.url, { method: "GET", headers: gateway.spec.headers })).status).toBe(405);
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

      // Initialize + tools/list stay compact and do NOT eagerly spawn upstream servers.
      const initRes = (await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as {
        result: { instructions: string; serverInfo: { name: string } };
      };
      expect(initRes.result.serverInfo.name).toBe("moxen-mcp");
      expect(initRes.result.instructions).toContain("exa, linear");

      const listRes = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
        result: { tools: Array<{ name: string; description: string }> };
      };
      expect(listRes.result.tools.map((t) => t.name)).toEqual(["search_tools", "call_tool"]);
      expect(listRes.result.tools[0]!.description).toContain("exa, linear");
      expect(connects).toEqual([]);

      // Small server (<= 12 tools): search_tools({ server: "exa" }) connects ONLY exa and inlines schemas.
      const exaRes = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_tools", arguments: { server: "exa" } } })).json()) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      };
      expect(connects).toEqual(["exa"]);
      expect(exaRes.result.isError).toBe(false);
      expect(exaRes.result.content[0]!.text).toContain("### exa / web_search_exa");
      expect(exaRes.result.content[0]!.text).toContain('"query"');

      // Large server (> 12 tools): catalog omits disabledTools (`delete_issue`) and lists the rest compactly.
      const linCatalog = (await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_tools", arguments: { server: "linear" } } })).json()) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      };
      expect(connects).toEqual(["exa", "linear"]);
      expect(linCatalog.result.content[0]!.text).toContain("- get_issue:");
      expect(linCatalog.result.content[0]!.text).not.toContain("delete_issue");

      // Exact schema lookup returns full JSON Schema for `get_issue`.
      const schemaRes = (await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_tools", arguments: { server: "linear", tools: ["get_issue"] } } })).json()) as {
        result: { content: Array<{ text: string }> };
      };
      expect(schemaRes.result.content[0]!.text).toContain("### linear / get_issue");
      expect(schemaRes.result.content[0]!.text).toContain('"required":["id"]');

      // Disabled tool is refused on call_tool.
      const denied = (await (await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "call_tool", arguments: { server: "linear", tool: "delete_issue", arguments: { id: "1" } } } })).json()) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0]!.text).toContain("disabled");

      // call_tool preserves both text and image blocks.
      const called = (await (await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "call_tool", arguments: { server: "linear", tool: "get_issue", arguments: { id: "MXN-77" } } } })).json()) as {
        result: { isError: boolean; content: Array<Record<string, unknown>> };
      };
      expect(called.result.isError).toBe(false);
      expect(called.result.content).toEqual([
        { type: "text", text: "Issue MXN-77" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]);
      expect(calls).toEqual([{ server: "linear", tool: "get_issue", args: { id: "MXN-77" } }]);

      // If an upstream client dies, the next call reconnects it transparently.
      clients.get("exa")!.kill();
      const afterCrash = (await (await post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "call_tool", arguments: { server: "exa", tool: "web_search_exa", arguments: { query: "moxen" } } } })).json()) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(afterCrash.result.isError).toBe(false);
      expect(connects).toEqual(["exa", "linear", "exa"]);
    } finally {
      await gateway.close();
    }

    expect(clients.get("linear")?.closed).toBe(true);
    expect(clients.get("exa")?.closed).toBe(true);
  });
});

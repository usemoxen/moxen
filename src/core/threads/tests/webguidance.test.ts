import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { describeSettings } from "../../configschema.js";
import type { McpServerSpec } from "../../mcp.js";
import { buildWebGuidance } from "../webguidance.js";

const brave: McpServerSpec = { name: "brave-search", type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: {} };
const exa: McpServerSpec = { name: "exa", type: "http", url: "https://mcp.exa.ai/mcp", headers: {} };
const moxen: McpServerSpec = {
  name: "moxen",
  type: "in-process",
  tools: [],
  call: async () => ({ text: "", isError: false }),
  fallback: { name: "moxen", type: "stdio", command: "moxen", args: [], env: {} },
};

describe("web guidance", () => {
  it("says nothing about a tool the session does not have", () => {
    const text = buildWebGuidance({ provider: "claude", disabledNativeTools: "WebSearch,WebFetch", servers: [] });
    expect(text).toBe("");
    const onlyFetch = buildWebGuidance({ provider: "claude", disabledNativeTools: "WebSearch", servers: [] });
    expect(onlyFetch).toContain("WebFetch:");
    expect(onlyFetch).not.toContain("WebSearch:");
    expect(onlyFetch).not.toContain("brave_web_search");
  });

  it("names Brave and Exa by what they are, wherever they are attached", () => {
    const text = buildWebGuidance({ provider: "opencode", servers: [{ ...brave, name: "search" }, exa] });
    expect(text).toContain("brave_web_search:");
    expect(text).toContain("web_search_exa:");
    expect(text).toContain("web_fetch_exa:");
  });

  it("ranks the tools the session has in the user's order, and only those", () => {
    const servers = [brave, exa, moxen];
    expect(buildWebGuidance({ provider: "claude", servers })).not.toContain("prefer in this order");
    const text = buildWebGuidance({ provider: "claude", searchOrder: ["exa", "brave", "native"], fetchOrder: ["native", "moxen"], servers });
    expect(text).toContain("For web searches, prefer in this order: web_search_exa (Exa), then brave_web_search (Brave Search), then the built-in WebSearch.");
    // The unranked Exa fetch goes last; Moxen's, ranked second, follows the built-in.
    expect(text).toContain("For reading a page, prefer in this order: the built-in WebFetch, then web_fetch (moxen), then web_fetch_exa (Exa).");
    // A tool that is off drops out of the order, and an order of one tool is no choice at all.
    const noNative = buildWebGuidance({ provider: "claude", searchOrder: ["native", "brave"], disabledNativeTools: "WebSearch", servers: [brave] });
    expect(noNative).not.toContain("prefer in this order");
    // An order naming nothing the session has says nothing.
    expect(buildWebGuidance({ provider: "claude", searchOrder: ["exa"], servers: [brave] })).not.toContain("prefer in this order");
  });

  it("leaves out a Claude MCP tool the server entry switched off, which Claude can hide", () => {
    const text = buildWebGuidance({ provider: "claude", servers: [{ ...exa, disabledTools: ["web_fetch_exa"] }] });
    expect(text).toContain("web_search_exa:");
    expect(text).not.toContain("web_fetch_exa:");
  });

  it("says nothing about an OpenCode tool that is off: OpenCode takes it out of the model's list", () => {
    expect(buildWebGuidance({ provider: "opencode", disabledNativeTools: "webfetch, Shell,websearch", servers: [] })).toBe("");
  });

  it("exposes Mistral Vibe's built-in web_search/web_fetch in settings web-order and runtime guidance", () => {
    const views = describeSettings({
      ...DEFAULT_CONFIG,
      mcpServers: {
        "brave-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"] },
        exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
      },
    });
    const search = views.find((v) => v.descriptor.key === "providers.vibe.webSearchOrder");
    const fetch = views.find((v) => v.descriptor.key === "providers.vibe.webFetchOrder");
    expect(search?.order?.map((e) => ({ id: e.id, summary: e.summary, locked: e.locked }))).toEqual([
      { id: "brave", summary: "brave_web_search", locked: null },
      { id: "exa", summary: "web_search_exa", locked: null },
      { id: "native", summary: "web_search", locked: null },
    ]);
    expect(fetch?.order?.map((e) => ({ id: e.id, summary: e.summary, locked: e.locked }))).toEqual([
      { id: "moxen", summary: "web_fetch", locked: null },
      { id: "exa", summary: "web_fetch_exa", locked: null },
      { id: "native", summary: "web_fetch", locked: null },
    ]);

    const guidance = buildWebGuidance({
      provider: "vibe",
      searchOrder: ["brave", "native"],
      fetchOrder: ["moxen", "native"],
      servers: [brave, moxen],
    });
    expect(guidance).toContain("For web searches, prefer in this order: brave_web_search (Brave Search), then the built-in web_search.");
    expect(guidance).toContain("For reading a page, prefer in this order: web_fetch (moxen), then the built-in web_fetch.");
  });
});

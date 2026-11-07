import { describe, expect, it } from "vitest";

import { discoverModels, modelsUrl } from "../discover.js";
import { MCP_PRESETS, PROVIDER_PRESETS, freeName, mcpTarget } from "../presets.js";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("modelsUrl", () => {
  it("lands on /v1/models with or without /v1 and a trailing slash", () => {
    expect(modelsUrl("http://h:1")).toBe("http://h:1/v1/models");
    expect(modelsUrl("http://h:1/v1/")).toBe("http://h:1/v1/models");
    expect(modelsUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/models");
  });
});

describe("discoverModels", () => {
  it("lists models with the window a server reports, once each", async () => {
    const result = await discoverModels({
      baseUrl: "http://192.168.1.20:8000",
      apiFormat: "chat",
      fetch: async () => json({ data: [{ id: "a", max_model_len: 32768 }, { id: "b", meta: { n_ctx_train: 4096 } }, { id: "a" }, { id: "" }, { nope: 1 }] }),
    });
    expect(result).toEqual({ ok: true, host: "192.168.1.20:8000", models: [{ id: "a", contextWindow: 32768 }, { id: "b", contextWindow: 4096 }] });
  });

  it("sends the key from the named variable, as the format's own header, and never returns it", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchSpy = async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return json({ data: [{ id: "m" }] });
    };
    const env = { MY_KEY: "sk-secret" };
    const chat = await discoverModels({ baseUrl: "http://h", apiFormat: "chat", apiKeyEnv: "MY_KEY", env, fetch: fetchSpy });
    const anthropic = await discoverModels({ baseUrl: "http://h", apiFormat: "anthropic", apiKeyEnv: "MY_KEY", env, fetch: fetchSpy });
    expect(seen[0]?.authorization).toBe("Bearer sk-secret");
    expect(seen[1]?.["x-api-key"]).toBe("sk-secret");
    expect(JSON.stringify([chat, anthropic])).not.toContain("sk-secret");
  });

  it("explains each way it can fail", async () => {
    const down = await discoverModels({ baseUrl: "http://h:1", apiFormat: "chat", fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(down).toMatchObject({ ok: false, host: "h:1" });
    expect(down.ok === false && down.message).toContain("Could not reach h:1");
    const denied = await discoverModels({ baseUrl: "http://h", apiFormat: "chat", apiKeyEnv: "UNSET_KEY_X", env: {}, fetch: async () => json({}, 401) });
    expect(denied.ok === false && denied.message).toContain("UNSET_KEY_X");
    const missing = await discoverModels({ baseUrl: "http://h", apiFormat: "chat", fetch: async () => json({}, 404) });
    expect(missing.ok === false && missing.message).toContain("Type the model's name");
    const empty = await discoverModels({ baseUrl: "http://h", apiFormat: "chat", fetch: async () => json({ data: [] }) });
    expect(empty.ok === false && empty.message).toContain("lists no models");
    const bad = await discoverModels({ baseUrl: "not an address", apiFormat: "chat" });
    expect(bad.ok).toBe(false);
    const ftp = await discoverModels({ baseUrl: "ftp://h", apiFormat: "chat" });
    expect(ftp.ok === false && ftp.message).toContain("http");
  });
});

describe("presets", () => {
  it("have unique ids and only a variable name where a key is expected", () => {
    expect(new Set(PROVIDER_PRESETS.map((preset) => preset.id)).size).toBe(PROVIDER_PRESETS.length);
    expect(new Set(MCP_PRESETS.map((preset) => preset.id)).size).toBe(MCP_PRESETS.length);
    for (const preset of PROVIDER_PRESETS) if (preset.keyEnv !== null) expect(preset.keyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("starts an npm preset with the runner chosen, and leaves a non-npm one alone", () => {
    const brave = MCP_PRESETS.find((preset) => preset.id === "brave-search")!;
    expect(mcpTarget(brave)).toBe("npx -y @brave/brave-search-mcp-server");
    expect(mcpTarget(brave, "bunx")).toBe("bunx @brave/brave-search-mcp-server");
    expect(mcpTarget(brave, "pnpm")).toBe("pnpm dlx @brave/brave-search-mcp-server");
    expect(mcpTarget(brave, "yarn")).toBe("yarn dlx @brave/brave-search-mcp-server");
    expect(mcpTarget(MCP_PRESETS.find((preset) => preset.id === "exa")!, "bunx")).toBe("https://mcp.exa.ai/mcp");
  });

  it("names the variable a key goes in, never a value", () => {
    for (const preset of MCP_PRESETS) if (preset.secret?.env !== undefined) expect(preset.secret.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
    // Exa is the hosted server, which takes the key as a header: nothing to install.
    const exa = MCP_PRESETS.find((preset) => preset.id === "exa")!;
    expect(exa.target).toBe("https://mcp.exa.ai/mcp");
    expect(exa.secret?.header).toBe("x-api-key");
    expect(mcpTarget(exa, "bunx")).toBe("https://mcp.exa.ai/mcp");
  });

  it("picks a free name", () => {
    expect(freeName("ollama", new Set())).toBe("ollama");
    expect(freeName("ollama", new Set(["ollama", "ollama-2"]))).toBe("ollama-3");
  });
});

import { DEFAULT_CONFIG, setConfigValue } from "../core/config.js";
import { describeSettings } from "../core/configschema.js";
import type { CliConfig } from "../core/types.js";
import type { ClientApi } from "../server/api.js";
import { client as fixtureClient } from "./render-check/fixtures.js";

/**
 * The client behind `bun run tui:mock` (`mock.tsx`): the render-check
 * fixtures' threads, transcript and diffs, plus a catalog offering Claude
 * and OpenAI models alike and settings that live in memory, so the
 * interface — per-model backdrops included — can be tried without a login
 * for every provider. Every other command is accepted and dropped.
 */

/** The reasoning levels a model offers, in the catalog's own shape; none for a model with no such knob (Haiku, to show the empty case). */
const effortOf = (levels: readonly string[], fallback = "medium") =>
  levels.length === 0
    ? {}
    : {
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: levels.map((id) => ({ id, label: id, ...(id === fallback ? { isDefault: true } : {}) })),
            },
          ],
        },
      };

const model = (slug: string, name: string, isDefault = false, levels: readonly string[] = []) => ({
  slug,
  name,
  isCustom: false,
  ...(isDefault ? { isDefault } : {}),
  ...effortOf(levels),
});

const FULL = ["low", "medium", "high", "xhigh", "max"] as const;

const providers = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      // The fixture threads run on `claude-opus-5`; keep it so they label.
      model("claude-opus-5", "Claude Opus 5", true, FULL),
      model("claude-sonnet-5-5", "Claude Sonnet 5.5", false, ["low", "medium", "high"]),
      model("claude-haiku-5-5", "Claude Haiku 5.5"),
      model("claude-fable-5-1", "Claude Fable 5.1", false, FULL),
      model("claude-mythos-5-1", "Claude Mythos 5.1", false, FULL),
    ],
    skills: [],
  },
  {
    instanceId: "opencode/openai",
    driver: "opencode",
    displayName: "OpenAI",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    // Names as the catalog would show them; the slugs are stand-ins.
    models: [
      model("gpt-6.1-sol", "GPT-6.1 Sol", false, ["low", "medium", "high", "xhigh"]),
      model("gpt-6-astra", "GPT-6 Astra", false, ["low", "medium", "high", "xhigh"]),
      model("gpt-6-terra", "GPT-6 Terra", false, ["low", "medium", "high", "xhigh"]),
      model("gpt-6-luna", "GPT-6 Luna", false, ["low", "medium", "high", "xhigh"]),
    ],
    skills: [],
  },
  {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    enabled: true,
    installed: true,
    status: null,
    auth: { status: "Google AI Pro" },
    models: [
      model("gemini-4-neon", "Gemini 4 Neon", true, ["low", "medium", "high", "xhigh"]),
      model("gemini-4-argon", "Gemini 4 Argon", false, ["low", "medium", "high"]),
      model("gemini-4-hydrogen", "Gemini 4 Hydrogen", false, ["low", "medium", "high", "xhigh"]),
      model("gemini-4-carbon", "Gemini 4 Carbon", false, ["low", "medium", "high", "xhigh"]),
      model("claude-opus-5-5", "Claude Opus 5.5 (Antigravity)", false, ["low", "medium", "high"]),
      model("claude-sonnet-5-5", "Claude Sonnet 5.5 (Antigravity)", false, ["low", "medium", "high"]),
    ],
    skills: [],
  },
];

// A few MCP servers so each provider's "MCP servers" checklist has something to show (github is limited to Claude Code on its own entry).
let config: CliConfig = {
  ...DEFAULT_CONFIG,
  mcpServers: {
    filesystem: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], providers: ["claude"] },
    docs: { type: "http", url: "https://example.com/mcp" },
  },
};
const settingsSnapshot = () => ({ path: "(mock — in memory)", exists: false, settings: describeSettings(config) });

export const mockClient: ClientApi = {
  ...fixtureClient,
  async getConfig() {
    return { settings: {}, providers } as unknown as Awaited<ReturnType<ClientApi["getConfig"]>>;
  },
  query: (async (query: { type: string }) => {
    if (query.type === "settings.read") return settingsSnapshot();
    if (query.type === "providers.list") return { providers };
    return await (fixtureClient.query as (q: unknown) => Promise<unknown>)(query);
  }) as unknown as ClientApi["query"],
  dispatch: (async (command: { type: string; key?: string; value?: string }) => {
    if (command.type === "settings.set" && command.key !== undefined && command.value !== undefined) {
      config = setConfigValue(config, command.key as Parameters<typeof setConfigValue>[1], command.value);
      return { ...settingsSnapshot(), accepted: true };
    }
    if (command.type === "harness.models.discover") {
      // Stand-ins for a server: any address with "down" in it is not running, "9999" is up but wants a key.
      const url = String((command as unknown as { baseUrl: string }).baseUrl);
      if (url.includes("down")) return { ok: false, host: url, message: `Could not reach ${url}. Is the server running, and is that the right address?` };
      if (url.includes("9999")) return { ok: false, host: url, message: `${url} wants a key (HTTP 401).` };
      return {
        ok: true,
        host: url.replace(/^https?:\/\//, ""),
        models: [
          { id: "qwen3-coder:30b", contextWindow: 262_144 },
          { id: "llama3.1:8b", contextWindow: 131_072 },
          { id: "gemma3:27b", contextWindow: 131_072 },
          { id: "deepseek-r1:14b" },
        ],
      };
    }
    return { accepted: true };
  }) as unknown as ClientApi["dispatch"],
};

/**
 * What "add a provider" and "add an MCP server" start from: well-known server
 * types with their usual address and wire format, so the user is asked only
 * for what Moxen cannot know. Only shapes live here; a preset's values still
 * go through `normalizeConfig` like any typed ones. The address is a starting
 * point: the server is often on another machine, so it is always editable.
 */
import type { HarnessApiFormat } from "../../types.js";

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  /** What the list shows beside the name. */
  readonly hint: string;
  readonly apiFormat: HarnessApiFormat;
  /** The usual address; empty when there is none to suggest. */
  readonly baseUrl: string;
  /** The environment variable such servers usually take their key from; null for a keyless local server. */
  readonly keyEnv: string | null;
  /** The id the new profile starts with. */
  readonly profileId: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "ollama", label: "Ollama", hint: "localhost:11434", apiFormat: "chat", baseUrl: "http://localhost:11434", keyEnv: null, profileId: "ollama" },
  { id: "lmstudio", label: "LM Studio", hint: "localhost:1234", apiFormat: "chat", baseUrl: "http://localhost:1234", keyEnv: null, profileId: "lmstudio" },
  { id: "llamacpp", label: "llama.cpp server", hint: "localhost:8080", apiFormat: "chat", baseUrl: "http://localhost:8080", keyEnv: null, profileId: "llamacpp" },
  { id: "vllm", label: "vLLM", hint: "localhost:8000", apiFormat: "chat", baseUrl: "http://localhost:8000", keyEnv: null, profileId: "vllm" },
  { id: "openai", label: "OpenAI-compatible, hosted", hint: "address + key", apiFormat: "chat", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", profileId: "openai" },
  { id: "anthropic", label: "Anthropic-compatible", hint: "address + key", apiFormat: "anthropic", baseUrl: "", keyEnv: "ANTHROPIC_API_KEY", profileId: "anthropic" },
  { id: "other", label: "Other server", hint: "enter its address", apiFormat: "chat", baseUrl: "", keyEnv: null, profileId: "server" },
];

export interface McpPreset {
  readonly id: string;
  readonly label: string;
  /** What the server does, in a few words. */
  readonly hint: string;
  /** The program to start (with its arguments), or an http(s) address. For a preset that is not an npm package. */
  readonly target?: string;
  /** An npm package (with its arguments): the command is built from the runner the user chose (`mcpTarget`). */
  readonly npm?: string;
  /** The name the server is saved under. */
  readonly name: string;
  /** What it needs before it works, when something other than a key. Never a value. */
  readonly needs?: string;
  /** A key it takes, in its environment (`env`) or as an HTTP header (`header`): asked for while adding it and kept in the keychain. */
  readonly secret?: { readonly env?: string; readonly header?: string; readonly label: string };
}

export const MCP_PRESETS: readonly McpPreset[] = [
  { id: "brave-search", label: "Brave Search", hint: "web, image and news search", name: "brave-search", npm: "@brave/brave-search-mcp-server", secret: { env: "BRAVE_API_KEY", label: "Brave Search API key" } },
  { id: "exa", label: "Exa Search", hint: "web search and page contents", name: "exa", target: "https://mcp.exa.ai/mcp", secret: { header: "x-api-key", label: "Exa API key" } },
  { id: "playwright", label: "Playwright", hint: "drive a browser", name: "playwright", npm: "@playwright/mcp@latest" },
];

export type McpRunner = "npx" | "bunx" | "pnpm" | "yarn";

/** The command line that starts a preset: its own target, or its npm package under the runner the user chose. */
export function mcpTarget(preset: McpPreset, runner: McpRunner = "npx"): string {
  if (preset.npm === undefined) return preset.target ?? "";
  const prefix = runner === "bunx" ? "bunx" : runner === "pnpm" ? "pnpm dlx" : runner === "yarn" ? "yarn dlx" : "npx -y";
  return `${prefix} ${preset.npm}`;
}

/** `base`, or `base-2`, `base-3`… so it does not clash with an id already taken. */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

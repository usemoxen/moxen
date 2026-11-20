import type { DiscoveredModel } from "../../core/types.js";
import type { ProviderPreset } from "../../core/providers/harness/presets.js";

/**
 * The pure parts of the guided "add" flows (a Harness provider, an MCP
 * server), so what gets saved is tested without a terminal. The documents
 * built here are the JSON the list editor hands to `settings.set`; the
 * server still validates them like any typed value.
 */

/** The profile a finished provider flow saves. Only the key's variable NAME is ever stored here. */
export function profileDocument(preset: ProviderPreset, input: { readonly baseUrl: string; readonly keyEnv: string; readonly models: readonly DiscoveredModel[] }): string {
  return JSON.stringify({
    apiFormat: preset.apiFormat,
    baseUrl: input.baseUrl.trim(),
    ...(input.keyEnv.trim() === "" ? {} : { apiKeyEnv: input.keyEnv.trim() }),
    models: input.models.map((model) => (model.contextWindow === undefined ? { id: model.id } : { id: model.id, contextWindow: model.contextWindow })),
  });
}

/** An MCP server from one line: an http(s) address, or a command with its arguments. */
export function mcpDocument(target: string, secret?: { readonly env?: Readonly<Record<string, string>>; readonly headers?: Readonly<Record<string, string>> }): string {
  const text = target.trim();
  const headers = secret?.headers;
  const env = secret?.env;
  if (/^https?:\/\//i.test(text)) return JSON.stringify({ type: "http", url: text, ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}) });
  const [command = "", ...args] = text.split(/\s+/);
  return JSON.stringify({ type: "stdio", command, ...(args.length > 0 ? { args } : {}), ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}) });
}

/** An ACP agent profile from a command line (binary plus arguments), optional display name and environment. */
export function acpAgentDocument(
  commandLine: string,
  extra?: { readonly name?: string; readonly env?: Readonly<Record<string, string>> },
): string {
  const [command = "", ...args] = commandLine.trim().split(/\s+/);
  const name = extra?.name?.trim();
  const env = extra?.env;
  return JSON.stringify({
    ...(name ? { name } : {}),
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
    enabled: true,
  });
}

/** The entries whose label or id contains every word of `query`; all of them for an empty one. */
export function filterEntries<T extends { readonly id: string; readonly label?: string }>(entries: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = `${entry.id} ${entry.label ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** A size such as `262144` as `262k` for the list's right-hand column. */
export function tokensShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  return `${Math.round(tokens / 1024)}k`;
}

/**
 * Which attached MCP servers are the search servers Moxen knows how to guide.
 *
 * Only the ones Moxen's own list adds (`MCP_PRESETS`: Brave Search's npm
 * package, Exa's hosted endpoint) count, recognised by what they run or
 * reach, not by the name they were saved under. Another search server is
 * welcome to be attached, but its tools and their parameters are unknown to
 * us, so there is nothing to say about it and the web-tool preference does not
 * cover it.
 */
import { moxenToolsOf, type McpServerEntry } from "./mcp.js";
import { disabledNativeToolNames as parseNameList } from "./nativetools.js";
import { MCP_PRESETS } from "./providers/harness/presets.js";
import type { CliConfig } from "./types.js";

export type WebServerKind = "brave" | "exa";

const preset = (id: string) => MCP_PRESETS.find((candidate) => candidate.id === id);

/** What identifies each server inside a command line or an address. */
const MARKERS: Readonly<Record<WebServerKind, string>> = {
  brave: (preset("brave-search")?.npm ?? "@brave/brave-search-mcp-server").toLowerCase(),
  exa: new URL(preset("exa")?.target ?? "https://mcp.exa.ai/mcp").host.toLowerCase(),
};

/** The kind of server this command or address starts, or null. */
export function webServerKind(target: readonly string[]): WebServerKind | null {
  const lowered = target.map((part) => part.toLowerCase());
  for (const kind of Object.keys(MARKERS) as WebServerKind[]) {
    if (lowered.some((part) => part.includes(MARKERS[kind]))) return kind;
  }
  return null;
}

/**
 * The search servers a provider would get from the global config: not switched
 * off, not limited to other providers, not excluded on the provider's own page.
 * (A project's `moxen.json` can add more; the settings page does not see it.)
 */
export function attachedSearchServers(config: CliConfig, provider: "claude" | "codex" | "opencode"): Array<{ readonly name: string; readonly kind: WebServerKind }> {
  const excluded = new Set(parseNameList(config.providers?.[provider]?.mcpExclude));
  const found: Array<{ name: string; kind: WebServerKind }> = [];
  for (const [name, entry] of Object.entries(config.mcpServers ?? {}) as Array<[string, McpServerEntry]>) {
    if (entry.disabled === true || excluded.has(name)) continue;
    if (entry.providers !== undefined && entry.providers.length > 0 && !entry.providers.includes(provider)) continue;
    const kind = webServerKind(entry.type === "http" ? [entry.url] : [entry.command, ...(entry.args ?? [])]);
    if (kind !== null) found.push({ name, kind });
  }
  return found;
}

export type WebRole = "search" | "fetch";

/** One tool a web order can rank, as the picker draws it. */
export interface WebOrderEntry {
  /** What the setting stores: `brave`, `exa`, `moxen`, `native`. */
  readonly id: string;
  readonly label: string;
  /** The tool the model sees. */
  readonly summary: string;
  /** Why it cannot be used for this provider right now, or null. */
  readonly locked: string | null;
}

const NATIVE_NAMES: Readonly<Record<"claude" | "codex" | "opencode", Readonly<Record<WebRole, string>>>> = {
  codex: { search: "web_search", fetch: "web_search" },
  claude: { search: "WebSearch", fetch: "WebFetch" },
  opencode: { search: "websearch", fetch: "webfetch" },
};

/** The tools a provider's search or fetch order can rank, with the ones it cannot use marked. */
export function webOrderEntries(config: CliConfig, provider: "claude" | "codex" | "opencode", role: WebRole): WebOrderEntry[] {
  const attached = new Set(attachedSearchServers(config, provider).map((server) => server.kind));
  const own = config.providers?.[provider];
  const nativeName = NATIVE_NAMES[provider][role];
  const nativeOff = parseNameList(own?.disabledNativeTools).some((name) => (provider === "claude" ? name === nativeName : name.toLowerCase() === nativeName));
  const added = (kind: WebServerKind, label: string): string | null => (attached.has(kind) ? null : `${label} is not added, or is off for this provider`);
  const native: WebOrderEntry = {
    id: "native",
    label: `${provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : "OpenCode"}'s own`,
    summary: nativeName,
    locked: nativeOff ? "switched off under Built-in tools off" : null,
  };
  if (role === "search") {
    return [
      { id: "brave", label: "Brave Search", summary: "brave_web_search", locked: added("brave", "Brave Search") },
      { id: "exa", label: "Exa", summary: "web_search_exa", locked: added("exa", "Exa") },
      native,
    ];
  }
  return [
    { id: "moxen", label: "Moxen's web_fetch", summary: "web_fetch", locked: moxenToolsOf(own).webFetch ? null : "Moxen's web_fetch is off for this provider" },
    { id: "exa", label: "Exa", summary: "web_fetch_exa", locked: added("exa", "Exa") },
    native,
  ];
}

/** Why a provider's order for this role can do nothing yet, or undefined when it can. */
export function webOrderUnavailable(config: CliConfig, provider: "claude" | "codex" | "opencode", role: WebRole): string | undefined {
  const entries = webOrderEntries(config, provider, role).filter((entry) => entry.id !== "native");
  if (role === "search") {
    return entries.some((entry) => entry.locked === null)
      ? undefined
      : "Needs the Brave Search or Exa server from Moxen's own list (MCP servers → Add), switched on for this provider. Other search servers are not covered.";
  }
  return entries.some((entry) => entry.locked === null) ? undefined : "Needs Moxen's web_fetch on for this provider, or the Exa server from Moxen's own list.";
}

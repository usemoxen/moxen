/**
 * What a session is told about the web tools it has: which to prefer, and how
 * each one is used well. Part of the runtime instructions
 * (`instructions.ts`).
 *
 * Providers ship their own search and fetch, and a user may attach Brave or
 * Exa (or use Moxen's `web_fetch`) instead. Only the servers Moxen's own list
 * adds are recognised (`webservers.ts`). With two similar tools in front
 * of it a model reaches for the one it was trained on, and each tool has its
 * own ways to go stale or come back thin: Claude's WebSearch wants
 * `mode: "extended"` for anything recent, Exa's fetch may answer from a cache,
 * Brave filters by `freshness`. Only the tools the session really has are
 * mentioned: a line about a tool that is switched off or not attached is
 * worse than none.
 *
 * The tips name parameters as the tools list them today and are worded to be
 * harmless if one is gone ("when it has a mode option"). A tool's schema is
 * not read at session start, so there is nothing to check them against.
 */
import { APP_NAME } from "../config.js";
import type { McpServerSpec } from "../mcp.js";
import { webServerKind } from "../webservers.js";
import { isNativeToolDisabled, type NativeToolProvider } from "../nativetools.js";

export interface WebGuidanceInput {
  readonly provider: NativeToolProvider;
  /** The provider's `disabledNativeTools` setting. */
  readonly disabledNativeTools?: string | undefined;
  /** The order the user prefers search tools in, by id (`brave`, `exa`, `native`); empty or absent: no preference. */
  readonly searchOrder?: readonly string[] | undefined;
  /** The same for fetch tools (`moxen`, `exa`, `native`). */
  readonly fetchOrder?: readonly string[] | undefined;
  /** The servers this session gets, after routing. */
  readonly servers: readonly McpServerSpec[];
}

interface WebTool {
  /** What the order setting calls it: the server (`brave`, `exa`, `moxen`). */
  readonly id: string;
  /** What the model calls it, with the server it comes from. */
  readonly label: string;
  readonly kind: "search" | "fetch";
  readonly tip: string;
}

const BRAVE_SEARCH: WebTool = {
  id: "brave",
  label: "brave_web_search (Brave Search)",
  kind: "search",
  tip: 'brave_web_search: set freshness (pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD) for anything recent, and result_filter ["news"] for news.',
};
const EXA_SEARCH: WebTool = {
  id: "exa",
  label: "web_search_exa (Exa)",
  kind: "search",
  tip: "web_search_exa: describe the ideal page rather than keywords, and use objective to say which pages should rank first and what to pull from them.",
};
const EXA_FETCH: WebTool = {
  id: "exa",
  label: "web_fetch_exa (Exa)",
  kind: "fetch",
  tip: "web_fetch_exa: gives 3000 characters a page unless you raise maxCharacters, and may answer from a cached copy; when a page has to be current, check it another way.",
};
const MOXEN_FETCH: WebTool = {
  id: "moxen",
  label: `web_fetch (${APP_NAME})`,
  kind: "fetch",
  tip: `web_fetch (${APP_NAME}): returns the page as text; set render to true for a page built by scripts. It cannot sign in, so use the command line (gh for GitHub) for those.`,
};

/** The web tools one attached server offers: Moxen's own fetch, and the Brave and Exa servers from Moxen's list. */
function webToolsOf(server: McpServerSpec): WebTool[] {
  if (server.name === APP_NAME && server.type === "in-process") return [MOXEN_FETCH];
  const kind = server.type === "http" ? webServerKind([server.url]) : server.type === "stdio" ? webServerKind([server.command, ...server.args]) : null;
  return kind === "brave" ? [BRAVE_SEARCH] : kind === "exa" ? [EXA_SEARCH, EXA_FETCH] : [];
}

const toolName = (label: string): string => label.split(" ")[0]!;

/** The part of the instructions about web tools; empty when there is nothing to say. */
export function buildWebGuidance(input: WebGuidanceInput): string {
  const claude = input.provider === "claude";
  const nativeSearch = claude ? "WebSearch" : "websearch";
  const nativeFetch = claude ? "WebFetch" : "webfetch";
  const searchOn = !isNativeToolDisabled(input.disabledNativeTools, nativeSearch, input.provider);
  const fetchOn = !isNativeToolDisabled(input.disabledNativeTools, nativeFetch, input.provider);

  // Claude hides a single MCP tool; OpenCode cannot, so there a "disabled" tool is still the model's to see.
  const attached = input.servers.flatMap((server) =>
    webToolsOf(server).filter((tool) => !(claude && (server.disabledTools ?? []).includes(toolName(tool.label)))),
  );
  const mcpSearch = attached.filter((tool) => tool.kind === "search");
  const mcpFetch = attached.filter((tool) => tool.kind === "fetch");
  const lines: string[] = [];

  // The user's order, over what the session really has: a tool that is off or not attached drops out of it.
  const native = (name: string, kind: WebTool["kind"]): WebTool => ({ id: "native", label: `the built-in ${name}`, kind, tip: "" });
  const searchLine = orderLine("web searches", [...mcpSearch, ...(searchOn ? [native(nativeSearch, "search")] : [])], input.searchOrder);
  const fetchLine = orderLine("reading a page", [...mcpFetch, ...(fetchOn ? [native(nativeFetch, "fetch")] : [])], input.fetchOrder);
  lines.push(...[searchLine, fetchLine].filter((line): line is string => line !== null));

  const tips: string[] = [];
  if (searchOn && claude) tips.push('WebSearch: when it has a mode option, use "extended" for anything recent or time-sensitive ("standard" can return older results); allowed_domains and blocked_domains cannot be combined.');
  if (searchOn && !claude) tips.push("websearch: it returns titles, URLs and snippets, not page text; read the page before relying on what a snippet cut off.");
  if (fetchOn && claude) tips.push('WebFetch: the prompt decides what comes back, so an answer that a page does not mention something may only mean the prompt did not ask; responses are cached for 15 minutes, and offset reads on through a long page.');
  if (fetchOn && !claude) tips.push("webfetch: returns text (markdown by default); it cannot read images or other binary files.");
  for (const tool of [...mcpSearch, ...mcpFetch]) tips.push(tool.tip);
  if (tips.length > 0) lines.push(`Using the web tools well:\n${tips.map((tip) => `- ${tip}`).join("\n")}`);

  return lines.join("\n");
}

/**
 * "For web searches, prefer in this order: A, then B, then the built-in X": the
 * tools the session has, ranked by the user's order, the unranked ones last.
 * Null when there is no order, or fewer than two tools to choose between.
 */
function orderLine(what: string, available: readonly WebTool[], order: readonly string[] | undefined): string | null {
  if (!order || order.length === 0 || available.length < 2) return null;
  const rank = (tool: WebTool): number => {
    const at = order.indexOf(tool.id);
    return at === -1 ? order.length : at;
  };
  const ranked = [...available].sort((left, right) => rank(left) - rank(right));
  if (!ranked.some((tool) => order.includes(tool.id))) return null;
  return `For ${what}, prefer in this order: ${ranked.map((tool) => tool.label).join(", then ")}. Go on to the next only if one fails or finds nothing useful.`;
}

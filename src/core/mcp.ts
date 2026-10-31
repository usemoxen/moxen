/**
 * MCP servers moxen injects into every provider session: one declaration,
 * translated by each driver into its provider's native form (Claude SDK
 * `mcpServers`, OpenCode `mcp.add`).
 *
 * Declared under `mcpServers` in the global config and in a project's
 * `moxen.json`, in the shape `.mcp.json` uses:
 *
 *   "mcpServers": {
 *     "fs":   { "command": "npx", "args": ["-y", "some-mcp"], "env": { "K": "v" } },
 *     "docs": { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "…" } }
 *   }
 *
 * A project entry replaces the global one of the same name; `null` removes
 * it for that project. `env` and `headers` may hold secrets: they go to the
 * provider and nowhere else (`redactMcpServers` is what gets displayed).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { APP_NAME } from "./config.js";
import { CliError } from "./errors.js";
import { isSecretRef, readSecret, refName } from "./secrets.js";

/** Which providers a server is offered to, and what of it is switched off. All optional: the default is every provider, every tool. */
export interface McpRouting {
  /** Provider kinds that get this server; absent or empty means all of them. */
  readonly providers?: readonly McpProviderKind[];
  /** Tool names (as the server lists them) that are switched off. Honoured by Claude Code and the Moxen Harness; OpenCode cannot hide single tools. */
  readonly disabledTools?: readonly string[];
  /** Off without being deleted. */
  readonly disabled?: boolean;
}

export type McpProviderKind = "claude" | "codex" | "opencode" | "harness";
const PROVIDER_KINDS: readonly McpProviderKind[] = ["claude", "codex", "opencode", "harness"];

export type McpServerEntry = McpRouting &
  (
    | {
        readonly type?: "stdio";
        readonly command: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
      }
    | {
        readonly type: "http";
        readonly url: string;
        readonly headers?: Readonly<Record<string, string>>;
      }
  );

/** A server a provider reaches out of process: a command it spawns, or a URL. */
export type OutOfProcessMcpServerSpec = McpRouting &
  (
  | {
      readonly name: string;
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      /** Keep its tools' schemas in the prompt from the start, never deferred behind tool search. */
      readonly alwaysLoad?: boolean;
    }
  | {
      readonly name: string;
      readonly type: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly alwaysLoad?: boolean;
    }
  );

/** One tool of an in-process server, described the way MCP lists it. */
export interface InProcessMcpTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments (an object schema). */
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

/**
 * A server whose tools run inside this process — moxen's own tools, served
 * by the process that owns the provider sessions. A provider that can host
 * tools in-process (Claude, through the Agent SDK) calls `call` directly;
 * any other reaches the same tools through `fallback`.
 */
export interface InProcessMcpServerSpec extends McpRouting {
  readonly name: string;
  readonly type: "in-process";
  readonly instructions?: string;
  readonly tools: readonly InProcessMcpTool[];
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<{ readonly text: string; readonly isError: boolean }>;
  readonly fallback: OutOfProcessMcpServerSpec;
  /**
   * `fallback` also offering a checklist tool, for a provider that keeps no
   * checklist of its own (OpenCode v2 has no `todowrite`). Absent when the
   * server has none to offer.
   */
  readonly checklist?: OutOfProcessMcpServerSpec;
  readonly alwaysLoad?: boolean;
}

/** One resolved server, as drivers receive it. */
export type McpServerSpec = OutOfProcessMcpServerSpec | InProcessMcpServerSpec;

/**
 * What makes a set of servers the same set, for deciding whether a live
 * session needs telling. An in-process server (moxen's own tools) is rebuilt
 * on every send, with fresh closures and a fallback that changes once the
 * loopback server is up; none of that is a change for a session already
 * hosting it, so it counts by name, tools and flags only. Order is not one.
 */
export function mcpSignature(servers: readonly McpServerSpec[]): string {
  return JSON.stringify(
    [...servers]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((server) =>
        server.type === "in-process"
          ? { name: server.name, type: server.type, alwaysLoad: server.alwaysLoad === true, instructions: server.instructions ?? null, tools: server.tools.map((tool) => tool.name) }
          : server,
      ),
  );
}

/** The out-of-process form of a server, for a provider that cannot host one in-process. */
export function outOfProcess(spec: McpServerSpec): OutOfProcessMcpServerSpec {
  return spec.type === "in-process" ? spec.fallback : spec;
}

/** `outOfProcess` for a provider with no checklist of its own: the form that lends one, where there is one. */
export function outOfProcessWithChecklist(spec: McpServerSpec): OutOfProcessMcpServerSpec {
  return spec.type === "in-process" ? (spec.checklist ?? spec.fallback) : spec;
}

/**
 * Names become tool prefixes (`mcp__<name>__tool`) and OpenCode config keys,
 * so a dot or space would break one or the other.
 */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(source: string, message: string): CliError {
  return new CliError("INVALID_CONFIG", `${source}: ${message}`);
}

function stringRecord(value: unknown, source: string, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(source, `${field} must be an object of strings.`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw invalid(source, `${field}.${key} must be a string.`);
    out[key] = item;
  }
  return out;
}

function parseRouting(input: Record<string, unknown>, where: string): McpRouting {
  const routing: { providers?: McpProviderKind[]; disabledTools?: string[]; disabled?: boolean } = {};
  if (input.providers !== undefined) {
    if (!Array.isArray(input.providers) || input.providers.some((kind) => !PROVIDER_KINDS.includes(kind as McpProviderKind))) {
      throw invalid(where, `providers must be a list of ${PROVIDER_KINDS.join(", ")}.`);
    }
    if (input.providers.length > 0) routing.providers = [...new Set(input.providers as McpProviderKind[])];
  }
  if (input.disabledTools !== undefined) {
    if (!Array.isArray(input.disabledTools) || input.disabledTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
      throw invalid(where, "disabledTools must be a list of tool names.");
    }
    if (input.disabledTools.length > 0) routing.disabledTools = [...new Set((input.disabledTools as string[]).map((tool) => tool.trim()))];
  }
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== "boolean") throw invalid(where, "disabled must be true or false.");
    if (input.disabled) routing.disabled = true;
  }
  return routing;
}

function parseEntry(name: string, raw: unknown, source: string): McpServerEntry {
  const where = `${source} mcpServers.${name}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid(where, "must be an object.");
  const input = raw as Record<string, unknown>;
  const routing = parseRouting(input, where);
  const type = input.type ?? (typeof input.url === "string" && input.command === undefined ? "http" : "stdio");
  if (type === "http") {
    if (typeof input.url !== "string" || !/^https?:\/\//.test(input.url)) {
      throw invalid(where, "url must be an http(s) URL.");
    }
    const headers = stringRecord(input.headers, where, "headers");
    return { type: "http", url: input.url, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...routing };
  }
  if (type !== "stdio") throw invalid(where, "type must be stdio or http.");
  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    throw invalid(where, "command must be a non-empty string.");
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string"))) {
    throw invalid(where, "args must be an array of strings.");
  }
  const env = stringRecord(input.env, where, "env");
  return {
    command: input.command,
    ...(input.args !== undefined ? { args: input.args as string[] } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...routing,
  };
}

/**
 * Validate an `mcpServers` object. `null` values survive (they remove a
 * global server for one project); the global config refuses them.
 */
export function parseMcpServers(
  raw: unknown,
  source: string,
  options: { readonly allowRemoval?: boolean } = {},
): Record<string, McpServerEntry | null> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(source, "mcpServers must be an object keyed by server name.");
  }
  const out: Record<string, McpServerEntry | null> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name)) throw invalid(source, `mcpServers name "${name}" may use only letters, digits, - and _.`);
    if (entry === null) {
      if (!options.allowRemoval) throw invalid(source, `mcpServers.${name} must be an object.`);
      out[name] = null;
      continue;
    }
    out[name] = parseEntry(name, entry, source);
  }
  return out;
}

function toSpec(name: string, entry: McpServerEntry): McpServerSpec {
  const routing: McpRouting = {
    ...(entry.providers ? { providers: entry.providers } : {}),
    ...(entry.disabledTools ? { disabledTools: entry.disabledTools } : {}),
    ...(entry.disabled ? { disabled: true } : {}),
  };
  if (entry.type === "http") return { name, type: "http", url: entry.url, headers: { ...entry.headers }, ...routing };
  return { name, type: "stdio", command: entry.command, args: [...(entry.args ?? [])], env: { ...entry.env }, ...routing };
}

/** Names as kept in a setting: comma-separated, blanks and repeats dropped. */
/**
 * Which of Moxen's own tools a provider's threads get: the delegation tools
 * and `web_fetch` are switched apart, each falling back to the older
 * all-or-nothing `moxenTools` (so `moxenTools: false` still turns both off).
 */
export function moxenToolsOf(config: { readonly moxenTools?: boolean; readonly orchestration?: boolean; readonly webFetch?: boolean } | undefined): { readonly orchestration: boolean; readonly webFetch: boolean } {
  const legacy = config?.moxenTools !== false;
  return { orchestration: config?.orchestration ?? legacy, webFetch: config?.webFetch ?? legacy };
}

export function parseNameList(text: string | undefined): string[] {
  return [...new Set((text ?? "").split(",").map((name) => name.trim()).filter((name) => name !== ""))];
}

/**
 * The servers one provider gets, with routing applied: servers that are off or
 * not offered to this provider drop out, and the tools switched off come back
 * as full names (`mcp__<server>__<tool>`) for the driver to hide.
 */
export function routeMcpServers(
  servers: readonly McpServerSpec[],
  provider: McpProviderKind,
  /** The provider's own `mcpExclude`: names of servers it does not get. */
  exclude?: string,
): { readonly servers: McpServerSpec[]; readonly disabledTools: string[] } {
  const kept: McpServerSpec[] = [];
  const disabledTools: string[] = [];
  const excluded = new Set(parseNameList(exclude));
  for (const server of servers) {
    if (server.disabled === true || excluded.has(server.name)) continue;
    if (server.providers !== undefined && server.providers.length > 0 && !server.providers.includes(provider)) continue;
    kept.push(server);
    for (const tool of server.disabledTools ?? []) disabledTools.push(`mcp__${server.name}__${tool}`);
  }
  return { servers: kept, disabledTools };
}

/** `mcpServers` from `<workspaceRoot>/moxen.json`, or none. */
async function projectMcpServers(workspaceRoot: string): Promise<Record<string, McpServerEntry | null>> {
  const file = path.join(workspaceRoot, `${APP_NAME}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Missing or unreadable: the project declares nothing. (Env-mode
    // resolution reads the same file just as leniently.)
    return {};
  }
  const servers = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).mcpServers : undefined;
  if (servers === undefined) return {};
  return parseMcpServers(servers, file, { allowRemoval: true });
}

/**
 * The servers a session in `workspaceRoot` gets: the global ones, with the
 * project's `moxen.json` layered over them by name. Sorted by name, so a
 * provider sees the same order every start.
 */
export async function resolveMcpServers(
  global: Readonly<Record<string, McpServerEntry>> | undefined,
  workspaceRoot: string | null,
): Promise<McpServerSpec[]> {
  const merged: Record<string, McpServerEntry | null> = { ...global };
  if (workspaceRoot) Object.assign(merged, await projectMcpServers(workspaceRoot));
  const specs = Object.entries(merged)
    .flatMap(([name, entry]) => (entry ? [toSpec(name, entry)] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(specs.map(withSecrets));
}

/** A value kept in the keychain (`keychain:<name>`) is read now; one that cannot be read is left out, so the server fails to sign in rather than being handed the reference. */
async function secretValues(record: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isSecretRef(value)) out[key] = value;
    else {
      const secret = await readSecret(refName(value));
      if (secret !== null) out[key] = secret;
    }
  }
  return out;
}

async function withSecrets(spec: McpServerSpec): Promise<McpServerSpec> {
  if (spec.type === "http") return { ...spec, headers: await secretValues(spec.headers) };
  if (spec.type === "stdio") return { ...spec, env: await secretValues(spec.env) };
  return spec;
}

/** For display: `env` and `headers` values replaced, keys kept. */
export function redactMcpServers(
  servers: Readonly<Record<string, McpServerEntry>>,
): Record<string, McpServerEntry> {
  const hide = (record: Readonly<Record<string, string>> | undefined) =>
    record ? Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"])) : undefined;
  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => {
      if (entry.type === "http") {
        const headers = hide(entry.headers);
        return [name, { ...entry, ...(headers ? { headers } : {}) }];
      }
      const env = hide(entry.env);
      return [name, { ...entry, ...(env ? { env } : {}) }];
    }),
  );
}

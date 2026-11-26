/**
 * Mistral Vibe `vibe-app-server` JSON-RPC 2.0 wire contract, JSON-Patch
 * applicator, and defensive payload readers.
 *
 * Verified against `mistral-vibe` v3.1.4 (`vibe/app_server/protocol.py`,
 * `vibe/app_server/models.py`, `vibe/app_server/_effect_models.py`, and live
 * `vibe-app-server` probes). Every payload is read defensively to tolerate
 * additive fields across Vibe updates.
 */
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";

import type { ModelSummary } from "../../catalog/summary.js";
import { outOfProcess, type McpServerSpec } from "../../mcp.js";
import type { ContextBreakdown, ProviderImage } from "../spi.js";
import type { RuntimeMode } from "../../types.js";

export const VIBE_METHODS = {
  // Lifecycle & passive host queries
  initialize: "initialize",
  initialized: "initialized",
  setupStatus: "setup/status",
  configRead: "config/read",
  configEffectiveRead: "config/effective/read",
  agentsList: "agents/list",
  skillsList: "skills/list",
  // Session lifecycle
  sessionStart: "session/start",
  sessionResume: "session/resume",
  sessionStop: "session/stop",
  sessionDelete: "session/delete",
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionRewindRead: "session/rewind/read",
  sessionRewind: "session/rewind",
  sessionContextRead: "session/context/read",
  sessionTitleUpdate: "session/title/update",
  sessionRename: "session/rename",
  sessionApprovalPolicyUpdate: "session/approvalPolicy/update",
  sessionBackgroundProcessOutput: "session/backgroundProcess/output",
  sessionBackgroundProcessStop: "session/backgroundProcess/stop",
  // Account & runtime (session-scoped)
  accountRead: "account/read",
  providerAuthRead: "providerAuth/read",
  runtimeRead: "runtime/read",
  configModelWrite: "config/model/write",
  // Turns & callbacks
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
  callbackResult: "callback/result",
  // Server → Client requests
  callbackCall: "callback/call",
  clientToolReadTextFile: "clientTool/readTextFile",
  clientToolWriteTextFile: "clientTool/writeTextFile",
  clientToolTerminalCreate: "clientTool/terminal/create",
  clientToolTerminalWait: "clientTool/terminal/wait",
  clientToolTerminalOutput: "clientTool/terminal/output",
  clientToolTerminalKill: "clientTool/terminal/kill",
  clientToolTerminalRelease: "clientTool/terminal/release",
  // Server → Client notifications
  sessionSnapshot: "session/snapshot",
  sessionUpdated: "session/updated",
  sessionCompacted: "session/compacted",
  sessionContextCleared: "session/contextCleared",
  historyEntryAdded: "history/entryAdded",
  historyEntryUpdated: "history/entryUpdated",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnQueueUpdated: "turn/queueUpdated",
  statsUpdated: "session/statsUpdated",
  childSessionUpdated: "session/childSessionUpdated",
} as const;

/**
 * Vibe's built-in subagent tool (`task`) is always disabled so delegation runs
 * through Moxen's tracked `delegate` threads instead of hidden native subagents.
 */
export const VIBE_ALWAYS_DISABLED_TOOLS: readonly string[] = ["task"];

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface VibeJsonPatchOp {
  readonly op: "add" | "append" | "replace" | "remove" | "test";
  readonly path: string;
  readonly value?: unknown;
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerSegments(pointer: string): string[] {
  if (!pointer || pointer === "/") return [];
  const trimmed = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  return trimmed.split("/").map(unescapePointerSegment);
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

/**
 * Apply `vibe-app-server`'s RFC 6902 + `append` JSON-Patch operations
 * (`vibe/app_server/_patch.py`) without mutating the input document.
 */
export function applyVibeJsonPatch(doc: unknown, rawOps: unknown): unknown {
  if (!Array.isArray(rawOps) || rawOps.length === 0) return doc;
  let root = cloneJson(doc);
  for (const rawOp of rawOps) {
    const rec = asRecord(rawOp);
    const op = asString(rec?.["op"]);
    const ptr = asString(rec?.["path"]);
    if (!op || ptr === null) continue;
    const value = rec?.["value"];
    const segments = pointerSegments(ptr);
    if (segments.length === 0) {
      if (op === "replace" || op === "add") root = cloneJson(value);
      else if (op === "append" && typeof root === "string" && typeof value === "string") root = root + value;
      continue;
    }
    let parent: unknown = root;
    let missing = false;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (Array.isArray(parent)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          missing = true;
          break;
        }
        parent = parent[idx];
      } else if (parent !== null && typeof parent === "object") {
        parent = (parent as Record<string, unknown>)[seg];
      } else {
        missing = true;
        break;
      }
    }
    if (missing || parent === null || typeof parent !== "object") continue;
    const leaf = segments[segments.length - 1]!;
    if (Array.isArray(parent)) {
      if (op === "add") {
        if (leaf === "-") {
          parent.push(cloneJson(value));
        } else {
          const idx = Number(leaf);
          if (Number.isInteger(idx) && idx >= 0 && idx <= parent.length) {
            parent.splice(idx, 0, cloneJson(value));
          }
        }
      } else if (op === "replace") {
        const idx = Number(leaf);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) {
          parent[idx] = cloneJson(value);
        }
      } else if (op === "remove") {
        const idx = Number(leaf);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) {
          parent.splice(idx, 1);
        }
      } else if (op === "append") {
        const idx = Number(leaf);
        if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) {
          const cur = parent[idx];
          if (typeof cur === "string" && typeof value === "string") parent[idx] = cur + value;
        }
      }
    } else {
      const target = parent as Record<string, unknown>;
      if (op === "add" || op === "replace") {
        target[leaf] = cloneJson(value);
      } else if (op === "remove") {
        delete target[leaf];
      } else if (op === "append") {
        const cur = target[leaf];
        if (typeof cur === "string" && typeof value === "string") {
          target[leaf] = cur + value;
        } else if (cur === undefined && typeof value === "string") {
          target[leaf] = value;
        }
      }
    }
  }
  return root;
}

/** Map Moxen's `RuntimeMode` to Vibe's approval policies (`ask`, `accept-edits`, `auto-approve`). */
export function vibeApprovalPolicyForRuntimeMode(mode: RuntimeMode | undefined): string {
  switch (mode) {
    case "approval-required":
      return "ask";
    case "auto-accept-edits":
      return "accept-edits";
    case "auto":
      // Keep tool callbacks flowing to Moxen in `auto` mode so our worktree
      // and command-safety checks can gate risky calls cleanly.
      return "ask";
    case "full-access":
      return "auto-approve";
    default:
      return "accept-edits";
  }
}

/**
 * Convert Moxen `McpServerSpec[]` into `vibe-app-server`'s `SessionMCPServer[]`.
 * Vibe supports `stdio` and `streamable-http` (`http` / `streamable-http`).
 */
export function vibeMcpServersOf(servers: readonly McpServerSpec[] | undefined): Array<Record<string, unknown>> {
  if (!servers || servers.length === 0) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const spec of servers) {
    const server = outOfProcess(spec);
    if (server.type === "stdio") {
      out.push({
        transport: "stdio",
        name: server.name,
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
      });
    } else if (server.type === "http") {
      out.push({
        transport: "streamable-http",
        name: server.name,
        url: server.url,
        ...(Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
      });
    }
  }
  return out;
}

/**
 * Vibe's MCP server alias normalization (`normalize_mcp_server_name`,
 * `mistral-vibe` v3.1.4/3.1.5, `vibe/core/config/models.py`): characters
 * outside `[a-zA-Z0-9_-]` become `_`, leading/trailing `_`/`-` are stripped,
 * and the result is cut to 256 chars. Iterates code points so an astral
 * character is one replacement, as Python does (a UTF-16 `.replace` would
 * emit two underscores).
 */
export function vibeMcpServerAlias(name: string): string {
  const replaced = [...name].map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_")).join("");
  return replaced.replace(/^[_-]+/, "").replace(/[_-]+$/, "").slice(0, 256);
}

/**
 * Vibe's identifier normalization (`_normalize_identifier` in
 * `mistralai_vibe_local_harness/vibe/_mcp_naming.py`): code-point wise, every
 * character outside `[A-Za-z0-9_$]` becomes a single `_`, and a leading digit
 * gains a `_` prefix.
 */
function vibeMcpIdentifier(value: string): string {
  const normalized = [...value].map((ch) => (/[A-Za-z0-9_$]/.test(ch) ? ch : "_")).join("") || "_";
  return /^[0-9]/.test(normalized) ? `_${normalized}` : normalized;
}

export interface VibeMcpExclusionPlan {
  /** Servers not to offer this session because an exclusion cannot be scoped. */
  readonly dropServers: ReadonlySet<string>;
  /** Exact anchored `disabledTools` patterns for the unambiguous exclusions. */
  readonly patterns: string[];
  /** Sanitized notes explaining each dropped server. */
  readonly notes: string[];
  /**
   * True when the plan would withhold every offered server while exclusions
   * exist: Vibe 3.1.4 sends no MCP override for an empty list, so a native
   * copy of the withheld servers from the user's own Vibe configuration (which
   * may still expose the excluded tools) stays in scope. The session must
   * refuse to start rather than send an ineffective empty override.
   */
  readonly unsatisfiable: boolean;
  /** The `mcp__server__tool` exclusions that cannot be enforced. */
  readonly unsatisfiableExclusions: string[];
}

const UNSATISFIABLE_PLAN = (exclusions: readonly string[]): Pick<VibeMcpExclusionPlan, "unsatisfiable" | "unsatisfiableExclusions"> =>
  exclusions.length > 0
    ? { unsatisfiable: true, unsatisfiableExclusions: [...exclusions] }
    : { unsatisfiable: false, unsatisfiableExclusions: [] };

/**
 * Vibe's display names for every (server, tool) identity, computed exactly as
 * `mistral-vibe` 3.1.4's `_display_names` (`_mcp_naming.py`) does: the
 * candidate is `_normalize_identifier(f"{server}_{tool}")`; a raw candidate
 * that is already an identifier and has a single owner keeps the raw form, a
 * unique candidate takes the normalized form, and every owner of a shared
 * candidate gets `_<sha256(server + "\0" + tool)[:8]>` appended (lengthened
 * on a further collision). Identity iteration is sorted, as Python's
 * `sorted(identities)` is.
 */
function vibeMcpDisplayNames(identities: ReadonlyArray<{ readonly server: string; readonly tool: string }>): Map<string, string> {
  const owners = new Map<string, number>();
  for (const { server, tool } of identities) {
    const candidate = vibeMcpIdentifier(`${server}_${tool}`);
    owners.set(candidate, (owners.get(candidate) ?? 0) + 1);
  }
  const sorted = [...identities].sort((a, b) => {
    if (a.server !== b.server) return a.server < b.server ? -1 : 1;
    if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
    return 0;
  });
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const { server, tool } of sorted) {
    const key = `${server}\u0000${tool}`;
    const base = `${server}_${tool}`;
    const candidate = vibeMcpIdentifier(base);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base) && owners.get(candidate) === 1) {
      result.set(key, base);
      used.add(base);
    } else if (owners.get(candidate) === 1 && !used.has(candidate)) {
      result.set(key, candidate);
      used.add(candidate);
    } else {
      const digest = createHash("sha256").update(`${server}\u0000${tool}`, "utf8").digest("hex");
      for (let length = 8; ; length += 1) {
        if (length > digest.length) {
          result.set(key, `${candidate}_${digest}`);
          used.add(`${candidate}_${digest}`);
          break;
        }
        const name = `${candidate}_${digest.slice(0, length)}`;
        if (!used.has(name)) {
          result.set(key, name);
          used.add(name);
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Plan Moxen's per-tool MCP exclusions (`mcp__<server>__<tool>`) against Vibe's
 * `disabledTools` filter. Verified against `mistral-vibe` v3.1.4
 * (`_mcp_naming.py`, `_mcp_models.py`, `_runtime.py`): a tool is published
 * under the display name built from the normalized server alias and the
 * normalized remote tool name (`_display_names`), and `disabledTools` entries
 * are case-insensitive fnmatch globs or `re:` regex full matches against that
 * display name (`MCPToolFilter.allows`). When two identities normalize to the
 * same candidate, Vibe digest-suffixes ALL of them (`_display_names`).
 *
 * Moxen knows the offered server list and the excluded tool names. It knows a
 * server's full tool list only for servers Moxen hosts in-process. Exclusions
 * are therefore resolved in exactly two ways:
 *
 *  - With every offered tool list known, each excluded tool's published display
 *    name is computed exactly (including Vibe's digest suffixes) and only the
 *    anchored pattern for that name is emitted — unless the case-insensitive
 *    filter would make that pattern also match a published name that is not
 *    excluded (a case-fold sibling), in which case the server that holds the
 *    excluded tool is not offered, with a notice (fail closed).
 *  - Otherwise (any offered server's tool list unknown) no pattern is emitted
 *    at all: Vibe may digest-suffix colliding display names in a way Moxen
 *    cannot predict, and a guessed suffix or the unsuffixed base name would
 *    miss the target and leave the excluded tool callable. Fail closed: only
 *    the server that holds an excluded tool is withheld (a server with no
 *    exclusion is always offered, and Vibe's own digest disambiguation is left
 *    alone), with a notice.
 *  - Exact-mode drops are re-resolved iteratively: withholding one server can
 *    unsuffix another server's published names, so the plan recomputes
 *    against the retained catalog after every removal (a server's own
 *    case-fold conflict first) and emits patterns only for exclusions that
 *    remain enforceable.
 *
 * An exclusion whose `mcp__<name>__` prefix parses under more than one offered
 * server (names may contain `__`) is structurally ambiguous and implicates all
 * matched servers. When ALL supplied servers are withheld, Vibe 3.1.4 sends no
 * MCP override at all (`_runtime.py` guards `if options.mcp_servers:`), so a
 * native copy of a withheld server from the user's own Vibe configuration
 * stays in scope; omitting a server is not a deny there.
 */
export function vibeMcpExclusionPlan(
  servers: readonly McpServerSpec[],
  disabled: readonly string[],
): VibeMcpExclusionPlan {
  const dropServers = new Set<string>();
  const notes: string[] = [];
  const patterns = new Set<string>();
  if (servers.length === 0 || disabled.length === 0) {
    return { dropServers, patterns: [...patterns], notes, ...UNSATISFIABLE_PLAN([]) };
  }

  const prefixExclusions = new Map<string, string[]>();
  const matchedExclusionNames: string[] = [];
  for (const name of disabled) {
    const matched = servers.filter((server) => {
      const prefix = `mcp__${server.name}__`;
      return name.startsWith(prefix) && name.slice(prefix.length).length > 0;
    });
    if (matched.length === 0) continue;
    matchedExclusionNames.push(name);
    if (matched.length > 1) {
      for (const server of matched) dropServers.add(server.name);
      notes.push(`MCP exclusion "${name}" matches more than one server (${matched.map((s) => s.name).join(", ")}); those servers are not offered to this session.`);
    } else if (matched.length === 1) {
      const server = matched[0]!;
      const tool = name.slice(`mcp__${server.name}__`.length);
      const list = prefixExclusions.get(server.name) ?? [];
      list.push(tool);
      prefixExclusions.set(server.name, list);
    }
    // An exclusion naming a server that is not offered needs no enforcement.
  }

  if (servers.some((server) => server.type !== "in-process")) {
    // At least one offered server's tool list is unknown: the excluded tool's
    // published name cannot be proven, so no pattern is trusted. Only the
    // server that holds an excluded tool is withheld ("only": no other server
    // loses its offer, and Vibe's own digest disambiguation is left alone).
    for (const [serverName, tools] of prefixExclusions) {
      if (dropServers.has(serverName)) continue;
      dropServers.add(serverName);
      notes.push(`MCP tool exclusions (${tools.join(", ")}) cannot be scoped within server "${serverName}" without its tool list; the server is not offered to this session.`);
    }
    // Withholding the last offered server would leave the override empty and
    // the exclusions unenforced against a native copy.
    if (servers.every((server) => dropServers.has(server.name))) {
      return { dropServers, patterns: [], notes, ...UNSATISFIABLE_PLAN(matchedExclusionNames) };
    }
    return { dropServers, patterns: [], notes, ...UNSATISFIABLE_PLAN([]) };
  }

  // Every offered server is in-process: the tool identities are known, so
  // Vibe's published display names (including digest suffixes) are computable
  // exactly and the anchored pattern provably matches the excluded tool.
  // `_display_names` sees each server's config-normalized name, so identities
  // are keyed by the alias Vibe will have after its name validator runs.
  // Drops are resolved iteratively: withholding one server can change the
  // other servers' published names (a digest disambiguation can disappear),
  // so the plan recomputes against the retained catalog after every removal
  // and stops as soon as every surviving exclusion is enforceable — a server
  // that only needs a pattern is never dropped, and each pass either
  // withholds one server or ends, so the loop terminates. A server's own
  // conflict (a case-fold bystander on the same server) is resolved before
  // cross-server ones.
  const aliasByServer = new Map(servers.map((server) => [server.name, vibeMcpServerAlias(server.name)]));
  let retained = [...servers];
  const ignoredNoted = new Set<string>();
  for (;;) {
    const identities = retained.flatMap((server) =>
      server.type === "in-process"
        ? server.tools.map((tool) => ({ server: aliasByServer.get(server.name) ?? server.name, tool: tool.name }))
        : [],
    );
    const displays = vibeMcpDisplayNames(identities);
    const retainedNames = new Set(retained.map((server) => server.name));
    const excludedIdentities = new Set<string>();
    for (const [serverName, tools] of prefixExclusions) {
      if (!retainedNames.has(serverName)) continue;
      const alias = aliasByServer.get(serverName) ?? serverName;
      for (const tool of tools) excludedIdentities.add(`${alias}\u0000${tool}`);
    }

    // Scan EVERY exclusion of EVERY retained server before dropping anything:
    // a `.find()` that stops at the first bystander could otherwise pick a
    // cross-server conflict and miss a mandatory internal one elsewhere, which
    // made the plan order-dependent. Servers are visited in sorted order and
    // the quoted bystander is the first of the sorted witness list, so the
    // notes do not depend on the caller's input order either.
    const violations: Array<{ readonly serverName: string; readonly note: string; readonly internal: boolean }> = [];
    for (const [serverName, tools] of [...prefixExclusions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!retainedNames.has(serverName)) continue;
      const alias = aliasByServer.get(serverName) ?? serverName;
      for (const tool of tools) {
        const display = displays.get(`${alias}\u0000${tool}`);
        if (display === undefined) {
          const key = `${serverName}\u0000${tool}`;
          if (!ignoredNoted.has(key)) {
            ignoredNoted.add(key);
            notes.push(`MCP exclusion "${tool}" names no tool server "${serverName}" lists; it is ignored.`);
          }
          continue;
        }
        // Vibe compiles `re:` patterns with IGNORECASE and full-matches them
        // against every published display name: the pattern is only safe when
        // everything it matches is itself excluded.
        const matcher = new RegExp(`^(?:${display.replace(/[^A-Za-z0-9_]/g, "\\$&")})$`, "i");
        const bystanders = identities
          .map((identity) => ({ identity, name: displays.get(`${identity.server}\u0000${identity.tool}`) }))
          .filter((entry): entry is { identity: typeof identities[number]; name: string } =>
            entry.name !== undefined && matcher.test(entry.name) && !excludedIdentities.has(`${entry.identity.server}\u0000${entry.identity.tool}`))
          .sort((p, q) => (p.identity.server !== q.identity.server
            ? (p.identity.server < q.identity.server ? -1 : 1)
            : (p.identity.tool < q.identity.tool ? -1 : p.identity.tool > q.identity.tool ? 1 : 0)));
        if (bystanders.length === 0) continue;
        // Any bystander suffices to disprove the pattern; quoting the
        // deterministic first witness keeps the note input-order independent.
        const bystander = bystanders[0]!.identity;
        const holderName = retained.find((server) => (aliasByServer.get(server.name) ?? server.name) === bystander.server)?.name ?? bystander.server;
        violations.push({
          serverName,
          internal: bystander.server === alias,
          note: bystander.server === alias
            ? `MCP server "${serverName}" is not offered to this session: its excluded tool "${tool}" cannot be separated from "${bystander.tool}" on the same server, and the filter matches case-insensitively.`
            : `MCP server "${serverName}" is not offered to this session: its excluded tool "${tool}" cannot be separated from "${bystander.tool}" of server "${holderName}", and the filter matches case-insensitively.`,
        });
      }
    }
    // A server's own conflict (a case-fold bystander on the same server) is a
    // mandatory drop and is resolved before any cross-server choice: withholding
    // those servers first can unsuffix other tools and re-enable patterns.
    const internalServers = [...new Set(violations.filter((entry) => entry.internal).map((entry) => entry.serverName))].sort();
    if (internalServers.length > 0) {
      for (const serverName of internalServers) {
        dropServers.add(serverName);
        notes.push(violations.find((entry) => entry.internal && entry.serverName === serverName)!.note);
      }
      retained = retained.filter((server) => !internalServers.includes(server.name));
    } else if (violations.length > 0) {
      // Cross-server drop, one per pass, deterministic: the smallest server
      // name wins instead of whichever conflict the input order produced.
      const chosen = [...violations].sort((p, q) => (p.serverName !== q.serverName ? (p.serverName < q.serverName ? -1 : 1) : (p.note < q.note ? -1 : 1)))[0]!;
      dropServers.add(chosen.serverName);
      notes.push(chosen.note);
      retained = retained.filter((server) => server.name !== chosen.serverName);
    } else {
      // Nothing must be withheld any further: enforce every surviving
      // exclusion against the retained catalog's published names.
      for (const [serverName, tools] of prefixExclusions) {
        if (!retainedNames.has(serverName)) continue;
        const alias = aliasByServer.get(serverName) ?? serverName;
        for (const tool of tools) {
          const display = displays.get(`${alias}\u0000${tool}`);
          if (display !== undefined) patterns.add(`re:${display.replace(/[^A-Za-z0-9_]/g, "\\$&")}`);
        }
      }
      break;
    }
    if (retained.length === 0) {
      return { dropServers, patterns: [...patterns], notes, ...UNSATISFIABLE_PLAN(matchedExclusionNames) };
    }
  }
  return { dropServers, patterns: [...patterns], notes, ...UNSATISFIABLE_PLAN([]) };
}

export interface VibeMcpGatewayRoute {
  /** The out-of-process servers implicated by an exclusion — hosted behind Moxen's lazy MCP gateway. */
  readonly servers: readonly McpServerSpec[];
  /**
   * The exclusion strings to deny inside the gateway. The raw `mcp__…` string
   * already names every parse: `mcp__demo__x__read` covers `demo`/`x__read`
   * and `demo__x`/`read` alike, because the gateway compares the string its
   * `server`/`tool` pair builds against it.
   */
  readonly denyTools: readonly string[];
  /** The exclusion plan for the session once these servers leave the direct offer. */
  readonly plan: VibeMcpExclusionPlan;
  /** Startup note explaining the routing, added when the route is taken. */
  readonly note: string;
}

/**
 * The servers a per-tool exclusion implicates that `vibeMcpExclusionPlan`
 * would withhold today because their tool list is unknown: the out-of-process
 * ones. LOCAL-032 routes exactly those through Moxen's lazy MCP gateway
 * instead — Vibe only ever sees the gateway's two tools, and the exclusions
 * are enforced inside the gateway (an ambiguous exclusion is denied under
 * every parse there). Servers without an exclusion and Moxen's own in-process
 * server keep `vibeMcpExclusionPlan`'s behaviour; a caller that cannot verify
 * the Vibe version must NOT take this route, falling back to
 * `vibeMcpExclusionPlan` on the full server list, which withholds these
 * servers exactly as main does. The returned `plan` covers the session once
 * the routed servers leave the offer: an exclusion left over implicates only
 * retaining servers, so nothing is under-enforced.
 */
export function vibeMcpGatewayRoute(
  servers: readonly McpServerSpec[],
  disabled: readonly string[],
): VibeMcpGatewayRoute | null {
  const implicated = new Set<string>();
  const denyTools: string[] = [];
  for (const name of disabled) {
    const matched = servers.filter(
      (server) => name.startsWith(`mcp__${server.name}__`) && name.length > `mcp__${server.name}__`.length,
    );
    if (matched.some((server) => server.type !== "in-process")) denyTools.push(name);
    for (const server of matched) {
      if (server.type !== "in-process") implicated.add(server.name);
    }
  }
  if (implicated.size === 0) return null;
  const routed = servers.filter((server) => implicated.has(server.name));
  const plan = vibeMcpExclusionPlan(
    servers.filter((server) => !implicated.has(server.name)),
    disabled,
  );
  const listed = routed.map((server) => `"${server.name}"`).join(", ");
  return {
    servers: routed,
    denyTools,
    plan,
    note: `MCP servers ${listed} have individually excluded tools, so they are attached through Moxen's lazy MCP gateway; the excluded tools stay hidden this session.`,
  };
}

/**
 * Every display name Vibe can publish for `(server, tool)`:
 * `mcp_tool_config_name` (`{server}_{tool}`), its normalized identifier
 * candidate, and each with the `_`+sha256(`server\0tool`) digest suffix that
 * `_display_names` appends on a collision (lengthened step by step).
 */
function vibeDisplayForms(server: string, tool: string): string[] {
  const raw = `${server}_${tool}`;
  const ident = vibeMcpIdentifier(raw);
  const digest = createHash("sha256").update(`${server}\u0000${tool}`, "utf8").digest("hex");
  const forms = new Set<string>([raw, ident]);
  for (const base of [raw, ident]) {
    for (let length = 8; length <= digest.length; length += 1) {
      forms.add(`${base}_${digest.slice(0, length)}`);
    }
  }
  return [...forms];
}

/**
 * One of Vibe's `enabled_tools`/`disabled_tools` patterns against a name, as
 * `MCPToolFilter`/`_pattern_matches` evaluate them (v3.1.5, `_mcp_models.py`):
 * `re:` bodies compile with `IGNORECASE` and are full-matched, everything else
 * is a case-insensitive fnmatch glob. An unparseable `re:` body is decided by
 * `unparseableMatches`, mirroring the disabled/enabled call sites.
 */
function vibeToolPatternMatches(pattern: string, name: string, unparseableMatches: boolean): boolean {
  const raw = pattern.trim();
  if (raw === "") return false;
  if (raw.startsWith("re:")) {
    try {
      return new RegExp(`^(?:${raw.slice(3)})$`, "i").test(name);
    } catch {
      return unparseableMatches;
    }
  }
  const lowered = name.toLowerCase();
  const glob = raw
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${glob}$`).test(lowered);
}

export interface VibeEffectiveMcpRestrictions {
  /** The normalized aliases of Mistral Vibe's own configured MCP servers. */
  readonly nativeServers: ReadonlySet<string>;
  /** Whether the tool `(server, tool)` may be surfaced by the lazy gateway. */
  allows(server: string, tool: string): boolean;
}

/**
 * `config/effective/read` (v3.1.5, `_unified_harness_backend_adapter.py` →
 * `effective_config_response`, `_config_introspect.py`) answers the whole
 * effective `VibeConfigSchema` — merged over user config, trusted project
 * config, env, the session's own overrides, the agent profile and the admin
 * layer, with credentials redacted but names, `disabled` and `disabled_tools`
 * intact. Parse it into the restrictions the lazy gateway must honor so it is
 * never a way around the user's own Vibe configuration, or null when the shape
 * cannot be proven: callers must fail closed on null (LOCAL-032).
 */
export function parseVibeEffectiveConfig(raw: unknown): VibeEffectiveMcpRestrictions | null {
  const root = asRecord(raw);
  const cfg = asRecord(root?.["config"]);
  if (!cfg) return null;
  const readPatterns = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") return null;
      out.push(item);
    }
    return out;
  };
  const disabledPatterns = readPatterns(cfg["disabled_tools"]);
  const enabledPatterns = readPatterns(cfg["enabled_tools"]);
  const rawServers = cfg["mcp_servers"];
  if (disabledPatterns === null || enabledPatterns === null || !Array.isArray(rawServers)) return null;
  const nativeServers = new Set<string>();
  const disabledServers = new Set<string>();
  const disabledTools = new Set<string>();
  for (const item of rawServers) {
    const rec = asRecord(item);
    const name = asNonEmptyString(rec?.["name"]);
    if (!name) return null;
    const alias = vibeMcpServerAlias(name).toLowerCase();
    if (alias === "") return null;
    const tools = readPatterns(rec?.["disabled_tools"]);
    if (tools === null || typeof rec?.["disabled"] !== "boolean") return null;
    nativeServers.add(alias);
    if (rec["disabled"] === true) disabledServers.add(alias);
    for (const tool of tools) disabledTools.add(`${alias}\u0000${tool.toLowerCase()}`);
  }
  return {
    nativeServers,
    allows(server: string, tool: string): boolean {
      const alias = vibeMcpServerAlias(server).toLowerCase();
      if (disabledServers.has(alias)) return false;
      if (disabledTools.has(`${alias}\u0000${tool.toLowerCase()}`)) return false;
      const forms = vibeDisplayForms(server, tool);
      if (disabledPatterns.some((pattern) => forms.some((form) => vibeToolPatternMatches(pattern, form, true)))) {
        return false;
      }
      if (enabledPatterns.length > 0
        && !forms.every((form) => enabledPatterns.some((pattern) => vibeToolPatternMatches(pattern, form, false)))) {
        // Vibe only publishes a tool the enabled list names; requiring every
        // plausible form to be named denies at least as strictly.
        return false;
      }
      return true;
    },
  };
}

/** The shape an unwrapped lazy-gateway approval takes (LOCAL-032). */
export interface VibeGatewayApprovalTarget {
  readonly kind: "call";
  readonly server: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Whether `toolName` is the gateway's `tool` as the model sees it. Vibe
 * publishes the display name (`{server}_{tool}` normalized — digest-suffixed
 * on a collision), so both the plain form and the suffixed one are accepted,
 * as is the `group.tool` route form.
 */
function isVibeGatewayToolName(toolName: string, gatewayName: string, tool: "call_tool" | "search_tools"): boolean {
  const alias = vibeMcpServerAlias(gatewayName);
  if (alias === "") return false;
  const bare = toolName.trim().toLowerCase();
  if (bare === "") return false;
  const display = vibeMcpIdentifier(`${alias}_${tool}`).toLowerCase();
  const segment = [...alias].map((ch) => (/[A-Za-z0-9_$]/.test(ch) ? ch : "_")).join("") || "_";
  const route = `mcp_${segment}`;
  return (
    new RegExp(`^${display}_[0-9a-f]{8,64}$|^${display}$`).test(bare)
    || new RegExp(`^${route}(_[0-9a-f]{8,64})?\\.${tool}$`).test(bare)
  );
}

/**
 * A gateway approval (or timeline effect) under the real server and tool:
 * `null` whenever this is not recognizable as the gateway's `call_tool`
 * naming a routed server. `search_tools` is not unwrapped — it has no
 * per-server target and is judged like the read it is.
 */
export function unwrapVibeGatewayApproval(
  gatewayName: string,
  routedServers: ReadonlySet<string>,
  toolName: string,
  input: Record<string, unknown>,
): VibeGatewayApprovalTarget | null {
  if (!isVibeGatewayToolName(toolName, gatewayName, "call_tool")) return null;
  const server = asString(input["server"])?.trim().toLowerCase() ?? "";
  const tool = asString(input["tool"])?.trim() ?? "";
  if (server === "" || tool === "" || !routedServers.has(server)) return null;
  return { kind: "call", server, tool, arguments: asRecord(input["arguments"]) ?? {} };
}

/** Build `TurnStartParams.message` / `TurnSteerParams.message` content blocks. */
export function buildVibeMessageBlocks(
  prompt: string,
  images?: readonly ProviderImage[],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (prompt.length > 0 || !images || images.length === 0) {
    blocks.push({ type: "text", text: prompt });
  }
  for (const image of images ?? []) {
    blocks.push({
      type: "image",
      attachment: {
        source: { kind: "inline", data: image.data },
        alias: image.name,
        mimeType: image.mimeType,
      },
    });
  }
  return blocks;
}

export interface VibeModelEntry {
  readonly alias: string;
  readonly name: string;
  readonly displayName: string;
  readonly thinking: string | null;
  readonly thinkingLevels: readonly string[];
  readonly maxContextLength: number | null;
  readonly autoCompactThreshold: number | null;
  readonly supportsImages: boolean;
  readonly locked: boolean;
}

export function parseVibeConfigModels(rawConfigRead: unknown): {
  readonly activeAlias: string | null;
  readonly models: VibeModelEntry[];
} {
  const root = asRecord(rawConfigRead);
  const cfg = asRecord(root?.["config"]) ?? root;
  if (!cfg) return { activeAlias: null, models: [] };
  const active = asRecord(cfg["activeModel"]);
  const activeAlias = asNonEmptyString(active?.["alias"]) ?? asNonEmptyString(cfg["defaultModelAlias"]);
  const rawModels = Array.isArray(cfg["models"]) ? cfg["models"] : [];
  const models: VibeModelEntry[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const item = asRecord(entry);
    if (!item) continue;
    const alias = asNonEmptyString(item["alias"]) ?? asNonEmptyString(item["name"]);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    const levels = Array.isArray(item["thinkingLevels"])
      ? item["thinkingLevels"].filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    models.push({
      alias,
      name: asNonEmptyString(item["name"]) ?? alias,
      displayName: asNonEmptyString(item["displayName"]) ?? alias,
      thinking: asNonEmptyString(item["thinking"]),
      thinkingLevels: levels,
      maxContextLength: asNumber(item["maxContextLength"]),
      autoCompactThreshold: asNumber(item["autoCompactThreshold"]),
      supportsImages: item["supportsImages"] === true,
      locked: item["requires"] !== null && item["requires"] !== undefined,
    });
  }
  return { activeAlias, models };
}

function titleCaseEffort(level: string): string {
  return level.length > 0 ? level[0]!.toUpperCase() + level.slice(1) : level;
}

export function vibeModelsToSummaries(
  entries: readonly VibeModelEntry[],
  activeAlias: string | null,
): ModelSummary[] {
  const unlocked = entries.filter((m) => !m.locked);
  const list = unlocked.length > 0 ? unlocked : entries;
  const summaries: ModelSummary[] = list.map((m) => {
    const choices = m.thinkingLevels.map((level) => ({
      id: level,
      label: titleCaseEffort(level),
      isDefault: level === m.thinking,
    }));
    return {
      slug: m.alias,
      name: m.displayName,
      isCustom: false,
      isHidden: false,
      isDefault: activeAlias !== null && m.alias === activeAlias,
      ...(m.maxContextLength !== null ? { contextWindow: m.maxContextLength } : {}),
      efforts: choices.length > 0
        ? [{ id: "effort", label: "Thinking", choices, currentValue: m.thinking }]
        : [],
    };
  });
  if (summaries.length > 0 && !summaries.some((s) => s.isDefault)) {
    summaries[0] = { ...summaries[0]!, isDefault: true };
  }
  return summaries;
}

export interface VibeAccountSnapshot {
  readonly status: string;
  readonly planKind: string | null;
  readonly planName: string | null;
  readonly planTitle: string | null;
  readonly budget: {
    readonly usagePercentage: number;
    readonly resetAt: string | null;
    readonly paygEnabled: boolean;
  } | null;
}

export function parseVibeAccountRead(raw: unknown): VibeAccountSnapshot | null {
  const root = asRecord(raw);
  const account = asRecord(root?.["account"]) ?? root;
  if (!account) return null;
  const status = asNonEmptyString(account["status"]);
  if (!status) return null;
  const plan = asRecord(account["plan"]);
  const budget = asRecord(account["budget"]);
  const pct = asNumber(budget?.["usagePercentage"]);
  return {
    status,
    planKind: asNonEmptyString(plan?.["kind"]),
    planName: asNonEmptyString(plan?.["name"]),
    planTitle: asNonEmptyString(plan?.["title"]),
    budget:
      pct !== null
        ? {
            usagePercentage: Math.max(0, pct),
            resetAt: asNonEmptyString(budget?.["resetAt"]),
            paygEnabled: budget?.["paygEnabled"] === true,
          }
        : null,
  };
}

export interface VibeSetupStatus {
  readonly hasApiKey: boolean;
  readonly activeCredentialSource: string | null;
  readonly activeModel: string | null;
  readonly supportsBrowserSignIn: boolean;
}

export function parseVibeSetupStatus(raw: unknown): VibeSetupStatus {
  const rec = asRecord(raw) ?? {};
  return {
    hasApiKey: rec["hasApiKey"] === true,
    activeCredentialSource: asNonEmptyString(rec["activeCredentialSource"]),
    activeModel: asNonEmptyString(rec["activeModel"]),
    supportsBrowserSignIn: rec["supportsBrowserSignIn"] === true,
  };
}

export interface VibeStatsSnapshot {
  readonly sessionPromptTokens: number;
  readonly sessionCompletionTokens: number;
  readonly sessionCachedTokens: number;
  readonly lastTurnPromptTokens: number;
  readonly lastTurnCompletionTokens: number;
  readonly lastTurnCachedTokens: number;
  readonly contextTokens: number;
  readonly contextWindow: number | null;
}

export function parseVibeStatsUpdated(raw: unknown): VibeStatsSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;
  const stats = asRecord(root["stats"]) ?? root;
  const contextWindow = asNumber(root["contextWindow"]);
  return {
    sessionPromptTokens: asNumber(stats["sessionPromptTokens"]) ?? 0,
    sessionCompletionTokens: asNumber(stats["sessionCompletionTokens"]) ?? 0,
    sessionCachedTokens: asNumber(stats["sessionCachedTokens"]) ?? 0,
    lastTurnPromptTokens: asNumber(stats["lastTurnPromptTokens"]) ?? 0,
    lastTurnCompletionTokens: asNumber(stats["lastTurnCompletionTokens"]) ?? 0,
    lastTurnCachedTokens: asNumber(stats["lastTurnCachedTokens"]) ?? 0,
    contextTokens: asNumber(stats["contextTokens"]) ?? 0,
    contextWindow,
  };
}

const CONTEXT_CATEGORY_LABELS: Record<string, string> = {
  system: "System prompt",
  tools: "Tools",
  skills: "Skills",
  conversation: "Conversation",
};

export function parseVibeContextBreakdown(raw: unknown): ContextBreakdown | null {
  const root = asRecord(raw);
  const b = asRecord(root?.["breakdown"]) ?? root;
  if (!b) return null;
  const usedTokens = asNumber(b["usedTokens"]);
  const maxTokens = asNumber(b["contextWindow"]);
  const threshold = asNumber(b["compactionThreshold"]);
  if (usedTokens === null) return null;
  const measured = b["measured"] === true;
  if (!measured && usedTokens === 0) return null;
  const rawCategories = Array.isArray(b["categories"]) ? b["categories"] : [];
  const categories: Array<{ readonly name: string; readonly tokens: number; readonly kind: "used" | "free" | "buffer" }> = [];
  for (const entry of rawCategories) {
    const rec = asRecord(entry);
    const id = asNonEmptyString(rec?.["id"]);
    const tokens = asNumber(rec?.["estimatedTokens"]);
    if (!id || tokens === null || tokens <= 0) continue;
    categories.push({
      name: CONTEXT_CATEGORY_LABELS[id] ?? id,
      tokens,
      kind: "used",
    });
  }
  if (maxTokens !== null && maxTokens > usedTokens) {
    const bufferTokens = threshold !== null && threshold < maxTokens ? Math.max(0, maxTokens - threshold) : 0;
    const freeTokens = Math.max(0, maxTokens - usedTokens - bufferTokens);
    if (freeTokens > 0) categories.push({ name: "Free space", tokens: freeTokens, kind: "free" });
    if (bufferTokens > 0) categories.push({ name: "Autocompact buffer", tokens: bufferTokens, kind: "buffer" });
  }
  return {
    usedTokens,
    maxTokens,
    cachedInputTokens: null,
    autoCompactThreshold: threshold,
    compactsAutomatically: threshold !== null && threshold > 0,
    categories,
    estimated: categories.length === 0 || !measured,
  };
}

export interface VibeNormalizedEffect {
  readonly callId: string;
  readonly tool: string;
  readonly rawToolName: string;
  readonly kind: string;
  readonly title: string;
  readonly status: "inProgress" | "completed" | "failed";
  readonly stopped: boolean;
  readonly input: Record<string, unknown>;
  readonly output: string | null;
  readonly exit: number | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly diff?: string }>;
  readonly patch: string | null;
  readonly durationMs: number | null;
  readonly todos: ReadonlyArray<{ readonly id: string; readonly content: string; readonly status: string; readonly priority?: string }> | null;
}

export function canonicalVibeToolName(rawToolName: string, kind: string): string {
  const lower = rawToolName.toLowerCase();
  if (kind === "shell" || lower === "bash" || lower === "git_bash" || lower === "powershell" || lower === "shell") {
    return "Bash";
  }
  if (kind === "file_read" || lower === "read_file") return "Read";
  if (kind === "file_write" || lower === "write_file") return "Write";
  if (kind === "file_edit" || lower === "edit") return "Edit";
  if (kind === "file_search" || lower === "grep") return "Grep";
  if (kind === "web_search" || lower === "web_search") return "WebSearch";
  if (kind === "web_fetch" || lower === "web_fetch") return "WebFetch";
  if (kind === "todo" || lower === "todo") return "TodoWrite";
  if (kind === "skill" || lower === "skill") return "Skill";
  if (kind === "user_question" || lower === "ask_user_question") return "AskUserQuestion";
  if (kind === "subagent" || lower === "task") return "Agent";
  return rawToolName;
}

function buildEditDiff(filePath: string, oldText: string, newText: string): string | null {
  try {
    return createTwoFilesPatch(filePath, filePath, oldText, newText, "", "", { context: 3 });
  } catch {
    return null;
  }
}

export function normalizeVibeEffectEntry(entry: Record<string, unknown>): VibeNormalizedEffect | null {
  const id = asNonEmptyString(entry["id"]);
  const detail = asRecord(entry["detail"]);
  const state = asRecord(entry["state"]);
  if (!id || !detail || !state) return null;
  const callId = asNonEmptyString(entry["toolCallId"]) ?? id;
  const kind = asNonEmptyString(detail["kind"]) ?? "tool";
  const rawToolName = asNonEmptyString(detail["toolName"]) ?? kind;
  const tool = canonicalVibeToolName(rawToolName, kind);
  const title = asNonEmptyString(entry["title"]) ?? tool;
  const rawStatus = asNonEmptyString(state["status"]) ?? "running";
  const status: "inProgress" | "completed" | "failed" =
    rawStatus === "completed"
      ? "completed"
      : rawStatus === "failed" || rawStatus === "cancelled" || rawStatus === "skipped"
        ? "failed"
        : "inProgress";
  const stopped = rawStatus === "cancelled";

  const rawInput = asRecord(detail["input"]) ?? {};
  const input: Record<string, unknown> = { ...rawInput };
  // Normalize camelCase Vibe filePath → snake_case file_path for Moxen's tool renderer.
  if (typeof input["filePath"] === "string" && input["file_path"] === undefined) {
    input["file_path"] = input["filePath"];
  }
  if (typeof input["oldString"] === "string" && input["old_string"] === undefined) {
    input["old_string"] = input["oldString"];
  }
  if (typeof input["newString"] === "string" && input["new_string"] === undefined) {
    input["new_string"] = input["newString"];
  }

  let output = asNonEmptyString(state["outputText"]);
  const structuredOutput = asRecord(state["output"]);
  if (!output && structuredOutput) {
    const transcript = asNonEmptyString(structuredOutput["output"]);
    const stdout = asString(structuredOutput["stdout"]) ?? "";
    const stderr = asString(structuredOutput["stderr"]) ?? "";
    if (transcript) {
      output = transcript;
    } else if (stdout || stderr) {
      output = stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : stdout + stderr;
    } else if (typeof structuredOutput["matches"] === "string") {
      output = structuredOutput["matches"];
    } else if (typeof structuredOutput["content"] === "string") {
      output = structuredOutput["content"];
    }
  }
  const errorRec = asRecord(state["error"]);
  if (!output && errorRec) {
    output = asNonEmptyString(errorRec["message"]);
  }

  const files: Array<{ readonly path: string; readonly diff?: string }> = [];
  let patch: string | null = null;
  const filePath =
    asNonEmptyString(input["file_path"]) ??
    asNonEmptyString(structuredOutput?.["file"]) ??
    asNonEmptyString(structuredOutput?.["filePath"]);
  if (kind === "file_edit" && filePath) {
    const oldStr = asString(input["old_string"]) ?? asString(structuredOutput?.["oldString"]);
    const newStr = asString(input["new_string"]) ?? asString(structuredOutput?.["newString"]);
    if (oldStr !== null && newStr !== null) {
      patch = buildEditDiff(filePath, oldStr, newStr);
      files.push(patch ? { path: filePath, diff: patch } : { path: filePath });
    } else {
      files.push({ path: filePath });
    }
  } else if (kind === "file_write" && filePath) {
    const prev = asString(structuredOutput?.["previousContent"]) ?? "";
    const next = asString(input["content"]) ?? asString(structuredOutput?.["content"]) ?? "";
    if (next.length > 0 || prev.length > 0) {
      patch = buildEditDiff(filePath, prev, next);
    }
    files.push(patch ? { path: filePath, diff: patch } : { path: filePath });
  }

  let todos: Array<{ readonly id: string; readonly content: string; readonly status: string; readonly priority?: string }> | null = null;
  if (kind === "todo") {
    const rawTodos = Array.isArray(structuredOutput?.["todos"])
      ? structuredOutput["todos"]
      : Array.isArray(rawInput["todos"])
        ? rawInput["todos"]
        : null;
    if (rawTodos) {
      todos = [];
      for (const item of rawTodos) {
        const rec = asRecord(item);
        const content = asNonEmptyString(rec?.["content"]);
        if (!content) continue;
        todos.push({
          id: asNonEmptyString(rec?.["id"]) ?? content,
          content,
          status: asNonEmptyString(rec?.["status"]) ?? "pending",
          ...(asNonEmptyString(rec?.["priority"]) ? { priority: asNonEmptyString(rec?.["priority"])! } : {}),
        });
      }
    }
  }

  return {
    callId,
    tool,
    rawToolName,
    kind,
    title,
    status,
    stopped,
    input,
    output,
    exit: asNumber(structuredOutput?.["exitCode"]) ?? (status === "failed" && kind === "shell" ? 1 : null),
    files,
    patch,
    durationMs: asNumber(state["durationMs"]),
    todos,
  };
}

export function extractVibeMessageText(entry: Record<string, unknown>): string {
  const blocks = Array.isArray(entry["content"]) ? entry["content"] : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (rec?.["type"] === "text" && typeof rec["text"] === "string") {
      parts.push(rec["text"]);
    }
  }
  return parts.join("\n\n");
}

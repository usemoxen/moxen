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
 * `mistral-vibe` v3.1.4): characters outside `[a-zA-Z0-9_-]` become `_`,
 * leading/trailing `_`/`-` are stripped, and the result is cut to 256 chars.
 * Iterates code points so an astral character is one replacement, as Python
 * does (a UTF-16 `.replace` would emit two underscores).
 */
function vibeMcpServerAlias(name: string): string {
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
}

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
    return { dropServers, patterns: [...patterns], notes };
  }

  const prefixExclusions = new Map<string, string[]>();
  for (const name of disabled) {
    const matched = servers.filter((server) => {
      const prefix = `mcp__${server.name}__`;
      return name.startsWith(prefix) && name.slice(prefix.length).length > 0;
    });
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
    return { dropServers, patterns: [], notes };
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

    // Withhold at most one server per pass (its own internal conflict first):
    // removing it can change which exclusions remain enforceable.
    const violations: Array<{ readonly serverName: string; readonly note: string; readonly internal: boolean }> = [];
    for (const [serverName, tools] of prefixExclusions) {
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
        const bystander = identities.find((identity) => {
          const name = displays.get(`${identity.server}\u0000${identity.tool}`);
          return name !== undefined && matcher.test(name) && !excludedIdentities.has(`${identity.server}\u0000${identity.tool}`);
        });
        if (!bystander) continue;
        const holderName = retained.find((server) => (aliasByServer.get(server.name) ?? server.name) === bystander.server)?.name ?? bystander.server;
        violations.push({
          serverName,
          note: bystander.server === alias
            ? `MCP server "${serverName}" is not offered to this session: its excluded tool "${tool}" cannot be separated from "${bystander.tool}" on the same server, and the filter matches case-insensitively.`
            : `MCP server "${serverName}" is not offered to this session: its excluded tool "${tool}" cannot be separated from "${bystander.tool}" of server "${holderName}", and the filter matches case-insensitively.`,
          internal: bystander.server === alias,
        });
        break;
      }
    }
    const violation = violations.find((entry) => entry.internal) ?? violations[0];
    if (!violation) {
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
    dropServers.add(violation.serverName);
    notes.push(violation.note);
    retained = retained.filter((server) => server.name !== violation.serverName);
    if (retained.length === 0) {
      return { dropServers, patterns: [...patterns], notes };
    }
  }
  return { dropServers, patterns: [...patterns], notes };
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

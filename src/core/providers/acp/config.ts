/**
 * ACP provider configuration, built-in Antigravity CLI (`agy acp`) preset, and
 * custom ACP agent entry validation.
 *
 * Launch arguments are tokenized into argv arrays via `tokenizeLaunchArgs`
 * (never concatenated into shell commands). Credentials are never read or
 * stored by Moxen — each ACP CLI owns its own login.
 */
import { expandHome } from "../../config.js";
import { CliError } from "../../errors.js";
import type { AcpAgentConfig, AcpProviderConfig } from "../../types.js";
import { tokenizeLaunchArgs } from "../codex/config.js";
import { AGY_ACP_LAUNCH_SPEC, type AcpAgentLaunchSpec } from "./transport.js";

/** Sentinel model slug meaning "use the ACP agent's own configured default". */
export const ACP_DEFAULT_MODEL_SLUG = "acp-default";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function resolveAcpModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim() ?? "";
  return !trimmed || trimmed === ACP_DEFAULT_MODEL_SLUG ? null : trimmed;
}

function fail(fieldPath: string, reason: string): never {
  throw new CliError("INVALID_CONFIG", `${fieldPath} ${reason}`, { details: { path: fieldPath } });
}

export function normalizeAcpAgent(raw: unknown, fieldPath: string): AcpAgentConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(fieldPath, "must be an object.");
  }
  const obj = raw as Record<string, unknown>;
  const rawId = typeof obj["id"] === "string" ? obj["id"].trim().toLowerCase() : "";
  if (!rawId || !AGENT_ID_RE.test(rawId)) {
    fail(`${fieldPath}.id`, "must be a lowercase slug (letters, digits, '.', '_', '-').");
  }
  const rawCommand = typeof obj["command"] === "string" ? obj["command"].trim() : "";
  if (!rawCommand) {
    fail(`${fieldPath}.command`, "must be a non-empty executable path or command name.");
  }
  let args: string[] | undefined;
  if (obj["args"] !== undefined) {
    if (!Array.isArray(obj["args"]) || !obj["args"].every((entry) => typeof entry === "string")) {
      fail(`${fieldPath}.args`, "must be an array of strings.");
    }
    args = [...(obj["args"] as string[])];
  }
  let launchArgs: string | undefined;
  if (obj["launchArgs"] !== undefined) {
    if (typeof obj["launchArgs"] !== "string") {
      fail(`${fieldPath}.launchArgs`, "must be a string.");
    }
    // Validate quotes immediately so malformed args fail at config load.
    try {
      tokenizeLaunchArgs(obj["launchArgs"]);
    } catch (cause) {
      fail(`${fieldPath}.launchArgs`, cause instanceof Error ? cause.message : "has invalid syntax.");
    }
    const trimmed = obj["launchArgs"].trim();
    if (trimmed.length > 0) launchArgs = trimmed;
  }
  let env: Record<string, string> | undefined;
  if (obj["env"] !== undefined) {
    if (obj["env"] === null || typeof obj["env"] !== "object" || Array.isArray(obj["env"])) {
      fail(`${fieldPath}.env`, "must be a string map.");
    }
    const entries: Record<string, string> = {};
    for (const [key, val] of Object.entries(obj["env"] as Record<string, unknown>)) {
      if (typeof val !== "string") fail(`${fieldPath}.env.${key}`, "must be a string.");
      entries[key] = val;
    }
    if (Object.keys(entries).length > 0) env = entries;
  }
  const name = typeof obj["name"] === "string" && obj["name"].trim().length > 0 ? obj["name"].trim() : undefined;
  const enabled = typeof obj["enabled"] === "boolean" ? obj["enabled"] : undefined;
  const defaultModel =
    typeof obj["defaultModel"] === "string" && obj["defaultModel"].trim().length > 0
      ? obj["defaultModel"].trim()
      : undefined;
  const defaultMode =
    typeof obj["defaultMode"] === "string" && obj["defaultMode"].trim().length > 0
      ? obj["defaultMode"].trim()
      : undefined;

  return {
    id: rawId,
    ...(name !== undefined ? { name } : {}),
    command: rawCommand,
    ...(args !== undefined ? { args } : {}),
    ...(launchArgs !== undefined ? { launchArgs } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(defaultMode !== undefined ? { defaultMode } : {}),
  };
}

export function normalizeAcpAgents(raw: unknown): AcpAgentConfig[] {
  if (!Array.isArray(raw)) {
    fail("providers.acp.agents", "must be a list.");
  }
  const seen = new Set<string>();
  const out: AcpAgentConfig[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const label =
      entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["id"] === "string"
        ? `providers.acp.agents[${(entry as Record<string, unknown>)["id"]}]`
        : `providers.acp.agents[${index}]`;
    const parsed = normalizeAcpAgent(entry, label);
    if (seen.has(parsed.id)) {
      fail("providers.acp.agents", `uses id "${parsed.id}" twice.`);
    }
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

export interface ResolvedAcpAgent extends AcpAgentLaunchSpec {
  readonly defaultModel?: string;
  readonly defaultMode?: string;
  readonly isPreset: boolean;
}

/**
 * Resolve all enabled ACP agents from `providers.acp`:
 * - Built-in `agy` preset (`binaryPath` or `"agy"`, `["acp", ...launchArgs]`),
 *   unless overridden or disabled by a custom entry with `id: "agy"`.
 * - Every enabled custom entry in `providers.acp.agents`.
 */
export function resolveAcpAgents(
  config: AcpProviderConfig | undefined,
): ResolvedAcpAgent[] {
  const custom = config?.agents ?? [];
  const byId = new Map<string, AcpAgentConfig>();
  for (const entry of custom) {
    byId.set(entry.id.trim().toLowerCase(), entry);
  }

  const resolved: ResolvedAcpAgent[] = [];
  const agyOverride = byId.get(AGY_ACP_LAUNCH_SPEC.id);
  if (!agyOverride) {
    const command = expandHome(config?.binaryPath?.trim() || AGY_ACP_LAUNCH_SPEC.command);
    const extra = config?.launchArgs?.trim() ? tokenizeLaunchArgs(config.launchArgs.trim()) : [];
    resolved.push({
      id: AGY_ACP_LAUNCH_SPEC.id,
      name: AGY_ACP_LAUNCH_SPEC.name ?? "Antigravity (agy)",
      command,
      args: [...AGY_ACP_LAUNCH_SPEC.args, ...extra],
      isPreset: true,
    });
  }

  for (const entry of custom) {
    if (entry.enabled === false) continue;
    const extra = entry.launchArgs?.trim() ? tokenizeLaunchArgs(entry.launchArgs.trim()) : [];
    const args = [...(entry.args ?? []), ...extra];
    resolved.push({
      id: entry.id.trim().toLowerCase(),
      name: entry.name ?? entry.id,
      command: expandHome(entry.command.trim()),
      args,
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
      ...(entry.defaultMode ? { defaultMode: entry.defaultMode } : {}),
      isPreset: false,
    });
  }

  return resolved;
}

export function resolveAcpAgentsMap(
  config: AcpProviderConfig | undefined,
): Record<string, AcpAgentLaunchSpec> {
  const map: Record<string, AcpAgentLaunchSpec> = {};
  for (const agent of resolveAcpAgents(config)) {
    map[agent.id] = agent;
  }
  return map;
}

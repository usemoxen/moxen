/**
 * ACP Registry (`agentclientprotocol.com/registry`) catalog loader, disk cache,
 * and safe argv launch-spec resolver.
 *
 * Fetches the pinned v1 registry (`ACP_REGISTRY_URL`), caches it under
 * `<storeRoot>/cache/acp-registry.json`, and falls back to the cached copy (or
 * an empty list) when offline or unreachable. Never invokes a shell and never
 * downloads packages during catalog listing.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { binaryOnPath } from "../../infra/process.js";
import { resolveStoreRoot } from "../../threads/store.js";
import { asNonEmptyString, asRecord } from "./protocol.js";
import type { AcpAgentLaunchSpec } from "./transport.js";

/** Pinned v1 ACP Registry manifest URL matching `ACP_PROTOCOL_VERSION = 1`. */
export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface AcpRegistryPackageDist {
  readonly package: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AcpRegistryBinaryTarget {
  readonly url: string;
  readonly cmd: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly sha256: string | null;
}

export interface AcpRegistryDistribution {
  readonly npx?: AcpRegistryPackageDist;
  readonly uvx?: AcpRegistryPackageDist;
  readonly binary?: Readonly<Record<string, AcpRegistryBinaryTarget>>;
}

export interface AcpRegistryAgent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly distribution: AcpRegistryDistribution;
}

export interface LoadedAcpRegistry {
  readonly agents: readonly AcpRegistryAgent[];
  readonly source: "network" | "cache" | "empty";
}

function parseStringMap(raw: unknown): Record<string, string> {
  const rec = asRecord(raw);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function parsePackageDist(raw: unknown): AcpRegistryPackageDist | undefined {
  const rec = asRecord(raw);
  const pkg = asNonEmptyString(rec?.["package"]);
  if (!pkg) return undefined;
  return {
    package: pkg,
    args: parseStringArray(rec?.["args"]),
    env: parseStringMap(rec?.["env"]),
  };
}

function parseBinaryDist(raw: unknown): Record<string, AcpRegistryBinaryTarget> | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const targetMap = asRecord(rec["targets"]) ?? rec;
  const out: Record<string, AcpRegistryBinaryTarget> = {};
  for (const [platformKey, entry] of Object.entries(targetMap)) {
    const item = asRecord(entry);
    const url = asNonEmptyString(item?.["archive"]) ?? asNonEmptyString(item?.["url"]);
    if (!url) continue;
    out[platformKey] = {
      url,
      cmd: asNonEmptyString(item?.["cmd"]),
      args: parseStringArray(item?.["args"]),
      env: parseStringMap(item?.["env"]),
      sha256: asNonEmptyString(item?.["sha256"]),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Defensive parse of an ACP Registry `registry.json` payload. */
export function parseAcpRegistry(raw: unknown): AcpRegistryAgent[] {
  const root = asRecord(raw);
  const rawList = Array.isArray(raw)
    ? raw
    : Array.isArray(root?.["agents"])
      ? root!["agents"]
      : [];
  const seen = new Set<string>();
  const agents: AcpRegistryAgent[] = [];
  for (const entry of rawList) {
    const item = asRecord(entry);
    const id = asNonEmptyString(item?.["id"])?.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    const distRaw = asRecord(item?.["distribution"]);
    if (!distRaw) continue;
    const npx = parsePackageDist(distRaw["npx"]);
    const uvx = parsePackageDist(distRaw["uvx"]);
    const binary = parseBinaryDist(distRaw["binary"]);
    if (!npx && !uvx && !binary) continue;
    seen.add(id);
    agents.push({
      id,
      name: asNonEmptyString(item?.["name"]) ?? id,
      version: asNonEmptyString(item?.["version"]) ?? "0.0.0",
      description: asNonEmptyString(item?.["description"]) ?? "",
      distribution: {
        ...(npx ? { npx } : {}),
        ...(uvx ? { uvx } : {}),
        ...(binary ? { binary } : {}),
      },
    });
  }
  return agents;
}

/** Candidate ACP Registry platform target keys for a Node platform + arch pair. */
export function acpRegistryPlatformKeys(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): readonly string[] {
  if (platform === "darwin") {
    return arch === "arm64" ? ["darwin-aarch64", "darwin-arm64"] : ["darwin-x86_64", "darwin-x64"];
  }
  if (platform === "win32") {
    return arch === "arm64"
      ? ["windows-aarch64", "windows-arm64", "win-arm64"]
      : ["windows-x86_64", "windows-x64", "win-x64"];
  }
  if (platform === "linux") {
    return arch === "arm64" ? ["linux-aarch64", "linux-arm64"] : ["linux-x86_64", "linux-x64"];
  }
  return [];
}

export type ResolvedRegistryLaunch =
  | { readonly ok: true; readonly spec: AcpAgentLaunchSpec; readonly runtime: "binary" | "npx" | "uvx" }
  | { readonly ok: false; readonly reason: "missing-runtime"; readonly runtime: "npx" | "uvx"; readonly message: string }
  | { readonly ok: false; readonly reason: "uninstalled-binary"; readonly target: AcpRegistryBinaryTarget; readonly message: string }
  | { readonly ok: false; readonly reason: "unsupported-platform"; readonly message: string };

/**
 * Resolve an ACP Registry manifest into a safe argv `AcpAgentLaunchSpec`
 * (never shell-joined), verifying runtime availability and platform support.
 */
export function resolveRegistryLaunchSpec(
  agent: AcpRegistryAgent,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly hasCommand?: (cmd: string, env: NodeJS.ProcessEnv) => boolean;
  } = {},
): ResolvedRegistryLaunch {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const hasCommand = options.hasCommand ?? binaryOnPath;
  const keys = acpRegistryPlatformKeys(platform, arch);

  // 1. Prefer a platform-matched binary whose command is already installed on PATH.
  let matchedBinary: AcpRegistryBinaryTarget | null = null;
  if (agent.distribution.binary) {
    for (const key of keys) {
      const target = agent.distribution.binary[key];
      if (target) {
        matchedBinary = target;
        if (target.cmd && hasCommand(target.cmd, env)) {
          return {
            ok: true,
            runtime: "binary",
            spec: {
              id: agent.id,
              name: agent.name,
              command: target.cmd,
              args: target.args,
              ...(Object.keys(target.env).length > 0 ? { env: target.env } : {}),
            },
          };
        }
        break;
      }
    }
  }

  // 2. Fallback to npx distribution.
  if (agent.distribution.npx) {
    const dist = agent.distribution.npx;
    if (hasCommand("npx", env)) {
      return {
        ok: true,
        runtime: "npx",
        spec: {
          id: agent.id,
          name: agent.name,
          command: "npx",
          args: ["-y", dist.package, ...dist.args],
          ...(Object.keys(dist.env).length > 0 ? { env: dist.env } : {}),
        },
      };
    }
    return {
      ok: false,
      reason: "missing-runtime",
      runtime: "npx",
      message: `Requires npx to launch ${agent.name}.`,
    };
  }

  // 3. Fallback to uvx distribution.
  if (agent.distribution.uvx) {
    const dist = agent.distribution.uvx;
    if (hasCommand("uvx", env)) {
      return {
        ok: true,
        runtime: "uvx",
        spec: {
          id: agent.id,
          name: agent.name,
          command: "uvx",
          args: [dist.package, ...dist.args],
          ...(Object.keys(dist.env).length > 0 ? { env: dist.env } : {}),
        },
      };
    }
    return {
      ok: false,
      reason: "missing-runtime",
      runtime: "uvx",
      message: `Requires uvx to launch ${agent.name}.`,
    };
  }

  // 4. Binary-only agent that is compatible with this platform but not installed locally.
  if (matchedBinary) {
    return {
      ok: false,
      reason: "uninstalled-binary",
      target: matchedBinary,
      message: `${agent.name} binary is not installed on PATH.`,
    };
  }

  return {
    ok: false,
    reason: "unsupported-platform",
    message: `${agent.name} has no compatible build for ${platform}/${arch}.`,
  };
}

export interface LoadAcpRegistryOptions {
  readonly storeRoot?: string;
  readonly url?: string;
  readonly ttlMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly forceRefresh?: boolean;
  /** When true, only reads the disk cache and never touches the network. */
  readonly offlineOnly?: boolean;
}

/**
 * Load the ACP Registry catalog with disk caching under `<storeRoot>/cache/acp-registry.json`
 * and graceful offline fallback.
 */
export async function loadAcpRegistryCatalog(
  options: LoadAcpRegistryOptions = {},
): Promise<LoadedAcpRegistry> {
  const storeRoot = options.storeRoot ?? resolveStoreRoot();
  const cachePath = path.join(storeRoot, "cache", "acp-registry.json");
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;

  let cached: AcpRegistryAgent[] | null = null;
  let cacheFresh = false;
  try {
    const info = await stat(cachePath);
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    cached = parseAcpRegistry(raw);
    cacheFresh = Date.now() - info.mtimeMs < ttlMs;
  } catch {
    // Cache absent or unreadable.
  }

  if (cached && cacheFresh && !options.forceRefresh) {
    return { agents: cached, source: "cache" };
  }
  if (options.offlineOnly) {
    return cached ? { agents: cached, source: "cache" } : { agents: [], source: "empty" };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(options.url ?? ACP_REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as unknown;
    const agents = parseAcpRegistry(json);
    await mkdir(path.dirname(cachePath), { recursive: true }).catch(() => undefined);
    await writeFile(cachePath, JSON.stringify({ agents }, null, 2), "utf8").catch(() => undefined);
    return { agents, source: "network" };
  } catch {
    if (cached) return { agents: cached, source: "cache" };
    return { agents: [], source: "empty" };
  }
}

export interface AcpRegistryPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly available: boolean;
  readonly note: string | null;
}

/**
 * Convert a registry agent into a client-ready preset with suggested argv
 * launch fields for the current platform, even when the runtime is not yet
 * installed on PATH.
 */
export function toRegistryPreset(
  agent: AcpRegistryAgent,
  options: Parameters<typeof resolveRegistryLaunchSpec>[1] = {},
): AcpRegistryPreset {
  const resolved = resolveRegistryLaunchSpec(agent, options);
  if (resolved.ok) {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      version: agent.version,
      command: resolved.spec.command,
      args: resolved.spec.args,
      ...(resolved.spec.env ? { env: resolved.spec.env } : {}),
      available: true,
      note: null,
    };
  }
  if (resolved.reason === "missing-runtime") {
    const dist = resolved.runtime === "npx" ? agent.distribution.npx : agent.distribution.uvx;
    if (dist) {
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        version: agent.version,
        command: resolved.runtime,
        args: resolved.runtime === "npx" ? ["-y", dist.package, ...dist.args] : [dist.package, ...dist.args],
        ...(Object.keys(dist.env).length > 0 ? { env: dist.env } : {}),
        available: false,
        note: resolved.message,
      };
    }
  }
  if (resolved.reason === "uninstalled-binary") {
    const cmd = resolved.target.cmd ? path.basename(resolved.target.cmd) : null;
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      version: agent.version,
      command: cmd,
      args: resolved.target.args,
      ...(Object.keys(resolved.target.env).length > 0 ? { env: resolved.target.env } : {}),
      available: false,
      note: resolved.message,
    };
  }
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    version: agent.version,
    command: null,
    args: [],
    available: false,
    note: resolved.message,
  };
}

/**
 * What this running Moxen is: its version, where it lives, and whether it is a release install (unpacked from
 * a release archive) or a source checkout. Read-only.
 *
 * The kind comes from `release.json`, which `scripts/package-release.ts` writes into the archive folder on
 * purpose. Anything without a valid marker is `source`: a checkout, a worktree, a plain copy, a dev run from
 * `src/`. The default is `source` so a mistake can never make a checkout look updatable.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MARKER, releaseTarget, type ReleaseMarker, type ReleaseTarget } from "../release.js";
import type { InstallInfo, InstallKind } from "./vocabulary.js";
import { APP_VERSION } from "../version.js";

/** The folder above `from` that holds `package.json` (the same walk bundled mods use), or null. */
export function installFolder(from = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let folder = from;
  while (!existsSync(path.join(folder, "package.json"))) {
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return folder;
}

function platformTarget(platform: string, arch: string): ReleaseTarget | null {
  try {
    return releaseTarget(platform, arch);
  } catch {
    return null;
  }
}

function readMarker(folder: string): ReleaseMarker | null {
  try {
    const value = JSON.parse(readFileSync(path.join(folder, RELEASE_MARKER), "utf8")) as Partial<ReleaseMarker> | null;
    if (value === null || typeof value !== "object") return null;
    if (typeof value.version !== "string" || typeof value.os !== "string" || typeof value.arch !== "string") return null;
    return { version: value.version, os: value.os, arch: value.arch } as ReleaseMarker;
  } catch {
    return null;
  }
}

export interface ReadInstallOptions {
  readonly from?: string;
  readonly version?: string;
  readonly platform?: string;
  readonly arch?: string;
}

/**
 * `release` only when the folder has a marker whose version is the one running and whose platform is this
 * one, and it is not a checkout (no `src/`, no `.git`). Every other case is `source`.
 */
export function readInstall(options: ReadInstallOptions = {}): InstallInfo {
  const version = options.version ?? APP_VERSION;
  const target = platformTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const folder = installFolder(options.from);
  const info = (kind: InstallKind): InstallInfo => ({
    version,
    kind,
    folder,
    target: target === null ? null : { os: target.os, arch: target.arch },
  });
  if (folder === null || target === null) return info("source");
  const marker = readMarker(folder);
  if (marker === null || marker.version !== version || marker.os !== target.os || marker.arch !== target.arch) return info("source");
  if (existsSync(path.join(folder, "src")) || existsSync(path.join(folder, ".git"))) return info("source");
  return info("release");
}

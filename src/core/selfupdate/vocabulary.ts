/**
 * The vocabulary of "what is installed and is there a newer release": the shapes the server answers with and
 * the version order, shared by the server, the check and the CLI. Pure; reading the install is `install.ts`
 * and asking GitHub is `check.ts`.
 */
import type { ReleaseArch, ReleaseOs } from "../release.js";

export type InstallKind = "release" | "source";

export interface InstallInfo {
  readonly version: string;
  readonly kind: InstallKind;
  /** The folder holding `package.json`: the archive's folder, or the checkout. Null when none was found. */
  readonly folder: string | null;
  /** This platform's release target, null on a platform with no release. */
  readonly target: { readonly os: ReleaseOs; readonly arch: ReleaseArch } | null;
}

export type UpdateStatus = "up-to-date" | "available" | "no-release" | "unavailable";

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number | null;
}

export interface LatestRelease {
  /** `0.2.0`, without the tag's `v`. */
  readonly version: string;
  readonly tag: string;
  /** The release's page. */
  readonly url: string;
  /** The release notes, as written. */
  readonly notes: string;
  /** This platform's archive and its checksum file, null where the release has none. */
  readonly archive: ReleaseAsset | null;
  readonly checksum: ReleaseAsset | null;
}

export interface UpdateCheck {
  readonly install: InstallInfo;
  readonly status: UpdateStatus;
  /** Why the status is `unavailable`, in a few words; null otherwise. */
  readonly reason: string | null;
  /** The newest release; null for `no-release`, and for an `unavailable` that never got an answer. */
  readonly latest: LatestRelease | null;
  /** Only a release install with a newer release that has this platform's archive and checksum. */
  readonly updatable: boolean;
}

interface Semver {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

export function parseVersion(raw: string): Semver | null {
  const match = raw.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

export function isPrerelease(raw: string): boolean {
  return (parseVersion(raw)?.pre.length ?? 0) > 0;
}

/** Semver order: negative when `a < b`, null when either is not a version. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index]! - right.core[index]!;
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    if (/^\d+$/.test(x)) return -1;
    if (/^\d+$/.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}


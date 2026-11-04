/**
 * The naming rules of a Moxen release, pure: which platforms have one, what its archive and checksum file are
 * called, and the tag it is made from. `scripts/` packs releases by these rules and the server looks for them
 * in GitHub's answer, so there is one copy.
 */

export type ReleaseOs = "macos" | "windows";
export type ReleaseArch = "arm64" | "x64";

export interface ReleaseTarget {
  readonly os: ReleaseOs;
  readonly arch: ReleaseArch;
  /** The `@opentui/core-*` package that holds this platform's native library. */
  readonly nativePackage: string;
  readonly extension: "tar.gz" | "zip";
}

/** The release target for a Node/Bun `process.platform` and `process.arch`; throws for any other. */
export function releaseTarget(platform: string, arch: string): ReleaseTarget {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`No Moxen release for the ${arch} architecture`);
  if (platform === "darwin") return { os: "macos", arch, nativePackage: `@opentui/core-darwin-${arch}`, extension: "tar.gz" };
  if (platform === "win32") return { os: "windows", arch, nativePackage: `@opentui/core-win32-${arch}`, extension: "zip" };
  throw new Error(`No Moxen release for ${platform}`);
}

/** The target named by its OS and architecture, as the marker and the wire say them. */
export function releaseTargetOf(os: ReleaseOs, arch: ReleaseArch): ReleaseTarget {
  return releaseTarget(os === "macos" ? "darwin" : "win32", arch);
}

/** `moxen-0.1.2-macos-arm64`: the archive's name without extension, and its single top-level folder. */
export function releaseBaseName(version: string, target: ReleaseTarget): string {
  return `moxen-${version}-${target.os}-${target.arch}`;
}

export function archiveFileName(version: string, target: ReleaseTarget): string {
  return `${releaseBaseName(version, target)}.${target.extension}`;
}

/** The checksum file published beside an archive. */
export function checksumFileName(version: string, target: ReleaseTarget): string {
  return `${archiveFileName(version, target)}.sha256`;
}

/** The tag a release of this version is made from. */
export function tagForVersion(version: string): string {
  return `v${version}`;
}

/** Null when the tag is `v<version>`; otherwise why not. */
export function tagMismatch(tag: string, version: string): string | null {
  const expected = tagForVersion(version);
  return tag === expected ? null : `Tag ${tag} does not match package.json version ${version} (expected ${expected})`;
}

/** The file `package-release.ts` writes into the archive folder, beside `package.json`, to say it is a release. */
export const RELEASE_MARKER = "release.json";

/** What the marker holds. */
export interface ReleaseMarker {
  readonly version: string;
  readonly os: ReleaseOs;
  readonly arch: ReleaseArch;
}

export function releaseMarker(version: string, target: ReleaseTarget): ReleaseMarker {
  return { version, os: target.os, arch: target.arch };
}

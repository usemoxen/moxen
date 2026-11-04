/** Pure rules for release archives, shared by `package-release.ts`, `smoke-release.ts` and the release workflow. */
import path from "node:path";

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

/** `moxen-0.1.2-macos-arm64`: the archive's name without extension, and its single top-level folder. */
export function releaseBaseName(version: string, target: ReleaseTarget): string {
  return `moxen-${version}-${target.os}-${target.arch}`;
}

export function archiveFileName(version: string, target: ReleaseTarget): string {
  return `${releaseBaseName(version, target)}.${target.extension}`;
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

export interface ArchiveCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * The tar invocation that packs `folder` (a directory inside `parent`) into `archive`, or unpacks `archive`
 * into `destination`. Windows uses the system bsdtar, which writes and reads zip: Git Bash's own `tar` is GNU
 * tar and does neither, and it comes first on PATH there.
 */
export function packCommand(target: ReleaseTarget, archive: string, parent: string, folder: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return target.extension === "zip"
    ? { command: windowsTar(env), args: ["-a", "-c", "-f", archive, "-C", parent, folder] }
    : { command: "tar", args: ["-czf", archive, "-C", parent, folder] };
}

export function unpackCommand(target: ReleaseTarget, archive: string, destination: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return { command: target.extension === "zip" ? windowsTar(env) : "tar", args: ["-xf", archive, "-C", destination] };
}

function windowsTar(env: NodeJS.ProcessEnv): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "tar.exe");
}

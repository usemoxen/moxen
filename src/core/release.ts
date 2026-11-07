/**
 * The naming rules of a Moxen release, pure: which platforms have one, what its archive and checksum file are
 * called, and the tag it is made from. `scripts/` packs releases by these rules and the server looks for them
 * in GitHub's answer, so there is one copy.
 */

import path from "node:path";

/** The GitHub repository releases are published from. */
export const RELEASES_REPOSITORY = "usemoxen/moxen";

export type ReleaseOs = "macos" | "windows";
export type ReleaseArch = "arm64" | "x64";

export interface ReleaseTarget {
  readonly os: ReleaseOs;
  readonly arch: ReleaseArch;
  /** The `@opentui/core-*` package that holds this platform's native library. */
  readonly nativePackage: string;
  readonly extension: "tar.gz" | "zip";
}

/** The release target for a Node/Bun `process.platform` and `process.arch`; throws for anything else. */
export function releaseTarget(platform: string, arch: string): ReleaseTarget {
  if (platform === "darwin" && arch === "arm64") return { os: "macos", arch, nativePackage: "@opentui/core-darwin-arm64", extension: "tar.gz" };
  if (platform === "win32" && arch === "x64") return { os: "windows", arch, nativePackage: "@opentui/core-win32-x64", extension: "zip" };
  if (platform !== "darwin" && platform !== "win32") throw new Error(`No Moxen release for ${platform}`);
  throw new Error(`No Moxen release for the ${arch} architecture`);
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

export interface ArchiveCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * The tar invocation that packs `folder` (a directory inside `parent`) into `archive`, or unpacks `archive`
 * into `destination`. Windows uses the system bsdtar, which writes and reads zip: Git Bash's own `tar` is GNU
 * tar and does neither, and it comes first on PATH there. Argument arrays only, never a joined command line.
 */
export function packCommand(target: ReleaseTarget, archive: string, parent: string, folder: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return target.extension === "zip"
    ? { command: windowsTar(env), args: ["-a", "-c", "-f", archive, "-C", parent, folder] }
    : { command: "tar", args: ["-czf", archive, "-C", parent, folder] };
}

export function unpackCommand(target: ReleaseTarget, archive: string, destination: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return { command: target.extension === "zip" ? windowsTar(env) : "tar", args: ["-xf", archive, "-C", destination] };
}

/** The command that lists an archive's entry names, one per line, without unpacking it. */
export function listCommand(target: ReleaseTarget, archive: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return { command: target.extension === "zip" ? windowsTar(env) : "tar", args: ["-tf", archive] };
}

function windowsTar(env: NodeJS.ProcessEnv): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "tar.exe");
}

/** The one-line installers published beside every release's archives. */
export const INSTALL_SCRIPT_POSIX = "install.sh";
export const INSTALL_SCRIPT_WINDOWS = "install.ps1";

/** `https://github.com/usemoxen/moxen/releases/download/v0.1.2/install.sh`: an asset of one release. */
export function releaseAssetUrl(tag: string, file: string): string {
  return `https://github.com/${RELEASES_REPOSITORY}/releases/download/${tag}/${file}`;
}

/**
 * The install steps for a release's notes, in markdown. One source: the release workflow puts this above
 * the changelog (`scripts/release-notes.ts`), and the README says the same for the latest release.
 */
export function releaseInstallNotes(version: string): string {
  const tag = tagForVersion(version);
  const macos = releaseTargetOf("macos", "arm64");
  const windows = releaseTargetOf("windows", "x64");
  const macosArchive = archiveFileName(version, macos);
  const windowsArchive = archiveFileName(version, windows);
  const macosChecksum = checksumFileName(version, macos);
  const windowsChecksum = checksumFileName(version, windows);
  return [
    "## Install",
    "",
    "macOS on Apple silicon, one line:",
    "",
    "```sh",
    `curl -fsSL ${releaseAssetUrl(tag, INSTALL_SCRIPT_POSIX)} | sh`,
    "```",
    "",
    "Windows on x64, one line (PowerShell):",
    "",
    "```powershell",
    `irm ${releaseAssetUrl(tag, INSTALL_SCRIPT_WINDOWS)} | iex`,
    "```",
    "",
    "The script downloads this release's archive and `.sha256`, installs Bun first when it is missing,",
    "refuses a checksum mismatch, runs `self-update --install`, and puts Moxen on your PATH: a snippet in",
    "your shell profile on macOS, the user Path on Windows (set `MOXEN_INSTALL_NO_PATH=1` to skip).",
    "Linux and Intel Macs have no build and are refused with a message.",
    "",
    `By hand instead, download \`${macosArchive}\` and \`${macosChecksum}\` (macOS)`,
    `or \`${windowsArchive}\` and \`${windowsChecksum}\` (Windows) from this release,`,
    "check the archive, and install. macOS:",
    "",
    "```sh",
    `shasum -a 256 -c ${macosChecksum}`,
    `tar -xzf ${macosArchive}`,
    `bun ${releaseBaseName(version, macos)}/dist/cli/index.js self-update --install`,
    "```",
    "",
    "Windows (PowerShell):",
    "",
    "```powershell",
    `$archive = "${windowsArchive}"; $expected = ((Get-Content "$archive.sha256") -split '\\s+')[0]`,
    `if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw 'checksum mismatch' }`,
    `tar -xf ${windowsArchive}`,
    `bun ${releaseBaseName(version, windows)}/dist/cli/index.js self-update --install`,
    "```",
    "",
    "`self-update --install` copies the release to `~/.moxen/app/versions/<version>/`, records it in",
    "`~/.moxen/app/current`, writes a `moxen` launcher (`moxen.cmd` on Windows) in `~/.moxen/app/bin`,",
    "and prints how to put that folder on your PATH. It edits no shell profile. After that you can delete",
    "the unpacked folder. The builds are not signed or notarized. To update later, run `moxen self-update`.",
  ].join("\n");
}

/**
 * The full notes for a release: the install steps, then the changelog below them. A blank changelog leaves
 * just the install steps; otherwise the changelog follows verbatim after a rule.
 */
export function releaseNotesBody(version: string, changelog: string): string {
  const notes = releaseInstallNotes(version);
  if (changelog.trim() === "") return `${notes}\n`;
  return `${notes}\n\n---\n\n${changelog.trimEnd()}\n`;
}

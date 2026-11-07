/**
 * Unpacks a release archive outside the checkout and runs it:
 *
 *   bun scripts/smoke-release.ts <archive> [--embeddings] [--remove <path inside the archive folder>]
 *
 * It checks the folder layout, that the bundle reports the version in `package.json`, and that the native
 * OpenTUI package loads from the unpacked folder. `--embeddings` also runs `verify-memory-embeddings.ts` against
 * the unpacked daemon. `--remove` deletes a path first, to prove the check fails when something is missing.
 * Without any network it also checks `scripts/release-notes.ts` names this archive above the changelog,
 * `install.sh` refuses platforms with no build on every runner (Git Bash provides its `sh`), and `install.ps1`
 * does on Windows.
 * It also installs the unpacked release into a throwaway store and starts it through the launcher (see below),
 * then updates that install to a copy of the archive that reports a higher version (the core function, in-process,
 * with an injected fetch: no setting can point a real `moxen` at another download), checks the launcher runs it,
 * rolls back and checks the launcher runs the old one again, and that a wrong checksum leaves `current` alone.
 * Nothing here starts a server or touches `~/.moxen`: the commands run with a throwaway store.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appLayout } from "../src/core/selfupdate/installer.js";
import { rollbackRelease, updateRelease } from "../src/core/selfupdate/update.js";
import { LATEST_RELEASE_URL } from "../src/core/selfupdate/check.js";
import { RELEASE_MARKER, archiveFileName, checksumFileName, packCommand, releaseBaseName, releaseMarker, releaseTarget, unpackCommand } from "./release-lib.js";

const checkout = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flagValue = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const archive = args.find((arg, at) => !arg.startsWith("--") && args[at - 1] !== "--remove");
if (!archive) throw new Error("Usage: bun scripts/smoke-release.ts <archive> [--embeddings] [--remove <path>]");

const target = releaseTarget(process.platform, process.arch);
const manifest = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8")) as { version: string };
const base = releaseBaseName(manifest.version, target);

const scratch = mkdtempSync(path.join(os.tmpdir(), "moxen-smoke-"));
// Resolution walks up from the unpacked files: a scratch folder inside the checkout would find its node_modules.
const outside = path.relative(realpathSync.native(checkout), realpathSync.native(scratch));
assert.ok(outside.startsWith("..") || path.isAbsolute(outside), "scratch folder must be outside the checkout");

const run = (command: string, commandArgs: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", cwd: options.cwd, env: options.env ?? process.env, timeout: 120_000 });
  if (result.error) throw result.error;
  return result;
};

try {
  const unpack = unpackCommand(target, path.resolve(archive), scratch);
  const unpacked = run(unpack.command, unpack.args);
  assert.equal(unpacked.status, 0, `unpacking failed: ${unpacked.stderr}`);
  assert.deepEqual(readdirSync(scratch), [base], "the archive must hold one top-level folder named after it");
  const folder = path.join(scratch, base);

  const remove = flagValue("--remove");
  if (remove) rmSync(path.join(folder, remove), { recursive: true, force: true });

  for (const entry of ["dist/cli/index.js", "dist/server/daemon.js", "dist/server/mcp/entry.js", "mods/agent-skills", "package.json", RELEASE_MARKER, "README.md", "LICENSE", "node_modules"]) {
    assert.ok(existsSync(path.join(folder, ...entry.split("/"))), `${entry} is missing from the archive`);
  }

  assert.deepEqual(JSON.parse(readFileSync(path.join(folder, RELEASE_MARKER), "utf8")), releaseMarker(manifest.version, target), `${RELEASE_MARKER} does not describe this release`);

  // A throwaway store, and no way back to the checkout's packages.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOXEN_STORE_ROOT: path.join(scratch, "store"),
    MOXEN_CONFIG: path.join(scratch, "store", "config.json"),
  };
  delete env.NODE_PATH;

  const version = run(process.execPath, [path.join(folder, "dist", "cli", "index.js"), "--version"], { cwd: folder, env });
  assert.equal(version.status, 0, `--version failed: ${version.stderr}`);
  assert.equal(version.stdout.trim(), manifest.version, "the bundle reports a version other than package.json's");
  const shipped = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8")) as { version: string };
  assert.equal(shipped.version, manifest.version);

  // The bundle imports the native package by name and opens the library it points at; do the same from the folder.
  const probe = [
    `import { dlopen } from "bun:ffi";`,
    `const resolved = import.meta.resolve(${JSON.stringify(target.nativePackage)});`,
    `const library = (await import(${JSON.stringify(target.nativePackage)})).default;`,
    // Opening the library and calling into it proves it loads here. OpenTUI binds this symbol itself on every platform;
    // the layout engine's own (`YG*`) are not exported on Windows.
    `const { symbols } = dlopen(library, { getArenaAllocatedBytes: { args: [], returns: "u64" } });`,
    `symbols.getArenaAllocatedBytes();`,
    `console.log(JSON.stringify({ resolved, library }));`,
  ].join("\n");
  const native = run(process.execPath, ["--eval", probe], { cwd: folder, env });
  assert.equal(native.status, 0, `${target.nativePackage} does not load from the archive: ${native.stderr}`);
  const { library } = JSON.parse(native.stdout.trim().split("\n").pop()!) as { library: string };
  assert.ok(realpathSync.native(library).startsWith(realpathSync.native(folder) + path.sep), `${target.nativePackage} resolved outside the archive: ${library}`);
  console.log(`ok: layout, version ${manifest.version}, ${target.nativePackage}`);

  // The notes the workflow publishes come from one source: the generator must name this archive above
  // the changelog, and the install scripts must refuse platforms with no build without any network.
  const changelogFile = path.join(scratch, "changelog.md");
  writeFileSync(changelogFile, "## What's changed\n* something in #1\n");
  const notes = run(process.execPath, [path.join(checkout, "scripts", "release-notes.ts"), manifest.version, "--changelog", changelogFile], { cwd: scratch, env });
  assert.equal(notes.status, 0, `release-notes failed: ${notes.stderr}`);
  assert.ok(notes.stdout.indexOf("## Install") < notes.stdout.indexOf("## What's changed"), "the install steps are not above the changelog");
  assert.ok(notes.stdout.includes(base), "the notes do not name this release's archive");
  assert.ok(notes.stdout.includes(checksumFileName(manifest.version, target)), "the notes do not name this release's checksum");
  console.log("ok: release notes name this archive above the changelog");
  // A stubbed `uname` proves the refusal paths: the script asks GitHub only after they pass.
  // Git Bash provides `sh` on every workflow runner, so this runs on Windows too.
  const stubBin = path.join(scratch, "stub bin");
  mkdirSync(stubBin);
  const refusedInstall = (system: string, machine: string, pattern: RegExp): void => {
    writeFileSync(path.join(stubBin, "uname"), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo "${system}"; else echo "${machine}"; fi\n`, { mode: 0o755 });
    const refused = run("sh", [path.join(checkout, "install.sh")], { env: { ...process.env, PATH: `${stubBin}${path.delimiter}${process.env.PATH}` } });
    assert.notEqual(refused.status, 0, `install.sh ran on ${system}/${machine}`);
    assert.match(`${refused.stdout}${refused.stderr}`, pattern, `install.sh refused ${system}/${machine} unclearly`);
  };
  refusedInstall("Linux", "x86_64", /no Moxen release for Linux/);
  refusedInstall("Darwin", "x86_64", /only Apple silicon/);
  console.log("ok: install.sh refuses platforms with no build");
  if (process.platform === "win32") {
    // A wrong architecture refuses before any download.
    const refused = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(checkout, "install.ps1")], { env: { ...process.env, PROCESSOR_ARCHITECTURE: "ARM64" } });
    assert.notEqual(refused.status, 0, "install.ps1 ran on ARM64");
    assert.match(`${refused.stdout}${refused.stderr}`, /only Windows x64/, "install.ps1 refused ARM64 unclearly");
    console.log("ok: install.ps1 refuses platforms with no build");
  }

  if (args.includes("--embeddings")) {
    const verify = spawnSync(process.execPath, [path.join(checkout, "scripts", "verify-memory-embeddings.ts"), "--dist", path.join(folder, "dist")], { stdio: "inherit", cwd: scratch, env: process.env });
    assert.equal(verify.status, 0, "memory embeddings failed against the archive");
    console.log("ok: memory embeddings");
  }

  // Install from the unpacked folder into a throwaway store (its path holds a space, as a Windows user folder can),
  // start through the launcher from a working directory with a space, then delete the source: the copy must stand alone.
  const installStore = path.join(scratch, "install store");
  const installEnv: NodeJS.ProcessEnv = { ...env, MOXEN_STORE_ROOT: installStore, MOXEN_CONFIG: path.join(installStore, "config.json") };
  const install = () => {
    const result = run(process.execPath, [path.join(folder, "dist", "cli", "index.js"), "self-update", "--install", "--json"], { cwd: folder, env: installEnv });
    assert.equal(result.status, 0, `--install failed: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout) as { ok: true; data: { version: string; folder: string; current: string; launcher: string; alreadyInstalled: boolean } };
  };
  const first = install().data;
  assert.equal(first.alreadyInstalled, false);
  assert.equal(first.version, manifest.version);
  assert.ok(path.resolve(first.current).startsWith(path.resolve(installStore) + path.sep), "install wrote outside the throwaway store");
  assert.equal(readFileSync(first.current, "utf8").trim(), manifest.version, "current does not name the version");
  // A second install from the same source is safe: the version is left as it is.
  const second = install().data;
  assert.equal(second.alreadyInstalled, true);
  assert.deepEqual(readdirSync(path.join(installStore, "app", "versions")), [manifest.version]);
  assert.equal(readFileSync(second.current, "utf8").trim(), manifest.version);
  console.log("ok: repeat install changes nothing");
  const workdir = path.join(scratch, "work dir");
  mkdirSync(workdir);
  const launch = () => {
    if (process.platform === "win32") {
      // /s strips the outer quotes of the command line; verbatim arguments stop Node adding backslash-escapes cmd does not read.
      const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${first.launcher}" --version"`], { encoding: "utf8", cwd: workdir, env: installEnv, timeout: 120_000, windowsVerbatimArguments: true });
      if (result.error) throw result.error;
      return result;
    }
    return run(first.launcher, ["--version"], { cwd: workdir, env: installEnv });
  };
  const launched = launch();
  assert.equal(launched.status, 0, `the launcher failed: ${launched.stderr}`);
  assert.equal(launched.stdout.trim(), manifest.version, "the launcher runs a different version");
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const alone = launch();
  assert.equal(alone.status, 0, `the installed copy does not run without the unpacked folder: ${alone.stderr}`);
  assert.equal(alone.stdout.trim(), manifest.version);
  console.log(`ok: install, launcher (${path.basename(first.launcher)}) in a folder with spaces`);
  // From inside versions it only sets current and rewrites the launcher.
  const inside = run(process.execPath, [path.join(first.folder, "dist", "cli", "index.js"), "self-update", "--install", "--json"], { cwd: workdir, env: installEnv });
  assert.equal(inside.status, 0, `install from inside versions failed: ${inside.stdout}${inside.stderr}`);
  assert.deepEqual(readdirSync(path.join(installStore, "app", "versions")), [manifest.version]);
  console.log("ok: install from the installed copy");

  // Update to a copy of the real archive that reports a higher version, served by an injected fetch.
  const [major, minor, patch] = manifest.version.split(".").map(Number) as [number, number, number];
  const higher = `${major}.${minor}.${patch + 1}`;
  const fakeParent = path.join(scratch, "fake release");
  mkdirSync(fakeParent);
  const reopen = unpackCommand(target, path.resolve(archive), fakeParent);
  const reopened = run(reopen.command, reopen.args);
  assert.equal(reopened.status, 0, `unpacking the copy failed: ${reopened.stderr}`);
  const fakeFolder = path.join(fakeParent, releaseBaseName(higher, target));
  renameSync(path.join(fakeParent, base), fakeFolder);
  // The version is compiled into the bundle's chunks as a quoted string; `--version` below proves every spot was found.
  const patchVersion = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) patchVersion(full);
      else if (full.endsWith(".js")) {
        const text = readFileSync(full, "utf8");
        if (text.includes(`"${manifest.version}"`)) writeFileSync(full, text.replaceAll(`"${manifest.version}"`, `"${higher}"`));
      }
    }
  };
  patchVersion(path.join(fakeFolder, "dist"));
  writeFileSync(path.join(fakeFolder, "package.json"), readFileSync(path.join(fakeFolder, "package.json"), "utf8").replace(`"version": "${manifest.version}"`, `"version": "${higher}"`));
  writeFileSync(path.join(fakeFolder, RELEASE_MARKER), JSON.stringify(releaseMarker(higher, target)));
  const fakeArchive = path.join(fakeParent, archiveFileName(higher, target));
  const pack = packCommand(target, fakeArchive, fakeParent, path.basename(fakeFolder));
  const packed = run(pack.command, pack.args);
  assert.equal(packed.status, 0, `packing the copy failed: ${packed.stderr}`);
  const fakeBytes = readFileSync(fakeArchive);
  const fakeSum = createHash("sha256").update(fakeBytes).digest("hex");

  const download = "https://releases.example.test/moxen";
  const serve = (checksum: string): typeof fetch =>
    (async (url: string | URL | Request): Promise<Response> => {
      const address = String(url);
      if (address === LATEST_RELEASE_URL) {
        const assets = [archiveFileName(higher, target), checksumFileName(higher, target)].map((name) => ({ name, browser_download_url: `${download}/${name}`, state: "uploaded", size: 1 }));
        return new Response(JSON.stringify({ tag_name: `v${higher}`, html_url: `${download}/notes`, body: "", draft: false, prerelease: false, assets }));
      }
      if (address === `${download}/${archiveFileName(higher, target)}`) return new Response(new Uint8Array(fakeBytes));
      if (address === `${download}/${checksumFileName(higher, target)}`) return new Response(`${checksum}  ${archiveFileName(higher, target)}\n`);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  const layout = appLayout(installEnv);
  const updateOptions = (doFetch: typeof fetch) => ({ from: first.folder, layout, fetch: doFetch });
  const current = () => readFileSync(layout.current, "utf8").trim();
  const launched2 = (): string => {
    const result = launch();
    assert.equal(result.status, 0, `the launcher failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  await assert.rejects(updateRelease(updateOptions(serve("0".repeat(64)))), { code: "SELF_UPDATE_CHECKSUM_MISMATCH" });
  assert.equal(current(), manifest.version, "a wrong checksum changed current");
  assert.deepEqual(readdirSync(layout.versions), [manifest.version], "a wrong checksum left something in versions");
  console.log("ok: a wrong checksum leaves current alone");

  const stages: string[] = [];
  const updated = await updateRelease({ ...updateOptions(serve(fakeSum)), onProgress: (progress) => void (stages.at(-1) === progress.stage || stages.push(progress.stage)) });
  assert.deepEqual(stages, ["checking", "downloading", "verifying", "unpacking", "testing", "switching", "done"], "the update reported its stages out of order");
  assert.equal(updated.action, "updated");
  assert.equal(updated.version, higher);
  assert.equal(current(), higher);
  assert.equal(launched2(), higher, "the launcher does not run the updated version");
  console.log(`ok: update to ${higher}, the launcher runs it`);

  const back = await rollbackRelease({ from: first.folder, layout });
  assert.equal(back.version, manifest.version);
  assert.equal(current(), manifest.version);
  assert.equal(launched2(), manifest.version, "the launcher does not run the old version after a rollback");
  assert.deepEqual(readdirSync(layout.versions).sort(), [manifest.version, higher].sort());
  console.log("ok: rollback, the launcher runs the old version");
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

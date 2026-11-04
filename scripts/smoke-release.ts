/**
 * Unpacks a release archive outside the checkout and runs it:
 *
 *   bun scripts/smoke-release.ts <archive> [--embeddings] [--remove <path inside the archive folder>]
 *
 * It checks the folder layout, that the bundle reports the version in `package.json`, and that the native
 * OpenTUI package loads from the unpacked folder. `--embeddings` also runs `verify-memory-embeddings.ts` against
 * the unpacked daemon. `--remove` deletes a path first, to prove the check fails when something is missing.
 * It also installs the unpacked release into a throwaway store and starts it through the launcher (see below).
 * Nothing here starts a server or touches `~/.moxen`: the commands run with a throwaway store.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELEASE_MARKER, releaseBaseName, releaseMarker, releaseTarget, unpackCommand } from "./release-lib.js";

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

  if (args.includes("--embeddings")) {
    const verify = spawnSync(process.execPath, [path.join(checkout, "scripts", "verify-memory-embeddings.ts"), "--dist", path.join(folder, "dist")], { stdio: "inherit", cwd: scratch, env: process.env });
    assert.equal(verify.status, 0, "memory embeddings failed against the archive");
    console.log("ok: memory embeddings");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

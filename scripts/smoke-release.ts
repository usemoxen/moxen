/**
 * Unpacks a release archive outside the checkout and runs it:
 *
 *   bun scripts/smoke-release.ts <archive> [--embeddings] [--remove <path inside the archive folder>]
 *
 * It checks the folder layout, that the bundle reports the version in `package.json`, and that the native
 * OpenTUI package loads from the unpacked folder. `--embeddings` also runs `verify-memory-embeddings.ts` against
 * the unpacked daemon. `--remove` deletes a path first, to prove the check fails when something is missing.
 * Nothing here starts a server or touches `~/.moxen`: the commands run with a throwaway store.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { releaseBaseName, releaseTarget, unpackCommand } from "./release-lib.js";

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

  for (const entry of ["dist/cli/index.js", "dist/server/daemon.js", "dist/server/mcp/entry.js", "mods/agent-skills", "package.json", "README.md", "LICENSE", "node_modules"]) {
    assert.ok(existsSync(path.join(folder, ...entry.split("/"))), `${entry} is missing from the archive`);
  }

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

  if (args.includes("--embeddings")) {
    const verify = spawnSync(process.execPath, [path.join(checkout, "scripts", "verify-memory-embeddings.ts"), "--dist", path.join(folder, "dist")], { stdio: "inherit", cwd: scratch, env: process.env });
    assert.equal(verify.status, 0, "memory embeddings failed against the archive");
    console.log("ok: memory embeddings");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

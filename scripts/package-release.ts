/**
 * Packs one release archive for the platform this runs on:
 *
 *   bun scripts/package-release.ts [--out <dir>]        (default: release/ in the checkout)
 *
 * writes `moxen-<version>-<os>-<arch>.tar.gz|zip` and a `.sha256` file beside it. The archive has one
 * top-level folder holding a standalone executable (`moxen`, `moxen.exe` on Windows: nothing else
 * needs installing to run it) beside the bundle (`dist/`), `mods/`, `package.json`, `release.json`
 * (the marker that makes it a release install), the licenses, and the one dependency the bundle still
 * loads from disk: this platform's native OpenTUI package. Everything else the executable needs is
 * compiled into it; the bundle stays for updates from older releases and as the launcher's fallback.
 *
 * The bundle and the executable are both built here into a clean folder, never taken from `dist/`,
 * which can hold older chunks and which a running Moxen is loading from.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveFileName, executableName, packCommand, RELEASE_MARKER, releaseBaseName, releaseMarker, releaseTarget } from "./release-lib.js";

const root = path.resolve(import.meta.dir, "..");
const outFlag = process.argv.indexOf("--out");
const outDir = path.resolve(outFlag >= 0 && process.argv[outFlag + 1] ? process.argv[outFlag + 1]! : path.join(root, "release"));

const run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (${result.status})`);
};

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const target = releaseTarget(process.platform, process.arch);
const base = releaseBaseName(manifest.version, target);
const staging = mkdtempSync(path.join(os.tmpdir(), "moxen-release-"));
try {
  const folder = path.join(staging, base);
  mkdirSync(folder);

  run(process.execPath, [path.join(root, "scripts", "build.ts"), "--outdir", path.join(folder, "dist")]);
  run(process.execPath, [path.join(root, "scripts", "build-exe.ts"), "--out", path.join(folder, executableName(target))]);

  cpSync(path.join(root, "mods"), path.join(folder, "mods"), { recursive: true });
  for (const file of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_LICENSES.md"]) {
    cpSync(path.join(root, file), path.join(folder, file));
  }

  // What tells an installed copy it is a release (and not a checkout): the app reads this, and treats anything without it as source.
  writeFileSync(path.join(folder, RELEASE_MARKER), `${JSON.stringify(releaseMarker(manifest.version, target), null, 2)}\n`);

  // The native library is found in node_modules beside the bundle at runtime, so it travels as it is.
  const native = path.join(root, "node_modules", ...target.nativePackage.split("/"));
  if (!existsSync(path.join(native, "package.json"))) throw new Error(`${target.nativePackage} is not installed: run bun install first`);
  cpSync(native, path.join(folder, "node_modules", ...target.nativePackage.split("/")), { recursive: true });

  mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, archiveFileName(manifest.version, target));
  rmSync(archive, { force: true });
  const pack = packCommand(target, archive, staging, base);
  // Without this macOS tar adds AppleDouble `._` files for extended attributes.
  run(pack.command, pack.args, { COPYFILE_DISABLE: "1" });

  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  // `sha256sum -c` format: hash, two characters, file name.
  writeFileSync(`${archive}.sha256`, `${sum}  ${path.basename(archive)}\n`);
  console.log(`${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MiB)\nsha256 ${sum}`);
} finally {
  rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

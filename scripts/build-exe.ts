/**
 * Compiles the standalone executable for the current platform:
 *
 *   bun scripts/build-exe.ts --out <file> [--target <bun-target>]
 *
 * One binary for every process: the CLI entry re-runs itself with an
 * internal first argument to become the autostarted daemon, the MCP server,
 * or the embedding worker (see `src/server/standalone.ts`). The platform
 * native OpenTUI package stays external and travels beside the binary, like
 * it does beside the bundle. Without `--target` the binary is for this
 * machine; the release builds on each platform's own runner instead of
 * cross-compiling, so the native package beside it always matches.
 */
import { join, resolve } from "node:path";
import { buildKnowledge } from "./build-knowledge.js";
import { readGitRevision } from "../src/core/build.js";

// Absolute paths throughout, so the build does not depend on the caller's cwd.
const root = join(import.meta.dir, "..");
const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 && process.argv[outFlag + 1] ? resolve(process.argv[outFlag + 1]!) : join(root, "moxen");
const targetFlag = process.argv.indexOf("--target");
const defaultTarget = process.platform === "win32" ? "bun-windows-x64" : process.platform === "linux" ? "bun-linux-x64" : "bun-darwin-arm64";
const target = targetFlag >= 0 && process.argv[targetFlag + 1] ? process.argv[targetFlag + 1]! : defaultTarget;
if (!/^bun-(darwin|linux|windows)-/.test(target)) throw new Error(`Not a Bun compile target: ${target}`);

await buildKnowledge();

const result = await Bun.build({
  entrypoints: [join(root, "src", "cli", "index.ts")],
  compile: { outfile: out, target },
  define: { "process.env.NODE_ENV": '"production"', __MOXEN_BUILD_REVISION__: JSON.stringify(readGitRevision(root) ?? "unknown") },
  // Native libraries are located on disk at runtime: leave them to node_modules.
  external: ["@opentui/core-*"],
  // No sourcemap file: stack traces already resolve to their source from the
  // binary itself, so an external map would only weigh down every install.
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`compiled ${out} (${target})`);

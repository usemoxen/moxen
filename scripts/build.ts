/**
 * Bundles moxen into `dist/` for `bun dist/cli/index.js` (the `moxen` bin).
 *
 * Bundling does the transpile once, here, instead of on every launch through
 * Bun's runtime transpiler and its on-disk cache (which has served stale
 * output). It also bakes in the production JSX runtime — `process.env.NODE_ENV`
 * is replaced at build time, including inside React — so the TUI no longer has
 * to re-exec itself under `NODE_ENV=production`. Code splitting keeps the TUI
 * (React, OpenTUI, the grammars) out of the startup path of plain commands.
 *
 * It also bundles the embeddings smoke client (`scripts/verify-memory-embeddings.ts`)
 * into `dist/` beside the daemon, so the release archive carries the client the
 * smoke test checks it with — carrying the same baked build identity.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildKnowledge } from "./build-knowledge.js";
import { readGitRevision } from "../src/core/build.js";

// Absolute paths throughout, so the build does not depend on the caller's cwd.
const root = join(import.meta.dir, "..");
// `--outdir <dir>` builds somewhere else (the release packaging builds into a clean folder);
// without it the build goes to `dist/`, as always.
const outdirFlag = process.argv.indexOf("--outdir");
const outdir = outdirFlag >= 0 && process.argv[outdirFlag + 1] ? resolve(process.argv[outdirFlag + 1]!) : join(root, "dist");

await buildKnowledge();

// Not emptied first: a moxen already running from `dist/` (a TUI, the
// server) loads chunks and assets — the syntax worker, the grammars — from
// it as it goes, and `bun run tui` rebuilds while one may be open. Chunks
// and assets carry a content hash, so this build's files sit beside the
// last one's; the old ones are pruned below once nothing can still need them.
const STALE_MS = 24 * 60 * 60 * 1000;

// Baked into every bundle: the production JSX runtime, and the commit the
// server and the client compare on hello. One value for all of them, so the
// archive's own embeddings client carries the same identity as its daemon.
const buildDefine = { "process.env.NODE_ENV": '"production"', __MOXEN_BUILD_REVISION__: JSON.stringify(readGitRevision(root) ?? "unknown") };

const result = await Bun.build({
  // The server and the moxen MCP server are spawned as their own processes
  // (`src/server/client.ts`, `src/server/mcp/main.ts`), as is the embedding
  // worker (`src/core/memory/embedding-runtime.ts`).
  entrypoints: [
    join(root, "src/cli/index.ts"),
    join(root, "src/server/daemon.ts"),
    join(root, "src/server/mcp/entry.ts"),
    join(root, "src/core/memory/embedding-child-entry.ts"),
  ],
  outdir,
  target: "bun",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "linked",
  // The commit this bundle was built from: the server and the client compare
  // it on hello, so a stale `dist/` and the checkout it came from refuse
  // each other instead of sharing a server. Read from the files, never git.
  define: buildDefine,
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  // Native libraries are located on disk at runtime: leave them to node_modules.
  external: ["@opentui/core-*"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The smoke test's `--embeddings` check speaks to the archive's daemon, so it
// must carry the archive's identity too: a source checkout's client is refused
// with BUILD_MISMATCH. This bundles the same script the local-dev path runs
// from source (`bun scripts/verify-memory-embeddings.ts` against the
// checkout's `dist/`) into the archive's own `dist/`, beside the daemon. A
// separate build keeps the entry paths above exactly where they are: folding
// another root into that build would move them under `src/`.
// `[name]` (not `[dir]/[name]`) lands it at the top of `dist/`, so its
// default `--dist` still resolves to the archive's `dist/` and its default
// workdir stays out of `dist/` (the smoke test passes both explicitly).
// No code splitting: it is one small client with no shared chunks to keep.
const verify = await Bun.build({
  entrypoints: [join(root, "scripts", "verify-memory-embeddings.ts")],
  outdir,
  target: "bun",
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: "linked",
  define: buildDefine,
  naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  external: ["@opentui/core-*"],
});

if (!verify.success) {
  for (const log of verify.logs) console.error(log);
  process.exit(1);
}

const outputs = [...result.outputs, ...verify.outputs];

// The grammar, worker and runtime-wasm imports are `import("./x", { with: { type: "file" | "wasm" } })`:
// at build time that makes `x` an asset, but the bundler leaves the attribute
// on the call, now pointing at the chunk that exports the asset's path — so at
// runtime Bun answers with the chunk's own path instead of running it. Dropping
// the attribute lets the chunk run and hand back the asset path it carries.
let stripped = 0;
for (const output of outputs) {
  if (output.kind !== "entry-point" && output.kind !== "chunk") continue;
  const source = await output.text();
  const rewritten = source.replace(/(import\("\.\/[^"]+\.js"),\{with:\{type:"(?:file|wasm)"\}\}\)/g, (_match, call) => {
    stripped += 1;
    return `${call})`;
  });
  if (rewritten !== source) await Bun.write(output.path, rewritten);
}
// What no build has written for a day: a process that old would have loaded what it needs long ago.
const current = new Set(outputs.map((output) => output.path));
let pruned = 0;
const prune = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await prune(full);
    else if (!current.has(full) && !current.has(full.replace(/\.map$/, "")) && Date.now() - (await stat(full)).mtimeMs > STALE_MS) {
      // Windows will not delete a file a running process holds: it waits for the next build.
      if (await rm(full, { force: true }).then(() => true, () => false)) pruned += 1;
    }
  }
};
await prune(outdir);
console.log(`built ${outputs.length} files into ${outdir} (${stripped} file imports rewritten, ${pruned} stale removed)`);

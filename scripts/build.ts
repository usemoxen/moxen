/**
 * Bundles moxen into `dist/` for `bun dist/cli/index.js` (the `moxen` bin).
 *
 * Bundling does the transpile once, here, instead of on every launch through
 * Bun's runtime transpiler and its on-disk cache (which has served stale
 * output). It also bakes in the production JSX runtime — `process.env.NODE_ENV`
 * is replaced at build time, including inside React — so the TUI no longer has
 * to re-exec itself under `NODE_ENV=production`. Code splitting keeps the TUI
 * (React, OpenTUI, the grammars) out of the startup path of plain commands.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Absolute paths throughout, so the build does not depend on the caller's cwd.
const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");

// Not emptied first: a moxen already running from `dist/` (a TUI, the
// server) loads chunks and assets — the syntax worker, the grammars — from
// it as it goes, and `bun run tui` rebuilds while one may be open. Chunks
// and assets carry a content hash, so this build's files sit beside the
// last one's; the old ones are pruned below once nothing can still need them.
const STALE_MS = 24 * 60 * 60 * 1000;

const result = await Bun.build({
  // The server and the moxen MCP server are spawned as their own processes
  // (`src/server/client.ts`, `src/server/mcp/main.ts`).
  entrypoints: [
    join(root, "src/cli/index.ts"),
    join(root, "src/server/daemon.ts"),
    join(root, "src/server/mcp/entry.ts"),
  ],
  outdir,
  target: "bun",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  // Native libraries are located on disk at runtime: leave them to node_modules.
  external: ["@opentui/core-*"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The grammar, worker and runtime-wasm imports are `import("./x", { with: { type: "file" | "wasm" } })`:
// at build time that makes `x` an asset, but the bundler leaves the attribute
// on the call, now pointing at the chunk that exports the asset's path — so at
// runtime Bun answers with the chunk's own path instead of running it. Dropping
// the attribute lets the chunk run and hand back the asset path it carries.
let stripped = 0;
for (const output of result.outputs) {
  if (output.kind !== "entry-point" && output.kind !== "chunk") continue;
  const source = await output.text();
  const rewritten = source.replace(/(import\("\.\/[^"]+\.js"),\{with:\{type:"(?:file|wasm)"\}\}\)/g, (_match, call) => {
    stripped += 1;
    return `${call})`;
  });
  if (rewritten !== source) await Bun.write(output.path, rewritten);
}
// What no build has written for a day: a process that old would have loaded what it needs long ago.
const current = new Set(result.outputs.map((output) => output.path));
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
console.log(`built ${result.outputs.length} files into ${outdir} (${stripped} file imports rewritten, ${pruned} stale removed)`);

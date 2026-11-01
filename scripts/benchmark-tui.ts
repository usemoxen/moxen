import path from "node:path";

// Match the shipped JSX runtime; development React's stacks distort both time and memory.
const output = path.join(import.meta.dir, "../node_modules/.cache/moxen-benchmark/tui.js");
const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "benchmarks/tui.tsx")],
  outdir: path.dirname(output),
  target: "bun",
  define: { "process.env.NODE_ENV": '"production"' },
  external: ["@opentui/core", "@opentui/core/testing", "@opentui/react", "react"],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const profile = process.argv.includes("--profile") ? ["--cpu-prof-md", `--cpu-prof-dir=${path.dirname(output)}`, "--cpu-prof-name=tui-profile.md"] : [];
const child = Bun.spawn([process.execPath, ...profile, output], {
  env: { ...process.env, NODE_ENV: "production" },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);

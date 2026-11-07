/**
 * The standalone executable's (`bun build --compile`) internal modes: the
 * same binary re-run with an internal first argument becomes the autostarted
 * daemon, the MCP server, or the embedding worker, instead of `bun <entry>`
 * like the bundle does. Only `src/cli/index.ts` calls this, before parsing.
 */
import type { StandaloneMode } from "../core/infra/standalone.js";

/** Runs `mode`, then returns for the daemon (the server keeps the process alive). */
export async function runStandaloneMode(mode: StandaloneMode): Promise<void> {
  // The mode flag at argv[2] is consumed here; the mode sees only user arguments.
  if (mode === "daemon") {
    // Runs the server until killed, like `dist/server/daemon.js` does.
    await import("./daemon.js");
    return;
  }
  if (mode === "mcp") {
    const { runMcpMain } = await import("./mcp/main.js");
    await runMcpMain(process.argv.slice(3));
    return;
  }
  const { runEmbeddingChild } = await import("../core/memory/embedding-child.js");
  await runEmbeddingChild(process.argv.slice(3));
}

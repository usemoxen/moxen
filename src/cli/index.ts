#!/usr/bin/env bun
import { standaloneMode } from "../core/infra/standalone.js";
import { runStandaloneMode } from "../server/standalone.js";

// A standalone executable (`bun build --compile`) is one binary for every
// process: the same file re-runs itself with an internal first argument to
// become the autostarted daemon, the MCP server, or the embedding worker.
// Anything else is the CLI.
const mode = standaloneMode();
if (mode === null) {
  const { program } = await import("./program.js");
  await program.parseAsync(process.argv);
  process.exit(process.exitCode ?? 0);
}
// The daemon returns and stays alive on the server's handles; the others exit by themselves.
await runStandaloneMode(mode);

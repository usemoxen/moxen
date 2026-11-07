#!/usr/bin/env bun
import { BARE_NO_TTY_HINT, decideBareInvocation } from "./bare.js";
import { standaloneMode } from "../core/infra/standalone.js";
import { runStandaloneMode } from "../server/standalone.js";

// A standalone executable (`bun build --compile`) is one binary for every
// process: the same file re-runs itself with an internal first argument to
// become the autostarted daemon, the MCP server, or the embedding worker.
// Anything else is the CLI.
const mode = standaloneMode();
if (mode === null) {
  // Bare `moxen` opens the TUI; anything else is parsed as CLI args.
  const decision = decideBareInvocation(process.argv.slice(2), process.stdout.isTTY === true);
  const { program } = await import("./program.js");
  if (decision.kind === "help") {
    process.stdout.write(program.helpInformation());
    process.stderr.write(`${BARE_NO_TTY_HINT}\n`);
    process.exit(2);
  }
  await program.parseAsync(decision.kind === "tui" ? [process.argv[0]!, process.argv[1]!, ...decision.argv] : process.argv);
  process.exit(process.exitCode ?? 0);
}
// The daemon returns and stays alive on the server's handles; the others exit by themselves.
await runStandaloneMode(mode);

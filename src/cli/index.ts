#!/usr/bin/env bun
import { BARE_NO_TTY_HINT, decideBareInvocation } from "./bare.js";
import { program } from "./program.js";

const decision = decideBareInvocation(process.argv.slice(2), process.stdout.isTTY === true);
if (decision.kind === "help") {
  process.stdout.write(program.helpInformation());
  process.stderr.write(`${BARE_NO_TTY_HINT}\n`);
  process.exit(2);
}
await program.parseAsync(decision.kind === "tui" ? [process.argv[0]!, process.argv[1]!, ...decision.argv] : process.argv);
process.exit(process.exitCode ?? 0);

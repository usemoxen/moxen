#!/usr/bin/env bun
import { program } from "./program.js";

await program.parseAsync(process.argv);
process.exit(process.exitCode ?? 0);

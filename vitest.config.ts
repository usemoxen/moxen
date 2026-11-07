import os from "node:os";

import { defineConfig } from "vitest/config";

// How many workers the suite may use, and how long one test may take, depend
// on where it runs. The tests are integration tests: real git repositories
// and worktrees, real subprocesses, a real browser. The hosted CI runners are
// small (windows-latest: 4 vCPUs, macos-latest: 3), so one worker per core
// leaves no room for the children each test spawns: a loaded Windows run
// slows ~1.6x across the board and a different file breaks every time. On CI
// halve the workers so each one (plus its children) fits in the machine, and
// allow the per-test budget the loaded runs need. Local runs keep every
// worker and the strict budget, so a real hang still fails fast.
// Never `retry`: it hides races.
const isCI = process.env.CI === "true";
const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;

export default defineConfig({
  test: {
    // Scope collection to this repo's own tests.
    //
    // `reference/` holds full clones of reference implementations we check
    // behavior against. They are gitignored, but vitest's default glob does not know that, so it
    // collected every test file in there as well as our own -- `bun run check` then failed
    // on upstream's suites and could never pass.
    //
    // An `include` glob rather than an `exclude` of `reference/`: allow-listing our own sources
    // stays correct no matter what other checkouts appear beside them.
    include: ["src/**/*.test.ts"],
    // CLI commands under test run in-process: clients otherwise always start a real server.
    setupFiles: ["src/cli/tests/setup.ts"],
    // Most suites are integration tests: real git repositories and
    // worktrees, real subprocesses (the CLI entry, process trees), all run
    // in parallel. The 5s default flaked under that load — a test that took
    // 0.5s alone exceeded it in a full run — so allow real headroom. On CI
    // the budget is wider still (see above): loaded runners need it, and the
    // worker cap keeps the suite inside the job's timeout.
    testTimeout: isCI ? 60_000 : 20_000,
    maxWorkers: isCI ? Math.max(2, Math.floor(cpus / 2)) : undefined,
  },
});

/**
 * Bare `moxen` opens the TUI: with a terminal it runs as `moxen tui` (global
 * options first, so `--server`/`--config`/`--json` parse as they do there);
 * without one it prints help plus a hint instead of launching. `moxen tui`
 * itself behaves as before, including its no-terminal refusal.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BARE_NO_TTY_HINT, decideBareInvocation, isBareInvocation } from "../bare.js";

const CLI = path.resolve("src/cli/index.ts");
// The CLI runs on Bun (TypeScript directly); vitest itself may run on Node.
const BUN = process.versions.bun ? process.execPath : "bun";

describe("bare moxen", () => {
  it("is no command with only global options", () => {
    for (const args of [[], ["--json"], ["--server", "winbox"], ["--server=winbox"], ["--config", "moxen.json"], ["--config=moxen.json"], ["--json", "--server", "winbox", "--config", "moxen.json"], ["--"]]) {
      expect(isBareInvocation(args)).toBe(true);
    }
  });

  it("leaves commands, help, version and unknown options to commander", () => {
    for (const args of [["tui"], ["--help"], ["-h"], ["--version"], ["-V"], ["threads", "list"], ["--bogus"], ["-x"], ["--server"], ["--config"], ["--", "tui"], ["--json", "--help"], ["--json", "--server", "winbox", "tui"]]) {
      expect(isBareInvocation(args)).toBe(false);
    }
  });

  it("routes a bare invocation with a terminal to `tui` after the global options", () => {
    expect(decideBareInvocation([], true)).toEqual({ kind: "tui", argv: ["tui"] });
    expect(decideBareInvocation(["--server", "winbox", "--json"], true)).toEqual({ kind: "tui", argv: ["--server", "winbox", "--json", "tui"] });
    expect(decideBareInvocation(["tui"], true)).toEqual({ kind: "passthrough" });
    expect(decideBareInvocation(["--help"], true)).toEqual({ kind: "passthrough" });
  });

  it("without a terminal prints help plus a hint instead of launching", () => {
    // Piped stdio is no TTY, so this is the no-terminal branch through the real entry.
    const run = spawnSync(BUN, [CLI], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("Usage:");
    expect(run.stdout).toContain("tui");
    expect(run.stderr).toContain(BARE_NO_TTY_HINT);
  });

  it("`moxen tui` still refuses without a terminal rather than launching", () => {
    const run = spawnSync(BUN, [CLI, "tui"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("moxen tui needs an interactive terminal");
  });
});

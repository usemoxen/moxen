import { describe, expect, it } from "vitest";

import { CliError } from "../../errors.js";
import { describeUpdate, updateProvider, type UpdateDeps } from "../update.js";
import { summarizeUpdateStatus } from "../../catalog/update.js";

type Run = NonNullable<UpdateDeps["run"]>;
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

/** A fake binary: `--version` answers from a queue (before, then after), anything else is the update itself. */
function fake(versions: string[], update: { stdout?: string; stderr?: string; exitCode?: number } = {}) {
  const calls: string[] = [];
  const run: Run = async (binary, args) => {
    calls.push(`${binary} ${args.join(" ")}`);
    if (args[0] === "--version") return ok(versions.shift() ?? "");
    return { stdout: update.stdout ?? "", stderr: update.stderr ?? "", exitCode: update.exitCode ?? 0 };
  };
  return { run, calls };
}

describe("updateProvider", () => {
  it("runs each tool's own update and reports the version before and after", async () => {
    const claude = fake(["2.1.280 (Claude Code)", "2.1.292 (Claude Code)"], { stdout: "Updated\n" });
    await expect(updateProvider("claude", { run: claude.run })).resolves.toEqual({
      provider: "claude",
      before: "2.1.280",
      after: "2.1.292",
      updated: true,
      output: "Updated",
    });
    expect(claude.calls).toEqual(["claude --version", "claude update", "claude --version"]);

    const opencode = fake(["opencode v2.0.20", "opencode v2.0.22"]);
    expect(await updateProvider("opencode", { run: opencode.run })).toMatchObject({ before: "2.0.20", after: "2.0.22", updated: true });
    expect(opencode.calls).toContain("opencode upgrade");
    const codex = fake(["codex-cli 0.164.0", "codex-cli 0.165.0"]);
    expect(await updateProvider("codex", { run: codex.run })).toMatchObject({ provider: "codex", updated: true, before: "0.164.0", after: "0.165.0" });
    expect(codex.calls).toEqual(["codex --version", "codex update", "codex --version"]);
  });

  it("reports an update that changed nothing, with the tool's own words", async () => {
    const result = await updateProvider("claude", { run: fake(["2.1.292", "2.1.292"], { stdout: "Claude Code is up to date (2.1.292)\n" }).run });
    expect(result).toMatchObject({ updated: false, before: "2.1.292", after: "2.1.292" });
    expect(describeUpdate(result)).toBe("Claude Code was not changed (2.1.292): Claude Code is up to date (2.1.292)");
  });

  it("fails when the tool exits non-zero, carrying what it printed", async () => {
    const failure = await updateProvider("opencode", { run: fake(["2.0.20"], { stderr: "permission denied", exitCode: 1 }).run }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "PROVIDER_UPDATE_FAILED", details: { provider: "opencode", exitCode: 1 } });
    expect((failure as CliError).message).toContain("permission denied");
  });

  it("fails clearly when the binary cannot be run at all", async () => {
    const run: Run = async () => {
      throw new Error("spawn claude ENOENT");
    };
    await expect(updateProvider("claude", { run })).rejects.toMatchObject({ code: "PROVIDER_UPDATE_FAILED" });
  });

  it("strips terminal colours and keeps only the tail of long output", async () => {
    const noisy = `${"x".repeat(2000)}\n\u001b[32mdone\u001b[0m`;
    const result = await updateProvider("claude", { run: fake(["2.1.1", "2.1.2"], { stdout: noisy }).run });
    expect(result.output.endsWith("done")).toBe(true);
    expect(result.output).not.toContain("\u001b");
    expect(result.output.length).toBeLessThan(700);
  });
});

describe("describeUpdate", () => {
  it("says what still runs the old build", () => {
    const claude = describeUpdate({ provider: "claude", before: "2.1.280", after: "2.1.292", updated: true, output: "" });
    expect(claude).toContain("2.1.280 → 2.1.292");
    expect(claude).toContain("keeps the old build until it restarts");
    expect(describeUpdate({ provider: "opencode", before: "2.0.20", after: "2.0.22", updated: true, output: "" })).toContain("OpenCode server restarts");
  });
});

describe("summarizeUpdateStatus", () => {
  it("normalizes already-current outputs across all CLIs into a concise Up to date status", () => {
    expect(
      summarizeUpdateStatus({
        provider: "claude",
        ok: true,
        update: { provider: "claude", before: "2.1.330", after: "2.1.330", updated: false, output: "Claude Code is up to date (2.1.330)" },
      }),
    ).toEqual({ tone: "ok", label: "Up to date" });
    expect(
      summarizeUpdateStatus({
        provider: "opencode",
        ok: true,
        update: { provider: "opencode", before: "2.3.2", after: "2.3.2", updated: false, output: "│ Checking...\n└   Done" },
      }),
    ).toEqual({ tone: "ok", label: "Up to date" });
    expect(
      summarizeUpdateStatus({
        provider: "codex",
        ok: true,
        update: { provider: "codex", before: "0.171.0", after: "0.171.0", updated: false, output: "Warning: Not upgrading codex, the latest version is already installed" },
      }),
    ).toEqual({ tone: "ok", label: "Up to date" });
    expect(
      summarizeUpdateStatus({
        provider: "antigravity",
        ok: true,
        update: { provider: "antigravity", before: "1.5.14", after: "1.5.14", updated: false, output: "✓ You are already on the latest version" },
      }),
    ).toEqual({ tone: "ok", label: "Up to date" });
  });

  it("formats version upgrades, non-current notices, and errors cleanly", () => {
    expect(
      summarizeUpdateStatus({
        provider: "claude",
        ok: true,
        update: { provider: "claude", before: "2.1.280", after: "2.1.292", updated: true, output: "" },
      }),
    ).toEqual({ tone: "ok", label: "Updated v2.1.280 → v2.1.292" });
    expect(
      summarizeUpdateStatus({
        provider: "opencode",
        ok: true,
        update: { provider: "opencode", before: "2.3.0", after: "2.3.0", updated: false, output: "Managed by Homebrew; run brew upgrade" },
      }),
    ).toEqual({ tone: "warn", label: "Managed by Homebrew; run brew upgrade" });
    expect(
      summarizeUpdateStatus({
        provider: "codex",
        ok: false,
        error: "permission denied",
      }),
    ).toEqual({ tone: "error", label: "permission denied" });
  });
});

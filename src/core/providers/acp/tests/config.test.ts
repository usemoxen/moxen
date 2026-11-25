import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import { normalizeAcpAgents, resolveAcpAgents, resolveAcpModel } from "../config.js";
import { acpLaunchCommand } from "../transport.js";

describe("ACP config & preset resolution", () => {
  it("returns no agents when none are configured under providers.acp.agents", () => {
    expect(resolveAcpAgents(undefined)).toEqual([]);
    expect(resolveAcpAgents({})).toEqual([]);
  });

  it("resolves enabled configured ACP agents and skips disabled ones", () => {
    const enabled = resolveAcpAgents({
      agents: [{ id: "cline", name: "Cline", command: "cline", args: ["--acp"], defaultModel: "gemini-pro" }],
    });
    expect(enabled).toEqual([
      {
        id: "cline",
        name: "Cline",
        command: "cline",
        args: ["--acp"],
        defaultModel: "gemini-pro",
        isPreset: false,
      },
    ]);

    const filtered = resolveAcpAgents({
      agents: [
        { id: "disabled-agent", command: "foo", enabled: false },
        { id: "cline", name: "Cline", command: "cline", args: ["--acp"], defaultModel: "gemini-pro" },
      ],
    });
    expect(filtered.map((a) => a.id)).toEqual(["cline"]);
  });

  it("rejects duplicate ids, invalid slugs, missing commands, and unterminated quotes", () => {
    expect(() => normalizeAcpAgents([{ id: "bad slug!", command: "x" }])).toThrow(CliError);
    expect(() => normalizeAcpAgents([{ id: "a", command: "" }])).toThrow(CliError);
    expect(() =>
      normalizeAcpAgents([
        { id: "dup", command: "x" },
        { id: "dup", command: "y" },
      ]),
    ).toThrow(/twice/);
    expect(() => normalizeAcpAgents([{ id: "a", command: "x", launchArgs: '"unterminated' }])).toThrow(CliError);
  });

  it("treats acp-default as unset model", () => {
    expect(resolveAcpModel("acp-default")).toBeNull();
    expect(resolveAcpModel("  ")).toBeNull();
    expect(resolveAcpModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("keeps argv intact in acpLaunchCommand on POSIX and unwraps Windows .cmd shims", () => {
    expect(acpLaunchCommand("agy", ["acp", "--foo"], {}, "darwin")).toEqual({
      command: "agy",
      args: ["acp", "--foo"],
    });
    expect(acpLaunchCommand("C:\\Tools\\agy.exe", ["acp"], {}, "win32")).toEqual({
      command: "C:\\Tools\\agy.exe",
      args: ["acp"],
    });
    const files = new Set([
      "C:\\Program Files\\nodejs\\npx.cmd",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
    ]);
    expect(
      acpLaunchCommand(
        "npx",
        ["-y", "acp-agent"],
        { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" },
        "win32",
        { isFile: (p) => files.has(p), readText: () => "" },
      ),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", "-y", "acp-agent"],
    });
  });
});

import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import { normalizeAcpAgents, resolveAcpAgents, resolveAcpModel } from "../config.js";
import { acpLaunchCommand } from "../transport.js";

describe("ACP config & preset resolution", () => {
  it("resolves the built-in agy preset with binaryPath and tokenized launchArgs", () => {
    const agents = resolveAcpAgents({ binaryPath: "/opt/bin/agy", launchArgs: '--flag "two words"' });
    expect(agents).toEqual([
      {
        id: "agy",
        name: "Antigravity (agy)",
        command: "/opt/bin/agy",
        args: ["acp", "--flag", "two words"],
        isPreset: true,
      },
    ]);
  });

  it("lets a custom agy entry override or disable the built-in preset", () => {
    const overridden = resolveAcpAgents({
      agents: [{ id: "agy", name: "My AGY", command: "/custom/agy", args: ["acp", "--verbose"] }],
    });
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatchObject({
      id: "agy",
      name: "My AGY",
      command: "/custom/agy",
      args: ["acp", "--verbose"],
      isPreset: false,
    });

    const disabled = resolveAcpAgents({
      agents: [
        { id: "agy", command: "agy", enabled: false },
        { id: "cline", name: "Cline", command: "cline", args: ["--acp"], defaultModel: "gemini-pro" },
      ],
    });
    expect(disabled.map((a) => a.id)).toEqual(["cline"]);
    expect(disabled[0]?.defaultModel).toBe("gemini-pro");
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

  it("keeps argv intact in acpLaunchCommand on POSIX and Windows", () => {
    expect(acpLaunchCommand("agy", ["acp", "--foo"], {}, "darwin")).toEqual({
      command: "agy",
      args: ["acp", "--foo"],
    });
    expect(acpLaunchCommand("C:\\Tools\\agy.exe", ["acp"], {}, "win32")).toEqual({
      command: "C:\\Tools\\agy.exe",
      args: ["acp"],
    });
  });
});

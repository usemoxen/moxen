import { describe, expect, it } from "vitest";

import { updateProvider } from "../../update.js";
import { FakeAcpTransport } from "../../acp/tests/fakes.js";
import { antigravityProvider } from "../catalog.js";
import { ANTIGRAVITY_DEFAULT_MODEL_SLUG, antigravityLaunchSpec } from "../config.js";

describe("Antigravity first-class provider", () => {
  it("builds an unmodified agy acp launch spec with optional binaryPath and tokenized launchArgs", () => {
    expect(antigravityLaunchSpec(undefined)).toEqual({
      id: "antigravity",
      name: "Antigravity",
      command: "agy",
      args: ["acp"],
    });
    expect(antigravityLaunchSpec({ binaryPath: "/opt/bin/agy", launchArgs: '--flag "two words"' })).toEqual({
      id: "antigravity",
      name: "Antigravity",
      command: "/opt/bin/agy",
      args: ["acp", "--flag", "two words"],
    });
  });

  it("probes agy acp via initialize without creating sessions and exposes Antigravity as a first-class provider", async () => {
    const transport = new FakeAcpTransport({
      authMethods: [{ id: "oauth", name: "Google login" }],
    });
    const summary = await antigravityProvider(
      { binaryPath: "agy" },
      process.env,
      process.cwd(),
      transport,
    );
    expect(summary).toMatchObject({
      instanceId: "antigravity",
      driver: "antigravity",
      displayName: "Antigravity",
      installed: true,
      enabled: true,
      authStatus: "oauth",
    });
    expect(summary.models.map((m) => m.slug)).toEqual([ANTIGRAVITY_DEFAULT_MODEL_SLUG]);
    expect(transport.sessions[0]?.server.requestsTo("initialize")).toHaveLength(1);
    expect(transport.sessions[0]?.server.requestsTo("session/new")).toEqual([]);
  });

  it("surfaces pinned ACP v1 protocol version mismatches on Antigravity", async () => {
    const transport = new FakeAcpTransport({ protocolVersion: 2 });
    const summary = await antigravityProvider(undefined, process.env, process.cwd(), transport);
    expect(summary.enabled).toBe(false);
    expect(summary.status).toMatch(/protocol v2.*only supports ACP protocol v1/i);
  });

  it("updates Antigravity by running agy update without a shell", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    let version = "1.2.3";
    const result = await updateProvider("antigravity", {
      binaryPath: "/custom/agy",
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "--version") return { exitCode: 0, stdout: `${version}\n`, stderr: "" };
        version = "1.3.0";
        return { exitCode: 0, stdout: "Updated Antigravity to 1.3.0\n", stderr: "" };
      },
    });
    expect(calls).toEqual([
      { command: "/custom/agy", args: ["--version"] },
      { command: "/custom/agy", args: ["update"] },
      { command: "/custom/agy", args: ["--version"] },
    ]);
    expect(result).toMatchObject({
      provider: "antigravity",
      before: "1.2.3",
      after: "1.3.0",
      updated: true,
    });
  });
});

import { describe, expect, it } from "vitest";

import { acpProviders } from "../catalog.js";
import { ACP_DEFAULT_MODEL_SLUG } from "../config.js";
import { FakeAcpTransport } from "./fakes.js";

describe("ACP catalog discovery", () => {
  it("probes configured ACP agents via initialize without creating sessions", async () => {
    const transport = new FakeAcpTransport({
      authMethods: [{ id: "oauth", name: "Google login" }],
    });
    const list = await acpProviders(
      {
        agents: [
          { id: "agy", name: "Antigravity (agy)", command: "agy", args: ["acp"] },
          { id: "cline", name: "Cline", command: "cline", args: ["--acp"], defaultModel: "claude-sonnet" },
        ],
      },
      process.env,
      process.cwd(),
      transport,
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      instanceId: "acp/agy",
      driver: "acp",
      installed: true,
      enabled: true,
      authStatus: "oauth",
    });
    expect(list[0]!.models.map((m) => m.slug)).toEqual([ACP_DEFAULT_MODEL_SLUG]);
    expect(list[1]!.models.map((m) => m.slug)).toEqual([ACP_DEFAULT_MODEL_SLUG, "claude-sonnet"]);
    // Catalog probe must never start a session.
    for (const session of transport.sessions) {
      expect(session.server.requestsTo("initialize")).toHaveLength(1);
      expect(session.server.requestsTo("session/new")).toEqual([]);
    }
  });

  it("surfaces pinned ACP protocol version mismatches in provider status", async () => {
    const transport = new FakeAcpTransport({ protocolVersion: 2 });
    const [cline] = await acpProviders(
      { agents: [{ id: "cline", name: "Cline", command: "cline", args: ["--acp"] }] },
      process.env,
      process.cwd(),
      transport,
    );
    expect(cline).toBeDefined();
    expect(cline!.enabled).toBe(false);
    expect(cline!.status).toMatch(/protocol v2.*only supports ACP protocol v1/i);
  });
});

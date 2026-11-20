import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import type { McpServerSpec } from "../../../mcp.js";
import {
  ACP_PROTOCOL_VERSION,
  acpMcpServersOf,
  acpStopReasonToStatus,
  assertSupportedAcpProtocolVersion,
  buildAcpPromptBlocks,
  extractAcpToolContent,
  selectAcpPermissionOutcome,
} from "../protocol.js";

describe("ACP protocol version pinning", () => {
  it("accepts only the pinned ACP protocol version", () => {
    expect(assertSupportedAcpProtocolVersion(ACP_PROTOCOL_VERSION, "agy")).toBe(1);
  });

  it.each([undefined, null, 0, 2, 1.5, "1", true])(
    "refuses unsupported or invalid protocolVersion (%s) with ACP_PROTOCOL_VERSION_UNSUPPORTED",
    (bad) => {
      try {
        assertSupportedAcpProtocolVersion(bad, "agy");
        expect.unreachable("expected assertSupportedAcpProtocolVersion to throw");
      } catch (cause) {
        expect(cause).toBeInstanceOf(CliError);
        expect((cause as CliError).code).toBe("ACP_PROTOCOL_VERSION_UNSUPPORTED");
      }
    },
  );
});

describe("ACP wire helpers", () => {
  it("filters HTTP MCP servers when the agent lacks mcpCapabilities.http", () => {
    const servers: McpServerSpec[] = [
      { name: "local", type: "stdio", command: "node", args: ["server.js"], env: { FOO: "bar" } },
      { name: "remote", type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
    ];
    expect(acpMcpServersOf(servers, { http: false, sse: false })).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "FOO", value: "bar" }] },
    ]);
    expect(acpMcpServersOf(servers, { http: true, sse: false })).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "FOO", value: "bar" }] },
      { type: "http", name: "remote", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ]);
  });

  it("sends native image blocks when supported and falls back to imageMention when not", () => {
    const images = [{ name: "shot.png", mimeType: "image/png", data: "AAAA" }];
    expect(buildAcpPromptBlocks("Look", images, true)).toEqual([
      { type: "text", text: "Look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    const fallback = buildAcpPromptBlocks("Look", images, false);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.["type"]).toBe("text");
    expect(String(fallback[0]?.["text"])).toContain("shot.png");
  });

  it("maps Moxen approval decisions to ACP permission outcomes", () => {
    const options = [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
      { optionId: "deny", name: "Reject once", kind: "reject_once" },
    ];
    expect(selectAcpPermissionOutcome({ kind: "accept" }, options)).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    expect(selectAcpPermissionOutcome({ kind: "acceptForSession" }, options)).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
    expect(selectAcpPermissionOutcome({ kind: "decline" }, options)).toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
    expect(selectAcpPermissionOutcome({ kind: "cancel" }, options)).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("maps ACP stopReason values to terminal turn statuses", () => {
    expect(acpStopReasonToStatus("end_turn")).toBe("completed");
    expect(acpStopReasonToStatus("max_tokens")).toBe("completed");
    expect(acpStopReasonToStatus("cancelled")).toBe("interrupted");
    expect(acpStopReasonToStatus("refusal")).toBe("failed");
  });

  it("extracts unified diffs and locations from ACP tool content blocks", () => {
    const extracted = extractAcpToolContent(
      [{ type: "diff", path: "src/a.ts", oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
      [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    );
    expect(extracted.patch).toContain("-const x = 1;");
    expect(extracted.patch).toContain("+const x = 2;");
    expect(extracted.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

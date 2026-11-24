import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import type { McpServerSpec } from "../../../mcp.js";
import {
  ACP_PROTOCOL_VERSION,
  acpMcpServersOf,
  acpStopReasonToStatus,
  assertSupportedAcpProtocolVersion,
  buildAcpElicitationResponse,
  buildAcpPromptBlocks,
  extractAcpToolContent,
  normalizeAcpToolCall,
  parseAcpCatalogModels,
  parseAcpElicitationQuestions,
  parseAcpInitializeResult,
  parseAcpTurnUsage,
  parseAcpUsageUpdate,
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
  it("filters HTTP MCP servers when the agent lacks mcpCapabilities.http, falling back to stdioFallback for in-process servers", () => {
    const servers: McpServerSpec[] = [
      { name: "local", type: "stdio", command: "node", args: ["server.js"], env: { FOO: "bar" } },
      { name: "remote", type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
      {
        name: "moxen",
        type: "in-process",
        tools: [],
        call: async () => ({ text: "", isError: false }),
        fallback: { name: "moxen", type: "http", url: "http://127.0.0.1:4321/mcp/t1", headers: { Authorization: "Bearer tok" } },
        stdioFallback: { name: "moxen", type: "stdio", command: "bun", args: ["mcp.ts", "--thread", "t1"], env: { MOXEN_STORE_ROOT: "/store" } },
      },
    ];
    expect(acpMcpServersOf(servers, { http: false, sse: false })).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "FOO", value: "bar" }] },
      { name: "moxen", command: "bun", args: ["mcp.ts", "--thread", "t1"], env: [{ name: "MOXEN_STORE_ROOT", value: "/store" }] },
    ]);
    expect(acpMcpServersOf(servers, { http: true, sse: false })).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "FOO", value: "bar" }] },
      { type: "http", name: "remote", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
      { type: "http", name: "moxen", url: "http://127.0.0.1:4321/mcp/t1", headers: [{ name: "Authorization", value: "Bearer tok" }] },
    ]);
    // stdioEnvDefaults fills missing keys (case-insensitively) without overwriting explicit server env.
    expect(
      acpMcpServersOf(
        [
          { name: "linear", type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], env: {} },
          { name: "custom", type: "stdio", command: "node", args: ["s.js"], env: { home: "/custom" } },
        ],
        { http: true, sse: false },
        { stdioEnvDefaults: { HOME: "/Users/real", SSH_CONNECTION: "" } },
      ),
    ).toEqual([
      { name: "linear", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], env: [{ name: "HOME", value: "/Users/real" }, { name: "SSH_CONNECTION", value: "" }] },
      { name: "custom", command: "node", args: ["s.js"], env: [{ name: "SSH_CONNECTION", value: "" }, { name: "home", value: "/custom" }] },
    ]);
  });

  it("treats Antigravity as HTTP-MCP-capable when agy acp omits mcpCapabilities, while honoring explicit false and keeping generic ACP strict", () => {
    // Real `agy acp` v1.5.14 initialize shape omits `mcpCapabilities`.
    const agyInit = parseAcpInitializeResult({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        _meta: { antigravity: { tier: true } },
      },
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
    });
    expect(agyInit.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false });

    // Explicit `http: false` still wins even for Antigravity.
    const agyExplicitFalse = parseAcpInitializeResult(
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: "Antigravity ACP Server", version: "2.0.0" },
      },
      "Antigravity",
      { defaultHttpMcp: true },
    );
    expect(agyExplicitFalse.agentCapabilities.mcpCapabilities).toEqual({ http: false, sse: false });

    // Snake_case `mcp_capabilities` is parsed alongside camelCase.
    const snakeInit = parseAcpInitializeResult({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { mcp_capabilities: { http: true, sse: true } },
      agentInfo: { name: "custom-agent" },
    });
    expect(snakeInit.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: true });

    // Non-Antigravity ACP agents without `mcpCapabilities` stay `http: false`.
    const genericInit = parseAcpInitializeResult({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "generic-acp-agent" },
    });
    expect(genericInit.agentCapabilities.mcpCapabilities).toEqual({ http: false, sse: false });
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

  it("derives base models and per-model efforts from ACP configOptions and availableModels", () => {
    const models = parseAcpCatalogModels(
      [
        {
          id: "model",
          category: "model",
          name: "Model",
          description: null,
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon", description: null },
            { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", description: null },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          name: "Thought Level",
          description: null,
          currentValue: "high",
          options: [
            { value: "low", name: "Low", description: null },
            { value: "high", name: "High", description: null },
            { value: "xhigh", name: "Extra", description: null },
          ],
        },
      ],
      {
        currentModelId: "gemini-4-neon-high",
        availableModels: [
          { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
          { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (Extra)" },
          { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
    );
    expect(models).toEqual([
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        isCustom: false,
        isDefault: true,
        isHidden: false,
        efforts: [
          {
            id: "effort",
            label: "Thought Level",
            currentValue: null,
            choices: [
              { id: "low", label: "Low", isDefault: null },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra", isDefault: null },
            ],
          },
        ],
      },
      {
        slug: "gpt-oss-120b-medium",
        name: "GPT-OSS 120B (Medium)",
        isCustom: false,
        isDefault: false,
        isHidden: false,
        efforts: [],
      },
    ]);
  });

  it("only parses costUsd when currency is USD or omitted", () => {
    expect(parseAcpUsageUpdate({ used: 500, size: 10_000, cost: { amount: 0.25, currency: "USD" } })).toEqual({
      used: 500,
      size: 10_000,
      costUsd: 0.25,
    });
    expect(parseAcpUsageUpdate({ used: 500, size: 10_000, cost: { amount: 0.25, currency: "usd" } })).toEqual({
      used: 500,
      size: 10_000,
      costUsd: 0.25,
    });
    expect(parseAcpUsageUpdate({ used: 500, size: 10_000, cost: { amount: 0.25 } })).toEqual({
      used: 500,
      size: 10_000,
      costUsd: 0.25,
    });
    expect(parseAcpUsageUpdate({ used: 500, size: 10_000, cost: { amount: 1000, currency: "JPY" } })).toEqual({
      used: 500,
      size: 10_000,
    });
    expect(parseAcpTurnUsage({ inputTokens: 100, outputTokens: 20, cost: { amount: 12, currency: "EUR" } })).toEqual({
      input: 100,
      cacheRead: 0,
      cacheCreate: 0,
      output: 20,
      thinking: 0,
    });
  });

  it("normalizes hyphenated eager MCP server names in normalizeAcpToolCall", () => {
    expect(normalizeAcpToolCall("other", "Run mcp_brave-search_brave_image_search", { query: "cats" })).toEqual({
      canonicalTool: "mcp__brave-search__brave_image_search",
      kind: "other",
      title: "mcp__brave-search__brave_image_search",
      input: { query: "cats" },
    });
    expect(normalizeAcpToolCall("other", "Run mcp_chrome-devtools_click", {})).toEqual({
      canonicalTool: "mcp__chrome-devtools__click",
      kind: "other",
      title: "mcp__chrome-devtools__click",
      input: {},
    });
    // Calls through Moxen's Antigravity lazy gateway unwrap to the target server/tool.
    expect(
      normalizeAcpToolCall("other", "Run mcp_moxen-mcp_call_tool", {
        server: "linear",
        tool: "get_issue",
        arguments: { id: "MXN-77" },
      }),
    ).toEqual({
      canonicalTool: "mcp__linear__get_issue",
      kind: "other",
      title: "mcp__linear__get_issue",
      input: { id: "MXN-77" },
    });
    expect(
      normalizeAcpToolCall("other", "Run mcp_moxen-mcp_call_tool", {
        server: "linear",
        tool: "whoami",
      }),
    ).toEqual({
      canonicalTool: "mcp__linear__whoami",
      kind: "other",
      title: "mcp__linear__whoami",
      input: {},
    });
  });

  it("extracts Glob search pattern from rawInput.pattern cleanly", () => {
    expect(
      normalizeAcpToolCall("search", "Files named *.ts", {
        pattern: "*.ts",
        SearchDirectory: "src",
      }),
    ).toMatchObject({
      canonicalTool: "Glob",
      title: "*.ts",
      input: { pattern: "*.ts", path: "src" },
    });
  });
});

describe("ACP elicitation <field>_other folding (MXN-464)", () => {
  const pairedSchema = {
    message: "Please answer a few questions",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "string",
          title: "Which approach?",
          oneOf: [
            { const: "a", title: "Option A" },
            { const: "b", title: "Option B" },
          ],
        },
        q1_other: {
          type: "string",
          title: "Other",
        },
        q2: {
          type: "array",
          title: "Which targets?",
          items: {
            anyOf: [
              { const: "mac", title: "macOS" },
              { const: "win", title: "Windows" },
            ],
          },
        },
        q2_other: {
          type: "string",
          title: "Other",
        },
        q3: {
          type: "string",
          title: "Sentinel choice?",
          enum: ["x", "y", "__other__"],
          enumNames: ["Choice X", "Choice Y", "Other"],
        },
        q3_other: {
          type: "string",
          title: "Other",
        },
        notes: {
          type: "string",
          title: "Notes",
        },
        notes_other: {
          type: "string",
          title: "Additional notes",
        },
      },
    },
  };

  it("folds paired <id>_other free-text fields into their choice parent without creating extra tabs", () => {
    const parsed = parseAcpElicitationQuestions(pairedSchema);
    expect(parsed.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3", "notes", "notes_other"]);
    expect(parsed.questions[0]).toMatchObject({
      id: "q1",
      multiSelect: false,
      allowCustomAnswer: true,
      options: [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
      ],
    });
    expect(parsed.questions[1]).toMatchObject({
      id: "q2",
      multiSelect: true,
      allowCustomAnswer: true,
      options: [
        { value: "mac", label: "macOS" },
        { value: "win", label: "Windows" },
      ],
    });
    // Strips the redundant "Other" sentinel choice when folded into Moxen's custom answer slot.
    expect(parsed.questions[2]).toMatchObject({
      id: "q3",
      allowCustomAnswer: true,
      options: [
        { value: "x", label: "Choice X" },
        { value: "y", label: "Choice Y" },
      ],
    });
  });

  it("routes standard picks to <id> and custom answers to <id>_other on single- and multi-select fields", () => {
    expect(
      buildAcpElicitationResponse(pairedSchema, {
        q1: "a",
        q2: "mac, win",
        q3: "x",
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1: "a",
        q2: ["mac", "win"],
        q3: "x",
      },
    });

    expect(
      buildAcpElicitationResponse(pairedSchema, {
        q1: "Custom answer, with commas",
        q2: "mac, Linux",
        q3: "Custom sentinel text",
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1_other: "Custom answer, with commas",
        q2: ["mac"],
        q2_other: "Linux",
        q3: "__other__",
        q3_other: "Custom sentinel text",
      },
    });

    expect(
      buildAcpElicitationResponse(pairedSchema, {
        q2: "Linux only",
      }),
    ).toEqual({
      action: "accept",
      content: {
        q2_other: "Linux only",
      },
    });
  });
});

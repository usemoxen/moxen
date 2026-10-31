import { describe, expect, it } from "vitest";
import { codexProvider } from "../catalog.js";
import { FakeCodexTransport } from "./fakes.js";

describe("Codex catalog contract", () => {
  it("reads all model pages without creating a thread or exposing account details", async () => {
    const transport = new FakeCodexTransport({ account: { account: { type: "chatgpt", email: "private@example.invalid" } }, modelPages: [
      { data: [{ id: "display-id", model: "model-a", displayName: "Model A", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }], nextCursor: "next" },
      { data: [{ id: "model-b" }], nextCursor: null },
    ] });
    const result = await codexProvider({ binaryPath: process.execPath }, process.env, process.cwd(), transport);
    expect(result).toMatchObject({ enabled: true, authStatus: "chatgpt", models: [{ slug: "model-a", isDefault: true, efforts: [{ choices: [{ id: "high", isDefault: true }] }] }, { slug: "model-b" }] });
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("model/list")[1]!.params).toMatchObject({ cursor: "next" });
    expect(server.requestsTo("thread/start")).toEqual([]);
    expect(transport.sessions[0]!.client.closed).toBe(true);
  });
});

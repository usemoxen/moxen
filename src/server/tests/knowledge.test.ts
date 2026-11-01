import { expect, it } from "vitest";
import { tempDir } from "../../core/testing/tmp.js";
import { DirectConnection } from "../connection.js";
import { decodeQuery } from "../protocol.js";
import { callMoxenTool, moxenToolsFor } from "../mcp/tools.js";
import { answerMcp, moxenInstructions } from "../mcp/stdio.js";
import { startMcpHttpServer } from "../mcp/http.js";
import { serve } from "../transport/serve.js";
import { RemoteConnection } from "../transport/remote.js";
import { testEndpoint } from "../transport/tests/endpoint.js";

it("serves offline knowledge over the wire and both MCP transports without reading config or memory", async () => {
  const api = new DirectConnection({ storeRoot: tempDir("moxen-knowledge-"), config: async () => { throw new Error("config must not be read"); } });
  const server = await serve({ endpoint: testEndpoint(), api });
  const remote = await RemoteConnection.connect(server.endpoint);
  const http = await startMcpHttpServer(remote, "test");
  try {
    const options = { api: remote, parentThreadId: "reader", delegated: true, webFetch: false, memory: "off" as const };
    const search = await answerMcp(options, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "knowledge_search", arguments: { query: "moxen harness profile add" } } });
    expect(search).toMatchObject({ result: { isError: false } });
    const text = (search!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text).matches[0].id).toBe("cli-moxen-harness-profile-add");
    const reading = await remote.query({ type: "knowledge.read", id: "settings", section: "secrets" });
    expect(reading.text).toContain("Never put a credential");
    const spec = http.specFor("reader");
    const response = await fetch(spec.url, { method: "POST", headers: { "Content-Type": "application/json", ...spec.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "knowledge_read", arguments: { id: "settings", section: "secrets" } } }) });
    expect(await response.json()).toMatchObject({ result: { isError: false, content: [{ type: "text", text: JSON.stringify(reading) }] } });
    expect(moxenToolsFor({ delegated: true, webFetch: false, memory: "off" }).map((tool) => tool.name)).toEqual(["knowledge_search", "knowledge_read"]);
    expect(moxenInstructions(options)).toContain("knowledge_search");
    for (const tool of moxenToolsFor({}).filter((tool) => tool.name.startsWith("knowledge_"))) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(await callMoxenTool(remote, "reader", "knowledge_search", { query: " " })).toMatchObject({ isError: true });
    expect(await callMoxenTool(remote, "reader", "knowledge_read", { id: "start", section: 1 })).toMatchObject({ isError: true });
    await expect(remote.query({ type: "knowledge.read", id: "missing" })).rejects.toMatchObject({ code: "KNOWLEDGE_NOT_FOUND" });
  } finally {
    await http.close();
    await remote.close();
    await server.close();
    await api.close();
  }
});

it("rejects malformed wire input instead of silently dropping a section selector", () => {
  for (const raw of [
    { type: "knowledge.search", query: "" },
    { type: "knowledge.search", query: "x".repeat(513) },
    { type: "knowledge.read", id: "start", section: 12 },
    { type: "knowledge.read", id: null },
  ]) expect(() => decodeQuery(raw)).toThrow(/must be nonempty text/);
});

import path from "node:path";
import { expect, it, vi } from "vitest";
import { testHarness } from "../../core/testing/harness.js";
import { CodexDriver } from "../../core/providers/codex/driver.js";
import { FakeCodexTransport } from "../../core/providers/codex/tests/fakes.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import { DirectConnection } from "../connection.js";
import { callMoxenTool } from "../mcp/tools.js";

it("rechecks Codex reserves before dispatch, then runs and reads a native image task through delegation", async () => {
  const harness = await testHarness();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const primary = { usedPercent: 97, windowDurationMins: 300, resetsAt: reset };
  const transport = new FakeCodexTransport({ account: { account: { type: "chatgpt", planType: "plus" } }, rateLimits: { rateLimits: { limitId: "codex", primary, secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: reset } } } });
  const codex = new CodexDriver({ transport });
  let catalogFailed = false;
  const provider: ProviderSummary = { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: null, authStatus: "chatgpt", models: [], supportedRuntimeModes: null, usageLimits: null, skills: [] };
  const connection = new DirectConnection({ storeRoot: harness.root, config: async () => harness.config, drivers: { ...harness.drivers, codex: () => codex }, providers: async () => { if (catalogFailed) throw new Error("unavailable"); return [provider]; }, builtinMcpServers: null });
  try {
    const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
    expect((await connection.query({ type: "image-generation.availability", threadId: parent.threadId })).available).toBe(true);
    primary.usedPercent = 98;
    await expect(connection.dispatch({ type: "thread.image.generate", parentThreadId: parent.threadId, prompt: "A tree" })).rejects.toThrow("3%");
    expect((await harness.store.readDelegations()).length).toBe(0);
    primary.usedPercent = 97;
    const result = await callMoxenTool(connection, parent.threadId, "image_gen", { prompt: "A tree" });
    expect(result.isError).toBe(false);
    const { taskId } = JSON.parse(result.text) as { taskId: string };
    await vi.waitFor(() => expect(transport.sessions.some((session) => session.server.requestsTo("turn/start").length > 0)).toBe(true));
    const server = transport.sessions.find((session) => session.server.requestsTo("turn/start").length > 0)!.server;
    const image = path.join(harness.work, "tree.png");
    server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "image-turn" } });
    server.notify("item/completed", { threadId: "codex-thread-1", item: { id: "generated", type: "imageGeneration", status: "completed", savedPath: image } });
    server.notify("turn/completed", { threadId: "codex-thread-1", turn: { id: "image-turn", status: "completed" } });
    await vi.waitFor(async () => {
      const status = await callMoxenTool(connection, parent.threadId, "image_gen", { taskId, waitMs: 0 });
      expect(JSON.parse(status.text)).toMatchObject({ status: "completed", images: [image] });
    });
    expect((await connection.query({ type: "image-generation.availability", threadId: taskId })).available).toBe(false);
    catalogFailed = true;
    expect((await connection.query({ type: "image-generation.availability", threadId: parent.threadId })).available).toBe(false);
  } finally { await connection.close(); }
});

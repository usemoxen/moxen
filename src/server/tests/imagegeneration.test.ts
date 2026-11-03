import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { testHarness } from "../../core/testing/harness.js";
import { CodexDriver } from "../../core/providers/codex/driver.js";
import { FakeCodexTransport } from "../../core/providers/codex/tests/fakes.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import { DirectConnection } from "../connection.js";
import { callMoxenTool } from "../mcp/tools.js";
import type { ShellFrame } from "../api.js";

it("rechecks Codex reserves before dispatch, then runs and reads a native image task through delegation", async () => {
  const harness = await testHarness();
  harness.config.thinkingEffort = "max";
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const primary = { usedPercent: 97, windowDurationMins: 300, resetsAt: reset };
  let delayed = false;
  const transport = new FakeCodexTransport({ account: { account: { type: "chatgpt", planType: "plus" } }, rateLimits: { rateLimits: { limitId: "codex", primary, secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: reset } } }, beforeResponse: async (method) => {
    // Exercise completion before a slow turn/start response, not just the immediate fake.
    if (method === "turn/start" && !delayed) { delayed = true; await delay(1500); }
  } });
  const codex = new CodexDriver({ transport });
  let catalogFailed = false;
  const luna = (slug: string): ProviderSummary["models"][number] => ({ slug, name: slug, isDefault: false, isCustom: false, isHidden: false, efforts: [{ id: "effort", label: "Effort", currentValue: null, choices: ["none", "max", "low"].map((id) => ({ id, label: id, isDefault: id === "max" })) }] });
  const provider: ProviderSummary = { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: null, authStatus: "chatgpt", models: [luna("gpt-6-luna")], supportedRuntimeModes: null, usageLimits: null, skills: [] };
  const connection = new DirectConnection({ storeRoot: harness.root, config: async () => harness.config, drivers: { ...harness.drivers, codex: () => codex }, providers: async () => { if (catalogFailed) throw new Error("unavailable"); return [provider]; }, builtinMcpServers: null, shellPollMs: 5 });
  const frames: ShellFrame[] = [];
  const errors: unknown[] = [];
  const stop = connection.subscribeShell({}, (frame) => frames.push(frame), (error) => errors.push(error));
  try {
    const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
    expect((await connection.query({ type: "image-generation.availability", threadId: parent.threadId })).available).toBe(true);
    const models = provider.models;
    provider.models = [];
    await expect(connection.dispatch({ type: "thread.image.generate", parentThreadId: parent.threadId, prompt: "A tree" })).rejects.toThrow("Luna");
    provider.models = models;
    primary.usedPercent = 98;
    await expect(connection.dispatch({ type: "thread.image.generate", parentThreadId: parent.threadId, prompt: "A tree" })).rejects.toThrow("3%");
    expect((await harness.store.readDelegations()).length).toBe(0);
    primary.usedPercent = 97;
    const result = await callMoxenTool(connection, parent.threadId, "image_gen", { prompt: "A tree" });
    expect(result.isError).toBe(false);
    const { taskId } = JSON.parse(result.text) as { taskId: string };
    await vi.waitFor(() => expect(transport.sessions.some((session) => session.server.requestsTo("turn/start").length > 0)).toBe(true));
    const server = transport.sessions.find((session) => session.server.requestsTo("turn/start").length > 0)!.server;
    expect(server.requestsTo("turn/start")[0]?.params).toMatchObject({ model: "gpt-6-luna", effort: "low" });
    expect(await harness.store.readThreadRecord(taskId)).toMatchObject({ hidden: true, archivedAt: null, deletedAt: null });
    await vi.waitFor(() => {
      const snapshot = frames.findLast((frame) => frame.kind === "snapshot");
      expect(snapshot?.kind === "snapshot" ? snapshot.snapshot.threads.map((thread) => thread.id) : []).toEqual([parent.threadId]);
    });
    const image = path.join(harness.work, "tree.png");
    server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "image-turn" } });
    server.notify("item/completed", { threadId: "codex-thread-1", item: { id: "generated", type: "imageGeneration", status: "completed", savedPath: image } });
    server.notify("turn/completed", { threadId: "codex-thread-1", turn: { id: "image-turn", status: "completed" } });
    await vi.waitFor(async () => {
      const status = await callMoxenTool(connection, parent.threadId, "image_gen", { taskId, waitMs: 0 });
      expect(JSON.parse(status.text)).toMatchObject({ status: "completed", images: [image] });
    }, { timeout: 5000 });
    expect((await connection.query({ type: "image-generation.availability", threadId: taskId })).available).toBe(false);
    // A new release is picked on the next call, without a restart or a config edit.
    provider.models.push(luna("gpt-6.1-luna"));
    const next = await connection.dispatch({ type: "thread.image.generate", parentThreadId: parent.threadId, prompt: "Another tree" });
    await vi.waitFor(() => expect(transport.sessions.filter((session) => session.server.requestsTo("turn/start").length > 0)).toHaveLength(2));
    const newer = transport.sessions.filter((session) => session.server.requestsTo("turn/start").length > 0)[1]!.server;
    expect(newer.requestsTo("turn/start")[0]?.params).toMatchObject({ model: "gpt-6.1-luna", effort: "low" });
    expect((await callMoxenTool(connection, parent.threadId, "task_cancel", { taskId: next.task.taskId })).isError).toBe(false);
    await vi.waitFor(async () => expect((await connection.query({ type: "thread.task.status", parentThreadId: parent.threadId, taskId: next.task.taskId })).task.status).toBe("interrupted"));
    const ordinary = await connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Ordinary work", title: "Visible work", isolation: "shared", wait: true });
    expect((await harness.store.readThreadRecord(ordinary.task.taskId))?.hidden).toBeUndefined();
    // A new connection proves hiding is persisted, not just a filter cached in the caller.
    const reopened = new DirectConnection({ storeRoot: harness.root, config: async () => harness.config, drivers: harness.drivers, builtinMcpServers: null });
    const reopenedFrames: ShellFrame[] = [];
    const unsubscribe = reopened.subscribeShell({}, (frame) => reopenedFrames.push(frame), (error) => errors.push(error));
    try {
      await vi.waitFor(() => {
        const snapshot = reopenedFrames.findLast((frame) => frame.kind === "snapshot");
        expect(snapshot?.kind === "snapshot" ? snapshot.snapshot.threads.map((thread) => thread.id).sort() : []).toEqual([parent.threadId, ordinary.task.taskId].sort());
      });
      expect((await reopened.query({ type: "threads.list" })).threads.map((thread) => thread.id).sort()).toEqual([parent.threadId, ordinary.task.taskId].sort());
      expect((await reopened.query({ type: "threads.search", query: "Image generation" })).threads).toEqual([]);
      expect((await reopened.query({ type: "thread.task.status", parentThreadId: parent.threadId, taskId })).task.status).toBe("completed");
      expect(errors).toEqual([]);
    } finally { unsubscribe(); await reopened.close(); }
    catalogFailed = true;
    expect((await connection.query({ type: "image-generation.availability", threadId: parent.threadId })).available).toBe(false);
  } finally { stop(); await connection.close(); }
});

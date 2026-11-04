import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { testHarness } from "../../core/testing/harness.js";
import { createThread, sendTurn, openTurn, completeTurn } from "../../core/threads/threads.js";
import { parseQueuePolicy } from "../../core/threads/queue.js";
import { callMoxenTool, availableMoxenTools } from "../mcp/tools.js";
import type { ClientApi } from "../api.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../core/usage/limits.js";
import { DirectConnection } from "../connection.js";
import { decodeCommand, decodeQuery, type ThreadFrame } from "../protocol.js";
import type { UsageProtection } from "../../core/usage/protection.js";

afterEach(resetUsageLimitsForTests);

it("logs each distinct scheduler failure once instead of silently retrying every two seconds", async () => {
  const w = await testHarness();
  const api = new DirectConnection({ storeRoot: w.root, config: async () => w.config, drivers: w.drivers, builtinMcpServers: null });
  const guard = Reflect.get(api, "usageProtection") as UsageProtection;
  const tick = vi.spyOn(guard, "tick").mockRejectedValue(new Error("first tick failure"));
  vi.useFakeTimers();
  try {
    api.startScheduling();
    const log = () => readFile(path.join(w.root, "server.log"), "utf8");
    await vi.waitFor(async () => expect(await log()).toContain("first tick failure"));
    await vi.advanceTimersByTimeAsync(4000);
    tick.mockRejectedValue(new Error("second tick failure"));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(async () => expect(await log()).toContain("second tick failure"));
    expect((await log()).match(/first tick failure/g)).toHaveLength(1);
    expect((await log()).match(/second tick failure/g)).toHaveLength(1);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(4);
  } finally {
    await api.close();
    vi.useRealTimers();
  }
});

it("holds explicitly queued client input across reconnection and never accepts the coordinator bypass over the wire", async () => {
  const w = await testHarness();
  const thread = await createThread(w.store, { projectId: "p", title: "Protected", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, env: { mode: "local", path: w.work, branch: null } });
  const started = await sendTurn(w.store, thread.id, { prompt: "Finish the work" });
  recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
  const first = new DirectConnection({ storeRoot: w.root, drivers: w.drivers });
  try {
    expect((await first.query({ type: "thread.inspect", threadId: thread.id })).thread.turnUsagePauses).toBeUndefined();
    await first.dispatch(decodeCommand({ type: "usage.wrap", provider: "codex" }));
    expect(await first.query(decodeQuery({ type: "usage.protection" }))).toMatchObject({ queue: [{ threadId: thread.id, phase: "pending" }] });
  } finally { await first.close(); }
  const second = new DirectConnection({ storeRoot: w.root, drivers: w.drivers });
  let unsubscribe: (() => void) | undefined;
  try {
    const expected = { [started.turn.id]: { provider: "codex", windows: [{ id: "session", kind: "session", label: "Session", resetsAt: null }], resetsAt: null, hasUncommittedChanges: false } };
    expect(await second.query({ type: "thread.read", threadId: thread.id })).toMatchObject({ thread: { turnUsagePauses: expected, latestTurn: { state: "interrupted" } } });
    const frames: ThreadFrame[] = [];
    unsubscribe = second.subscribeThread(thread.id, {}, (frame) => frames.push(frame), (error) => { throw error; });
    await vi.waitFor(() => expect(frames.find((frame) => frame.kind === "snapshot")).toMatchObject({ snapshot: { thread: { turnUsagePauses: expected } } }), { timeout: 10_000 });
    await second.dispatch(decodeCommand({ type: "thread.turn.start", threadId: thread.id, message: { text: "Additional request" }, delivery: "queue", usageControl: true }));
    expect(openTurn(await w.store.readTurns(thread.id))).toBeNull();
    expect((await w.store.readTurns(thread.id)).at(-1)?.status).toBe("queued");
    await second.dispatch(decodeCommand({ type: "usage.queue", threadId: thread.id, direction: "first" }));
    expect(await second.query({ type: "usage.protection" })).toMatchObject({ queue: [{ threadId: thread.id }] });
    expect(() => decodeCommand({ type: "usage.queue", threadId: thread.id, direction: "execute" })).toThrow();
    await second.dispatch({ type: "usage.queue", threadId: thread.id, direction: "cancel" });
    expect(await second.query({ type: "usage.protection" })).toMatchObject({ queue: [] });
    expect(openTurn(await w.store.readTurns(thread.id))).toBeNull();
    expect((await second.query({ type: "thread.inspect", threadId: thread.id })).thread.turnUsagePauses).toMatchObject(expected);
  } finally { unsubscribe?.(); await second.close(); }
});

it("accepts handoffs only for the bound request and ignores arbitrary final response prose", async () => {
  const w = await testHarness();
  const thread = await createThread(w.store, { projectId: "p", title: "Summary", modelSelection: { instanceId: "codex", model: "test" }, env: { mode: "local", path: w.work, branch: null } });
  const summary = await sendTurn(w.store, thread.id, { prompt: "write summary" });
  const waiting = await sendTurn(w.store, thread.id, { prompt: "resume elsewhere", queue: parseQueuePolicy({ conditions: [], continuation: "model" }) });
  await w.store.updateTurn(thread.id, waiting.turn.id, { handoff: { requestId: "request-one", destinationThreadId: w.store.newId(), summaryTurnId: summary.turn.id } });
  const api = new DirectConnection({ storeRoot: w.root, drivers: w.drivers, builtinMcpServers: null });
  try {
    const scoped: ClientApi = { ...api, query: (async (query) => query.type === "image-generation.availability" ? { available: false } : api.query(query)) as ClientApi["query"] } as ClientApi;
    expect((await availableMoxenTools(scoped, thread.id, {})).some((tool) => tool.name === "submit_handoff")).toBe(true);
    expect((await callMoxenTool(api, thread.id, "submit_handoff", { requestId: "another-request", summary: "wrong" })).isError).toBe(true);
    expect((await callMoxenTool(api, thread.id, "submit_handoff", { requestId: "request-one", summary: "Only this payload is the summary" })).isError).toBe(false);
    await completeTurn(w.store, thread.id, summary.turn.id, { text: "Done. Unrelated extra prose." });
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === waiting.turn.id)?.handoff?.summary).toBe("Only this payload is the summary");
    expect((await availableMoxenTools(scoped, thread.id, {})).some((tool) => tool.name === "submit_handoff")).toBe(false);
    expect((await callMoxenTool(api, thread.id, "submit_handoff", { requestId: "request-one", summary: "replace accepted payload" })).isError).toBe(true);
  } finally { await api.close(); }
});

it("decodes conditional queue entries without trusting internal latches or admission flags", () => {
  const command = decodeCommand({ type: "thread.turn.start", threadId: "thread", message: { text: "later" }, queue: { conditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }], held: true, latched: [0], automatic: false, summaryFor: "other-turn", requestId: "other-request", removed: false } });
  expect(command).toMatchObject({ queue: { conditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }], held: true } });
  if (command.type !== "thread.turn.start") throw new Error("wrong command");
  expect(command.queue).not.toHaveProperty("latched");
  expect(command.queue).not.toHaveProperty("summaryFor");
  expect(command.queue).not.toHaveProperty("requestId");
  expect(() => decodeCommand({ type: "queue.edit", threadId: "thread", turnId: "turn", action: "edit", policy: { conditions: [{ type: "usage", provider: "codex", window: "weekly", minimum: -1 }] } })).toThrow();
});

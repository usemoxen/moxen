import { afterEach, expect, it } from "vitest";
import { testHarness } from "../../core/testing/harness.js";
import { createThread, sendTurn, openTurn } from "../../core/threads/threads.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../core/usage/limits.js";
import { DirectConnection } from "../connection.js";
import { decodeCommand, decodeQuery } from "../protocol.js";

afterEach(resetUsageLimitsForTests);

it("holds client input across reconnection and never accepts the coordinator bypass over the wire", async () => {
  const w = await testHarness();
  const thread = await createThread(w.store, { projectId: "p", title: "Protected", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, env: { mode: "local", path: w.work, branch: null } });
  await sendTurn(w.store, thread.id, { prompt: "Finish the work" });
  recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
  const first = new DirectConnection({ storeRoot: w.root, drivers: w.drivers });
  try {
    await first.dispatch(decodeCommand({ type: "usage.wrap", provider: "codex" }));
    expect(await first.query(decodeQuery({ type: "usage.protection" }))).toMatchObject({ queue: [{ threadId: thread.id, phase: "pending" }] });
  } finally { await first.close(); }
  const second = new DirectConnection({ storeRoot: w.root, drivers: w.drivers });
  try {
    await second.dispatch(decodeCommand({ type: "thread.turn.start", threadId: thread.id, message: { text: "Additional request" }, delivery: "restart", usageControl: true }));
    expect(openTurn(await w.store.readTurns(thread.id))).toBeNull();
    expect((await w.store.readTurns(thread.id)).at(-1)?.status).toBe("queued");
    await second.dispatch(decodeCommand({ type: "usage.queue", threadId: thread.id, direction: "first" }));
    expect(await second.query({ type: "usage.protection" })).toMatchObject({ queue: [{ threadId: thread.id }] });
    expect(() => decodeCommand({ type: "usage.queue", threadId: thread.id, direction: "execute" })).toThrow();
    await second.dispatch({ type: "usage.queue", threadId: thread.id, direction: "cancel" });
    expect(await second.query({ type: "usage.protection" })).toMatchObject({ queue: [] });
    expect(openTurn(await w.store.readTurns(thread.id))).toBeNull();
  } finally { await second.close(); }
});

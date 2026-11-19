import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readThreadForAgent } from "../agentread.js";
import { openThreadStore, type ThreadStore } from "../store.js";
import { completeTurn, createThread, interruptTurn, promoteDueScheduledTurn, sendTurn } from "../threads.js";

const MODEL = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
const budget = { chars: 40_000, outlineOnly: false, reason: null };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function setup(): Promise<{ store: ThreadStore; threadId: string; now: (iso: string) => void }> {
  let clock = Date.parse("2026-11-19T00:00:00.000Z");
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-agentread-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await openThreadStore(root, { clock: () => clock });
  const thread = await createThread(store, {
    projectId: "p",
    title: "Queued work",
    modelSelection: MODEL,
    env: { mode: "local", path: root, branch: null },
  });
  return { store, threadId: thread.id, now: (iso) => { clock = Date.parse(iso); } };
}

/**
 * The incident behind MXN-374: a scheduled message was queued at 00:05 for
 * 00:20, a task notification ran at 00:09, and `thread_read` reported the
 * notification as turn 18. When the scheduled message was cancelled before
 * it ran, the reader listed it as turn 18 and moved the notification to 19,
 * though it had never run and no turn had been reordered on disk.
 */
describe("thread_read numbering", () => {
  it("keeps the numbers of turns that already ran when a queued message is taken back before it runs", async () => {
    const { store, threadId, now } = await setup();
    now("2026-11-19T00:00:00.000Z");
    const first = await sendTurn(store, threadId, { prompt: "first" });
    await completeTurn(store, threadId, first.turn.id, { text: "done" });

    now("2026-11-19T00:05:27.754Z");
    const scheduled = await sendTurn(store, threadId, { prompt: "follow through", scheduledFor: "2026-11-19T00:20:00.000Z" });
    expect(scheduled.turn).toMatchObject({ status: "queued" });

    now("2026-11-19T00:09:27.522Z");
    const notification = await sendTurn(store, threadId, { prompt: "task settled" });
    await completeTurn(store, threadId, notification.turn.id, { text: "ok" });

    now("2026-11-19T00:18:00.000Z");
    expect(await readThreadForAgent(store, { threadId }, budget)).toContain("2 turns");

    await interruptTurn(store, threadId, scheduled.turn.id);
    const after = await readThreadForAgent(store, { threadId }, budget);
    expect(after).toContain("2 turns");
    expect(after).not.toContain("follow through");
    expect(await readThreadForAgent(store, { threadId, turns: "1" }, budget)).toContain("User: first");
    expect(await readThreadForAgent(store, { threadId, turns: "2" }, budget)).toContain("User: task settled");
  });

  it("numbers a queued message by when it ran, not where its row was queued", async () => {
    const { store, threadId, now } = await setup();
    now("2026-11-19T00:00:00.000Z");
    const first = await sendTurn(store, threadId, { prompt: "first" });
    await completeTurn(store, threadId, first.turn.id, { text: "done" });

    now("2026-11-19T00:05:27.754Z");
    const scheduled = await sendTurn(store, threadId, { prompt: "later", scheduledFor: "2026-11-19T00:20:00.000Z" });

    now("2026-11-19T00:09:27.522Z");
    const notification = await sendTurn(store, threadId, { prompt: "task settled" });
    await completeTurn(store, threadId, notification.turn.id, { text: "ok" });
    expect(await readThreadForAgent(store, { threadId }, budget)).toContain("2 turns");

    now("2026-11-19T00:20:00.010Z");
    const started = await promoteDueScheduledTurn(store, threadId);
    expect(started?.id).toBe(scheduled.turn.id);
    await completeTurn(store, threadId, scheduled.turn.id, { text: "late" });

    const after = await readThreadForAgent(store, { threadId }, budget);
    expect(after).toContain("3 turns");
    expect(await readThreadForAgent(store, { threadId, turns: "2" }, budget)).toContain("User: task settled");
    expect(await readThreadForAgent(store, { threadId, turns: "3" }, budget)).toContain("User: later");
  });
});

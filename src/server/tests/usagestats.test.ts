/**
 * `usage.stats` (MXN-166): the stats query reads every thread's turns through
 * the connection, so a client never opens the store. Claude's turns hold the
 * thread's running total and are read as gains over the previous turn.
 */
import { realpath } from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../core/projects/projects.js";
import { testHarness } from "../../core/testing/harness.js";
import type { TurnDriver } from "../../core/threads/execute.js";
import type { ThreadStore } from "../../core/threads/store.js";
import { createThread } from "../../core/threads/threads.js";
import type { ThreadFrame } from "../protocol.js";
import { DirectConnection } from "../connection.js";

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const claude = { instanceId: "claudeAgent", model: "claude-opus-5" };
const opencode = { instanceId: "opencode", model: "anthropic/claude-sonnet-5" };

function usage(input: number, costUsd?: number) {
  return { input, cacheRead: 0, cacheCreate: 0, output: 1, thinking: 0, ...(costUsd === undefined ? {} : { costUsd }) };
}

let turnNumber = 0;
async function addTurn(store: ThreadStore, threadId: string, selection: typeof claude, when: string, turnUsage: ReturnType<typeof usage>) {
  turnNumber += 1;
  await store.appendLedger(threadId, "turns", {
    id: `turn-${turnNumber}`, threadId, status: "completed", delivery: "started", messageId: `m${turnNumber}`, runtimeMode: "full-access",
    interactionMode: "default", modelSelection: selection, parentTurnId: null, error: null, usage: turnUsage, createdAt: when, updatedAt: when, completedAt: when,
  });
}

async function world() {
  const harness = await testHarness();
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers });
  const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
  const make = (id: string, selection: typeof claude) => createThread(harness.store, { id, projectId: project.id, title: id, modelSelection: selection });
  return { harness, connection, store: harness.store, make };
}

describe("usage.stats", () => {
  it("is empty with nothing in the store", async () => {
    const { connection } = await world();
    try {
      expect(await connection.query({ type: "usage.stats" })).toMatchObject({ range: "all", sessions: 0, totalTokens: 0, costUsd: null });
    } finally {
      await connection.close();
    }
  });

  it("reads Claude's running totals as gains and other providers' turns as their own spend, across threads", async () => {
    const { connection, store, make } = await world();
    try {
      await make("c", claude);
      await addTurn(store, "c", claude, daysAgo(2), usage(100, 1));
      await addTurn(store, "c", claude, daysAgo(1), usage(150, 1.5));
      await addTurn(store, "c", claude, daysAgo(0), usage(180, 2));
      await make("o", opencode);
      await addTurn(store, "o", opencode, daysAgo(1), usage(10));
      await addTurn(store, "o", opencode, daysAgo(0), usage(20));

      const stats = await connection.query({ type: "usage.stats" });
      expect(stats.sessions).toBe(2);
      expect(stats.totals.input).toBe(180 + 30);
      expect(stats.byProvider.map((bucket) => [bucket.key, bucket.usage.input, bucket.costUsd])).toEqual([
        ["claude", 180, 2],
        ["opencode/opencode", 30, null],
      ]);
    } finally {
      await connection.close();
    }
  });

  it("counts only what was spent inside the range", async () => {
    const { connection, store, make } = await world();
    try {
      await make("c", claude);
      await addTurn(store, "c", claude, daysAgo(40), usage(100));
      await addTurn(store, "c", claude, daysAgo(1), usage(130));
      expect((await connection.query({ type: "usage.stats", range: "7d" })).totals.input).toBe(30);
      expect((await connection.query({ type: "usage.stats", range: "all" })).totals.input).toBe(130);
    } finally {
      await connection.close();
    }
  });

  it("leaves out a thread the user deleted", async () => {
    const { connection, store, make } = await world();
    try {
      const gone = await make("gone", opencode);
      await addTurn(store, "gone", opencode, daysAgo(0), usage(50));
      await store.writeThreadRecord({ ...gone, deletedAt: daysAgo(0) });
      await make("kept", opencode);
      await addTurn(store, "kept", opencode, daysAgo(0), usage(7));
      expect((await connection.query({ type: "usage.stats" })).totals.input).toBe(7);
    } finally {
      await connection.close();
    }
  });

  it("refuses a range it does not know", async () => {
    const { connection } = await world();
    try {
      await expect(connection.query({ type: "usage.stats", range: "1y" } as never)).rejects.toMatchObject({ code: "INVALID_THREAD_OPTION" });
    } finally {
      await connection.close();
    }
  });

  it("hands back the card as a PNG for the range, named by the day, for the client to save", async () => {
    const { connection, store, make } = await world();
    try {
      await make("c", claude);
      await addTurn(store, "c", claude, daysAgo(1), usage(100, 1));
      const card = await connection.query({ type: "usage.card" });
      const bytes = Buffer.from(card.png, "base64");
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(bytes.readUInt32BE(16)).toBe(1200);
      expect(card.filename).toMatch(/^moxen-stats-\d{4}-\d{2}-\d{2}\.png$/u);
      expect((await connection.query({ type: "usage.card", range: "7d" })).filename).toMatch(/^moxen-stats-7d-\d{4}-\d{2}-\d{2}\.png$/u);
      await expect(connection.query({ type: "usage.card", range: "1y" } as never)).rejects.toMatchObject({ code: "INVALID_THREAD_OPTION" });
      // The client's theme colours are used, and a palette that is not one is refused.
      const palette = { background: "#fafafa", text: "#111111", dim: "#888888", empty: "#dddddd", muted: "#bbbbbb", levels: ["#c6dbef", "#9ecae1", "#4292c6", "#08519c"] as [string, string, string, string] };
      const themed = Buffer.from((await connection.query({ type: "usage.card", palette })).png, "base64");
      const plain = Buffer.from(card.png, "base64");
      expect(themed.equals(plain)).toBe(false);
      await expect(connection.query({ type: "usage.card", palette: { ...palette, text: "red" } } as never)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    } finally {
      await connection.close();
    }
  });

  it("prices live thread.context reads and idle ThreadDetail snapshots for ChatGPT, Antigravity, and OpenCode (MXN-412)", async () => {
    const harness = await testHarness();
    const sessions = new Set<string>();
    const liveByThread = new Map<string, { input: number; cacheRead: number; cacheCreate: number; output: number; thinking: number }>();
    const fakeDriver = (): TurnDriver => ({
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      startSession: () => Effect.succeed({}),
      sendTurn: () => Effect.succeed({ threadId: "", turnId: "t" }),
      interruptTurn: () => Effect.void,
      awaitTurn: async () => ({ status: "completed", text: "", usage: null, error: null }),
      streamEvents: Stream.never,
      contextBreakdown: async (threadId) =>
        sessions.has(threadId)
          ? {
              usedTokens: 50_000,
              maxTokens: 200_000,
              cachedInputTokens: 10_000,
              autoCompactThreshold: null,
              compactsAutomatically: null,
              categories: [{ name: "Messages", tokens: 50_000, kind: "used" }],
              estimated: true,
            }
          : null,
      liveTurnUsage: (threadId) => liveByThread.get(threadId) ?? null,
    });
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: {
        ...harness.drivers,
        chatgpt: fakeDriver,
        antigravity: fakeDriver,
        opencode: fakeDriver,
      },
    });
    try {
      const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
      const chatgptSel = { instanceId: "chatgpt/default", model: "gpt-6.2-sol" };
      const agySel = { instanceId: "antigravity/default", model: "gemini-4-neon" };
      const ocSel = { instanceId: "opencode/opencode-go", model: "opencode-go/deepseek-v4.1-flash" };

      await createThread(harness.store, { id: "th-chatgpt", projectId: project.id, title: "ChatGPT", modelSelection: chatgptSel });
      await createThread(harness.store, { id: "th-agy", projectId: project.id, title: "Antigravity", modelSelection: agySel });
      await createThread(harness.store, { id: "th-oc", projectId: project.id, title: "OpenCode", modelSelection: ocSel });

      // Completed turns + an in-flight turn on ChatGPT to pin live mid-turn accumulation.
      await addTurn(harness.store, "th-chatgpt", chatgptSel, daysAgo(0), { input: 500_000, cacheRead: 0, cacheCreate: 0, output: 100_000, thinking: 0 }); // $2.00
      await harness.store.appendLedger("th-chatgpt", "turns", {
        id: "turn-running-chatgpt", threadId: "th-chatgpt", status: "running", delivery: "started", messageId: "m-run",
        runtimeMode: "full-access", interactionMode: "default", modelSelection: chatgptSel, parentTurnId: null, error: null,
        usage: null, createdAt: daysAgo(0), updatedAt: daysAgo(0), completedAt: null,
      });
      liveByThread.set("th-chatgpt", { input: 100_000, cacheRead: 0, cacheCreate: 0, output: 20_000, thinking: 0 }); // +$0.40 -> $2.40

      await addTurn(harness.store, "th-agy", agySel, daysAgo(0), { input: 100_000, cacheRead: 0, cacheCreate: 0, output: 10_000, thinking: 0 }); // $0.30 + $0.15 = $0.45
      await addTurn(harness.store, "th-oc", ocSel, daysAgo(0), { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 500_000, thinking: 0 }); // $0.15 + $0.30 = $0.45

      // Live reads (`thread.context`) price all three non-Claude providers.
      sessions.add("th-chatgpt");
      sessions.add("th-agy");
      sessions.add("th-oc");
      const cgCtx = await connection.query({ type: "thread.context", threadId: "th-chatgpt" });
      expect(cgCtx.live).toBe(true);
      expect(cgCtx.breakdown?.costUsd).toBeCloseTo(2.4, 9);

      const agyCtx = await connection.query({ type: "thread.context", threadId: "th-agy" });
      expect(agyCtx.breakdown?.costUsd).toBeCloseTo(0.45, 9);

      const ocCtx = await connection.query({ type: "thread.context", threadId: "th-oc" });
      expect(ocCtx.breakdown?.costUsd).toBeCloseTo(0.45, 9);

      // Idle/historical threads whose stored `context-window.updated` had no `costUsd` still get priced on ThreadDetail snapshots (TUI + Desktop).
      sessions.delete("th-agy");
      await harness.store.appendLedger("th-agy", "activity", {
        id: "ctx-old", threadId: "th-agy", turnId: null, kind: "context-window.updated",
        summary: "50000 / 1000000 tokens in context",
        payload: { usedTokens: 50_000, maxTokens: 1_000_000, cachedInputTokens: 0, autoCompactThreshold: null, compactsAutomatically: null },
        createdAt: daysAgo(0),
      });
      const snapshot = await new Promise<Extract<ThreadFrame, { kind: "snapshot" }>>((resolve, reject) => {
        const stop = connection.subscribeThread(
          "th-agy",
          {},
          (frame) => {
            if (frame.kind === "snapshot") {
              stop();
              resolve(frame);
            }
          },
          reject,
        );
      });
      expect(snapshot.snapshot.thread.contextUsage?.costUsd).toBeCloseTo(0.45, 9);
    } finally {
      await connection.close();
    }
  });
});

/**
 * `usage.stats` (MXN-166): the stats query reads every thread's turns through
 * the connection, so a client never opens the store. Claude's turns hold the
 * thread's running total and are read as gains over the previous turn.
 */
import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../core/projects/projects.js";
import { testHarness } from "../../core/testing/harness.js";
import type { ThreadStore } from "../../core/threads/store.js";
import { createThread } from "../../core/threads/threads.js";
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
        ["claudeAgent", 180, 2],
        ["opencode", 30, null],
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
});

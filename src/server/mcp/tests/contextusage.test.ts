/**
 * `context_usage` (MXN-266): an agent sees how full its own context window
 * is — the same figure the TUI shows, with the time of the reading — and
 * never an estimate or an old reading passed off as the current one.
 */
import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../../core/projects/projects.js";
import { testHarness } from "../../../core/testing/harness.js";
import { createThread } from "../../../core/threads/threads.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, moxenToolsFor, MOXEN_TOOLS } from "../tools.js";

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, "0")}:00.000Z`;

interface Answer {
  readonly reading: {
    readonly usedTokens: number;
    readonly maxTokens: number | null;
    readonly percentUsed: number | null;
    readonly takenAt: string;
    readonly current: boolean;
  } | null;
  readonly note?: string;
}

async function world() {
  const harness = await testHarness();
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers });
  const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
  const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };
  await createThread(harness.store, { id: "caller", projectId: project.id, title: "Caller", modelSelection: selection });
  await createThread(harness.store, { id: "other", projectId: project.id, title: "Other", modelSelection: selection });
  let next = 0;
  const add = (threadId: string, kind: string, payload: Record<string, unknown>, minute: number) =>
    harness.store.appendLedger(threadId, "activity", {
      id: `activity-${(next += 1)}`,
      threadId,
      turnId: null,
      kind,
      summary: "",
      payload,
      createdAt: at(minute),
    });
  const reading = (usedTokens: number, maxTokens: number | null, minute: number, threadId = "caller") =>
    add(threadId, "context-window.updated", { usedTokens, ...(maxTokens === null ? {} : { maxTokens }) }, minute);
  const compaction = (minute: number) => add("caller", "notice", { notice: "compacted" }, minute);
  const ask = async (args: Record<string, unknown> = {}, options: Parameters<typeof callMoxenTool>[4] = {}) => {
    const result = await callMoxenTool(connection, "caller", "context_usage", args, options);
    return { ...result, value: JSON.parse(result.text) as Answer };
  };
  return { harness, connection, reading, compaction, ask };
}

describe("context_usage", () => {
  it("reports the latest reading's tokens, window, percent and when it was taken", async () => {
    const { connection, reading, ask } = await world();
    try {
      await reading(120_000, 1_000_000, 1);
      await reading(357_000, 1_000_000, 2);
      const answer = await ask();
      expect(answer.isError).toBe(false);
      expect(answer.value).toEqual({
        reading: { usedTokens: 357_000, maxTokens: 1_000_000, percentUsed: 36, takenAt: at(2), current: true },
      });
    } finally {
      await connection.close();
    }
  });

  it("leaves the percent unknown when the provider reports no window", async () => {
    const { connection, reading, ask } = await world();
    try {
      await reading(50_000, null, 1);
      expect((await ask()).value.reading).toMatchObject({ usedTokens: 50_000, maxTokens: null, percentUsed: null });
    } finally {
      await connection.close();
    }
  });

  it("says there is no reading, plainly, and never estimates", async () => {
    const { connection, ask } = await world();
    try {
      const answer = await ask();
      expect(answer.isError).toBe(false);
      expect(answer.value.reading).toBeNull();
      expect(answer.value.note).toMatch(/No context reading for this thread yet/u);
      // No number of any kind: an estimate would be a guess dressed as a reading.
      expect(answer.text).not.toMatch(/\d/u);
    } finally {
      await connection.close();
    }
  });

  it("reads only the calling thread's own context, whatever argument is passed", async () => {
    const { connection, reading, ask } = await world();
    try {
      await reading(25_000, 200_000, 1);
      await reading(900_000, 1_000_000, 2, "other");
      expect((await ask()).value.reading).toMatchObject({ usedTokens: 25_000, maxTokens: 200_000, percentUsed: 13 });
      // No thread id parameter: a client that sends one anyway still gets its own thread.
      expect((await ask({ threadId: "other" })).value.reading).toMatchObject({ usedTokens: 25_000 });
      const tool = MOXEN_TOOLS.find((candidate) => candidate.name === "context_usage")!;
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it("is offered to a delegated task as well as an ordinary thread", async () => {
    const { connection, reading, ask } = await world();
    try {
      expect(moxenToolsFor({}).map((tool) => tool.name)).toContain("context_usage");
      expect(moxenToolsFor({ delegated: true, memory: "read" }).map((tool) => tool.name)).toContain("context_usage");
      await reading(10_000, 200_000, 1);
      const answer = await ask({}, { delegated: true });
      expect(answer.isError).toBe(false);
      expect(answer.value.reading).toMatchObject({ usedTokens: 10_000 });
    } finally {
      await connection.close();
    }
  });

  it("does not pass a reading from before a compaction off as current", async () => {
    const { connection, reading, compaction, ask } = await world();
    try {
      await reading(190_000, 200_000, 1);
      await compaction(2);
      const stale = await ask();
      expect(stale.value.reading).toMatchObject({ usedTokens: 190_000, takenAt: at(1), current: false });
      expect(stale.value.note).toMatch(/compaction has happened since/u);

      // A reading recorded after the compaction is current again.
      await reading(18_000, 200_000, 3);
      expect((await ask()).value.reading).toMatchObject({ usedTokens: 18_000, current: true });
    } finally {
      await connection.close();
    }
  });
});

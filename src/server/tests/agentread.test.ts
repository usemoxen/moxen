/**
 * `thread_search` / `thread_read` (MXN-133): another thread revealed a step
 * at a time, within a budget, every cut named, the text marked as untrusted.
 */
import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../core/projects/projects.js";
import { testHarness } from "../../core/testing/harness.js";
import { agentReadBudget, AGENT_READ_DEFAULT_CHARS, AGENT_READ_MAX_CHARS } from "../../core/threads/agentread.js";
import { createThread } from "../../core/threads/threads.js";
import { DirectConnection } from "../connection.js";
import { callMoxenTool } from "../mcp/tools.js";

const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

async function world() {
  const harness = await testHarness();
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers });
  const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
  const { project: elsewhere } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: harness.root });
  const selection = { instanceId: "claudeAgent", model: "claude-opus-5" };
  await createThread(harness.store, { id: "caller", projectId: project.id, title: "Caller", modelSelection: selection });
  await createThread(harness.store, { id: "target", projectId: project.id, title: "Webhook retries", modelSelection: selection });
  await createThread(harness.store, { id: "foreign", projectId: elsewhere.id, title: "Webhook in another project", modelSelection: selection });
  const store = harness.store;
  // Turns 1..30, each a prompt, a Bash call with long output, and a reply.
  for (let number = 1; number <= 30; number += 1) {
    const turnId = `t${number}`;
    await store.appendLedger("target", "turns", {
      id: turnId, threadId: "target", status: "completed", delivery: "started", messageId: `u${number}`, runtimeMode: "full-access", interactionMode: "default",
      modelSelection: selection, parentTurnId: null, error: null, usage: null, createdAt: at(number), updatedAt: at(number), completedAt: at(number),
    });
    await store.appendLedger("target", "messages", { id: `u${number}`, threadId: "target", turnId, role: "user", text: `Fix the webhook retry, step ${number}`, createdAt: at(number) });
    const payload = (status: string) => ({
      itemType: "command_execution", status, toolCallId: `call${number}`, title: "Bash",
      data: { tool: "Bash", state: { status, input: { command: "bun run check" }, ...(status === "completed" ? { output: Array.from({ length: 214 }, (_, line) => `line ${line} of ${number}`).join("\n"), metadata: { exit: 0 } } : {}) } },
    });
    await store.appendLedger("target", "activity", { id: `a${number}s`, threadId: "target", turnId, kind: "tool-call.started", summary: "$ bun run check", payload: payload("inProgress"), createdAt: at(number) });
    await store.appendLedger("target", "activity", { id: `a${number}c`, threadId: "target", turnId, kind: "tool-call.completed", summary: "$ bun run check", payload: payload("completed"), createdAt: at(number) });
    await store.appendLedger("target", "messages", { id: `r${number}`, threadId: "target", turnId, role: "assistant", text: `Done with step ${number}. ${"Details. ".repeat(number === 30 ? 3000 : 5)}`, createdAt: at(number) });
  }
  const read = async (args: Record<string, unknown>) => (await callMoxenTool(connection, "caller", "thread_read", args)).text;
  return { harness, connection, store, read };
}

describe("thread_read", () => {
  it("starts with an outline, newest first, and names the call for the turns it left out", async () => {
    const { connection, read } = await world();
    try {
      const outline = await read({ id: "target" });
      expect(outline.startsWith('<untrusted_context source="thread:target">')).toBe(true);
      expect(outline).toMatch(/30\. 2026-10-01 10:30 · completed · 1 tool call\n {3}asked: Fix the webhook retry, step 30/u);
      expect(outline.indexOf("30. ")).toBeLessThan(outline.indexOf("29. "));
      const missing = /\[Moxen\] Turns 1–(\d+) not listed: thread_read\(id: "target", before: (\d+)\)/u.exec(outline);
      expect(missing).not.toBeNull();
      // The note lives outside the untrusted block: it is Moxen's, not the thread's.
      expect(outline.indexOf("[Moxen]")).toBeGreaterThan(outline.indexOf("</untrusted_context>"));
      const earlier = await read({ id: "target", before: Number(missing![2]) });
      expect(earlier).toContain(`${Number(missing![1])}. `);
      expect(earlier).not.toContain(`${Number(missing![2])}. 2026`);
    } finally {
      await connection.close();
    }
  });

  it("shows turns with each tool call on one line, and one call in full, in pages", async () => {
    const { connection, read } = await world();
    try {
      const turns = await read({ id: "target", turns: "12-13" });
      expect(turns).toContain("[12.1] Bash: bun run check → completed, exit 0, 214 lines");
      expect(turns).toContain("Assistant: Done with step 13.");
      expect(turns).not.toContain("line 5 of 12");

      const item = await read({ id: "target", item: "12.1" });
      expect(item).toContain('"command": "bun run check"');
      expect(item).toContain("line 213 of 12");

      // Turn 30's reply is far past the budget: a page, and the offset of the next one.
      const long = await read({ id: "target", turns: "30" });
      const next = /\[Moxen\] Characters 0–(\d+) of (\d+); \d+ more not shown: thread_read\(id: "target", turns: "30", offset: (\d+)\)/u.exec(long);
      expect(next).not.toBeNull();
      expect(long.length).toBeLessThan(AGENT_READ_DEFAULT_CHARS + 1_000);
      const rest = await read({ id: "target", turns: "30", offset: Number(next![3]) });
      expect(rest).toContain(`Characters ${next![3]}–`);
    } finally {
      await connection.close();
    }
  });

  it("reads only this project's threads unless asked for all", async () => {
    const { connection, read } = await world();
    try {
      expect(await read({ id: "foreign" })).toContain('THREAD_OUT_OF_SCOPE');
      expect(await read({ id: "foreign", scope: "all" })).toContain("Nothing has run in it yet");
    } finally {
      await connection.close();
    }
  });

  it("holds the answer to a share of the caller's free context, and only the outline when it is nearly full", async () => {
    expect(agentReadBudget(null)).toEqual({ chars: AGENT_READ_DEFAULT_CHARS, outlineOnly: false, reason: null });
    expect(agentReadBudget(null, 1_000_000).chars).toBe(AGENT_READ_MAX_CHARS);
    // 1M window, 900K used: 100K tokens free → 400K chars, 5% of it = 20K, above the default.
    expect(agentReadBudget({ usedTokens: 900_000, maxTokens: 1_000_000 }).chars).toBe(AGENT_READ_DEFAULT_CHARS);
    const tight = agentReadBudget({ usedTokens: 150_000, maxTokens: 200_000 });
    expect(tight).toMatchObject({ chars: 10_000, outlineOnly: false });
    expect(tight.reason).toContain("75% full");
    expect(agentReadBudget({ usedTokens: 195_000, maxTokens: 200_000 })).toMatchObject({ outlineOnly: true });

    const { connection, store, read } = await world();
    try {
      await store.appendLedger("caller", "activity", { id: "ctx", threadId: "caller", turnId: null, kind: "context-window.updated", summary: "", payload: { usedTokens: 195_000, maxTokens: 200_000 }, createdAt: at(59) });
      const squeezed = await read({ id: "target", turns: "12" });
      expect(squeezed).toContain("[Moxen] Only the outline: your context is 98% full");
      expect(squeezed).not.toContain("[12.1]");
    } finally {
      await connection.close();
    }
  });
});

describe("thread_search", () => {
  it("finds this project's other threads with short snippets, and every project's when asked", async () => {
    const { connection } = await world();
    try {
      const search = async (args: Record<string, unknown>) => (await callMoxenTool(connection, "caller", "thread_search", args)).text;
      const here = await search({ query: "webhook" });
      expect(here).toContain('"Webhook retries" · id target');
      expect(here).not.toContain("foreign");
      expect(here.startsWith('<untrusted_context source="moxen:thread_search">')).toBe(true);
      for (const line of here.split("\n").filter((row) => row.startsWith("    "))) expect(line.length).toBeLessThan(160);
      expect(await search({ query: "webhook", scope: "all" })).toContain("id foreign");
    } finally {
      await connection.close();
    }
  });
});

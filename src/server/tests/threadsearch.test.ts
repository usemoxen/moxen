import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../core/projects/projects.js";
import { testHarness } from "../../core/testing/harness.js";
import { DirectConnection } from "../connection.js";
import { matchesTerms, snippetAround } from "../../core/threads/search.js";
import { createThread, settleThread } from "../../core/threads/threads.js";

describe("thread search", () => {
  it("finds title, message and tool-call text across active and settled threads, active first", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers });
    try {
      const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
      const make = (id: string, title: string) =>
        createThread(harness.store, { id, projectId: project.id, title, modelSelection: { instanceId: "codex", model: "gpt-5.4" } });
      await make("old", "Billing refactor");
      await make("new", "Login bug");
      await make("other", "Unrelated");
      const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
      await harness.store.appendLedger("old", "messages", { id: "m1", threadId: "old", turnId: "t1", role: "user", text: "Why does the webhook retry loop never stop?", createdAt: at(1) });
      await harness.store.appendLedger("new", "messages", { id: "m2", threadId: "new", turnId: "t1", role: "assistant", text: "The WEBHOOK handler retries forever.", createdAt: at(2) });
      await harness.store.appendLedger("new", "activity", {
        id: "a1",
        threadId: "new",
        turnId: "t1",
        kind: "tool",
        summary: "Ran a command",
        payload: { data: { tool: "Bash", state: { input: { command: "curl https://hooks.example/webhook" } } } },
        createdAt: at(3),
      });
      await settleThread(harness.store, "old");

      const search = async (query: string, status?: "active" | "settled") =>
        await connection.query({ type: "threads.search", query, ...(status ? { status } : {}) });

      const both = await search("webhook");
      expect(both.threads.map((entry) => [entry.threadId, entry.status])).toEqual([
        ["new", "active"],
        ["old", "settled"],
      ]);
      expect(both.threads[0]!.hits.map((hit) => hit.kind).sort()).toEqual(["message", "tool"]);
      expect(both.threads[0]!.hits.find((hit) => hit.kind === "tool")).toMatchObject({ source: "Bash" });

      expect((await search("billing")).threads[0]).toMatchObject({ threadId: "old", hits: [{ kind: "title" }] });
      expect((await search("webhook", "settled")).threads.map((entry) => entry.threadId)).toEqual(["old"]);
      expect((await search("forever retries")).threads.map((entry) => entry.threadId)).toEqual(["new"]);
      expect((await search("   ")).threads).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it("matches every word in any order and cuts a snippet around the first", () => {
    expect(matchesTerms("The Quick brown fox", ["fox", "quick"])).toBe(true);
    expect(matchesTerms("The quick brown fox", ["fox", "slow"])).toBe(false);
    const text = `${"a ".repeat(100)}needle${" b".repeat(100)}`;
    const snippet = snippetAround(text, ["needle"]);
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("…") && snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(160);
  });
});

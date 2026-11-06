import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { testHarness } from "../../../core/testing/harness.js";
import type { ClientApi } from "../../api.js";
import { DirectConnection } from "../../connection.js";
import { TASK_NOTIFICATION_BATCH_MS } from "../../../core/threads/operations.js";
import { openThreadStore } from "../../../core/threads/store.js";
import { sendTurn } from "../../../core/threads/threads.js";
import { serveMcp } from "../stdio.js";
import { callMoxenTool, moxenToolsFor } from "../tools.js";
import { webPolicy } from "../../../core/providers/harness/web/settings.js";
import { normalizeConfig } from "../../../core/config.js";
import { describeSettings } from "../../../core/configschema.js";

async function setup(harnessOptions: Parameters<typeof testHarness>[0] = {}) {
  const starts: Array<Record<string, unknown>> = [];
  const harness = await testHarness({ ...harnessOptions, onStartSession: (input) => starts.push(input) });
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const parent = await connection.dispatch({
    type: "thread.handover",
    cwd: harness.work,
    prompt: "Parent",
    // A parent whose turns never settle must not be waited on either.
    wait: harnessOptions.leaveTurnsRunning !== true,
    threadEnvMode: "local",
  });
  return { harness, connection, parentThreadId: parent.threadId, starts };
}

/** One MCP session over in-memory pipes: send requests, read each reply line. */
function mcpSession(connection: DirectConnection, parentThreadId: string, checklist = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveMcp({ api: connection, parentThreadId, checklist, input, output });
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      replies.get(message.id as number)?.(message);
      newline = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const close = async () => {
    input.end();
    await served;
  };
  return { request, notify: (method: string) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`), close };
}

describe("moxen MCP server", () => {
  it("speaks MCP: negotiates a version, lists its tools, rejects unknown methods", async () => {
    const { connection, parentThreadId } = await setup();
    const mcp = mcpSession(connection, parentThreadId);
    try {
      const init = await mcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t" } });
      expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "moxen" } });
      const unknownVersion = await mcp.request("initialize", { protocolVersion: "1999-01-01" });
      expect((unknownVersion.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
      mcp.notify("notifications/initialized");
      const listed = await mcp.request("tools/list");
      expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
        "knowledge_search",
        "knowledge_read",
        "delegate",
        "task_status",
        "models",
        "context_usage",
        "web_fetch",
        "task_cancel",
        "task_send",
        "task_ask",
        "message_queue",
        "thread_search",
        "thread_read",
        "memory_read",
        "memory_search",
        "memory_save",
        "memory_edit",
        "memory_append",
        "memory_delete",
      ]);
      expect((await mcp.request("ping")).result).toEqual({});
      expect((await mcp.request("resources/list")).error).toMatchObject({ code: -32601 });
    } finally {
      await mcp.close();
      await connection.close();
    }
  });

  it("delegates into a worktree by default and reports the subagent's result", async () => {
    const { connection, parentThreadId, starts } = await setup();
    const mcp = mcpSession(connection, parentThreadId);
    try {
      const called = await mcp.request("tools/call", { name: "delegate", arguments: { task: "Write the changelog", title: "Write changelog" } });
      const result = called.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(false);
      const delegated = JSON.parse(result.content[0]!.text) as { taskId: string; isolation: string; branch: string };
      expect(delegated.isolation).toBe("worktree");
      expect(delegated.branch).toBe("moxen/write-changelog");

      const status = await mcp.request("tools/call", { name: "task_status", arguments: { taskId: delegated.taskId, waitMs: 5000 } });
      const report = JSON.parse((status.result as { content: Array<{ text: string }> }).content[0]!.text);
      expect(report).toMatchObject({ status: "completed", finished: true, report: "Completed: Write the changelog", branch: delegated.branch });

      // Both sessions carry Moxen's tools, but the subagent's has none that delegate (it does not delegate again).
      const moxen = (input: Record<string, unknown> | undefined) =>
        ((input?.mcpServers as Array<{ name: string; tools?: Array<{ name: string }> }> | undefined) ?? []).find((server) => server.name === "moxen");
      expect(moxen(starts.find((input) => input.threadId === parentThreadId))?.tools?.map((tool) => tool.name)).toEqual(["knowledge_search", "knowledge_read", "delegate", "task_status", "models", "context_usage", "web_fetch", "task_cancel", "task_send", "task_ask", "message_queue", "thread_search", "thread_read", "memory_read", "memory_search", "memory_save", "memory_edit", "memory_append", "memory_delete"]);
      expect(moxen(starts.find((input) => input.threadId === delegated.taskId))?.tools?.map((tool) => tool.name)).toEqual(["knowledge_search", "knowledge_read", "context_usage", "web_fetch", "memory_read", "memory_search"]);
    } finally {
      await mcp.close();
      await connection.close();
    }
  });

  it("does not fall back to the checkout when the parent record has no branch but its checkout is on one", async () => {
    const harness = await testHarness({});
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      // The way the TUI creates one: `thread.create` sends no branch, so the record has none.
      const project = await connection.dispatch({ type: "project.ensure", cwd: harness.work });
      const parent = await connection.dispatch({ type: "thread.create", projectId: project.project.id });
      const result = await callMoxenTool(connection, parent.threadId, "delegate", { task: "Write the changelog", title: "Write changelog" });
      expect(result.isError).toBe(false);
      const delegated = JSON.parse(result.text) as { taskId: string; isolation: string; branch: string };
      expect(delegated.isolation).toBe("worktree");
      expect(delegated.branch).toBe("moxen/write-changelog");
    } finally {
      await connection.close();
    }
  });

  it("starts several tasks in one call with shared settings and per-task overrides", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const result = await callMoxenTool(connection, parentThreadId, "delegate", {
        isolation: "shared",
        rules: "Report in three bullets.",
        tasks: [
          { task: "First job", title: "first" },
          { task: "Second job", title: "second", isolation: "worktree" },
        ],
      });
      expect(result.isError).toBe(false);
      const batch = JSON.parse(result.text) as { tasks: Array<{ taskId: string; title: string; isolation: string }>; warning?: string };
      expect(batch.tasks).toHaveLength(2);
      expect(batch.tasks[0]).toMatchObject({ title: "first", isolation: "shared" });
      expect(batch.tasks[1]).toMatchObject({ title: "second", isolation: "worktree" });
      expect(typeof batch.tasks[0]!.taskId).toBe("string");
      expect(batch.tasks[0]!.taskId).not.toBe(batch.tasks[1]!.taskId);
      // Warned once, naming the task that shares the checkout.
      expect(batch.warning).toContain("first");
      expect(batch.warning).not.toContain("second");
      // The shared rules reached every child's prompt.
      const rows = await harness.store.readDelegations();
      for (const entry of batch.tasks) {
        expect(rows.find((row) => row.childThreadId === entry.taskId)?.prompt).toContain("Common rules for this task:\nReport in three bullets.");
      }
    } finally {
      await connection.close();
    }
  });

  it("starts the tasks that can start when one fails, and says the failed one plainly", async () => {
    const harness = await testHarness({});
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      // No git repository here, so no worktree to cut: that entry fails while the shared one still starts.
      const plain = path.join(harness.root, "plain");
      await mkdir(plain);
      const project = await connection.dispatch({ type: "project.ensure", cwd: plain });
      const parent = await connection.dispatch({ type: "thread.create", projectId: project.project.id });
      const result = await callMoxenTool(connection, parent.threadId, "delegate", {
        tasks: [
          { task: "Needs a branch", title: "branchy", isolation: "worktree" },
          { task: "Reads only", title: "reader", isolation: "shared" },
        ],
      });
      expect(result.isError).toBe(false);
      const batch = JSON.parse(result.text) as { tasks: Array<Record<string, unknown>>; warning?: string };
      expect(batch.tasks).toHaveLength(2);
      expect(batch.tasks[0]).toMatchObject({ title: "branchy", error: expect.stringContaining("WORKTREE_UNAVAILABLE") });
      expect(batch.tasks[1]).toMatchObject({ title: "reader", isolation: "shared" });
      expect(typeof batch.tasks[1]!["taskId"]).toBe("string");
    } finally {
      await connection.close();
    }
  });

  it("returns each original task when a batch delegate is retried with the same idempotency key", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const key = randomUUID();
      const call = async () => {
        const result = await callMoxenTool(connection, parentThreadId, "delegate", {
          isolation: "shared",
          idempotencyKey: key,
          tasks: [
            { task: "First job", title: "first" },
            { task: "Second job", title: "second" },
          ],
        });
        expect(result.isError).toBe(false);
        return JSON.parse(result.text) as { tasks: Array<{ taskId: string }> };
      };
      const first = await call();
      const again = await call();
      expect(again.tasks.map((entry) => entry.taskId)).toEqual(first.tasks.map((entry) => entry.taskId));
      // The retry started no duplicates: two delegation rows behind the parent.
      expect((await harness.store.readDelegations()).filter((row) => row.parentThreadId === parentThreadId)).toHaveLength(2);
    } finally {
      await connection.close();
    }
  });

  it("returns the right original task when a batch delegate is retried in a different order", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const key = randomUUID();
      const call = async (tasks: Array<{ task: string; title: string }>) => {
        const result = await callMoxenTool(connection, parentThreadId, "delegate", { isolation: "shared", idempotencyKey: key, tasks });
        expect(result.isError).toBe(false);
        return JSON.parse(result.text) as { tasks: Array<{ taskId: string; title: string }> };
      };
      const first = await call([{ task: "Alpha job", title: "alpha" }, { task: "Beta job", title: "beta" }]);
      const idOf = Object.fromEntries(first.tasks.map((entry) => [entry.title, entry.taskId]));
      // Same entries in a new order meet their own originals, not their positions'.
      const again = await call([{ task: "Beta job", title: "beta" }, { task: "Alpha job", title: "alpha" }]);
      expect(again.tasks.map((entry) => entry.taskId)).toEqual([idOf["beta"], idOf["alpha"]]);
      // A removed entry is simply not returned, and a new one starts.
      const partial = await call([{ task: "Alpha job", title: "alpha" }, { task: "Gamma job", title: "gamma" }]);
      expect(partial.tasks.map((entry) => entry.taskId)).toEqual([idOf["alpha"], expect.any(String)]);
      expect(partial.tasks[1]!.taskId).not.toBe(idOf["beta"]);
      expect((await harness.store.readDelegations()).filter((row) => row.parentThreadId === parentThreadId)).toHaveLength(3);
    } finally {
      await connection.close();
    }
  });

  it("does not carry a shared model across a provider override", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const result = await callMoxenTool(connection, parentThreadId, "delegate", {
        isolation: "shared",
        model: "gpt-5.4",
        tasks: [
          { task: "Same provider", title: "same" },
          { task: "Other provider", title: "other", provider: "codex" },
          { task: "Other provider with model", title: "own", provider: "codex", model: "gpt-5.4" },
        ],
      });
      expect(result.isError).toBe(false);
      const batch = JSON.parse(result.text) as { tasks: Array<Record<string, unknown>> };
      const modelOf = async (taskId: string) => (await harness.store.readThreadRecord(taskId as string))?.modelSelection;
      // The plain entry inherits the shared model on the parent's provider.
      expect(batch.tasks[0]).toMatchObject({ title: "same", isolation: "shared" });
      expect(await modelOf(batch.tasks[0]!["taskId"] as string)).toMatchObject({ instanceId: "opencode", model: "gpt-5.4" });
      // The override without a model does not start codex/gpt-5.4: it fails for want of a model.
      expect(batch.tasks[1]).toMatchObject({ title: "other", error: expect.stringContaining("MODEL_REQUIRED_FOR_PROVIDER") });
      // The override with its own model starts on exactly that.
      expect(batch.tasks[2]).toMatchObject({ title: "own", isolation: "shared" });
      expect(await modelOf(batch.tasks[2]!["taskId"] as string)).toMatchObject({ instanceId: "codex", model: "gpt-5.4" });
    } finally {
      await connection.close();
    }
  });

  it("refuses more than 20 tasks in one call with nothing started", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const tasks = Array.from({ length: 21 }, (_, index) => ({ task: `Job ${index + 1}`, title: `job-${index + 1}` }));
      const result = await callMoxenTool(connection, parentThreadId, "delegate", { isolation: "shared", tasks });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("at most 20");
      expect((await harness.store.readDelegations()).filter((row) => row.parentThreadId === parentThreadId)).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("refuses an entry field it does not know, naming it, with nothing started", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const result = await callMoxenTool(connection, parentThreadId, "delegate", {
        isolation: "shared",
        tasks: [{ task: "Sneaky job", title: "sneaky", mode: "research" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"mode"');
      expect((await harness.store.readDelegations()).filter((row) => row.parentThreadId === parentThreadId)).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("fails a forked batch with a worktree entry before starting anything", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const result = await callMoxenTool(connection, parentThreadId, "delegate", {
        fork: true,
        tasks: [
          { task: "Shared question", title: "shared" },
          { task: "Worktree question", title: "branched", isolation: "worktree" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("FORK_NEEDS_SHARED");
      expect((await harness.store.readDelegations()).filter((row) => row.parentThreadId === parentThreadId)).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("fails a batch with a model-less provider override before starting anything", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const result = await callMoxenTool(connection, parentThreadId, "delegate", {
        isolation: "shared",
        tasks: [
          { task: "Good job", title: "good" },
          { task: "Provider with no model", title: "modelless", provider: "codex" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("no model");
      expect((await harness.store.readDelegations()).filter((row) => row.parentThreadId === parentThreadId)).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("fails a batch delegate for a missing parent as the single form does", async () => {
    const { connection } = await setup();
    try {
      const result = await callMoxenTool(connection, "thread-missing", "delegate", {
        isolation: "shared",
        tasks: [
          { task: "First job", title: "first" },
          { task: "Second job", title: "second" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("THREAD_NOT_FOUND");
    } finally {
      await connection.close();
    }
  });

  it("refuses a batch delegate that mixes the forms or misuses research and rules", async () => {
    const { connection, parentThreadId } = await setup();
    try {
      const call = (args: Record<string, unknown>) => callMoxenTool(connection, parentThreadId, "delegate", args);
      expect((await call({ task: "x", title: "x", tasks: [{ task: "y", title: "y" }] })).text).toContain("not both");
      expect((await call({ tasks: [] })).text).toContain("non-empty array");
      expect((await call({ tasks: [{ title: "y" }] })).text).toContain("task is required");
      expect((await call({ tasks: [{ task: "y", title: "y" }], researchProposal: { size: { researchers: 1, critics: 1 } } })).text).toContain("cannot be combined");
      expect((await call({ task: "x", title: "x", rules: "Be brief." })).text).toContain("needs tasks");
      for (const reply of [
        await call({ task: "x", title: "x", tasks: [{ task: "y", title: "y" }] }),
        await call({ tasks: [] }),
      ]) expect(reply.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("returns the original task when a delegate call is retried with the same idempotency key", async () => {
    const { connection, parentThreadId, starts } = await setup();
    const mcp = mcpSession(connection, parentThreadId);
    try {
      const key = randomUUID();
      const call = async () => {
        const reply = await mcp.request("tools/call", {
          name: "delegate",
          arguments: { task: "Write the changelog", title: "Write changelog", isolation: "shared", idempotencyKey: key },
        });
        const result = reply.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(false);
        return JSON.parse(result.content[0]!.text) as { taskId: string };
      };
      const first = await call();
      const again = await call();
      expect(again.taskId).toBe(first.taskId);
      // The retry started no duplicate: one child session behind the parent's.
      const children = starts.filter((input) => input.threadId !== parentThreadId);
      expect(children).toHaveLength(1);
      expect(children[0]!.threadId).toBe(first.taskId);
    } finally {
      await mcp.close();
      await connection.close();
    }
  });

  it("runs a task in Build or Research as the model asks, and never in Orchestrate", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const modeOf = async (taskId: string) => (await (await openThreadStore(harness.root)).readThreadRecord(taskId))?.interactionMode;
      const build = JSON.parse((await callMoxenTool(connection, parentThreadId, "delegate", { task: "Scout", title: "scout", isolation: "shared" })).text) as { taskId: string };
      expect(await modeOf(build.taskId)).toBe("default");
      const research = JSON.parse((await callMoxenTool(connection, parentThreadId, "delegate", { task: "Look into it", title: "look", isolation: "shared", mode: "research" })).text) as { taskId: string };
      expect(await modeOf(research.taskId)).toBe("research");
      const refused = await callMoxenTool(connection, parentThreadId, "delegate", { task: "Plan it", title: "plan", isolation: "shared", mode: "orchestrate" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("never runs in Orchestrate");
    } finally {
      await connection.close();
    }
  });

  it("edits a memory and adds to it through the tools, and says why a refused edit was", async () => {
    const { connection, parentThreadId } = await setup();
    try {
      const call = (tool: string, args: Record<string, unknown>) => callMoxenTool(connection, parentThreadId, tool, args);
      await call("memory_save", { name: "bun-tests", description: "Tests run with bun", type: "feedback", body: "Use bun test.\nWhy: pinned.", scope: "project" });
      const edited = await call("memory_edit", { name: "bun-tests", scope: "project", old_string: "pinned", new_string: "the repo pins it" });
      expect(edited.isError).toBe(false);
      expect(JSON.parse(edited.text)).toEqual({ name: "bun-tests", scope: "project", total: 1 });
      expect((await call("memory_append", { name: "bun-tests", scope: "project", text: "Also: CI runs it." })).isError).toBe(false);
      expect((await call("memory_read", { name: "bun-tests", scope: "project" })).text).toContain("Use bun test.\nWhy: the repo pins it.\nAlso: CI runs it.");
      // An empty replacement removes the text.
      expect((await call("memory_edit", { name: "bun-tests", scope: "project", old_string: "\nAlso: CI runs it.", new_string: "" })).isError).toBe(false);
      const refused = await call("memory_edit", { name: "bun-tests", scope: "project", old_string: "not there", new_string: "x" });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("MEMORY_EDIT_NOT_FOUND");
      expect((await call("memory_append", { name: "missing", scope: "project", text: "x" })).text).toContain("MEMORY_NOT_FOUND");
    } finally {
      await connection.close();
    }
  });

  it("searches memory through MCP with scope and limits, allows read-only tasks and refuses memory-off sessions", async () => {
    const { connection, parentThreadId } = await setup();
    const mcp = mcpSession(connection, parentThreadId);
    try {
      for (const scope of ["project", "global"]) {
        await connection.dispatch({ type: "memory.save", threadId: parentThreadId, name: "checks", description: "Test workflow", memoryType: "feedback", body: "Use CI for verification.", scope: scope as "project" | "global" });
      }
      const searched = await mcp.request("tools/call", { name: "memory_search", arguments: { query: "CI", scope: "global", limit: 1 } });
      const result = searched.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toContain("checks (global, feedback): Test workflow");
      expect(result.content[0]!.text).toContain("Use CI for verification.");
      expect(result.content[0]!.text).not.toContain("checks (project");
      const limited = await callMoxenTool(connection, parentThreadId, "memory_search", { query: "CI", limit: 1 }, { delegated: true, memory: "read" });
      expect(limited.isError).toBe(false);
      expect(limited.text).toContain("2 matching memories; showing 1.");
      expect(limited.text).toContain("checks (project");
      const disabled = await callMoxenTool(connection, parentThreadId, "memory_search", { query: "CI" }, { memory: "off" });
      expect(disabled.isError).toBe(true);
      expect((await callMoxenTool(connection, parentThreadId, "memory_search", { query: "missing" })).text).toBe("No matching memories.");
      for (const args of [{}, { query: 4 }, { query: "CI", scope: "all" }, { query: "CI", limit: "1" }, { query: "CI", limit: 1.5 }, { query: "CI", limit: 51 }]) {
        expect((await callMoxenTool(connection, parentThreadId, "memory_search", args)).isError).toBe(true);
      }
    } finally {
      await mcp.close();
      await connection.close();
    }
  });

  it("tells the parent thread when a delegated task settles, with its facts for a card", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const delegated = JSON.parse(
        (await callMoxenTool(connection, parentThreadId, "delegate", { task: "Write the changelog", title: "changelog", isolation: "shared" })).text,
      ) as { taskId: string };
      // The task settles, then the batch window passes and the parent hears of it.
      const store = await openThreadStore(harness.root);
      const deadline = Date.now() + 8000;
      let notification: Record<string, unknown> | undefined;
      while (Date.now() < deadline && notification === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const messages = (await store.readMessages(parentThreadId)) as unknown as Array<Record<string, unknown>>;
        notification = messages.find((message) => message.origin === "task-notification");
      }
      expect(notification).toBeDefined();
      expect(notification!.text).toContain(`Task "changelog" (taskId ${delegated.taskId}) finished`);
      expect(notification!.text).toContain("Headline: Completed: Write the changelog");
      expect(notification!.notification).toMatchObject({
        tasks: [{ taskId: delegated.taskId, title: "changelog", status: "completed", headline: "Completed: Write the changelog" }],
      });
    } finally {
      await connection.close();
    }
  }, 15_000);

  it("waits for a task paused by a usage limit, and tells the parent when its resumed run ends", async () => {
    const { harness, connection, parentThreadId } = await setup();
    try {
      const delegated = JSON.parse(
        (await callMoxenTool(connection, parentThreadId, "delegate", { task: "Write the changelog", title: "changelog", isolation: "shared" })).text,
      ) as { taskId: string };
      const store = await openThreadStore(harness.root);
      // The limit hit: the task's turn ended and a continue is held for the reset.
      const held = await sendTurn(store, delegated.taskId, {
        prompt: "continue",
        scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
        scheduleReason: "usage-reset",
      });
      const notifications = async () =>
        ((await store.readMessages(parentThreadId)) as unknown as Array<Record<string, unknown>>).filter((message) => message.origin === "task-notification");
      // Past the batch window the parent still has heard nothing: the task has not finished.
      await new Promise((resolve) => setTimeout(resolve, TASK_NOTIFICATION_BATCH_MS + 1_000));
      expect(await notifications()).toHaveLength(0);

      // The reset passes; the resumed run ends and now the parent is told.
      await store.updateTurn(delegated.taskId, held.turn.id, { scheduledFor: new Date(Date.now() - 1_000).toISOString() });
      connection.startScheduling();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await notifications()).length === 0) await new Promise((resolve) => setTimeout(resolve, 200));
      const [notification] = await notifications();
      expect(notification?.text).toContain(`taskId ${delegated.taskId}) finished`);
    } finally {
      await connection.close();
    }
  }, 25_000);

  it("forks: the task resumes a copy of the parent's conversation, in the parent's checkout", async () => {
    const { connection, parentThreadId, starts } = await setup();
    try {
      const delegated = JSON.parse(
        (await callMoxenTool(connection, parentThreadId, "delegate", { task: "What did we decide about caching?", title: "caching", fork: true })).text,
      ) as { taskId: string; isolation: string };
      expect(delegated.isolation).toBe("shared");
      const childStart = starts.find((input) => input.threadId === delegated.taskId);
      expect(childStart?.resumeCursor).toBe(`fork-of-harness-session-${parentThreadId}`);
      const inWorktree = await callMoxenTool(connection, parentThreadId, "delegate", { task: "x", title: "x", fork: true, isolation: "worktree" });
      expect(inWorktree).toMatchObject({ isError: true, text: expect.stringContaining("FORK_NEEDS_SHARED") });
    } finally {
      await connection.close();
    }
  });

  it("answers bad input and unknown tasks as tool errors, not protocol errors", async () => {
    const { connection, parentThreadId } = await setup();
    try {
      expect(await callMoxenTool(connection, parentThreadId, "delegate", {})).toMatchObject({ isError: true, text: expect.stringContaining("task is required") });
      expect(await callMoxenTool(connection, parentThreadId, "delegate", { task: "x", title: "x", isolation: "sideways" })).toMatchObject({ isError: true });
      expect(await callMoxenTool(connection, parentThreadId, "task_status", { taskId: "nope", waitMs: 0 })).toMatchObject({
        isError: true,
        text: expect.stringContaining("TASK_NOT_FOUND"),
      });
      expect(await callMoxenTool(connection, parentThreadId, "frobnicate", {})).toMatchObject({ isError: true });
    } finally {
      await connection.close();
    }
  });

  it("returns a running task after the wait instead of blocking", async () => {
    const { connection, parentThreadId } = await setup({ leaveTurnsRunning: true });
    try {
      const delegated = JSON.parse(
        (await callMoxenTool(connection, parentThreadId, "delegate", { task: "Long job", title: "long job", isolation: "shared" })).text,
      ) as { taskId: string };
      const sleeps: number[] = [];
      const status = await callMoxenTool(connection, parentThreadId, "task_status", { taskId: delegated.taskId, waitMs: 0 }, {
        sleep: async (ms) => void sleeps.push(ms),
      });
      expect(JSON.parse(status.text)).toMatchObject({ status: "running", finished: false });
      const cancelled = await callMoxenTool(connection, parentThreadId, "task_cancel", { taskId: delegated.taskId });
      expect(JSON.parse(cancelled.text)).toMatchObject({ cancelRequested: true });
    } finally {
      await connection.close();
    }
  });

  it("can be switched off per project with moxen.json", async () => {
    const { harness, connection, starts } = await setup();
    try {
      await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify({ mcpServers: { moxen: null } }));
      const other = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Again", wait: true, threadEnvMode: "local" });
      const start = starts.find((input) => input.threadId === other.threadId);
      expect(start).not.toHaveProperty("mcpServers");
      expect(String(start?.instructions)).not.toContain("# Moxen knowledge base");
    } finally {
      await connection.close();
    }
  });

  it("lends its checklist only to a client that asks, and records it as the thread's plan", async () => {
    const { harness, connection, parentThreadId, starts } = await setup();
    const plain = mcpSession(connection, parentThreadId);
    const lent = mcpSession(connection, parentThreadId, true);
    try {
      const names = async (session: ReturnType<typeof mcpSession>) =>
        ((await session.request("tools/list")).result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
      expect(await names(plain)).not.toContain("todos");
      expect(await names(lent)).toContain("todos");

      const called = await lent.request("tools/call", {
        name: "todos",
        arguments: { todos: [{ content: "Read the code", status: "completed" }, { content: "Fix it", status: "in_progress" }] },
      });
      expect(called.result).toMatchObject({ isError: false });
      const store = await openThreadStore(harness.root);
      const plans = (await store.readActivities(parentThreadId)).filter((row) => row.kind === "turn.plan.updated");
      expect(plans.at(-1)?.payload).toEqual({ plan: [{ step: "Read the code", status: "completed" }, { step: "Fix it", status: "in_progress" }] });
      expect(await callMoxenTool(connection, parentThreadId, "todos", { todos: [{ content: "x", status: "done" }] })).toMatchObject({ isError: true });

      // The out-of-process form a checklist-less provider takes asks for it.
      const spec = (starts.find((input) => input.threadId === parentThreadId) as { mcpServers: Array<Record<string, any>> }).mcpServers.find(
        (server) => server.name === "moxen",
      )!;
      const lending = spec.checklist as { type: string; url?: string; args?: string[] };
      expect(lending.type === "http" ? lending.url : lending.args).toEqual(
        lending.type === "http" ? expect.stringMatching(/\?checklist=1$/) : expect.arrayContaining(["--checklist"]),
      );
    } finally {
      await plain.close();
      await lent.close();
      await connection.close();
    }
  });

  it("is hosted in-process unless the project points the name at a server of its own", async () => {
    const { harness, connection, starts, parentThreadId } = await setup();
    try {
      const first = starts.find((input) => input.threadId === parentThreadId) as { mcpServers: Array<{ name: string; type: string }> };
      expect(first.mcpServers.find((server) => server.name === "moxen")?.type).toBe("in-process");
      await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify({ mcpServers: { moxen: { command: "my-moxen" } } }));
      const other = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Again", wait: true, threadEnvMode: "local" });
      const start = starts.find((input) => input.threadId === other.threadId) as { instructions: string; mcpServers: Array<Record<string, unknown>> };
      expect(start.mcpServers.find((server) => server.name === "moxen")).toMatchObject({ type: "stdio", command: "my-moxen" });
      expect(String(start.instructions)).not.toContain("# Moxen knowledge base");
    } finally {
      await connection.close();
    }
  });
});

describe("moxen web_fetch", () => {
  const api = {} as ClientApi;

  it("keeps web fetch, knowledge and memory reads in a delegated task, and refuses delegation tools", async () => {
    const result = await callMoxenTool(api, "t1", "delegate", { task: "x" }, { delegated: true });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("not available in a delegated task");
    expect(moxenToolsFor({ delegated: true, checklist: true, memory: "read" }).map((tool) => tool.name)).toEqual(["knowledge_search", "knowledge_read", "context_usage", "web_fetch", "memory_read", "memory_search", "todos"]);
  });

  it("gives a delegated task memory to read, and refuses it the memory writes it is never shown", async () => {
    for (const tool of ["memory_save", "memory_edit", "memory_append", "memory_delete"]) {
      const result = await callMoxenTool(api, "t1", tool, { name: "x", scope: "project" }, { delegated: true, memory: "read" });
      expect(result).toMatchObject({ isError: true });
      expect(result.text).toContain("not available in a delegated task");
    }
    expect(moxenToolsFor({ memory: "off" }).some((tool) => tool.name.startsWith("memory_"))).toBe(false);
  });

  it("reads a page on this machine as text, marked as data from outside", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><title>Docs</title><body><p>Hello there</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await callMoxenTool(api, "t1", "web_fetch", { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("Hello there");
      expect(result.text).toContain("<untrusted_context");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not reach cloud metadata or the local network, however the address is written", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://10.0.0.5:8080/"]) {
      const result = await callMoxenTool(api, "t1", "web_fetch", { url });
      expect(result.isError).toBe(true);
    }
  });
  it("starts no browser when the shared setting says never, whichever provider asks", async () => {
    const off = { web: async () => webPolicy({ browser: "off" }, undefined, false) };
    const rendered = await callMoxenTool(api, "t1", "web_fetch", { url: "https://example.com/", render: true }, off);
    expect(rendered).toMatchObject({ isError: true });
    expect(rendered.text).toContain("No browser is available");
    // The Harness's older key says the same for every provider now.
    const legacy = await callMoxenTool(api, "t1", "web_fetch", { url: "https://example.com/", render: true }, { web: async () => webPolicy(undefined, { webBrowser: "off" }, false) });
    expect(legacy.text).toContain("No browser is available");
  });

  it("reads the shared web settings through the server, as the HTTP and stdio paths do", async () => {
    const served = (config: unknown) => ({ query: async () => ({ path: "", exists: true, settings: describeSettings(normalizeConfig(config)) }) }) as unknown as ClientApi;
    const off = await callMoxenTool(served({ web: { browser: "off" } }), "t1", "web_fetch", { url: "https://example.com/", render: true });
    expect(off.text).toContain("No browser is available");
    const legacy = await callMoxenTool(served({ providers: { harness: { webBrowser: "off" } } }), "t1", "web_fetch", { url: "https://example.com/", render: true });
    expect(legacy.text).toContain("No browser is available");
  });

  it("is left off the list, and refused, for a provider that has it switched off", async () => {
    expect(moxenToolsFor({ webFetch: false }).map((tool) => tool.name)).not.toContain("web_fetch");
    expect(await callMoxenTool(api, "t1", "web_fetch", { url: "https://example.com/" }, { webFetch: false })).toMatchObject({ isError: true, text: expect.stringContaining("switched off") });
  });

  it("keeps cloud metadata out even when private networks are allowed", async () => {
    const open = { web: async () => webPolicy({ privateNetwork: true }, undefined, false) };
    const result = await callMoxenTool(api, "t1", "web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }, open);
    expect(result.isError).toBe(true);
  });
});

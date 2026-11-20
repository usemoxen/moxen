import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../../../errors.js";
import { driverForInstance } from "../../../threads/execute.js";
import {
  permissionActivityRow,
  userInputActivityRow,
  type PermissionRuntimeEvent,
  type UserInputRuntimeEvent,
} from "../../../threads/requestactivity.js";
import { toolActivityRow, type ToolRuntimeEvent } from "../../../threads/toolactivity.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { AcpDriver } from "../driver.js";
import { ACP_PROTOCOL_VERSION } from "../protocol.js";
import { FakeAcpTransport } from "./fakes.js";

const START = { threadId: "thread-1", workingDirectory: path.resolve("repo") };

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof CliError) return cause.code;
    throw cause;
  }
  throw new Error("expected a CliError");
}

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("ACP handshake & protocol version pinning", () => {
  it("sends pinned protocolVersion=1 and refuses a newer or mismatched agent version", async () => {
    const transport = new FakeAcpTransport({ protocolVersion: 2 });
    const driver = new AcpDriver({ transport });
    const code = await codeOf(() => Effect.runPromise(driver.startSession(START)));
    expect(code).toBe("ACP_PROTOCOL_VERSION_UNSUPPORTED");
    expect(transport.sessions[0]!.server.requestsTo("initialize")[0]!.params).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
    });
    expect(transport.sessions[0]!.client.closed).toBe(true);
    expect(await Effect.runPromise(driver.hasSession("thread-1"))).toBe(false);
  });

  it("routes acp/<agent-id> to the configured launch spec and rejects unknown ids", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({
      transport,
      agents: {
        cline: { id: "cline", name: "Cline", command: "cline", args: ["--acp"] },
      },
    });
    await Effect.runPromise(
      driver.startSession({
        ...START,
        modelSelection: { instanceId: "acp/cline", model: "default" },
      }),
    );
    expect(transport.sessions[0]!.server.spawnOptions.agent).toMatchObject({
      id: "cline",
      command: "cline",
      args: ["--acp"],
    });
    await Effect.runPromise(driver.stopAll());

    const unknownCode = await codeOf(() =>
      Effect.runPromise(
        driver.startSession({
          threadId: "thread-2",
          workingDirectory: START.workingDirectory,
          modelSelection: { instanceId: "acp/nope", model: "default" },
        }),
      ),
    );
    expect(unknownCode).toBe("ACP_AGENT_UNKNOWN");
  });
});

describe("ACP session resume", () => {
  it("does not silently replace a conversation when session/load fails for authentication", async () => {
    const transport = new FakeAcpTransport({
      failRequests: { "session/load": "authentication required" },
    });
    const driver = new AcpDriver({ transport });
    const code = await codeOf(() =>
      Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" })),
    );
    expect(code).toBe("ACP_AUTH_REQUIRED");
    expect(transport.sessions[0]!.server.requestsTo("session/new")).toEqual([]);
  });

  it("reattaches via session/load when resumeCursor is valid", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("session/load")[0]!.params).toMatchObject({
      sessionId: "acp-old",
      cwd: START.workingDirectory,
    });
    expect(server.requestsTo("session/new")).toEqual([]);
    expect(driver.resumeCursor("thread-1")).toBe("acp-old");
    await Effect.runPromise(driver.stopAll());
  });

  it("falls back to session/new when the agent lost the previous session", async () => {
    const transport = new FakeAcpTransport({ lostSessions: ["acp-old"] });
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    expect(transport.sessions[0]!.server.requestsTo("session/new")).toHaveLength(1);
    expect(driver.resumeCursor("thread-1")).toBe("acp-sess-1");
    await Effect.runPromise(driver.stopAll());
  });
});

describe("ACP streaming, notes, reasoning, tools & plans (UI/UX parity)", () => {
  it("streams interim notes, reasoning, tool diffs, plans, and measures generation excluding tools/reasoning", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "fix it" }));
    const server = transport.sessions[0]!.server;

    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking carefully..." },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "reasoning.delta")).toBe(true));

      now = 2_000;
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Checking file." },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "message.part.updated")).toBe(true));

      now = 2_500;
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Edit src/a.ts",
        kind: "edit",
        status: "in_progress",
        rawInput: { file_path: "src/a.ts" },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "assistant.note")).toBe(true));
      await vi.waitFor(() => expect(events.some((e) => e.type === "tool.execute.started")).toBe(true));

      // Long tool execution should NOT inflate generation durationMs.
      now = 22_500;
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        content: [{ type: "diff", path: "src/a.ts", oldText: "a\n", newText: "b\n" }],
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "plan",
        entries: [
          { content: "Edit file", status: "completed", priority: "high" },
          { content: "Run tests", status: "in_progress", priority: "medium" },
        ],
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "All done." },
      });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "message.part.updated")).toHaveLength(2),
      );
      now = 23_000;
      server.finishPrompt("end_turn");

      const outcome = await driver.awaitTurn("thread-1", sent.turnId);
      expect(outcome.status).toBe("completed");
      expect(outcome.text).toBe("All done.");
      expect(outcome.generation).toEqual({ characters: "Checking file.".length + "All done.".length, durationMs: 1_000 });

      // Verify tool activity row normalizes identically for TUI/Desktop rendering.
      const completedTool = events.find((e): e is ToolRuntimeEvent => e.type === "tool.execute.completed");
      expect(completedTool).toBeDefined();
      const row = toolActivityRow(completedTool!);
      expect(row).not.toBeNull();
      expect(row!.kind).toBe("tool-call.completed");
      expect(row!.payload["itemType"]).toBe("file_change");

      // Verify plan row matches the tasks panel shape.
      const planEvent = events.find((e) => e.type === "turn.plan.updated");
      expect(planEvent).toMatchObject({
        raw: {
          plan: [
            { step: "Edit file", status: "completed" },
            { step: "Run tests", status: "in_progress" },
          ],
        },
      });
    } finally {
      clock.mockRestore();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });
});

describe("ACP permissions, cancellation & worktree isolation", () => {
  it("parks permission requests, renders through permissionActivityRow, and honors acceptForSession", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, runtimeMode: "approval-required" }));
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    const server = transport.sessions[0]!.server;
    const options = [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ];

    const pending = server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-1", title: "Run tests", kind: "execute", rawInput: { command: "bun test" } },
      options,
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission.request.opened")).toBe(true));
    const opened = events.find((e) => e.type === "permission.request.opened") as PermissionRuntimeEvent;
    const row = permissionActivityRow(opened);
    expect(row.kind).toBe("permission.requested");
    expect(row.payload["toolName"]).toBe("Bash");
    expect(row.payload["detail"]).toBe("bun test");

    await Effect.runPromise(driver.respondToRequest("thread-1", opened.requestId, { kind: "acceptForSession" }));
    expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "always" } });

    // Second identical request is auto-approved without parking.
    const second = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-2", title: "Run tests", kind: "execute", rawInput: { command: "bun test" } },
      options,
    });
    expect(second).toEqual({ outcome: { outcome: "selected", optionId: "always" } });

    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopAll());
  });

  it("unblocks parked permissions on interruptTurn so the peer never deadlocks", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, runtimeMode: "approval-required" }));
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "run" }));
    const server = transport.sessions[0]!.server;

    const pending = server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-1", title: "Shell", kind: "execute", rawInput: { command: "echo hi" } },
      options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission.request.opened")).toBe(true));

    await Effect.runPromise(driver.interruptTurn("thread-1", sent.turnId));
    expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
    expect((await driver.awaitTurn("thread-1", sent.turnId)).status).toBe("interrupted");
    expect(server.notificationsTo("session/cancel")).toHaveLength(1);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopAll());
  });

  it("enforces worktree isolation on permissions, fs/write_text_file, and terminal/create even in full-access", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-iso-"));
    tempDirs.push(base);
    const mainDir = path.join(base, "main");
    const wtDir = path.join(base, "wt");
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(
      driver.startSession({
        threadId: "thread-1",
        workingDirectory: wtDir,
        runtimeMode: "full-access",
        isolation: { worktreeRoot: wtDir, protectedRoots: [mainDir] },
      }),
    );
    const server = transport.sessions[0]!.server;

    // 1. Permission targeting main checkout is declined even in full-access.
    const perm = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: {
        toolCallId: "tc-1",
        title: "Edit main",
        kind: "edit",
        locations: [{ path: path.join(mainDir, "secret.ts") }],
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    expect(perm).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    // 2. fs/write_text_file into main checkout is rejected; write inside worktree succeeds.
    await expect(
      server.ask("fs/write_text_file", { path: path.join(mainDir, "a.txt"), content: "nope" }),
    ).rejects.toThrow(/worktree/i);
    const insideFile = path.join(wtDir, "ok.txt");
    await server.ask("fs/write_text_file", { path: insideFile, content: "line1\nline2\nline3" });
    expect(await readFile(insideFile, "utf8")).toBe("line1\nline2\nline3");
    expect(await server.ask("fs/read_text_file", { path: insideFile, line: 2, limit: 1 })).toEqual({
      content: "line2",
    });

    // 3. terminal/create targeting main checkout is rejected; running inside worktree succeeds.
    await expect(
      server.ask("terminal/create", { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: mainDir }),
    ).rejects.toThrow(/worktree/i);
    const created = (await server.ask("terminal/create", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-acp')"],
      cwd: wtDir,
    })) as { terminalId: string };
    const exit = await server.ask("terminal/wait_for_exit", { terminalId: created.terminalId });
    expect(exit).toEqual({ exitCode: 0, signal: null });
    const out = await server.ask("terminal/output", { terminalId: created.terminalId });
    expect(out).toMatchObject({ output: "hello-acp", truncated: false });
    await server.ask("terminal/release", { terminalId: created.terminalId });

    await Effect.runPromise(driver.stopAll());
  });
});

describe("ACP crash recovery & rollback", () => {
  it("settles an open turn as failed when the ACP peer exits unexpectedly", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId);
    // Simulate unexpected crash of the agent process.
    transport.sessions[0]!.client.close();
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBeTruthy();
  });

  it("supports readThread and refuses rollbackThread with REVERT_UNSUPPORTED (supportsConversationRollback: false)", async () => {
    const transport = new FakeAcpTransport({
      onPrompt: () => ({ stopReason: "end_turn" }),
    });
    const driver = new AcpDriver({ transport });
    expect(driver.capabilities.supportsConversationRollback).toBe(false);
    await Effect.runPromise(driver.startSession(START));
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    await driver.awaitTurn("thread-1", t1.turnId);
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    await driver.awaitTurn("thread-1", t2.turnId);

    expect((await Effect.runPromise(driver.readThread("thread-1"))).turns).toHaveLength(2);
    expect(await codeOf(() => Effect.runPromise(driver.rollbackThread("thread-1", 1)))).toBe("REVERT_UNSUPPORTED");
    // Transcript stays intact (never silently desynchronized from the live ACP session).
    expect((await Effect.runPromise(driver.readThread("thread-1"))).turns).toHaveLength(2);
    await Effect.runPromise(driver.stopAll());
  });

  it("prepends runtime instructions only on the first normal turn, skips slash commands, and restores them on failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-inst-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "readme.txt"), "hi", "utf8");
    let promptCalls = 0;
    const transport = new FakeAcpTransport({
      onPrompt: () => {
        promptCalls += 1;
        if (promptCalls === 2) throw new Error("transient network error");
        return { stopReason: "end_turn" };
      },
    });
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(
      driver.startSession({
        threadId: "thread-1",
        workingDirectory: dir,
        instructions: "# Runtime\nStay in worktree.",
      }),
    );
    // 1. Leading slash command keeps its leading `/compact` untouched; instructions stay pending.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "/compact" }));
    await driver.awaitTurn("thread-1", t1.turnId);
    // 2. First normal turn fails transiently; instructions are restored for the retry.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "first" }));
    expect((await driver.awaitTurn("thread-1", t2.turnId)).status).toBe("failed");
    // 3. Retry succeeds with instructions; 4. Following turn omits them.
    const t3 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "first retry" }));
    expect((await driver.awaitTurn("thread-1", t3.turnId)).status).toBe("completed");
    const t4 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "second" }));
    await driver.awaitTurn("thread-1", t4.turnId);

    const prompts = transport.sessions[0]!.server.requestsTo("session/prompt");
    const textAt = (index: number) =>
      String((prompts[index]!.params as { prompt: Array<{ text: string }> }).prompt[0]!.text);
    expect(textAt(0)).toBe("/compact");
    expect(textAt(1)).toContain("Stay in worktree.");
    expect(textAt(2)).toContain("Stay in worktree.");
    expect(textAt(3)).not.toContain("Stay in worktree.");
    await Effect.runPromise(driver.stopAll());
  });

  it("applies model and thought_level effort via session/set_config_option and skips synthetic default slugs", async () => {
    const transport = new FakeAcpTransport({
      configOptions: [
        {
          id: "model",
          category: "model",
          name: "Model",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-4-argon", name: "Gemini 4 Argon" },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          name: "Thought Level",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" },
          ],
        },
      ],
      onPrompt: () => ({ stopReason: "end_turn" }),
    });
    const driver = new AcpDriver({
      transport,
      agents: {
        antigravity: { id: "antigravity", name: "Antigravity", command: "agy", args: ["acp"] },
      },
    });

    // Synthetic default slug should not issue a set_config_option for model, but effort still applies.
    await Effect.runPromise(
      driver.startSession({
        ...START,
        modelSelection: {
          instanceId: "antigravity",
          model: "antigravity-default",
          options: [{ id: "effort", value: "xhigh" }],
        },
      }),
    );
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("session/set_config_option").map((r) => r.params)).toEqual([
      { sessionId: "acp-sess-1", configId: "thought_level", value: "xhigh" },
    ]);

    // Switching model and effort on a subsequent turn forwards both options.
    const t1 = await Effect.runPromise(
      driver.sendTurn({
        threadId: "thread-1",
        prompt: "switch",
        modelSelection: {
          instanceId: "antigravity",
          model: "gemini-4-argon",
          options: [{ id: "effort", value: "low" }],
        },
      }),
    );
    await driver.awaitTurn("thread-1", t1.turnId);
    expect(server.requestsTo("session/set_config_option").map((r) => r.params)).toEqual([
      { sessionId: "acp-sess-1", configId: "thought_level", value: "xhigh" },
      { sessionId: "acp-sess-1", configId: "model", value: "gemini-4-argon" },
      { sessionId: "acp-sess-1", configId: "thought_level", value: "low" },
    ]);
    await Effect.runPromise(driver.stopAll());
  });

  it("records ACP usage_update context readings, turn token usage, and Antigravity plan usage with credits", async () => {
    const transport = new FakeAcpTransport({
      sessionMeta: { antigravity: { tier: { name: "Google AI Pro" } } },
      onPrompt: (server) => {
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "usage_update",
          used: 12_400,
          size: 1_000_000,
          cost: 0.042,
        });
        return {
          stopReason: "end_turn",
          usage: {
            inputTokens: 9_000,
            cachedReadTokens: 3_000,
            outputTokens: 400,
            thoughtTokens: 150,
            totalTokens: 12_550,
          },
        };
      },
    });
    const probeUsage = vi.fn(async () => ({
      windows: [
        { id: "gemini-5h", label: "Session – Gemini", usedPercent: 80, exhausted: false, resetsAt: "2026-11-20T18:16:16.000Z" },
      ],
      credits: 25,
    }));
    const driver = new AcpDriver({
      provider: "antigravity",
      transport,
      agents: { antigravity: { id: "antigravity", name: "Antigravity", command: "agy", args: ["acp"] } },
      probeUsage,
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession({ ...START, modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" } }));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hello" }));
      const outcome = await driver.awaitTurn("thread-1", sent.turnId);
      expect(outcome.usage).toEqual({
        input: 9_000,
        cacheRead: 3_000,
        cacheCreate: 0,
        output: 400,
        thinking: 150,
      });
      expect(await driver.contextUsage("thread-1")).toEqual({
        usedTokens: 12_400,
        maxTokens: 1_000_000,
        cachedInputTokens: 3_000,
        autoCompactThreshold: null,
        compactsAutomatically: null,
        costUsd: 0.042,
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "rate-limits.updated")).toBe(true));
      expect(events.find((e) => e.type === "rate-limits.updated")).toMatchObject({
        provider: "antigravity",
        credits: 25,
        raw: { subscriptionType: "Google AI Pro" },
      });
      expect(await driver.refreshUsage()).toEqual({
        key: "antigravity",
        windows: [
          { id: "gemini-5h", label: "Session – Gemini", usedPercent: 80, exhausted: false, resetsAt: "2026-11-20T18:16:16.000Z" },
        ],
        credits: 25,
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("canonicalizes ACP MCP calls, Run-prefixed tools, directory listings, URL reads, and web/glob searches", async () => {
    const transport = new FakeAcpTransport({
      onPrompt: (server) => {
        // 1. Lazy call_mcp_tool emitted with kind: "execute" and title: "MCP Tool save_comment"
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-mcp-lazy",
          kind: "execute",
          title: "MCP Tool save_comment",
          status: "completed",
          rawInput: {
            ServerName: "linear_linear",
            ToolName: "save_comment",
            Arguments: { issueId: "MXN-434", body: "Done" },
          },
        });
        // 2. Eager MCP tool emitted with kind: "other" and title: "Run mcp_linear_get_issue"
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-mcp-eager",
          kind: "other",
          title: "Run mcp_linear_get_issue",
          status: "completed",
          rawInput: { id: "MXN-434", toolSummary: "Get issue" },
        });
        // 3. Built-in manage_task emitted with kind: "other" and title: "Run manage_task"
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-manage",
          kind: "other",
          title: "Run manage_task",
          status: "completed",
          rawInput: { Action: "status", TaskId: "conv/task-339" },
        });
        // 4. list_dir emitted with kind: "read" and title: "Directory src/tui"
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-dir",
          kind: "read",
          title: "Directory src/tui",
          status: "completed",
          rawInput: { DirectoryPath: "/Users/aaron/repo/src/tui" },
        });
        // 5. search_web emitted with kind: "search" and title: '"acp spec" on Web'
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-web",
          kind: "search",
          title: '"acp spec" on Web',
          status: "completed",
          rawInput: { query: "acp spec" },
        });
        // 6. find_by_name emitted with kind: "search" and title: 'Files named "*.ts" in src'
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "tc-glob",
          kind: "search",
          title: 'Files named "*.ts" in src',
          status: "completed",
          rawInput: { Pattern: "*.ts", SearchDirectory: "src" },
        });
        return { stopReason: "end_turn" };
      },
    });
    const driver = new AcpDriver({ transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "tools" }));
      await driver.awaitTurn("thread-1", sent.turnId);
      const completed = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { readonly tool: string }> =>
          e.type === "tool.execute.completed",
      );
      expect(completed.map((e) => [e.tool, (e.raw as Record<string, unknown>)["input"]])).toEqual([
        ["mcp__linear_linear__save_comment", { issueId: "MXN-434", body: "Done" }],
        ["mcp__linear__get_issue", { id: "MXN-434", toolSummary: "Get issue" }],
        ["manage_task", { Action: "status", TaskId: "conv/task-339" }],
        ["List", { DirectoryPath: "/Users/aaron/repo/src/tui", path: "/Users/aaron/repo/src/tui" }],
        ["WebSearch", { query: "acp spec" }],
        ["Glob", { Pattern: "*.ts", SearchDirectory: "src", pattern: "*.ts", path: "src" }],
      ]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("tracks backgrounded ACP commands and records out-of-turn completions and reactive wakeup turns", async () => {
    const transport = new FakeAcpTransport({
      onPrompt: (server) => {
        // Start a command that remains in_progress when the turn settles (backgrounded after WaitMsBeforeAsync).
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "tool_call",
          toolCallId: "call-bg-check",
          kind: "execute",
          title: "bun run check",
          status: "in_progress",
          rawInput: {
            CommandLine: "bun run check",
            WaitMsBeforeAsync: 10_000,
            toolSummary: "Full project check",
          },
        });
        server.notifyUpdate("acp-sess-1", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Waiting for bun run check." },
        });
        return { stopReason: "end_turn" };
      },
    });
    const driver = new AcpDriver({ transport, backgroundTurnIdleMs: 30 });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "check" }));
      await driver.awaitTurn("thread-1", sent.turnId);

      // The in_progress command is promoted to a live background task.
      expect(driver.backgroundTasks("thread-1")).toMatchObject([
        {
          taskId: "call-bg-check",
          taskType: "local_bash",
          toolName: "Bash",
          description: "Full project check",
          command: "bun run check",
        },
      ]);
      expect(events.some((e) => e.type === "background.task" && e.taskId === "call-bg-check" && e.status === "started")).toBe(true);

      const server = transport.sessions[0]!.server;
      // Now the background command finishes out-of-turn, and `agy acp` streams a reactive wakeup turn.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-bg-check",
        status: "completed",
        rawOutput: "Command exited with code 0.",
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Check finished cleanly." },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "All checks passed." },
      });

      await vi.waitFor(() => {
        expect(driver.backgroundTasks("thread-1")).toEqual([]);
        expect(
          events.some(
            (e) =>
              e.type === "tool.execute.completed" &&
              (e.raw as Record<string, unknown>)["toolCallId"] === "call-bg-check",
          ),
        ).toBe(true);
        expect(events.some((e) => e.type === "turn.started" && e.origin === "background")).toBe(true);
        expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
      });

      const bgStarted = events.find((e) => e.type === "turn.started" && e.origin === "background");
      expect(bgStarted).toBeDefined();
      if (bgStarted && bgStarted.type === "turn.started") {
        const bgOutcome = await driver.awaitTurn("thread-1", bgStarted.turnId);
        expect(bgOutcome.status).toBe("completed");
        expect(bgOutcome.text).toBe("All checks passed.");
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("does not split a wakeup turn across >350ms pauses, holds on turn-local tools, settles after post-text usage_update, and coalesces usage probes", async () => {
    const transport = new FakeAcpTransport();
    const probeUsage = vi.fn(async () => ({ windows: [], credits: 10 }));
    const driver = new AcpDriver({
      provider: "antigravity",
      agents: { antigravity: { id: "antigravity", name: "Antigravity", command: "agy", args: ["acp"] } },
      transport,
      // Use the production 10s mid-stream idle window with a short post-usage grace for fast tests.
      backgroundTurnPostUsageIdleMs: 40,
      probeUsage,
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(
        driver.startSession({
          ...START,
          modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
        }),
      );
      await vi.waitFor(() => expect(probeUsage).toHaveBeenCalledTimes(1));
      probeUsage.mockClear();
      const server = transport.sessions[0]!.server;

      // Realistic agy multi-step wakeup: thought -> usage_update -> tool_call (backgrounded) -> pause -> completion -> pause -> chunk1 -> 450ms pause -> chunk2 -> usage_update.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking output..." },
      });
      await new Promise((r) => setTimeout(r, 80));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "usage_update",
        used: 9_900,
        size: 1_048_576,
      });
      await new Promise((r) => setTimeout(r, 60));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-wakeup-cmd",
        kind: "execute",
        title: "echo check",
        status: "in_progress",
        rawInput: { CommandLine: "echo check", WaitMsBeforeAsync: 10 },
      });
      // Let WaitMsBeforeAsync promote it to background; turn must still stay open because no reply followed.
      await new Promise((r) => setTimeout(r, 70));
      expect(driver.backgroundTasks("thread-1").map((t) => t.taskId)).toEqual(["tc-wakeup-cmd"]);
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-wakeup-cmd",
        status: "completed",
        rawOutput: "ok",
      });
      await new Promise((r) => setTimeout(r, 80));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Part 1. " },
      });
      // Pause longer than the old 350ms idle cutoff before streaming Part 2.
      await new Promise((r) => setTimeout(r, 420));
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Part 2." },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "usage_update",
        used: 10_660,
        size: 1_048_576,
      });

      await vi.waitFor(() => expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1));
      const bgStarts = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { readonly type: "turn.started" }> =>
          e.type === "turn.started" && e.origin === "background",
      );
      expect(bgStarts).toHaveLength(1);
      const outcome = await driver.awaitTurn("thread-1", bgStarts[0]!.turnId);
      expect(outcome.status).toBe("completed");
      expect(outcome.text).toBe("Part 1. Part 2.");
      expect(probeUsage).toHaveBeenCalledTimes(1);

      // A second wakeup settling immediately afterward coalesces its forced usage probe.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Follow-up." },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "usage_update",
        used: 10_700,
        size: 1_048_576,
      });
      await vi.waitFor(() => expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(2));
      expect(probeUsage).toHaveBeenCalledTimes(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("drains cancelled session/prompt updates on interruptTurn without phantom background turns, Turn 2 leaks, or stale context overwrites", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport, backgroundTurnIdleMs: 25 });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const sent1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "write essay" }));
      const server = transport.sessions[0]!.server;

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Part 1" },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "message.part.updated")).toBe(true));

      await Effect.runPromise(driver.interruptTurn("thread-1", sent1.turnId));

      // Start Turn 2 immediately while Turn 1's cancelled session/prompt is still flushing.
      const send2Promise = Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "2+2?" }));

      // Per ACP spec, agent flushes trailing chunks before replying stopReason: "cancelled" with usage.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " trailing chunk" },
      });
      // Resolve Turn 1's session/prompt with cancelled + usage that must NOT overwrite session.context.
      server.finishPrompt("cancelled", {
        usage: { inputTokens: 99_999, outputTokens: 500 },
      });

      const sent2 = await send2Promise;
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "4" },
      });
      server.finishPrompt("end_turn");
      const outcome2 = await driver.awaitTurn("thread-1", sent2.turnId);

      expect(outcome2.text).toBe("4");
      expect(events.filter((e) => e.type === "turn.started" && e.origin === "background")).toEqual([]);
      expect(await driver.contextUsage("thread-1")).toBeNull();
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("rejects sendTurn with ACP_TURN_BUSY while a background wakeup turn is open and across concurrent set_config_option awaits", async () => {
    const transport = new FakeAcpTransport({
      configOptions: [
        {
          id: "model",
          category: "model",
          name: "Model",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-4-argon", name: "Gemini 4 Argon" },
          ],
        },
      ],
    });
    const driver = new AcpDriver({ transport, backgroundTurnIdleMs: 200 });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const server = transport.sessions[0]!.server;

      // 1. Open background turn rejects sendTurn so background chunks never leak into a user turn.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[BG part 1]" },
      });
      await vi.waitFor(
        () => expect(events.some((e) => e.type === "turn.started" && e.origin === "background")).toBe(true),
        { interval: 5 },
      );
      const busyBgCode = await codeOf(() =>
        Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "2+2?" })),
      );
      expect(busyBgCode).toBe("ACP_TURN_BUSY");
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[BG part 2]" },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "turn.completed")).toBe(true));
      const bgStart = events.find((e) => e.type === "turn.started" && e.origin === "background")!;
      if (bgStart.type === "turn.started") {
        expect((await driver.awaitTurn("thread-1", bgStart.turnId)).text).toBe("[BG part 1][BG part 2]");
      }

      // 2. Concurrent sendTurn during awaited session/set_config_option rejects the second call with ACP_TURN_BUSY.
      const p1 = Effect.runPromise(
        driver.sendTurn({
          threadId: "thread-1",
          prompt: "turn 1",
          modelSelection: { instanceId: "acp/agy", model: "gemini-4-argon" },
        }),
      );
      const p2 = codeOf(() =>
        Effect.runPromise(
          driver.sendTurn({
            threadId: "thread-1",
            prompt: "turn 2",
            modelSelection: { instanceId: "acp/agy", model: "gemini-4-argon" },
          }),
        ),
      );
      const [sent1, busyConcurrentCode] = await Promise.all([p1, p2]);
      expect(busyConcurrentCode).toBe("ACP_TURN_BUSY");
      expect(server.requestsTo("session/prompt")).toHaveLength(1);
      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", sent1.turnId);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("sends session/cancel and suppresses trailing updates when promptTimeoutMs expires", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({
      transport,
      promptTimeoutMs: 30,
      backgroundTurnIdleMs: 20,
      cancelQuietMs: 120,
      cancelDrainTimeoutMs: 500,
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "slow" }));
      const outcome = await driver.awaitTurn("thread-1", sent.turnId);
      expect(outcome.status).toBe("failed");

      const server = transport.sessions[0]!.server;
      await vi.waitFor(() => expect(server.notificationsTo("session/cancel")).toHaveLength(1));

      // Trailing chunks emitted after timeout must NOT spawn a phantom background turn.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "still running" },
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(events.some((e) => e.type === "turn.started" && e.origin === "background")).toBe(false);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("preserves canonicalTool, rawInput, and deduplicates turn.items across two-step tool_call -> tool_call_update", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
      const server = transport.sessions[0]!.server;

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-agent",
        kind: "other",
        title: "Run invoke_subagent",
        status: "in_progress",
        rawInput: { Role: "Codebase Researcher", Prompt: "Inspect driver" },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-agent",
        status: "completed",
        rawOutput: "Done",
      });

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-web",
        kind: "search",
        title: '"acp spec" on Web',
        status: "in_progress",
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-web",
        status: "completed",
      });

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-glob",
        kind: "search",
        title: 'Files named "*.ts"',
        status: "in_progress",
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-glob",
        status: "completed",
      });

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-list",
        kind: "read",
        title: "Directory src/core",
        status: "in_progress",
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-list",
        status: "completed",
      });

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-write",
        kind: "edit",
        title: "File src/new.ts",
        status: "in_progress",
        rawInput: { Path: "src/new.ts", Content: "export const x = 1;\n" },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-write",
        status: "completed",
        rawInput: {},
      });
      // Duplicate terminal update must not push a second item onto turn.items.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-write",
        status: "completed",
        rawOutput: "written",
      });

      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", sent.turnId);

      const started = events
        .filter((e): e is ToolRuntimeEvent => e.type === "tool.execute.started")
        .map((e) => e.tool);
      const completed = events.filter((e): e is ToolRuntimeEvent => e.type === "tool.execute.completed");
      expect(started).toEqual(["Agent", "WebSearch", "Glob", "List", "Write"]);
      expect(completed.map((e) => e.tool)).toEqual(["Agent", "WebSearch", "Glob", "List", "Write", "Write"]);
      const writeCompleted = completed.find(
        (e) => (e.raw as Record<string, unknown>)["toolCallId"] === "tc-write",
      )!;
      expect((writeCompleted.raw as Record<string, unknown>)["input"]).toMatchObject({
        Path: "src/new.ts",
        Content: "export const x = 1;\n",
      });

      const snapshot = await Effect.runPromise(driver.readThread("thread-1"));
      const toolItems = snapshot.turns[0]!.items.filter(
        (item) => (item as { kind: string }).kind === "tool",
      );
      expect(toolItems).toHaveLength(5);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("does not promote foreground Bash on thought chunks, settles in-progress tools on interrupt, and ignores unknown pre-restart tool_call_update without phantom turns", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport, backgroundTurnIdleMs: 30 });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const server = transport.sessions[0]!.server;

      // 1. Unknown pre-restart tool_call_update with no open turn must not spawn a phantom background turn.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-pre-restart",
        kind: "execute",
        title: "old cmd",
        status: "completed",
        rawOutput: "done",
      });
      await vi.waitFor(
        () =>
          expect(
            events.some(
              (e) =>
                e.type === "tool.execute.completed" &&
                (e.raw as Record<string, unknown>)["toolCallId"] === "tc-pre-restart",
            ),
          ).toBe(true),
        { interval: 5 },
      );
      expect(events.filter((e) => e.type === "turn.started" && e.origin === "background")).toEqual([]);

      // 2. Foreground Bash is NOT promoted on agent_thought_chunk; interrupt fails both Read and foreground Bash.
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-fg-bash",
        kind: "execute",
        title: "bun test",
        status: "in_progress",
        rawInput: { CommandLine: "bun test", WaitMsBeforeAsync: 60_000 },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-fg-read",
        kind: "read",
        title: "File src/a.ts",
        status: "in_progress",
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Waiting..." },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "reasoning.delta")).toBe(true), { interval: 5 });

      expect(driver.backgroundTasks("thread-1")).toEqual([]);

      await Effect.runPromise(driver.interruptTurn("thread-1", sent.turnId));
      await vi.waitFor(() => {
        const terminalIds = events
          .filter((e): e is ToolRuntimeEvent => e.type === "tool.execute.completed")
          .map((e) => (e.raw as Record<string, unknown>)["toolCallId"]);
        expect(terminalIds).toEqual(expect.arrayContaining(["tc-fg-bash", "tc-fg-read"]));
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("exposes backgroundTaskOutput from tool_call_update and client terminals, and stops only client-terminal-backed tasks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-bg-term-"));
    tempDirs.push(dir);
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession({ threadId: "thread-1", workingDirectory: dir }));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "run bg" }));
      const server = transport.sessions[0]!.server;

      // 1. Agent-internal background command (like agy's run_command): not stoppable, output from tool_call_update.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-internal",
        kind: "execute",
        title: "sleep 10",
        status: "in_progress",
        rawInput: { CommandLine: "sleep 10", IsDaemon: true },
      });
      await vi.waitFor(() =>
        expect(driver.backgroundTasks("thread-1").some((t) => t.taskId === "tc-internal")).toBe(true),
      );
      expect(driver.backgroundTasks("thread-1").find((t) => t.taskId === "tc-internal")?.stoppable).toBe(false);
      expect(await driver.backgroundTaskOutput("thread-1", "tc-internal")).toBeNull();

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-internal",
        status: "in_progress",
        rawOutput: { output: "line 1\r\nline 2\r\n", exit_code: null },
      });
      await vi.waitFor(async () => {
        expect(await driver.backgroundTaskOutput("thread-1", "tc-internal")).toEqual({
          lines: ["line 1", "line 2"],
        });
      });
      expect(await codeOf(() => Effect.runPromise(driver.stopBackgroundTask("thread-1", "tc-internal")))).toBe(
        "BACKGROUND_TASK_STOP_UNSUPPORTED",
      );
      expect(await codeOf(() => Effect.runPromise(driver.stopBackgroundTask("thread-1", "no-such-task")))).toBe(
        "BACKGROUND_TASK_NOT_FOUND",
      );

      // 2. Client-owned ACP terminal task: live output from AcpClientHandlers and stoppable: true.
      const created = (await server.ask("terminal/create", {
        command: process.execPath,
        args: ["-e", "process.stdout.write('term-ready\\n'); setInterval(() => {}, 10_000);"],
        cwd: dir,
      })) as { terminalId: string };
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-term",
        kind: "execute",
        title: "dev server",
        status: "in_progress",
        rawInput: { CommandLine: "dev server", IsDaemon: true },
        content: [{ type: "terminal", terminalId: created.terminalId }],
      });
      await vi.waitFor(async () => {
        const out = await driver.backgroundTaskOutput("thread-1", "tc-term");
        expect(out?.lines).toContain("term-ready");
      });
      expect(driver.backgroundTasks("thread-1").find((t) => t.taskId === "tc-term")?.stoppable).toBe(true);

      await Effect.runPromise(driver.stopBackgroundTask("thread-1", "tc-term"));
      expect(driver.backgroundTasks("thread-1").some((t) => t.taskId === "tc-term")).toBe(false);
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "background.task" && e.taskId === "tc-term" && e.status === "stopped")).toBe(true),
      );
      const exit = await server.ask("terminal/wait_for_exit", { terminalId: created.terminalId });
      expect(exit).toBeDefined();

      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", sent.turnId);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });
});

describe("ACP isolation, runtime modes, delegated permissions & parked lifecycle (MXN-441)", () => {
  const PERM_OPTIONS = [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ];

  it("blocks PascalCase agy Path, TargetFile, CommandLine, and Cwd under worktree isolation and replies allow_once in full-access", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-iso-pascal-"));
    tempDirs.push(base);
    const mainDir = path.join(base, "main");
    const wtDir = path.join(base, "wt");
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(
      driver.startSession({
        threadId: "thread-1",
        workingDirectory: wtDir,
        runtimeMode: "full-access",
        isolation: { worktreeRoot: wtDir, protectedRoots: [mainDir] },
      }),
    );
    const server = transport.sessions[0]!.server;

    // PascalCase Path / TargetFile into main checkout must be declined even in full-access.
    const byPath = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-1", title: "Write file", kind: "edit", rawInput: { Path: path.join(mainDir, "a.ts"), Content: "x" } },
      options: PERM_OPTIONS,
    });
    expect(byPath).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    const byTargetFile = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-2", title: "Edit file", kind: "edit", rawInput: { TargetFile: path.join(mainDir, "b.ts") } },
      options: PERM_OPTIONS,
    });
    expect(byTargetFile).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    // PascalCase CommandLine redirect and Cwd into main checkout must be declined.
    const byCommandLine = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-3", title: "Run git", kind: "execute", rawInput: { CommandLine: `git -C ${mainDir} status` } },
      options: PERM_OPTIONS,
    });
    expect(byCommandLine).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    const byCwd = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-4", title: "Run ls", kind: "execute", rawInput: { CommandLine: "ls", Cwd: mainDir } },
      options: PERM_OPTIONS,
    });
    expect(byCwd).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    // Safe call inside worktree in full-access must return allow_once (never allow_always).
    const safeEdit = await server.ask("session/request_permission", {
      sessionId: "acp-sess-1",
      toolCall: { toolCallId: "tc-5", title: "Edit ok", kind: "edit", rawInput: { Path: path.join(wtDir, "ok.ts") } },
      options: PERM_OPTIONS,
    });
    expect(safeEdit).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    await Effect.runPromise(driver.stopAll());
  });

  it("honors auto-accept-edits, live setRuntimeMode, and configured defaultMode via session/set_mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-modes-"));
    tempDirs.push(dir);
    const transport = new FakeAcpTransport({
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "accept-edits", name: "Accept edits" },
        ],
      },
    });
    const driver = new AcpDriver({
      transport,
      agents: {
        custom: { id: "custom", name: "Custom", command: "custom", args: [], defaultMode: "accept-edits" },
      },
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(
        driver.startSession({
          threadId: "thread-1",
          workingDirectory: dir,
          runtimeMode: "auto-accept-edits",
          modelSelection: { instanceId: "acp/custom", model: "default" },
        }),
      );
      const server = transport.sessions[0]!.server;
      // defaultMode applied via session/set_mode on session/new.
      expect(server.requestsTo("session/set_mode")).toEqual([
        { method: "session/set_mode", params: { sessionId: "acp-sess-1", modeId: "accept-edits" } },
      ]);

      // Workspace edit auto-approved with allow_once in auto-accept-edits.
      const editResp = await server.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-edit", title: "Edit a.ts", kind: "edit", rawInput: { Path: path.join(dir, "a.ts") } },
        options: PERM_OPTIONS,
      });
      expect(editResp).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

      // Shell command still parks for manual approval in auto-accept-edits, and renders CommandLine (not toolSummary).
      const execPending = server.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: {
          toolCallId: "tc-exec",
          title: "Run tests",
          kind: "execute",
          rawInput: { toolSummary: "Run tests", CommandLine: "bun run check" },
        },
        options: PERM_OPTIONS,
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "permission.request.opened")).toBe(true));
      const opened = events.find((e) => e.type === "permission.request.opened") as PermissionRuntimeEvent;
      expect(permissionActivityRow(opened).payload["detail"]).toBe("bun run check");
      await Effect.runPromise(driver.respondToRequest("thread-1", opened.requestId, { kind: "accept" }));
      expect(await execPending).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

      // Live setRuntimeMode downgrades to approval-required and calls session/set_mode("default").
      driver.setRuntimeMode("thread-1", "approval-required");
      await vi.waitFor(() =>
        expect(server.requestsTo("session/set_mode")).toContainEqual({
          method: "session/set_mode",
          params: { sessionId: "acp-sess-1", modeId: "default" },
        }),
      );
      const editNowParked = server.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: {
          toolCallId: "tc-edit-2",
          title: "Edit b.ts",
          kind: "edit",
          rawInput: { toolSummary: "Update b", Path: path.join(dir, "b.ts") },
        },
        options: PERM_OPTIONS,
      });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "permission.request.opened")).toHaveLength(2),
      );
      const opened2 = events.filter((e) => e.type === "permission.request.opened")[1] as PermissionRuntimeEvent;
      expect(permissionActivityRow(opened2).payload["detail"]).toBe(path.join(dir, "b.ts"));
      await Effect.runPromise(driver.respondToRequest("thread-1", opened2.requestId, { kind: "decline" }));
      expect(await editNowParked).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("cancels parked permissions when a turn settles without interruptTurn", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, runtimeMode: "approval-required" }));
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
      const server = transport.sessions[0]!.server;
      const pending = server.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-1", title: "Run", kind: "execute", rawInput: { CommandLine: "echo hi" } },
        options: PERM_OPTIONS,
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "permission.request.opened")).toBe(true));

      // Turn settles on its own without interruptTurn: parked permission must resolve as cancelled.
      server.finishPrompt("end_turn");
      expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
      expect((await driver.awaitTurn("thread-1", sent.turnId)).status).toBe("completed");
      await vi.waitFor(() => expect(events.some((e) => e.type === "permission.request.resolved")).toBe(true));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("allows delegated ACP threads in auto and auto-accept-edits to run mode-permitted actions while declining interactive-only prompts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-delegated-"));
    tempDirs.push(dir);
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });

    // 1. Delegated in `auto` mode (the default).
    await Effect.runPromise(
      driver.startSession({
        threadId: "thread-auto",
        workingDirectory: dir,
        runtimeMode: "auto",
        delegated: true,
      }),
    );
    const autoServer = transport.sessions[0]!.server;

    expect(
      await autoServer.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-edit", title: "Edit", kind: "edit", rawInput: { Path: path.join(dir, "src.ts") } },
        options: PERM_OPTIONS,
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    expect(
      await autoServer.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-safe", title: "Run test", kind: "execute", rawInput: { CommandLine: "bun test" } },
        options: PERM_OPTIONS,
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    // Sensitive command (git push) needs approval -> declined because delegated has no user.
    expect(
      await autoServer.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-push", title: "Push", kind: "execute", rawInput: { CommandLine: "git push origin main" } },
        options: PERM_OPTIONS,
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    // 2. Delegated in `auto-accept-edits` mode.
    await Effect.runPromise(
      driver.startSession({
        threadId: "thread-edits",
        workingDirectory: dir,
        runtimeMode: "auto-accept-edits",
        delegated: true,
      }),
    );
    const editsServer = transport.sessions[1]!.server;

    expect(
      await editsServer.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-edit-2", title: "Edit", kind: "edit", rawInput: { Path: path.join(dir, "a.ts") } },
        options: PERM_OPTIONS,
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    // Shell command in auto-accept-edits requires approval -> declined for delegated.
    expect(
      await editsServer.ask("session/request_permission", {
        sessionId: "acp-sess-1",
        toolCall: { toolCallId: "tc-cmd-2", title: "Run", kind: "execute", rawInput: { CommandLine: "bun test" } },
        options: PERM_OPTIONS,
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });

    await Effect.runPromise(driver.stopAll());
  });
});

describe("ACP session titles, startup notifications, and live agent config sync (MXN-442)", () => {
  it("handles session_info_update titles and buffers startup updates emitted during session/new and session/load", async () => {
    const transport = new FakeAcpTransport({
      onSessionNew: (server, sessionId) => {
        server.notifyUpdate(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "compact", description: "Compact conversation" }],
        });
        server.notifyUpdate(sessionId, {
          sessionUpdate: "usage_update",
          used: 4_000,
          size: 200_000,
        });
        server.notifyUpdate(sessionId, {
          sessionUpdate: "session_info_update",
          title: "Initial ACP Title",
        });
      },
      onSessionLoad: (server, sessionId) => {
        // Replayed history during session/load must NOT spawn a phantom background turn.
        server.notifyUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "old replayed text" },
        });
        server.notifyUpdate(sessionId, {
          sessionUpdate: "session_info_update",
          title: "Resumed ACP Title",
        });
      },
    });
    const driver = new AcpDriver({ transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const meta = driver.sessionMetadata("thread-1");
      expect(meta?.availableCommands).toEqual([
        { name: "compact", description: "Compact conversation", inputHint: null },
      ]);
      expect(await driver.contextUsage("thread-1")).toMatchObject({ usedTokens: 4_000, maxTokens: 200_000 });
      expect(await driver.sessionTitle("acp-sess-1", START.workingDirectory)).toBe("Initial ACP Title");
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "session.title.updated" && e.title === "Initial ACP Title")).toBe(true),
      );

      // Mid-session title update also publishes and updates sessionTitle().
      const server = transport.sessions[0]!.server;
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "session_info_update",
        title: "Refined ACP Title",
      });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "session.title.updated" && e.title === "Refined ACP Title")).toBe(true),
      );
      expect(await driver.sessionTitle("acp-sess-1", START.workingDirectory)).toBe("Refined ACP Title");

      // Resume via session/load: picks up title update without opening a phantom background turn from replay.
      await Effect.runPromise(driver.stopSession("thread-1"));
      await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-sess-1" }));
      expect(await driver.sessionTitle("acp-sess-1", START.workingDirectory)).toBe("Resumed ACP Title");
      expect(events.some((e) => e.type === "turn.started" && e.origin === "background")).toBe(false);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("refreshes cached AcpDriver agents live when providers.acp.agents changes", async () => {
    const owner = {};
    const transport = new FakeAcpTransport();
    const factories = {
      acp: () =>
        new AcpDriver({
          transport,
          agents: {
            cline: { id: "cline", name: "Cline", command: "cline", args: ["--acp"] },
          },
        }),
    };
    const initial = driverForInstance(owner, "acp/cline", factories, {
      acp: { agents: [{ id: "cline", name: "Cline", command: "cline", args: ["--acp"] }] },
    });
    expect(initial).toBeInstanceOf(AcpDriver);

    // Add a new agent profile `goose` without recreating the cached driver.
    const updated = driverForInstance(owner, "acp/goose", factories, {
      acp: {
        agents: [
          { id: "cline", name: "Cline", command: "cline", args: ["--acp"] },
          { id: "goose", name: "Goose", command: "goose", args: ["acp"] },
        ],
      },
    });
    expect(updated).toBe(initial);

    await Effect.runPromise(
      updated.startSession({
        threadId: "thread-goose",
        workingDirectory: START.workingDirectory,
        modelSelection: { instanceId: "acp/goose", model: "default" },
      }),
    );
    expect(transport.sessions[0]!.server.spawnOptions.agent).toMatchObject({
      id: "goose",
      command: "goose",
      args: ["acp"],
    });
    await Effect.runPromise((updated as AcpDriver).stopAll());
  });
});

describe("ACP elicitation/create (ask_question) & respondToUserInput (MXN-443)", () => {
  it("advertises form elicitation, converts requestedSchema through userInputActivityRow, and resolves typed answers, dismissals, URL/delegated declines, and turn settle cancellation", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const server = transport.sessions[0]!.server;

      // 1. Initialize advertises form elicitation (and not url).
      expect(server.requestsTo("initialize")[0]!.params).toMatchObject({
        clientCapabilities: {
          elicitation: { form: {} },
        },
      });

      // 2. URL elicitation is declined immediately without parking.
      expect(
        await server.ask("elicitation/create", {
          sessionId: "acp-sess-1",
          mode: "url",
          url: "https://example.test/oauth",
          message: "Sign in",
        }),
      ).toEqual({ action: "decline" });

      // 3. Form elicitation with single-select oneOf, multi-select array anyOf, boolean, and integer fields.
      const pending = server.ask("elicitation/create", {
        sessionId: "acp-sess-1",
        mode: "form",
        message: "Clarify setup",
        requestedSchema: {
          type: "object",
          properties: {
            db: {
              type: "string",
              title: "Which database?",
              oneOf: [
                { const: "pg", title: "PostgreSQL" },
                { const: "sqlite", title: "SQLite" },
              ],
            },
            features: {
              type: "array",
              title: "Which features?",
              items: {
                anyOf: [
                  { const: "auth", title: "Auth" },
                  { const: "search", title: "Search" },
                ],
              },
            },
            strict: { type: "boolean", title: "Enable strict mode?" },
            retries: { type: "integer", title: "Max retries" },
          },
        },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "user-input.request.opened")).toBe(true));
      const opened = events.find((e) => e.type === "user-input.request.opened") as UserInputRuntimeEvent;
      const row = userInputActivityRow(opened);
      expect(row).not.toBeNull();
      expect(row!.kind).toBe("user-input.requested");
      expect(row!.payload["questions"]).toMatchObject([
        {
          id: "db",
          question: "Which database?",
          multiSelect: false,
          options: [
            { label: "PostgreSQL", value: "pg" },
            { label: "SQLite", value: "sqlite" },
          ],
        },
        {
          id: "features",
          question: "Which features?",
          multiSelect: true,
          options: [
            { label: "Auth", value: "auth" },
            { label: "Search", value: "search" },
          ],
        },
        {
          id: "strict",
          question: "Enable strict mode?",
          multiSelect: false,
          allowCustomAnswer: false,
        },
        {
          id: "retries",
          question: "Max retries",
          multiSelect: false,
        },
      ]);

      await Effect.runPromise(
        driver.respondToUserInput("thread-1", opened.requestId, {
          db: "pg",
          features: "auth, search",
          strict: "true",
          retries: "3",
        }),
      );
      expect(await pending).toEqual({
        action: "accept",
        content: { db: "pg", features: ["auth", "search"], strict: true, retries: 3 },
      });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "user-input.request.resolved" && e.requestId === opened.requestId)).toBe(true),
      );

      // 4. Dismissal routes through respondToRequest(..., { kind: "decline" }) and replies { action: "decline" }.
      const dismissPending = server.ask("elicitation/create", {
        sessionId: "acp-sess-1",
        mode: "form",
        message: "Optional question",
        requestedSchema: { type: "object", properties: { note: { type: "string", title: "Any notes?" } } },
      });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "user-input.request.opened")).toHaveLength(2),
      );
      const opened2 = events.filter((e) => e.type === "user-input.request.opened")[1] as UserInputRuntimeEvent;
      await Effect.runPromise(driver.respondToRequest("thread-1", opened2.requestId, { kind: "decline" }));
      expect(await dismissPending).toEqual({ action: "decline" });

      // 5. Turn settle cancels parked user-input requests.
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "ask me" }));
      const settlePending = server.ask("elicitation/create", {
        sessionId: "acp-sess-1",
        mode: "form",
        message: "Will settle",
      });
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === "user-input.request.opened")).toHaveLength(3),
      );
      server.finishPrompt("end_turn");
      expect(await settlePending).toEqual({ action: "cancel" });
      await driver.awaitTurn("thread-1", sent.turnId);

      // 6. Delegated sessions decline elicitations immediately without parking.
      await Effect.runPromise(
        driver.startSession({ threadId: "thread-delegated", workingDirectory: START.workingDirectory, delegated: true }),
      );
      const delServer = transport.sessions[1]!.server;
      expect(
        await delServer.ask("elicitation/create", {
          sessionId: "acp-sess-1",
          mode: "form",
          message: "Need user",
        }),
      ).toEqual({ action: "decline" });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });
});

describe("ACP session/resume, session/close, steering, compaction, skills inventory, and context breakdown (MXN-444)", () => {
  it("prefers session/resume over session/load when advertised and sends session/close on stopSession", async () => {
    const transport = new FakeAcpTransport({ canResumeSession: true, canCloseSession: true });
    const driver = new AcpDriver({ transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-prev" }));
    const server = transport.sessions[0]!.server;
    expect(server.requestsTo("session/resume")).toHaveLength(1);
    expect(server.requestsTo("session/load")).toHaveLength(0);
    expect(server.requestsTo("session/new")).toHaveLength(0);

    await Effect.runPromise(driver.stopSession("thread-1"));
    expect(server.requestsTo("session/close")).toEqual([
      { method: "session/close", params: { sessionId: "acp-prev" } },
    ]);
  });

  it("supports mid-turn steerTurn on antigravity (omitted on generic acp) across both immediate-ack and prompt-handoff flows", async () => {
    const generic = new AcpDriver({ transport: new FakeAcpTransport() });
    expect(generic.steerTurn).toBeUndefined();
    expect(generic.compaction).toBeUndefined();

    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    expect(driver.steerTurn).toBeDefined();
    expect(driver.compaction).toEqual({ type: "slash-command", command: "/compact" });

    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));

    // Mid-turn steer sends a second session/prompt without settling the running turn.
    await Effect.runPromise(driver.steerTurn!("thread-1", "focus on tests"));
    expect(server.requestsTo("session/prompt")).toHaveLength(2);
    expect(server.requestsTo("session/prompt")[1]!.params).toMatchObject({
      sessionId: "acp-sess-1",
      prompt: [{ type: "text", text: "focus on tests" }],
    });

    // Prompt #1 finishes first (handoff to steer): turn must stay open until prompt #2 finishes too.
    server.notifyUpdate("acp-sess-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Steered reply." },
    });
    server.finishPrompt("end_turn");
    let settledEarly = false;
    const outcomePromise = driver.awaitTurn("thread-1", sent.turnId).then((res) => {
      settledEarly = true;
      return res;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settledEarly).toBe(false);

    server.finishPrompt("end_turn");
    const outcome = await outcomePromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("Steered reply.");
    await Effect.runPromise(driver.stopAll());
  });

  it("emits compacted session.notice on /compact and computes scaled contextBreakdown & skillInventory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-skills-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-home-"));
    tempDirs.push(dir, home);
    await mkdir(path.join(dir, ".agents", "skills", "deploy"), { recursive: true });
    await writeFile(
      path.join(dir, ".agents", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app\n---\nRun deploy.\n",
      "utf8",
    );

    const transport = new FakeAcpTransport({
      onSessionNew: (server, sessionId) => {
        server.notifyUpdate(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "Compact context" },
            { name: "plan", description: "Plan changes", input: { hint: "goal" } },
          ],
        });
      },
    });
    const driver = new AcpDriver({ provider: "antigravity", transport, skillHome: home });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession({ threadId: "thread-1", workingDirectory: dir }));
      const server = transport.sessions[0]!.server;

      // skillInventory merges local skills with live available_commands_update.
      const inventory = await driver.skillInventory(dir);
      expect(inventory.trigger).toBe("/");
      expect(inventory.skills).toMatchObject([
        { name: "deploy", description: "Deploy the app", enabled: true },
      ]);
      expect(inventory.commands).toEqual([
        { name: "compact", description: "Compact context", argumentHint: null, builtin: true },
        { name: "plan", description: "Plan changes", argumentHint: "goal", builtin: true },
      ]);

      // Run a normal turn with reasoning + tool + reply + usage_update -> contextBreakdown reflects all categories.
      const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "inspect repo" }));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking about the repo structure." },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        kind: "read",
        title: "File a.ts",
        status: "completed",
        rawInput: { Path: "a.ts" },
        rawOutput: { output: "export const a = 1;" },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Inspected a.ts." },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "usage_update",
        used: 2_000,
        size: 100_000,
      });
      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", t1.turnId);

      const breakdown = await driver.contextBreakdown("thread-1");
      expect(breakdown).not.toBeNull();
      expect(breakdown!.estimated).toBe(true);
      expect(breakdown!.usedTokens).toBe(2_000);
      expect(breakdown!.maxTokens).toBe(100_000);
      expect(breakdown!.categories.map((c) => c.name)).toContain("Tool calls");
      expect(breakdown!.categories.map((c) => c.name)).toContain("Reasoning");
      expect(breakdown!.tools?.[0]?.name).toBe("Read");

      // /compact emits session.notice: "compacted" and resets contextBreakdown window to post-compaction turns.
      const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "/compact" }));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Compacted summary." },
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "usage_update",
        used: 400,
        size: 100_000,
      });
      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", t2.turnId);

      await vi.waitFor(() =>
        expect(
          events.some(
            (e) =>
              e.type === "session.notice" &&
              e.notice === "compacted" &&
              e.detail === "Compacted summary.",
          ),
        ).toBe(true),
      );
      const afterCompact = await driver.contextBreakdown("thread-1");
      expect(afterCompact!.usedTokens).toBe(400);
      expect(afterCompact!.tools).toBeUndefined();
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });
});

describe("ACP native subagent status events (MXN-445)", () => {
  it("emits subagent.updated started and stopped for invoke_subagent Agent calls without duplicates", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "research" }));
      const server = transport.sessions[0]!.server;

      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "sub-1",
        kind: "other",
        title: "Run invoke_subagent",
        status: "in_progress",
        rawInput: {
          TypeName: "research",
          Role: "Codebase Researcher",
          Prompt: "Inspect ACP protocol handlers",
        },
      });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "subagent.updated" && e.status === "started")).toBe(true),
      );
      expect(events.find((e) => e.type === "subagent.updated" && e.status === "started")).toMatchObject({
        provider: "antigravity",
        threadId: "thread-1",
        turnId: sent.turnId,
        agentId: "sub-1",
        agentType: "Codebase Researcher",
        description: "Inspect ACP protocol handlers",
        lastMessage: null,
      });

      // Intermediate update does not emit a second "started" event.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "sub-1",
        status: "in_progress",
      });
      // Completion emits "stopped" with lastMessage summary (even when title/rawInput omitted).
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "sub-1",
        status: "completed",
        rawOutput: { output: "Found 4 protocol handlers." },
      });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "subagent.updated" && e.status === "stopped")).toBe(true),
      );
      const subEvents = events.filter((e) => e.type === "subagent.updated");
      expect(subEvents).toHaveLength(2);
      expect(subEvents[1]).toMatchObject({
        agentId: "sub-1",
        agentType: "Codebase Researcher",
        status: "stopped",
        lastMessage: "Found 4 protocol handlers.",
      });

      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", sent.turnId);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("publishes token-usage.updated when usage_update notifications arrive mid-turn", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession({ threadId: "thread-1", workingDirectory: process.cwd() }));
      const server = transport.sessions[0]!.server;
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "hello" }));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "usage_update",
        used: 4_200,
        size: 100_000,
        cost: { amount: 0.12, currency: "USD" },
      });
      await vi.waitFor(() => expect(events.some((e) => e.type === "token-usage.updated")).toBe(true));
      expect(events.find((e) => e.type === "token-usage.updated")).toMatchObject({
        type: "token-usage.updated",
        provider: "antigravity",
        threadId: "thread-1",
        usage: { input: 4_200, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0, costUsd: 0.12 },
      });
      server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-1", sent.turnId);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("forks via session/fork when advertised (live or cold) and refuses with FORK_UNSUPPORTED otherwise (MXN-451)", async () => {
    // 1. Agent without sessionCapabilities.fork fails cleanly with FORK_UNSUPPORTED.
    const noForkTransport = new FakeAcpTransport({ canForkSession: false });
    const noForkDriver = new AcpDriver({ provider: "antigravity", transport: noForkTransport });
    try {
      await Effect.runPromise(noForkDriver.startSession({ threadId: "thread-1", workingDirectory: process.cwd() }));
      await expect(noForkDriver.forkSession("acp-sess-1", process.cwd(), "antigravity")).rejects.toMatchObject({
        code: "FORK_UNSUPPORTED",
      });
    } finally {
      await Effect.runPromise(noForkDriver.stopAll());
    }

    // 2. Agent advertising sessionCapabilities.fork uses session/fork both on a live session and cold peer.
    const forkTransport = new FakeAcpTransport({ canForkSession: true, forkedSessionId: "acp-sess-fork-42" });
    const forkDriver = new AcpDriver({
      provider: "acp",
      agents: { custom: { id: "custom", command: "custom", args: ["--acp"] } },
      transport: forkTransport,
    });
    try {
      await Effect.runPromise(
        forkDriver.startSession({
          threadId: "thread-2",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "acp/custom", model: "default" },
        }),
      );
      expect(await forkDriver.forkSession("acp-sess-1", process.cwd(), "acp/custom")).toBe("acp-sess-fork-42");
      expect(forkTransport.sessions[0]?.server.requestsTo("session/fork").map((r) => r.params)).toEqual([
        { sessionId: "acp-sess-1", cwd: process.cwd(), mcpServers: [] },
      ]);

      // Cold fork (cursor not in live sessions) initializes a short-lived peer and forks.
      expect(await forkDriver.forkSession("acp-sess-cold", process.cwd(), "acp/custom")).toBe("acp-sess-fork-42");
      expect(forkTransport.sessions[1]?.server.requestsTo("session/fork").map((r) => r.params)).toEqual([
        { sessionId: "acp-sess-cold", cwd: process.cwd(), mcpServers: [] },
      ]);
    } finally {
      await Effect.runPromise(forkDriver.stopAll());
    }
  });
});

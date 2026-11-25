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
import {
  ANTIGRAVITY_NATIVE_SUBAGENT_REMINDER,
  ANTIGRAVITY_NO_NATIVE_SUBAGENTS_INSTRUCTION,
  AcpDriver,
} from "../driver.js";
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
        // The prompt result carried no cost, so the observed cumulative
        // reading (0.042 against a fresh-session baseline of 0) is persisted
        // as this turn's settled cost (LOCAL-009).
        costUsd: 0.042,
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

  it("routes a steer prompt that outlives the ack window through the same turn failure and cancel path as the main prompt (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({
      provider: "antigravity",
      transport,
      promptTimeoutMs: 300,
      backgroundTurnIdleMs: 10_000,
      cancelQuietMs: 50,
      cancelDrainTimeoutMs: 200,
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(driver.startSession(START));
      const server = transport.sessions[0]!.server;
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
      await Effect.runPromise(driver.steerTurn!("thread-1", "focus on tests"));
      expect(server.requestsTo("session/prompt")).toHaveLength(2);

      // Let the early steering acknowledgement window pass, then finish the main
      // prompt while the steer is still pending.
      await new Promise((r) => setTimeout(r, 80));
      server.finishPrompt("end_turn");

      // The steer request now reaches its idle deadline: the turn must fail and
      // send session/cancel instead of staying running with no pending prompt.
      const outcome = await Promise.race([
        driver.awaitTurn("thread-1", sent.turnId),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      expect(outcome).not.toBeNull();
      expect(outcome!.status).toBe("failed");
      await vi.waitFor(() => expect(server.notificationsTo("session/cancel")).toHaveLength(1));
      expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("tracks ACP usage_update cost as cumulative per session and reports only the unaccounted delta live (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;

    // Turn 1: cumulative session cost 0.25 while the prompt is held.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.25 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.25, 9);
    expect((await driver.contextUsage("thread-1"))?.costUsd).toBeCloseTo(0.25, 9);
    // The prompt-result usage stays per-turn and separate from the cumulative reading.
    server.finishPrompt("end_turn", { usage: { inputTokens: 900, outputTokens: 100, cost: 0.25 } });
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.25, 9);

    // Turn 2: the cumulative reading grows to 0.60; only the delta past the
    // settled baseline (0.25) is the open turn's live cost.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    expect((await driver.contextUsage("thread-1"))?.costUsd).toBeCloseTo(0.6, 9);
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.35, 9);
    server.finishPrompt("end_turn", { usage: { inputTokens: 800, outputTokens: 90, cost: 0.35 } });
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.costUsd).toBeCloseTo(0.35, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("baselines a resumed ACP session's cumulative cost at its first reading (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport({
      sessionId: "acp-old",
      onSessionLoad: (server, sessionId) => {
        // Pre-resume spend already inside the agent's cumulative counter.
        server.notifyUpdate(sessionId, { sessionUpdate: "usage_update", used: 5_000, size: 100_000, cost: 0.1 });
      },
    });
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    const server = transport.sessions[0]!.server;
    // The pre-resume 0.10 is the baseline, not new spend.
    expect((await driver.contextUsage("thread-1"))?.costUsd).toBeCloseTo(0.1, 9);

    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 6_000, size: 100_000, cost: 0.3 });
    await new Promise((r) => setTimeout(r, 10));
    // Only 0.20 of the 0.30 cumulative reading is unaccounted.
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.2, 9);
    server.finishPrompt("end_turn", { usage: { inputTokens: 500, outputTokens: 50, cost: 0.2 } });
    const outcome = await driver.awaitTurn("thread-1", sent.turnId);
    expect(outcome.usage?.costUsd).toBeCloseTo(0.2, 9);
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

  it("turns Antigravity quota-exhaustion replies into a rate-limit event, failed turn, and forced refresh (MXN-454)", async () => {
    const transport = new FakeAcpTransport();
    const probeCalls: Array<{ force?: boolean }> = [];
    const driver = new AcpDriver({
      provider: "antigravity",
      transport,
      backgroundTurnIdleMs: 30,
      probeUsage: async (_command, _env, opts) => {
        probeCalls.push({ ...(opts?.force !== undefined ? { force: opts.force } : {}) });
        return {
          windows: [
            {
              id: "gemini-5h",
              label: "Session – Gemini",
              usedPercent: 100,
              exhausted: true,
              resetsAt: "2026-11-20T23:16:16.000Z",
            },
          ],
          credits: 50,
        };
      },
    });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))),
    );
    try {
      await Effect.runPromise(
        driver.startSession({
          threadId: "thread-quota",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
        }),
      );
      const server = transport.sessions[0]!.server;

      // 1. User turn completes with end_turn after emitting agy's warning chunk.
      const beforeStart = Date.now();
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-quota", prompt: "keep working" }));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 17m8s.\n",
        },
      });
      server.finishPrompt("end_turn");
      const outcome = await driver.awaitTurn("thread-quota", sent.turnId);
      expect(outcome.status).toBe("failed");
      expect(outcome.text).toBe("");
      expect(outcome.error).toBe(
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 17m8s.",
      );
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "thread.state.changed" && e.state === "rate-limited")).toBe(true);
        expect(probeCalls.some((c) => c.force === true)).toBe(true);
      });
      const rateLimited = events.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }> =>
          e.type === "thread.state.changed" && e.state === "rate-limited",
      )!;
      const raw = rateLimited.raw as Record<string, unknown>;
      expect(raw["rateLimitType"]).toBe("gemini-5h");
      expect(raw["label"]).toBe("Session – Gemini");
      expect(typeof raw["resetsAt"]).toBe("string");
      const deltaMs = Date.parse(String(raw["resetsAt"])) - beforeStart;
      expect(deltaMs).toBeGreaterThanOrEqual(17 * 60_000);
      expect(deltaMs).toBeLessThanOrEqual(17 * 60_000 + 30_000);
      expect(events.some((e) => e.type === "message.retracted")).toBe(true);

      // 2. Out-of-turn background wakeup turn hitting quota also fails and emits rate-limited + forced probe (bypassing coalesce).
      const forcedBefore = probeCalls.filter((c) => c.force === true).length;
      events.length = 0;
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 12m.\n",
        },
      });
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "turn.failed")).toBe(true);
        expect(events.some((e) => e.type === "thread.state.changed" && e.state === "rate-limited")).toBe(true);
        expect(probeCalls.filter((c) => c.force === true).length).toBeGreaterThan(forcedBefore);
      });

      // 3. Normal assistant prose mentioning quota text completes normally without rate-limiting.
      events.length = 0;
      const normal = await Effect.runPromise(driver.sendTurn({ threadId: "thread-quota", prompt: "explain the bug" }));
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "The driver now handles '⚠ Individual quota reached. Resets in 17m8s.' cleanly.",
        },
      });
      server.finishPrompt("end_turn");
      const normalOutcome = await driver.awaitTurn("thread-quota", normal.turnId);
      expect(normalOutcome.status).toBe("completed");
      expect(normalOutcome.text).toContain("The driver now handles");
      expect(events.some((e) => e.type === "thread.state.changed" && e.state === "rate-limited")).toBe(false);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(driver.stopAll());
    }
  });
});

describe("Antigravity native subagent discouragement & reminder (MXN-465)", () => {
  it("prepends no-native-subagents guidance and sends a one-shot corrective steer reminder when invoke_subagent is called", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    try {
      await Effect.runPromise(driver.startSession({ ...START, instructions: "# Base\nFollow repo rules." }));
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "inspect codebase" }));
      const server = transport.sessions[0]!.server;

      const firstPrompt = server.requests.find((r) => r.method === "session/prompt");
      const firstText = String((firstPrompt?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text ?? "");
      expect(firstText).toContain("# Base\nFollow repo rules.");
      expect(firstText).toContain(ANTIGRAVITY_NO_NATIVE_SUBAGENTS_INSTRUCTION);
      expect(firstText).toContain("inspect codebase");

      // Native subagent tool call triggers an automatic mid-turn reminder once per turn.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "sub-1",
        kind: "other",
        title: "Run invoke_subagent",
        status: "in_progress",
        rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Scan files" },
      });
      await vi.waitFor(() =>
        expect(server.requests.filter((r) => r.method === "session/prompt")).toHaveLength(2),
      );
      const reminderReq = server.requests.filter((r) => r.method === "session/prompt")[1];
      const reminderText = String((reminderReq?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text ?? "");
      expect(reminderText).toBe(ANTIGRAVITY_NATIVE_SUBAGENT_REMINDER);

      // Follow-up updates or a second native subagent call in the same turn do not spam reminders.
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "sub-1",
        status: "completed",
      });
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "tool_call",
        toolCallId: "sub-2",
        kind: "other",
        title: "Run define_subagent",
        status: "completed",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(server.requests.filter((r) => r.method === "session/prompt")).toHaveLength(2);

      // Finish both prompts cleanly: original prompt + reminder steer.
      server.finishPrompt("end_turn");
      server.finishPrompt("end_turn");
      const outcome = await driver.awaitTurn("thread-1", sent.turnId);
      expect(outcome.status).toBe("completed");
    } finally {
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("does not drop HTTP MCP servers or built-in moxen tools for Antigravity when agy acp omits mcpCapabilities", async () => {
    const mcpServers = [
      { name: "brave-search", type: "stdio" as const, command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "k1" } },
      { name: "exa", type: "http" as const, url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": "k2" } },
      { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer k3" } },
      {
        name: "moxen",
        type: "in-process" as const,
        tools: [],
        call: async () => ({ text: "", isError: false }),
        fallback: { name: "moxen", type: "http" as const, url: "http://127.0.0.1:9999/mcp/thread-1", headers: { Authorization: "Bearer tok" } },
        stdioFallback: { name: "moxen", type: "stdio" as const, command: "bun", args: ["mcp.ts", "--thread", "thread-1"], env: {} },
      },
    ];

    const agyTransport = new FakeAcpTransport({ omitMcpCapabilities: true, canResumeSession: true });
    const agyDriver = new AcpDriver({ provider: "antigravity", lazyMcp: false, transport: agyTransport });
    const acpTransport = new FakeAcpTransport({ omitMcpCapabilities: true });
    const acpDriver = new AcpDriver({
      provider: "acp",
      agents: { custom: { id: "custom", name: "Custom", command: "custom-acp", args: [] } },
      transport: acpTransport,
    });
    try {
      await Effect.runPromise(
        agyDriver.startSession({
          threadId: "thread-1",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
          mcpServers,
        }),
      );
      const newParams = agyTransport.sessions[0]?.server.requestsTo("session/new")[0]?.params as {
        mcpServers?: Array<Record<string, unknown>>;
      };
      expect(newParams.mcpServers).toEqual([
        { name: "brave-search", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: [{ name: "BRAVE_API_KEY", value: "k1" }] },
        { type: "http", name: "exa", url: "https://mcp.exa.ai/mcp", headers: [{ name: "x-api-key", value: "k2" }] },
        { type: "http", name: "linear", url: "https://mcp.linear.app/mcp", headers: [{ name: "Authorization", value: "Bearer k3" }] },
        { type: "http", name: "moxen", url: "http://127.0.0.1:9999/mcp/thread-1", headers: [{ name: "Authorization", value: "Bearer tok" }] },
      ]);

      // A generic ACP agent that omits mcpCapabilities drops user HTTP servers
      // but still receives Moxen's built-in tools via stdioFallback.
      await Effect.runPromise(
        acpDriver.startSession({
          threadId: "thread-2",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "acp/custom", model: "default" },
          mcpServers,
        }),
      );
      const acpNewParams = acpTransport.sessions[0]?.server.requestsTo("session/new")[0]?.params as {
        mcpServers?: Array<Record<string, unknown>>;
      };
      expect(acpNewParams.mcpServers).toEqual([
        { name: "brave-search", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: [{ name: "BRAVE_API_KEY", value: "k1" }] },
        { name: "moxen", command: "bun", args: ["mcp.ts", "--thread", "thread-1"], env: [] },
      ]);
    } finally {
      await Effect.runPromise(agyDriver.stopAll());
      await Effect.runPromise(acpDriver.stopAll());
    }
  });

  it("restores host HOME/USERPROFILE and clears synthetic SSH_CONNECTION on stdio MCP servers under isolated Antigravity accounts", async () => {
    const posixHostEnv: NodeJS.ProcessEnv = { HOME: "/Users/alice", PATH: "/usr/bin" };
    const posixIsolated = path.join("/Users/alice", ".moxen", "accounts", "antigravity", "default");
    const posixTransport = new FakeAcpTransport({ omitMcpCapabilities: true });
    const posixDriver = new AcpDriver({
      provider: "antigravity",
      lazyMcp: false,
      hostEnv: posixHostEnv,
      env: { ...posixHostEnv, HOME: posixIsolated, USERPROFILE: posixIsolated, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" },
      agents: {
        antigravity: {
          id: "antigravity",
          command: "agy",
          args: ["acp"],
          env: { HOME: posixIsolated, USERPROFILE: posixIsolated, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" },
        },
      },
      transport: posixTransport,
    });

    const winHostEnv: NodeJS.ProcessEnv = { USERPROFILE: "C:\\Users\\alice", PATH: "C:\\Windows" };
    const winIsolated = "C:\\Users\\alice\\.moxen\\accounts\\antigravity\\default";
    const winTransport = new FakeAcpTransport({ omitMcpCapabilities: true });
    const winDriver = new AcpDriver({
      provider: "antigravity",
      lazyMcp: false,
      hostEnv: winHostEnv,
      env: { ...winHostEnv, HOME: winIsolated, USERPROFILE: winIsolated, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" },
      agents: {
        antigravity: {
          id: "antigravity",
          command: "agy",
          args: ["acp"],
          env: { HOME: winIsolated, USERPROFILE: winIsolated, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" },
        },
      },
      transport: winTransport,
    });

    try {
      await Effect.runPromise(
        posixDriver.startSession({
          threadId: "thread-posix",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
          mcpServers: [
            { name: "linear", type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], env: {} },
          ],
        }),
      );
      const posixParams = posixTransport.sessions[0]?.server.requestsTo("session/new")[0]?.params as {
        mcpServers?: Array<{ env?: Array<{ name: string; value: string }> }>;
      };
      expect(posixParams.mcpServers?.[0]?.env).toEqual([
        { name: "HOME", value: "/Users/alice" },
        { name: "USERPROFILE", value: "" },
        { name: "SSH_CONNECTION", value: "" },
      ]);

      await Effect.runPromise(
        winDriver.startSession({
          threadId: "thread-win",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
          mcpServers: [
            { name: "linear", type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], env: {} },
          ],
        }),
      );
      const winParams = winTransport.sessions[0]?.server.requestsTo("session/new")[0]?.params as {
        mcpServers?: Array<{ env?: Array<{ name: string; value: string }> }>;
      };
      expect(winParams.mcpServers?.[0]?.env).toEqual([
        { name: "HOME", value: "C:\\Users\\alice" },
        { name: "USERPROFILE", value: "C:\\Users\\alice" },
        { name: "SSH_CONNECTION", value: "" },
      ]);
    } finally {
      await Effect.runPromise(posixDriver.stopAll());
      await Effect.runPromise(winDriver.stopAll());
    }
  });

  it("routes Antigravity external MCP servers through the compact moxen-mcp lazy gateway while keeping moxen direct", async () => {
    const transport = new FakeAcpTransport({ omitMcpCapabilities: true });
    let closedClient = false;
    const driver = new AcpDriver({
      provider: "antigravity",
      transport,
      connectMcp: async (spec) =>
        ({
          alive: true,
          tools: [
            {
              name: spec.name === "linear" ? "get_issue" : "web_search_exa",
              description: "Test tool",
              inputSchema: { type: "object", properties: { id: { type: "string" } } },
              readOnly: true,
            },
          ],
          dropped: 0,
          call: async (_tool: string, args: Record<string, unknown>) => ({ text: JSON.stringify(args), isError: false }),
          close: async () => {
            closedClient = true;
          },
        }) as never,
    });
    try {
      await Effect.runPromise(
        driver.startSession({
          threadId: "thread-lazy",
          workingDirectory: process.cwd(),
          modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
          mcpServers: [
            {
              name: "moxen",
              type: "in-process",
              tools: [],
              call: async () => ({ text: "", isError: false }),
              fallback: { name: "moxen", type: "http", url: "http://127.0.0.1:9999/mcp/thread-lazy", headers: { Authorization: "Bearer tok" } },
            },
            { name: "brave-search", type: "stdio", command: "bunx", args: ["@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "secret" } },
            { name: "exa", type: "http", url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": "secret" } },
            { name: "linear", type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], env: {} },
          ],
        }),
      );

      const newParams = transport.sessions[0]?.server.requestsTo("session/new")[0]?.params as {
        mcpServers?: Array<{ type?: string; name?: string; url?: string; headers?: Array<{ name: string; value: string }> }>;
      };
      expect(newParams.mcpServers?.map((s) => s.name)).toEqual(["moxen", "moxen-mcp"]);
      const gw = newParams.mcpServers![1]!;
      expect(gw.type).toBe("http");
      expect(gw.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const authHeader = gw.headers?.find((h) => h.name === "Authorization")?.value ?? "";
      expect(authHeader).toMatch(/^Bearer [0-9a-f]{48}$/);

      // Call through the live loopback gateway to verify linear is reachable end-to-end.
      const res = await fetch(gw.url!, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_tool", arguments: { server: "linear", tool: "get_issue", arguments: { id: "MXN-77" } } },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        result: { isError: false, content: [{ type: "text", text: '{"id":"MXN-77"}' }] },
      });

      // First prompt includes external MCP server names in instructions.
      const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-lazy", prompt: "Check MXN-77" }));
      const promptReq = transport.sessions[0]!.server.requests.find((r) => r.method === "session/prompt");
      const promptText = String((promptReq?.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text ?? "");
      expect(promptText).toContain("brave-search, exa, linear");
      expect(promptText).toContain("mcp_moxen-mcp_search_tools");
      transport.sessions[0]!.server.finishPrompt("end_turn");
      await driver.awaitTurn("thread-lazy", sent.turnId);
    } finally {
      await Effect.runPromise(driver.stopAll());
    }
    expect(closedClient).toBe(true);
  });
});

describe("LOCAL-009 round 3: steer rejection classification, idle activity attribution, and cumulative cost accounting", () => {
  const promptScript = () => {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (cause: unknown) => void }> = [];
    return {
      pending,
      script: {
        onPrompt: () =>
          new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      } as const,
    };
  };

  it("settles the turn from the stored main result when an early steer refusal removes the last pending prompt (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    const steerOutcome = Effect.runPromise(
      Effect.match(driver.steerTurn!("thread-1", "focus on tests"), {
        onFailure: (cause) => `rejected:${cause.message}`,
        onSuccess: () => "accepted",
      }),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(2), { interval: 5, timeout: 1000 });
    // The main prompt completes while the steer is pending: its result must be
    // kept. The pair delivers in order, so the client processes the main
    // success before the steer rejection below.
    pending[0]!.resolve({ stopReason: "end_turn" });
    // The steer is refused before the acknowledgement window (50 ms).
    pending[1]!.reject(new Error("steering refused"));
    expect(await steerOutcome).toContain("rejected");
    // The early refusal removed the last pending prompt: the turn must settle
    // from the stored main result, not stay running forever.
    const outcome = await Promise.race([
      driver.awaitTurn("thread-1", sent.turnId),
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("completed");
    expect(server.notificationsTo("session/cancel")).toHaveLength(0);
    await Effect.runPromise(driver.stopAll());
  });

  it("routes a late steer rejection (past the ack window) while the main prompt is still pending through the turn failure and cancel path (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Let the acknowledgement window (50 ms) pass with the main prompt still pending.
    await new Promise((r) => setTimeout(r, 80));
    // An ordinary late RPC rejection (not a timeout) must fail the turn and send
    // session/cancel exactly like the main prompt's failure path.
    pending[1]!.reject(new Error("late steer failure"));
    const outcome = await Promise.race([
      driver.awaitTurn("thread-1", sent.turnId),
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failed");
    await vi.waitFor(() => expect(server.notificationsTo("session/cancel")).toHaveLength(1));
    await Effect.runPromise(driver.stopAll());
  });

  it("classifies a steer rejection by acknowledgment state, not the wall clock, so a rolled-back clock cannot strand the turn (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Acknowledged: the ack window (50 ms) passes while both prompts are pending.
    await new Promise((r) => setTimeout(r, 80));
    // Roll the wall clock one hour backward while the rejection is delivered: a
    // Date.now()-based classification would misread this as an early refusal.
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000_000);
    pending[1]!.reject(new Error("late steer failure after rollback"));
    await new Promise((r) => setTimeout(r, 10));
    nowSpy.mockRestore();
    const outcome = await Promise.race([
      driver.awaitTurn("thread-1", sent.turnId),
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failed");
    await vi.waitFor(() => expect(server.notificationsTo("session/cancel")).toHaveLength(1));
    await Effect.runPromise(driver.stopAll());
  });

  it("restarts the ACP prompt idle timer only on recognized session activity, not unrelated frames with a matching sessionId (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport, promptTimeoutMs: 35, promptDeadlineMs: 400 });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const startedAt = Date.now();
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    // Unrelated traffic carrying the same sessionId: a foreign method and a
    // non-progress update kind must not keep the prompt alive.
    const interval = setInterval(() => {
      server.peer.notify("custom/notify", { sessionId: "acp-sess-1" });
      server.notifyUpdate("acp-sess-1", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } });
    }, 10);
    try {
      const outcome = await Promise.race([
        driver.awaitTurn("thread-1", sent.turnId),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      expect(outcome).not.toBeNull();
      expect(outcome!.status).toBe("failed");
      // Failed at the 35 ms idle timeout, not at the 400 ms hard deadline.
      expect(Date.now() - startedAt).toBeLessThan(250);
      await vi.waitFor(() => expect(server.notificationsTo("session/cancel")).toHaveLength(1));
    } finally {
      clearInterval(interval);
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("still restarts the ACP prompt idle timer on recognized prompt progress (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport, promptTimeoutMs: 60, promptDeadlineMs: 5_000 });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    const interval = setInterval(() => {
      server.notifyUpdate("acp-sess-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" },
      });
    }, 20);
    try {
      // Well past several 60 ms idle windows: recognized progress keeps the prompt alive.
      await new Promise((r) => setTimeout(r, 200));
      const stillRunning = await Promise.race([
        driver.awaitTurn("thread-1", sent.turnId).then(() => "settled"),
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ]);
      expect(stillRunning).toBeNull();
      clearInterval(interval);
      server.finishPrompt("end_turn");
      const outcome = await driver.awaitTurn("thread-1", sent.turnId);
      expect(outcome.status).toBe("completed");
    } finally {
      clearInterval(interval);
      await Effect.runPromise(driver.stopAll());
    }
  });

  it("persists the measured cumulative delta as the turn cost at settle when the prompt result carries no cost (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;

    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.25 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.25, 9);
    // The prompt result carries NO cost: the observed 0.25 must still be
    // persisted as this turn's settled cost.
    server.finishPrompt("end_turn");
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.25, 9);

    // Turn 2: cumulative reading grows to 0.60; only 0.35 is unaccounted.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.35, 9);
    server.finishPrompt("end_turn");
    await driver.awaitTurn("thread-1", t2.turnId);
    await Effect.runPromise(driver.stopAll());
  });

  it("reconciles a prompt-result cost against the cumulative counter so the next turn's delta starts after it (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;

    // Turn 1: no usage_update at all; the prompt result alone reports $0.25.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.finishPrompt("end_turn", { usage: { inputTokens: 900, outputTokens: 100, cost: 0.25 } });
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.25, 9);

    // Turn 2: the first cumulative reading is $0.60; the counter already
    // contained the settled $0.25, so the live delta is 0.35, not 0.60.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    expect((await driver.contextUsage("thread-1"))?.costUsd).toBeCloseTo(0.6, 9);
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.35, 9);
    server.finishPrompt("end_turn");
    await driver.awaitTurn("thread-1", t2.turnId);
    await Effect.runPromise(driver.stopAll());
  });

  it("keeps a resumed session's cost baseline unknown until a pre-turn reading and reports no delta from an unknown baseline (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport({ sessionId: "acp-old" });
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    // First reading arrives in-turn, with no pre-turn reading to baseline against.
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 6_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    expect((await driver.contextUsage("thread-1"))?.costUsd).toBeCloseTo(0.6, 9);
    // No delta is reported from an unknown baseline (fall back to the estimate).
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeUndefined();
    server.finishPrompt("end_turn");
    const outcome = await driver.awaitTurn("thread-1", sent.turnId);
    expect(outcome.usage?.costUsd).toBeUndefined();
    await Effect.runPromise(driver.stopAll());
  });

  it("never lowers the accounted cost baseline on a downward counter reading (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;

    // Turn 1: the cumulative counter reads 0.20, falls to 0.10, and the prompt
    // result settles the turn at $0.20.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_500, size: 100_000, cost: 0.1 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn", { usage: { inputTokens: 900, outputTokens: 100, cost: 0.2 } });
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.2, 9);

    // Turn 2: the counter rebounds to 0.25; the accounted high-water mark is
    // 0.20, so the live delta is 0.05, not 0.15.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.25 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.05, 9);
    server.finishPrompt("end_turn");
    await driver.awaitTurn("thread-1", t2.turnId);
    await Effect.runPromise(driver.stopAll());
  });

  it("retains the open turn's last known cost delta on a token-only usage_update (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "go" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.25 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.25, 9);
    // A token-only update must refresh the token fields but keep the last known cost.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_500, size: 100_000 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.25, 9);
    expect(driver.liveTurnUsage("thread-1")?.input).toBe(2_500);
    server.finishPrompt("end_turn");
    await driver.awaitTurn("thread-1", sent.turnId);
    await Effect.runPromise(driver.stopAll());
  });
});

describe("LOCAL-009 round 4: steer reconciliation, cancelled-prompt drain, and counter baseline accounting", () => {
  const outcomeWithinMs = 500;
  const settledOutcome = async (driver: AcpDriver, turnId: string) =>
    await Promise.race([
      driver.awaitTurn("thread-1", turnId),
      new Promise<null>((r) => setTimeout(() => r(null), outcomeWithinMs)),
    ]);
  const promptScript = () => {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (cause: unknown) => void }> = [];
    return {
      pending,
      script: {
        onPrompt: () =>
          new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      } as const,
    };
  };

  it("abandons and drains the cancelled main prompt so its trailing output cannot leak into the next turn (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Let the acknowledgement window (50 ms) pass, then fail the steer: the turn
    // fails and session/cancel is sent while the main prompt is still pending.
    await new Promise((r) => setTimeout(r, 80));
    pending[1]!.reject(new Error("late steer failure"));
    const outcome1 = await driver.awaitTurn("thread-1", sent.turnId);
    expect(outcome1.status).toBe("failed");
    await vi.waitFor(() => expect(server.notificationsTo("session/cancel")).toHaveLength(1));

    // The next send must not admit while the cancelled main prompt is draining.
    const second = Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "turn two" }));
    await new Promise((r) => setTimeout(r, 20));
    // A trailing chunk from the cancelled main prompt lands on the session.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD MAIN OUTPUT" } });
    // The agent only now acknowledges the cancellation.
    pending[0]!.resolve({ stopReason: "cancelled" });
    const t2 = await second;
    pending[2]!.resolve({ stopReason: "end_turn" });
    const outcome2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(outcome2.status).toBe("completed");
    expect(outcome2.text).not.toContain("OLD MAIN OUTPUT");
    await Effect.runPromise(driver.stopAll());
  });

  it("bounds the cancelled-prompt drain when the agent never acknowledges session/cancel (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport, cancelDrainTimeoutMs: 150 });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 80));
    pending[1]!.reject(new Error("late steer failure"));
    expect((await driver.awaitTurn("thread-1", sent.turnId)).status).toBe("failed");
    // The main prompt is never answered: the next send must still proceed
    // within the bounded drain window instead of waiting forever.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "turn two" }));
    pending[2]!.resolve({ stopReason: "end_turn" });
    const outcome2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(outcome2.status).toBe("completed");
    expect(outcome2.text).not.toContain("OLD MAIN OUTPUT");
    await Effect.runPromise(driver.stopAll());
  });

  it("settles the turn from the main prompt's stored error when an early steer refusal follows it (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2), { interval: 1, timeout: 1_000 });
    // The main RPC fails while the steer is still pending...
    pending[0]!.reject(new Error("quota boom"));
    // ...and the steer is refused before the acknowledgement window (50 ms).
    pending[1]!.reject(new Error("steering refused"));
    const outcome = await settledOutcome(driver, sent.turnId);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failed");
    expect(outcome!.error).toContain("quota boom");
    // The main failure alone never cancels the session turn.
    expect(server.notificationsTo("session/cancel")).toHaveLength(0);
    await Effect.runPromise(driver.stopAll());
  });

  it("keeps the main prompt's usage when the steer settles the turn (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // The main prompt completes first with usage that must survive the settle.
    pending[0]!.resolve({ stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 100, cost: 0.25 } });
    await new Promise((r) => setTimeout(r, 80));
    // The steer resolves last with no usage of its own.
    pending[1]!.resolve({ stopReason: "end_turn" });
    const outcome = await settledOutcome(driver, sent.turnId);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("completed");
    expect(outcome!.usage?.costUsd).toBeCloseTo(0.25, 9);
    expect(outcome!.usage?.input).toBe(900);
    await Effect.runPromise(driver.stopAll());
  });

  it("keeps the main prompt's usage when a late steer rejection fails the turn (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "start work" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!.resolve({ stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 100, cost: 0.25 } });
    await new Promise((r) => setTimeout(r, 80));
    // The steer was acknowledged and then failed: the turn fails with a cancel,
    // but the main prompt's recorded usage must reach the outcome.
    pending[1]!.reject(new Error("late steer failure"));
    const outcome = await settledOutcome(driver, sent.turnId);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failed");
    expect(outcome!.usage?.costUsd).toBeCloseTo(0.25, 9);
    expect(outcome!.usage?.input).toBe(900);
    await Effect.runPromise(driver.stopAll());
  });

  it("carries the main prompt's runtime instructions through the early steer-refusal recovery (LOCAL-009)", async () => {
    const { pending, script } = promptScript();
    const transport = new FakeAcpTransport(script);
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(
      driver.startSession({
        ...START,
        instructions: "# Runtime\nStay in worktree.",
      }),
    );
    const server = transport.sessions[0]!.server;
    const sent = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "first" }));
    void Effect.runPromise(Effect.exit(driver.steerTurn!("thread-1", "focus on tests")));
    await vi.waitFor(() => expect(pending).toHaveLength(2), { interval: 1, timeout: 1_000 });
    // The main prompt returns a refusal (a failed result) while the steer is pending.
    pending[0]!.resolve({ stopReason: "refusal" });
    // The steer is refused before the acknowledgement window: the turn settles
    // from the stored main result and must recover its carried instructions.
    pending[1]!.reject(new Error("steering refused"));
    const outcome = await settledOutcome(driver, sent.turnId);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failed");
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "first retry" }));
    pending[2]!.resolve({ stopReason: "end_turn" });
    await driver.awaitTurn("thread-1", t2.turnId);
    const prompts = server.requestsTo("session/prompt");
    expect(String((prompts.at(-1)!.params as { prompt: Array<{ text: string }> }).prompt[0]!.text)).toContain("Stay in worktree.");
    await Effect.runPromise(driver.stopAll());
  });

  it("keeps a resumed session's counter baseline unknown when only post-resume result costs were booked (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport({ sessionId: "acp-old" });
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    const server = transport.sessions[0]!.server;
    // Turn 1 settles on its own explicit result cost, with no cumulative reading.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.finishPrompt("end_turn", { usage: { inputTokens: 500, outputTokens: 50, cost: 0.05 } });
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.05, 9);
    // Turn 2: the first cumulative reading arrives mid-turn. Neither zero nor the
    // booked $0.05 establishes the provider's counter origin, so no delta is
    // reported from the counter; the estimate applies instead.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 6_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeUndefined();
    server.finishPrompt("end_turn");
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.costUsd).toBeUndefined();
    await Effect.runPromise(driver.stopAll());
  });

  it("does not report a counter delta for a turn with no fresh counter reading (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // Turn 1 settles from a $0.20 cumulative reading.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.2, 9);
    // Turn 2 finishes with token usage but neither a fresh counter reading nor a
    // result cost: an unchanged cached reading is not evidence of zero spend, so
    // the cost stays undefined and the token-based estimate applies.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.finishPrompt("end_turn", { usage: { inputTokens: 800, outputTokens: 120 } });
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.input).toBe(800);
    expect(o2.usage?.costUsd).toBeUndefined();
    await Effect.runPromise(driver.stopAll());
  });

  it("does not charge a fresh session's pre-turn reading to the first turn (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // A $0.50 cumulative reading arrives before any turn exists.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 100, size: 100_000, cost: 0.5 });
    await new Promise((r) => setTimeout(r, 10));
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    // The counter grows to $0.60 during the turn: only the $0.10 delta past the
    // absorbed out-of-turn baseline belongs to this turn.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.1, 9);
    server.finishPrompt("end_turn");
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.1, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("books the per-turn counter high-water so the ledger totals the counter (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // Turn 1: the counter reads $0.20 then $0.10 (downward) with no result cost:
    // the per-turn high-water ($0.20) is booked, not the last reading.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_500, size: 100_000, cost: 0.1 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.2, 9);
    // Turn 2: the counter reaches $0.25, so the booked ledger must total $0.25 —
    // the baseline advanced only by the spend actually booked.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.25 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.costUsd).toBeCloseTo(0.05, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("books the counter over a lower prompt-result cost so the ledger totals the counter (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // Turn 1: the counter moved to $0.20 while the prompt result claims $0.10.
    // The spec-defined cumulative counter wins; the result cost never advanced
    // the accounted baseline past the spend actually booked.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn", { usage: { inputTokens: 900, outputTokens: 100, cost: 0.1 } });
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.2, 9);
    // Turn 2: the counter reaches $0.25; the ledger totals $0.25 against it.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.25 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.costUsd).toBeCloseTo(0.05, 9);
    await Effect.runPromise(driver.stopAll());
  });
});

describe("LOCAL-009 round 5: counter evidence, and equal snapshots", () => {
  it("books the prompt result's spend when the unchanged counter snapshot trails the baseline (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // Turn 1 books $0.20 from the counter.
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const o1 = await driver.awaitTurn("thread-1", t1.turnId);
    expect(o1.usage?.costUsd).toBeCloseTo(0.2, 9);
    // Turn 2: the in-turn snapshot is UNCHANGED (still $0.20) and the prompt
    // result reports $0.10. The lagging snapshot is not proof of zero spend:
    // the known result spend is booked, not an explicit $0.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_500, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeUndefined();
    server.finishPrompt("end_turn", { usage: { inputTokens: 800, outputTokens: 120, cost: 0.1 } });
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.costUsd).toBeCloseTo(0.1, 9);
    // The counter reaches $0.30 after settlement: the growth is reconciled
    // against amounts already booked, so nothing is booked a second time.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.3 });
    await new Promise((r) => setTimeout(r, 10));
    const t3 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "three" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_500, size: 100_000, cost: 0.3 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const o3 = await driver.awaitTurn("thread-1", t3.turnId);
    expect(o3.usage?.costUsd).toBeUndefined();
    // The booked ledger totals the counter's $0.30 movement exactly.
    expect(o1.usage!.costUsd! + o2.usage!.costUsd!).toBeCloseTo(0.3, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("leaves the turn cost undefined when an unchanged snapshot is the only counter evidence (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    const t1 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    await driver.awaitTurn("thread-1", t1.turnId);
    // Turn 2's fresh reading equals the baseline and the result carries tokens
    // but no cost: no spend is provable, so the cost stays undefined and the
    // token-based estimate applies, never a reported $0.
    const t2 = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_500, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn", { usage: { inputTokens: 400, outputTokens: 60 } });
    const o2 = await driver.awaitTurn("thread-1", t2.turnId);
    expect(o2.usage?.input).toBe(400);
    expect(o2.usage?.costUsd).toBeUndefined();
    await Effect.runPromise(driver.stopAll());
  });
});

describe("LOCAL-009 round 6: the effective baseline advances with the counter", () => {
  it("does not rebook spend already covered by an idle counter reading (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // An idle cumulative reading of $0.50 arrives with no turn open.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 100, size: 100_000, cost: 0.5 });
    await new Promise((r) => setTimeout(r, 10));
    // Turn A: the counter reaches $0.60 → $0.10.
    const tA = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oA = await driver.awaitTurn("thread-1", tA.turnId);
    expect(oA.usage?.costUsd).toBeCloseTo(0.1, 9);
    // Turn B: with no new idle reading, the counter reaches $0.70 → $0.10
    // again. The baseline advanced to the $0.60 reading actually used, so the
    // already-covered spend is not booked twice.
    const tB = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.7 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oB = await driver.awaitTurn("thread-1", tB.turnId);
    expect(oB.usage?.costUsd).toBeCloseTo(0.1, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("does not rebook spend on a resumed session after an idle reading establishes the origin (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport({ sessionId: "acp-old" });
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    const server = transport.sessions[0]!.server;
    // An idle reading establishes the resumed counter's origin at $0.50.
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 100, size: 100_000, cost: 0.5 });
    await new Promise((r) => setTimeout(r, 10));
    // Turn A: the counter reaches $0.60 → $0.10.
    const tA = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oA = await driver.awaitTurn("thread-1", tA.turnId);
    expect(oA.usage?.costUsd).toBeCloseTo(0.1, 9);
    // Turn B: the counter reaches $0.70 → $0.10, never $0.20 on the stale origin.
    const tB = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.7 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oB = await driver.awaitTurn("thread-1", tB.turnId);
    expect(oB.usage?.costUsd).toBeCloseTo(0.1, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("treats an idle reading between turns as the baseline, without re-booking later (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    // Turn A books $0.20 from a fresh counter.
    const tA = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.2 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oA = await driver.awaitTurn("thread-1", tA.turnId);
    expect(oA.usage?.costUsd).toBeCloseTo(0.2, 9);
    // An idle reading between turns raises the baseline to $0.50.
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_500, size: 100_000, cost: 0.5 });
    await new Promise((r) => setTimeout(r, 10));
    // Turn B: the counter reaches $0.60 → $0.10 past the $0.50 baseline.
    const tB = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oB = await driver.awaitTurn("thread-1", tB.turnId);
    expect(oB.usage?.costUsd).toBeCloseTo(0.1, 9);
    // Turn C: the counter reaches $0.70 → $0.10 again — the baseline advanced
    // to the $0.60 reading turn B actually used.
    const tC = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "three" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_500, size: 100_000, cost: 0.7 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oC = await driver.awaitTurn("thread-1", tC.turnId);
    expect(oC.usage?.costUsd).toBeCloseTo(0.1, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("advances the baseline by a result-only turn's booked spend, so the counter catching up is not rebooked (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 100, size: 100_000, cost: 0.5 });
    await new Promise((r) => setTimeout(r, 10));
    // Turn A carries no counter reading but an explicit $0.10 result cost.
    const tA = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.finishPrompt("end_turn", { usage: { inputTokens: 500, outputTokens: 50, cost: 0.1 } });
    const oA = await driver.awaitTurn("thread-1", tA.turnId);
    expect(oA.usage?.costUsd).toBeCloseTo(0.1, 9);
    // Turn B: the counter catches up at $0.65 — only $0.05 remains unbooked,
    // never the $0.15 the lagging baseline would re-attribute.
    const tB = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.65 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oB = await driver.awaitTurn("thread-1", tB.turnId);
    expect(oB.usage?.costUsd).toBeCloseTo(0.05, 9);
    await Effect.runPromise(driver.stopAll());
  });

  it("leaves a fallen counter unbooked and books only the strict rebound past the baseline (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport();
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession(START));
    const server = transport.sessions[0]!.server;
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 100, size: 100_000, cost: 0.5 });
    await new Promise((r) => setTimeout(r, 10));
    // Turn A: the counter reaches $0.60 → $0.10 booked.
    const tA = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.6 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oA = await driver.awaitTurn("thread-1", tA.turnId);
    expect(oA.usage?.costUsd).toBeCloseTo(0.1, 9);
    // Turn B: the counter falls to $0.55 — a lower reading is not evidence of
    // spend, so nothing is booked and no negative delta is invented.
    const tB = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 1_500, size: 100_000, cost: 0.55 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn", { usage: { inputTokens: 400, outputTokens: 40 } });
    const oB = await driver.awaitTurn("thread-1", tB.turnId);
    expect(oB.usage?.costUsd).toBeUndefined();
    // Turn C: the counter rebounds to $0.65 — only the $0.05 strictly above
    // the $0.60 baseline is booked, never the dip that followed.
    const tC = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "three" }));
    server.notifyUpdate("acp-sess-1", { sessionUpdate: "usage_update", used: 2_000, size: 100_000, cost: 0.65 });
    await new Promise((r) => setTimeout(r, 10));
    server.finishPrompt("end_turn");
    const oC = await driver.awaitTurn("thread-1", tC.turnId);
    expect(oC.usage?.costUsd).toBeCloseTo(0.05, 9);
    await Effect.runPromise(driver.stopAll());
  });
});

describe("LOCAL-009 round 7: the first idle reading on a resumed session", () => {
  it("treats a lagging first idle reading as at least the result costs already booked (LOCAL-009)", async () => {
    const transport = new FakeAcpTransport({ sessionId: "acp-old" });
    const driver = new AcpDriver({ provider: "antigravity", transport });
    await Effect.runPromise(driver.startSession({ ...START, resumeCursor: "acp-old" }));
    const server = transport.sessions[0]!.server;
    // Turn A: no counter reading at all; its prompt result reports $0.125,
    // booked while the resumed counter's origin is still unknown.
    const tA = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "one" }));
    server.finishPrompt("end_turn", { usage: { inputTokens: 500, outputTokens: 50, cost: 0.125 } });
    const oA = await driver.awaitTurn("thread-1", tA.turnId);
    expect(oA.usage?.costUsd).toBeCloseTo(0.125, 9);
    // The FIRST idle reading arrives at $0.0625: the cumulative counter has
    // only caught up to half of A's charge. It must not settle the origin
    // below the spend already booked.
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 100, size: 100_000, cost: 0.0625 });
    await new Promise((r) => setTimeout(r, 10));
    // Turn B spends $0.0625: its in-turn counter reaches $0.1875 and its
    // prompt result confirms $0.0625 — never the $0.125 a re-anchored origin
    // would double-book.
    const tB = await Effect.runPromise(driver.sendTurn({ threadId: "thread-1", prompt: "two" }));
    server.notifyUpdate("acp-old", { sessionUpdate: "usage_update", used: 1_000, size: 100_000, cost: 0.1875 });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.liveTurnUsage("thread-1")?.costUsd).toBeCloseTo(0.0625, 9);
    server.finishPrompt("end_turn", { usage: { inputTokens: 300, outputTokens: 30, cost: 0.0625 } });
    const oB = await driver.awaitTurn("thread-1", tB.turnId);
    expect(oB.usage?.costUsd).toBeCloseTo(0.0625, 9);
    // The booked ledger totals the counter's $0.1875 movement exactly.
    expect(oA.usage!.costUsd! + oB.usage!.costUsd!).toBeCloseTo(0.1875, 9);
    await Effect.runPromise(driver.stopAll());
  });
});

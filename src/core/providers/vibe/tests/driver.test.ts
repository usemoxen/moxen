import path from "node:path";
import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import type { ConnectMcp } from "../../harness/mcp.js";
import type { McpClient } from "../../harness/mcpclient.js";
import type { McpServerSpec } from "../../../mcp.js";
import { subscribeDriverThread, subscribeDriverUsage } from "../../../threads/execute.js";
import { JsonRpcPeer, type SpawnedProcess } from "../../stdio.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { applyVibeJsonPatch, parseVibeEffectiveConfig, VIBE_METHODS } from "../protocol.js";
import type { VibeTransport } from "../transport.js";
import { VibeDriver } from "../driver.js";
import { vibeProvider, forgetVibeCatalogCache } from "../catalog.js";
import { vibeWindowsOf, rewriteVibeLimitError } from "../usage.js";

interface RecordedRpc {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

class FakeVibeServer {
  readonly received: RecordedRpc[] = [];
  private dataHandlers = new Set<(chunk: string) => void>();
  private exitHandlers = new Set<(code: number | null) => void>();
  private responseWaiters = new Map<string | number, (msg: Record<string, unknown>) => void>();
  private nextServerReqId = 1000;
  private handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  closed = false;

  on(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
    this.handlers.set(method, handler);
  }

  sendNotification(method: string, params: unknown): void {
    this.emitLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async sendRequest(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = `srv-${this.nextServerReqId++}`;
    return await new Promise<Record<string, unknown>>((resolve) => {
      this.responseWaiters.set(id, resolve);
      this.emitLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private emitLine(line: string): void {
    for (const h of [...this.dataHandlers]) h(`${line}\n`);
  }

  createPeer(): JsonRpcPeer {
    const proc: SpawnedProcess = {
      pid: 4242,
      writeLine: (line: string) => {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg["method"] === "string") {
          const method = msg["method"];
          const id = msg["id"] as string | number | undefined;
          const params = msg["params"];
          this.received.push({ ...(id !== undefined ? { id } : {}), method, params });
          if (id === undefined) return;
          const handler = this.handlers.get(method);
          if (!handler) {
            this.emitLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unhandled: ${method}` } }));
            return;
          }
          Promise.resolve(handler(params)).then(
            (result) => this.emitLine(JSON.stringify({ jsonrpc: "2.0", id, result })),
            (err) => {
              const message = err instanceof Error ? err.message : String(err);
              this.emitLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
            },
          );
        } else if (msg["id"] !== undefined) {
          const waiter = this.responseWaiters.get(msg["id"] as string | number);
          if (waiter) {
            this.responseWaiters.delete(msg["id"] as string | number);
            waiter(msg);
          }
        }
      },
      onData: (handler) => {
        this.dataHandlers.add(handler);
        return () => this.dataHandlers.delete(handler);
      },
      onExit: (handler) => {
        this.exitHandlers.add(handler);
        return () => this.exitHandlers.delete(handler);
      },
      kill: () => {
        if (this.closed) return;
        this.closed = true;
        for (const h of [...this.exitHandlers]) h(0);
      },
    };
    return new JsonRpcPeer(proc, { forceKillAfterMs: 0 });
  }
}

function setupDefaultServer(server: FakeVibeServer, sessionId = "vibe-sess-1"): void {
  server.on(VIBE_METHODS.initialize, () => ({
    serverInfo: { name: "vibe-app-server", version: "3.1.4" },
    processId: 4242,
    platformCredentials: false,
  }));
  server.on(VIBE_METHODS.setupStatus, () => ({
    hasApiKey: true,
    activeCredentialSource: "os_keyring",
    activeModel: "mistral-large-4-0",
    supportsBrowserSignIn: true,
  }));
  server.on(VIBE_METHODS.configRead, () => ({
    config: {
      activeModel: {
        name: "mistral-large-4-0",
        alias: "mistral-large-4-0",
        displayName: "Mistral Large 4",
        thinking: "high",
        thinkingLevels: ["low", "medium", "high"],
        maxContextLength: 1048576,
        autoCompactThreshold: 400000,
        supportsImages: true,
        requires: null,
      },
      models: [
        {
          name: "mistral-large-4-0",
          alias: "mistral-large-4-0",
          displayName: "Mistral Large 4",
          thinking: "high",
          thinkingLevels: ["low", "medium", "high"],
          maxContextLength: 1048576,
          autoCompactThreshold: 400000,
          supportsImages: true,
          requires: null,
        },
        {
          name: "locked-model",
          alias: "locked-model",
          displayName: "Locked Model",
          thinking: "high",
          thinkingLevels: ["high"],
          maxContextLength: 128000,
          supportsImages: false,
          requires: "team",
        },
      ],
    },
  }));
  server.on(VIBE_METHODS.sessionStart, () => ({
    state: {
      session: { id: sessionId, title: null, status: { type: "idle" } },
      history: [],
      backgroundProcesses: [],
    },
  }));
  server.on(VIBE_METHODS.accountRead, () => ({
    account: {
      status: "ready",
      plan: { kind: "chat", name: "INDIVIDUAL", title: "Pro" },
      budget: {
        usagePercentage: 12.5,
        resetAt: "2026-12-01T00:00:00Z",
        paygEnabled: false,
      },
    },
  }));
  server.on(VIBE_METHODS.sessionStop, () => ({ closed: true }));
}

function makeTransport(servers: FakeVibeServer[]): VibeTransport {
  let index = 0;
  return {
    startPeer: () => {
      const server = servers[Math.min(index++, servers.length - 1)]!;
      return server.createPeer();
    },
  };
}

describe("vibe protocol JSON-Patch & usage helpers", () => {
  it("applies append, replace, add, and remove patch ops without mutating input", () => {
    const doc = {
      id: "e1",
      content: [{ type: "text", text: "Hello" }],
      extra: "old",
    };
    const next = applyVibeJsonPatch(doc, [
      { op: "append", path: "/content/0/text", value: " world" },
      { op: "remove", path: "/extra" },
      { op: "add", path: "/generationStatus", value: "completed" },
    ]) as Record<string, unknown>;
    expect((doc.content[0] as { text: string }).text).toBe("Hello");
    expect(((next["content"] as Array<{ text: string }>)[0]!).text).toBe("Hello world");
    expect(next["extra"]).toBeUndefined();
    expect(next["generationStatus"]).toBe("completed");
  });

  it("maps monthly budget windows and PAYG flag cleanly", () => {
    const regular = vibeWindowsOf({
      status: "ready",
      planKind: "chat",
      planName: "INDIVIDUAL",
      planTitle: "Pro",
      budget: { usagePercentage: 100, resetAt: "2026-12-01T00:00:00Z", paygEnabled: false },
    });
    expect(regular).toEqual([
      { id: "monthly", label: "Monthly", resetsAt: "2026-12-01T00:00:00Z", exhausted: true, usedPercent: 100 },
    ]);

    const payg = vibeWindowsOf({
      status: "ready",
      planKind: "chat",
      planName: "INDIVIDUAL",
      planTitle: "Pro",
      budget: { usagePercentage: 100, resetAt: "2026-12-01T00:00:00Z", paygEnabled: true },
    });
    expect(payg[0]?.exhausted).toBe(false);
    expect(payg[0]?.label).toBe("Monthly (PAYG)");

    expect(rewriteVibeLimitError("usage limit reached", null)).toBe("Mistral Vibe usage limit exceeded.");
  });
});

describe("VibeDriver contract", () => {
  it("handshakes honestly, disables native task subagent, streams patches/tools/reasoning, and reports monthly usage", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, () => {
      setTimeout(() => {
        server.sendNotification(VIBE_METHODS.turnStarted, {
          turn: { id: "t-srv-1", inputEntryId: "entry-user-1", status: "in_progress" },
        });
        server.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: { id: "r-1", type: "reasoning", text: "Thinking", generationStatus: "generating" },
        });
        server.sendNotification(VIBE_METHODS.historyEntryUpdated, {
          entryId: "r-1",
          patch: [
            { op: "append", path: "/text", value: " harder" },
            { op: "replace", path: "/generationStatus", value: "completed" },
          ],
        });
        server.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: { id: "m-note", type: "message", role: "assistant", content: [{ type: "text", text: "Checking file" }], generationStatus: "completed" },
        });
        server.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: {
            id: "eff-1",
            type: "effect",
            toolCallId: "tc-1",
            title: "Edit foo.ts",
            detail: { kind: "file_edit", toolName: "edit", input: { filePath: "foo.ts", oldString: "a", newString: "b" } },
            state: { status: "completed", outputText: "ok", durationMs: 12 },
          },
        });
        server.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: { id: "m-final", type: "message", role: "assistant", content: [{ type: "text", text: "Done" }], generationStatus: "generating" },
        });
        server.sendNotification(VIBE_METHODS.historyEntryUpdated, {
          entryId: "m-final",
          patch: [
            { op: "append", path: "/content/0/text", value: "!" },
            { op: "replace", path: "/generationStatus", value: "completed" },
          ],
        });
        server.sendNotification(VIBE_METHODS.statsUpdated, {
          contextWindow: 1048576,
          stats: {
            sessionPromptTokens: 1200,
            sessionCompletionTokens: 200,
            sessionCachedTokens: 400,
            lastTurnPromptTokens: 1200,
            lastTurnCompletionTokens: 200,
            lastTurnCachedTokens: 400,
            contextTokens: 1400,
          },
        });
        server.sendNotification(VIBE_METHODS.turnCompleted, {
          turn: { id: "t-srv-1", status: "completed" },
        });
      }, 10);
      return { turn: { id: "t-srv-1", inputEntryId: "entry-user-1", status: "in_progress" } };
    });

    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));

    await Effect.runPromise(driver.startSession({
      threadId: "th-1",
      workingDirectory: "/tmp/repo",
      modelSelection: { instanceId: "vibe", model: "mistral-large-4-0", options: [{ id: "effort", value: "high" }] },
      instructions: "Follow Moxen rules.",
      mcpServers: [{ name: "moxen", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }],
    }));

    const initCall = server.received.find((r) => r.method === VIBE_METHODS.initialize);
    expect((initCall?.params as Record<string, unknown>)["clientInfo"]).toMatchObject({
      name: "moxen",
      entrypoint: "unknown",
    });

    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const startParams = startCall?.params as Record<string, unknown>;
    expect(startParams["sessionOnly"]).toBe(true);
    expect(startParams["model"]).toBe("mistral-large-4-0");
    expect(startParams["reasoningEffort"]).toBe("high");
    const agentCfg = startParams["agentConfig"] as Record<string, unknown>;
    expect(agentCfg["disabledTools"]).toContain("task");
    expect(agentCfg["instructions"]).toBe("Follow Moxen rules.");
    expect(agentCfg["mcpServers"]).toEqual([
      { transport: "streamable-http", name: "moxen", url: "http://127.0.0.1:9999/mcp" },
    ]);

    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "th-1", prompt: "Fix foo" }));
    const outcome = await driver.awaitTurn("th-1", turnId);
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("Done!");
    expect(outcome.usage).toEqual({ input: 800, cacheRead: 400, cacheCreate: 0, output: 200, thinking: 0 });
    expect(driver.resumeCursor("th-1")).toBe("vibe-sess-1");

    expect(events.some((e) => e.type === "assistant.note" && e.text === "Checking file")).toBe(true);
    expect(events.some((e) => e.type === "tool.execute.completed" && e.tool === "Edit")).toBe(true);
    expect(events.some((e) => e.type === "reasoning.updated" && e.status === "completed" && e.text === "Thinking harder")).toBe(true);
    expect(events.some((e) => e.type === "rate-limits.updated" && e.windows[0]?.usedPercent === 12.5)).toBe(true);

    await Effect.runPromise(driver.stopSession("th-1"));
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("enforces worktree isolation on approval callbacks even in full-access and blocks session-wide approvals", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const callbackResults: unknown[] = [];
    server.on(VIBE_METHODS.callbackResult, (params) => {
      callbackResults.push(params);
      return { accepted: true };
    });

    const wtRoot = path.resolve("/tmp/moxen-wt");
    const mainRoot = path.resolve("/tmp/moxen-main");
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-iso",
      workingDirectory: wtRoot,
      runtimeMode: "full-access",
      isolation: { worktreeRoot: wtRoot, protectedRoots: [mainRoot] },
    }));

    // Attempted write into protected main checkout must be denied immediately.
    const ack1 = await server.sendRequest(VIBE_METHODS.callbackCall, {
      callback: {
        callbackId: "cb-escape",
        detail: {
          kind: "approval",
          effect: { kind: "file_write", toolName: "write_file", input: { filePath: path.join(mainRoot, "evil.ts"), content: "x" } },
        },
      },
    });
    expect(ack1["result"]).toEqual({ callbackId: "cb-escape", accepted: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(callbackResults[0]).toMatchObject({
      result: { callbackId: "cb-escape", output: { type: "approval", decision: { type: "deny" } } },
    });

    // Write inside the worktree under full-access is auto-approved with single-use `approve` (never session-wide).
    await server.sendRequest(VIBE_METHODS.callbackCall, {
      callback: {
        callbackId: "cb-safe",
        detail: {
          kind: "approval",
          effect: { kind: "file_write", toolName: "write_file", input: { filePath: path.join(wtRoot, "ok.ts"), content: "x" } },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(callbackResults[1]).toMatchObject({
      result: { callbackId: "cb-safe", output: { type: "approval", decision: { type: "approve" } } },
    });

    await Effect.runPromise(driver.stopSession("th-iso"));
  });

  it("supports mid-turn steering, native compaction handoff, rewind handoff, and tool-free /btw fork", async () => {
    const server = new FakeVibeServer();
    const btwServer = new FakeVibeServer();
    setupDefaultServer(server, "vibe-s1");
    setupDefaultServer(btwServer, "vibe-btw-fork");

    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    server.on(VIBE_METHODS.turnSteer, () => ({ accepted: true }));
    server.on(VIBE_METHODS.sessionCompact, () => ({
      summary: "Compacted summary",
      state: { session: { id: "vibe-s2", title: "My Thread" }, history: [] },
    }));
    server.on(VIBE_METHODS.sessionRewind, () => ({
      message: "Rewound",
      restoreErrors: [],
      restoredPaths: [],
      state: { session: { id: "vibe-s3", title: "My Thread" }, history: [] },
    }));

    btwServer.on(VIBE_METHODS.sessionFork, () => ({
      sourceSessionId: "vibe-s3",
      state: { session: { id: "vibe-btw-fork" }, history: [] },
    }));
    btwServer.on(VIBE_METHODS.turnStart, () => {
      setTimeout(() => {
        btwServer.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: { id: "btw-a1", type: "message", role: "assistant", content: [{ type: "text", text: "Side answer" }], generationStatus: "completed" },
        });
        btwServer.sendNotification(VIBE_METHODS.turnCompleted, {
          turn: { id: "btw-t1", status: "completed" },
        });
      }, 10);
      return { turn: { id: "btw-t1", status: "in_progress" } };
    });

    const driver = new VibeDriver({ transport: makeTransport([server, btwServer]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-2", workingDirectory: "/tmp/repo" }));
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "th-2", prompt: "First" }));
    await Effect.runPromise(driver.steerTurn("th-2", "Also check tests", undefined, "steer-1"));
    // Unconfirmed before turn_steer message arrives -> returned by takeUnconfirmedSteers
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    await driver.awaitTurn("th-2", turnId);
    expect(driver.takeUnconfirmedSteers("th-2")).toHaveLength(1);

    // Compact adopts handed-off session id `vibe-s2`
    await Effect.runPromise(driver.compaction.type === "native" ? driver.compaction.start("th-2") : Effect.void);
    expect(driver.resumeCursor("th-2")).toBe("vibe-s2");

    // Rollback calls session/rewind with restoreFiles: false and adopts `vibe-s3`
    const snap = await Effect.runPromise(driver.rollbackThread("th-2", 1));
    expect(snap.turns).toHaveLength(0);
    expect(driver.resumeCursor("th-2")).toBe("vibe-s3");
    const rewindReq = server.received.find((r) => r.method === VIBE_METHODS.sessionRewind);
    expect(rewindReq?.params).toMatchObject({ restoreFiles: false, entryId: "u1" });

    // /btw uses session/fork with enabledTools: []
    const side = await driver.sideQuestion({
      cursor: "vibe-s3",
      workingDirectory: "/tmp/repo",
      question: "What did we decide?",
    });
    expect(side).toEqual({ text: "Side answer", withContext: true });
    const forkReq = btwServer.received.find((r) => r.method === VIBE_METHODS.sessionFork);
    expect((forkReq?.params as Record<string, unknown>)["agentConfig"]).toMatchObject({ enabledTools: [] });

    await Effect.runPromise(driver.stopSession("th-2"));
  });

  it("discovers unlocked models via passive catalog query without starting a session", async () => {
    forgetVibeCatalogCache();
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const summary = await vibeProvider(undefined, process.env, "/tmp/repo", makeTransport([server]));
    expect(summary.enabled).toBe(true);
    expect(summary.authStatus).toBe("os_keyring");
    expect(summary.models.map((m) => m.slug)).toEqual(["mistral-large-4-0"]);
    expect(summary.models[0]?.efforts[0]?.choices.map((c) => c.id)).toEqual(["low", "medium", "high"]);
    // Never opened a session during catalog discovery.
    expect(server.received.some((r) => r.method === VIBE_METHODS.sessionStart)).toBe(false);
  });

  it("reads monthly budget via refreshUsage even before any session is open, and stops its probe session", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]), instanceId: "vibe" });

    const refreshed = await driver.refreshUsage();
    expect(refreshed).toEqual({
      key: "vibe",
      windows: [
        { id: "monthly", label: "Monthly", resetsAt: "2026-12-01T00:00:00Z", exhausted: false, usedPercent: 12.5 },
      ],
    });
    expect(server.received.some((r) => r.method === VIBE_METHODS.accountRead)).toBe(true);
    expect(server.received.some((r) => r.method === VIBE_METHODS.sessionStop)).toBe(true);
  });
});

/** Match a Vibe `disabledTools` entry the way Vibe does: `re:` regex full
 * match or case-insensitive fnmatch glob, against the published tool name. */
function vibeDisabledMatches(patterns: readonly string[], name: string): boolean {
  const lowered = name.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim();
    if (pattern.startsWith("re:")) {
      return new RegExp(`^(?:${pattern.slice(3)})$`, "i").test(name);
    }
    const glob = pattern
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${glob}$`).test(lowered);
  });
}

describe("VibeDriver review regressions", () => {
  it("hides individually excluded MCP tools through Vibe's published-name disabledTools filter", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-mcp",
      workingDirectory: "/tmp/repo",
      // The tool list is known (in-process), so the exclusion resolves to the
      // exact published display name and the server stays offered.
      mcpServers: [inProcessServer("demo", ["write", "read"])],
      disabledMcpTools: ["mcp__demo__write"],
    }));

    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    const disabled = agentCfg["disabledTools"] as string[];
    expect(disabled).toContain("task");
    // Vibe (unified harness, v3.1.4) publishes MCP tools as `<server>_<tool>`
    // and filters disabledTools against that display name. Moxen matches the
    // exact published name only — no speculative hex suffix — so a literal
    // digest-named sibling (`demo_write_ba51f2af`, `demo_write_deadbeef`) and
    // `demo_write_file` stay available.
    expect(vibeDisabledMatches(disabled, "demo_write")).toBe(true);
    expect(vibeDisabledMatches(disabled, "demo_write_ba51f2af")).toBe(false);
    expect(vibeDisabledMatches(disabled, "demo_write_deadbeef")).toBe(false);
    expect(vibeDisabledMatches(disabled, "demo_write_file")).toBe(false);
    expect(vibeDisabledMatches(disabled, "demo_read")).toBe(false);

    await Effect.runPromise(driver.stopSession("th-mcp"));
  });

  it("settles an open turn and its waiters as interrupted when the session stops", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t-open", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-stop", workingDirectory: "/tmp/repo" }));
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "th-stop", prompt: "Work" }));
    const waiting = driver.awaitTurn("th-stop", turnId);
    await Effect.runPromise(driver.stopSession("th-stop"));
    const outcome = await Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcome).toMatchObject({ status: "interrupted" });
  });

  it("does not complete the current turn from a stale or early turn/completed, and confirms steers by client message id", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let starts = 0;
    server.on(VIBE_METHODS.turnStart, async () => {
      starts += 1;
      if (starts === 1) return { turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } };
      // A stale completion for t1 lands before the client can know t2's id.
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { turn: { id: "t2", inputEntryId: "u2", status: "in_progress" } };
    });
    server.on(VIBE_METHODS.turnSteer, () => ({ accepted: true }));

    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-corr", workingDirectory: "/tmp/repo" }));
    const first = await Effect.runPromise(driver.sendTurn({ threadId: "th-corr", prompt: "First" }));
    await Effect.runPromise(driver.steerTurn("th-corr", "first", undefined, "steer-A"));
    await Effect.runPromise(driver.steerTurn("th-corr", "second", undefined, "steer-B"));
    // The server echoes steer B under its client message id, with rewritten
    // text: only B may be confirmed, never the first unconfirmed steer.
    server.sendNotification(VIBE_METHODS.historyEntryAdded, {
      entry: { id: "steer-B", type: "message", role: "user", source: "turn_steer", content: [{ type: "text", text: "rewritten by server" }] },
    });
    expect(driver.takeUnconfirmedSteers("th-corr").map((s) => s.id)).toEqual(["steer-A"]);

    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    expect((await driver.awaitTurn("th-corr", first.turnId)).status).toBe("completed");

    // The stale t1 completion above arrived while t2's start was in flight;
    // it must not settle t2.
    const second = await Effect.runPromise(driver.sendTurn({ threadId: "th-corr", prompt: "Second" }));
    const early = await Promise.race([
      driver.awaitTurn("th-corr", second.turnId),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(early).toBe("hung");
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t2", status: "completed" } });
    expect((await driver.awaitTurn("th-corr", second.turnId)).status).toBe("completed");

    await Effect.runPromise(driver.stopSession("th-corr"));
  });

  it("settles a timed-out turn start locally and closes the peer that may be running an unidentifiable turn", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, () => new Promise(() => {})); // never answers
    const driver = new VibeDriver({ transport: makeTransport([server]), requestTimeoutMs: 60 });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    await Effect.runPromise(driver.startSession({ threadId: "th-to", workingDirectory: "/tmp/repo" }));

    const result = await Effect.runPromiseExit(driver.sendTurn({ threadId: "th-to", prompt: "Work" }));
    expect(Exit.isFailure(result)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    expect(server.closed).toBe(true);
    expect(await Effect.runPromise(driver.hasSession("th-to"))).toBe(false);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("refuses to start a turn under a policy downgrade the server never acknowledged", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, () => {
      throw new Error("policy update refused");
    });
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-mode", workingDirectory: "/tmp/repo", runtimeMode: "full-access" }));

    driver.setRuntimeMode("th-mode", "approval-required");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await Effect.runPromiseExit(driver.sendTurn({ threadId: "th-mode", prompt: "Work", runtimeMode: "approval-required" }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(server.received.some((r) => r.method === VIBE_METHODS.turnStart)).toBe(false);

    await Effect.runPromise(driver.stopSession("th-mode"));
  });
});

describe("VibeDriver round-2 regressions", () => {
  it("never starts a turn under a wider policy when an upgrade ack races a refused downgrade", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let releaseUpgrade!: () => void;
    const upgradeGate = new Promise<void>((resolve) => { releaseUpgrade = resolve; });
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, async (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"];
      if (policy === "auto-approve") {
        await upgradeGate; // hold the upgrade ack until the downgrade is queued
        return { status: "applied", runtime: { approvalPolicy: policy } };
      }
      throw new Error("downgrade refused");
    });
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-race", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    driver.setRuntimeMode("th-race", "full-access");
    await new Promise((resolve) => setTimeout(resolve, 10)); // upgrade RPC now in flight (gated)
    driver.setRuntimeMode("th-race", "approval-required");
    releaseUpgrade(); // server applies + acks the upgrade, then refuses the downgrade
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await Effect.runPromiseExit(driver.sendTurn({ threadId: "th-race", prompt: "Work", runtimeMode: "approval-required" }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(server.received.some((r) => r.method === VIBE_METHODS.turnStart)).toBe(false);

    await Effect.runPromise(driver.stopSession("th-race"));
  });

  it("mirrors Vibe alias stripping when excluding an MCP tool on a padded server name", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-alias",
      workingDirectory: "/tmp/repo",
      mcpServers: [inProcessServer("-demo_", ["write"])],
      disabledMcpTools: ["mcp__-demo___write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const disabled = ((startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>)["disabledTools"] as string[];
    // Vibe strips leading/trailing `_`/`-` from the alias: published name is `demo_write`.
    expect(vibeDisabledMatches(disabled, "demo_write")).toBe(true);
    await Effect.runPromise(driver.stopSession("th-alias"));
  });

  it("routes only the server holding an exclusion whose tool list Moxen cannot know through the lazy gateway", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-collide",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "alpha", type: "http", url: "http://127.0.0.1:9998/mcp", headers: {} },
        { name: "beta", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__alpha__write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    // `alpha` holds the excluded tool and Moxen cannot know its tool list, so
    // alpha alone leaves the direct offer for the lazy MCP gateway (which
    // enforces the exclusion inside); `beta` keeps its offer untouched.
    expect((agentCfg["mcpServers"] as Array<{ name: string }>).map((s) => s.name))
      .toEqual(["beta", expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    const disabled = agentCfg["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "alpha_write")).toBe(false);
    expect(vibeDisabledMatches(disabled, "beta_write")).toBe(false);
    await Effect.runPromise(driver.stopSession("th-collide"));
  });

  it("normalizes an astral character in an MCP tool name to a single underscore, as Python does", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-astral",
      workingDirectory: "/tmp/repo",
      mcpServers: [inProcessServer("demo", ["w\u{1F600}rite"])],
      disabledMcpTools: ["mcp__demo__w\u{1F600}rite"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const disabled = ((startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>)["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "demo_w_rite")).toBe(true);
    expect(vibeDisabledMatches(disabled, "demo_w__rite")).toBe(false);
    await Effect.runPromise(driver.stopSession("th-astral"));
  });

  it("does not let a stale turn/started authenticate a buffered stale completion", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let starts = 0;
    server.on(VIBE_METHODS.turnStart, async () => {
      starts += 1;
      if (starts === 1) return { turn: { id: "A", inputEntryId: "uA", status: "in_progress" } };
      // Before B's start reply: a duplicate completion for A, then a stale started(A).
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "A", status: "completed" } });
      server.sendNotification(VIBE_METHODS.turnStarted, { turn: { id: "A", inputEntryId: "uA", status: "in_progress" } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { turn: { id: "B", inputEntryId: "uB", status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-stale", workingDirectory: "/tmp/repo" }));
    const a = await Effect.runPromise(driver.sendTurn({ threadId: "th-stale", prompt: "A" }));
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "A", status: "completed" } });
    expect((await driver.awaitTurn("th-stale", a.turnId)).status).toBe("completed");

    const b = await Effect.runPromise(driver.sendTurn({ threadId: "th-stale", prompt: "B" }));
    const early = await Promise.race([
      driver.awaitTurn("th-stale", b.turnId),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(early).toBe("hung");
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "B", status: "completed" } });
    expect((await driver.awaitTurn("th-stale", b.turnId)).status).toBe("completed");
    await Effect.runPromise(driver.stopSession("th-stale"));
  });

  it("fails the turn explicitly when uncorrelated completions overflow the buffer instead of hanging", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, async () => {
      // The real completion arrives first, then 16 foreign ids, before the reply.
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "real", status: "completed" } });
      for (let i = 0; i < 16; i += 1) {
        server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: `foreign-${i}`, status: "completed" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { turn: { id: "real", inputEntryId: "u1", status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-overflow", workingDirectory: "/tmp/repo" }));
    const result = await Effect.runPromiseExit(driver.sendTurn({ threadId: "th-overflow", prompt: "Work" }));
    expect(Exit.isFailure(result)).toBe(true);
    // The session is closed so a server turn that may have been accepted is not
    // left running behind a locally failed row.
    expect(server.closed).toBe(true);
    expect(await Effect.runPromise(driver.hasSession("th-overflow"))).toBe(false);
  });

  it("drops completions for already-settled turns so they cannot evict the real one", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let starts = 0;
    server.on(VIBE_METHODS.turnStart, async () => {
      starts += 1;
      if (starts <= 20) return { turn: { id: `A${starts}`, inputEntryId: `u${starts}`, status: "in_progress" } };
      // B's real completion first, then 20 distinct settled-turn completions.
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "B", status: "completed" } });
      for (let i = 1; i <= 20; i += 1) {
        server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: `A${i}`, status: "completed" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { turn: { id: "B", inputEntryId: "uB", status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-drop", workingDirectory: "/tmp/repo" }));
    for (let i = 1; i <= 20; i += 1) {
      const t = await Effect.runPromise(driver.sendTurn({ threadId: "th-drop", prompt: `A${i}` }));
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: `A${i}`, status: "completed" } });
      expect((await driver.awaitTurn("th-drop", t.turnId)).status).toBe("completed");
    }
    const b = await Effect.runPromise(driver.sendTurn({ threadId: "th-drop", prompt: "B" }));
    const outcome = await Promise.race([
      driver.awaitTurn("th-drop", b.turnId),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcome).toMatchObject({ status: "completed" });
    await Effect.runPromise(driver.stopSession("th-drop"));
  });

  it("does not publish a compacted notice when the session stopped during /compact", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let releaseCompact!: (value: unknown) => void;
    let releaseStop!: (value: unknown) => void;
    server.on(VIBE_METHODS.sessionCompact, () => new Promise((resolve) => { releaseCompact = resolve; }));
    // Hold session/stop so stopSession is suspended at its RPC with the session
    // logically closed but the peer still open when the compact reply lands.
    server.on(VIBE_METHODS.sessionStop, () => new Promise((resolve) => { releaseStop = resolve; }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    await Effect.runPromise(driver.startSession({ threadId: "th-compact", workingDirectory: "/tmp/repo" }));

    const compacting = Effect.runPromise(driver.sendTurn({ threadId: "th-compact", prompt: "/compact" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopping = Effect.runPromise(driver.stopSession("th-compact"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseCompact({ summary: "Compacted", state: { session: { id: "vibe-s2", title: null }, history: [] } });
    await compacting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((e) => e.type === "session.notice" && e.notice === "compacted")).toBe(false);
    releaseStop({ closed: true });
    await stopping;
    await Effect.runPromise(Fiber.interrupt(fiber));
  });
});

describe("VibeDriver round-3 regressions", () => {
  it("preserves each overlapping send's requested mode through serialized admission", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let currentPolicy = "ask";
    let releaseUpgrade!: () => void;
    const gate = new Promise<void>((resolve) => { releaseUpgrade = resolve; });
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, async (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      if (policy === "auto-approve") await gate;
      currentPolicy = policy;
      return { status: "applied" };
    });
    const startPolicies: string[] = [];
    let starts = 0;
    server.on(VIBE_METHODS.turnStart, () => {
      startPolicies.push(currentPolicy);
      starts += 1;
      return { turn: { id: `t${starts}`, inputEntryId: `u${starts}`, status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-overlap", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    driver.setRuntimeMode("th-overlap", "full-access"); // upgrade held in flight
    await new Promise((resolve) => setTimeout(resolve, 10));
    const s1 = Effect.runPromiseExit(driver.sendTurn({ threadId: "th-overlap", prompt: "one", runtimeMode: "approval-required" }));
    const s2 = Effect.runPromiseExit(driver.sendTurn({ threadId: "th-overlap", prompt: "two", runtimeMode: "full-access" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseUpgrade();
    expect(Exit.isFailure(await s1)).toBe(false);
    expect(Exit.isFailure(await s2)).toBe(false);
    expect(startPolicies).toEqual(["ask", "auto-approve"]);
    await Effect.runPromise(driver.stopSession("th-overlap"));
  });

  it("closes the session when a policy write times out so a stale acknowledgement cannot admit a turn", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, () => new Promise(() => {})); // never replies
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]), requestTimeoutMs: 60 });
    await Effect.runPromise(driver.startSession({ threadId: "th-ptimeout", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));
    const result = await Effect.runPromiseExit(driver.sendTurn({ threadId: "th-ptimeout", prompt: "Work", runtimeMode: "full-access" }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(server.received.some((r) => r.method === VIBE_METHODS.turnStart)).toBe(false);
    expect(server.closed).toBe(true);
    expect(await Effect.runPromise(driver.hasSession("th-ptimeout"))).toBe(false);
  });

  it("does not treat a pending policy response as an acknowledgement", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, () => ({ status: "pending", runtime: {} }));
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-pending", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));
    const result = await Effect.runPromiseExit(driver.sendTurn({ threadId: "th-pending", prompt: "Work", runtimeMode: "full-access" }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(server.received.some((r) => r.method === VIBE_METHODS.turnStart)).toBe(false);
    await Effect.runPromise(driver.stopSession("th-pending"));
  });

  it("does not send turn/start after the session stopped while admission was pending", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let releasePolicy!: (value: unknown) => void;
    let releaseStop!: (value: unknown) => void;
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, () => new Promise((resolve) => { releasePolicy = resolve; }));
    server.on(VIBE_METHODS.sessionStop, () => new Promise((resolve) => { releaseStop = resolve; }));
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-stopadmit", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    const sending = Effect.runPromiseExit(driver.sendTurn({ threadId: "th-stopadmit", prompt: "Work", runtimeMode: "full-access" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopping = Effect.runPromise(driver.stopSession("th-stopadmit"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releasePolicy({ status: "applied" });
    expect(Exit.isFailure(await sending)).toBe(true);
    expect(server.received.some((r) => r.method === VIBE_METHODS.turnStart)).toBe(false);
    releaseStop({ closed: true });
    await stopping;
  });

  it("keeps early turn/started metadata and sends an interrupt requested while binding was pending", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let releaseStart!: (value: unknown) => void;
    server.on(VIBE_METHODS.turnStart, () => new Promise((resolve) => { releaseStart = resolve; }));
    const interrupts: unknown[] = [];
    server.on(VIBE_METHODS.turnInterrupt, (params) => {
      interrupts.push((params as Record<string, unknown>)["expectedTurnId"]);
      return { accepted: true };
    });
    server.on(VIBE_METHODS.sessionRewind, () => ({ state: { session: { id: "vibe-s1", title: null }, history: [] } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-early", workingDirectory: "/tmp/repo" }));

    const sending = Effect.runPromise(driver.sendTurn({ threadId: "th-early", prompt: "Work" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    server.sendNotification(VIBE_METHODS.turnStarted, { turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } });
    await Effect.runPromise(driver.interruptTurn("th-early"));
    releaseStart({ turn: { id: "t1", status: "in_progress" } }); // response carries no inputEntryId
    await sending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toEqual(["t1"]);
    const snap = await Effect.runPromise(driver.rollbackThread("th-early", 1));
    expect(snap.turns).toHaveLength(0);
    await Effect.runPromise(driver.stopSession("th-early"));
  });

  it("does not fail the turn when an already-buffered completion is duplicated", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, async () => {
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "real", status: "completed" } });
      for (let i = 0; i < 15; i += 1) {
        server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: `f${i}`, status: "completed" } });
      }
      server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "real", status: "completed" } }); // duplicate
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { turn: { id: "real", inputEntryId: "u1", status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-dup", workingDirectory: "/tmp/repo" }));
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "th-dup", prompt: "Work" }));
    const outcome = await Promise.race([
      driver.awaitTurn("th-dup", turnId),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcome).toMatchObject({ status: "completed" });
    await Effect.runPromise(driver.stopSession("th-dup"));
  });

  it("matches only the exact published MCP name, not a literal digest-like sibling", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-exact",
      workingDirectory: "/tmp/repo",
      mcpServers: [inProcessServer("demo", ["write", "write_ba51f2af"])],
      disabledMcpTools: ["mcp__demo__write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const disabled = ((startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>)["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "demo_write")).toBe(true);
    expect(vibeDisabledMatches(disabled, "demo_write_ba51f2af")).toBe(false);
    await Effect.runPromise(driver.stopSession("th-exact"));
  });

  it("routes a server whose excluded tools case-fold together through the gateway rather than hiding one", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    await Effect.runPromise(driver.startSession({
      threadId: "th-casefold",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "Demo", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }, { name: "extra", type: "http", url: "http://127.0.0.1:9997/mcp", headers: {} }],
      disabledMcpTools: ["mcp__Demo__read", "mcp__Demo__READ"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    // Demo's tools are enforced through the gateway (the whole server routes
    // there); the bystander keeps a nonempty override — the gateway entry is
    // always offered, so the empty-override refusal cannot be triggered here.
    expect((agentCfg["mcpServers"] as Array<{ name: string }>).map((s) => s.name))
      .toEqual(["extra", expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    const disabled = agentCfg["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "Demo_READ")).toBe(false);
    // The withheld-server notice rides the first send, so a turn subscriber
    // that attached after session/start still sees it.
    await Effect.runPromise(driver.sendTurn({ threadId: "th-casefold", prompt: "go" }));
    expect(events.some((e) => e.type === "session.notice" && e.notice === "mcp")).toBe(true);
    await Effect.runPromise(driver.stopSession("th-casefold"));
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  it("routes both servers a flattened ambiguous exclusion key implicates through the gateway", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-flat",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "demo", type: "http", url: "http://127.0.0.1:9998/mcp", headers: {} },
        { name: "demo__x", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} },
        { name: "extra", type: "http", url: "http://127.0.0.1:9997/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__demo__x__read"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    expect((agentCfg["mcpServers"] as Array<{ name: string }>).map((s) => s.name))
      .toEqual(["extra", expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    await Effect.runPromise(driver.stopSession("th-flat"));
  });

  it("routes the server an alias-colliding exclusion names through the gateway and leaves Vibe's disambiguation alone for the rest", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-aliascollide",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "foo-bar", type: "http", url: "http://127.0.0.1:9998/mcp", headers: {} },
        { name: "foo_bar", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__foo-bar__write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    // `foo-bar` holds the excluded tool and cannot be scoped: only it routes
    // through the lazy gateway. `foo_bar` carries no exclusion, so Vibe's own
    // digest disambiguation of its tool names is left untouched.
    expect((agentCfg["mcpServers"] as Array<{ name: string }>).map((s) => s.name))
      .toEqual(["foo_bar", expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    const disabled = agentCfg["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "foo_bar_write_f4180191")).toBe(false);
    await Effect.runPromise(driver.stopSession("th-aliascollide"));
  });
});

/**
 * A faithful JS port of Vibe 3.1.4's `_display_names` (`_mcp_naming.py`):
 * candidate = `_normalize_identifier(f"{server}_{tool}")`; a raw candidate
 * that is already an identifier and has one owner keeps the raw form, a
 * unique candidate takes the normalized form, and every owner of a shared
 * candidate gets `_<sha256(server + "\\0" + tool)[:8]>` appended (lengthened
 * on further collision). Read from `mistral-vibe==3.1.4`, read-only.
 */
function vibeDisplayNames(servers: ReadonlyArray<{ name: string; tools: readonly string[] }>): Map<string, string> {
  const normalize = (value: string): string => {
    let out = [...value].map((ch) => (/[A-Za-z0-9_$]/.test(ch) ? ch : "_")).join("") || "_";
    if (/^[0-9]/.test(out)) out = `_${out}`;
    return out;
  };
  const isIdentifier = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
  const identities: Array<{ readonly server: string; readonly tool: string }> = [];
  for (const server of servers) {
    for (const tool of server.tools) identities.push({ server: server.name, tool });
  }
  const owners = new Map<string, number>();
  for (const { server, tool } of identities) {
    const candidate = normalize(`${server}_${tool}`);
    owners.set(candidate, (owners.get(candidate) ?? 0) + 1);
  }
  const sorted = [...identities].sort((a, b) => {
    if (a.server !== b.server) return a.server < b.server ? -1 : 1;
    if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
    return 0;
  });
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const { server, tool } of sorted) {
    const key = `${server}\u0000${tool}`;
    const base = `${server}_${tool}`;
    const candidate = normalize(base);
    if (isIdentifier(base) && owners.get(candidate) === 1) {
      result.set(key, base);
      used.add(base);
    } else if (owners.get(candidate) === 1 && !used.has(candidate)) {
      result.set(key, candidate);
      used.add(candidate);
    } else {
      const digest = createHash("sha256").update(`${server}\u0000${tool}`, "utf8").digest("hex");
      for (let length = 8; ; length += 1) {
        const name = `${candidate}_${digest.slice(0, length)}`;
        if (!used.has(name)) {
          result.set(key, name);
          used.add(name);
          break;
        }
      }
    }
  }
  return result;
}

/** An in-process server spec: Vibe gets its `fallback` endpoint, Moxen knows its tool list. */
function inProcessServer(name: string, tools: readonly string[]): McpServerSpec {
  return {
    name,
    type: "in-process",
    tools: tools.map((tool) => ({ name: tool, description: tool, inputSchema: { type: "object", properties: {} } })),
    call: async () => ({ text: "", isError: false }),
    fallback: { name, type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VibeDriver round-4 regressions", () => {
  /** A session whose server tracks the live approval policy and records the policy every turn/start ran under. */
  function policyServer(holdUpgrade?: { register: (release: () => void) => void }): {
    readonly server: FakeVibeServer;
    readonly startPolicies: string[];
  } {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const startPolicies: string[] = [];
    let currentPolicy = "ask";
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, async (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      if (policy === "auto-approve" && holdUpgrade !== undefined) {
        await new Promise<void>((resolve) => { holdUpgrade.register(resolve); });
      }
      // The live adapter applies the approval change before anything is parked.
      currentPolicy = policy;
      return { runtime: { approvalPolicy: policy }, status: "applied" };
    });
    server.on(VIBE_METHODS.turnStart, () => {
      startPolicies.push(currentPolicy);
      return { turn: { id: `t${startPolicies.length}`, inputEntryId: `u${startPolicies.length}`, status: "in_progress" } };
    });
    return { server, startPolicies };
  }

  it("starts a queued full-access turn only under a newer narrowed selection once its upgrade ack lands", async () => {
    let releaseUpgrade: () => void = () => {};
    const { server, startPolicies } = policyServer({ register: (release) => { releaseUpgrade = release; } });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-supersede", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    const sending = Effect.runPromise(driver.sendTurn({ threadId: "th-supersede", prompt: "Heavy", runtimeMode: "full-access" }));
    await sleep(30); // the upgrade write is in flight and parked on the gate
    driver.setRuntimeMode("th-supersede", "approval-required"); // newer, narrower selection
    releaseUpgrade();

    await sending; // accepted, but never under auto-approve: the recheck re-writes to the narrower policy
    expect(startPolicies).toEqual(["ask"]);
    await Effect.runPromise(driver.stopSession("th-supersede"));
  });

  it("does not let a queued mode-less send start under a wide policy the newer selection overtook", async () => {
    let releaseUpgrade: () => void = () => {};
    const { server, startPolicies } = policyServer({ register: (release) => { releaseUpgrade = release; } });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-narrow", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    driver.setRuntimeMode("th-narrow", "full-access"); // wide setter queued, ack parked
    await sleep(20);
    const sending = Effect.runPromise(driver.sendTurn({ threadId: "th-narrow", prompt: "Queued" })); // mode-less, captures full-access
    await sleep(20);
    driver.setRuntimeMode("th-narrow", "approval-required"); // narrow setter overtakes it
    releaseUpgrade();

    await sending;
    expect(startPolicies).toEqual(["ask"]);
    await Effect.runPromise(driver.stopSession("th-narrow"));
  });

  it("re-establishes the policy with a fresh write after a pending response instead of trusting the cached ack", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let currentPolicy = "ask";
    // Vibe 3.1.4 applies the live approval change BEFORE parking the rest of
    // the configuration, then answers `pending`: the previous approval policy
    // is NOT still in effect, so the session's cached acknowledgement goes.
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      currentPolicy = policy;
      if (policy === "auto-approve") return { runtime: { approvalPolicy: policy }, status: "pending" };
      return { runtime: { approvalPolicy: policy }, status: "applied" };
    });
    const startPolicies: string[] = [];
    server.on(VIBE_METHODS.turnStart, () => {
      startPolicies.push(currentPolicy);
      return { turn: { id: `t${startPolicies.length}`, inputEntryId: `u${startPolicies.length}`, status: "in_progress" } };
    });

    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-pending2", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    const first = await Effect.runPromise(driver.sendTurn({ threadId: "th-pending2", prompt: "First" }));
    driver.setRuntimeMode("th-pending2", "full-access"); // applied live on the server, answered `pending`
    await sleep(20);
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    await driver.awaitTurn("th-pending2", first.turnId);

    // The next turn must not take the stale `ask` shortcut: the write goes
    // out again and the turn only starts under the freshly acknowledged ask.
    await Effect.runPromise(driver.sendTurn({ threadId: "th-pending2", prompt: "Second", runtimeMode: "approval-required" }));
    expect(startPolicies).toEqual(["ask", "ask"]);
    const writes = server.received.filter((r) => r.method === VIBE_METHODS.sessionApprovalPolicyUpdate);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    await Effect.runPromise(driver.stopSession("th-pending2"));
  });

  it("routes a server whose excluded tool Moxen cannot prove un-suffixed through the gateway (real name collision)", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-collide-tool",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "demo", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }, { name: "extra", type: "http", url: "http://127.0.0.1:9997/mcp", headers: {} }],
      // A real server offering both spellings: Vibe digest-suffixes BOTH
      // display names, and no unsuffixed pattern can match either. Moxen
      // cannot see the sibling, so the server routes through the lazy gateway
      // (where the exclusion is enforced whatever it publishes).
      disabledMcpTools: ["mcp__demo__write-file"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    expect((agentCfg["mcpServers"] as Array<{ name: string }>).map((s) => s.name))
      .toEqual(["extra", expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    await Effect.runPromise(driver.stopSession("th-collide-tool"));
  });

  it("enforces an exclusion whose display name is digest-suffixed when the tool list is known", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-collide-known",
      workingDirectory: "/tmp/repo",
      mcpServers: [inProcessServer("demo", ["write-file", "write_file", "read"])],
      disabledMcpTools: ["mcp__demo__write-file"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    expect((agentCfg["mcpServers"] as unknown[]).length).toBe(1);
    const disabled = agentCfg["disabledTools"] as string[];
    const names = vibeDisplayNames([{ name: "demo", tools: ["write-file", "write_file", "read"] }]);
    const target = names.get("demo\u0000write-file")!;
    const sibling = names.get("demo\u0000write_file")!;
    expect(target).toMatch(/^[A-Za-z0-9_$]+_[0-9a-f]{8,}$/); // digest-suffixed, like Vibe publishes it
    expect(target).not.toBe(sibling); // both suffixed, differently
    expect(vibeDisabledMatches(disabled, target)).toBe(true);
    expect(vibeDisabledMatches(disabled, sibling)).toBe(false);
    expect(vibeDisabledMatches(disabled, "demo_read")).toBe(false);
    await Effect.runPromise(driver.stopSession("th-collide-known"));
  });

  it("withholds a known-tool-list server whose exclusion would co-hide a case-fold sibling", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-case-sibling",
      workingDirectory: "/tmp/repo",
      mcpServers: [inProcessServer("demo", ["write", "WRITE", "read"]), inProcessServer("extra", ["read"])],
      disabledMcpTools: ["mcp__demo__write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    // `re:demo_write` matches `demo_WRITE` case-insensitively; WRITE is not
    // excluded, so the whole server is withheld rather than over-hidden while
    // the bystander keeps a nonempty override.
    expect((agentCfg["mcpServers"] as Array<{ name: string }>).map((s) => s.name)).toEqual(["extra"]);
    expect((agentCfg["disabledTools"] as string[]).some((p) => p.startsWith("re:demo_write"))).toBe(false);
    await Effect.runPromise(driver.stopSession("th-case-sibling"));
  });

  it("forwards alias-colliding servers untouched when no exclusion targets them", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-aliasclean",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "foo-bar", type: "http", url: "http://127.0.0.1:9998/mcp", headers: {} },
        { name: "foo_bar", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} },
      ],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    expect((agentCfg["mcpServers"] as unknown[]).map((s) => (s as { name: string }).name)).toEqual(["foo-bar", "foo_bar"]);
    await Effect.runPromise(driver.stopSession("th-aliasclean"));
  });

  it("delivers startup MCP-offer notices to a turn subscriber that attaches after session startup", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });

    // The real send path: a global usage subscriber exists from before the
    // session starts; the turn's thread subscriber attaches only when the
    // turn runner wires it, AFTER session/start — `execute.ts` order.
    const globalEvents: ProviderRuntimeEvent[] = [];
    const unsubscribeGlobal = subscribeDriverUsage(driver, (event) => { globalEvents.push(event); });
    await Effect.runPromise(driver.startSession({
      threadId: "th-noticelate",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "demo", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }, { name: "extra", type: "http", url: "http://127.0.0.1:9997/mcp", headers: {} }],
      disabledMcpTools: ["mcp__demo__write-file"],
    }));
    const threadEvents: ProviderRuntimeEvent[] = [];
    const unsubscribeThread = subscribeDriverThread(driver, "th-noticelate", (event) => { threadEvents.push(event); });

    await Effect.runPromise(driver.sendTurn({ threadId: "th-noticelate", prompt: "go" }));
    expect(globalEvents.some((e) => e.type === "session.notice" && e.notice === "mcp" && e.title === "MCP servers not offered")).toBe(true);
    expect(threadEvents.some((e) => e.type === "session.notice" && e.notice === "mcp" && e.title === "MCP servers not offered")).toBe(true);

    unsubscribeGlobal();
    unsubscribeThread();
    await Effect.runPromise(driver.stopSession("th-noticelate"));
  });

  it("keeps an accepted turn running when its deferred interrupt fails", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let releaseStart!: (value: unknown) => void;
    server.on(VIBE_METHODS.turnStart, () => new Promise((resolve) => { releaseStart = resolve; }));
    server.on(VIBE_METHODS.turnInterrupt, () => {
      throw new Error("interrupt refused");
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    await Effect.runPromise(driver.startSession({ threadId: "th-deferint", workingDirectory: "/tmp/repo" }));

    const sending = Effect.runPromise(driver.sendTurn({ threadId: "th-deferint", prompt: "Work" }));
    await sleep(20); // turn/start in flight
    await Effect.runPromise(driver.interruptTurn("th-deferint")); // recorded while the id is still binding
    releaseStart({ turn: { id: "t-accepted", inputEntryId: "u1", status: "in_progress" } });

    // The server ACCEPTED the turn: its start must not be misreported as failed.
    const sent = await sending;
    expect(sent.turnId).toBeTruthy();
    expect(server.closed).toBe(false);
    expect(await Effect.runPromise(driver.hasSession("th-deferint"))).toBe(true);
    expect(events.some((e) => e.type === "session.notice" && e.notice === "interrupt-failed")).toBe(true);

    // Completion tracking still works: the server settles the turn normally.
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t-accepted", status: "completed" } });
    expect((await driver.awaitTurn("th-deferint", sent.turnId)).status).toBe("completed");
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopSession("th-deferint"));
  });

  it("routes an earlier turn's completion by server turn id even when a later send is queued", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    let releaseUpgrade!: () => void;
    const upgradeGate = new Promise<void>((resolve) => { releaseUpgrade = resolve; });
    let turns = 0;
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, async (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      if (policy === "auto-approve") await upgradeGate;
      return { runtime: { approvalPolicy: policy }, status: "applied" };
    });
    server.on(VIBE_METHODS.turnStart, () => {
      turns += 1;
      return { turn: { id: turns === 1 ? "tA" : "tB", inputEntryId: `u${turns}`, status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-strand", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    const a = await Effect.runPromise(driver.sendTurn({ threadId: "th-strand", prompt: "A" }));
    const awaitingA = driver.awaitTurn("th-strand", a.turnId);
    // Queue B: its policy write parks on the gate, so B stays queued.
    const sendingB = Effect.runPromise(driver.sendTurn({ threadId: "th-strand", prompt: "B", runtimeMode: "full-access" }));
    await sleep(30);
    // A completes while B is still queued behind its policy write.
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "tA", status: "completed" } });

    // The buffered completion must not be discarded when B binds: A settles.
    const outcomeA = await Promise.race([
      awaitingA,
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcomeA).toMatchObject({ status: "completed" });
    releaseUpgrade();
    const b = await sendingB;
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "tB", status: "completed" } });
    expect((await driver.awaitTurn("th-strand", b.turnId)).status).toBe("completed");
    await Effect.runPromise(driver.stopSession("th-strand"));
  });
});

describe("VibeDriver round-5 regressions", () => {
  it("recomputes deny patterns after a drop so a retained server's exclusion still matches its published name", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-replan",
      workingDirectory: "/tmp/repo",
      mcpServers: [inProcessServer("a-b", ["lock", "LOCK", "write"]), inProcessServer("a_b", ["write"])],
      disabledMcpTools: ["mcp__a-b__lock", "mcp__a_b__write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    // a-b is withheld (its excluded `lock` cannot be separated from `LOCK`);
    // with a-b gone, a_b's `write` collision suffix disappears, so the deny
    // must be recomputed against the retained catalog or the tool stays
    // callable.
    expect((agentCfg["mcpServers"] as unknown[]).map((s) => (s as { name: string }).name)).toEqual(["a_b"]);
    const disabled = agentCfg["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "a_b_write")).toBe(true);
    expect(disabled.some((p) => p.startsWith("re:a_b_write_"))).toBe(false);
    await Effect.runPromise(driver.stopSession("th-replan"));
  });

  it("skips a queued superseded mode setter instead of widening a live turn", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const applied: string[] = [];
    let releaseUpgrade: () => void = () => {};
    let gatedWrites = 0;
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, async (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      // Only the admission's own upgrade write is parked; a later one answers at once.
      if (policy === "auto-approve" && gatedWrites++ === 0) {
        await new Promise<void>((resolve) => { releaseUpgrade = resolve; });
      }
      applied.push(policy);
      return { runtime: { approvalPolicy: policy }, status: "applied" };
    });
    const startPolicies: string[] = [];
    let currentPolicy = "ask";
    server.on(VIBE_METHODS.turnStart, () => {
      startPolicies.push(currentPolicy);
      return { turn: { id: `t${startPolicies.length}`, inputEntryId: `u${startPolicies.length}`, status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-superskip", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    // A blocks the admission chain on its own gated write.
    const sending = Effect.runPromise(driver.sendTurn({ threadId: "th-superskip", prompt: "A", runtimeMode: "full-access" }));
    await sleep(20);
    driver.setRuntimeMode("th-superskip", "full-access"); // queued setter 1, not yet started
    await sleep(10);
    driver.setRuntimeMode("th-superskip", "approval-required"); // newer selection supersedes it
    releaseUpgrade();

    const sent = await sending; // the admission rechecks and starts under the narrowed selection
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    await driver.awaitTurn("th-superskip", sent.turnId);
    await sleep(30); // let the queued setters drain
    expect(startPolicies).toEqual(["ask"]);
    // The superseded setter must never issue its widening RPC.
    expect(applied).toEqual(["auto-approve", "ask"]);
    await Effect.runPromise(driver.stopSession("th-superskip"));
  });

  it("defers a widening mode write until no turn is running", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const applied: string[] = [];
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      applied.push(policy);
      return { runtime: { approvalPolicy: policy }, status: "applied" };
    });
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-deferwiden", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    const a = await Effect.runPromise(driver.sendTurn({ threadId: "th-deferwiden", prompt: "A" }));
    driver.setRuntimeMode("th-deferwiden", "full-access"); // widening write while A runs
    await sleep(30);
    // Vibe applies a policy write to the running turn live: a widening one
    // must wait for the turn to end.
    expect(applied).toEqual([]);
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    await driver.awaitTurn("th-deferwiden", a.turnId);
    // When the session is idle again, the latest selection is applied.
    for (let i = 0; i < 20 && !applied.includes("auto-approve"); i += 1) await sleep(20);
    expect(applied).toEqual(["auto-approve"]);
    await Effect.runPromise(driver.stopSession("th-deferwiden"));
  });

  it("clamps local approval gating to the tightened selection even when the wire write answers pending", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const callbackResults: unknown[] = [];
    server.on(VIBE_METHODS.callbackResult, (params) => {
      callbackResults.push(params);
      return { accepted: true };
    });
    // The tightening write is applied live on the server (the running turn
    // starts to ask) and only then answered `pending`.
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      return { runtime: { approvalPolicy: policy }, status: "pending" };
    });
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    await Effect.runPromise(driver.startSession({ threadId: "th-clamp", workingDirectory: "/tmp/repo", runtimeMode: "full-access" }));

    await Effect.runPromise(driver.sendTurn({ threadId: "th-clamp", prompt: "A" }));
    driver.setRuntimeMode("th-clamp", "approval-required"); // narrowed; live-applied, answered pending
    await sleep(20);
    // The server now asks: a file write reaches Moxen's callback.
    await server.sendRequest(VIBE_METHODS.callbackCall, {
      callback: {
        callbackId: "cb-tight",
        detail: {
          kind: "approval",
          effect: { kind: "file_write", toolName: "write_file", input: { filePath: "/tmp/repo/x.ts", content: "x" } },
        },
      },
    });
    await sleep(20);
    // The local gate must be no wider than the tightened selection, so the
    // call parks for the user instead of being auto-approved.
    expect(callbackResults).toEqual([]);
    expect(events.some((e) => e.type === "permission.request.opened")).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopSession("th-clamp"));
  });
});

describe("VibeDriver round-6 regressions", () => {
  it("refuses to start when every offered MCP server would be withheld and an exclusion exists", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const exit = await Effect.runPromiseExit(driver.startSession({
      threadId: "th-unsatisfiable",
      workingDirectory: "/tmp/repo",
      moxenTools: undefined,
      // Both servers must be withheld: a-b cannot separate lock/LOCK, and
      // withheld a-b unsuffixes a_b/write whose own WRITE sibling cannot be
      // separated either. An empty override is no deny on Vibe 3.1.4 — the
      // native configuration (with its own a-b copy exposing lock) would come
      // back — so startup must refuse.
      mcpServers: [inProcessServer("a-b", ["lock", "LOCK", "write"]), inProcessServer("a_b", ["write", "WRITE"])],
      disabledMcpTools: ["mcp__a-b__lock", "mcp__a_b__write"],
    } as never));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause as { failure?: CliError; reasons?: ReadonlyArray<{ error?: CliError }> };
      const failure = cause.failure ?? cause.reasons?.[0]?.error;
      expect(failure?.code).toBe("VIBE_MCP_EXCLUSION_UNENFORCEABLE");
      expect(failure?.message).toMatch(/mcp__a-b__lock/);
      expect(failure?.message).toMatch(/native MCP configuration/);
      expect(failure?.message).toMatch(/Remove the exclusion/);
    }
    // Fail fast: no session was opened on the peer.
    expect(server.received.some((r) => r.method === VIBE_METHODS.sessionStart)).toBe(false);
    expect(await Effect.runPromise(driver.hasSession("th-unsatisfiable"))).toBe(false);
  });

  it("replays only a deferred widening on turn completion, never a tightening or a plain selection", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const applied: string[] = [];
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      applied.push(policy);
      // The first write (the tightening) is live-applied and answered pending;
      // anything later is recorded and applied, so a retried write is visible.
      return { runtime: { approvalPolicy: policy }, status: applied.length === 1 ? "pending" : "applied" };
    });
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({ threadId: "th-hookenv", workingDirectory: "/tmp/repo", runtimeMode: "full-access" }));

    await Effect.runPromise(driver.sendTurn({ threadId: "th-hookenv", prompt: "A" }));
    driver.setRuntimeMode("th-hookenv", "approval-required"); // narrowed; live-applied, answered pending
    await sleep(30);
    // The narrowing write went out once; record that.
    expect(applied).toEqual(["ask"]);
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    await sleep(30);
    // Nothing was deferred (the tightening was not), so the hook writes
    // nothing further and the session stays open.
    expect(applied).toEqual(["ask"]);

    // An explicit send still works and issues exactly the write it needs.
    await Effect.runPromise(driver.sendTurn({ threadId: "th-hookenv", prompt: "B", runtimeMode: "full-access" }));
    await sleep(20);
    expect(applied).toEqual(["ask", "auto-approve"]);
    expect(await Effect.runPromise(driver.hasSession("th-hookenv"))).toBe(true);
    await Effect.runPromise(driver.stopSession("th-hookenv"));
  });

  it("resolves internal tool conflicts first and drops the same set regardless of input order", async () => {
    const probe = async (
      threadId: string,
      servers: readonly McpServerSpec[],
      disabled: readonly string[],
    ): Promise<{ readonly offered: readonly string[]; readonly patterns: readonly string[] }> => {
      const server = new FakeVibeServer();
      setupDefaultServer(server);
      const driver = new VibeDriver({ transport: makeTransport([server]) });
      await Effect.runPromise(driver.startSession({ threadId, workingDirectory: "/tmp/repo", mcpServers: [...servers], disabledMcpTools: [...disabled] }));
      const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
      const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
      const offered = (agentCfg["mcpServers"] as Array<{ name: string }> | undefined)?.map((s) => s.name) ?? [];
      const disabledList = agentCfg["disabledTools"] as string[];
      const patterns = disabledList.filter((p) => p.startsWith("re:")).sort();
      await Effect.runPromise(driver.stopSession(threadId));
      return { offered, patterns };
    };
    const specA = (name: string, tools: readonly string[]): McpServerSpec => inProcessServer(name, tools);
    const exclusion = (server: string, tool: string): string => `mcp__${server}__${tool}`;

    // Probe 1: A[l] vs A[L] is an internal conflict; a[y] collides only with A's Y.
    const first = await probe("th-order1", [specA("A", ["x", "l", "L", "Y"]), specA("a", ["X", "y"])], [exclusion("a", "y"), exclusion("A", "x"), exclusion("A", "l")]);
    const firstShuffled = await probe("th-order1s", [specA("a", ["X", "y"]), specA("A", ["x", "l", "L", "Y"])], [exclusion("A", "l"), exclusion("a", "y"), exclusion("A", "x")]);
    expect(first).toEqual({ offered: ["a"], patterns: ["re:a_y"] });
    expect(firstShuffled).toEqual(first);

    // Probe 2: no l/L pair, but the external a/X can shadow A's internal X conflict.
    const second = await probe("th-order2", [specA("A", ["x", "X", "Y"]), specA("a", ["X", "y"])], [exclusion("a", "y"), exclusion("A", "x")]);
    const secondShuffled = await probe("th-order2s", [specA("a", ["X", "y"]), specA("A", ["x", "X", "Y"])], [exclusion("A", "x"), exclusion("a", "y")]);
    expect(second).toEqual({ offered: ["a"], patterns: ["re:a_y"] });
    expect(secondShuffled).toEqual(second);
  });
});

describe("VibeDriver round-8 regressions", () => {
  it("drops a deferred widening superseded by a HIGHER selection instead of replaying the stale write", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const writes: string[] = [];
    server.on(VIBE_METHODS.sessionApprovalPolicyUpdate, (params) => {
      const policy = (params as Record<string, unknown>)["approvalPolicy"] as string;
      writes.push(policy);
      // Only the obsolete accept-edits write must never be answered: if the
      // completion-time replay wrongly sends it, it hangs, times out, and
      // invalidates the session.
      if (policy === "accept-edits") return new Promise(() => {});
      return { runtime: { approvalPolicy: policy }, status: "applied" };
    });
    server.on(VIBE_METHODS.turnStart, () => ({ turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } }));
    const driver = new VibeDriver({ transport: makeTransport([server]), requestTimeoutMs: 80 });
    await Effect.runPromise(driver.startSession({ threadId: "th-staleset", workingDirectory: "/tmp/repo", runtimeMode: "approval-required" }));

    await Effect.runPromise(driver.sendTurn({ threadId: "th-staleset", prompt: "A" }));
    driver.setRuntimeMode("th-staleset", "auto-accept-edits"); // widens; deferred while A runs
    await sleep(30);
    expect(writes).toEqual([]); // deferred, nothing on the wire yet
    server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
    // Supersedes the deferral with a HIGHER selection before the replay runs:
    // replaying the stale accept-edits would be a write nobody selected, and
    // a timeout on it would close the session.
    driver.setRuntimeMode("th-staleset", "full-access");
    await sleep(40);
    // Exactly the latest selection's write went out; the obsolete accept-edits
    // replay never hit the wire, so the session is still open.
    expect(writes).toEqual(["auto-approve"]);
    expect(await Effect.runPromise(driver.hasSession("th-staleset"))).toBe(true);
    await Effect.runPromise(driver.stopSession("th-staleset"));
  });
});

describe("vibe catalog launcher diagnostics", () => {
  it("surfaces an actionable status for an unsupported batch wrapper", async () => {
    forgetVibeCatalogCache();
    const transport: VibeTransport = {
      startPeer: () => { throw new CliError("VIBE_UNSUPPORTED_LAUNCHER", "batch wrapper"); },
    };
    const summary = await vibeProvider({ binaryPath: "vibe-app-server" }, process.env, "/tmp/repo", transport);
    expect(summary.status).toMatch(/batch wrapper|real executable/i);
    expect(summary.status).not.toMatch(/check `vibe` login/i);
  });

  it("surfaces an actionable status for a drive-relative executable path", async () => {
    forgetVibeCatalogCache();
    const transport: VibeTransport = {
      startPeer: () => { throw new CliError("VIBE_INVALID_BINARY_PATH", "drive-relative"); },
    };
    const summary = await vibeProvider({ binaryPath: "vibe-app-server" }, process.env, "/tmp/repo", transport);
    expect(summary.status).toMatch(/drive-relative|absolute path/i);
    expect(summary.status).not.toMatch(/check `vibe` login/i);
  });
});

/** A stub upstream MCP connection for gateway tests (LOCAL-032). */
function stubUpstreamServers(
  serverTools: Record<string, readonly string[]>,
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }>,
  connects: string[] = [],
): ConnectMcp {
  return async (spec) => {
    connects.push(spec.name);
    const tools = (serverTools[spec.name] ?? []).map((name) => ({
      name,
      description: `Tool ${name} on ${spec.name}.`,
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    }));
    return {
      get alive() {
        return true;
      },
      get closed() {
        return false;
      },
      tools,
      dropped: 0,
      async call(tool: string, args: Record<string, unknown>) {
        calls.push({ server: spec.name, tool, args });
        return { text: `ok:${spec.name}:${tool}`, isError: false };
      },
      async close() {},
    } as unknown as McpClient;
  };
}

describe("VibeDriver lazy MCP gateway (LOCAL-032)", () => {
  /** The effective-config fixture Vibe's `config/effective/read` answers with. */
  function effectiveConfigFixture(): Record<string, unknown> {
    return {
      config: {
        mcp_servers: [
          {
            name: "exa",
            transport: "streamable-http",
            url: "https://mcp.exa.invalid/mcp",
            auth: { type: "static", headers: { "x-api-key": "<redacted>" } },
            disabled: false,
            disabled_tools: ["crawling"],
          },
        ],
        disabled_tools: ["exa_nativeoff_tool"],
        enabled_tools: [],
      },
    };
  }

  function setupGatewaySession(server: FakeVibeServer, effectiveConfig: Record<string, unknown> | null): void {
    setupDefaultServer(server);
    server.on(VIBE_METHODS.configEffectiveRead, () => {
      if (effectiveConfig === null) throw new Error("effective config unreadable");
      return effectiveConfig;
    });
  }

  interface GatewaySpec {
    readonly name: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }

  async function offeredServers(server: FakeVibeServer): Promise<Array<Record<string, unknown>>> {
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    return (agentCfg["mcpServers"] ?? []) as Array<Record<string, unknown>>;
  }

  async function gatewaySpec(server: FakeVibeServer): Promise<GatewaySpec> {
    const offered = await offeredServers(server);
    const gw = offered.find((entry) => /^moxen-mcp-[0-9a-f]+$/.test(String(entry["name"])));
    if (!gw) throw new Error("no lazy MCP gateway offered to the session");
    return {
      name: String(gw["name"]),
      url: String(gw["url"]),
      headers: (gw["headers"] ?? {}) as Record<string, string>,
    };
  }

  async function gatewayRpc<T>(gw: GatewaySpec, tool: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(gw.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...gw.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const body = (await res.json()) as { result: T };
    return body.result;
  }

  const callToolViaGateway = (gw: GatewaySpec, server: string, tool: string, args: Record<string, unknown> = {}) =>
    gatewayRpc<{ content: Array<{ text: string }>; isError: boolean }>(gw, "call_tool", { server, tool, arguments: args });

  it("routes external servers with excluded tools through the loopback gateway, hiding Moxen's exclusions and Vibe's own restrictions there", async () => {
    const server = new FakeVibeServer();
    setupGatewaySession(server, effectiveConfigFixture());
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const connects: string[] = [];
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers(
        { exa: ["agent_run", "web_search_exa", "crawling", "nativeoff_tool"] },
        calls,
        connects,
      ),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-route",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} }],
      disabledMcpTools: ["mcp__exa__agent_run"],
    }));

    // exa is not offered directly; the gateway is the only MCP entry, and the
    // effective config was read through the session before startup returned.
    const offered = await offeredServers(server);
    expect(offered.map((entry) => String(entry["name"]))).toEqual([expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    const effectiveRead = server.received.find((r) => r.method === VIBE_METHODS.configEffectiveRead);
    expect(effectiveRead?.params).toMatchObject({ sessionId: "vibe-sess-1" });

    const gw = await gatewaySpec(server);
    // A Moxen exclusion is neither listed nor callable.
    const catalog = await gatewayRpc<{ content: Array<{ text: string }>; isError: boolean }>(gw, "search_tools", { server: "exa" });
    expect(catalog.isError).toBe(false);
    expect(catalog.content[0]!.text).toContain("web_search_exa");
    expect(catalog.content[0]!.text).not.toContain("agent_run");
    expect(catalog.content[0]!.text).not.toContain("crawling");
    expect(catalog.content[0]!.text).not.toContain("nativeoff_tool");

    const moxenDenied = await callToolViaGateway(gw, "exa", "agent_run");
    expect(moxenDenied.isError).toBe(true);
    expect(moxenDenied.content[0]!.text).toContain("disabled");
    // Vibe's own per-server disabled_tools and global disabled_tools stay off.
    const nativeDenied = await callToolViaGateway(gw, "exa", "crawling");
    expect(nativeDenied.isError).toBe(true);
    const globallyDenied = await callToolViaGateway(gw, "exa", "nativeoff_tool");
    expect(globallyDenied.isError).toBe(true);
    // An allowed tool reaches the real server with its real arguments.
    const allowed = await callToolViaGateway(gw, "exa", "web_search_exa", { query: "moxen" });
    expect(allowed.isError).toBe(false);
    expect(allowed.content[0]!.text).toBe("ok:exa:web_search_exa");
    expect(connects).toEqual(["exa"]);
    expect(calls).toEqual([{ server: "exa", tool: "web_search_exa", args: { query: "moxen" } }]);

    await Effect.runPromise(driver.stopSession("th-gw-route"));
  });

  it("fails closed when Vibe's effective configuration cannot be read, and says so with the first turn", async () => {
    const server = new FakeVibeServer();
    setupGatewaySession(server, null);
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers({ exa: ["web_search_exa"] }, []),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-locked",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} }],
      disabledMcpTools: ["mcp__exa__agent_run"],
    }));

    const gw = await gatewaySpec(server);
    const refused = await callToolViaGateway(gw, "exa", "web_search_exa");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("not serving tools");

    // The session explanation rides the first turn's notices.
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    server.on(VIBE_METHODS.turnStart, () => {
      setTimeout(() => {
        server.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "Done" }], generationStatus: "completed" },
        });
        server.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "t1", status: "completed" } });
      }, 10);
      return { turn: { id: "t1", inputEntryId: "u1", status: "in_progress" } };
    });
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "th-gw-locked", prompt: "Search" }));
    await driver.awaitTurn("th-gw-locked", turnId);
    const notices = events.filter((e) => e.type === "session.notice" && e.notice === "mcp") as
      Array<Extract<ProviderRuntimeEvent, { type: "session.notice" }>>;
    const lockedNotice = notices.find((e) => e.detail?.includes("effective configuration could not be read"));
    expect(lockedNotice?.detail).toContain("exa");
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopSession("th-gw-locked"));
  });

  it("denies ambiguous exclusions under every parse through the gateway instead of withholding both servers", async () => {
    const server = new FakeVibeServer();
    setupGatewaySession(server, { config: { mcp_servers: [], disabled_tools: [], enabled_tools: [] } });
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers(
        { demo: ["x__read", "demo_plain"], "demo__x": ["read", "other"] },
        [],
      ),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-ambiguous",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "demo", type: "http", url: "https://mcp.demo.invalid/mcp", headers: {} },
        { name: "demo__x", type: "http", url: "https://mcp.demox.invalid/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__demo__x__read"],
    }));

    // Both implicated servers left the direct offer; the gateway carries them.
    const offered = await offeredServers(server);
    expect(offered.map((entry) => String(entry["name"]))).toEqual([expect.stringMatching(/^moxen-mcp-[0-9a-f]+$/)]);
    const gw = await gatewaySpec(server);
    // x__read under demo and read under demo__x are both denied...
    const firstParse = await callToolViaGateway(gw, "demo", "x__read");
    expect(firstParse.isError).toBe(true);
    const secondParse = await callToolViaGateway(gw, "demo__x", "read");
    expect(secondParse.isError).toBe(true);
    // ...while each server's other tools stay usable.
    const untouched = await callToolViaGateway(gw, "demo", "demo_plain");
    expect(untouched.isError).toBe(false);
    const untouched2 = await callToolViaGateway(gw, "demo__x", "other");
    expect(untouched2.isError).toBe(false);

    await Effect.runPromise(driver.stopSession("th-gw-ambiguous"));
  });

  it("resolves in-process exclusions by exact published name even while external excluded servers go through the gateway", async () => {
    const server = new FakeVibeServer();
    setupGatewaySession(server, { config: { mcp_servers: [], disabled_tools: [], enabled_tools: [] } });
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers({ exa: ["web_search_exa"] }, []),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-mixed",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        inProcessServer("docs", ["write", "read"]),
        { name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__docs__write", "mcp__exa__agent_run"],
    }));

    const offered = await offeredServers(server);
    const names = offered.map((entry) => String(entry["name"]));
    expect(names).toContain("docs");
    expect(names.some((name) => /^moxen-mcp-[0-9a-f]+$/.test(name))).toBe(true);
    expect(names).not.toContain("exa");
    const agentCfg = (server.received.find((r) => r.method === VIBE_METHODS.sessionStart)?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    const disabled = agentCfg["disabledTools"] as string[];
    expect(vibeDisabledMatches(disabled, "docs_write")).toBe(true);
    expect(vibeDisabledMatches(disabled, "docs_read")).toBe(false);

    await Effect.runPromise(driver.stopSession("th-gw-mixed"));
  });

  it("withholds the excluded server on an unverified Vibe version, without opening a gateway or reading the effective config", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.initialize, () => ({
      serverInfo: { name: "vibe-app-server", version: "9.9.9" },
      processId: 4242,
      platformCredentials: false,
    }));
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers({ exa: ["web_search_exa"] }, []),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-unknown-version",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} },
        { name: "extra", type: "http", url: "https://mcp.extra.invalid/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__exa__agent_run"],
    }));

    const offered = await offeredServers(server);
    expect(offered.map((entry) => String(entry["name"]))).toEqual(["extra"]);
    expect(server.received.some((r) => r.method === VIBE_METHODS.configEffectiveRead)).toBe(false);
    await Effect.runPromise(driver.stopSession("th-gw-unknown-version"));
  });

  it("still refuses to start when withholding every excluded server on an unverified Vibe version", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    server.on(VIBE_METHODS.initialize, () => ({
      serverInfo: { name: "vibe-app-server", version: "9.9.9" },
      processId: 4242,
      platformCredentials: false,
    }));
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    const exit = await Effect.runPromiseExit(driver.startSession({
      threadId: "th-gw-unknown-refusal",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} }],
      disabledMcpTools: ["mcp__exa__agent_run"],
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause as { failure?: CliError; reasons?: ReadonlyArray<{ error?: CliError }> };
      const failure = cause.failure ?? cause.reasons?.[0]?.error;
      expect(failure?.code).toBe("VIBE_MCP_EXCLUSION_UNENFORCEABLE");
    }
  });

  it("unwraps gateway approval callbacks under the real server and tool, and never grants call_tool for the session", async () => {
    const server = new FakeVibeServer();
    setupGatewaySession(server, { config: { mcp_servers: [], disabled_tools: [], enabled_tools: [] } });
    const callbackResults: unknown[] = [];
    server.on(VIBE_METHODS.callbackResult, (params) => {
      callbackResults.push(params);
      return { accepted: true };
    });
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers({ exa: ["web_search_exa"] }, []),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-approval",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} }],
      disabledMcpTools: ["mcp__exa__agent_run"],
    }));
    const gw = await gatewaySpec(server);

    // The model-visible name of the gateway's call_tool (Vibe display form).
    const visibleCallTool = gw.name.replace(/-/g, "_") + "_call_tool";
    const events: ProviderRuntimeEvent[] = [];
    const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (ev) => Effect.sync(() => { events.push(ev); })));
    const ack = await server.sendRequest(VIBE_METHODS.callbackCall, {
      callback: {
        callbackId: "cb-gw-1",
        detail: {
          kind: "approval",
          effect: { kind: "tool", toolName: visibleCallTool, input: { server: "exa", tool: "web_search_exa", arguments: { query: "moxen" } } },
        },
      },
    });
    expect(ack["result"]).toEqual({ callbackId: "cb-gw-1", accepted: true });
    await sleep(30);
    const open = events.find((e) => e.type === "permission.request.opened");
    expect(open && "raw" in open ? (open as { raw: Record<string, unknown> }).raw : null).toMatchObject({
      toolName: "mcp__exa__web_search_exa",
      input: { query: "moxen" },
    });
    // Granting "for the session" must not remember the gateway's call_tool
    // (Vibe remembers a provided tool's session grant for the WHOLE tool).
    await Effect.runPromise(driver.respondToRequest("th-gw-approval", "cb-gw-1", { kind: "acceptForSession" }));
    expect(callbackResults[0]).toMatchObject({
      result: { callbackId: "cb-gw-1", output: { type: "approval", decision: { type: "approve" } } },
    });
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(driver.stopSession("th-gw-approval"));
  });

  it("closes the gateway with the session", async () => {
    const server = new FakeVibeServer();
    setupGatewaySession(server, { config: { mcp_servers: [], disabled_tools: [], enabled_tools: [] } });
    const driver = new VibeDriver({
      transport: makeTransport([server]),
      connectMcp: stubUpstreamServers({ exa: ["web_search_exa"] }, []),
    });
    await Effect.runPromise(driver.startSession({
      threadId: "th-gw-close",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "exa", type: "http", url: "https://mcp.exa.invalid/mcp", headers: {} }],
      disabledMcpTools: ["mcp__exa__agent_run"],
    }));
    const gw = await gatewaySpec(server);
    await Effect.runPromise(driver.stopSession("th-gw-close"));
    await expect(fetch(gw.url, { method: "POST", headers: gw.headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }))
      .rejects.toThrow();
  });

  it("sends a deny-all disabledTools to /btw and probe sessions so native Vibe MCP servers stay routed off", async () => {
    // /btw fresh session (no cursor): nothing Vibe-side is routable.
    const btwServer = new FakeVibeServer();
    setupDefaultServer(btwServer);
    btwServer.on(VIBE_METHODS.turnStart, () => {
      setTimeout(() => {
        btwServer.sendNotification(VIBE_METHODS.historyEntryAdded, {
          entry: { id: "btw-a", type: "message", role: "assistant", content: [{ type: "text", text: "Side answer" }], generationStatus: "completed" },
        });
        btwServer.sendNotification(VIBE_METHODS.turnCompleted, { turn: { id: "btw-t", status: "completed" } });
      }, 10);
      return { turn: { id: "btw-t", inputEntryId: "u1", status: "in_progress" } };
    });
    const driver = new VibeDriver({ transport: makeTransport([btwServer]) });
    const side = await driver.sideQuestion({ cursor: null, workingDirectory: "/tmp/repo", question: "Quick one?" });
    expect(side.text).toBe("Side answer");
    const sideStart = btwServer.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const sideAgentCfg = (sideStart?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    expect(sideAgentCfg["disabledTools"]).toContain("re:.*");
    await Effect.runPromise(driver.stopSession("any"));

    // The idle budget probe: a zero-turn session with nothing routable either.
    const probeServer = new FakeVibeServer();
    setupDefaultServer(probeServer);
    const probeDriver = new VibeDriver({ transport: makeTransport([probeServer]) });
    await probeDriver.refreshUsage();
    const probeStart = probeServer.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const probeAgentCfg = (probeStart?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    expect(probeAgentCfg["disabledTools"]).toContain("re:.*");
  });
});

describe("vibe MCP gateway restriction parsing (LOCAL-032)", () => {
  it("reads Vibe's effective config into per-server and global restrictions, refusing shapes it cannot prove", async () => {
    const restrictions = parseVibeEffectiveConfig({
      config: {
        mcp_servers: [
          { name: "brave-search", disabled: false, disabled_tools: ["brave_llm_context", "brave_summarizer"] },
          { name: "off-server", disabled: true, disabled_tools: [] },
        ],
        disabled_tools: ["exa_agent_run"],
        enabled_tools: [],
      },
    });
    expect(restrictions).not.toBeNull();
    expect(restrictions?.allows("brave-search", "brave_llm_context")).toBe(false);
    expect(restrictions?.allows("brave-search", "brave_web_search")).toBe(true);
    expect(restrictions?.allows("off-server", "any_tool")).toBe(false);
    expect(restrictions?.allows("exa", "agent_run")).toBe(false); // global display-name pattern
    expect(restrictions?.allows("exa", "web_search_exa")).toBe(true);

    // Unreadable shapes fail closed to null so the caller locks the gateway.
    expect(parseVibeEffectiveConfig({ config: { mcp_servers: "nonsense" } })).toBeNull();
    expect(parseVibeEffectiveConfig(null)).toBeNull();
    expect(parseVibeEffectiveConfig({ config: { mcp_servers: [{ no_name: true }] } })).toBeNull();
  });

  it("matches global patterns against every display name Vibe can publish for the tool, including digest suffixed forms", async () => {
    // The digest Vibe appends on a display-name collision: sha256("exa\0agent_run")
    const digest = createHash("sha256").update("exa\u0000agent_run", "utf8").digest("hex");
    const suffixed = parseVibeEffectiveConfig({ config: { mcp_servers: [], disabled_tools: [`exa_agent_run_${digest.slice(0, 8)}`], enabled_tools: [] } });
    expect(suffixed?.allows("exa", "agent_run")).toBe(false);
    expect(suffixed?.allows("exa", "web_search_exa")).toBe(true);

    // An unparseable re: pattern denies (Vibe treats it as a match).
    const unparseable = parseVibeEffectiveConfig({ config: { mcp_servers: [], disabled_tools: ["re:("], enabled_tools: [] } });
    expect(unparseable?.allows("exa", "agent_run")).toBe(false);

    // Non-empty enabled patterns allow only what they name — everything else is denied.
    const enabled = parseVibeEffectiveConfig({ config: { mcp_servers: [], disabled_tools: [], enabled_tools: ["serena_*"] } });
    expect(enabled?.allows("serena", "read_file")).toBe(true);
    expect(enabled?.allows("exa", "web_search_exa")).toBe(false);
  });
});

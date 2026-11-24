import path from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { JsonRpcPeer, type SpawnedProcess } from "../../stdio.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { applyVibeJsonPatch, VIBE_METHODS } from "../protocol.js";
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
      mcpServers: [{ name: "demo", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }],
      disabledMcpTools: ["mcp__demo__write"],
    }));

    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const agentCfg = (startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>;
    const disabled = agentCfg["disabledTools"] as string[];
    expect(disabled).toContain("task");
    // Vibe (unified harness, v3.1.4) publishes MCP tools as `<server>_<tool>`
    // and filters disabledTools against that display name; a name collision
    // appends this identity's own `_<sha256 hex>` prefix (demo\0write ->
    // ba51f2af). The exclusion covers that form, but not an arbitrary hex-named
    // sibling (`demo_write_deadbeef`) or `demo_write_file`.
    expect(vibeDisabledMatches(disabled, "demo_write")).toBe(true);
    expect(vibeDisabledMatches(disabled, "demo_write_ba51f2af")).toBe(true);
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
        return { accepted: true };
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
      mcpServers: [{ name: "-demo_", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }],
      disabledMcpTools: ["mcp__-demo___write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const disabled = ((startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>)["disabledTools"] as string[];
    // Vibe strips leading/trailing `_`/`-` from the alias: published name is `demo_write`.
    expect(vibeDisabledMatches(disabled, "demo_write")).toBe(true);
    await Effect.runPromise(driver.stopSession("th-alias"));
  });

  it("excludes only the targeted server's colliding MCP tool, not its sibling or an arbitrary hex-named tool", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-collide",
      workingDirectory: "/tmp/repo",
      mcpServers: [
        { name: "foo-bar", type: "http", url: "http://127.0.0.1:9998/mcp", headers: {} },
        { name: "foo_bar", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} },
      ],
      disabledMcpTools: ["mcp__foo-bar__write"],
    }));
    const startCall = server.received.find((r) => r.method === VIBE_METHODS.sessionStart);
    const disabled = ((startCall?.params as Record<string, unknown>)["agentConfig"] as Record<string, unknown>)["disabledTools"] as string[];
    // Both aliases normalize to the `foo_bar_write` candidate, so both tools take
    // their own sha256 collision suffix: foo-bar -> f4180191, foo_bar -> 27b58290.
    expect(vibeDisabledMatches(disabled, "foo_bar_write_f4180191")).toBe(true);
    expect(vibeDisabledMatches(disabled, "foo_bar_write_27b58290")).toBe(false);
    expect(vibeDisabledMatches(disabled, "foo_bar_write_deadbeef")).toBe(false);
    await Effect.runPromise(driver.stopSession("th-collide"));
  });

  it("normalizes an astral character in an MCP tool name to a single underscore, as Python does", async () => {
    const server = new FakeVibeServer();
    setupDefaultServer(server);
    const driver = new VibeDriver({ transport: makeTransport([server]) });
    await Effect.runPromise(driver.startSession({
      threadId: "th-astral",
      workingDirectory: "/tmp/repo",
      mcpServers: [{ name: "demo", type: "http", url: "http://127.0.0.1:9999/mcp", headers: {} }],
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
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "th-overflow", prompt: "Work" }));
    const outcome = await Promise.race([
      driver.awaitTurn("th-overflow", turnId),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcome).not.toBe("hung");
    expect(outcome).toMatchObject({ status: "failed" });
    await Effect.runPromise(driver.stopSession("th-overflow"));
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

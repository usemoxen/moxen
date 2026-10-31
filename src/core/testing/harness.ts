/**
 * Store-backed test harness, shared by the CLI and server suites. Each
 * test gets a tmp store root (wired through `MOXEN_STORE_ROOT`, and a
 * `MOXEN_CONFIG` that does not exist, both restored afterwards) plus a git
 * repo workdir, so commands run the real ledger path with fake provider
 * drivers — no provider processes, no tokens, no network.
 *
 * Drivers: `completing` by default (turns finish with
 * `Completed: <prompt>`), `leaveTurnsRunning` parks them (busy/queue/
 * timeout paths), `failTurns` throws from `sendTurn` (async ledger
 * failure). Pass explicit `drivers` factories to take full control.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DEFAULT_CONFIG } from "../config.js";
import { CliError } from "../errors.js";
import type { McpServerSpec } from "../mcp.js";
import type { ProviderRuntimeEvent } from "../providers/spi.js";
import { runProcess } from "../infra/process.js";
import { rmTempAsync } from "./tmp.js";
import { openThreadStore, type ThreadStore } from "../threads/store.js";
import { flushTurnRunners } from "../threads/execute.js";
import type { TurnDriver, TurnDriverFactories, TurnOutcome } from "../threads/execute.js";
import type { CliConfig } from "../types.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Settle background turn runs before tearing down stores; pending runs
  // (leaveTurnsRunning) are abandoned by the flush timeout.
  await flushTurnRunners(2000).catch(() => undefined);
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

/** A turn as the provider receives it: the prompt, and the images sent with it. */
export interface SentTurn {
  readonly threadId: string;
  readonly prompt: string;
  readonly images?: ReadonlyArray<{ name: string; mimeType: string; data: string }>;
}

class HarnessDriver implements TurnDriver {
  private sessions = new Set<string>();
  private prompts = new Map<string, string>();
  private turn = 0;

  constructor(
    private readonly behavior: "completing" | "pending" | "failing",
    private readonly onStartSession?: (input: Record<string, unknown>) => void,
    private readonly onSendTurn?: (input: SentTurn) => void,
    private readonly onUpdateMcpServers?: (threadId: string, servers: readonly McpServerSpec[]) => void,
  ) {}

  /** Like the drivers that can: a session already running is given the servers of the day. */
  async updateMcpServers(threadId: string, servers: readonly McpServerSpec[]): Promise<void> {
    if (this.sessions.has(threadId)) this.onUpdateMcpServers?.(threadId, servers);
  }

  hasSession(threadId: string): Effect.Effect<boolean, CliError> {
    return Effect.succeed(this.sessions.has(threadId));
  }

  startSession(input: { threadId: string }): Effect.Effect<unknown, CliError> {
    return Effect.sync(() => {
      this.onStartSession?.(input as unknown as Record<string, unknown>);
      this.sessions.add(input.threadId);
      return {};
    });
  }

  sendTurn(input: SentTurn): Effect.Effect<{ threadId: string; turnId: string }, CliError> {
    return Effect.tryPromise({
      try: async () => {
        if (this.behavior === "failing") throw new Error("harness driver cannot start turns");
        this.onSendTurn?.({ threadId: input.threadId, prompt: input.prompt, ...(input.images ? { images: input.images } : {}) });
        this.turn += 1;
        const turnId = `driver-turn-${this.turn}`;
        this.prompts.set(turnId, input.prompt);
        return { threadId: input.threadId, turnId };
      },
      catch: (cause) => new CliError("DRIVER_TURN_FAILED", "Harness driver failed to start the turn.", { cause }),
    });
  }

  interruptTurn(_threadId: string): Effect.Effect<void, CliError> {
    return Effect.void;
  }

  async awaitTurn(threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnOutcome> {
    void threadId;
    if (this.behavior === "pending") {
      await new Promise<void>((_, reject) => {
        if (signal?.aborted === true) {
          reject(new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {}));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {})),
          { once: true },
        );
      });
    }
    const prompt = this.prompts.get(turnId) ?? "";
    return {
      status: "completed",
      text: `Completed: ${prompt}`,
      usage: { input: 1, cacheRead: 0, cacheCreate: 0, output: 2, thinking: 0 },
      error: null,
    };
  }

  /** Like every real driver: a handle to resume by, and a rollback. */
  resumeCursor(threadId: string): string | null {
    return this.sessions.has(threadId) ? `harness-session-${threadId}` : null;
  }

  /** A fork is a new handle naming its source, so a test can see the child resumed the copy. */
  async forkSession(cursor: string): Promise<string> {
    return `fork-of-${cursor}`;
  }

  rollbackThread(_threadId: string, _numTurns: number): Effect.Effect<unknown, CliError> {
    return Effect.succeed({});
  }

  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> = Stream.never;
}

export interface TestHarnessOptions {
  readonly drivers?: TurnDriverFactories;
  /** Turns never settle (busy/queue/timeout paths). */
  readonly leaveTurnsRunning?: boolean;
  /** `sendTurn` throws (async ledger failure). */
  readonly failTurns?: boolean;
  /** Sees every `startSession` input (instructions, MCP servers, working directory). */
  readonly onStartSession?: (input: Record<string, unknown>) => void;
  /** Sees every prompt as the provider receives it (instruction updates included). */
  readonly onSendTurn?: (input: SentTurn) => void;
  /** Sees the MCP servers a live session is given at each send (`updateMcpServers`). */
  readonly onUpdateMcpServers?: (threadId: string, servers: readonly McpServerSpec[]) => void;
}

function harnessDrivers(options: TestHarnessOptions): TurnDriverFactories {
  if (options.drivers) return options.drivers;
  const behavior = options.failTurns ? "failing" : options.leaveTurnsRunning ? "pending" : "completing";
  const factory = (): TurnDriver => new HarnessDriver(behavior, options.onStartSession, options.onSendTurn, options.onUpdateMcpServers);
  return { claude: factory, codex: factory, opencode: factory };
}

export async function testHarness(options: TestHarnessOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-store-"));
  const previousStoreRoot = process.env.MOXEN_STORE_ROOT;
  const previousConfig = process.env.MOXEN_CONFIG;
  const previousDefaultModel = process.env.MOXEN_DEFAULT_MODEL;
  process.env.MOXEN_STORE_ROOT = root;
  // The installation default otherwise depends on which provider CLIs this
  // machine has; the goldens must not.
  process.env.MOXEN_DEFAULT_MODEL = "opencode/gpt-5.4";
  // Anything that loads the config itself (the server connection) must
  // see defaults, never the developer's own config file.
  process.env.MOXEN_CONFIG = path.join(root, "config.json");
  // And never the developer's running server: in the default `auto` mode a
  // client takes any server at the endpoint, and the real one would answer
  // for (and write into) the real store. Here, `auto` finds none.
  const previousEndpoint = process.env.MOXEN_SERVER_ENDPOINT;
  process.env.MOXEN_SERVER_ENDPOINT =
    process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(root)}` : path.join(root, "server.sock");
  cleanup.push(async () => {
    if (previousStoreRoot === undefined) delete process.env.MOXEN_STORE_ROOT;
    else process.env.MOXEN_STORE_ROOT = previousStoreRoot;
    if (previousConfig === undefined) delete process.env.MOXEN_CONFIG;
    else process.env.MOXEN_CONFIG = previousConfig;
    if (previousEndpoint === undefined) delete process.env.MOXEN_SERVER_ENDPOINT;
    else process.env.MOXEN_SERVER_ENDPOINT = previousEndpoint;
    if (previousDefaultModel === undefined) delete process.env.MOXEN_DEFAULT_MODEL;
    else process.env.MOXEN_DEFAULT_MODEL = previousDefaultModel;
    await rmTempAsync(root);
  });
  const work = path.join(root, "work");
  await mkdir(work, { recursive: true });
  await runProcess("git", ["init", "-b", "main"], { cwd: work });
  // A seed commit so the branch exists (worktree provisioning and
  // checkpoint capture both need a resolvable HEAD).
  await writeFile(path.join(work, ".gitkeep"), "");
  await runProcess("git", ["add", "-A"], { cwd: work });
  await runProcess("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: work });

  const store: ThreadStore = await openThreadStore(root);
  const config: CliConfig = {
    ...DEFAULT_CONFIG,
    openMode: "none",
    threadEnvMode: "local",
  };
  return { root, work, config, store, drivers: harnessDrivers(options) };
}

export type TestHarness = Awaited<ReturnType<typeof testHarness>>;

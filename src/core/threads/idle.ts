/**
 * Ending provider sessions nobody is using: the idle lifetime (`sessionTtl`,
 * and `providers.<kind>.sessionTtl` over it).
 *
 * A warm session costs a process (Claude Code), a slot on a server (OpenCode,
 * a local llama.cpp) and memory; a cold one costs a restart and a prompt cache
 * read afresh. The lifetime is where the user puts that line. A session is
 * ended only when nothing happened on it for that long, it has no open turn,
 * no background task, and nothing waiting on the user (which is always inside
 * an open turn). Ending it loses nothing: the next message resumes the
 * provider's own session from the thread's cursor.
 *
 * Activity is what the session watcher (`watchDriverSession`) sees: every
 * event of the thread, and the live set of its background tasks.
 */
import * as Effect from "effect/Effect";

import type { CliConfig } from "../types.js";
import type { ThreadStore } from "./store.js";
import { openTurn } from "./threads.js";

/** How often idle sessions are looked for. A lifetime is honoured to within this. */
export const IDLE_SWEEP_MS = 30_000;

/** `45s`, `2m`, `1h` (the setting's own form) in milliseconds; null for anything else. */
export function durationMs(text: string | undefined): number | null {
  const match = /^(\d+)(ms|s|m|h)$/.exec((text ?? "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  return value * unit;
}

/** The idle lifetime for one provider's sessions: its own, else the global one. Null: never ended. */
export function sessionTtlFor(config: CliConfig, kind: "claude" | "codex" | "opencode" | "harness" | null): number | null {
  const own = kind === null ? undefined : config.providers?.[kind]?.sessionTtl;
  return durationMs(own ?? config.sessionTtl);
}

/** What ending a session needs from its driver. */
export interface IdleDriver {
  stopSession?(threadId: string): Effect.Effect<void, unknown>;
  hasSession(threadId: string): Effect.Effect<boolean, unknown>;
}

interface IdleState {
  last: number;
  ttlMs: number | null;
  tasks: number;
  readonly store: ThreadStore;
  /** Stop watching the thread, once its session is gone. */
  readonly unwatch: () => void;
}

const sessions = new Map<IdleDriver, Map<string, IdleState>>();
let sweeper: ReturnType<typeof setInterval> | null = null;
let clock: () => number = () => Date.now();

/** For tests: a clock to measure idleness by. */
export function setIdleClock(next: () => number): void {
  clock = next;
}

function stateOf(driver: IdleDriver, threadId: string): IdleState | undefined {
  return sessions.get(driver)?.get(threadId);
}

/** A watched session, with its lifetime; a session already known keeps its record and takes the new lifetime. */
export function trackSession(driver: IdleDriver, threadId: string, input: { readonly store: ThreadStore; readonly ttlMs: number | null; readonly unwatch: () => void }): void {
  let byThread = sessions.get(driver);
  if (!byThread) {
    byThread = new Map();
    sessions.set(driver, byThread);
  }
  const known = byThread.get(threadId);
  if (known) {
    known.last = clock();
    known.ttlMs = input.ttlMs;
    return;
  }
  byThread.set(threadId, { last: clock(), ttlMs: input.ttlMs, tasks: 0, store: input.store, unwatch: input.unwatch });
  if (sweeper === null) {
    sweeper = setInterval(() => void sweepIdleSessions(), IDLE_SWEEP_MS);
    sweeper.unref?.();
  }
}

/** Something happened on the session: it is not idle. `tasks`: the live count of its background tasks, when the event says. */
export function touchSession(driver: IdleDriver, threadId: string, tasks?: number): void {
  const state = stateOf(driver, threadId);
  if (!state) return;
  state.last = clock();
  if (tasks !== undefined) state.tasks = tasks;
}

/** The session ended on its own: nothing more to watch. */
export function forgetSession(driver: IdleDriver, threadId: string): void {
  sessions.get(driver)?.delete(threadId);
}

/** End every session idle past its lifetime. Returns the threads whose sessions were ended. */
export async function sweepIdleSessions(): Promise<string[]> {
  const ended: string[] = [];
  const now = clock();
  for (const [driver, byThread] of sessions) {
    for (const [threadId, state] of [...byThread]) {
      if (state.ttlMs === null || now - state.last < state.ttlMs || state.tasks > 0) continue;
      const alive = await Effect.runPromise(driver.hasSession(threadId)).catch(() => false);
      if (!alive) {
        byThread.delete(threadId);
        state.unwatch();
        continue;
      }
      // A turn still open (a long quiet tool call, a question waiting on the user) is not idle.
      const turns = await state.store.readTurns(threadId).catch(() => null);
      if (turns === null || openTurn(turns) !== null) {
        state.last = now;
        continue;
      }
      if (driver.stopSession === undefined) continue;
      const stopped = await Effect.runPromise(driver.stopSession(threadId)).then(() => true, () => false);
      if (!stopped) continue;
      byThread.delete(threadId);
      state.unwatch();
      ended.push(threadId);
    }
  }
  return ended;
}

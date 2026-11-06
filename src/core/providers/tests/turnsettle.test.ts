import { describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "../spi.js";
import {
  parkTurnWaiter,
  resolveTurnWaiters,
  settleAndPublishTurn,
  terminalTurnEvent,
  type TurnWaiters,
} from "../turnsettle.js";

interface FakeTurn {
  readonly id: string;
  status: string;
  text: string;
  error: string | null;
}

function settle(turns: FakeTurn[], waiters: TurnWaiters<string>, events: ProviderRuntimeEvent[], status: "completed" | "failed" | "interrupted", detail: string): FakeTurn | null {
  return settleAndPublishTurn({
    open: turns.find((turn) => turn.status === "running"),
    waiters,
    status,
    apply: (turn) => {
      turn.status = status;
      turn.error = status === "completed" ? null : detail;
      if (status !== "completed") turn.text = turn.text || detail;
      return `${status}:${turn.text}`;
    },
    publish: (event) => void events.push(event),
    event: (turnId) => terminalTurnEvent("claude", "thread-1", turnId, status, { error: detail }),
  });
}

describe("turn settle helper", () => {
  it("settles, resolves and publishes exactly once", async () => {
    const turns: FakeTurn[] = [{ id: "turn-1", status: "running", text: "", error: null }];
    const waiters: TurnWaiters<string> = new Map();
    const first = parkTurnWaiter({ waiters, turnId: "turn-1", signal: undefined, onAbort: () => new Error("aborted") });
    const second = parkTurnWaiter({ waiters, turnId: "turn-1", signal: undefined, onAbort: () => new Error("aborted") });
    const events: ProviderRuntimeEvent[] = [];

    expect(settle(turns, waiters, events, "interrupted", "Interrupted.")).not.toBeNull();
    // An interrupt landing after the result settled the turn, or a result
    // arriving after an interrupt settled it, finds nothing running.
    expect(settle(turns, waiters, events, "completed", "")).toBeNull();

    await expect(first).resolves.toBe("interrupted:Interrupted.");
    await expect(second).resolves.toBe("interrupted:Interrupted.");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "turn.interrupted", provider: "claude", threadId: "thread-1", turnId: "turn-1" });
    expect(waiters.has("turn-1")).toBe(false);
  });

  it("resolving waiters directly drops the registry entry", async () => {
    const waiters: TurnWaiters<string> = new Map();
    const waiting = parkTurnWaiter({ waiters, turnId: "turn-1", signal: undefined, onAbort: () => new Error("aborted") });
    resolveTurnWaiters(waiters, "turn-1", "done");
    resolveTurnWaiters(waiters, "turn-1", "done");
    await expect(waiting).resolves.toBe("done");
  });

  it("aborting one waiter leaves the other waiter to settle", async () => {
    const waiters: TurnWaiters<string> = new Map();
    const first = new AbortController();
    const waitingFirst = parkTurnWaiter({ waiters, turnId: "turn-1", signal: first.signal, onAbort: () => new Error("aborted") });
    const waitingSecond = parkTurnWaiter({ waiters, turnId: "turn-1", signal: undefined, onAbort: () => new Error("aborted") });
    first.abort();
    await expect(waitingFirst).rejects.toThrow("aborted");
    resolveTurnWaiters(waiters, "turn-1", "done");
    await expect(waitingSecond).resolves.toBe("done");
  });

  it("maps terminal statuses to their event, with raw only on failures", () => {
    expect(terminalTurnEvent("codex", "thread-1", "turn-1", "completed")).toEqual({
      type: "turn.completed",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(terminalTurnEvent("codex", "thread-1", "turn-1", "failed", { error: "boom" })).toMatchObject({
      type: "turn.failed",
      raw: { error: "boom" },
    });
    expect(terminalTurnEvent("codex", "thread-1", "turn-1", "interrupted")).toEqual({
      type: "turn.interrupted",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });
});

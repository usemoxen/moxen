/**
 * MXN-402 round 7: the probe deadline settles the answer first and reaps the
 * child off the response path. These tests drive the runner with a fake child
 * and fake timers: a callback that arrives first must clear the deadline, and
 * a deadline that fires first must answer without waiting for the reaper,
 * ignoring any late output.
 *
 * Round 9: stdout is only an answer when the child reported a clean exit. A
 * probe that prints `[]` and then exits non-zero (or dies on a signal) is a
 * failed probe whose output means nothing — accepting it would rewrite a
 * valid login snapshot as an explicit logout.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, killMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  killMock: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../../infra/process.js", () => ({ killProcessTreeAsync: killMock, resolveOnPath: () => null }));

import { defaultAuthListRunner } from "../catalog.js";

type FakeStream = EventEmitter & { setEncoding: (encoding: string) => void; resume: () => void; destroy: () => void };

interface FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdin: { end: () => void };
  readonly stdout: FakeStream;
  readonly stderr: FakeStream;
  readonly unref: () => void;
  readonly kill: () => void;
  exitCode: number | null;
  signalCode: string | null;
}

function fakeChild(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), resume: vi.fn(), destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), resume: vi.fn(), destroy: vi.fn() });
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: { end: vi.fn() },
    stdout,
    stderr,
    unref: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  killMock.mockReset();
  killMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("defaultAuthListRunner deadline ordering", () => {
  it("settles from the callback first and clears the deadline", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = defaultAuthListRunner("/opt/opencode", {}, { timeoutMs: 500, killGraceMs: 100 });
    child.stdout.emit("data", "[]");
    child.emit("close", 0, null);
    await expect(result).resolves.toBe("[]");
    expect(killMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers at the deadline without waiting for the reaper, and ignores late output", async () => {
    vi.useFakeTimers();
    // A reaper that never resolves: the answer must not depend on it.
    killMock.mockImplementation(() => new Promise(() => undefined));
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = defaultAuthListRunner("/opt/opencode", {}, { timeoutMs: 500, killGraceMs: 100 });

    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeNull();
    expect(killMock).toHaveBeenNthCalledWith(1, child, "SIGTERM");

    await vi.advanceTimersByTimeAsync(100);
    expect(killMock).toHaveBeenNthCalledWith(2, child, "SIGKILL");

    // Output that arrives after the deadline is ignored.
    child.stdout.emit("data", "[]");
    child.emit("close", 0, null);
    await expect(result).resolves.toBeNull();
  });

  it("settles as failure when the output cap is exceeded", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = defaultAuthListRunner("/opt/opencode", {}, { timeoutMs: 500, killGraceMs: 100 });
    child.stdout.emit("data", "x".repeat(4 * 1024 * 1024 + 1));
    await expect(result).resolves.toBeNull();
    expect(killMock).toHaveBeenCalledWith(child, "SIGTERM");
  });
});

describe("defaultAuthListRunner exit status", () => {
  /** A probe that prints `text` and then closes with the given status. */
  async function runWithStatus(text: string, code: number | null, signal: NodeJS.Signals | null): Promise<string | null> {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = defaultAuthListRunner("/opt/opencode", {}, { timeoutMs: 500, killGraceMs: 100 });
    child.stdout.emit("data", text);
    child.emit("close", code, signal);
    return await result;
  }

  it("accepts stdout only from a clean exit", async () => {
    await expect(runWithStatus("[]", 0, null)).resolves.toBe("[]");
  });

  it("refuses a non-zero exit even when its stdout looks like a logout", async () => {
    // `[]` here is an explicit logout for every provider: accepting it from a
    // probe that failed would wipe a valid login snapshot.
    await expect(runWithStatus("[]", 7, null)).resolves.toBeNull();
    await expect(runWithStatus("[]", 1, null)).resolves.toBeNull();
  });

  it("refuses a signal exit even when its stdout looks like a logout", async () => {
    await expect(runWithStatus("[]", null, "SIGKILL")).resolves.toBeNull();
    await expect(runWithStatus("[]", null, "SIGTERM")).resolves.toBeNull();
  });

  it("still reports a clean exit that printed nothing as failure", async () => {
    await expect(runWithStatus("", 0, null)).resolves.toBeNull();
  });
});

describe("defaultAuthListRunner escalation keeps the caller alive", () => {
  /**
   * A one-shot caller (`moxen models`, the TUI's first catalog) exits as soon
   * as its promise resolves. If the SIGKILL escalation timer is unreferenced,
   * the process exits the moment the deadline answers null — inside the grace
   * period — and a probe that ignores SIGTERM is never reaped. The timer must
   * hold the loop open until it fires.
   */
  it("holds the loop open across the grace period, then releases it", async () => {
    // Real timers: the question is what Node counts as a live handle.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = defaultAuthListRunner("/opt/opencode", {}, { timeoutMs: 20, killGraceMs: 120 });
    await expect(result).resolves.toBeNull();
    expect(killMock).toHaveBeenNthCalledWith(1, child, "SIGTERM");
    // The answer is out, but the grace timer is still ahead: it must be a
    // referenced Timeout, or a one-shot caller would exit before SIGKILL.
    const pending = (process.getActiveResourcesInfo?.() ?? []).filter((kind) => kind === "Timeout");
    expect(pending.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(killMock).toHaveBeenCalledWith(child, "SIGKILL"), { timeout: 2_000 });
    // Once the escalation has fired nothing of the runner's keeps the loop alive.
    await vi.waitFor(
      () => expect((process.getActiveResourcesInfo?.() ?? []).filter((kind) => kind === "Timeout")).toHaveLength(0),
      { timeout: 2_000 },
    );
  });
});

/**
 * MXN-402 round 7: the probe deadline settles the answer first and reaps the
 * child off the response path. These tests drive the runner with a fake child
 * and fake timers: a callback that arrives first must clear the deadline, and
 * a deadline that fires first must answer without waiting for the reaper,
 * ignoring any late output.
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
    child.emit("close");
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
    child.emit("close");
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

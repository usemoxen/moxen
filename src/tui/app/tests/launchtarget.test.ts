import { describe, expect, it } from "vitest";

import { launchTarget } from "../utils.js";

const row = (id: string, over: Partial<{ status: string; waiting: boolean; depth: number }> = {}) => ({
  thread: { id },
  status: "active",
  waiting: false,
  depth: 0,
  ...over,
});

describe("launchTarget", () => {
  it("lands on the new-thread screen over the latest thread when nothing needs the user", () => {
    expect(launchTarget([row("latest"), row("older")], null)).toEqual({ threadId: "latest", transcript: false });
  });

  it("falls back to the latest visible thread of any status, and to none", () => {
    expect(launchTarget([], "settled-one")).toEqual({ threadId: "settled-one", transcript: false });
    expect(launchTarget([], null)).toEqual({ threadId: null, transcript: false });
  });

  it("opens the thread that is working or waiting on the user instead, even when it is not the latest", () => {
    expect(launchTarget([row("latest"), row("asking", { waiting: true })], null)).toEqual({ threadId: "asking", transcript: true });
    expect(launchTarget([row("latest"), row("busy", { status: "running" })], null)).toEqual({ threadId: "busy", transcript: true });
    expect(launchTarget([row("blocked", { status: "blocked" }), row("latest")], null)).toEqual({ threadId: "blocked", transcript: true });
  });

  it("prefers the most recent, and a top-level thread over a task under it", () => {
    expect(launchTarget([row("a", { status: "running" }), row("b", { waiting: true })], null).threadId).toBe("a");
    expect(launchTarget([row("task", { status: "running", depth: 1 }), row("parent", { status: "running", depth: 0 })], null).threadId).toBe("parent");
    expect(launchTarget([row("task", { status: "running", depth: 1 }), row("other")], null).threadId).toBe("task");
  });
});

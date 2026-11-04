import { describe, expect, it } from "vitest";

import type { UpdateCheck, UpdateResult } from "../../../core/selfupdate/vocabulary.js";
import { IDLE, downloadFraction, reduceUpdate, stageRows, updateActions, updateEventFromFrame, type UpdateEvent, type UpdateView } from "../update.js";

const check = (overrides: Partial<UpdateCheck> = {}): UpdateCheck => ({
  install: { version: "0.1.0", kind: "release", folder: "/app", target: { os: "macos", arch: "arm64" } },
  status: "available",
  reason: null,
  latest: { version: "0.2.0", tag: "v0.2.0", url: "u", notes: "", archive: null, checksum: null },
  updatable: true,
  ...overrides,
});
const result: UpdateResult = { action: "updated", version: "0.2.0", from: "0.1.0", previous: "0.1.0", folder: "/f", current: "/c", warnings: [] };
const run = (...events: UpdateEvent[]): UpdateView => events.reduce(reduceUpdate, IDLE as UpdateView);
const ready = (value = check()): UpdateEvent[] => [{ type: "check-start" }, { type: "check-done", check: value }];

describe("update view", () => {
  it("keeps only progress that carries its own commandId", () => {
    const view = run(...ready(), { type: "run-start", op: "apply", commandId: "mine" },
      { type: "progress", commandId: "theirs", progress: { stage: "testing" } },
      { type: "progress", commandId: null, progress: { stage: "switching" } });
    expect(view).toMatchObject({ phase: "running", progress: null });
    expect(reduceUpdate(view, { type: "progress", commandId: "mine", progress: { stage: "unpacking" } })).toMatchObject({ progress: { stage: "unpacking" } });
  });

  it("does not start a second update while one runs, and does not let a check replace it", () => {
    const view = run(...ready(), { type: "run-start", op: "apply", commandId: "one" });
    expect(reduceUpdate(view, { type: "run-start", op: "apply", commandId: "two" })).toBe(view);
    expect(reduceUpdate(view, { type: "check-start" })).toBe(view);
    expect(updateActions(view, { remote: false })).toEqual([]);
  });

  it("ignores the end of a command that is not the one it is running", () => {
    const view = run(...ready(), { type: "run-start", op: "apply", commandId: "mine" });
    expect(reduceUpdate(view, { type: "run-done", commandId: "other", result })).toBe(view);
    expect(reduceUpdate(view, { type: "run-failed", commandId: "other", code: null, message: "x" })).toBe(view);
  });

  it("says it lost track when the link drops mid-update, and still takes the real answer if it arrives", () => {
    const lost = run(...ready(), { type: "run-start", op: "apply", commandId: "mine" }, { type: "link-lost" });
    expect(lost.phase).toBe("lost");
    expect(updateActions(lost, { remote: false })).toEqual(["check"]);
    expect(reduceUpdate(lost, { type: "run-done", commandId: "mine", result }).phase).toBe("finished");
    // Losing the link with nothing running changes nothing.
    expect(reduceUpdate(run(...ready()), { type: "link-lost" }).phase).toBe("ready");
  });

  it("reads an update event from a shell frame and nothing else", () => {
    const frame = { kind: "event", event: { type: "app.update-progress", payload: { commandId: "c", progress: { stage: "downloading", bytes: 1, total: 2 } } } };
    expect(updateEventFromFrame(frame)).toEqual({ type: "progress", commandId: "c", progress: { stage: "downloading", bytes: 1, total: 2 } });
    expect(updateEventFromFrame({ kind: "synchronized" })).toBeNull();
    expect(updateEventFromFrame({ kind: "event", event: { type: "other", payload: {} } })).toBeNull();
  });
});

describe("update actions", () => {
  const offered = (view: UpdateView, remote = false) => updateActions(view, { remote });
  it("offers an install and a rollback to a release install on this machine", () => {
    expect(offered(run(...ready()))).toEqual(["install", "rollback", "check"]);
  });
  it("offers no install when nothing newer can be installed", () => {
    expect(offered(run(...ready(check({ status: "up-to-date", updatable: false }))))).toEqual(["rollback", "check"]);
    expect(offered(run(...ready(check({ updatable: false }))))).toEqual(["rollback", "check"]);
  });
  it("offers no install or rollback on a source checkout", () => {
    expect(offered(run(...ready(check({ install: { ...check().install, kind: "source" }, updatable: false }))))).toEqual(["check"]);
  });
  it("offers no install or rollback on a paired server", () => {
    expect(offered(run(...ready()), true)).toEqual(["check"]);
  });
  it("offers nothing but a check when the server did not answer", () => {
    expect(offered(run({ type: "check-start" }, { type: "check-failed", message: "x" }))).toEqual(["check"]);
  });
  it("does not offer an immediate retry after another update was running, but does after a failure", () => {
    const failed = (code: string | null) => run(...ready(), { type: "run-start", op: "apply", commandId: "c" }, { type: "run-failed", commandId: "c", code, message: "no" });
    expect(offered(failed("SELF_UPDATE_BUSY"))).toEqual(["check"]);
    expect(offered(failed("SELF_UPDATE_DOWNLOAD_FAILED"))).toEqual(["install", "check"]);
  });
});

describe("update progress", () => {
  it("marks the stages before the current one done and shows a rollback's own two", () => {
    expect(stageRows("apply", { stage: "unpacking" }).map((row) => row.state)).toEqual(["done", "done", "done", "current", "pending", "pending"]);
    expect(stageRows("rollback", null).map((row) => row.stage)).toEqual(["testing", "switching"]);
    expect(stageRows("apply", { stage: "done" }).every((row) => row.state === "done")).toBe(true);
  });
  it("gives no fraction while the size is unknown", () => {
    expect(downloadFraction({ stage: "downloading", bytes: 5, total: null })).toBeNull();
    expect(downloadFraction({ stage: "downloading", bytes: 5, total: 10 })).toBe(0.5);
    expect(downloadFraction({ stage: "verifying" })).toBeNull();
  });
});

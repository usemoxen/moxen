/**
 * Plan mode was removed (MXN-136): what was saved with it still loads as
 * Build, and asking for it now is refused with a reason, never ignored.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../config.js";
import { CliError } from "../errors.js";
import { requestedInteractionMode, storedInteractionMode } from "../interactionmode.js";
import { ThreadStore } from "../threads/store.js";

const refusal = (run: () => unknown): CliError => {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("interaction modes after plan mode", () => {
  it("reads a saved plan (or anything unknown) as Build", () => {
    expect(storedInteractionMode("plan")).toBe("default");
    expect(storedInteractionMode(undefined)).toBe("default");
    expect(storedInteractionMode("default")).toBe("default");
  });

  it("refuses plan when asked for, with its own code and exit 2", () => {
    const removed = refusal(() => requestedInteractionMode("plan", "--mode"));
    expect(removed.code).toBe("PLAN_MODE_REMOVED");
    expect(removed.exitCode).toBe(2);
    expect(refusal(() => requestedInteractionMode("nope", "--mode")).code).toBe("INVALID_THREAD_OPTION");
    expect(requestedInteractionMode("default", "--mode")).toBe("default");
  });

  it("loads a config that still says plan as Build, and still refuses nonsense", () => {
    expect(normalizeConfig({ interactionMode: "plan" }).interactionMode).toBe("default");
    expect(refusal(() => normalizeConfig({ interactionMode: "sideways" })).code).toBe("INVALID_CONFIG");
  });

  it("reads a thread stored in plan mode as Build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-modes-"));
    const store = await ThreadStore.open(root);
    await mkdir(path.join(root, "threads", "t1"), { recursive: true });
    await writeFile(path.join(root, "threads", "t1", "thread.json"), JSON.stringify({ id: "t1", interactionMode: "plan", runtimeMode: "full-access" }));
    expect((await store.readThreadRecord("t1"))?.interactionMode).toBe("default");
  });
});

/**
 * Plan mode was removed (MXN-136): every command that takes a mode refuses
 * `plan` with its own code, rather than quietly running in Build.
 */
import { describe, expect, it } from "vitest";

import { CliError } from "../../core/errors.js";
import { decodeCommand } from "../protocol.js";

const refusal = (run: () => unknown): CliError => {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("commands after plan mode", () => {
  it("refuses plan in every command that takes a mode", () => {
    for (const command of [
      { type: "thread.create", projectId: "p1", interactionMode: "plan" },
      { type: "thread.runtime-mode.set", threadId: "t1", runtimeMode: "full-access", interactionMode: "plan" },
    ]) {
      expect(refusal(() => decodeCommand(command)).code).toBe("PLAN_MODE_REMOVED");
    }
    expect(decodeCommand({ type: "thread.create", projectId: "p1", interactionMode: "default" })).toMatchObject({ interactionMode: "default" });
  });
});

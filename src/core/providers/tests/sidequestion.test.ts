import { describe, expect, it } from "vitest";

import { SIDE_QUESTION_RULES } from "../sidequestion.js";

describe("side question rules", () => {
  // A real /btw on a running task said Bash was disabled, that the last
  // command was interrupted, and listed the steps left for the user.
  it("says the thread keeps working, its tools are unaffected, and the finishing is not the user's", () => {
    expect(SIDE_QUESTION_RULES).toContain("was not interrupted");
    expect(SIDE_QUESTION_RULES).toContain("still running, not stopped or failed");
    expect(SIDE_QUESTION_RULES).toContain("never say the thread's tools are disabled");
    expect(SIDE_QUESTION_RULES).toContain("Do not tell the user what to do to finish it");
  });
});

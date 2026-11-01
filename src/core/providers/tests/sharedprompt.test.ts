import { describe, expect, it } from "vitest";

import { CHECKING, careSection } from "../sharedprompt.js";

describe("the prose Moxen's own prompts share", () => {
  const care = careSection("A refusal is final.");

  it("does not end unfinished work when checks for one change pass", () => {
    expect(CHECKING).not.toContain("Once the relevant checks pass, stop;");
    expect(CHECKING).toContain("stop running checks for that change");
    expect(CHECKING).toContain("Continue with any remaining requested work.");
    expect(CHECKING).toContain("Finish your turn only when the whole request is complete or an unresolved blocker requires the user.");
  });

  it("does not hand every change it did not make to the user", () => {
    // A subagent or a sibling thread writes in this checkout too, and nobody is there to answer a question about its work.
    expect(care).toContain("never revert, reset, discard or overwrite the user's work in progress, another thread's, or a subagent's");
    expect(care).toContain("If the user's own change turns up in a file you are working on, stop and ask.");
    expect(care).toContain("A subagent's or another thread's is not a surprise to stop dead for");
    expect(care).not.toContain("Changes you did not make are the user's");
  });

  it("puts the host's own approval wording inside the care section", () => {
    expect(care).toContain("A refusal is final.");
    expect(care.indexOf("When you do need approval")).toBeLessThan(care.indexOf("A refusal is final."));
  });
});

import { describe, expect, it } from "vitest";

import { buildOpencodeSystemPrompt } from "../prompt.js";

describe("Moxen's system prompt for OpenCode", () => {
  it("carries the Harness's working principles and names the tools the way OpenCode does", () => {
    const prompt = buildOpencodeSystemPrompt();
    expect(prompt).toContain("# Doing the work");
    expect(prompt).toContain("# Checking your work");
    expect(prompt).toContain("# Acting with care");
    expect(prompt).toContain("OpenCode's permission system refuses some actions");
    expect(prompt).toContain("oldString");
    expect(prompt).not.toContain("Moxen's safety check");
    expect(prompt).not.toContain("web_fetch");
    // The dedicated tools are the default, not the only way: the Shell section says when the shell is better.
    expect(prompt).toContain("Use the dedicated tools for file work by default");
    expect(prompt).toContain("One mechanical change across many files is a script");
    // What the runtime instructions already say is not said twice.
    expect(prompt).not.toContain("progress notes");
    expect(prompt).not.toContain("<task-notification>");
    // Moxen has no plan mode, so the prompt does not mention one.
    expect(prompt).not.toContain("plan mode");
    // The cadence of status updates is the runtime instructions' to set, so the prompt does not set a second one.
    expect(prompt).not.toContain("Before your first tool call");
  });

  it("does not point the model at a tool the server was told to leave off, and carries nothing that changes between turns", () => {
    const prompt = buildOpencodeSystemPrompt("webfetch,websearch,subagent,question");
    expect(prompt).not.toContain("On the web, prefer");
    expect(prompt).not.toContain("A subagent works");
    expect(prompt).not.toContain("ask with question");
    expect(prompt).toContain("The skill tool lists skills");
    expect(prompt).not.toMatch(/Working directory|20\d\d-\d\d-\d\d/);
  });
});

import { SIDE_QUESTION_RULES } from "../../sidequestion.js";
import { describe, expect, it } from "vitest";

import { ClaudeDriver } from "../driver.js";
import { assistantText, errorResult, FakeTransport, permissionCallbackOptions, successResult } from "./fakes.js";

/**
 * `/btw` on Claude: a one-shot answer on a copy of the thread's session.
 * The options are the whole contract — a missing `forkSession` would write
 * the side question into the real session, and a missing `tools: []`
 * would let it act on the repository.
 */
describe("Claude side questions", () => {
  it("completes fresh text with only the editing prompt, no tools, inherited MCP, hooks, or persisted session", async () => {
    const transport = new FakeTransport([[successResult(" Improved draft. ")]]);
    const driver = new ClaudeDriver({ transport });
    await expect(driver.completeText({ workingDirectory: "/work", model: "claude-haiku-5-5", prompt: "Draft", instructions: "Edit only." })).resolves.toBe(" Improved draft. ");
    const query = transport.created[0]!;
    expect(query.options).toMatchObject({ tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], settings: { disableAllHooks: true, autoMemoryEnabled: false }, systemPrompt: "Edit only.", model: "claude-haiku-5-5", persistSession: false, maxTurns: 1 });
    expect(query.options.resume).toBeUndefined();
    expect(query.options.forkSession).toBeUndefined();
    expect(await query.options.canUseTool!("Read", {}, permissionCallbackOptions("read"))).toMatchObject({ behavior: "deny" });
    expect(query.prompts).toEqual(["Draft"]);
    expect(query.closed).toBe(true);
  });
  it("asks on a tool-less, unpersisted copy of the session and returns its text", async () => {
    const transport = new FakeTransport([[assistantText("It is using JWTs in auth.ts."), successResult("It is using JWTs in auth.ts.")]]);
    const driver = new ClaudeDriver({ transport });
    const answer = await driver.sideQuestion({
      cursor: "session-abc",
      workingDirectory: "/work",
      question: "Which auth scheme did we settle on?",
      model: "claude-opus-5",
    });
    expect(answer).toEqual({ text: "It is using JWTs in auth.ts.", withContext: true });

    const query = transport.created[0]!;
    expect(query.options).toMatchObject({
      cwd: "/work",
      resume: "session-abc",
      forkSession: true,
      persistSession: false,
      tools: [],
      maxTurns: 3,
      model: "claude-opus-5",
    });
    // Told it has no tools, so it answers rather than writing fake tool calls,
    // and that this is a copy, so it doesn't report the running work as stopped.
    expect(query.options.systemPrompt).toMatchObject({ append: expect.stringContaining(SIDE_QUESTION_RULES) });
    expect(query.prompts).toEqual(["Which auth scheme did we settle on?"]);
    expect(query.closed).toBe(true);
  });

  it("answers without a copy when the thread has no session yet, and says so", async () => {
    const transport = new FakeTransport([[successResult("No context yet.")]]);
    const driver = new ClaudeDriver({ transport });
    const answer = await driver.sideQuestion({ cursor: null, workingDirectory: "/work", question: "hi" });
    expect(answer).toEqual({ text: "No context yet.", withContext: false });
    expect(transport.created[0]!.options.resume).toBeUndefined();
    expect(transport.created[0]!.options.forkSession).toBeUndefined();
  });

  it("fails plainly when the side run errors or comes back empty", async () => {
    const failing = new ClaudeDriver({ transport: new FakeTransport([[errorResult("error_max_turns")]]) });
    await expect(failing.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q" })).rejects.toThrow(
      "did not get an answer (error_max_turns)",
    );
    const empty = new ClaudeDriver({ transport: new FakeTransport([[successResult("")]]) });
    await expect(empty.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q" })).rejects.toThrow("came back empty");
  });
});

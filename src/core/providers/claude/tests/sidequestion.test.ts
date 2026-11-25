import { SIDE_QUESTION_RULES } from "../../sidequestion.js";
import { describe, expect, it } from "vitest";

import { CliError } from "../../../errors.js";
import { ClaudeDriver } from "../driver.js";
import {
  assistantApiError,
  assistantStringText,
  assistantText,
  assistantThinking,
  errorResult,
  FakeTransport,
  permissionCallbackOptions,
  streamTextDelta,
  successResult,
  thinkingTokens,
} from "./fakes.js";

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

  /**
   * The Claude Code 2.1 CLI, checked against a stub API on a tool-less forked
   * turn: a reply that only thought ends as a `success` result whose `result`
   * is `""`, after the CLI's own "no visible output" nudge. That is the
   * shape Fable 5.2, Opus 5.5 and Sonnet 5.5 side questions came back as.
   */
  it("says a thinking-only reply was thinking-only instead of a bare empty answer", async () => {
    const transport = new FakeTransport([
      [assistantThinking("Considering the thread's auth scheme."), successResult("", 0.01, { num_turns: 2 })],
    ]);
    const driver = new ClaudeDriver({ transport });
    const failure = await driver
      .sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q", model: "claude-fable-5-2" })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("SIDE_QUESTION_FAILED");
    expect((failure as CliError).message).toBe(
      "The side question came back empty: claude-fable-5-2 replied with thinking only and no text in 2 turns.",
    );
  });

  it("counts the CLI's thinking token frames as thinking, even with no block to read", async () => {
    const transport = new FakeTransport([[thinkingTokens(), successResult("", 0.01, { num_turns: 2 })]]);
    const driver = new ClaudeDriver({ transport });
    await expect(
      driver.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q", model: "claude-opus-5-5" }),
    ).rejects.toThrow(
      "The side question came back empty: claude-opus-5-5 replied with thinking only and no text in 2 turns.",
    );
  });

  /**
   * A failed API call also arrives as `success` with `is_error: true`, and its
   * `result` holds the error text. Returning that text answered `/btw` with
   * "API Error: 400 …" as if the model had said it.
   */
  it("fails with the API's own error text instead of resolving to it as the answer", async () => {
    const detail = "API Error: 400 thinking budget exceeded for this model";
    const transport = new FakeTransport([[assistantApiError(detail), successResult(detail, 0, { is_error: true })]]);
    const driver = new ClaudeDriver({ transport });
    const failure = await driver
      .sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q", model: "claude-fable-5-2" })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("SIDE_QUESTION_FAILED");
    expect((failure as CliError).message).toBe(`The side question failed: ${detail}.`);
  });

  it("takes an answer the CLI only streamed token by token", async () => {
    const transport = new FakeTransport([
      [streamTextDelta("It is using ", 0), streamTextDelta("JWTs in auth.ts.", 0), successResult("")],
    ]);
    const driver = new ClaudeDriver({ transport });
    await expect(
      driver.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q" }),
    ).resolves.toEqual({ text: "It is using JWTs in auth.ts.", withContext: true });
  });

  it("reads an answer whose content is a plain string", async () => {
    const transport = new FakeTransport([[assistantStringText("It is using JWTs."), successResult("")]]);
    const driver = new ClaudeDriver({ transport });
    await expect(
      driver.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q" }),
    ).resolves.toEqual({ text: "It is using JWTs.", withContext: true });
  });

  it("keeps a reply that reached its turn cap with its answer", async () => {
    const transport = new FakeTransport([[assistantText("JWTs."), errorResult("error_max_turns")]]);
    const driver = new ClaudeDriver({ transport });
    await expect(
      driver.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q" }),
    ).resolves.toEqual({ text: "JWTs.", withContext: true });
  });

  it("takes the run's own result over an interim note before it", async () => {
    const transport = new FakeTransport([[assistantText("Let me see."), successResult("JWTs in auth.ts.")]]);
    const driver = new ClaudeDriver({ transport });
    await expect(
      driver.sideQuestion({ cursor: "s", workingDirectory: "/w", question: "q" }),
    ).resolves.toEqual({ text: "JWTs in auth.ts.", withContext: true });
  });
});

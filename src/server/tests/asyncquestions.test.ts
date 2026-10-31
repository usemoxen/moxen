import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { testHarness } from "../../core/testing/harness.js";
import { ensureStoredProject } from "../../core/projects/projects.js";
import { CodexDriver } from "../../core/providers/codex/driver.js";
import { FakeCodexTransport } from "../../core/providers/codex/tests/fakes.js";
import { readThread } from "../../core/threads/threads.js";
import { openQuestions } from "../../core/threads/views.js";
import { toThreadEnvelope } from "../../core/threads/project.js";
import { DirectConnection } from "../connection.js";

async function setup(failRequests: Record<string, string> = {}) {
  const transport = new FakeCodexTransport({ failRequests });
  const driver = new CodexDriver({ transport });
  const harness = await testHarness({ drivers: { codex: () => driver } });
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers });
  const project = await ensureStoredProject(harness.root, { workspaceRoot: path.resolve(harness.work) });
  await connection.dispatch({ type: "thread.create", threadId: "thread", projectId: project.project.id, title: "Async question", modelSelection: { instanceId: "codex", model: "gpt-test" } });
  await connection.dispatch({ type: "thread.turn.start", threadId: "thread", message: { text: "Research compaction" } });
  await expect.poll(() => transport.sessions[0]?.server.requestsTo("turn/start").length).toBe(1);
  const server = transport.sessions[0]!.server;
  server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "first" } });
  const item = { id: "question", type: "agentMessage", phase: "final_answer", delivery: "async", text: "Which images?\n- All\n- Recent", questions: [{ title: "Which images?", options: ["All", "Recent"] }] };
  server.notify("item/started", { threadId: "codex-thread-1", item });
  server.notify("item/completed", { threadId: "codex-thread-1", item });
  await expect.poll(async () => (await readThread(harness.store, "thread")).activities.some((row) => row.kind === "user-input.requested")).toBe(true);
  const finish = async (nativeId = "first") => {
    server.notify("item/completed", { threadId: "codex-thread-1", item: { type: "agentMessage", id: `answer-${nativeId}`, phase: "final_answer", text: "Research result." } });
    server.notify("turn/completed", { threadId: "codex-thread-1", turn: { id: nativeId, status: "completed" } });
    await expect.poll(async () => (await harness.store.readTurns("thread")).at(-1)?.status).toBe("completed");
  };
  return { transport, driver, harness, connection, server, finish };
}

describe("Codex asynchronous questions", () => {
  it.each(["running", "completed", "restarted"] as const)("delivers a panel answer through the normal turn lifecycle when %s", async (state) => {
    const current = await setup();
    let connection = current.connection;
    let transport = current.transport;
    let driver = current.driver;
    if (state !== "running") {
      await current.finish();
      const read = await readThread(current.harness.store, "thread");
      expect(openQuestions(toThreadEnvelope(read.thread, read.turns, { activities: read.activities }))).toHaveLength(1);
      expect(read.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual(["Research result."]);
    }
    if (state === "restarted") {
      await Effect.runPromise(current.driver.stopAll());
      transport = new FakeCodexTransport();
      driver = new CodexDriver({ transport });
      connection = new DirectConnection({ storeRoot: current.harness.root, drivers: { codex: () => driver } });
    }
    const requestId = "codex-async:codex-thread-1:question";
    const questionId = JSON.stringify(["request_user_input_async", "question", 0]);
    const command = { type: "thread.user-input.respond" as const, threadId: "thread", requestId, answers: { [questionId]: "All" } };
    await Promise.all([connection.dispatch(command), connection.dispatch(command)]);
    const answerMessage = (await current.harness.store.readMessages("thread")).findLast((message) => message.role === "user");
    expect(answerMessage).toMatchObject({ origin: "question-answer", text: "> Which images?\n\nAll" });
    const server = transport.sessions[0]!.server;
    const method = state === "running" ? "turn/steer" : "turn/start";
    await expect.poll(() => server.requestsTo(method).length).toBe(state === "completed" ? 2 : 1);
    const params = server.requestsTo(method).at(-1)!.params as { input: { text: string }[] };
    expect(params.input[0]?.text).toContain(`<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questionId, question: "Which images?", answer: "All" }])}\n</send_user_message_question_reply>`);
    expect((await current.harness.store.readActivities("thread")).filter((row) => row.kind === "user-input.resolved")).toHaveLength(1);
    if (state === "running") await current.finish();
    else {
      server.notify("turn/started", { threadId: "codex-thread-1", turn: { id: "second" } });
      server.notify("item/completed", { item: { type: "agentMessage", id: "continued", text: "Using all images.", phase: "final_answer" } });
      server.notify("turn/completed", { threadId: "codex-thread-1", turn: { id: "second", status: "completed" } });
      await expect.poll(async () => (await current.harness.store.readTurns("thread")).at(-1)?.status).toBe("completed");
    }
    await Effect.runPromise(driver.stopAll());
  });

  it("dismisses a completed-turn question without submitting an answer or starting work", async () => {
    const current = await setup();
    await current.finish();
    await current.connection.dispatch({ type: "thread.user-input.dismiss", threadId: "thread", requestId: "codex-async:codex-thread-1:question" });
    expect(current.server.requestsTo("turn/start")).toHaveLength(1);
    const read = await readThread(current.harness.store, "thread");
    expect(openQuestions(toThreadEnvelope(read.thread, read.turns, { activities: read.activities }))).toEqual([]);
    await Effect.runPromise(current.driver.stopAll());
  });

  it("keeps the question pending when an answer is missing or delivery fails", async () => {
    const failures: Record<string, string> = {};
    const current = await setup(failures);
    const command = { type: "thread.user-input.respond" as const, threadId: "thread", requestId: "codex-async:codex-thread-1:question" };
    await expect(current.connection.dispatch({ ...command, answers: {} })).rejects.toThrow(/Answer every question/);
    failures["turn/steer"] = "No active turn";
    await expect(current.connection.dispatch({ ...command, answers: { [JSON.stringify(["request_user_input_async", "question", 0])]: "All" } })).rejects.toThrow(/still pending/);
    expect((await current.harness.store.readActivities("thread")).some((row) => row.kind === "user-input.resolved")).toBe(false);
    await current.finish();
    await Effect.runPromise(current.driver.stopAll());
  });

  it("records a late async item once when its turn runner has already finished", async () => {
    const current = await setup();
    await current.finish();
    const item = { id: "late", type: "agentMessage", phase: "final_answer", delivery: "async", text: "Which output?", questions: [{ title: "Which output?", options: null }] };
    current.server.notify("item/completed", { threadId: "codex-thread-1", item });
    current.server.notify("item/completed", { threadId: "codex-thread-1", item });
    const late = async () => (await current.harness.store.readActivities("thread")).filter((row) => row.kind === "user-input.requested" && row.payload?.requestId === "codex-async:codex-thread-1:late");
    await expect.poll(late).toHaveLength(1);
    await Effect.runPromise(current.driver.stopAll());
  });
});

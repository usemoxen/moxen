import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import { codexAsyncQuestions } from "../../../core/providers/codex/questions.js";
import { userInputActivityRow } from "../../../core/threads/requestactivity.js";
import { AnswerPanel } from "../../features/answerpanel/answerpanel.js";
import { Timeline } from "../../features/timeline/timeline.js";
import { emptyThreadState, pendingUserInputRequests, timeline } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** The native async item reaches an answerable panel even without a running turn. */
export async function runAsyncQuestions(): Promise<void> {
  const questions = codexAsyncQuestions({ id: "images", delivery: "async", questions: [{ title: "Which images should survive compaction?", options: ["All reference images", "Recent images only"] }] });
  const row = userInputActivityRow({ type: "user-input.request.opened", provider: "codex", threadId: "thread", requestId: "async-images", raw: { delivery: "async", nativeThreadId: "native-thread", questions } })!;
  const state = emptyThreadState();
  state.activities = [{ id: "asked", tone: "info", kind: row.kind, summary: row.summary, payload: row.payload, turnId: "finished-turn", createdAt: "2026-10-31T12:00:00.000Z" }];
  const request = pendingUserInputRequests(state)[0]!;
  const at = "2026-10-31T12:00:01.000Z";
  state.messages = [
    { id: "reply", role: "user", origin: "question-answer", text: "> Which images should survive compaction?\n\nRecent images only", turnId: "reply-turn", streaming: false, createdAt: at, updatedAt: at },
    { id: "continued", role: "assistant", text: "Research result.", turnId: "reply-turn", streaming: false, createdAt: at, updatedAt: at },
  ];
  const groups = groupTurns(timeline(state));
  let selected = "";
  function Host() {
    const [done, setDone] = useState(false);
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return done ? <Timeline groups={groups} title="Async reply" subtitle="" modelForTurn={() => ({ name: "Codex", color: null, provider: "codex" })} modelLabel={(model) => ({ name: model, color: null })} homeDir="" expandedTurn={null} expandedWork={new Map()} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={100} sessionStatus="idle" now={Date.parse(at)} turnStartedAt={null} turnFileDiffs={new Map()} gitFiles={[]} /> : <AnswerPanel question={request.questions[0]!} position={0} total={1} width={95} suspended={false} pickedValues={[]} tabs={[{ header: request.questions[0]!.header, answered: false }]} onGoto={() => {}} onToggleOption={() => {}} onPickOption={(value) => { selected = value; setDone(true); }} onCustom={() => {}} onContinue={() => {}} onDismiss={() => setDone(true)} />;
  }
  const setup = await testRender(<Host />, { width: 100, height: 16, exitOnCtrlC: false });
  try {
    await setup.flush();
    console.log("--- Codex async question: answer panel after turn completion ---");
    const frame = setup.captureCharFrame();
    console.log(frame);
    for (const text of ["Which images should survive compaction?", "All reference images", "Recent images only"]) {
      if (!frame.includes(text)) fail(`async question panel lost ${text}`);
    }
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    if (selected !== "Recent images only") fail("async question options cannot be selected");
    const answered = setup.captureCharFrame();
    if (answered.includes("Which images should survive compaction?") || answered.includes("Recent images only")) fail("answer-panel reply leaked into the conversation");
    if (!answered.includes("Research result.")) fail("hiding the question reply also hid the assistant continuation");
    console.log("--- Codex async question: reply hidden, assistant continuation visible ---");
    console.log(answered);
  } finally {
    setup.renderer.destroy();
  }
}

import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { wasModalJustDismissed } from "../../model/modalDismiss.js";
import { fail, replyHeader } from "../helpers.js";
import { emitLiveRef, userInputRequestedFrame } from "../fixtures.js";

/** The closing reply's message actions, an inline agent question arriving
    live, answering it, the toast-dismiss swallow window, and the reply
    click past that window opening message actions. */
export async function runTimelineAndAnswers(setup: TestRendererSetup): Promise<void> {
  // The assistant's closing reply opens the same modal: back to the top and
  // click the reply card below the prompt.
  await act(async () => setup.mockInput.pressKey("HOME"));
  await setup.flush();
  console.log("--- timeline top (idle) ---");
  console.log(setup.captureCharFrame());

  // Wheel inside the timeline box (not the tasks/composer rows below it)
  // until the closing reply's header scrolls into view, then click it.
  for (let wheel = 0; wheel < 40; wheel += 1) {
    await act(async () => setup.mockMouse.scroll(70, 5, "down"));
    await setup.flush();
    if (/Claude Opus 5\s+·\s+(?:\w{3}, )?\d\d:\d\d/.test(setup.captureCharFrame())) break;
  }
  await setup.flush();
  console.log("--- reply visible ---");
  console.log(setup.captureCharFrame());

  // Clicking the assistant's closing reply opens the same modal (Copy plus
  // Revert, resolved through its turn).
  await act(async () => {
    const header = replyHeader(setup);
    await setup.mockMouse.click(header.x, header.y);
  });
  await setup.flush();
  // ModalShell fades in; look once it is up.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  await setup.flush();
  console.log("--- assistant message actions (open) ---");
  const assistantActions = setup.captureCharFrame();
  console.log(assistantActions);
  // Only a user prompt is a revert point; an agent reply offers Copy alone.
  if (!assistantActions.includes("Copy")) fail("assistant message actions did not open");
  if (assistantActions.includes("Revert")) fail("assistant message actions offer a revert");

  // An agent question arrives mid-run: dismiss the open modal first (pending
  // answers wait for a free UI), then the inline panel replaces the composer.
  await act(async () => setup.mockMouse.click(138, 0));
  await setup.flush();
  await act(async () => {
    emitLiveRef.current?.(userInputRequestedFrame("que_live1"));
  });
  await setup.flush();
  console.log("--- answer panel (inline) ---");
  const inline = setup.captureCharFrame();
  console.log(inline);
  if (!inline.includes("dismisses")) fail("the inline answer panel did not open");

  // Esc is not the panel's: its listener is global, so it would take esc from
  // whichever pane has focus. The × in the header dismisses instead.
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();
  if (!setup.captureCharFrame().includes("dismisses")) fail("esc dismissed the answer panel");
  const lines = setup.captureCharFrame().split("\n");
  const header = lines.findIndex((line) => line.includes("◈") && line.includes("×"));
  if (header === -1) fail("the answer panel has no × in its header");
  await act(async () => setup.mockMouse.click(lines[header]!.lastIndexOf("×"), header));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await setup.flush();
  if (setup.captureCharFrame().includes("dismisses")) fail("clicking × did not dismiss the answer panel");
  console.log("--- answer panel (dismissed with ×) ---");
  // A fresh question for the single-select pick below.
  await act(async () => {
    emitLiveRef.current?.(userInputRequestedFrame("que_live1b"));
  });
  await setup.flush();

  // Single-select: picking the first option submits and restores the composer.
  // The option is found by its label: the panel stands where the composer did, whose height has changed before.
  const optionRows = setup.captureCharFrame().split("\n");
  const forwardRow = optionRows.findIndex((line) => line.includes("1. Forward"));
  if (forwardRow === -1) fail("the single-select question shows no Forward option");
  await act(async () => setup.mockMouse.click(60, forwardRow));
  await setup.flush();
  console.log("--- answer submitted ---");
  console.log(setup.captureCharFrame());

  // Manually dismissing the "Answer submitted" toast marks the same 250ms
  // swallow window as a modal dismiss: the click's mouse-up lands on timeline
  // content instead of the overlay. The toast stack shifts with timing
  // (auto-expiry), so locate the toast's × cell in the live frame instead of
  // hardcoding its row.
  // Let any earlier dismiss window expire, so the toast assertion below
  // proves the × click's own mark rather than a stale one (the 2500ms toast
  // easily survives the wait).
  await new Promise((resolve) => setTimeout(resolve, 350));
  const answerToastRows = setup.captureCharFrame().split("\n");
  const answerToastRow = answerToastRows.findIndex((line) => line.includes("Answer submitted"));
  if (answerToastRow === -1) fail("expected Answer submitted toast");
  const answerToastX = answerToastRows[answerToastRow]?.lastIndexOf("×") ?? -1;
  if (answerToastX === -1) fail("Answer submitted toast has no ×");
  await act(async () => setup.mockMouse.click(answerToastX, answerToastRow));
  await setup.flush();
  if (!wasModalJustDismissed()) fail("toast × did not mark the dismiss window");
  console.log("--- toast dismissed (manual ×) ---");
  const toastDismissedFrame = setup.captureCharFrame();
  console.log(toastDismissedFrame);
  if (toastDismissedFrame.includes("Answer submitted")) fail("toast × did not dismiss");

  // A reply click inside the window is swallowed — no message-actions modal.
  // Assert the window is still held first, so a slow harness reads as a
  // harness failure instead of a false behavior pass.
  if (!wasModalJustDismissed()) fail("harness outran the 250ms dismiss window");
  await act(async () => {
    const header = replyHeader(setup);
    await setup.mockMouse.click(header.x, header.y);
  });
  await setup.flush();
  console.log("--- reply click inside toast-dismiss window (swallowed) ---");
  const swallowedFrame = setup.captureCharFrame();
  console.log(swallowedFrame);
  if (swallowedFrame.includes("Message actions"))
    fail("reply click inside toast-dismiss window opened message actions");

  // Past the window the same click opens message actions.
  await new Promise((resolve) => setTimeout(resolve, 350));
  await act(async () => {
    const header = replyHeader(setup);
    await setup.mockMouse.click(header.x, header.y);
  });
  await setup.flush();
  // The modal fades in over ~150ms: capture mid-fade and the translucent
  // panel composites transcript borders into its title (reads as
  // "Message┃actions"), so let the fade settle before asserting content.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await setup.flush();
  console.log("--- reply click past window (actions open) ---");
  const reopenedFrame = setup.captureCharFrame();
  console.log(reopenedFrame);
  if (!reopenedFrame.includes("Message actions"))
    fail("reply click past window did not open message actions");

  // Backdrop-dismiss restores the closed state the answer flow below expects.
  await act(async () => setup.mockMouse.click(138, 0));
  await setup.flush();

  // A two-question request: tabs name the questions, answering moves on, and
  // either arrow (or a tab click) revisits one with its answer still in place.
  await act(async () => {
    emitLiveRef.current?.(userInputRequestedFrame("que_live2", 2));
  });
  await setup.flush();
  const firstStep = setup.captureCharFrame();
  if (!firstStep.includes("1 Direction") || !/\s2\s/.test(firstStep.split("\n").find((line) => line.includes("1 Direction")) ?? "")) fail("two-question request did not open with a tab per question");
  if (!firstStep.includes("←→ questions")) fail("the hint does not mention the arrows");
  await act(async () => setup.mockInput.pressKey("2"));
  await setup.flush();
  const secondStep = setup.captureCharFrame();
  console.log("--- answer panel (question 2/2) ---");
  console.log(secondStep);
  if (!secondStep.includes("Which direction, step 2?")) fail("answering did not advance to question 2");
  if (!secondStep.split("\n").some((line) => line.includes("1✓") && line.includes("2 Direction 2"))) fail("the answered question's tab has no ✓");
  await act(async () => setup.mockInput.pressArrow("left"));
  await setup.flush();
  const backStep = setup.captureCharFrame();
  console.log("--- answer panel (back on question 1) ---");
  console.log(backStep);
  if (!backStep.includes("Which direction?")) fail("← did not return to question 1");
  if (!/●\s+2\. Sideways/.test(backStep)) fail("going back lost the answer already given");
  await act(async () => setup.mockInput.pressArrow("right"));
  await setup.flush();
  if (!setup.captureCharFrame().includes("Which direction, step 2?")) fail("→ did not move on to question 2");
  // Dismiss so later scenarios start from a clean composer. The panel takes
  // no Escape (its key listener is global), so the × in its header is the way out.
  const frameLines = setup.captureCharFrame().split("\n");
  const headerRow = frameLines.findIndex((line) => line.includes("1✓") && line.includes("2 Direction 2"));
  const closeColumn = headerRow < 0 ? -1 : frameLines[headerRow]!.lastIndexOf("×");
  if (closeColumn < 0) fail("the answer panel has no × to dismiss it");
  await act(async () => setup.mockMouse.click(closeColumn, headerRow));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await setup.flush();
  if (setup.captureCharFrame().includes("Which direction, step 2?")) fail("the × did not dismiss the answer panel");
}

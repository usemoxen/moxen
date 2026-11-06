import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { SIDEBAR_WIDTH } from "../../app/constants.js";
import { fail } from "../helpers.js";

/** Prompt-click message actions: copy, and the revert two-step confirm
    (blocked while running, then succeeding on an idle thread). */
export async function runMessageActions(setup: TestRendererSetup): Promise<void> {
  const frame = () => setup.captureCharFrame();
  // Modals fade in and thread switches resync on their own time, not a
  // fixed delay a loaded renderer overruns (mid-fade the panel composites
  // transcript borders into its rows, garbling label matches).
  const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 5000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    do {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await setup.flush();
      });
      if (predicate()) return frame();
    } while (Date.now() < deadline);
    fail(`${label}:\n${frame()}`);
  };
  // Rows are found by their label, not a fixed row: the modal is centred, so
  // its rows move whenever it gains or loses one.
  // `required` rows fail the walkthrough when missing; the first pass runs
  // wherever the palette scenario left the app, so its rows are best-effort.
  const clickRow = async (label: string, required = false): Promise<void> => {
    const rows = frame().split("\n");
    const y = rows.findIndex((line) => line.includes(label));
    if (y === -1) {
      if (required) {
        console.log(rows.join("\n"));
        fail(`message actions row "${label}" not visible`);
      }
      return;
    }
    await act(async () => setup.mockMouse.click(rows[y]!.indexOf(label) + 2, y));
  };
  // Back to the top of the timeline, then click the user prompt: mouse-up on
  // a PromptBlock (not a selection drag) opens message actions.
  await act(async () => setup.mockInput.pressKey("HOME"));
  await setup.flush();
  await act(async () => setup.mockMouse.click(60, 5));
  await setup.flush();
  console.log("--- message actions (open) ---");
  console.log(setup.captureCharFrame());

  // Copy closes the modal with a toast …
  await clickRow("Copy");
  await setup.flush();
  console.log("--- message copied ---");
  console.log(setup.captureCharFrame());

  // … reopen (past the 250ms dismiss-guard window, which swallows the
  // mouse-up half of a backdrop-dismiss gesture), arm the revert …
  await new Promise((resolve) => setTimeout(resolve, 350));
  await act(async () => setup.mockMouse.click(60, 5));
  await setup.flush();
  await clickRow("Revert to before this turn");
  await setup.flush();
  console.log("--- revert armed ---");
  console.log(setup.captureCharFrame());

  // … and confirm: the turn is still running, so the guard refuses with a
  // toast instead of dispatching (the toast paints above the still-open modal).
  await clickRow("Confirm revert");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await setup.flush();
  console.log("--- revert blocked while running ---");
  console.log(setup.captureCharFrame());

  // Same flow on an idle thread: dismiss the modal via the backdrop first
  // (it stays open on guard failure, so a bare sidebar click would only land
  // on the backdrop), open t-xash from the sidebar, back to the top, and
  // click the prompt again.
  await act(async () => setup.mockMouse.click(138, 0));
  await setup.flush();
  // If the backdrop click missed, the modal is still up and would swallow
  // the sidebar click into its own backdrop instead of switching threads:
  // close it first rather than failing fifteen seconds later at the header.
  if (setup.captureCharFrame().includes("Message actions")) {
    await act(async () => setup.mockMouse.click(138, 0));
    await waitFor("stale message modal did not close", () => !setup.captureCharFrame().includes("Message actions"));
  }
  // Open t-xash from the sidebar: found by the thread's own title, in the
  // sidebar's columns. The project shares its name with nothing here, but a
  // whole-frame search for it matches the thread's first card line, and the
  // thread header only ever shows thread titles — never the project name the
  // old whole-frame search waited for, which could never appear.
  // (The card's first line carries the project title and badge; the second
  // carries the thread title that opens it. Either line's box opens it.)
  const sidebarRows = setup.captureCharFrame().split("\n");
  const xash = sidebarRows.findIndex((line) => line.includes("Neural Radiance") && line.indexOf("Neural Radiance") < SIDEBAR_WIDTH);
  if (xash === -1) fail("the sidebar does not list t-xash");
  await act(async () => setup.mockMouse.click(10, xash));
  // The thread switch resyncs the transcript; wait for the new thread's
  // header rather than a fixed delay. The header shows the thread title
  // (matched loosely: it scrolls longer titles), never the project name.
  // Bound generously: the resync waits on the thread poll tick, which a
  // loaded machine can stall badly.
  const threadHeader = () => {
    const top = frame().split("\n")[0] ?? "";
    return top.split("╮")[1] ?? "";
  };
  await waitFor("sidebar did not open t-xash", () => /Neural|Radiance|viability/.test(threadHeader()), 15000);
  await act(async () => setup.mockInput.pressKey("HOME"));
  await setup.flush();
  await act(async () => setup.mockMouse.click(60, 5));
  // ModalShell fades in; wait for its rows to read cleanly instead of
  // capturing mid-fade, when the composite garbles label matches.
  await waitFor("message actions did not open on t-xash", () => frame().includes("Revert to before this turn"));
  await clickRow("Revert to before this turn", true);
  await setup.flush();
  await clickRow("Confirm revert", true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await setup.flush();
  console.log("--- turn reverted (resynced) ---");
  const reverted = setup.captureCharFrame();
  console.log(reverted);
  // The prompt that was taken back is in the composer, ready to edit and resend.
  if (!reverted.includes("Render **markdown**, plus diffs and commands")) fail("reverted prompt not restored to the composer");

  // Empty it again so the scenarios after this one see the composer as before.
  await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
  await setup.flush();
  if (setup.captureCharFrame().includes("Render **markdown**, plus diffs and commands")) fail("ctrl+c did not clear the restored prompt");
  // Revert hands focus to the composer; give it back to the timeline, and let
  // the clear's toast expire so the next scenario starts from a quiet frame.
  await act(async () => setup.mockInput.pressEscape());
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  await setup.flush();
}

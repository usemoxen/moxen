import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { fail } from "../helpers.js";

/** Thread search from the command palette: type a query, active results sit above settled ones. */
export async function runThreadSearch(setup: TestRendererSetup): Promise<void> {
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();
  for (const char of ["s", "e", "a", "r", "c", "h", " ", "t"]) {
    await act(async () => setup.mockInput.pressKey(char));
    await setup.flush();
  }
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();
  const empty = setup.captureCharFrame();
  console.log("--- thread search (open, empty) ---");
  console.log(empty);
  // The frame shows the thread behind a modal wherever the modal has a space, so match single words.
  if (!empty.includes("Search threads") || !empty.includes("calls.")) fail("the search picker did not open with its prompt");

  for (const char of ["w", "e", "b", "h", "o", "o", "k"]) {
    await act(async () => setup.mockInput.pressKey(char));
    await setup.flush();
  }
  // The query waits out a pause in typing before it is sent.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
  await setup.flush();
  const found = setup.captureCharFrame();
  console.log("--- thread search (results) ---");
  console.log(found);
  const active = found.indexOf("Fix");
  const settled = found.indexOf("Billing");
  if (active < 0 || settled < 0) fail("search results did not list both threads");
  if (!found.includes("Active") || active > settled) fail("active results must come before settled ones");

  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();
}

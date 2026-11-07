import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { CancelAutoContinueModal } from "../../features/queue/cancelmodal.js";
import { testRender } from "../testrender.js";
import { fail } from "../helpers.js";
import { applyTheme } from "../../theme.js";
import { harnessTheme } from "../fixtures.js";

/** Names the frame that follows, after the modal has finished fading in so the picture shows full colour. */
async function label(setup: TestRendererSetup, name: string) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  await setup.flush();
  console.log(`--- ${name} ---`);
}

function peek(setup: TestRendererSetup): string {
  return setup.captureCharFrame();
}

async function until(setup: TestRendererSetup, check: (frame: string) => boolean, message: string) {
  for (let attempt = 0; !check(peek(setup)); attempt += 1) {
    if (attempt === 150) fail(`cancel auto-continue: ${message}\n${peek(setup)}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
}
const visible = (setup: TestRendererSetup, text: string) => until(setup, (screen) => screen.includes(text), `did not show ${text}`);

async function press(setup: TestRendererSetup, name: "enter" | "escape" | "up" | "down") {
  await act(async () => {
    if (name === "enter") setup.mockInput.pressEnter();
    else if (name === "escape") setup.mockInput.pressEscape();
    else setup.mockInput.pressArrow(name);
  });
  await setup.flush();
}

async function open(picks: { notify: number; silent: number; back: number }) {
  const setup = await testRender(
    <CancelAutoContinueModal
      title="Map auth endpoints"
      screenWidth={84}
      screenHeight={30}
      onNotify={() => {
        picks.notify += 1;
      }}
      onSilent={() => {
        picks.silent += 1;
      }}
      onBack={() => {
        picks.back += 1;
      }}
    />,
    { width: 84, height: 30, exitOnCtrlC: false },
  );
  await setup.flush();
  return setup;
}

const must = (screen: string, texts: readonly string[], where: string) => {
  for (const text of texts) if (!screen.includes(text)) fail(`${where}: missing ${text}\n${screen}`);
};

export async function runCancelAutoContinueModal(): Promise<void> {
  if (harnessTheme.current) applyTheme(harnessTheme.current);

  // The modal names the delegated task and leads with notifying the parent.
  const picks = { notify: 0, silent: 0, back: 0 };
  const setup = await open(picks);
  await visible(setup, "Cancel automatic continue?");
  must(peek(setup), ["Map auth endpoints", "Cancel and notify parent", "Cancel without notifying", "Go back"], "cancel modal");
  await label(setup, "cancel auto-continue");
  // The default is notifying: enter takes the first row.
  await press(setup, "enter");
  await until(setup, () => picks.notify === 1, "enter did not pick notifying the parent");
  setup.renderer.destroy();

  // The second row cancels quietly.
  const quiet = { notify: 0, silent: 0, back: 0 };
  const second = await open(quiet);
  await visible(second, "Cancel without notifying");
  await press(second, "down");
  await press(second, "enter");
  await until(second, () => quiet.silent === 1, "down+enter did not pick cancelling quietly");
  if (quiet.notify !== 0) fail("cancel auto-continue: the quiet pick notified the parent");
  second.renderer.destroy();

  // Escape goes back without cancelling either way.
  const back = { notify: 0, silent: 0, back: 0 };
  const third = await open(back);
  await visible(third, "Go back");
  await press(third, "escape");
  await until(third, () => back.back === 1, "escape did not go back");
  if (back.notify !== 0 || back.silent !== 0) fail("cancel auto-continue: going back cancelled the continue");
  third.renderer.destroy();
}

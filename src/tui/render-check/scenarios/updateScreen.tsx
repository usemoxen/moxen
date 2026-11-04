import { act } from "react";

import type { ClientApi, Command, Query, ShellFrame } from "../../../server/api.js";
import type { LinkState } from "../../../server/transport/remote.js";
import type { UpdateCheck, UpdateProgress, UpdateResult } from "../../../core/selfupdate/vocabulary.js";
import { App, client as fixtureClient } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

const CHECK: UpdateCheck = {
  install: { version: "0.1.4", kind: "release", folder: "/apps/moxen", target: { os: "macos", arch: "arm64" } },
  status: "available",
  reason: null,
  latest: { version: "0.2.0", tag: "v0.2.0", url: "https://example.test/v0.2.0", notes: "## Moxen 0.2.0\n\n- The in-app updater.\n- A quieter sidebar.", archive: null, checksum: null },
  updatable: true,
};
const RESULT: UpdateResult = { action: "updated", version: "0.2.0", from: "0.1.4", previous: "0.1.4", folder: "/apps/moxen/versions/0.2.0", current: "/apps/moxen/current", warnings: [] };

/**
 * The update screen driven through the app: opened from the palette, it asks once; an update that runs is
 * reported by the shell subscription (our own command's frames only), survives closing the screen, is not
 * started twice, and a dropped connection is said to be lost rather than failed.
 */
export async function runUpdateScreen(): Promise<void> {
  const checks: number[] = [];
  const commands: Command[] = [];
  const started = () => commands.length;
  let answerCheck: (value: UpdateCheck | Error) => void = () => {};
  let finish: (value: UpdateResult | Error) => void = () => {};
  let emit: (frame: ShellFrame) => void = () => {};
  let link: LinkState = { status: "connected" };
  const listeners = new Set<(state: LinkState) => void>();
  const client = {
    ...fixtureClient,
    get linkState() { return link; },
    onLinkState(listener: (state: LinkState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeShell(options, onItem, onError) {
      const stop = fixtureClient.subscribeShell(options, onItem, onError);
      emit = onItem;
      return stop;
    },
    query: (async (query: Query) => {
      if (query.type !== "app.update.check") return fixtureClient.query(query);
      checks.push(checks.length);
      return await new Promise<UpdateCheck>((resolve, reject) => { answerCheck = (value) => (value instanceof Error ? reject(value) : resolve(value)); });
    }) as ClientApi["query"],
    dispatch: (async (command: Command) => {
      if (command.type !== "app.update.apply" && command.type !== "app.update.rollback") return fixtureClient.dispatch(command);
      commands.push(command);
      return await new Promise<UpdateResult>((resolve, reject) => { finish = (value) => (value instanceof Error ? reject(value) : resolve(value)); });
    }) as ClientApi["dispatch"],
  } as ClientApi;
  const setup = await testRender(<App client={client} onQuit={() => {}} />, { width: 120, height: 40, exitOnCtrlC: false });
  const readFrame = () => setup.captureSpans().lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
  const until = async (check: () => boolean, message: string) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) fail(`${message}\n${readFrame()}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await setup.flush(); });
    }
  };
  const see = (text: string) => until(() => readFrame().includes(text), `missing ${text}`);
  const gone = (text: string) => until(() => !readFrame().includes(text), `still showing ${text}`);
  const press = async (name: string) => { await act(async () => setup.mockInput.pressKey(name)); await setup.flush(); };
  // A bare ESC waits out the key parser's escape-sequence timeout before it is a key.
  const escape = async () => { await act(async () => setup.mockInput.pressEscape()); await act(async () => new Promise((resolve) => setTimeout(resolve, 150))); await setup.flush(); };
  const click = async (text: string) => {
    await see(text);
    const lines = readFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    await act(async () => setup.mockMouse.click(lines[y]!.indexOf(text) + 1, y));
    await setup.flush();
  };
  await see("Ask for changes");
  const openFromPalette = async () => {
    await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
    // Filtered, so the row is on screen whatever the palette's height.
    for (const char of "update moxen") await act(async () => setup.mockInput.pressKey(char));
    await setup.flush();
    await click("Update Moxen");
    await see("Installed");
  };
  const progress = (commandId: string | null, value: UpdateProgress): ShellFrame => ({ kind: "event", event: { type: "app.update-progress", payload: { commandId, progress: value } } });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); await setup.flush(); });

  await openFromPalette();
  await see("Checking for the latest release");
  if (checks.length !== 1) fail("opening the screen did not ask once");
  await settle();
  console.log("--- update screen, checking ---");
  console.log(setup.captureCharFrame());
  await act(async () => answerCheck(CHECK));
  await see("Update to 0.2.0");
  await see("The in-app updater.");
  await see("Nothing restarts by itself");
  console.log("--- update screen, available ---");
  console.log(setup.captureCharFrame());

  // Install: only our own command's frames move the screen.
  await press("u");
  await until(() => commands.length === 1, "the update was not started");
  const commandId = (commands[0] as { commandId?: string }).commandId ?? "";
  if (commandId === "") fail("the update command carried no commandId");
  await press("u");
  if (commands.length !== 1) fail("a second update started while one ran");
  await act(async () => emit(progress("someone-elses", { stage: "testing" })));
  await act(async () => emit(progress(commandId, { stage: "downloading", version: "0.2.0", bytes: 38_000_000, total: 91_000_000 })));
  await see("36.2 MiB / 86.8 MiB");
  if (readFrame().includes("Update to 0.2.0")) fail("an install button was offered while an update ran");
  console.log("--- update screen, downloading ---");
  console.log(setup.captureCharFrame());

  // Closing the screen does not cancel or lose the update.
  await escape();
  await gone("Installed");
  await act(async () => emit(progress(commandId, { stage: "verifying", version: "0.2.0" })));
  await openFromPalette();
  await see("Verifying the download");
  if (checks.length !== 1) fail("reopening the screen during an update asked GitHub again");
  await act(async () => emit(progress(commandId, { stage: "testing", version: "0.2.0" })));
  await see("Starting it to check it works");
  console.log("--- update screen, reopened mid-update at a later stage ---");
  console.log(setup.captureCharFrame());
  await act(async () => finish({ ...RESULT, warnings: ["Could not delete the old version 0.1.2: it is in use."] }));
  await see("Moxen 0.2.0 is installed.");
  await see("Restart the Moxen server to use it");
  await see("Could not delete the old version 0.1.2");
  console.log("--- update screen, finished ---");
  console.log(setup.captureCharFrame());

  // A refusal is shown cleanly and the running version is said to be untouched.
  await press("c");
  await until(() => checks.length === 2, "check again did not ask");
  await act(async () => answerCheck(CHECK));
  await see("Update to 0.2.0");
  await press("u");
  await until(() => commands.length === 2, "the second update was not started");
  const refused = Object.assign(new Error("Another moxen self-update is running. Wait for it to finish, then try again."), { code: "SELF_UPDATE_BUSY" });
  await act(async () => finish(refused));
  await see("Another moxen self-update is running");
  await see("Your running version is untouched");
  if (readFrame().includes("Update to 0.2.0")) fail("a busy refusal offered an immediate retry");
  console.log("--- update screen, another update is running ---");
  console.log(setup.captureCharFrame());

  // Going back is asked twice and a refusal is shown in words.
  await act(async () => setup.mockInput.pressKey("c"));
  await until(() => checks.length === 3, "check again did not ask");
  await act(async () => answerCheck(CHECK));
  await see("Previous version (r)");
  await press("r");
  await see("Press r again to confirm");
  if (started() !== 2) fail("going back started on the first press");
  await press("r");
  await until(() => commands.length === 3 && commands[2]!.type === "app.update.rollback", "the rollback was not started");
  await act(async () => finish(Object.assign(new Error("There is no previous version to go back to."), { code: "SELF_UPDATE_NO_PREVIOUS" })));
  await see("There is no previous version to go back to.");
  console.log("--- update screen, nothing to go back to ---");
  console.log(setup.captureCharFrame());

  // A dropped connection mid-update: lost track, not failed, and a check is offered.
  await press("c");
  await until(() => checks.length === 4, "check again did not ask");
  await act(async () => answerCheck(CHECK));
  await see("Update to 0.2.0");
  await press("u");
  await until(() => commands.length === 4, "the update was not started");
  link = { status: "reconnecting", since: Date.now(), attempts: 1, reason: "connection closed" };
  await act(async () => { for (const listener of listeners) listener(link); });
  await see("Lost track of the update");
  await see("Check again (c)");
  console.log("--- update screen, lost track ---");
  console.log(setup.captureCharFrame());
  link = { status: "connected" };
  await act(async () => { for (const listener of listeners) listener(link); });
  await escape();
  setup.renderer.destroy();
}

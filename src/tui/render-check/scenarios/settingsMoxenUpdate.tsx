import { act, useRef, useState } from "react";

import type { UpdateCheck } from "../../../core/selfupdate/vocabulary.js";
import type { UpdateView } from "../../model/update.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";

const CHECK: UpdateCheck = {
  install: { version: "0.1.4", kind: "release", folder: "/apps/moxen", target: { os: "macos", arch: "arm64" } },
  status: "available",
  reason: null,
  latest: { version: "0.2.0", tag: "v0.2.0", url: "https://example.test/v0.2.0", notes: "## Moxen 0.2.0\n\n- The in-app updater.", archive: { name: "moxen-macos-arm64.tar.gz", url: "https://example.test/dl", size: 91_000_000 }, checksum: null },
  updatable: true,
};
const SOURCE_CHECK: UpdateCheck = {
  ...CHECK,
  install: { ...CHECK.install, kind: "source" },
  updatable: false,
};

/**
 * The General tab's Moxen card: the installed version against the latest
 * available, opening the same update screen the palette opens, over the same
 * state. The screen keeps its own gating (a source checkout or a paired
 * server is shown, not offered an install), so the scenario drives those too.
 */
export async function runSettingsMoxenUpdate(): Promise<void> {
  const opened: string[] = [];
  let answer: (view: UpdateView) => void = () => {};
  let nameServer: (name: string | null) => void = () => {};
  function Harness() {
    const [view, setView] = useState<UpdateView>({ phase: "idle" });
    const [serverName, setServerName] = useState<string | null>(null);
    const latest = useRef(view);
    latest.current = view;
    answer = setView;
    nameServer = setServerName;
    return (
      <SettingsModal
        snapshot={{ path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) }}
        loading={false}
        saving={null}
        error={null}
        onSet={() => {}}
        onDuplicate={() => {}}
        run={null}
        onTest={() => {}}
        onTestMcp={() => {}}
        onProbe={() => {}}
        onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
        onExport={() => {}}
        onImport={() => {}}
        notice={null}
        versions={{
          codex: { ok: true, installed: true, version: "codex-cli 0.164.0", login: "inherit", minVersion: "0.164.0" },
          claude: { ok: true, installed: true, version: "2.1.293 (Claude Code)", login: "inherit", minVersion: "2.1.292" },
          opencode: { ok: true, installed: true, version: "opencode v2.0.24", login: "inherit", minVersion: "2.0.0" },
        }}
        latest={null}
        updating={new Set()}
        onUpdate={() => {}}
        moxenUpdate={{
          view,
          serverName,
          onOpen: () => {
            opened.push("open");
            const phase = latest.current.phase;
            if (phase === "idle" || phase === "ready" || phase === "unreachable") setView({ phase: "checking" });
          },
          onInstall: () => {},
          onRollback: () => {},
          onCheck: () => {},
        }}
        providers={null}
        screenWidth={80}
        screenHeight={34}
        left={2}
        top={1}
        width={76}
        height={32}
        onClose={() => {}}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 80, height: 34, exitOnCtrlC: false });
  const readFrame = () => setup.captureCharFrame();
  const until = async (predicate: () => boolean, message: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) fail(`${message}\n${readFrame()}`);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await setup.flush();
      });
    }
  };
  const see = (text: string) => until(() => readFrame().includes(text), `missing ${text}`);
  const gone = (text: string) => until(() => !readFrame().includes(text), `still showing ${text}`);
  // A bare ESC waits out the key parser's escape-sequence timeout before it is a key.
  const escape = async () => {
    await act(async () => setup.mockInput.pressEscape());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    await setup.flush();
  };
  const click = async (text: string) => {
    await see(text);
    const lines = readFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    await act(async () => setup.mockMouse.click(lines[y]!.indexOf(text) + 1, y));
    await setup.flush();
  };
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 200)));

  await setup.flush();
  await settle();
  await setup.flush();
  const card = readFrame();
  console.log("--- settings page, moxen-update card ---");
  console.log(card);
  // The card's status wraps across rows around the sidebar, so the sentence is matched in halves.
  for (const expected of ["Moxen", "Open the update screen", "newer version.", "[ View update ]", "u updates"]) {
    if (!readFrame().includes(expected)) fail(`the Moxen card is missing "${expected}"`);
  }

  await click("[ View update ]");
  if (opened.join() !== "open") fail(`opening the card did not ask once (${JSON.stringify(opened)})`);
  await see("Update Moxen");
  await see("Checking for the latest release");
  // The modal fades in over ~150ms; capture it settled, not blended with the page beneath.
  await settle();
  await setup.flush();
  console.log("--- settings page, moxen-update screen checking ---");
  console.log(readFrame());

  await act(async () => answer({ phase: "ready", check: CHECK }));
  await see("Update to 0.2.0");
  await see("The in-app updater.");
  await settle();
  await setup.flush();
  console.log("--- settings page, moxen-update screen available ---");
  console.log(readFrame());

  await escape();
  await gone("Release notes");
  await see("0.2.0 is available.");
  if (!readFrame().includes("0.1.4")) fail("the Moxen card lost its installed version after closing the screen");

  // The keyboard way in: u opens the same screen over the same state, without asking again.
  await act(async () => setup.mockInput.pressKey("u"));
  await act(async () => answer({ phase: "ready", check: CHECK }));
  await see("Update to 0.2.0");
  if (opened.join() !== "open,open") fail(`pressing u did not open the update screen (${JSON.stringify(opened)})`);
  await settle();
  await setup.flush();
  console.log("--- settings page, moxen-update reopened with u ---");
  console.log(readFrame());
  await escape();
  await gone("Update to 0.2.0");

  // A source checkout is shown, not offered an install: the screen's own gating.
  // Opening the screen asks again (like the palette's door), so the check is answered a second time.
  await act(async () => answer({ phase: "ready", check: SOURCE_CHECK }));
  await setup.flush();
  await click("[ View update ]");
  await act(async () => answer({ phase: "ready", check: SOURCE_CHECK }));
  await see("source checkout");
  await settle();
  await setup.flush();
  if (readFrame().includes("Update to 0.2.0")) fail("the update screen offered an install for a source checkout");
  console.log("--- settings page, moxen-update source checkout ---");
  console.log(readFrame());
  await escape();
  await gone("source checkout");

  // A paired server's versions are shown where they are updated: on their own machine.
  await act(async () => {
    nameServer("helium");
    answer({ phase: "ready", check: CHECK });
  });
  await setup.flush();
  await click("[ View update ]");
  await act(async () => answer({ phase: "ready", check: CHECK }));
  await see("helium");
  await settle();
  await setup.flush();
  if (!readFrame().includes("not from here") || readFrame().includes("Update to 0.2.0")) fail("the update screen did not gate a paired server to its own machine");
  console.log("--- settings page, moxen-update paired server ---");
  console.log(readFrame());
  await escape();
  await gone("helium");
  setup.renderer.destroy();
}

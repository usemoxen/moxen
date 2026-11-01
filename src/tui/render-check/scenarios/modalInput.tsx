import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import type { ClientApi } from "../../../server/api.js";
import { App, client, emitLiveRef, permissionRequestedFrame, userInputRequestedFrame } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";

async function clickText(setup: TestRendererSetup, text: string): Promise<void> {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  if (y < 0) fail(`modal input: missing ${text}`);
  await act(async () => setup.mockMouse.click(rows[y]!.indexOf(text), y));
  await setup.flush();
}

/** Settings must not answer a question, approve a tool, or change the draft beneath it. */
export async function runModalInput(): Promise<void> {
  for (const kind of ["question", "permission", "composer"] as const) {
    const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
    const isolated: ClientApi = {
      ...client,
      dispatch(command) {
        commands.push(command);
        return client.dispatch(command);
      },
      query: (async (query) => query.type === "settings.read"
        ? { path: "config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) }
        : client.query(query)) as ClientApi["query"],
    };
    const setup = await testRender(<App client={isolated} onQuit={() => {}} launchView="thread" />, {
      width: 140,
      height: 40,
      exitOnCtrlC: false,
    });
    try {
      await setup.flush();
      if (kind === "composer") {
        await act(async () => setup.mockInput.pressKey("i"));
        await act(async () => setup.mockInput.typeText("preserved draft"));
      } else {
        await act(async () => emitLiveRef.current?.(kind === "question"
          ? userInputRequestedFrame("modal-question")
          : permissionRequestedFrame("modal-permission")));
      }
      await setup.flush();
      const expected = kind === "question" ? "1. Forward" : kind === "permission" ? "Do you want to proceed?" : "preserved draft";
      if (!setup.captureCharFrame().includes(expected)) fail(`modal input: ${kind} did not open`);
      await clickText(setup, "⚙ settings");
      // Wait for the modal's fade, not a platform-dependent fixed delay.
      for (let attempt = 0; !setup.captureCharFrame().includes("Unknown folders"); attempt += 1) {
        if (attempt === 100) fail("modal input: Settings did not open");
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
        await setup.flush();
      }
      const before = commands.length;
      for (const key of ["1", "2", "3", "DOWN", "UP", "DOWN"]) {
        await act(async () => setup.mockInput.pressKey(key));
        await setup.flush();
      }
      await act(async () => setup.mockInput.typeText("leaked"));
      await act(async () => setup.mockInput.pressEnter());
      await setup.flush();
      const responses = () => commands.slice(before).filter((command) =>
        command.type === "thread.user-input.respond" || command.type === "thread.permission.respond" || command.type === "thread.turn.start");
      if (responses().length !== 0) fail(`modal input: Settings submitted the ${kind} beneath it`);
      console.log(`--- modal input: Settings over ${kind} ---`);
      console.log(setup.captureCharFrame());

      // Clicking outside closes the whole page even if Enter opened a setting editor.
      await act(async () => setup.mockMouse.click(139, 0));
      await setup.flush();
      const closed = setup.captureCharFrame();
      if (closed.includes("Settings") || !closed.includes(expected)) fail(`modal input: closing Settings lost the ${kind}`);
      if (closed.includes("leaked")) fail("modal input: Settings typed into the composer beneath it");
      await act(async () => setup.mockInput.pressEnter());
      await setup.flush();
      const response = responses()[0];
      if (responses().length !== 1) fail(`modal input: ${kind} did not regain input after closing Settings`);
      if (kind === "question" && (response?.type !== "thread.user-input.respond" || !JSON.stringify(response.answers).includes("Forward"))) {
        fail("modal input: Settings changed the question's highlighted answer");
      }
      if (kind === "permission" && (response?.type !== "thread.permission.respond" || response.decision !== "accept")) {
        fail("modal input: Settings changed the highlighted permission decision");
      }
      if (kind === "composer" && (response?.type !== "thread.turn.start" || response.message.text !== "preserved draft")) {
        fail("modal input: Settings changed the draft");
      }
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }
}

import { act } from "react";
import { testRender } from "../testrender.js";

import type { ClientApi } from "../../../server/api.js";
import type { StoreProblem } from "../../../core/threads/problems.js";
import { App, client } from "../fixtures.js";
import { fail } from "../helpers.js";

/**
 * Bad records warn over the composer with their fixes: one banner for
 * every skipped record and stuck turn, and Details opens each problem
 * with the button that fixes it — move a bad record aside, reset a bad
 * setting, stop a stuck turn.
 */
export async function runProblems(): Promise<void> {
  const ledger: StoreProblem = {
    id: "ledger-line|/store/threads/demo/messages.jsonl|7|demo|",
    kind: "ledger-line",
    threadId: "demo",
    file: "/store/threads/demo/messages.jsonl",
    line: 7,
    message: "Line 7 of /store/threads/demo/messages.jsonl is not valid JSON and was skipped; the rest of the ledger still loads.",
  };
  const stuck: StoreProblem = {
    id: "turn-ownerless|/store/threads/demo/turns.jsonl||demo|turn-9",
    kind: "turn-ownerless",
    threadId: "demo",
    turnId: "turn-9",
    file: "/store/threads/demo/turns.jsonl",
    message: "Turn turn-9 is running but no process owns it, so nothing will ever settle it. Stop the turn.",
  };
  const commands: unknown[] = [];
  const problemsClient = Object.create(client, {
    query: {
      value: (async (query: { type: string }) => {
        if (query.type === "store.problems") return { problems: [ledger, stuck] };
        if (query.type === "config.read") {
          return { path: "/store/config.json", exists: true, config: {}, problems: [{ path: "speedMode", message: "speedMode must be standard or fast." }] };
        }
        return await (client.query as (query: { type: string }) => Promise<unknown>)(query);
      }) as ClientApi["query"],
    },
    dispatch: {
      value: (async (command: unknown) => {
        commands.push(command);
        return { accepted: true };
      }) as ClientApi["dispatch"],
    },
  }) as ClientApi;
  const setup = await testRender(<App client={problemsClient} onQuit={() => {}} launchView="thread" />, { width: 140, height: 34, exitOnCtrlC: false });
  const wait = async (): Promise<void> => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await setup.flush();
  };
  // The label is logged before the capture it names.
  const capture = async (label: string): Promise<string> => {
    console.log(label);
    await wait();
    const frame = setup.captureCharFrame();
    console.log(frame);
    return frame;
  };
  const click = async (frame: string, label: string): Promise<void> => {
    const rows = frame.split("\n");
    const row = rows.findIndex((line) => line.includes(label));
    if (row < 0) fail(`no clickable "${label}"`);
    await act(async () => setup.mockMouse.click(rows[row]!.indexOf(label) + 2, row));
    await wait();
  };
  const warned = await capture("--- problems: banner over the composer ---");
  if (!warned.includes("3 records need attention")) fail("the problems banner does not count the skipped records and stuck turns");
  if (!warned.includes("Details")) fail("the problems banner offers no details");
  await click(warned, "Details");
  const modal = await capture("--- problems: each record with its fix ---");
  for (const expected of ["Records needing attention", "Move aside", "Reset to default", "Stop turn", "speedMode"]) {
    if (!modal.includes(expected)) fail(`the problems modal is missing "${expected}"`);
  }
  await click(modal, "Move aside");
  if (!commands.some((command) => JSON.stringify(command) === JSON.stringify({ type: "store.quarantine", id: ledger.id }))) {
    fail("moving a bad record aside dispatches the wrong command");
  }
  await click(modal, "Reset to default");
  if (!commands.some((command) => JSON.stringify(command) === JSON.stringify({ type: "settings.set", key: "speedMode", value: "" }))) {
    fail("resetting a bad setting dispatches the wrong command");
  }
  await click(modal, "Stop turn");
  if (!commands.some((command) => JSON.stringify(command) === JSON.stringify({ type: "thread.turn.interrupt", threadId: "demo", turnId: "turn-9" }))) {
    fail("stopping a stuck turn dispatches the wrong command");
  }
}

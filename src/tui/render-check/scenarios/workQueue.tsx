import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { ClientApi } from "../../../server/api.js";
import { WorkQueueModal } from "../../features/queue/queuemodal.js";
import type { QueuePolicy } from "../../features/queue/useWorkQueue.js";
import { App, client } from "../fixtures.js";
import { queueFixture } from "../queueFixture.js";
import { testRender } from "../testrender.js";
import { fail } from "../helpers.js";
import { registerSyntaxParsers } from "../../../core/syntax/register.js";

async function visible(setup: TestRendererSetup, text: string) {
  for (let attempt = 0; !setup.captureCharFrame().includes(text); attempt += 1) {
    if (attempt === 100) fail(`work queue did not show ${text}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
}

async function click(setup: TestRendererSetup, text: string) {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  if (y < 0) fail(`work queue: missing ${text}`);
  await act(async () => { await setup.mockMouse.click(rows[y]!.indexOf(text) + 1, y); });
  await setup.flush();
}

export async function runWorkQueueModal(): Promise<void> {
  await registerSyntaxParsers();
  const fixture = queueFixture();
  const setup = await testRender(<WorkQueueModal client={fixture.client} threads={[{ id: "thread-queue", title: "Finish keyboard navigation" }]} screenWidth={116} screenHeight={34} onClose={() => {}} />, { width: 116, height: 34, exitOnCtrlC: false });
  await setup.flush();
  await visible(setup, "Work queue");
  console.log("--- work queue: cross-provider conditions and controls ---");
  const first = setup.captureCharFrame();
  console.log(first);
  for (const text of ["Work queue", "Finish keyboard navigation", "Review the settings changes", "Move up", "Move down", "Removed / stopped", "after allowance resets"]) if (!first.includes(text)) fail(`work queue clipped ${text}`);
  await click(setup, "Select all");
  await click(setup, "Continue here");
  const edits = fixture.commands.filter((command) => command.type === "queue.edit" && command.policy?.continuation === "stored");
  if (edits.length !== 2) fail("work queue did not apply the handoff choice to both selected entries");
  console.log("--- work queue: batch stored handoffs ---");
  console.log(setup.captureCharFrame());
  await click(setup, "Removed / stopped");
  await click(setup, "Add back held");
  if (!fixture.commands.some((command) => command.type === "queue.edit" && command.action === "restore")) fail("removed entries cannot be added back");

  const submitted: QueuePolicy[] = [];
  const schedule = await testRender(<WorkQueueModal client={fixture.client} threads={[]} screenWidth={84} screenHeight={28} onClose={() => {}} onSchedule={(policy) => submitted.push(policy)} />, { width: 84, height: 28, exitOnCtrlC: false });
  await schedule.flush();
  await visible(schedule, "Schedule work");
  await click(schedule, "+ Add condition");
  await click(schedule, "Queue this work");
  if (submitted[0]?.conditions[0]?.type !== "reset") fail("conditional scheduling did not preserve a quota-reset condition");
  console.log("--- work queue: scheduling after quota reset ---");
  console.log(schedule.captureCharFrame());

  const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
  const isolated: ClientApi = { ...client, dispatch(command) { commands.push(command); return client.dispatch(command); } };
  const creation = await testRender(<App client={isolated} onQuit={() => {}} launchView="create" />, { width: 140, height: 40, exitOnCtrlC: false });
  await creation.flush();
  await visible(creation, "Build");
  await act(async () => creation.mockInput.pressKey("i"));
  await creation.flush();
  await act(async () => creation.mockInput.typeText("/research Scheduled new thread task"));
  await creation.flush();
  await visible(creation, "Scheduled new thread task");
  await act(async () => creation.mockInput.pressKey("p", { ctrl: true }));
  await creation.flush();
  await visible(creation, "Schedule work");
  console.log("--- work queue: new-thread command palette ---");
  const palette = creation.captureCharFrame();
  console.log(palette);
  for (const text of ["Work queue", "Schedule work", "Schedule message"]) if (!palette.includes(text)) fail(`new-thread palette is missing ${text}`);
  await click(creation, "Schedule work");
  await visible(creation, "+ Add condition");
  await click(creation, "+ Add condition");
  await click(creation, "Queue this work");
  await creation.flush();
  const start = commands.find((command) => command.type === "thread.turn.start");
  if (!commands.some((command) => command.type === "thread.create") || start?.type !== "thread.turn.start" || start.queue?.conditions[0]?.type !== "reset" || start.interactionMode !== "research" || start.message.text !== "Scheduled new thread task") fail("new-thread scheduling lost its conditions or one-off mode");
}

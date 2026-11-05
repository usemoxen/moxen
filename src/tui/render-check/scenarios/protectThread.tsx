import { act } from "react";
import { testRender } from "../testrender.js";

import type { TurnUsagePause } from "../../../core/types.js";
import type { ClientApi } from "../../../server/api.js";
import { QueuedPanel } from "../../features/queuedpanel/queuedpanel.js";
import { Timeline } from "../../features/timeline/timeline.js";
import { queuedLabel, type QueuedMessage, type TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { App, client, emitShellRef, originalShellSnapshot } from "../fixtures.js";
import { fail } from "../helpers.js";

/**
 * MXN-246. `/protect` typed in the composer dispatches `thread.protect` and
 * the thread then says it is held, whether the user forced it and how many
 * wake-ups wait; a turn the hold cut off closes on a marker that names the
 * user, not a window; and a queued provider notification reads as a label,
 * not its raw payload.
 */
export async function runProtectThread(): Promise<void> {
  await runProtectCommand();
  await runForcedMarker();
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>, ms = 200): Promise<string> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await setup.flush();
  return setup.captureCharFrame();
}

async function runProtectCommand(): Promise<void> {
  const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
  const opening = originalShellSnapshot() as { snapshot?: { threads?: Array<Record<string, unknown>> }; threads?: Array<Record<string, unknown>> };
  const threads = opening.snapshot?.threads ?? opening.threads ?? [];
  const open = threads.find((candidate) => candidate["id"] === "t-xash");
  if (open === undefined) fail("protect scenario: the fixture's open thread is missing");
  // Answering the command the way the server does: the thread now carries its hold.
  const protecting = Object.create(client, {
    dispatch: {
      value: async (command: Parameters<ClientApi["dispatch"]>[0]) => {
        commands.push(command);
        if (command.type === "thread.protect") {
          emitShellRef.current?.({ thread: { ...open, protection: { protected: true, forced: true, waitingWakeUps: 2 } } });
        }
        return { accepted: true };
      },
    },
  }) as ClientApi;
  const setup = await testRender(<App client={protecting} onQuit={() => {}} launchView="thread" />, { width: 140, height: 34, exitOnCtrlC: false });
  await settle(setup, 400);
  // Focus the composer by its placeholder, wherever the layout puts it.
  const rows = setup.captureCharFrame().split("\n");
  const placeholder = rows.findIndex((row) => row.includes("Message the agent"));
  if (placeholder < 0) fail("protect scenario: the composer is not on screen");
  await act(async () => setup.mockMouse.click(rows[placeholder]!.indexOf("Message the agent"), placeholder));
  await setup.flush();
  for (const char of "/protect") await act(async () => setup.mockInput.pressKey(char));
  await setup.flush();
  console.log("--- protect: /protect typed ---");
  console.log(setup.captureCharFrame());
  // The first enter may pick the command from the `/` list; the next sends it.
  for (let attempt = 0; attempt < 3 && !commands.some((command) => command.type === "thread.protect"); attempt += 1) {
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup, 100);
  }
  const frame = await settle(setup, 300);
  console.log("--- protect: thread held (forced, 2 waiting) ---");
  console.log(frame);
  const protect = commands.filter((command) => command.type === "thread.protect");
  if (protect.length !== 1 || protect[0]!.threadId !== open["id"]) fail(`/protect dispatched ${JSON.stringify(commands.map((command) => command.type))}`);
  if (commands.some((command) => command.type === "thread.turn.start")) fail("/protect was also sent to the agent as a message");
  for (const expected of ["Thread protected by you", "2 wake-ups waiting", "Send a message to end it"]) {
    if (!frame.includes(expected)) fail(`the protected thread does not show "${expected}"`);
  }
}

const at = "2026-11-03T17:00:00.000Z";
const entry = (fields: Partial<TimelineEntry> & Pick<TimelineEntry, "id" | "kind" | "text">): TimelineEntry =>
  ({ at, turnId: "p1", streaming: false, tone: null, activityKind: null, message: null, activity: null, checkpoint: null, editStats: null, proposedPlan: null, ...fields }) as TimelineEntry;

async function runForcedMarker(): Promise<void> {
  const forced: TurnUsagePause = { provider: "claude", windows: [], resetsAt: null, pausedAt: "2026-11-03T17:05:00.000Z", hasUncommittedChanges: true, forced: true };
  const noop = () => {};
  for (const width of [100, 44]) {
    const setup = await testRender(
      <Timeline groups={groupTurns([entry({ id: "u", kind: "user", text: "Refactor the retry runner." }), entry({ id: "a", kind: "assistant", at: "2026-11-03T17:04:00.000Z", text: "Moved the backoff into its own module." })])}
        title="Retry logic" subtitle="idle" modelForTurn={() => ({ name: "Claude Opus 5", color: null })} usagePauseForTurn={() => forced}
        modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map()} scrollRef={{ current: null }}
        onFocus={noop} onOpenDiff={noop} onToggleWork={noop} onOpenMessageActions={noop} onOpenUrl={noop} focused width={width}
        sessionStatus="idle" now={Date.UTC(2026, 10, 3, 18, 0)} turnStartedAt={null} turnFileDiffs={new Map()} gitFiles={[]} />,
      { width: width + 2, height: 24, exitOnCtrlC: false },
    );
    const frame = await settle(setup);
    console.log(`--- protect: forced pause marker, ${width} wide ---`);
    console.log(frame);
    const flat = frame.replace(/[┃\s]+/gu, " ");
    for (const expected of ["Protected by you", "You protected this thread", "Sending a message ends the hold", "uncommitted changes"]) {
      if (!flat.includes(expected)) fail(`the forced marker at ${width} columns is missing "${expected}"`);
    }
    for (const wrong of ["resets", "ran low", "Paused by usage protection"]) {
      if (flat.includes(wrong)) fail(`the forced marker still says "${wrong}"`);
    }
  }
  const raw = '{"task_id":"b1","status":"completed"}';
  const items: readonly QueuedMessage[] = [
    { turnId: "q1", messageId: "m1", text: raw, attachments: 0, scheduledFor: null, reason: "usage-hold", background: true },
    { turnId: "q2", messageId: "m2", text: "Then open the PR", attachments: 0, scheduledFor: null, reason: "usage-hold" },
  ];
  if (queuedLabel(items[0]!) !== "Background task finished") fail("a background notification is not labelled in the queue");
  const queue = await testRender(<QueuedPanel items={items} width={70} now={Date.parse(at)} onCancel={noop} />, { width: 72, height: 8, exitOnCtrlC: false });
  const frame = await settle(queue, 50);
  console.log("--- protect: queued background notification ---");
  console.log(frame);
  if (!frame.includes("Background task finished") || frame.includes("task_id")) fail("the queue dumps a background notification's raw payload");
}

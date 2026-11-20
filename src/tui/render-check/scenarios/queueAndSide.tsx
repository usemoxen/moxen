import { act } from "react";
import { testRender } from "../testrender.js";

import { QueuedPanel } from "../../features/queuedpanel/queuedpanel.js";
import { SELF_QUEUED_HEADER } from "../../../core/threads/views.js";
import { SideQuestionModal } from "../../features/btw/sidequestionmodal.js";
import type { SideQuestion } from "../../features/btw/useSideQuestion.js";
import type { QueuedMessage } from "../../model/thread.js";
import { Pager } from "../../ui/noticebanner.js";
import { fail } from "../helpers.js";

/**
 * The Queued panel and the `/btw` answer.
 *
 * Queued: messages the agent has not been sent, in send order, each saying
 * when it goes and with a way to take it back; the pager shows when Tasks
 * shares the slot. Side question: the answer, and — the part that matters
 * — that it never reached the thread.
 */
export async function runQueueAndSide(): Promise<void> {
  await runQueued();
  await runQueuedNarrow();
  await runSide();
}

const NOW = Date.parse("2026-09-26T10:00:00.000Z");

const ITEMS: readonly QueuedMessage[] = [
  { turnId: "t1", messageId: "m1", text: "Also update the changelog", attachments: 0, scheduledFor: null, reason: null },
  { turnId: "t2", messageId: "m2", text: "Run the full suite after", attachments: 1, scheduledFor: "2026-09-26T12:00:00.000Z", reason: "user" },
  { turnId: "t3", messageId: "m3", text: "Then open the PR", attachments: 0, scheduledFor: "2026-09-26T15:01:00.000Z", reason: "usage-hold", conditions: [
    { type: "reset", provider: "claude", window: "weekly", resetsAt: null },
    { type: "usage", provider: "claude", window: "session", minimum: 10 },
  ] },
  // An agent's own queued message: the row marks it as the agent's and shows what it wrote, not the header line.
  { turnId: "t4", messageId: "m4", text: `${SELF_QUEUED_HEADER}\n\nRecheck the nightly build`, attachments: 0, scheduledFor: null, reason: null, agent: true },
  // A condition is not "after this turn": the row says what the entry actually waits for.
  { turnId: "t5", messageId: "m5", text: "Verify the release after the reset", attachments: 0, scheduledFor: null, reason: null, conditions: [{ type: "reset", provider: "claude", window: "session", resetsAt: null }] },
  // A manual hold with no condition of its own, and a usage hold with two conditions.
  { turnId: "t6", messageId: "m6", text: "Held until I say so", attachments: 0, scheduledFor: null, reason: null, held: true },
];

async function runQueued(): Promise<void> {
  const cancelled: string[] = [];
  const paged: number[] = [];
  const setup = await testRender(
    <box style={{ width: 90, height: 12, flexDirection: "column" }}>
      <QueuedPanel
        items={ITEMS}
        width={90}
        now={NOW}
        onCancel={(turnId) => cancelled.push(turnId)}
        pager={<Pager position={0} count={2} onPage={(next) => paged.push(next)} />}
      />
    </box>,
    { width: 92, height: 14, exitOnCtrlC: false },
  );
  await setup.flush();
  const frame = setup.captureCharFrame();
  console.log("--- queued panel ---");
  console.log(frame);
  for (const expected of [
    "Queued",
    "6 not sent yet, 1 of them held for the reset",
    "1. Also update the changelog",
    "after this turn",
    "+1 image",
    "1/2",
    "agent · Recheck the nightly build",
    "After Claude's next session reset",
    "Held until I say so",
    "held",
    "2 conditions",
  ]) {
    if (!frame.includes(expected)) fail(`queued panel is missing "${expected}"`);
  }
  // Send order: the ungated one first, then by time.
  if (frame.indexOf("Also update") > frame.indexOf("Then open the PR")) fail("queued panel lists messages out of send order");

  const rows = frame.split("\n");
  const second = rows.findIndex((row) => row.includes("Run the full suite"));
  await act(async () => setup.mockMouse.click(rows[second]!.lastIndexOf("×"), second));
  await setup.flush();
  if (cancelled.join() !== "t2") fail(`cancelling a queued message took back ${JSON.stringify(cancelled)}`);

  const header = rows.findIndex((row) => row.includes("1/2"));
  await act(async () => setup.mockMouse.click(rows[header]!.indexOf("›"), header));
  await setup.flush();
  if (paged.join() !== "1") fail(`paging the dock went to ${JSON.stringify(paged)}`);
}

function entry(overrides: Partial<SideQuestion>): SideQuestion {  return {
    id: 1,
    threadId: "t",
    question: "Which auth scheme did we settle on?",
    status: "answered",
    answer: "JWTs, verified in src/auth.ts.",
    error: null,
    withContext: true,
    ...overrides,
  };
}

/** A narrow panel: the agent's marker and the state stay separate, and many conditions become a bounded count. */
async function runQueuedNarrow(): Promise<void> {
  const items: readonly QueuedMessage[] = [
    {
      turnId: "n1", messageId: "n1", text: `${SELF_QUEUED_HEADER}\n\nRecheck the build after the reset`, attachments: 0, scheduledFor: null, reason: null, agent: true,
      conditions: [
        { type: "reset", provider: "claude", window: "session", resetsAt: null },
        { type: "usage", provider: "claude", window: "session", minimum: 40 },
        { type: "thread", threadId: "thread-other" },
      ],
    },
    {
      turnId: "n2", messageId: "n2", text: "Verify the release", attachments: 0, scheduledFor: "2026-09-26T12:00:00.000Z", reason: "user",
      conditions: [
        { type: "reset", provider: "claude", window: "weekly", resetsAt: null },
        { type: "usage", provider: "claude", window: "session", minimum: 10 },
      ],
    },
    { turnId: "n3", messageId: "n3", text: "Held for me", attachments: 0, scheduledFor: null, reason: null, held: true },
    {
      turnId: "n4", messageId: "n4", text: "Usage-held release", attachments: 0, scheduledFor: "2026-09-26T17:01:00.000Z", reason: "usage-hold",
      conditions: [
        { type: "reset", provider: "claude", window: "weekly", resetsAt: null },
        { type: "usage", provider: "claude", window: "session", minimum: 10 },
      ],
    },
  ];
  const setup = await testRender(
    <box style={{ width: 64, height: 8, flexDirection: "column" }}>
      <QueuedPanel items={items} width={64} now={NOW} onCancel={() => {}} threads={[{ id: "thread-other", title: "Re-review" }]} />
    </box>,
    { width: 64, height: 9, exitOnCtrlC: false },
  );
  await setup.flush();
  const frame = setup.captureCharFrame();
  console.log("--- queued panel narrow ---");
  console.log(frame);
  for (const expected of ["agent · Recheck the build", "3 conditions", "2 conditions", "held", "◷"]) {
    if (!frame.includes(expected)) fail(`narrow queued panel is missing "${expected}"`);
  }
  if (frame.includes("After Claude's next session reset")) fail("narrow queued panel did not bound its condition list");
  if (frame.split("\n").find((row) => row.includes("Recheck the build"))?.includes("n1") === true) fail("narrow queued panel shows an internal id");
}

async function runSide(): Promise<void> {
  const copied: string[] = [];
  const setup = await testRender(
    <SideQuestionModal
      entry={entry({})}
      onCopy={(text) => copied.push(text)}
      screenWidth={80}
      screenHeight={20}
      left={4}
      top={2}
      width={72}
      height={14}
      onClose={() => {}}
    />,
    { width: 80, height: 20, exitOnCtrlC: false },
  );
  await setup.flush();
  // ModalShell fades in; capture after it.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const frame = setup.captureCharFrame();
  console.log("--- side question (answered) ---");
  console.log(frame);
  for (const expected of ["Side question", "/btw Which auth scheme", "JWTs, verified in src/auth.ts.", "Not added to the thread", "copy"]) {
    if (!frame.includes(expected)) fail(`side question modal is missing "${expected}"`);
  }
  await act(async () => setup.mockInput.pressKey("c"));
  await setup.flush();
  if (copied.join() !== "JWTs, verified in src/auth.ts.") fail("c did not copy the side answer");

  const bare = await testRender(
    <SideQuestionModal
      entry={entry({ status: "answered", withContext: false, answer: "No context." })}
      onCopy={() => {}}
      screenWidth={80}
      screenHeight={20}
      left={4}
      top={2}
      width={72}
      height={14}
      onClose={() => {}}
    />,
    { width: 80, height: 20, exitOnCtrlC: false },
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await bare.flush();
  if (!bare.captureCharFrame().includes("No thread context")) fail("side answer without a session does not say it lacked context");
}

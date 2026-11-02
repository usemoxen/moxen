import { act, useState } from "react";
import { testRender } from "../testrender.js";

import { NoticeBanner, type Notice } from "../../ui/noticebanner.js";
import { COLOR } from "../../theme.js";
import { fail } from "../helpers.js";
import { usageProtectionNotices } from "../../model/usageprotection.js";

/**
 * Two notices over the composer share one slot: the first shows with a
 * "1/2" pager, and › moves to the second. One alone shows no pager. In a
 * narrow pane (sidebar and a side panel open) the actions drop to their own
 * row instead of running off the edge, pager and all.
 */
export async function runNoticeBanner(): Promise<void> {
  const notice = (key: string, title: string, action: string): Notice => ({
    key,
    glyph: "◔",
    glyphColor: COLOR.danger,
    title,
    detail: <text fg={COLOR.dim}>{`  about ${key}`}</text>,
    actions: [{ label: action, fg: COLOR.accent, onClick: () => {} }],
  });
  const both = [notice("usage", "Usage limit reached", "Continue at reset"), notice("resume", "Resume with less context", "Compact")];
  let setNotices: ((next: Notice[]) => void) | null = null;
  function Harness() {
    const [notices, set] = useState<Notice[]>(both);
    const [index, setIndex] = useState(0);
    setNotices = set;
    return <NoticeBanner notices={notices} index={index} onPage={setIndex} width={100} />;
  }
  const setup = await testRender(<Harness />, { width: 100, height: 5, exitOnCtrlC: false });
  await setup.flush();
  const first = setup.captureCharFrame();
  console.log("--- notice banner: first of two ---");
  console.log(first);
  if (!first.includes("Usage limit reached") || !first.includes("1/2")) fail("notice banner does not page two notices");
  if (first.includes("Resume with less context")) fail("notice banner stacks notices instead of paging them");
  const rows = first.split("\n");
  const row = rows.findIndex((line) => line.includes("1/2"));
  await act(async () => setup.mockMouse.click(rows[row]!.indexOf("1/2") + 5, row));
  await setup.flush();
  const second = setup.captureCharFrame();
  if (!second.includes("Resume with less context") || !second.includes("2/2")) fail("› did not page to the second notice");

  await act(async () => setNotices?.([both[0]!]));
  await setup.flush();
  if (setup.captureCharFrame().includes("1/1")) fail("a lone notice shows a pager");

  const usage: Notice = {
    ...both[0]!,
    tags: [{ text: "Session limit", color: COLOR.dim }],
    actions: [
      { label: "Continue at reset", fg: COLOR.accent, onClick: () => {} },
      { label: "In a new thread", fg: COLOR.accent, onClick: () => {} },
      { label: "Dismiss", fg: COLOR.dim, onClick: () => {} },
    ],
  };
  function Narrow() {
    const [index, setIndex] = useState(0);
    return <NoticeBanner notices={[usage, both[1]!]} index={index} onPage={setIndex} width={60} />;
  }
  const narrow = await testRender(<Narrow />, { width: 60, height: 6, exitOnCtrlC: false });
  await narrow.flush();
  const tight = narrow.captureCharFrame();
  console.log("--- notice banner: narrow pane ---");
  console.log(tight);
  if (!tight.includes("Dismiss") || !tight.includes("In a new thread") || !tight.includes("1/2")) fail("a narrow notice banner cut off its actions or pager");
  if (tight.split("\n").some((line) => line.includes("Usage limit reached") && line.includes("Continue at reset"))) fail("a narrow notice banner kept its actions beside the title");
  // No destroy(), as in bootGate: tearing down a second renderer breaks the shared one.
  const commands: unknown[] = [];
  const now = Date.parse("2026-11-01T10:00:00Z");
  const protection = usageProtectionNotices({
    forecasts: [{ provider: "codex", windowId: "session", label: "Session", usedPercent: 94, resetsAt: "2026-11-01T11:12:00Z", remainingWorkMs: 360_000, reservePercent: 4, shouldWrap: true, running: 2, costSource: "estimated", wrapCostUsd: 0.4 }],
    queue: [{ provider: "codex", threadId: "held", title: "Finish keyboard navigation", phase: "waiting", order: 1, resetsAt: "2026-11-01T11:12:00Z", handoff: false }],
  }, (command) => commands.push(command), now);
  function Protection() {
    const [index, setIndex] = useState(0);
    return <NoticeBanner notices={protection} index={index} onPage={setIndex} width={80} />;
  }
  const guarded = await testRender(<Protection />, { width: 80, height: 7, exitOnCtrlC: false });
  await guarded.flush();
  console.log("--- usage protection: forecast and manual wrap-up ---");
  const forecast = guarded.captureCharFrame();
  console.log(forecast);
  if (!forecast.includes("94%") || !forecast.includes("6 min") || !forecast.includes("72 min")) fail("usage protection forecast lost its estimates");
  const forecastRows = forecast.split("\n");
  const actionRow = forecastRows.findIndex((line) => line.includes("Wrap up all"));
  await act(async () => guarded.mockMouse.click(forecastRows[actionRow]!.indexOf("Wrap up all") + 2, actionRow));
  if (JSON.stringify(commands[0]) !== JSON.stringify({ type: "usage.wrap", provider: "codex" })) fail("manual wrap-up targets the wrong provider");
  const pagerRow = forecastRows.findIndex((line) => line.includes("1/2"));
  await act(async () => guarded.mockMouse.click(forecastRows[pagerRow]!.indexOf("1/2") + 5, pagerRow));
  await guarded.flush();
  console.log("--- usage protection: durable recovery queue ---");
  const held = guarded.captureCharFrame();
  console.log(held);
  if (!held.includes("Move first") || !held.includes("Move last") || !held.includes("Cancel recovery")) fail("usage queue controls are clipped");
}

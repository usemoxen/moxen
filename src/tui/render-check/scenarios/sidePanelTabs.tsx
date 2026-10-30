import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "../testrender.js";

import { Composer } from "../../features/composer/composer.js";
import { DiffPanel } from "../../features/diffpanel/diffpanel.js";
import { AgentsTab, ContextTab, InfoTab, SidePanelFrame, SideTabBar } from "../../features/sidepanel/sidepanel.js";
import type { SideTab } from "../../model/sidepanel.js";
import { fail } from "../helpers.js";

/**
 * The side panel's Agents and Context tabs, and the composer's plan-usage
 * gauges, on their own render (the shared walkthrough covers opening the
 * panel from the app and the Background tab). Agents lists delegated
 * threads with their state (a click opens one), then the provider's own
 * subagents; Context shows the window as a stacked bar with its categories,
 * then the plan's usage windows with reset times.
 */
export async function runSidePanelTabs(): Promise<void> {
  const now = Date.parse("2026-09-25T10:00:00.000Z");
  let showTab: ((tab: SideTab) => void) | null = null;
  const opened: string[] = [];
  const stopped: string[] = [];
  function Harness() {
    const [tab, setTab] = useState<SideTab>("agents");
    showTab = setTab;
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <box style={{ width: 60, height: 30, flexDirection: "column" }}>
        <SideTabBar tab={tab} badges={{ agents: "1", context: "42%" }} onTab={setTab} onClose={() => {}} />
        <SidePanelFrame width={60} focused scrollRef={scrollRef} onFocus={() => {}}>
          {tab === "agents" ? (
            <AgentsTab
              threads={[
                {
                  threadId: "child-1",
                  title: "Audit the routes",
                  status: "running",
                  model: "GPT-5.5",
                  startedAt: new Date(now - 125_000).toISOString(),
                  outcome: null,
                },
                { threadId: "child-2", title: "Scout the tests", status: "active", model: "Claude Sonnet 5", startedAt: null, outcome: "completed" },
              ]}
              subagents={[
                {
                  agentId: "a2",
                  agentType: "Plan",
                  description: "Plan the route audit fixes",
                  running: true,
                  lastMessage: null,
                  at: new Date(now - 42_000).toISOString(),
                  stoppedAt: null,
                },
                {
                  agentId: "a1",
                  agentType: "Explore",
                  description: "Count TODO comments in src",
                  running: false,
                  lastMessage: "Found 3 call sites",
                  at: "2026-09-25T09:59:00.000Z",
                  stoppedAt: "2026-09-25T09:59:14.000Z",
                },
              ]}
              now={now}
              onOpen={(threadId) => opened.push(threadId)}
              onStopSubagent={(agentId) => stopped.push(agentId)}
            />
          ) : (
            <ContextTab
              breakdown={{
                usedTokens: 84_000,
                maxTokens: 200_000,
                cachedInputTokens: null,
                compactsAutomatically: true,
                autoCompactThreshold: 167_000,
                estimated: false,
                categories: [
                  { name: "Messages", tokens: 60_000, kind: "used" },
                  { name: "System prompt", tokens: 24_000, kind: "used" },
                  { name: "Free space", tokens: 83_000, kind: "free" },
                  { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
                ],
                tools: [
                  { name: "Bash", tokens: 29_000 },
                  { name: "Read", tokens: 12_400 },
                  { name: "delegate", tokens: 900 },
                ],
              }}
              fallback={null}
              live
              usageLimits={{
                checkedAt: "2026-09-25T09:58:00.000Z",
                windows: [
                  { id: "session", kind: "session", label: "Session", usedPercent: 42, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
                  { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 91, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
                ],
                unavailable: null,
              }}
              providerName="Claude"
              width={60}
              now={now}
            />
          )}
        </SidePanelFrame>
      </box>
    );
  }
  const setup = await testRender(<Harness />, { width: 62, height: 32, exitOnCtrlC: false });
  await setup.flush();
  const agents = setup.captureCharFrame();
  console.log("--- side panel: agents tab ---");
  console.log(agents);
  for (const expected of ["Agents 1", "Context 42%", "Delegated threads", "Audit the routes", "2m 5s", "GPT-5.5", "Scout the tests", "done", "Explore · Count TODO comments in src", "done in 14s", "Plan · Plan the route audit fixes", "42s", "Found 3 call sites"]) {
    if (!agents.includes(expected)) fail(`agents tab is missing "${expected}"`);
  }
  const rows = agents.split("\n");
  const openRow = rows.findIndex((row) => row.includes("GPT-5.5"));
  await act(async () => setup.mockMouse.click(rows[openRow]!.indexOf("GPT-5.5") + 1, openRow));
  await setup.flush();
  if (opened[0] !== "child-1") fail("clicking a delegated thread did not open that thread");

  // Only the running subagent offers a stop, and it stops that one.
  const stopRows = rows.flatMap((row, y) => (/\bstop\b/.test(row) ? [y] : []));
  if (stopRows.length !== 1) fail(`expected one subagent stop action, found ${stopRows.length}`);
  await act(async () => setup.mockMouse.click(rows[stopRows[0]!]!.indexOf("stop") + 1, stopRows[0]!));
  await setup.flush();
  if (stopped.join() !== "a2") fail("clicking stop did not stop the running subagent");

  await act(async () => showTab?.("context"));
  await setup.flush();
  const context = setup.captureCharFrame();
  console.log("--- side panel: context tab ---");
  console.log(context);
  for (const expected of ["Context usage", "84k / 200k", "42%", "Messages", "System prompt", "Free space", "Auto-compacts at 167k · 83k to go", "Heaviest tools", "Plan usage", "Session", "Weekly", "91%", "↻ 2h"]) {
    if (!context.includes(expected)) fail(`context tab is missing "${expected}"`);
  }
  // Each tool is one row, and every bar ends on the same column.
  const toolRows = context.split("\n").filter((row) => /│ (Bash|Read|delegate) /.test(row));
  if (toolRows.length !== 3) fail(`heaviest tools should be one row each, found ${toolRows.length}`);
  if (new Set(toolRows.map((row) => row.lastIndexOf("░") === -1 ? row.lastIndexOf("█") : row.lastIndexOf("░"))).size !== 1) {
    fail("heaviest tool bars do not end on the same column");
  }

  // A delegated thread's tab is Info: the task, who asked, where the work is.
  const infoOpened: string[] = [];
  function InfoHarness() {
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <box style={{ width: 60, height: 20, flexDirection: "column" }}>
        <SideTabBar tab="agents" badges={{}} onTab={() => {}} onClose={() => {}} agentsLabel="Info" />
        <SidePanelFrame width={60} focused scrollRef={scrollRef} onFocus={() => {}}>
          <InfoTab
            info={{
              task: "Audit the routes and list the ones missing auth.",
              parent: { threadId: "parent-1", title: "Harden the API" },
              status: "running",
              outcome: null,
              startedAt: new Date(now - 65_000).toISOString(),
              model: "Sonnet 5.5",
              branch: "moxen/audit-routes",
              worktreePath: "~/.moxen/threads/worktrees/df0ea54d-2cde-4255-8389-afb07b867a83",
            }}
            now={now}
            onOpen={(threadId) => infoOpened.push(threadId)}
          />
        </SidePanelFrame>
      </box>
    );
  }
  const infoSetup = await testRender(<InfoHarness />, { width: 62, height: 22, exitOnCtrlC: false });
  await infoSetup.flush();
  const info = infoSetup.captureCharFrame();
  console.log("--- side panel: info tab (delegated thread) ---");
  console.log(info);
  for (const expected of ["Info", "Delegated task", "running 1m 5s", "Sonnet 5.5", "Harden the API", "moxen/audit-routes", "Task", "Audit the routes and list"]) {
    if (!info.includes(expected)) fail(`info tab is missing "${expected}"`);
  }
  // The path wraps inside its own column, never over the label.
  const worktreeRow = info.split("\n").find((row) => row.includes("Worktree"));
  if (worktreeRow === undefined || !/Worktree\s+~\//.test(worktreeRow)) fail("the worktree label and its path run together");
  if (info.includes("Agents")) fail("a delegated thread's tab should not be called Agents");
  const infoRows = info.split("\n");
  const parentRow = infoRows.findIndex((row) => row.includes("Harden the API"));
  await act(async () => infoSetup.mockMouse.click(infoRows[parentRow]!.indexOf("Harden") + 1, parentRow));
  await infoSetup.flush();
  if (infoOpened[0] !== "parent-1") fail("clicking the parent did not open it");

  // The composer footer: gauges per window, shed before the model label
  // when the composer narrows (as it does beside an open panel).
  function Footer({ width, suggestion }: { width: number; suggestion?: string }) {
    return (
      <Composer
        draft=""
        resetKey="k"
        onInput={() => {}}
        onSubmit={() => {}}
        onEscape={() => {}}
        onFocus={() => {}}
        focused={false}
        placeholder="Message the agent"
        model="Claude Opus 5"
        permission="Full access"
        submitVerb="sends"
        running={false}
        width={width}
        contextUsage={{ percent: 42, usedLabel: "84k", maxLabel: "200k", totalProcessedLabel: null, costLabel: null }}
        planUsage={[
          { short: "5h", percent: 42 },
          { short: "wk", percent: 91 },
        ]}
        onCopyClick={() => {}}
        onExternalEditClick={() => {}}
        {...(suggestion === undefined ? {} : { suggestion })}
      />
    );
  }

  // A prompt suggestion is one line at any width: beside an open panel the
  // composer is narrow, and the suggestion's tail must not wrap onto a line
  // of its own (a lone "…" with the tab chip under it).
  const suggestion = "kick off a couple more in parallel to stress-test the panels";
  for (const [width, hint] of [[110, "tab  to use it"], [52, "tab  to use it"], [36, "tab"]] as const) {
    const suggested = await testRender(<Footer width={width} suggestion={suggestion} />, { width: width + 2, height: 10, exitOnCtrlC: false });
    await suggested.flush();
    const frame = suggested.captureCharFrame();
    console.log(`--- composer: prompt suggestion at ${width} ---`);
    console.log(frame);
    const rows = frame.split("\n");
    const first = rows.findIndex((row) => row.includes("kick off"));
    if (first < 0 || !rows[first]!.includes(hint)) fail(`a ${width}-wide suggestion does not end in "${hint}" on its own line`);
    if (rows[first + 1]?.trim().startsWith("…") || rows[first + 1]?.includes("tab")) fail(`a ${width}-wide suggestion wrapped onto a second line`);
  }

  const wide = await testRender(<Footer width={110} />, { width: 112, height: 10, exitOnCtrlC: false });
  await wide.flush();
  const wideFrame = wide.captureCharFrame();
  console.log("--- composer footer: plan usage ---");
  console.log(wideFrame);
  if (!wideFrame.includes("5h 42%") || !wideFrame.includes("wk 91%")) fail("composer footer does not show the plan usage gauges");
  // Beside an open panel the composer is narrow: the lowest-ranked controls (the plan gauges, then copy) go
  // behind "⋯ more" while the model group and the rest stay in their slots.
  const narrow = await testRender(<Footer width={44} />, { width: 46, height: 10, exitOnCtrlC: false });
  await narrow.flush();
  const narrowFrame = narrow.captureCharFrame();
  console.log("--- composer footer: narrow ---");
  console.log(narrowFrame);
  const narrowLines = narrowFrame.split("\n");
  const topLine = narrowLines.find((row) => row.includes("Claude Opus 5")) ?? "";
  const bottomLine = narrowLines.find((row) => row.includes("Full access")) ?? "";
  if (!bottomLine.includes("Full access")) fail("narrow composer lost its permission");
  if (!topLine.includes("84k/200k")) fail("narrow composer lost the context, which outranks the plan gauges");
  if (topLine.includes("5h 42%")) fail("narrow composer kept the plan gauges it has no room for");
  if (!bottomLine.includes("✎ external") || bottomLine.includes("copy")) fail("narrow composer did not shed copy before external");
  // What does not fit sits behind "⋯ more", whose menu lists every control that was left out.
  if (!bottomLine.includes("⋯ more")) fail("narrow composer offers no way to reach its hidden controls");
  const narrowRows = narrowFrame.split("\n");
  const moreRow = narrowRows.findIndex((row) => row.includes("⋯ more"));
  await act(async () => narrow.mockMouse.click(narrowRows[moreRow]!.indexOf("⋯ more") + 2, moreRow));
  await narrow.flush();
  const menu = narrow.captureCharFrame();
  console.log("--- composer footer: more menu ---");
  console.log(menu);
  for (const expected of ["5h 42%", "⧉ copy", "▾ more"]) {
    if (!menu.includes(expected)) fail(`the more menu is missing "${expected}"`);
  }

  // The open diff panel's footer: the counts in their own colours (green/red)
  // instead of one monochrome border title. Wrapped in a bounded row like
  // the app does, so the scrollbox takes the remainder and the footer pins
  // above the bottom border.
  function DiffHarness() {
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <box style={{ width: 62, height: 24, flexDirection: "row" }}>
        <DiffPanel
          files={[{ path: "src/a.ts", filetype: "typescript", patch: "--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line2\n", additions: 2, deletions: 1, binary: false }]}
          loading={false}
          fileIndex={0}
          collapsed={new Set()}
          width={60}
          turnCount={8}
          turnTotal={4}
          focused={false}
          scrollRef={scrollRef}
          onToggleFile={() => {}}
          onFocus={() => {}}
          onHeaderClick={() => {}}
        />
      </box>
    );
  }
  const diff = await testRender(<DiffHarness />, { width: 62, height: 24, exitOnCtrlC: false });
  await diff.flush();
  const diffFrame = diff.captureCharFrame();
  console.log("--- diff panel: footer ---");
  console.log(diffFrame);
  for (const expected of ["Diff turn 8", "+2", "-1", "click a file to fold"]) {
    if (!diffFrame.includes(expected)) fail(`diff footer is missing "${expected}"`);
  }
  // No destroy(), as in bootGate: tearing down a second renderer breaks the shared one.
}

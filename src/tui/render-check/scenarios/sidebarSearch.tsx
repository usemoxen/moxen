import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import type { QueryResult } from "../../../server/protocol.js";
import type { ThreadEnvelope } from "../../../core/types.js";
import { Sidebar } from "../../features/sidebar/sidebar.js";
import type { SidebarSearchView } from "../../features/sidebar/useSidebarSearch.js";
import { buildSidebarSections } from "../../model/sidebar.js";
import { messageMatches, titleMatches } from "../../model/sidebarsearch.js";
import { fail } from "../helpers.js";

/**
 * The sidebar's search (MXN-134): a typed query lists the threads whose
 * title matches, then "In messages" for those only their content matches,
 * each with its snippet. A thread listed by its title is not listed twice.
 */
export async function runSidebarSearch(): Promise<void> {
  const now = Date.parse("2026-10-28T10:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const thread = (id: string, title: string): ThreadEnvelope => ({
    id,
    projectId: "p1",
    title,
    archivedAt: null,
    createdAt: ago(600_000),
    updatedAt: ago(60_000),
  });
  const threads = [
    thread("t1", "Fix the render check flake"),
    thread("t2", "Sidebar search bar"),
    thread("t3", "Memory per project"),
  ];
  const shell = { snapshotSequence: 1, projects: [{ id: "p1", title: "moxen", workspaceRoot: "/repo", defaultModelSelection: null }], threads, synchronized: true, unhandled: {} };
  const sections = buildSidebarSections(shell, { settledExpanded: false, settledLimit: 10, now });
  const hit = (threadId: string, title: string, snippet: string) => ({
    threadId,
    projectId: "p1",
    title,
    status: "active" as const,
    updatedAt: ago(60_000),
    hitCount: 1,
    hits: [{ kind: "message" as const, snippet, source: "assistant", turnId: null, at: null }],
  });
  const found: QueryResult<"threads.search"> = {
    query: "search",
    threads: [
      hit("t2", "Sidebar search bar", "the search field in the sidebar"),
      hit("t3", "Memory per project", "thread_search reads the store for the memory index"),
    ],
    total: 2,
  };
  const titles = titleMatches(threads, "search");
  const messages = messageMatches(found, new Set(titles.map((entry) => entry.id)));
  const search: SidebarSearchView = { query: "search", titles, messages, searching: false, selectedId: titles[0]?.id ?? null };
  const opened: string[] = [];
  const setup = await testRender(
    <Sidebar
      sections={sections}
      openThreadId={null}
      markedThreadIds={new Set()}
      settledExpanded={false}
      width={44}
      now={now}
      height={22}
      screenWidth={44}
      search={search}
      searchFocused
      onOpenThread={(threadId) => opened.push(threadId)}
      onToggleSettled={() => {}}
      onShowMore={() => {}}
      onSelectMode={() => {}}
      onToggleProject={() => {}}
      onCycleProject={() => {}}
      onNewThread={() => {}}
    />,
    { width: 46, height: 22, exitOnCtrlC: false },
  );
  await setup.flush();
  const frame = setup.captureCharFrame();
  console.log("--- sidebar: a search with title and message matches ---");
  console.log(frame);
  const rows = frame.split("\n");
  const at = (text: string) => rows.findIndex((line) => line.includes(text));
  if (at("search▏") === -1) fail("the focused search field does not show the query with its caret");
  if (at("Titles") === -1 || at("In messages") === -1) fail("the results are not grouped under Titles and In messages");
  if (at("Fix the render check") !== -1) fail("a thread that matches nothing is still listed");
  if (rows.filter((line) => line.includes("Sidebar search bar")).length !== 1) fail("a title match is listed again under In messages");
  const memory = at("Memory per project");
  if (memory < at("In messages")) fail("a content-only match is not under In messages");
  if (!(rows[memory + 1] ?? "").includes("thread_search reads the store")) fail("a message match does not show its snippet");
  await act(async () => setup.mockMouse.click(rows[memory]!.indexOf("Memory") + 1, memory));
  await setup.flush();
  if (opened[0] !== "t3") fail("clicking a message match did not open its thread");
}

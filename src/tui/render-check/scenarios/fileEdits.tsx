import { useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import { Timeline } from "../../features/timeline/timeline.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { toolActivityRow } from "../../../core/threads/toolactivity.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** A Codex file-change item carries hunk-only patches, one per path. */
export async function runFileEdits(): Promise<void> {
  const at = "2026-10-31T12:00:00.000Z";
  const changes = [
    { path: "docs/README.md", kind: { type: "update" }, diff: "@@ -1 +1,3 @@\n heading\n+README_ONLY\n+README_SECOND" },
    { path: "src/core/threads/operations.ts", kind: { type: "update" }, diff: "@@ -1225 +1225 @@\n-old\n+CORE_ONLY" },
    { path: "src/server/operations.ts", kind: { type: "update" }, diff: "@@ -292 +292,2 @@\n context\n+SERVER_ONLY" },
  ];
  const row = toolActivityRow({ provider: "codex", type: "tool.execute.completed", threadId: "thread", turnId: "turn", tool: "fileChange", raw: { item: { id: "edit", type: "fileChange", status: "completed", changes } } })!;
  const entries: TimelineEntry[] = [{
    id: "edit", at, turnId: "turn", kind: "activity", text: "", streaming: false, tone: "tool", activityKind: row.kind, message: null,
    activity: { id: "edit", turnId: "turn", tone: "tool", kind: row.kind, summary: row.summary, createdAt: at, payload: row.payload },
    checkpoint: null, editStats: { added: 99, removed: 99 }, proposedPlan: null,
  }];
  function Host() {
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return <Timeline groups={groupTurns(entries)} title="Codex edits" subtitle="" modelForTurn={() => ({ name: "Codex", color: null, provider: "codex" })} modelLabel={(model) => ({ name: model, color: null })} homeDir="/work" expandedTurn={null} expandedWork={new Map([["turn", true]])} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={100} sessionStatus="running" now={Date.parse(at) + 1000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  const setup = await testRender(<Host />, { width: 100, height: 30, exitOnCtrlC: false });
  try {
    await setup.flush();
    console.log("--- multi-file edit: separate paths, hunks and per-file counts ---");
    const frame = setup.captureCharFrame();
    console.log(frame);
    const core = frame.indexOf("src/core/threads/operations.ts");
    const server = frame.indexOf("src/server/operations.ts");
    if (!frame.includes("Update(docs/README.md)") || !frame.includes("Update(src/core/threads/operations.ts)") || !frame.includes("Update(src/server/operations.ts)") || frame.includes("+2 more")) fail("multi-file patch did not render as separate tool calls");
    if (core === -1 || server === -1 || core > frame.indexOf("CORE_ONLY") || server > frame.indexOf("SERVER_ONLY")) fail("a file's hunk is missing its own path heading");
    if (frame.indexOf("README_SECOND") > core || frame.indexOf("CORE_ONLY") > server) fail("file boundaries no longer separate each file's hunks");
    if (!frame.includes("Added 2 lines") || !frame.includes("Added 1 line, removed 1 line") || frame.includes("Added 4 lines") || frame.includes("99 lines")) fail("file section counts are still totals for another scope");
  } finally {
    setup.renderer.destroy();
  }
}

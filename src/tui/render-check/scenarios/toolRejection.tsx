import { useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { toolActivityRow } from "../../../core/threads/toolactivity.js";
import { Timeline } from "../../features/timeline/timeline.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

export async function runToolRejection(): Promise<void> {
  const at = "2026-11-01T12:00:00.000Z";
  const reason = "The action was rejected.\nReason: approval was denied.\nAsk the user before retrying.";
  const row = toolActivityRow({ provider: "codex", type: "tool.execute.completed", threadId: "thread", turnId: "turn", tool: "save_comment", raw: { item: { id: "call", type: "mcpToolCall", server: "linear", tool: "save_comment", status: "failed", arguments: {}, error: { message: reason } } } })!;
  const entries: TimelineEntry[] = [{ id: "call", at, turnId: "turn", kind: "activity", text: "", streaming: false, tone: "tool", activityKind: row.kind, message: null, activity: { id: "call", turnId: "turn", tone: "tool", kind: row.kind, summary: row.summary, createdAt: at, payload: row.payload }, checkpoint: null, editStats: null, proposedPlan: null }];
  function Host() {
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return <Timeline groups={groupTurns(entries)} title="Rejection" subtitle="" modelForTurn={() => ({ name: "Codex", color: null, provider: "codex" })} modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map([["turn", true]])} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={100} sessionStatus="idle" now={Date.parse(at) + 1000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  const setup = await testRender(<Host />, { width: 100, height: 18, exitOnCtrlC: false });
  try {
    await setup.flush();
    console.log("--- rejected MCP call ---");
    const frame = setup.captureCharFrame();
    console.log(frame);
    if (!frame.includes("Linear · Save comment") || !frame.includes("failed") || !frame.includes("Reason: approval was denied.") || !frame.includes("Ask the user before retrying.")) fail("tool rejection or its full reason is hidden");
  } finally {
    setup.renderer.destroy();
  }
}

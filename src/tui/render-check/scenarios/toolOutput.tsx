import { useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { toolActivityRow, type ToolRuntimeEvent } from "../../../core/threads/toolactivity.js";
import { Timeline } from "../../features/timeline/timeline.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** A Codex MCP failure shown as its text, a real shell failure, and a search that found nothing. */
export async function runToolOutput(): Promise<void> {
  const at = "2026-11-01T12:00:00.000Z";
  const base = { type: "tool.execute.completed", threadId: "thread", turnId: "turn" } as const;
  const shell = (command: string, output: string): ToolRuntimeEvent => ({ ...base, provider: "codex", tool: "bash", raw: { item: { id: command, type: "mcpToolCall", server: "moxen_harness", tool: "bash", status: "completed", arguments: { command }, result: { content: [{ type: "text", text: output }], isError: true } } } });
  const events: ToolRuntimeEvent[] = [
    { ...base, provider: "codex", tool: "get_issue", raw: { item: { id: "mcp", type: "mcpToolCall", server: "linear", tool: "get_issue", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "Issue MXN-1 not found.\nCheck the identifier and try again." }], isError: true } } } },
    shell("cargo build", `${"warning: unused variable\n".repeat(400)}error: could not compile\n\n[exit code 101]`),
    shell("sed -n 1,20p src/a.ts; rg -n 'MISSING' src", "export const a = 1;\n\n[exit code 1]"),
    shell("rg -n 'MISSING' src; false", "[exit code 1]"),
  ];
  const entries: TimelineEntry[] = events.map((event, index) => {
    const row = toolActivityRow(event)!;
    return { id: `c${index}`, at, turnId: "turn", kind: "activity", text: "", streaming: false, tone: "tool", activityKind: row.kind, message: null, activity: { id: `c${index}`, turnId: "turn", tone: "tool", kind: row.kind, summary: row.summary, createdAt: at, payload: row.payload }, checkpoint: null, editStats: null, proposedPlan: null };
  });
  function Host() {
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return <Timeline groups={groupTurns(entries)} title="Tool output" subtitle="" modelForTurn={() => ({ name: "Codex", color: null, provider: "codex" })} modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map([["turn", true]])} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={100} sessionStatus="idle" now={Date.parse(at) + 1000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  const setup = await testRender(<Host />, { width: 100, height: 30, exitOnCtrlC: false });
  try {
    await setup.flush();
    console.log("--- tool output as text ---");
    const frame = setup.captureCharFrame();
    console.log(frame);
    if (frame.includes('"content"') || frame.includes("\\n")) fail("tool output still shows its JSON envelope");
    if (!frame.includes("Issue MXN-1 not found.") || !frame.includes("Check the identifier")) fail("Codex MCP text is hidden");
    if (!frame.includes("[exit code 101]") || !frame.includes("exit 101")) fail("a cut command lost its exit code");
    if ((frame.match(/no matches/gu) ?? []).length !== 1) fail("only the final search that found nothing reads as no matches");
  } finally {
    setup.renderer.destroy();
  }
}

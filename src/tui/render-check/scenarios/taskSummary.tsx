import { act, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { toolActivityRow } from "../../../core/threads/toolactivity.js";
import { Timeline } from "../../features/timeline/timeline.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { applyLanguage } from "../../i18n/index.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/**
 * A folded work segment names moxen's task tools in its own words: the
 * Linear calls stay generic tools, the command stays a command, and the
 * delegate / task_send calls read as delegated / messaged tasks instead of
 * vanishing into (or inflating) "used N tools".
 */
export async function runTaskSummary(): Promise<void> {
  const at = "2026-11-01T12:00:00.000Z";
  const claude = (id: string, tool: string, input: Record<string, unknown>, output: string) =>
    toolActivityRow({ provider: "claude", type: "tool.execute.completed", threadId: "thread", turnId: "turn", tool, raw: { toolUseId: id, input, output } })!;
  const rows = [
    claude("l1", "mcp__claude_ai_Linear__list_issues", { team: "Moxen" }, '{"issues":[]}'),
    claude("l2", "mcp__claude_ai_Linear__get_issue", { id: "MXN-281" }, '{"title":"Group headings name tasks"}'),
    claude("c1", "Bash", { command: "bun run check" }, "ok"),
    claude("d1", "mcp__moxen__delegate", { title: "Stop button race on new threads", task: "Investigate." }, JSON.stringify({ taskId: "t1", title: "Stop button race on new threads", status: "running" })),
    toolActivityRow({ provider: "opencode", type: "tool.execute.completed", threadId: "thread", turnId: "turn", tool: "mcp__moxen__task_send", raw: { callID: "s1", tool: "moxen_task_send", state: { status: "completed", input: { taskId: "t1", message: "go" }, output: JSON.stringify({ taskId: "t1", outcome: "queued", status: "running" }) } } })!,
  ];
  const tools: TimelineEntry[] = rows.map((row, index) => (
    { id: `task-${index}`, at, turnId: "turn", kind: "activity", text: "", streaming: false, tone: "tool", activityKind: row.kind, message: null, activity: { id: `task-${index}`, turnId: "turn", tone: "tool", kind: row.kind, summary: row.summary, createdAt: at, payload: row.payload }, checkpoint: null, editStats: null, proposedPlan: null }
  ));
  const entries: TimelineEntry[] = [
    { ...tools[0]!, id: "intro", kind: "assistant", text: "Looking into it.", activity: null, activityKind: null },
    ...tools,
    { ...tools[0]!, id: "reply", kind: "assistant", text: "Delegated and messaged.", activity: null, activityKind: null },
  ];
  function Host({ width }: { width: number }) {
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return <Timeline groups={groupTurns(entries)} title="Tasks" subtitle="" modelForTurn={() => ({ name: "Claude", color: null, provider: "claude" })} modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map([["turn", true]])} scrollRef={scroll} onFocus={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} onOpenDiff={() => {}} focused width={width} sessionStatus="idle" now={Date.parse(at) + 1000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  for (const language of ["en", "es-ES"] as const) {
    await act(async () => applyLanguage(language));
    const expected = language === "en"
      ? "Used 2 tools, ran 1 command, delegated 1 task, messaged 1 task"
      : "Ha usado 2 herramientas, ha ejecutado 1 comando, ha delegado 1 tarea, ha enviado un mensaje a 1 tarea";
    for (const width of [140, 64]) {
      const setup = await testRender(<Host width={width} />, { width, height: 22, exitOnCtrlC: false });
      try {
        await setup.flush();
        console.log(`--- task summary ${language} ${width} columns ---`);
        const frame = setup.captureCharFrame();
        console.log(frame);
        if (width === 140 && !frame.includes(expected)) fail(`task summary heading missing: ${expected}`);
      } finally {
        await act(async () => setup.renderer.destroy());
      }
    }
  }
  await act(async () => applyLanguage("en"));
}

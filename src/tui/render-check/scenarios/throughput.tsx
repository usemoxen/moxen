import { useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Timeline } from "../../features/timeline/timeline.js";
import { groupTurns } from "../../model/turns.js";
import type { TimelineEntry } from "../../model/thread.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

export async function runThroughput(): Promise<void> {
  const at = "2026-10-31T12:00:00.000Z";
  const entry = (id: string, kind: "user" | "assistant"): TimelineEntry => ({ id, at, turnId: "turn", kind, text: kind === "user" ? "Hello" : "Answer", streaming: false, tone: null, activityKind: null, message: null, activity: null, checkpoint: null, editStats: null, proposedPlan: null });
  function Host() {
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return <Timeline groups={groupTurns([entry("prompt", "user"), entry("reply", "assistant")], new Map(), { turn: 12.5 })} title="Thread" subtitle="" modelForTurn={() => ({ name: "Model", color: null, provider: "codex" })} modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map()} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={100} sessionStatus="idle" now={Date.parse(at) + 1000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  const setup = await testRender(<Host />, { width: 100, height: 30, exitOnCtrlC: false });
  try {
    await setup.flush();
    console.log("--- completed reply throughput ---");
    const frame = setup.captureCharFrame();
    console.log(frame);
    if (!frame.includes("~12.5 tokens/s")) fail("completed reply lost its estimated throughput");
  } finally {
    setup.renderer.destroy();
  }
}

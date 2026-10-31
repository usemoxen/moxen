import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import { Timeline } from "../../features/timeline/timeline.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** Native image-generation status stays distinct from reads, and summaries remain readable markdown. */
export async function runCodexMedia(): Promise<void> {
  const at = "2026-10-30T12:00:00.000Z";
  let complete: () => void = () => {};
  let showWeb: () => void = () => {};
  function Host() {
    const [done, setDone] = useState(false);
    const [web, setWeb] = useState(false);
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    complete = () => setDone(true);
    showWeb = () => setWeb(true);
    const payloads = web ? [
      { itemType: "web_search", toolCallId: "legacy", status: "completed", data: { tool: "websearch", state: { input: { query: "legacy query" } } } },
      { itemType: "web_search", provider: "codex", toolCallId: "queries", status: "completed", data: { tool: "websearch", state: { input: { action: "search", query: "first · second" } } } },
      { itemType: "web_search", provider: "codex", toolCallId: "open", status: "completed", data: { tool: "webfetch", state: { input: { action: "openPage", url: "https://example.org/visual" } } } },
      { itemType: "web_search", provider: "codex", toolCallId: "find", status: "completed", data: { tool: "websearch", state: { input: { action: "findInPage", pattern: "key visual", url: "https://example.org/visual" } } } },
      { itemType: "web_search", provider: "codex", toolCallId: "long-query", status: "completed", data: { tool: "websearch", state: { input: { query: "a long query ".repeat(12) } } } },
      { itemType: "dynamic_tool_call", toolCallId: "linear", status: "completed", detail: '{"content":[{"type":"text","text":"RAW_MCP_RESPONSE"}]}', data: { tool: "mcp__linear__get_issue", state: { input: {} } } },
    ] : [
      { itemType: "reasoning", toolCallId: "reason", status: "inProgress", text: "**Preparing image crops**\n\nKeep both crops aligned and check their edges.", startedAt: at },
      { itemType: "image_generation", toolCallId: "image", status: done ? "completed" : "inProgress", ...(done ? { detail: "/work/generated.png" } : {}), data: { tool: "image_generation", state: { input: {} } } },
      ...(done ? [{ itemType: "image_view", toolCallId: "view-image", status: "completed", detail: "/work/comparison.png", data: { tool: "imageview", state: { input: {} } } }] : []),
    ];
    const entries: TimelineEntry[] = payloads.map((payload, index) => ({
      id: `entry-${index}`, at, turnId: "turn-1", kind: "activity", text: "", streaming: false, tone: "tool", activityKind: "tool-call.started", message: null,
      activity: { id: `activity-${index}`, turnId: "turn-1", tone: "tool", kind: "tool-call.started", summary: "", createdAt: at, payload },
      checkpoint: null, editStats: null, proposedPlan: null,
    }));
    return <Timeline groups={groupTurns(entries)} title="Codex media" subtitle="" modelForTurn={() => ({name: "Codex", color: null, provider: "codex"})} modelLabel={(model) => ({name: model, color: null})} homeDir="/work" expandedTurn={null} expandedWork={new Map([["turn-1", true]])} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={100} sessionStatus="running" now={Date.parse(at) + 5000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  const setup = await testRender(<Host />, {width: 100, height: 25, exitOnCtrlC: false});
  try {
    await setup.flush();
    const deadline = Date.now() + 2000;
    while (!setup.captureCharFrame().includes("Keep both crops aligned") && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); await setup.flush(); });
    }
    let frame = setup.captureCharFrame();
    console.log("--- Codex media: native generation in progress and detailed reasoning ---");
    console.log(frame);
    const generationRow = frame.split("\n").find((line) => line.includes("Generating image"));
    if (!generationRow || frame.includes("(image)")) fail("native image generation has no status label");
    if (generationRow.slice(0, generationRow.indexOf("Generating image")).replace(/[│┃\s]/gu, "") !== "") fail("image generation still renders an indicator before its label");
    if (frame.includes("░") || frame.includes("━━━━")) fail("image generation still renders the oversized activity bar");
    if (!frame.includes("Keep both crops aligned") || frame.includes("**Preparing")) fail("native reasoning markdown was lost or rendered as literal formatting");
    await act(async () => complete());
    await setup.flush();
    frame = setup.captureCharFrame();
    console.log("--- Codex media: saved generated image ---");
    console.log(frame);
    if (!frame.includes("Generated image") || !frame.includes("generated.png")) fail("completed native image generation was rendered as a read");
    if (!frame.includes("Read image") || !frame.includes("comparison.png")) fail("native image viewing was not distinguished from generation");
    await act(async () => showWeb());
    await setup.flush();
    frame = setup.captureCharFrame();
    console.log("--- Codex web: native actions and legacy rows use the correct provider ---");
    console.log(frame);
    for (const expected of ['Searched for "legacy query" · Codex', 'Searched for "first · second" · Codex', 'Fetched example.org · Codex', 'Find "key visual" in example.org · Codex']) {
      if (!frame.includes(expected)) fail(`Codex web action is not mapped correctly: ${expected}`);
    }
    if (frame.includes("OpenCode")) fail("Codex web rows are still labelled OpenCode");
    if (!frame.includes("Linear · Get issue") || frame.includes("RAW_MCP_RESPONSE")) fail("Codex MCP calls are not using the shared pretty formatter");
    if (!frame.split("\n").some((line) => line.includes('Searched for "a long query') && line.includes("· Codex"))) fail("a long web query hides its provider label");
  } finally { setup.renderer.destroy(); }
}

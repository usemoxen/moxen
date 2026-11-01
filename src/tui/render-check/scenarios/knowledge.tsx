import { act, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { toolActivityRow } from "../../../core/threads/toolactivity.js";
import { Timeline } from "../../features/timeline/timeline.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { applyLanguage } from "../../i18n/index.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

export async function runKnowledge(): Promise<void> {
  const at = "2026-11-01T12:00:00.000Z";
  const calls = [
    { tool: "knowledge_search", input: { query: "connect a local endpoint" }, output: '{"matches":[{"id":"profiles"},{"id":"settings"}]}' },
    { tool: "knowledge_read", input: { id: "profiles", section: "setup" }, output: '{"title":"Connect a model server","sectionTitle":"Create and test an endpoint profile","outline":false}' },
    { tool: "knowledge_read", input: { id: "settings-provider:harness" }, output: '{"title":"Moxen Harness settings","outline":true,"sections":[]}' },
    { tool: "knowledge_search", input: { query: "no matching document" }, output: '{"matches":[]}' },
    { tool: "knowledge_read", input: { id: "missing-page", section: "missing-section" }, output: "KNOWLEDGE_NOT_FOUND: Unknown knowledge page.", failed: true },
    { tool: "knowledge_search", input: { query: "configure another model server" } },
    { tool: "knowledge_read", input: { id: "profiles", section: "tune" } },
  ];
  const entries: TimelineEntry[] = calls.map((call, index) => {
    const row = toolActivityRow({ provider: "codex", type: call.output === undefined ? "tool.execute.started" : "tool.execute.completed", threadId: "thread", turnId: "turn", tool: call.tool, raw: { item: { id: `kb-${index}`, type: "mcpToolCall", server: "moxen", tool: call.tool, arguments: call.input, status: call.output === undefined ? "inProgress" : call.failed ? "failed" : "completed", ...(call.output === undefined ? {} : { result: { content: [{ type: "text", text: call.output }], isError: call.failed === true } }) } } })!;
    return { id: `kb-${index}`, at, turnId: "turn", kind: "activity", text: "", streaming: false, tone: "tool", activityKind: row.kind, message: null, activity: { id: `kb-${index}`, turnId: "turn", tone: "tool", kind: row.kind, summary: row.summary, createdAt: at, payload: row.payload }, checkpoint: null, editStats: null, proposedPlan: null };
  });
  const summaryEntries: TimelineEntry[] = [
    { ...entries[0]!, id: "intro", kind: "assistant", text: "Consulting the knowledge base.", activity: null, activityKind: null },
    ...Array.from({ length: 16 }, (_, index) => ({ ...entries[index < 6 ? 0 : 1]!, id: `summary-${index}` })),
    { ...entries[0]!, id: "reply", kind: "assistant", text: "Knowledge review complete.", activity: null, activityKind: null },
  ];
  function Host({ width, summary = false }: { width: number; summary?: boolean }) {
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    return <Timeline groups={groupTurns(summary ? summaryEntries : entries)} title="Knowledge" subtitle="" modelForTurn={() => ({ name: "Codex", color: null, provider: "codex" })} modelLabel={(model) => ({ name: model, color: null })} homeDir={undefined} expandedTurn={null} expandedWork={new Map([["turn", true]])} scrollRef={scroll} onFocus={() => {}} onOpenDiff={() => {}} onToggleWork={() => {}} onOpenMessageActions={() => {}} onOpenUrl={() => {}} focused width={width} sessionStatus={summary ? "idle" : "running"} now={Date.parse(at) + 1000} turnStartedAt={at} turnFileDiffs={new Map()} gitFiles={[]} />;
  }
  for (const language of ["en", "es-ES"] as const) {
    await act(async () => applyLanguage(language));
    for (const width of [100, 64]) {
      const setup = await testRender(<Host width={width} />, { width, height: 50, exitOnCtrlC: false });
      try {
        await setup.flush();
        console.log(`--- knowledge activity ${language} ${width} columns ---`);
        const frame = setup.captureCharFrame();
        console.log(frame);
        for (const expected of ["connect a local endpoint", "Connect a model server", "Create and test an endpoint profile", "Moxen Harness settings", "no matching document", "missing-page", "missing-section", "Unknown knowledge page", "configure another model server", "profiles", "tune"]) {
          if (!frame.includes(expected)) fail(`knowledge target missing: ${expected}`);
        }
        for (const expected of language === "en" ? ["2 matching sections", "0 matching sections", "outline only", "Knowledge not read", "Searching knowledge", "Reading knowledge"] : ["2 secciones encontradas", "0 secciones encontradas", "solo el índice", "Buscando en la base", "Leyendo la base"]) {
          if (!frame.includes(expected)) fail(`knowledge outcome missing: ${expected}`);
        }
      } finally {
        await act(async () => setup.renderer.destroy());
      }
    }
    const summarySetup = await testRender(<Host width={140} summary />, { width: 140, height: 22, exitOnCtrlC: false });
    try {
      await summarySetup.flush();
      console.log(`--- knowledge summary ${language} ---`);
      const frame = summarySetup.captureCharFrame();
      console.log(frame);
      const expected = language === "en"
        ? "Read from the knowledge base 10 times, searched the knowledge base 6 times"
        : "Ha leído la base de conocimiento 10 veces, ha buscado en la base de conocimiento 6 veces";
      if (!frame.includes(expected) || frame.includes("Used 16 tools")) fail("knowledge calls still use the generic tools summary");
    } finally {
      await act(async () => summarySetup.renderer.destroy());
    }
  }
  await act(async () => applyLanguage("en"));
}

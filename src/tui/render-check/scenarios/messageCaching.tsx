import { MarkdownRenderable, type BaseRenderable } from "@opentui/core";
import { act, useState } from "react";
import { MessageBody } from "../../features/timeline/timeline.js";
import { emptyThreadState, timeline } from "../../model/thread.js";
import { applyTheme, activeTheme } from "../../theme.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** Cached history must still reflect text edits, stream completion and palette changes. */
export async function runMessageCaching(): Promise<void> {
  let update!: (text: string, streaming: boolean) => void;
  let refresh!: () => void;
  function Harness() {
    const [body, setBody] = useState({ text: "first draft", streaming: true });
    const [, tick] = useState(0);
    update = (text, streaming) => setBody({ text, streaming });
    refresh = () => tick((value) => value + 1);
    const state = emptyThreadState();
    state.messages = [{ id: "reply", turnId: "turn", role: "assistant", ...body, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
    return <MessageBody entry={timeline(state)[0]!} homeDir={undefined} background="#000000" />;
  }
  const theme = activeTheme();
  const setup = await testRender(<Harness />, { width: 50, height: 6, exitOnCtrlC: false });
  const markdown = (node: BaseRenderable): MarkdownRenderable[] => [
    ...(node instanceof MarkdownRenderable ? [node] : []),
    ...node.getChildren().flatMap(markdown),
  ];
  const settle = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await setup.flush();
  });
  try {
    await settle();
    await act(async () => update("edited reply", false));
    await settle();
    if (!setup.captureCharFrame().includes("edited reply")) fail("caching hid a message edit");
    if (markdown(setup.renderer.root).some((node) => node.streaming)) fail("caching kept a completed reply in streaming mode");
    const before = JSON.stringify(setup.captureSpans().lines);
    await act(async () => {
      applyTheme(theme === "catppuccin-latte" ? "dracula" : "catppuccin-latte");
      refresh();
    });
    await settle();
    if (JSON.stringify(setup.captureSpans().lines) === before) fail("caching froze a reply's theme colors");
  } finally {
    applyTheme(theme);
    await act(async () => setup.renderer.destroy());
  }
}

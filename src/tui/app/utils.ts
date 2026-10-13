import type { ScrollBoxRenderable } from "@opentui/core";

/** Arrow keys and page keys scroll whichever pane holds focus. */
export function scrollPane(pane: ScrollBoxRenderable | null, keyName: string): void {
  if (pane === null) return;
  if (keyName === "down") pane.scrollBy(1);
  else if (keyName === "up") pane.scrollBy(-1);
  else if (keyName === "pagedown") pane.scrollBy(Math.max(1, pane.viewport.height - 2));
  else if (keyName === "pageup") pane.scrollBy(-Math.max(1, pane.viewport.height - 2));
  else if (keyName === "home") pane.scrollTo(0);
  else if (keyName === "end") pane.scrollTo(pane.scrollHeight);
}

/** First line of the prompt, matching the CLI handover title. */
export function threadTitle(prompt: string): string {
  const title = prompt.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, " ").trim() || "New thread";
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

export function clock(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "--:--";
  const date = new Date(parsed);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Where a launch lands. Production opens on the new-thread screen, the latest
 * thread only lending its project and model — unless a thread is working or
 * waiting on the user, which is where they were: that one opens on its
 * transcript instead. (Landing on the new-thread screen over a thread that is
 * asking a question drew the question on top of "What should we build?".)
 * The most recent such thread wins, a top-level one over a task under it.
 */
export function launchTarget(
  active: ReadonlyArray<{ thread: { id: string }; status: string; waiting: boolean; depth: number }>,
  fallbackId: string | null,
): { threadId: string | null; transcript: boolean } {
  const busy = (row: { status: string; waiting: boolean }): boolean => row.status === "running" || row.status === "blocked" || row.waiting;
  const ongoing = active.find((row) => row.depth === 0 && busy(row)) ?? active.find(busy);
  if (ongoing !== undefined) return { threadId: ongoing.thread.id, transcript: true };
  return { threadId: active[0]?.thread.id ?? fallbackId, transcript: false };
}

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildHandoff, continuedTitle } from "../handoff.js";
import { parseQueuePolicy } from "../queue.js";
import { openThreadStore } from "../store.js";
import { completeTurn, createThread, failTurn, promoteDueScheduledTurn, sendTurn } from "../threads.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function thread() {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-handoff-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await openThreadStore(root);
  const created = await createThread(store, {
    projectId: "p",
    title: "Auth audit",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    env: { mode: "worktree", path: path.join(root, "wt"), branch: "moxen/auth" },
  });
  return { store, threadId: created.id };
}

describe("buildHandoff", () => {
  it("keeps original image paths outside transcript trimming and uses the model's wrap-up when requested", async () => {
    const { store, threadId } = await thread();
    const sent = await sendTurn(store, threadId, { prompt: "Implement the screenshot", attachments: [{ type: "image", mimeType: "image/png", sizeBytes: 8, name: "screen.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }] });
    await completeTurn(store, threadId, sent.turn.id, { text: "The sidebar is done. Next: keyboard navigation and screenshot checks." });
    const messages = await store.readMessages(threadId);
    const attachment = messages.flatMap((message) => message.attachments ?? [])[0]!;
    const doc = await buildHandoff(store, threadId, { preferModelSummary: true });
    expect(doc).toContain(JSON.stringify(attachment.path));
    expect(doc).toContain("## Model's wrap-up");
    expect(doc).toContain("Next: keyboard navigation");
    expect(doc).not.toContain("### Turn 1");
  });
  it("leads with where it stopped, then what is on disk, then the conversation", async () => {
    const { store, threadId } = await thread();
    const first = await sendTurn(store, threadId, { prompt: "Audit every route for missing auth checks." });
    await store.appendLedger(threadId, "activity", {
      id: "a1",
      threadId,
      turnId: first.turn.id,
      kind: "tool.completed",
      summary: "$ rg requireAuth src/routes",
      payload: { toolCallId: "call-1", status: "completed" },
      createdAt: store.nowIso(),
    });
    await store.appendLedger(threadId, "checkpoints", {
      id: "c1",
      threadId,
      turnId: first.turn.id,
      status: "available",
      ref: "b",
      baseRef: "a",
      files: [{ path: "src/routes/admin.ts", additions: 12, deletions: 3 }],
      createdAt: store.nowIso(),
    });
    await completeTurn(store, threadId, first.turn.id, { text: "Found two routes without checks; fixed admin.ts." });
    const second = await sendTurn(store, threadId, { prompt: "Now fix users.ts too." });
    await store.appendLedger(threadId, "activity", {
      id: "l1",
      threadId,
      turnId: second.turn.id,
      kind: "usage.limit",
      summary: "Usage limit reached",
      payload: { label: "Session", resetsAt: "2026-09-26T15:00:00.000Z" },
      createdAt: store.nowIso(),
    });
    await failTurn(store, threadId, second.turn.id, { error: "You've hit your session limit" });
    // A message still queued when the handoff was written is part of the task.
    await sendTurn(store, threadId, { prompt: "And add a test for it.", queue: parseQueuePolicy({ conditions: [], continuation: "same-thread" }) });

    const doc = await buildHandoff(store, threadId, { projectTitle: "moxen" });

    expect(doc.startsWith("# Continuing: Auth audit")).toBe(true);
    expect(doc).toContain("(branch moxen/auth)");
    expect(doc).toContain("- Project: moxen");
    expect(doc).toContain("claudeAgent/claude-opus-5");
    // The reason reads as the limit, not as the bare provider error.
    expect(doc).toContain("stopped on a plan usage limit (Session window)");
    expect(doc).toContain("The last request, verbatim:\n\nNow fix users.ts too.");
    expect(doc).toContain("The thread began with:");
    // A queued message that never went out is part of the task.
    expect(doc).toContain("never sent");
    expect(doc).toContain("1. And add a test for it.");
    expect(doc).toContain("- src/routes/admin.ts +12 −3");
    expect(doc).toContain("- $ rg requireAuth src/routes");
    expect(doc).toContain("Found two routes without checks; fixed admin.ts.");
    // Order: the reader needs where it stopped before the history.
    expect(doc.indexOf("## Where it stopped")).toBeLessThan(doc.indexOf("## Files already changed"));
    expect(doc.indexOf("## Files already changed")).toBeLessThan(doc.indexOf("## Conversation"));
    expect(doc.trimEnd().endsWith("then finish what is left.")).toBe(true);
  });

  it("does not say the work was unfinished when the last turn ran to completion", async () => {
    const { store, threadId } = await thread();
    const sent = await sendTurn(store, threadId, { prompt: "Rename the helper everywhere." });
    await completeTurn(store, threadId, sent.turn.id, { text: "Renamed it in all 14 files; tests pass." });
    const doc = await buildHandoff(store, threadId);
    expect(doc).not.toContain("did not finish");
    expect(doc).not.toContain("could not finish");
    expect(doc).toContain("picking up a thread another session worked on.");
    expect(doc).toContain("The work may already be done");
    expect(doc).toContain("If the work is complete, say so");
    expect(doc).not.toContain("then finish what is left.");
  });

  it("still treats a completed turn as unfinished work when something is open", async () => {
    const { store, threadId } = await thread();
    const sent = await sendTurn(store, threadId, { prompt: "Rename the helper everywhere." });
    await completeTurn(store, threadId, sent.turn.id, { text: "Renamed it in half the files." });
    await sendTurn(store, threadId, { prompt: "Then update the docs.", delivery: "queue" });
    const doc = await buildHandoff(store, threadId);
    expect(doc).toContain("another session worked on and did not finish");
    expect(doc.trimEnd().endsWith("then finish what is left.")).toBe(true);
  });

  it("shrinks older turns to one line each when the thread is long", async () => {
    const { store, threadId } = await thread();
    for (let index = 0; index < 20; index += 1) {
      const sent = await sendTurn(store, threadId, { prompt: `Step ${index}: ${"detail ".repeat(20)}` });
      await completeTurn(store, threadId, sent.turn.id, { text: `Done with step ${index}.` });
    }
    const doc = await buildHandoff(store, threadId);
    expect(doc).toContain("Earlier turns, in brief:");
    expect(doc).toContain('- Turn 1: asked "Step 0:');
    // The latest turns stay word for word.
    expect(doc).toContain("### Turn 20");
    expect(doc).toContain("Done with step 19.");
    expect(doc).not.toContain("### Turn 1\n");
  });

  it("says so for a thread that never ran", async () => {
    const { store, threadId } = await thread();
    expect(await buildHandoff(store, threadId)).toContain("had not run a turn yet");
  });

  /**
   * MXN-382: a handoff entry never ran here. It must not take a number from a
   * turn that did (the numbering thread_read and revert use), and its request
   * must not read as a prompt the thread delivered.
   */
  it("numbers only the turns that ran and keeps handed-off requests out of the history", async () => {
    const { store, threadId } = await thread();
    const first = await sendTurn(store, threadId, { prompt: "first real" });
    await completeTurn(store, threadId, first.turn.id, { text: "done one" });

    // Prepared: completed without a start, the work moved to a new thread.
    const prepared = await sendTurn(store, threadId, { prompt: "carry on elsewhere", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) });
    await store.updateTurn(threadId, prepared.turn.id, { status: "completed", completedAt: store.nowIso(), handoff: { requestId: "r1", destinationThreadId: "dest-1" } });

    // Failed preparing, then edited back to this thread but never restored.
    const failed = await sendTurn(store, threadId, { prompt: "failed then edited", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) });
    await store.updateTurn(threadId, failed.turn.id, {
      status: "failed",
      completedAt: store.nowIso(),
      handoff: { requestId: "r2", destinationThreadId: "dest-2" },
      handoffFailed: true,
      queue: parseQueuePolicy({ conditions: [], continuation: "same-thread" }),
    });

    const second = await sendTurn(store, threadId, { prompt: "second real" });
    await completeTurn(store, threadId, second.turn.id, { text: "done two" });

    const doc = await buildHandoff(store, threadId);
    expect(doc).toContain("Turns so far: 2");
    expect(doc).toContain("### Turn 1");
    expect(doc).toContain("### Turn 2");
    expect(doc).not.toContain("### Turn 3");
    expect(doc).not.toContain("### Turn 4");
    expect(doc).not.toContain("carry on elsewhere");
    expect(doc).not.toContain("failed then edited");
    expect(doc).toContain("### Turn 1\n\n**User:**\n\nfirst real");
    expect(doc).toContain("### Turn 2\n\n**User:**\n\nsecond real");
  });

  /**
   * MXN-382: the handoff drops its own model-summary turn from the document.
   * It filtered before numbering, so a real turn after the summary took the
   * summary's place (ordinal 3 shown as 2) while thread_read counted three.
   */
  it("keeps the canonical ordinal of a turn after the model-summary turn", async () => {
    const { store, threadId } = await thread();
    const first = await sendTurn(store, threadId, { prompt: "first real" });
    await completeTurn(store, threadId, first.turn.id, { text: "done one" });
    // A completed handoff-summary turn: it ran (and numbers), but is plumbing
    // for the handoff, not conversation.
    const summary = await sendTurn(store, threadId, {
      prompt: "write a handoff summary",
      queue: { ...parseQueuePolicy({ conditions: [], sequential: false }), requestId: "summary:r1", summaryFor: first.turn.id },
    });
    await promoteDueScheduledTurn(store, threadId, summary.turn.id, true);
    await completeTurn(store, threadId, summary.turn.id, { text: "the summary" });
    const third = await sendTurn(store, threadId, { prompt: "third real" });
    await completeTurn(store, threadId, third.turn.id, { text: "done three" });

    const doc = await buildHandoff(store, threadId);
    expect(doc).toContain("### Turn 1\n\n**User:**\n\nfirst real");
    expect(doc).toContain("### Turn 3\n\n**User:**\n\nthird real");
    expect(doc).not.toContain("### Turn 2");
    // The run count is the thread's, not the number of blocks shown.
    expect(doc).toContain("- Turns so far: 3 (2 in this record)");
  });
});

describe("continuedTitle", () => {
  it("marks the title once, then numbers further continuations", () => {
    expect(continuedTitle("Auth audit")).toBe("Auth audit (continued)");
    expect(continuedTitle("Auth audit (continued)")).toBe("Auth audit (continued 2)");
    expect(continuedTitle("Auth audit (continued 2)")).toBe("Auth audit (continued 3)");
  });
});

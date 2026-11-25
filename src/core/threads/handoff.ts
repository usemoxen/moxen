/**
 * The handoff document: a thread written up for a *new* agent session to
 * continue from.
 *
 * This is not the TUI's markdown export. That one is for a person reading
 * back a thread, and it is built from the TUI's own projections, so neither
 * the CLI nor the server can produce it. This is built from the ledger
 * alone — any client, and the server, can make the same one — and it is
 * written for the reader who matters here: an agent with none of the
 * original context, who must pick up exactly where the last one stopped.
 *
 * So it leads with what that reader needs first (the goal, where it
 * stopped, what is already on disk, what the user asked for that never got
 * sent) and only then the conversation. Prompts and replies stay verbatim
 * for recent turns, where the detail is; older turns shrink to a line each
 * so a long thread still fits a context window.
 *
 * A continued thread carries its chain in its turn: the hand-off that
 * opened it is itself the thread's first prompt, so a hand-off built from
 * a chain of continuations would nest the previous hand-off inside itself,
 * multiplying with every hop. So the opening hand-off is never retold. It
 * is recognized by its persisted provenance (the turn's `handoffOpen`
 * flag), never by its text, and the bounded facts of the chain — the goal,
 * the last request, the first action, the latest wrap-up, the checklist,
 * the files, the images — travel as structured data on the thread record
 * (`HandoffFacts`), never parsed back out of a rendered document. Queued
 * requests are durable work rather than history excerpts: they travel
 * whole, with their identity and start conditions, and are never cut.
 * Every section that is not pending work is capped, and every cut or
 * omission names the thread whose ledger holds the full text, so
 * `thread_read` can recover it. Threads stored before the facts field
 * existed read with nothing carried.
 */
import type { ThreadStore } from "./store.js";
import { isTransferLanded } from "./queue.js";
import type { HandoffFacts, HandoffPendingRequest, HandoffText, StoredActivity, StoredMessage, StoredThread, StoredTurn, } from "./types.js";

/** Turns kept word for word; older ones become a one-line summary each. */
const VERBATIM_TURNS = 12;
/** Past this, verbatim turns shrink too, oldest first, until it fits. */
const TARGET_CHARS = 60_000;
/** Tool calls listed per turn before "+N more". */
const MAX_TOOL_LINES = 40;
/** A single prompt or reply kept word for word before it is cut. */
const PIECE_CHARS = 16_000;
/** The largest carried goal, request or instruction is kept before it is cut. */
const REQUEST_CHARS = 16_000;
/** The largest a wrap-up is kept at, matching the submit tool's own cap. */
const WRAPUP_CHARS = 64_000;
/** Checklist rows kept; older ones drop, marked. */
const PLAN_ROWS = 40;
/** Changed-file rows kept; the rest drop, marked. */
const FILES_ROWS = 100;
/** Image rows kept; the rest drop, marked. */
const IMAGES_ROWS = 40;
/** One-line summaries of older turns kept; earlier turns drop, marked. */
const SUMMARY_ROWS = 300;
/**
 * The final budget of rendered context on every path, pending work aside:
 * every section is capped so the document cannot exceed it by construction
 * (goal 16k + last request 16k + wrap-up 64k + plan, files, images rows +
 * conversation 60k target), and the render loop below keeps it true when a
 * thread's history alone would dwarf the rest.
 */
const RENDER_BUDGET = 180_000;

function oneLine(text: string, max = 140): string {
  const line = text.split(/\r?\n/u).map((row) => row.trim()).find((row) => row.length > 0) ?? "";
  const single = line.replace(/\s+/gu, " ");
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}

/** Verbatim text cut at its cap, naming the ledger that holds the full text. */
function clamped(text: string, max: number, threadId: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(cut at ${max} of ${text.length} characters; the full text is thread ${threadId}'s to read)`;
}

/** A single prompt or reply, cut when a block would dwarf the whole document. */
function piece(text: string, threadId: string, cap = PIECE_CHARS): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…(cut at ${cap} of ${text.length} characters; the full text is thread ${threadId}'s to read)`;
}

/** A carried text, cut once when it enters the facts so the record stays bounded. */
function carriedText(text: string | null | undefined, sourceThreadId: string, max: number): HandoffText | null {
  const trimmed = text?.trim();
  return trimmed ? { text: clamped(trimmed, max, sourceThreadId), sourceThreadId } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Tool calls in one turn, one line each, newest state per call. */
function toolLines(activities: readonly StoredActivity[]): string[] {
  const byCall = new Map<string, string>();
  for (const activity of activities) {
    const payload = activity.payload;
    const callId = typeof payload?.toolCallId === "string" ? payload.toolCallId : null;
    if (callId === null || callId.startsWith("reasoning:")) continue;
    const status = typeof payload?.status === "string" ? payload.status : "";
    const failed = status === "failed" || status === "error";
    byCall.set(callId, `${failed ? "✗ " : ""}${oneLine(activity.summary, 200)}`);
  }
  return [...byCall.values()];
}

interface TurnBlock {
  readonly turn: StoredTurn;
  readonly prompts: readonly StoredMessage[];
  readonly replies: readonly StoredMessage[];
  readonly tools: readonly string[];
  /** The message that opened this thread with a hand-off document, when this block holds it. */
  readonly openerMessageId: string | null;
}

/** The line standing in for the opening hand-off in the conversation: its facts live in this document's head. */
const OPENER_LINE = "_This prompt was the hand-off record that opened this thread; the sections above carry its goal and its last request, and this document supersedes it._";

function verbatim(block: TurnBlock, index: number, threadId: string, pieceCap = PIECE_CHARS): string {
  const lines: string[] = [`### Turn ${index + 1}${block.turn.status === "completed" ? "" : ` (${block.turn.status})`}`];
  for (const prompt of block.prompts) lines.push("", "**User:**", "", prompt.id === block.openerMessageId ? OPENER_LINE : piece(prompt.text.trim(), threadId, pieceCap));
  if (block.tools.length > 0) {
    lines.push("", "**Work:**");
    for (const tool of block.tools.slice(0, MAX_TOOL_LINES)) lines.push(`- ${tool}`);
    if (block.tools.length > MAX_TOOL_LINES) lines.push(`- …and ${block.tools.length - MAX_TOOL_LINES} more tool calls`);
  }
  for (const reply of block.replies) lines.push("", "**Assistant:**", "", piece(reply.text.trim(), threadId, pieceCap));
  if (block.turn.status === "failed" && block.turn.error) lines.push("", `_Failed: ${oneLine(block.turn.error, 300)}_`);
  return lines.join("\n");
}

function summarized(block: TurnBlock, index: number): string {
  const asked = block.prompts[0] !== undefined && block.prompts[0]!.id === block.openerMessageId
    ? "the hand-off that opened this thread"
    : block.prompts[0] ? oneLine(block.prompts[0].text, 120) : "(no prompt)";
  const answered = block.replies.at(-1) ? oneLine(block.replies.at(-1)!.text, 120) : block.turn.status;
  const work = block.tools.length > 0 ? ` · ${block.tools.length} tool call${block.tools.length === 1 ? "" : "s"}` : "";
  return `- Turn ${index + 1}: asked "${asked}" → ${answered}${work}`;
}

/** The latest checklist the thread was working through, its rows capped, the oldest dropped and marked. */
function planFacts(activities: readonly StoredActivity[], threadId: string): { rows: string[]; omitted: number } {
  const rows = openPlan(activities);
  if (rows.length <= PLAN_ROWS) return { rows, omitted: 0 };
  const dropped = rows.length - PLAN_ROWS;
  return {
    rows: [`- …${dropped} earlier checklist steps not shown; read thread ${threadId}`, ...rows.slice(-PLAN_ROWS)],
    omitted: dropped,
  };
}

/** Rows of the thread's open plan, uncapped, oldest last. */
function openPlan(activities: readonly StoredActivity[]): string[] {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== "turn.plan.updated" || !Array.isArray(activity.payload?.plan)) continue;
    return (activity.payload.plan as unknown[]).flatMap((row) => {
      const record = asRecord(row);
      const step = typeof record?.step === "string" ? record.step : null;
      if (step === null) return [];
      const status = typeof record?.status === "string" ? record.status : "pending";
      const mark = status === "completed" ? "[x]" : status === "inProgress" || status === "in_progress" ? "[~]" : "[ ]";
      return [`- ${mark} ${step}`];
    });
  }
  return [];
}

/** Why the thread's last turn ended, and whether that is the end of the work: a turn that simply completed may have finished the task. */
function stoppedBecause(last: TurnBlock | undefined, activities: readonly StoredActivity[]): { text: string; completed: boolean } {
  const stopped = (text: string) => ({ text, completed: false });
  if (last === undefined) return stopped("The thread had not run a turn yet.");
  const limit = activities.find(
    (activity) => activity.turnId === last.turn.id && (activity.kind === "usage.limit" || activity.kind === "usage.wrap-up"),
  );
  if (limit) {
    const label = typeof limit.payload?.label === "string" ? `${limit.payload.label} ` : "";
    return stopped(`It stopped on a plan usage limit (${label}window), mid-task. Nothing about the work itself went wrong.`);
  }
  if (last.turn.status === "failed") return stopped(`Its last turn failed: ${oneLine(last.turn.error ?? "no error recorded", 300)}`);
  if (last.turn.status === "interrupted") return stopped("Its last turn was interrupted before it finished.");
  if (last.turn.status === "running" || last.turn.status === "queued") return stopped("Its last turn had not finished.");
  return { text: "Its last turn ran to completion. The work may already be done: this thread was moved on (its context window may have filled), not necessarily because anything was left.", completed: true };
}

export interface HandoffOptions {
  readonly projectTitle?: string | null;
  readonly preferModelSummary?: boolean;
  readonly modelSummary?: string;
  /** The first instruction the new thread is being given with this hand-off (the continue request's first message). */
  readonly firstAction?: string;
  readonly queuedTurnIds?: readonly string[];
  /**
   * The source turns visible when a manual continue claimed its moves: the
   * handoff projects exactly this set, so source work accepted after the
   * claim belongs only to the source — never assigned as destination work
   * nor captured in its snapshot — while claimed moves stay excluded by
   * their marker. Only the manual path passes it.
   */
  readonly knownTurnIds?: readonly string[];
  /**
   * Turns this call itself claimed for the move: hidden like moved turns,
   * since the migration runs right after this read. Only the manual path
   * passes it.
   */
  readonly excludedTurnIds?: readonly string[];
}

/** A hand-off document next to the facts its destination's record carries forward. */
export interface PreparedHandoff {
  readonly document: string;
  readonly facts: HandoffFacts;
}

export async function prepareHandoff(store: ThreadStore, threadId: string, options: HandoffOptions = {}): Promise<PreparedHandoff> {
  const thread = (await store.readThreadRecord(threadId)) as StoredThread | null;
  if (!thread) throw new Error(`No thread ${threadId}.`);
  const [allTurns, messages, activities, checkpoints] = await Promise.all([
    store.readTurns(threadId),
    store.readMessages(threadId),
    store.readActivities(threadId),
    store.readCheckpoints(threadId),
  ]);
  // A manual continue pins the projection to its claim: turns accepted after
  // the claim belong only to the source, so neither history nor an
  // immediate task here, whether still queued or already promoted.
  const knownTurns = options.knownTurnIds ? new Set(options.knownTurnIds) : null;
  const turns = knownTurns ? allTurns.filter((turn) => knownTurns.has(turn.id)) : allTurns;
  // Turn-scoped rows follow the same boundary; thread-level rows (a null
  // turn) stay. Checklists and file stats name their turn, so a late plan or
  // checkpoint drops out while pre-claim ones remain.
  const scopedActivities = activities.filter((activity) => activity.turnId == null || !knownTurns || knownTurns.has(activity.turnId));
  const scopedCheckpoints = knownTurns
    ? checkpoints.filter((checkpoint) => checkpoint.turnId == null || knownTurns.has(checkpoint.turnId))
    : checkpoints;

  // The hand-off that opened this thread, by the provenance the continue
  // path records on the turn — never by its text, which a user message can
  // quote. It is never retold: retelling it is what multiplied a chain of
  // continuations hop by hop.
  const openerTurn = turns.find((turn) => turn.handoffOpen === true) ?? null;
  const openerMessageId = openerTurn === null ? null : openerTurn.messageId;
  const carried = thread.handoffFacts ?? null;

  // A turn has reached the agent once it produced something. One that is
  // queued, or was promoted to `running` by a settle but never ran (the
  // runner held it for a usage reset, or its process went away), carries
  // only the user's message: that is a request still to do, not history.
  const produced = new Set([
    ...messages.filter((message) => message.role === "assistant").map((message) => message.turnId),
    ...activities.filter((activity) => typeof activity.payload?.toolCallId === "string").map((activity) => activity.turnId ?? ""),
  ]);
  const terminal = (turn: StoredTurn): boolean => turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
  const reached = (turn: StoredTurn): boolean => terminal(turn) || produced.has(turn.id);
  // Moved messages run as Work queue entries on the new thread: they are
  // neither history to retell nor immediate work for this turn. Only landed
  // moves count — a staged claim alone is not a move — plus the turns this
  // call itself claimed, whose migration follows this read.
  const excluded = new Set(options.excludedTurnIds ?? []);
  const moved = turns.filter((turn) => isTransferLanded(turn) || excluded.has(turn.id));
  const movedIds = new Set(moved.map((turn) => turn.id));
  const sent = turns.filter((turn) => reached(turn) && !turn.queue?.summaryFor && !movedIds.has(turn.id));
  const blocks: TurnBlock[] = sent.map((turn) => ({
    turn,
    prompts: messages.filter((message) => message.turnId === turn.id && message.role === "user"),
    replies: messages.filter((message) => message.turnId === turn.id && message.role === "assistant" && message.text.trim().length > 0),
    tools: toolLines(activities.filter((activity) => activity.turnId === turn.id)),
    openerMessageId,
  }));

  // Pending requests: durable work, carried whole. The queued turns of this
  // thread, plus the ones the chain behind it already carried whose message
  // never landed here — an entry that did land became this thread's own.
  const messageIds = new Set(messages.map((message) => message.id));
  const queuedIds = new Set(options.queuedTurnIds);
  const unsentTurns = turns.filter(
    (turn) => turn.handoffOpen !== true
      && !reached(turn)
      && !movedIds.has(turn.id)
      && !(options.preferModelSummary && turn.scheduledFor)
      && (!options.queuedTurnIds || queuedIds.has(turn.id)),
  );
  const ownPending: HandoffPendingRequest[] = unsentTurns.flatMap((turn) => {
    const message = messages.find(
      (entry) => entry.id === turn.messageId
        && entry.origin !== "usage-continue"
        && entry.origin !== "usage-protection"
        && entry.origin !== "handoff-summary",
    );
    if (message === undefined) return [];
    return [{
      sourceThreadId: thread.id,
      turnId: turn.id,
      messageId: message.id,
      text: message.text.trim(),
      ...(turn.scheduledFor !== undefined && turn.scheduledFor !== null ? { scheduledFor: turn.scheduledFor } : {}),
    }];
  });
  const carriedPending = (carried?.pending ?? []).filter((entry) => !messageIds.has(entry.messageId) && !ownPending.some((own) => own.messageId === entry.messageId));
  const pending = [...carriedPending, ...ownPending];

  // Files the chain already changed, summed across every turn's checkpoint
  // and the ones carried forward, capped with the omissions counted.
  const fileMap = new Map<string, { additions: number; deletions: number }>();
  for (const file of carried?.files ?? []) fileMap.set(file.path, { additions: file.additions, deletions: file.deletions });
  for (const checkpoint of scopedCheckpoints) {
    for (const file of checkpoint.files ?? []) {
      const stat = fileMap.get(file.path) ?? { additions: 0, deletions: 0 };
      fileMap.set(file.path, { additions: stat.additions + file.additions, deletions: stat.deletions + file.deletions });
    }
  }
  const files = [...fileMap.entries()].sort(([left], [right]) => left.localeCompare(right));
  const filesKept = files.slice(0, FILES_ROWS).map(([path, stat]) => ({ path, additions: stat.additions, deletions: stat.deletions }));
  const filesOmitted = files.length - filesKept.length;

  // The chain's images: this thread's own attachments plus the carried ones, deduped by path.
  const images = [
    ...messages
      .filter((message) => !knownTurns || knownTurns.has(message.turnId))
      .flatMap((message) => message.attachments ?? [])
      .filter((attachment) => attachment.type === "image")
      .map((attachment) => ({ name: attachment.name, path: attachment.path })),
    ...(carried?.images ?? []),
  ];
  const imagesKept = images.filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index).slice(0, IMAGES_ROWS);
  const imagesOmitted = images.length - imagesKept.length;

  const planFactsOfThisThread = planFacts(scopedActivities, thread.id);
  const plan = planFactsOfThisThread.rows.length > 0 ? planFactsOfThisThread.rows : [...(carried?.plan ?? [])];

  const hasAnswer = [...messages].some((message) => message.role === "assistant" && message.text.trim().length > 0);
  const userPrompts = blocks.flatMap((block) => block.prompts).filter((message) => !message.origin && message.id !== openerMessageId);
  // The chain's goal never yields to a later steer: the original request
  // stays the goal, the newest request the last request.
  const goal = carried?.goal ?? carriedText(userPrompts[0]?.text, thread.id, REQUEST_CHARS);
  const lastRequest = carriedText(userPrompts.at(-1)?.text, thread.id, REQUEST_CHARS) ?? carried?.lastRequest ?? null;
  const firstAction = options.firstAction !== undefined
    ? carriedText(options.firstAction, thread.id, REQUEST_CHARS)
    : hasAnswer ? null : carried?.firstAction ?? null;

  const summaryBlock = thread.usagePause?.turnId ? blocks.find((block) => block.turn.id === thread.usagePause!.turnId) : blocks.at(-1);
  const authoredSummary = options.modelSummary
    ?? (options.preferModelSummary ? summaryBlock?.replies.map((reply) => reply.text.trim()).join("\n\n") ?? null : null);
  const wrapUp = carriedText(authoredSummary, thread.id, WRAPUP_CHARS) ?? carried?.wrapUp ?? null;
  // The wrap-up rendered *here* is this thread's own (below), never one this
  // hop already consumed into `authoredSummary`; a carried one renders only
  // while the chain has not answered beyond it.
  const carriedWrapUp = authoredSummary === null && !hasAnswer ? carried?.wrapUp ?? null : null;

  const stopped = stoppedBecause(blocks.at(-1), activities);
  // Only a last turn that ran to completion, with nothing queued, nothing
  // moved, and no open checklist step, may be a finished task.
  const finished = stopped.completed && pending.length === 0 && moved.length === 0 && plan.every((row) => row.startsWith("- [x]"));
  const where = thread.env.branch ? `${thread.env.path} (branch ${thread.env.branch})` : thread.env.path;

  const head: string[] = [
    `# Continuing: ${thread.title}`,
    "",
    `You are picking up a thread another session worked on${finished ? "" : " and did not finish"}. Below is its record, written by Moxen from the thread's ledger — you have none of the original context beyond this. Read "Where it stopped" first. Every cut or omission below names the thread whose ledger holds the full text.`,
    "",
    `- Working directory: ${where}`,
    ...(options.projectTitle ? [`- Project: ${options.projectTitle}`] : []),
    `- Model it ran on: ${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    `- Turns so far: ${blocks.length}`,
    `- Its record before this one: thread ${thread.id}`,
    "",
    "## Where it stopped",
    "",
    stopped.text,
  ];
  const facts: HandoffFacts = {
    sourceThreadId: thread.id,
    goal,
    lastRequest,
    firstAction,
    wrapUp,
    plan,
    files: filesKept,
    ...(filesOmitted > 0 ? { filesOmitted } : {}),
    images: imagesKept,
    ...(imagesOmitted > 0 ? { imagesOmitted } : {}),
    pending,
  };

  if (goal !== null && goal.text !== lastRequest?.text) {
    head.push("", "The thread began with:", "", authoredSummary !== null ? goal.text : `> ${oneLine(goal.text, 400)}`);
  }
  if (lastRequest !== null) head.push("", "The last request, verbatim:", "", lastRequest.text);
  if (plan.length > 0) head.push("", "Its checklist when it stopped (`[x]` done, `[~]` in progress, `[ ]` open):", "", ...plan);
  if (firstAction !== null && options.firstAction === undefined) {
    head.push("", "## What to do first", "", "This instruction came with the chain and nothing has answered it yet:", "", firstAction.text);
  }
  if (moved.length > 0) {
    head.push(
      "",
      moved.length === 1
        ? "The user had queued a message that had not run; it moved to the new thread's Work queue with this continuation and will arrive as a follow-up turn — it is not part of this turn's work."
        : `The user had queued ${moved.length} messages that had not run; they moved to the new thread's Work queue with this continuation and will arrive as follow-up turns — they are not part of this turn's work.`,
      "",
    );
  }
  const pendingChars = pending.reduce((sum, entry, index) => sum + entry.text.length
    + `${index + 1}. `.length
    + (entry.sourceThreadId === thread.id ? 0 : `(from thread ${entry.sourceThreadId}) `.length)
    + (entry.scheduledFor != null ? `(do not start before ${entry.scheduledFor}) `.length : 0), 0);
  if (pending.length > 0) {
    head.push("", "The user queued these and they were never sent — treat them as part of the task, in this order:", "");
    pending.forEach((entry, index) => {
      const prefix = [
        ...(entry.sourceThreadId === thread.id ? [] : [`(from thread ${entry.sourceThreadId})`]),
        ...(entry.scheduledFor != null ? [`(do not start before ${entry.scheduledFor})`] : []),
      ];
      head.push(`${index + 1}. ${prefix.join(" ")}${prefix.length > 0 ? " " : ""}${entry.text}`);
    });
  }
  if (filesKept.length > 0 || filesOmitted > 0) {
    head.push("", "## Files already changed", "", "These edits, from this thread and the chain behind it, are on disk now. Check the working tree before redoing anything — some work may be partly done.", "");
    for (const file of filesKept) head.push(`- ${file.path} +${file.additions} −${file.deletions}`);
    if (filesOmitted > 0) head.push(`- …and ${filesOmitted} more changed files not shown; read thread ${thread.id}`);
  }
  if (imagesKept.length > 0 || imagesOmitted > 0) {
    head.push("", "## Original images", "", "These original image files remain on this server. Open them with your image/file tools when the task depends on visual input:", "");
    for (const image of imagesKept) head.push(`- ${JSON.stringify(image.name)}: ${JSON.stringify(image.path)}`);
    if (imagesOmitted > 0) head.push(`- …and ${imagesOmitted} more original images not shown; read thread ${thread.id}`);
  }
  if (authoredSummary !== null) {
    return {
      document: [...head, "", "## Model's wrap-up", "", clamped(authoredSummary, WRAPUP_CHARS, thread.id), "", "Continue the unfinished task from these notes; do not repeat completed work."].join("\n"),
      facts,
    };
  }
  if (carriedWrapUp !== null) {
    head.push("", "## Model's wrap-up", "", "The latest wrap-up the chain authored; this thread has not answered beyond it:", "", carriedWrapUp.text);
  }
  const tail = [
    "",
    "---",
    "",
    finished
      ? "Check the working tree against the last request before doing anything. If the work is complete, say so and wait for the user — do not redo it. If part of the request is still open, finish that part."
      : "Continue the task from \"Where it stopped\". Do not start over: verify what is already done, then finish what is left.",
  ].join("\n");

  // Keep the most recent turns verbatim, shrinking older ones until the
  // document fits: the latest turns are where the unfinished work is. When
  // even the summaries would not fit, the oldest turns drop, marked with
  // the thread that holds them, and the verbatim pieces shrink — the
  // rendered context never leaves its budget, however long the thread.
  const pendingBudget = pendingChars;
  let verbatimFrom = Math.max(0, blocks.length - VERBATIM_TURNS);
  let pieceCap = PIECE_CHARS;
  let summaryRowCap = SUMMARY_ROWS;
  const render = (): string => {
    const older = blocks.slice(0, verbatimFrom).map((block, index) => summarized(block, index));
    const recent = blocks.slice(verbatimFrom).map((block, index) => verbatim(block, verbatimFrom + index, thread.id, pieceCap));
    let olderRows = older;
    let droppedTurns = 0;
    if (olderRows.length > summaryRowCap) {
      droppedTurns = olderRows.length - summaryRowCap;
      olderRows = [`…${droppedTurns} earlier turns not retold; read thread ${thread.id}`, ...olderRows.slice(-summaryRowCap)];
    }
    const conversation = [
      "",
      "## Conversation",
      ...(olderRows.length > 0 ? ["", "Earlier turns, in brief:", "", ...olderRows] : []),
      ...recent.flatMap((block) => ["", block]),
    ];
    return [...head, ...conversation].join("\n") + tail;
  };
  let document = render();
  while (document.length - pendingBudget > RENDER_BUDGET) {
    if (pieceCap > 1_000) {
      pieceCap = Math.max(1_000, Math.floor(pieceCap / 4));
    } else if (summaryRowCap > 20) {
      summaryRowCap = Math.max(20, Math.floor(summaryRowCap / 4));
    } else if (verbatimFrom < blocks.length - 1) {
      verbatimFrom += 1;
    } else {
      break;
    }
    document = render();
  }
  while (document.length > TARGET_CHARS && verbatimFrom < blocks.length - 1) {
    verbatimFrom += 1;
    document = render();
  }
  return { document, facts };
}

/** The hand-off document alone, as every caller that writes no facts uses it. */
export async function buildHandoff(store: ThreadStore, threadId: string, options: HandoffOptions = {}): Promise<string> {
  return (await prepareHandoff(store, threadId, options)).document;
}

/** The new thread's title: the old one, marked, without piling up marks. */
export function continuedTitle(title: string): string {
  const base = title.replace(/\s+\(continued(?: \d+)?\)$/u, "");
  const match = /\(continued(?: (\d+))?\)$/u.exec(title);
  if (match === null) return `${base} (continued)`;
  const next = match[1] === undefined ? 2 : Number(match[1]) + 1;
  return `${base} (continued ${next})`;
}

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
 */
import { ranTurns, turnOrdinals } from "./project.js";
import type { ThreadStore } from "./store.js";
import type { StoredActivity, StoredMessage, StoredThread, StoredTurn } from "./types.js";

/** Turns kept word for word; older ones become a one-line summary each. */
const VERBATIM_TURNS = 12;
/** Past this, verbatim turns shrink too, oldest first, until it fits. */
const TARGET_CHARS = 60_000;
/** Tool calls listed per turn before "+N more". */
const MAX_TOOL_LINES = 40;

function oneLine(text: string, max = 140): string {
  const line = text.split(/\r?\n/u).map((row) => row.trim()).find((row) => row.length > 0) ?? "";
  const single = line.replace(/\s+/gu, " ");
  return single.length <= max ? single : `${single.slice(0, max)}…`;
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
  /** The canonical ordinal of this turn, from `ranTurns` before any filtering. */
  readonly ordinal: number;
  readonly prompts: readonly StoredMessage[];
  readonly replies: readonly StoredMessage[];
  readonly tools: readonly string[];
}

function verbatim(block: TurnBlock): string {
  const lines: string[] = [`### Turn ${block.ordinal}${block.turn.status === "completed" ? "" : ` (${block.turn.status})`}`];
  for (const prompt of block.prompts) lines.push("", "**User:**", "", prompt.text.trim());
  if (block.tools.length > 0) {
    lines.push("", "**Work:**");
    for (const tool of block.tools.slice(0, MAX_TOOL_LINES)) lines.push(`- ${tool}`);
    if (block.tools.length > MAX_TOOL_LINES) lines.push(`- …and ${block.tools.length - MAX_TOOL_LINES} more tool calls`);
  }
  for (const reply of block.replies) lines.push("", "**Assistant:**", "", reply.text.trim());
  if (block.turn.status === "failed" && block.turn.error) lines.push("", `_Failed: ${oneLine(block.turn.error, 300)}_`);
  return lines.join("\n");
}

function summarized(block: TurnBlock): string {
  const asked = block.prompts[0] ? oneLine(block.prompts[0].text, 120) : "(no prompt)";
  const answered = block.replies.at(-1) ? oneLine(block.replies.at(-1)!.text, 120) : block.turn.status;
  const work = block.tools.length > 0 ? ` · ${block.tools.length} tool call${block.tools.length === 1 ? "" : "s"}` : "";
  return `- Turn ${block.ordinal}: asked "${asked}" → ${answered}${work}`;
}

/** The latest checklist the thread was working through, if any. */
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
  readonly queuedTurnIds?: readonly string[];
}

/**
 * The turns this document numbers: the same run order every reader uses
 * (`ranTurns`), without the model-summary turn — plumbing for the handoff,
 * not part of the conversation.
 */
function countedTurns(turns: readonly StoredTurn[]): StoredTurn[] {
  return ranTurns(turns).filter((turn) => !turn.queue?.summaryFor);
}

/**
 * An entry the handoff path settled here: its request moved to another thread
 * (prepared, or failed preparing), so it is neither history nor pending work
 * in this document. An entry still queued has not moved yet and stays pending
 * — even after an earlier attempt failed — so restoring it and releasing it
 * carries the same request into the next handoff instead of dropping it.
 * `handoffFailed` only keeps a historical row (one that never ran) out of the
 * document once it is no longer queued.
 */
function leftForAnotherThread(turn: StoredTurn): boolean {
  if (turn.status === "queued") return false;
  return turn.handoffFailed === true || turn.handoff !== undefined;
}

/**
 * Whether this row is a request still waiting to be sent, so the document
 * lists it as work to do: not a turn that ran (dispatch evidence), not one the
 * handoff path settled here (disposition), and — when the handoff names the
 * entry it is carrying — that entry (ownership). The three stay separate
 * predicates so another branch can add its own filter without renumbering
 * anything.
 */
function pendingRequest(turn: StoredTurn, counted: ReadonlySet<string>, options: HandoffOptions): boolean {
  return (
    !counted.has(turn.id) &&
    !turn.queue?.summaryFor &&
    !leftForAnotherThread(turn) &&
    !(options.preferModelSummary && turn.scheduledFor) &&
    (!options.queuedTurnIds || options.queuedTurnIds.includes(turn.id))
  );
}

export async function buildHandoff(store: ThreadStore, threadId: string, options: HandoffOptions = {}): Promise<string> {
  const thread = (await store.readThreadRecord(threadId)) as StoredThread | null;
  if (!thread) throw new Error(`No thread ${threadId}.`);
  const [turns, messages, activities, checkpoints] = await Promise.all([
    store.readTurns(threadId),
    store.readMessages(threadId),
    store.readActivities(threadId),
    store.readCheckpoints(threadId),
  ]);

  // Numbered from the run order, like thread_read, checkpoints and revert: an
  // entry handed off to a new thread does not take a number from a turn that
  // ran after it. The ordinal is attached before the model-summary turn is
  // dropped from the conversation, so a real turn after it keeps the number
  // every reader gives it.
  const ordinals = turnOrdinals(turns);
  const runCount = ordinals.size;
  const history = countedTurns(turns);
  const counted = new Set(history.map((turn) => turn.id));
  const blocks: TurnBlock[] = history.map((turn) => ({
    turn,
    ordinal: ordinals.get(turn.id)!,
    prompts: messages.filter((message) => message.turnId === turn.id && message.role === "user"),
    replies: messages.filter((message) => message.turnId === turn.id && message.role === "assistant" && message.text.trim().length > 0),
    tools: toolLines(activities.filter((activity) => activity.turnId === turn.id)),
  }));
  // What never ran here is a request still to do, not delivered history. The
  // entry this handoff is carrying is still queued, so it stays listed.
  const unsent = turns
    .filter((turn) => pendingRequest(turn, counted, options))
    .flatMap((turn) => messages.filter((message) => message.id === turn.messageId && message.origin !== "usage-continue" && message.origin !== "usage-protection" && message.origin !== "handoff-summary"));

  // Files the thread changed, summed across every turn's checkpoint.
  const files = new Map<string, { additions: number; deletions: number }>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files ?? []) {
      const known = files.get(file.path) ?? { additions: 0, deletions: 0 };
      files.set(file.path, { additions: known.additions + file.additions, deletions: known.deletions + file.deletions });
    }
  }

  const userPrompts = blocks.flatMap((block) => block.prompts).filter((message) => !message.origin);
  const firstPrompt = userPrompts[0]?.text.trim() ?? null;
  const lastPrompt = userPrompts.at(-1)?.text.trim() ?? null;
  const plan = openPlan(activities);
  const stopped = stoppedBecause(blocks.at(-1), activities);
  // Only a last turn that ran to completion, with nothing queued and no open checklist step, may be a finished task.
  const finished = stopped.completed && unsent.length === 0 && plan.every((row) => row.startsWith("- [x]"));
  const where = thread.env.branch ? `${thread.env.path} (branch ${thread.env.branch})` : thread.env.path;

  const head: string[] = [
    `# Continuing: ${thread.title}`,
    "",
    `You are picking up a thread another session worked on${finished ? "" : " and did not finish"}. Below is its record, written by Moxen from the thread's ledger — you have none of the original context beyond this. Read "Where it stopped" first.`,
    "",
    `- Working directory: ${where}`,
    ...(options.projectTitle ? [`- Project: ${options.projectTitle}`] : []),
    `- Model it ran on: ${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    // The thread's real run count, not just the conversation blocks shown:
    // the handoff's own model-summary turn ran but is not conversation.
    `- Turns so far: ${runCount}${blocks.length === runCount ? "" : ` (${blocks.length} in this record)`}`,
    "",
    "## Where it stopped",
    "",
    stopped.text,
  ];
  if (firstPrompt !== null && firstPrompt !== lastPrompt) head.push("", "The thread began with:", "", options.preferModelSummary || options.modelSummary ? firstPrompt : `> ${oneLine(firstPrompt, 400)}`);
  if (lastPrompt !== null) head.push("", "The last request, verbatim:", "", lastPrompt);
  if (plan.length > 0) head.push("", "Its checklist when it stopped (`[x]` done, `[~]` in progress, `[ ]` open):", "", ...plan);
  if (unsent.length > 0) {
    head.push("", "The user queued these and they were never sent — treat them as part of the task, in this order:", "");
    unsent.forEach((message, index) => head.push(`${index + 1}. ${message.text.trim()}`));
  }
  if (files.size > 0) {
    head.push("", "## Files already changed in this thread", "", "These edits are on disk now. Check the working tree before redoing anything — some work may be partly done.", "");
    for (const [path, stat] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      head.push(`- ${path} +${stat.additions} −${stat.deletions}`);
    }
  }
  const images = messages.flatMap((message) => message.attachments ?? []).filter((attachment) => attachment.type === "image");
  if (images.length > 0) {
    head.push("", "## Original images", "", "These original image files remain on this server. Open them with your image/file tools when the task depends on visual input:", ...images.map((image) => `- ${JSON.stringify(image.name)}: ${JSON.stringify(image.path)}`));
  }
  const summaryBlock = thread.usagePause?.turnId ? blocks.find((block) => block.turn.id === thread.usagePause!.turnId) : blocks.at(-1);
  const modelSummary = options.modelSummary ?? (options.preferModelSummary ? summaryBlock?.replies.map((reply) => reply.text.trim()).join("\n\n") : null);
  if (modelSummary) return [...head, "", "## Model's wrap-up", "", modelSummary, "", "Continue the unfinished task from these notes; do not repeat completed work."].join("\n");
  const tail = [
    "",
    "---",
    "",
    finished
      ? "Check the working tree against the last request before doing anything. If the work is complete, say so and wait for the user — do not redo it. If part of the request is still open, finish that part."
      : "Continue the task from \"Where it stopped\". Do not start over: verify what is already done, then finish what is left.",
  ].join("\n");

  // Keep the most recent turns verbatim, shrinking older ones until the
  // document fits: the latest turns are where the unfinished work is.
  let verbatimFrom = Math.max(0, blocks.length - VERBATIM_TURNS);
  const render = (): string => {
    const older = blocks.slice(0, verbatimFrom).map((block) => summarized(block));
    const recent = blocks.slice(verbatimFrom).map((block) => verbatim(block));
    const conversation = [
      "",
      "## Conversation",
      ...(older.length > 0 ? ["", "Earlier turns, in brief:", "", ...older] : []),
      ...recent.flatMap((block) => ["", block]),
    ];
    return [...head, ...conversation].join("\n") + tail;
  };
  let document = render();
  while (document.length > TARGET_CHARS && verbatimFrom < blocks.length - 1) {
    verbatimFrom += 1;
    document = render();
  }
  return document;
}

/** The new thread's title: the old one, marked, without piling up marks. */
export function continuedTitle(title: string): string {
  const base = title.replace(/\s+\(continued(?: \d+)?\)$/u, "");
  const match = /\(continued(?: (\d+))?\)$/u.exec(title);
  if (match === null) return `${base} (continued)`;
  const next = match[1] === undefined ? 2 : Number(match[1]) + 1;
  return `${base} (continued ${next})`;
}

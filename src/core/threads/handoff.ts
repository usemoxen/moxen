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
 * A continued thread continues in its turn: the hand-off that opened it is
 * itself the thread's first prompt, so a hand-off built from a chain of
 * continuations would nest the previous hand-off inside itself, multiplying
 * with every hop. So the opening hand-off is recognized by its head
 * line and never retold: only its bounded facts (the goal, the last request,
 * the plan, the files, the images) are carried forward, and this thread's
 * own transcript is told instead. Every section is capped, so one document
 * has a ceiling however many hops the chain behind it had.
 */
import type { ThreadStore } from "./store.js";
import { isTransferLanded } from "./queue.js";
import type { StoredActivity, StoredMessage, StoredThread, StoredTurn } from "./types.js";

/** Turns kept word for word; older ones become a one-line summary each. */
const VERBATIM_TURNS = 12;
/** Past this, verbatim turns shrink too, oldest first, until it fits. */
const TARGET_CHARS = 60_000;
/** Tool calls listed per turn before "+N more". */
const MAX_TOOL_LINES = 40;
/** Every hand-off document starts with this line, so one can be told apart from a user message. */
const HANDOFF_HEAD = "# Continuing: ";
/** A single prompt or reply kept word for word before it is cut. */
const PIECE_CHARS = 16_000;
/** The largest a "last request, verbatim" (or an unsent message) is kept before it is cut. */
const REQUEST_CHARS = 16_000;
/** The largest a model wrap-up is kept at, matching the submit tool's own cap. */
const WRAPUP_CHARS = 64_000;
/** Carried checklist steps and image lines kept from the opening hand-off. */
const CARRY_LINES = 60;
/** Carried file rows kept from the opening hand-off. */
const CARRY_FILES = 200;

function oneLine(text: string, max = 140): string {
  const line = text.split(/\r?\n/u).map((row) => row.trim()).find((row) => row.length > 0) ?? "";
  const single = line.replace(/\s+/gu, " ");
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}

/** Cut a verbatim section to its cap, saying so: the full text lives in the thread's ledger. */
function clamped(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(cut at ${max} of ${text.length} characters; the full text stays in this thread's ledger)`;
}

/** A single prompt or reply, cut when a block would dwarf the whole document. */
function piece(text: string): string {
  if (text.length <= PIECE_CHARS) return text;
  return `${text.slice(0, PIECE_CHARS)}…(cut at ${PIECE_CHARS} of ${text.length} characters)`;
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
  /** The id of the hand-off that opened this thread, when this block's first prompt is it. */
  readonly openerId: string | null;
}

/** The line standing in for the opening hand-off in the conversation: its facts live in this document's head. */
const OPENER_LINE = "_This prompt was the hand-off record that opened this thread; the sections above carry its goal and its last request, and this document supersedes it._";

function verbatim(block: TurnBlock, index: number): string {
  const lines: string[] = [`### Turn ${index + 1}${block.turn.status === "completed" ? "" : ` (${block.turn.status})`}`];
  for (const prompt of block.prompts) lines.push("", "**User:**", "", prompt.id === block.openerId ? OPENER_LINE : piece(prompt.text.trim()));
  if (block.tools.length > 0) {
    lines.push("", "**Work:**");
    for (const tool of block.tools.slice(0, MAX_TOOL_LINES)) lines.push(`- ${tool}`);
    if (block.tools.length > MAX_TOOL_LINES) lines.push(`- …and ${block.tools.length - MAX_TOOL_LINES} more tool calls`);
  }
  for (const reply of block.replies) lines.push("", "**Assistant:**", "", piece(reply.text.trim()));
  if (block.turn.status === "failed" && block.turn.error) lines.push("", `_Failed: ${oneLine(block.turn.error, 300)}_`);
  return lines.join("\n");
}

function summarized(block: TurnBlock, index: number): string {
  const asked = block.prompts[0] !== undefined && block.prompts[0]!.id === block.openerId
    ? "the hand-off that opened this thread"
    : block.prompts[0] ? oneLine(block.prompts[0].text, 120) : "(no prompt)";
  const answered = block.replies.at(-1) ? oneLine(block.replies.at(-1)!.text, 120) : block.turn.status;
  const work = block.tools.length > 0 ? ` · ${block.tools.length} tool call${block.tools.length === 1 ? "" : "s"}` : "";
  return `- Turn ${index + 1}: asked "${asked}" → ${answered}${work}`;
}

/**
 * The bounded facts carried forward from the hand-off that opened this
 * thread — all a chain of continuations may keep of the documents before
 * it, so a hand-off never nests an earlier one.
 */
interface CarriedHandoff {
  /** "The thread began with": the goal, as far as it was ever written down. */
  readonly goal: string | null;
  /** "The last request, verbatim": the request the chain is still working on. */
  readonly lastRequest: string | null;
  /** The checklist steps as the opening hand-off last recorded them. */
  readonly plan: readonly string[];
  /** Files the thread behind already changed, summed like the section below sums its own. */
  readonly files: readonly { readonly path: string; readonly additions: number; readonly deletions: number }[];
  /** The formatted image lines of the opening hand-off's "Original images" section. */
  readonly images: readonly string[];
}

/** Section headings that end a carried prose block: everything a hand-off's head may follow one with. */
const CARRIED_STOPS = [
  "The thread began with:",
  "The last request, verbatim:",
  "Its checklist when it stopped",
  "The user had queued",
  "The user queued these",
  "## ",
  "---",
];

/** The prose after a section heading, cut at its stop: the goal or the last request as the opener carried them. */
function carriedProse(text: string, heading: string): string | null {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;
  const rows: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (CARRIED_STOPS.some((stop) => line.startsWith(stop))) break;
    if (rows.length === 0 && line.trim() === "") continue;
    rows.push(line);
  }
  const joined = rows.join("\n").trim();
  return joined.length > 0 ? clamped(joined, REQUEST_CHARS) : null;
}

/** The `- ` list after a section heading, only lines matching `keep`'s shape, at most `cap` of them. */
function carriedList(text: string, heading: string, keep: (line: string) => boolean, cap: number): string[] {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return [];
  const rows: string[] = [];
  for (let index = start + 1; index < lines.length && index <= start + 8 && rows.length < cap; index += 1) {
    const line = lines[index]!.trim();
    if (line.startsWith("## ") || line === "" || line.startsWith("---")) continue;
    if (keep(line)) rows.push(line);
  }
  return rows;
}

/** The opening hand-off's bounded facts, parsed out of the document this thread opened with. */
function carriedHandoff(text: string): CarriedHandoff {
  return {
    goal: carriedProse(text, "The thread began with:")?.replace(/^>\s*/u, "") ?? null,
    lastRequest: carriedProse(text, "The last request, verbatim:"),
    plan: carriedList(text, "Its checklist when it stopped", (line) => /^- \[[x~ ]\] /u.test(line), CARRY_LINES),
    files: carriedList(text, "## Files already changed", (line) => /^- .+ \+\d+ −\d+$/u.test(line), CARRY_FILES)
      .map((line) => {
        const match = /^- (.+) \+(\d+) −(\d+)$/u.exec(line)!;
        return { path: match[1]!, additions: Number(match[2]), deletions: Number(match[3]) };
      }),
    images: carriedList(text, "## Original images", (line) => /^- ".*": ".*"$/u.test(line), CARRY_LINES),
  };
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

export async function buildHandoff(store: ThreadStore, threadId: string, options: HandoffOptions = {}): Promise<string> {
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

  // The hand-off that opened this thread, when it was opened by one: Moxen
  // wrote that prompt, not the user. Retelling it — in the head as the last
  // request or in the conversation as a turn — is what made each hop's
  // hand-off embed the whole one before it and double chain-wide, so it is
  // never retold: only its bounded facts are carried forward (`carried`).
  // A continued thread whose opening prompt began with the hand-off head
  // line is one by construction; nothing else Moxen writes starts with it.
  const opener = thread.continuedFrom === undefined
    ? null
    : messages.find((message) => message.role === "user" && message.origin === undefined && message.text.startsWith(HANDOFF_HEAD)) ?? null;
  const carried = opener === null ? null : carriedHandoff(opener.text);

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
    openerId: opener === null ? null : opener.id,
  }));
  const unsent = turns
    .filter((turn) => !reached(turn) && !movedIds.has(turn.id) && !(options.preferModelSummary && turn.scheduledFor) && (!options.queuedTurnIds || options.queuedTurnIds.includes(turn.id)))
    .flatMap((turn) => {
      if (opener !== null && turn.messageId === opener.id) {
        // The queued opening hand-off is the task itself, not a request of
        // the user's: retold as one line, never as the document inside.
        return ["(the hand-off record that opened this thread — it never ran; this document carries its request)",];
      }
      return messages
        .filter((message) => message.id === turn.messageId && message.origin !== "usage-continue" && message.origin !== "usage-protection" && message.origin !== "handoff-summary")
        .map((message) => message.text.trim());
    })
    .map((text) => clamped(text, REQUEST_CHARS));

  // Files the thread changed, summed across every turn's checkpoint, with
  // the ones the chain behind it already changed carried forward.
  const files = new Map<string, { additions: number; deletions: number }>();
  for (const file of carried?.files ?? []) files.set(file.path, { additions: file.additions, deletions: file.deletions });
  for (const checkpoint of scopedCheckpoints) {
    for (const file of checkpoint.files ?? []) {
      const stat = files.get(file.path) ?? { additions: 0, deletions: 0 };
      files.set(file.path, { additions: stat.additions + file.additions, deletions: stat.deletions + file.deletions });
    }
  }

  const userPrompts = blocks.flatMap((block) => block.prompts).filter((message) => !message.origin && message.id !== opener?.id);
  const firstPrompt = userPrompts[0]?.text.trim() ?? carried?.goal ?? null;
  const lastPrompt = userPrompts.at(-1)?.text.trim() ?? carried?.lastRequest ?? null;
  const ownPlan = openPlan(scopedActivities);
  const plan = ownPlan.length > 0 ? ownPlan : [...(carried?.plan ?? [])];
  const stopped = stoppedBecause(blocks.at(-1), activities);
  // Only a last turn that ran to completion, with nothing queued, nothing
  // moved, and no open checklist step, may be a finished task.
  const finished = stopped.completed && unsent.length === 0 && moved.length === 0 && plan.every((row) => row.startsWith("- [x]"));
  const where = thread.env.branch ? `${thread.env.path} (branch ${thread.env.branch})` : thread.env.path;

  const head: string[] = [
    `# Continuing: ${thread.title}`,
    "",
    `You are picking up a thread another session worked on${finished ? "" : " and did not finish"}. Below is its record, written by Moxen from the thread's ledger — you have none of the original context beyond this. Read "Where it stopped" first.`,
    "",
    `- Working directory: ${where}`,
    ...(options.projectTitle ? [`- Project: ${options.projectTitle}`] : []),
    `- Model it ran on: ${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    `- Turns so far: ${blocks.length}`,
    "",
    "## Where it stopped",
    "",
    stopped.text,
  ];
  if (firstPrompt !== null && firstPrompt !== lastPrompt) head.push("", "The thread began with:", "", options.preferModelSummary || options.modelSummary ? clamped(firstPrompt, REQUEST_CHARS) : `> ${oneLine(firstPrompt, 400)}`);
  if (lastPrompt !== null) head.push("", "The last request, verbatim:", "", clamped(lastPrompt, REQUEST_CHARS));
  if (plan.length > 0) head.push("", "Its checklist when it stopped (`[x]` done, `[~]` in progress, `[ ]` open):", "", ...plan);
  if (moved.length > 0) {
    head.push(
      "",
      moved.length === 1
        ? "The user had queued a message that had not run; it moved to the new thread's Work queue with this continuation and will arrive as a follow-up turn — it is not part of this turn's work."
        : `The user had queued ${moved.length} messages that had not run; they moved to the new thread's Work queue with this continuation and will arrive as follow-up turns — they are not part of this turn's work.`,
      "",
    );
  }
  if (unsent.length > 0) {
    head.push("", "The user queued these and they were never sent — treat them as part of the task, in this order:", "");
    unsent.forEach((text, index) => head.push(`${index + 1}. ${text}`));
  }
  if (files.size > 0) {
    head.push("", "## Files already changed", "", "These edits, from this thread and the chain behind it, are on disk now. Check the working tree before redoing anything — some work may be partly done.", "");
    for (const [path, stat] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      head.push(`- ${path} +${stat.additions} −${stat.deletions}`);
    }
  }
  const images = [...messages
    .filter((message) => !knownTurns || knownTurns.has(message.turnId))
    .flatMap((message) => message.attachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map((image) => `- ${JSON.stringify(image.name)}: ${JSON.stringify(image.path)}`),
    ...(carried?.images ?? [])]
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, CARRY_LINES);
  if (images.length > 0) {
    head.push("", "## Original images", "", "These original image files remain on this server. Open them with your image/file tools when the task depends on visual input:", ...images);
  }
  const summaryBlock = thread.usagePause?.turnId ? blocks.find((block) => block.turn.id === thread.usagePause!.turnId) : blocks.at(-1);
  const modelSummary = options.modelSummary ?? (options.preferModelSummary ? summaryBlock?.replies.map((reply) => reply.text.trim()).join("\n\n") : null);
  if (modelSummary) return [...head, "", "## Model's wrap-up", "", clamped(modelSummary, WRAPUP_CHARS), "", "Continue the unfinished task from these notes; do not repeat completed work."].join("\n");
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
    const older = blocks.slice(0, verbatimFrom).map((block, index) => summarized(block, index));
    const recent = blocks.slice(verbatimFrom).map((block, index) => verbatim(block, verbatimFrom + index));
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

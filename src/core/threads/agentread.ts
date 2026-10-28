/**
 * Another thread, as an agent reads it (`thread_read`, MXN-133): revealed
 * in three steps, each paid for only when asked, so reading a long thread
 * never floods the caller's context.
 *
 * | Ask | Gets |
 * |---|---|
 * | the thread | an outline, one line per turn, newest first (`before` goes further back) |
 * | `turns: "12-14"` | what was written in those turns, each tool call one line, numbered `12.3` |
 * | `item: "12.3"` | that tool call's input and output in full, in pages (`offset`) |
 *
 * Every answer fits a budget (`agentReadBudget`), and whatever does not fit
 * is named with the exact call that fetches it: nothing is dropped silently.
 * The thread's text is wrapped as untrusted: another thread may have read
 * something hostile. Moxen's own notes (what was cut, how to get it) stay
 * outside the wrapper.
 */
import { CliError } from "../errors.js";
import { untrustedContext } from "../untrusted.js";
import type { ThreadStore } from "./store.js";
import type { StoredActivity, StoredMessage, StoredTurn } from "./types.js";

/** A call's answer by default, in characters (about 4 K tokens). */
export const AGENT_READ_DEFAULT_CHARS = 16_000;
/** Never more: under Claude Code's 50 K-character cut (past it a result moves to a file) and its 10 K-token warning. */
export const AGENT_READ_MAX_CHARS = 40_000;
/** Below this the caller's context is too full for anything but the outline. */
export const AGENT_READ_MIN_CHARS = 2_000;
/** The outline's own share, whatever the budget. */
const OUTLINE_CHARS = 4_000;
const PREVIEW_CHARS = 120;
/** Characters per token, for turning a caller's free context into a budget. */
const CHARS_PER_TOKEN = 4;
/** The share of the caller's free context one call may take. */
const FREE_CONTEXT_SHARE = 0.05;

export interface CallerContext {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
}

/**
 * How many characters one call may return: the default, or less when the
 * caller's context is filling up (`min(default, ~5% of what is free)`), never
 * past the ceiling. `outlineOnly` when even that is too little to read turns.
 */
export function agentReadBudget(caller: CallerContext | null, asked?: number): { readonly chars: number; readonly outlineOnly: boolean; readonly reason: string | null } {
  const wanted = Math.min(AGENT_READ_MAX_CHARS, Math.max(AGENT_READ_MIN_CHARS, asked ?? AGENT_READ_DEFAULT_CHARS));
  if (caller === null || caller.maxTokens === null || caller.maxTokens <= 0) return { chars: wanted, outlineOnly: false, reason: null };
  const freeChars = Math.max(0, caller.maxTokens - caller.usedTokens) * CHARS_PER_TOKEN;
  const share = Math.floor(freeChars * FREE_CONTEXT_SHARE);
  if (share >= wanted) return { chars: wanted, outlineOnly: false, reason: null };
  const percent = Math.round((caller.usedTokens / caller.maxTokens) * 100);
  if (share < AGENT_READ_MIN_CHARS) {
    return { chars: Math.min(OUTLINE_CHARS, wanted), outlineOnly: true, reason: `your context is ${percent}% full, so only the outline is returned; compact or hand off before reading turns` };
  }
  return { chars: share, outlineOnly: false, reason: `your context is ${percent}% full, so this answer is held to ${share} characters` };
}

export interface AgentReadRequest {
  readonly threadId: string;
  /** `"12"` or `"12-14"`. */
  readonly turns?: string;
  /** A tool call, as the turns view numbers it (`"12.3"`). */
  readonly item?: string;
  /** Where to resume a turns or item page, in characters. */
  readonly offset?: number;
  /** The outline: list turns before this number (newest first). */
  readonly before?: number;
}

interface ToolCall {
  readonly ref: string;
  readonly tool: string;
  readonly summary: string;
  readonly status: string;
  readonly exit: number | null;
  readonly input: unknown;
  readonly output: string | null;
  readonly files: readonly string[];
  readonly at: string;
}

interface TurnView {
  readonly number: number;
  readonly turn: StoredTurn;
  readonly prompt: string;
  readonly result: string | null;
  /** In the order they happened: messages, and tool calls folded to their newest row. */
  readonly items: ReadonlyArray<{ readonly at: string; readonly message?: StoredMessage; readonly call?: ToolCall }>;
  readonly calls: readonly ToolCall[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function flat(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function preview(text: string | null, size = PREVIEW_CHARS): string {
  if (text === null || text.trim() === "") return "—";
  const line = flat(text);
  return line.length <= size ? line : `${line.slice(0, size - 1)}…`;
}

function lineCount(text: string | null): number {
  return text === null || text === "" ? 0 : text.split("\n").length;
}

/** Tool rows of one turn, folded per call to the newest row, numbered in the order the calls began. */
function toolCalls(number: number, activities: readonly StoredActivity[]): ToolCall[] {
  const byCall = new Map<string, { first: StoredActivity; last: StoredActivity }>();
  for (const activity of activities) {
    const callId = activity.payload?.["toolCallId"];
    if (typeof callId !== "string") continue;
    const seen = byCall.get(callId);
    if (seen) seen.last = activity;
    else byCall.set(callId, { first: activity, last: activity });
  }
  return [...byCall.values()].map(({ first, last }, index) => {
    const payload = last.payload ?? {};
    const data = record(payload["data"]) ?? {};
    const state = record(data["state"]) ?? {};
    const metadata = record(state["metadata"]) ?? {};
    const input = record(state["input"]) ?? {};
    const files = new Set<string>();
    for (const file of Array.isArray(data["files"]) ? data["files"] : []) {
      const path = record(file)?.["path"];
      if (typeof path === "string") files.add(path);
    }
    if (payload["itemType"] === "file_change") {
      for (const key of ["file_path", "filePath", "path"]) if (typeof input[key] === "string") files.add(input[key] as string);
    }
    return {
      ref: `${number}.${index + 1}`,
      tool: typeof data["tool"] === "string" ? (data["tool"] as string) : "tool",
      summary: last.summary.replace(/^\$ /u, ""),
      status: typeof state["status"] === "string" ? (state["status"] as string) : typeof payload["status"] === "string" ? (payload["status"] as string) : "unknown",
      exit: typeof metadata["exit"] === "number" ? (metadata["exit"] as number) : null,
      input: state["input"] ?? null,
      output: typeof state["output"] === "string" ? (state["output"] as string) : typeof payload["detail"] === "string" ? (payload["detail"] as string) : null,
      files: [...files],
      at: first.createdAt,
    };
  });
}

async function turnViews(store: ThreadStore, threadId: string): Promise<TurnView[]> {
  const [turns, messages, activities] = await Promise.all([store.readTurns(threadId), store.readMessages(threadId), store.readActivities(threadId)]);
  const ran = turns.filter((turn) => turn.status !== "queued").sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return ran.map((turn, index) => {
    const number = index + 1;
    const own = messages.filter((message) => message.turnId === turn.id);
    const prompt = messages.find((message) => message.id === turn.messageId)?.text ?? own.find((message) => message.role === "user")?.text ?? "";
    const result = [...own].reverse().find((message) => message.role === "assistant")?.text ?? null;
    const calls = toolCalls(number, activities.filter((activity) => activity.turnId === turn.id));
    const items = [
      ...own.filter((message) => message.id !== turn.messageId).map((message) => ({ at: message.createdAt, message })),
      ...calls.map((call) => ({ at: call.at, call })),
    ].sort((left, right) => left.at.localeCompare(right.at));
    return { number, turn, prompt, result, items, calls };
  });
}

function callLine(call: ToolCall): string {
  const outcome = [call.status, ...(call.exit === null ? [] : [`exit ${call.exit}`]), ...(call.output === null ? [] : [`${lineCount(call.output)} lines`])].join(", ");
  return `[${call.ref}] ${call.tool}: ${preview(call.summary, 160)} → ${outcome}`;
}

function outlineLine(view: TurnView): string {
  const files = new Set(view.calls.flatMap((call) => call.files)).size;
  const counts = `${view.calls.length} tool call${view.calls.length === 1 ? "" : "s"}${files > 0 ? `, ${files} file${files === 1 ? "" : "s"}` : ""}`;
  return `${view.number}. ${view.turn.createdAt.slice(0, 16).replace("T", " ")} · ${view.turn.status} · ${counts}\n   asked: ${preview(view.prompt)}\n   result: ${preview(view.result)}`;
}

function turnText(view: TurnView): string {
  const lines = [`## Turn ${view.number} (${view.turn.status}, ${view.turn.createdAt})`, `User: ${view.prompt}`];
  for (const item of view.items) {
    if (item.call) lines.push(callLine(item.call));
    else if (item.message) lines.push(`${item.message.role === "assistant" ? "Assistant" : item.message.role === "user" ? "User" : "Moxen"}: ${item.message.text}`);
  }
  return lines.join("\n");
}

function parseRange(text: string, last: number): { from: number; to: number } {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u.exec(text);
  if (match === null) throw new CliError("INVALID_TOOL_INPUT", 'turns is a turn number or a range, like "12" or "12-14".', { exitCode: 2 });
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to < from || from > last) {
    throw new CliError("INVALID_TOOL_INPUT", `This thread has turns 1 to ${last}.`, { exitCode: 2, details: { turns: text } });
  }
  return { from, to: Math.min(to, last) };
}

/** A page of `text` from `offset`, and the note that names the rest. */
function page(text: string, offset: number, chars: number, next: (offset: number) => string): { body: string; note: string | null } {
  const start = Math.max(0, Math.min(offset, text.length));
  const body = text.slice(start, start + chars);
  const end = start + body.length;
  if (end >= text.length) return { body, note: start > 0 ? `Characters ${start}–${end} of ${text.length}: the end.` : null };
  return { body, note: `Characters ${start}–${end} of ${text.length}; ${text.length - end} more not shown: ${next(end)}.` };
}

function answer(source: string, body: string, notes: ReadonlyArray<string | null>): string {
  const said = notes.filter((note): note is string => note !== null);
  return [untrustedContext(body, source), ...(said.length > 0 ? ["", ...said.map((note) => `[Moxen] ${note}`)] : [])].join("\n");
}

/**
 * Read another thread for an agent: the outline, a range of turns, or one
 * tool call, within `budget` (`agentReadBudget`).
 */
export async function readThreadForAgent(
  store: ThreadStore,
  request: AgentReadRequest,
  budget: { readonly chars: number; readonly outlineOnly: boolean; readonly reason: string | null },
): Promise<string> {
  const thread = await store.readThreadRecord(request.threadId);
  if (!thread) throw new CliError("THREAD_NOT_FOUND", `No thread ${request.threadId}.`, { exitCode: 4, details: { threadId: request.threadId } });
  const views = await turnViews(store, thread.id);
  const source = `thread:${thread.id}`;
  const call = (args: string) => `thread_read(id: "${thread.id}"${args})`;
  const header = `Thread "${thread.title}" (${thread.id}), ${views.length} turn${views.length === 1 ? "" : "s"}`;

  if (views.length === 0) return answer(source, `${header}. Nothing has run in it yet.`, [budget.reason]);

  const wantsDetail = request.item !== undefined || request.turns !== undefined;
  if (!wantsDetail || budget.outlineOnly) {
    const below = request.before === undefined ? views.length + 1 : Math.max(1, Math.min(request.before, views.length + 1));
    const room = Math.min(OUTLINE_CHARS, budget.chars);
    const lines = [`${header}, newest first:`];
    let used = lines[0]!.length;
    let lowest = below;
    for (const view of views.filter((entry) => entry.number < below).reverse()) {
      const line = outlineLine(view);
      if (used + line.length + 1 > room && lowest < below) break;
      lines.push(line);
      used += line.length + 1;
      lowest = view.number;
    }
    const notes = [
      budget.reason === null ? null : `Only the outline: ${budget.reason}.`,
      lowest > 1 ? `Turns 1–${lowest - 1} not listed: ${call(`, before: ${lowest}`)}.` : null,
      `Read turns with ${call(', turns: "<n>" or "<from>-<to>"')}; one tool call in full with ${call(', item: "<turn>.<n>"')}. Results stay in your context: do not read the same range twice.`,
    ];
    return answer(source, lines.join("\n"), notes);
  }

  if (request.item !== undefined) {
    const match = /^\s*(\d+)\.(\d+)\s*$/u.exec(request.item);
    const view = match === null ? undefined : views[Number(match[1]) - 1];
    const found = view?.calls[Number(match?.[2]) - 1];
    if (found === undefined) {
      throw new CliError("INVALID_TOOL_INPUT", `No tool call ${request.item}: items are numbered "<turn>.<n>" in the turns view.`, { exitCode: 2 });
    }
    const full = [
      `Tool call ${found.ref} in turn ${match![1]}: ${found.tool}, ${found.status}${found.exit === null ? "" : `, exit ${found.exit}`}`,
      `Input:\n${JSON.stringify(found.input, null, 2)}`,
      `Output:\n${found.output ?? "(none recorded)"}`,
    ].join("\n\n");
    const paged = page(full, request.offset ?? 0, budget.chars, (offset) => call(`, item: "${found.ref}", offset: ${offset}`));
    return answer(source, paged.body, [budget.reason, paged.note]);
  }

  const range = parseRange(request.turns!, views.length);
  const text = views
    .slice(range.from - 1, range.to)
    .map(turnText)
    .join("\n\n");
  const label = range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`;
  const paged = page(text, request.offset ?? 0, budget.chars, (offset) => call(`, turns: "${label}", offset: ${offset}`));
  return answer(source, `${header}. Turns ${label}; each tool call is one line, read one in full with ${call(', item: "<ref>"')}.\n\n${paged.body}`, [budget.reason, paged.note]);
}

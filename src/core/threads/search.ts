/**
 * Thread search: find a thread by what is in it — its title, a message
 * either side sent, a tool call (its name, its input, its summary). Settled
 * and snoozed threads are searched too, but never mixed in with the active
 * ones: the result lists active threads first and says which each is.
 *
 * It reads the store, so a hit is whatever was recorded; a message the
 * provider kept but moxen never stored is not found. A query is
 * case-insensitive words that must all appear in the same item (title,
 * message, or tool row), in any order.
 */
import type { ThreadListStatus } from "./types.js";
import { listThreadsView, type OperationContext, type ThreadListQuery } from "./operations.js";
import { matchesTerms, searchTerms } from "./views.js";
import type { StoredActivity, StoredMessage } from "./types.js";

export type ThreadSearchHitKind = "title" | "message" | "tool" | "activity";

export interface ThreadSearchHit {
  readonly kind: ThreadSearchHitKind;
  /** The matching text around the first match, ellipsised when cut. */
  readonly snippet: string;
  /** Who said it (`user`, `assistant`, `system`) for a message; the tool name for a tool row. */
  readonly source: string | null;
  readonly turnId: string | null;
  readonly at: string | null;
}

export interface ThreadSearchResult {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: Exclude<ThreadListStatus, "all">;
  readonly updatedAt: string | null;
  /** How many items matched, which can exceed `hits.length` (capped per thread). */
  readonly hitCount: number;
  readonly hits: readonly ThreadSearchHit[];
}

export interface ThreadSearchQuery extends ThreadListQuery {
  readonly query: string;
  /** Threads returned; default 30. */
  readonly limit?: number;
  /** Hits kept per thread; default 3. */
  readonly hitsPerThread?: number;
}

export interface ThreadSearch {
  readonly query: string;
  /** Active (and snoozed) threads first, then settled; each group newest match first. */
  readonly threads: readonly ThreadSearchResult[];
  /** Threads that matched before `limit` cut the list. */
  readonly total: number;
}

export { matchesTerms, searchTerms };

const DEFAULT_LIMIT = 30;
const DEFAULT_HITS_PER_THREAD = 3;
const SNIPPET_RADIUS = 60;
const MAX_ACTIVITY_TEXT = 8_000;
const CONCURRENCY = 8;

/** The text around the earliest term in `text`, on one line. */
export function snippetAround(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
  const from = Number.isFinite(at) ? Math.max(0, at - SNIPPET_RADIUS) : 0;
  const to = Math.min(flat.length, from + SNIPPET_RADIUS * 2 + (terms[0]?.length ?? 0));
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

/** Every string inside a tool row's payload (name, input, output), joined, bounded. */
function payloadText(value: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const visit = (node: unknown, depth: number): void => {
    if (size >= MAX_ACTIVITY_TEXT || depth > 8) return;
    if (typeof node === "string") {
      parts.push(node);
      size += node.length;
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else if (node && typeof node === "object") {
      for (const item of Object.values(node)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return parts.join(" ").slice(0, MAX_ACTIVITY_TEXT);
}

function toolNameOf(activity: StoredActivity): string | null {
  const data = activity.payload?.["data"];
  const tool = data && typeof data === "object" ? (data as Record<string, unknown>)["tool"] : undefined;
  return typeof tool === "string" ? tool : null;
}

function messageHit(message: StoredMessage, terms: readonly string[]): ThreadSearchHit | null {
  if (!matchesTerms(message.text, terms)) return null;
  return { kind: "message", snippet: snippetAround(message.text, terms), source: message.role, turnId: message.turnId, at: message.createdAt };
}

function activityHit(activity: StoredActivity, terms: readonly string[]): ThreadSearchHit | null {
  const tool = toolNameOf(activity);
  const text = `${activity.summary} ${payloadText(activity.payload)}`;
  if (!matchesTerms(`${tool ?? ""} ${text}`, terms)) return null;
  return {
    kind: tool ? "tool" : "activity",
    snippet: snippetAround(text, terms),
    source: tool,
    turnId: activity.turnId,
    at: activity.createdAt,
  };
}

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  }
  return out;
}

export async function searchThreadsView(ctx: OperationContext, request: ThreadSearchQuery): Promise<ThreadSearch> {
  const terms = searchTerms(request.query);
  if (terms.length === 0) return { query: request.query, threads: [], total: 0 };
  const { query: _query, limit, hitsPerThread, ...scope } = request;
  const listed = await listThreadsView(ctx, { ...scope, status: scope.status ?? "all" });
  const perThread = Math.max(1, hitsPerThread ?? DEFAULT_HITS_PER_THREAD);

  const scanned = await inBatches(listed.threads, CONCURRENCY, async (thread): Promise<ThreadSearchResult | null> => {
    const [messages, activities] = await Promise.all([ctx.store.readMessages(thread.id), ctx.store.readActivities(thread.id)]);
    const hits: ThreadSearchHit[] = [];
    if (matchesTerms(thread.title, terms)) {
      hits.push({ kind: "title", snippet: thread.title, source: null, turnId: null, at: thread.updatedAt ?? null });
    }
    for (const message of messages) {
      const hit = messageHit(message, terms);
      if (hit) hits.push(hit);
    }
    for (const activity of activities) {
      const hit = activityHit(activity, terms);
      if (hit) hits.push(hit);
    }
    if (hits.length === 0) return null;
    // The title first, then the newest matches: what the user is most likely looking for.
    hits.sort((a, b) => Number(b.kind === "title") - Number(a.kind === "title") || (b.at ?? "").localeCompare(a.at ?? ""));
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      status: thread.status,
      updatedAt: thread.updatedAt ?? null,
      hitCount: hits.length,
      hits: hits.slice(0, perThread),
    };
  });

  const found = scanned.filter((entry): entry is ThreadSearchResult => entry !== null);
  const settled = (entry: ThreadSearchResult) => (entry.status === "settled" ? 1 : 0);
  found.sort(
    (a, b) =>
      settled(a) - settled(b) ||
      Number(b.hits[0]?.kind === "title") - Number(a.hits[0]?.kind === "title") ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  return { query: request.query, threads: found.slice(0, Math.max(1, limit ?? DEFAULT_LIMIT)), total: found.length };
}

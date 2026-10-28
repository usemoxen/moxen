/**
 * The sidebar's search (MXN-134): titles filter on the client as you type;
 * after a pause the server's content search (`threads.search`) adds the
 * threads whose messages or tool calls match, under "In messages". A thread
 * already listed by its title is not listed again.
 */
import type { ThreadEnvelope } from "../../core/types.js";
import { matchesTerms, searchTerms } from "../../core/threads/views.js";
import type { QueryResult } from "../../server/protocol.js";
import { threadSortTime } from "./shell.js";

type ThreadSearch = QueryResult<"threads.search">;

export interface SidebarMessageHit {
  readonly threadId: string;
  readonly title: string;
  /** The first non-title match, on one line. */
  readonly snippet: string;
}

/** Threads whose title holds every word of the query, newest first. Archived and deleted threads are left out. */
export function titleMatches(threads: readonly ThreadEnvelope[], query: string): ThreadEnvelope[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  return threads
    .filter((thread) => thread.archivedAt === null && !thread.deletedAt && matchesTerms(thread.title, terms))
    .sort((left, right) => threadSortTime(right) - threadSortTime(left));
}

/** The server's content matches, less the threads the titles already list. */
export function messageMatches(found: ThreadSearch | null, listed: ReadonlySet<string>): SidebarMessageHit[] {
  if (found === null) return [];
  return found.threads.flatMap((thread) => {
    if (listed.has(thread.threadId)) return [];
    const hit = thread.hits.find((candidate) => candidate.kind !== "title");
    return hit === undefined ? [] : [{ threadId: thread.threadId, title: thread.title, snippet: hit.snippet }];
  });
}

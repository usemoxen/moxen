import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../server/protocol.js";
import type { ThreadEnvelope } from "../../../core/types.js";
import { messageMatches, titleMatches } from "../sidebarsearch.js";

function thread(id: string, title: string, extra: Partial<ThreadEnvelope> = {}): ThreadEnvelope {
  return { id, projectId: "p1", title, archivedAt: null, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", ...extra };
}

function found(...threads: Array<{ id: string; title: string; kinds: Array<"title" | "message" | "tool"> }>): QueryResult<"threads.search"> {
  return {
    query: "q",
    total: threads.length,
    threads: threads.map((entry) => ({
      threadId: entry.id,
      projectId: "p1",
      title: entry.title,
      status: "active",
      updatedAt: null,
      hitCount: entry.kinds.length,
      hits: entry.kinds.map((kind) => ({ kind, snippet: `${kind} in ${entry.id}`, source: null, turnId: null, at: null })),
    })),
  };
}

describe("titleMatches", () => {
  it("keeps threads whose title holds every word, newest first", () => {
    const threads = [
      thread("old", "Sidebar search bar", { createdAt: "2026-09-01T10:00:00.000Z" }),
      thread("new", "Search in the sidebar", { createdAt: "2026-10-20T10:00:00.000Z" }),
      thread("other", "Search only"),
    ];
    expect(titleMatches(threads, "sidebar SEARCH").map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("lists nothing for an empty query, and leaves archived and deleted threads out", () => {
    const threads = [thread("a", "search", { archivedAt: "2026-10-02T10:00:00.000Z" }), thread("d", "search", { deletedAt: "2026-10-02T10:00:00.000Z" })];
    expect(titleMatches(threads, "   ")).toEqual([]);
    expect(titleMatches(threads, "search")).toEqual([]);
  });
});

describe("messageMatches", () => {
  it("drops threads the titles already list, and threads that only matched by title", () => {
    const hits = messageMatches(
      found(
        { id: "listed", title: "Listed", kinds: ["title", "message"] },
        { id: "titleonly", title: "Title only", kinds: ["title"] },
        { id: "content", title: "Content", kinds: ["title", "tool"] },
      ),
      new Set(["listed"]),
    );
    expect(hits).toEqual([{ threadId: "content", title: "Content", snippet: "tool in content" }]);
  });

  it("lists nothing before the server answers", () => {
    expect(messageMatches(null, new Set())).toEqual([]);
  });
});

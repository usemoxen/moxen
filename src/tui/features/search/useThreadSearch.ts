import { useEffect, useRef, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import type { QueryResult } from "../../../server/protocol.js";

type ThreadSearch = QueryResult<"threads.search">;

/** Quiet time after the last keystroke before the store is read. */
const SEARCH_DEBOUNCE_MS = 200;

export type ThreadSearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "done"; readonly found: ThreadSearch };

/**
 * The thread-search picker's results for what is typed in it. Every thread
 * is read from the store per query, so it waits for a pause in typing, and
 * an answer to an older query never replaces a newer one's.
 */
export function useThreadSearch(client: ClientApi, open: boolean, query: string): ThreadSearchState {
  const [state, setState] = useState<ThreadSearchState>({ kind: "idle" });
  const latest = useRef(0);
  useEffect(() => {
    const text = query.trim();
    if (!open || text.length === 0) {
      latest.current += 1;
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    const mine = (latest.current += 1);
    const timer = setTimeout(() => {
      void client
        .query({ type: "threads.search", query: text })
        .then((found) => {
          if (latest.current === mine) setState({ kind: "done", found });
        })
        .catch((cause: unknown) => {
          if (latest.current === mine) setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, open, query]);
  return state;
}

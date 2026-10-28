import { useMemo, useState } from "react";
import type { KeyEvent } from "@opentui/core";

import type { ThreadEnvelope } from "../../../core/types.js";
import type { ClientApi } from "../../../server/api.js";
import { messageMatches, titleMatches, type SidebarMessageHit } from "../../model/sidebarsearch.js";
import { useThreadSearch } from "../search/useThreadSearch.js";

export interface SidebarSearchView {
  readonly query: string;
  readonly titles: readonly ThreadEnvelope[];
  readonly messages: readonly SidebarMessageHit[];
  /** The server's content search has not answered for this query yet. */
  readonly searching: boolean;
  /** The row Enter opens: a title match first, then the message matches. */
  readonly selectedId: string | null;
}

/**
 * The sidebar's search (MXN-134). Titles filter here on every keystroke; the
 * content search behind Cmd+P's picker (`useThreadSearch`) fills "In
 * messages" after a pause. The app routes keys to `handleKey` while the
 * search holds focus.
 */
export function useSidebarSearch(client: ClientApi, threads: readonly ThreadEnvelope[]) {
  const [query, setQueryState] = useState("");
  const [cursor, setCursor] = useState(0);
  const active = query.trim().length > 0;
  const content = useThreadSearch(client, active, query);
  const titles = useMemo(() => titleMatches(threads, query), [threads, query]);
  const messages = useMemo(
    () => messageMatches(content.kind === "done" ? content.found : null, new Set(titles.map((thread) => thread.id))),
    [content, titles],
  );
  const ids = [...titles.map((thread) => thread.id), ...messages.map((hit) => hit.threadId)];
  const selectedId = ids.length === 0 ? null : (ids[Math.min(cursor, ids.length - 1)] ?? null);

  const setQuery = (next: string) => {
    setQueryState(next);
    setCursor(0);
  };

  /**
   * One key while the search holds focus. Esc clears and hands focus back
   * (`onLeave`); Enter opens the selected thread (`onOpen`). Returns whether
   * the key was the search's.
   */
  const handleKey = (key: KeyEvent, actions: { onOpen: (threadId: string) => void; onLeave: () => void }): boolean => {
    if (key.name === "escape") {
      setQuery("");
      actions.onLeave();
      return true;
    }
    if (key.name === "return") {
      if (selectedId !== null) actions.onOpen(selectedId);
      return true;
    }
    if (key.name === "up" || key.name === "down") {
      if (ids.length > 0) setCursor((at) => (Math.min(at, ids.length - 1) + (key.name === "down" ? 1 : ids.length - 1)) % ids.length);
      return true;
    }
    if (key.name === "backspace") {
      setQuery(query.slice(0, -1));
      return true;
    }
    const sequence = key.sequence;
    if (typeof sequence === "string" && sequence.length === 1 && sequence >= " " && key.ctrl !== true && key.meta !== true) {
      setQuery(`${query}${sequence}`);
      return true;
    }
    return false;
  };

  const view: SidebarSearchView = {
    query,
    titles,
    messages,
    searching: active && (content.kind === "loading" || content.kind === "idle"),
    selectedId,
  };
  return { view, handleKey, clear: () => setQuery("") };
}

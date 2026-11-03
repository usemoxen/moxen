import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import type { ProviderUsageLimits } from "../../../core/catalog/summary.js";
import { dispatchErrorMessage } from "../../../core/errors.js";
import type { ContextBreakdown } from "../../model/sidepanel.js";
import type { ClientApi } from "../../../server/api.js";
import type { QueryResults } from "../../../server/protocol.js";
import type { SideTab } from "../../model/sidepanel.js";
import { startPolling } from "../../hooks/poll.js";
import { useTerminalVisible } from "../../hooks/useTerminalVisible.js";

/**
 * The side panel's open tab (null: closed). The Diff tab follows the diff
 * panel's own state — opening a turn's diff shows it, closing the diff
 * closes it — the other tabs are opened and closed here. Also holds the
 * non-diff tabs' scroll pane.
 */
export function useSidePanel(diffOpen: boolean): {
  tab: SideTab | null;
  open: (tab: SideTab) => void;
  toggle: (tab: SideTab) => void;
  close: () => void;
  scrollRef: MutableRefObject<ScrollBoxRenderable | null>;
} {
  const [tab, setTab] = useState<SideTab | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (diffOpen) setTab("diff");
    else setTab((current) => (current === "diff" ? null : current));
  }, [diffOpen]);
  const open = useCallback((next: SideTab) => setTab(next), []);
  const toggle = useCallback((next: SideTab) => setTab((current) => (current === next ? null : next)), []);
  const close = useCallback(() => setTab(null), []);
  return { tab, open, toggle, close, scrollRef };
}

/** Default for `ui.contextRefreshSeconds`, when the config pins nothing. */
const CONTEXT_REFRESH_MS = 5_000;

/**
 * The open thread's live context breakdown, re-read while the Context tab
 * is showing (and whenever `refreshKey` moves — a turn settling, say).
 * Null until the first answer, or when no session runs here.
 */
export function useContextBreakdown(
  client: ClientApi,
  threadId: string | null,
  active: boolean,
  refreshKey: unknown,
  intervalMs: number = CONTEXT_REFRESH_MS,
): { breakdown: ContextBreakdown | null; live: boolean } {
  const [state, setState] = useState<{ breakdown: ContextBreakdown | null; live: boolean }>({ breakdown: null, live: false });
  const visible = useTerminalVisible();
  useEffect(() => {
    setState({ breakdown: null, live: false });
  }, [threadId]);
  useEffect(() => {
    if (!active || threadId === null) return;
    let cancelled = false;
    const read = () =>
      client
        .query({ type: "thread.context", threadId })
        .then((result) => {
          if (!cancelled) setState({ breakdown: result.breakdown, live: result.live });
        })
        .catch(() => undefined);
    const stop = startPolling(read, visible ? intervalMs : null);
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, threadId, active, refreshKey, intervalMs, visible]);
  return state;
}

/** Default for `ui.usageRefreshSeconds` (live events refresh the server's copy; this just picks it up). */
const USAGE_REFRESH_MS = 20_000;

export function useUsageProtection(client: ClientApi) {
  const [state, setState] = useState<QueryResults["usage.protection"]>({ forecasts: [], queue: [] });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const stop = startPolling(async () => {
      try {
        const next = await client.query({ type: "usage.protection" });
        if (!stopped && next?.forecasts && next?.queue) setState(next);
      } catch { /* A reconnect keeps the last durable queue visible. */ }
    }, 2000);
    return () => { stopped = true; stop(); };
  }, [client]);
  const act = useCallback((command: { type: "usage.wrap"; provider: string } | { type: "usage.queue"; threadId: string; direction: "first" | "last" | "cancel" }) => {
    setError(null);
    void client.dispatch(command)
      .then(() => client.query({ type: "usage.protection" }))
      .then(setState)
      .catch((cause: unknown) => setError(dispatchErrorMessage(cause)));
  }, [client]);
  return { state, error, act };
}

/**
 * The account's plan usage per driver kind, as the server last recorded it,
 * re-read on a slow timer and whenever `refreshKey` moves (a turn settling).
 */
export function usePlanUsage(
  client: ClientApi,
  refreshKey: unknown,
  intervalMs: number = USAGE_REFRESH_MS,
  /** Called when a read has answered or failed: the boot screen waits for the first one. */
  onFirstRead?: () => void,
): Readonly<Record<string, ProviderUsageLimits>> {
  const [limits, setLimits] = useState<Readonly<Record<string, ProviderUsageLimits>>>({});
  const visible = useTerminalVisible();
  const firstRead = useRef(onFirstRead);
  firstRead.current = onFirstRead;
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      client
        .query({ type: "usage.limits" })
        .then((result) => {
          if (!cancelled) setLimits(result.providers);
        })
        .catch(() => undefined)
        .finally(() => { if (!cancelled) firstRead.current?.(); });
    const stop = startPolling(read, visible ? intervalMs : null);
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, refreshKey, intervalMs, visible]);
  return limits;
}

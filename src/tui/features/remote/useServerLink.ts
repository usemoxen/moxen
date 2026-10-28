import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ClientApi } from "../../../server/api.js";
import type { LinkState, RemoteConnection } from "../../../server/transport/remote.js";

const CONNECTED: LinkState = { status: "connected" };
const NEVER = (): (() => void) => () => undefined;

/**
 * Whether the TUI's server is answering. Only a connection to a server can
 * lose it (`RemoteConnection`'s heartbeat says when); in-process there is
 * nothing to lose, so it is always connected.
 */
export function useServerLink(client: ClientApi): LinkState {
  const watchable = client as Partial<Pick<RemoteConnection, "linkState" | "onLinkState">>;
  const subscribe = useCallback(
    (onChange: () => void) => (typeof watchable.onLinkState === "function" ? watchable.onLinkState(onChange) : NEVER()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );
  return useSyncExternalStore(subscribe, () => watchable.linkState ?? CONNECTED);
}

/**
 * How many times the connection has come back after being lost. What the
 * TUI fetched once (the model catalog, the server's display settings) keys
 * on it to fetch again: the server may have been replaced meanwhile, and
 * whatever failed while it was gone would otherwise stay failed.
 */
export function useReconnects(link: LinkState): number {
  const [count, setCount] = useState(0);
  const lost = useRef(false);
  useEffect(() => {
    if (link.status !== "connected") lost.current = true;
    else if (lost.current) {
      lost.current = false;
      setCount((value) => value + 1);
    }
  }, [link]);
  return count;
}

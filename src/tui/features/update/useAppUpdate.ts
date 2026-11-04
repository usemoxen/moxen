import { useCallback, useEffect, useReducer, useRef } from "react";

import type { ClientApi } from "../../../server/api.js";
import { IDLE, errorCode, reduceUpdate, updateEventFromFrame, type UpdateEvent, type UpdateOperation } from "../../model/update.js";

/**
 * The update screen's state, kept in the app so closing the screen does not lose an update that runs. The server
 * reports progress on the shell subscription the app already holds, so `onFrame` is fed from there (no second
 * subscription, and none that could start after the command). Asking GitHub is the server's `app.update.check`:
 * it runs only when the screen opens or the person asks again, never in the background.
 */
export function useAppUpdate(client: ClientApi, linkConnected: boolean) {
  const [view, dispatchView] = useReducer(reduceUpdate, IDLE);
  // What the next press sees before React has rendered the last one: a double press must not start two.
  const latest = useRef(view);
  latest.current = view;
  const send = (event: UpdateEvent) => {
    latest.current = reduceUpdate(latest.current, event);
    dispatchView(event);
  };

  const check = useCallback(() => {
    if (latest.current.phase === "running" || latest.current.phase === "checking") return;
    send({ type: "check-start" });
    client.query({ type: "app.update.check" }).then(
      (value) => send({ type: "check-done", check: value }),
      (cause: unknown) => send({ type: "check-failed", message: cause instanceof Error ? cause.message : String(cause) }),
    );
  }, [client]);

  const run = useCallback((op: UpdateOperation) => {
    if (latest.current.phase === "running") return;
    const commandId = globalThis.crypto.randomUUID();
    send({ type: "run-start", op, commandId });
    const command = op === "apply" ? ({ type: "app.update.apply", commandId } as const) : ({ type: "app.update.rollback", commandId } as const);
    (client.dispatch(command) as Promise<unknown>).then(
      (result) => send({ type: "run-done", commandId, result: result as never }),
      (cause: unknown) => {
        const code = errorCode(cause);
        // A dropped connection is not a failure of the update: the server may still be at it.
        if (code === "SERVER_DISCONNECTED") send({ type: "link-lost" });
        else send({ type: "run-failed", commandId, code, message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  }, [client]);

  useEffect(() => {
    if (!linkConnected) send({ type: "link-lost" });
  }, [linkConnected]);

  return {
    view,
    /** Opening the screen: ask once, unless an update runs (or already ended and has not been looked at). */
    open: () => {
      const phase = latest.current.phase;
      if (phase === "idle" || phase === "ready" || phase === "unreachable") check();
    },
    check,
    install: () => run("apply"),
    rollback: () => run("rollback"),
    onFrame: (frame: unknown) => {
      const event = updateEventFromFrame(frame);
      if (event !== null) send(event);
    },
  };
}

import { t } from "../../i18n/index.js";
import { useMemo, useState } from "react";

import { dispatchErrorMessage } from "../../../core/errors.js";
import { pendingPermissionRequests, type ThreadState } from "../../model/thread.js";
import type { useToasts } from "../../hooks/useToasts.js";
import { COPY_TOAST_MS } from "../../app/constants.js";
import type { ClientApi } from "../../../server/api.js";
import type { PermissionDecision } from "../../../server/protocol.js";

const DECIDED = (): Record<PermissionDecision, string> => ({
  accept: t("perm.allowed_bb5f"),
  "accept-session": t("perm.allowed_for_this_session_413f"),
  decline: t("perm.denied_58d0"),
});

/**
 * The tool approval the turn is parked on, oldest first. The panel replaces
 * the composer while one is open (after any agent question, which wins the
 * slot), and an answer hides it at once — the server's `permission.resolved`
 * row confirms it, and a rejected answer brings the panel back with the error.
 */
export function usePermissionFlow(
  client: ClientApi,
  threadState: ThreadState,
  threadStateRef: { current: ThreadState },
  openThreadId: string | null,
  toasts: ReturnType<typeof useToasts>,
  setError: (message: string) => void,
) {
  const pending = useMemo(() => pendingPermissionRequests(threadState), [threadState]);
  /** Answered locally, not yet confirmed by the server. */
  const [settled, setSettled] = useState<string[]>([]);
  const active = openThreadId === null ? null : (pending.find((request) => !settled.includes(request.requestId)) ?? null);

  const respond = (decision: PermissionDecision) => {
    const request = active;
    const id = openThreadId;
    if (request === null || id === null) return;
    setSettled((current) => [...current, request.requestId]);
    void client
      .dispatch({ type: "thread.permission.respond", threadId: id, requestId: request.requestId, decision })
      .then(() => toasts.push("permission-answered", "info", DECIDED()[decision], COPY_TOAST_MS))
      .catch((cause: unknown) => {
        // A rejection right after answering in another client means the
        // request is already gone — only an approval still open is an error.
        setTimeout(() => {
          const stillPending = pendingPermissionRequests(threadStateRef.current).some(
            (entry) => entry.requestId === request.requestId,
          );
          if (stillPending) {
            setSettled((current) => current.filter((entry) => entry !== request.requestId));
            setError(dispatchErrorMessage(cause));
          } else {
            toasts.push("permission-elsewhere", "info", t("perm.already_answered_elsewhere_08b4"), COPY_TOAST_MS);
          }
        }, 800);
      });
  };

  return { activePermission: active, permissionVisible: active !== null, respondToPermission: respond };
}

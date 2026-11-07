import { useCallback, useEffect, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import { dispatchErrorMessage } from "../../../core/errors.js";
import { t } from "../../i18n/index.js";
import { COPY_TOAST_MS, ERROR_DISPLAY_MS } from "../../app/constants.js";
import { useClipboard } from "../../hooks/useClipboard.js";
import type { ToastTone } from "../../hooks/useToasts.js";
import { problemRows, type ProblemRow } from "../../model/problems.js";

/** Bad records as warnings with fixes, refreshed from the server. */
export function useProblems(
  client: ClientApi,
  push: (id: string, tone: ToastTone, text: string, ms?: number) => void,
): {
  readonly rows: readonly ProblemRow[];
  /** False once dismissed; true again when a new problem arrives. */
  readonly visible: boolean;
  readonly dismiss: () => void;
  readonly reload: () => void;
  readonly quarantine: (id: string) => void;
  readonly resetToDefault: (key: string) => void;
  readonly stopTurn: (threadId: string, turnId: string) => void;
  readonly copyPath: (text: string) => void;
} {
  const [rows, setRows] = useState<readonly ProblemRow[]>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { copyText } = useClipboard();
  const load = useCallback(() => {
    void client
      .query({ type: "store.problems" })
      .then(async (reported) => {
        const read = await client.query({ type: "config.read" }).catch(() => null);
        const next = problemRows(reported.problems, read?.path ?? "", read?.problems ?? []);
        // New rows redraw the app, and every redraw re-applies the theme:
        // only take the update when something actually changed, so a quiet
        // poll never perturbs what is on screen.
        setRows((current) =>
          current.length === next.length && current.every((row, index) => row.key === next[index]?.key && row.message === next[index]?.message)
            ? current
            : next,
        );
      })
      .catch(() => undefined);
  }, [client]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);
  const ids = rows.map((row) => row.key).join("\n");
  const fix = useCallback(
    (run: Promise<unknown>) => {
      void run
        .then(() => load())
        .catch((cause: unknown) => push("problems-fix", "danger", t("toast.error", { message: dispatchErrorMessage(cause) }), ERROR_DISPLAY_MS));
    },
    [load, push],
  );
  const quarantine = useCallback((id: string) => fix(client.dispatch({ type: "store.quarantine", id })), [client, fix]);
  const resetToDefault = useCallback((key: string) => fix(client.dispatch({ type: "settings.set", key, value: "" })), [client, fix]);
  const stopTurn = useCallback(
    (threadId: string, turnId: string) => fix(client.dispatch({ type: "thread.turn.interrupt", threadId, turnId })),
    [client, fix],
  );
  const copyPath = useCallback(
    (text: string) => {
      void copyText(text).then((ok) =>
        push("problems-copy", "info", ok ? t("app.copied_to_clipboard_efc1") : t("app.could_not_copy_fa4b"), COPY_TOAST_MS),
      );
    },
    [copyText, push],
  );
  return {
    rows,
    visible: rows.length > 0 && dismissed !== ids,
    dismiss: () => setDismissed(ids),
    reload: load,
    quarantine,
    resetToDefault,
    stopTurn,
    copyPath,
  };
}

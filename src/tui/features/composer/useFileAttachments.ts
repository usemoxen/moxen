import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "../../i18n/index.js";
import { pickPaths, type PickResult } from "../../model/filepicker.js";
import { addPaths, type PathAttachment } from "../../model/pathattachments.js";
import type { useToasts } from "../../hooks/useToasts.js";

const TOAST_MS = 4_000;

/**
 * Files and folders chosen with the OS dialog, kept per thread (as pending
 * images are). Each is a chip in the draft; the message goes out with its path in the chip's place.
 */
export function useFileAttachments(
  threadId: string | null,
  toasts: ReturnType<typeof useToasts>,
  enabled: boolean,
  pick: () => Promise<PickResult> = () => pickPaths(t("attachPaths.pick")),
) {
  const [byThread, setByThread] = useState<Record<string, PathAttachment[]>>({});
  const key = threadId ?? "__creating__";
  const items = byThread[key] ?? [];
  // The dialog stays open while the person browses: a thread switch behind
  // it must not strand the pick on the thread that opened the dialog.
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const write = useCallback((id: string, next: PathAttachment[]) => setByThread((current) => ({ ...current, [id]: next })), []);

  const attach = async (): Promise<void> => {
    if (!enabled) {
      // The dialog picks paths on this machine; a paired server's agent could not read them.
      toasts.push("attach-paths", "warn", t("attachPaths.local"), TOAST_MS);
      return;
    }
    const result = await pick();
    if (result.status === "unavailable") {
      toasts.push("attach-paths", "warn", t("attachPaths.unavailable", { why: result.reason.slice(0, 80) }), TOAST_MS);
      return;
    }
    if (result.status === "picked") {
      const live = keyRef.current;
      setByThread((current) => ({ ...current, [live]: addPaths(current[live] ?? [], result.items) }));
    }
  };

  const remove = (target: string) => setByThread((current) => ({ ...current, [key]: (current[key] ?? []).filter((item) => item.path !== target) }));

  return { items, attach, remove, clear: (id: string) => write(id, []) };
}

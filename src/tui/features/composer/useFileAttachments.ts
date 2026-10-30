import { useCallback, useState } from "react";

import { t } from "../../i18n/index.js";
import { pickPaths } from "../../model/filepicker.js";
import { addPaths, type PathAttachment } from "../../model/pathattachments.js";
import type { useToasts } from "../../hooks/useToasts.js";

const TOAST_MS = 4_000;

/**
 * Files and folders chosen with the OS dialog, kept per thread (as pending
 * images are) until the message goes out with their paths in its prompt.
 */
export function useFileAttachments(threadId: string | null, toasts: ReturnType<typeof useToasts>, enabled: boolean) {
  const [byThread, setByThread] = useState<Record<string, PathAttachment[]>>({});
  const key = threadId ?? "__creating__";
  const items = byThread[key] ?? [];

  const write = useCallback((id: string, next: PathAttachment[]) => setByThread((current) => ({ ...current, [id]: next })), []);

  const attach = async (): Promise<void> => {
    if (!enabled) {
      // The dialog picks paths on this machine; a paired server's agent could not read them.
      toasts.push("attach-paths", "warn", t("attachPaths.local"), TOAST_MS);
      return;
    }
    const result = await pickPaths(t("attachPaths.pick"));
    if (result.status === "unavailable") {
      toasts.push("attach-paths", "warn", t("attachPaths.unavailable", { why: result.reason.slice(0, 80) }), TOAST_MS);
      return;
    }
    if (result.status === "picked") setByThread((current) => ({ ...current, [key]: addPaths(current[key] ?? [], result.items) }));
  };

  const remove = (target: string) => setByThread((current) => ({ ...current, [key]: (current[key] ?? []).filter((item) => item.path !== target) }));

  return { items, attach, remove, clear: (id: string) => write(id, []) };
}

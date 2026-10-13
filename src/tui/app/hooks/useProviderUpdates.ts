import { useRef, useState } from "react";

import { describeUpdate, type UpdatableProvider } from "../../../core/catalog/update.js";
import { dispatchErrorMessage } from "../../../core/errors.js";
import type { ClientApi } from "../../../server/api.js";
import type { ToastTone } from "../../hooks/useToasts.js";

const LABELS: Record<UpdatableProvider, string> = { claude: "Claude Code", opencode: "OpenCode" };
/** The updater can take a while (a package-manager install): the "Updating…" toast stays until the answer replaces it. */
const RESULT_TOAST_MS = 9_000;

/**
 * Runs a provider's own updater (`claude update`, `opencode upgrade`) on the
 * machine the sessions run on, and says how it went. One toast per provider,
 * replaced as it goes: "Updating…", then what changed — or the reason it could
 * not. A second request while one is running is turned away, not queued.
 */
export function useProviderUpdates(
  client: ClientApi,
  push: (id: string, tone: ToastTone, text: string, ms?: number) => void,
  /** Called when an update ends, however it went: the versions on screen are out of date. */
  onFinished?: () => void,
) {
  const running = useRef(new Set<UpdatableProvider>());
  /** The same set, for rendering: a button reads "Updating…" while its provider is in it. */
  const [updating, setUpdating] = useState<ReadonlySet<UpdatableProvider>>(new Set());
  const update = (provider: UpdatableProvider) => {
    const id = `update:${provider}`;
    if (running.current.has(provider)) {
      push(id, "info", `${LABELS[provider]} is already updating…`);
      return;
    }
    running.current.add(provider);
    setUpdating(new Set(running.current));
    push(id, "info", `Updating ${LABELS[provider]}…`);
    void client
      .dispatch({ type: "provider.update", provider })
      .then((result) => push(id, "info", describeUpdate(result), RESULT_TOAST_MS))
      .catch((cause: unknown) => push(id, "danger", dispatchErrorMessage(cause), RESULT_TOAST_MS))
      .finally(() => {
        running.current.delete(provider);
        setUpdating(new Set(running.current));
        onFinished?.();
      });
  };
  return { update, updating };
}

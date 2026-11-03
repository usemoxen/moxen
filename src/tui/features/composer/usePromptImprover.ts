import { useEffect, useRef, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import type { ModelSelection } from "../../../core/types.js";
import { t } from "../../i18n/index.js";

/** A reply belongs to the exact draft and destination that requested it, never to newer typing. */
export function usePromptImprover(options: {
  client: Pick<ClientApi, "dispatch">;
  draft: string;
  resetKey: string;
  directory: string;
  modelSelection: ModelSelection | undefined;
  protectedText: readonly string[];
  disabled: boolean;
  onInput: (text: string) => void;
  restore: (text: string) => void;
  setError: (message: string) => void;
}) {
  const [improving, setImproving] = useState(false);
  const [undo, setUndo] = useState<{ identity: string; original: string; text: string } | null>(null);
  const identity = JSON.stringify([options.directory, options.modelSelection, options.protectedText]);
  const snapshot = JSON.stringify([identity, options.resetKey, options.draft, options.disabled]);
  const current = useRef({ snapshot, revision: 0 });
  if (current.current.snapshot !== snapshot) current.current = { snapshot, revision: current.current.revision + 1 };
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const improve = async (): Promise<void> => {
    if (busy.current || options.disabled || !options.draft.trim()) return;
    busy.current = true;
    setImproving(true);
    const revision = current.current.revision;
    try {
      const result = await options.client.dispatch({
        type: "prompt.improve", directory: options.directory, prompt: options.draft,
        ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
        protectedText: options.protectedText,
      });
      if (!mounted.current) return;
      if (current.current.revision !== revision) {
        options.setError(t("composer.improvementStale"));
        return;
      }
      setUndo({ identity, original: options.draft, text: result.text });
      options.restore(result.text);
    } catch (cause) {
      if (mounted.current) options.setError(t("composer.improvementFailed", { why: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      busy.current = false;
      if (mounted.current) setImproving(false);
    }
  };

  const onInput = (text: string): void => {
    // Native input can arrive before React commits the parent's new draft.
    current.current.revision += 1;
    options.onInput(text);
  };

  const undoImprovement = undo !== null && undo.identity === identity && undo.text === options.draft && !options.disabled
    ? () => { options.restore(undo.original); setUndo(null); }
    : undefined;
  return { improving, improve, undoImprovement, onInput };
}

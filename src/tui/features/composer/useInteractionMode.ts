import { useEffect, useState } from "react";

import { storedInteractionMode } from "../../../core/interactionmode.js";
import type { InteractionMode, ThreadEnvelope } from "../../../core/types.js";
import type { ClientApi } from "../../../server/api.js";
import { interactionModeLabel, nextInteractionMode, parseModeCommand } from "../../model/modes.js";

/**
 * The mode the composer shows and changes: the open thread's (a
 * `thread.interaction-mode.set` dispatch, shown at once rather than when the
 * thread list catches up), or while drafting a new thread, the one it will
 * start in. A draft starts in Build whatever the open thread is in: Research
 * and Orchestrate spend usage on delegated tasks, so a new thread never
 * inherits one unasked.
 */
export function useInteractionMode(params: {
  client: ClientApi;
  selected: ThreadEnvelope | null;
  creating: boolean;
  notify: (text: string) => void;
  setError: (message: string) => void;
}) {
  const { client, selected, creating, notify, setError } = params;
  const [creatingMode, setCreatingMode] = useState<InteractionMode>("default");
  const [requested, setRequested] = useState<{ readonly threadId: string; readonly mode: InteractionMode } | null>(null);
  const stored = storedInteractionMode(selected?.interactionMode);
  const threadMode = selected !== null && requested !== null && requested.threadId === selected.id ? requested.mode : stored;
  const mode = creating ? creatingMode : threadMode;

  // Once the thread list carries the change, it is the source again.
  useEffect(() => {
    if (requested !== null && requested.threadId === selected?.id && requested.mode === stored) setRequested(null);
  }, [requested, selected?.id, stored]);
  // Each new draft starts in Build.
  useEffect(() => {
    if (creating) setCreatingMode("default");
  }, [creating]);

  /** Switch to `next`; resolves once the server has it, so a send after it runs in the new mode. */
  const setMode = async (next: InteractionMode): Promise<boolean> => {
    if (next === mode) return true;
    notify(next === "default" ? `${interactionModeLabel(mode)} mode off: Build` : `${interactionModeLabel(next)} mode on`);
    if (creating) {
      setCreatingMode(next);
      return true;
    }
    if (selected === null) return false;
    const threadId = selected.id;
    setRequested({ threadId, mode: next });
    try {
      await client.dispatch({ type: "thread.interaction-mode.set", threadId, interactionMode: next });
      return true;
    } catch (cause) {
      setRequested(null);
      setError(String(cause).slice(0, 120));
      return false;
    }
  };

  /**
   * A `/research` or `/orchestrate` draft: switches the mode and returns the
   * text to send after it ("" for none), or null when the draft is not one.
   */
  const takeCommand = async (draft: string): Promise<string | null> => {
    const command = parseModeCommand(draft, mode);
    if (command === null) return null;
    return (await setMode(command.mode)) ? command.rest : "";
  };

  return { mode, setMode, cycleMode: () => void setMode(nextInteractionMode(mode)), takeCommand, isModeCommand: (draft: string) => parseModeCommand(draft, mode) !== null };
}

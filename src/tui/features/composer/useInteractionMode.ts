import { useEffect, useRef, useState } from "react";

import { storedInteractionMode } from "../../../core/interactionmode.js";
import type { InteractionMode, ThreadEnvelope } from "../../../core/types.js";
import type { ClientApi } from "../../../server/api.js";
import { nextInteractionMode, parseModeCommand } from "../../model/modes.js";

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
  setError: (message: string) => void;
}) {
  const { client, selected, creating, setError } = params;
  const [creatingMode, setCreatingMode] = useState<InteractionMode>("default");
  const [requested, setRequested] = useState<{ readonly threadId: string; readonly mode: InteractionMode } | null>(null);
  const stored = storedInteractionMode(selected?.interactionMode);
  const threadMode = selected !== null && requested !== null && requested.threadId === selected.id ? requested.mode : stored;
  /** The mode a new prompt starts in and `Shift+Tab` cycles: the thread's own. */
  const stickyMode = creating ? creatingMode : threadMode;
  // `/research` or `/orchestrate`: the next prompt only. The ref is read at send time, the state draws it.
  const [oneOff, setOneOff] = useState<InteractionMode | null>(null);
  const oneOffRef = useRef<InteractionMode | null>(null);
  const armOneOff = (next: InteractionMode | null) => {
    oneOffRef.current = next;
    setOneOff(next);
  };
  /** The one-off mode for the prompt being sent now, cleared by taking it; undefined when none is armed. */
  const takeOneOff = (): InteractionMode | undefined => {
    const armed = oneOffRef.current;
    if (armed === null) return undefined;
    armOneOff(null);
    return armed;
  };
  // A one-off belongs to the draft it was typed in.
  useEffect(() => {
    oneOffRef.current = null;
    setOneOff(null);
  }, [selected?.id, creating]);
  /** What the composer shows: the armed one-off, else the thread's mode. */
  const mode = oneOff ?? stickyMode;

  // Once the thread list carries the change, it is the source again.
  useEffect(() => {
    if (requested !== null && requested.threadId === selected?.id && requested.mode === stored) setRequested(null);
  }, [requested, selected?.id, stored]);
  // Each new draft starts in Build.
  useEffect(() => {
    if (creating) setCreatingMode("default");
  }, [creating]);

  /** Switch the thread's mode to `next`; resolves once the server has it, so a send after it runs in the new mode. */
  const setMode = async (next: InteractionMode): Promise<boolean> => {
    armOneOff(null);
    if (next === stickyMode) return true;
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
   * A `/research` or `/orchestrate` draft: the mode applies to one prompt and
   * the thread's own mode stays. Returns the text to send in it ("" for none,
   * which arms the mode for the next prompt; the same command again disarms),
   * or null when the draft is not one.
   */
  const takeCommand = (draft: string): string | null => {
    const command = parseModeCommand(draft);
    if (command === null) return null;
    armOneOff(command.rest.length === 0 && oneOffRef.current === command.mode ? null : command.mode);
    return command.rest;
  };

  return {
    mode,
    stickyMode,
    setMode,
    cycleMode: () => void setMode(nextInteractionMode(stickyMode)),
    takeCommand,
    takeOneOff,
    isModeCommand: (draft: string) => parseModeCommand(draft) !== null,
  };
}

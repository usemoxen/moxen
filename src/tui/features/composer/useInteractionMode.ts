import { t } from "../../i18n/index.js";
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
  /** Whether a turn is running now (read when a switch is asked for, not when it renders): the mode is fixed until it stops. */
  isRunning: () => boolean;
}) {
  const { client, selected, creating, setError, isRunning } = params;
  const [creatingMode, setCreatingMode] = useState<InteractionMode>("default");
  const [requested, setRequested] = useState<{ readonly threadId: string; readonly mode: InteractionMode } | null>(null);
  // The `thread.interaction-mode.set` still reaching the server, if any: a
  // send started now waits for it instead of racing it.
  const pendingMode = useRef<Promise<boolean> | null>(null);
  const stored = storedInteractionMode(selected?.interactionMode);
  const threadMode = selected !== null && requested !== null && requested.threadId === selected.id ? requested.mode : stored;
  /** The mode a new prompt starts in and `Shift+Tab` cycles: the thread's own. */
  const stickyMode = creating ? creatingMode : threadMode;
  // `/research`, `/orchestrate` or `/review`: the next prompt only. The ref is read at send time, the state draws it.
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
  // A switch belongs to the thread it was asked on: opening another thread
  // leaves it behind rather than holding the next thread's sends.
  useEffect(() => {
    pendingMode.current = null;
  }, [selected?.id, creating]);

  /**
   * A turn is running: the mode cannot change (not by Shift+Tab, a click on it or `/research`), and a steer
   * carries none. True, with the reason on screen, when that is so.
   */
  const refuseWhileRunning = (): boolean => {
    // Drafting a new thread is another thread: the open one running does not hold it.
    if (creating || !isRunning()) return false;
    setError(t("composer.the_mode_cant_change_e55a"));
    return true;
  };

  /** Switch the thread's mode to `next`; resolves once the server has it, so a send after it runs in the new mode. */
  const setMode = async (next: InteractionMode): Promise<boolean> => {
    if (refuseWhileRunning()) return false;
    armOneOff(null);
    if (next === stickyMode) return true;
    if (creating) {
      setCreatingMode(next);
      return true;
    }
    if (selected === null) return false;
    const threadId = selected.id;
    setRequested({ threadId, mode: next });
    const attempt = (async (): Promise<boolean> => {
      try {
        await client.dispatch({ type: "thread.interaction-mode.set", threadId, interactionMode: next });
        return true;
      } catch (cause) {
        // A newer switch has its own optimistic state: only this attempt's
        // failure clears it, never a superseded one's.
        setRequested((current) => (current !== null && current.threadId === threadId && current.mode === next ? null : current));
        setError(String(cause).slice(0, 120));
        return false;
      }
    })();
    pendingMode.current = attempt;
    try {
      return await attempt;
    } finally {
      if (pendingMode.current === attempt) pendingMode.current = null;
    }
  };

  /**
   * A `/research`, `/orchestrate` or `/review` draft: the mode applies to one prompt and
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

  /**
   * A send through this gate runs once the mode switch still reaching the
   * server has landed, so the prompt runs in the mode the composer shows.
   * See `sendAfterModeSwitch`.
   */
  const gateSend = (send: () => void): Promise<ModeGateResult> => sendAfterModeSwitch(() => pendingMode.current, send);

  return {
    mode,
    stickyMode,
    setMode,
    cycleMode: () => setMode(nextInteractionMode(stickyMode)),
    takeCommand,
    takeOneOff,
    refuseWhileRunning,
    gateSend,
    isModeCommand: (draft: string) => parseModeCommand(draft) !== null,
  };
}

/**
 * How long a send waits for an in-flight mode switch before giving up: a
 * switch is one server round trip, so longer means the server is gone and
 * every send after it would wedge behind the same wait.
 */
export const MODE_SWITCH_WAIT_MS = 5_000;

/** Whether a gated send ran, or why it stayed unsent. */
export type ModeGateResult = "sent" | "switch-failed" | "switch-timed-out";

/**
 * Runs a send once the mode switch still reaching the server has landed, so
 * the prompt runs in the mode the composer shows. With no switch in flight
 * the send runs at once. A switch that arrives while waiting supersedes the
 * one waited on: the latest attempt decides, never a stale one. When the
 * latest switch failed — or no switch lands within `timeoutMs` — the send
 * never runs, so nothing goes out silently in the old mode.
 */
export async function sendAfterModeSwitch(
  getPending: () => Promise<boolean> | null,
  send: () => void,
  timeoutMs: number = MODE_SWITCH_WAIT_MS,
): Promise<ModeGateResult> {
  const startedAt = Date.now();
  for (;;) {
    const pending = getPending();
    if (pending === null) break;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return "switch-timed-out";
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const ok = await Promise.race([
        pending,
        new Promise<"timed-out">((resolve) => {
          timer = setTimeout(() => resolve("timed-out"), remaining);
        }),
      ]);
      if (ok === "timed-out") return "switch-timed-out";
      // A newer switch arrived while waiting: it decides, not this one.
      if (getPending() !== null && getPending() !== pending) continue;
      if (!ok) return "switch-failed";
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  send();
  return "sent";
}

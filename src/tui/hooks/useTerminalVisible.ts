import { useSyncExternalStore } from "react";

/**
 * Whether the terminal can be seen, as it reports (`model/terminalVisibility.ts`).
 * True until it says otherwise, and always on a terminal that cannot say.
 */
let visible = true;
const listeners = new Set<() => void>();

export function setTerminalVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

export function isTerminalVisible(): boolean {
  return visible;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For things that only matter on screen (spinners, clocks): they stop while this is false and start again, current, when it is true. */
export function useTerminalVisible(): boolean {
  return useSyncExternalStore(subscribe, isTerminalVisible);
}

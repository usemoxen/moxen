import { useSyncExternalStore } from "react";

/**
 * Whether a modal is on screen. `ModalShell`'s translucent dimming layer
 * turns any `<image>` under it into pure black, whichever protocol draws it,
 * so anything that shows an image reads this and draws a flat placeholder
 * while a modal is open.
 */
const open = new Set<symbol>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Marks a modal open until the returned function is called (once; later calls do nothing). */
export function modalOpened(): () => void {
  const token = Symbol("modal");
  open.add(token);
  emit();
  return () => {
    if (open.delete(token)) emit();
  };
}

export function isModalOpen(): boolean {
  return open.size > 0;
}

/** For the render harness, whose scenarios share one process and leave their modals mounted. */
export function resetModalOpen(): void {
  open.clear();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useModalOpen(): boolean {
  return useSyncExternalStore(subscribe, isModalOpen);
}

import { useEffect, useState } from "react";

import { useTerminalVisible } from "./useTerminalVisible.js";

/**
 * Shared animation clock: returns wall-clock ms, re-rendering every `ms`
 * while `active`. Idle cost is zero (no interval when inactive) — callers
 * gate on exactly the condition that needs motion (running turn, visible
 * pill, mounted backdrop, ...) so a quiet screen never re-renders. It also
 * stops while the terminal reports it is hidden, and is current again on return.
 */
export function useAnimTick(active: boolean, ms: number): number {
  const [tick, setTick] = useState(() => Date.now());
  const visible = useTerminalVisible();
  useEffect(() => {
    if (!active || !visible) return;
    setTick(Date.now());
    const timer = setInterval(() => setTick(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, visible, ms]);
  return tick;
}

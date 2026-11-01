import { useEffect, useState } from "react";

import { clippedText, marqueeWindow, textWidth } from "../model/textoverflow.js";
import { useAnimTick } from "./useAnimTick.js";

const STEP_MS = 150;
const HOLD_MS = 900;

/** Only overflowing, hovered/selected text has an animation clock. */
export function useScrollingText(text: string, width: number, active: boolean): string {
  const moving = active && width > 0 && textWidth(text) > width;
  const tick = useAnimTick(moving, STEP_MS);
  const [startedAt, setStartedAt] = useState(tick);
  useEffect(() => { if (moving) setStartedAt(Date.now()); }, [text, width, moving]);
  if (!moving) return clippedText(text, width);
  return marqueeWindow(text, width, Math.max(0, Math.floor((tick - startedAt - HOLD_MS) / STEP_MS)));
}

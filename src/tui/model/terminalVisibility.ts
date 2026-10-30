/**
 * Visibility reports (private mode 2033, Ghostty 1.4): with the mode set the
 * terminal tells the program, as `CSI ? 999 ; Ps n`, whether its view can be
 * seen (1: potentially visible, 2: not visible: a background tab, another
 * workspace, a covered window). While it cannot, painting is skipped: state
 * keeps updating, and one repaint follows when it can be seen again. A
 * terminal without the mode ignores the request and never reports, so the
 * program stays visible.
 */
import { setTerminalVisible } from "../hooks/useTerminalVisible.js";

export const VISIBILITY_ENABLE = "\x1b[?2033h";
export const VISIBILITY_DISABLE = "\x1b[?2033l";

/** `true` for a report that the terminal can be seen, `false` for one that it cannot; null for any other sequence. */
export function parseVisibilityReport(sequence: string): boolean | null {
  const match = /^\x1b\[\?999;(\d+)n$/u.exec(sequence);
  if (match === null) return null;
  // The report says "not visible" only for 2; any value not known is taken as visible, as the specification asks.
  return match[1] !== "2";
}

/** The part of the renderer this needs: input sequences, and the request that paints a frame. */
export interface VisibilityRenderer {
  addInputHandler(handler: (sequence: string) => boolean): void;
  removeInputHandler(handler: (sequence: string) => boolean): void;
  requestRender(): void;
}

/**
 * Asks the terminal for visibility reports and, while it says it is hidden,
 * turns the renderer's frame requests into nothing. Returns what undoes it:
 * the mode off, the renderer as it was.
 */
export function watchTerminalVisibility(renderer: VisibilityRenderer, write: (data: string) => void): () => void {
  const painting = renderer.requestRender;
  const handler = (sequence: string): boolean => {
    const visible = parseVisibilityReport(sequence);
    if (visible === null) return false;
    setTerminalVisible(visible);
    if (visible) {
      renderer.requestRender = painting;
      // What changed while it was hidden was never painted.
      renderer.requestRender();
    } else {
      renderer.requestRender = () => {};
    }
    return true;
  };
  renderer.addInputHandler(handler);
  write(VISIBILITY_ENABLE);
  return () => {
    renderer.removeInputHandler(handler);
    renderer.requestRender = painting;
    setTerminalVisible(true);
    write(VISIBILITY_DISABLE);
  };
}

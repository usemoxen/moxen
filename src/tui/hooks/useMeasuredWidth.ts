import type { BoxRenderable } from "@opentui/core";
import { useCallback, useRef, useState } from "react";

/**
 * The width, in cells, a box was given by its parent: null until the first
 * layout. Spread `props` on the box. A resize of the terminal or a pane
 * changes it and the caller draws again, so what is sized from it follows.
 */
export function useMeasuredWidth(): { width: number | null; props: { ref: (node: BoxRenderable | null) => void; onSizeChange: () => void } } {
  const [width, setWidth] = useState<number | null>(null);
  const node = useRef<BoxRenderable | null>(null);
  const ref = useCallback((next: BoxRenderable | null) => {
    node.current = next;
    if (next !== null && next.width > 0) setWidth(next.width);
  }, []);
  const onSizeChange = useCallback(() => {
    const measured = node.current?.width ?? 0;
    if (measured > 0) setWidth(measured);
  }, []);
  return { width, props: { ref, onSizeChange } };
}

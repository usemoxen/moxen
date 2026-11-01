import type { BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

/** Keep the layout box, but release native image resources outside its clipped viewport. */
export function useImageVisibility() {
  const renderer = useRenderer();
  const ref = useRef<BoxRenderable>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let previous = false;
    const measure = () => {
      const node = ref.current;
      if (node === null) return;
      let left = 0;
      let top = 0;
      let right = renderer.width;
      let bottom = renderer.height;
      for (let parent = node.parent; parent !== null; parent = parent.parent) {
        if (parent.overflow !== "hidden") continue;
        left = Math.max(left, parent.screenX);
        top = Math.max(top, parent.screenY);
        right = Math.min(right, parent.screenX + parent.width);
        bottom = Math.min(bottom, parent.screenY + parent.height);
      }
      const next = node.width > 0 && node.height > 0 && right > left && bottom > top
        && node.screenX < right && node.screenX + node.width > left
        && node.screenY < bottom && node.screenY + node.height > top;
      if (previous === next) return;
      previous = next;
      setVisible(next);
    };
    // Post-processing sees the current frame's layout, including scroll offsets.
    // This observes requested frames only; it does not start an animation timer.
    renderer.addPostProcessFn(measure);
    renderer.requestRender();
    return () => renderer.removePostProcessFn(measure);
  }, [renderer]);
  return { ref, visible };
}

import type { TextProps } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Renderable, TextRenderable } from "@opentui/core";

import { useHover } from "../hooks/useHover.js";
import { useScrollingText } from "../hooks/useScrollingText.js";
import { textWidth } from "../model/textoverflow.js";

/** A single-line label retains its full text and reveals it on hover or selection. */
export function OverflowText({ children, width, active = false, padToWidth = false, prefix = "", suffix = "", style, onMouseOver, onMouseOut, onSizeChange, ref, ...props }: Omit<TextProps, "children" | "width" | "content"> & {
  children: string;
  width: number;
  active?: boolean;
  padToWidth?: boolean;
  prefix?: string;
  suffix?: string;
}) {
  const { hovered, handlers } = useHover();
  const [measured, setMeasured] = useState<number | null>(null);
  const measuredRef = useRef<number | null>(null);
  const nodeRef = useRef<TextRenderable | null>(null);
  const text = children.replace(/[\r\n\t]+/gu, " ");
  const budget = Math.max(0, Math.floor(width));
  const engaged = active || hovered;
  const cells = engaged ? Math.min(budget, measured ?? budget) : budget;
  const bodyWidth = Math.max(0, cells - textWidth(prefix) - textWidth(suffix));
  const shown = useScrollingText(text, bodyWidth, active || hovered);
  // Keep the original column allocation while scrolling; adjacent fields do not move.
  const allocated = padToWidth ? budget : Math.min(budget, textWidth(text) + textWidth(prefix) + textWidth(suffix));
  const measure = (node: Renderable) => {
    if (node.width <= 0) return;
    let visibleWidth = node.width;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.width <= 0) return;
      visibleWidth = Math.min(visibleWidth, Math.max(0, parent.screenX + parent.width - node.screenX));
    }
    const next = visibleWidth < allocated ? visibleWidth : null;
    if (next !== measuredRef.current) { measuredRef.current = next; setMeasured(next); }
  };
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!engaged || !node) return;
    const update = () => measure(node);
    // TextBufferRenderable emits this after resizing its viewport; it does not call onSizeChange.
    node.on("line-info-change", update);
    update();
    return () => { node.off("line-info-change", update); };
  });
  if (allocated === 0) return null;
  return (
    <text {...props} wrapMode="none" style={{ ...style, width: allocated, maxWidth: "100%", height: 1, flexShrink: 1 }}
      ref={(node) => { nodeRef.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node; }}
      onSizeChange={function () { if (engaged) measure(this); onSizeChange?.call(this); }}
      onMouseOver={function (event) { measure(this); handlers.onMouseOver(); onMouseOver?.call(this, event); }}
      onMouseOut={function (event) { handlers.onMouseOut(); onMouseOut?.call(this, event); }}
    >{`${prefix}${shown}${padToWidth ? " ".repeat(Math.max(0, bodyWidth - textWidth(shown))) : ""}${suffix}`}</text>
  );
}

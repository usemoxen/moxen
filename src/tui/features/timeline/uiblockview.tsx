import { useTerminalDimensions } from "@opentui/react";

import type { UiBlock, UiNode } from "../../../core/threads/uiblock.js";
import { useMeasuredWidth } from "../../hooks/useMeasuredWidth.js";
import { gridCellWidth, gridColumnsThatFit, splitColumns } from "../../model/uilayout.js";
import { COLOR } from "../../theme.js";
import { BlendedImage, ReplyImage } from "./replyimage.js";

/** The widest a block is drawn, pane permitting, and what a first frame assumes the pane and its gutter take from the screen. */
const MAX_BLOCK_COLUMNS = 100;
const SIDE_ROOM = 12;

/**
 * A `moxen-ui` block a reply carries, drawn from its parsed tree. A container
 * hands each child a number of cells; an image fits itself in them. The same
 * boxes are drawn whether a row sits side by side or stacks (a pane too
 * narrow for readable cells), so a resize never rebuilds an image.
 */
export function UiBlockView({ block }: { block: UiBlock }) {
  const { width: screenWidth } = useTerminalDimensions();
  const measured = useMeasuredWidth();
  const columns = Math.max(8, Math.min(MAX_BLOCK_COLUMNS, measured.width ?? screenWidth - SIDE_ROOM));
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, width: "100%" }} {...measured.props}>
      <UiNodeView node={block.root} columns={columns} />
    </box>
  );
}

function UiNodeView({ node, columns }: { node: UiNode; columns: number }) {
  switch (node.type) {
    case "image":
      return <ReplyImage path={node.src} alt={node.alt} caption={node.caption} maxColumns={columns} ops={node.ops} fill />;
    case "blend":
      return <BlendedImage a={node.a} b={node.b} mode={node.mode} opacity={node.opacity} caption={node.caption} maxColumns={columns} fill />;
    case "text":
      return (
        <text fg={COLOR.text} wrapMode="word" selectable>
          {node.text}
        </text>
      );
    case "caption":
      return (
        <text fg={COLOR.dim} wrapMode="word" selectable>
          {node.text}
        </text>
      );
    case "column":
      return (
        <box style={{ flexDirection: "column", rowGap: node.gap, flexShrink: 0 }}>
          {node.children.map((child, at) => (
            <Cell key={at} width={columns}>
              <UiNodeView node={child} columns={columns} />
            </Cell>
          ))}
        </box>
      );
    case "row": {
      const widths = splitColumns(
        columns,
        node.children.map((child) => child.weight ?? 1),
        node.gap,
      );
      return (
        <box style={{ flexDirection: widths === null ? "column" : "row", columnGap: node.gap, rowGap: node.gap, flexShrink: 0 }}>
          {node.children.map((child, at) => (
            <Cell key={at} width={widths?.[at] ?? columns}>
              <UiNodeView node={child} columns={widths?.[at] ?? columns} />
            </Cell>
          ))}
        </box>
      );
    }
    case "grid": {
      const fit = gridColumnsThatFit(columns, node.columns, node.gap);
      return (
        <box style={{ flexDirection: "row", flexWrap: "wrap", columnGap: node.gap, rowGap: node.gap, flexShrink: 0 }}>
          {node.children.map((child, at) => {
            const width = gridCellWidth(columns, fit, node.gap, child.span ?? 1);
            return (
              <Cell key={at} width={width}>
                <UiNodeView node={child} columns={width} />
              </Cell>
            );
          })}
        </box>
      );
    }
  }
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return <box style={{ flexDirection: "column", width, flexShrink: 0 }}>{children}</box>;
}

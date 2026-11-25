import { useMemo } from "react";
import type { SyntaxStyle } from "@opentui/core";

import { splitMarkdownBlocks } from "../model/markdownblocks.js";
import { COLOR } from "../theme.js";

export interface MarkdownViewProps {
  content: string;
  fg: string;
  syntaxStyle: SyntaxStyle;
  streaming?: boolean | undefined;
  selectable?: boolean | undefined;
}

/** Top-level mode defaults tables to borderless columns; keep the boxed grid a top-level table gets. */
const LIST_TABLE_OPTIONS = { style: "grid" } as const;

/**
 * A drop-in `<markdown>` for the TUI that also renders the tables GFM allows
 * inside containers (MXN-375): OpenTUI only structures top-level tables, so
 * a table under a list item or inside a blockquote used to draw as raw pipes.
 * The content is cut into blocks (`splitMarkdownBlocks`); lists render in
 * `internalBlockMode="top-level"`, where OpenTUI draws list children
 * structurally, and blockquotes render as a bordered box around a recursive
 * render of their inner markdown. Content without a list or blockquote takes
 * the exact single-`<markdown>` path it always did.
 */
export function MarkdownView({ content, fg, syntaxStyle, streaming, selectable }: MarkdownViewProps) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  const shared = {
    fg,
    syntaxStyle,
    ...(streaming === undefined ? {} : { streaming }),
    ...(selectable === undefined ? {} : { selectable }),
  };
  if (blocks.length === 1 && blocks[0]!.kind === "text") {
    return <markdown content={content} {...shared} />;
  }
  return (
    <>
      {blocks.map((block, index) => {
        const marginTop = block.gapBefore ? 1 : 0;
        if (block.kind === "quote") {
          return (
            <box
              key={index}
              border={["left"]}
              borderColor={COLOR.dim}
              style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, marginTop }}
            >
              <MarkdownView content={block.inner} fg={fg} syntaxStyle={syntaxStyle} streaming={streaming} selectable={selectable} />
            </box>
          );
        }
        return (
          <markdown
            key={index}
            content={block.text}
            marginTop={marginTop}
            {...shared}
            {...(block.kind === "list" ? { internalBlockMode: "top-level" as const, tableOptions: LIST_TABLE_OPTIONS } : {})}
          />
        );
      })}
    </>
  );
}

import { t } from "../../i18n/index.js";
import type { ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRef } from "react";

import { useHover } from "../../hooks/useHover.js";
import { clockTime } from "../../model/turns.js";
import { queuedLabel, queuedSummary, type QueuedMessage } from "../../model/thread.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";

/** Rows shown at once; a longer queue scrolls inside the panel, like Tasks. */
const MAX_QUEUED_ROWS = 6;

/**
 * When a waiting message goes out. Plain queued ones go when the running
 * turn settles; the rest name their time.
 */
export function whenLabel(item: QueuedMessage, now: number): string {
  if (item.scheduledFor === null) return t("queued.after_this_turn_c5ef");
  const at = clockTime(item.scheduledFor, now);
  // ◷, not the ⏲ emoji: terminals draw the emoji two cells wide over the space after it.
  if (item.reason === "usage-hold") return t("queued.afterReset", { at });
  return `◷ ${at}`;
}

function CancelButton({ onClick }: { onClick: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <text
      fg={hovered ? COLOR.danger : COLOR.faint}
      bg={hovered ? SURFACE.hover : SURFACE.panel}
      selectable={false}
      onMouseDown={onClick}
      {...handlers}
    >
      {" × "}
    </text>
  );
}

/**
 * Messages the agent has not been sent yet, pinned above the composer in
 * the Tasks slot. A queued message is not in the transcript until it is
 * sent — that is when the agent sees it — so this is the one place it is
 * visible, and where it can be taken back. It leaves the list the moment
 * it is sent and appears in the chat instead.
 */
export function QueuedPanel({
  items,
  width,
  now,
  onCancel,
  pager,
}: {
  items: readonly QueuedMessage[];
  width: number;
  now: number;
  onCancel: (turnId: string) => void;
  /** The `‹ 1/2 ›` control when Tasks shares the slot. */
  pager?: ReactNode;
}) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const overflows = items.length > MAX_QUEUED_ROWS;
  const rowWidth = Math.max(4, width - 2 - (overflows ? 1 : 0));
  const held = items.filter((item) => item.reason === "usage-hold").length;
  const rows = items.map((item, index) => {
    const when = whenLabel(item, now);
    const extra = item.attachments > 0 ? t("queued.images", { count: item.attachments }) : "";
    // Cancel is 3 cells, the when-label and its gap follow the text.
    const textWidth = Math.max(4, rowWidth - 4 - when.length - 2 - extra.length - 3);
    const firstLine = queuedLabel(item);
    return (
      <box key={item.turnId} style={{ width: rowWidth, flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.panel}>
        <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{`${index + 1}. `}</text>
        <text fg={item.tasks === undefined ? COLOR.text : COLOR.dim} bg={SURFACE.panel}>{truncate(firstLine || t("queued.image_only_d3ad"), textWidth)}</text>
        <text fg={COLOR.faint} bg={SURFACE.panel} selectable={false}>{extra}</text>
        <box style={{ flexGrow: 1 }} backgroundColor={SURFACE.panel} />
        <text fg={item.reason === "usage-hold" ? COLOR.warn : COLOR.faint} bg={SURFACE.panel} selectable={false}>
          {`  ${when}`}
        </text>
        <CancelButton onClick={() => onCancel(item.turnId)} />
      </box>
    );
  });

  return (
    <box
      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: SURFACE.panel }}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.panel}>
        <text fg={COLOR.accent} bg={SURFACE.panel} selectable={false}>{t("queued.queued_7b2f")}</text>
        <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>
          {t("queued.takeBack", { summary: queuedSummary(items.length, held) })}
        </text>
        <box style={{ flexGrow: 1 }} backgroundColor={SURFACE.panel} />
        {pager ?? null}
      </box>
      {overflows ? (
        <scrollbox
          ref={scrollRef}
          style={{ height: MAX_QUEUED_ROWS, flexShrink: 0, backgroundColor: SURFACE.panel }}
          verticalScrollbarOptions={{
            showArrows: false,
            trackOptions: { foregroundColor: COLOR.accent, backgroundColor: SURFACE.border },
          }}
        >
          {rows}
        </scrollbox>
      ) : (
        rows
      )}
    </box>
  );
}

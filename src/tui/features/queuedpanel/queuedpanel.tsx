import { OverflowText } from "../../ui/overflowtext.js";
import { t } from "../../i18n/index.js";
import type { ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRef } from "react";

import { useHover } from "../../hooks/useHover.js";
import { clockTime } from "../../model/turns.js";
import { clippedText, textWidth } from "../../model/textoverflow.js";
import { queueConditionText } from "../../model/workqueue.js";
import { queuedLabel, queuedSummary, type QueuedMessage } from "../../model/thread.js";
import { COLOR, SURFACE } from "../../theme.js";

/** Rows shown at once; a longer queue scrolls inside the panel, like Tasks. */
const MAX_QUEUED_ROWS = 6;

/**
 * When a waiting message goes out. Plain queued ones go when the running
 * turn settles; the rest name their time, and every condition the entry
 * waits for, so a held message never reads as a plain "after this turn".
 * `maxWidth` keeps the state label from crowding out the message and its
 * agent marker: several conditions become a count, and the full list stays
 * in the Work queue.
 */
export function whenLabel(item: QueuedMessage, now: number, threads: readonly { id: string; title: string }[] = [], maxWidth = Number.POSITIVE_INFINITY): string {
  const at = item.scheduledFor === null ? null : clockTime(item.scheduledFor, now);
  // ◷, not the ⏲ emoji: terminals draw the emoji two cells wide over the space after it.
  const compactTime = at === null ? null : `◷ ${at}`;
  const fullTime = at === null ? null : item.reason === "usage-hold" ? t("queued.afterReset", { at }) : compactTime;
  const held = item.held === true ? [t("queued.held")] : [];
  const conditions = item.conditions ?? [];
  if (conditions.length > 1) {
    // The count is the part that must survive: drop the time before clipping it.
    const count = t(item.held === true ? "queued.conditionsShort" : "queued.conditions", { count: conditions.length });
    const base = [...held, count];
    const withTime = compactTime === null ? base : [compactTime, ...base];
    const chosen = textWidth(withTime.join(" · ")) <= maxWidth ? withTime : base;
    return textWidth(chosen.join(" · ")) <= maxWidth ? chosen.join(" · ") : clippedText(chosen.join(" · "), maxWidth);
  }
  if (conditions.length === 1) {
    const condition = queueConditionText(conditions[0]!, threads, [], now);
    const base = [...held, condition];
    const withFullTime = fullTime === null ? base : [fullTime, ...base];
    const withCompactTime = compactTime === null ? base : [compactTime, ...base];
    const chosen = textWidth(withFullTime.join(" · ")) <= maxWidth ? withFullTime : withCompactTime;
    return textWidth(chosen.join(" · ")) <= maxWidth ? chosen.join(" · ") : clippedText(chosen.join(" · "), maxWidth);
  }
  if (at === null) return item.held === true ? t("queued.held") : t("queued.after_this_turn_c5ef");
  const parts = held.length > 0 ? [compactTime!, ...held] : [fullTime!];
  return textWidth(parts.join(" · ")) <= maxWidth ? parts.join(" · ") : clippedText(parts.join(" · "), maxWidth);
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
  threads = [],
}: {
  items: readonly QueuedMessage[];
  width: number;
  now: number;
  onCancel: (turnId: string) => void;
  /** The `‹ 1/2 ›` control when Tasks shares the slot. */
  pager?: ReactNode;
  /** Thread titles for a condition that waits for another thread. */
  threads?: readonly { id: string; title: string }[];
}) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const overflows = items.length > MAX_QUEUED_ROWS;
  const rowWidth = Math.max(4, width - 2 - (overflows ? 1 : 0));
  const held = items.filter((item) => item.reason === "usage-hold").length;
  const rows = items.map((item, index) => {
    // Leave most of the row to the message and its agent marker; the state
    // label shows a bounded summary (the Work queue has the full list).
    const when = whenLabel(item, now, threads, Math.max(10, Math.floor(rowWidth * 0.42)));
    const extra = item.attachments > 0 ? t("queued.images", { count: item.attachments }) : "";
    // Cancel is 3 cells, the when-label and its gap follow the text.
    const textWidthAvailable = Math.max(4, rowWidth - 4 - textWidth(when) - 2 - extra.length - 3);
    const firstLine = queuedLabel(item);
    return (
      <box key={item.turnId} style={{ width: rowWidth, flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.panel}>
        <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{`${index + 1}. `}</text>
        <OverflowText fg={item.tasks === undefined && item.background !== true ? COLOR.text : COLOR.dim} bg={SURFACE.panel} width={textWidthAvailable}>{firstLine || t("queued.image_only_d3ad")}</OverflowText>
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

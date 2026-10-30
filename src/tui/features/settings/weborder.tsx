import { t, tx } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import type { WebOrderRow } from "../../model/settings.js";

/**
 * The order a provider's model should try its web tools in. The ranked ones
 * come first, numbered; the rest sit below, unranked. Space ranks a tool (at
 * the end) or takes it out, `u` and `d` move a ranked one, and every change is
 * applied at once. A tool this provider cannot use says why and cannot be
 * ranked, but a stale one already in the order can still be taken out.
 */
export function WebOrderEditor({
  title,
  description,
  rows,
  width,
  onChange,
  onExit,
}: {
  title: string;
  description: string;
  /** Ranked tools in rank order, then the rest. */
  rows: readonly WebOrderRow[];
  width: number;
  /** The ids now ranked, comma-separated; empty puts the setting back to unset. */
  onChange: (order: string) => void;
  onExit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const ranked = rows.filter((row) => row.rank !== null);

  const write = (ids: readonly string[]) => onChange(ids.join(","));
  const toggle = (row: WebOrderRow | undefined) => {
    if (row === undefined) return;
    if (row.rank !== null) return write(ranked.filter((other) => other.id !== row.id).map((other) => other.id));
    if (row.locked !== null) return;
    write([...ranked.map((other) => other.id), row.id]);
  };
  const move = (row: WebOrderRow | undefined, by: -1 | 1) => {
    if (row === undefined || row.rank === null) return;
    const ids = ranked.map((other) => other.id);
    const from = row.rank - 1;
    const to = from + by;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    write(ids);
    // The row moved with the tool, so the cursor follows it.
    setCursor(to);
  };

  useKeyboard((key) => {
    key.preventDefault();
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    if (escape || key.name === "left") return onExit();
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) return setCursor(Math.min(at + 1, Math.max(0, rows.length - 1)));
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) return setCursor(Math.max(at - 1, 0));
    if (enter || key.name === "space" || key.name === "right") return toggle(rows[at]);
    if (!key.ctrl && !key.meta && key.name === "u") return move(rows[at], -1);
    if (!key.ctrl && !key.meta && key.name === "d") return move(rows[at], 1);
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(`web-order-${at}`), 0);
    return () => clearTimeout(timer);
  }, [at]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <Back onBack={onExit} />
      <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{title}</text>
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{description}</text>
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
        {rows.map((row, index) => (
          <Row key={row.id} id={`web-order-${index}`} row={row} active={index === at} width={width} onPress={() => { setCursor(index); toggle(row); }} />
        ))}
      </scrollbox>
      <box style={{ flexDirection: "row", flexShrink: 0, height: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
          {truncate(t("wo.footer", { state: ranked.length === 0 ? t("wo.noPreference") : t("wo.ranked", { count: ranked.length }) }), width)}
        </text>
      </box>
    </box>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} onMouseDown={onBack} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("ui.back")}</text>
    </box>
  );
}

function Row({ id, row, active, width, onPress }: { id: string; row: WebOrderRow; active: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const locked = row.locked !== null;
  const left = `${active ? "▌ " : "  "}${row.rank === null ? " ·" : `${String(row.rank).padStart(2, " ")}.`} ${row.label}`;
  const right = locked ? `· ${tx(row.locked ?? "")}` : tx(row.summary);
  const rightWidth = Math.max(0, width - left.length - 4);
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={locked ? COLOR.faint : active ? COLOR.bright : row.rank === null ? COLOR.dim : COLOR.text} bg={bg} selectable={false}>{truncate(left, Math.max(8, width - 4))}</text>
      {rightWidth < 6 ? null : <text fg={locked ? COLOR.warn : COLOR.dim} bg={bg} selectable={false}>{truncate(right, rightWidth)}</text>}
    </box>
  );
}

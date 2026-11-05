import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE } from "../../theme.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { overflowColumns } from "../../model/textoverflow.js";

/** One key and what it does: the footer's hints and an entry's actions are both made of these. */
export interface KeyHint { readonly key: string; readonly label: string; readonly onClick?: () => void }

/** A key and its word that can be pressed or clicked; idle it reads as a hint, hovered it fills like the other buttons. */
export function KeyButton({ hint, tone = "dim" }: { hint: KeyHint; tone?: "dim" | "danger" }) {
  const hover = useHover();
  const bg = hover.hovered && hint.onClick ? SURFACE.hover : SURFACE.raised;
  return <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={bg} {...(hint.onClick ? { ...hover.handlers, onMouseDown: hint.onClick } : {})}>
    <text fg={tone === "danger" ? COLOR.danger : COLOR.accent} bg={bg} selectable={false}>{hint.key}</text>
    <text fg={hover.hovered && hint.onClick ? COLOR.bright : tone === "danger" ? COLOR.danger : COLOR.dim} bg={bg} selectable={false}>{` ${hint.label}`}</text>
  </box>;
}

/** The line of key hints at the bottom of a modal, like Settings': dim, separated by a dot, each clickable when it can act. */
export function KeyHints({ hints }: { hints: readonly KeyHint[] }) {
  return <box style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0, height: 1 }}>
    {hints.map((hint, i) => <box key={hint.key + hint.label} style={{ flexDirection: "row", flexShrink: 0 }}>
      {i > 0 ? <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{" · "}</text> : null}
      <KeyButton hint={hint} />
    </box>)}
  </box>;
}

/** Keeps lines `first..last` of a scrollbox in view when focus moves, without fighting the mouse wheel otherwise. */
export function useKeepInView(first: number, last: number, height: number) {
  const ref = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const pane = ref.current;
    if (!pane || height <= 0) return;
    if (first < pane.scrollTop) pane.scrollTo(first);
    else if (last >= pane.scrollTop + height) pane.scrollTo(Math.max(first, last - height + 1));
  }, [first, last, height]);
  return ref;
}

export interface Choice {
  readonly key: string;
  readonly label: string;
  /** Said at the right edge, dimmer. */
  readonly detail?: string;
  /** A section title instead of a choice: it cannot be focused. */
  readonly header?: boolean;
  /** A radio mark in front: whether this is the current value. */
  readonly current?: boolean;
  readonly tone?: "danger";
  readonly onPick?: () => void;
}

/**
 * A plain list the keyboard walks: the marker bar on the focused row, enter or a click picks. Used for every
 * step of choosing a condition, the options and the schedule page. It owns up, down, enter and escape.
 */
export function ChoiceList({ choices, width, height, emptyText, onBack }: {
  choices: readonly Choice[];
  width: number;
  height: number;
  emptyText?: string;
  onBack: () => void;
}) {
  const pickable = choices.map((choice, at) => (choice.header || !choice.onPick ? -1 : at)).filter((at) => at >= 0);
  const [focus, setFocus] = useFocus(pickable);
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") { onBack(); return; }
    const at = pickable.indexOf(focus);
    if (key.name === "down") setFocus(pickable[Math.min(pickable.length - 1, at + 1)] ?? focus);
    else if (key.name === "up") setFocus(pickable[Math.max(0, at - 1)] ?? focus);
    else if (key.name === "return" || key.name === "kpenter") choices[focus]?.onPick?.();
  });
  const ref = useKeepInView(Math.max(0, focus - (choices[focus - 1]?.header ? 1 : 0)), focus, height);
  if (!choices.length) return <text fg={COLOR.dim} bg={SURFACE.raised}>{emptyText ?? ""}</text>;
  return <scrollbox ref={ref} style={{ flexGrow: 1 }} stickyStart="top" verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
    {choices.map((choice, at) => choice.header
      ? <box key={choice.key} style={{ height: 1, flexShrink: 0, marginTop: at === 0 ? 0 : 1 }}><text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{choice.label}</text></box>
      : <ChoiceRow key={choice.key} choice={choice} focused={at === focus} width={width - 1} onFocus={() => setFocus(at)} />)}
  </scrollbox>;
}


/** The focused row's index among `pickable`, kept valid when the list changes under it. */
function useFocus(pickable: readonly number[]): [number, (at: number) => void] {
  const [focus, setFocus] = useState<number>(pickable[0] ?? 0);
  const valid = pickable.includes(focus) ? focus : pickable[0] ?? 0;
  return [valid, setFocus];
}

function ChoiceRow({ choice, focused, width, onFocus }: { choice: Choice; focused: boolean; width: number; onFocus: () => void }) {
  const bg = focused ? SURFACE.hover : SURFACE.raised;
  const mark = choice.current === undefined ? "" : choice.current ? "● " : "○ ";
  const columns = overflowColumns(`  ${mark}${choice.label}`, choice.detail, width - 2);
  return <box style={{ flexDirection: "row", width, height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg} {...(choice.onPick ? { onMouseDown: choice.onPick } : {})} onMouseOver={onFocus}>
    <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={bg}>
      <text fg={COLOR.accent} bg={bg} selectable={false}>{focused ? "▌ " : "  "}</text>
      <OverflowText fg={choice.tone === "danger" ? COLOR.danger : focused ? COLOR.bright : COLOR.text} bg={bg} selectable={false} width={Math.max(1, columns.label - 2)} active={focused} prefix={mark}>{choice.label}</OverflowText>
    </box>
    {choice.detail ? <OverflowText fg={COLOR.faint} bg={bg} selectable={false} width={columns.detail} active={focused}>{choice.detail}</OverflowText> : null}
  </box>;
}

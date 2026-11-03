import { useHover } from "../hooks/useHover.js";
import { COLOR, SURFACE } from "../theme.js";

/** A clickable label in the header: the way back, or an action on the open entry. */
export function Chip({ label, keyHint, onPress, accent, danger, disabled }: { label: string; keyHint?: string; onPress: () => void; accent?: boolean; danger?: boolean; disabled?: boolean }) {
  const { hovered, handlers } = useHover();
  const bg = hovered && disabled !== true ? SURFACE.hover : SURFACE.raised;
  const fg = disabled === true ? COLOR.faint : danger ? COLOR.danger : accent ? COLOR.accent : COLOR.text;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginRight: 1, paddingRight: 1 }} backgroundColor={bg} onMouseDown={() => disabled !== true && onPress()} selectable={false} {...handlers}>
      <text fg={fg} bg={bg} selectable={false}>{label}</text>
      {keyHint === undefined ? null : <text fg={COLOR.faint} bg={bg} selectable={false}>{` ${keyHint}`}</text>}
    </box>
  );
}

import { useHover } from "../hooks/useHover.js";
import { COLOR, SURFACE } from "../theme.js";

/**
 * A clickable label in a header or card: either a quiet inline chip or a
 * bracketed TUI action (`[ Label ]`) that matches the rest of the TUI's
 * button language (`MoxenUpdateCard`, `ProviderUpdateCard`).
 */
export function Chip({
  label,
  keyHint,
  onPress,
  accent,
  danger,
  disabled,
  bracketed,
  surface,
}: {
  label: string;
  keyHint?: string;
  onPress: () => void;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
  bracketed?: boolean;
  surface?: string;
}) {
  const { hovered, handlers } = useHover();
  const baseBg = surface ?? SURFACE.raised;
  if (bracketed === true) {
    const fg =
      disabled === true
        ? COLOR.faint
        : hovered
          ? danger
            ? COLOR.danger
            : COLOR.bright
          : danger
            ? COLOR.danger
            : accent
              ? COLOR.accent
              : COLOR.text;
    const text = keyHint === undefined ? `[ ${label} ]` : `[ ${label} (${keyHint}) ]`;
    return (
      <box
        style={{ flexDirection: "row", height: 1, flexShrink: 0, marginRight: 1 }}
        backgroundColor={baseBg}
        onMouseDown={() => disabled !== true && onPress()}
        selectable={false}
        {...handlers}
      >
        <text fg={fg} bg={baseBg} selectable={false}>{text}</text>
      </box>
    );
  }
  const bg = hovered && disabled !== true ? SURFACE.hover : baseBg;
  const fg = disabled === true ? COLOR.faint : danger ? COLOR.danger : accent ? COLOR.accent : COLOR.text;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginRight: 1, paddingRight: 1 }} backgroundColor={bg} onMouseDown={() => disabled !== true && onPress()} selectable={false} {...handlers}>
      <text fg={fg} bg={bg} selectable={false}>{label}</text>
      {keyHint === undefined ? null : <text fg={COLOR.faint} bg={bg} selectable={false}>{` ${keyHint}`}</text>}
    </box>
  );
}

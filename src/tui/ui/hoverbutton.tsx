import { useHover } from "../hooks/useHover.js";
import { SURFACE } from "../theme.js";
import { OverflowText } from "./overflowtext.js";

/**
 * A text button with background hover — the close-menu standard issue: idle
 * blends into its surroundings, hover fills with `SURFACE.hover` (and
 * optionally brightens the label) so disparate buttons feel like one family.
 */
export function HoverButton({
  label,
  fg,
  hoverFg,
  bg,
  hoverBg = SURFACE.hover,
  onClick,
  width,
  active = false,
}: {
  label: string;
  fg: string;
  hoverFg?: string;
  bg?: string;
  hoverBg?: string;
  onClick: () => void;
  width?: number;
  active?: boolean;
}) {
  const { hovered, handlers } = useHover();
  const resolvedBg = hovered ? hoverBg : bg;
  if (width !== undefined) return <OverflowText fg={hovered && hoverFg !== undefined ? hoverFg : fg} {...(resolvedBg === undefined ? {} : { bg: resolvedBg })} selectable={false} onMouseDown={onClick} width={width} active={active || hovered} {...handlers}>{label}</OverflowText>;
  return (
    <text
      fg={hovered && hoverFg !== undefined ? hoverFg : fg}
      {...(resolvedBg === undefined ? {} : { bg: resolvedBg })}
      selectable={false}
      onMouseDown={onClick}
      {...handlers}
    >
      {label}
    </text>
  );
}

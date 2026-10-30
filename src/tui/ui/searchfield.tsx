import { t } from "../i18n/index.js";
import { COLOR, SURFACE } from "../theme.js";

/**
 * The search row the pickers and the sidebar share: a lens, then "Search"
 * (dim) or what is typed with a caret. Typing is the owner's: this only
 * draws, and a click hands focus to whoever owns the query.
 */
export function SearchField({
  query,
  active = true,
  placeholder = t("ui.search_1334"),
  marginTop = 1,
  onClick,
}: {
  query: string;
  /** Takes keystrokes now: the caret shows. */
  active?: boolean;
  placeholder?: string;
  marginTop?: number;
  onClick?: () => void;
}) {
  const empty = query.length === 0;
  return (
    <box
      style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop, paddingLeft: 1 }}
      backgroundColor={SURFACE.hover}
      selectable={false}
      {...(onClick === undefined ? {} : { onMouseDown: onClick })}
    >
      <text fg={COLOR.dim} bg={SURFACE.hover} selectable={false}>{"⌕  "}</text>
      <text fg={empty ? COLOR.dim : COLOR.bright} bg={SURFACE.hover} selectable={false}>
        {empty ? (active ? `${placeholder}▏` : placeholder) : active ? `${query}▏` : query}
      </text>
    </box>
  );
}

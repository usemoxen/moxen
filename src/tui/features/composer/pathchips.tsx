import { useHover } from "../../hooks/useHover.js";
import { pathIcon, pathLabel, type PathAttachment } from "../../model/pathattachments.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";

function Chip({ item, onRemove, maxWidth }: { item: PathAttachment; onRemove: (path: string) => void; maxWidth: number }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} selectable={false} {...handlers}>
      <text fg={COLOR.text} bg={SURFACE.raised} selectable={false}>{` ${pathIcon(item.kind)} ${truncate(pathLabel(item), maxWidth)} `}</text>
      <text fg={hovered ? COLOR.danger : COLOR.dim} bg={hovered ? SURFACE.hover : SURFACE.raised} selectable={false} onMouseDown={() => onRemove(item.path)}>
        {" ✕ "}
      </text>
    </box>
  );
}

/**
 * The files and folders attached to the next message, one chip each with its
 * icon and name and a ✕ that takes it off (one press). They sit above the
 * composer; nothing is uploaded, the message carries their paths.
 */
export function PathChips({ items, onRemove, width }: { items: readonly PathAttachment[]; onRemove: (path: string) => void; width: number }) {
  if (items.length === 0) return null;
  return (
    <box style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0, columnGap: 1, paddingLeft: 1, width }}>
      {items.map((item) => (
        <Chip key={item.path} item={item} onRemove={onRemove} maxWidth={Math.max(8, Math.floor(width / 2))} />
      ))}
    </box>
  );
}

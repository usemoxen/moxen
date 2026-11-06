import { useHover } from "../../hooks/useHover.js";
import { COLOR } from "../../theme.js";

/** The suffix a line carries when the native decoder cannot read its picture. One wording everywhere. */
const UNUSABLE_SUFFIX = " (could not be drawn)";

/** What stands in for a picture while its bytes come, or if they cannot be drawn. */
export function Placeholder({ label, state }: { label: string; state: string }) {
  return (
    <text fg={state === "failed" ? COLOR.faint : COLOR.dim} selectable={false}>
      {`▣ ${label}${state === "failed" ? " (not found)" : state === "unusable" ? UNUSABLE_SUFFIX : ""}`}
    </text>
  );
}

/** One clickable line standing in for a picture that cannot be drawn. A click opens the viewer, where the original bytes still open externally. */
export function UndrawableLine({ label, onOpen }: { label: string; onOpen: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box onMouseDown={onOpen} {...handlers} style={{ flexShrink: 0 }}>
      <text fg={hovered ? COLOR.bright : COLOR.dim} selectable={false}>
        {`▣ ${label}${UNUSABLE_SUFFIX}`}
      </text>
    </box>
  );
}

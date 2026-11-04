import { TextAttributes } from "@opentui/core";

import { useHover } from "../../hooks/useHover.js";
import { t } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { OverflowText } from "../../ui/overflowtext.js";

/**
 * Where the composer sits while a role of a research run (or its lead) is open
 * as a full thread: what is on screen, and the way back to the run.
 */
export function RunBackBar({ title, state, width, onBack }: { title: string; state: string; width: number; onBack: () => void }) {
  const { hovered, handlers } = useHover();
  const back = t("run.back");
  const inner = width - 5 - 2 - back.length - 2;
  const suffix = `  ·  ${t("run.backPart")}  ·  ${state}`;
  const room = Math.max(4, inner - suffix.length);
  return (
    <box
      border={["left"]}
      borderStyle="heavy"
      borderColor={COLOR.diff}
      style={{ width, flexDirection: "row", flexShrink: 0, marginTop: 1, marginBottom: 1, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, justifyContent: "space-between" }}
      backgroundColor={SURFACE.raised}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.diff} bg={SURFACE.raised} selectable={false}>{"◈ "}</text>
        <OverflowText fg={COLOR.text} bg={SURFACE.raised} selectable={false} width={room} active={hovered}>{title}</OverflowText>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{suffix}</text>
      </box>
      <text
        fg={hovered ? COLOR.bright : COLOR.accent}
        bg={SURFACE.raised}
        attributes={TextAttributes.NONE}
        style={{ flexShrink: 0 }}
        selectable={false}
        onMouseDown={onBack}
        {...handlers}
      >
        {back}
      </text>
    </box>
  );
}

import { useKeyboard } from "@opentui/react";
import { useState } from "react";

import { RESEARCH_CRITIC_COUNTS, RESEARCH_MAX_RESEARCHERS } from "../../../core/threads/researchvocab.js";
import type { ResearchPlan, ResearchProposal, ResearchRole } from "../../../server/api.js";
import { useHover } from "../../hooks/useHover.js";
import { t } from "../../i18n/index.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import {
  initialPicker, moveRow, setCritics, setResearchers, stepPicker, threadCount, type PickerRow, type PickerState,
} from "../../model/researchpicker.js";
import { COLOR, SURFACE } from "../../theme.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { ModalShell } from "../../ui/modalshell.js";
import { OverflowText } from "../../ui/overflowtext.js";

/** Width and height of the picker's panel, for the geometry the app centres it by. */
export const PICKER_SIZE = { width: 72, height: 17 } as const;

const LABEL_WIDTH = 16;

/** A click target in the stepped control: one dot of the researchers, one of the critics' two choices. */
function Step({ label, on, focused, onPick }: { label: string; on: boolean; focused: boolean; onPick: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <text
      fg={on ? COLOR.accent : hovered ? COLOR.bright : COLOR.faint}
      bg={hovered ? SURFACE.hover : SURFACE.raised}
      attributes={focused && on ? 1 : 0}
      selectable={false}
      onMouseDown={onPick}
      {...handlers}
    >
      {label}
    </text>
  );
}

/**
 * The run size picker (MXN-243): researchers 1 to 8 as dots, critics as one
 * of two choices, one finalizer, the model and effort each role runs on, and
 * what the run will open. Left and right change the focused row, up and down
 * move between rows, a click on a dot sets it. Nothing starts until Start.
 */
export function ResearchPickerModal({
  proposal,
  modelName,
  providerName,
  screenWidth,
  screenHeight,
  left,
  top,
  onStart,
  onSingle,
}: {
  proposal: ResearchProposal;
  /** A role's model and effort as one short label, e.g. "Opus 5.5 · Medium". */
  modelName: (role: ResearchRole) => string;
  /** The provider each role draws on, deduplicated by the caller. */
  providerName: string;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  onStart: (plan: ResearchPlan) => void;
  onSingle: () => void;
}) {
  const [state, setState] = useState<PickerState>(() => initialPicker(proposal.plan));
  const { size } = state;
  const start = () => onStart({ size, ...(proposal.plan.models ? { models: proposal.plan.models } : {}) });
  const single = () => {
    markModalDismissed();
    onSingle();
  };
  useKeyboard((key) => {
    if (key.name === "left" || key.name === "h") setState((current) => stepPicker(current, -1));
    else if (key.name === "right" || key.name === "l") setState((current) => stepPicker(current, 1));
    else if (key.name === "up" || key.name === "k") setState((current) => moveRow(current, -1));
    else if (key.name === "down" || key.name === "j" || key.name === "tab") setState((current) => moveRow(current, 1));
    else if (key.name === "return") start();
    else if (key.name === "escape" || key.name === "o") single();
    else if (key.sequence !== undefined && /^[1-8]$/u.test(key.sequence) && state.row === "researchers") setState((current) => setResearchers(current, Number(key.sequence)));
  });
  const inner = PICKER_SIZE.width - 4;
  const dots = Array.from({ length: RESEARCH_MAX_RESEARCHERS }, (_, at) => at < size.researchers);
  const row = (name: PickerRow | "finalizer", label: string, control: React.ReactNode, count: string, role: ResearchRole, note?: string) => {
    const focused = state.row === name;
    return (
      <>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
          <text fg={focused ? COLOR.accent : COLOR.faint} bg={SURFACE.raised} selectable={false}>{focused ? "▌" : " "}</text>
          <text fg={focused ? COLOR.bright : COLOR.text} bg={SURFACE.raised} selectable={false}>{label.padEnd(LABEL_WIDTH)}</text>
          <box style={{ flexDirection: "row", width: 14, flexShrink: 0 }} backgroundColor={SURFACE.raised}>{control}</box>
          <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{count.padEnd(4)}</text>
          <OverflowText fg={COLOR.dim} bg={SURFACE.raised} selectable={false} width={Math.max(8, inner - LABEL_WIDTH - 1 - 14 - 4)}>{modelName(role)}</OverflowText>
        </box>
        {note === undefined ? null : (
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
            <text bg={SURFACE.raised}>{" ".repeat(LABEL_WIDTH + 1)}</text>
            <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={inner - LABEL_WIDTH - 1}>{note}</OverflowText>
          </box>
        )}
      </>
    );
  };
  const critics = (
    <>
      {RESEARCH_CRITIC_COUNTS.map((count) => (
        <Step key={count} label={` ${count} `} on={size.critics === count} focused={state.row === "critics"} onPick={() => setState((current) => setCritics(current, count))} />
      ))}
    </>
  );
  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={PICKER_SIZE.width} height={PICKER_SIZE.height} onClose={single}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("research.picker.title")}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"esc"}</text>
      </box>
      <box style={{ height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <OverflowText fg={COLOR.dim} bg={SURFACE.raised} selectable={false} width={inner}>{proposal.task}</OverflowText>
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        {row("researchers", t("run.role.researchers"), dots.map((on, at) => (
          <Step key={at} label={on ? "●" : "○"} on={on} focused={state.row === "researchers"} onPick={() => setState((current) => setResearchers(current, at + 1))} />
        )), String(size.researchers), "researcher", t("research.picker.researchersNote", { count: size.researchers }))}
        {row("critics", t("run.role.critics"), critics, String(size.critics), "critic", t(size.critics === 1 ? "research.picker.criticsOne" : "research.picker.criticsThree"))}
        {row("finalizer", t("run.role.finalizer"), <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"●"}</text>, "1", "finalizer")}
      </box>
      <box style={{ height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <OverflowText fg={COLOR.text} bg={SURFACE.raised} selectable={false} width={inner}>{t("research.picker.threads", { count: threadCount(size), providers: providerName })}</OverflowText>
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <HoverButton label={` ${t("research.picker.start")} `} fg={COLOR.bright} bg={SURFACE.hover} hoverBg={COLOR.accent} hoverFg="#09090b" onClick={start} />
        <text bg={SURFACE.raised}>{"  "}</text>
        <HoverButton label={` ${t("research.picker.single")} `} fg={COLOR.dim} hoverFg={COLOR.bright} onClick={single} />
      </box>
      <box style={{ height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={inner}>{t("research.picker.keys")}</OverflowText>
      </box>
    </ModalShell>
  );
}

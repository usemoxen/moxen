import { useEffect, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";

import { t } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { ModalShell } from "../../ui/modalshell.js";
import type { ProblemRow } from "../../model/problems.js";

/**
 * Every bad record with its fix: move a bad record aside, reset a bad
 * setting to its default, stop a stuck turn. Nothing here deletes or
 * rewrites on its own — each button is one explicit fix.
 */
export function ProblemsModal({
  rows,
  screenWidth,
  screenHeight,
  onClose,
  onQuarantine,
  onReset,
  onStop,
  onCopy,
}: {
  rows: readonly ProblemRow[];
  screenWidth: number;
  screenHeight: number;
  onClose: () => void;
  onQuarantine: (id: string) => void;
  onReset: (key: string) => void;
  onStop: (threadId: string, turnId: string) => void;
  onCopy: (text: string) => void;
}) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      onClose();
    }
  });
  // The last fix clears the list: nothing left to show, so go back to the thread.
  useEffect(() => {
    if (rows.length === 0) onClose();
  }, [rows.length, onClose]);
  const width = Math.min(100, Math.max(40, screenWidth - 4));
  const height = Math.max(8, Math.min(10 + rows.length * 3, screenHeight - 2));
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(0, Math.floor((screenHeight - height) / 2));
  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("problems.modalTitle")}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"esc"}</text>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>
        {rows.map((row) => {
          const fixes: ReactNode[] = [];
          if (row.quarantineId !== undefined) {
            fixes.push(<HoverButton label={` ${t("problems.moveAside")} `} fg={COLOR.accent} onClick={() => onQuarantine(row.quarantineId!)} />);
          }
          if (row.resetKey !== undefined) {
            fixes.push(<HoverButton label={` ${t("problems.resetDefault")} `} fg={COLOR.accent} onClick={() => onReset(row.resetKey!)} />);
          }
          if (row.stop !== undefined) {
            fixes.push(<HoverButton label={` ${t("problems.stopTurn")} `} fg={COLOR.accent} onClick={() => onStop(row.stop!.threadId, row.stop!.turnId)} />);
          }
          return (
            <box key={row.key} style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
              <text fg={COLOR.text} bg={SURFACE.raised} selectable={false}>{row.message}</text>
              <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{row.location}</text>
              <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }}>
                {fixes.map((fix, index) => (
                  <box key={index} style={{ flexDirection: "row", flexShrink: 0, ...(index === 0 ? {} : { marginLeft: 1 }) }}>
                    {fix}
                  </box>
                ))}
                <box style={{ flexDirection: "row", flexShrink: 0, marginLeft: 1 }}>
                  <HoverButton label={` ${t("problems.copyPath")} `} fg={COLOR.dim} hoverFg={COLOR.text} onClick={() => onCopy(row.copyText)} />
                </box>
              </box>
            </box>
          );
        })}
      </box>
    </ModalShell>
  );
}

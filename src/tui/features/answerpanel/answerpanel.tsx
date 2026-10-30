import { t } from "../../i18n/index.js";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";

import { PICK_BG, PICK_FG } from "../pickers/pickermodal.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { COLOR, markdownSyntaxStyle, SURFACE, truncate } from "../../theme.js";
import type { PendingUserInputQuestion } from "../../model/thread.js";

/** A preview is a glance, not a document: long ones clip rather than push the transcript away. */
const PREVIEW_MAX_ROWS = 14;

export interface AnswerRow {
  key: string;
  label: string;
  meta?: string;
  selected?: boolean;
  onPick: () => void;
}

/**
 * Inline question UI replacing the composer while an agent question is
 * pending (Claude-Code style): the question on top, one row per option with
 * its description, custom-answer and (multi-select) continue rows, and a
 * hint line. Owns its keys exactly like a modal does — the app swallows
 * every other binding while this is mounted, and `suspended` yields to the
 * custom-answer prompt on top of it.
 */
export function AnswerPanel({
  question,
  position,
  total,
  width,
  suspended,
  pickedValues,
  customValue,
  tabs,
  onGoto,
  onToggleOption,
  onPickOption,
  onCustom,
  onContinue,
  onDismiss,
}: {
  question: PendingUserInputQuestion;
  /** 0-based position for multi-question requests. */
  position: number;
  total: number;
  /** Outer width, border included — same slot the composer fills. */
  width: number;
  /** A modal prompt is open above: ignore keys but keep rendering. */
  suspended: boolean;
  /** Option values currently toggled (multi-select). */
  pickedValues: readonly string[];
  /** Free-text answer already given to this question (when revisiting it). */
  customValue?: string;
  /** One tab per question of a multi-question request, in order. */
  tabs: ReadonlyArray<{ header: string; answered: boolean }>;
  /** Jump to another question, keeping answers. */
  onGoto: (index: number) => void;
  onToggleOption: (value: string) => void;
  onPickOption: (value: string) => void;
  onCustom: () => void;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  // Revisiting a question lands on what was answered, not the top row.
  const [highlight, setHighlight] = useState(() => {
    const picked = question.options.findIndex((option) => pickedValues.includes(option.value ?? option.label));
    if (picked >= 0) return picked;
    return customValue !== undefined && question.allowCustomAnswer !== false ? question.options.length : 0;
  });

  const rows: AnswerRow[] = [
    ...question.options.map((option, order) => {
      const value = option.value ?? option.label;
      return {
        key: `option:${order}`,
        label: `${order + 1}. ${option.label}`,
        ...(option.description !== null && option.description.length > 0
          ? { meta: truncate(option.description, 48) }
          : {}),
        selected: pickedValues.includes(value),
        onPick: () => {
          if (question.multiSelect) onToggleOption(value);
          else onPickOption(value);
        },
      };
    }),
    ...(question.allowCustomAnswer === false
      ? []
      : [
          {
            key: "custom",
            label: t("answer.custom_answer_cd39"),
            ...(customValue === undefined ? {} : { meta: truncate(customValue, 32), selected: true }),
            onPick: onCustom,
          },
        ]),
    ...(question.multiSelect
      ? [{ key: "continue", label: t("answer.continue_a757"), meta: t("answer.picked", { count: pickedValues.length }), onPick: onContinue }]
      : []),
  ];
  const safe = rows.length === 0 ? -1 : Math.min(highlight, rows.length - 1);
  // Option rows come first, so a highlight inside them names its option.
  const preview = safe >= 0 && safe < question.options.length ? question.options[safe]?.preview ?? null : null;

  useKeyboard((key) => {
    if (suspended || rows.length === 0) return;
    // No escape here: this listener is global, so it would take esc from whichever
    // panel is focused. The × in the header dismisses.
    if (total > 1 && (key.name === "left" || key.name === "backspace") && position > 0) {
      onGoto(position - 1);
      return;
    }
    if (total > 1 && key.name === "right" && position + 1 < total) {
      onGoto(position + 1);
      return;
    }
    if (key.name === "up") {
      setHighlight((current) => (current - 1 + rows.length) % rows.length);
      return;
    }
    if (key.name === "down") {
      setHighlight((current) => (current + 1) % rows.length);
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      const row = rows[safe];
      row?.onPick();
      return;
    }
    if (key.ctrl === true || key.meta === true) return;
    const digit = /^([1-9])$/.exec(key.name);
    if (digit?.[1] !== undefined) {
      const option = question.options[Number.parseInt(digit[1], 10) - 1];
      if (option !== undefined) {
        const value = option.value ?? option.label;
        if (question.multiSelect) onToggleOption(value);
        else onPickOption(value);
      }
    }
  });

  const inner = Math.max(10, width - 4);

  return (
    <box style={{ width, flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
      <box
        border={["left"]}
        borderStyle="heavy"
        borderColor={COLOR.warn}
        style={{
          flexDirection: "column",
          backgroundColor: SURFACE.raised,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
        selectable={false}
      >
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
          {total > 1 ? (
            <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={SURFACE.raised}>
              <text fg={COLOR.warn} bg={SURFACE.raised} selectable={false}>
                {"◈ "}
              </text>
              {tabs.map((tab, order) => {
                const active = order === position;
                // Only the open tab spells its header out; the rest stay a number
                // (with a ✓ once answered) so a long request still fits the row.
                const label = ` ${order + 1}${tab.answered ? "✓" : ""}${active ? ` ${truncate(tab.header, Math.max(8, inner - 30 - tabs.length * 5))}` : ""} `;
                return (
                  <HoverButton
                    key={order}
                    label={label}
                    fg={active ? COLOR.warn : tab.answered ? COLOR.accent : COLOR.faint}
                    hoverFg={COLOR.bright}
                    {...(active ? { bg: SURFACE.hover } : { bg: SURFACE.raised })}
                    onClick={() => onGoto(order)}
                  />
                );
              })}
            </box>
          ) : (
            <text fg={COLOR.warn} bg={SURFACE.raised} selectable={false}>
              {truncate(`◈ ${question.header}`, inner)}
            </text>
          )}
          <HoverButton label=" × " fg={COLOR.faint} hoverFg={COLOR.danger} bg={SURFACE.raised} onClick={onDismiss} />
        </box>
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.bright} bg={SURFACE.raised}>
            {question.question}
          </text>
        </box>
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          {rows.map((row, order) => {
            const active = order === safe;
            return (
              <box
                key={row.key}
                style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}
                backgroundColor={active ? PICK_BG : SURFACE.raised}
                onMouseDown={row.onPick}
                onMouseOver={() => setHighlight(order)}
              >
                <text fg={active ? PICK_FG : row.selected === true ? COLOR.accent : COLOR.text} bg={active ? PICK_BG : SURFACE.raised} selectable={false}>
                  {`${row.selected === true ? "● " : "  "}${truncate(row.label, Math.max(0, inner - (row.meta === undefined ? 4 : row.meta.length + 5)))}`}
                </text>
                {row.meta === undefined ? null : (
                  <text fg={active ? PICK_FG : COLOR.faint} bg={active ? PICK_BG : SURFACE.raised} selectable={false}>
                    {` ${row.meta}`}
                  </text>
                )}
              </box>
            );
          })}
        </box>
        {preview === null ? null : (
          <box
            border
            borderStyle="rounded"
            borderColor={SURFACE.border}
            title={t("answer.preview_aac3")}
            titleColor={COLOR.faint}
            style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1, maxHeight: PREVIEW_MAX_ROWS }}
            backgroundColor={SURFACE.raised}
          >
            <markdown content={preview} fg={COLOR.text} syntaxStyle={markdownSyntaxStyle()} />
          </box>
        )}
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "flex-end" }}>
        <text fg={COLOR.faint}>{truncate(t(total > 1 ? "answer.hintMany" : "answer.hintOne"), Math.max(0, width))}</text>
      </box>
    </box>
  );
}

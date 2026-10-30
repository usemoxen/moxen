import { t } from "../i18n/index.js";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";

import { DATE_FIELDS, FIELD_WIDTH, atLeast, earliestSchedule, fieldText, moveField, stepField, typeDigit, type DateField } from "../model/datepicker.js";
import { markModalDismissed } from "../model/modalDismiss.js";
import { describeScheduled } from "../model/schedule.js";
import { COLOR, SURFACE } from "../theme.js";
import { ModalShell } from "./modalshell.js";

const SEPARATOR: Record<DateField, string> = { year: "-", month: "-", day: " ", hour: ":", minute: "" };

/** One field: its value with a ▲ above and a ▼ below, each a click target. */
function FieldColumn({
  field,
  text,
  selected,
  onSelect,
  onStep,
}: {
  field: DateField;
  text: string;
  selected: boolean;
  onSelect: () => void;
  onStep: (delta: 1 | -1) => void;
}) {
  const width = FIELD_WIDTH[field];
  const middle = (glyph: string) => " ".repeat(Math.floor((width - 1) / 2)) + glyph + " ".repeat(Math.ceil((width - 1) / 2));
  const arrow = selected ? COLOR.accent : COLOR.faint;
  return (
    <box style={{ flexDirection: "column", width, flexShrink: 0 }} selectable={false}>
      <text fg={arrow} bg={SURFACE.raised} selectable={false} onMouseDown={() => onStep(1)}>{middle("▲")}</text>
      <text
        fg={selected ? COLOR.bright : COLOR.text}
        bg={selected ? SURFACE.hover : SURFACE.raised}
        selectable={false}
        onMouseDown={onSelect}
      >
        {text}
      </text>
      <text fg={arrow} bg={SURFACE.raised} selectable={false} onMouseDown={() => onStep(-1)}>{middle("▼")}</text>
    </box>
  );
}

/**
 * The Schedule message picker: a date and time as digit fields, like a
 * handheld's clock screen. ← → pick a field, ↑ ↓ change it, digits type over
 * it, enter schedules, esc cancels. Always a real moment, so nothing to
 * mistype. It never goes back in time: nothing earlier than five minutes
 * from now can be picked.
 */
export function DateTimeModal({
  title = t("app.schedule_message_cbae"),
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onSubmit,
  onClose,
}: {
  title?: string;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onSubmit: (at: Date) => void;
  onClose: () => void;
}) {
  // Fixed for as long as the picker is open; enter checks it again against the clock.
  const [earliest] = useState(() => earliestSchedule(new Date()));
  const [at, setAt] = useState(earliest);
  const [field, setField] = useState<DateField>("hour");
  const [typed, setTyped] = useState("");

  const select = (next: DateField) => {
    setField(next);
    setTyped("");
  };
  const step = (target: DateField, delta: 1 | -1) => {
    // A step into the past (or a wrap round into it) is refused.
    setAt((current) => {
      const next = stepField(current, target, delta);
      return next.getTime() < earliest.getTime() ? current : next;
    });
    select(target);
  };

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      onClose();
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      // The clock has moved on since the picker opened: pull the time forward rather than send it sooner than allowed.
      onSubmit(atLeast(at, earliestSchedule(new Date())));
      return;
    }
    if (key.name === "left" || (key.name === "tab" && key.shift === true)) {
      select(moveField(field, -1));
      return;
    }
    if (key.name === "right" || key.name === "tab") {
      select(moveField(field, 1));
      return;
    }
    if (key.name === "up") {
      step(field, 1);
      return;
    }
    if (key.name === "down") {
      step(field, -1);
      return;
    }
    if (/^[0-9]$/u.test(key.sequence)) {
      const result = typeDigit(at, field, typed, key.sequence);
      setAt(atLeast(result.at, earliest));
      if (result.advance) {
        setField(moveField(field, 1));
        setTyped("");
      } else {
        setTyped(result.typed);
      }
    }
  });

  const when = describeScheduled(at, new Date());
  const day = at.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised}>{title}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised}>{"esc"}</text>
      </box>
      <box style={{ flexDirection: "row", height: 3, flexShrink: 0, marginTop: 1, justifyContent: "center" }}>
        {DATE_FIELDS.map((name) => (
          <box key={name} style={{ flexDirection: "row", flexShrink: 0 }}>
            <FieldColumn
              field={name}
              text={fieldText(at, name)}
              selected={field === name}
              onSelect={() => select(name)}
              onStep={(delta) => step(name, delta)}
            />
            {SEPARATOR[name] === "" ? null : (
              <box style={{ flexDirection: "column", width: 3, flexShrink: 0 }} selectable={false}>
                <text fg={COLOR.faint} bg={SURFACE.raised}>{" "}</text>
                <text fg={COLOR.dim} bg={SURFACE.raised}>{` ${SEPARATOR[name]} `}</text>
                <text fg={COLOR.faint} bg={SURFACE.raised}>{" "}</text>
              </box>
            )}
          </box>
        ))}
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "center" }}>
        <text fg={COLOR.accent} bg={SURFACE.raised}>{`${day} · ${when}`}</text>
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "center" }}>
        <text fg={COLOR.faint} bg={SURFACE.raised}>{t("ui.field_change_digits_type_97be")}</text>
      </box>
    </ModalShell>
  );
}

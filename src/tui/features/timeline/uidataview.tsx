import { TextAttributes } from "@opentui/core";

import type { UiBar, UiColor } from "../../../core/threads/uiblock.js";
import { chartLayout, progressLayout } from "../../model/uidata.js";
import { COLOR } from "../../theme.js";

/** The theme's colour for a named one: a reply names a colour, the theme decides what it is. Read at draw time, so a theme change shows at once. */
function themeColor(color: UiColor | undefined): string {
  switch (color) {
    case "red":
      return COLOR.danger;
    case "yellow":
      return COLOR.warn;
    case "green":
      return COLOR.added;
    case "white":
      return COLOR.bright;
    case "black":
      return COLOR.faint;
    case "blue":
    case undefined:
      return COLOR.accent;
  }
}

function Title({ text }: { text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <text fg={COLOR.bright} attributes={TextAttributes.BOLD} selectable>
      {text}
    </text>
  );
}

/** A bar chart: a label, a bar and a value per row, the bars scaled to the largest (or to `max`). */
export function ChartView({ title, unit, max, bars, columns }: { title?: string | undefined; unit?: string | undefined; max?: number | undefined; bars: readonly UiBar[]; columns: number }) {
  const layout = chartLayout(bars, columns, unit, max);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Title text={title} />
      {layout.rows.map((row, at) => (
        <text key={at} selectable>
          <span fg={COLOR.dim}>{row.label.padEnd(layout.labelWidth)}</span>
          {" "}
          <span fg={themeColor(bars[at]!.color)}>{row.bar}</span>
          {" ".repeat(Math.max(0, layout.barWidth - row.bar.length))}
          {layout.valueWidth > 0 ? <span fg={COLOR.text}>{` ${row.value.padStart(layout.valueWidth)}`}</span> : null}
        </text>
      ))}
    </box>
  );
}

/** A progress row: `label  ████░░░░  42%  38 of 90`. */
export function ProgressView({ label, value, text, color, columns }: { label: string; value: number; text?: string | undefined; color?: UiColor | undefined; columns: number }) {
  const layout = progressLayout(label, value, text, columns);
  const track = "░".repeat(Math.max(0, layout.barWidth - layout.bar.length));
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {layout.stackedLabel === null ? null : (
        <text fg={COLOR.dim} selectable>
          {layout.stackedLabel}
        </text>
      )}
      <text selectable>
        {layout.stackedLabel === null ? <span fg={COLOR.dim}>{`${layout.label.padEnd(layout.labelWidth)} `}</span> : null}
        <span fg={themeColor(color)}>{layout.bar}</span>
        <span fg={COLOR.faint}>{track}</span>
        <span fg={COLOR.text}>{` ${layout.right}`}</span>
      </text>
    </box>
  );
}

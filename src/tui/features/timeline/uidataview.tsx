import { TextAttributes } from "@opentui/core";

import type { UiBar, UiColor, UiState } from "../../../core/threads/uiblock.js";
import { chartLayout, fit, keyValueLayout, progressLayout, STATE_GLYPH, statusLayout } from "../../model/uidata.js";
import { COLOR, STATUS_COLOR } from "../../theme.js";

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

/** The theme's colour for a state: the ones the sidebar and the tasks panel give it. */
function stateColor(state: UiState): string {
  switch (state) {
    case "live":
      return STATUS_COLOR.running ?? COLOR.accent;
    case "held":
      return STATUS_COLOR.active ?? COLOR.warn;
    case "broken":
      return COLOR.danger;
    case "next":
      return COLOR.dim;
    case "done":
      return COLOR.added;
  }
}

/** A list of facts: keys dim in an aligned column, values beside them, wrapping. */
export function KeyValueView({ title, rows, columns }: { title?: string | undefined; rows: readonly { key: string; value: string }[]; columns: number }) {
  const layout = keyValueLayout(rows.map((row) => row.key), columns);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Title text={title} />
      {rows.map((row, at) => (
        <box key={at} style={{ flexDirection: layout.stacked ? "column" : "row", columnGap: 2, flexShrink: 0 }}>
          <box style={{ width: layout.keyWidth, flexShrink: 0 }}>
            <text fg={COLOR.dim} selectable>
              {fit(row.key, layout.keyWidth)}
            </text>
          </box>
          <box style={{ width: layout.valueWidth, flexShrink: 0 }}>
            <text fg={COLOR.text} wrapMode="word" selectable>
              {row.value}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

/** A grid of things and where each stands, in the five states' own marks and colours. */
export function StatusView({ title, rows, columns }: { title?: string | undefined; rows: readonly { label: string; state: UiState; note?: string | undefined }[]; columns: number }) {
  const layout = statusLayout(rows.map((row) => row.label), columns);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Title text={title} />
      {rows.map((row, at) => (
        <box key={at} style={{ flexDirection: "column", flexShrink: 0 }}>
          <text selectable>
            <span fg={stateColor(row.state)}>{`${STATE_GLYPH[row.state]} `}</span>
            <span fg={COLOR.text}>{layout.noteWidth > 0 ? fit(row.label, layout.labelWidth).padEnd(layout.labelWidth) : fit(row.label, columns - 2)}</span>
            {layout.noteWidth > 0 && row.note !== undefined ? <span fg={COLOR.dim}>{`  ${fit(row.note, layout.noteWidth)}`}</span> : null}
          </text>
          {layout.noteWidth === 0 && row.note !== undefined ? (
            <text fg={COLOR.dim} selectable>
              {`  ${fit(row.note, columns - 2)}`}
            </text>
          ) : null}
        </box>
      ))}
    </box>
  );
}

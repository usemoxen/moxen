import { t } from "../../i18n/index.js";
import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";

import { SearchField } from "../../ui/searchfield.js";
import { ModalShell } from "../../ui/modalshell.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { marqueeWindow } from "../../model/skills.js";
import { Slider } from "../../ui/slider.js";
import { effortTones, sliderLayout } from "../../model/slider.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { TextAttributes } from "@opentui/core";

/** Marquee tick for the highlighted row's meta text, ms per column — same cadence as the skill popup. */
const PICKER_MARQUEE_INTERVAL_MS = 350;

export interface PickerRow {
  key: string;
  label: string;
  meta?: string;
  /** A short tag in the accent before the meta ("default"). */
  badge?: string;
  /** Current choice: dot prefix plus highlight. */
  selected?: boolean;
  /**
   * Visible but not actionable (server support missing): dimmed, and both
   * enter and click are no-ops — the `meta` should say why (e.g. "not yet
   * supported"). Kept in the list (and in filter results) so the affordance
   * is discoverable instead of silently missing.
   */
  disabled?: boolean;
  onPick: () => void;
}

export interface PickerSection {
  header?: string;
  headerColor?: string;
  rows: PickerRow[];
}

/** A few stops along a track, as the effort picker offers them; a list when they would not fit. */
export interface PickerSlider {
  key: string;
  header: string;
  stops: ReadonlyArray<{ key: string; label: string; isDefault?: boolean; description?: string | undefined }>;
  /** The stop in force; null when none is. */
  current: string | null;
  ends?: { readonly low: string; readonly high: string };
  /** Colour the stops cool to hot, as reasoning levels. */
  effort?: boolean;
  /** What the highlighted stop is called when it is the default ("The default effort for this model"). */
  defaultCaption?: string;
  onPick: (stopKey: string) => void;
}

export type PickerBody =
  | { kind: "sliders"; sliders: PickerSlider[] }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "list"; sections: PickerSection[] };

/** Selected-row colors, mirroring the reference Select-model modal. Shared with the answer panel. */
export const PICK_BG = "#df9f5f";
export const PICK_FG = "#221503";

/**
 * Centered modal picker: title
 * with esc on the right, an inline filter row, sections of rows with a
 * right-aligned meta column, and a highlighted current row. It owns its keys
 * (type to filter, arrows to move, enter to pick, escape to close); the app
 * swallows every other global binding while it is open, and the composer is
 * unfocused so keystrokes never leak into the draft.
 */
export function PickerModal({
  title,
  body,
  filter,
  onFilterChange,
  filterable,
  prefiltered = false,
  emptyLabel,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
}: {
  title: string;
  body: PickerBody;
  filter: string;
  onFilterChange: (value: string) => void;
  filterable: boolean;
  /** The rows already answer the filter (the server searched), so none is hidden by it here. */
  prefiltered?: boolean;
  emptyLabel: string;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [marqueeTick, setMarqueeTick] = useState(0);
  const sliderWidth = Math.max(10, width - 6);
  /** Sliders need room for every label; narrower than that they are a list like any other picker. */
  const sliding = body.kind === "sliders" && body.sliders.every((slider) => sliderLayout(slider.stops.map((stop) => stop.label), sliderWidth).fits);
  const listBody = useMemo<Exclude<PickerBody, { kind: "sliders" }>>(() => {
    if (body.kind !== "sliders") return body;
    return {
      kind: "list",
      sections: body.sliders.map((slider) => ({
        header: slider.header,
        rows: slider.stops.map((stop) => ({
          key: `${slider.key}:${stop.key}`,
          label: stop.isDefault === true ? t("picker.withDefault", { label: stop.label }) : stop.label,
          selected: slider.current === stop.key,
          onPick: () => slider.onPick(stop.key),
        })),
      })),
    };
  }, [body]);
  /** Which slider has the keys, and where each one's marker is. */
  const [focusSlider, setFocusSlider] = useState(0);
  const [stopAt, setStopAt] = useState<Record<string, number>>({});
  const stopOf = (slider: PickerSlider): number => {
    const set = stopAt[slider.key];
    if (set !== undefined) return set;
    const current = slider.stops.findIndex((stop) => stop.key === slider.current);
    return Math.max(0, current >= 0 ? current : slider.stops.findIndex((stop) => stop.isDefault === true));
  };

  // The highlighted row's meta text auto-scrolls instead of sitting
  // truncated or overflowing — ticks only while the modal is mounted.
  useEffect(() => {
    const timer = setInterval(() => setMarqueeTick((tick) => tick + 1), PICKER_MARQUEE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    if (listBody.kind !== "list") return [];
    const query = prefiltered ? "" : filter.trim().toLowerCase();
    const rows: PickerRow[] = [];
    for (const section of listBody.sections) {
      for (const row of section.rows) {
        if (query.length === 0) {
          rows.push(row);
          continue;
        }
        const haystack = `${row.label} ${row.meta ?? ""}`.toLowerCase();
        if (haystack.includes(query)) rows.push(row);
      }
    }
    return rows;
  }, [listBody, filter, prefiltered]);

  const visibleSections = useMemo(() => {
    if (listBody.kind !== "list") return [];
    const keys = new Set(visible.map((row) => row.key));
    return listBody.sections
      .map((section) => ({ ...section, rows: section.rows.filter((row) => keys.has(row.key)) }))
      .filter((section) => section.rows.length > 0);
  }, [listBody, visible]);

  const safe = visible.length === 0 ? -1 : Math.min(index, visible.length - 1);

  useKeyboard((key) => {
    // "esc" alias included: some inputs report the raw alias instead of the
    // canonical "escape".
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      onClose();
      return;
    }
    if (sliding && body.kind === "sliders") {
      const slider = body.sliders[Math.min(focusSlider, body.sliders.length - 1)];
      if (slider === undefined) return;
      if (key.name === "return" || key.name === "kpenter") {
        const stop = slider.stops[stopOf(slider)];
        if (stop !== undefined) slider.onPick(stop.key);
        return;
      }
      if (key.name === "left" || key.name === "right") {
        const next = Math.max(0, Math.min(stopOf(slider) + (key.name === "left" ? -1 : 1), slider.stops.length - 1));
        setStopAt((current) => ({ ...current, [slider.key]: next }));
        return;
      }
      if (key.name === "up" || key.name === "down") setFocusSlider((current) => Math.max(0, Math.min(current + (key.name === "up" ? -1 : 1), body.sliders.length - 1)));
      return;
    }
    // With no rows there is nothing to pick or move over, but typing must still
    // work: it is how an empty search (or a filter that matched nothing) gets text.
    if (visible.length > 0) {
      if (key.name === "return" || key.name === "kpenter") {
        const row = visible[safe];
        if (row !== undefined && row.disabled !== true) row.onPick();
        return;
      }
      if (key.name === "up") {
        setIndex((current) => (current - 1 + visible.length) % visible.length);
        return;
      }
      if (key.name === "down") {
        setIndex((current) => (current + 1) % visible.length);
        return;
      }
    }
    if (!filterable) return;
    if (key.name === "backspace") {
      onFilterChange(filter.slice(0, -1));
      setIndex(0);
      return;
    }
    if (key.ctrl === true || key.meta === true) return;
    const sequence = key.sequence;
    if (typeof sequence === "string" && sequence.length === 1 && sequence >= " ") {
      onFilterChange(`${filter}${sequence}`);
      setIndex(0);
    }
  });

  const inner = Math.max(10, width - 4);
  // The scrollbar and the content's right padding take two columns of a row.
  const rowWidth = Math.max(10, inner - 2);
  const hint = sliding
    ? body.kind === "sliders" && body.sliders.length > 1
      ? t("picker.move_next_setting_enter_7297")
      : t("picker.move_enter_selects_esc_dee3")
    : filterable
      ? t("picker.move_enter_selects_esc_2756")
      : t("picker.move_enter_selects_esc_f825");

  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised}>{title}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised}>{"esc"}</text>
      </box>
      {filterable ? <SearchField query={filter} active={filter.length > 0} /> : null}
      <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" contentOptions={{ paddingRight: 1 }} verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
        {sliding && body.kind === "sliders" ? (
          body.sliders.map((slider, at) => {
            const stopIndex = stopOf(slider);
            const labels = slider.stops.map((stop) => stop.label);
            const focused = at === Math.min(focusSlider, body.sliders.length - 1);
            const highlighted = slider.stops[stopIndex];
            return (
              <box key={slider.key} style={{ flexDirection: "column", flexShrink: 0, marginTop: at === 0 ? 0 : 1 }}>
                <text fg={focused ? COLOR.bright : COLOR.dim} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{slider.header}</text>
                <Slider
                  idPrefix={`picker-${slider.key}`}
                  stops={labels}
                  active={stopIndex}
                  chosen={slider.stops.findIndex((stop) => stop.key === slider.current)}
                  width={sliderWidth}
                  {...(slider.ends === undefined ? {} : { ends: slider.ends })}
                  {...(slider.effort === true ? { tones: effortTones(slider.stops.map((stop) => stop.key)) } : {})}
                  caption={highlighted?.description ?? (highlighted?.isDefault === true ? slider.defaultCaption ?? t("settings.theDefault") : undefined)}
                  onMove={(next) => {
                    setFocusSlider(at);
                    setStopAt((current) => ({ ...current, [slider.key]: next }));
                  }}
                  onPick={(next) => {
                    const stop = slider.stops[next];
                    if (stop !== undefined) slider.onPick(stop.key);
                  }}
                />
              </box>
            );
          })
        ) : listBody.kind === "loading" || body.kind === "loading" ? (
          <text fg={COLOR.dim} bg={SURFACE.raised}>{t("picker.loading_3da3")}</text>
        ) : listBody.kind === "error" ? (
          <text fg={COLOR.danger} bg={SURFACE.raised}>{` ${listBody.message}`}</text>
        ) : sliding ? null : visibleSections.length === 0 ? (
          <text fg={COLOR.faint} bg={SURFACE.raised}>{` ${emptyLabel}`}</text>
        ) : (
          visibleSections.map((section, sectionIndex) => (
            <box key={sectionIndex} style={{ flexDirection: "column", flexShrink: 0 }}>
              {section.header === undefined ? null : (
                <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: sectionIndex === 0 ? 0 : 1 }}>
                  <text fg={section.headerColor ?? COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{`${section.header} `}</text>
                  <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"─".repeat(Math.max(0, inner - section.header.length - 2))}</text>
                </box>
              )}
              {section.rows.map((row) => {
                const active = visible[safe]?.key === row.key;
                const disabled = row.disabled === true;
                const rowBg = active && !disabled ? PICK_BG : SURFACE.raised;
                const labelFg = disabled ? COLOR.faint : active ? PICK_FG : row.selected === true ? COLOR.accent : COLOR.text;
                // The label is the actionable part — it never gets crowded
                // out by a long meta description. Whatever width survives
                // goes to the meta; the highlighted row's meta auto-scrolls
                // through the rest instead of sitting truncated or
                // overflowing the row.
                const labelText = truncate(`${row.selected === true ? "● " : "  "}${row.label}`, rowWidth);
                const badgeText = row.badge === undefined ? "" : `${row.badge}${row.meta === undefined || row.meta.length === 0 ? "" : "  "}`;
                const metaBudget = rowWidth - labelText.length - 1 - badgeText.length;
                const metaText =
                  row.meta === undefined || row.meta.length === 0 || metaBudget < 6
                    ? null
                    : active
                      ? marqueeWindow(row.meta, metaBudget, marqueeTick)
                      : truncate(row.meta, metaBudget);
                return (
                  <box
                    key={row.key}
                    style={{ width: rowWidth, flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}
                    backgroundColor={rowBg}
                    {...(disabled ? {} : { onMouseDown: row.onPick })}
                    onMouseOver={() => setIndex(visible.findIndex((entry) => entry.key === row.key))}
                  >
                    <text fg={labelFg} bg={rowBg} selectable={false}>
                      {labelText}
                    </text>
                    <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={rowBg}>
                      {badgeText === "" ? null : <text fg={active && !disabled ? PICK_FG : COLOR.accent} bg={rowBg} selectable={false}>{` ${badgeText}`}</text>}
                      {metaText === null ? null : <text fg={active && !disabled ? PICK_FG : COLOR.faint} bg={rowBg} selectable={false}>{badgeText === "" ? ` ${metaText}` : metaText}</text>}
                    </box>
                  </box>
                );
              })}
            </box>
          ))
        )}
      </scrollbox>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }}>
        <text fg={COLOR.faint} bg={SURFACE.raised}>{truncate(hint, inner)}</text>
      </box>
    </ModalShell>
  );
}

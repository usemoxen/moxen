import { t } from "../i18n/index.js";
import { useRef } from "react";
import type { BoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";

import { COLOR, SURFACE } from "../theme.js";
import { nearestStop, sliderLayout, stopTones } from "../model/slider.js";
import { useHover } from "../hooks/useHover.js";

/**
 * Moxen's horizontal picker: a few labelled stops along a track. The track
 * is filled up to the highlighted stop (heavy line, in that stop's colour)
 * and thin beyond it, with a peg at every stop and a diamond on the
 * highlighted one. Labels sit below, the highlighted one bold in its
 * colour; end captions above say which way is more of what; one line under
 * says what the highlighted stop means. Left and right move it, and so does
 * a click. It does not pick: the caller applies the highlighted stop.
 *
 * Every stop has its own colour: `tones` when the caller means something by
 * them (reasoning levels run cool to hot), else an even ramp along the track.
 */
export function Slider({
  stops,
  active,
  width,
  ends,
  chosen,
  caption,
  tones,
  idPrefix,
  onMove,
  onPick,
}: {
  stops: readonly string[];
  /** The highlighted stop. */
  active: number;
  /** The stop in force, or -1 when none is (the default applies). */
  chosen: number;
  width: number;
  ends?: { readonly low: string; readonly high: string };
  caption?: string | undefined;
  tones?: readonly string[];
  idPrefix: string;
  onMove: (index: number) => void;
  onPick: (index: number) => void;
}) {
  const trackRef = useRef<BoxRenderable | null>(null);
  const layout = sliderLayout(stops, width);
  const marker = layout.markers[active] ?? 0;
  const colours = tones ?? stopTones(stops.length);
  const tone = colours[active] ?? COLOR.accent;
  const pegs = new Set(layout.markers);
  const filled = Array.from({ length: marker }, (_, at) => (pegs.has(at) ? "╋" : "━")).join("");
  const rest = Array.from({ length: Math.max(0, width - marker - 1) }, (_, at) => (pegs.has(marker + 1 + at) ? "┼" : "─")).join("");
  return (
    <box style={{ flexDirection: "column", width, flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
      {ends === undefined ? null : (
        <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", width }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{ends.low}</text>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{ends.high}</text>
        </box>
      )}
      <box
        ref={trackRef}
        style={{ flexDirection: "row", height: 1, width, flexShrink: 0, marginTop: ends === undefined ? 0 : 1 }}
        backgroundColor={SURFACE.raised}
        onMouseDown={(event: { x: number }) => onMove(nearestStop(layout, event.x - (trackRef.current?.x ?? 0)))}
        selectable={false}
      >
        <text fg={tone} bg={SURFACE.raised} selectable={false}>{filled}</text>
        <text fg={tone} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{"◆"}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{rest}</text>
      </box>
      <box style={{ height: 1, width, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        {stops.map((label, at) => (
          <Stop
            key={`${label}:${at}`}
            id={`${idPrefix}-${at}`}
            label={label}
            left={layout.starts[at] ?? 0}
            tone={colours[at] ?? COLOR.accent}
            highlighted={at === active}
            chosen={at === chosen}
            onPick={() => onPick(at)}
          />
        ))}
      </box>
      <box style={{ minHeight: 1, width, justifyContent: "center", flexDirection: "row", marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{caption === undefined || caption === "" ? " " : caption}</text>
      </box>
    </box>
  );
}

function Stop({ id, label, left, tone, highlighted, chosen, onPick }: { id: string; label: string; left: number; tone: string; highlighted: boolean; chosen: boolean; onPick: () => void }) {
  const { hovered, handlers } = useHover();
  // The stop in hand and the one in force wear their colour; the rest stay quiet until hovered.
  const color = highlighted || chosen ? tone : hovered ? COLOR.text : COLOR.dim;
  return (
    <box id={id} style={{ position: "absolute", left, top: 0, height: 1, width: label.length }} backgroundColor={SURFACE.raised} onMouseDown={onPick} selectable={false} {...handlers}>
      <text fg={color} bg={SURFACE.raised} {...(highlighted ? { attributes: TextAttributes.BOLD } : {})} selectable={false}>{label}</text>
    </box>
  );
}

/**
 * The line under a slider that is about the setting having no value of its
 * own: when it has none it says what applies instead; when it has one, it is
 * the way back.
 */
export function SliderDefault({ id, unset, defaultLabel, onReset }: { id: string; unset: boolean; defaultLabel: string | undefined; onReset: () => void }) {
  const { hovered, handlers } = useHover();
  if (unset) {
    return (
      <box style={{ flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
          {defaultLabel === undefined ? t("ui.nothing_chosen_here_the_b6c8") : t("ui.nothingChosenDefault", { default: defaultLabel })}
        </text>
      </box>
    );
  }
  const bg = hovered ? SURFACE.hover : SURFACE.raised;
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={bg} onMouseDown={onReset} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{t("ui.clear_this_choice_1d45")}</text>
      <text fg={COLOR.dim} bg={bg} selectable={false}>{defaultLabel === undefined ? "  d" : t("ui.backToDefault", { default: defaultLabel })}</text>
    </box>
  );
}

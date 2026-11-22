/**
 * The layout of a horizontal slider: a few stops along a track, the first
 * flush left and the last flush right, the rest spread by position, with a
 * marker over the middle of the chosen stop. Pure, so what fits and where
 * the marker lands is tested without a terminal.
 */
export interface SliderLayout {
  /** Column each label starts at. */
  readonly starts: readonly number[];
  /** Column the marker sits at for each stop (the middle of its label). */
  readonly markers: readonly number[];
  /** Every label has at least one blank column to its neighbour; when false the caller falls back to a list. */
  readonly fits: boolean;
}

export function sliderLayout(labels: readonly string[], width: number): SliderLayout {
  const count = labels.length;
  const starts: number[] = labels.map((label, at) => (count <= 1 ? 0 : Math.round((at / (count - 1)) * Math.max(0, width - label.length))));
  // Where proportional spacing would crowd two labels, push them apart (right, then back from the right edge) so a tight pane still gets a slider.
  for (let at = 1; at < count; at += 1) starts[at] = Math.max(starts[at]!, starts[at - 1]! + labels[at - 1]!.length + 1);
  if (count > 0) starts[count - 1] = Math.min(starts[count - 1]!, Math.max(0, width - labels[count - 1]!.length));
  for (let at = count - 2; at >= 0; at -= 1) starts[at] = Math.min(starts[at]!, starts[at + 1]! - labels[at]!.length - 1);
  const markers = starts.map((start, at) => start + Math.floor(labels[at]!.length / 2));
  let fits = count >= 1 && labels.every((label) => label.length <= width) && (count === 0 || starts[0]! >= 0);
  for (let at = 1; fits && at < count; at += 1) {
    if (starts[at]! < starts[at - 1]! + labels[at - 1]!.length + 1) fits = false;
  }
  return { starts, markers, fits };
}

/** The stop nearest a click on column `x` of the track. */
export function nearestStop(layout: SliderLayout, x: number): number {
  let best = 0;
  for (let at = 1; at < layout.markers.length; at += 1) {
    if (Math.abs(layout.markers[at]! - x) < Math.abs(layout.markers[best]! - x)) best = at;
  }
  return best;
}

/**
 * A colour per reasoning level, cool to hot with how hard the model thinks:
 * the names the providers use have their own, anything else is spread along
 * the same ramp by position. Hex values in the page's own palette family.
 */
const EFFORT_RAMP = ["#7dd3fc", "#86efac", "#fde047", "#fb923c", "#f87171", "#e879f9"] as const;
const EFFORT_NAMED: Readonly<Record<string, number>> = { minimal: 0, low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 };

export function effortTones(ids: readonly string[]): string[] {
  return ids.map((id, at) => {
    const named = EFFORT_NAMED[id.toLowerCase()];
    if (named !== undefined) return EFFORT_RAMP[named]!;
    const fraction = ids.length <= 1 ? 0 : at / (ids.length - 1);
    return EFFORT_RAMP[Math.round(fraction * (EFFORT_RAMP.length - 1))]!;
  });
}

/** The ramp for sliders with no meaning along the track: sky to violet to pink, so no end reads as "good" or "bad". */
const GENERIC_RAMP = ["#7dd3fc", "#a5b4fc", "#c4b5fd", "#f0abfc"] as const;

function mix(from: string, to: string, at: number): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2].map((index) => Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * at).toString(16).padStart(2, "0")).join("")}`;
}

/** One colour per stop, evenly along the generic ramp. */
export function stopTones(count: number): string[] {
  return Array.from({ length: count }, (_, at) => {
    if (count <= 1) return GENERIC_RAMP[0];
    const position = (at / (count - 1)) * (GENERIC_RAMP.length - 1);
    const lower = Math.floor(position);
    return mix(GENERIC_RAMP[lower]!, GENERIC_RAMP[Math.min(lower + 1, GENERIC_RAMP.length - 1)]!, position - lower);
  });
}

/**
 * The stats card in the current theme's colours: the TUI sends these with the
 * request, and the server draws the card in them, so what is pasted looks like
 * the screen it came from.
 */
import type { QueryOf } from "../../server/api.js";
import { COLOR, SURFACE, lerpColor } from "../theme.js";

type CardPalette = NonNullable<QueryOf<"usage.card">["palette"]>;

export function cardPalette(): CardPalette {
  // The heatmap ramps from the quietest text colour to the accent, as the screen does.
  const level = (step: number): string => lerpColor(COLOR.faint, COLOR.accent, step / 4);
  return {
    background: SURFACE.base,
    text: COLOR.bright,
    dim: COLOR.dim,
    empty: COLOR.faint,
    muted: lerpColor(COLOR.faint, COLOR.dim, 0.5),
    levels: [level(1), level(2), level(3), level(4)],
  };
}

import { fieldDrifters } from "../backdrop.js";
import { COLOR, SURFACE } from "../../theme.js";
import { lightFor, putGlyph, type SceneEngine } from "./raster.js";

/**
 * The monitoring field as a scene engine, for the new-thread view when the
 * model has no scene of its own. It paints what `MonitoringBackdrop` did
 * there — same lattice, same shared drifter swarm, same colours at the
 * same 0.55 opacity — so the field still meets the sidebar's without a
 * seam. It exists so a model switch can ease between grid and scene
 * inside one renderable: OpenTUI's alpha blend keeps the cell beneath
 * only under a *space*, so fading a half-block layer over the old
 * component would drop grid dots cell by cell instead of dissolving them.
 */

const GRID_X = 8;
const GRID_Y = 4;
const FIELD_DRIFTERS = 14;
const TICK_MS = 150;
const OPACITY = 0.55;

function hex(value: string): [number, number, number] {
  const clean = value.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(clean.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** `fg` laid over `base` at `OPACITY`, as a hex colour. */
function faded(fg: string, base: string): string {
  const f = hex(fg);
  const b = hex(base);
  return `#${[0, 1, 2]
    .map((k) => Math.round((b[k]! + (f[k]! - b[k]!) * OPACITY) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function createGridScene(base: string = SURFACE.base): SceneEngine {
  const baseRgb = hex(base);
  const lattice = lightFor(faded(SURFACE.border, base), baseRgb);
  const drifter = lightFor(faded(COLOR.faint, base), baseRgb);
  return {
    frameMs: TICK_MS,
    paint(frame, win, t) {
      for (let y = win.y; y < win.y + win.height; y++) {
        if (y % GRID_Y !== 0) continue;
        for (let x = win.x; x < win.x + win.width; x++) {
          if (x % GRID_X === 0) putGlyph(frame, win, x, y, "·", lattice[0], lattice[1], lattice[2]);
        }
      }
      // `t` is wall-clock seconds, so the frame index matches the
      // sidebar's own `useAnimTick` clock and the swarm stays one swarm.
      const tick = Math.floor((t * 1000) / TICK_MS);
      for (const dot of fieldDrifters(win.fieldWidth, win.fieldHeight, tick, FIELD_DRIFTERS, 0)) {
        putGlyph(frame, win, dot.x, dot.y, dot.glyph, drifter[0], drifter[1], drifter[2]);
      }
    },
  };
}

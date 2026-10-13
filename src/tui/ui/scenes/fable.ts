import { createPlateScene, type Layout, type RGB, type Species } from "./lepidoptera.js";
import { hash2 } from "./raster.js";
import type { SceneEngine } from "./raster.js";

/**
 * Fable 5.1 — the flagship, with its safeguards on: the specimen plate
 * lit for display. Hand-coloured butterflies and a hawk moth fly free
 * over a dark specimen drawer, then settle into the 5 heads up, wings
 * open as if pinned, small plate numbers fading in beside them as on an
 * engraving. Under the pointer the moths come to it as to a lamp; the
 * butterflies startle away. (Mythos is the same plate, unpinned.)
 */

const DARK: RGB = [0.15, 0.13, 0.11];

const SPECIES: readonly Species[] = [
  {
    // Graphium: black with a chain of teal-green panes.
    size: 11,
    moth: false,
    tail: 0.3,
    paint: (u, v, fore) => {
      if (Math.abs(v - (0.55 * u - 0.35)) < 0.16 && Math.sin(u * 14) > -0.3) return [0.3, 0.82, 0.68];
      return fore ? DARK : [0.17, 0.18, 0.15];
    },
  },
  {
    // Red-banded: dusky brown crossed by a scarlet bar.
    size: 9,
    moth: false,
    paint: (u, v, fore) => (fore && Math.abs(v + 0.15 - 0.3 * u) < 0.14 ? [0.9, 0.2, 0.12] : [0.3, 0.17, 0.12]),
  },
  {
    // Sulphur: yellow, the forewing tips dipped in orange.
    size: 7,
    moth: false,
    paint: (u, v, fore) => (fore && u > 0.7 && v < -0.05 ? [0.98, 0.52, 0.14] : [0.96, 0.84, 0.3]),
  },
  {
    // A small blue, edged dark.
    size: 5.5,
    moth: false,
    paint: (u) => (u > 0.85 ? [0.2, 0.22, 0.32] : [0.45, 0.62, 0.96]),
  },
  {
    // Checkered swallowtail: black, cream spots in rows.
    size: 11,
    moth: false,
    tail: 0.3,
    paint: (u, v) => (Math.sin(u * 7) * Math.sin(v * 7 + 1) > 0.3 ? [0.95, 0.87, 0.58] : [0.15, 0.13, 0.1]),
  },
  {
    // Glasswing: pale peach, a red eyespot low on the hindwing.
    size: 9,
    moth: false,
    paint: (u, v, fore) => (!fore && Math.hypot(u - 0.45, v - 0.5) < 0.2 ? [0.88, 0.24, 0.2] : [0.9, 0.76, 0.68]),
  },
  {
    // Hawk moth: narrow olive forewings, a flush of pink beneath.
    size: 10,
    moth: true,
    narrow: true,
    paint: (u, v, fore) => (fore ? (Math.abs(v - 0.4 * u + 0.1) < 0.1 ? [0.82, 0.62, 0.66] : [0.4, 0.46, 0.24]) : [0.88, 0.42, 0.5]),
  },
];

const SEED = 0xf4b1;

/** The drawer: warm near-black with paper grain, lifting a little behind the plate. */
function drawer(x: number, y: number, _t: number, g: Layout, out: Float32Array, o: number): void {
  const grain = (hash2(x, y, SEED + 1) - 0.5) * 0.012;
  const plate = Math.exp(-Math.pow((x - (g.left + g.width / 2)) / (g.width * 0.9), 2) - Math.pow((y - (g.top + g.height / 2)) / (g.height * 0.7), 2)) * 0.05;
  out[o] = 0.03 + plate * 0.95 + grain;
  out[o + 1] = 0.025 + plate * 0.85 + grain;
  out[o + 2] = 0.018 + plate * 0.65 + grain;
}

export function createFableScene(): SceneEngine {
  return createPlateScene({
    seed: SEED,
    species: SPECIES,
    count: 26,
    ground: drawer,
    glow: 0,
    lamp: "moths",
    lampLight: null,
    numbers: true,
    threads: false,
    restless: 0,
    fan: [0.8, 0.2],
  });
}

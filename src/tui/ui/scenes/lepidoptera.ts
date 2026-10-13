import { hash2, noise, putGlyph, smoothstep, splat, type Frame, type Pointer, type SceneEngine, type SceneWindow } from "./raster.js";

/**
 * The specimen plate shared by Fable 5.1 and Mythos 5.1 — one engine, as
 * they are one model. After the launch key art: a great "5" made of
 * naturalist plates of butterflies and moths.
 *
 * Specimens fly free, each beating its wings and turning along its
 * heading; then they gather and settle into the 5, hold it, and burst
 * apart again. A `Plate` decides the rest: which species, what lies
 * behind them, whether they glow, how still the formation is, and who
 * comes to the pointer's light.
 *
 * Every specimen's flight, formation slot and wingbeat is a pure function
 * of (t, pointer), so the swarm needs no simulation state.
 */

export type RGB = readonly [number, number, number];

export interface Species {
  /** Half-wingspan in pixels, at a 50-row terminal. */
  size: number;
  /** Comes to the lamp, and beats faster. */
  moth: boolean;
  /** Narrow, swept forewings (hawk moths). */
  narrow?: boolean;
  /** Hindwing tail length in half-spans (swallowtails, luna moths). */
  tail?: number;
  /** Colour of its halo and scale-dust, on a glowing plate. */
  glow?: RGB;
  /** Colour at a body point (v along it, in half-spans) — the death's-head's skull. */
  body?: (v: number) => RGB;
  /** Colour at a wing point (u across from the body, v along it, both in half-spans; v < 0 is forward). */
  paint(u: number, v: number, fore: boolean): RGB;
}

export interface Plate {
  seed: number;
  species: readonly Species[];
  count: number;
  /** Light behind everything, at field pixel (x, y). */
  ground(x: number, y: number, t: number, plate: Layout, out: Float32Array, o: number): void;
  /** Halo and scale-dust trail strength; 0 for a plate lit only from outside. */
  glow: number;
  /** Who comes to the pointer: only the moths (the rest startle away), or everything. */
  lamp: "moths" | "all";
  /** The pointer's own light, if it gives off any. */
  lampLight: RGB | null;
  /** Engraved plate numbers beside settled specimens. */
  numbers: boolean;
  /** Faint luminous threads between neighbours while the 5 holds. */
  threads: boolean;
  /** How far settled specimens hover, in pixels: 0 is pinned still. */
  restless: number;
  /** How settled wings fan: [minimum openness, swing]. */
  fan: readonly [number, number];
}

const LOOP = 36;

/** The 5, as points along its strokes in a unit box (x right, y down): top bar, stem, bowl. */
function fivePath(): [number, number][] {
  const points: [number, number][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number, n: number) => {
    for (let i = 0; i < n; i++) points.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  line(0.92, 0.03, 0.24, 0.03, 9);
  line(0.24, 0.03, 0.17, 0.44, 6);
  // The bowl: an arc swinging out to the right and back under.
  for (let i = 0; i <= 26; i++) {
    const a = -2.4 + (i / 26) * 4.55;
    points.push([0.5 + Math.cos(a) * 0.4, 0.66 + Math.sin(a) * 0.32]);
  }
  return points;
}

export interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The 5 stands at the right, clear of the sidebar and most of the composer. */
function layout(fw: number, fh: number): Layout {
  const height = fh * 0.84;
  const width = height * 0.7;
  return { left: fw - width - 12, top: fh * 0.1, width, height };
}

const spread = (n: number): number => Math.min(1, Math.max(0, (n - 0.5) * 2.2 + 0.5));

interface Flight {
  x: number;
  y: number;
  heading: number;
  open: number;
  hold: number;
}

/** Where specimen i is, which way it faces, and how open its wings are at t. */
function flight(plate: Plate, i: number, t: number, slots: [number, number][], g: Layout, fw: number, fh: number, pointer: Pointer | null): Flight {
  const species = plate.species[i % plate.species.length]!;
  const seed = plate.seed;
  const wander = (at: number): [number, number] => [
    // Noise crowds the middle; stretch it so flight fills the view.
    fw * (0.3 + 0.66 * spread(noise(i * 13.1 + at * 0.045 + seed, 1.7 + i))),
    fh * (0.06 + 0.86 * spread(noise(7.3 + i * 5.7, at * 0.04 + i * 3 + seed))),
  ];
  const [fx, fy] = wander(t);
  const [nx, ny] = wander(t + 0.15);
  // Gather, hold, burst — each specimen a little out of step with the rest.
  const s = (((t + hash2(i, 9, seed) * 1.5) % LOOP) + LOOP) % LOOP;
  const hold = smoothstep(12, 18, s) * (1 - smoothstep(28, 30.5, s));
  const slot = slots[Math.floor((i * slots.length) / plate.count)]!;
  const sx = g.left + slot[0] * g.width + Math.sin(t * 1.3 + i) * plate.restless;
  const sy = g.top + slot[1] * g.height + Math.cos(t * 1.7 + i * 2) * plate.restless * 0.6;
  let x = fx + (sx - fx) * hold;
  let y = fy + (sy - fy) * hold;
  const beat = Math.sin(t * (species.moth ? 22 : 15) + i * 2.1);
  // In flight it bobs with its stroke; settled, it fans slowly, head up.
  y += beat * 0.6 * (1 - hold);
  let heading = (Math.atan2(ny - fy, nx - fx) + Math.PI / 2) * (1 - hold) + Math.sin(t * 0.8 + i) * 0.08 * plate.restless * hold;
  const fan = plate.fan[0] + plate.fan[1] * Math.abs(Math.sin(t * 0.9 + i));
  let open = Math.abs(beat) * (1 - hold) + fan * hold;
  if (pointer && pointer.strength > 0.05) {
    const dx = x - pointer.x;
    const dy = y - pointer.y;
    const d = Math.hypot(dx, dy) || 1;
    if (species.moth || plate.lamp === "all") {
      // To the lamp: a wobbling orbit.
      const a = t * (2.2 + hash2(i, 4, seed)) + i;
      // With everything coming to the light, the orbits spread out into a swarm.
      const r = plate.lamp === "all" ? 7 + hash2(i, 5, seed) * 22 : 5 + hash2(i, 5, seed) * 6;
      const pull = pointer.strength * 0.9;
      x += (pointer.x + Math.cos(a) * r * 1.6 - x) * pull;
      y += (pointer.y + Math.sin(a) * r - y) * pull;
      heading += (a + Math.PI - heading) * pull;
      open = Math.abs(beat);
    } else if (d < 16) {
      // Butterflies startle away.
      const push = (16 - d) * pointer.strength;
      x += (dx / d) * push;
      y += (dy / d) * push;
      open = Math.max(open, Math.abs(beat));
    }
  }
  return { x, y, heading, open: Math.max(0.12, open), hold };
}

const BODY: RGB = [0.1, 0.08, 0.07];

/** One specimen, drawn top-down: forewings and hindwings, mirrored, opening and closing. */
function drawSpecimen(frame: Frame, win: SceneWindow, species: Species, scale: number, f: Flight, brightness: number): void {
  const r = species.size * scale;
  const cos = Math.cos(f.heading);
  const sin = Math.sin(f.heading);
  const reach = Math.ceil(r * (1.3 + (species.tail ?? 0))) + 1;
  const x0 = Math.max(0, Math.floor(f.x - reach - win.x));
  const x1 = Math.min(win.width - 1, Math.ceil(f.x + reach - win.x));
  const y0 = Math.max(0, Math.floor(f.y - reach - win.y * 2));
  const y1 = Math.min(win.height * 2 - 1, Math.ceil(f.y + reach - win.y * 2));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = win.x + px + 0.5 - f.x;
      const dy = win.y * 2 + py + 0.5 - f.y;
      // Into the specimen's own frame: u across the wings, v along the body.
      const u = (dx * cos + dy * sin) / r;
      const v = (-dx * sin + dy * cos) / r;
      const au = Math.abs(u);
      let c: RGB | null = null;
      if (au < 0.1 && v > -0.55 && v < 0.6) {
        c = species.body ? species.body(v) : BODY;
      } else {
        // Wings foreshorten as they close: a closed wing is a sliver.
        const w = au / f.open;
        // Forewing: sweeps forward and out to a point at the apex.
        const fu = (w - 0.52) / 0.5;
        const fv = (v + 0.22 + (w - 0.3) * 0.38) / (species.narrow ? 0.2 : 0.3 + 0.08 * (1 - w));
        const fore = fu * fu + fv * fv <= 1;
        // Hindwing: rounder and lower, trailing a tail where the species has one.
        const hu = (w - 0.34) / 0.36;
        const hv = (v - 0.3) / 0.32;
        const tail = species.tail !== undefined && Math.abs(w - 0.32) < 0.07 && v > 0.55 && v < 0.55 + species.tail;
        const hind = hu * hu + hv * hv <= 1 || tail;
        if (fore || hind) {
          const base = species.paint(w, v, fore);
          // A pale rim, so dark wings still read against a dark ground.
          const edge = fore ? fu * fu + fv * fv > 0.72 : hu * hu + hv * hv > 0.68;
          c = edge ? [base[0] * 0.7 + 0.12, base[1] * 0.7 + 0.11, base[2] * 0.7 + 0.09] : base;
        }
      }
      if (c === null) continue;
      const o = (py * win.width + px) * 3;
      // Specimens are opaque: they cover what is behind rather than add to it.
      frame.light[o] = c[0] * brightness;
      frame.light[o + 1] = c[1] * brightness;
      frame.light[o + 2] = c[2] * brightness;
    }
  }
}

export function createPlateScene(plate: Plate): SceneEngine {
  const slots = fivePath();
  // Small specimens first, so the large ones overlap them.
  const order = Array.from({ length: plate.count }, (_, i) => i).sort(
    (a, b) => plate.species[a % plate.species.length]!.size - plate.species[b % plate.species.length]!.size,
  );
  return {
    frameMs: 50,
    paint(frame, win, t, pointer) {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const g = layout(fw, fh);

      for (let py = 0; py < win.height * 2; py++) {
        for (let px = 0; px < win.width; px++) plate.ground(win.x + px, win.y * 2 + py, t, g, frame.light, (py * win.width + px) * 3);
      }

      const flights = Array.from({ length: plate.count }, (_, i) => flight(plate, i, t, slots, g, fw, fh, pointer));
      const size = Math.max(0.7, Math.min(1.4, fh / 100));

      if (plate.threads) {
        // Neighbours on the 5 (consecutive slots), joined while it holds.
        for (let i = 0; i + 1 < plate.count; i++) {
          const a = flights[i]!;
          const b = flights[i + 1]!;
          const held = Math.min(a.hold, b.hold);
          if (held < 0.6) continue;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len > fh * 0.25) continue;
          const w = 0.1 * (held - 0.6) * 2.5 * (0.7 + 0.3 * Math.sin(t * 2 + i));
          for (let s = 0; s <= len; s += 1.2) {
            const k = s / (len || 1);
            splat(frame, win, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, 0.5, 0.55 * w, 0.62 * w, 1.0 * w);
          }
        }
      }

      if (plate.lampLight && pointer && pointer.strength > 0.05) {
        const w = 0.22 * pointer.strength * (0.9 + 0.1 * Math.sin(t * 9) * Math.sin(t * 5.3));
        const c = plate.lampLight;
        splat(frame, win, pointer.x, pointer.y, 8, c[0] * w, c[1] * w, c[2] * w);
      }

      for (const i of order) {
        const species = plate.species[i % plate.species.length]!;
        const f = flights[i]!;
        // Settled on the plate they lie a little smaller, so the 5 is not a heap.
        const scale = size * (0.85 + hash2(i, 3, plate.seed) * 0.35) * (1 - 0.2 * f.hold);
        if (plate.glow > 0 && species.glow) {
          const c = species.glow;
          // Scale-dust: where it was a moment ago, fading.
          for (let k = 1; k <= 7; k++) {
            const past = flight(plate, i, t - k * 0.09, slots, g, fw, fh, pointer);
            const w = plate.glow * 0.3 * (1 - k / 8) * (1 - past.hold * 0.7);
            splat(frame, win, past.x, past.y, 0.6, c[0] * w, c[1] * w, c[2] * w);
          }
          const halo = plate.glow * 0.22 * (0.85 + 0.15 * Math.sin(t * 1.7 + i));
          splat(frame, win, f.x, f.y, species.size * scale * 0.9, c[0] * halo, c[1] * halo, c[2] * halo);
        }
        drawSpecimen(frame, win, species, scale, f, 0.95);
        // Plate numbers, as on the engraving — once a specimen has settled.
        if (plate.numbers && f.hold > 0.9 && i % 3 === 0) {
          const w = 0.35 * (f.hold - 0.9) * 10;
          putGlyph(frame, win, f.x + species.size * size + 2, (f.y + species.size * size) / 2, String(1 + (i % 9)), 0.7 * w, 0.62 * w, 0.5 * w);
        }
      }
    },
  };
}

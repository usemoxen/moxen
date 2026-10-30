import { addPixel, hash2, noise, smoothstep, splat, type Frame, type Pointer, type SceneEngine, type SceneWindow } from "./raster.js";

/**
 * Astra — "per aspera ad astra", through hardships to the stars. Opus
 * already owns looking at the stars; Astra is going to them, so it is
 * the one scene that travels. A voyage on a loop:
 *
 * - cruise: a true 3D starfield drifting toward you, a destination star
 *   ahead slowly growing;
 * - spool-up: the stars begin to stretch, the destination brightens;
 * - the jump: streaks of light blue-shifted at their heads, radiating
 *   from the vanishing point, inside a faint turning hyperspace tunnel;
 * - drop-out: a soft blue flash, the streaks snap back to points, and you
 *   have arrived somewhere new — a blue-white star, a sun, a red giant, a
 *   binary pair, or a pulsar sweeping its beams.
 *
 * Stars carry a horizontal anamorphic flare rather than Opus's warm
 * diffraction spikes, and the palette runs cool. The pointer steers: the
 * vanishing point leans toward it, and the flight banks with it.
 *
 * Distance travelled is a pure function of t — the speed profile is
 * integrated once into a table — so every star's place is too.
 */

type RGB = readonly [number, number, number];

/** Seconds in one voyage: cruise, spool-up, jump, drop-out. */
export const LOOP = 36;
const STARS = 280;
const SEED = 0xa57a;
const STREAK_S = 0.06;

/** Speed (depth units per second) at loop time s: drop-out, cruise, spool, jump. */
function speed(s: number): number {
  const ease = (v: number) => v * v * (3 - 2 * v);
  if (s < 2) return 3 + (0.05 - 3) * ease(s / 2);
  if (s < 24) return 0.05;
  if (s < 29) return 0.05 + 2.95 * Math.pow(ease((s - 24) / 5), 2);
  return 3;
}

const TABLE_STEP = 0.02;
let table: Float64Array | null = null;

/** Cumulative distance through one loop, integrated once. */
function distanceTable(): Float64Array {
  if (table) return table;
  const n = Math.ceil(LOOP / TABLE_STEP) + 1;
  table = new Float64Array(n);
  for (let i = 1; i < n; i++) table[i] = table[i - 1]! + speed((i - 0.5) * TABLE_STEP) * TABLE_STEP;
  return table;
}

/** Total depth travelled by time t. */
function distance(t: number): number {
  const d = distanceTable();
  const loops = Math.floor(t / LOOP);
  const s = t - loops * LOOP;
  const k = s / TABLE_STEP;
  const i = Math.min(d.length - 2, Math.floor(k));
  const local = d[i]! + (d[i + 1]! - d[i]!) * (k - i);
  return loops * d[d.length - 1]! + local;
}

interface Destination {
  colour: RGB;
  size: number;
  kind: "star" | "binary" | "pulsar";
  dx: number;
  dy: number;
}

const KINDS: readonly Omit<Destination, "dx" | "dy">[] = [
  { colour: [0.66, 0.8, 1.0], size: 1.1, kind: "star" },
  { colour: [1.0, 0.88, 0.62], size: 0.95, kind: "star" },
  { colour: [1.0, 0.46, 0.28], size: 1.7, kind: "star" },
  { colour: [0.7, 0.82, 1.0], size: 0.8, kind: "binary" },
  { colour: [0.6, 0.78, 1.0], size: 0.6, kind: "pulsar" },
];

/** Which of `KINDS` a voyage ends at: 0 blue-white star, 1 sun, 2 red giant, 3 binary, 4 pulsar. */
export function destinationIndex(voyage: number): number {
  return Math.floor(hash2(voyage, 1, SEED) * KINDS.length);
}

function destination(voyage: number): Destination {
  const kind = KINDS[destinationIndex(voyage)]!;
  return { ...kind, dx: (hash2(voyage, 2, SEED) - 0.5) * 0.3, dy: (hash2(voyage, 3, SEED) - 0.5) * 0.25 };
}

/** Additive anti-aliased point: weight shared over the four nearest pixels. */
function dot(frame: Frame, win: SceneWindow, x: number, y: number, r: number, g: number, b: number): void {
  const fx = x - win.x - 0.5;
  const fy = y - win.y * 2 - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  for (let k = 0; k < 4; k++) {
    const w = weights[k]!;
    if (w > 0.01) addPixel(frame, ix + (k & 1), iy + (k >> 1), r * w, g * w, b * w);
  }
}

/** A star's flare: a soft core, a halo, and a thin horizontal anamorphic streak. */
function flare(frame: Frame, win: SceneWindow, x: number, y: number, c: RGB, size: number, power: number): void {
  splat(frame, win, x, y, size * 3.5, c[0] * 0.08 * power, c[1] * 0.08 * power, c[2] * 0.08 * power);
  splat(frame, win, x, y, size * 0.9, 1.0 * power, 0.98 * power, 0.95 * power);
  splat(frame, win, x, y, size * 1.8, c[0] * 0.85 * power, c[1] * 0.85 * power, c[2] * 0.85 * power);
  const reach = size * 26;
  for (let s = 1; s < reach; s += 0.8) {
    const w = 0.4 * power * Math.exp(-s / (reach * 0.3));
    dot(frame, win, x + s, y, 0.55 * w, 0.72 * w, w);
    dot(frame, win, x - s, y, 0.55 * w, 0.72 * w, w);
  }
}

export function createAstraScene(): SceneEngine {
  return {
    frameMs: 50,
    paint(frame, win, t, pointer) {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const s = ((t % LOOP) + LOOP) % LOOP;
      const voyage = Math.floor(t / LOOP);
      const v = speed(s);
      const jump = smoothstep(0.4, 2.5, v);
      // The vanishing point: over the new-thread pane, above the composer, leaning toward the pointer.
      let vx = fw * 0.62;
      let vy = fh * 0.32;
      if (pointer && pointer.strength > 0.05) {
        vx += (pointer.x - vx) * 0.3 * pointer.strength;
        vy += (pointer.y - vy) * 0.3 * pointer.strength;
      }
      const focal = fw * 0.42;

      const travelled = distance(t);
      // Deep space, with the hyperspace tunnel turning in it during the jump.
      for (let py = 0; py < win.height * 2; py++) {
        const y = win.y * 2 + py + 0.5;
        for (let px = 0; px < win.width; px++) {
          const x = win.x + px + 0.5;
          const o = (py * win.width + px) * 3;
          let r = 0.008;
          let g = 0.012;
          let b = 0.03 + 0.02 * smoothstep(0, fh, y);
          if (jump > 0.02) {
            const dx = x - vx;
            const dy = y - vy;
            const radius = Math.hypot(dx, dy) + 1;
            const angle = Math.atan2(dy, dx);
            // One turn of angle is exactly one period of the noise torus (256),
            // so the tunnel has no seam where atan2 wraps.
            const wall = noise((angle / (Math.PI * 2)) * 256 + t * 6, 400 / radius - travelled * 0.8);
            const band = smoothstep(0.55, 0.9, wall) * smoothstep(4, 30, radius) * jump * 0.14;
            r += band * 0.45;
            g += band * 0.55;
            b += band * 1.0;
          }
          frame.light[o] = r;
          frame.light[o + 1] = g;
          frame.light[o + 2] = b;
        }
      }

      // The destination ahead, growing as you cruise toward it, fading as you pass into the jump.
      const dest = destination(voyage);
      const approach = smoothstep(2, 24, s);
      const presence = smoothstep(0.2, 2.5, s) * (1 - smoothstep(26, 30, s));
      if (presence > 0.01) {
        const dxp = vx + dest.dx * fw * (1 - 0.5 * approach);
        const dyp = vy + dest.dy * fh * (1 - 0.5 * approach);
        const size = dest.size * (0.7 + 1.6 * approach) * (fh / 100) * (1 + smoothstep(24, 28, s));
        if (dest.kind === "binary") {
          const a = t * 0.8;
          const sep = size * 4;
          flare(frame, win, dxp + Math.cos(a) * sep, dyp + Math.sin(a) * sep * 0.4, dest.colour, size, presence);
          flare(frame, win, dxp - Math.cos(a) * sep, dyp - Math.sin(a) * sep * 0.4, [1.0, 0.7, 0.42], size * 0.8, presence);
        } else if (dest.kind === "pulsar") {
          const pulse = 0.6 + 0.4 * Math.pow(Math.abs(Math.sin(t * 6)), 8);
          flare(frame, win, dxp, dyp, dest.colour, size, presence * pulse);
          // Two lighthouse beams sweeping round.
          const a = t * 1.6;
          for (let k = 0; k < 2; k++) {
            const ang = a + k * Math.PI;
            for (let d = 3; d < size * 40; d += 0.9) {
              const w = 0.16 * presence * Math.exp(-d / (size * 14));
              dot(frame, win, dxp + Math.cos(ang) * d * 1.6, dyp + Math.sin(ang) * d, 0.6 * w, 0.8 * w, w);
            }
          }
        } else {
          flare(frame, win, dxp, dyp, dest.colour, size, presence);
        }
      }

      // The starfield: each star a point in depth, streaking with speed.
      const before = distance(t - STREAK_S);
      for (let i = 0; i < STARS; i++) {
        const sx = (hash2(i, 1, SEED) * 2 - 1) * 1.6;
        const sy = (hash2(i, 2, SEED) * 2 - 1) * 1.0;
        const depth0 = hash2(i, 3, SEED);
        const z = 0.02 + ((((depth0 - travelled * 0.5) % 1) + 1) % 1) * 0.98;
        const zPrev = 0.02 + ((((depth0 - before * 0.5) % 1) + 1) % 1) * 0.98;
        const x = vx + (sx / z) * focal * 0.35;
        const y = vy + (sy / z) * focal * 0.35;
        if (x < -40 || y < -40 || x > fw + 40 || y > fh + 40) continue;
        const tint = hash2(i, 4, SEED);
        const base: RGB = tint < 0.6 ? [0.8, 0.86, 1.0] : tint < 0.85 ? [1.0, 0.95, 0.88] : [0.65, 0.75, 1.0];
        const bright = Math.min(1.4, 0.05 / z) * (0.5 + 0.5 * hash2(i, 5, SEED));
        if (zPrev > z && v > 0.2) {
          // A streak back along the line of travel: blue at the head, fading violet behind.
          const tx = vx + (sx / zPrev) * focal * 0.35;
          const ty = vy + (sy / zPrev) * focal * 0.35;
          const len = Math.hypot(x - tx, y - ty);
          const steps = Math.min(90, Math.ceil(len / 0.8));
          for (let k = 0; k <= steps; k++) {
            const f = k / (steps || 1);
            const w = bright * (1 - f) * 2;
            dot(frame, win, x + (tx - x) * f, y + (ty - y) * f, (0.6 + 0.2 * f) * w, (0.75 - 0.3 * f) * w, w);
          }
        } else {
          dot(frame, win, x, y, base[0] * bright, base[1] * bright, base[2] * bright);
        }
      }

      // Drop-out: a soft blue flash as the streaks snap back to stars.
      if (s < 0.7) {
        const w = 0.22 * (1 - s / 0.7);
        for (let o = 0; o < frame.light.length; o += 3) {
          frame.light[o]! += 0.55 * w;
          frame.light[o + 1]! += 0.7 * w;
          frame.light[o + 2]! += w;
        }
      }
    },
  };
}

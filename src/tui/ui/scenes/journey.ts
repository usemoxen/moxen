import { addPixel, hash2, smoothstep, type Frame } from "./raster.js";

/**
 * Travel between the OpenAI scenes. Astra, Sol, Terra and Luna are places
 * in one neighbourhood of space, so switching between them is not a
 * dissolve: the camera goes there, and how depends on how far it is.
 *
 * - hop (Terra ↔ Luna): neighbours — a quick swing of the camera, lifting
 *   off the lunar surface toward the Moon, or descending onto it.
 * - cruise (Sol ↔ Terra or Luna): across the inner system — the old view
 *   recedes and slides away, open space streams past with the stars in
 *   parallax, and the destination drifts in and grows to fill the frame.
 * - warp (Astra ↔ anything): interstellar, so a jump — the old scene
 *   collapses into the vanishing point as starlight streaks out of it, a
 *   soft flash, and the destination bursts outward into place.
 *
 * Every journey composites the two real scenes, panned and zoomed through
 * a stretch of space, with motion blur that follows the camera's speed. It
 * is a pure function of (from, to, p): p = 0 is exactly the old scene and
 * p = 1 exactly the new one, so a journey starts and ends on clean frames.
 */

export type JourneyKind = "hop" | "cruise" | "warp";

export interface Journey {
  kind: JourneyKind;
  /** Direction of travel on screen (x right, y down), unit length; unused by warp. */
  dx: number;
  dy: number;
  seconds: number;
}

/** Where each place sits on a notional map of the neighbourhood (screen axes). */
const PLACES: Record<string, readonly [number, number]> = {
  sol: [0, 0.15],
  terra: [1, 0.2],
  luna: [1.05, -0.05],
};

/** How the camera gets from one scene to another, or null when they share no space (a bloom instead). */
export function journeyBetween(from: string, to: string): Journey | null {
  if (from === to) return null;
  const neighbourhood = ["astra", "sol", "terra", "luna"];
  if (!neighbourhood.includes(from) || !neighbourhood.includes(to)) return null;
  if (from === "astra" || to === "astra") return { kind: "warp", dx: 0, dy: 0, seconds: 2.6 };
  const a = PLACES[from]!;
  const b = PLACES[to]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const near = (from === "terra" && to === "luna") || (from === "luna" && to === "terra");
  if (near) {
    // Luna is "above" Terra: lifting off the Moon toward it, or coming down to land.
    return { kind: "hop", dx: 0.15 * Math.sign(b[0] - a[0]), dy: to === "luna" ? -1 : 1, seconds: 1.7 };
  }
  return { kind: "cruise", dx: (b[0] - a[0]) / len, dy: (b[1] - a[1]) / len, seconds: 2.4 };
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Derivative of easeInOutCubic: the camera's speed through the journey. */
const easeSpeed = (t: number): number => (t < 0.5 ? 12 * t * t : 3 * Math.pow(-2 * t + 2, 2));

/** Bilinear sample of a frame's light; false outside it. */
function sample(frame: Frame, x: number, y: number, out: number[]): boolean {
  const w = frame.width;
  const h = frame.height * 2;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return false;
  const ix = Math.min(w - 2, Math.floor(x));
  const iy = Math.min(h - 2, Math.floor(y));
  const tx = x - ix;
  const ty = y - iy;
  for (let k = 0; k < 3; k++) {
    const a = frame.light[(iy * w + ix) * 3 + k]!;
    const b = frame.light[(iy * w + ix + 1) * 3 + k]!;
    const c = frame.light[((iy + 1) * w + ix) * 3 + k]!;
    const d = frame.light[((iy + 1) * w + ix + 1) * 3 + k]!;
    out[k] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
  return true;
}

interface Placement {
  /** Where the scene's centre sits, relative to the frame's centre, in pixels. */
  ox: number;
  oy: number;
  scale: number;
  /** Motion-blur vector in pixels (screen space). */
  bx: number;
  by: number;
  /** Radial blur toward the centre, as a fraction of distance (warp). */
  radial: number;
}

/** How far in from each border a travelling scene fades into space, as a fraction of its size. */
const FEATHER = 0.14;

const tap = [0, 0, 0];
const acc = [0, 0, 0];

/** Draw a scene, placed and blurred, over what is already in `out` (opaque where it covers). */
function place(scene: Frame, out: Frame, at: Placement): void {
  const w = out.width;
  const h = out.height * 2;
  const cx = w / 2;
  const cy = h / 2;
  const blur = Math.hypot(at.bx, at.by);
  const taps = Math.min(8, 1 + Math.ceil(blur / 1.5) + (at.radial > 0.02 ? 5 : 0));
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let n = 0;
      acc[0] = acc[1] = acc[2] = 0;
      for (let k = 0; k < taps; k++) {
        const f = taps === 1 ? 0 : k / (taps - 1) - 0.5;
        let sx = px + 0.5 + at.bx * f;
        let sy = py + 0.5 + at.by * f;
        if (at.radial > 0) {
          sx += (sx - cx) * at.radial * f;
          sy += (sy - cy) * at.radial * f;
        }
        // Into the scene's own pixels: undo the offset, then the zoom about its centre.
        const ux = (sx - cx - at.ox) / at.scale + cx - 0.5;
        const uy = (sy - cy - at.oy) / at.scale + cy - 0.5;
        if (!sample(scene, ux, uy, tap)) continue;
        // Feather the scene's own borders into space, so it travels as a
        // place, not as a picture with edges.
        const ex = Math.min(ux, scene.width - 1 - ux) / (scene.width * FEATHER);
        const ey = Math.min(uy, scene.height * 2 - 1 - uy) / (scene.height * 2 * FEATHER);
        const fade = smoothstep(0, 1, Math.min(ex, ey));
        acc[0]! += tap[0]! * fade;
        acc[1]! += tap[1]! * fade;
        acc[2]! += tap[2]! * fade;
        n += fade;
      }
      if (n <= 0) continue;
      // Partly covered (a blurred or feathered edge): mix with the space behind.
      const cover = n / taps;
      const o = (py * w + px) * 3;
      for (let c = 0; c < 3; c++) out.light[o + c] = out.light[o + c]! * (1 - cover) + (acc[c]! / n) * cover;
    }
  }
}

/** Open space between the two places: stars in parallax, streaking along the camera's motion. */
function space(out: Frame, travelX: number, travelY: number, vx: number, vy: number, seed: number): void {
  const w = out.width;
  const h = out.height * 2;
  for (let o = 0; o < out.light.length; o += 3) {
    out.light[o] = 0.004;
    out.light[o + 1] = 0.005;
    out.light[o + 2] = 0.014;
  }
  const count = Math.round((w * h) / 70);
  for (let i = 0; i < count; i++) {
    const depth = 0.3 + hash2(i, 3, seed) * 0.9;
    const x = ((((hash2(i, 1, seed) * w - travelX * depth) % w) + w) % w);
    const y = ((((hash2(i, 2, seed) * h - travelY * depth) % h) + h) % h);
    const bright = (0.12 + 0.5 * Math.pow(hash2(i, 4, seed), 3)) * depth;
    const len = Math.hypot(vx, vy) * depth;
    const steps = Math.min(40, Math.ceil(len / 0.8));
    for (let k = 0; k <= steps; k++) {
      const f = steps === 0 ? 0 : k / steps;
      const fade = bright * (1 - f * 0.85) * (steps === 0 ? 1 : 1.4 / Math.sqrt(steps + 1));
      addPixel(out, Math.floor(x + vx * depth * f), Math.floor(y + vy * depth * f), 0.8 * fade, 0.88 * fade, fade);
    }
  }
}

/**
 * Paint `out` as the camera travels from `from` to `to`, `p` (0..1) of the
 * way. Glyph layers are dropped: these scenes paint light only.
 */
export function journeyFrames(from: Frame, to: Frame, out: Frame, p: number, journey: Journey): void {
  out.glyph.fill("");
  out.glyphLight.fill(0);
  const w = out.width;
  const h = out.height * 2;
  if (p <= 0) {
    out.light.set(from.light);
    return;
  }
  if (p >= 1) {
    out.light.set(to.light);
    return;
  }

  if (journey.kind === "warp") {
    const out1 = smoothstep(0, 0.5, p);
    const in1 = smoothstep(0.5, 1, p);
    const surge = Math.sin(Math.PI * p);
    space(out, 0, 0, 0, 0, 0x3a7a);
    // Streaks of starlight out of the vanishing point.
    const cx = w / 2;
    const cy = h / 2;
    const reach = Math.hypot(cx, cy);
    for (let i = 0; i < 140; i++) {
      const a = hash2(i, 1, 0x3a7b) * Math.PI * 2;
      const r0 = (((hash2(i, 2, 0x3a7b) + p * 2.5) % 1) * reach * 1.1);
      const len = reach * 0.35 * surge;
      const bright = 0.5 * surge * (0.4 + 0.6 * hash2(i, 3, 0x3a7b));
      for (let s = 0; s < len; s += 0.8) {
        const f = s / (len || 1);
        const rr = r0 + s;
        addPixel(out, Math.floor(cx + Math.cos(a) * rr), Math.floor(cy + Math.sin(a) * rr * 0.6), 0.6 * bright * (1 - f), 0.75 * bright * (1 - f), bright * (1 - f));
      }
    }
    // Out: collapsing into the centre. In: bursting out of it.
    if (out1 < 1) {
      const scale = 1 - 0.97 * easeInOutCubic(out1);
      place(from, out, { ox: 0, oy: 0, scale, bx: 0, by: 0, radial: 0.6 * surge });
    }
    if (in1 > 0) {
      const scale = 0.03 + 0.97 * easeInOutCubic(in1);
      place(to, out, { ox: 0, oy: 0, scale, bx: 0, by: 0, radial: 0.6 * surge });
    }
    // The flash at the jump's turning point.
    const flash = 0.09 * Math.exp(-Math.pow((p - 0.5) / 0.04, 2));
    for (let o = 0; o < out.light.length; o += 3) {
      out.light[o]! += 0.6 * flash;
      out.light[o + 1]! += 0.75 * flash;
      out.light[o + 2]! += flash;
    }
    return;
  }

  // Hop and cruise: a pan from one place to the next, through a stretch of
  // space, the views receding and growing a little for depth.
  const e = easeInOutCubic(p);
  const speed = easeSpeed(p) / journey.seconds;
  const gap = journey.kind === "hop" ? 1.25 : 1.9;
  const travelX = journey.dx * w * gap;
  const travelY = journey.dy * h * gap;
  // Pixels the camera moves in one 50 ms frame: that is the blur.
  const bx = travelX * speed * 0.05;
  const by = travelY * speed * 0.05;
  space(out, travelX * e, travelY * e, bx, by, journey.kind === "hop" ? 0x5e1a : 0x5e1b);
  const depth = journey.kind === "hop" ? 0.12 : 0.35;
  place(from, out, { ox: -travelX * e, oy: -travelY * e, scale: 1 - depth * smoothstep(0, 0.6, p), bx, by, radial: 0 });
  place(to, out, { ox: travelX * (1 - e), oy: travelY * (1 - e), scale: 1 - depth * (1 - smoothstep(0.4, 1, p)), bx, by, radial: 0 });
}

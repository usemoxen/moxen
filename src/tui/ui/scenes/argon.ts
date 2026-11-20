import {
  addPixel,
  hash2,
  noise,
  putGlyph,
  smoothstep,
  splat,
  type Frame,
  type Pointer,
  type SceneEngine,
  type SceneWindow,
} from "./raster.js";

/**
 * Argon (Ar, Z=18) — serene noble-gas violet-blue plasma discharge.
 *
 * Ionized argon emits crisp blue-violet lines (415–420 nm) with soft orchid
 * undertones. A jewel-like high-voltage electrode sits in the upper-right
 * sky inside a subtle atmospheric containment halo (sized to breathe cleanly
 * inside the viewport); sinuous plasma filaments drift lazily outward and
 * flower into delicate lilac corona kisses where they fade into the dark.
 *
 * Under the pointer, the classic plasma-globe touch: electrostatic tendrils
 * bend gracefully from the electrode straight to the cursor with a luminous
 * lavender contact glow.
 */

type RGB = readonly [number, number, number];

const INDIGO: RGB = [0.04, 0.05, 0.2];
/** Real argon discharge blue-violet (415–420 nm). */
const VIOLET: RGB = [0.52, 0.3, 1.0];
const PERIWINKLE: RGB = [0.28, 0.58, 1.0];
const ORCHID: RGB = [0.78, 0.34, 0.98];
const WHITE_CORE: RGB = [0.92, 0.9, 1.0];

export const SLOW_STEP = 0.25;
export const SURGE_PERIOD = 16;
const SEED = 0xa490;

interface Chamber {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

function chamberFor(fw: number, fh: number): Chamber {
  return {
    cx: fw * 0.68,
    cy: fh * 0.44,
    // Keep the soft containment halo wholly inside the frame with dark breathing room.
    r: Math.max(10, Math.min(fw * 0.24, fh * 0.41)),
  };
}

/** Slow ambient indigo/violet chamber glow + whisper-soft glass rim. */
function slowLight(c: Chamber, x: number, y: number, t: number, out: Float32Array, o: number): void {
  const n1 = noise(x * 0.35 + t * 0.05, y * 0.4 - t * 0.04);
  const n2 = noise(x * 0.6 - t * 0.04 + 41, y * 0.6 + t * 0.03 + 73);
  const haze = smoothstep(0.28, 0.92, n1) * 0.36;

  let r = INDIGO[0] * haze + VIOLET[0] * smoothstep(0.62, 0.96, n2) * 0.1;
  let g = INDIGO[1] * haze + VIOLET[1] * smoothstep(0.62, 0.96, n2) * 0.1;
  let b = INDIGO[2] * haze + PERIWINKLE[2] * smoothstep(0.56, 0.95, n2) * 0.14;

  const d = Math.hypot(x - c.cx, y - c.cy) / c.r;
  // Tighter inner halo around the electrode so the tendrils stand out crisply.
  const coreHalo = Math.exp(-d * d * 7.5) * 0.45 + Math.exp(-d * 2.8) * 0.16;
  r += VIOLET[0] * coreHalo + PERIWINKLE[0] * coreHalo * 0.35;
  g += VIOLET[1] * coreHalo + PERIWINKLE[1] * coreHalo * 0.35;
  b += VIOLET[2] * coreHalo + PERIWINKLE[2] * coreHalo * 0.35;

  // Whisper-soft atmospheric glass sheen along the containment shell (never a hard ring).
  const rim = Math.exp(-Math.pow((d - 1.0) / 0.1, 2)) * (0.14 + 0.08 * n2);
  r += PERIWINKLE[0] * rim;
  g += PERIWINKLE[1] * rim;
  b += PERIWINKLE[2] * rim;

  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

function drawFilament(
  frame: Frame,
  win: SceneWindow,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t: number,
  salt: number,
  intensity: number,
  wiggle: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx = -dy / len;
  const ny = dx / len;
  const steps = Math.max(12, Math.min(72, Math.ceil(len * 1.5)));
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const env = Math.sin(Math.PI * u);
    const wave1 = (noise(u * 4.4 + salt, t * 0.5 + salt * 0.7) - 0.5) * 2;
    const wave2 = Math.sin(u * 12 - t * 2.0 + salt * 3) * 0.35;
    const off = env * (wave1 + wave2) * wiggle;
    const px = x0 + dx * u + nx * off;
    const py = y0 + dy * u + ny * off;
    const pulse = 0.76 + 0.32 * Math.sin(u * 9 - t * 3.2 + salt);
    const bright = intensity * pulse * (0.48 + 0.52 * env);
    const tint = u < 0.35 ? WHITE_CORE : u < 0.74 ? VIOLET : ORCHID;
    splat(frame, win, px, py, 0.62, tint[0] * 0.44 * bright, tint[1] * 0.44 * bright, tint[2] * 0.44 * bright);
    splat(frame, win, px, py, 2.0, PERIWINKLE[0] * 0.11 * bright, VIOLET[1] * 0.11 * bright, VIOLET[2] * 0.12 * bright);
  }
}

export function createArgonScene(): SceneEngine {
  let cached: Float32Array | null = null;
  let cacheKey = "";

  return {
    frameMs: 50,
    paint(frame: Frame, win: SceneWindow, t: number, pointer: Pointer | null): void {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const c = chamberFor(fw, fh);
      const slowT = Math.floor(t / SLOW_STEP) * SLOW_STEP;
      const key = `${win.x},${win.y},${win.width},${win.height},${fw},${fh},${slowT}`;
      if (!cached || key !== cacheKey) {
        if (!cached || cached.length !== frame.light.length) {
          cached = new Float32Array(frame.light.length);
        }
        for (let py = 0; py < frame.height * 2; py++) {
          const fy = win.y * 2 + py;
          for (let px = 0; px < frame.width; px++) {
            slowLight(c, win.x + px, fy, slowT, cached, (py * frame.width + px) * 3);
          }
        }
        cacheKey = key;
      }
      frame.light.set(cached);

      const surgePhase = (t % SURGE_PERIOD) / SURGE_PERIOD;
      const surge = 1 + 0.38 * Math.exp(-Math.pow((surgePhase - 0.5) / 0.12, 2));

      // Crisp jewel-like central electrode.
      splat(frame, win, c.cx, c.cy, 1.35, WHITE_CORE[0] * 1.05 * surge, WHITE_CORE[1] * 1.0 * surge, WHITE_CORE[2] * 1.15 * surge);
      splat(frame, win, c.cx, c.cy, 3.8, VIOLET[0] * 0.46 * surge, VIOLET[1] * 0.46 * surge, VIOLET[2] * 0.5 * surge);

      // Seven delicate noble-gas plasma tendrils radiating to the outer halo.
      const tendrils = 7;
      for (let i = 0; i < tendrils; i++) {
        const baseAngle = (i / tendrils) * Math.PI * 2 + hash2(i, 1, SEED) * 0.5;
        const drift = (noise(i * 7.3 + 3, t * 0.1) - 0.5) * 1.1 + t * 0.035;
        const angle = baseAngle + drift;
        const reach = c.r * (0.94 + 0.06 * Math.sin(t * 0.4 + i * 1.7));
        const tipX = c.cx + Math.cos(angle) * reach;
        const tipY = c.cy + Math.sin(angle) * reach;
        const strength = (0.55 + 0.4 * Math.sin(t * 0.65 + i * 2.3)) * surge;
        drawFilament(frame, win, c.cx, c.cy, tipX, tipY, t, i * 13.7 + 1.1, strength, c.r * 0.18);
        splat(frame, win, tipX, tipY, 1.5, ORCHID[0] * 0.52 * strength, ORCHID[1] * 0.52 * strength, ORCHID[2] * 0.55 * strength);
      }

      // Faint secondary ionized aurora wisp drifting in the far-left dark.
      for (let i = 0; i < 2; i++) {
        const x0 = fw * (0.09 + i * 0.09);
        const y0 = fh * (0.2 + i * 0.14);
        const x1 = x0 + fw * 0.14;
        const y1 = y0 + fh * 0.26;
        drawFilament(frame, win, x0, y0, x1, y1, t * 0.5, 80 + i * 17, 0.28 * surge, 4.2);
      }

      const sparks = 24;
      for (let i = 0; i < sparks; i++) {
        const a = hash2(i, 20, SEED) * Math.PI * 2 + t * (0.03 + hash2(i, 21, SEED) * 0.04);
        const rad = c.r * (0.22 + 0.92 * hash2(i, 22, SEED));
        const sx = c.cx + Math.cos(a) * rad;
        const sy = c.cy + Math.sin(a) * rad;
        const tw = 0.4 + 0.6 * Math.sin(t * (1.4 + hash2(i, 23, SEED) * 2.0) + i * 3.1);
        const lvl = (0.24 + 0.36 * hash2(i, 24, SEED)) * tw;
        if (i % 5 === 0) {
          putGlyph(frame, win, sx, sy / 2, i % 10 === 0 ? "✧" : "·", WHITE_CORE[0] * lvl, WHITE_CORE[1] * lvl, WHITE_CORE[2] * lvl);
        } else {
          addPixel(frame, Math.floor(sx) - win.x, Math.floor(sy) - win.y * 2, PERIWINKLE[0] * lvl, PERIWINKLE[1] * lvl, PERIWINKLE[2] * lvl);
        }
      }

      if (pointer && pointer.strength > 0.01) {
        const s = pointer.strength;
        drawFilament(frame, win, c.cx, c.cy, pointer.x, pointer.y, t * 1.4, 211.3, 1.15 * s, Math.min(7, c.r * 0.22));
        drawFilament(frame, win, c.cx, c.cy, pointer.x, pointer.y, t * 1.1, 307.9, 0.65 * s, Math.min(10, c.r * 0.3));
        splat(frame, win, pointer.x, pointer.y, 1.35, WHITE_CORE[0] * 1.15 * s, WHITE_CORE[1] * 1.1 * s, WHITE_CORE[2] * 1.25 * s);
        splat(frame, win, pointer.x, pointer.y, 4.8, ORCHID[0] * 0.4 * s, VIOLET[1] * 0.4 * s, PERIWINKLE[2] * 0.48 * s);
      }
    },
  };
}

import {
  addPixel,
  clamp01,
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
 * Hydrogen (H, Z=1) — the primordial element: a star-forming H II emission
 * nebula glowing in Hydrogen's Balmer-series lines.
 *
 * Back to front:
 * - deep cosmic dark with subtle indigo-violet molecular cloud wisps;
 * - billowing domain-warped emission veils in real Balmer H-alpha rose-
 *   crimson (656 nm) and H-beta icy turquoise (486 nm), sculpted by organic
 *   dark dust lanes and glowing ionization fronts curving around a young
 *   O-star nursery in the upper right;
 * - twinkling newborn stars and sparse diffraction-spiked hero stars;
 * - under the pointer, a hot blue-white O-type star whose UV flux locally
 *   ionizes and brightens the surrounding hydrogen gas in rose and cyan.
 */

type RGB = readonly [number, number, number];

/** Balmer H-alpha (656 nm) — deep hydrogen crimson-rose. */
const H_ALPHA: RGB = [0.95, 0.22, 0.38];
/** Warm ionized rose-coral ridge. */
const H_RIDGE: RGB = [1.0, 0.56, 0.62];
/** Balmer H-beta (486 nm) — luminous turquoise-cyan. */
const H_BETA: RGB = [0.18, 0.82, 0.94];
/** Balmer H-gamma (434 nm) — deep emission violet-indigo. */
const H_GAMMA: RGB = [0.34, 0.24, 0.88];
const DEEP_NAVY: RGB = [0.04, 0.05, 0.16];
const O_STAR: RGB = [0.84, 0.93, 1.0];

export const SLOW_STEP = 0.25;
export const PULSE_PERIOD = 20;
const SEED = 0x41d0;

const mix = (a: RGB, b: RGB, t: number, k: number): number => a[k]! + (b[k]! - a[k]!) * t;

/** Slow nebula + organic dust rifts at one field pixel. Pure in (x, y, t). */
function slowLight(x: number, y: number, fw: number, fh: number, t: number, out: Float32Array, o: number): void {
  const nx = x / Math.max(1, fw);
  const ny = y / Math.max(1, fh);

  // Two-stage domain warp so gas veils curl organically like real emission clouds.
  const qx = x * 0.42;
  const qy = y * 0.46;
  const w1 = noise(qx * 0.72 + t * 0.045, qy * 0.72 - t * 0.03);
  const w2 = noise(qx * 0.72 + 61.4 - t * 0.035, qy * 0.72 + 29.2 + t * 0.025);
  const n = noise(qx * 1.1 + (w1 - 0.5) * 56, qy * 1.1 + (w2 - 0.5) * 56);
  const fine = noise(qx * 2.1 + (w2 - 0.5) * 34 + 17, qy * 2.1 - (w1 - 0.5) * 34 + 51);

  // Flowing ionization cavity centred in the upper right, sweeping diagonally toward bottom left.
  const cx = fw * 0.66;
  const cy = fh * 0.34;
  const dx = (x - cx) / Math.max(14, fw * 0.42);
  const dy = (y - cy) / Math.max(12, fh * 0.56);
  const rCavity = Math.hypot(dx, dy);

  // Billowing cloud envelope: bright rim around the cavity, soft drifting tendrils into the dark.
  const rimBand = Math.exp(-Math.pow((rCavity - 0.72 + (w1 - 0.5) * 0.42) / 0.46, 2));
  const innerGlow = Math.exp(-rCavity * rCavity * 2.1);
  const diagonalVeil = Math.exp(-Math.pow((ny - (0.78 - nx * 0.52) + (w2 - 0.5) * 0.36) / 0.34, 2));

  const cloud = smoothstep(0.28, 0.9, n) * (0.22 + 0.58 * rimBand + 0.42 * diagonalVeil);
  // Crisp glowing ionization ridges where UV light meets denser gas.
  const ridge = Math.pow(clamp01(1 - Math.abs(n - 0.56) * 4.4), 2.4) * (0.35 + 0.95 * rimBand + 0.45 * diagonalVeil);
  // Organic dark molecular-dust lanes carving depth through the clouds (never geometric shapes).
  const dustNoise = noise(qx * 1.35 + (w1 - 0.5) * 42 + 91, qy * 1.35 + (w2 - 0.5) * 42 + 13);
  const dust = smoothstep(0.62, 0.88, dustNoise) * smoothstep(0.22, 0.95, rCavity) * 0.72;
  // Bright edge along the dust lane facing the O-star cluster.
  const dustEdge = smoothstep(0.52, 0.64, dustNoise) * (1 - smoothstep(0.64, 0.76, dustNoise)) * rimBand * 0.55;

  const pulse = 0.92 + 0.08 * Math.sin((t / PULSE_PERIOD) * Math.PI * 2 + w1 * 4);
  const alphaMix = smoothstep(0.25, 0.82, w1);

  let r = DEEP_NAVY[0] * (0.25 + 0.5 * cloud) + mix(H_GAMMA, H_ALPHA, alphaMix, 0) * cloud * 0.72;
  let g = DEEP_NAVY[1] * (0.25 + 0.5 * cloud) + mix(H_GAMMA, H_ALPHA, alphaMix, 1) * cloud * 0.72;
  let b = DEEP_NAVY[2] * (0.25 + 0.5 * cloud) + mix(H_GAMMA, H_ALPHA, alphaMix, 2) * cloud * 0.72;

  // Ionized H-beta cyan-turquoise core inside the upper-right star-forming cavity.
  const beta = innerGlow * (0.34 + 0.42 * fine) * pulse;
  r += H_BETA[0] * beta;
  g += H_BETA[1] * beta;
  b += H_BETA[2] * beta;

  // Carve organic dust shadows, then paint hot ionized Balmer rims on top.
  const absorb = 1 - dust;
  r *= absorb;
  g *= absorb;
  b *= absorb;

  const hotRidge = (ridge * 0.62 + dustEdge * 0.85) * pulse;
  const cyanTint = smoothstep(0.9, 0.25, rCavity) * 0.55;
  r += mix(H_RIDGE, H_BETA, cyanTint, 0) * hotRidge;
  g += mix(H_RIDGE, H_BETA, cyanTint, 1) * hotRidge;
  b += mix(H_RIDGE, H_BETA, cyanTint, 2) * hotRidge;

  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

const STAR_GLYPHS = ["·", "⋆", "✧", "✦"] as const;

export function createHydrogenScene(): SceneEngine {
  let cached: Float32Array | null = null;
  let cacheKey = "";

  return {
    frameMs: 50,
    paint(frame: Frame, win: SceneWindow, t: number, pointer: Pointer | null): void {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const slowT = Math.floor(t / SLOW_STEP) * SLOW_STEP;
      const key = `${win.x},${win.y},${win.width},${win.height},${fw},${fh},${slowT}`;
      if (!cached || key !== cacheKey) {
        if (!cached || cached.length !== frame.light.length) {
          cached = new Float32Array(frame.light.length);
        }
        for (let py = 0; py < frame.height * 2; py++) {
          const fy = win.y * 2 + py;
          for (let px = 0; px < frame.width; px++) {
            slowLight(win.x + px, fy, fw, fh, slowT, cached, (py * frame.width + px) * 3);
          }
        }
        cacheKey = key;
      }
      frame.light.set(cached);

      // Young O-star nursery in the upper-right ionized cavity.
      const clusterX = fw * 0.66;
      const clusterY = fh * 0.34;
      for (let i = 0; i < 6; i++) {
        const ang = hash2(i, 1, SEED) * Math.PI * 2;
        const rad = Math.pow(hash2(i, 2, SEED), 0.75) * Math.min(fw * 0.1, fh * 0.15);
        const sx = clusterX + Math.cos(ang) * rad;
        const sy = clusterY + Math.sin(ang) * rad * 0.85;
        const tw = 0.8 + 0.2 * Math.sin(t * (1.1 + hash2(i, 3, SEED) * 1.4) + i * 2.1);
        const bright = (i === 0 ? 1.05 : 0.36 + hash2(i, 4, SEED) * 0.38) * tw;
        splat(frame, win, sx, sy, i === 0 ? 1.4 : 0.9, O_STAR[0] * bright, O_STAR[1] * bright, O_STAR[2] * bright);
        if (i === 0) {
          // Crisp 4-point stellar diffraction cross on the primary O-star.
          for (let s = 1; s <= 5; s++) {
            const f = Math.exp(-s / 2.2) * 0.42 * tw;
            addPixel(frame, Math.floor(sx - win.x + s), Math.floor(sy - win.y * 2), O_STAR[0] * f, O_STAR[1] * f, O_STAR[2] * f);
            addPixel(frame, Math.floor(sx - win.x - s), Math.floor(sy - win.y * 2), O_STAR[0] * f, O_STAR[1] * f, O_STAR[2] * f);
            addPixel(frame, Math.floor(sx - win.x), Math.floor(sy - win.y * 2 + s), O_STAR[0] * f, O_STAR[1] * f, O_STAR[2] * f);
            addPixel(frame, Math.floor(sx - win.x), Math.floor(sy - win.y * 2 - s), O_STAR[0] * f, O_STAR[1] * f, O_STAR[2] * f);
          }
        }
      }

      // Faint ionized wisps drifting slowly away from the nebula ridge.
      for (let i = 0; i < 14; i++) {
        const phase = (t * 0.035 + hash2(i, 10, SEED)) % 1;
        const bx = fw * (0.14 + hash2(i, 11, SEED) * 0.74);
        const by = fh * (0.28 + hash2(i, 12, SEED) * 0.56) - phase * 10;
        const fade = Math.sin(Math.PI * phase) * 0.2;
        const tint = i % 3 === 0 ? H_BETA : H_ALPHA;
        splat(frame, win, bx + Math.sin(t * 0.4 + i) * 1.5, by, 1.8, tint[0] * fade, tint[1] * fade, tint[2] * fade);
      }

      // Field stars: subtle pinpoints and occasional twinkling glyph stars.
      const starCount = Math.max(22, Math.round((fw * win.fieldHeight) / 52));
      for (let i = 0; i < starCount; i++) {
        const sx = hash2(i, 20, SEED) * fw;
        const sy = hash2(i, 21, SEED) * fh;
        const tw = 0.55 + 0.45 * Math.sin(t * (0.8 + hash2(i, 22, SEED) * 2.0) + hash2(i, 23, SEED) * 6.28);
        const mag = Math.pow(hash2(i, 24, SEED), 2.5);
        const tint = hash2(i, 25, SEED) > 0.35 ? O_STAR : H_RIDGE;
        if (mag > 0.68) {
          const glyphIdx = Math.min(STAR_GLYPHS.length - 1, Math.floor(tw * STAR_GLYPHS.length));
          const lvl = (0.35 + 0.5 * mag) * tw;
          putGlyph(frame, win, sx, sy / 2, STAR_GLYPHS[glyphIdx]!, tint[0] * lvl, tint[1] * lvl, tint[2] * lvl);
        } else {
          const lvl = (0.16 + 0.42 * mag) * tw;
          addPixel(frame, Math.floor(sx) - win.x, Math.floor(sy) - win.y * 2, tint[0] * lvl, tint[1] * lvl, tint[2] * lvl);
        }
      }

      // Pointer: a young ionizing O-star whose UV flux illuminates surrounding hydrogen gas.
      if (pointer && pointer.strength > 0.01) {
        const s = pointer.strength;
        splat(frame, win, pointer.x, pointer.y, 1.3, O_STAR[0] * 1.2 * s, O_STAR[1] * 1.2 * s, O_STAR[2] * 1.25 * s);
        splat(frame, win, pointer.x, pointer.y, 4.8, H_BETA[0] * 0.42 * s, H_BETA[1] * 0.42 * s, H_BETA[2] * 0.42 * s);
        splat(frame, win, pointer.x, pointer.y, 9.8, H_ALPHA[0] * 0.3 * s, H_ALPHA[1] * 0.3 * s, H_ALPHA[2] * 0.3 * s);
      }
    },
  };
}

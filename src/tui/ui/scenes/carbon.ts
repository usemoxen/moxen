import {
  clamp01,
  hash2,
  noise,
  putGlyph,
  splat,
  type Frame,
  type Pointer,
  type SceneEngine,
  type SceneWindow,
} from "./raster.js";

/**
 * Carbon (C, Z=6) — the two allotropes of carbon: dark architectural
 * graphene honeycomb and cut-diamond prismatic caustics.
 *
 * - a gently tilted hexagonal sp² carbon lattice spans the whole field in
 *   quiet gunmetal-graphite, nearly dark where unlit;
 * - slow sweeping caustic beams glide across the lattice, catching bond
 *   edges and vertices with crisp specular silver-white and real chromatic
 *   diamond dispersion (slightly offset sapphire-cyan, emerald, topaz-gold
 *   and ruby-rose rays);
 * - a delicate, jewel-cut diamond crystal floats in the upper right,
 *   defined by luminous bevelled facet edges and subtle prismatic internal
 *   fire rather than solid fills;
 * - under the pointer, a pinpoint light source sweeps over the crystal
 *   lattice, lighting nearby hexagons in silver and refracting prismatic
 *   diamond dispersion off surrounding facets.
 */

type RGB = readonly [number, number, number];

const GRAPHITE: RGB = [0.08, 0.1, 0.14];
const SILVER: RGB = [0.76, 0.83, 0.94];
const DIAMOND: RGB = [0.98, 0.99, 1.0];
const SAPPHIRE: RGB = [0.26, 0.76, 1.0];
const EMERALD: RGB = [0.3, 0.94, 0.74];
const TOPAZ: RGB = [1.0, 0.74, 0.3];
const RUBY_FIRE: RGB = [0.98, 0.34, 0.64];

export const SWEEP_PERIOD = 24;
const SEED = 0xc4b0;
const SQRT3 = Math.sqrt(3);
const TILT_COS = Math.cos(-0.22);
const TILT_SIN = Math.sin(-0.22);

function hexMetrics(u: number, v: number): { edge: number; vertex: number; cellHash: number } {
  const q = (SQRT3 / 3) * u - (1 / 3) * v;
  const r = (2 / 3) * v;
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;

  const cx = SQRT3 * (rq + rr / 2);
  const cy = 1.5 * rr;
  const lx = Math.abs(u - cx);
  const ly = Math.abs(v - cy);

  const inradius = SQRT3 / 2;
  const hexDist = Math.max(lx, lx * 0.5 + ly * inradius);
  const edge = Math.abs(inradius - hexDist);

  const vTop = Math.hypot(lx, ly - 1);
  const vSide = Math.hypot(lx - inradius, ly - 0.5);
  const vertex = Math.min(vTop, vSide);

  return { edge, vertex, cellHash: hash2(rq, rr, SEED) };
}

/** Paint a delicate luminous cut-diamond prism with smooth bevelled facets and prismatic dispersion rays. */
function paintPrism(frame: Frame, win: SceneWindow, fw: number, fh: number, t: number): void {
  const cx = fw * 0.72;
  const cy = fh * 0.38;
  const r = Math.max(7.5, Math.min(fw * 0.115, fh * 0.25));
  const spin = t * 0.22;
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);

  const x0 = Math.max(0, Math.floor(cx - r * 2.1) - win.x);
  const x1 = Math.min(frame.width - 1, Math.ceil(cx + r * 2.1) - win.x);
  const y0 = Math.max(0, Math.floor(cy - r * 2.1) - win.y * 2);
  const y1 = Math.min(frame.height * 2 - 1, Math.ceil(cy + r * 2.1) - win.y * 2);
  if (x0 > x1 || y0 > y1) return;

  for (let py = y0; py <= y1; py++) {
    const fy = win.y * 2 + py;
    const dy = (fy - cy) / r;
    for (let px = x0; px <= x1; px++) {
      const fx = win.x + px;
      const dx = (fx - cx) / r;
      const rx = dx * cs - dy * sn;
      const ry = dx * sn + dy * cs;
      // Sharp diamond lozenge / brilliant-cut octagon silhouette.
      const dOct = Math.max(Math.abs(rx), Math.abs(ry), (Math.abs(rx) + Math.abs(ry)) * 0.71);
      if (dOct > 1.95) continue;

      const angle = Math.atan2(ry, rx);
      const o = (py * frame.width + px) * 3;

      // Delicate prismatic dispersion rays extending gently outward from the crystal.
      if (dOct > 0.92) {
        const ray = Math.pow(Math.max(0, Math.cos(angle * 4 - spin * 0.5)), 12);
        const fade = Math.exp(-(dOct - 0.92) / 0.42);
        const rayBlue = Math.pow(Math.max(0, Math.cos((angle - 0.08) * 4 - spin * 0.5)), 12);
        const rayGold = Math.pow(Math.max(0, Math.cos((angle + 0.08) * 4 - spin * 0.5)), 12);
        frame.light[o]! += (DIAMOND[0] * ray * 0.22 + TOPAZ[0] * rayGold * 0.24 + RUBY_FIRE[0] * rayGold * 0.1) * fade;
        frame.light[o + 1]! += (DIAMOND[1] * ray * 0.22 + EMERALD[1] * ray * 0.16 + TOPAZ[1] * rayGold * 0.16) * fade;
        frame.light[o + 2]! += (DIAMOND[2] * ray * 0.22 + SAPPHIRE[2] * rayBlue * 0.34) * fade;
      }

      if (dOct > 1.08) continue;

      // Translucent crystal interior: dim obsidian-sapphire glass + crisp glowing bevel edges.
      const outerEdge = Math.exp(-Math.pow((dOct - 0.98) / 0.055, 2));
      const tableEdge = Math.exp(-Math.pow((dOct - 0.48) / 0.05, 2)) * 0.85;
      const spoke = Math.exp(-Math.pow(Math.abs(Math.sin(angle * 4)) / 0.09, 2)) * (dOct < 0.48 ? 0.12 : 0.62);
      const innerStar = Math.exp(-Math.pow(Math.abs(Math.sin(angle * 4 + Math.PI / 4)) / 0.08, 2)) * (dOct < 0.48 ? 0.42 : 0.15);

      // Smooth iridescent internal fire (continuous trig, never flat pie blocks).
      const fireWave = Math.sin(angle * 3 + spin * 2.1 + dOct * 4);
      const fireA = Math.pow(clamp01(fireWave * 0.5 + 0.5), 2.6) * 0.26;
      const fireB = Math.pow(clamp01(-fireWave * 0.5 + 0.5), 2.6) * 0.22;
      const glass = (1 - dOct * 0.55) * 0.12;
      const wire = outerEdge * 0.85 + tableEdge * 0.65 + spoke * 0.45 + innerStar * 0.38;

      frame.light[o]! += SILVER[0] * glass + DIAMOND[0] * wire + TOPAZ[0] * fireA + RUBY_FIRE[0] * fireB * 0.65;
      frame.light[o + 1]! += SILVER[1] * glass + DIAMOND[1] * wire + EMERALD[1] * fireA * 0.8 + SAPPHIRE[1] * fireB * 0.7;
      frame.light[o + 2]! += SILVER[2] * glass + DIAMOND[2] * wire + SAPPHIRE[2] * fireB * 1.15;
    }
  }

  // Crisp diamond-fire star flash at the crown centre.
  const pulse = 0.55 + 0.45 * Math.sin(t * 1.4);
  splat(frame, win, cx, cy, 1.1, DIAMOND[0] * 0.75 * pulse, DIAMOND[1] * 0.78 * pulse, DIAMOND[2] * 0.85 * pulse);
}

export function createCarbonScene(): SceneEngine {
  return {
    frameMs: 50,
    paint(frame: Frame, win: SceneWindow, t: number, pointer: Pointer | null): void {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const scale = Math.max(5.5, Math.min(fw, fh) * 0.11);

      const sweepPhase = (t / SWEEP_PERIOD) * Math.PI * 2;
      const beam1Pos = Math.sin(sweepPhase) * 0.55;
      const beam2Pos = Math.cos(sweepPhase * 0.7 + 1.2) * 0.55;

      for (let py = 0; py < frame.height * 2; py++) {
        const fy = win.y * 2 + py;
        const ny = fy / Math.max(1, fh) - 0.5;
        for (let px = 0; px < frame.width; px++) {
          const fx = win.x + px;
          const nx = fx / Math.max(1, fw) - 0.5;

          const u = (fx * TILT_COS - fy * TILT_SIN) / scale;
          const v = (fx * TILT_SIN + fy * TILT_COS) / scale;
          const hex = hexMetrics(u, v);

          const bond = Math.exp(-(hex.edge * hex.edge) / 0.0048);
          const node = Math.exp(-(hex.vertex * hex.vertex) / 0.015);

          const diag1 = nx * 0.78 + ny * 0.62 - beam1Pos;
          const diag2 = -nx * 0.55 + ny * 0.83 - beam2Pos;
          const wave = (noise(fx * 0.09 + t * 0.14, fy * 0.09 - t * 0.1) - 0.5) * 0.12;

          const cWhite = Math.exp(-Math.pow((diag1 + wave) / 0.13, 2)) + Math.exp(-Math.pow((diag2 - wave) / 0.15, 2)) * 0.72;
          const cBlue = Math.exp(-Math.pow((diag1 + wave - 0.04) / 0.12, 2)) + Math.exp(-Math.pow((diag2 - wave - 0.036) / 0.14, 2)) * 0.68;
          const cGold = Math.exp(-Math.pow((diag1 + wave + 0.04) / 0.12, 2)) + Math.exp(-Math.pow((diag2 - wave + 0.036) / 0.14, 2)) * 0.68;

          const facetShimmer = 0.45 + 0.55 * Math.sin(t * 0.45 + hex.cellHash * 6.28);
          const baseCell = (0.24 + 0.22 * hex.cellHash) * (0.22 + 0.42 * cWhite * facetShimmer);

          let pLit = 0;
          let pDisp = 0;
          if (pointer && pointer.strength > 0.01) {
            const pd = Math.hypot(fx - pointer.x, fy - pointer.y);
            pLit = Math.exp(-(pd * pd) / 260) * pointer.strength;
            pDisp = Math.exp(-Math.pow((pd - 10) / 7, 2)) * pointer.strength;
          }

          const bondLight = (0.12 + 0.52 * cWhite + 0.82 * pLit) * bond;
          const nodeLight = (0.14 + 0.68 * cWhite * facetShimmer + 1.05 * pLit) * node;

          const o = (py * frame.width + px) * 3;
          let r = GRAPHITE[0] * baseCell + SILVER[0] * bondLight + DIAMOND[0] * nodeLight;
          let g = GRAPHITE[1] * baseCell + SILVER[1] * bondLight + DIAMOND[1] * nodeLight;
          let b = GRAPHITE[2] * baseCell + SILVER[2] * bondLight + DIAMOND[2] * nodeLight;

          // Prismatic diamond dispersion riding the sweeping caustic bonds & vertices.
          const prismMask = bond * 0.68 + node * 0.95;
          r += (TOPAZ[0] * cGold * 0.52 + RUBY_FIRE[0] * (cGold * 0.22 + pDisp * 0.48)) * prismMask;
          g += (EMERALD[1] * cWhite * 0.4 + TOPAZ[1] * cGold * 0.34) * prismMask;
          b += (SAPPHIRE[2] * cBlue * 0.68 + SAPPHIRE[2] * pDisp * 0.6) * prismMask;

          frame.light[o] = r;
          frame.light[o + 1] = g;
          frame.light[o + 2] = b;
        }
      }

      paintPrism(frame, win, fw, fh, t);

      for (let i = 0; i < 16; i++) {
        const gx = hash2(i, 1, SEED) * fw;
        const gy = hash2(i, 2, SEED) * fh;
        const flash = Math.pow(Math.max(0, Math.sin(t * (0.9 + hash2(i, 3, SEED) * 1.4) + hash2(i, 4, SEED) * 6.28)), 6);
        if (flash < 0.18) continue;
        const hue = i % 3 === 0 ? SAPPHIRE : i % 3 === 1 ? TOPAZ : DIAMOND;
        putGlyph(frame, win, gx, gy / 2, flash > 0.65 ? "✦" : "·", hue[0] * flash, hue[1] * flash, hue[2] * flash);
      }

      if (pointer && pointer.strength > 0.01) {
        const s = pointer.strength;
        splat(frame, win, pointer.x, pointer.y, 1.3, DIAMOND[0] * 1.15 * s, DIAMOND[1] * 1.15 * s, DIAMOND[2] * 1.2 * s);
        splat(frame, win, pointer.x - 1.5, pointer.y, 2.4, SAPPHIRE[0] * 0.45 * s, SAPPHIRE[1] * 0.45 * s, SAPPHIRE[2] * 0.5 * s);
        splat(frame, win, pointer.x + 1.5, pointer.y, 2.4, TOPAZ[0] * 0.4 * s, TOPAZ[1] * 0.34 * s, RUBY_FIRE[2] * 0.4 * s);
      }
    },
  };
}

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
 * Neon (Ne, Z=10) — gas-discharge luminescence in an obsidian darkroom.
 *
 * Authentic neon discharge emits intensely at 640 nm (saturated vermilion-
 * orange) with a razor-thin incandescent plasma filament at the centerline
 * and a deep crimson-magenta atmospheric halation, contrasted against faint
 * cool slate-indigo mist so the warm glow reads vividly without turning
 * brown.
 *
 * - three graceful bent glass-discharge arcs sweep across the flanks and
 *   upper right (clear of the centre composer), each rendered as an exact
 *   distance field with tight filament core, saturated neon vermilion tube,
 *   and wide ruby halation;
 * - travelling ionization striations glide gently along the arcs, with a
 *   periodic excitation wave surging through one tube at a time;
 * - sparse warm ion motes drift upward in the convection haze;
 * - under the pointer, capacitive glass touch: a bright discharge node
 *   excites a live plasma filament arching from the nearest neon tube to
 *   the cursor.
 */

type RGB = readonly [number, number, number];

const COOL_MIST: RGB = [0.04, 0.09, 0.19];
const RUBY: RGB = [0.76, 0.06, 0.16];
/** Real 640 nm neon discharge vermilion-orange. */
const VERMILION: RGB = [1.0, 0.22, 0.07];
const HOT_ORANGE: RGB = [1.0, 0.48, 0.12];
const CORE: RGB = [1.0, 0.88, 0.72];

export const SLOW_STEP = 0.25;
export const EXCITE_PERIOD = 18;
const SEED = 0x4e0e;

interface TubePoint {
  readonly x: number;
  readonly y: number;
}

function bezier(p0: TubePoint, p1: TubePoint, p2: TubePoint, p3: TubePoint, u: number): TubePoint {
  const m = 1 - u;
  const m2 = m * m;
  const u2 = u * u;
  return {
    x: m2 * m * p0.x + 3 * m2 * u * p1.x + 3 * m * u2 * p2.x + u2 * u * p3.x,
    y: m2 * m * p0.y + 3 * m2 * u * p1.y + 3 * m * u2 * p2.y + u2 * u * p3.y,
  };
}

interface TubeDef {
  readonly p0: TubePoint;
  readonly p1: TubePoint;
  readonly p2: TubePoint;
  readonly p3: TubePoint;
  readonly phase: number;
  readonly radius: number;
}

function tubesFor(fw: number, fh: number): readonly TubeDef[] {
  return [
    {
      p0: { x: fw * 0.46, y: fh * 0.07 },
      p1: { x: fw * 0.72, y: fh * 0.09 },
      p2: { x: fw * 0.91, y: fh * 0.29 },
      p3: { x: fw * 0.87, y: fh * 0.68 },
      phase: 0,
      radius: 1.25,
    },
    {
      p0: { x: fw * 0.56, y: fh * 0.16 },
      p1: { x: fw * 0.75, y: fh * 0.2 },
      p2: { x: fw * 0.83, y: fh * 0.37 },
      p3: { x: fw * 0.77, y: fh * 0.59 },
      phase: 2.1,
      radius: 0.95,
    },
    {
      p0: { x: fw * 0.07, y: fh * 0.88 },
      p1: { x: fw * 0.09, y: fh * 0.52 },
      p2: { x: fw * 0.18, y: fh * 0.26 },
      p3: { x: fw * 0.34, y: fh * 0.14 },
      phase: 4.2,
      radius: 1.05,
    },
  ];
}

interface SampledTube {
  readonly pts: TubePoint[];
  readonly def: TubeDef;
}

function sampleTubes(fw: number, fh: number): SampledTube[] {
  const steps = 42;
  return tubesFor(fw, fh).map((def) => {
    const pts: TubePoint[] = [];
    for (let i = 0; i <= steps; i++) {
      pts.push(bezier(def.p0, def.p1, def.p2, def.p3, i / steps));
    }
    return { pts, def };
  });
}

function closestOnTube(tube: SampledTube, x: number, y: number): { dist: number; u: number; px: number; py: number } {
  const pts = tube.pts;
  let bestD2 = Infinity;
  let bestU = 0;
  let bestX = pts[0]!.x;
  let bestY = pts[0]!.y;
  const segs = pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const proj = clamp01(((x - a.x) * vx + (y - a.y) * vy) / len2);
    const px = a.x + vx * proj;
    const py = a.y + vy * proj;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestU = (i + proj) / segs;
      bestX = px;
      bestY = py;
    }
  }
  return { dist: Math.sqrt(bestD2), u: bestU, px: bestX, py: bestY };
}

function slowHaze(x: number, y: number, t: number, out: Float32Array, o: number): void {
  const n1 = noise(x * 0.35 + t * 0.08, y * 0.38 - t * 0.06);
  const n2 = noise(x * 0.65 - t * 0.05 + 37, y * 0.65 + t * 0.04 + 19);
  const mist = smoothstep(0.28, 0.92, n1) * 0.3 + smoothstep(0.55, 0.95, n2) * 0.14;
  out[o] = COOL_MIST[0] * mist;
  out[o + 1] = COOL_MIST[1] * mist;
  out[o + 2] = COOL_MIST[2] * mist;
}

export function createNeonScene(): SceneEngine {
  let hazeCache: Float32Array | null = null;
  let hazeKey = "";
  let tubeCache: SampledTube[] = [];
  let tubeKey = "";

  return {
    frameMs: 50,
    paint(frame: Frame, win: SceneWindow, t: number, pointer: Pointer | null): void {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const slowT = Math.floor(t / SLOW_STEP) * SLOW_STEP;
      const key = `${win.x},${win.y},${win.width},${win.height},${fw},${fh},${slowT}`;
      if (!hazeCache || key !== hazeKey) {
        if (!hazeCache || hazeCache.length !== frame.light.length) {
          hazeCache = new Float32Array(frame.light.length);
        }
        for (let py = 0; py < frame.height * 2; py++) {
          const fy = win.y * 2 + py;
          for (let px = 0; px < frame.width; px++) {
            slowHaze(win.x + px, fy, slowT, hazeCache, (py * frame.width + px) * 3);
          }
        }
        hazeKey = key;
      }
      frame.light.set(hazeCache);

      const tKey = `${fw},${fh}`;
      if (tKey !== tubeKey) {
        tubeCache = sampleTubes(fw, fh);
        tubeKey = tKey;
      }

      const cycle = t / EXCITE_PERIOD;
      const activeTube = ((Math.floor(cycle) % tubeCache.length) + tubeCache.length) % tubeCache.length;
      const cycleFrac = cycle - Math.floor(cycle);

      for (let py = 0; py < frame.height * 2; py++) {
        const fy = win.y * 2 + py;
        for (let px = 0; px < frame.width; px++) {
          const fx = win.x + px;
          let r = 0;
          let g = 0;
          let b = 0;
          for (let ti = 0; ti < tubeCache.length; ti++) {
            const tube = tubeCache[ti]!;
            const hit = closestOnTube(tube, fx, fy);
            const rad = tube.def.radius;
            if (hit.dist > rad * 20) continue;

            const striation = 0.86 + 0.14 * Math.sin(hit.u * 44 - t * 3.2 + tube.def.phase);
            const ends = smoothstep(0, 0.06, hit.u) * smoothstep(0, 0.06, 1 - hit.u);
            const pulseHead = ti === activeTube ? Math.exp(-Math.pow((hit.u - cycleFrac) / 0.11, 2)) * 0.85 : 0;
            const energy = (0.7 + 0.3 * ends) * striation * (1 + pulseHead);

            // Tight incandescent filament, rich 640 nm vermilion body, wide ruby-crimson bloom.
            const core = Math.exp(-(hit.dist * hit.dist) / (rad * rad * 0.32)) * 0.88 * energy;
            const body = Math.exp(-hit.dist / (rad * 1.4)) * 0.92 * energy;
            const bloom = Math.exp(-hit.dist / (rad * 7.6)) * 0.28 * (0.85 + 0.15 * striation) * (1 + pulseHead * 0.5);

            r += CORE[0] * core + VERMILION[0] * body + HOT_ORANGE[0] * core * 0.45 + RUBY[0] * bloom;
            g += CORE[1] * core + VERMILION[1] * body + HOT_ORANGE[1] * core * 0.45 + RUBY[1] * bloom;
            b += CORE[2] * core + VERMILION[2] * body + HOT_ORANGE[2] * core * 0.45 + RUBY[2] * bloom;
          }
          if (r > 0.001 || g > 0.001 || b > 0.001) {
            const o = (py * frame.width + px) * 3;
            frame.light[o]! += r;
            frame.light[o + 1]! += g;
            frame.light[o + 2]! += b;
          }
        }
      }

      for (const tube of tubeCache) {
        for (const end of [tube.pts[0]!, tube.pts[tube.pts.length - 1]!]) {
          splat(frame, win, end.x, end.y, 1.3, HOT_ORANGE[0] * 0.5, HOT_ORANGE[1] * 0.5, HOT_ORANGE[2] * 0.5);
        }
      }
      const motes = 24;
      for (let i = 0; i < motes; i++) {
        const life = (t * (0.04 + hash2(i, 1, SEED) * 0.04) + hash2(i, 2, SEED)) % 1;
        const tube = tubeCache[i % tubeCache.length]!;
        const anchor = tube.pts[Math.floor(hash2(i, 3, SEED) * tube.pts.length)]!;
        const mx = anchor.x + Math.sin(t * 0.7 + i * 1.9) * 3.5 + (hash2(i, 4, SEED) - 0.5) * 8;
        const my = anchor.y - life * 18;
        const fade = Math.sin(Math.PI * life) * (0.28 + 0.32 * hash2(i, 5, SEED));
        if (i % 4 === 0) {
          putGlyph(frame, win, mx, my / 2, "·", HOT_ORANGE[0] * fade * 1.3, HOT_ORANGE[1] * fade * 1.3, HOT_ORANGE[2] * fade * 1.3);
        } else {
          addPixel(frame, Math.floor(mx) - win.x, Math.floor(my) - win.y * 2, VERMILION[0] * fade, VERMILION[1] * fade, VERMILION[2] * fade);
        }
      }

      if (pointer && pointer.strength > 0.01) {
        const s = pointer.strength;
        let best = { dist: Infinity, px: fw * 0.7, py: fh * 0.3 };
        for (const tube of tubeCache) {
          const hit = closestOnTube(tube, pointer.x, pointer.y);
          if (hit.dist < best.dist) best = { dist: hit.dist, px: hit.px, py: hit.py };
        }
        const steps = Math.max(8, Math.min(48, Math.ceil(best.dist * 1.3)));
        const dx = pointer.x - best.px;
        const dy = pointer.y - best.py;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        for (let k = 0; k <= steps; k++) {
          const u = k / steps;
          const arch = Math.sin(Math.PI * u) * (noise(u * 6 + t * 2.2, best.px * 0.1) - 0.5) * Math.min(10, len * 0.35);
          const ax = best.px + dx * u + nx * arch;
          const ay = best.py + dy * u + ny * arch;
          const glow = (0.35 + 0.65 * Math.sin(Math.PI * u)) * s;
          splat(frame, win, ax, ay, 0.85, CORE[0] * 0.5 * glow, HOT_ORANGE[1] * 0.5 * glow, VERMILION[2] * 0.5 * glow);
          splat(frame, win, ax, ay, 2.4, VERMILION[0] * 0.18 * glow, VERMILION[1] * 0.18 * glow, VERMILION[2] * 0.18 * glow);
        }
        splat(frame, win, pointer.x, pointer.y, 1.3, CORE[0] * 1.05 * s, HOT_ORANGE[1] * 1.05 * s, CORE[2] * 0.75 * s);
        splat(frame, win, pointer.x, pointer.y, 5.8, VERMILION[0] * 0.42 * s, VERMILION[1] * 0.42 * s, VERMILION[2] * 0.42 * s);
      }
    },
  };
}

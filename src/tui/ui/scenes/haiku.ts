import { hash2, noise, smoothstep, splat, type Frame, type SceneEngine, type SceneWindow } from "./raster.js";

/**
 * Haiku — the shortest form, so the quietest scene: mostly empty space.
 *
 * Black lacquer with maki-e: one brush-stroke branch in muted gold ink
 * reaching in from the top right, still water along the bottom, a
 * vermillion seal by the water as the signature. Three things carry the
 * form:
 *
 * - kigo, the season word — the scene follows the real calendar
 *   (northern hemisphere): cherry petals in spring, fireflies over the
 *   water in summer, maple leaves in autumn, snow in winter;
 * - kireji, the cut — Bashō's frog: "old pond / a frog jumps in / the
 *   sound of water". Now and then an unseen splash breaks the still
 *   water, a few droplets and a widening ring. Falling petals and leaves
 *   ring the water where they land; snow, as on a real pond, does not;
 * - restraint — the pointer leaves one ripple on the water, or a faint
 *   breeze among what is falling. Nothing more.
 *
 * The branch, seal and water are static and drawn once per window; only
 * the few moving things are painted per frame, on a slow 10 fps clock.
 */

type RGB = readonly [number, number, number];
export type Season = "spring" | "summer" | "autumn" | "winter";

const INK: RGB = [0.5, 0.42, 0.3];
const SEAL: RGB = [0.85, 0.16, 0.1];
const SILVER: RGB = [0.62, 0.66, 0.74];
const SEED = 0x4a1c;

/** Seasonal palette: what blooms on the branch, what falls from it. */
const SEASONS: Record<Season, { bloom: RGB; fall: RGB; falling: number; size: number }> = {
  spring: { bloom: [1.0, 0.68, 0.78], fall: [1.0, 0.74, 0.82], falling: 9, size: 0.75 },
  summer: { bloom: [0.24, 0.42, 0.22], fall: [0.75, 1.0, 0.42], falling: 0, size: 0 },
  autumn: { bloom: [1.0, 0.32, 0.1], fall: [1.0, 0.42, 0.12], falling: 8, size: 0.95 },
  winter: { bloom: [0.82, 0.86, 0.94], fall: [0.86, 0.9, 1.0], falling: 34, size: 0.45 },
};

/** The season at wall-clock `t` seconds, local time. */
export function seasonAt(t: number): Season {
  const month = new Date(t * 1000).getMonth();
  if (month === 11 || month < 2) return "winter";
  if (month < 5) return "spring";
  if (month < 8) return "summer";
  return "autumn";
}

/** Bashō's frog: one splash per slot, somewhere on the water. */
const SPLASH_SLOT = 24;
const RIPPLE_LIFE = 6;

interface Brush {
  x: number;
  y: number;
  w: number;
  ink: number;
}

interface Branch {
  strokes: Brush[];
  /** Twig ends and forks — where blossoms sit and petals leave from. */
  nodes: { x: number; y: number }[];
}

/** One calligraphic branch, grown deterministically from the field's right edge. */
function growBranch(fw: number, fh: number): Branch {
  const strokes: Brush[] = [];
  const nodes: { x: number; y: number }[] = [];
  const grow = (x: number, y: number, angle: number, length: number, width: number, depth: number, id: number): void => {
    const steps = Math.ceil(length / 0.6);
    let children = 0;
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      // The brush wanders in slow arcs; the branch droops under its weight
      // and its tip lifts toward the light.
      angle += (noise(i * 0.045 + id * 37, id * 11) - 0.5) * 0.14 + 0.002 - (s > 0.7 ? 0.004 : 0);
      x += Math.cos(angle) * 0.6;
      y += Math.sin(angle) * 0.6;
      // Dry brush (kasure): the ink breaks where the bristles run dry.
      const ink = 0.4 + 0.6 * smoothstep(0.3, 0.62, noise(i * 0.3 + id * 13, 7 + id));
      const w = width * (1 - 0.82 * Math.pow(s, 0.8));
      strokes.push({ x, y, w, ink });
      // Twigs sprout irregularly, more toward the tip, mostly reaching up.
      if (depth > 0 && children < 4 && s > 0.15 && hash2(id, i, SEED) < 0.035 + 0.04 * s) {
        children++;
        const up = hash2(id, i, SEED + 1) < 0.7 ? -1 : 1;
        grow(x, y, angle + up * (0.35 + hash2(id, i, SEED + 2) * 0.6), length * (0.22 + 0.33 * hash2(id, i, SEED + 3)), w * 0.75, depth - 1, id * 7 + i);
        nodes.push({ x, y });
      }
    }
    nodes.push({ x, y });
  };
  // The main stroke is composed, not grown: a single sweep in from the
  // right edge, dipping and lifting at its tip — the one gesture the
  // scene is built around. Only the twigs are left to chance.
  const p0 = [fw + 3, fh * 0.12];
  const p1 = [fw * 0.84, fh * 0.03];
  const p2 = [fw * 0.74, fh * 0.34];
  const p3 = [fw * 0.56, fh * 0.24];
  const length = fw * 0.55;
  const steps = Math.ceil(length / 0.6);
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const k = 1 - s;
    let x = k * k * k * p0[0]! + 3 * k * k * s * p1[0]! + 3 * k * s * s * p2[0]! + s * s * s * p3[0]!;
    let y = k * k * k * p0[1]! + 3 * k * k * s * p1[1]! + 3 * k * s * s * p2[1]! + s * s * s * p3[1]!;
    // The hand is not a machine: a slight tremor along the stroke.
    x += (noise(s * 6, 3) - 0.5) * 1.2;
    y += (noise(s * 6, 9) - 0.5) * 1.6;
    const ink = 0.45 + 0.55 * smoothstep(0.3, 0.62, noise(i * 0.3, 7));
    const w = 3.4 * (1 - 0.8 * Math.pow(s, 0.9));
    strokes.push({ x, y, w, ink });
    if (i > 0 && i < steps - 3 && hash2(1, i, SEED) < 0.03 + 0.03 * s) {
      const dx = x - strokes[strokes.length - 2]!.x;
      const dy = y - strokes[strokes.length - 2]!.y;
      const heading = Math.atan2(dy, dx);
      const up = hash2(1, i, SEED + 1) < 0.7 ? -1 : 1;
      grow(x, y, heading + up * (0.45 + hash2(1, i, SEED + 2) * 0.55), fw * (0.05 + 0.1 * hash2(1, i, SEED + 3)), w * 0.6, 2, 7 + i);
      nodes.push({ x, y });
    }
  }
  nodes.push(strokes[strokes.length - 1]!);
  return { strokes, nodes };
}

interface Still {
  key: string;
  light: Float32Array;
  branch: Branch;
  waterY: number;
}

/** Branch, blossoms, seal and water — everything that does not move. */
function paintStill(win: SceneWindow, season: Season): Still {
  const fw = win.fieldWidth;
  const fh = win.fieldHeight * 2;
  const waterY = fh * 0.8;
  const frame: Frame = {
    width: win.width,
    height: win.height,
    light: new Float32Array(win.width * win.height * 6),
    glyph: [],
    glyphLight: new Float32Array(0),
  };
  // Lacquer: a breath of warmth low down, the water a shade cooler.
  for (let py = 0; py < win.height * 2; py++) {
    const y = win.y * 2 + py + 0.5;
    const warm = smoothstep(0.3, 0.8, y / fh) * 0.03;
    const water = y > waterY ? 0.008 + 0.012 * smoothstep(waterY, fh, y) : 0;
    for (let px = 0; px < win.width; px++) {
      const o = (py * win.width + px) * 3;
      frame.light[o] = warm * 0.9 + water * 0.5;
      frame.light[o + 1] = warm * 0.6 + water * 0.6;
      frame.light[o + 2] = warm * 0.4 + water * 0.9;
    }
  }
  // The surface: a single faint line where the water begins. Columns a
  // little past the window too, so a neighbour's glow spill is not lost.
  for (let px = -3; px < win.width + 3; px++) {
    splat(frame, win, win.x + px + 0.5, waterY, 0.6, SILVER[0] * 0.035, SILVER[1] * 0.035, SILVER[2] * 0.035);
  }
  const branch = growBranch(fw, fh);
  for (const brush of branch.strokes) {
    const w = 0.42 * brush.ink;
    splat(frame, win, brush.x, brush.y, Math.max(0.45, brush.w * 0.5), INK[0] * w, INK[1] * w, INK[2] * w);
  }
  const { bloom } = SEASONS[season];
  for (let i = 0; i < branch.nodes.length; i++) {
    const node = branch.nodes[i]!;
    if (season === "winter") {
      // Snow resting on the branch, never quite settled evenly.
      if (hash2(i, 0, SEED + 8) < 0.7) splat(frame, win, node.x, node.y - 1, 1.1, bloom[0] * 0.3, bloom[1] * 0.3, bloom[2] * 0.3);
      continue;
    }
    if (season === "autumn" && hash2(i, 0, SEED + 8) > 0.45) continue;
    const petals = season === "spring" ? 4 : 2;
    for (let k = 0; k < petals; k++) {
      const a = hash2(i, k, SEED + 9) * Math.PI * 2;
      const r = 0.8 + hash2(i, k, SEED + 10) * 1.6;
      const w = (season === "summer" ? 0.35 : season === "autumn" ? 0.7 : 0.45) * (0.6 + 0.4 * hash2(i, k, SEED + 11));
      splat(frame, win, node.x + Math.cos(a) * r, node.y + Math.sin(a) * r * 0.8, 0.75, bloom[0] * w, bloom[1] * w, bloom[2] * w);
    }
  }
  if (season === "winter") {
    for (const brush of branch.strokes) {
      if (brush.w < 1.2) continue;
      splat(frame, win, brush.x, brush.y - brush.w * 0.55, 0.55, bloom[0] * 0.14, bloom[1] * 0.14, bloom[2] * 0.14);
    }
  }
  // The seal (hanko): vermillion, with 山 (mountain) carved out of it.
  const carving = ["#########", "####.####", "#.#.#.#.#", "#.#.#.#.#", "#.......#", "#########"];
  const sealX = Math.floor(fw - 13);
  const sealY = Math.floor(waterY - 10);
  for (let row = 0; row < carving.length; row++) {
    for (let col = 0; col < carving[row]!.length; col++) {
      if (carving[row]![col] !== "#") continue;
      const px = sealX + col - win.x;
      const py = sealY + row - win.y * 2;
      if (px < 0 || py < 0 || px >= win.width || py >= win.height * 2) continue;
      const o = (py * win.width + px) * 3;
      frame.light[o]! += SEAL[0] * 0.55;
      frame.light[o + 1]! += SEAL[1] * 0.55;
      frame.light[o + 2]! += SEAL[2] * 0.55;
    }
  }
  return {
    key: `${win.x},${win.y},${win.width},${win.height},${fw},${fh},${season}`,
    light: frame.light,
    branch,
    waterY,
  };
}

/** Rings on the water: a perspective ellipse, a second ring trailing inside. */
function ripple(frame: Frame, win: SceneWindow, cx: number, cy: number, age: number, strength: number): void {
  if (age < 0 || age > RIPPLE_LIFE) return;
  const fade = Math.exp(-age / 1.6) * strength;
  if (fade < 0.01) return;
  const rx = 2 + age * 8;
  const ry = rx * 0.26;
  const x0 = Math.max(0, Math.floor(cx - rx - 2 - win.x));
  const x1 = Math.min(win.width - 1, Math.ceil(cx + rx + 2 - win.x));
  const y0 = Math.max(0, Math.floor(cy - ry - 2 - win.y * 2));
  const y1 = Math.min(win.height * 2 - 1, Math.ceil(cy + ry + 2 - win.y * 2));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (win.x + px + 0.5 - cx) / rx;
      const dy = (win.y * 2 + py + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ring = Math.exp(-Math.pow((d - 1) * rx * 1.4, 2)) + 0.5 * Math.exp(-Math.pow((d - 0.62) * rx * 1.6, 2));
      const w = ring * fade * 0.3;
      if (w < 0.004) continue;
      const o = (py * win.width + px) * 3;
      frame.light[o]! += SILVER[0] * w;
      frame.light[o + 1]! += SILVER[1] * w;
      frame.light[o + 2]! += SILVER[2] * w;
    }
  }
}

export function createHaikuScene(): SceneEngine {
  let still: Still | null = null;
  /** The pointer's one ripple: where and when it last arrived on the water. */
  let touch: { x: number; y: number; t0: number } | null = null;
  let touching = false;

  return {
    frameMs: 100,
    paint(frame, win, t, pointer) {
      const season = seasonAt(t);
      const key = `${win.x},${win.y},${win.width},${win.height},${win.fieldWidth},${win.fieldHeight * 2},${season}`;
      if (still === null || still.key !== key) still = paintStill(win, season);
      frame.light.set(still.light);
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const { waterY, branch } = still;

      // Water glints: a few slow silver streaks, stretched along the surface.
      for (let py = Math.max(0, Math.ceil(waterY - win.y * 2)); py < win.height * 2; py++) {
        const y = win.y * 2 + py + 0.5;
        for (let px = 0; px < win.width; px++) {
          const n = noise((win.x + px) * 0.04 + t * 0.05, y * 0.9);
          const glint = smoothstep(0.78, 0.95, n) * 0.06;
          if (glint <= 0) continue;
          const o = (py * win.width + px) * 3;
          frame.light[o]! += SILVER[0] * glint;
          frame.light[o + 1]! += SILVER[1] * glint;
          frame.light[o + 2]! += SILVER[2] * glint;
        }
      }

      // Kireji: the frog. One splash per slot, droplets first, then the ring.
      for (const slot of [Math.floor(t / SPLASH_SLOT) - 1, Math.floor(t / SPLASH_SLOT)]) {
        const t0 = slot * SPLASH_SLOT + hash2(slot, 1, SEED + 20) * (SPLASH_SLOT - RIPPLE_LIFE);
        const age = t - t0;
        if (age < 0 || age > RIPPLE_LIFE) continue;
        const x = fw * (0.3 + hash2(slot, 2, SEED + 20) * 0.6);
        const y = waterY + (fh - waterY) * (0.25 + hash2(slot, 3, SEED + 20) * 0.45);
        ripple(frame, win, x, y, age, 1.2);
        ripple(frame, win, x, y, age - 0.5, 0.6);
        if (age < 0.7) {
          for (let d = 0; d < 5; d++) {
            const vx = (hash2(slot, d, SEED + 21) - 0.5) * 9;
            const vy = 9 + hash2(slot, d, SEED + 22) * 7;
            const dy = vy * age - 26 * age * age;
            if (dy < 0) continue;
            const w = 0.5 * (1 - age / 0.7);
            splat(frame, win, x + vx * age, y - dy, 0.5, SILVER[0] * w, SILVER[1] * w, SILVER[2] * w);
          }
        }
      }

      const { fall, falling, size } = SEASONS[season];
      // A faint breeze where the pointer rests in the sky.
      const breeze = (x: number, y: number): number => {
        if (!pointer || pointer.strength < 0.05 || pointer.y > waterY) return 0;
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        return Math.sign(dx || 1) * 6 * pointer.strength * Math.exp(-(dx * dx + dy * dy) / 120);
      };

      for (let i = 0; i < falling; i++) {
        const period = season === "winter" ? 16 + hash2(i, 1, SEED + 30) * 10 : 14 + hash2(i, 1, SEED + 30) * 12;
        const phase = hash2(i, 2, SEED + 30) * period;
        const cycle = Math.floor((t + phase) / period);
        const s = (t + phase) / period - cycle;
        // Petals and leaves leave from the branch; snow comes from above.
        let x0: number;
        let y0: number;
        if (season === "winter") {
          x0 = hash2(i, cycle, SEED + 31) * fw;
          y0 = -4;
        } else {
          const node = branch.nodes[Math.floor(hash2(i, cycle, SEED + 31) * branch.nodes.length)] ?? { x: fw * 0.8, y: 4 };
          x0 = node.x;
          y0 = node.y;
        }
        const drift = (hash2(i, cycle, SEED + 32) - 0.65) * fw * 0.25;
        const landX = x0 + drift;
        const sway = Math.sin(s * Math.PI * (3 + 2 * hash2(i, 3, SEED + 30)) + i) * (season === "winter" ? 2 : 5);
        let x = x0 + drift * s + sway;
        const y = y0 + (waterY - y0) * s;
        x += breeze(x, y);
        // Flutter: a petal turning over catches the light and loses it.
        const flutter = season === "winter" ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2 + i * 1.7));
        const w = 0.55 * flutter * smoothstep(0, 0.04, s);
        splat(frame, win, x, y, size, fall[0] * w, fall[1] * w, fall[2] * w);
        if (season !== "winter") {
          // Landing rings the water — the previous cycle's ripple, still spreading.
          const landed = t - (cycle * period - phase);
          ripple(frame, win, landX, waterY + 2, landed, 0.45);
        }
      }

      if (season === "summer") {
        // Fireflies: long dark gaps, a brief soft flash, a reflection below.
        for (let i = 0; i < 12; i++) {
          const x = fw * (0.15 + 0.85 * noise(i * 17 + t * 0.03, 3));
          const y = waterY - fh * (0.05 + 0.3 * noise(i * 29, 11 + t * 0.025));
          const period = 3 + hash2(i, 1, SEED + 40) * 3;
          const p = ((t + hash2(i, 2, SEED + 40) * period) % period) / period;
          const flash = p < 0.18 ? Math.sin((Math.PI * p) / 0.18) : 0;
          const w = 0.06 + 0.9 * flash;
          splat(frame, win, x, y, 0.9, fall[0] * w, fall[1] * w, fall[2] * w);
          const mirror = waterY + (waterY - y) * 0.6;
          splat(frame, win, x, mirror, 1.2, fall[0] * w * 0.18, fall[1] * w * 0.18, fall[2] * w * 0.18);
        }
      }

      // The pointer's ripple: one per arrival on the water, then stillness.
      const onWater = pointer !== null && pointer.strength > 0.3 && pointer.y > waterY;
      if (onWater && !touching) touch = { x: pointer.x, y: pointer.y, t0: t };
      touching = onWater;
      if (touch) ripple(frame, win, touch.x, touch.y, t - touch.t0, 0.9);
    },
  };
}

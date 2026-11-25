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
 * Neon (Ne, Z=10) — high-voltage noble-gas discharge in a midnight obsidian
 * darkroom.
 *
 * Authentic ionized neon emits intensely across 585–640 nm (searing vermilion-
 * orange with incandescent golden-white plasma filaments and electric crimson-
 * magenta halation), contrasted against cool midnight-cobalt darkroom haze so
 * the glow stays luminous and electric rather than turning brown.
 *
 * - three slender interlocking 3D-projected precessing neon orbital rings
 *   frame the upper right around a pulsing cathode core (above and clear of
 *   the centre composer), driven by counter-rotating moving striations
 *   (luminous plasma beads) and orbiting high-energy discharge packets;
 * - a slender braided pair of undulating neon plasma filaments sweeps cleanly
 *   up the left flank, carrying travelling ionization waves;
 * - a periodic high-voltage excitation wave (`EXCITE_PERIOD`) surges through
 *   the rings and flashes crackling arcs from the cathode nucleus;
 * - below the darkroom floor line (`0.82 * fh`), horizontally rippled
 *   obsidian reflections mirror the neon tubes in liquid-glass streaks;
 * - under the pointer, capacitive high-voltage discharge: forked incandescent
 *   vermilion and electric-magenta plasma arcs leap straight to the cursor.
 */

type RGB = readonly [number, number, number];

const MIDNIGHT: RGB = [0.012, 0.032, 0.115];
const COBALT_MIST: RGB = [0.025, 0.16, 0.36];
/** Saturated crimson-magenta atmospheric bloom — keeps halation electric, never brown. */
const MAGENTA_BLOOM: RGB = [0.94, 0.02, 0.35];
const ELECTRIC_PINK: RGB = [1.0, 0.12, 0.46];
/** Authentic 640 nm neon discharge vermilion-scarlet. */
const VERMILION: RGB = [1.0, 0.16, 0.03];
/** Hot 585 nm neon yellow-orange sheath. */
const AMBER_SHEATH: RGB = [1.0, 0.5, 0.07];
/** Razor-thin incandescent plasma centerline. */
const CORE: RGB = [1.0, 0.94, 0.8];

export const SLOW_STEP = 0.25;
export const EXCITE_PERIOD = 18;
const SEED = 0x4e10;

interface Layout {
  readonly cx: number;
  readonly cy: number;
  readonly rMain: number;
  readonly floorY: number;
  readonly tubeScale: number;
}

function layoutFor(fw: number, fh: number): Layout {
  const rMain = Math.max(8, Math.min(fw * 0.21, fh * 0.33));
  return {
    cx: fw * 0.72,
    cy: fh * 0.34,
    rMain,
    floorY: fh * 0.82,
    tubeScale: Math.max(1, Math.min(1.48, rMain / 15)),
  };
}

interface RingSpec {
  readonly radius: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly roll: number;
  readonly spinSpeed: number;
  readonly striationFreq: number;
  readonly striationSpeed: number;
  readonly primary: RGB;
  readonly halo: RGB;
  readonly phase: number;
  readonly weight: number;
}

function ringsFor(g: Layout, t: number): readonly RingSpec[] {
  return [
    // Primary steeply tilted 640 nm vermilion-scarlet ring.
    {
      radius: g.rMain,
      tiltX: 1.06 + 0.14 * Math.sin(t * 0.21),
      tiltY: -0.44 + 0.12 * Math.cos(t * 0.17),
      roll: -0.42 + 0.08 * Math.sin(t * 0.13),
      spinSpeed: 0.42,
      striationFreq: 8,
      striationSpeed: 4.0,
      primary: VERMILION,
      halo: MAGENTA_BLOOM,
      phase: 0,
      weight: 1.05,
    },
    // Counter-tilted crossing electric-magenta orbital ring (interlocks with primary).
    {
      radius: g.rMain * 0.94,
      tiltX: -0.98 + 0.15 * Math.cos(t * 0.24 + 1.1),
      tiltY: 0.56 + 0.13 * Math.sin(t * 0.19 + 0.6),
      roll: 0.52 + 0.09 * Math.cos(t * 0.15),
      spinSpeed: -0.52,
      striationFreq: 7,
      striationSpeed: -4.4,
      primary: ELECTRIC_PINK,
      halo: MAGENTA_BLOOM,
      phase: 2.1,
      weight: 0.95,
    },
    // Sleek equatorial hot-amber/vermilion plasma belt slicing across the middle.
    {
      radius: g.rMain * 0.76,
      tiltX: 1.24 + 0.09 * Math.sin(t * 0.27 + 2.3),
      tiltY: 0.12 + 0.1 * Math.cos(t * 0.22),
      roll: 0.12 + 0.07 * Math.sin(t * 0.16),
      spinSpeed: 0.68,
      striationFreq: 6,
      striationSpeed: 5.1,
      primary: AMBER_SHEATH,
      halo: VERMILION,
      phase: 4.0,
      weight: 0.84,
    },
  ];
}

interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function projectRingPoint(g: Layout, ring: RingSpec, angle: number): ProjectedPoint {
  const lx = Math.cos(angle) * ring.radius;
  const ly = Math.sin(angle) * ring.radius;

  const cx = Math.cos(ring.tiltX);
  const sx = Math.sin(ring.tiltX);
  const y1 = ly * cx;
  const z1 = ly * sx;

  const cy = Math.cos(ring.tiltY);
  const sy = Math.sin(ring.tiltY);
  const x2 = lx * cy + z1 * sy;
  const z2 = -lx * sy + z1 * cy;

  const cr = Math.cos(ring.roll);
  const sr = Math.sin(ring.roll);
  const x3 = x2 * cr - y1 * sr;
  const y3 = x2 * sr + y1 * cr;

  return { x: g.cx + x3, y: g.cy + y3, z: z2 / Math.max(1, ring.radius) };
}

/** Graceful S-curved left-flank neon plasma stream, framing the left side clear of the composer. */
function ribbonPoint(fw: number, fh: number, u: number, t: number): { x: number; y: number } {
  const baseX = fw * (0.06 + 0.21 * Math.pow(u, 1.3) + 0.045 * Math.sin(u * Math.PI * 1.15));
  const baseY = fh * (0.78 - 0.68 * Math.pow(u, 0.82));
  const env = Math.sin(Math.PI * u);
  const waveY = Math.sin(u * 5.8 - t * 1.35) * (fh * 0.036) * (0.25 + 0.75 * env);
  const waveX = Math.cos(u * 7.2 + t * 1.05) * (fw * 0.015) * (0.25 + 0.75 * env);
  return { x: baseX + waveX, y: baseY + waveY };
}

/** Slow darkroom midnight mist, volumetric neon spill, and light-caught obsidian horizon. */
function slowDarkroom(
  g: Layout,
  x: number,
  y: number,
  fw: number,
  fh: number,
  t: number,
  out: Float32Array,
  o: number,
): void {
  const n1 = noise(x * 0.34 + t * 0.055, y * 0.38 - t * 0.045);
  const n2 = noise(x * 0.62 - t * 0.04 + 43, y * 0.62 + t * 0.03 + 17);
  const mist = smoothstep(0.24, 0.92, n1) * 0.32;
  const cobaltWisp = smoothstep(0.58, 0.96, n2) * smoothstep(0.1, 0.95, 1 - x / Math.max(1, fw)) * 0.14;

  let r = MIDNIGHT[0] * mist + COBALT_MIST[0] * cobaltWisp;
  let gCh = MIDNIGHT[1] * mist + COBALT_MIST[1] * cobaltWisp;
  let b = MIDNIGHT[2] * mist + COBALT_MIST[2] * cobaltWisp;

  // Soft volumetric crimson-magenta spill around the right orbital chamber.
  const dr = Math.hypot((x - g.cx) / (g.rMain * 1.65), (y - g.cy) / (g.rMain * 1.45));
  const chamberGlow = Math.exp(-dr * dr * 1.55) * 0.2 + Math.exp(-dr * 2.3) * 0.08;
  r += MAGENTA_BLOOM[0] * chamberGlow * 0.72 + VERMILION[0] * chamberGlow * 0.3;
  gCh += MAGENTA_BLOOM[1] * chamberGlow * 0.72 + VERMILION[1] * chamberGlow * 0.3;
  b += MAGENTA_BLOOM[2] * chamberGlow * 0.88;

  // Subtle ambient warm glow hugging the left plasma stream.
  const nx = x / Math.max(1, fw);
  const ny = y / Math.max(1, fh);
  const leftPath = 0.065 + 0.22 * Math.pow(Math.max(0, 1 - ny / 0.82), 1.25);
  const leftCorridor = Math.exp(-Math.pow((nx - leftPath) / 0.13, 2)) * smoothstep(0.86, 0.1, ny) * 0.12;
  r += MAGENTA_BLOOM[0] * leftCorridor * 0.55 + VERMILION[0] * leftCorridor * 0.45;
  gCh += VERMILION[1] * leftCorridor * 0.4;
  b += MAGENTA_BLOOM[2] * leftCorridor * 0.65;

  // Floor horizon catches light only beneath the neon sculptures, fading into dark obsidian elsewhere.
  const underRight = Math.exp(-Math.pow((x - g.cx) / (g.rMain * 1.4), 2));
  const underLeft = Math.exp(-Math.pow((nx - 0.13) / 0.15, 2));
  const floorLight = (underRight * 0.9 + underLeft * 0.7) * (0.75 + 0.25 * n2);
  const floorEdge = Math.exp(-Math.pow((y - g.floorY) / 1.15, 2)) * 0.15 * floorLight;
  r += MAGENTA_BLOOM[0] * floorEdge * 0.6 + VERMILION[0] * floorEdge * 0.35 + COBALT_MIST[0] * floorEdge * 0.5;
  gCh += VERMILION[1] * floorEdge * 0.3 + COBALT_MIST[1] * floorEdge * 0.5;
  b += MAGENTA_BLOOM[2] * floorEdge * 0.75 + COBALT_MIST[2] * floorEdge * 0.8;

  out[o] = r;
  out[o + 1] = gCh;
  out[o + 2] = b;
}

/** Paint a horizontally rippled obsidian-floor reflection streak in pure field coordinates. */
function paintReflectionTap(
  frame: Frame,
  win: SceneWindow,
  floorY: number,
  fh: number,
  px: number,
  py: number,
  t: number,
  c: RGB,
  power: number,
  scale: number,
): void {
  if (py >= floorY) return;
  const distAbove = floorY - py;
  const ry = floorY + distAbove * 0.3;
  if (ry > fh + 2) return;
  const fade = Math.exp(-distAbove / Math.max(8, (fh - floorY) * 2.8)) * power;
  if (fade < 0.014) return;
  const ripple =
    Math.sin(ry * 0.85 - t * 2.8 + px * 0.1) * (1.3 + distAbove * 0.05) +
    (noise(px * 0.2 + t * 0.5, ry * 0.5) - 0.5) * 2.8;
  const rx = px + ripple;
  const spread = 1.7 * scale;
  splat(frame, win, rx, ry, 1.15 * scale, c[0] * fade * 0.46, c[1] * fade * 0.44, c[2] * fade * 0.5);
  splat(frame, win, rx - spread, ry, 1.25 * scale, c[0] * fade * 0.22, c[1] * fade * 0.2, c[2] * fade * 0.26);
  splat(frame, win, rx + spread, ry, 1.25 * scale, c[0] * fade * 0.22, c[1] * fade * 0.2, c[2] * fade * 0.26);
}

/** Crackling electric neon plasma filament between two field pixels. */
function drawArc(
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
  tint: RGB,
  scale: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx = -dy / len;
  const ny = dx / len;
  const steps = Math.max(10, Math.min(68, Math.ceil(len * 1.45)));
  const norm = len / steps;
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const env = Math.sin(Math.PI * u);
    const nWave = (noise(u * 5.4 + salt, t * 1.7 + salt * 0.7) - 0.5) * 2;
    const snap = Math.sin(u * 16 - t * 5.8 + salt * 2.3) * 0.34;
    const off = env * (nWave + snap) * wiggle;
    const px = x0 + dx * u + nx * off;
    const py = y0 + dy * u + ny * off;
    const bright = intensity * (0.44 + 0.56 * env) * norm;
    splat(frame, win, px, py, 0.52 * scale, CORE[0] * 0.72 * bright, AMBER_SHEATH[1] * 0.72 * bright, CORE[2] * 0.48 * bright);
    splat(frame, win, px, py, 1.7 * scale, tint[0] * 0.24 * bright, tint[1] * 0.22 * bright, tint[2] * 0.27 * bright);
  }
}

export function createNeonScene(): SceneEngine {
  let hazeCache: Float32Array | null = null;
  let hazeKey = "";

  return {
    frameMs: 50,
    paint(frame: Frame, win: SceneWindow, t: number, pointer: Pointer | null): void {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const g = layoutFor(fw, fh);
      const ts = g.tubeScale;

      const slowT = Math.floor(t / SLOW_STEP) * SLOW_STEP;
      const key = `${win.x},${win.y},${win.width},${win.height},${fw},${fh},${slowT}`;
      if (!hazeCache || key !== hazeKey) {
        if (!hazeCache || hazeCache.length !== frame.light.length) {
          hazeCache = new Float32Array(frame.light.length);
        }
        for (let py = 0; py < frame.height * 2; py++) {
          const fy = win.y * 2 + py;
          for (let px = 0; px < frame.width; px++) {
            slowDarkroom(g, win.x + px, fy, fw, fh, slowT, hazeCache, (py * frame.width + px) * 3);
          }
        }
        hazeKey = key;
      }
      frame.light.set(hazeCache);

      // Periodic high-voltage excitation wave peaking mid-cycle (t = 9s for gallery).
      const cyclePhase = (((t / EXCITE_PERIOD) % 1) + 1) % 1;
      const surgeBell = Math.exp(-Math.pow((cyclePhase - 0.5) / 0.11, 2));
      const surge = 1 + 0.55 * surgeBell;
      const hum = 0.96 + 0.04 * Math.sin(t * 21.3);
      const rings = ringsFor(g, t);

      // Track closest luminous point on the rings and on the left ribbon for capacitive pointer arcs.
      let nearRingDist = Infinity;
      let nearRingX = g.cx;
      let nearRingY = g.cy;
      let nearRibbonDist = Infinity;
      let nearRibbonX = fw * 0.15;
      let nearRibbonY = fh * 0.45;

      // 1. Three slender interlocking 3D precessing neon orbital rings.
      for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri]!;
        const steps = Math.max(54, Math.min(124, Math.round(ring.radius * 4.8)));
        const arcStep = (Math.PI * 2 * ring.radius) / steps;
        const stepNorm = Math.min(1.5, arcStep * 0.62);
        const packetA = (t * (0.95 + ri * 0.35) + ring.phase) % (Math.PI * 2);
        const packetB = (packetA + Math.PI) % (Math.PI * 2);

        for (let i = 0; i < steps; i++) {
          const theta = (i / steps) * Math.PI * 2 + t * ring.spinSpeed;
          const pt = projectRingPoint(g, ring, theta);
          if (pointer && pointer.strength > 0.01) {
            const d = Math.hypot(pointer.x - pt.x, pointer.y - pt.y);
            if (d >= 6 && d < nearRingDist) {
              nearRingDist = d;
              nearRingX = pt.x;
              nearRingY = pt.y;
            }
          }

          // Strong 3D front/back separation so interlocking rings read unmistakably in depth.
          const front = smoothstep(-0.85, 0.85, pt.z);
          const depth = 0.4 + 0.72 * front;
          // Distinct moving ionization striations (luminous plasma beads gliding along the tube).
          const striationWave = 0.5 + 0.5 * Math.sin(theta * ring.striationFreq - t * ring.striationSpeed + ring.phase);
          const striation = 0.56 + 0.58 * Math.pow(striationWave, 2.2);

          // Fast-orbiting high-energy plasma packets.
          const dA = Math.atan2(Math.sin(theta - packetA), Math.cos(theta - packetA));
          const dB = Math.atan2(Math.sin(theta - packetB), Math.cos(theta - packetB));
          const packet = Math.exp(-(dA * dA) / 0.11) * 1.2 + Math.exp(-(dB * dB) / 0.16) * 0.58;

          const energy = depth * striation * (0.92 + packet) * surge * hum * ring.weight * stepNorm;
          const coreHot = (0.24 + 0.58 * packet + 0.26 * front) * energy;

          // Wide saturated crimson-magenta halation (sampled every 3rd step to keep center dark & crisp).
          if (i % 3 === 0) {
            splat(
              frame,
              win,
              pt.x,
              pt.y,
              2.6 * ts,
              ring.halo[0] * 0.095 * energy,
              ring.halo[1] * 0.095 * energy,
              ring.halo[2] * 0.11 * energy,
            );
          }
          // Slender vibrant neon tube sheath.
          splat(
            frame,
            win,
            pt.x,
            pt.y,
            0.96 * ts,
            ring.primary[0] * 0.42 * energy,
            ring.primary[1] * 0.4 * energy,
            ring.primary[2] * 0.4 * energy,
          );
          // Razor-sharp hot incandescent filament centerline.
          splat(
            frame,
            win,
            pt.x,
            pt.y,
            0.47 * ts,
            (CORE[0] * coreHot + AMBER_SHEATH[0] * 0.34 * energy) * 0.66,
            (CORE[1] * coreHot * 0.72 + AMBER_SHEATH[1] * 0.32 * energy) * 0.66,
            (CORE[2] * coreHot * 0.44 + ring.primary[2] * 0.18 * energy) * 0.66,
          );

          if (i % 3 === 0) {
            paintReflectionTap(frame, win, g.floorY, fh, pt.x, pt.y, t, ring.primary, 0.58 * energy, ts);
          }
        }

        // Orbiting bright discharge spark heads along each ring.
        const head = projectRingPoint(g, ring, packetA);
        splat(frame, win, head.x, head.y, 1.0 * ts, CORE[0] * 1.25 * surge, CORE[1] * 0.9 * surge, CORE[2] * 0.56 * surge);
        splat(frame, win, head.x, head.y, 2.9 * ts, ring.primary[0] * 0.36 * surge, ring.primary[1] * 0.3 * surge, ring.halo[2] * 0.36 * surge);

        // During high-voltage excitation, crisp plasma arcs briefly bridge the cathode to the rings.
        if (surgeBell > 0.22 && ri < 2) {
          drawArc(
            frame,
            win,
            g.cx,
            g.cy,
            head.x,
            head.y,
            t * 1.4,
            13.7 + ri * 41,
            surgeBell * 0.9,
            Math.max(1.8, ring.radius * 0.16),
            ring.primary,
            ts,
          );
        }
      }

      // 2. Pulsing central Ne-10 cathode nucleus inside the interlocking rings.
      const corePulse = (0.74 + 0.28 * Math.sin(t * 2.4)) * surge;
      splat(frame, win, g.cx, g.cy, 1.0 * ts, CORE[0] * 1.1 * corePulse, AMBER_SHEATH[1] * 0.88 * corePulse, CORE[2] * 0.5 * corePulse);
      splat(frame, win, g.cx, g.cy, 3.0 * ts, VERMILION[0] * 0.38 * corePulse, VERMILION[1] * 0.22 * corePulse, MAGENTA_BLOOM[2] * 0.36 * corePulse);
      putGlyph(
        frame,
        win,
        g.cx,
        g.cy / 2,
        surgeBell > 0.35 ? "✦" : "✧",
        CORE[0] * (0.62 + 0.45 * surgeBell),
        AMBER_SHEATH[1] * (0.62 + 0.45 * surgeBell),
        CORE[2] * (0.48 + 0.42 * surgeBell),
      );

      // 3. Slender braided pair of undulating left-flank neon plasma filaments.
      const ribbonSteps = 64;
      const ribbonPulseU = (((t * 0.22 + 0.18) % 1.4) + 1.4) % 1.4 - 0.2;
      for (let i = 0; i <= ribbonSteps; i++) {
        const u = i / ribbonSteps;
        const pt = ribbonPoint(fw, fh, u, t);
        if (pointer && pointer.strength > 0.01) {
          const d = Math.hypot(pointer.x - pt.x, pointer.y - pt.y);
          if (d >= 6 && d < nearRibbonDist) {
            nearRibbonDist = d;
            nearRibbonX = pt.x;
            nearRibbonY = pt.y;
          }
        }

        const taper = smoothstep(0, 0.08, u) * smoothstep(0, 0.1, 1 - u);
        const bead = 0.58 + 0.58 * Math.pow(0.5 + 0.5 * Math.sin(u * 28 - t * 4.6), 2.2);
        const waveHead = Math.exp(-Math.pow((u - ribbonPulseU) / 0.09, 2)) * 1.3;
        const energy = (0.3 + 0.7 * taper) * bead * (0.88 + waveHead) * surge * hum * 0.72;

        if (i % 3 === 0) {
          splat(
            frame,
            win,
            pt.x,
            pt.y,
            2.5 * ts,
            MAGENTA_BLOOM[0] * 0.1 * energy,
            MAGENTA_BLOOM[1] * 0.09 * energy,
            MAGENTA_BLOOM[2] * 0.12 * energy,
          );
        }
        // Main 640 nm vermilion-scarlet filament.
        splat(
          frame,
          win,
          pt.x,
          pt.y,
          0.92 * ts,
          VERMILION[0] * 0.48 * energy,
          VERMILION[1] * 0.42 * energy,
          VERMILION[2] * 0.28 * energy,
        );
        splat(
          frame,
          win,
          pt.x,
          pt.y,
          0.46 * ts,
          CORE[0] * (0.36 + 0.5 * waveHead) * energy,
          AMBER_SHEATH[1] * (0.4 + 0.48 * waveHead) * energy,
          CORE[2] * 0.24 * energy,
        );

        // Braided electric-magenta harmonic companion filament weaving cleanly around it.
        const braidAmp = Math.max(1.8, Math.min(4.4, fw * 0.03)) * taper;
        const bx = pt.x + Math.sin(u * 12.5 - t * 2.1) * braidAmp;
        const by = pt.y + Math.cos(u * 12.5 - t * 2.1) * braidAmp * 0.55;
        splat(
          frame,
          win,
          bx,
          by,
          0.74 * ts,
          ELECTRIC_PINK[0] * 0.34 * energy,
          ELECTRIC_PINK[1] * 0.26 * energy,
          ELECTRIC_PINK[2] * 0.4 * energy,
        );
        splat(
          frame,
          win,
          bx,
          by,
          0.4 * ts,
          CORE[0] * 0.25 * energy,
          ELECTRIC_PINK[1] * 0.3 * energy,
          CORE[2] * 0.28 * energy,
        );

        if (i % 4 === 0) {
          paintReflectionTap(frame, win, g.floorY, fh, pt.x, pt.y, t, VERMILION, 0.56 * energy, ts);
          paintReflectionTap(frame, win, g.floorY, fh, bx, by, t, ELECTRIC_PINK, 0.36 * energy, ts);
        }
      }

      // Soft glowing electrode caps at both ends of the left plasma stream.
      for (const endU of [0.02, 0.98]) {
        const cap = ribbonPoint(fw, fh, endU, t);
        splat(frame, win, cap.x, cap.y, 1.05 * ts, CORE[0] * 0.72 * surge, AMBER_SHEATH[1] * 0.6 * surge, CORE[2] * 0.34 * surge);
        splat(frame, win, cap.x, cap.y, 2.5 * ts, VERMILION[0] * 0.26 * surge, VERMILION[1] * 0.18 * surge, MAGENTA_BLOOM[2] * 0.28 * surge);
      }

      // 4. Drifting ionized sparks and shimmering gas-discharge glints.
      const sparkCount = 28;
      for (let i = 0; i < sparkCount; i++) {
        const life = (((t * (0.045 + hash2(i, 1, SEED) * 0.05) + hash2(i, 2, SEED)) % 1) + 1) % 1;
        const onRing = i % 3 !== 0;
        let sx: number;
        let sy: number;
        if (onRing) {
          const ang = hash2(i, 3, SEED) * Math.PI * 2 + t * 0.09 * (i % 2 === 0 ? 1 : -1);
          const rad = g.rMain * (0.3 + 0.95 * hash2(i, 4, SEED));
          sx = g.cx + Math.cos(ang) * rad;
          sy = g.cy + Math.sin(ang) * rad * 0.85 - life * 10;
        } else {
          const pt = ribbonPoint(fw, fh, hash2(i, 3, SEED), t * 0.5);
          sx = pt.x + (hash2(i, 4, SEED) - 0.5) * 12 + Math.sin(t * 0.9 + i) * 2.2;
          sy = pt.y - life * 14;
        }
        const tw = 0.45 + 0.55 * Math.sin(t * (1.8 + hash2(i, 5, SEED) * 2.2) + i * 2.7);
        const fade = Math.sin(Math.PI * life) * (0.28 + 0.42 * hash2(i, 6, SEED)) * tw;
        const hue = i % 3 === 0 ? ELECTRIC_PINK : i % 3 === 1 ? AMBER_SHEATH : CORE;
        if (i % 6 === 0) {
          putGlyph(frame, win, sx, sy / 2, i % 12 === 0 ? "✧" : "·", hue[0] * fade * 1.1, hue[1] * fade * 1.1, hue[2] * fade * 1.1);
        } else {
          addPixel(frame, Math.floor(sx) - win.x, Math.floor(sy) - win.y * 2, hue[0] * fade, hue[1] * fade, hue[2] * fade);
        }
      }

      // 5. Capacitive pointer discharge: forked electric neon arcs bridging to the cursor.
      if (pointer && pointer.strength > 0.01) {
        const s = pointer.strength;
        const fromCathode = Math.hypot(pointer.x - g.cx, pointer.y - g.cy);
        const a1x = fromCathode >= 5 ? g.cx : nearRingX;
        const a1y = fromCathode >= 5 ? g.cy : nearRingY;
        const span1 = Math.hypot(pointer.x - a1x, pointer.y - a1y);
        drawArc(frame, win, a1x, a1y, pointer.x, pointer.y, t * 1.4, 19.7, 1.2 * s, Math.min(7.5, Math.max(2.0, span1 * 0.24)), VERMILION, ts);
        // Second arc bridges from the left plasma ribbon when the cursor sits between the two sculptures.
        const useRibbon = nearRibbonDist < Math.max(fw * 0.45, nearRingDist * 2.2);
        const a2x = useRibbon ? nearRibbonX : nearRingX;
        const a2y = useRibbon ? nearRibbonY : nearRingY;
        const span2 = Math.hypot(pointer.x - a2x, pointer.y - a2y);
        drawArc(frame, win, a2x, a2y, pointer.x, pointer.y, t * 1.1, 83.1, 0.85 * s, Math.min(8.5, Math.max(2.2, span2 * 0.24)), ELECTRIC_PINK, ts);
        // Sizzling white-hot contact node + crimson-magenta ionization bloom.
        splat(frame, win, pointer.x, pointer.y, 1.25 * ts, CORE[0] * 1.45 * s, AMBER_SHEATH[1] * 1.25 * s, CORE[2] * 0.92 * s);
        splat(frame, win, pointer.x, pointer.y, 4.6 * ts, VERMILION[0] * 0.46 * s, VERMILION[1] * 0.24 * s, MAGENTA_BLOOM[2] * 0.54 * s);
        paintReflectionTap(frame, win, g.floorY, fh, pointer.x, pointer.y, t, VERMILION, 0.7 * s, ts);
      }
    },
  };
}

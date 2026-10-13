import { hash2, putGlyph, smoothstep, splat, type Frame, type Pointer, type SceneEngine, type SceneWindow } from "./raster.js";

/**
 * Sonnet — the "little song", drawn as its own anatomy.
 *
 * Fourteen strings of light, one per line, woven into a silk ribbon that
 * sweeps across the view and slowly twists through itself. They are
 * coloured by the Shakespearean rhyme scheme — ABAB CDCD EFEF GG — so
 * lines that rhyme share a colour, and they resonate together.
 *
 * The scene recites: one line every `LINE_S` seconds, its ten syllables
 * lighting left to right in iambic pentameter (da-DUM ×5, the stressed
 * beats brighter). Each line is plucked as it is read and rings out along
 * the string; its rhyme partner vibrates in sympathy. At the closing
 * couplet the volta comes round — the whole ribbon turns toward gold.
 *
 * Behind it, soft out-of-focus lights drift upward through a twilight
 * haze. The pointer presses the strings aside like a fingertip, and
 * dragging across them strums them.
 *
 * Everything is a pure function of (field position, t, pointer) except
 * strums, which need the pointer's previous position — the one piece of
 * state, kept per engine.
 */

type RGB = readonly [number, number, number];

/** Rhyme colours: A rose, B lavender, C teal, D amber, E sky, F mint, G gold. */
const RHYME: readonly RGB[] = [
  [1.0, 0.5, 0.6],
  [0.66, 0.56, 1.0],
  [0.36, 0.86, 0.84],
  [1.0, 0.72, 0.38],
  [0.48, 0.7, 1.0],
  [0.52, 0.95, 0.68],
  [1.0, 0.86, 0.6],
];
/** Line → rhyme: ABAB CDCD EFEF GG. */
const SCHEME = [0, 1, 0, 1, 2, 3, 2, 3, 4, 5, 4, 5, 6, 6] as const;
const LINES = 14;
const GOLD: RGB = [1.0, 0.86, 0.6];
const HAZE: RGB = [0.5, 0.36, 0.7];
const DUSK: RGB = [0.1, 0.04, 0.12];

/** Seconds per recited line: a full sonnet takes 42 s. */
const LINE_S = 3;
const SLOW_STEP = 0.25;
const SEED = 0x50e7;

/** The rhyming partner of a line (the couplet's two lines pair with each other). */
function partnerOf(line: number): number {
  for (let j = 0; j < LINES; j++) if (j !== line && SCHEME[j] === SCHEME[line]) return j;
  return line;
}

interface Pluck {
  line: number;
  x: number;
  t0: number;
  amp: number;
}

/** Where the ribbon's spine runs and how far it fans, at field pixel x. */
function ribbon(x: number, fw: number, fh: number, t: number): { centre: number; spread: number } {
  const u = x / fw;
  const centre = fh * (0.6 - 0.44 * u) + fh * 0.07 * Math.sin(u * 4.2 + t * 0.11) + fh * 0.03 * Math.sin(u * 9.1 - t * 0.17);
  // The fan passes through zero and flips: the ribbon twists through itself.
  const twist = Math.sin(u * 2.6 - t * 0.07 + 1.2);
  return { centre, spread: fh * 0.024 * twist };
}

/** A string's resting height at x, before plucks and the pointer. */
function restY(line: number, x: number, fw: number, fh: number, t: number): number {
  const { centre, spread } = ribbon(x, fw, fh, t);
  return centre + (line - 6.5) * spread + 0.6 * Math.sin((x / fw) * 13 + line * 0.7 + t * 0.4);
}

/** A ringing wave packet spreading out from where a string was plucked. */
function ring(pluck: Pluck, x: number, t: number): number {
  const age = t - pluck.t0;
  if (age < 0 || age > 4) return 0;
  const dx = x - pluck.x;
  const width = 6 + 45 * age;
  return pluck.amp * Math.exp(-age / 0.9) * Math.exp(-(dx * dx) / (width * width)) * Math.sin(0.45 * dx - 11 * age);
}

/** The recitation's plucks: the line being read, the two before it, and their rhyme partners. */
function recitationPlucks(fw: number, t: number): Pluck[] {
  const plucks: Pluck[] = [];
  const index = Math.floor(t / LINE_S);
  for (let back = 0; back < 3; back++) {
    const n = index - back;
    const line = ((n % LINES) + LINES) % LINES;
    const t0 = n * LINE_S;
    const x = fw * (0.08 + 0.1 * hash2(n, 0, SEED));
    plucks.push({ line, x, t0, amp: 2.2 });
    plucks.push({ line: partnerOf(line), x, t0: t0 + 0.08, amp: 0.8 });
  }
  return plucks;
}

function slowLight(fw: number, fh: number, x: number, y: number, t: number, out: Float32Array, o: number): void {
  const v = y / fh;
  // Twilight: deeper toward the bottom, a haze hugging the ribbon.
  const dusk = smoothstep(0.1, 1.0, v) * 0.7;
  const { centre } = ribbon(x, fw, fh, t);
  const haze = Math.exp(-Math.abs(y - centre) / (fh * 0.14)) * 0.13;
  let r = DUSK[0] * dusk + HAZE[0] * haze;
  let g = DUSK[1] * dusk + HAZE[1] * haze;
  let b = DUSK[2] * dusk + HAZE[2] * haze;
  // Bokeh: soft discs drifting upward, a little brighter at the rim.
  for (let i = 0; i < 9; i++) {
    const radius = 5 + hash2(i, 1, SEED + 5) * 9;
    const speed = 0.4 + hash2(i, 2, SEED + 5) * 0.8;
    const span = fh + radius * 4;
    const by = fh + radius * 2 - ((hash2(i, 3, SEED + 5) * span + t * speed) % span);
    const bx = fw * hash2(i, 4, SEED + 5) + Math.sin(t * 0.05 + i) * 6;
    const d = Math.hypot(x - bx, y - by);
    if (d > radius + 1) continue;
    const disc = 1 - smoothstep(radius - 1.5, radius + 0.5, d);
    const rim = Math.exp(-Math.pow((d - radius + 1) / 1.1, 2)) * 0.5;
    const c = RHYME[i % RHYME.length]!;
    const w = (disc * 0.05 + rim * 0.05) * (0.6 + 0.4 * hash2(i, 5, SEED + 5));
    r += c[0] * w;
    g += c[1] * w;
    b += c[2] * w;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

/** Motes: a few glyphs of dust drifting up through the light. */
function paintMotes(frame: Frame, win: SceneWindow, t: number): void {
  const count = Math.round((win.fieldWidth * win.fieldHeight) / 420);
  for (let i = 0; i < count; i++) {
    const speed = 0.15 + hash2(i, 1, SEED + 9) * 0.35;
    const y = win.fieldHeight - ((hash2(i, 2, SEED + 9) * win.fieldHeight + t * speed) % win.fieldHeight);
    const x = hash2(i, 3, SEED + 9) * win.fieldWidth + Math.sin(t * 0.3 + i) * 1.5;
    const b = 0.5 + 0.5 * Math.sin(t * (0.6 + hash2(i, 4, SEED + 9)) + i);
    const c = RHYME[i % RHYME.length]!;
    const w = 0.15 + 0.35 * b;
    putGlyph(frame, win, x, y, b > 0.8 ? "˙" : "·", c[0] * w, c[1] * w, c[2] * w);
  }
}

export function createSonnetScene(): SceneEngine {
  let slow: Float32Array | null = null;
  let slowKey = "";
  let slowT = Number.NaN;
  let strums: Pluck[] = [];
  let last: Pointer | null = null;

  return {
    frameMs: 50,
    paint(frame, win, t, pointer) {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const key = `${win.x},${win.y},${win.width},${win.height},${fw},${fh}`;
      const ts = Math.floor(t / SLOW_STEP) * SLOW_STEP;
      if (slow === null || slowKey !== key || slowT !== ts) {
        if (slow === null || slow.length !== win.width * win.height * 6) slow = new Float32Array(win.width * win.height * 6);
        for (let py = 0; py < win.height * 2; py++) {
          for (let px = 0; px < win.width; px++) {
            slowLight(fw, fh, win.x + px + 0.5, win.y * 2 + py + 0.5, ts, slow, (py * win.width + px) * 3);
          }
        }
        slowKey = key;
        slowT = ts;
      }
      frame.light.set(slow);

      // Strums: the pointer crossing a string between two frames plucks it there.
      if (pointer && last && pointer.strength > 0.3 && Math.abs(pointer.x - last.x) < 40) {
        for (let line = 0; line < LINES; line++) {
          const before = last.y - restY(line, last.x, fw, fh, t);
          const now = pointer.y - restY(line, pointer.x, fw, fh, t);
          if (before !== 0 && Math.sign(before) !== Math.sign(now)) {
            strums.push({ line, x: pointer.x, t0: t, amp: 2.6 });
            strums.push({ line: partnerOf(line), x: pointer.x, t0: t + 0.06, amp: 0.9 });
          }
        }
      }
      last = pointer;
      strums = strums.filter((pluck) => t - pluck.t0 < 4 && t >= pluck.t0 - 1);
      const plucks = [...recitationPlucks(fw, t), ...strums];

      const index = Math.floor(t / LINE_S);
      const reading = ((index % LINES) + LINES) % LINES;
      const age = t - index * LINE_S;
      const partner = partnerOf(reading);
      // The volta: through the couplet, the ribbon turns toward gold.
      const volta = reading >= 12 ? Math.sin((Math.PI * ((reading - 12) * LINE_S + age)) / (2 * LINE_S)) : 0;

      for (let line = 0; line < LINES; line++) {
        const base = RHYME[SCHEME[line]!]!;
        const c: RGB = [
          base[0] + (GOLD[0] - base[0]) * volta * 0.6,
          base[1] + (GOLD[1] - base[1]) * volta * 0.6,
          base[2] + (GOLD[2] - base[2]) * volta * 0.6,
        ];
        const lit = line === reading ? 1 : line === partner ? 0.45 : 0;
        const env = lit * Math.sin((Math.PI * Math.min(age, LINE_S)) / LINE_S);
        const glow = 0.27 + 0.45 * env + 0.16 * volta;
        const own = plucks.filter((pluck) => pluck.line === line);
        // One vertical profile per column: a line's thickness measured
        // straight down is its true thickness × √(1 + slope²). Each column
        // lights only itself, so panes meet without a seam.
        let prev = restY(line, win.x - 0.5, fw, fh, t);
        for (let px = 0; px < win.width; px++) {
          const x = win.x + px + 0.5;
          const rest = restY(line, x, fw, fh, t);
          const slope = rest - prev;
          prev = rest;
          let y = rest;
          for (const pluck of own) y += ring(pluck, x, t);
          if (pointer && pointer.strength > 0.05) {
            // A fingertip pressing the strings aside.
            const dx = x - pointer.x;
            const dy = y - pointer.y;
            const push = 7 * pointer.strength * Math.exp(-(dx * dx) / 64) * Math.exp(-(dy * dy) / 100);
            y += (dy >= 0 ? 1 : -1) * push;
          }
          const sigma = 0.62 * Math.sqrt(1 + slope * slope);
          const wy = y - win.y * 2;
          const reach = Math.ceil(sigma * 3);
          const inv = 1 / (2 * sigma * sigma);
          for (let py = Math.max(0, Math.floor(wy) - reach); py <= Math.min(win.height * 2 - 1, Math.floor(wy) + reach); py++) {
            const d = py + 0.5 - wy;
            const w = glow * Math.exp(-d * d * inv);
            const o = (py * win.width + px) * 3;
            frame.light[o]! += c[0] * w;
            frame.light[o + 1]! += c[1] * w;
            frame.light[o + 2]! += c[2] * w;
          }
        }
        // The meter: ten syllables lit left to right, the stresses brighter.
        if (lit === 1) {
          for (let syllable = 0; syllable < 10; syllable++) {
            const at = (syllable + 0.5) * (LINE_S * 0.8) / 10;
            if (age < at) break;
            const fade = Math.exp(-(age - at) / 0.9);
            const stress = syllable % 2 === 1 ? 1 : 0.45;
            const x = fw * (0.12 + 0.078 * syllable);
            let y = restY(line, x, fw, fh, t);
            for (const pluck of own) y += ring(pluck, x, t);
            const w = 1.1 * stress * fade;
            splat(frame, win, x, y, 1.1 + 0.5 * stress, c[0] * w, c[1] * w, c[2] * w);
          }
        }
      }

      if (pointer && pointer.strength > 0.05) {
        const w = 0.1 * pointer.strength;
        splat(frame, win, pointer.x, pointer.y, 3.5, 0.8 * w, 0.75 * w, w);
      }
      paintMotes(frame, win, t);
    },
  };
}

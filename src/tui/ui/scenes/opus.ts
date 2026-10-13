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
 * Opus — the magnum opus: a grand spiral galaxy turning in the dark.
 *
 * Caynac's starfield painted glyph particles through React spans; this
 * paints light. Back to front:
 *
 * - a domain-warped plum/indigo nebula drifting behind everything;
 * - a tilted two-arm logarithmic spiral in Anthropic's clay and ivory —
 *   the arm *pattern* turns rigidly (density-wave style) while its dust
 *   lanes and star clouds shear with differential rotation, inner faster;
 * - a ✻ spark at the nucleus: eight diffraction spikes, Claude's mark;
 * - pixel stars that twinkle, glyph stars that swell ·→⋆→✧→✦, and a few
 *   hero stars with four-point spikes;
 * - a comet every so often (straight blue ion tail, curved warm dust
 *   tail) and brief meteors;
 * - under the pointer, a point-mass gravitational lens: background light
 *   is resampled through the lens equation, stars split into the two
 *   images a real lens makes, and a photon ring rims the shadow.
 *
 * Nebula and galaxy move sub-pixel per second, so they are evaluated on a
 * slow clock (`SLOW_STEP`) and cached; only the sparse fast layers are
 * redrawn every frame.
 */

type RGB = readonly [number, number, number];

const IVORY: RGB = [1.0, 0.94, 0.84];
const GOLD: RGB = [1.0, 0.7, 0.42];
/** Anthropic clay — `providerColor`'s #DE7356. */
const CLAY: RGB = [0.87, 0.45, 0.34];
const ROSE: RGB = [1.0, 0.46, 0.56];
const MAUVE: RGB = [0.5, 0.32, 0.5];
const BLUE: RGB = [0.6, 0.74, 1.0];
const PLUM: RGB = [0.26, 0.06, 0.2];
const INDIGO: RGB = [0.07, 0.08, 0.3];
const EMBER: RGB = [0.42, 0.14, 0.06];

/** Seconds per slow-layer evaluation. Sub-pixel motion hides the steps. */
export const SLOW_STEP = 0.25;
/** Pattern speed of the spiral arms (rad/s): one turn in ~15 minutes. */
const PATTERN_SPEED = (Math.PI * 2) / 900;
/** Spiral winding: 1 / tan(pitch), pitch ≈ 17°. */
const WINDING = 3.2;

const SEED = 0x0b05;

interface Layout {
  cx: number;
  cy: number;
  r: number;
  cos: number;
  sin: number;
  incl: number;
}

/** Galaxy placement in field pixels: upper right, clear of the composer. */
function layout(fieldWidth: number, fieldHeight: number): Layout {
  const fw = fieldWidth;
  const fh = fieldHeight * 2;
  const pa = -0.36;
  return {
    cx: fw * 0.64,
    cy: fh * 0.36,
    r: Math.max(10, Math.min(fw * 0.36, fh * 0.8)),
    cos: Math.cos(pa),
    sin: Math.sin(pa),
    incl: 0.5,
  };
}

const mix = (a: RGB, b: RGB, t: number, k: number): number => a[k]! + (b[k]! - a[k]!) * t;

/** Nebula + galaxy light at a field pixel. Pure in (x, y, t). */
function slowLight(g: Layout, x: number, y: number, t: number, out: Float32Array, o: number): void {
  // Nebula: fBm warped by two more fBm lookups, drifting a few pixels a minute.
  const qx = x * 0.42;
  const qy = y * 0.5;
  const w1 = noise(qx * 0.8 + t * 0.06, qy * 0.8 - t * 0.04);
  const w2 = noise(qx * 0.8 + 83.1 - t * 0.05, qy * 0.8 + 47.7);
  const n = noise(qx * 1.3 + (w1 - 0.5) * 52, qy * 1.3 + (w2 - 0.5) * 52);
  const cloud = smoothstep(0.32, 0.92, n) * 0.5;
  const hot = smoothstep(0.7, 1.0, n) * 0.4;
  let r = mix(INDIGO, PLUM, w1, 0) * cloud + EMBER[0] * hot;
  let gr = mix(INDIGO, PLUM, w1, 1) * cloud + EMBER[1] * hot;
  let b = mix(INDIGO, PLUM, w1, 2) * cloud + EMBER[2] * hot;

  const dx = x - g.cx;
  const dy = y - g.cy;
  const u = dx * g.cos + dy * g.sin;
  const vRaw = -dx * g.sin + dy * g.cos;
  const v = vRaw / g.incl;
  const rr = Math.sqrt(u * u + v * v) / g.r;

  // Faint warm halo so the galaxy sits *in* the nebula, not on it.
  const halo = Math.exp(-rr / 0.55) * 0.07;
  r += GOLD[0] * halo;
  gr += GOLD[1] * halo;
  b += GOLD[2] * halo;

  if (rr < 1.5) {
    const theta = Math.atan2(v, u);
    const psi = 2 * (theta - PATTERN_SPEED * t) - Math.log(rr + 0.03) * WINDING;
    // Differential rotation for texture: the inner disk shears ahead.
    const spin = (t * 0.03) / (rr + 0.2);
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const tu = u * cs - v * sn;
    const tv = u * sn + v * cs;
    const warp = noise(tu * 0.3 + 17, tv * 0.3 + 5);
    const arm = Math.pow(0.5 + 0.5 * Math.cos(psi + (warp - 0.5) * 2.6), 3.2);
    const disk = Math.exp(-rr / 0.36) * (1 - smoothstep(0.85, 1.45, rr));
    const grain = noise(tu * 1.6 + 3, tv * 1.6 + 9);
    const dust = noise(tu * 0.8 + 41, tv * 0.8 + 13);
    const lane = Math.pow(0.5 + 0.5 * Math.cos(psi - 0.95), 5) * smoothstep(0.3, 0.7, dust) * smoothstep(0.06, 0.22, rr);
    const armLight = disk * (0.12 + 1.9 * arm) * (0.45 + 1.0 * grain) * (1 - 0.8 * lane) * 0.95;
    const knotNoise = noise(tu * 2.4 + 77, tv * 2.4 + 31);
    const knots = Math.pow(clamp01((knotNoise - 0.6) / 0.4), 2) * arm * smoothstep(0.18, 0.4, rr) * (1 - smoothstep(0.85, 1.25, rr));
    const young = knots * smoothstep(0.5, 0.95, rr);
    const toClay = smoothstep(0.08, 0.45, rr);
    const toMauve = smoothstep(0.55, 1.2, rr);
    for (let k = 0; k < 3; k++) {
      const inner = GOLD[k]! + (CLAY[k]! - GOLD[k]!) * toClay;
      const c = inner + (MAUVE[k]! - inner) * toMauve;
      const add = c * armLight + ROSE[k]! * knots * (0.9 - 0.6 * smoothstep(0.5, 0.95, rr)) + BLUE[k]! * young * 0.7;
      if (k === 0) r += add;
      else if (k === 1) gr += add;
      else b += add;
    }
  }

  // Bulge: rounder than the disk (less inclined), ivory at the heart.
  const bv = vRaw / 0.8;
  const rb = Math.sqrt(u * u + bv * bv) / g.r;
  if (rb < 0.6) {
    const bulge = Math.exp(-(rb * rb) / 0.0035) * 1.3 + Math.exp(-rb / 0.065) * 0.55;
    const warmth = smoothstep(0.0, 0.18, rb);
    r += bulge * (IVORY[0] + (GOLD[0] - IVORY[0]) * warmth);
    gr += bulge * (IVORY[1] + (GOLD[1] - IVORY[1]) * warmth);
    b += bulge * (IVORY[2] + (GOLD[2] - IVORY[2]) * warmth);
  }

  out[o] = r;
  out[o + 1] = gr;
  out[o + 2] = b;
}

/** Einstein radius at full strength, in pixels. */
const LENS_RADIUS = 7.5;
/** How far the lens reaches (and a star's image can travel), in pixels. */
const LENS_REACH = Math.ceil(LENS_RADIUS * 3) + 2;

interface PixelStar {
  x: number;
  y: number;
  bright: number;
  twinkle: number;
  freq: number;
  phase: number;
  color: RGB;
}

const STAR_TINTS: readonly RGB[] = [
  [0.72, 0.8, 1.0],
  [0.95, 0.95, 1.0],
  [1.0, 0.92, 0.8],
  [1.0, 0.78, 0.6],
];

function starTint(h: number): RGB {
  return STAR_TINTS[Math.min(STAR_TINTS.length - 1, Math.floor(h * STAR_TINTS.length))]!;
}

/**
 * Every field pixel decides independently whether it is a star. The list
 * reaches `LENS_REACH` past the window: a star just outside it can still
 * be lensed into it, and dropping that image is a seam between panes.
 */
function pixelStars(win: SceneWindow): PixelStar[] {
  const stars: PixelStar[] = [];
  const y0 = win.y * 2 - LENS_REACH;
  const x0 = win.x - LENS_REACH;
  for (let y = y0; y < win.y * 2 + win.height * 2 + LENS_REACH; y++) {
    for (let x = x0; x < win.x + win.width + LENS_REACH; x++) {
      if (hash2(x, y, SEED) >= 0.0055) continue;
      const h = hash2(x, y, SEED + 1);
      stars.push({
        x,
        y,
        bright: 0.06 + Math.pow(h, 6) * 0.55,
        twinkle: 0.2 + hash2(x, y, SEED + 2) * 0.7,
        freq: 0.6 + hash2(x, y, SEED + 3) * 2.4,
        phase: hash2(x, y, SEED + 4) * Math.PI * 2,
        color: starTint(hash2(x, y, SEED + 5)),
      });
    }
  }
  return stars;
}

interface GlyphStar {
  x: number;
  y: number;
  freq: number;
  phase: number;
  color: RGB;
}

/** Glyph stars live on field cells — one list per field, shared by every pane. */
function glyphStars(fieldWidth: number, fieldHeight: number): GlyphStar[] {
  const count = Math.round((fieldWidth * fieldHeight) / 230);
  const stars: GlyphStar[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.floor(hash2(i, 1, SEED + 20) * fieldWidth),
      y: Math.floor(hash2(i, 2, SEED + 20) * fieldHeight),
      freq: 0.25 + hash2(i, 3, SEED + 20) * 0.7,
      phase: hash2(i, 4, SEED + 20) * Math.PI * 2,
      color: starTint(hash2(i, 5, SEED + 20)),
    });
  }
  return stars;
}

/** Brightness → glyph: a star swells through four sizes as it breathes. */
export function glyphFor(brightness: number): string {
  if (brightness > 0.86) return "✦";
  if (brightness > 0.62) return "✧";
  if (brightness > 0.36) return "⋆";
  return "·";
}

/** Four (or eight) diffraction spikes from a field pixel. */
function spikes(frame: Frame, win: SceneWindow, x: number, y: number, len: number, diag: number, amp: number, c: RGB): void {
  const arms: readonly (readonly [number, number, number])[] = [
    [1, 0, len],
    [-1, 0, len],
    [0, 1, len * 0.75],
    [0, -1, len * 0.75],
    [0.707, 0.707, diag],
    [-0.707, 0.707, diag],
    [0.707, -0.707, diag],
    [-0.707, -0.707, diag],
  ];
  for (const [ax, ay, reach] of arms) {
    if (reach <= 0) continue;
    for (let s = 0.8; s <= reach; s += 0.7) {
      const w = amp * Math.exp(-s / (reach * 0.33));
      splat(frame, win, x + ax * s, y + ay * s, 0.5, c[0] * w, c[1] * w, c[2] * w);
    }
  }
}

/** Comets arrive on a 40 s schedule; each slot hashes whether and where. */
const COMET_SLOT = 40;
const COMET_LIFE = 16;

function paintComet(frame: Frame, win: SceneWindow, t: number): void {
  const fw = win.fieldWidth;
  const fh = win.fieldHeight * 2;
  for (const slot of [Math.floor(t / COMET_SLOT) - 1, Math.floor(t / COMET_SLOT)]) {
    if (hash2(slot, 0, SEED + 30) > 0.7) continue;
    const start = slot * COMET_SLOT + 2 + hash2(slot, 1, SEED + 30) * (COMET_SLOT - COMET_LIFE - 4);
    const s = (t - start) / COMET_LIFE;
    if (s < 0 || s > 1) continue;
    const ltr = hash2(slot, 2, SEED + 30) < 0.5;
    const ax = ltr ? -0.08 * fw : 1.08 * fw;
    const bx = ltr ? 1.08 * fw : -0.08 * fw;
    const ay = fh * (0.04 + hash2(slot, 3, SEED + 30) * 0.3);
    const by = fh * (0.3 + hash2(slot, 4, SEED + 30) * 0.5);
    const hx = ax + (bx - ax) * s;
    const hy = ay + (by - ay) * s;
    const len = Math.hypot(bx - ax, by - ay);
    const dx = -(bx - ax) / len;
    const dy = -(by - ay) / len;
    // Dust tail curves away from the direction of travel, to one side.
    const nx = -dy * (ltr ? 1 : -1);
    const ny = dx * (ltr ? 1 : -1);
    const env = smoothstep(0, 0.1, s) * (1 - smoothstep(0.88, 1, s));
    for (let k = 1; k <= 34; k++) {
      const ion = 0.42 * Math.exp(-k / 13) * env;
      splat(frame, win, hx + dx * k * 1.1, hy + dy * k * 1.1, 0.5 + k * 0.045, BLUE[0] * ion, BLUE[1] * ion, BLUE[2] * ion);
      const dustAmp = 0.34 * Math.exp(-k / 17) * env;
      const bend = 0.012 * k * k;
      splat(
        frame,
        win,
        hx + dx * k * 0.95 + nx * bend,
        hy + dy * k * 0.95 + ny * bend,
        0.7 + k * 0.08,
        GOLD[0] * dustAmp,
        GOLD[1] * dustAmp * 0.9,
        GOLD[2] * dustAmp * 0.8,
      );
    }
    splat(frame, win, hx, hy, 3.2, CLAY[0] * 0.22 * env, CLAY[1] * 0.22 * env, CLAY[2] * 0.22 * env);
    splat(frame, win, hx, hy, 0.85, 1.6 * env, 1.5 * env, 1.35 * env);
  }
}

/** Meteors: a brief streak on a 9 s schedule. */
const METEOR_SLOT = 9;
const METEOR_LIFE = 0.9;

function paintMeteor(frame: Frame, win: SceneWindow, t: number): void {
  const fw = win.fieldWidth;
  const fh = win.fieldHeight * 2;
  const slot = Math.floor(t / METEOR_SLOT);
  if (hash2(slot, 0, SEED + 40) > 0.6) return;
  const start = slot * METEOR_SLOT + hash2(slot, 1, SEED + 40) * (METEOR_SLOT - METEOR_LIFE);
  const s = (t - start) / METEOR_LIFE;
  if (s < 0 || s > 1) return;
  const angle = (0.35 + hash2(slot, 2, SEED + 40) * 0.4) * (hash2(slot, 3, SEED + 40) < 0.5 ? 1 : -1);
  const dirX = Math.cos(angle) * Math.sign(angle || 1);
  const dirY = Math.abs(Math.sin(angle));
  const sx = fw * (0.1 + hash2(slot, 4, SEED + 40) * 0.8);
  const sy = fh * (0.02 + hash2(slot, 5, SEED + 40) * 0.45);
  const travel = 70 * s;
  const hx = sx + dirX * travel;
  const hy = sy + dirY * travel;
  const env = Math.sin(Math.PI * s);
  const trail = 18 * Math.min(1, s * 3);
  for (let k = 0; k <= trail; k += 0.5) {
    const w = 0.9 * env * Math.pow(1 - k / (trail + 0.001), 2);
    splat(frame, win, hx - dirX * k, hy - dirY * k, 0.55, IVORY[0] * w, IVORY[1] * w, IVORY[2] * w);
  }
}


export function createOpusScene(): SceneEngine {
  let slow: Float32Array | null = null;
  let slowKey = "";
  let slowT = Number.NaN;
  let stars: PixelStar[] = [];
  let starKey = "";
  let glyphs: GlyphStar[] = [];
  let glyphKey = "";
  const sample = new Float32Array(3);

  return {
    frameMs: 50,
    paint(frame, win, t, lens) {
      const g = layout(win.fieldWidth, win.fieldHeight);
      const key = `${win.x},${win.y},${win.width},${win.height},${win.fieldWidth},${win.fieldHeight}`;
      const ts = Math.floor(t / SLOW_STEP) * SLOW_STEP;
      const pixels = win.width * win.height * 2;

      if (slow === null || slowKey !== key || slowT !== ts) {
        if (slow === null || slow.length !== pixels * 3) slow = new Float32Array(pixels * 3);
        for (let py = 0; py < win.height * 2; py++) {
          for (let px = 0; px < win.width; px++) {
            slowLight(g, win.x + px + 0.5, win.y * 2 + py + 0.5, ts, slow, (py * win.width + px) * 3);
          }
        }
        slowKey = key;
        slowT = ts;
      }
      frame.light.set(slow);

      const thetaE = lens ? LENS_RADIUS * lens.strength : 0;
      const shadow = thetaE * 0.42;
      if (lens && thetaE > 0.4) {
        // Resample the background through the lens equation β = θ − θE²/θ.
        const reach = thetaE * 3;
        const lx = lens.x - win.x;
        const ly = lens.y - win.y * 2;
        const x0 = Math.max(0, Math.floor(lx - reach));
        const x1 = Math.min(win.width - 1, Math.ceil(lx + reach));
        const y0 = Math.max(0, Math.floor(ly - reach));
        const y1 = Math.min(win.height * 2 - 1, Math.ceil(ly + reach));
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const dx = px + 0.5 - lx;
            const dy = py + 0.5 - ly;
            const dist = Math.hypot(dx, dy);
            const o = (py * win.width + px) * 3;
            if (dist < shadow) {
              frame.light[o] = 0;
              frame.light[o + 1] = 0;
              frame.light[o + 2] = 0;
            } else if (dist < reach) {
              const k = (thetaE * thetaE) / (dist * dist);
              slowLight(g, lens.x + dx - dx * k, lens.y + dy - dy * k, ts, sample, 0);
              const f = 1 - smoothstep(reach * 0.7, reach, dist);
              for (let c = 0; c < 3; c++) frame.light[o + c] = frame.light[o + c]! + (sample[c]! - frame.light[o + c]!) * f;
            }
            if (dist < reach) {
              const ring = Math.exp(-Math.pow((dist - shadow * 1.12) / 0.42, 2)) * 0.55 * lens.strength;
              const glow = dist > shadow ? Math.exp(-(dist - shadow) / 3) * 0.12 * lens.strength : 0;
              frame.light[o]! += GOLD[0] * ring + CLAY[0] * glow;
              frame.light[o + 1]! += GOLD[1] * ring + CLAY[1] * glow;
              frame.light[o + 2]! += GOLD[2] * ring + CLAY[2] * glow;
            }
          }
        }
      }

      if (starKey !== key) {
        stars = pixelStars(win);
        starKey = key;
      }
      for (const star of stars) {
        const tw = 1 - star.twinkle + star.twinkle * (0.5 + 0.5 * Math.sin(t * star.freq + star.phase));
        const w = star.bright * tw * 1.4;
        if (lens && thetaE > 0.4) {
          const bx = star.x + 0.5 - lens.x;
          const by = star.y + 0.5 - lens.y;
          const beta = Math.hypot(bx, by);
          if (beta < thetaE * 3) {
            // A point lens makes two images on the line through it, at
            // θ± = (β ± √(β² + 4θE²)) / 2, magnified by |1 − (θE/θ)⁴|⁻¹.
            const root = Math.sqrt(beta * beta + 4 * thetaE * thetaE);
            const ux = beta > 1e-3 ? bx / beta : 1;
            const uy = beta > 1e-3 ? by / beta : 0;
            for (const theta of [(beta + root) / 2, (beta - root) / 2]) {
              const mag = Math.min(6, 1 / Math.abs(1 - Math.pow(thetaE / theta, 4)));
              if (Math.abs(theta) < shadow) continue;
              const m = w * mag;
              splat(frame, win, lens.x + ux * theta, lens.y + uy * theta, 0.5, star.color[0] * m, star.color[1] * m, star.color[2] * m);
            }
            continue;
          }
        }
        addPixel(frame, star.x - win.x, star.y - win.y * 2, star.color[0] * w, star.color[1] * w, star.color[2] * w);
      }

      // The ✻ spark at the nucleus: fixed to the "telescope", so the
      // spikes do not turn with the galaxy — the way real ones behave.
      const breathe = 0.5 + 0.12 * Math.sin(t * 0.5);
      spikes(frame, win, g.cx, g.cy, g.r * 0.3, g.r * 0.17, 0.32 * breathe, IVORY);
      putGlyph(frame, win, g.cx, g.cy / 2, "✻", 1.2 * breathe, 1.05 * breathe, 0.85 * breathe);

      const fieldKey = `${win.fieldWidth}x${win.fieldHeight}`;
      if (glyphKey !== fieldKey) {
        glyphs = glyphStars(win.fieldWidth, win.fieldHeight);
        glyphKey = fieldKey;
      }
      let heroes = 0;
      for (let i = 0; i < glyphs.length; i++) {
        const star = glyphs[i]!;
        const px = star.x + 0.5;
        const py = star.y * 2 + 1;
        // Keep the nucleus and the lens clean.
        if (Math.hypot(px - g.cx, (py - g.cy) * 1.4) < g.r * 0.22) continue;
        if (lens && thetaE > 0.4 && Math.hypot(px - lens.x, py - lens.y) < thetaE * 2.2) continue;
        const b = 0.5 + 0.5 * Math.sin(t * star.freq + star.phase);
        const light = 0.25 + 1.1 * b;
        putGlyph(frame, win, star.x, star.y, glyphFor(b), star.color[0] * light, star.color[1] * light, star.color[2] * light);
        // Every eleventh glyph star is a hero with its own spikes.
        if (i % 11 === 0 && heroes < 5) {
          heroes++;
          spikes(frame, win, px, py, 4 + 3 * b, 0, 0.22 * b, star.color);
        }
      }

      paintComet(frame, win, t);
      paintMeteor(frame, win, t);
    },
  };
}

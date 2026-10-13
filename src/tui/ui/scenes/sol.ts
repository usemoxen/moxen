import { addPixel, clamp01, hash2, noise, smoothstep, splat, type Frame, type Pointer, type SceneEngine, type SceneWindow } from "./raster.js";

/**
 * Sol — the Sun, cresting the bottom right of the new-thread view like a
 * dawn seen from close orbit. Back to front:
 *
 * - a warm glare in the dark, stars only far from the Sun;
 * - the corona: a bright inner ring and long streamers flowing outward;
 * - the photosphere: limb-darkened, boiling with granulation (cellular
 *   noise whose cells drift and re-form), bright faculae near the limb,
 *   and sunspots — umbra inside penumbra — carried across the disc by
 *   the Sun's rotation, foreshortened toward the limb as real ones are;
 * - prominences: twisted plasma loops standing on the limb, with coronal
 *   rain sliding down their legs; now and then one erupts and lifts away;
 * - the solar wind, streaming outward.
 *
 * Under the pointer, a small planet sits in the wind: lit on its sunward
 * side, with a glowing bow shock, and the wind parts around it.
 *
 * Granulation and corona are the expensive part and change slowly, so
 * they run on the slow clock (`SLOW_STEP`) and are cached, as in Opus.
 */

type RGB = readonly [number, number, number];

const CORE: RGB = [1.25, 0.82, 0.3];
const LIMB: RGB = [0.95, 0.33, 0.05];
const CORONA: RGB = [1.0, 0.86, 0.6];
const AMBER: RGB = [0.95, 0.45, 0.12];
const GLARE: RGB = [0.32, 0.12, 0.03];
const PLASMA: RGB = [1.0, 0.34, 0.24];
const RAIN: RGB = [1.0, 0.75, 0.5];
const WIND: RGB = [1.0, 0.85, 0.62];
const AURORA: RGB = [0.35, 1.0, 0.72];
const OCEAN: RGB = [0.3, 0.55, 1.0];

const SLOW_STEP = 0.25;
const SEED = 0x5017;
/** One solar rotation in ~20 minutes: spots cross visibly but slowly. */
const ROTATION = (Math.PI * 2) / 1200;
/** Granule cell size in pixels. */
const GRANULE = 5.2;

interface Layout {
  cx: number;
  cy: number;
  r: number;
}

/** The Sun's centre sits below the field so only its north cap rises. */
function layout(fieldWidth: number, fieldHeight: number): Layout {
  const fh = fieldHeight * 2;
  return { cx: fieldWidth * 0.7, cy: fh * 1.42, r: fh * 0.7 };
}

/** Sunspot centres as unit vectors (x right, y up, z toward us). */
function spots(t: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const lat = 0.72 + hash2(i, 1, SEED) * 0.28;
    const lon = hash2(i, 2, SEED) * Math.PI * 2 + ROTATION * t;
    const size = 0.035 + hash2(i, 3, SEED) * 0.04;
    out.push([Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon), size]);
  }
  return out;
}

/** Cellular noise: distance to the nearest drifting feature point, and to the second. */
function granulation(x: number, y: number, t: number): number {
  const gx = x / GRANULE;
  const gy = y / GRANULE;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let f1 = 9;
  let f2 = 9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const phase = hash2(cx, cy, SEED + 7) * Math.PI * 2;
      const speed = 0.15 + hash2(cx, cy, SEED + 8) * 0.25;
      const px = cx + 0.5 + 0.38 * Math.sin(t * speed + phase);
      const py = cy + 0.5 + 0.38 * Math.cos(t * speed * 1.3 + phase);
      const d = (px - gx) * (px - gx) + (py - gy) * (py - gy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  // Bright cell interiors, dark intergranular lanes.
  return smoothstep(0.0, 0.5, Math.sqrt(f2) - Math.sqrt(f1));
}

/** Corona and glare above the limb, `h` radii out. Adds into `acc`. */
function coronaLight(h: number, angle: number, t: number, acc: number[], weight: number): void {
  const glare = Math.exp(-h / 0.6) * 0.6;
  // Streamers: noise in (angle, height) with height scrolling outward.
  const streak = noise(angle * 30 + 13, h * 1.6 - t * 0.05);
  const fine = noise(angle * 110 + 71, h * 1.2 - t * 0.08);
  const ring = Math.exp(-h / 0.03) * 1.0;
  const rays = smoothstep(0.4, 0.85, streak);
  const corona = Math.exp(-h / 0.5) * (0.08 + 1.4 * rays) * (0.55 + 0.9 * fine) * 0.5;
  const warm = smoothstep(0.0, 0.3, h);
  for (let k = 0; k < 3; k++) {
    const c = CORONA[k]! + (AMBER[k]! - CORONA[k]!) * warm;
    acc[k]! += (c * (ring + corona) + GLARE[k]! * glare) * weight;
  }
}

/** Photosphere at unit-disc position (nx, ny). Adds into `acc`. */
function surfaceLight(nx: number, ny: number, x: number, y: number, t: number, acc: number[], weight: number): void {
  const mu = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const limb = 0.3 + 0.7 * Math.pow(mu, 0.55);
  // Granules, mottled by larger cells so they never tile like cobbles.
  const mottle = noise(x * 0.12 + 5, y * 0.12 + t * 0.01);
  const gran = granulation(x, y, t) * smoothstep(0.0, 0.35, mu) * (0.4 + 0.9 * mottle);
  const network = smoothstep(0.55, 0.85, noise(x * 0.22 + 31, y * 0.22 + 9));
  const faculae = network * (1 - mu) * 0.55;
  let shade = limb * (0.84 + 0.2 * gran + 0.1 * (mottle - 0.5)) + faculae;
  // Sunspots: angular distance between this surface normal and the spot.
  for (const [sx, sy, sz, size] of spots(t)) {
    if (sz <= 0) continue;
    const cos = nx * sx + ny * sy + mu * sz;
    const ang = Math.acos(Math.min(1, cos));
    const umbra = 1 - smoothstep(size * 0.35, size * 0.5, ang);
    const penumbra = 1 - smoothstep(size * 0.75, size, ang);
    shade *= 1 - 0.45 * penumbra - 0.45 * umbra;
  }
  const heat = smoothstep(0.0, 0.9, 1 - mu);
  for (let k = 0; k < 3; k++) acc[k]! += (CORE[k]! + (LIMB[k]! - CORE[k]!) * heat) * shade * 0.95 * weight;
}

const accum = [0, 0, 0];

function slowLight(g: Layout, x: number, y: number, t: number, out: Float32Array, o: number): void {
  const dx = x - g.cx;
  const dy = y - g.cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // One pixel of coverage across the limb, so the edge is smooth, not stepped.
  const inside = clamp01(g.r - dist + 0.5);
  accum[0] = accum[1] = accum[2] = 0;
  if (inside < 1) coronaLight(Math.max(0, dist / g.r - 1), Math.atan2(dx, -dy), t, accum, 1 - inside);
  if (inside > 0) {
    const scale = Math.min(1, (g.r - 0.01) / Math.max(dist, 1e-6));
    surfaceLight((dx * scale) / g.r, (-dy * scale) / g.r, x, y, t, accum, inside);
  }
  out[o] = accum[0]!;
  out[o + 1] = accum[1]!;
  out[o + 2] = accum[2]!;
}

/** Limb point and outward normal at limb angle `a` (0 = straight up). */
function limbAt(g: Layout, a: number, lift = 0): [number, number, number, number] {
  const nx = Math.sin(a);
  const ny = -Math.cos(a);
  return [g.cx + nx * (g.r + lift), g.cy + ny * (g.r + lift), nx, ny];
}

/** The limb angles that are on screen: where the limb is above the bottom edge. */
function visibleArc(g: Layout, fieldHeight: number): number {
  const c = (g.cy - fieldHeight * 2) / g.r;
  return c >= 1 ? 0 : Math.acos(Math.max(-1, c));
}

const ERUPT_SLOT = 55;
const ERUPT_LIFE = 14;

function paintProminences(frame: Frame, win: SceneWindow, g: Layout, t: number): void {
  const arc = visibleArc(g, win.fieldHeight) * 0.85;
  if (arc <= 0) return;
  const slot = Math.floor(t / ERUPT_SLOT);
  const eruptStart = slot * ERUPT_SLOT + 6 + hash2(slot, 1, SEED + 40) * (ERUPT_SLOT - ERUPT_LIFE - 8);
  const erupting = hash2(slot, 0, SEED + 40) < 0.65 ? Math.floor(hash2(slot, 2, SEED + 40) * 3) : -1;
  const age = t - eruptStart;

  for (let p = 0; p < 3; p++) {
    const centre = (hash2(p, 1, SEED + 30) * 2 - 1) * arc;
    const half = 0.05 + hash2(p, 2, SEED + 30) * 0.05;
    let height = g.r * (0.09 + hash2(p, 3, SEED + 30) * 0.1) * (1 + 0.12 * Math.sin(t * 0.21 + p));
    let fade = 1;
    let span = 1;
    if (p === erupting && age > 0 && age < ERUPT_LIFE) {
      // The loop lifts off: it swells and widens exponentially, then thins out.
      const s = age / ERUPT_LIFE;
      height *= Math.exp(s * 2.6);
      span = 1 + s * 1.4;
      fade = 1 - smoothstep(0.45, 1, s);
    } else if (p === erupting && age >= ERUPT_LIFE && age < ERUPT_LIFE + 4) {
      // …and a new one regrows where it stood.
      fade = smoothstep(0, 4, age - ERUPT_LIFE);
    }
    const lean = 0.7 + hash2(p, 4, SEED + 30) * 0.7;
    for (let strand = 0; strand < 4; strand++) {
      const twist = (strand - 1.5) * 0.8;
      const steps = Math.ceil((half * g.r * 2 + height * 2) / 0.55);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const a = centre + half * span * (2 * u - 1);
        // Loops lean and sag unevenly: the apex sits off-centre.
        const arch = Math.sin(Math.PI * Math.pow(u, lean));
        const wobble = (noise(u * 9 + p * 31 + strand * 7, t * 0.35) - 0.5) * 4;
        const lift = height * arch + wobble * (0.4 + arch) + twist * arch;
        const [x, y] = limbAt(g, a, lift);
        const heat = Math.pow(noise(u * 11 + strand * 5 + p * 17, t * 0.5), 1.6) * 1.7;
        const w = 0.13 * heat * fade;
        splat(frame, win, x, y, 0.9 + 0.5 * heat, PLASMA[0] * w, PLASMA[1] * w, PLASMA[2] * w);
      }
    }
    // Coronal rain: knots sliding from the apex down each leg.
    if (fade > 0.5) {
      for (let k = 0; k < 4; k++) {
        const s = (t * (0.05 + k * 0.012) + hash2(p, k, SEED + 35)) % 1;
        const u = k % 2 === 0 ? 0.5 - s * 0.5 : 0.5 + s * 0.5;
        const a = centre + half * span * (2 * u - 1);
        const [x, y] = limbAt(g, a, height * Math.sin(Math.PI * Math.pow(u, lean)));
        const w = 0.55 * Math.sin(Math.PI * s);
        splat(frame, win, x, y, 0.6, RAIN[0] * w, RAIN[1] * w, RAIN[2] * w);
      }
    }
  }
}

/** Planet + bow shock radius, in pixels. */
const PLANET = 2.4;
const SHOCK = 6.5;

/** Where the shock stands at angle `cos` off the sunward axis (a parabola, nose at SHOCK). */
const shockAt = (cos: number): number => (2 * SHOCK) / (1 + Math.max(-0.6, cos));

function paintWind(frame: Frame, win: SceneWindow, g: Layout, t: number, pointer: Pointer | null): void {
  const arc = visibleArc(g, win.fieldHeight);
  if (arc <= 0) return;
  const count = Math.round(win.fieldWidth * 0.6);
  for (let i = 0; i < count; i++) {
    const a = (hash2(i, 1, SEED + 50) * 2 - 1) * Math.min(Math.PI * 0.95, arc + 0.6);
    const speed = 0.025 + hash2(i, 2, SEED + 50) * 0.05;
    const s = (t * speed + hash2(i, 3, SEED + 50)) % 1;
    const reach = g.r * (0.02 + s * 1.3);
    let [x, y] = limbAt(g, a, reach);
    if (pointer && pointer.strength > 0.05) {
      // The wind parts around the planet's bow shock.
      const px = x - pointer.x;
      const py = y - pointer.y;
      const d = Math.hypot(px, py);
      const sun = Math.hypot(g.cx - pointer.x, g.cy - pointer.y);
      const cos = d > 0 ? (px * (g.cx - pointer.x) + py * (g.cy - pointer.y)) / (d * sun) : 1;
      const edge = shockAt(cos) * pointer.strength;
      if (d < edge + 1) {
        x = pointer.x + (px / (d || 1)) * (edge + 1);
        y = pointer.y + (py / (d || 1)) * (edge + 1);
      }
    }
    const w = 0.5 * Math.sin(Math.PI * s) * (0.4 + 0.6 * hash2(i, 4, SEED + 50));
    splat(frame, win, x, y, 0.5, WIND[0] * w, WIND[1] * w, WIND[2] * w);
  }
}

function paintPlanet(frame: Frame, win: SceneWindow, g: Layout, t: number, pointer: Pointer): void {
  const s = pointer.strength;
  const sunX = g.cx - pointer.x;
  const sunY = g.cy - pointer.y;
  const sunD = Math.hypot(sunX, sunY) || 1;
  const ux = sunX / sunD;
  const uy = sunY / sunD;
  const reach = Math.ceil(shockAt(-0.6) * s) + 2;
  const lx = pointer.x - win.x;
  const ly = pointer.y - win.y * 2;
  for (let py = Math.max(0, Math.floor(ly - reach)); py <= Math.min(frame.height * 2 - 1, Math.ceil(ly + reach)); py++) {
    for (let px = Math.max(0, Math.floor(lx - reach)); px <= Math.min(frame.width - 1, Math.ceil(lx + reach)); px++) {
      const dx = px + 0.5 - lx;
      const dy = py + 0.5 - ly;
      const d = Math.hypot(dx, dy);
      const o = (py * frame.width + px) * 3;
      if (d < PLANET * s) {
        // A small blue world, day side toward the Sun.
        const lit = clamp01(((dx * ux + dy * uy) / (PLANET * s) + 0.35) * 1.4);
        frame.light[o] = OCEAN[0] * (0.08 + lit * 0.9) * s;
        frame.light[o + 1] = OCEAN[1] * (0.08 + lit * 0.9) * s;
        frame.light[o + 2] = OCEAN[2] * (0.08 + lit * 0.9) * s;
        continue;
      }
      const cos = (dx * ux + dy * uy) / (d || 1);
      const edge = shockAt(cos) * s;
      const band = Math.exp(-Math.pow((d - edge) / 0.55, 2)) * smoothstep(-0.55, 0.4, cos);
      const shimmer = 0.75 + 0.25 * Math.sin(t * 3 + d * 1.7);
      const w = band * 0.75 * s * shimmer;
      frame.light[o]! += AURORA[0] * w;
      frame.light[o + 1]! += AURORA[1] * w;
      frame.light[o + 2]! += AURORA[2] * w;
    }
  }
}

export function createSolScene(): SceneEngine {
  let slow: Float32Array | null = null;
  let slowKey = "";
  let slowT = Number.NaN;
  let stars: { x: number; y: number; w: number; freq: number; phase: number }[] = [];
  let starKey = "";

  return {
    frameMs: 50,
    paint(frame, win, t, pointer) {
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

      if (starKey !== key) {
        // Only far from the Sun does anything else show through the glare.
        stars = [];
        for (let y = win.y * 2; y < (win.y + win.height) * 2; y++) {
          for (let x = win.x; x < win.x + win.width; x++) {
            if (hash2(x, y, SEED + 60) >= 0.0025) continue;
            const far = smoothstep(1.35, 2.1, Math.hypot(x - g.cx, y - g.cy) / g.r);
            if (far <= 0) continue;
            stars.push({
              x,
              y,
              w: far * (0.05 + Math.pow(hash2(x, y, SEED + 61), 6) * 0.4),
              freq: 0.5 + hash2(x, y, SEED + 62) * 2,
              phase: hash2(x, y, SEED + 63) * Math.PI * 2,
            });
          }
        }
        starKey = key;
      }
      for (const star of stars) {
        const w = star.w * (0.6 + 0.4 * Math.sin(t * star.freq + star.phase));
        addPixel(frame, star.x - win.x, star.y - win.y * 2, w * 0.85, w * 0.9, w);
      }

      paintProminences(frame, win, g, t);
      paintWind(frame, win, g, t, pointer);
      if (pointer && pointer.strength > 0.05) paintPlanet(frame, win, g, t, pointer);
    },
  };
}

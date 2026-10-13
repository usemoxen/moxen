import { hash2, noise, smoothstep, splat, type Pointer, type SceneEngine } from "./raster.js";
import { DEG, landAt, moonPhase, subsolarPoint } from "./sky.js";

/**
 * Terra — the Earth, seen from the Moon: Earthrise.
 *
 * A grey lunar horizon along the bottom, scrolling slowly past as if in
 * lunar orbit; above it the Earth, as it is right now. The face turned
 * toward us is the one facing the Moon at this moment, and the lit part is
 * where it is day: the sub-solar point comes from the time and the
 * season, and Earth's phase seen from the Moon is the complement of the
 * Moon's own (a full Moon over Earth is a "new Earth" over the Moon —
 * the night side glittering with cities).
 *
 * Real coastlines (Natural Earth, via `sky.ts`), oceans with a sun-glint,
 * deserts, forests and ice by latitude, drifting cloud, a thin blue
 * atmosphere at the limb, city lights on the night side.
 *
 * The pointer is the Sun: move it and the daylight swings round with it.
 */

type RGB = readonly [number, number, number];

const SEED = 0x7e77;
const OCEAN: RGB = [0.02, 0.09, 0.26];
const ICE: RGB = [0.82, 0.86, 0.92];
const CITY: RGB = [1.0, 0.72, 0.36];
const AIR: RGB = [0.32, 0.55, 1.0];

/** Land colour by latitude: tropics green, desert belts tan, temperate green, tundra, ice. */
function landColour(lat: number, lon: number): RGB {
  const a = Math.abs(lat);
  if (a > 66 || lat < -60) return ICE;
  const n = noise(lon * 0.9 + 40, lat * 0.9);
  const desert = smoothstep(10, 20, a) * (1 - smoothstep(30, 38, a)) * smoothstep(0.35, 0.6, n);
  const green: RGB = a < 15 ? [0.1, 0.26, 0.08] : a < 55 ? [0.16, 0.27, 0.11] : [0.28, 0.26, 0.2];
  const tan: RGB = [0.52, 0.42, 0.24];
  return [green[0] + (tan[0] - green[0]) * desert, green[1] + (tan[1] - green[1]) * desert, green[2] + (tan[2] - green[2]) * desert];
}

/** The sun's direction in the view frame (x right, y up, z toward us), and which longitude faces us. */
function geometry(t: number, pointer: Pointer | null, cx: number, cy: number, r: number): { sun: [number, number, number]; centreLon: number } {
  const theta = moonPhase(t);
  const subsolar = subsolarPoint(t);
  // The Moon stands east of the Sun by its phase angle, so the point under
  // it — the face of the Earth turned toward us — is that far east of noon.
  let centreLon = subsolar.lon + theta / DEG;
  centreLon = ((centreLon + 540) % 360) - 180;
  const d = subsolar.lat * DEG;
  let sun: [number, number, number] = [Math.sin(-theta) * Math.cos(d), Math.sin(d), Math.cos(theta) * Math.cos(d)];
  if (pointer && pointer.strength > 0.05) {
    // The pointer is the Sun: light from where it is, a little in front.
    const px = (pointer.x - cx) / r;
    const py = -(pointer.y - cy) / r;
    const len = Math.hypot(px, py, 0.7) || 1;
    const k = pointer.strength;
    sun = [sun[0] * (1 - k) + (px / len) * k, sun[1] * (1 - k) + (py / len) * k, sun[2] * (1 - k) + (0.7 / len) * k];
    const n = Math.hypot(...sun) || 1;
    sun = [sun[0] / n, sun[1] / n, sun[2] / n];
  }
  return { sun, centreLon };
}

const CRATERS = 30;
/** Ground units per screen pixel per unit depth. */
const GROUND_SCALE = 0.04;
/** How fast the ground slides past in lunar orbit, in ground units per second. */
const ORBIT_SPEED = 0.45;

/** The curved lunar horizon at field x. */
function horizonAt(x: number, t: number, fw: number, fh: number, horizon: number): number {
  return horizon - Math.pow((x - fw * 0.55) / fw, 2) * fh * 0.3 + (noise(x * 0.06 + t * 0.35, 3) - 0.5) * 2.5;
}

/** Distance along the ground for a row below the horizon: the strip is shallow, so its bottom is near. */
function groundDepth(y: number, edge: number, fh: number): number {
  return (0.25 * fh) / Math.max(0.5, y - edge);
}

export function createTerraScene(): SceneEngine {
  return {
    frameMs: 80,
    paint(frame, win, t, pointer) {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const cx = fw * 0.66;
      const cy = fh * 0.28;
      const r = fh * 0.19;
      const horizon = fh * 0.8;
      const { sun, centreLon } = geometry(t, pointer, cx, cy, r);
      // Half-vector for the ocean glint, the viewer straight on (0, 0, 1).
      const hn = Math.hypot(sun[0], sun[1], sun[2] + 1) || 1;
      const half = [sun[0] / hn, sun[1] / hn, (sun[2] + 1) / hn];

      for (let py = 0; py < win.height * 2; py++) {
        const y = win.y * 2 + py + 0.5;
        for (let px = 0; px < win.width; px++) {
          const x = win.x + px + 0.5;
          const o = (py * win.width + px) * 3;
          let cr = 0.004;
          let cg = 0.005;
          let cb = 0.012;

          // Stars, faint — the sunlit Earth and Moon wash most of them out.
          if (hash2(Math.floor(x), Math.floor(y), SEED) < 0.003) {
            const w = 0.12 + 0.2 * hash2(Math.floor(x), Math.floor(y), SEED + 1);
            cr += w;
            cg += w;
            cb += w * 1.1;
          }

          const dx = (x - cx) / r;
          const dy = -(y - cy) / r;
          const rr = dx * dx + dy * dy;
          if (rr <= 1) {
            const nz = Math.sqrt(1 - rr);
            const lat = Math.asin(dy) / DEG;
            const lon = Math.atan2(dx, nz) / DEG + centreLon;
            const lambert = dx * sun[0] + dy * sun[1] + nz * sun[2];
            const day = smoothstep(-0.08, 0.22, lambert);
            const land = landAt(lat, lon);
            const ice = Math.abs(lat) > 72 || lat < -62 ? 1 : 0;
            const ground = landColour(lat, lon);
            let sr = OCEAN[0] + (ground[0] - OCEAN[0]) * Math.max(land, ice);
            let sg = OCEAN[1] + (ground[1] - OCEAN[1]) * Math.max(land, ice);
            let sb = OCEAN[2] + (ground[2] - OCEAN[2]) * Math.max(land, ice);
            // Cloud where the real planet gathers it — the equatorial convergence
            // and the mid-latitude storm tracks — and clear over the subtropical
            // deserts; drifting east, re-forming slowly.
            const band = 0.25 + 0.55 * Math.exp(-((lat / 9) ** 2)) + 0.65 * Math.exp(-(((Math.abs(lat) - 52) / 12) ** 2));
            const cloud = 0.85 * smoothstep(0.45, 0.8, noise(lon * 1.8 + t * 0.15, lat * 2.2 + t * 0.03) * band + 0.2 * noise(lon * 5 - t * 0.2, lat * 5));
            sr += (0.92 - sr) * cloud;
            sg += (0.93 - sg) * cloud;
            sb += (0.95 - sb) * cloud;
            // Sun-glint on open water.
            const spec = Math.pow(Math.max(0, dx * half[0]! + dy * half[1]! + nz * half[2]!), 60) * (1 - land) * (1 - cloud) * 1.4;
            const lit = 0.04 + 1.05 * day;
            cr = sr * lit + spec;
            cg = sg * lit + spec;
            cb = sb * lit + spec * 0.95;
            // Night side: cities on land, twinkling a little, under thinner cloud.
            if (day < 0.5 && land > 0.5 && Math.abs(lat) < 68) {
              const cellLat = Math.floor(lat * 1.5);
              const cellLon = Math.floor(((lon % 360) + 360) % 360 * 1.5);
              if (hash2(cellLon, cellLat, SEED + 2) < 0.22) {
                const w = (1 - day * 2) * (0.35 + 0.25 * hash2(cellLon, cellLat, SEED + 3)) * (1 - cloud * 0.8) * (0.85 + 0.15 * Math.sin(t * 3 + cellLon));
                cr += CITY[0] * w;
                cg += CITY[1] * w;
                cb += CITY[2] * w;
              }
            }
            // Atmosphere: haze thickening toward the limb, brighter on the day side.
            const haze = Math.pow(1 - nz, 3) * (0.25 + 0.75 * smoothstep(-0.2, 0.4, lambert)) * 0.6;
            cr += AIR[0] * haze;
            cg += AIR[1] * haze;
            cb += AIR[2] * haze;
          } else {
            // The thin blue line above the limb, where sunlight reaches it.
            const height = Math.sqrt(rr) - 1;
            const facing = smoothstep(-0.3, 0.5, (dx * sun[0] + dy * sun[1]) / Math.sqrt(rr));
            const glow = Math.exp(-height * r / 1.3) * (0.15 + 0.85 * facing) * 0.5;
            cr += AIR[0] * glow;
            cg += AIR[1] * glow;
            cb += AIR[2] * glow;
          }

          // The lunar surface below a curved horizon: soft rolling grey here;
          // the craters are drawn as shapes afterwards (see below).
          const edge = horizonAt(x, t, fw, fh, horizon);
          if (y > edge) {
            const depth = groundDepth(y, edge, fh);
            const u = (x - fw * 0.55) * depth * GROUND_SCALE + t * ORBIT_SPEED;
            const g = 0.11 + 0.05 * noise(u * 0.5 + 9, depth * 0.5) + 0.02 * noise(u * 2, depth * 2) / (1 + depth * 0.2);
            cr = g;
            cg = g * 0.98;
            cb = g * 0.95;
          }

          frame.light[o] = cr;
          frame.light[o + 1] = cg;
          frame.light[o + 2] = cb;
        }
      }

      // Craters on the ground plane, projected: wide and round up close,
      // flattening toward the horizon, the rim lit on the Sun's side and
      // the bowl shadowed on it. They scroll past with the orbit.
      const sunSide = Math.sign(sun[0] || 1);
      for (let i = 0; i < CRATERS; i++) {
        const depth = 1.3 + hash2(i, 1, SEED + 5) * 9;
        const span = 2 * fw * depth * GROUND_SCALE;
        const along = ((((hash2(i, 2, SEED + 5) * span - t * ORBIT_SPEED) % span) + span) % span) - span / 2;
        const cxp = fw * 0.55 + along / (depth * GROUND_SCALE);
        const cyp = horizonAt(cxp, t, fw, fh, horizon) + (0.25 * fh) / depth;
        const rx = (0.6 + hash2(i, 3, SEED + 5) * 2.2) / (depth * GROUND_SCALE) * 0.3;
        const ry = rx * Math.min(0.75, 1.1 / depth);
        if (rx < 0.8) continue;
        const x0 = Math.max(0, Math.floor(cxp - rx * 1.2 - win.x));
        const x1 = Math.min(win.width - 1, Math.ceil(cxp + rx * 1.2 - win.x));
        const y0 = Math.max(0, Math.floor(cyp - ry * 1.2 - win.y * 2));
        const y1 = Math.min(win.height * 2 - 1, Math.ceil(cyp + ry * 1.2 - win.y * 2));
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const x = win.x + px + 0.5;
            const y = win.y * 2 + py + 0.5;
            if (y <= horizonAt(x, t, fw, fh, horizon)) continue;
            const ex = (x - cxp) / rx;
            const ey = (y - cyp) / ry;
            const d = Math.hypot(ex, ey);
            if (d > 1.18) continue;
            const facing = ex * sunSide;
            let delta = 0;
            if (d < 0.9) delta = facing > 0 ? -0.04 : -0.11 * (1 - d * 0.6);
            else delta = facing > 0 ? 0.12 * (1.18 - d) / 0.28 : -0.05;
            const o = (py * win.width + px) * 3;
            frame.light[o] = Math.max(0.01, frame.light[o]! + delta);
            frame.light[o + 1] = Math.max(0.01, frame.light[o + 1]! + delta * 0.98);
            frame.light[o + 2] = Math.max(0.01, frame.light[o + 2]! + delta * 0.95);
          }
        }
      }

      // Earthshine on the regolith is too faint to see; the pointer-sun gets a soft glow instead.
      if (pointer && pointer.strength > 0.05) {
        const w = 0.18 * pointer.strength;
        splat(frame, win, pointer.x, pointer.y, 5, 1.0 * w, 0.95 * w, 0.85 * w);
      }
    },
  };
}

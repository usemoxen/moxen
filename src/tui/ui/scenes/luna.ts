import { hash2, noise, smoothstep, splat, type Pointer, type SceneEngine } from "./raster.js";
import { DEG, landAt, moonPhase } from "./sky.js";

/**
 * Luna — the Moon, seen from Earth orbit: Terra's view turned around.
 *
 * Along the bottom, the night side of the Earth curving away, cities
 * glittering under a thin blue atmosphere and the faint green line of
 * airglow above it — your own part of the world, roughly (the longitude
 * comes from the local timezone). Above it, the Moon in tonight's real
 * phase: its maria and bright craters where they actually are on the
 * near side, Tycho throwing its rays, and the dark part softly lit by
 * earthshine — strongest around new Moon, when the Earth seen from there
 * is nearly full.
 *
 * The pointer is the Sun: move it and the Moon runs through its phases.
 */

type RGB = readonly [number, number, number];

const SEED = 0x1a7a;
const HIGHLAND: RGB = [0.66, 0.64, 0.6];
const MARE: RGB = [0.3, 0.3, 0.32];
const CITY: RGB = [1.0, 0.7, 0.34];
const AIR: RGB = [0.3, 0.52, 1.0];
const AIRGLOW: RGB = [0.35, 0.85, 0.45];
const EARTHSHINE: RGB = [0.55, 0.65, 0.85];

/** Near-side maria: [latitude, longitude, radius] in degrees — approximate, enough to read as the real Moon. */
const MARIA: readonly (readonly [number, number, number])[] = [
  [20, -50, 17], // Oceanus Procellarum (two lobes)
  [3, -58, 13],
  [33, -16, 15], // Imbrium
  [28, 17, 9], // Serenitatis
  [8, 31, 11], // Tranquillitatis
  [17, 59, 7], // Crisium
  [-8, 51, 8], // Fecunditatis
  [-15, 35, 5], // Nectaris
  [-21, -17, 9], // Nubium
  [-24, -39, 6], // Humorum
  [56, -10, 6], // Frigoris, a long northern band
  [56, 14, 6],
  [13, 4, 4], // Vaporum
  [8, -31, 6], // Insularum
  [-10, -23, 5], // Cognitum
];

/** Bright young craters: [latitude, longitude, radius, ray length] — Tycho, Copernicus, Kepler, Aristarchus. */
const CRATERS: readonly (readonly [number, number, number, number])[] = [
  [-43.3, -11.4, 1.8, 1.1],
  [9.6, -20.1, 1.9, 0.45],
  [8.1, -38.0, 1.0, 0.3],
  [23.7, -47.4, 0.9, 0],
];

function unit(lat: number, lon: number): [number, number, number] {
  return [Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG), Math.cos(lat * DEG) * Math.cos(lon * DEG)];
}

// Drawn a third wider than their cores, with ragged edges, so neighbouring
// maria run together into the connected dark regions the real Moon has.
const MARIA_UNITS = MARIA.map(([lat, lon, r]) => [...unit(lat, lon), Math.cos(r * 1.35 * DEG)] as const);
const CRATER_UNITS = CRATERS.map(([lat, lon, r, rays]) => ({ at: unit(lat, lon), cos: Math.cos(r * DEG), rays }));

/** Albedo of the near side at unit normal n (x east, y north, z toward Earth). */
function albedo(n: readonly [number, number, number]): [number, number, number] {
  let mare = 0;
  for (const [mx, my, mz, cos] of MARIA_UNITS) {
    const c = n[0] * mx + n[1] * my + n[2] * mz;
    // Soft, ragged shorelines: real maria are not circles.
    mare = Math.max(mare, smoothstep(cos - 0.02, cos + 0.015, c + (noise(n[0] * 30 + 5, n[1] * 30) - 0.5) * 0.045));
  }
  const mottle = 0.88 + 0.24 * noise(n[0] * 60 + 30, n[1] * 60 + n[2] * 20);
  let r = (HIGHLAND[0] + (MARE[0] - HIGHLAND[0]) * mare) * mottle;
  let g = (HIGHLAND[1] + (MARE[1] - HIGHLAND[1]) * mare) * mottle;
  let b = (HIGHLAND[2] + (MARE[2] - HIGHLAND[2]) * mare) * mottle;
  for (const crater of CRATER_UNITS) {
    const c = n[0] * crater.at[0] + n[1] * crater.at[1] + n[2] * crater.at[2];
    let bright = smoothstep(crater.cos - 0.0006, crater.cos + 0.0004, c) * 0.5;
    if (crater.rays > 0) {
      // Rays: streaks radiating along great circles, fading with distance.
      const dist = Math.acos(Math.min(1, c));
      const ex = n[0] - crater.at[0] * c;
      const ey = n[1] - crater.at[1] * c;
      const bearing = Math.atan2(ey, ex);
      const streak = smoothstep(0.62, 0.85, noise((bearing / (Math.PI * 2)) * 256, 3 + crater.rays * 10));
      bright += streak * Math.max(0, 1 - dist / crater.rays) * 0.35 * smoothstep(0.01, 0.05, dist);
    }
    r += bright;
    g += bright;
    b += bright * 0.97;
  }
  return [r, g, b];
}

/** Light direction in the view frame (x right, y up, z toward us): tonight's phase, or the pointer. */
function sunlight(t: number, pointer: Pointer | null, cx: number, cy: number, r: number): [number, number, number] {
  const theta = moonPhase(t);
  // Waxing (0 < θ < π) is lit from the right, as seen from the north.
  let sun: [number, number, number] = [Math.sin(theta), 0, -Math.cos(theta)];
  if (pointer && pointer.strength > 0.05) {
    const px = (pointer.x - cx) / r;
    const py = -(pointer.y - cy) / r;
    const len = Math.hypot(px, py, 0.7) || 1;
    const k = pointer.strength;
    sun = [sun[0] * (1 - k) + (px / len) * k, sun[1] * (1 - k) + (py / len) * k, sun[2] * (1 - k) + (0.7 / len) * k];
    const n = Math.hypot(...sun) || 1;
    sun = [sun[0] / n, sun[1] / n, sun[2] / n];
  }
  return sun;
}

/** Your longitude, roughly: the local timezone's offset at 15° an hour. */
const HOME_LON = -new Date().getTimezoneOffset() / 4;
const HOME_LAT = 38;

export function createLunaScene(): SceneEngine {
  return {
    frameMs: 80,
    paint(frame, win, t, pointer) {
      const fw = win.fieldWidth;
      const fh = win.fieldHeight * 2;
      const mx = fw * 0.64;
      const my = fh * 0.28;
      const mr = fh * 0.2;
      const sun = sunlight(t, pointer, mx, my, mr);
      // Earthshine follows the Earth's phase seen from the Moon: the complement.
      const shine = 0.05 * (1 + Math.cos(moonPhase(t))) / 2;
      // The Earth: a huge sphere below, only its night limb on screen.
      const ex = fw * 0.5;
      const ey = fh * 2.3;
      const er = fh * 1.55;
      const tilt = 0.85;
      const lat0 = HOME_LAT * DEG;

      for (let py = 0; py < win.height * 2; py++) {
        const y = win.y * 2 + py + 0.5;
        for (let px = 0; px < win.width; px++) {
          const x = win.x + px + 0.5;
          const o = (py * win.width + px) * 3;
          let cr = 0.003;
          let cg = 0.004;
          let cb = 0.012;
          if (hash2(Math.floor(x), Math.floor(y), SEED) < 0.004) {
            const w = 0.1 + 0.25 * hash2(Math.floor(x), Math.floor(y), SEED + 1);
            cr += w;
            cg += w;
            cb += w * 1.1;
          }

          // The Moon.
          const dx = (x - mx) / mr;
          const dy = -(y - my) / mr;
          const rr = dx * dx + dy * dy;
          if (rr <= 1) {
            const nz = Math.sqrt(1 - rr);
            const n: [number, number, number] = [dx, dy, nz];
            const [ar, ag, ab] = albedo(n);
            const lambert = dx * sun[0] + dy * sun[1] + nz * sun[2];
            const day = smoothstep(-0.04, 0.12, lambert) * (0.35 + 0.65 * Math.max(0, lambert));
            cr = ar * (day * 1.15 + shine * EARTHSHINE[0]);
            cg = ag * (day * 1.15 + shine * EARTHSHINE[1]);
            cb = ab * (day * 1.15 + shine * EARTHSHINE[2]);
          }

          // The Earth's night side, and the air above its limb.
          const gx = (x - ex) / er;
          const gy = -(y - ey) / er;
          const gr = gx * gx + gy * gy;
          if (gr <= 1) {
            const gz = Math.sqrt(1 - gr);
            // Tip the globe so home sits just below the limb, then read latitude and longitude.
            const ny = gy * Math.cos(tilt) - gz * Math.sin(tilt);
            const nz2 = gy * Math.sin(tilt) + gz * Math.cos(tilt);
            const lat = Math.asin(Math.max(-1, Math.min(1, ny * Math.cos(lat0) + nz2 * Math.sin(lat0)))) / DEG;
            const lon = HOME_LON + Math.atan2(gx, nz2 * Math.cos(lat0) - ny * Math.sin(lat0)) / DEG;
            let lr = 0.006;
            let lg = 0.008;
            let lb = 0.02;
            if (landAt(lat, lon) > 0.5 && Math.abs(lat) < 70) {
              const cellLat = Math.floor(lat * 3);
              const cellLon = Math.floor((((lon % 360) + 360) % 360) * 3);
              // Lights gather where people do: clustered, with wide dark country between.
              const people = smoothstep(0.55, 0.8, noise(lon * 1.6 + 11, lat * 1.6 + 7));
              if (hash2(cellLon, cellLat, SEED + 2) < 0.25 * people) {
                const w = (0.15 + 0.35 * hash2(cellLon, cellLat, SEED + 3)) * (0.85 + 0.15 * Math.sin(t * 2.5 + cellLon)) * (1 - 0.6 * smoothstep(0.6, 1, Math.sqrt(gr)));
                lr += CITY[0] * w;
                lg += CITY[1] * w;
                lb += CITY[2] * w;
              }
            }
            const limb = Math.pow(1 - gz, 4) * 0.5;
            cr = lr + AIR[0] * limb;
            cg = lg + AIR[1] * limb;
            cb = lb + AIR[2] * limb;
          } else {
            const height = (Math.sqrt(gr) - 1) * er;
            const blue = Math.exp(-height / 1.4) * 0.35;
            const green = Math.exp(-Math.pow((height - 3.2) / 0.9, 2)) * 0.22;
            cr += AIR[0] * blue + AIRGLOW[0] * green;
            cg += AIR[1] * blue + AIRGLOW[1] * green;
            cb += AIR[2] * blue + AIRGLOW[2] * green;
          }

          frame.light[o] = cr;
          frame.light[o + 1] = cg;
          frame.light[o + 2] = cb;
        }
      }

      if (pointer && pointer.strength > 0.05) {
        const w = 0.18 * pointer.strength;
        splat(frame, win, pointer.x, pointer.y, 5, 1.0 * w, 0.95 * w, 0.85 * w);
      }
    },
  };
}

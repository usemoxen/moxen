/**
 * The Earth and the Moon as they actually are right now — shared by the
 * Terra and Luna scenes, which show each from the other.
 *
 * `LAND` is a 180×90 equirectangular land mask (2° cells, row 0 at 90°N,
 * column 0 at 180°W, one bit per cell, LSB first), rasterised from
 * Natural Earth 1:110m land (public domain) as redistributed in the
 * `world-atlas@2.0.2` npm package (Natural Earth v4.1.0).
 */

const LAND_W = 180;
const LAND_H = 90;
const LAND = [
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAf",
  "AP8DAAAAAAAAAAAAAAAAAAAAAADo//z//wcAAAAAAAACAAAAAAAAAAAAhvvw//8PAPABAAAAwAMAAAAAAAAAwADkw////wEABAAA",
  "AABgAAAAAAAAAADAUT8A/v8PAAAAAAwA/j8AuAEAAAAAcBHtDcD/fwAAAAAwAPz/fwMAABCAAQD5w/wD8P8FAAAMAIL7//9//xOA",
  "AP/ff0668QD/HwAA+A8At///////v3/w/////x8++B8AAOD/1//7////////jP////+/+AE/gAcAn9f//////////w/w/////wEs",
  "4AEAAHz+////////////gL////8HeAAcAADg5///////////9ADgAf7/f4AnAAAAAH78////////H0QAAAiA//8f8AcAAIBB4///",
  "/////38ADwAQAOD//5//AQAAHAT/////////A3AAAAAA/v//+T8AAGDz//////////8DAQAAAMD/////AwAAsP//////////LwAA",
  "AAAA6P///2IAAAD+//////////8CAAAAAAD///8/CAAA4P//////////JwAAAAAA8P///wYAAAD+/un//////z8AAAAAAAD///8H",
  "AAAA/pgP/P//////MQAAAAAA8P//PwAAAMBD9v7//////wcBAAAAAAD///8AAAAAPkD7//////8hEAAAAAAA4P//DwAAAIDhAv//",
  "////f8YAAAAAAAD8//8AAAAA+AdE//////8jDwAAAAAAgP//AwAAAMD/APD/////PxgAAAAAAADw/x8AAAAA/n/v//////8HAAAA",
  "AAAAAPwDAgAAAOD////7////fwAAAAAAAACgHyAAAACA//9/f/7///8DAAAAAAAAAPQBAAAAAPj//+cv+P//PwAAAAAAAAAAHjAA",
  "AADA/////g/+//8EAAAAAAAAAOBhCAAAAP7//99/4D//AAAAAAAAAAAAPAMEAADA////+Qf84BcAAAAAAAAAAAA/AAAAAPz//58f",
  "gAf+QAAAAAAAAAAAAA8AAADg////ewA4gA8EAAAAAAAAAADAAAAAAPz//38BgAP4QQAAAAAAAAAAAAgPAADA////zwAwgAwQAAAA",
  "AAAAAAAA9Q8AAPj///8HAAVIAAAAAAAAAAAAAID/AQAA////fwBAAAAQAAAAAAAAAAAA+P8AAGDh//8DAAA0GAAAAAAAAAAAAID/",
  "HwAAAPj/HwAAgMIBAAAAAAAAAAAA/P8BAACA//8AAAAYXgAAAAAAAAAAAMD/fwAAAPz/BwAAAOOBAQAAAAAAAAAA/P8/AACA/z8A",
  "AABgbtQBAAAAAAAAAOD//w8AAPD/AwAAAAQIeAAAAAAAAAAA/P//AQAA/z8AAACAA4APAQAAAAAAAID//w8AAPD/AwAAAAARsEAA",
  "AAAAAAAA+P9/AAAA/j8AAAAAAAAAAAAAAAAAAAD//wcAAPD/QwAAAACAIwAAAAAAAAAA8P9/AAAA/z8EAAAAAD8GIAAAAAAAAAD8",
  "/wMAAPD/cQAAAAD4ZwAAAAAAAAAAgP8/AAAA/w8HAAAAgP8HAAAAAAAAAAD4/wMAAOD/MAAAAAD//wEBAAAAAAAAgP8PAAAA/g8D",
  "AAAA+P8fAAAAAAAAAAD4PwAAAOB/EAAAAID//wMAAAAAAAAAgP8DAAAA/AMAAAAA+P9/AAAAAAAAAAD8HwAAAMA/AAAAAID//wcA",
  "AAAAAAAAwP8BAAAA+AEAAAAA8P9/AAAAAAAAAAD8DwAAAIAPAAAAAAAP/gMAAAAAAAAAwB8AAAAAAAAAAAAAEIAfAAEAAAAAAAD+",
  "AwAAAAAAAAAAAAAA8AEgAAAAAAAA4AcAAAAAAAAAAAAAAAAAAAYAAAAAAABeAAAAAAAAAAAAAAAAwAAwAAAAAAAAwAMAAAAAAAAA",
  "AAAAAAAIgAEAAAAAAAAeAAAAAAAAAAAAAAAAAAAMAAAAAAAA4AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAABAAAAAAAA",
  "AAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAB4AEDwn/8HAAAAAAAAAAAwAAAAAACA/P/h/////w8A",
  "AAAAAAAAwAcAAAD4////z///////PwAAAAAAHALwAACA//////////////8HAADw/y///wMAAP7/////////////HwAA+P///38A",
  "AID///////////////8AAPL/////BwAO////////////////DwAA8P////8HEPD//////////////z8AAOD/////////////////",
  "////////H/AfwP//////////////////////////////////////////////////////////////////////////////////////",
].join("");

let landBits: Uint8Array | null = null;

function bits(): Uint8Array {
  if (landBits) return landBits;
  const raw = atob(LAND);
  landBits = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) landBits[i] = raw.charCodeAt(i);
  return landBits;
}

function cell(x: number, y: number): number {
  const cx = ((x % LAND_W) + LAND_W) % LAND_W;
  const cy = Math.min(LAND_H - 1, Math.max(0, y));
  const i = cy * LAND_W + cx;
  return (bits()[i >> 3]! >> (i & 7)) & 1;
}

/** Land (1) or sea (0) at a latitude and longitude in degrees, blended between cells so coasts are soft. */
export function landAt(lat: number, lon: number): number {
  const fx = ((lon + 180) / 360) * LAND_W - 0.5;
  const fy = ((90 - lat) / 180) * LAND_H - 0.5;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const tx = fx - x;
  const ty = fy - y;
  const top = cell(x, y) * (1 - tx) + cell(x + 1, y) * tx;
  const bottom = cell(x, y + 1) * (1 - tx) + cell(x + 1, y + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

const DEG = Math.PI / 180;

/**
 * Where the Sun is overhead at wall-clock `t` seconds: its longitude from
 * the time of day (noon UTC at 0°) and its latitude from the season (the
 * 23.44° tilt, solstices around 21 June and 21 December). Degrees.
 * Good to about a degree — plenty for a picture.
 */
export function subsolarPoint(t: number): { lat: number; lon: number } {
  const date = new Date(t * 1000);
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = (t * 1000 - start) / 86_400_000;
  const lat = -23.44 * Math.cos((2 * Math.PI * (day + 10)) / 365.25);
  let lon = (12 - hours) * 15;
  if (lon > 180) lon -= 360;
  return { lat, lon };
}

/** One synodic month: new Moon to new Moon. */
export const SYNODIC_DAYS = 29.530588853;
/** A known new Moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

/**
 * The Moon's phase angle at `t`, radians in [0, 2π): 0 at new Moon, π at
 * full, waxing in between. Seen from the Moon, the Earth's phase is the
 * complement — a full Moon over Earth means a "new Earth" over the Moon.
 */
export function moonPhase(t: number): number {
  const days = (t * 1000 - NEW_MOON_MS) / 86_400_000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  return (age / SYNODIC_DAYS) * 2 * Math.PI;
}

export { DEG };

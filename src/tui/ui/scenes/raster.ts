/**
 * Pixel primitives for model scenes — pure, no OpenTUI import, so vitest
 * runs them without the native core.
 *
 * A scene paints *light*, not cells: an emissive RGB raster at two pixels
 * per terminal cell (top and bottom half), which `composeCells` folds into
 * `▀` half-blocks — fg is the top pixel, bg the bottom. Terminal cells are
 * ~1:2 wide:tall, so a half-cell pixel is roughly square and circles need
 * no aspect correction in pixel space (they still do in cell space).
 *
 * Coordinates are *field* coordinates: the field is the whole terminal,
 * and each pane paints a window onto it. Everything a scene draws is a
 * pure function of (field position, time), so two panes painting adjacent
 * windows meet without a seam — the same contract the monitoring
 * backdrop's shared drifter field keeps.
 */

/** One pane's view of the field, in terminal cells. */
export interface SceneWindow {
  x: number;
  y: number;
  width: number;
  height: number;
  fieldWidth: number;
  fieldHeight: number;
}

/**
 * The pointer at a field *pixel*, with `strength` 0..1 easing in while it
 * moves and out after it rests. Each scene decides what it does there:
 * Opus bends light around it, Sol puts a planet in the solar wind.
 */
export interface Pointer {
  x: number;
  y: number;
  strength: number;
}

/**
 * Emissive light for one window. `light` is RGB per pixel, `width` ×
 * `height * 2` pixels, unbounded (tone-mapped at compose time). `glyph`
 * holds an optional character per cell, drawn in `glyphLight`'s colour
 * over the cell's averaged pixels.
 */
export interface Frame {
  width: number;
  height: number;
  light: Float32Array;
  glyph: string[];
  glyphLight: Float32Array;
}

export function createFrame(width: number, height: number): Frame {
  const cells = Math.max(0, width * height);
  return {
    width,
    height,
    light: new Float32Array(cells * 2 * 3),
    glyph: new Array<string>(cells).fill(""),
    glyphLight: new Float32Array(cells * 3),
  };
}

export function clearFrame(frame: Frame): void {
  frame.light.fill(0);
  frame.glyph.fill("");
  frame.glyphLight.fill(0);
}

/** Integer hash → [0, 1). Stable across runs and panes (no Math.random). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

const NOISE_SIZE = 256;
const NOISE_MASK = NOISE_SIZE - 1;
let noiseTexture: Float32Array | null = null;

/**
 * Tileable fBm value noise, built once on first use (~5 octaves over a
 * 256² torus, a few ms). Sampling a texture beats evaluating fBm per pixel
 * per frame by an order of magnitude, and a scene samples it several times
 * per pixel for domain warping.
 */
function texture(): Float32Array {
  if (noiseTexture) return noiseTexture;
  const out = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  let amplitude = 0.5;
  let total = 0;
  for (let octave = 0; octave < 5; octave++) {
    const lattice = 4 << octave;
    const step = NOISE_SIZE / lattice;
    for (let y = 0; y < NOISE_SIZE; y++) {
      const gy = Math.floor(y / step);
      let fy = y / step - gy;
      fy = fy * fy * (3 - 2 * fy);
      const y0 = gy % lattice;
      const y1 = (gy + 1) % lattice;
      for (let x = 0; x < NOISE_SIZE; x++) {
        const gx = Math.floor(x / step);
        let fx = x / step - gx;
        fx = fx * fx * (3 - 2 * fx);
        const x0 = gx % lattice;
        const x1 = (gx + 1) % lattice;
        const a = hash2(x0, y0, octave + 11);
        const b = hash2(x1, y0, octave + 11);
        const c = hash2(x0, y1, octave + 11);
        const d = hash2(x1, y1, octave + 11);
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        out[y * NOISE_SIZE + x]! += (top + (bottom - top) * fy) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  // Stretch to a full 0..1 range: summed octaves crowd around 0.5, which
  // would leave every threshold a scene picks hugging the middle.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const v = out[i]! / total;
    out[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i]! - min) / span;
  noiseTexture = out;
  return out;
}

/** Bilinear sample of the noise torus; one unit is one texel (period 256). */
export function noise(x: number, y: number): number {
  const tex = texture();
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = x - fx;
  const ty = y - fy;
  const x0 = fx & NOISE_MASK;
  const y0 = fy & NOISE_MASK;
  const x1 = (x0 + 1) & NOISE_MASK;
  const y1 = (y0 + 1) & NOISE_MASK;
  const a = tex[y0 * NOISE_SIZE + x0]!;
  const b = tex[y0 * NOISE_SIZE + x1]!;
  const c = tex[y1 * NOISE_SIZE + x0]!;
  const d = tex[y1 * NOISE_SIZE + x1]!;
  const top = a + (b - a) * tx;
  return top + (c + (d - c) * tx - top) * ty;
}

/** Add light at one window pixel (bounds-checked). */
export function addPixel(frame: Frame, px: number, py: number, r: number, g: number, b: number): void {
  if (px < 0 || py < 0 || px >= frame.width || py >= frame.height * 2) return;
  const o = (py * frame.width + px) * 3;
  frame.light[o]! += r;
  frame.light[o + 1]! += g;
  frame.light[o + 2]! += b;
}

/**
 * Additive gaussian splat at a *field* pixel position. Everything that
 * moves (comet heads, tails, meteors, spikes) is built from these, so
 * motion is sub-pixel smooth instead of snapping cell to cell.
 */
export function splat(
  frame: Frame,
  win: SceneWindow,
  fx: number,
  fy: number,
  sigma: number,
  r: number,
  g: number,
  b: number,
): void {
  const wx = fx - win.x;
  const wy = fy - win.y * 2;
  const reach = Math.ceil(sigma * 3);
  const x0 = Math.max(0, Math.floor(wx) - reach);
  const x1 = Math.min(frame.width - 1, Math.floor(wx) + reach);
  const y0 = Math.max(0, Math.floor(wy) - reach);
  const y1 = Math.min(frame.height * 2 - 1, Math.floor(wy) + reach);
  if (x0 > x1 || y0 > y1) return;
  const inv = 1 / (2 * sigma * sigma);
  for (let py = y0; py <= y1; py++) {
    const dy = py + 0.5 - wy;
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - wx;
      const w = Math.exp(-(dx * dx + dy * dy) * inv);
      if (w < 0.004) continue;
      const o = (py * frame.width + px) * 3;
      frame.light[o]! += r * w;
      frame.light[o + 1]! += g * w;
      frame.light[o + 2]! += b * w;
    }
  }
}

/** Put a glyph on a *field* cell if it lands in this window. */
export function putGlyph(frame: Frame, win: SceneWindow, cx: number, cy: number, ch: string, r: number, g: number, b: number): void {
  const x = Math.floor(cx) - win.x;
  const y = Math.floor(cy) - win.y;
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
  const i = y * frame.width + x;
  frame.glyph[i] = ch;
  frame.glyphLight[i * 3] = r;
  frame.glyphLight[i * 3 + 1] = g;
  frame.glyphLight[i * 3 + 2] = b;
}

/**
 * A model's scene. `paint` adds light for `win` at `t` seconds into a
 * cleared frame; it may cache per window, but what it paints must stay a
 * pure function of (field position, t, lens) so panes agree.
 */
export interface SceneEngine {
  /** How often the picture changes; a still-life engine repaints less. */
  readonly frameMs: number;
  paint(frame: Frame, win: SceneWindow, t: number, pointer: Pointer | null): void;
}

/**
 * Light that composes (over `base`, at gain 1) to exactly `hex` — for
 * glyphs that must match a colour the rest of the UI uses, like the
 * monitoring lattice. Inverts `composeCells`' exposure per channel.
 */
export function lightFor(hex: string, base: readonly [number, number, number]): [number, number, number] {
  const clean = hex.replace("#", "");
  return [0, 1, 2].map((k) => {
    const c = Number.parseInt(clean.slice(k * 2, k * 2 + 2), 16) / 255;
    const b = base[k]!;
    const f = clamp01((c - b) / (1 - b));
    return f >= 1 ? 8 : -Math.log(1 - f);
  }) as [number, number, number];
}

/**
 * Darken an elliptical "reading well" (window-cell centre and radii) so
 * text laid over the scene — the creating view's title and composer —
 * keeps its contrast. `depth` is how much light survives at the centre.
 */
export function applyWell(frame: Frame, cx: number, cy: number, rx: number, ry: number, depth: number): void {
  if (rx <= 0 || ry <= 0) return;
  for (let py = 0; py < frame.height * 2; py++) {
    const ny = (py / 2 + 0.25 - cy) / ry;
    for (let px = 0; px < frame.width; px++) {
      const nx = (px + 0.5 - cx) / rx;
      const d = nx * nx + ny * ny;
      if (d >= 1.6) continue;
      const keep = depth + (1 - depth) * smoothstep(0.35, 1.6, d);
      const o = (py * frame.width + px) * 3;
      frame.light[o]! *= keep;
      frame.light[o + 1]! *= keep;
      frame.light[o + 2]! *= keep;
      if ((py & 1) === 1) {
        const c = ((py >> 1) * frame.width + px) * 3;
        frame.glyphLight[c]! *= keep;
        frame.glyphLight[c + 1]! *= keep;
        frame.glyphLight[c + 2]! *= keep;
      }
    }
  }
}

/** Cells ready for the terminal: one char plus fg/bg in 0..1 RGB per cell. */
export interface Cells {
  width: number;
  height: number;
  ch: string[];
  fg: Float32Array;
  bg: Float32Array;
}

export function createCells(width: number, height: number): Cells {
  const n = Math.max(0, width * height);
  return { width, height, ch: new Array<string>(n).fill(" "), fg: new Float32Array(n * 3), bg: new Float32Array(n * 3) };
}

/** Soft exposure: light adds to the base without ever clipping hard. */
const expose = (light: number, gain: number): number => 1 - Math.exp(-light * gain);

/**
 * Light over a base colour → half-block cells. `gain` is the pane's
 * intensity (the sidebar runs dimmer than the empty creating view). Values
 * are snapped to 8 bits here so a pixel that did not visibly change does
 * not change the cell — the renderer only repaints differing cells, so
 * this is what keeps a slowly turning galaxy cheap to stream.
 */
export function composeCells(frame: Frame, base: readonly [number, number, number], gain: number, out: Cells): void {
  const { width, height, light } = frame;
  const q = (v: number) => Math.round(clamp01(v) * 255) / 255;
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const cell = cy * width + cx;
      const top = (cy * 2 * width + cx) * 3;
      const bottom = ((cy * 2 + 1) * width + cx) * 3;
      const o = cell * 3;
      let same = true;
      for (let k = 0; k < 3; k++) {
        const b = base[k]!;
        const t = q(b + (1 - b) * expose(light[top + k]!, gain));
        const u = q(b + (1 - b) * expose(light[bottom + k]!, gain));
        out.fg[o + k] = t;
        out.bg[o + k] = u;
        if (t !== u) same = false;
      }
      const glyph = frame.glyph[cell]!;
      if (glyph !== "") {
        // A glyph replaces the half-block, so the cell keeps one colour:
        // the mean of its two pixels, with the glyph's own light on top.
        for (let k = 0; k < 3; k++) {
          const mean = (out.fg[o + k]! + out.bg[o + k]!) / 2;
          out.bg[o + k] = q(mean);
          out.fg[o + k] = q(mean + (1 - mean) * expose(frame.glyphLight[o + k]!, Math.max(gain, 0.5)));
        }
        out.ch[cell] = glyph;
      } else {
        // Equal halves need no glyph at all: a space with a background is
        // fewer bytes on the wire than a half-block in two equal colours.
        out.ch[cell] = same ? " " : "▀";
      }
    }
  }
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Half-width of the bloom's soft edge, in normalised distance. */
const BLOOM_SOFT = 0.22;

/**
 * How much of the *incoming* scene shows at a window pixel when a
 * transition is `p` (0..1) through: the new scene blooms out from the
 * pane's centre along an eased, slightly ragged front. Exactly 0
 * everywhere at p = 0 and exactly 1 everywhere at p = 1, so a transition
 * starts and ends on a clean frame of each scene.
 */
export function bloomWeight(px: number, py: number, width: number, height: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // Pixel space is roughly square, so this is a circle, normalised so the
  // farthest corner sits at 1.
  const hx = width / 2;
  const hy = height;
  const dx = (px + 0.5 - hx) / hx;
  const dy = (py + 0.5 - hy) / hy;
  const reach = Math.hypot(hx, hy);
  const d = clamp01(Math.hypot(dx * hx, dy * hy) / reach + (noise(px * 0.7, py * 0.7) - 0.5) * 0.16);
  const front = easeInOutCubic(p) * (1 + 2 * BLOOM_SOFT) - BLOOM_SOFT;
  return 1 - smoothstep(front - BLOOM_SOFT, front + BLOOM_SOFT, d);
}

/**
 * Mix two painted frames of the same window into `out` for a transition
 * `p` through, from `from` to `to`. Light mixes per pixel; a cell's glyph
 * goes to whichever side outweighs the other there, dimmed by its share,
 * so lattice dots and stars dissolve rather than blink.
 */
export function blendFrames(from: Frame, to: Frame, out: Frame, p: number): void {
  const { width, height } = out;
  const flash = Math.sin(Math.PI * clamp01(p)) * 0.1;
  for (let py = 0; py < height * 2; py++) {
    for (let px = 0; px < width; px++) {
      const w = bloomWeight(px, py, width, height, p);
      const o = (py * width + px) * 3;
      // A faint glow rides the front, so the change reads as a wave.
      const edge = flash * 4 * w * (1 - w);
      out.light[o] = from.light[o]! + (to.light[o]! - from.light[o]!) * w + edge;
      out.light[o + 1] = from.light[o + 1]! + (to.light[o + 1]! - from.light[o + 1]!) * w + edge * 0.92;
      out.light[o + 2] = from.light[o + 2]! + (to.light[o + 2]! - from.light[o + 2]!) * w + edge * 0.8;
    }
  }
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const i = cy * width + cx;
      const o = i * 3;
      const w = bloomWeight(cx, cy * 2 + 1, width, height, p);
      const a = from.glyph[i]!;
      const b = to.glyph[i]!;
      const la = a === "" ? 0 : (from.glyphLight[o]! + from.glyphLight[o + 1]! + from.glyphLight[o + 2]!) * (1 - w);
      const lb = b === "" ? 0 : (to.glyphLight[o]! + to.glyphLight[o + 1]! + to.glyphLight[o + 2]!) * w;
      if (la === 0 && lb === 0) {
        out.glyph[i] = "";
        out.glyphLight[o] = out.glyphLight[o + 1] = out.glyphLight[o + 2] = 0;
        continue;
      }
      const [src, share, ch] = lb >= la ? [to, w, b] : [from, 1 - w, a];
      out.glyph[i] = ch;
      out.glyphLight[o] = src.glyphLight[o]! * share;
      out.glyphLight[o + 1] = src.glyphLight[o + 1]! * share;
      out.glyphLight[o + 2] = src.glyphLight[o + 2]! * share;
    }
  }
}

/**
 * What a `moxen-ui` block does to an image before it is drawn: crop (which is
 * also the zoom, the picture being fitted to its cells), pad to a shape,
 * annotate with boxes, arrows and highlights, and blend two images. The
 * geometry and the drawing are pure and tested on a small stand-in for the
 * native image; `processImage` and `blendLoaded` run them on opentui's
 * `NativeImage`, which needs Bun's FFI (the render-check covers that part).
 *
 * OpenTUI's image has no drawing, no text and no difference blend, so marks
 * are painted here into a transparent layer that is composited on, and a
 * difference is taken on the raw pixels. Text stays in captions.
 */
import { NativeImage } from "@opentui/core";

import type { UiColor, UiOp, UiShape } from "../../core/threads/uiblock.js";
import { encodeRgbaPng } from "./imageshrink.js";
import type { LoadedImage } from "./imagethumb.js";

/** The most pixels an image may come out with; a bigger result is scaled down, aspect kept. */
export const MAX_OUTPUT_PIXELS = 2_000_000;

export interface RawPixels {
  data: Uint8Array;
  width: number;
  height: number;
  stride: number;
}

/** The part of a native image these operations use, so tests can stand one in. */
export interface Pic {
  width: number;
  height: number;
  extract(options: { left: number; top: number; width: number; height: number }): Pic;
  extend(options: { top?: number; right?: number; bottom?: number; left?: number; background?: readonly [number, number, number, number] }): Pic;
  resize(options: { width: number; height: number }): Pic;
  composite(overlay: Pic, options?: { left?: number; top?: number; opacity?: number }): Pic;
  raw(): RawPixels;
  dispose(): void;
}

export interface PicFactory {
  fromRgba(pixels: Uint8Array, width: number, height: number): Pic;
}

const NATIVE_FACTORY: PicFactory = { fromRgba: (pixels, width, height) => NativeImage.fromRgba(pixels, width, height) as unknown as Pic };

/** The pixels a crop takes: whole pixels, at least one, inside the image. */
export function cropRect(size: { width: number; height: number }, crop: { x: number; y: number; w: number; h: number }) {
  const left = Math.min(size.width - 1, Math.max(0, Math.round(crop.x * size.width)));
  const top = Math.min(size.height - 1, Math.max(0, Math.round(crop.y * size.height)));
  return {
    left,
    top,
    width: Math.max(1, Math.min(size.width - left, Math.round(crop.w * size.width))),
    height: Math.max(1, Math.min(size.height - top, Math.round(crop.h * size.height))),
  };
}

/** The padding that brings an image to `aspect` (width ÷ height), centred; null when it is within a pixel of it already. */
export function padExtents(size: { width: number; height: number }, aspect: number) {
  const wanted = size.height * aspect;
  if (Math.abs(wanted - size.width) < 1) return null;
  if (wanted > size.width) {
    const across = Math.ceil(wanted) - size.width;
    return { left: Math.floor(across / 2), right: across - Math.floor(across / 2), top: 0, bottom: 0 };
  }
  const down = Math.ceil(size.width / aspect) - size.height;
  return { top: Math.floor(down / 2), bottom: down - Math.floor(down / 2), left: 0, right: 0 };
}

const RGB: Record<UiColor, [number, number, number]> = {
  red: [230, 57, 70],
  yellow: [250, 200, 30],
  green: [60, 190, 90],
  blue: [60, 140, 240],
  white: [255, 255, 255],
  black: [0, 0, 0],
};

/** Opacity of a highlight's fill, of 255. */
const HIGHLIGHT_ALPHA = 90;

/**
 * The marks on a transparent RGBA layer `width`×`height`: a box is an outline,
 * a highlight a translucent fill, an arrow a line with a head at its end.
 * Lines are `max(3, shorter edge / 32)` pixels thick: a picture is drawn a
 * few times smaller than it is, and a thinner mark would be lost on the way.
 */
export function rasterShapes(shapes: readonly UiShape[], width: number, height: number): Uint8Array {
  const layer = new Uint8Array(width * height * 4);
  const thick = Math.max(3, Math.round(Math.min(width, height) / 32));
  const put = (x: number, y: number, color: UiColor, alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    const below = layer[at + 3]! / 255;
    if (alpha === 255 || below === 0) {
      layer.set(RGB[color], at);
      layer[at + 3] = alpha;
      return;
    }
    // A translucent mark over an earlier one: straight-alpha "over", so a highlight tints an arrow instead of erasing it.
    const over = alpha / 255;
    const out = over + below * (1 - over);
    RGB[color].forEach((channel, at2) => {
      layer[at + at2] = Math.round((channel * over + layer[at + at2]! * below * (1 - over)) / out);
    });
    layer[at + 3] = Math.round(out * 255);
  };
  const fill = (x0: number, y0: number, x1: number, y1: number, color: UiColor, alpha = 255) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) put(x, y, color, alpha);
  };
  const line = (ax: number, ay: number, bx: number, by: number, color: UiColor) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(ax + ((bx - ax) * step) / steps);
      const y = Math.round(ay + ((by - ay) * step) / steps);
      fill(x - Math.floor(thick / 2), y - Math.floor(thick / 2), x - Math.floor(thick / 2) + thick, y - Math.floor(thick / 2) + thick, color);
    }
  };
  for (const shape of shapes) {
    if (shape.shape === "arrow") {
      const [ax, ay, bx, by] = [shape.x1 * (width - 1), shape.y1 * (height - 1), shape.x2 * (width - 1), shape.y2 * (height - 1)];
      line(ax, ay, bx, by, shape.color);
      const angle = Math.atan2(by - ay, bx - ax);
      const head = Math.max(8, thick * 5);
      for (const turn of [Math.PI * 0.85, -Math.PI * 0.85]) line(bx, by, bx + Math.cos(angle + turn) * head, by + Math.sin(angle + turn) * head, shape.color);
      continue;
    }
    const x0 = Math.round(shape.x * width);
    const y0 = Math.round(shape.y * height);
    const x1 = Math.min(width, Math.max(x0 + 1, Math.round((shape.x + shape.w) * width)));
    const y1 = Math.min(height, Math.max(y0 + 1, Math.round((shape.y + shape.h) * height)));
    if (shape.shape === "highlight") {
      fill(x0, y0, x1, y1, shape.color, HIGHLIGHT_ALPHA);
    } else {
      fill(x0, y0, x1, y0 + thick, shape.color);
      fill(x0, y1 - thick, x1, y1, shape.color);
      fill(x0, y0, x0 + thick, y1, shape.color);
      fill(x1 - thick, y0, x1, y1, shape.color);
    }
  }
  return layer;
}

/** `|a − b|` per colour channel, opaque, for two images of one size. */
export function differencePixels(a: RawPixels, b: RawPixels): Uint8Array {
  const out = new Uint8Array(a.width * a.height * 4);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const from = y * a.stride + x * 4;
      const other = y * b.stride + x * 4;
      const to = (y * a.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) out[to + channel] = Math.abs(a.data[from + channel]! - b.data[other + channel]!);
      out[to + 3] = 255;
    }
  }
  return out;
}

/** The image scaled down, aspect kept, until it has at most `maxPixels`; the same one when it already does. */
function limitPixels(pic: Pic, maxPixels: number): Pic {
  const pixels = pic.width * pic.height;
  if (pixels <= maxPixels) return pic;
  const scale = Math.sqrt(maxPixels / pixels);
  const next = pic.resize({ width: Math.max(1, Math.floor(pic.width * scale)), height: Math.max(1, Math.floor(pic.height * scale)) });
  pic.dispose();
  return next;
}

/**
 * `source` through `ops` in order, as a new image the caller disposes (the
 * source is left alone). Each step reads the image as the one before left it:
 * a crop's coordinates are fractions of the whole, an annotation's of the crop.
 */
export function applyOps(source: Pic, ops: readonly UiOp[], factory: PicFactory = NATIVE_FACTORY, maxPixels = MAX_OUTPUT_PIXELS): Pic {
  let current = source;
  const step = (next: Pic) => {
    if (current !== source) current.dispose();
    current = next;
  };
  try {
    for (const op of ops) {
      if (op.op === "crop") {
        step(current.extract(cropRect(current, op)));
      } else if (op.op === "pad") {
        const extents = padExtents(current, op.aspect);
        if (extents !== null) step(current.extend({ ...extents, background: [0, 0, 0, 0] }));
      } else {
        const layer = factory.fromRgba(rasterShapes(op.shapes, current.width, current.height), current.width, current.height);
        try {
          step(current.composite(layer));
        } finally {
          layer.dispose();
        }
      }
    }
    // The caller owns the result: a copy when no step ran, so disposing it never frees the source.
    const result = current === source ? source.resize({ width: source.width, height: source.height }) : current;
    return limitPixels(result, maxPixels);
  } catch (error) {
    if (current !== source) current.dispose();
    throw error;
  }
}

/** `b` over `a` at `opacity`, or the difference of the two, as a new image the size of `a` (`b` is stretched to fit). */
export function blendPics(a: Pic, b: Pic, mode: "overlay" | "difference", opacity: number, factory: PicFactory = NATIVE_FACTORY, maxPixels = MAX_OUTPUT_PIXELS): Pic {
  const base = limitPixels(a.resize({ width: a.width, height: a.height }), maxPixels);
  const top = b.resize({ width: base.width, height: base.height });
  try {
    if (mode === "overlay") return base.composite(top, { opacity });
    const diff = differencePixels(base.raw(), top.raw());
    return factory.fromRgba(diff, base.width, base.height);
  } finally {
    top.dispose();
    base.dispose();
  }
}

/** A processed picture as the drawing code takes it: PNG bytes and a size. */
function toLoaded(pic: Pic): LoadedImage {
  const raw = pic.raw();
  const bytes = encodeRgbaPng(raw.width, raw.height, raw.data, raw.stride, true);
  return { mimeType: "image/png", bytes, size: { width: raw.width, height: raw.height } };
}

/** `image` through `ops`; the image itself when there are none, or when the native code cannot do them (the original is better than nothing). */
export function processImage(image: LoadedImage, ops: readonly UiOp[]): LoadedImage {
  if (ops.length === 0) return image;
  try {
    const source = NativeImage.decode(image.bytes) as unknown as Pic;
    try {
      const result = applyOps(source, ops);
      try {
        return toLoaded(result);
      } finally {
        result.dispose();
      }
    } finally {
      source.dispose();
    }
  } catch {
    return image;
  }
}

/** Two loaded images blended; null when the native code cannot decode them. */
export function blendLoaded(a: LoadedImage, b: LoadedImage, mode: "overlay" | "difference", opacity: number): LoadedImage | null {
  try {
    const first = NativeImage.decode(a.bytes) as unknown as Pic;
    const second = NativeImage.decode(b.bytes) as unknown as Pic;
    try {
      const result = blendPics(first, second, mode, opacity);
      try {
        return toLoaded(result);
      } finally {
        result.dispose();
      }
    } finally {
      first.dispose();
      second.dispose();
    }
  } catch {
    return null;
  }
}

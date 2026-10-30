/**
 * Shrinks an image that is over the API's limits, where it used to be
 * refused: decoded and resized with opentui's native image code (no new
 * dependency), then written back as a PNG. Lossless, and about 3 MB at the
 * target size for a photo. Which images need it, and the numbers, are
 * `core/attachments.ts`'s.
 */
import { NativeImage } from "@opentui/core";
import { deflateSync } from "node:zlib";

import { IMAGE_LIMITS, imageNeedsShrink, MAX_IMAGE_BYTES, SHRINK_TARGET_EDGE } from "../../core/attachments.js";
import { crc32 } from "../../core/usage/png.js";

/** The edge is cut by this much each time the result is still over the byte cap. */
const SHRINK_STEP = 0.75;
const MAX_ATTEMPTS = 6;

export interface ShrunkImage {
  name: string;
  mimeType: "image/png";
  bytes: Uint8Array;
  from: { width: number; height: number };
  to: { width: number; height: number };
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A PNG from 8-bit RGBA rows (`stride` bytes apart), as RGB when nothing in it is transparent. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array, stride: number, withAlpha: boolean): Uint8Array {
  const channels = withAlpha ? 4 : 3;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = withAlpha ? 6 : 2;
  const rowBytes = width * channels;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const out = row * (rowBytes + 1) + 1;
    const source = row * stride;
    if (withAlpha) raw.set(rgba.subarray(source, source + rowBytes), out);
    else for (let column = 0; column < width; column += 1) raw.set(rgba.subarray(source + column * 4, source + column * 4 + 3), out + column * 3);
  }
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((all, part) => all + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** `name` under a `.png` extension: the shrunk copy is a PNG whatever the original was. */
export function pngName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.png`;
}

/** An image as the shrinker needs it from a decoder: its size, and a copy at another size as RGBA rows. */
export interface DecodedImage {
  width: number;
  height: number;
  hasAlpha: boolean;
  resize(width: number, height: number): { width: number; height: number; stride: number; data: Uint8Array };
  dispose(): void;
}

/** opentui's native decoder. It needs Bun's FFI, so tests that run under Node pass their own. */
export function nativeDecoder(bytes: Uint8Array): DecodedImage {
  const source = NativeImage.decode(bytes);
  return {
    width: source.width,
    height: source.height,
    hasAlpha: source.info().hasAlpha,
    resize(width, height) {
      const resized = width === source.width && height === source.height ? source.clone() : source.resize({ width, height });
      try {
        const raw = resized.raw();
        // The pixels belong to the native image: copied out before it is released.
        return { width: raw.width, height: raw.height, stride: raw.stride, data: raw.data.slice() };
      } finally {
        resized.dispose();
      }
    },
    dispose: () => source.dispose(),
  };
}

/**
 * The image brought under the limits, or null when it needs no shrinking or
 * cannot be (not decodable, or still too large after every step): the
 * caller then attaches the original and the usual refusal speaks.
 * `many` is a message already holding more than 20 images, whose limit is 2000 px.
 */
export function shrinkImage(name: string, bytes: Uint8Array, many = false, decode: (bytes: Uint8Array) => DecodedImage = nativeDecoder): ShrunkImage | null {
  if (!imageNeedsShrink(bytes, many)) return null;
  let source: DecodedImage;
  try {
    source = decode(bytes);
  } catch {
    return null;
  }
  try {
    const from = { width: source.width, height: source.height };
    let edge = Math.min(SHRINK_TARGET_EDGE, many ? IMAGE_LIMITS.manyImagesMaxDimension : IMAGE_LIMITS.maxDimension);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(from.width, from.height));
      const resized = source.resize(Math.max(1, Math.round(from.width * scale)), Math.max(1, Math.round(from.height * scale)));
      const png = encodeRgbaPng(resized.width, resized.height, resized.data, resized.stride, source.hasAlpha);
      if (png.length <= MAX_IMAGE_BYTES) {
        return { name: pngName(name), mimeType: "image/png", bytes: png, from, to: { width: resized.width, height: resized.height } };
      }
      edge = Math.floor(edge * SHRINK_STEP);
    }
    return null;
  } catch {
    return null;
  } finally {
    source.dispose();
  }
}

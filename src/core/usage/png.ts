/**
 * A PNG made without a library: an RGB canvas to draw rectangles on, and the
 * encoder that writes it out. zlib ships with Node and Bun, and the rest of
 * the format is a signature, three chunk kinds and a CRC, so the stats card
 * costs no dependency and draws the same on every OS.
 */
import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

/** `#rrggbb` as its three bytes. */
export function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.data = new Uint8Array(width * height * 3);
    this.fillRect(0, 0, width, height, background);
  }

  /** Paints the rectangle, clipped to the canvas. */
  fillRect(x: number, y: number, width: number, height: number, color: Rgb): void {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(this.width, Math.round(x + width));
    const bottom = Math.min(this.height, Math.round(y + height));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const at = (row * this.width + column) * 3;
        this.data[at] = color[0];
        this.data[at + 1] = color[1];
        this.data[at + 2] = color[2];
      }
    }
  }

  pixel(x: number, y: number): Rgb {
    const at = (y * this.width + x) * 3;
    return [this.data[at]!, this.data[at + 1]!, this.data[at + 2]!];
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  // The checksum covers the type and the body, not the length.
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export function encodePng(canvas: Canvas): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, canvas.width);
  view.setUint32(4, canvas.height);
  // 8 bits a channel, colour type 2 (RGB), the one compression and filter method, no interlace.
  header[8] = 8;
  header[9] = 2;
  // Every row is led by its filter type; 0 is "none".
  const stride = canvas.width * 3;
  const raw = new Uint8Array((stride + 1) * canvas.height);
  for (let row = 0; row < canvas.height; row += 1) raw.set(canvas.data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((all, part) => all + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

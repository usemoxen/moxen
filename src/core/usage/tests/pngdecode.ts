import { inflateSync } from "node:zlib";

import { expect } from "vitest";

import { crc32 } from "../png.js";

/** Reads a PNG as this encoder writes it back: the chunks with their checksums verified, and the pixels. */
export function decodePng(png: Uint8Array): { width: number; height: number; pixel: (x: number, y: number) => [number, number, number]; chunks: string[] } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: string[] = [];
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push(type);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([...body.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  return {
    width,
    height,
    chunks,
    pixel: (x, y) => {
      const at = y * stride + 1 + x * 3;
      return [raw[at]!, raw[at + 1]!, raw[at + 2]!];
    },
  };
}


import { describe, expect, it } from "vitest";

import { Canvas, crc32, encodePng, rgb } from "../png.js";
import { decodePng } from "./pngdecode.js";

describe("png", () => {
  it("checksums the way the PNG spec does", () => {
    // The well-known check value for CRC-32 of "123456789".
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a file any reader opens: the signature, IHDR, IDAT and IEND, each checksummed, and the pixels back", () => {
    const canvas = new Canvas(5, 4, rgb("#102030"));
    canvas.fillRect(1, 1, 2, 2, rgb("#ff8000"));
    const png = encodePng(canvas);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const decoded = decodePng(png);
    expect(decoded.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([decoded.width, decoded.height]).toEqual([5, 4]);
    expect(decoded.pixel(0, 0)).toEqual([0x10, 0x20, 0x30]);
    expect(decoded.pixel(2, 2)).toEqual([0xff, 0x80, 0x00]);
    expect(decoded.pixel(3, 2)).toEqual([0x10, 0x20, 0x30]);
  });

  it("clips a rectangle to the canvas instead of writing past it", () => {
    const canvas = new Canvas(3, 3, rgb("#000000"));
    canvas.fillRect(-2, -2, 3, 3, rgb("#ffffff"));
    canvas.fillRect(2, 2, 10, 10, rgb("#ffffff"));
    expect(canvas.pixel(0, 0)).toEqual([255, 255, 255]);
    expect(canvas.pixel(1, 1)).toEqual([0, 0, 0]);
    expect(canvas.pixel(2, 2)).toEqual([255, 255, 255]);
    expect(canvas.data).toHaveLength(27);
  });
});

import { describe, expect, it } from "vitest";

import { attachmentFromBytes, imageDimensions, MAX_IMAGE_BYTES } from "../../../core/attachments.js";
import { encodeRgbaPng, pngName, shrinkImage, type DecodedImage } from "../imageshrink.js";

/** A solid PNG of exactly `width`×`height`. */
function png(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4).fill(200);
  return encodeRgbaPng(width, height, pixels, width * 4, false);
}

/**
 * A stand-in for opentui's decoder, which needs Bun's FFI and so cannot load
 * under Node, where these tests run (`render-check` shrinks a real image).
 * It reads the size from the PNG header unless told another, and answers a
 * resize with pixels no compressor can shrink, so a copy's file size is its
 * pixel count.
 */
function fakeDecoder(override?: { width: number; height: number; hasAlpha: boolean }) {
  const resizes: Array<[number, number]> = [];
  const decode = (bytes: Uint8Array): DecodedImage => {
    const size = override ?? { ...imageDimensions(bytes)!, hasAlpha: false };
    return {
      ...size,
      resize(width, height) {
        resizes.push([width, height]);
        const data = new Uint8Array(width * height * 4);
        let state = 0x9e3779b9;
        for (let at = 0; at < data.length; at += 1) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          data[at] = state & 0xff;
        }
        return { width, height, stride: width * 4, data };
      },
      dispose() {},
    };
  };
  return { decode, resizes };
}

describe("shrinking an image over a limit", () => {
  it("brings a side over 8000 px to a long edge of 1568, keeping the ratio, as a PNG the attachment rules accept", () => {
    const shrunk = shrinkImage("wide.jpg", png(9000, 300), false, fakeDecoder().decode);
    expect(shrunk).not.toBeNull();
    expect(shrunk!.from).toEqual({ width: 9000, height: 300 });
    expect(shrunk!.to).toEqual({ width: 1568, height: 52 });
    expect(shrunk!.name).toBe("wide.png");
    expect(imageDimensions(shrunk!.bytes)).toEqual({ width: 1568, height: 52 });
    expect(attachmentFromBytes(shrunk!.name, shrunk!.mimeType, shrunk!.bytes).error).toBeNull();
  });

  it("keeps shrinking an image whose copy is still over the byte cap, until it fits", () => {
    // 1568 px square with transparency is 9.8 MB of noise, over the 7.5 MB cap; the next step down fits.
    const fake = fakeDecoder({ width: 9000, height: 9000, hasAlpha: true });
    const shrunk = shrinkImage("huge.png", png(9000, 300), false, fake.decode);
    expect(fake.resizes[0]).toEqual([1568, 1568]);
    expect(fake.resizes.length).toBeGreaterThan(1);
    expect(shrunk!.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(shrunk!.to.width).toBe(1176);
  });

  it("leaves an image within the limits alone", () => {
    const fake = fakeDecoder();
    expect(shrinkImage("small.png", png(3000, 2000), false, fake.decode)).toBeNull();
    expect(fake.resizes).toEqual([]);
  });

  it("holds each image to 2000 px once a message carries more than 20", () => {
    const fake = fakeDecoder();
    expect(shrinkImage("a.png", png(3000, 2000), true, fake.decode)?.to).toEqual({ width: 1568, height: 1045 });
  });

  it("does not shrink what it cannot read", () => {
    const failing = () => {
      throw new Error("not an image");
    };
    expect(shrinkImage("broken.png", png(9000, 300), false, failing)).toBeNull();
  });

  it("names the copy as a PNG whatever the original was", () => {
    expect(pngName("photo.final.jpeg")).toBe("photo.final.png");
    expect(pngName("noext")).toBe("noext.png");
  });
});

import { describe, expect, it } from "vitest";

import type { UiOp } from "../../../core/threads/uiblock.js";
import { applyOps, blendPics, cropRect, differencePixels, padExtents, rasterShapes, type Pic, type PicFactory, type RawPixels } from "../imageops.js";

/** A native image's stand-in: RGBA rows in memory, the operations as plainly as they can be written. */
class FakePic implements Pic {
  disposed = false;
  composites: Array<{ opacity: number | undefined; left: number | undefined; top: number | undefined }> = [];
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Uint8Array = new Uint8Array(width * height * 4),
  ) {}
  static solid(width: number, height: number, color: [number, number, number, number]): FakePic {
    const pic = new FakePic(width, height);
    for (let at = 0; at < width * height; at++) pic.data.set(color, at * 4);
    return pic;
  }
  pixel(x: number, y: number): number[] {
    return [...this.data.subarray((y * this.width + x) * 4, (y * this.width + x) * 4 + 4)];
  }
  extract({ left, top, width, height }: { left: number; top: number; width: number; height: number }): Pic {
    if (left < 0 || top < 0 || width < 1 || height < 1 || left + width > this.width || top + height > this.height) throw new Error("invalid image argument");
    const out = new FakePic(width, height);
    for (let y = 0; y < height; y++) out.data.set(this.data.subarray(((top + y) * this.width + left) * 4, ((top + y) * this.width + left + width) * 4), y * width * 4);
    return out;
  }
  extend({ top = 0, right = 0, bottom = 0, left = 0, background = [0, 0, 0, 0] }: { top?: number; right?: number; bottom?: number; left?: number; background?: readonly [number, number, number, number] }): Pic {
    const out = new FakePic(this.width + left + right, this.height + top + bottom);
    for (let at = 0; at < out.width * out.height; at++) out.data.set(background, at * 4);
    for (let y = 0; y < this.height; y++) out.data.set(this.data.subarray(y * this.width * 4, (y + 1) * this.width * 4), ((top + y) * out.width + left) * 4);
    return out;
  }
  resize({ width, height }: { width: number; height: number }): Pic {
    const out = new FakePic(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.data.set(this.pixel(Math.floor((x * this.width) / width), Math.floor((y * this.height) / height)), (y * width + x) * 4);
    return out;
  }
  composite(overlay: Pic, options: { left?: number; top?: number; opacity?: number } = {}): Pic {
    this.composites.push({ opacity: options.opacity, left: options.left, top: options.top });
    const out = new FakePic(this.width, this.height, this.data.slice());
    const top = overlay as FakePic;
    for (let y = 0; y < top.height; y++) {
      for (let x = 0; x < top.width; x++) {
        const alpha = (top.pixel(x, y)[3]! / 255) * (options.opacity ?? 1);
        const base = out.pixel(x, y);
        const over = top.pixel(x, y);
        out.data.set([0, 1, 2].map((channel) => Math.round(base[channel]! * (1 - alpha) + over[channel]! * alpha)), (y * out.width + x) * 4);
      }
    }
    return out;
  }
  raw(): RawPixels {
    return { data: this.data, width: this.width, height: this.height, stride: this.width * 4 };
  }
  dispose(): void {
    this.disposed = true;
  }
}

const factory: PicFactory = { fromRgba: (pixels, width, height) => new FakePic(width, height, pixels) };
const RED = [230, 57, 70];

describe("cropRect", () => {
  it("takes whole pixels from fractions of the image", () => {
    expect(cropRect({ width: 200, height: 100 }, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 })).toEqual({ left: 50, top: 50, width: 100, height: 50 });
  });

  it("keeps a crop that rounds to nothing, or runs a pixel over, inside the image", () => {
    expect(cropRect({ width: 100, height: 100 }, { x: 0.999, y: 0.999, w: 0.001, h: 0.001 })).toEqual({ left: 99, top: 99, width: 1, height: 1 });
    expect(cropRect({ width: 101, height: 100 }, { x: 0.5, y: 0, w: 0.5, h: 1 })).toEqual({ left: 51, top: 0, width: 50, height: 100 });
  });
});

describe("padExtents", () => {
  it("pads a tall image sideways to a wide shape, the extra cell going to the right", () => {
    expect(padExtents({ width: 100, height: 100 }, 2)).toEqual({ left: 50, right: 50, top: 0, bottom: 0 });
    expect(padExtents({ width: 51, height: 100 }, 1)).toEqual({ left: 24, right: 25, top: 0, bottom: 0 });
  });

  it("pads a wide image downward and upward to a tall shape", () => {
    expect(padExtents({ width: 100, height: 20 }, 1)).toEqual({ top: 40, bottom: 40, left: 0, right: 0 });
  });

  it("leaves an image that is within a pixel of the shape", () => {
    expect(padExtents({ width: 200, height: 100 }, 2)).toBeNull();
    expect(padExtents({ width: 200, height: 100 }, 2.004)).toBeNull();
  });
});

describe("rasterShapes", () => {
  const at = (layer: Uint8Array, width: number, x: number, y: number) => [...layer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

  it("draws a box as an outline and leaves its inside and the rest of the image clear", () => {
    const layer = rasterShapes([{ shape: "box", x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: "red" }], 40, 40);
    expect(at(layer, 40, 10, 10)).toEqual([...RED, 255]);
    expect(at(layer, 40, 29, 29)).toEqual([...RED, 255]);
    expect(at(layer, 40, 20, 20)).toEqual([0, 0, 0, 0]);
    expect(at(layer, 40, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it("draws a highlight as a translucent fill", () => {
    const layer = rasterShapes([{ shape: "highlight", x: 0, y: 0, w: 0.5, h: 1, color: "yellow" }], 20, 20);
    expect(at(layer, 20, 5, 5)).toEqual([250, 200, 30, 90]);
    expect(at(layer, 20, 15, 5)).toEqual([0, 0, 0, 0]);
  });

  it("draws an arrow through both its ends, with a head that leaves the line", () => {
    const layer = rasterShapes([{ shape: "arrow", x1: 0, y1: 0.5, x2: 1, y2: 0.5, color: "green" }], 60, 60);
    expect(at(layer, 60, 0, 30)[3]).toBe(255);
    expect(at(layer, 60, 59, 30)[3]).toBe(255);
    expect(at(layer, 60, 30, 30)[3]).toBe(255);
    // The head's barbs reach above and below the line, near its tip.
    const marked = (x: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, at) => at + from).some((y) => at(layer, 60, x, y)[3] === 255);
    expect(marked(53, 20, 27)).toBe(true);
    expect(marked(53, 33, 40)).toBe(true);
    expect(at(layer, 60, 20, 10)[3]).toBe(0);
  });

  it("lets a later translucent mark tint an earlier one instead of erasing it", () => {
    const layer = rasterShapes(
      [
        { shape: "box", x: 0, y: 0, w: 1, h: 1, color: "red" },
        { shape: "highlight", x: 0, y: 0, w: 1, h: 1, color: "white" },
      ],
      30,
      30,
    );
    // The box's edge stays opaque and lighter; inside there is only the highlight.
    expect(at(layer, 30, 1, 15)[3]).toBe(255);
    expect(at(layer, 30, 1, 15)[1]).toBeGreaterThan(57);
    expect(at(layer, 30, 15, 15)).toEqual([255, 255, 255, 90]);
  });

  it("keeps a shape that runs past the edge inside the layer", () => {
    expect(() => rasterShapes([{ shape: "box", x: 0.9, y: 0.9, w: 0.1, h: 0.1, color: "blue" }, { shape: "arrow", x1: 0, y1: 0, x2: 1, y2: 1, color: "white" }], 10, 10)).not.toThrow();
  });
});

describe("differencePixels", () => {
  it("is black where two images agree and shows by how much they differ where they do not", () => {
    const a = FakePic.solid(2, 1, [100, 100, 100, 255]);
    const b = FakePic.solid(2, 1, [100, 100, 100, 255]);
    b.data.set([160, 100, 40, 255], 4);
    const diff = differencePixels(a.raw(), b.raw());
    expect([...diff]).toEqual([0, 0, 0, 255, 60, 0, 60, 255]);
  });
});

describe("applyOps", () => {
  const crop = (x: number, y: number, w: number, h: number): UiOp => ({ op: "crop", x, y, w, h });

  it("crops, then pads the crop, in the order written", () => {
    const source = FakePic.solid(200, 100, [10, 20, 30, 255]);
    const out = applyOps(source, [crop(0, 0, 0.5, 1), { op: "pad", aspect: 2 }], factory);
    expect([out.width, out.height]).toEqual([200, 100]);
    // The padding is transparent and centred: the 100-wide crop sits between two 50-wide bands.
    expect((out as FakePic).pixel(10, 50)).toEqual([0, 0, 0, 0]);
    expect((out as FakePic).pixel(100, 50)).toEqual([10, 20, 30, 255]);
  });

  it("reads an annotation's coordinates against the crop before it, not the whole image", () => {
    const source = FakePic.solid(100, 100, [0, 0, 0, 255]);
    const out = applyOps(source, [crop(0.5, 0.5, 0.5, 0.5), { op: "annotate", shapes: [{ shape: "highlight", x: 0, y: 0, w: 1, h: 1, color: "red" }] }], factory) as FakePic;
    expect([out.width, out.height]).toEqual([50, 50]);
    expect(out.pixel(0, 0)[0]).toBeGreaterThan(50);
    expect(out.pixel(49, 49)[0]).toBeGreaterThan(50);
  });

  it("leaves the source alone, hands back a copy when no step changed it, and frees what it made on the way", () => {
    const source = FakePic.solid(100, 50, [1, 2, 3, 255]);
    const same = applyOps(source, [{ op: "pad", aspect: 2 }], factory);
    expect(same).not.toBe(source);
    expect([same.width, same.height]).toEqual([100, 50]);
    expect(source.disposed).toBe(false);
  });

  it("scales a result over the pixel cap down to it, aspect kept", () => {
    const out = applyOps(FakePic.solid(400, 200, [1, 2, 3, 255]), [crop(0, 0, 1, 1)], factory, 20_000);
    expect(out.width * out.height).toBeLessThanOrEqual(20_000);
    expect(out.width / out.height).toBeCloseTo(2, 1);
  });

  it("does not leave the image it made half-way behind when a step throws", () => {
    const source = FakePic.solid(10, 10, [1, 2, 3, 255]);
    const first = source.extract({ left: 0, top: 0, width: 5, height: 5 }) as FakePic;
    const seen: FakePic[] = [];
    const broken = new Proxy(source, {
      get(target, key) {
        if (key === "extract") return () => (seen.push(first), first);
        return Reflect.get(target, key);
      },
    });
    expect(() => applyOps(broken as FakePic, [crop(0, 0, 0.5, 0.5), { op: "annotate", shapes: [{ shape: "box", x: 0, y: 0, w: 1, h: 1, color: "red" }] }], { fromRgba: () => { throw new Error("no layer"); } })).toThrow("no layer");
    expect(first.disposed).toBe(true);
    expect(source.disposed).toBe(false);
  });
});

describe("blendPics", () => {
  it("lays b over a at the opacity, b stretched to a's size", () => {
    const a = FakePic.solid(4, 4, [255, 0, 0, 255]);
    const b = FakePic.solid(2, 2, [0, 0, 255, 255]);
    const out = blendPics(a, b, "overlay", 0.25, factory) as FakePic;
    expect([out.width, out.height]).toEqual([4, 4]);
    expect(out.pixel(1, 1)).toEqual([191, 0, 64, 255]);
  });

  it("shows the difference of two images and nothing where they match", () => {
    const a = FakePic.solid(2, 1, [200, 200, 200, 255]);
    const b = FakePic.solid(2, 1, [200, 200, 200, 255]);
    b.data.set([200, 0, 200, 255], 4);
    const out = blendPics(a, b, "difference", 0.5, factory) as FakePic;
    expect(out.pixel(0, 0)).toEqual([0, 0, 0, 255]);
    expect(out.pixel(1, 0)).toEqual([0, 200, 0, 255]);
  });
});

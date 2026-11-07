import { describe, expect, it } from "vitest";

import { imageDimensions } from "../../../core/attachments.js";
import { encodeRgbaPng, type DecodedImage } from "../imageshrink.js";
import { loadDisplay, MAX_CACHED_DISPLAY, toDisplayOutcome, type DisplayOutcome } from "../imagedisplay.js";
import { processImage } from "../imageops.js";
import type { LoadedImage } from "../imagethumb.js";

/** A solid PNG of exactly `width`×`height`. */
function png(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4).fill(200);
  return encodeRgbaPng(width, height, pixels, width * 4, false);
}

function loaded(width: number, height: number): LoadedImage {
  return { mimeType: "image/png", bytes: png(width, height), size: { width, height } };
}

/** opentui's decoder stood in: reads the PNG header, answers a resize call with noise. */
function fakeDecode(bytes: Uint8Array): DecodedImage {
  const size = imageDimensions(bytes)!;
  return {
    ...size,
    hasAlpha: false,
    resize: (width: number, height: number) => ({ width, height, stride: width * 4, data: new Uint8Array(width * height * 4) }),
    dispose: () => {},
  };
}

describe("one verdict and display copy per cache key", () => {
  it("shares the outcome between surfaces instead of probing again", async () => {
    let starts = 0;
    const key = `test-share-${Date.now()}`;
    const start = async (): Promise<DisplayOutcome> => {
      starts += 1;
      return toDisplayOutcome(loaded(100, 80), fakeDecode);
    };
    const [first, second] = await Promise.all([loadDisplay(key, start), loadDisplay(key, start)]);
    expect(starts).toBe(1);
    expect(second).toBe(first);
    expect(first).toEqual({ status: "ready", display: expect.anything(), original: expect.anything() });
  });

  it("bounds the cache, redoing an evicted key", async () => {
    const prefix = `test-bound-${Date.now()}-`;
    let starts = 0;
    const start = async (): Promise<DisplayOutcome> => {
      starts += 1;
      return toDisplayOutcome(loaded(10, 10), fakeDecode);
    };
    await loadDisplay(`${prefix}first`, start);
    for (let at = 0; at < MAX_CACHED_DISPLAY; at += 1) await loadDisplay(`${prefix}${at}`, start);
    const before = starts;
    await loadDisplay(`${prefix}first`, start);
    expect(starts).toBe(before + 1);
  });

  it("maps a rejecting starter to missing instead of an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let settled: DisplayOutcome | null = null;
      // As useDisplay subscribes: fulfillment only, never awaited here, so a
      // rejection with no handler would escape to the process and kill the TUI.
      void loadDisplay(`test-reject-${Date.now()}`, async (): Promise<DisplayOutcome> => {
        throw new Error("starter-boom");
      }).then((outcome) => {
        settled = outcome;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toEqual({ status: "missing" });
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("toDisplayOutcome", () => {
  it("says missing when there are no bytes", async () => {
    expect(await toDisplayOutcome(null, fakeDecode)).toEqual({ status: "missing" });
  });

  it("keeps the original bytes on an undrawable image, for the viewer and opening externally", async () => {
    const image = loaded(100, 80);
    const outcome = await toDisplayOutcome(image, () => {
      throw new Error("image dimensions exceed limits");
    });
    expect(outcome).toEqual({ status: "undrawable", original: image });
  });

  it("draws an image within the cap as it is", async () => {
    const image = loaded(100, 80);
    expect(await toDisplayOutcome(image, fakeDecode)).toEqual({ status: "ready", display: image, original: image });
  });

  it("draws an image over the cap from a smaller copy, keeping the original", async () => {
    const image = loaded(9000, 300);
    const outcome = await toDisplayOutcome(image, fakeDecode);
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.original).toBe(image);
    expect(outcome.display.size).toEqual({ width: 4096, height: 137 });
  });

  it("takes corrupt bytes with ops to the undrawable fallback instead of throwing", async () => {
    const corrupt: LoadedImage = { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), size: { width: 10, height: 10 } };
    const outcome = await toDisplayOutcome(
      processImage(corrupt, [{ op: "pad", aspect: 1 }]),
      () => {
        throw new Error("image dimensions exceed limits");
      },
    );
    expect(outcome).toEqual({ status: "undrawable", original: corrupt });
  });
});

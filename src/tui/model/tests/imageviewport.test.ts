import { describe, expect, it } from "vitest";

import { FIT_VIEW, imageGeometry, panImage, zoomImage } from "../imageviewport.js";

describe("image viewer viewport", () => {
  it("expands a wide image into the letterbox space instead of refitting a crop", () => {
    const size = { width: 1200, height: 300 };
    const canvas = { width: 80, height: 40 };
    expect(imageGeometry(size, canvas, FIT_VIEW)).toMatchObject({ width: 80, height: 10, left: 0, top: 15 });
    expect(imageGeometry(size, canvas, zoomImage(FIT_VIEW, 3))).toMatchObject({ width: 240, height: 30, left: -80, top: 5 });
    const panned = imageGeometry(size, canvas, panImage(zoomImage(FIT_VIEW, 3), -10, 10));
    expect(panned).toMatchObject({ left: 0, top: 5 });
    expect(panned.view.y).toBe(0); // Still fits vertically: pan must not move it out of the canvas.
    expect(imageGeometry(size, canvas, zoomImage(panned.view, 1 / 3)).view).toEqual(FIT_VIEW);
  });

  it("expands a tall image horizontally and clamps it at the viewport edges", () => {
    const size = { width: 100, height: 400 };
    const canvas = { width: 80, height: 40 };
    const view = imageGeometry(size, canvas, panImage(zoomImage(FIT_VIEW, 2), 10, -10));
    expect(view).toMatchObject({ width: 40, height: 80, left: 20, top: 0 });
    expect(view.view.x).toBe(0);
    expect(imageGeometry(size, { width: 20, height: 10 }, view.view)).toMatchObject({ width: 10, height: 20, left: 5, top: 0 });
    expect(imageGeometry(size, canvas, FIT_VIEW, 1)).toMatchObject({ width: 10, height: 40, left: 35 });
  });

  it("never zooms past the fit and maximum scale", () => {
    expect(zoomImage(FIT_VIEW, 0.5)).toEqual(FIT_VIEW);
    expect(zoomImage(FIT_VIEW, 1000).zoom).toBe(16);
  });
});

import { describe, expect, it } from "vitest";

import { imageFromDataUrl, previewPlacement, thumbnailCells } from "../imagethumb.js";

describe("thumbnail cells", () => {
  it("fits a wide image to the column limit, keeping its aspect with cells twice as tall as wide", () => {
    // 2:1 image: 2 * 2 = 4 columns per row, so 24 columns allow 6 rows.
    expect(thumbnailCells({ width: 2000, height: 1000 }, 24, 8)).toEqual({ columns: 24, rows: 6 });
  });

  it("limits a tall image by rows", () => {
    // 1:2 image: 1 column per row; 8 rows -> 8 columns.
    expect(thumbnailCells({ width: 500, height: 1000 }, 24, 8)).toEqual({ columns: 8, rows: 8 });
  });

  it("never exceeds the box and is at least one cell", () => {
    expect(thumbnailCells({ width: 4000, height: 10 }, 24, 8)).toEqual({ columns: 24, rows: 1 });
    expect(thumbnailCells({ width: 1, height: 4000 }, 24, 8)).toEqual({ columns: 1, rows: 8 });
  });

  it("honors a measured cell aspect", () => {
    // Square cells: a square image is as many columns as rows.
    expect(thumbnailCells({ width: 100, height: 100 }, 24, 8, 1)).toEqual({ columns: 8, rows: 8 });
  });

  it("returns null for an image with no usable size", () => {
    expect(thumbnailCells({ width: 0, height: 10 }, 24, 8)).toBeNull();
    expect(thumbnailCells({ width: 10, height: Number.NaN }, 24, 8)).toBeNull();
  });
});

/** A PNG header with the given size: all `imageDimensions` reads. */
function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

describe("imageFromDataUrl", () => {
  it("decodes an attachment.read reply into its bytes and pixel size", () => {
    const image = imageFromDataUrl(`data:image/png;base64,${pngHeader(640, 480).toString("base64")}`);
    expect(image?.bytes).toHaveLength(33);
    expect(image?.size).toEqual({ width: 640, height: 480 });
  });

  it("says null for anything that is not an image with a readable size", () => {
    expect(imageFromDataUrl("not a data url")).toBeNull();
    expect(imageFromDataUrl(`data:image/png;base64,${Buffer.from("plain text, no header").toString("base64")}`)).toBeNull();
  });
});

describe("previewPlacement", () => {
  const screen = { width: 100, height: 40 };
  const wide = { width: 2000, height: 1000 };

  it("goes above the item when there is more room there, touching it", () => {
    const anchor = { x: 10, y: 30, width: 24, height: 9 };
    const placed = previewPlacement(wide, anchor, screen);
    // 2:1 image, 72 columns wide at most -> 18 rows; box is 74x20, ending right where the item starts.
    expect(placed).toEqual({ left: 10, top: 10, columns: 72, rows: 18 });
  });

  it("goes below the item when it is near the top", () => {
    const anchor = { x: 5, y: 2, width: 24, height: 9 };
    const placed = previewPlacement(wide, anchor, screen);
    expect(placed?.top).toBe(11);
  });

  it("fits the image to the room that side leaves", () => {
    // 6 rows above the item, 4 of them for the image once the border takes 2.
    const placed = previewPlacement({ width: 100, height: 100 }, { x: 0, y: 6, width: 10, height: 34 }, screen);
    expect(placed).toMatchObject({ rows: 4, top: 0 });
  });

  it("keeps the box inside the screen sideways", () => {
    const placed = previewPlacement(wide, { x: 90, y: 30, width: 24, height: 9 }, screen);
    // 74 wide box cannot start past 100 - 74.
    expect(placed?.left).toBe(26);
  });

  it("is null when not even one image cell fits", () => {
    expect(previewPlacement(wide, { x: 0, y: 1, width: 10, height: 38 }, screen)).toBeNull();
  });
});

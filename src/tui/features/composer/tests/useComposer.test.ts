import { describe, expect, it } from "vitest";

import type { ImageAttachmentUpload } from "../../../../core/attachments.js";
import { mergeAttachments } from "../useComposer.js";

const image = (name: string, sizeBytes = 10): ImageAttachmentUpload => ({
  type: "image", name, mimeType: "image/png", sizeBytes, dataUrl: `data:image/png;base64,${name}`,
});

describe("mergeAttachments", () => {
  it("returns the current images untouched when nothing went out", () => {
    const current = [image("a.png")];
    expect(mergeAttachments(current, [])).toEqual(current);
  });

  it("puts images from a failed send back after newer ones", () => {
    expect(mergeAttachments([image("fresh.png", 20)], [image("sent.png", 10)])).toEqual([image("fresh.png", 20), image("sent.png", 10)]);
  });

  it("does not duplicate an image that is already back", () => {
    const both = [image("a.png", 10), image("b.png", 20)];
    expect(mergeAttachments(both, [image("a.png", 10)])).toEqual(both);
  });

  it("tells same-name images apart by size", () => {
    expect(mergeAttachments([image("a.png", 10)], [image("a.png", 99)])).toEqual([image("a.png", 10), image("a.png", 99)]);
  });
});

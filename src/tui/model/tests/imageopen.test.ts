import { readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { imageFileName, writeImageToTemp } from "../imageopen.js";

describe("image file name", () => {
  it("keeps the label's name under the image type's own extension", () => {
    expect(imageFileName("clipboard-1.png", "image/png")).toBe("clipboard-1.png");
    expect(imageFileName("photo.jpeg", "image/jpeg")).toBe("photo.jpg");
  });

  it("does not let a label with separators or reserved characters leave the temp folder", () => {
    expect(imageFileName("../../etc/a:b?.png", "image/png")).toBe(".._.._etc_a_b_.png");
    expect(imageFileName("", "image/webp")).toBe("image.webp");
  });

  it.each(["CON", "nul.png", "Com1", "lpt9.jpeg"])("does not name a file after the Windows device %s", (label) => {
    expect(imageFileName(label, "image/png")).toMatch(/^image-/u);
  });

  it("drops a trailing dot or space, which Windows removes from a name", () => {
    expect(imageFileName("shot. .png", "image/png")).toBe("shot.png");
  });
});

describe("image written for the system viewer", () => {
  it("lands in its own temp folder under a name every OS accepts, with the exact bytes", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255]);
    const file = await writeImageToTemp('a/b:"c"?.png', "image/png", bytes);
    try {
      // Windows can hand back a short temp path (RUNNER~1) for the same folder.
      expect(path.dirname(path.dirname(realpathSync.native(file)))).toBe(realpathSync.native(tmpdir()));
      expect(path.basename(file)).toBe("a_b__c__.png");
      expect(readFileSync(file)).toEqual(Buffer.from(bytes));
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

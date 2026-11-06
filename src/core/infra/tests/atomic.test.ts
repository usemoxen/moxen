import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renameReplacing, writeAtomic } from "../atomic.js";

describe("atomic file replacement", () => {
  it("replaces an existing file, so readers see the old or the new content, never a mix", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-atomic-"));
    const file = path.join(dir, "data.json");
    await writeFile(file, "old", "utf8");
    await writeAtomic(file, "new\n");
    expect(await readFile(file, "utf8")).toBe("new\n");
  });

  it("renames over an existing target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-atomic-"));
    const from = path.join(dir, "from");
    const to = path.join(dir, "to");
    await writeFile(from, "next", "utf8");
    await writeFile(to, "current", "utf8");
    await renameReplacing(from, to);
    expect(await readFile(to, "utf8")).toBe("next");
  });

  it("refuses a missing source instead of retrying it as a locked target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-atomic-"));
    await expect(renameReplacing(path.join(dir, "absent"), path.join(dir, "to"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cardPalette } from "../../model/cardtheme.js";
import { useStatsCard } from "../hooks/useStatsCard.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CARD = { png: PNG.toString("base64"), filename: "moxen-stats-2026-10-29.png" };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(options: { query?: (request: unknown) => Promise<unknown>; copyImage?: (file: string, mimeType: string) => Promise<boolean> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-card-dir-"));
  dirs.push(dir);
  const toasts: Array<{ tone: string; text: string }> = [];
  const copied: string[] = [];
  const save = useStatsCard({
    client: { query: options.query ?? (async () => CARD) } as never,
    dir,
    clipboard: { copyText: async (text: string) => (copied.push(text), true) },
    toasts: { push: (_id: string, tone: string, text: string) => void toasts.push({ tone, text }) } as never,
    copyImage: options.copyImage ?? (async () => false),
  });
  const settled = async () => {
    for (let waited = 0; waited < 50 && toasts.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { dir, save, toasts, copied, settled };
}

describe("copying the stats card", () => {
  it("puts the server's PNG on the clipboard as an image, through a temp file that is gone after, and saves nothing", async () => {
    const asked: unknown[] = [];
    const seen: Array<{ file: string; mimeType: string; bytes: number[] }> = [];
    const { dir, save, toasts, copied, settled } = await setup({
      query: async (request) => (asked.push(request), CARD),
      copyImage: async (file, mimeType) => {
        seen.push({ file, mimeType, bytes: [...(await readFile(file))] });
        return true;
      },
    });
    save("7d");
    await settled();
    expect(asked).toEqual([{ type: "usage.card", range: "7d", palette: cardPalette() }]);
    expect(seen).toHaveLength(1);
    // The file the clipboard tool read held the card, was not in the work folder, and is removed.
    expect(seen[0]).toMatchObject({ mimeType: "image/png", bytes: [...PNG] });
    expect(path.basename(seen[0]!.file)).toBe(CARD.filename);
    expect(path.dirname(seen[0]!.file).startsWith(dir)).toBe(false);
    expect(existsSync(seen[0]!.file)).toBe(false);
    expect(toasts).toEqual([{ tone: "info", text: expect.not.stringContaining(dir) }]);
    expect(copied).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("saves the card in the folder when there is no image clipboard, copies its path, and says so", async () => {
    const { dir, save, toasts, copied, settled } = await setup({ copyImage: async () => false });
    save("all");
    await settled();
    const file = path.join(dir, CARD.filename);
    expect([...(await readFile(file))]).toEqual([...PNG]);
    expect(toasts).toEqual([{ tone: "info", text: expect.stringContaining(file) }]);
    expect(copied).toEqual([file]);
  });

  it("treats a clipboard tool that throws as no clipboard, and never overwrites an earlier card", async () => {
    const { dir, save, toasts, settled } = await setup({
      copyImage: async () => {
        throw new Error("no xclip");
      },
    });
    save("all");
    await settled();
    toasts.length = 0;
    save("all");
    await settled();
    expect((await readdir(dir)).sort()).toEqual(["moxen-stats-2026-10-29-2.png", "moxen-stats-2026-10-29.png"]);
  });

  it("says so, and leaves nothing behind, when the card cannot be had", async () => {
    const { dir, save, toasts, settled } = await setup({
      query: async () => {
        throw new Error("server went away");
      },
    });
    save("all");
    await settled();
    expect(toasts).toEqual([{ tone: "danger", text: expect.stringContaining("server went away") }]);
    expect(await readdir(dir)).toEqual([]);
  });
});

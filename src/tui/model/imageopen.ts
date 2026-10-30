import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { imageExtension } from "../../core/attachments.js";
import { openExternal } from "../../core/infra/platformOpen.js";

/** Names Windows reserves for devices, with or without an extension (`CON.png` is the console). */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/** A file name safe on every OS, ending in the image's own extension. */
export function imageFileName(label: string, mimeType: string): string {
  const extension = imageExtension(mimeType);
  // Windows drops a trailing dot or space from a name, so none is kept.
  const cleaned = path.parse(label.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")).name.trim().replace(/[. ]+$/u, "");
  const base = cleaned.length === 0 ? "image" : WINDOWS_DEVICE_NAME.test(cleaned) ? `image-${cleaned}` : cleaned;
  return `${base}${extension}`;
}

/**
 * Opens an image in the system's viewer (Preview, Photos, ...). The bytes come
 * from the server and the server may be another machine, so they are written
 * to a fresh temp folder here first; the OS cleans temp folders itself.
 */
export async function openImageExternally(label: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  await openExternal(await writeImageToTemp(label, mimeType, bytes));
}

/** Writes the image under a fresh temp folder and returns its path. */
export async function writeImageToTemp(label: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "moxen-image-"));
  const file = path.join(folder, imageFileName(label, mimeType));
  await writeFile(file, bytes);
  return file;
}

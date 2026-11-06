/**
 * What the TUI draws for one image: one verdict and display copy per cache
 * key, shared by the transcript, the hover preview and the viewer, so the
 * native decode and downscale run once no matter how many surfaces show the
 * picture. The fetch beneath stays shared too: every starter reads through
 * `loadImage`, whose own cache remembers the bytes by the same key.
 *
 * Keys name their surface (`reply:`, `attachment:`, `composer:`, `blend:`)
 * so a path a reply names can never collide with an attachment id. A reply's
 * key holds its message scope, path and operations: the same file rewritten
 * at the same path, or drawn through other operations, is another entry.
 */
import { useEffect, useRef, useState, type DependencyList } from "react";

import { drawableImage, type DecodedImage } from "./imageshrink.js";
import type { LoadedImage } from "./imagethumb.js";

/** What drawing one image found: a copy to draw and the original it came from, or why there is none. */
export type DisplayOutcome =
  | { status: "ready"; display: LoadedImage; original: LoadedImage }
  | { status: "undrawable"; original: LoadedImage }
  | { status: "missing" };

/** Entries are display copies, which run bigger than the bytes they came from; the bound is tighter than the fetch cache's. */
export const MAX_CACHED_DISPLAY = 16;
const displays = new Map<string, Promise<DisplayOutcome>>();

/** The outcome for `key`, starting it with `start` only when no surface has: every surface passes an equivalent starter. */
export function loadDisplay(key: string, start: () => Promise<DisplayOutcome>): Promise<DisplayOutcome> {
  const hit = displays.get(key);
  if (hit !== undefined) return hit;
  const pending = start();
  displays.set(key, pending);
  if (displays.size > MAX_CACHED_DISPLAY) displays.delete(displays.keys().next().value as string);
  return pending;
}

/**
 * Fetched bytes through the display rules: missing when there are none, a
 * smaller copy when the image is only too big, the original kept for the
 * viewer and opening externally when the decoder cannot read it at all.
 * The decode waits a turn first, so the one-line loading row paints before
 * a huge image ties up this thread.
 */
export async function toDisplayOutcome(image: LoadedImage | null, decode?: (bytes: Uint8Array) => DecodedImage): Promise<DisplayOutcome> {
  if (image === null) return { status: "missing" };
  await new Promise((resolve) => setTimeout(resolve, 0));
  const display = drawableImage(image, decode);
  return display === null ? { status: "undrawable", original: image } : { status: "ready", display, original: image };
}

/** The shared outcome for `key`, null while it comes: the caller draws its one-line loading row meanwhile. */
export function useDisplay(key: string | null, start: () => Promise<DisplayOutcome>, deps: DependencyList): DisplayOutcome | null {
  const [outcome, setOutcome] = useState<DisplayOutcome | null>(null);
  const starter = useRef(start);
  starter.current = start;
  useEffect(() => {
    if (key === null) return;
    setOutcome(null);
    let live = true;
    void loadDisplay(key, () => starter.current()).then((result) => {
      if (live) setOutcome(result);
    });
    return () => {
      live = false;
    };
    // The caller passes what the starter closes over; the key names the entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  return outcome;
}

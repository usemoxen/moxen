import { useKeyboard } from "@opentui/react";
import { useEffect, useSyncExternalStore } from "react";

import { previewPlacement, type Rect } from "../../model/imagethumb.js";
import { SURFACE } from "../../theme.js";
import { useModalOpen } from "../../ui/modalopen.js";
import { useImageViewer } from "./imageviewer.js";

/** The image the pointer is over, and where its item is on screen. */
export interface ImagePreview {
  /** The attachment's id: only the item that showed a preview can hide it. */
  id: string;
  bytes: Uint8Array;
  size: { width: number; height: number };
  anchor: Rect;
}

let current: ImagePreview | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showImagePreview(preview: ImagePreview): void {
  current = preview;
  emit();
}

/** Hides the preview, if `id` is the one showing: moving from one item to the next must not hide the new one's. */
export function hideImagePreview(id: string): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useImagePreview(): ImagePreview | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether a preview is showing: the composer hides its text cursor then, which would blink over the image. */
export function useImagePreviewVisible(): boolean {
  return useImagePreview() !== null;
}

/** Hides whatever preview is showing. */
export function clearImagePreview(): void {
  if (current === null) return;
  current = null;
  emit();
}

/**
 * The hover preview: the image at a larger size in a bordered box beside the
 * item the pointer is over. It is a layer of the app, not part of the item,
 * so the scrolling timeline cannot clip it, and it sits above everything that
 * can hold an image (a Kitty image is hidden by whatever is painted over it).
 * A modal ends it: its dimming layer would turn the image black.
 */
export function ImagePreviewLayer({ screenWidth, screenHeight }: { screenWidth: number; screenHeight: number }) {
  const preview = useImagePreview();
  const modalOpen = useModalOpen();
  const viewing = useImageViewer() !== null;
  useEffect(() => {
    if (modalOpen) clearImagePreview();
  }, [modalOpen]);
  // Typing or a key-driven scroll moves what the preview is anchored to.
  useKeyboard(() => clearImagePreview());

  if (preview === null || modalOpen || viewing) return null;
  const placed = previewPlacement(preview.size, preview.anchor, { width: screenWidth, height: screenHeight });
  if (placed === null) return null;
  return (
    <box
      style={{ position: "absolute", left: placed.left, top: placed.top, width: placed.columns + 2, height: placed.rows + 2, zIndex: 15 }}
      border
      borderStyle="rounded"
      borderColor={SURFACE.borderFocus}
      backgroundColor={SURFACE.raised}
      selectable={false}
    >
      <image source={preview.bytes} fit="fit" style={{ width: placed.columns, height: placed.rows }} />
    </box>
  );
}

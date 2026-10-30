import type { BoxRenderable } from "@opentui/core";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { useHover } from "../../hooks/useHover.js";
import { t } from "../../i18n/index.js";
import type { LoadedImage } from "../../model/imagethumb.js";
import { formatBytes } from "../../model/message.js";
import { COLOR, SURFACE } from "../../theme.js";
import type { Rect } from "../../model/imagethumb.js";
import { clearImagePreview } from "./imagepreview.js";

/** The image the full-screen view shows. */
export interface ViewedImage extends LoadedImage {
  label: string;
  sizeBytes: number | null;
}

let current: ViewedImage | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Where the viewer's pane is on screen, for the dimming around it. */
let pane: Rect | null = null;

export function openImageViewer(image: ViewedImage): void {
  clearImagePreview();
  current = image;
  emit();
}

function setPane(rect: Rect | null): void {
  if (pane?.x === rect?.x && pane?.y === rect?.y && pane?.width === rect?.width && pane?.height === rect?.height) return;
  pane = rect;
  emit();
}

/** Closes the view; false when none was open, so a key handler knows whether Esc was its own. */
export function closeImageViewer(): boolean {
  if (current === null) return false;
  current = null;
  pane = null;
  emit();
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useImageViewer(): ViewedImage | null {
  return useSyncExternalStore(subscribe, () => current);
}

function usePane(): Rect | null {
  return useSyncExternalStore(subscribe, () => pane);
}

/**
 * Dims everything but the viewer's pane and the composer below it (the full height of the sidebar and side panel too),
 * as a modal dims its background. The dim is three boxes around the pane's column, not
 * one layer over it: a dimming layer over an image turns it black.
 */
export function ImageViewerDim({ screenWidth, screenHeight }: { screenWidth: number; screenHeight: number }) {
  const viewed = useImageViewer();
  const rect = usePane();
  if (viewed === null || rect === null) return null;
  const dim = (key: string, left: number, top: number, width: number, height: number) =>
    width > 0 && height > 0 ? (
      <box
        key={key}
        style={{ position: "absolute", left, top, width, height, zIndex: 20 }}
        backgroundColor="#000000"
        opacity={0.5}
        selectable={false}
        onMouseDown={() => {
          closeImageViewer();
        }}
      />
    ) : null;
  return (
    <>
      {dim("left", 0, 0, rect.x, screenHeight)}
      {dim("top", rect.x, 0, rect.width, rect.y)}
      {dim("right", rect.x + rect.width, 0, screenWidth - rect.x - rect.width, screenHeight)}
      {/* Below the pane the composer stays bright. */}
    </>
  );
}

function HeaderButton({ label, onPress, color = COLOR.dim }: { label: string; onPress: () => void; color?: string }) {
  const { hovered, handlers } = useHover();
  return (
    <text fg={hovered ? COLOR.bright : color} bg={hovered ? SURFACE.hover : SURFACE.base} selectable={false} onMouseDown={onPress} {...handlers}>
      {` ${label} `}
    </text>
  );
}

/**
 * A sent image at the size the pane allows, in place of the transcript. It is
 * not a modal, so nothing dims it (a dimming layer turns an image black) and
 * the composer stays below it, which a modal would cover. Esc, the close
 * button or a click on the image closes it.
 */
export function ImageViewer({ image, onClose, onOpenExternally }: { image: ViewedImage; onClose: () => void; onOpenExternally: () => void }) {
  const ref = useRef<BoxRenderable>(null);
  const publish = () => {
    const node = ref.current;
    if (node !== null) setPane({ x: node.screenX, y: node.screenY, width: node.width, height: node.height });
  };
  useEffect(publish);
  useEffect(() => () => setPane(null), []);
  const detail = `${image.size.width}×${image.size.height}${image.sizeBytes === null ? "" : ` · ${formatBytes(image.sizeBytes)}`}`;
  return (
    <box
      ref={ref}
      onSizeChange={publish}
      style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0 }}
      border
      borderStyle="rounded"
      borderColor={SURFACE.borderFocus}
      backgroundColor={SURFACE.base}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        <text fg={COLOR.bright} selectable={false}>{`▣ ${image.label}`}</text>
        <text fg={COLOR.dim} selectable={false}>{`  ${detail}`}</text>
        <box style={{ flexGrow: 1 }} />
        <HeaderButton label={t("imageViewer.open")} onPress={onOpenExternally} />
        <HeaderButton label="✕" onPress={onClose} />
      </box>
      <box style={{ flexGrow: 1, minHeight: 0, alignItems: "center", justifyContent: "center" }} onMouseDown={onClose}>
        <image source={image.bytes} fit="fit" style={{ flexGrow: 1, width: "100%" }} />
      </box>
    </box>
  );
}

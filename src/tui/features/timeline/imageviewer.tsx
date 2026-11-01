import type { BoxRenderable, CliRenderer } from "@opentui/core";
import { createContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { t } from "../../i18n/index.js";
import type { LoadedImage } from "../../model/imagethumb.js";
import { formatBytes } from "../../model/message.js";
import { COLOR, SURFACE } from "../../theme.js";
import type { Rect } from "../../model/imagethumb.js";
import { clearImagePreview } from "./imagepreview.js";
import { FIT_VIEW, imageGeometry, panImage, zoomImage, type ImageViewport } from "../../model/imageviewport.js";
import { isModalOpen } from "../../ui/modalopen.js";

/** Loaded pictures in one block, keyed by their position in its tree. */
export const ImageSetContext = createContext<Map<string, ViewedImage> | null>(null);

/** The image the full-screen view shows. */
export interface ViewedImage extends LoadedImage {
  label: string;
  sizeBytes: number | null;
}

let current: ViewedImage | null = null;
let images: readonly ViewedImage[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Where the viewer's pane is on screen, for the dimming around it. */
let panes = new WeakMap<CliRenderer, Rect>();

export function openImageViewer(image: ViewedImage, set: readonly ViewedImage[] = [image]): void {
  clearImagePreview();
  images = set.includes(image) ? [...set] : [image];
  current = image;
  emit();
}

function setPane(renderer: CliRenderer, rect: Rect | null): void {
  const pane = panes.get(renderer);
  if (pane?.x === rect?.x && pane?.y === rect?.y && pane?.width === rect?.width && pane?.height === rect?.height) return;
  if (rect === null) panes.delete(renderer);
  else panes.set(renderer, rect);
  emit();
}

/** Closes the view; false when none was open, so a key handler knows whether Esc was its own. */
export function closeImageViewer(): boolean {
  if (current === null) return false;
  current = null;
  images = [];
  panes = new WeakMap();
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
  const renderer = useRenderer();
  return useSyncExternalStore(subscribe, () => panes.get(renderer) ?? null);
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
 * button or a click outside the pane closes it. The image itself accepts dragging.
 */
export function ImageViewer({ image, onClose, onOpenExternally }: { image: ViewedImage; onClose: () => void; onOpenExternally: () => void }) {
  const renderer = useRenderer();
  const ref = useRef<BoxRenderable>(null);
  const canvasRef = useRef<BoxRenderable>(null);
  const [canvas, setCanvas] = useState({ width: 1, height: 1 });
  const measureCanvas = () => {
    const node = canvasRef.current;
    if (node === null) return;
    const width = Math.max(1, node.width);
    const height = Math.max(1, node.height);
    setCanvas((previous) => previous.width === width && previous.height === height ? previous : { width, height });
  };
  useEffect(measureCanvas);
  const [view, setView] = useState(FIT_VIEW);
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { setView(FIT_VIEW); drag.current = null; }, [image]);
  const resolution = renderer.resolution;
  const cellAspect = resolution === null ? 2 : (resolution.height / renderer.terminalHeight) / (resolution.width / renderer.terminalWidth);
  const geometry = imageGeometry(image.size, canvas, view, cellAspect);
  const changeView = (update: (value: ImageViewport) => ImageViewport) => {
    setView((value) => imageGeometry(image.size, canvas, update(imageGeometry(image.size, canvas, value, cellAspect).view), cellAspect).view);
  };
  const index = images.indexOf(image);
  const step = (delta: number) => {
    const at = current === null ? -1 : images.indexOf(current);
    const next = at < 0 ? undefined : images[at + delta];
    if (next !== undefined) { current = next; emit(); }
  };
  const zoom = (factor: number) => changeView((value) => zoomImage(value, factor));
  useKeyboard((key) => {
    if (isModalOpen() || key.ctrl || key.meta || key.option) return;
    if (key.name === "escape") onClose();
    else if (key.name === "left" && !key.shift) step(-1);
    else if (key.name === "right" && !key.shift) step(1);
    else if (key.sequence === "+" || key.sequence === "=") zoom(1.25);
    else if (key.sequence === "-") zoom(0.8);
    else if (key.sequence === "0") setView(FIT_VIEW);
    else if (["up", "down", "left", "right"].includes(key.name)) {
      changeView((value) => panImage(value, (key.name === "left" ? -0.1 : key.name === "right" ? 0.1 : 0) / value.zoom, (key.name === "up" ? -0.1 : key.name === "down" ? 0.1 : 0) / value.zoom));
    } else return;
    key.preventDefault();
    key.stopPropagation();
  });
  const publish = () => {
    const node = ref.current;
    if (node !== null) setPane(renderer, { x: node.screenX, y: node.screenY, width: node.width, height: node.height });
  };
  useEffect(publish);
  useEffect(() => () => setPane(renderer, null), [renderer]);
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
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        {images.length > 1 && <>
          <HeaderButton label="←" onPress={() => step(-1)} />
          <text fg={COLOR.dim} selectable={false}>{`${index + 1}/${images.length}`}</text>
          <HeaderButton label="→" onPress={() => step(1)} />
        </>}
        <HeaderButton label="−" onPress={() => zoom(0.8)} />
        <HeaderButton label={`${Math.round(view.zoom * 100)}%`} onPress={() => setView(FIT_VIEW)} />
        <HeaderButton label="+" onPress={() => zoom(1.25)} />
        <text fg={COLOR.dim} selectable={false}>{t("imageViewer.controls")}</text>
      </box>
      <box ref={canvasRef} onSizeChange={measureCanvas} style={{ flexGrow: 1, minHeight: 0, overflow: "hidden" }}
        onMouseDown={(event) => { if (event.button === 0) drag.current = { x: event.x, y: event.y }; }}
        onMouseDrag={(event) => {
          const from = drag.current;
          if (from === null) return;
          changeView((value) => panImage(value, (from.x - event.x) / geometry.width, (from.y - event.y) / geometry.height));
          drag.current = { x: event.x, y: event.y };
        }}
        onMouseUp={() => { drag.current = null; }}
        onMouseDragEnd={() => { drag.current = null; }}
        onMouseScroll={(event) => {
          if (event.scroll?.direction !== "up" && event.scroll?.direction !== "down") return;
          zoom(event.scroll.direction === "up" ? 1.25 : 0.8);
          event.stopPropagation();
        }}>
        <image source={image.bytes} fit="fill" style={{ position: "absolute", left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }} />
      </box>
    </box>
  );
}

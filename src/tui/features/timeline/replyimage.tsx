import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { useImageVisibility } from "../../hooks/useImageVisibility.js";
import { thumbnailCells, type LoadedImage } from "../../model/imagethumb.js";
import { nativeDecoder } from "../../model/imageshrink.js";
import { toDisplayOutcome, useDisplay, type DisplayOutcome } from "../../model/imagedisplay.js";
import { blendLoaded, processImage } from "../../model/imageops.js";
import { mosaicRows } from "../../model/mosaic.js";
import type { UiImage, UiOp } from "../../../core/threads/uiblock.js";
import { COLOR } from "../../theme.js";
import { useModalOpen } from "../../ui/modalopen.js";
import { loadImage, type AttachmentReader } from "./attachmentrow.js";
import { Placeholder, UndrawableLine } from "./imagefallback.js";
import { ImageSetContext, openImageViewer, type ViewedImage } from "./imageviewer.js";

export const ImagePositionContext = createContext("");

/** Reads an image a reply shows, by the path the reply names (`image.read`). Provided by `Timeline`. */
export const ReplyImageReaderContext = createContext<AttachmentReader | null>(null);

/**
 * Which message an image belongs to. A file can be rewritten at the same path
 * between two replies (a screenshot saved over the last one), so an image is
 * remembered per message and path: the same message never fetches it twice,
 * and a later one that names the path gets the file as it is then.
 */
export const ReplyImageScopeContext = createContext<string>("");

/** The widest and tallest a reply's image is drawn, in cells, pane permitting. */
const MAX_COLUMNS = 72;
const MAX_ROWS = 24;
/** What the pane and the card take from the terminal's width. */
const SIDE_ROOM = 12;

/** The image as rows of mosaic cells at `columns`×`rows`: null when it cannot be decoded. */
function mosaicOf(image: LoadedImage, columns: number, rows: number) {
  try {
    const decoded = nativeDecoder(image.bytes);
    try {
      const pixels = decoded.resize(columns, rows * 2);
      return mosaicRows(pixels.data, pixels.width, rows, pixels.stride);
    } finally {
      decoded.dispose();
    }
  } catch {
    return null;
  }
}

/** The image a path names: null while the bytes come, "failed" when they cannot. */
function useLoadedImage(path: string): LoadedImage | null | "failed" {
  const reader = useContext(ReplyImageReaderContext);
  const scope = useContext(ReplyImageScopeContext);
  const [image, setImage] = useState<LoadedImage | null | "failed">(null);
  useEffect(() => {
    if (reader === null) return;
    let live = true;
    void loadImage(reader, path, `${scope}\u0000${path}`).then((loaded) => {
      if (live) setImage(loaded ?? "failed");
    });
    return () => {
      live = false;
    };
  }, [reader, path, scope]);
  return image;
}

interface PictureProps {
  /** Said under the image. */
  label: string;
  /** The cells a `moxen-ui` block gives this image; a lone image takes what the screen allows. */
  maxColumns?: number | undefined;
  /** Inside a `moxen-ui` block: take the height the row gives, with the caption at its foot, so captions side by side line up. */
  fill?: boolean;
}

/**
 * A loaded image drawn in the transcript: the real image, or while a modal is
 * open the same picture as text cells (a dimming layer would turn the real one
 * black). A click opens it full screen.
 */
function ImagePicture({
  original,
  display,
  label,
  maxColumns,
  fill = false,
}: PictureProps & { original: LoadedImage; display: LoadedImage | null }) {
  const set = useContext(ImageSetContext);
  const position = useContext(ImagePositionContext);
  const id = useId();
  const undrawable = display === null;
  const viewed = useMemo<ViewedImage>(
    () => ({ ...original, label, sizeBytes: original.bytes.length, undrawable }),
    [original, label, undrawable],
  );
  useEffect(() => {
    if (set === null) return;
    const key = position || id;
    set.set(key, viewed);
    return () => { set.delete(key); };
  }, [set, position, id, viewed]);
  const modalOpen = useModalOpen();
  const { width: screenWidth } = useTerminalDimensions();
  const { hovered, handlers } = useHover();
  const { ref, visible } = useImageVisibility();
  const [drawFailed, setDrawFailed] = useState(false);
  useEffect(() => {
    setDrawFailed(false);
  }, [display, original]);
  const open = () => openImageViewer(viewed, set === null ? [viewed] : [...set.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([, value]) => value));
  // The display copy is drawn; the original is what the viewer opens. Only a
  // known-drawable picture reserves rows, so a known-undrawable one never
  // flashes a blank block, on load or on scrolling back.
  const cells = thumbnailCells(undrawable ? original.size : display.size, Math.max(8, maxColumns ?? Math.min(MAX_COLUMNS, screenWidth - SIDE_ROOM)), MAX_ROWS);
  const mosaic = useMemo(
    () => visible && modalOpen && cells !== null && display !== null ? mosaicOf(display, cells.columns, cells.rows) : null,
    [display, visible, modalOpen, cells?.columns, cells?.rows],
  );
  if (cells === null) return <text fg={COLOR.dim} selectable={false}>{`▣ ${label}`}</text>;
  if (undrawable || (drawFailed && mosaic === null)) {
    return <UndrawableLine label={label} onOpen={open} width={cells.columns} fill={fill} />;
  }
  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        width: cells.columns,
        ...(fill ? { flexGrow: 1, justifyContent: "space-between" as const } : {}),
      }}
      onMouseDown={open}
      {...handlers}
    >
      <box ref={ref} style={{ height: cells.rows, width: cells.columns, flexShrink: 0 }}>
        {!visible ? null : mosaic === null ? (
          <image source={display === null ? original.bytes : display.bytes} onError={() => setDrawFailed(true)} fit="fit" style={{ width: cells.columns, height: cells.rows }} />
        ) : (
          mosaic.map((runs, row) => (
            <text key={row} selectable={false}>
              {runs.map((run, at) => (
                <span key={at} fg={run.fg} bg={run.bg}>
                  {run.text}
                </span>
              ))}
            </text>
          ))
        )}
      </box>
      <text fg={hovered ? COLOR.bright : COLOR.faint} selectable={false}>{label}</text>
    </box>
  );
}

/**
 * An image a reply shows, through the operations the reply asks for. The
 * verdict and display copy are shared with the hover preview and the viewer
 * under one key per message, path and operations, so the native decode runs
 * once: while the verdict is unknown a one-line loading row stands in, never
 * a blank reserved block.
 */
export function ReplyImage({
  path,
  alt,
  caption,
  maxColumns,
  fill = false,
  ops = [],
}: {
  path: string;
  alt: string;
  /** Said under the image instead of its alt text or path. */
  caption?: string | undefined;
  /** What is done to the image before it is drawn (crop, pad, annotate). */
  ops?: readonly UiOp[];
} & Omit<PictureProps, "label">) {
  const reader = useContext(ReplyImageReaderContext);
  const scope = useContext(ReplyImageScopeContext);
  const opsKey = JSON.stringify(ops);
  const outcome = useDisplay(
    reader === null ? null : `reply:${scope}\u0000${path}\u0000${opsKey}`,
    async () =>
      toDisplayOutcome(
        await loadImage(reader!, path, `${scope}\u0000${path}`).then((loaded) => (loaded === null ? null : processImage(loaded, ops))),
      ),
    [reader, scope, path, opsKey],
  );
  const label = caption !== undefined && caption.length > 0 ? caption : alt.length > 0 ? alt : path;
  if (outcome === null) return <Placeholder label={label} state="loading" />;
  if (outcome.status === "missing") return <Placeholder label={label} state="failed" />;
  return (
    <ImagePicture
      original={outcome.original}
      display={outcome.status === "ready" ? outcome.display : null}
      label={label}
      maxColumns={maxColumns}
      fill={fill}
    />
  );
}

/** Two images of a reply in one: `b` laid over `a`, or what differs between them. */
export function BlendedImage({
  a,
  b,
  mode,
  opacity,
  caption,
  maxColumns,
  fill = false,
}: {
  a: UiImage;
  b: UiImage;
  mode: "overlay" | "difference";
  opacity: number;
  caption?: string | undefined;
} & Omit<PictureProps, "label">) {
  const reader = useContext(ReplyImageReaderContext);
  const scope = useContext(ReplyImageScopeContext);
  const first = useLoadedImage(a.src);
  const second = useLoadedImage(b.src);
  const key = JSON.stringify([a.ops, b.ops, mode, opacity]);
  // The whole blend runs once per message, inputs and operations: fetching,
  // blending and the display rules share one entry, off the render path.
  const outcome = useDisplay(
    reader === null ? null : `blend:${scope}\u0000${a.src}\u0000${b.src}\u0000${key}`,
    async (): Promise<DisplayOutcome> => {
      const [loadedFirst, loadedSecond] = await Promise.all([
        loadImage(reader!, a.src, `${scope}\u0000${a.src}`),
        loadImage(reader!, b.src, `${scope}\u0000${b.src}`),
      ]);
      if (loadedFirst === null || loadedSecond === null) return { status: "missing" };
      const blended = blendLoaded(processImage(loadedFirst, a.ops), processImage(loadedSecond, b.ops), mode, opacity);
      // The blend comes out of the native code small; what the viewer can
      // still need is an original, so the first input stands in, unused here.
      if (blended === null) return { status: "undrawable", original: loadedFirst };
      return { status: "ready", display: blended, original: blended };
    },
    [reader, scope, a.src, b.src, key],
  );
  const label = caption !== undefined && caption.length > 0 ? caption : `${a.caption ?? (a.alt || a.src)} · ${b.caption ?? (b.alt || b.src)}`;
  // What the viewer opens from a fallback line: the inputs that did come.
  const viewable = (input: UiImage, image: LoadedImage | null | "failed"): ViewedImage[] =>
    image === null || image === "failed"
      ? []
      : [{ ...image, label: input.caption ?? (input.alt || input.src), sizeBytes: image.bytes.length, undrawable: false }];
  const viewed = [...viewable(a, first), ...viewable(b, second)];
  const openInputs = () => {
    if (viewed.length > 0) openImageViewer(viewed[0]!, viewed);
  };
  if (outcome === null) return <Placeholder label={label} state="loading" />;
  if (outcome.status === "missing") {
    if (viewed.length === 0) return <Placeholder label={label} state="failed" />;
    return (
      <box onMouseDown={openInputs} style={{ flexDirection: "column", flexShrink: 0, ...(maxColumns === undefined ? {} : { width: maxColumns }), ...(fill ? { flexGrow: 1 } : {}) }}>
        <Placeholder label={label} state="failed" />
      </box>
    );
  }
  // The blend cannot be drawn (an input the decoder cannot read): one
  // clickable line, opening the viewer on the inputs that did come.
  if (outcome.status === "undrawable") return <UndrawableLine label={label} onOpen={openInputs} width={maxColumns} fill={fill} />;
  return <ImagePicture original={outcome.original} display={outcome.display} label={label} maxColumns={maxColumns} fill={fill} />;
}

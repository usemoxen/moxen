import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { useImageVisibility } from "../../hooks/useImageVisibility.js";
import { imageFromDataUrl, thumbnailCells, type LoadedImage } from "../../model/imagethumb.js";
import { drawableImage, nativeDecoder } from "../../model/imageshrink.js";
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
function ImagePicture({ image, label, maxColumns, fill = false }: PictureProps & { image: LoadedImage }) {
  const set = useContext(ImageSetContext);
  const position = useContext(ImagePositionContext);
  const id = useId();
  const viewed = useMemo(() => ({ ...image, label, sizeBytes: image.bytes.length }), [image, label]);
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
  }, [image]);
  const open = () => openImageViewer(viewed, set === null ? [viewed] : [...set.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([, value]) => value));
  // What is drawn: a smaller copy when the image is only too big, null when
  // the native decoder cannot read it at all. The probe runs only once the
  // box is on screen: decoding every image in the transcript up front would
  // hold them all in native memory at once.
  const drawable = useMemo(() => (visible && !drawFailed ? drawableImage(image) : null), [image, visible, drawFailed]);
  const cells = thumbnailCells(image.size, Math.max(8, maxColumns ?? Math.min(MAX_COLUMNS, screenWidth - SIDE_ROOM)), MAX_ROWS);
  const mosaic = useMemo(
    () => visible && modalOpen && cells !== null && drawable !== null ? mosaicOf(drawable, cells.columns, cells.rows) : null,
    [drawable, visible, modalOpen, cells?.columns, cells?.rows],
  );
  if (cells === null) return <text fg={COLOR.dim} selectable={false}>{`▣ ${label}`}</text>;
  // Nothing drawable (over the native ceiling, or corrupt): one clickable
  // line that opens the viewer, where the original bytes still open externally.
  if (visible && drawable === null) return <UndrawableLine label={label} onOpen={open} />;
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
          <image source={drawable!.bytes} onError={() => setDrawFailed(true)} fit="fit" style={{ width: cells.columns, height: cells.rows }} />
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
 * An image a reply shows, through the operations the reply asks for. While the
 * bytes come, or if they cannot, a text row stands in for it.
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
  const loaded = useLoadedImage(path);
  const opsKey = JSON.stringify(ops);
  const image = useMemo(() => (loaded === null || loaded === "failed" ? loaded : processImage(loaded, ops)), [loaded, opsKey]);
  const label = caption !== undefined && caption.length > 0 ? caption : alt.length > 0 ? alt : path;
  if (image === null || image === "failed") return <Placeholder label={label} state={image ?? "loading"} />;
  return <ImagePicture image={image} label={label} maxColumns={maxColumns} fill={fill} />;
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
  const first = useLoadedImage(a.src);
  const second = useLoadedImage(b.src);
  const key = JSON.stringify([a.ops, b.ops, mode, opacity]);
  const blended = useMemo(() => {
    if (first === null || first === "failed" || second === null || second === "failed") return null;
    return blendLoaded(processImage(first, a.ops), processImage(second, b.ops), mode, opacity);
  }, [first, second, key]);
  const label = caption !== undefined && caption.length > 0 ? caption : `${a.caption ?? (a.alt || a.src)} · ${b.caption ?? (b.alt || b.src)}`;
  // What the viewer opens from a fallback line: the inputs that did come.
  const viewable = (input: UiImage, image: LoadedImage | null | "failed"): ViewedImage[] =>
    image === null || image === "failed" ? [] : [{ ...image, label: input.caption ?? (input.alt || input.src), sizeBytes: image.bytes.length }];
  const viewed = [...viewable(a, first), ...viewable(b, second)];
  const openInputs = () => {
    if (viewed.length > 0) openImageViewer(viewed[0]!, viewed);
  };
  if (first === "failed" || second === "failed") {
    if (viewed.length === 0) return <Placeholder label={label} state="failed" />;
    return (
      <box onMouseDown={openInputs} style={{ flexShrink: 0 }}>
        <Placeholder label={label} state="failed" />
      </box>
    );
  }
  if (first === null || second === null) return <Placeholder label={label} state="loading" />;
  // The blend cannot be drawn (an input the decoder cannot read): one
  // clickable line, opening the viewer on the inputs that did come.
  if (blended === null) return <UndrawableLine label={label} onOpen={openInputs} />;
  return <ImagePicture image={blended} label={label} maxColumns={maxColumns} fill={fill} />;
}

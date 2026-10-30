import { createContext, useContext, useEffect, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { imageFromDataUrl, thumbnailCells, type LoadedImage } from "../../model/imagethumb.js";
import { nativeDecoder } from "../../model/imageshrink.js";
import { mosaicRows } from "../../model/mosaic.js";
import { COLOR } from "../../theme.js";
import { useModalOpen } from "../../ui/modalopen.js";
import { loadImage, type AttachmentReader } from "./attachmentrow.js";
import { openImageViewer } from "./imageviewer.js";

/** Reads an image a reply shows, by the path the reply names (`image.read`). Provided by `Timeline`. */
export const ReplyImageReaderContext = createContext<AttachmentReader | null>(null);

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

/**
 * An image a reply shows, drawn in the transcript: the real image, or while a
 * modal is open the same picture as text cells (a dimming layer would turn the
 * real one black). A click opens it full screen. While the bytes come, or if
 * they cannot, a text row stands in for it.
 */
export function ReplyImage({ path, alt }: { path: string; alt: string }) {
  const reader = useContext(ReplyImageReaderContext);
  const modalOpen = useModalOpen();
  const { width: screenWidth } = useTerminalDimensions();
  const { hovered, handlers } = useHover();
  const [image, setImage] = useState<LoadedImage | null | "failed">(null);

  useEffect(() => {
    if (reader === null) return;
    let live = true;
    void loadImage(reader, path).then((loaded) => {
      if (live) setImage(loaded ?? "failed");
    });
    return () => {
      live = false;
    };
  }, [reader, path]);

  const label = alt.length > 0 ? alt : path;
  if (image === null || image === "failed") {
    return (
      <text fg={image === "failed" ? COLOR.faint : COLOR.dim} selectable={false}>
        {`▣ ${label}${image === "failed" ? " (not found)" : ""}`}
      </text>
    );
  }
  const cells = thumbnailCells(image.size, Math.max(8, Math.min(MAX_COLUMNS, screenWidth - SIDE_ROOM)), MAX_ROWS);
  if (cells === null) return <text fg={COLOR.dim} selectable={false}>{`▣ ${label}`}</text>;
  const mosaic = modalOpen ? mosaicOf(image, cells.columns, cells.rows) : null;
  return (
    <box
      style={{ flexDirection: "column", flexShrink: 0, width: cells.columns }}
      onMouseDown={() => openImageViewer({ ...image, label, sizeBytes: image.bytes.length })}
      {...handlers}
    >
      <box style={{ height: cells.rows, width: cells.columns, flexShrink: 0 }}>
        {mosaic === null ? (
          <image source={image.bytes} fit="fit" style={{ width: cells.columns, height: cells.rows }} />
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

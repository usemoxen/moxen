/**
 * The hover preview of a message's image: how many cells it takes and where
 * it goes. Pure, so the sizing is testable without a terminal; the layer
 * (`features/timeline/imagepreview.tsx`) only draws what this decides. The
 * bytes come from the server (`attachment.read`), never from a path: the
 * server may be a paired machine.
 */
import { decodeDataUrl, imageDimensions } from "../../core/attachments.js";

/** A terminal cell is about twice as tall as it is wide; the renderer measures the real ratio when it can. */
const DEFAULT_CELL_ASPECT = 2;

/**
 * The cells a `width`×`height` image fits in, aspect ratio kept and never
 * larger than the box. A degenerate image (no size) yields null: the caller
 * shows the text row instead.
 */
export function thumbnailCells(
  size: { width: number; height: number },
  maxColumns: number,
  maxRows: number,
  cellAspect = DEFAULT_CELL_ASPECT,
): { columns: number; rows: number } | null {
  if (!(size.width > 0) || !(size.height > 0) || !(maxColumns >= 1) || !(maxRows >= 1)) return null;
  // Columns the image needs per row of height, once cells are taller than wide.
  const columnsPerRow = (size.width / size.height) * cellAspect;
  const rows = Math.max(1, Math.min(maxRows, Math.floor(maxColumns / columnsPerRow)));
  const columns = Math.max(1, Math.min(maxColumns, Math.round(rows * columnsPerRow)));
  return { columns, rows };
}

/** A fetched image: its bytes and its own pixel size. */
export interface LoadedImage {
  mimeType: string;
  bytes: Uint8Array;
  size: { width: number; height: number };
}

/** An image from an `attachment.read` reply; null when it is not an image whose header states a size. */
export function imageFromDataUrl(dataUrl: string): LoadedImage | null {
  const decoded = decodeDataUrl(dataUrl);
  if (decoded === null) return null;
  const bytes = new Uint8Array(Buffer.from(decoded.data, "base64"));
  const size = imageDimensions(bytes);
  return size === null ? null : { mimeType: decoded.mimeType, bytes, size };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a hover preview goes: its outer box's corner, and the cells its image takes (the border adds one on every side). */
export interface PreviewPlacement {
  left: number;
  top: number;
  columns: number;
  rows: number;
}

/** The widest and tallest a hover preview's image gets, screen permitting. */
export const PREVIEW_MAX_COLUMNS = 72;
export const PREVIEW_MAX_ROWS = 28;

/**
 * A preview touching the hovered item, on whichever side has more room (above
 * on a tie), never covering it: the pointer over the preview would end the
 * hover and the preview would flicker. The image is fitted to the room that
 * side leaves, and the box is kept inside the screen. Null when no image
 * cell fits.
 */
export function previewPlacement(
  size: { width: number; height: number },
  anchor: Rect,
  screen: { width: number; height: number },
  maxColumns = PREVIEW_MAX_COLUMNS,
  maxRows = PREVIEW_MAX_ROWS,
): PreviewPlacement | null {
  const above = anchor.y;
  const below = screen.height - (anchor.y + anchor.height);
  const onTop = above >= below;
  const border = 2;
  const cells = thumbnailCells(size, Math.min(maxColumns, screen.width - border), Math.min(maxRows, (onTop ? above : below) - border));
  if (cells === null) return null;
  const width = cells.columns + border;
  const height = cells.rows + border;
  return {
    left: Math.max(0, Math.min(anchor.x, screen.width - width)),
    top: onTop ? anchor.y - height : anchor.y + anchor.height,
    ...cells,
  };
}

import type { BoxRenderable } from "@opentui/core";
import { createContext, useContext, useEffect, useRef } from "react";

import { useHover } from "../../hooks/useHover.js";
import { imageFromDataUrl, type LoadedImage } from "../../model/imagethumb.js";
import { formatBytes } from "../../model/message.js";
import { COLOR } from "../../theme.js";
import { hideImagePreview, showImagePreview } from "./imagepreview.js";
import { openImageViewer } from "./imageviewer.js";

/** Reads a sent image by attachment id from the server (`attachment.read`). */
export type AttachmentReader = (attachmentId: string) => Promise<{ mimeType: string; dataUrl: string }>;

/** Provided by `Timeline`, so the message rows need no prop for it. */
export const AttachmentReaderContext = createContext<AttachmentReader | null>(null);

/**
 * Images already fetched, newest last: hovering the same attachment again
 * must not ask the server for its bytes again.
 */
const MAX_CACHED = 16;
const cache = new Map<string, Promise<LoadedImage | null>>();

function loadImage(reader: AttachmentReader, attachmentId: string): Promise<LoadedImage | null> {
  const hit = cache.get(attachmentId);
  if (hit !== undefined) return hit;
  const pending = reader(attachmentId)
    .then((read) => imageFromDataUrl(read.dataUrl))
    .catch(() => null)
    .then((image) => {
      // A miss is not remembered: the next hover asks again.
      if (image === null) cache.delete(attachmentId);
      return image;
    });
  cache.set(attachmentId, pending);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return pending;
}

/**
 * One attached image in a message: a `▣ name (size)` row. Hovering it shows
 * the image beside it (`ImagePreviewLayer`); the transcript itself holds no
 * image, so nothing has to be drawn under a modal's dimming layer.
 */
export function AttachmentRow({
  attachmentId,
  label,
  sizeBytes,
  background,
}: {
  attachmentId: string | null;
  label: string;
  sizeBytes: number | null;
  /** The card behind the row, which the label's own background must match. */
  background: string;
}) {
  const reader = useContext(AttachmentReaderContext);
  const ref = useRef<BoxRenderable>(null);
  const { hovered, handlers } = useHover();
  // The pointer can leave while the bytes are still arriving; then there is nothing to show.
  const over = useRef(false);

  useEffect(
    () => () => {
      if (attachmentId !== null) hideImagePreview(attachmentId);
    },
    [attachmentId],
  );

  const show = () => {
    over.current = true;
    const node = ref.current;
    if (node === null || reader === null || attachmentId === null) return;
    const anchor = { x: node.screenX, y: node.screenY, width: node.width, height: node.height };
    void loadImage(reader, attachmentId).then((image) => {
      if (image !== null && over.current) showImagePreview({ id: attachmentId, bytes: image.bytes, size: image.size, anchor });
    });
  };
  const hide = () => {
    over.current = false;
    if (attachmentId !== null) hideImagePreview(attachmentId);
  };

  /** A click opens the image full screen; the hover preview it replaces ends with it. */
  const view = () => {
    if (reader === null || attachmentId === null) return;
    over.current = false;
    void loadImage(reader, attachmentId).then((image) => {
      if (image !== null) openImageViewer({ ...image, label, sizeBytes });
    });
  };

  return (
    <box
      ref={ref}
      onMouseDown={view}
      style={{ flexDirection: "row", height: 1, flexShrink: 0 }}
      onMouseOver={() => {
        handlers.onMouseOver();
        show();
      }}
      onMouseOut={() => {
        handlers.onMouseOut();
        hide();
      }}
      // The wheel moves the row out from under the preview's anchor, and no hover event follows.
      onMouseScroll={hide}
    >
      <text fg={hovered ? COLOR.bright : COLOR.diff} bg={background} selectable={false}>
        {`▣ ${label}${sizeBytes === null ? "" : ` (${formatBytes(sizeBytes)})`}`}
      </text>
    </box>
  );
}

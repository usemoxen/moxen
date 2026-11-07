import type { BoxRenderable } from "@opentui/core";
import { createContext, useContext, useEffect, useRef } from "react";

import { useHover } from "../../hooks/useHover.js";
import { loadDisplay, toDisplayOutcome } from "../../model/imagedisplay.js";
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

/**
 * The image `attachmentId` names. `cacheKey` is what a fetch is remembered
 * under, the id itself by default: an attachment never changes under its id,
 * but a file a reply names can be rewritten at the same path, so those are
 * remembered per message (`ReplyImageScopeContext`).
 */
export function loadImage(reader: AttachmentReader, attachmentId: string, cacheKey: string = attachmentId): Promise<LoadedImage | null> {
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const pending = reader(attachmentId)
    .then((read) => imageFromDataUrl(read.dataUrl))
    .catch(() => null)
    .then((image) => {
      // A miss is not remembered: the next hover asks again.
      if (image === null) cache.delete(cacheKey);
      return image;
    });
  cache.set(cacheKey, pending);
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
    // The verdict and display copy are shared with the transcript and the
    // viewer under the attachment id, so hovering never probes again.
    void loadDisplay(`attachment:${attachmentId}`, () => loadImage(reader, attachmentId).then((image) => toDisplayOutcome(image))).then((outcome) => {
      if (!over.current) return;
      if (outcome.status === "missing") return;
      showImagePreview({
        id: attachmentId,
        label,
        display: outcome.status === "ready" ? outcome.display : null,
        anchor,
      });
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
    // The shared verdict tells the viewer to show its fallback at once,
    // with the original bytes for opening externally.
    void loadDisplay(`attachment:${attachmentId}`, () => loadImage(reader, attachmentId).then((image) => toDisplayOutcome(image))).then((outcome) => {
      if (outcome.status === "missing") return;
      openImageViewer({ ...outcome.original, label, sizeBytes: outcome.original.bytes.length, undrawable: outcome.status === "undrawable" });
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

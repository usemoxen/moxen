/** Pan offsets in fractions of the scaled image, measured from its centre. */
export interface ImageViewport {
  zoom: number;
  x: number;
  y: number;
}

export const FIT_VIEW: ImageViewport = { zoom: 1, x: 0, y: 0 };

export function panImage(view: ImageViewport, dx: number, dy: number): ImageViewport {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export function zoomImage(view: ImageViewport, factor: number): ImageViewport {
  const zoom = Math.max(1, Math.min(16, view.zoom * factor));
  return { ...view, zoom };
}

/** Scale the fitted image before clipping it to the canvas. Letterboxing shrinks as zoom grows. */
export function imageGeometry(
  size: { width: number; height: number },
  canvas: { width: number; height: number },
  view: ImageViewport,
  cellAspect = 2,
) {
  const aspect = size.width / size.height * cellAspect;
  const fitHeight = Math.min(canvas.width / aspect, canvas.height);
  const width = Math.max(1, Math.round(fitHeight * aspect * view.zoom));
  const height = Math.max(1, Math.round(fitHeight * view.zoom));
  const limitX = Math.max(0, (width - canvas.width) / (2 * width));
  const limitY = Math.max(0, (height - canvas.height) / (2 * height));
  const x = limitX === 0 ? 0 : Math.max(-limitX, Math.min(limitX, view.x));
  const y = limitY === 0 ? 0 : Math.max(-limitY, Math.min(limitY, view.y));
  return {
    width, height,
    left: Math.round((canvas.width - width) / 2 - x * width),
    top: Math.round((canvas.height - height) / 2 - y * height),
    view: { ...view, x, y },
  };
}

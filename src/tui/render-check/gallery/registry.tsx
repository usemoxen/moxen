import type { ReactNode } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { COLOR, SURFACE } from "../../theme.js";

/**
 * One component, drawn on its own: `element` builds it with fixed props at
 * `width` × `height` cells. `settleMs` waits out an entrance animation
 * (modals fade in). The visual harness renders every entry in every theme.
 */
export interface GalleryEntry {
  /** Unique, file-name safe; the image is `<id>.png`. */
  id: string;
  /** The component's folder, for the index: `ui`, `composer`, … */
  group: string;
  title: string;
  width: number;
  height: number;
  settleMs?: number;
  element: () => ReactNode;
  /** Acts on the mounted component before it is captured: click a tab, open an editor. */
  drive?: (setup: TestRendererSetup) => Promise<void>;
  /** Drop the blank stretch between a tall page's content and its footer. */
  squeeze?: boolean;
}

/** The surface a component sits on in the app, so its edges read as they do there. */
export function Stage({ width, height, children }: { width: number; height: number; children: ReactNode }): ReactNode {
  return (
    <box style={{ width, height, flexDirection: "column" }} backgroundColor={SURFACE.base}>
      {children}
    </box>
  );
}

/** A label above a row of states of one component. */
export function Caption({ text }: { text: string }): ReactNode {
  return (
    <box style={{ height: 1, flexShrink: 0, marginTop: 1 }}>
      <text fg={COLOR.faint}>{text}</text>
    </box>
  );
}

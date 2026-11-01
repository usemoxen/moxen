import { ImageRenderable, type BaseRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { act } from "react";
import { ReplyImage, ReplyImageReaderContext } from "../../features/timeline/replyimage.js";
import { resetModalOpen } from "../../ui/modalopen.js";
import { fail } from "../helpers.js";
import { solidPng } from "../png.js";
import { testRender } from "../testrender.js";

/** A long reply keeps its scroll geometry but only visible pictures hold native images. */
export async function runImageVisibility(): Promise<void> {
  resetModalOpen();
  const png = solidPng(200, 100, [255, 0, 0, 255]);
  const reader = async () => ({ mimeType: "image/png", dataUrl: `data:image/png;base64,${png.toString("base64")}` });
  let pane: ScrollBoxRenderable | null = null;
  const setup = await testRender(
    <ReplyImageReaderContext.Provider value={reader}>
      <scrollbox ref={(node) => { pane = node; }} style={{ width: "100%", height: "100%" }}>
        {/* One tall child reproduces images nested inside a single long reply. */}
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          {Array.from({ length: 24 }, (_, index) => <ReplyImage key={index} path={`visibility-${index}.png`} alt={`picture ${index}`} />)}
        </box>
      </scrollbox>
    </ReplyImageReaderContext.Provider>,
    { width: 80, height: 30, exitOnCtrlC: false },
  );
  const pictures = (node: BaseRenderable): ImageRenderable[] => [
    ...(node instanceof ImageRenderable ? [node] : []),
    ...node.getChildren().flatMap(pictures),
  ];
  const waitFor = async (predicate: () => boolean) => {
    for (let pass = 0; pass < 100; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await setup.flush();
      });
      if (predicate()) return;
    }
    fail("reply image visibility did not settle");
  };
  try {
    await waitFor(() => pictures(setup.renderer.root).some((image) => image.image !== null));
    const first = pictures(setup.renderer.root);
    if (first.length > 3) fail(`off-screen reply images mounted native renderables (${first.length} for a 30-row viewport)`);
    const scrollPane = pane as ScrollBoxRenderable | null;
    if (scrollPane === null) fail("image visibility scroll pane did not mount");
    const height = scrollPane.scrollHeight;
    await act(async () => {
      scrollPane.scrollTo(height);
      await setup.flush();
    });
    await waitFor(() => setup.captureCharFrame().includes("picture 23") && pictures(setup.renderer.root).some((image) => image.image !== null));
    const last = pictures(setup.renderer.root);
    if (last.length > 3) fail("scrolling retained native images from earlier replies");
    if (first.some((image) => !image.isDestroyed)) fail("off-screen native images were not released");
    if (scrollPane.scrollHeight !== height) fail("unmounting an off-screen image changed the scroll geometry");
    await act(async () => {
      scrollPane.scrollTo(0);
      await setup.flush();
    });
    await waitFor(() => setup.captureCharFrame().includes("picture 0") && pictures(setup.renderer.root).some((image) => image.image !== null));
    console.log("--- reply images: only viewport images mounted ---");
    console.log(setup.captureCharFrame());
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}

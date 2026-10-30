import { act, useState } from "react";
import { testRender } from "../testrender.js";

import { Composer } from "../../features/composer/composer.js";
import { ImagePreviewLayer } from "../../features/timeline/imagepreview.js";
import { closeImageViewer, ImageViewer, ImageViewerDim, useImageViewer } from "../../features/timeline/imageviewer.js";
import { AttachmentReaderContext, AttachmentRow, type AttachmentReader } from "../../features/timeline/attachmentrow.js";
import { SURFACE } from "../../theme.js";
import { resetModalOpen } from "../../ui/modalopen.js";
import { ModalShell } from "../../ui/modalshell.js";
import { fail } from "../helpers.js";
import { imageDimensions } from "../../../core/attachments.js";
import { encodeRgbaPng, shrinkImage } from "../../model/imageshrink.js";
import { blendLoaded, processImage } from "../../model/imageops.js";
import { NativeImage } from "@opentui/core";
import type { LoadedImage } from "../../model/imagethumb.js";
import { MessageBody } from "../../features/timeline/timeline.js";
import { ReplyImageReaderContext } from "../../features/timeline/replyimage.js";
import { solidPng } from "../png.js";

/**
 * An attached image in the transcript is a `▣ name (size)` row, with no image
 * of its own. Hovering it shows the image bigger beside it, in a bordered box
 * the timeline cannot clip; moving off ends it, and so does a modal (whose
 * dimming layer would turn a Kitty image black).
 */
export async function runImageThumbs(): Promise<void> {
  // Earlier scenarios share this process and leave their modals mounted.
  resetModalOpen();
  const png = solidPng(200, 100, [255, 0, 0, 255]);
  const asked: string[] = [];
  const reader: AttachmentReader = async (attachmentId) => {
    asked.push(attachmentId);
    if (attachmentId === "gone") throw new Error("ATTACHMENT_NOT_FOUND");
    return { mimeType: "image/png", dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  };
  const width = 80;
  const height = 34;
  let setOpen: (open: boolean) => void = () => {};
  function Harness() {
    const [open, set] = useState(false);
    setOpen = set;
    return (
      <AttachmentReaderContext.Provider value={reader}>
        <box style={{ flexDirection: "column", width, height }} backgroundColor={SURFACE.user}>
          <box style={{ height: 12, flexShrink: 0 }}>
            <text>{"earlier messages"}</text>
          </box>
          <AttachmentRow attachmentId="present" label="clipboard-1.png" sizeBytes={51240} background={SURFACE.user} />
          <AttachmentRow attachmentId="gone" label="missing.png" sizeBytes={null} background={SURFACE.user} />
          <text>{"below the items"}</text>
          {open ? (
            <ModalShell screenWidth={width} screenHeight={height} left={40} top={20} width={30} height={5} onClose={() => {}}>
              <text>{"modal"}</text>
            </ModalShell>
          ) : null}
        </box>
        <ImagePreviewLayer screenWidth={width} screenHeight={height} />
      </AttachmentReaderContext.Provider>
    );
  }
  const setup = await testRender(<Harness />, { width, height, exitOnCtrlC: false });
  const settle = (ms: number) =>
    act(async () => {
      for (let waited = 0; waited < ms; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await setup.flush();
      }
    });
  const rows = () => setup.captureCharFrame().split("\n");
  const imageRows = () => rows().filter((line) => line.includes("█")).length;
  const hasPreviewBorder = () => rows().some((line) => line.includes("╭"));

  await settle(200);
  const labelRow = rows().findIndex((line) => line.includes("▣ clipboard-1.png (50 KB)"));
  if (labelRow === -1) fail("the attachment row did not render");
  if (imageRows() !== 0) fail("the transcript draws an image of its own; attachments are rows, shown on hover");
  if (asked.length !== 0) fail("images were fetched before any hover");

  // Over the row: the preview appears.
  await act(async () => setup.mockMouse.moveTo(4, labelRow));
  await settle(300);
  console.log("--- timeline: hover preview ---");
  console.log(setup.captureCharFrame());
  if (!hasPreviewBorder()) fail("hovering an attached image did not show a preview");
  if (imageRows() < 8) fail(`the preview should show the image, drew ${imageRows()} rows`);

  // The wheel over the item ends it: the item moves and no hover event follows.
  await act(async () => setup.mockMouse.scroll(4, labelRow, "down"));
  await settle(200);
  if (hasPreviewBorder()) fail("the preview stayed after scrolling over the item");
  await act(async () => setup.mockMouse.moveTo(70, 2));
  await settle(200);
  await act(async () => setup.mockMouse.moveTo(4, labelRow));
  await settle(300);
  if (!hasPreviewBorder()) fail("the preview did not come back on hovering after a scroll");

  // Hovering again reads the cache, not the server.
  await act(async () => setup.mockMouse.moveTo(70, 2));
  await settle(200);
  if (hasPreviewBorder()) fail("the preview stayed after the pointer left the item");
  await act(async () => setup.mockMouse.moveTo(4, labelRow));
  await settle(300);
  if (!hasPreviewBorder()) fail("hovering again did not show the preview");
  if (asked.join(",") !== "present") fail(`an image should be fetched once, then cached (asked: ${asked.join(",")})`);

  // A modal ends it.
  await act(async () => setOpen(true));
  await settle(400);
  if (hasPreviewBorder() || imageRows() !== 0) fail("a preview is still drawn under a modal");
  await act(async () => setOpen(false));
  await act(async () => setup.mockMouse.moveTo(70, 2));
  await settle(200);

  // An image the server no longer has: the row still shows, and a hover shows nothing.
  const gone = rows().findIndex((line) => line.includes("▣ missing.png"));
  if (gone === -1) fail("the row of a missing image disappeared");
  await act(async () => setup.mockMouse.moveTo(4, gone));
  await settle(300);
  if (hasPreviewBorder()) fail("hovering an image the server no longer has showed a preview");
  await runComposerHover(png);
  await runViewer(png);
  runShrink();
  await runReplyImage(png);
  await runUiBlock(png);
  await runImageOps();
  await runUiData();
  await runUiFacts();
  // No destroy(), as in bootGate: tearing down a second renderer breaks the shared one.
}

/** A pending image's `[Image #N]` token in the composer shows the image on hover, like an attachment in the chat. */
async function runComposerHover(png: Buffer): Promise<void> {
  resetModalOpen();
  const width = 80;
  const height = 30;
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const setup = await testRender(
    <box style={{ flexDirection: "column", width, height, justifyContent: "flex-end" }} backgroundColor={SURFACE.user}>
      <Composer
        draft=""
        resetKey="k"
        onInput={() => {}}
        onSubmit={() => {}}
        onEscape={() => {}}
        onFocus={() => {}}
        focused
        placeholder="Message the agent"
        model="Claude Opus 5"
        submitVerb="sends"
        running={false}
        width={width}
        attachments={["clip.png"]}
        attachmentDataUrl={(name) => (name === "clip.png" ? dataUrl : undefined)}
        onAttachmentRemoved={() => {}}
      />
      <ImagePreviewLayer screenWidth={width} screenHeight={height} />
    </box>,
    { width, height, exitOnCtrlC: false },
  );
  const settle = (ms: number) =>
    act(async () => {
      for (let waited = 0; waited < ms; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await setup.flush();
      }
    });
  const rows = () => setup.captureCharFrame().split("\n");
  await settle(300);
  const tokenRow = rows().findIndex((line) => line.includes("[Image #1]"));
  if (tokenRow === -1) fail("the pending image has no token in the composer");
  const tokenCol = rows()[tokenRow]!.indexOf("[Image #1]");
  if (rows().some((line) => line.includes("█"))) fail("an image is drawn in the composer before any hover");

  await act(async () => setup.mockMouse.moveTo(tokenCol + 3, tokenRow));
  await settle(300);
  console.log("--- composer: hover over an image token ---");
  console.log(setup.captureCharFrame());
  if (!rows().some((line) => line.includes("█"))) fail("hovering an image token in the composer showed no preview");

  await act(async () => setup.mockMouse.moveTo(width - 3, 1));
  await settle(300);
  if (rows().some((line) => line.includes("█"))) fail("the composer preview stayed after the pointer left the token");
}

/** Clicking an attachment row opens it full screen with the composer kept below; the close button, a click on the image and Esc close it. */
async function runViewer(png: Buffer): Promise<void> {
  resetModalOpen();
  closeImageViewer();
  const width = 80;
  const height = 30;
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const reader: AttachmentReader = async () => ({ mimeType: "image/png", dataUrl });
  let opened = 0;
  function Harness() {
    const viewed = useImageViewer();
    return (
      <AttachmentReaderContext.Provider value={reader}>
        <box style={{ flexDirection: "column", width, height }} backgroundColor={SURFACE.base}>
          {viewed === null ? (
            <box style={{ flexGrow: 1 }}>
              <AttachmentRow attachmentId="present" label="clipboard-1.png" sizeBytes={51240} background={SURFACE.base} />
            </box>
          ) : (
            <ImageViewer image={viewed} onClose={closeImageViewer} onOpenExternally={() => (opened += 1)} />
          )}
          <Composer
            draft=""
            resetKey="k"
            onInput={() => {}}
            onSubmit={() => {}}
            onEscape={() => closeImageViewer()}
            onFocus={() => {}}
            focused
            placeholder="Message the agent"
            model="Claude Opus 5"
            submitVerb="sends"
            running={false}
            width={width}
            attachments={["clip.png"]}
            attachmentDataUrl={(name) => (name === "clip.png" ? dataUrl : undefined)}
            onAttachmentRemoved={() => {}}
          />
        </box>
        <ImageViewerDim screenWidth={width} screenHeight={height} />
        <ImagePreviewLayer screenWidth={width} screenHeight={height} />
      </AttachmentReaderContext.Provider>
    );
  }
  const setup = await testRender(<Harness />, { width, height, exitOnCtrlC: false });
  const settle = (ms: number) =>
    act(async () => {
      for (let waited = 0; waited < ms; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await setup.flush();
      }
    });
  const rows = () => setup.captureCharFrame().split("\n");
  const find = (text: string) => rows().findIndex((line) => line.includes(text));
  await settle(200);
  const row = find("▣ clipboard-1.png");
  if (row === -1) fail("the attachment row did not render");

  await act(async () => setup.mockMouse.click(4, row));
  await settle(1200);
  console.log("--- image viewer: opened with the composer below ---");
  console.log(setup.captureCharFrame());
  if (find("▣ clipboard-1.png  200×100") === -1) fail("clicking the row did not open the viewer with the image's name and size");
  if (rows().filter((line) => line.includes("█")).length < 8) fail("the viewer draws no image");
  if (find("[Image #1]") === -1) fail("the composer is not kept below the viewer");
  if (rows().some((line) => line.includes("╭") && line.includes("█"))) fail("the hover preview is drawn over the viewer");

  const openRow = find("open externally");
  await act(async () => setup.mockMouse.click(rows()[openRow]!.indexOf("open externally") + 2, openRow));
  await settle(100);
  if (opened !== 1) fail("the open button did not ask to open the image externally");

  await act(async () => setup.mockMouse.click(width - 4, find("✕")));
  await settle(300);
  if (find("▣ clipboard-1.png  200×100") !== -1) fail("the close button left the viewer open");

  await act(async () => setup.mockMouse.click(4, row));
  await settle(400);
  await act(async () => setup.mockMouse.click(width / 2, 12));
  await settle(300);
  if (find("open externally") !== -1) fail("a click on the image left the viewer open");

  // Outside the pane is dimmed like a modal's backdrop, and a click there closes it.
  await act(async () => setup.mockMouse.click(4, row));
  await settle(400);
  const topRow = rows()[0]!;
  await act(async () => setup.mockMouse.click(0, 0));
  await settle(300);
  if (find("open externally") !== -1) fail(`a click on the dimmed area left the viewer open (${topRow.length})`);

  // A pending image's token in the composer opens the same view.
  const tokenRow = find("[Image #1]");
  if (tokenRow === -1) fail("the pending image has no token in the composer");
  await act(async () => setup.mockMouse.click(rows()[tokenRow]!.indexOf("[Image #1]") + 3, tokenRow));
  await settle(400);
  if (find("▣ clip.png") === -1) fail("clicking an image token in the composer did not open the viewer");
  closeImageViewer();
}

/** The real native decoder shrinks an over-limit image (unit tests run under Node, where it cannot load). */
function runShrink(): void {
  const wide = encodeRgbaPng(9000, 300, new Uint8Array(9000 * 300 * 4).fill(180), 9000 * 4, false);
  const shrunk = shrinkImage("wide.jpg", wide);
  if (shrunk === null) fail("an image 9000 px wide was not shrunk");
  const size = imageDimensions(shrunk.bytes);
  if (size?.width !== 1568 || size.height !== 52) fail(`shrunk to ${size?.width}x${size?.height}, not 1568x52`);
  if (shrunk.name !== "wide.png") fail(`the shrunk copy is named ${shrunk.name}`);
}

/** An image a reply names is drawn in the transcript; under a modal it is drawn as text cells, which the dimming layer does not turn black. */
async function runReplyImage(png: Buffer): Promise<void> {
  resetModalOpen();
  closeImageViewer();
  const width = 80;
  const height = 34;
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const asked: string[] = [];
  let setOpen: (open: boolean) => void = () => {};
  function Harness() {
    const [open, set] = useState(false);
    setOpen = set;
    return (
      <ReplyImageReaderContext.Provider
        value={async (path) => {
          asked.push(path);
          if (path === "/tmp/gone.png") throw new Error("IMAGE_NOT_FOUND");
          return { mimeType: "image/png", dataUrl };
        }}
      >
        <box style={{ flexDirection: "column", width, height }} backgroundColor={SURFACE.base}>
          <MessageBody
            entry={{ text: "Here is the chart:\n![quarterly chart](/tmp/chart.png)\nAnd one that is gone:\n![missing](/tmp/gone.png)\nDone.", streaming: false, message: null } as never}
            homeDir={undefined}
            background={SURFACE.base}
          />
          {open ? (
            <ModalShell screenWidth={width} screenHeight={height} left={30} top={25} width={30} height={5} onClose={() => {}}>
              <text>{"modal"}</text>
            </ModalShell>
          ) : null}
        </box>
      </ReplyImageReaderContext.Provider>
    );
  }
  const setup = await testRender(<Harness />, { width, height, exitOnCtrlC: false });
  const settle = (ms: number) =>
    act(async () => {
      for (let waited = 0; waited < ms; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await setup.flush();
      }
    });
  const frame = () => setup.captureCharFrame();
  await settle(500);
  console.log("--- reply image: drawn in the transcript ---");
  console.log(frame());
  if (!frame().includes("Here is the chart:") || !frame().includes("Done.")) fail("the text around a reply's image is gone");
  if (frame().split("\n").filter((line) => line.includes("█")).length < 6) fail("the reply's image is not drawn");
  if (!frame().includes("quarterly chart")) fail("the image has no caption");
  if (!frame().includes("missing (not found)")) fail("an image the server cannot read is not said to be missing");

  await act(async () => setOpen(true));
  await settle(500);
  console.log("--- reply image: as text cells under a modal ---");
  console.log(frame());
  if (frame().includes("█")) fail("a real image is still drawn under a modal");
  if (frame().split("\n").filter((line) => line.includes("▀")).length < 6) fail("the image is not drawn as text cells under a modal");
  await act(async () => setOpen(false));
  await settle(300);
  if (asked.filter((path) => path === "/tmp/chart.png").length !== 1) fail("the image was fetched more than once");
}

/**
 * A `moxen-ui` block lays images out as the reply says: two side by side with
 * their captions, a grid, and stacked when the pane is too narrow to read them
 * squeezed. A resize re-lays them out without fetching again, and under a
 * modal each is text cells. A block that is not valid stays the code it is.
 */
async function runUiBlock(png: Buffer): Promise<void> {
  resetModalOpen();
  closeImageViewer();
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const asked: string[] = [];
  const pair = JSON.stringify({
    v: 1,
    root: {
      type: "column",
      children: [
        { type: "text", text: "Before and after the fix:" },
        { type: "row", children: [{ type: "image", src: "/tmp/before.png", caption: "Before" }, { type: "image", src: "/tmp/after.png", caption: "After" }] },
        { type: "grid", columns: 2, children: [1, 2, 3].map((n) => ({ type: "image", src: `/tmp/g${n}.png`, caption: `Shot ${n}`, span: n === 3 ? 2 : 1 })) },
      ],
    },
  });
  const text = `Here it is.\n\n\`\`\`moxen-ui\n${pair}\n\`\`\`\n\nBroken:\n\`\`\`moxen-ui\n{ nope\n\`\`\`\nDone.`;
  const width = 80;
  const height = 60;
  let setOpen: (open: boolean) => void = () => {};
  function Harness() {
    const [open, set] = useState(false);
    setOpen = set;
    return (
      <ReplyImageReaderContext.Provider
        value={async (path) => {
          asked.push(path);
          return { mimeType: "image/png", dataUrl };
        }}
      >
        <box style={{ flexDirection: "column", width: "100%", height: "100%" }} backgroundColor={SURFACE.base}>
          <MessageBody entry={{ text, streaming: false, message: null } as never} homeDir={undefined} background={SURFACE.base} />
          {open ? (
            <ModalShell screenWidth={width} screenHeight={height} left={30} top={25} width={30} height={5} onClose={() => {}}>
              <text>{"modal"}</text>
            </ModalShell>
          ) : null}
        </box>
      </ReplyImageReaderContext.Provider>
    );
  }
  const setup = await testRender(<Harness />, { width, height, exitOnCtrlC: false });
  const settle = (ms: number) =>
    act(async () => {
      for (let waited = 0; waited < ms; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await setup.flush();
      }
    });
  const lines = () => setup.captureCharFrame().split("\n");
  const rowOf = (needle: string) => lines().findIndex((line) => line.includes(needle));
  await settle(600);
  console.log("--- moxen-ui block: a pair and a grid ---");
  console.log(setup.captureCharFrame());
  if (rowOf("Here it is.") === -1 || rowOf("Done.") === -1) fail("the text around a moxen-ui block is gone");
  if (!lines().some((line) => line.includes("Before") && line.includes("After"))) fail("a row of two images does not show them side by side, captions on one line");
  if (!lines().some((line) => line.includes("Shot 1") && line.includes("Shot 2"))) fail("a grid of two columns does not put two images in a row");
  if (rowOf("Shot 3") <= rowOf("Shot 1")) fail("the third grid image should wrap under the first two");
  if (rowOf("{ nope") === -1) fail("a block that is not valid should stay as code");
  if (rowOf('"type"') !== -1) fail("a valid block's JSON is shown instead of its images");
  const fetched = asked.length;
  if (new Set(asked).size !== 5) fail(`five images should have been asked for once each, asked ${asked.join(",")}`);

  // A pane too narrow to read the pair side by side stacks it; the bytes are not asked for again.
  await act(async () => setup.resize(28, height));
  await settle(500);
  console.log("--- moxen-ui block: stacked in a narrow pane ---");
  console.log(setup.captureCharFrame());
  if (rowOf("Before") === -1 || rowOf("After") === -1 || rowOf("Before") === rowOf("After")) fail("a pair in a narrow pane should stack");
  if (asked.length !== fetched) fail("resizing fetched the images again");
  await act(async () => setup.resize(width, height));
  await settle(500);
  if (!lines().some((line) => line.includes("Before") && line.includes("After"))) fail("the pair did not go back side by side when the pane widened");

  await act(async () => setOpen(true));
  await settle(500);
  console.log("--- moxen-ui block: as text cells under a modal ---");
  console.log(setup.captureCharFrame());
  if (setup.captureCharFrame().includes("█")) fail("a real image is still drawn under a modal");
  if (lines().filter((line) => line.includes("▀")).length < 6) fail("the block's images are not drawn as text cells under a modal");
  await act(async () => setOpen(false));
  await settle(300);
}

/** A `w`×`h` PNG, `left` on its left half and `right` on its right. */
function twoTone(w: number, h: number, left: [number, number, number], right: [number, number, number]): LoadedImage {
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) pixels.set([...(x < w / 2 ? left : right), 255], (y * w + x) * 4);
  return { mimeType: "image/png", bytes: encodeRgbaPng(w, h, pixels, w * 4, true), size: { width: w, height: h } };
}

/** The pixel at (x, y) of a PNG, read back through the real decoder. */
function pixelOf(image: LoadedImage, x: number, y: number): number[] {
  const decoded = NativeImage.decode(image.bytes);
  try {
    const raw = decoded.raw();
    const at = y * raw.stride + x * 4;
    return [...raw.data.slice(at, at + 4)];
  } finally {
    decoded.dispose();
  }
}

/**
 * The operations a `moxen-ui` image asks for, on the real native image (the
 * unit tests stand one in): the pixels that come out are the ones the reply
 * asked for, and a block that uses every one of them draws.
 */
async function runImageOps(): Promise<void> {
  resetModalOpen();
  closeImageViewer();
  const split = twoTone(200, 100, [255, 0, 0], [0, 0, 255]);

  const cropped = processImage(split, [{ op: "crop", x: 0.5, y: 0, w: 0.5, h: 1 }]);
  if (cropped.size.width !== 100 || cropped.size.height !== 100) fail(`the crop is ${cropped.size.width}x${cropped.size.height}, not 100x100`);
  if (pixelOf(cropped, 0, 0).join() !== "0,0,255,255" || pixelOf(cropped, 99, 99).join() !== "0,0,255,255") fail("a crop of the right half is not all blue");

  const padded = processImage(split, [{ op: "pad", aspect: 1 }]);
  if (padded.size.width !== 200 || padded.size.height !== 200) fail(`the pad is ${padded.size.width}x${padded.size.height}, not 200x200`);
  if (pixelOf(padded, 0, 0)[3] !== 0 || pixelOf(padded, 0, 100).join() !== "255,0,0,255") fail("the padding is not transparent around the centred image");

  const marked = processImage(twoTone(100, 100, [0, 0, 255], [0, 0, 255]), [{ op: "annotate", shapes: [{ shape: "box", x: 0.2, y: 0.2, w: 0.6, h: 0.6, color: "red" }] }]);
  if (pixelOf(marked, 20, 50)[0]! < 200 || pixelOf(marked, 50, 50).join() !== "0,0,255,255") fail("a box is not drawn on its edge and left clear inside");

  const huge = twoTone(3000, 1000, [1, 2, 3], [1, 2, 3]);
  const capped = processImage(huge, [{ op: "crop", x: 0, y: 0, w: 1, h: 1 }]);
  if (capped.size.width * capped.size.height > 2_000_000) fail(`a 3 MP image was not brought under the pixel cap: ${capped.size.width}x${capped.size.height}`);
  if (Math.abs(capped.size.width / capped.size.height - 3) > 0.05) fail("the pixel cap changed the image's shape");

  const red = twoTone(40, 40, [255, 0, 0], [255, 0, 0]);
  const blue = twoTone(40, 40, [0, 0, 255], [0, 0, 255]);
  const mixed = blendLoaded(red, blue, "overlay", 0.5);
  if (mixed === null) fail("an overlay could not be made");
  const [r, g, b] = pixelOf(mixed, 5, 5);
  if (r! < 100 || b! < 100 || g !== 0) fail(`a half overlay of blue on red is ${pixelOf(mixed, 5, 5)}, not a mix`);
  if (pixelOf(blendLoaded(red, red, "difference", 0.5)!, 5, 5).join() !== "0,0,0,255") fail("the difference of an image with itself is not black");
  if (pixelOf(blendLoaded(red, blue, "difference", 0.5)!, 5, 5).join() !== "255,0,255,255") fail("the difference of red and blue is not magenta");
  if (processImage({ ...split, bytes: new Uint8Array([1, 2, 3]) }, [{ op: "pad", aspect: 1 }]).bytes.length !== 3) fail("an image that cannot be decoded should come back as it was");

  // Every operation in one block, drawn.
  const png = Buffer.from(split.bytes);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const block = JSON.stringify({
    v: 1,
    root: {
      type: "column",
      children: [
        {
          type: "row",
          children: [
            { type: "image", src: "/tmp/shot.png", caption: "Cropped", ops: [{ op: "crop", x: 0, y: 0, w: 0.5, h: 1 }, { op: "pad", aspect: 2 }] },
            { type: "image", src: "/tmp/shot.png", caption: "Marked", ops: [{ op: "annotate", shapes: [{ shape: "box", x: 0.1, y: 0.1, w: 0.3, h: 0.5 }, { shape: "arrow", x1: 0.9, y1: 0.9, x2: 0.6, y2: 0.5, color: "yellow" }, { shape: "highlight", x: 0.5, y: 0, w: 0.5, h: 0.4, color: "green" }] }] },
          ],
        },
        { type: "blend", mode: "difference", caption: "What changed", a: { type: "image", src: "/tmp/shot.png" }, b: { type: "image", src: "/tmp/other.png" } },
      ],
    },
  });
  const width = 80;
  const height = 50;
  const setup = await testRender(
    <ReplyImageReaderContext.Provider value={async () => ({ mimeType: "image/png", dataUrl })}>
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }} backgroundColor={SURFACE.base}>
        <MessageBody entry={{ text: `\`\`\`moxen-ui\n${block}\n\`\`\``, streaming: false, message: null } as never} homeDir={undefined} background={SURFACE.base} />
      </box>
    </ReplyImageReaderContext.Provider>,
    { width, height, exitOnCtrlC: false },
  );
  await act(async () => {
    for (let waited = 0; waited < 800; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await setup.flush();
    }
  });
  const frame = setup.captureCharFrame();
  console.log("--- moxen-ui block: crop, pad, annotate and a difference ---");
  console.log(frame);
  for (const caption of ["Cropped", "Marked", "What changed"]) if (!frame.includes(caption)) fail(`the block's "${caption}" picture is not drawn`);
  if (frame.includes("could not be drawn") || frame.includes("not found")) fail("a picture of the block failed to draw");
}

/** A bar chart and a progress row in a block: bars scaled to the largest, values on the right, and the label above the bar in a pane too narrow to share. */
async function runUiData(): Promise<void> {
  resetModalOpen();
  const block = JSON.stringify({
    v: 1,
    root: {
      type: "column",
      children: [
        { type: "chart", kind: "bar", title: "Tokens", unit: "k", bars: [{ label: "input", value: 120 }, { label: "output", value: 30 }, { label: "cache", value: 0 }] },
        { type: "progress", label: "Tests", value: 0.5, text: "45 of 90" },
        { type: "progress", label: "Integration suites across every provider", value: 1 },
      ],
    },
  });
  const draw = async (width: number) => {
    const setup = await testRender(
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }} backgroundColor={SURFACE.base}>
        <MessageBody entry={{ text: `\`\`\`moxen-ui\n${block}\n\`\`\``, streaming: false, message: null } as never} homeDir={undefined} background={SURFACE.base} />
      </box>,
      { width, height: 12, exitOnCtrlC: false },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await setup.flush();
    });
    return setup.captureCharFrame().split("\n");
  };
  const wide = await draw(60);
  console.log("--- moxen-ui block: a chart and progress rows ---");
  console.log(wide.join("\n"));
  const row = (lines: string[], needle: string) => lines.find((line) => line.includes(needle)) ?? fail(`no row with "${needle}"`);
  if (!row(wide, "input").includes("120k") || !row(wide, "output").includes("30k")) fail("a chart row does not show its value on the right");
  const barOf = (line: string) => [...line].filter((char) => "█▏▎▍▌▋▊▉".includes(char)).length;
  if (barOf(row(wide, "input")) <= barOf(row(wide, "output")) * 3) fail("a bar four times as large is not about four times as long");
  if (barOf(row(wide, "cache")) !== 0) fail("a zero value draws a bar");
  if (!row(wide, "Tests").includes("50%") || !row(wide, "Tests").includes("45 of 90")) fail("a progress row does not show its percentage and its words");
  if (!wide.some((line) => line.trim() === "Integration suites across every provider")) fail("a long progress label should sit above its bar, whole");
  if (!row(wide, "100%").includes("█")) fail("a full progress bar is not full");

  const narrow = await draw(16);
  console.log("--- moxen-ui block: a chart in a narrow pane ---");
  console.log(narrow.join("\n"));
  if (row(narrow, "input").includes("120k")) fail("a chart too narrow for its values should drop them before the bars");
}

/** A key-value list and a status grid in a block: keys aligned, values wrapping, each state's own mark, and stacked in a pane too narrow to share. */
async function runUiFacts(): Promise<void> {
  resetModalOpen();
  const block = JSON.stringify({
    v: 1,
    root: {
      type: "column",
      children: [
        { type: "keyvalue", title: "Branch", rows: [{ key: "name", value: "main" }, { key: "last commit", value: "a long subject line that has to wrap inside its own column" }] },
        { type: "status", title: "Checks", rows: [{ label: "typecheck", state: "done", note: "2.1s" }, { label: "tests", state: "live", note: "running" }, { label: "deploy", state: "held" }, { label: "gallery", state: "broken", note: "a component" }, { label: "docs", state: "next" }] },
      ],
    },
  });
  const draw = async (width: number) => {
    const setup = await testRender(
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }} backgroundColor={SURFACE.base}>
        <MessageBody entry={{ text: `\`\`\`moxen-ui\n${block}\n\`\`\``, streaming: false, message: null } as never} homeDir={undefined} background={SURFACE.base} />
      </box>,
      { width, height: 18, exitOnCtrlC: false },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await setup.flush();
    });
    return setup.captureCharFrame().split("\n");
  };
  const row = (lines: string[], needle: string) => lines.find((line) => line.includes(needle)) ?? fail(`no row with "${needle}"`);
  const wide = await draw(50);
  console.log("--- moxen-ui block: a key-value list and a status grid ---");
  console.log(wide.join("\n"));
  if (row(wide, "name").indexOf("main") !== row(wide, "last commit").indexOf("a long subject")) fail("the values of a key-value list do not line up");
  if (wide.filter((line) => line.includes("subject line") || line.includes("inside its own column")).length < 2) fail("a long value did not wrap inside its column");
  for (const [label, glyph] of [["typecheck", "✓"], ["tests", "●"], ["deploy", "○"], ["gallery", "!"], ["docs", "☐"]] as const) {
    if (!row(wide, label).includes(`${glyph} ${label}`)) fail(`"${label}" does not carry its state's mark ${glyph}`);
  }
  if (!row(wide, "typecheck").includes("2.1s")) fail("a status note is not on its label's row");

  const narrow = await draw(16);
  console.log("--- moxen-ui block: stacked in a narrow pane ---");
  console.log(narrow.join("\n"));
  const at = narrow.findIndex((line) => line.trim() === "last commit");
  if (at === -1 || !narrow[at + 1]!.includes("a long")) fail("a key should stand above its value in a pane too narrow to share");
  const gallery = narrow.findIndex((line) => line.includes("! gallery"));
  if (gallery === -1 || !narrow[gallery + 1]!.includes("a component")) fail("a note should go under its label in a pane too narrow for it beside");
}

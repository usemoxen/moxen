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

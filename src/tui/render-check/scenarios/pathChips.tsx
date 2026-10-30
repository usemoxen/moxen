import { act, useState } from "react";

import { Composer } from "../../features/composer/composer.js";
import { addPaths, promptWithPaths, type PathAttachment } from "../../model/pathattachments.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/**
 * An attached file or folder is a chip in the draft, at the cursor, like an
 * image's token: the message carries its path in that place, backspace takes
 * it whole, and "+ attach" leads the bottom row.
 */
export async function runPathChips(): Promise<void> {
  const width = 100;
  const height = 14;
  let attach: (items: Array<{ path: string; kind: "file" | "folder" }>) => void = () => {};
  let latest = "";
  let removed: string[] = [];
  let attachClicks = 0;
  function Harness() {
    const [draft, setDraft] = useState("");
    const [items, setItems] = useState<PathAttachment[]>([]);
    attach = (picked) => setItems((current) => addPaths(current, picked));
    latest = draft;
    return (
      <box style={{ flexDirection: "column", width, height, justifyContent: "flex-end" }}>
        <Composer
          draft={draft}
          resetKey="k"
          onInput={setDraft}
          onSubmit={() => {}}
          onEscape={() => {}}
          onFocus={() => {}}
          focused
          placeholder="Message the agent"
          model="Claude Opus 5"
          submitVerb="sends"
          running={false}
          width={width}
          permission="Full access"
          onAttachClick={() => (attachClicks += 1)}
          pathAttachments={items.map((item) => ({ id: item.path, label: item.label }))}
          onPathRemoved={(id) => {
            removed.push(id);
            setItems((current) => current.filter((item) => item.path !== id));
          }}
        />
        <text>{items.map((item) => item.path).join(",")}</text>
      </box>
    );
  }
  const setup = await testRender(<Harness />, { width, height, exitOnCtrlC: false });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await setup.flush();
    });
  const rows = () => setup.captureCharFrame().split("\n");
  await settle();

  // "+ attach" leads the bottom row, before the permission, flush with the draft.
  const bottom = rows().findIndex((line) => line.includes("+ attach"));
  if (bottom === -1) fail("the composer has no attach button");
  const draftColumn = rows().find((line) => line.includes("Message the agent"))!.indexOf("Message the agent");
  if (rows()[bottom]!.indexOf("+ attach") !== draftColumn) fail("the attach button is not left-aligned with the draft");
  if (rows()[bottom]!.indexOf("+ attach") > rows()[bottom]!.indexOf("Full access")) fail("the attach button is not first in the bottom row");
  await act(async () => setup.mockMouse.click(draftColumn + 2, bottom));
  if (attachClicks !== 1) fail("the attach button did not open the dialog");

  // Typed text, then an attachment: its chip lands at the cursor, in the sentence.
  await act(async () => setup.mockInput.typeText("Look at this file: "));
  await settle();
  await act(async () => attach([{ path: "/Users/me/My Docs/normalize.py", kind: "file" }]));
  await settle();
  console.log("--- composer: an attached file is a chip in the draft ---");
  console.log(setup.captureCharFrame());
  if (!latest.startsWith("Look at this file:  📄 normalize.py ")) fail(`the chip did not land at the cursor: ${JSON.stringify(latest)}`);
  if (promptWithPaths(latest, [{ path: "/Users/me/My Docs/normalize.py", kind: "file", label: " 📄 normalize.py " }]).trim() !== 'Look at this file: "/Users/me/My Docs/normalize.py"') {
    fail("the message does not carry the path in the chip's place");
  }

  // Backspace takes the chip whole and detaches it (the first one is for the space after it).
  await act(async () => setup.mockInput.pressBackspace());
  await act(async () => setup.mockInput.pressBackspace());
  await settle();
  if (latest.includes("normalize.py")) fail(`backspace left part of the chip: ${JSON.stringify(latest)}`);
  if (removed.join() !== "/Users/me/My Docs/normalize.py") fail("deleting the chip did not detach the attachment");
}

import { act, useState } from "react";

import { PathChips } from "../../features/composer/pathchips.js";
import type { PathAttachment } from "../../model/pathattachments.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** Attached files and folders show as chips with an icon and a name; the ✕ takes one off in one press. */
export async function runPathChips(): Promise<void> {
  const width = 60;
  function Harness() {
    const [items, setItems] = useState<PathAttachment[]>([
      { path: "/Users/me/My Docs/report.pdf", kind: "file" },
      { path: "/Users/me/projects/moxen", kind: "folder" },
    ]);
    return <PathChips items={items} onRemove={(target) => setItems((current) => current.filter((item) => item.path !== target))} width={width} />;
  }
  const setup = await testRender(<Harness />, { width, height: 3, exitOnCtrlC: false });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await setup.flush();
    });
  const rows = () => setup.captureCharFrame().split("\n");
  await settle();
  console.log("--- path chips ---");
  console.log(setup.captureCharFrame());
  const row = rows().findIndex((line) => line.includes("report.pdf"));
  if (row === -1 || !rows()[row]!.includes("moxen")) fail("the chips did not show both names on a row");
  if (!rows()[row]!.includes("📄") || !rows()[row]!.includes("📁")) fail("a chip lacks its file or folder icon");

  // The ✕ of the first chip.
  await act(async () => setup.mockMouse.click(rows()[row]!.indexOf("✕"), row));
  await settle();
  if (rows().some((line) => line.includes("report.pdf"))) fail("pressing ✕ did not take the chip off");
  if (!rows().some((line) => line.includes("moxen"))) fail("pressing ✕ took off a chip it was not on");
}

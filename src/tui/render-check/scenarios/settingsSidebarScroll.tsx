import { act } from "react";
import { testRender } from "../testrender.js";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { describeSettings } from "./settingsFixture.js";
import { normalizeConfig } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * The settings sidebar on a short window: with Harness profiles and MCP
 * servers nested under it, it is taller than the page. It scrolls, keeps a
 * blank line above the key hint, and follows the section tab moves to.
 */
export async function runSettingsSidebarScroll(): Promise<void> {
  const config = normalizeConfig({
    mcpServers: { "brave-search": { command: "brave-mcp" }, exa: { type: "http", url: "https://mcp.exa.ai/mcp" } },
    providers: { harness: { profiles: [{ id: "colab", name: "Google Colab", baseUrl: "http://localhost:8080/v1", models: [{ id: "m" }] }] } },
  });
  const height = 22;
  const setup = await testRender(
    <SettingsModal
      snapshot={{ path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(config) }}
      loading={false}
      saving={null}
      error={null}
      onSet={() => Promise.resolve(true)}
      onDuplicate={() => {}}
      run={null}
      onTest={() => {}}
      onTestMcp={() => {}}
      onProbe={() => {}}
      onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
      onExport={() => {}}
      onImport={() => {}}
      notice={null}
      versions={null}
      latest={null}
      updating={new Set()}
      onUpdate={() => {}}
      providers={[]}
      screenWidth={100}
      screenHeight={height}
      left={2}
      top={1}
      width={96}
      height={height - 2}
      onClose={() => {}}
    />,
    { width: 100, height, exitOnCtrlC: false },
  );
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    await setup.flush();
  };
  await settle();

  const check = (when: string): string[] => {
    const rows = setup.captureCharFrame().split("\n");
    const hint = rows.findIndex((row) => row.includes("tab next section"));
    if (hint < 0) fail(`${when}: the key hint is gone`);
    // The line above the hint is blank: no sidebar entry runs into it.
    if (rows[hint - 1]!.slice(0, 30).trim() !== "") fail(`${when}: the sidebar touches the key hint: ${JSON.stringify(rows[hint - 1])}`);
    return rows;
  };
  const first = check("on opening");
  console.log("--- settings sidebar, short window ---");
  console.log(first.join("\n"));
  if (first.some((row) => row.includes("exa"))) fail("on opening: the last MCP server shows, so the sidebar did not need to scroll; make the window shorter");

  // A long Default is the one shortened: the global "Compact at" keeps its whole label and two spaces before its value.
  for (let step = 0; step < 3; step += 1) await act(async () => setup.mockInput.pressTab());
  await settle();
  // Compaction is chosen here too, like Hand off: the row sits on the global tab, above Compact at.
  for (let step = 0; step < 4; step += 1) {
    if (/│\s+Compaction {2,}\S/.test(setup.captureCharFrame())) break;
    await act(async () => setup.mockInput.pressArrow("down"));
    await settle();
  }
  if (!/│\s+Compaction {2,}Default/.test(setup.captureCharFrame())) fail("the global Long threads tab has no Compaction row");
  for (let step = 0; step < 4; step += 1) {
    if (setup.captureCharFrame().includes("Compact at  ")) break;
    await act(async () => setup.mockInput.pressArrow("down"));
    await settle();
  }
  const longThreads = setup.captureCharFrame().split("\n");
  console.log("--- global Long threads, narrow ---");
  console.log(longThreads.join("\n"));
  const compactRow = longThreads.find((row) => /│\s+Compact at\b/.test(row));
  if (compactRow === undefined) fail("the global Long threads tab shows no whole 'Compact at' label");
  if (!/Compact at {2,}\S/.test(compactRow)) fail(`'Compact at' and its value touch: ${JSON.stringify(compactRow)}`);
  if (!compactRow.includes("Default (80% of the window)")) fail(`the global Compact at Default is not the plain share: ${JSON.stringify(compactRow)}`);
  for (let step = 0; step < 3; step += 1) await act(async () => setup.mockInput.pressTab({ shift: true }));
  await settle();

  // Shift-tab from the first section wraps to the last: the sidebar follows it down.
  await act(async () => setup.mockInput.pressTab({ shift: true }));
  await settle();
  const last = check("at the last section");
  const active = last.find((row) => row.includes("▌ "));
  console.log(last.join("\n"));
  if (active === undefined || !active.includes("MCP servers")) fail(`at the last section: the active entry is not in view (${JSON.stringify(active)})`);
  setup.renderer.destroy();
}

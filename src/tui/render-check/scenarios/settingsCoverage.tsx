import { act } from "react";

import { DEFAULT_CONFIG } from "../../../core/config.js";
import { SETTINGS } from "../../../core/configschema.js";
import { CONFIGURED, CONFIGURED_PAGES, DEFAULT_PAGES, settingsPage, walk } from "../gallery/settings.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

const HEIGHT = 260;

/**
 * Every setting the schema table lists is drawn on some page of the settings
 * screen, and the screen's sidebar is the page list the visual harness
 * (`gallery/settings.tsx`) walks. A setting a page never shows, or a page the
 * harness does not know, fails here rather than going unseen.
 */
export async function runSettingsCoverage(): Promise<void> {
  const shown: string[] = [];
  for (const [config, pages] of [[DEFAULT_CONFIG, DEFAULT_PAGES], [CONFIGURED, CONFIGURED_PAGES]] as const) {
    // A fresh page for each: opening a profile or a server replaces the sidebar with its own.
    for (const ref of pages) {
      const setup = await testRender(settingsPage(HEIGHT, config), { width: 100, height: HEIGHT, exitOnCtrlC: false });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
      await setup.flush();
      if (config === DEFAULT_CONFIG && ref === pages[0]) {
        const sidebar = setup
          .captureCharFrame()
          .split("\n")
          .slice(4, -3)
          .map((row) => row.slice(0, 26).replace(/[▌│]/g, "").trim())
          .filter((text) => text !== "" && text !== text.toUpperCase());
        if (sidebar.join("|") !== DEFAULT_PAGES.map((entry) => entry.label).join("|")) fail(`the settings sidebar lists ${JSON.stringify(sidebar)}, not the pages the visual harness walks (${JSON.stringify(DEFAULT_PAGES.map((entry) => entry.label))})`);
      }
      await walk(setup, ref.steps);
      shown.push(setup.captureCharFrame());
      setup.renderer.destroy();
    }
  }
  const text = shown.join("\n");
  const missing = SETTINGS.filter((descriptor) => descriptor.hidden !== true && !text.includes(descriptor.label)).map((descriptor) => `${descriptor.key} ("${descriptor.label}")`);
  if (missing.length > 0) fail(`settings the page never shows: ${missing.join(", ")}`);
  console.log(`--- settings coverage: ${SETTINGS.filter((descriptor) => descriptor.hidden !== true).length} settings on ${DEFAULT_PAGES.length + CONFIGURED_PAGES.length} pages ---`);
}

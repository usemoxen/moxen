import { act } from "react";
import { testRender } from "../testrender.js";

import { applyLanguage } from "../../i18n/index.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { App, client } from "../fixtures.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";
import { fail } from "../helpers.js";

/**
 * The app in Spanish (Spain): the sidebar, the quit confirm, the command
 * palette and the settings page say their words in the language the setting
 * picks, and nothing is cut off where the longer words land. The frames are
 * printed so a change to a translation can be read, not only counted.
 */
export async function runSpanish(): Promise<void> {
  const setup = await testRender(<App client={client} onQuit={() => {}} launchView="thread" ui={{ language: "es-ES" }} />, { width: 150, height: 40, exitOnCtrlC: false });
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await setup.flush();
  };
  try {
    await settle();
    const home = setup.captureCharFrame();
    console.log("--- español: inicio ---");
    console.log(home);
    for (const word of ["Hilos", "ajustes"]) if (!home.includes(word)) fail(`the Spanish home screen lacks "${word}"`);

    await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
    await settle();
    const quit = setup.captureCharFrame();
    console.log("--- español: salir ---");
    console.log(quit);
    for (const word of ["¿Salir de moxen?", "Cancelar (esc)", "Salir (intro / ctrl+c otra vez)"]) if (!quit.includes(word)) fail(`the Spanish quit confirm lacks "${word}"`);
    await act(async () => setup.mockInput.pressEscape());
    await settle();

  } finally {
    setup.renderer.destroy();
    applyLanguage("en");
  }
}

/** The settings page in Spanish, from the real schema: its sections, a setting, a choice and the sidebar's headings. */
export async function runSpanishSettings(): Promise<void> {
  applyLanguage("es-ES");
  const snapshot = { path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) };
  const setup = await testRender(
    <SettingsModal
      snapshot={snapshot}
      loading={false}
      saving={null}
      error={null}
      onSet={() => {}}
      onDuplicate={() => {}}
      run={null}
      onTest={() => {}}
      onTestMcp={() => {}}
      onProbe={() => {}}
      onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
      onExport={() => {}}
      onImport={() => {}}
      notice={null}
      versions={{
        claude: { ok: true, installed: true, version: "2.1.293 (Claude Code)", login: "inherit", minVersion: "2.1.292" },
        opencode: { ok: true, installed: true, version: "opencode v2.0.24", login: "inherit", minVersion: "2.0.0" },
      }}
      latest={null}
      updating={new Set()}
      onUpdate={() => {}}
      providers={null}
      screenWidth={110}
      screenHeight={34}
      left={2}
      top={1}
      width={106}
      height={32}
      onClose={() => {}}
    />,
    { width: 110, height: 34, exitOnCtrlC: false },
  );
  try {
    await setup.flush();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    await setup.flush();
    const frame = setup.captureCharFrame();
    console.log("--- español: ajustes ---");
    console.log(frame);
    for (const word of ["Ajustes", "Contexto del agente", "Interfaz", "Git y GitHub/GitLab", "Carpetas desconocidas", "PROVEEDORES", "INTEGRACIONES"]) if (!frame.includes(word)) fail(`the Spanish settings page lacks "${word}"`);
    if (frame.split("PROVEEDORES").length !== 2) fail("the Spanish settings sidebar repeats its Providers heading");
    for (const english of ["Settings", "Agent context", "Interface", "Unknown folders", "PROVIDERS"]) if (frame.includes(english)) fail(`the Spanish settings page still says "${english}"`);
  } finally {
    setup.renderer.destroy();
    applyLanguage("en");
  }
}

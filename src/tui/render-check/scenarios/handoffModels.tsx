import { act, useState } from "react";
import { testRender } from "../testrender.js";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { describeSettings } from "./settingsFixture.js";
import { normalizeConfig, setConfigValue } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * A provider's "Hand off at, per model" row opens a list of that provider's
 * models; enter on one opens a slider of sizes, and d takes the override away.
 * Its "Per model" row opens every model; a model opens a page of four fields,
 * each a choice list or a size slider.
 */
export async function runHandoffModels(): Promise<void> {
  const model = (slug: string, name: string, isDefault: boolean, isHidden = false) => ({ slug, name, isCustom: false, isDefault, isHidden, efforts: [] });
  const providers: ProviderSummary[] = [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [model("claude-sonnet-5", "Claude Sonnet 5", false), model("claude-opus-5", "Claude Opus 5", true), model("claude-old", "Claude Old", false, true)],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    },
  ];
  const initial = normalizeConfig({ providers: { claude: { autoHandoffModels: { "claude-opus-5": 500_000, "gone-model": "300k" }, compactAtModels: { "claude-opus-5": 400_000 } } } });
  const written: Array<{ key: string; value: string }> = [];
  const Host = () => {
    const [config, setConfig] = useState(initial);
    return (
      <SettingsModal
        snapshot={{ path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(config) }}
        loading={false}
        saving={null}
        error={null}
        onSet={(key, value) => {
          written.push({ key, value });
          setConfig((current) => setConfigValue(current, key as Parameters<typeof setConfigValue>[1], value));
          return Promise.resolve(true);
        }}
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
        providers={providers}
        screenWidth={100}
        screenHeight={60}
        left={2}
        top={1}
        width={96}
        height={58}
        onClose={() => {}}
      />
    );
  };
  const setup = await testRender(<Host />, { width: 100, height: 60, exitOnCtrlC: false });
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await setup.flush();
  };
  await settle();

  const side = setup.captureCharFrame().split("\n");
  const claudeRow = side.findIndex((row) => row.includes("Claude Code") && row.includes("│"));
  await act(async () => setup.mockMouse.click(side[claudeRow]!.indexOf("Claude Code") + 1, claudeRow));
  await settle();
  // The row sits under "Long threads", below the fold: step down to it by its place on the page.
  const page = describeSettings(initial).filter((view) => view.descriptor.section === "provider:claude" && view.descriptor.hidden !== true)
    // A row another one switches off is not on the page to step over.
    .filter((view, _at, all) => {
      const when = view.descriptor.visibleWhen;
      return when === undefined || when.in.includes(String(all.find((other) => other.descriptor.key === when.key)?.value ?? ""));
    });
  const place = page.findIndex((view) => view.descriptor.key === "providers.claude.autoHandoffModels");
  if (place < 0) fail("Claude Code's page has no Per model row");
  if (page.some((view) => view.descriptor.key === "providers.claude.compactAtModels")) fail("the per-model compaction sizes still have a row of their own");
  for (let step = 0; step < place; step += 1) await act(async () => setup.mockInput.pressArrow("down"));
  await settle();
  const shown = setup.captureCharFrame();
  if (!shown.split("\n").some((line) => line.includes("Per model") && line.includes("2 models"))) fail("the 'Per model' row does not count its 2 models");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const list = setup.captureCharFrame();
  console.log("--- per model ---");
  console.log(list);
  for (const expected of ["Claude Opus 5", "hand off at 500K", "compact at 400K", "Claude Sonnet 5", "uses provider setting", "gone-model (not offered)"]) {
    if (!list.includes(expected)) fail(`the per-model list is missing "${expected}"`);
  }
  if (list.includes("Claude Old")) fail("a hidden model is listed");

  // Sonnet is second (the default model leads): its page holds four fields, all following the provider.
  await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const modelPage = setup.captureCharFrame();
  console.log("--- a model's page ---");
  console.log(modelPage);
  for (const expected of ["Claude Sonnet 5", "Hand off", "Hand off at", "Compaction", "Compact at", "Follows the provider"]) {
    if (!modelPage.includes(expected)) fail(`the model's page is missing "${expected}"`);
  }
  // Hand off: Off, from the choice list (Follows the provider, Ask, Automatic, Off).
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (!setup.captureCharFrame().includes("Automatic")) fail("the Hand off choice list is missing Automatic");
  for (let step = 0; step < 3; step += 1) await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const handoffWrite = written.at(-1);
  if (handoffWrite?.key !== "providers.claude.handoffModels" || handoffWrite.value !== "claude-sonnet-5=off") fail(`choosing Off wrote ${JSON.stringify(handoffWrite)}`);

  // Hand off at: the slider, one stop right of 200K.
  await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const slider = setup.captureCharFrame();
  for (const expected of ["Claude Sonnet 5", "16K", "1M", "Nothing chosen here"]) {
    if (!slider.includes(expected)) fail(`the size slider is missing "${expected}"`);
  }
  await act(async () => setup.mockInput.pressArrow("right"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const sizeWrite = written.at(-1);
  if (sizeWrite?.key !== "providers.claude.autoHandoffModels" || sizeWrite.value !== "claude-opus-5=500000, gone-model=300000, claude-sonnet-5=256000") fail(`picking a size wrote ${JSON.stringify(sizeWrite)}`);

  // d on a field lets it follow the provider again.
  await act(async () => setup.mockInput.pressKey("d"));
  await settle();
  if (written.at(-1)?.value !== "claude-opus-5=500000, gone-model=300000") fail(`d wrote ${JSON.stringify(written.at(-1))}`);

  // Esc to the list, esc out of the editor.
  await act(async () => setup.mockInput.pressEscape());
  await settle();
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  await setup.flush();
  const after = setup.captureCharFrame();
  if (!after.includes("Settings") || after.includes("← back") || after.includes("uses provider setting")) fail("esc did not leave only the editor for the settings page");
  setup.renderer.destroy();
}

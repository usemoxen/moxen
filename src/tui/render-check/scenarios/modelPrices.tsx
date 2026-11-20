import { act, useState } from "react";
import { testRender } from "../testrender.js";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { describeSettings } from "./settingsFixture.js";
import { normalizeConfig, setConfigValue } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * A provider's "Prices per model" row opens a list of that provider's models
 * with shipped and custom USD/1M prices; enter on a model opens its four
 * numeric price fields, enter edits one USD value, and d resets it back to
 * Moxen's shipped price or unpriced.
 */
export async function runModelPrices(): Promise<void> {
  const model = (slug: string, name: string, isDefault: boolean, isHidden = false) => ({
    slug,
    name,
    isCustom: false,
    isDefault,
    isHidden,
    efforts: [],
  });
  const providers: ProviderSummary[] = [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [
        model("claude-opus-5", "Claude Opus 5", true),
        model("claude-sonnet-5-5", "Claude Sonnet 5.5", false),
        model("claude-custom-preview", "Claude Preview", false),
        model("claude-old", "Claude Old", false, true),
      ],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    },
  ];
  const initial = normalizeConfig({
    providers: {
      claude: {
        modelInputPrices: { "claude-opus-5": 6, "retired-model": 1.5 },
        modelOutputPrices: { "claude-opus-5": 30 },
      },
    },
  });
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
  const claudeRow = side.findIndex((row) => row.includes("Claude Code") && row.indexOf("Claude Code") < 28 && row.includes("│"));
  await act(async () => setup.mockMouse.click(side[claudeRow]!.indexOf("Claude Code") + 1, claudeRow));
  await settle();

  const page = describeSettings(initial)
    .filter((view) => view.descriptor.section === "provider:claude" && view.descriptor.hidden !== true)
    .filter((view, _at, all) => {
      const when = view.descriptor.visibleWhen;
      return when === undefined || when.in.includes(String(all.find((other) => other.descriptor.key === when.key)?.value ?? ""));
    });
  const place = page.findIndex((view) => view.descriptor.key === "providers.claude.modelInputPrices");
  if (place < 0) fail("Claude Code's page has no Prices per model row");
  if (page.some((view) => view.descriptor.key === "providers.claude.modelOutputPrices")) fail("Output price still has a separate row");
  for (let step = 0; step < place; step += 1) await act(async () => setup.mockInput.pressArrow("down"));
  await settle();
  const shown = setup.captureCharFrame();
  if (!shown.split("\n").some((line) => line.includes("Prices per model") && line.includes("2 models"))) {
    fail("the 'Prices per model' row does not count its 2 custom models");
  }

  // Open the model prices list.
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const list = setup.captureCharFrame();
  console.log("--- model prices list ---");
  console.log(list);
  for (const expected of [
    "Claude Opus 5",
    "$6 / $30",
    "Claude Sonnet 5.5",
    "$2 / $10 (shipped)",
    "Claude Preview",
    "unpriced",
    "retired-model (not offered)",
  ]) {
    if (!list.includes(expected)) fail(`the model prices list is missing "${expected}"`);
  }
  if (list.includes("Claude Old")) fail("a hidden model is listed in model prices");

  // Open Claude Sonnet 5.5 (index 1) and check its 4 price fields.
  await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const modelPage = setup.captureCharFrame();
  console.log("--- model prices page ---");
  console.log(modelPage);
  for (const expected of [
    "Claude Sonnet 5.5",
    "Input price",
    "Shipped ($2 / 1M)",
    "Output price",
    "Shipped ($10 / 1M)",
    "Cache read price",
    "Cache write price",
  ]) {
    if (!modelPage.includes(expected)) fail(`the model's prices page is missing "${expected}"`);
  }

  // Edit Input price for Claude Sonnet 5.5 to 3.5.
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  await act(async () => setup.mockInput.typeText("3.5"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const write = written.at(-1);
  if (write?.key !== "providers.claude.modelInputPrices" || write.value !== "claude-opus-5=6, retired-model=1.5, claude-sonnet-5-5=3.5") {
    fail(`editing Input price wrote ${JSON.stringify(write)}`);
  }
  const afterEdit = setup.captureCharFrame();
  if (!afterEdit.includes("$3.5 / 1M")) fail("updated custom Input price did not render on the model page");

  // Reset that field with d.
  await act(async () => setup.mockInput.pressKey("d"));
  await settle();
  if (written.at(-1)?.value !== "claude-opus-5=6, retired-model=1.5") {
    fail(`d on Input price wrote ${JSON.stringify(written.at(-1))}`);
  }

  // Esc to the list, esc back to the settings page.
  await act(async () => setup.mockInput.pressEscape());
  await settle();
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  await setup.flush();
  const after = setup.captureCharFrame();
  if (!after.includes("Settings") || after.includes("← back")) fail("esc did not leave the model prices editor for the settings page");
  setup.renderer.destroy();
}

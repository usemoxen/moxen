import { act } from "react";
import { testRender } from "../testrender.js";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";
import { fail } from "../helpers.js";

/**
 * The horizontal slider the settings page uses for effort and numeric
 * presets: end captions, a track with a marker, the labels, the line for
 * the highlighted stop, and a way back to the default.
 */
export async function runSettingsSlider(): Promise<void> {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
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
        {
          slug: "claude-opus-5",
          name: "Claude Opus 5",
          isCustom: false,
          isDefault: true,
          isHidden: false,
          efforts: [{ id: "effort", label: "Effort", currentValue: null, choices: efforts.map((id) => ({ id, label: id, isDefault: id === "medium" })) }],
        },
      ],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    },
  ];
  const written: Array<[string, string]> = [];
  const snapshot = { path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings({ ...DEFAULTS_FOR_RENDER_CHECK, provider: "claudeAgent", model: "claude-opus-5" }) };
  const setup = await testRender(
    <SettingsModal
      snapshot={snapshot}
      loading={false}
      saving={null}
      error={null}
      onSet={(key, value) => written.push([key, value])}
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
      screenWidth={90}
      screenHeight={34}
      left={2}
      top={1}
      width={86}
      height={32}
      onClose={() => {}}
    />,
    { width: 90, height: 34, exitOnCtrlC: false },
  );
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    await setup.flush();
  };
  await settle();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  // Defaults is the tab after General.
  await act(async () => setup.mockInput.pressTab());
  await settle();
  const rows = setup.captureCharFrame().split("\n");
  const effortRow = rows.findIndex((row) => row.includes("Effort"));
  if (effortRow < 0) fail("Defaults has no Effort row");
  await act(async () => setup.mockMouse.click(rows[effortRow]!.indexOf("Effort") + 1, effortRow));
  await settle();
  const opened = setup.captureCharFrame();
  console.log("--- settings page, effort slider ---");
  console.log(opened);
  for (const expected of ["Faster", "Smarter", "◆", "Balanced speed and depth · default for this model", "Nothing chosen here"]) {
    if (!opened.includes(expected)) fail(`the effort slider is missing "${expected}"`);
  }
  const lines = opened.split("\n");
  const labelRow = lines.findIndex((row) => row.includes("low") && row.includes("medium") && row.includes("max"));
  const markerRow = lines.findIndex((row) => row.includes("◆"));
  if (labelRow < 0 || markerRow !== labelRow - 2) fail("the effort slider's marker is not on the track over its labels");
  const mediumMiddle = lines[labelRow]!.indexOf("medium") + 3;
  if (Math.abs(lines[markerRow]!.indexOf("◆") - mediumMiddle) > 1) fail("an unset effort does not open on the model's default level");
  // Right moves the marker; enter picks the stop it is over.
  await act(async () => setup.mockInput.pressArrow("right"));
  await act(async () => setup.mockInput.pressArrow("right"));
  await settle();
  const moved = setup.captureCharFrame();
  if (moved.includes("default for this model")) fail("the default-effort line stayed after the marker moved off it");
  if (!moved.includes("Extended reasoning, slower, more tokens")) fail("a level that is not the default has no line saying what it means");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (written.length !== 1 || written[0]![0] !== "thinkingEffort" || written[0]![1] !== "xhigh") fail(`picking on the slider wrote ${JSON.stringify(written)}, not thinkingEffort=xhigh`);
  setup.renderer.destroy();
}

/** The model list: models under their provider's heading, the default first, and typing narrows it. */
export async function runSettingsModelList(): Promise<void> {
  const model = (slug: string, name: string, isDefault: boolean, levels: string[]) => ({
    slug,
    name,
    isCustom: false,
    isDefault,
    isHidden: false,
    efforts: levels.length === 0 ? [] : [{ id: "effort", label: "Effort", currentValue: null, choices: levels.map((id) => ({ id, label: id, isDefault: id === "medium" })) }],
  });
  const provider = (instanceId: string, displayName: string, models: ProviderSummary["models"]): ProviderSummary => ({
    instanceId,
    driver: instanceId,
    displayName,
    enabled: true,
    installed: true,
    status: null,
    authStatus: null,
    models,
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  });
  const providers = [
    provider("claudeAgent", "Claude", [
      model("claude-haiku", "Claude Haiku", false, []),
      model("claude-opus", "Claude Opus", true, ["low", "medium", "high"]),
      model("claude-sonnet", "Claude Sonnet", false, ["low", "medium", "high"]),
    ]),
    provider("opencode/openai", "OpenAI", [
      model("gpt-sol", "GPT Sol", false, ["low", "high"]),
      model("gpt-astra", "GPT Astra", true, ["low", "high"]),
      model("gpt-luna", "GPT Luna", false, ["low", "high"]),
      model("gpt-terra", "GPT Terra", false, ["low", "high"]),
      model("gpt-nova", "GPT Nova", false, ["low", "high"]),
      model("gpt-vega", "GPT Vega", false, ["low", "high"]),
      model("gpt-orion", "GPT Orion", false, ["low", "high"]),
    ]),
  ];
  const written: Array<[string, string]> = [];
  // The global Model belongs to the global Provider, so it lists that provider's models (with none, it waits for one).
  const snapshot = { path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings({ ...DEFAULTS_FOR_RENDER_CHECK, provider: "opencode/openai" }) };
  const setup = await testRender(
    <SettingsModal
      snapshot={snapshot}
      loading={false}
      saving={null}
      error={null}
      onSet={(key, value) => written.push([key, value])}
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
      screenWidth={90}
      screenHeight={36}
      left={2}
      top={1}
      width={86}
      height={34}
      onClose={() => {}}
    />,
    { width: 90, height: 36, exitOnCtrlC: false },
  );
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    await setup.flush();
  };
  await settle();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  // Defaults is the tab after General.
  await act(async () => setup.mockInput.pressTab());
  await settle();
  const rows = setup.captureCharFrame().split("\n");
  const modelRow = rows.findIndex((row) => /\bModel\b/.test(row) && !row.includes("backdrop"));
  if (modelRow < 0) fail("Defaults has no Model row");
  await act(async () => setup.mockMouse.click(rows[modelRow]!.indexOf("Model") + 1, modelRow));
  await settle();
  const opened = setup.captureCharFrame();
  console.log("--- settings page, model list ---");
  console.log(opened);
  for (const expected of ["Search by name", "GPT Astra", "GPT Orion", "default"]) {
    if (!opened.includes(expected)) fail(`the model list is missing "${expected}"`);
  }
  if (opened.includes("Claude Opus")) fail("the global Model lists another provider's models than the global Provider's");
  const lines = opened.split("\n");
  const at = (text: string) => lines.findIndex((row) => row.includes(text));
  if (!(at("GPT Astra") < at("GPT Sol"))) fail("the model list does not put the provider's default first");
  for (const letter of "luna") await act(async () => setup.mockInput.typeText(letter));
  await settle();
  const filtered = setup.captureCharFrame();
  if (!filtered.includes("luna▏") || !filtered.includes("GPT Luna") || filtered.includes("GPT Sol")) fail("typing did not narrow the model list to the match");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (written.length !== 1 || written[0]![0] !== "model" || written[0]![1] !== "gpt-luna") fail(`picking from the filtered list wrote ${JSON.stringify(written)}, not model=gpt-luna`);
  setup.renderer.destroy();
}

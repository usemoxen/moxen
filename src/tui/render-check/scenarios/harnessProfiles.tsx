import { act } from "react";
import { testRender } from "../testrender.js";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { describeSettings } from "./settingsFixture.js";
import type { HarnessRun } from "../../features/settings/useSettings.js";
import { normalizeConfig } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * The Moxen Harness tab: the profile list, one profile, one of its models.
 * Rendered from the real schema and `describeSettings`, so what a profile's
 * fields are called, which value is in force and where it comes from are the
 * server's words, not this file's.
 */
export async function runHarnessProfiles(): Promise<void> {
  const written: Array<{ key: string; value: string }> = [];
  const probed: string[] = [];
  const tested: string[] = [];
  const mcpTested: string[] = [];
  const asked: string[] = [];
  const config = normalizeConfig({
    providers: {
      harness: {
        autoCompactPercent: 80,
        profiles: [
          {
            id: "colab",
            label: "Colab Qwen",
            baseUrl: "https://example.trycloudflare.com",
            apiKeyEnv: "RENDER_CHECK_UNSET_KEY",
            slots: 1,
            compaction: { tokens: 65536 },
            models: [{ id: "qwen3.8-flash-next", probed: { at: "2026-10-14T10:00:00.000Z", quirks: { systemFirstOnly: true }, contextWindow: 262144 } }],
          },
        ],
      },
    },
  });
  const snapshot = { path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(config) };
  // A finished probe of the profile: it belongs on that profile's page and nowhere else.
  const probeRun: HarnessRun = {
    scope: "harness",
    kind: "probe",
    profileId: "colab",
    running: false,
    result: {
      profileId: "colab",
      model: "qwen3.8-flash-next",
      at: "2026-10-21T10:00:00.000Z",
      saved: true,
      checks: [
        { id: "stream", title: "Streaming", outcome: "pass", finding: "Replies stream." },
        { id: "tools", title: "Tool calls", outcome: "fail", finding: "The server rejected the tool definitions with a 500 about the template." },
        { id: "vision", title: "Images", outcome: "inconclusive", finding: "No image model loaded, so it could not tell." },
      ],
      quirks: {},
      server: {},
      notes: ["Only one slot is free: other requests wait."],
      stopped: null,
    } as unknown as Extract<HarnessRun, { kind: "probe"; running: false; result: unknown }>["result"],
  };
  const setup = await testRender(
    <SettingsModal
      snapshot={snapshot}
      loading={false}
      saving={null}
      error={null}
      onSet={(key, value) => { written.push({ key, value }); return Promise.resolve(true); }}
      onDuplicate={() => {}}
      run={probeRun}
      onTest={(id, model) => tested.push(`${id}/${model}`)}
      onTestMcp={(name) => mcpTested.push(name)}
      onProbe={(id, model) => probed.push(`${id}/${model}`)}
      onDiscover={async (url, format, keyEnv) => {
        asked.push(`${url} ${format} ${keyEnv ?? ""}`);
        if (url.includes("down")) return { ok: false, host: "down:1", message: "Could not reach down:1. Is the server running, and is that the right address?" };
        return { ok: true, host: url.replace(/^https?:\/\//, ""), models: [{ id: "qwen3-coder:30b", contextWindow: 262_144 }, { id: "llama3.1:8b", contextWindow: 131_072 }, { id: "gemma3:27b" }] };
      }}
      onExport={() => {}}
      onImport={() => {}}
      notice={null}
      versions={null}
      latest={null}
      updating={new Set()}
      onUpdate={() => {}}
      providers={[]}
      screenWidth={100}
      screenHeight={46}
      left={2}
      top={1}
      width={96}
      height={44}
      onClose={() => {}}
    />,
    { width: 100, height: 46, exitOnCtrlC: false },
  );
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();

  // Moxen Harness is a category of its own: a heading, with its pages directly under it and no row for the harness itself.
  const sidebar = setup.captureCharFrame().split("\n");
  const harnessRow = sidebar.findIndex((row) => row.includes("MOXEN HARNESS") && row.includes("│"));
  if (harnessRow < 0) fail("the sidebar has no MOXEN HARNESS category");
  if (sidebar.some((row) => row.includes("Moxen Harness"))) fail("the Moxen Harness category also has a row of its own");
  const firstPage = sidebar.findIndex((row, at) => at > harnessRow && row.includes("Defaults"));
  if (firstPage < 0) fail("the MOXEN HARNESS category has no first page under it");
  await act(async () => setup.mockMouse.click(sidebar[firstPage]!.indexOf("Defaults") + 1, firstPage));
  await setup.flush();
  const tab = setup.captureCharFrame();
  console.log("--- harness tab ---");
  console.log(tab);
  for (const expected of ["Defaults", "Permissions"]) {
    if (!tab.includes(expected)) fail(`the first Moxen Harness heading is missing "${expected}"`);
  }
  // "Web search" is also a page in the sidebar: only the settings pane, right of it, counts.
  if (tab.includes("Compact") || tab.split("\n").some((row) => row.indexOf("Web search") > 28)) fail("opening the first Moxen Harness page showed other pages' settings");
  if (tab.includes("next start")) fail("the harness settings still say they need a restart, but the driver reads them on every turn");

  // A row of the sidebar's left column by its name, whatever tree glyph or marker it carries.
  const pageName = (line: string) => line.slice(0, 28).replace(/[│▌├└]/g, "").trim();
  // Each heading in the sidebar shows only its own settings.
  const children = setup.captureCharFrame().split("\n");
  for (const heading of ["Defaults", "Tools", "Long threads", "Sessions", "Web search", "Model servers"]) {
    if (!children.some((row, at) => at > harnessRow && pageName(row) === heading)) fail(`the sidebar does not list "${heading}" under Moxen Harness`);
  }
  const openHeading = async (name: string) => {
    const rows = setup.captureCharFrame().split("\n");
    // Below the Moxen Harness heading: the global tabs above share some of these names.
    const below = rows.findIndex((line) => line.includes("MOXEN HARNESS"));
    const row = rows.findIndex((line, at) => at > below && pageName(line) === name);
    await act(async () => setup.mockMouse.click(rows[row]!.indexOf(name) + 1, row));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await setup.flush();
    return setup.captureCharFrame();
  };
  const longThreads = await openHeading("Long threads");
  for (const expected of ["Compact at", "Hand off at"]) if (!longThreads.includes(expected)) fail(`Long threads is missing "${expected}"`);
  if (longThreads.includes("Permissions")) fail("Long threads still shows other headings' settings");
  const web = await openHeading("Web search");
  if (!web.includes("Web search") && !web.includes("Web tools")) fail("the Web heading shows none of the web settings");
  if (web.includes("Permissions") || web.includes("Compaction")) fail("the Web heading still shows other headings' settings");
  for (const name of ["Tools", "Sessions"]) {
    if (!(await openHeading(name)).includes(name)) fail(`the ${name} heading shows nothing of its own`);
  }

  // Model servers is only a list, so it opens on the list itself, with the profiles nested under it.
  const servers = await openHeading("Model servers");
  const list = servers;
  console.log("--- harness profiles ---");
  console.log(list);
  for (const expected of ["Colab Qwen", "RENDER_CHECK_UNSET_KEY is not set", "+ Add profile"]) {
    if (!list.includes(expected)) fail(`the profile list is missing "${expected}"`);
  }
  if (list.includes("Probe ·") || list.includes("Tool calls")) fail("a probe result shows on the profile list instead of on its own profile");

  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const profile = setup.captureCharFrame();
  console.log("--- harness profile ---");
  console.log(profile);
  // The probe's card sits first, so the fields follow below it: walk down to see them.
  const walked: string[] = [profile];
  for (let step = 0; step < 6; step += 1) {
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.flush();
    walked.push(setup.captureCharFrame());
  }
  for (const expected of ["Base URL", "API key variable", "Which API the server speaks"]) {
    if (!walked.some((frame) => frame.includes(expected))) fail(`the profile editor is missing "${expected}"`);
  }
  for (let step = 0; step < 6; step += 1) await act(async () => setup.mockInput.pressArrow("up"));
  await setup.flush();
  // Inside a profile the sidebar narrows to the model servers: the way back, the profiles, and the open one's headings.
  const sideRows = profile.split("\n");
  for (const expected of ["← Model servers", "└ Colab Qwen", "├ Endpoint", "├ Sampling", "└ Template quirks"]) {
    if (!sideRows.some((row) => row.includes(expected) && row.indexOf(expected) < 28)) fail(`the sidebar inside a profile is missing "${expected}"`);
  }
  if (sideRows.some((row) => row.includes("Web search") && row.indexOf("Web search") < 28)) fail("the sidebar inside a profile still lists the other Moxen Harness pages");
  // A heading in the sidebar narrows the editor to it, and tab steps through them.
  const samplingRow = sideRows.findIndex((row) => row.includes("├ Sampling") && row.indexOf("├ Sampling") < 28);
  await act(async () => setup.mockMouse.click(sideRows[samplingRow]!.indexOf("Sampling") + 1, samplingRow));
  await setup.flush();
  const sampling = setup.captureCharFrame();
  if (!sampling.includes("Temperature") || sampling.includes("Base URL")) fail("a heading in the sidebar did not narrow the profile editor to that heading");
  const quirksRow = sideRows.findIndex((row) => row.includes("└ Template quirks") && row.indexOf("└ Template quirks") < 28);
  await act(async () => setup.mockMouse.click(sideRows[quirksRow]!.indexOf("Template quirks") + 1, quirksRow));
  await setup.flush();
  const quirks = setup.captureCharFrame();
  // The advice is said once, under the heading, and not after every quirk.
  if ((quirks.match(/Most servers need none/g) ?? []).length !== 1) fail("the template quirks' advice is not said exactly once, under its heading");
  if (quirks.includes("Keep reasoning in history") || quirks.includes("Image parts")) fail("the profile editor still offers an older control beside the one that replaced it");
  await act(async () => setup.mockMouse.click(sideRows[samplingRow]!.indexOf("Sampling") + 1, samplingRow));
  await setup.flush();
  await act(async () => setup.mockInput.pressTab());
  await setup.flush();
  if (setup.captureCharFrame().includes("Temperature")) fail("tab did not step to the next heading");
  await act(async () => setup.mockInput.pressTab({ shift: true }));
  await act(async () => setup.mockInput.pressTab({ shift: true }));
  await setup.flush();
  // The profile's own row shows all of it again.
  const profileRow = sideRows.findIndex((row) => row.includes("└ Colab Qwen") && row.indexOf("└ Colab Qwen") < 28);
  await act(async () => setup.mockMouse.click(sideRows[profileRow]!.indexOf("Colab Qwen") + 1, profileRow));
  await setup.flush();
  if (!setup.captureCharFrame().includes("Base URL")) fail("the profile's own sidebar row did not show every heading again");

  // The probe's own card: a title, counts, one row per check and the note.
  for (const expected of ["Probe · qwen3.8-flash-next", "✓ 1", "✗ 1", "Streaming", "Tool calls", "Only one slot is free"]) {
    if (!profile.includes(expected)) fail(`the probe card is missing "${expected}"`);
  }
  // The key's value is never a thing this screen can show: only the variable's name is a field.
  if (walked.some((frame) => /sk-|Bearer/.test(frame))) fail("the profile editor shows something key-shaped");

  // The back button is clickable and goes up one level, not out of the editor.
  const backRows = profile.split("\n");
  const backRow = backRows.findIndex((row) => row.includes("← Profiles"));
  if (backRow < 0) fail("the profile editor has no back button naming where it goes");
  await act(async () => setup.mockMouse.click(backRows[backRow]!.indexOf("←") + 2, backRow));
  await setup.flush();
  if (!setup.captureCharFrame().includes("+ Add profile")) fail("clicking back did not return to the profile list");

  // esc and the left arrow go up exactly one level and are not also read by the settings page behind
  // the editor: esc must not close it, left must not step to another section.
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  await act(async () => setup.mockInput.pressEscape());
  // A lone escape is held back briefly in case it starts a sequence.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  await setup.flush();
  if (!setup.captureCharFrame().includes("+ Add profile")) fail("esc in the profile editor did not return to the profile list");
  await act(async () => setup.mockInput.pressArrow("left"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const leftOut = setup.captureCharFrame();
  // A page that is only a list has no page behind it: left stays put rather than jumping to the page before.
  if (!leftOut.includes("+ Add profile") || leftOut.includes("▌ ├ Web")) fail("left out of the profile list left the page");
  if (!leftOut.includes("└ Colab Qwen")) fail("the profiles are not nested under Model servers");
  await openHeading("Model servers");
  if (!setup.captureCharFrame().includes("+ Add profile")) fail("the profile list did not reopen");
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  // A profile opens on its first heading, never on everything at once.
  const opened = setup.captureCharFrame();
  if (!opened.includes("Base URL") || opened.includes("Compact at") || opened.includes("Temperature")) fail("a profile did not open on its first heading, Endpoint, alone");

  // Compaction: the profile's own threshold is shown, in tokens.
  const compaction = await openHeading("Compaction");
  if (!compaction.includes("Compact at") || !compaction.includes("64K")) fail("the profile's own compaction threshold is not shown");
  const modelsHeading = await openHeading("Models");
  for (const expected of ["qwen3.8-flash-next", "+ Add model"]) {
    if (!modelsHeading.includes(expected)) fail(`the Models heading never shows "${expected}"`);
  }

  // Open the model: family from the name, the probed window, the probe's finding.
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const modelFrame = setup.captureCharFrame();
  console.log("--- harness model ---");
  console.log(modelFrame);
  for (const expected of ["Model family", "qwen3", "the model's name", "262,144", "from a probe"]) {
    if (!modelFrame.includes(expected)) fail(`the model editor is missing "${expected}"`);
  }
  // The model has headings in the sidebar too, and it opens on the first.
  if (modelFrame.includes("systemFirstOnly")) fail("the model editor opened on everything instead of its first heading");
  for (const expected of ["├ Model", "└ In force"]) {
    if (!modelFrame.split("\n").some((row) => row.includes(expected) && row.indexOf(expected) < 28)) fail(`the sidebar inside a model is missing "${expected}"`);
  }
  const inForce = await openHeading("In force");
  if (!inForce.includes("systemFirstOnly")) fail("the model's In force heading does not show the probed quirks");

  // The probe asks before it runs, and says what it does to a one-slot server.
  await act(async () => setup.mockInput.pressKey("p"));
  await setup.flush();
  const warn = setup.captureCharFrame();
  console.log(warn);
  if (!warn.includes("tiny requests") || !warn.includes("one-slot") || probed.length !== 0) fail("p did not ask for confirmation before probing");
  await act(async () => setup.mockInput.pressKey("p"));
  await setup.flush();
  if (probed[0] !== "colab/qwen3.8-flash-next") fail(`the confirmed probe ran for ${JSON.stringify(probed)}`);
  if (written.length !== 0) fail(`looking around wrote config: ${JSON.stringify(written)}`);

  // Adding a provider: a preset, an address that need not be localhost, the server's own model list, a name, then a test.
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await setup.flush();
  };
  for (let step = 0; step < 2; step += 1) {
    await act(async () => setup.mockInput.pressEscape());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  }
  await setup.flush();
  if (!setup.captureCharFrame().includes("+ Add profile")) fail("could not get back to the profile list to add a provider");
  // A server that is not up: the reason is said and a name can still be typed; esc leaves.
  await act(async () => setup.mockInput.pressKey("a"));
  await settle();
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
  for (const char of "http://down:1") await act(async () => setup.mockInput.pressKey(char));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  await settle();
  const unreachable = setup.captureCharFrame();
  console.log(unreachable);
  if (!unreachable.includes("Could not reach down:1") || !unreachable.includes("Model name")) fail("an unreachable server did not say so and offer a typed model name");
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  await setup.flush();
  if (!setup.captureCharFrame().includes("+ Add profile")) fail("esc did not leave the add flow");

  await act(async () => setup.mockInput.pressKey("a"));
  await settle();
  const presets = setup.captureCharFrame();
  console.log("--- add a provider ---");
  console.log(presets);
  for (const expected of ["Add a provider", "Ollama", "LM Studio", "llama.cpp server", "vLLM", "OpenAI-compatible, hosted", "Other server"]) {
    if (!presets.includes(expected)) fail(`the provider presets are missing "${expected}"`);
  }
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const address = setup.captureCharFrame();
  if (!address.includes("http://localhost:11434") || !address.includes("another")) fail("the address step does not start from the preset or say it can be another machine");
  // Another machine: replace the host, keep the port.
  await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
  for (const char of "http://192.168.1.20:11434") await act(async () => setup.mockInput.pressKey(char));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  await settle();
  const models = setup.captureCharFrame();
  console.log(models);
  for (const expected of ["Models on 192.168.1.20:11434", "qwen3-coder:30b", "256k", "llama3.1:8b", "Search by name"]) {
    if (!models.includes(expected)) fail(`the discovered model list is missing "${expected}"`);
  }
  if (asked[1] !== "http://192.168.1.20:11434 chat ") fail(`discovery asked ${JSON.stringify(asked)}`);
  for (const char of "llama") await act(async () => setup.mockInput.pressKey(char));
  await setup.flush();
  const filtered = setup.captureCharFrame();
  if (filtered.includes("qwen3-coder") || !filtered.includes("llama3.1:8b")) fail("typing did not filter the discovered models");
  await act(async () => setup.mockInput.pressKey(" "));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (!setup.captureCharFrame().includes("Name this provider")) fail("picking a model did not lead to naming the provider");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const created = written.find((entry) => entry.key === "providers.harness.profiles[ollama-2]" || entry.key === "providers.harness.profiles[ollama]");
  if (created === undefined) fail(`no profile was saved: ${JSON.stringify(written)}`);
  const body = JSON.parse(created.value) as { baseUrl: string; apiFormat: string; models: Array<{ id: string; contextWindow?: number }>; apiKey?: unknown };
  if (body.baseUrl !== "http://192.168.1.20:11434" || body.apiFormat !== "chat" || body.models.length !== 1 || body.models[0]!.id !== "llama3.1:8b" || body.models[0]!.contextWindow !== 131072) fail(`the saved profile is wrong: ${created.value}`);
  if (/key/i.test(created.value.replace(/apiKeyEnv/g, ""))) fail("the saved profile carries something key-shaped");
  if (!tested.some((entry) => entry.endsWith("/llama3.1:8b"))) fail(`the new provider was not tested: ${JSON.stringify(tested)}`);


  // MCP servers: well-known ones to start from, a name, then a connection test that lists the tools.
  const sidebarNow = setup.captureCharFrame().split("\n");
  const mcpRow = sidebarNow.findIndex((row) => row.includes("MCP servers") && row.includes("│"));
  if (mcpRow < 0) fail("the sidebar has no MCP servers entry");
  await act(async () => setup.mockMouse.click(sidebarNow[mcpRow]!.indexOf("MCP servers") + 1, mcpRow));
  await settle();
  // The page holds the servers and the runner now: the servers row opens the list.
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  await act(async () => setup.mockInput.pressKey("a"));
  await settle();
  const mcp = setup.captureCharFrame();
  console.log("--- add an MCP server ---");
  console.log(mcp);
  for (const expected of ["Add an MCP server", "Filesystem", "Fetch", "GitHub", "Brave Search", "Exa Search", "Playwright", "Custom"]) {
    if (!mcp.includes(expected)) fail(`the MCP presets are missing "${expected}"`);
  }
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (!setup.captureCharFrame().includes("server-filesystem")) fail("the Filesystem preset did not fill in its command");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (!setup.captureCharFrame().includes("Name this server")) fail("the command step did not lead to naming the server");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const mcpSaved = written.find((entry) => entry.key === "mcpServers[filesystem]");
  if (mcpSaved === undefined || JSON.parse(mcpSaved.value).command !== "npx" || JSON.parse(mcpSaved.value).args?.[0] !== "-y") fail(`the MCP server was saved wrong: ${JSON.stringify(written.slice(-2))}`);
  if (!mcpTested.includes("filesystem")) fail("the new MCP server was not connected to list its tools");
  setup.renderer.destroy();
}

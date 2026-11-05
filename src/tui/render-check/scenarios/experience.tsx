import { act, useState } from "react";
import type { BaseRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { ClientApi, Command, ExperienceSnapshot, Query, QueryResult } from "../../../server/api.js";
import { DEFAULT_CONFIG, setConfigValue } from "../../../core/config.js";
import type { CliConfig } from "../../../core/types.js";
import { describeSettings } from "../../../core/configschema.js";
import { RELEASES } from "../../../core/experience/experience.js";
import { APP_VERSION } from "../../../core/version.js";
import { applyLanguage } from "../../i18n/index.js";
import { THEMES } from "../../themes.js";
import { GUIDE_STEPS, OnboardingPage } from "../../features/experience/onboardingpage.js";
import { ChangelogModal } from "../../features/experience/experiencemodal.js";
import { useSettings } from "../../features/settings/useSettings.js";
import { ExperienceField } from "../../features/experience/field.js";
import { setTerminalVisible } from "../../hooks/useTerminalVisible.js";
import { App, client as fixtureClient, harnessTheme } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** Pins first-run gating, real saves and setup that stays on the onboarding page. */
export async function runExperience(): Promise<void> {
  let config: CliConfig = { ...DEFAULT_CONFIG, ui: { language: "en", backdrop: "off" } };
  let state: ExperienceSnapshot = { version: APP_VERSION, releases: [...RELEASES, { ...RELEASES[0]!, version: "0.1.1", title: { en: "Earlier release", es: "Versión anterior" }, highlights: [], sections: [{ title: { en: "Fixes", es: "Correcciones" }, entries: [{ en: "An earlier detailed change.", es: "Un cambio detallado anterior." }] }] }], onboardingCompleted: false, seenReleases: [] };
  const commands: Command[] = [];
  let refuseMemory = false;
  const embeddingsOn = () => config.memoryEmbeddings === true;
  let memoryGate: Promise<void> | null = null;
  let memoryStatus: QueryResult<"memory.embeddings.status"> = { state: "stopped", phase: "idle", device: null, message: null, file: null, percent: null, validation: null, busy: false, indexed: 0 };
  const settings = () => ({ path: "config.json", exists: true, settings: describeSettings(config) });
  const client: ClientApi = {
    ...fixtureClient,
    query: (async (query: Query) => {
      if (query.type === "experience.read") return state;
      if (query.type === "settings.read") return settings();
      if (query.type === "memory.embeddings.status") return memoryStatus;
      return fixtureClient.query(query);
    }) as ClientApi["query"],
    dispatch: (async (command: Command) => {
      commands.push(command);
      if (command.type === "settings.set") {
        if (refuseMemory && command.key === "memoryEmbeddings") throw new Error("Memory preference was refused");
        if (command.key === "memoryEmbeddings" && command.value === "true" && memoryGate) await memoryGate;
        config = setConfigValue(config, command.key, command.value) as typeof config;
        return { ...settings(), accepted: true };
      }
      if (command.type === "experience.update") {
        state = { ...state, onboardingCompleted: state.onboardingCompleted || command.completeOnboarding === true,
          seenReleases: command.seenRelease ? [...new Set([...state.seenReleases, command.seenRelease])] : state.seenReleases };
        return state;
      }
      return fixtureClient.dispatch(command);
    }) as ClientApi["dispatch"],
  };
  const setup = await testRender(<App client={client} onQuit={() => {}} />, { width: 180, height: 47, exitOnCtrlC: false });
  const until = async (check: () => boolean, message: string) => {
    const deadline = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > deadline) fail(`${message}\n${readFrame()}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await setup.flush(); });
    }
  };
  // Polling must not export intermediate animation frames under the last
  // intentional capture's label. Spans read the same frame without publishing it.
  const readFrame = () => setup.captureSpans().lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
  const visible = (text: string) => readFrame().includes(text);
  const see = (text: string) => until(() => visible(text), `missing ${text}`);
  const click = async (text: string) => {
    await see(text);
    const lines = readFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    await act(async () => setup.mockMouse.click(lines[y]!.indexOf(text) + 1, y));
    await setup.flush();
  };
  const next = async () => click("Continue");
  // "Back" also starts "Backdrop": the footer's button is the one on the row with Later.
  const back = async () => {
    await see("Later");
    const lines = readFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Later") && line.includes("Back"));
    if (y < 0) fail(`no Back button on the footer\n${readFrame()}`);
    await act(async () => setup.mockMouse.click(lines[y]!.indexOf("Back") + 1, y));
    await setup.flush();
  };
  const inlineNavigation = () => {
    const frame = readFrame();
    if ((frame.match(/← /g) ?? []).length !== 1 || !frame.includes("Back") || !frame.includes("Continue") || !/\d of 6/.test(frame)) fail(`inline setup lost its navigation or duplicated its back link\n${frame}`);
  };
  const settledModal = async (target: TestRendererSetup = setup) => {
    await new Promise<void>((resolve) => {
      const check = () => {
        if (target.renderer.root.findDescendantById("modal-panel")?.opacity !== 1) return;
        clearTimeout(deadline);
        target.renderer.off("frame", check);
        resolve();
      };
      const deadline = setTimeout(() => fail("release viewer did not finish fading in"), 4000);
      target.renderer.on("frame", check);
      check();
    });
    await target.flush();
  };
  // Scrolls the open page with Page Down until the text is on screen.
  const scrollTo = async (text: string, target: TestRendererSetup = setup) => {
    for (let attempt = 0; attempt < 8 && !target.captureCharFrame().includes(text); attempt += 1) {
      await act(async () => target.mockInput.pressKey("\x1b[6~"));
      await target.flush();
    }
    if (!target.captureCharFrame().includes(text)) fail(`could not scroll to ${text}\n${target.captureCharFrame()}`);
  };
  const press = async (name: string) => {
    await act(async () => { if (name === "left" || name === "right") setup.mockInput.pressArrow(name); else if (name === "escape") setup.mockInput.pressEscape(); else setup.mockInput.pressKey(name); });
    await setup.flush();
  };
  // The dots under "N of 6": the progress row is found by its label, then the glyphs by position.
  const clickDot = async (index: number) => {
    const lines = readFrame().split("\n");
    const y = lines.findIndex((line) => / of 6/.test(line));
    const columns = [...lines[y]!.matchAll(/[●○]/g)].map((match) => match.index!);
    if (y < 0 || columns.length !== GUIDE_STEPS.length) fail(`progress dots not found\n${readFrame()}`);
    await act(async () => setup.mockMouse.click(columns[index]!, y));
    await setup.flush();
  };
  await see("Welcome to Moxen");
  await see("1 of 6");
  if (visible("Back")) fail("the first step offered Back");
  await clickDot(2);
  await see("Choose who you work with");
  await see("3 of 6");
  await clickDot(0);
  await see("Welcome to Moxen");
  // Later leaves the guide; the palette brings it back.
  await click("Later");
  await until(() => !visible("Welcome to Moxen"), "Later did not close the guide");
  if (state.onboardingCompleted) fail("Later completed onboarding");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("Getting started");
  await see("Welcome to Moxen");
  await next();
  await see("Make it yours");
  await back();
  await see("Welcome to Moxen");
  await press("]");
  await see("Make it yours");
  // The theme row has focus on arrival: Right applies the next theme, Left restores it.
  const before = config.ui?.theme;
  await press("right");
  await until(() => config.ui?.theme !== before && config.ui?.theme !== undefined, "the arrow key did not apply the next theme");
  const advanced = config.ui?.theme;
  await press("left");
  await until(() => config.ui?.theme !== advanced, "the arrow key did not step back to the previous theme");
  if (visible("Threads ─")) fail("onboarding was drawn over the working view");
  await click("Catppuccin Latte");
  await until(() => config.ui?.theme === "catppuccin-latte", "appearance was not persisted");
  // The persistence check changes the live palette, too. Restore the visual
  // harness's requested theme before capturing the rest of the guide.
  if (harnessTheme.current && harnessTheme.current !== "catppuccin-latte") {
    await click(THEMES[harnessTheme.current as keyof typeof THEMES].label);
    await until(() => config.ui?.theme === harnessTheme.current, "the requested frame theme was not restored");
  }
  // The backdrop mounts after the guide and used to paint over it (MXN-198).
  await click("Animated");
  await until(() => config.ui?.backdrop === "animated", "the animated backdrop was not enabled");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); await setup.flush(); });
  if (!visible("Make it yours")) fail("the animated backdrop painted over the guide");
  await click("Static");
  await next();
  await see("Choose who you work with");
  await click("Claude Opus 5");
  if (visible("Select model")) fail("onboarding opened a separate model picker");
  await see("Choose who you work with");
  await click("Connect a model server");
  await see("Back to this step");
  await act(async () => setup.mockInput.pressKey("a"));
  await see("Ollama");
  if (!visible("Choose who you work with")) fail("model server setup left onboarding");
  inlineNavigation();
  console.log("--- onboarding, inline model server setup ---");
  console.log(setup.captureCharFrame());
  await click("← back");
  await click("Back to this step");
  await next();
  await see("What should Moxen remember?");
  refuseMemory = true;
  await click("With embeddings");
  await see("Memory preference was refused");
  if (embeddingsOn()) fail("a refused preference was shown as saved");
  refuseMemory = false;
  let finishMemory: () => void = () => {};
  memoryGate = new Promise<void>((resolve) => { finishMemory = resolve; });
  memoryStatus = { ...memoryStatus, state: "loading", phase: "installing", busy: true };
  await click("With embeddings");
  await see("Installing the optional runtime");
  await see("Cancel setup (c)");
  if (/\[\s*Cancel setup/.test(readFrame())) fail("memory setup still uses bracketed buttons");
  const memoryRows = readFrame().split("\n");
  const choices = ["○  Memory off", "○  Memory ", "●  With embeddings"].map((label) => memoryRows.findIndex((line) => line.includes(label) && (label !== "○  Memory " || !line.includes("Memory off"))));
  const modelRow = memoryRows.find((line) => line.includes("Memory model"));
  if (choices.some((row) => row < 0) || choices[1]! - choices[0]! !== choices[2]! - choices[1]!) fail("memory choices have uneven spacing");
  if (modelRow?.indexOf("Memory model") !== memoryRows[choices[2]!]!.indexOf("●")) fail("memory setup is not aligned with the choices");
  console.log("--- onboarding, memory setup pending ---");
  console.log(setup.captureCharFrame());
  if (embeddingsOn()) fail("semantic memory was enabled before validation");
  await click("Continue");
  if (!visible("What should Moxen remember?")) fail("onboarding proceeded while memory setup was pending");
  memoryStatus = { ...memoryStatus, phase: "validating" };
  await see("Checking retrieval and query speed");
  memoryStatus = { ...memoryStatus, state: "ready", phase: "idle", busy: false, device: "webgpu", indexed: 8,
    validation: { version: "fixture", platform: "fixture", arch: "fixture", device: "webgpu", correct: 6, total: 6, queryP95Ms: 24, documentMs: 100, checkedAt: "2026-11-01" } };
  memoryGate = null;
  finishMemory();
  await until(() => config.memoryEmbeddings === true && config.memory !== false, "embedding preference did not save");
  await click("Memory off");
  await until(() => config.memory === false && config.memoryEmbeddings === false, "memory off did not save");
  await click("With embeddings");
  await until(() => config.memoryEmbeddings === true && config.memory !== false, "memory did not re-enable");
  console.log("--- onboarding, memory preference ---");
  console.log(setup.captureCharFrame());
  await next();
  await see("Bring your tools");
  await click("Add an MCP server");
  await see("Back to this step");
  if (!visible("Bring your tools")) fail("MCP setup left the onboarding page");
  await act(async () => setup.mockInput.pressKey("a"));
  await see("Brave Search");
  if (!visible("Bring your tools")) fail("MCP preset selection left onboarding");
  inlineNavigation();
  console.log("--- onboarding, inline MCP setup ---");
  console.log(setup.captureCharFrame());
  await click("← back");
  await click("Back to this step");
  await see("Bring your tools");
  await next();
  await see("A place to build");
  await see("No project");
  await click("No project");
  await see("A place to build");
  await click("Start a thread");
  await until(() => state.onboardingCompleted && !visible("A place to build"), "onboarding did not finish");
  if (commands.some((command) => command.type === "thread.create" || command.type === "thread.turn.start" || command.type === "thread.model-selection.set")) fail("onboarding changed or started a thread");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("What’s new");
  await see("Make yourself at home");
  await settledModal();
  const releasePanel = setup.renderer.root.findDescendantById("modal-panel");
  if (visible("There’s something new in Moxen")) fail("release notice remained above the open viewer");
  if (visible("Highlights") || visible("RELEASE HISTORY")) fail("the viewer still shows tabs or its history column");
  await see("1 of 2");
  console.log("--- changelog, one release ---");
  console.log(setup.captureCharFrame());
  await scrollTo("The CLI and release viewer report the same package version.");
  if (!visible("ALL CHANGES") && !visible("Improved")) fail("the full notes do not follow the highlights on the same page");
  // The history opens only when asked for, and Escape returns to the release.
  await press("h");
  await see("RELEASE HISTORY");
  await see("Earlier release");
  if (setup.renderer.root.findDescendantById("modal-panel") !== releasePanel || releasePanel?.opacity !== 1) fail("opening the history restarted the modal fade");
  console.log("--- changelog, history ---");
  console.log(setup.captureCharFrame());
  await press("escape");
  await until(() => !visible("RELEASE HISTORY"), "Escape in the history did not return to the release");
  await see("A place to start");
  await press("h");
  await click("Earlier release");
  await see("2 of 2");
  await see("An earlier detailed change.");
  if (visible("RELEASE HISTORY")) fail("choosing a release left the history open");
  await press("left");
  await see("Make yourself at home");
  // Mouse: the header's arrow moves on, too.
  {
    const lines = readFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("1 of 2"));
    await act(async () => setup.mockMouse.click(lines[y]!.lastIndexOf("→"), y));
    await setup.flush();
  }
  await see("An earlier detailed change.");
  await press("left");
  await see("Make yourself at home");
  // Try it opens the guide from the viewer.
  await click("Try it");
  await see("Welcome to Moxen");
  await press("escape");
  await until(() => !visible("Welcome to Moxen"), "Escape did not leave the guide");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("What’s new");
  await see("Make yourself at home");
  await settledModal();
  await scrollTo("Add one in the guide or");
  console.log("--- changelog, inline tools copy ---");
  console.log(setup.captureCharFrame());
  await click("Later");
  if (state.seenReleases.length) fail("closing release notes marked them read");
  await see("There’s something new in Moxen");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("What’s new");
  await act(async () => setup.mockInput.pressArrow("right"));
  await see("Earlier release");
  await see("An earlier detailed change.");
  await click("Mark read");
  await until(() => state.seenReleases.includes("0.1.1"), "older release was not acknowledged");
  if (state.seenReleases.includes(RELEASES[0]!.version)) fail("reading an older release also acknowledged the latest one");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("What’s new");
  await click("Mark read");
  await until(() => state.seenReleases.includes(RELEASES[0]!.version), "release was not acknowledged");
  setup.renderer.destroy();

  // Spanish and Off use the same controls; no scene is mounted behind translated text.
  applyLanguage("es-ES");
  function SpanishGuide() {
    const controller = useSettings(client, true);
    return <OnboardingPage step={3} onStep={() => {}} settings={controller} providers={null} selection={null} projects={[]} projectId={null}
      client={client} error={null} saving={false} motion="off" screenWidth={180} screenHeight={47} onMemory={() => {}} onModel={() => {}}
      onProject={() => {}} onRefresh={() => {}} onComplete={() => {}} onClose={() => {}} />;
  }
  const spanish = await testRender(<SpanishGuide />, { width: 180, height: 47, exitOnCtrlC: false });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); await spanish.flush(); });
  console.log("--- onboarding, Spanish memory ---");
  const frame = spanish.captureCharFrame();
  if (!frame.includes("Con embeddings") || !frame.includes("207 MB")) fail(`Spanish semantic memory setup guidance is missing\n${frame}`);
  const titleRow = frame.split("\n").findIndex((line) => line.includes("¿Qué debería recordar Moxen?"));
  const titleColumn = frame.split("\n")[titleRow]?.indexOf("¿Qué debería recordar Moxen?") ?? -1;
  if (titleColumn < 0 || /[█▀▄▌▐]/.test(frame.split("\n")[titleRow + 1]?.slice(titleColumn, titleColumn + 2) ?? "")) fail(`a stray cursor remains below the Spanish step title\n${frame}`);
  console.log(frame);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const rows = spanish.captureSpans().lines.map((line) => line.spans.map((span) => span.text).join(""));
    if (rows.some((line) => line.includes("Comprobar (r)"))) break;
    const row = rows.findIndex((line) => line.includes("Con embeddings"));
    if (row < 0) fail("Spanish memory choice disappeared before its setup actions were reachable");
    await act(async () => spanish.mockMouse.scroll(rows[row]!.indexOf("Con embeddings"), row, "down"));
    await spanish.flush();
  }
  console.log("--- onboarding, Spanish memory setup ---");
  const setupFrame = spanish.captureCharFrame();
  if (!setupFrame.includes("Comprobar (r)") || /\[\s*Comprobar/.test(setupFrame)) fail(`Spanish memory setup actions are missing or still bracketed\n${setupFrame}`);
  console.log(setupFrame);
  spanish.renderer.destroy();
  const spanishRelease = await testRender(<ChangelogModal snapshot={state} error={null} saving={false} screenWidth={180} screenHeight={47}
    onSettings={() => {}} onRead={() => {}} onGuide={() => {}} onClose={() => {}} />, { width: 180, height: 47, exitOnCtrlC: false });
  await settledModal(spanishRelease);
  await scrollTo("desde la guía o Ajustes", spanishRelease);
  console.log("--- changelog, Spanish inline tools copy ---");
  const releaseFrame = spanishRelease.captureCharFrame();
  if (!releaseFrame.includes("desde la guía o Ajustes")) fail(`Spanish release copy lost inline MCP setup\n${releaseFrame}`);
  console.log(releaseFrame);
  spanishRelease.renderer.destroy();
  applyLanguage("en");
  await runExperienceField();
}

async function runExperienceField(): Promise<void> {
  let renders = 0;
  let setMotion: (value: "animated" | "static" | "off") => void = () => {};
  function FieldHarness() {
    renders += 1;
    const [motion, changeMotion] = useState<"animated" | "static" | "off">("animated");
    setMotion = changeMotion;
    return <ExperienceField width={80} height={20} stage={3} motion={motion} />;
  }
  const setup = await testRender(<FieldHarness />, { width: 80, height: 20, exitOnCtrlC: false });
  const find = (node: BaseRenderable): BaseRenderable | undefined => node.id === "experience-field" ? node : node.getChildren().map(find).find(Boolean);
  const field = find(setup.renderer.root);
  if (!field) fail("the onboarding field did not mount");
  let requests = 0;
  const request = field.requestRender.bind(field);
  field.requestRender = () => { requests += 1; request(); };
  const deadline = Date.now() + 2000;
  while (requests === 0) {
    if (Date.now() > deadline) fail("the onboarding field did not animate");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  if (renders !== 1) fail("the onboarding animation rerendered React");
  setTerminalVisible(false);
  const hidden = requests;
  // Observe more than two 100ms frames: an idle clock must make no requests.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
  if (requests !== hidden) fail("the hidden onboarding field kept animating");
  await act(async () => setMotion("static"));
  setTerminalVisible(true);
  await setup.flush();
  const still = requests;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
  if (requests !== still) fail("the static onboarding field kept animating");
  await act(async () => setMotion("off"));
  await setup.flush();
  if (find(setup.renderer.root)) fail("Off left the onboarding field mounted");
  const removed = requests;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
  if (requests !== removed) fail("the unmounted onboarding field left a clock running");
  setup.renderer.destroy();
}

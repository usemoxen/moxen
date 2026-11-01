import { act, useState } from "react";
import type { BaseRenderable } from "@opentui/core";
import type { ClientApi, Command, ExperienceSnapshot, Query, QueryResult } from "../../../server/api.js";
import { DEFAULT_CONFIG, setConfigValue } from "../../../core/config.js";
import type { CliConfig } from "../../../core/types.js";
import { describeSettings } from "../../../core/configschema.js";
import { RELEASES } from "../../../core/experience/experience.js";
import { APP_VERSION } from "../../../core/version.js";
import { applyLanguage } from "../../i18n/index.js";
import { OnboardingPage } from "../../features/experience/onboardingpage.js";
import { useSettings } from "../../features/settings/useSettings.js";
import { ExperienceField } from "../../features/experience/field.js";
import { setTerminalVisible } from "../../hooks/useTerminalVisible.js";
import { App, client as fixtureClient } from "../fixtures.js";
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
      if (Date.now() > deadline) fail(`${message}\n${setup.captureCharFrame()}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await setup.flush(); });
    }
  };
  const visible = (text: string) => setup.captureCharFrame().includes(text);
  const see = (text: string) => until(() => visible(text), `missing ${text}`);
  const click = async (text: string) => {
    await see(text);
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    await act(async () => setup.mockMouse.click(lines[y]!.indexOf(text) + 1, y));
    await setup.flush();
  };
  const next = async () => click("Continue");
  await see("Welcome to Moxen");
  await next();
  await see("Make it yours");
  if (visible("Threads ─")) fail("onboarding was drawn over the working view");
  await click("Catppuccin Latte");
  await until(() => config.ui?.theme === "catppuccin-latte", "appearance was not persisted");
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
  console.log("--- onboarding, inline model server setup ---");
  console.log(setup.captureCharFrame());
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
  console.log("--- onboarding, inline MCP setup ---");
  console.log(setup.captureCharFrame());
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
  await click("All changes");
  await see("The CLI and release viewer report the same package version.");
  await see("RELEASE HISTORY");
  console.log("--- changelog, detailed changes ---");
  console.log(setup.captureCharFrame());
  await click("Later");
  if (state.seenReleases.length) fail("closing release notes marked them read");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("What’s new");
  await act(async () => setup.mockInput.pressArrow("right"));
  await see("Earlier release");
  await see("An earlier detailed change.");
  await click("Mark read and close");
  await until(() => state.seenReleases.includes("0.1.1"), "older release was not acknowledged");
  if (state.seenReleases.includes(RELEASES[0]!.version)) fail("reading an older release also acknowledged the latest one");
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await click("What’s new");
  await click("Mark read and close");
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
  const frame = spanish.captureCharFrame();
  if (!frame.includes("Con embeddings") || !frame.includes("207 MB")) fail(`Spanish semantic memory setup guidance is missing\n${frame}`);
  console.log("--- onboarding, Spanish memory ---");
  console.log(frame);
  spanish.renderer.destroy();
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

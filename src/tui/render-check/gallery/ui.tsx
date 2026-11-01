import { OverflowText } from "../../ui/overflowtext.js";
import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { ChangelogModal } from "../../features/experience/experiencemodal.js";
import { OnboardingPage } from "../../features/experience/onboardingpage.js";
import { ExperienceField } from "../../features/experience/field.js";
import { SETTINGS_PROVIDERS } from "./settings.js";
import { client } from "../fixtures.js";
import { RELEASES } from "../../../core/experience/experience.js";
import { APP_VERSION } from "../../../core/version.js";
import { DEFAULT_CONFIG } from "../../../core/config.js";
import { describeSettings } from "../../../core/configschema.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { LoadingScreen } from "../../ui/loadingscreen.js";
import { ModalShell } from "../../ui/modalshell.js";
import { NoticeBanner, Pager, type Notice } from "../../ui/noticebanner.js";
import { DateTimeModal } from "../../ui/datetimemodal.js";
import { RenameModal } from "../../ui/renamemodal.js";
import { SearchField } from "../../ui/searchfield.js";
import { Slider, SliderDefault } from "../../ui/slider.js";
import { MonitoringBackdrop } from "../../ui/backdrop.js";
import { TextField } from "../../features/settings/textfield.js";
import { SideTabBar } from "../../features/sidepanel/sidepanel.js";
import { COLOR, SURFACE } from "../../theme.js";
import { Caption, Stage, type GalleryEntry } from "./registry.js";

const noop = (): void => {};
const clickExperience = async (setup: TestRendererSetup, label: string) => {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(label));
  if (y < 0) throw new Error(`missing experience control: ${label}`);
  await act(async () => setup.mockMouse.click(lines[y]!.indexOf(label) + 1, y));
  await setup.flush();
};

const notice = (key: string, title: string, actions: string[]): Notice => ({
  key,
  glyph: "◔",
  glyphColor: COLOR.danger,
  title,
  detail: <text fg={COLOR.dim}>{`  about ${key}`}</text>,
  actions: actions.map((label, index) => ({ label, fg: index === actions.length - 1 && actions.length > 2 ? COLOR.dim : COLOR.accent, onClick: noop })),
});

export const UI_GALLERY: GalleryEntry[] = [
  ...Array.from({ length: 6 }, (_, step): GalleryEntry => ({
    id: `experience-onboarding-${step + 1}`,
    group: "experience", title: `Getting started: step ${step + 1}`,
    width: 180, height: 47, settleMs: 180,
    element: () => <OnboardingPage step={step} onStep={noop}
      settings={{ snapshot: { path: "config.json", exists: true, settings: describeSettings({ ...DEFAULT_CONFIG, memoryEmbeddings: true }) },
        saving: null, error: null, set: async () => true, duplicate: noop, run: null, test: noop, testMcp: noop, probe: noop,
        discover: async () => ({ ok: false, host: null, message: "preview" }), exportProfile: noop, importProfile: noop, notice: null }}
      providers={SETTINGS_PROVIDERS} selection={{ instanceId: "claudeAgent", model: "claude-opus-5" }} projects={[{ id: "moxen", title: "Moxen", workspaceRoot: "moxen", defaultModelSelection: null }]} projectId="moxen" client={client}
      error={null} saving={false} motion="static" screenWidth={180} screenHeight={47} onMemory={noop} onModel={noop} onProject={noop}
      onRefresh={noop} onComplete={noop} onClose={noop}
    />,
  })),
  ...[2, 4].map((step): GalleryEntry => ({
    id: step === 2 ? "experience-model-server-inline" : "experience-mcp-inline", group: "experience", title: "Inline connection setup", width: 180, height: 47,
    element: () => UI_GALLERY.find((entry) => entry.id === `experience-onboarding-${step + 1}`)!.element(),
    drive: async (setup) => {
      await clickExperience(setup, step === 2 ? "Connect a model server" : "Add an MCP server");
      await act(async () => setup.mockInput.pressKey("a"));
      await setup.flush();
      if (step === 2) { await act(async () => setup.mockInput.pressEnter()); await setup.flush(); }
    },
  })),
  ...[false, true].map((details): GalleryEntry => ({
    id: details ? "experience-changelog-details" : "experience-changelog", group: "experience", title: details ? "All changes" : "Highlights", width: 180, height: 47, settleMs: 180,
    element: () => <ChangelogModal snapshot={{ version: APP_VERSION, releases: RELEASES, onboardingCompleted: true, seenReleases: [] }} error={null} saving={false} screenWidth={180} screenHeight={47} onSettings={noop} onRead={noop} onGuide={noop} onClose={noop} />,
    ...(details ? { drive: async (setup) => { await act(async () => setup.mockInput.pressKey("d")); await setup.flush(); } } : {}),
  })),
  { id: "experience-field", group: "experience", title: "Welcome thread field", width: 100, height: 30,
    element: () => <Stage width={100} height={30}><ExperienceField width={100} height={30} stage={3} motion="static" /></Stage> },
  {
    id: "ui-overflow-text", group: "ui", title: "OverflowText", width: 60, height: 7,
    element: () => <Stage width={60} height={7}>
      <Caption text="Hover the clipped label to reveal the full text" />
      <OverflowText width={28} fg={COLOR.text}>{"The quick brown fox jumps over the lazy dog"}</OverflowText>
      <Caption text="Selected labels scroll; adjacent columns stay put" />
      <box style={{flexDirection: "row", height: 1}}>
        <OverflowText width={28} active padToWidth fg={COLOR.accent}>{"The quick brown fox jumps over the lazy dog"}</OverflowText>
        <text fg={COLOR.dim}>{" | fixed column"}</text>
      </box>
    </Stage>,
  },
  {
    id: "ui-hover-button",
    group: "ui",
    title: "HoverButton",
    width: 70,
    height: 5,
    element: () => (
      <Stage width={70} height={5}>
        <box style={{ flexDirection: "row", height: 1, marginTop: 1, gap: 2 }}>
          <HoverButton label=" accent " fg={COLOR.accent} onClick={noop} />
          <HoverButton label=" danger " fg={COLOR.danger} onClick={noop} />
          <HoverButton label=" dim " fg={COLOR.dim} onClick={noop} />
          <HoverButton label=" filled " fg={SURFACE.base} bg={COLOR.accent} onClick={noop} />
        </box>
      </Stage>
    ),
  },
  {
    id: "ui-search-field",
    group: "ui",
    title: "SearchField",
    width: 60,
    height: 20,
    element: () => (
      <Stage width={60} height={20}>
        <Caption text="empty, taking keys" />
        <SearchField query="" placeholder="Search threads" marginTop={0} />
        <Caption text="typed" />
        <SearchField query="auth" placeholder="Search threads" marginTop={0} />
        <Caption text="not taking keys" />
        <SearchField query="" active={false} placeholder="Search threads" marginTop={0} />
        <Caption text="a query longer than the field" />
        <SearchField query="the migration that moved every theme setting into one table" placeholder="Search threads" marginTop={0} />
      </Stage>
    ),
  },
  {
    id: "ui-slider",
    group: "ui",
    title: "Slider",
    width: 70,
    height: 28,
    element: () => (
      <Stage width={70} height={28}>
        <Caption text="chosen, with ends and a caption" />
        <Slider idPrefix="g1" stops={["Low", "Medium", "High", "Max"]} active={2} chosen={1} width={60} ends={{ low: "Faster", high: "Smarter" }} caption="High: thinks longer before answering." onMove={noop} onPick={noop} />
        <Caption text="nothing chosen (the default applies)" />
        <Slider idPrefix="g2" stops={["Off", "Ask", "Automatic"]} active={0} chosen={-1} width={60} onMove={noop} onPick={noop} />
      </Stage>
    ),
  },
  {
    id: "ui-pager",
    group: "ui",
    title: "Pager",
    width: 30,
    height: 3,
    element: () => (
      <Stage width={30} height={3}>
        <Pager position={0} count={3} onPage={noop} />
      </Stage>
    ),
  },
  {
    id: "ui-notice-banner",
    group: "ui",
    title: "NoticeBanner",
    width: 100,
    height: 16,
    element: () => (
      <Stage width={100} height={16}>
        <Caption text="two notices, wide" />
        <NoticeBanner notices={[notice("usage", "Usage limit reached", ["Continue at reset"]), notice("resume", "Resume with less context", ["Compact"])]} index={0} onPage={noop} width={100} />
        <Caption text="narrow, three actions" />
        <box style={{ width: 60, height: 6 }}>
          <NoticeBanner notices={[notice("usage", "Usage limit reached", ["Continue at reset", "In a new thread", "Dismiss"])]} index={0} onPage={noop} width={60} />
        </box>
      </Stage>
    ),
  },
  {
    id: "ui-modal-shell",
    group: "ui",
    title: "ModalShell",
    width: 70,
    height: 14,
    settleMs: 250,
    element: () => (
      <Stage width={70} height={14}>
        <text fg={COLOR.dim}>{"the view behind the modal"}</text>
        <ModalShell screenWidth={70} screenHeight={14} left={8} top={2} width={54} height={9} onClose={noop}>
          <box style={{ padding: 1, flexDirection: "column" }}>
            <text fg={COLOR.bright}>{"A modal"}</text>
            <text fg={COLOR.dim}>{"enter confirms · esc cancels"}</text>
          </box>
        </ModalShell>
      </Stage>
    ),
  },
  {
    id: "ui-rename-modal",
    group: "ui",
    title: "RenameModal",
    width: 70,
    height: 12,
    settleMs: 250,
    element: () => (
      <Stage width={70} height={12}>
        <RenameModal initialTitle="Neural Radiance Cache viability" screenWidth={70} screenHeight={12} left={6} top={2} width={58} height={7} onSubmit={noop} onClose={noop} />
      </Stage>
    ),
  },
  {
    id: "ui-datetime-modal",
    group: "ui",
    title: "DateTimeModal",
    width: 70,
    height: 16,
    settleMs: 250,
    element: () => (
      <Stage width={70} height={16}>
        <DateTimeModal screenWidth={70} screenHeight={16} left={3} top={2} width={64} height={10} onSubmit={noop} onClose={noop} />
      </Stage>
    ),
  },
  {
    id: "ui-loading-screen",
    group: "ui",
    title: "LoadingScreen",
    width: 60,
    height: 6,
    element: () => (
      <Stage width={60} height={6}>
        <LoadingScreen stage="threads" />
      </Stage>
    ),
  },
  {
    id: "ui-slider-default",
    group: "ui",
    title: "SliderDefault",
    width: 90,
    height: 6,
    element: () => (
      <Stage width={90} height={6}>
        <SliderDefault id="g-default-unset" unset defaultLabel="Medium" onReset={noop} />
        <SliderDefault id="g-default-set" unset={false} defaultLabel="Medium" onReset={noop} />
      </Stage>
    ),
  },
  {
    id: "ui-monitoring-backdrop",
    group: "ui",
    title: "MonitoringBackdrop",
    width: 80,
    height: 20,
    element: () => (
      <Stage width={80} height={20}>
        <MonitoringBackdrop width={80} height={20} motion="static" />
      </Stage>
    ),
  },
  {
    id: "settings-text-field",
    group: "settings",
    title: "TextField",
    width: 70,
    height: 14,
    element: () => (
      <Stage width={70} height={14}>
        <TextField initial="" placeholder="claude" fallback="the default, claude" width={60} onSubmit={noop} />
        <Caption text="with a value" />
        <TextField initial="/usr/local/bin/gh" width={60} onSubmit={noop} />
        <Caption text="secret" />
        <TextField initial="sk-live-123456" secret width={60} onSubmit={noop} />
      </Stage>
    ),
  },
  {
    id: "sidepanel-tab-bar",
    group: "sidepanel",
    title: "SideTabBar",
    width: 70,
    height: 12,
    element: () => (
      <Stage width={70} height={12}>
        <SideTabBar tab="diff" badges={{ diff: "2", context: "42%" }} onTab={noop} onClose={noop} />
        <Caption text="Context open, Agents badge" />
        <SideTabBar tab="context" badges={{ agents: "1", context: "42%" }} onTab={noop} onClose={noop} />
        <Caption text="a delegated thread's Info tab" />
        <SideTabBar tab="agents" badges={{}} onTab={noop} onClose={noop} agentsLabel="Info" />
      </Stage>
    ),
  },
];

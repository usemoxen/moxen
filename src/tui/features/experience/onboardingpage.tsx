import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import path from "node:path";

import type { ClientApi, QueryResult } from "../../../server/api.js";
import type { ModelSelection, ProjectEnvelope } from "../../../core/types.js";
import { expandHome } from "../../../core/config.js";
import { t, tx } from "../../i18n/index.js";
import { localizeSnapshot } from "../../i18n/settingsview.js";
import { textWidth } from "../../model/textoverflow.js";
import { COLOR, MODE_COLOR, SURFACE, providerColor } from "../../theme.js";
import { useHover } from "../../hooks/useHover.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { SearchField } from "../../ui/searchfield.js";
import { ListEditor, type Screen } from "../settings/listeditor.js";
import { TextField } from "../settings/textfield.js";
import type { useSettings } from "../settings/useSettings.js";
import { ExperienceField } from "./field.js";
import { MemoryRuntimePanel, useMemoryRuntime } from "../memory/memoryruntime.js";

export const GUIDE_STEPS = ["guide.welcome", "guide.appearance", "guide.provider", "guide.memory", "guide.tools", "guide.project"] as const;
const DESCRIPTIONS = ["guide.welcomeBody", "guide.appearanceBody", "guide.providerBody", "guide.memoryBody", "guide.toolsBody", "guide.projectBody"] as const;
type GuideSettings = Pick<ReturnType<typeof useSettings>, "snapshot" | "saving" | "error" | "set" | "duplicate" | "run" | "test" | "testMcp" | "probe" | "discover" | "exportProfile" | "importProfile" | "notice">;
interface Control { run: () => void; move?: (delta: number) => void; pane?: "providers" | "models" }

export function OnboardingPage({
  step, onStep, settings, providers, selection, projects, projectId, client, remote = false,
  error, saving, motion, screenWidth, screenHeight, onMemory, onModel, onProject, onRefresh, onComplete, onClose,
}: {
  step: number; onStep: (step: number) => void; settings: GuideSettings;
  providers: QueryResult<"providers.list">["providers"] | null;
  selection: ModelSelection | null; projects: readonly ProjectEnvelope[]; projectId: string | null;
  client: ClientApi; remote?: boolean; error: string | null; saving: boolean;
  motion: "animated" | "static" | "off"; screenWidth: number; screenHeight: number;
  onMemory: (choice: "off" | "plain" | "embeddings") => void;
  onModel: (selection: ModelSelection) => void; onProject: (id: string) => void;
  onRefresh: () => void; onComplete: () => void; onClose: () => void;
}) {
  const [focus, setFocus] = useState(0);
  const [list, setList] = useState<"mcpServers" | "providers.harness.profiles" | null>(null);
  const [screen, setScreen] = useState<Screen>({ profile: null, model: null });
  const [heading, setHeading] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(selection?.instanceId ?? null);
  const [providerQuery, setProviderQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [searching, setSearching] = useState<"providers" | "models" | null>(null);
  const [folder, setFolder] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const providerScroll = useRef<ScrollBoxRenderable | null>(null);
  const modelScroll = useRef<ScrollBoxRenderable | null>(null);
  const bodyRef = useRef<BoxRenderable | null>(null);
  // The panes take whatever height the body has left once the description and
  // the connect row are paid for; measured, because the frame is capped and
  // the terminal can be shorter than it.
  const [bodyHeight, setBodyHeight] = useState(0);
  const controls: Control[] = [];
  const disabled = saving || settings.saving !== null || addingProject;
  const memoryStatus = useMemoryRuntime(client, step === 3);

  // One framed surface floats on the field: the animation only lives in the
  // margin, and no text ever sits on top of it. It stays close to the size of
  // the Settings panel rather than filling the terminal.
  const width = Math.min(108, Math.max(0, screenWidth - 10));
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const height = Math.min(34, Math.max(0, screenHeight - 2));
  const top = Math.max(0, Math.floor((screenHeight - height) / 2));
  const showRail = width >= 104 && height >= 22;
  const railWidth = showRail ? 24 : 0;
  const gap = showRail ? 3 : 0;
  const inner = Math.max(0, width - 6 - railWidth - gap);
  const rule = "─".repeat(Math.max(0, width - 6));
  // The key legend is the first thing to go: it must still leave room for
  // "Later", "Back" and the primary action beside it.
  const footerLabel = t(step === GUIDE_STEPS.length - 1 ? "guide.finish" : "guide.next");
  const showKeys = inner >= textWidth(`${t("guide.later")} ${t("guide.pageKeys")} ${t("guide.back")} ${footerLabel}`) + 8;

  const currentProvider = providers?.find((provider) => provider.instanceId === providerId) ?? providers?.find((provider) => provider.enabled && provider.installed) ?? providers?.[0];
  useEffect(() => { if (providerId === null && selection) setProviderId(selection.instanceId); }, [providerId, selection]);
  const localized = localizeSnapshot(settings.snapshot);
  const view = (key: string) => localized?.settings.find((entry) => entry.descriptor.key === key);
  const value = (key: string) => view(key)?.value ?? view(key)?.descriptor.defaultValue;
  const memory = value("memory") === false ? 0 : settings.saving === "memoryEmbeddings" || value("memoryEmbeddings") === true ? 2 : 1;
  const showMemorySetup = memory === 2 || memoryStatus?.busy === true || memoryStatus?.state === "failed";
  const memoryValues = ["off", "plain", "embeddings"] as const;
  const memoryLabels = [t("guide.memoryOff"), t("guide.memoryPlain"), t("guide.embeddingsShort")];
  const memoryBodies = [t("guide.memoryOffBody"), t("guide.memoryPlainBody"), t("guide.memoryEmbeddingsBody")];
  const memoryTones = [COLOR.dim, COLOR.added, MODE_COLOR.research];
  const stageInk = [COLOR.accent, COLOR.user, COLOR.agent, MODE_COLOR.research, COLOR.added, COLOR.tool][step] ?? COLOR.accent;
  const changeStep = (next: number) => { if (!disabled) { setList(null); setFolder(false); setSearching(null); setLocalError(null); onStep(next); } };
  const next = () => { if (step === GUIDE_STEPS.length - 1) onComplete(); else changeStep(step + 1); };
  const openList = (key: typeof list) => { setScreen({ profile: null, model: null }); setHeading(null); setList(key); };
  const closeList = () => { setList(null); onRefresh(); };
  useEffect(() => { setFocus(0); scroll.current?.scrollTo(0); providerScroll.current?.scrollTo(0); modelScroll.current?.scrollTo(0); }, [step, list]);
  useEffect(() => {
    if (list || folder) return;
    // Bring the focused control into view in the pane that owns it, without
    // moving the fixed navigation/footer or the other pane.
    const pane = controls[focus]?.pane;
    const paneScroll = pane === "providers" ? providerScroll.current : pane === "models" ? modelScroll.current : null;
    if (paneScroll !== null) paneScroll.scrollChildIntoView(`guide-control-${focus}`);
    else scroll.current?.scrollChildIntoView(`guide-control-${focus}`);
  }, [focus, list, folder, step]);
  useEffect(() => {
    if (step !== 3 || !showMemorySetup) return;
    // Setup adds measured results and actions below the choices. Bring the
    // whole panel into view when its phase changes, so Cancel never sits
    // below the fold while the controls above it are disabled.
    const timer = setTimeout(() => scroll.current?.scrollChildIntoView("guide-memory-setup"), 0);
    return () => clearTimeout(timer);
  }, [step, showMemorySetup, settings.saving, memoryStatus?.phase, memoryStatus?.busy, memoryStatus?.validation?.checkedAt]);
  useKeyboard((key) => {
    if (list !== null) return; // The embedded editor owns its keys; it never replaces this page.
    if (folder) { if (key.name === "escape" && !disabled) setFolder(false); return; }
    if (searching !== null) {
      const setQuery = searching === "providers" ? setProviderQuery : setModelQuery;
      if (key.name === "escape" || key.name === "return" || key.name === "tab") setSearching(null);
      else if (key.name === "backspace") setQuery((text) => text.slice(0, -1));
      else if (key.ctrl && key.name === "u") setQuery("");
      else if (!key.ctrl && !key.meta && key.sequence && !key.sequence.startsWith("\x1b")) setQuery((text) => text + key.sequence);
      return;
    }
    if (disabled) return;
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) { onClose(); return; }
    if (key.name === "tab" || key.name === "down" || key.name === "up") {
      const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1;
      setFocus((at) => (at + delta + controls.length) % controls.length);
    }
    if (key.name === "return") controls[Math.min(focus, controls.length - 1)]?.run();
    if (key.name === "left" || key.name === "right") controls[focus]?.move?.(key.name === "left" ? -1 : 1);
    if (key.name === "]" && step < GUIDE_STEPS.length - 1) next();
    if (key.name === "[" && step > 0) changeStep(step - 1);
  });
  const button = (label: string, run: () => void, options: { chosen?: boolean; tone?: string; detail?: string; width?: number } = {}) => {
    const at = controls.push({ run }) - 1;
    return <GuideChoice key={label} id={`guide-control-${at}`} label={label} detail={options.detail} choice={options.chosen !== undefined} chosen={options.chosen ?? false} active={focus === at} tone={options.tone ?? COLOR.accent} width={options.width ?? inner} onPick={() => { setFocus(at); if (!disabled) run(); }} />;
  };
  const enumControl = (key: string): ReactNode => {
    const entry = view(key);
    if (entry?.descriptor.kind.type !== "enum") return null;
    const choices = entry.descriptor.kind.choices;
    const chosen = Math.max(0, choices.findIndex((choice) => choice.value === value(key)));
    const pick = (at: number) => { if (!disabled) void settings.set(key, choices[at]!.value); };
    const at = controls.push({ run: () => pick(chosen), move: (delta) => pick((chosen + delta + choices.length) % choices.length) }) - 1;
    return <box key={key} id={`guide-control-${at}`} style={{ flexDirection: "column", marginBottom: 2, flexShrink: 0, paddingLeft: 1, border: ["left"] }}
      borderColor={focus === at ? COLOR.accent : SURFACE.panel}>
      <text fg={focus === at ? COLOR.bright : COLOR.dim} attributes={focus === at ? TextAttributes.BOLD : TextAttributes.NONE}>{tx(entry.descriptor.label)}</text>
      <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 1, marginTop: 1 }}>
        {choices.map((choice, index) => <HoverButton key={choice.value} label={` ${index === chosen ? "●" : "○"} ${tx(choice.label)} `}
          fg={index === chosen ? SURFACE.base : COLOR.text}
          bg={index === chosen ? COLOR.accent : SURFACE.raised}
          hoverBg={index === chosen ? COLOR.bright : SURFACE.hover}
          onClick={() => { setFocus(at); pick(index); }} />)}
      </box>
    </box>;
  };
  const addFolder = async (text: string) => {
    if (disabled || !text.trim()) return;
    if (remote && !path.posix.isAbsolute(text) && !path.win32.isAbsolute(text)) { setLocalError(t("thread.enterServerPath")); return; }
    setAddingProject(true); setLocalError(null);
    try {
      const result = await client.dispatch({ type: "project.ensure", cwd: remote ? text.trim() : path.resolve(expandHome(text.trim())), projectPolicy: "create" });
      onProject(result.project.id); setFolder(false);
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAddingProject(false); }
  };
  const listView = list === null ? null : view(list);
  const entries = providers ?? [];
  const providerWidth = Math.min(30, Math.max(20, Math.floor(inner * 0.3)));
  const twoPane = inner >= 70;
  const modelWidth = twoPane ? inner - providerWidth - 2 : inner;
  // The panes fit without a page scroll only when there is room below them for
  // the connect row and its status; shorter terminals keep one page scroll.
  const panned = height >= 28;
  const showHint = bodyHeight >= 19;
  const paneBudget = Math.max(5, Math.min(10, bodyHeight - (showHint ? 11 : 10)));
  useEffect(() => {
    if (!panned) return;
    // The box is laid out after this render, so read its size on the next turn.
    const timer = setTimeout(() => {
      const node = bodyRef.current;
      if (node === null) return;
      setBodyHeight((previous) => previous === node.height ? previous : node.height);
    }, 0);
    return () => clearTimeout(timer);
  });
  const providerMatches = entries.filter((provider) => `${provider.displayName ?? ""} ${provider.instanceId} ${provider.driver}`.toLowerCase().includes(providerQuery.toLowerCase()));
  const models = (currentProvider?.models ?? []).filter((model) => !model.isHidden && `${model.name} ${model.slug}`.toLowerCase().includes(modelQuery.toLowerCase()));
  // As tall as the longer list needs, within the room the body has: a short
  // list does not reserve empty rows, a long one scrolls.
  const listRows = Math.max(1, Math.min(paneBudget - 3, Math.max(providerMatches.length, models.length)));
  const paneRows = listRows + 3;
  const providerStatus = currentProvider
    ? [currentProvider.installed ? t("guide.cliDetected") : t("guide.cliMissing"), tx(currentProvider.status ?? ""), tx(currentProvider.authStatus ?? "")].filter((part) => part !== "").join("  ·  ")
    : t("guide.noModel");
  const providerRow = (provider: (typeof entries)[number]) => {
    const at = controls.push({ run: () => { setProviderId(provider.instanceId); setModelQuery(""); }, pane: "providers" }) - 1;
    return <GuideChoice key={provider.instanceId} id={`guide-control-${at}`} label={provider.displayName ?? provider.instanceId} detail={undefined} choice chosen={provider.instanceId === currentProvider?.instanceId}
      active={focus === at} tone={providerColor(provider.driver, provider.instanceId, "") ?? COLOR.accent} width={providerWidth}
      onPick={() => { setFocus(at); setProviderId(provider.instanceId); setModelQuery(""); }} />;
  };
  const modelRow = (model: NonNullable<typeof currentProvider>["models"][number]) => {
    const at = controls.push({ run: () => { if (currentProvider?.installed && currentProvider.enabled) onModel({ instanceId: currentProvider.instanceId, model: model.slug }); }, pane: "models" }) - 1;
    return <GuideChoice key={model.slug} id={`guide-control-${at}`} label={model.name ?? model.slug} detail={undefined} choice
      chosen={selection?.instanceId === currentProvider?.instanceId && selection?.model === model.slug} active={focus === at}
      tone={providerColor(currentProvider?.driver, currentProvider?.instanceId, model.name ?? model.slug) ?? COLOR.accent} width={modelWidth}
      onPick={() => { setFocus(at); if (currentProvider?.installed && currentProvider?.enabled) onModel({ instanceId: currentProvider.instanceId, model: model.slug }); }} />;
  };
  const searchControl = (pane: "providers" | "models") => {
    const at = controls.push({ run: () => setSearching(pane), pane }) - 1;
    return <box id={`guide-control-${at}`} style={{ marginBottom: 1, flexShrink: 0, border: ["left"] }}
      borderColor={focus === at ? COLOR.accent : SURFACE.panel}><SearchField query={pane === "providers" ? providerQuery : modelQuery} active={searching === pane}
        placeholder={t(pane === "providers" ? "guide.searchProviders" : "guide.searchModels")} marginTop={0}
        onClick={() => { setFocus(at); setSearching(pane); }} /></box>;
  };
  const refreshControl = () => {
    const at = controls.push({ run: onRefresh }) - 1;
    return <box id={`guide-control-${at}`} style={{ height: 1, flexShrink: 0 }}>
      <HoverButton label={`↻  ${t("guide.refreshProviders")}`} width={inner} fg={focus === at ? COLOR.bright : COLOR.accent} bg={focus === at ? SURFACE.hover : SURFACE.panel} hoverBg={SURFACE.hover} onClick={() => { setFocus(at); onRefresh(); }} />
    </box>;
  };
  const providersPane = (paneWidth: number, rows: number) => <box style={{ width: paneWidth, ...(panned ? { height: rows } : {}), flexDirection: "column", flexShrink: 0 }}>
    <text fg={COLOR.dim} style={{ flexShrink: 0 }}>{`${t("guide.providersLabel")}  ·  ${providerMatches.length}`}</text>
    {searchControl("providers")}
    {panned
      ? <scrollbox ref={providerScroll} style={{ height: Math.max(1, rows - 3) }} contentOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
        {providerMatches.length === 0 ? <text fg={COLOR.dim}>{t("guide.noProvidersMatch")}</text> : null}
        {providerMatches.map(providerRow)}
      </scrollbox>
      : <box style={{ flexDirection: "column", flexShrink: 0 }}>
        {providerMatches.length === 0 ? <text fg={COLOR.dim}>{t("guide.noProvidersMatch")}</text> : null}
        {providerMatches.map(providerRow)}
      </box>}
  </box>;
  const modelsPane = (paneWidth: number, rows: number) => <box style={{ width: paneWidth, ...(panned ? { height: rows } : {}), flexDirection: "column", flexShrink: 0 }}>
    <text fg={COLOR.dim} style={{ flexShrink: 0 }}>{`${t("guide.modelsNav")}  ·  ${models.length}`}</text>
    {searchControl("models")}
    {panned
      ? <scrollbox ref={modelScroll} style={{ height: Math.max(1, rows - 3) }} contentOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
        {models.length === 0 ? <text fg={COLOR.dim}>{t("guide.noModelsMatch")}</text> : null}
        {models.map(modelRow)}
      </scrollbox>
      : <box style={{ flexDirection: "column", flexShrink: 0 }}>
        {models.length === 0 ? <text fg={COLOR.dim}>{t("guide.noModelsMatch")}</text> : null}
        {models.map(modelRow)}
      </box>}
  </box>;
  const stepTwo = <>
    <text fg={COLOR.dim} style={{ marginTop: 1, marginBottom: 1, flexShrink: 0 }}>{t(DESCRIPTIONS[2]!)}</text>
    {twoPane
      ? <box style={{ flexDirection: "row", gap: 2, flexShrink: 0 }}>
        {providersPane(providerWidth, paneRows)}
        {modelsPane(modelWidth, paneRows)}
      </box>
      : <box style={{ flexDirection: "column", flexShrink: 0 }}>
        {providersPane(inner, Math.min(paneRows, 8))}
        <box style={{ height: 1, flexShrink: 0 }} />
        {modelsPane(inner, paneRows)}
      </box>}
    <box style={{ flexDirection: "column", marginTop: 1, flexShrink: 0 }}>
      {button(t("guide.addModelServer"), () => openList("providers.harness.profiles"), { detail: t("guide.addModelServerBody"), width: inner })}
      {refreshControl()}
      <text fg={COLOR.dim}>{providerStatus}</text>
      {showHint ? <text fg={COLOR.dim}>{t("guide.loginHint")}</text> : null}
    </box>
  </>;

  const content = listView && list !== null ? <>
    <ListEditor key={list} descriptor={listView.descriptor} items={listView.items ?? []} screen={screen} onScreen={setScreen}
      heading={heading} onHeading={setHeading} saving={settings.saving} onSet={settings.set}
      onDuplicate={(id, newId) => settings.duplicate(list, id, newId)} run={settings.run}
      onTest={(id, model) => list === "mcpServers" ? settings.testMcp(id) : settings.test(id, model)} onProbe={settings.probe}
      onDiscover={settings.discover} onExport={settings.exportProfile} onImport={settings.importProfile} notice={settings.notice}
      width={inner} onExit={closeList} exitLabel={t("guide.backToStep")} mcpRunner={(value("mcpRunner") ?? "npx") as "npx" | "bunx" | "pnpm" | "yarn"} />
  </> : step === 2 ? (panned
    ? <box ref={bodyRef} style={{ flexGrow: 1, flexDirection: "column", overflow: "hidden" }}>{stepTwo}</box>
    : <scrollbox ref={scroll} style={{ flexGrow: 1 }} contentOptions={{ paddingRight: 1 }}
      verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>{stepTwo}</scrollbox>)
  : <scrollbox ref={scroll} style={{ flexGrow: 1 }} contentOptions={{ paddingRight: 1 }}
    // Memory setup arrives asynchronously. Reserve its gutter from the first
    // layout so a newly visible native thumb cannot paint at the body origin.
    verticalScrollbarOptions={{ ...(step === 3 ? { visible: true } : {}), showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
    <text fg={COLOR.dim} style={{ marginTop: 1, marginBottom: 1, flexShrink: 0 }}>{t(DESCRIPTIONS[step]!)}</text>
    {step === 0 ? <>
      <text fg={COLOR.text} style={{ marginBottom: 2 }}>{t("guide.welcomeDetail")}</text>
      {([["guide.previewAppearance", COLOR.accent], ["guide.previewMemory", MODE_COLOR.research], ["guide.previewTools", COLOR.added]] as const).map(([key, tone]) => <box key={key} style={{ flexDirection: "row", height: 1, flexShrink: 0, gap: 2, marginBottom: 1 }}>
        <text fg={tone}>{"✦"}</text><text fg={COLOR.text}>{t(key as "guide.previewAppearance")}</text>
      </box>)}
    </> : null}
    {step === 1 ? <>
      {["ui.theme", "ui.backdrop", "ui.language"].map(enumControl)}
      <text fg={COLOR.dim}>{t("guide.selectControl")}</text>
    </> : null}
    {step === 3 ? <>
      <text fg={COLOR.dim} style={{ marginBottom: 2 }}>{t("guide.memoryMode")}</text>
      {memoryLabels.map((label, index) => {
        const at = controls.push({ run: () => { if (!disabled) onMemory(memoryValues[index]!); } }) - 1;
        return <GuideChoice key={label} id={`guide-control-${at}`} label={label} detail={memoryBodies[index]}
          choice chosen={memory === index} active={focus === at} tone={memoryTones[index] ?? COLOR.accent} width={inner - 1} detailRows={2} inset={0}
          onPick={() => { setFocus(at); if (!disabled) onMemory(memoryValues[index]!); }} />;
      })}
      {showMemorySetup ? <box id="guide-memory-setup" style={{ flexDirection: "column", flexShrink: 0 }}><MemoryRuntimePanel status={memoryStatus} saving={settings.saving === "memoryEmbeddings"}
        onSetup={() => onMemory("embeddings")} onKeyword={() => onMemory("plain")}
        onCancel={() => { void client.dispatch({ type: "memory.embeddings.unload" }); }} /></box> : null}
      <text fg={COLOR.dim} style={{ marginTop: 1 }}>{t("guide.memoryControl")}</text>
    </> : null}
    {step === 4 ? <>
      <text fg={COLOR.dim} style={{ marginBottom: 2 }}>{t("guide.mcpExamples")}</text>
      {(view("mcpServers")?.items ?? []).map((server) => button(server.id, () => { setScreen({ profile: server.id, model: null }); setList("mcpServers"); }, { chosen: true, tone: COLOR.added, detail: t("guide.connectedConfig") }))}
      {button(t("guide.addMcp"), () => openList("mcpServers"), { detail: t("guide.mcpInline") })}
      <text fg={COLOR.dim} style={{ marginTop: 1 }}>{t("guide.optionalTools")}</text>
    </> : null}
    {step === 5 ? <>
      {button(t("guide.noProjectChoice"), () => onProject("__no-project__"), { chosen: projectId === "__no-project__", detail: t("guide.scratchProject") })}
      {projects.filter((project) => !project.scratch).map((project) => button(String(project.title), () => onProject(project.id), { chosen: projectId === project.id, detail: String(project.workspaceRoot ?? "") }))}
      {folder ? <box style={{ flexDirection: "column", marginTop: 1 }}>
        <text fg={COLOR.bright}>{t("guide.folderPrompt")}</text>
        <TextField initial="" placeholder={t("guide.folderPrompt")} width={inner} onSubmit={(text) => { void addFolder(text); }} />
        <HoverButton label={t("guide.cancelFolder")} fg={COLOR.dim} onClick={() => setFolder(false)} />
      </box> : button(t("guide.addFolder"), () => setFolder(true))}
      <text fg={COLOR.dim} style={{ marginTop: 1 }}>{t("guide.readySummary", { model: selection?.model ?? t("guide.noModel"), memory: memoryLabels[memory]! })}</text>
    </> : null}
  </scrollbox>;
  const backIndex = step > 0 ? controls.push({ run: () => changeStep(step - 1) }) - 1 : -1;
  const nextIndex = controls.push({ run: next }) - 1;
  const laterIndex = controls.push({ run: onClose }) - 1;

  return <box style={{ width: screenWidth, height: screenHeight, flexDirection: "column" }} backgroundColor={SURFACE.base}>
    <ExperienceField width={screenWidth} height={screenHeight} stage={step} motion={motion} ink={stageInk} />
    <box border borderStyle="rounded" borderColor={SURFACE.border} backgroundColor={SURFACE.panel}
      style={{ position: "absolute", left, top, width, height, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, zIndex: 1 }}>
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1, flexShrink: 0 }}>
        <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{t("guide.pageBrand")}</text>
        <text fg={COLOR.dim}>{t("guide.stepCount", { n: step + 1, total: GUIDE_STEPS.length })}</text>
      </box>
      <text fg={SURFACE.border} style={{ marginTop: 1, flexShrink: 0 }}>{rule}</text>
      <box style={{ flexDirection: "row", flexGrow: 1, marginTop: 1, marginBottom: 1, gap }}>
        {showRail ? <box style={{ width: railWidth, flexDirection: "column", paddingRight: 2, border: ["right"], borderColor: SURFACE.border, flexShrink: 0 }}>
          <text fg={COLOR.dim} style={{ marginBottom: 2 }}>{t("guide.yourWorkspace")}</text>
          {GUIDE_STEPS.map((key, index) => <box key={key} style={{ height: 1, marginBottom: 1, flexShrink: 0 }}>
            <HoverButton label={`${index < step ? "✓" : String(index + 1).padStart(2, "0")}  ${t(key === "guide.provider" ? "guide.modelsNav" : key === "guide.memory" ? "guide.memoryPlain" : key === "guide.project" ? "guide.projectNav" : key === "guide.appearance" ? "guide.appearanceNav" : key === "guide.tools" ? "guide.toolsNav" : "guide.welcomeNav")}`} width={railWidth - 3} fg={index === step ? COLOR.accent : index < step ? COLOR.added : COLOR.dim} bg={index === step ? SURFACE.hover : SURFACE.panel} onClick={() => changeStep(index)} />
          </box>)}
          <box style={{ flexGrow: 1 }} />
          <text fg={COLOR.dim}>{t("guide.changesSaved")}</text>
        </box> : null}
        <box style={{ flexGrow: 1, flexDirection: "column", overflow: "hidden" }}>
          <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{t(GUIDE_STEPS[step]!)}</text>
          {content}
          {localError || error || settings.error ? <text fg={COLOR.danger} style={{ flexShrink: 0 }}>{localError ?? error ?? settings.error}</text> : null}
          {disabled ? <text fg={COLOR.dim} style={{ flexShrink: 0 }}>{t("guide.saving")}</text> : null}
        </box>
      </box>
      <text fg={SURFACE.border} style={{ flexShrink: 0 }}>{rule}</text>
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1, flexShrink: 0, marginTop: 1 }}>
        <HoverButton label={t("guide.later")} fg={focus === laterIndex ? COLOR.accent : COLOR.dim} {...(focus === laterIndex ? { bg: SURFACE.hover } : {})} onClick={() => { if (!disabled) onClose(); }} />
        {list === null && showKeys ? <text fg={COLOR.dim}>{t("guide.pageKeys")}</text> : <box />}
        <box style={{ flexDirection: "row", gap: 3 }}>
          {step > 0 ? <HoverButton label={t("guide.back")} fg={focus === backIndex ? COLOR.accent : COLOR.dim} {...(focus === backIndex ? { bg: SURFACE.hover } : {})} onClick={() => changeStep(step - 1)} /> : null}
          <HoverButton label={` ${footerLabel}  → `} fg={SURFACE.base} bg={focus === nextIndex ? COLOR.bright : COLOR.accent} hoverBg={COLOR.bright} onClick={() => { if (!disabled) next(); }} />
        </box>
      </box>
    </box>
  </box>;
}

function GuideChoice({ id, label, detail, tag, active, choice, chosen, tone, width, detailRows, inset = 1, onPick }: { id: string; label: string; detail: string | undefined; tag?: string | undefined; active: boolean; choice: boolean; chosen: boolean; tone: string; width: number; detailRows?: number; inset?: number; onPick: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active || hovered ? SURFACE.hover : chosen ? SURFACE.raised : SURFACE.panel;
  return <box id={id} style={{ flexDirection: "column", width, marginLeft: 1 - inset, paddingLeft: inset, paddingRight: 1, flexShrink: 0, overflow: "hidden", border: ["left"], marginBottom: detail ? 1 : 0 }}
    borderColor={active ? COLOR.accent : chosen ? inset === 0 ? tone : SURFACE.raised : SURFACE.panel}
    backgroundColor={bg} onMouseDown={onPick} selectable={false} {...handlers}>
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <text fg={chosen ? tone : active || hovered ? COLOR.bright : COLOR.text} bg={bg} wrapMode="none" selectable={false}
        attributes={active ? TextAttributes.BOLD : TextAttributes.NONE}>{`${choice ? chosen ? "●" : "○" : "›"}  ${label}`}</text>
      {tag === undefined ? null : <text fg={COLOR.dim} bg={bg} wrapMode="none" selectable={false}>{`  ·  ${tag}`}</text>}
    </box>
    {detail ? <text fg={COLOR.dim} bg={bg} selectable={false} style={{ paddingLeft: 3, maxHeight: 2, ...(detailRows === undefined ? {} : { minHeight: detailRows }) }}>{detail}</text> : null}
  </box>;
}

import { sessionStatusLabel } from "../i18n/status.js";
import { applyLanguage, currentLanguage, t, tx } from "../i18n/index.js";
import os from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";

import { applyShellFrame, emptyShellState, threadStatus, visibleThreads, type ShellState } from "../model/shell.js";
import { Timeline } from "../features/timeline/timeline.js";
import { DiffPanel } from "../features/diffpanel/diffpanel.js";
import { Composer } from "../features/composer/composer.js";
import { useSkillInventory } from "../features/composer/useSkillInventory.js";
import { useInteractionMode } from "../features/composer/useInteractionMode.js";
import { pickerEntries } from "../model/skills.js";
import { TasksPanel } from "../features/taskspanel/taskspanel.js";
import { BackgroundTasksModal } from "../features/taskspanel/backgroundtasksmodal.js";
import { SettingsModal } from "../features/settings/settingsmodal.js";
import { StatsModal } from "../features/stats/statsmodal.js";
import { GitFooter, GitTab } from "../features/gitpanel/gitpanel.js";
import type { ActiveServer } from "../features/remote/server.js";
import { useRemote } from "../features/remote/useRemote.js";
import type { PairedServers } from "../../server/transport/servers.js";
import { devicesBody, remotePaletteSection, serversBody } from "../features/remote/palette.js";
import { useReconnects, useServerLink } from "../features/remote/useServerLink.js";
import { linkNoticeText } from "../features/remote/linkNotice.js";
import { PAIRING_PANEL_HEIGHT, PairingCodeModal } from "../features/remote/codemodal.js";
import { SubagentBar } from "../features/subagentview/subagentbar.js";
import { describeScheduled } from "../model/schedule.js";
import { subagentRun, subagentState, subagentTitle, useSubagentView } from "../features/subagentview/useSubagentView.js";
import { useGitPanel } from "../features/gitpanel/useGitPanel.js";
import { useProviderVersions } from "../features/settings/useProviderVersions.js";
import { longThreadConfigFromSnapshot, uiFromSnapshot, useSettings } from "../features/settings/useSettings.js";
import { PickerModal, type PickerBody, type PickerSlider } from "../features/pickers/pickermodal.js";
import { useThreadSearch } from "../features/search/useThreadSearch.js";
import { useSidebarSearch } from "../features/sidebar/useSidebarSearch.js";
import { DateTimeModal } from "../ui/datetimemodal.js";
import { ModalShell } from "../ui/modalshell.js";
import { RenameModal } from "../ui/renamemodal.js";
import { AnswerPanel } from "../features/answerpanel/answerpanel.js";
import { PermissionPanel } from "../features/permissionpanel/permissionpanel.js";
import { usePermissionFlow } from "../features/permissionpanel/usePermissionFlow.js";
import { dispatchErrorMessage } from "../../core/errors.js";
import type { LongThreadsConfig, ModelSelection, ProvidersConfig, RuntimeMode, UiConfig } from "../../core/types.js";
import { compatibleRuntimeMode } from "../../core/catalog/permissions.js";
import { offerableModels, offerableProviders } from "../../core/catalog/summary.js";
import {
  attachmentFromBytes,
  buildImageAttachments,
  extractMentions,
  IMAGE_LIMITS,
  imageSetError,
  MAX_PENDING_ATTACHMENTS,
} from "../../core/attachments.js";
import type { ImageAttachmentUpload } from "../../core/attachments.js";
import { clipboardFileName } from "../model/hostClipboard.js";
import { defaultEffortId, describeEffort, isEffortDescriptor, modelRowDetail, turnModelSelection } from "../model/display.js";
import { configuredDefaultModel } from "../model/settings.js";
import { formatContextUsage, formatTokenCount, groupTurns } from "../model/turns.js";
import { waitSpans } from "../model/waits.js";
import { markModalDismissed } from "../model/modalDismiss.js";
import { setPathRoots } from "../model/activity.js";
import { Sidebar } from "../features/sidebar/sidebar.js";
import { sceneForModel } from "../ui/scenes/catalog.js";
import { SceneBackdrop } from "../ui/scenes/scenebackdrop.js";
import { LoadingScreen } from "../ui/loadingscreen.js";
import { bootLoadingStage, isBootReady } from "../model/readiness.js";
import { HoverButton } from "../ui/hoverbutton.js";
import { openExternal } from "../../core/infra/platformOpen.js";
import { formatDuration } from "../model/turns.js";
import { autoHandoffState, compactsFirst, lineInput, longThreadPolicy, type LongThreadConfig } from "../model/autohandoff.js";
import { handOffTarget, openRequestPrompt, requestNoun } from "../model/gitpanel.js";
import { renderMessage } from "../model/message.js";
import { copiedAttachments, copiedToast, copyPrompt, matchCopy, uniqueName } from "../model/copystash.js";

import { applyTheme, COLOR, MARKER, pulseColor, SPINNER, SURFACE, truncate } from "../theme.js";
import { useToasts, type ToastTone } from "../hooks/useToasts.js";
import { useClipboard } from "../hooks/useClipboard.js";
import { useTerminalNotify } from "../hooks/useTerminalNotify.js";
import { readPastedImage, type TerminalClipboardDeps } from "../model/terminalClipboard.js";
import { useHover } from "../hooks/useHover.js";
import {
  applyThreadFrame,
  backgroundSummaryLabel,
  backgroundTaskTitle,
  emptyThreadState,
  latestPlan,
  pendingUserInputRequests,
  promptSuggestion,
  timeline,
  untilLabel,
  resumeCompactionKey,
  shouldOfferResumeCompaction,
  type BackgroundTaskRow,
  type ThreadState,
  type TimelineEntry,
} from "../model/thread.js";
import {
  CHAT_GUTTER,
  COPY_TOAST_MS,
  CTRL_C_WINDOW_MS,
  ERROR_DISPLAY_MS,
  SIDEBAR_WIDTH,
  TOAST_COLOR,
  TOAST_INSET,
  TOAST_STEP,
  SCHEDULE_PANEL_HEIGHT,
} from "./constants.js";
import { clock, launchTarget, scrollPane } from "./utils.js";
import { useTasksPanel } from "../features/taskspanel/useTasksPanel.js";
import { useProviderUpdates } from "./hooks/useProviderUpdates.js";
import { useQuitConfirm } from "./hooks/useQuitConfirm.js";
import { useUsageLimitBanner } from "./hooks/useUsageLimitBanner.js";
import { useNoticePager } from "./hooks/useNoticePager.js";
import { NoticeBanner, Pager, type Notice } from "../ui/noticebanner.js";
import { QueuedPanel } from "../features/queuedpanel/queuedpanel.js";
import { SideQuestionModal } from "../features/btw/sidequestionmodal.js";
import { parseSideQuestion, useSideQuestion } from "../features/btw/useSideQuestion.js";
import { useQueuedPanel } from "../features/queuedpanel/useQueuedPanel.js";
import { useThreadNotifications } from "./hooks/useThreadNotifications.js";
import { useAnswerFlow } from "../features/answerpanel/useAnswerFlow.js";
import { useSidebar } from "../features/sidebar/useSidebar.js";
import { useDiffPanel } from "../features/diffpanel/useDiffPanel.js";
import { ActionText, AgentsTab, BackgroundTab, InfoTab, type DelegatedInfo, ContextTab, DiffEmptyTab, SidePanelFrame, SideTabBar, tabLabel } from "../features/sidepanel/sidepanel.js";
import { ImagePreviewLayer } from "../features/timeline/imagepreview.js";
import { closeImageViewer, ImageViewer, ImageViewerDim, useImageViewer } from "../features/timeline/imageviewer.js";
import { openImageExternally } from "../model/imageopen.js";
import { shrinkImage } from "../model/imageshrink.js";
import { useTerminalVisible } from "../hooks/useTerminalVisible.js";
import { useContextBreakdown, usePlanUsage, useSidePanel } from "../features/sidepanel/useSidePanel.js";
import { agentThreads, effectiveContextBreakdown, nativeSubagents, planUsageGauges, type SideTab } from "../model/sidepanel.js";
import { useComposer } from "../features/composer/useComposer.js";
import { useProviderCatalog } from "../features/pickers/useProviderCatalog.js";
import { NO_PROJECT, useThreadCreation } from "./hooks/useThreadCreation.js";
import { useThreadExport } from "./hooks/useThreadExport.js";
import { useStatsCard } from "./hooks/useStatsCard.js";
import { useThreadOps, type RevertKind } from "./hooks/useThreadOps.js";
import type { PickerName } from "../features/pickers/pickerTypes.js";
import type { ClientApi } from "../../server/api.js";


/** A path as the user would type it: their home directory as `~`. */
function withHomeAsTilde(target: string | null): string | null {
  const home = process.env.HOME;
  if (target === null || !home || home === "/") return target;
  return target === home ? "~" : target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

export function App({
  client,
  onQuit,
  homeDir,
  cwd,
  launchView,
  setTerminalTitle,
  server = null,
  onSwitchServer,
  pairedServers,
  ui: launchUi,
  providers: launchProviders,
  longThreads: launchLongThreads,
}: {
  client: ClientApi;
  onQuit: () => void;
  homeDir?: string;
  /** Resolves relative `@path` mentions. Defaults to the launch directory. */
  cwd?: string;
  /**
   * Production always launches into the new-thread view; the render check
   * passes `"thread"` so its frames keep covering the transcript.
   */
  launchView?: "create" | "thread";
  /** Wired to the renderer's own terminal-title API; omitted in tests. */
  setTerminalTitle?: (title: string) => void;
  /**
   * Presentation settings (`ui.*`), read once at launch. These change how
   * the app draws rather than what it does, so unlike the rest of the
   * config they are not re-read per operation — a restart applies them.
   */
  ui?: UiConfig;
  /** The providers' own settings at launch: only their long-thread keys are read, until the settings page loads a fresher snapshot. */
  providers?: ProvidersConfig;
  /** The global hand-off and compaction lines at launch, read the same way. */
  longThreads?: LongThreadsConfig;
  /** The paired server on another machine `client` talks to; null for this machine's. */
  server?: ActiveServer | null;
  /**
   * Reconnect the whole app to another server (a paired one by name, or null
   * for this machine's). Rejects, leaving this one in place, when it cannot
   * be reached. Omitted in tests, where switching is not offered.
   */
  onSwitchServer?: (target: string | null) => Promise<void>;
  /** Tests: the list of paired servers; this machine's by default. */
  pairedServers?: PairedServers;
}) {
  /** Folders and files named by the server are its machine's, not this one's. */
  const remote = server !== null;
  const { width, height } = useTerminalDimensions();
  const [shell, setShell] = useState<ShellState>(emptyShellState);
  const [threadState, setThreadState] = useState<ThreadState>(emptyThreadState);
  const { plan, background, tasksVisibleNow, toggleTasksVisible } = useTasksPanel(threadState);
  /** `search` is the sidebar's search field, which takes typed keys while it holds focus. */
  const [focus, setFocus] = useState<"chat" | "composer" | "diff" | "search">("chat");
  const toasts = useToasts();
  /** Kept as the one call every existing error path already used; now routes
      through `toasts` instead of its own state + timeout effect. */
  const setError = (message: string) => toasts.push("error", "danger", t("toast.error", { message }), ERROR_DISPLAY_MS);
  /** The palette's Remote section: this server's remote access, and switching between servers. */
  // Whether the server is answering, and how many times it has come back:
  // what was fetched once is fetched again then (the server may be a new one).
  const serverLink = useServerLink(client);
  const reconnects = useReconnects(serverLink);
  const remoteAccess = useRemote({ client, server, onSwitchServer, push: toasts.push, ...(pairedServers ? { pairedServers } : {}) });
  /** Composer is drafting the first message of a new thread, not a reply. */
  const [creating, setCreating] = useState(launchView !== "thread");
  /** Overrides the model the new thread inherits from its source once the
      user picks a different one while creating — `null` means "still
      inheriting". Picking a model/effort during `creating` must land here,
      never dispatch `thread.model-selection.set` against the still-open
      source thread. */
  const [creatingModelSelection, setCreatingModelSelection] = useState<ModelSelection | null>(null);
  /**
   * Overrides the permission level the new thread starts with once the user
   * picks one while creating — `null` means "still inheriting" from the
   * source thread. Same rule as `creatingModelSelection`: picking during
   * `creating` lands here, never dispatches against the source thread.
   */
  const [creatingRuntimeMode, setCreatingRuntimeMode] = useState<RuntimeMode | null>(null);
  /**
   * Overrides the project the new thread lands in once the user picks a
   * different one while creating — `null` means "still inheriting" from the
   * source thread. Picked via the project picker (command palette or `[`/`]`
   * in the creating view); `createThread` reads it back on send.
   */
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const {
    sections,
    settledExpanded,
    toggleSettledExpanded,
    showMoreSettled,
    sidebarMode,
    setSidebarMode,
    cycleSidebarMode,
    toggleSidebarProject,
    cycleSidebarProject,
  } = useSidebar(shell, openThreadId, now);
  const sidebarSearch = useSidebarSearch(client, shell.threads);
  /** A sidebar row or search result: it always shows the thread itself, so the parent of an open subagent goes back to the parent. */
  const openThreadFromSidebar = (threadId: string) => {
    subagentView.close();
    setFocus("chat");
    setCreating(false);
    setPicker(null);
    setPickerFilter("");
    setOpenThreadId(threadId);
  };
  const {
    quitConfirmOpen,
    quitCancelHover,
    quitConfirmHover,
    openQuitConfirm,
    closeQuitConfirm,
    registerCtrlCPress,
  } = useQuitConfirm(setFocus);
  const [picker, setPicker] = useState<PickerName>(null);
  // Reads on open and writes through the server; see `useSettings`. The
  // snapshot outlives the page, so once it exists the app draws from it:
  // a `ui.*` edit applies on the spot instead of after a restart.
  const settings = useSettings(client, picker === "settings" || picker === "model");
  // Each provider's install on the settings page, and the updaters behind the palette rows and the page's buttons;
  // the versions are read again whenever an update ends.
  const providerVersions = useProviderVersions(client, picker === "settings");
  const providerUpdates = useProviderUpdates(client, toasts.push, providerVersions.reload);
  const ui = uiFromSnapshot(settings.snapshot) ?? launchUi;
  // Rewrites the shared palettes before any child draws; a no-op while the theme is unchanged.
  applyTheme(ui?.theme);
  applyLanguage(ui?.language);
  // The provider catalog is read again when the page closes after an edit (a Harness profile, a hidden model).
  const [settingsChanges, setSettingsChanges] = useState(0);
  const snapshotAtOpen = useRef<typeof settings.snapshot>(null);
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    const open = picker === "settings";
    if (open && !settingsWasOpen.current) snapshotAtOpen.current = settings.snapshot;
    if (!open && settingsWasOpen.current && settings.snapshot !== snapshotAtOpen.current) setSettingsChanges((count) => count + 1);
    settingsWasOpen.current = open;
  }, [picker, settings.snapshot]);
  const longThreadConfig: LongThreadConfig = longThreadConfigFromSnapshot(settings.snapshot, launchProviders?.harness?.profiles) ?? {
    ...(launchUi ? { ui: launchUi } : {}),
    ...(launchProviders ? { providers: launchProviders } : {}),
    ...(launchLongThreads ? { longThreads: launchLongThreads } : {}),
  };
  const [pickerFilter, setPickerFilter] = useState("");
  /** Where esc/backdrop returns focus after the command palette closes. */
  const [paletteReturnFocus, setPaletteReturnFocus] = useState<"chat" | "composer" | "diff">("chat");
  /** Delete-thread two-step confirm: first pick arms, second pick dispatches. */
  const [deleteArmed, setDeleteArmed] = useState(false);
  /**
   * Whether the server accepts a general `thread.delete`. Starts assumed and
   * flips permanently off for the session on the first rejection — the row
   * then renders disabled like the other unsupported actions.
   */
  const [deleteSupported, setDeleteSupported] = useState(true);
  /** The user turn the message-actions modal acts on (a PromptBlock click). */
  const [messageActionEntry, setMessageActionEntry] = useState<TimelineEntry | null>(null);
  /** Revert two-step confirm inside the message-actions modal. */
  const [revertArmed, setRevertArmed] = useState<RevertKind | false>(false);
  /** Bumped to tear down and re-establish the thread subscription for a
      fresh snapshot (our projector can't consume removal events). */
  const [threadResync, setThreadResync] = useState(0);
  /** Live thread state for delayed re-checks (answer race detection). */
  const threadStateRef = useRef(threadState);
  threadStateRef.current = threadState;
  const {
    answerDraft,
    pendingAnswerRequests,
    activeAnswerRequest,
    activeAnswerQuestion,
    answerVisible,
    resolveAnswerQuestion,
    answerCurrentQuestion,
    toggleAnswerOption,
    goToQuestion,
    dismissAnswerRequest,
  } = useAnswerFlow(client, threadState, threadStateRef, openThreadId, picker, toasts, setError);
  const { activePermission, permissionVisible, respondToPermission } = usePermissionFlow(
    client,
    threadState,
    threadStateRef,
    openThreadId,
    toasts,
    setError,
  );
  /** An agent question owns the composer slot first; a tool approval takes it once none is open. */
  const permissionShown = !answerVisible && permissionVisible;
  const requestPanelVisible = answerVisible || permissionShown;
  /** Dismissal key of the last-dismissed resume-compaction banner — a new
      context snapshot reopens it even if an earlier one was dismissed. */
  const [dismissedResumeKey, setDismissedResumeKey] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const chatScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const diffScrollRef = useRef<ScrollBoxRenderable | null>(null);
  /** Stops dispatch through one global path, but keep a dedupe window so a
      repeated stop click never double-dispatches interrupts. */
  const lastInterruptRef = useRef(0);
  /** Live read of `sessionRunning` (computed below) for picker-row callbacks,
      whose memo snapshot goes stale while the modal is open (same pattern as
      editingExternallyRef). */
  const sessionRunningRef = useRef(false);
  const clipboard = useClipboard();
  const renderer = useRenderer() as CliRenderer | null;
  const themeName = ui?.theme;
  useEffect(() => {
    renderer?.setBackgroundColor(SURFACE.base);
  }, [renderer, themeName]);
  const {
    drafts,
    pendings,
    draft,
    pending,
    editingExternally,
    editingExternallyRef,
    markedThreadIds,
    composerResetKey,
    copyDraft,
    setDraft,
    resetDraft,
    restoreDraft,
    writePending,
    setPending,
    editDraftExternally,
  } = useComposer(openThreadId, clipboard, toasts, setError, setFocus);
  /** Dedupes the "selection" event, which keeps firing while dragging and
      once more on release — only the settled, non-empty, changed text
      triggers a copy+toast. */
  const lastCopiedRef = useRef<string | null>(null);
  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const text = selection.getSelectedText();
    if (text.trim().length === 0) {
      lastCopiedRef.current = null;
      return;
    }
    if (text === lastCopiedRef.current) return;
    lastCopiedRef.current = text;
    void clipboard.copyText(text).then((ok) => {
      if (ok) toasts.push("copy-selection", "info", t("app.copied_to_clipboard_efc1"), COPY_TOAST_MS);
    });
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return client.subscribeShell(
      {},
      (item) => setShell((current) => applyShellFrame(current, item)),
      (cause) => setError(String(cause).slice(0, 120)),
    );
  }, [client]);

  // Launch always selects the latest thread; production additionally lands in
  // its new-thread view (the thread only lends its project, model, and modes
  // to the composer), while the render check's `launchView="thread"` needs
  // that same thread selected but opened on its transcript instead. This runs
  // once, so an explicit open or a sent first message always wins afterwards.
  useEffect(() => {
    if (openThreadId !== null) return;
    // Prefer the latest active thread, but fall back to the latest visible
    // thread of any status: an all-settled workspace otherwise leaves nothing
    // selected and `startNewThread` errors with "no open thread to inherit
    // the project from". (`sections.settled` is pagination-gated, so it
    // can't serve as the fallback.) The fallback thread only lends its
    // project/model/modes to the composer.
    const target = launchTarget(sections.active, visibleThreads(shell)[0]?.id ?? null);
    if (target.threadId === null) return;
    setOpenThreadId(target.threadId);
    // A thread that is working or waiting on the user is where they were: open it, not the new-thread screen.
    if (launchView === "thread" || target.transcript) return;
    setCreating(true);
    setFocus("composer");
  }, [openThreadId, sections, launchView]);

  const selected = useMemo(
    () => shell.threads.find((thread) => thread.id === openThreadId) ?? null,
    [shell.threads, openThreadId],
  );
  // Rows show paths relative to where this thread's files live. Set during
  // render (it is idempotent) so the first frame of a thread already has it.
  setPathRoots(
    [selected?.worktreePath, shell.projects.find((project) => project.id === selected?.projectId)?.workspaceRoot],
    homeDir ?? os.homedir(),
  );
  /**
   * Boot gate: the app chrome stays hidden behind `<LoadingScreen>` until the
   * shell snapshot (thread list) and the picked thread's own snapshot have
   * both landed. Latched — once true it never drops: thread switches and
   * resyncs reset `threadState.synchronized` (which correctly re-holds the
   * *transcript* placeholder below), but must never flash the whole app back
   * to the loading screen. Declared up here so the keyboard handler below
   * can swallow app bindings while booting — only the ctrl+c quit flow
   * stays live.
   */
  const [booted, setBooted] = useState(false);
  // The latch itself sits below, after the provider catalog and plan usage it waits for are read.
  const bootReady = booted;
  /** The model selection every picker/footer reads: while drafting a new
      thread this is the local override (once picked) or the source thread's
      own model, never a dispatch target. */
  const effectiveModelSelection = creating ? (creatingModelSelection ?? selected?.modelSelection) : selected?.modelSelection;
  /** The permission level a turn would run with — the local override while
      drafting, else the open thread's own mode. */
  const effectiveRuntimeMode = creating
    ? (creatingRuntimeMode ?? selected?.runtimeMode ?? null)
    : (selected?.runtimeMode ?? null);
  /**
   * The project the next thread lands in: while drafting, the local override
   * (once picked) or the source thread's own project — never dispatched
   * against anything until `createThread` sends `thread.create`.
   */
  const effectiveProjectId = creating ? (creatingProjectId ?? selected?.projectId ?? null) : (selected?.projectId ?? null);
  /** Where the skill picker asks the provider to look: the thread's worktree, else its project. */
  const skillDirectory =
    (creating ? null : (selected?.worktreePath ?? null)) ??
    shell.projects.find((project) => project.id === effectiveProjectId)?.workspaceRoot ??
    null;
  const interaction = useInteractionMode({
    client,
    selected,
    creating,
    setError,
    isRunning: () => sessionRunningRef.current,
  });
  const { inventory: skillInventory, refresh: refreshSkills } = useSkillInventory(client, effectiveModelSelection?.instanceId, skillDirectory);
  const pickerSkills = useMemo(() => pickerEntries(skillInventory), [skillInventory]);

  /** One palette copy action: missing data toasts instead of dispatching. */
  const copyPaletteText = (text: string | null, emptyMessage: string) => {
    if (text === null || text.length === 0) {
      setError(emptyMessage);
      return;
    }
    void clipboard.copyText(text).then((ok) => {
      if (ok) toasts.push("palette-copy", "info", t("app.copied_to_clipboard_efc1"), COPY_TOAST_MS);
      else if (clipboard.isRemote()) setError(t("app.copy_failed_terminal_may_6db8"));
    });
  };
  /**
   * A message, with the images it carried: the text goes to the clipboard
   * last (after each image, for clipboard histories), and pasting it back
   * into moxen attaches the images again onto its `[Image #N]` tokens.
   */
  /** A sent image's bytes by id, for the transcript thumbnails: the server holds them, which may be a paired machine. */
  const readAttachment = useCallback((attachmentId: string) => client.query({ type: "attachment.read", attachmentId }), [client]);
  const copyMessage = (entry: TimelineEntry) => {
    const rendered = entry.message === null ? { text: entry.text, images: [] } : renderMessage(entry.message);
    if (rendered.text.trim().length === 0) {
      setError(t("app.nothing_to_copy_91c1"));
      return;
    }
    // The images are the server's: it hands over their bytes by id. One it no longer has is left out.
    void Promise.all(
      rendered.images.map(async (image) => {
        if (image.attachmentId === null) return [];
        const read = await client.query({ type: "attachment.read", attachmentId: image.attachmentId }).catch(() => null);
        return read === null ? [] : [{ name: image.label, mimeType: read.mimeType, dataUrl: read.dataUrl }];
      }),
    )
      .then(async (found) => {
        const sources = found.flat();
        const { ok, images } = await copyPrompt(clipboard, rendered.text, sources);
        if (ok) toasts.push("palette-copy", "info", copiedToast(sources.length, images), COPY_TOAST_MS);
        else if (clipboard.isRemote()) setError(t("app.copy_failed_terminal_may_6db8"));
      });
  };
  /**
   * A paste that is moxen's own copy of a prompt with images: attach those
   * images again, under names no pending image already has. The composer
   * puts the text in and pins each `[Image #N]` token to its image.
   */
  const claimPaste = (text: string): string[] | null => {
    const copied = matchCopy(text);
    if (copied === null || copied.images.length === 0) return null;
    if (pending.length + copied.images.length > MAX_PENDING_ATTACHMENTS) {
      toasts.push("attach-limit", "warn", t("attach.limitPasted", { max: MAX_PENDING_ATTACHMENTS, count: copied.images.length }), COPY_TOAST_MS);
      return null;
    }
    const taken = new Set(pending.map((attachment) => attachment.name));
    const names = copied.images.map((image) => uniqueName(image.name, taken));
    const uploads = copiedAttachments(copied, names);
    if (uploads.length === 0) return null;
    setPending((current) => [...current, ...uploads]);
    return uploads.map((upload) => upload.name);
  };
  const viewedImage = useImageViewer();
  // The viewed image belongs to the thread it was sent in.
  useEffect(() => {
    closeImageViewer();
  }, [selected?.id]);
  // Opening an image leaves the composer focused, so a reply can be typed while looking at it.
  useEffect(() => {
    if (viewedImage !== null) setFocus("composer");
  }, [viewedImage === null]);
  const openViewedImage = () => {
    if (viewedImage === null) return;
    void openImageExternally(viewedImage.label, viewedImage.mimeType, viewedImage.bytes).catch((cause: unknown) =>
      toasts.push("open-image", "danger", t("imageViewer.openFailed", { message: dispatchErrorMessage(cause) }), COPY_TOAST_MS),
    );
  };
  /** Latest assistant reply text, for the palette's copy action. */
  const lastAssistantMessage = [...threadState.messages].reverse().find(
    (message) => message.role === "assistant" && message.text.length > 0,
  )?.text ?? null;
  /** Opens a fetched URL in the browser (clickable web-row links). */
  const openFetchedUrl = (url: string) => {
    void openExternal(url).catch((cause: unknown) =>
      toasts.push("open-url", "danger", dispatchErrorMessage(cause), COPY_TOAST_MS),
    );
  };
  /**
   * Commits the custom-answer prompt back into the options modal (esc goes
   * back without recording). Empty submits toast and return too.
   */
  const submitCustomAnswer = (text: string) => {
    const draft = answerDraft;
    const request =
      draft === null ? undefined : pendingAnswerRequests.find((candidate) => candidate.requestId === draft.requestId);
    const question = request?.questions[draft?.index ?? -1];
    setPicker(null);
    if (draft === null || question === undefined) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError(t("app.answer_is_empty_4033"));
      return;
    }
    answerCurrentQuestion(question.id, { custom: trimmed });
  };

  const closePicker = (returnFocus: "composer" | "chat" | "diff" = "composer") => {
    setPicker(null);
    setPickerFilter("");
    setDeleteArmed(false);
    setRevertArmed(false);
    markModalDismissed();
    setFocus(returnFocus);
  };

  const entries = useMemo(() => timeline(threadState), [threadState]);
  /** Turn groups own the scroll math: the diff-turn picker resolves a picked
      turn to a group index and jumps the chat pane to it. */
  // Waits on the user (questions, permission prompts) come off the raw
  // activities: their closing rows are bookkeeping the transcript hides.
  const turnWaits = useMemo(() => waitSpans(threadState.activities), [threadState.activities]);
  const groups = useMemo(() => groupTurns(entries, turnWaits), [entries, turnWaits]);
  const diffPanel = useDiffPanel({
    client,
    width,
    openThreadId,
    selected,
    shellProjects: shell.projects,
    threadState,
    threadStateRef,
    groups,
    selectedIdRef,
    chatScrollRef,
    setThreadState,
    setFocus,
    setError,
    hideBinary: ui?.hideBinaryDiffs !== false,
  });
  /** The right-hand panel: the Diff tab follows the diff panel, the others open here. */
  const sidePanel = useSidePanel(diffPanel.expandedTurn !== null);
  /** A native subagent's own conversation, open in the chat pane in place of its thread's. */
  const subagentView = useSubagentView(client, openThreadId);
  const {
    deleteThread,
    toggleSettleThread,
    regenerateThreadTitle,
    archiveThread,
    compactSession,
    openMessageActions,
    revertMessageTurn,
    submitRename,
  } = useThreadOps({
    client,
    renderer,
    openThreadId,
    selected,
    creating,
    shellThreads: shell.threads,
    // Settled headers of live families sit in `active` too; never fall back onto one.
    activeThreadIds: sections.active.filter((row) => row.status !== "settled").map((row) => row.thread.id),
    toasts,
    paletteReturnFocus,
    deleteArmed,
    revertArmed,
    sessionRunningRef,
    subagentOpen: subagentView.target !== null,
    restoreDraft,
    closePicker,
    closeDiff: diffPanel.closeDiff,
    setError,
    setOpenThreadId,
    setDeleteArmed,
    setDeleteSupported,
    setRevertArmed,
    setMessageActionEntry,
    setPickerFilter,
    setPicker,
    setCreatingModelSelection,
    setCreatingRuntimeMode,
    setCreatingProjectId,
    setCreating,
    setFocus,
    setThreadState,
    setThreadResync,
  });

  /**
   * Command-palette "Export thread" source data: the live plan checklist,
   * unanswered agent questions, and context usage feed the handover file's
   * "State to continue" section; the file lands in the thread project's
   * workspace root (else the launch directory).
   */
  const exportPlan = useMemo(() => latestPlan(threadState), [threadState]);
  const exportPending = useMemo(() => pendingUserInputRequests(threadState), [threadState]);
  const suggestedPrompt = useMemo(() => promptSuggestion(threadState), [threadState]);
  const notify = useTerminalNotify(renderer);
  useThreadNotifications({
    threads: shell.threads,
    openThreadId,
    openThreadTitle: selected?.title ?? null,
    pendingQuestions: exportPending.length,
    pushToast: toasts.push,
    notify,
  });
  const exportProject = useMemo(() => {
    const project = shell.projects.find((candidate) => candidate.id === selected?.projectId) ?? null;
    if (project === null) return null;
    return {
      title: String(project.title ?? project.id),
      workspaceRoot: typeof project.workspaceRoot === "string" ? project.workspaceRoot : null,
    };
  }, [shell.projects, selected]);
  const { exportThread } = useThreadExport({
    thread: selected,
    openThreadId,
    project: exportProject,
    groups,
    plan: exportPlan,
    pending: exportPending,
    contextUsage: threadState.contextUsage,
    // A remote project's folder is on the server: export here, to the launch folder, instead.
    exportDir: remote ? null : (exportProject?.workspaceRoot ?? null),
    fallbackDir: cwd,
    clipboard,
    toasts,
    paletteReturnFocus,
    closePicker,
    setError,
  });
  const copyStatsCard = useStatsCard({ client, dir: cwd, clipboard, toasts });

  useEffect(() => {
    if (openThreadId === null) return;
    selectedIdRef.current = openThreadId;
    setThreadState(emptyThreadState());
    diffPanel.resetCaches();
    return client.subscribeThread(
      openThreadId,
      {},
      (item) => {
        if (selectedIdRef.current !== openThreadId) return;
        setThreadState((current) => applyThreadFrame(current, item));
      },
      (cause) => setError(String(cause).slice(0, 120)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, openThreadId, threadResync]);

  /** Opens the diff-turn picker from the diff panel's header row. */
  const openDiffTurnPicker = () => {
    setPickerFilter("");
    setPicker("diff-turn");
  };

  /**
   * Picking the already-open turn keeps the panel (no toggle-close) and just
   * jumps the timeline; any other turn opens like a header/row click. The
   * jump is deferred past the panel open: opening/resizing the panel reflows
   * the chat pane (new scrollHeight) under a sticky-bottom scrollbox, which
   * swallows a same-tick scrollTo — landing the jump on the settled layout
   * with fresh measurements instead.
   */
  const pickDiffTurn = (turnCount: number) => {
    setPicker(null);
    setPickerFilter("");
    if (diffPanel.expandedTurn !== turnCount) diffPanel.openDiff(turnCount);
    else setFocus("diff");
    setTimeout(() => diffPanel.scrollTimelineToTurn(turnCount), 60);
  };

  /**
   * While a turn runs, a message either steers it (lands at its next step —
   * Claude's `next` priority) or queues behind it (runs once it ends — its
   * `later`). Idle, it simply starts a turn.
   */
  const dispatchTurn = (prompt: string, attachments: ImageAttachmentUpload[], busyDelivery: "steer" | "queue", scheduledFor?: Date) => {
    if (selected === null) return;
    // A message sent while a turn runs is a steer or a queued send: it carries no mode, and an armed one waits for the next prompt.
    const oneOff = sessionRunningRef.current ? undefined : interaction.takeOneOff();
    void client
      .dispatch({
        type: "thread.turn.start",
        threadId: selected.id,
        message: { text: prompt, attachments },
        // `/research` for this prompt only: the thread's own mode is not touched.
        ...(oneOff === undefined ? {} : { interactionMode: oneOff }),
        // A scheduled message waits in the queue for its time (it cannot steer).
        ...(scheduledFor !== undefined
          ? { scheduledFor: scheduledFor.toISOString() }
          : sessionRunningRef.current
            ? { delivery: busyDelivery }
            : {}),
      })
      .then((result) => {
        const continueAt = usageBanner.banner?.continueAt ?? null;
        if (scheduledFor === undefined && result.status === "queued" && !sessionRunningRef.current && continueAt !== null) {
          toasts.push("queued", "info", t("send.queuedAfterContinue", { at: clock(continueAt) }), COPY_TOAST_MS);
        } else if (scheduledFor !== undefined) {
          const when = describeScheduled(scheduledFor, new Date());
          toasts.push("scheduled", "info", when === "now" ? t("app.scheduled_goes_out_now_58dc") : t("send.scheduledFor", { when }), COPY_TOAST_MS);
        } else if (sessionRunningRef.current && busyDelivery === "queue") {
          toasts.push("queued", "info", t("app.queued_sent_once_this_2b24"), COPY_TOAST_MS);
        }
      })
      .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
  };

  /**
   * `@path/to/image.png` mentions become inline image attachments, combined
   * with anything pasted off the clipboard. The draft stays put when a file
   * cannot be read so the prompt is never eaten by a failed attach.
   */
  const send = (text: string, busyDelivery: "steer" | "queue" = "steer", scheduledFor?: Date) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || selected === null) return;
    // `/btw` never reaches the thread: it is answered on a copy of the
    // context, so it must not wake a settled thread or queue behind a turn.
    const side = parseSideQuestion(trimmed);
    if (side !== null) {
      if (side.length === 0) {
        if (!sideQuestion.reopen()) toasts.push("btw", "info", t("app.usage_btw_question_asks_e6b2"), COPY_TOAST_MS);
      } else if (sideQuestion.ask(side)) {
        resetDraft(selected.id);
      } else {
        toasts.push("btw", "warn", t("app.a_side_question_is_70ee"), COPY_TOAST_MS);
      }
      return;
    }
    // A settled thread wakes on send: unsettle first so the turn lands on a
    // live thread instead of dispatching into a finished one. The toast says
    // what happened; a rejection surfaces as an error and the draft is kept.
    if (threadStatus(selected, Date.now()) === "settled") {
      const id = selected.id;
      void client
        .dispatch({ type: "thread.unsettle", threadId: id, reason: "user" as const })
        .then(() => {
          toasts.push("thread-unsettled", "info", t("ops.unsettled"), COPY_TOAST_MS);
          send(text, busyDelivery, scheduledFor);
        })
        .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
      return;
    }
    const sourceId = selected.id;
    const parsed = extractMentions(trimmed);
    if (parsed.paths.length === 0 && pending.length === 0) {
      resetDraft(sourceId);
      dispatchTurn(trimmed, [], busyDelivery, scheduledFor);
      return;
    }
    void buildImageAttachments(parsed.paths, cwd ?? process.cwd(), (name, mimeType, bytes) =>
      shrinkForAttach(name, mimeType, bytes, pending.length + parsed.paths.length > IMAGE_LIMITS.manyImages),
    ).then((built) => {
      if (built.error !== null) {
        setError(built.error.slice(0, 120));
        return;
      }
      // Pasted and @-mentioned together: the server refuses the same, but
      // here the draft is kept and nothing is sent.
      const imageError = imageSetError([...pending, ...built.attachments]);
      if (imageError !== null) {
        setError(t("send.cannot", { why: tx(imageError) }).slice(0, 160));
        return;
      }
      resetDraft(sourceId);
      writePending(sourceId, []);
      dispatchTurn(parsed.text, [...pending, ...built.attachments], busyDelivery, scheduledFor);
    });
  };

  /**
   * Alt+V (and Ctrl+V where the terminal passes it through) reads an image
   * off the clipboard into a pending attachment chip. Most terminals
   * swallow Ctrl+V for their own paste, so Alt+V is the reliable binding.
   * The read goes to the *terminal* first (OSC 5522 — the only image path
   * that crosses SSH), then the host OS clipboard, then a session-aware
   * error. See `model/terminalClipboard.ts` for the protocol details.
   */
  /** An image's token was deleted from the draft: it no longer goes with the message. */
  const detachImage = (name: string) => setPending((current) => current.filter((attachment) => attachment.name !== name));

  /** Brings an image over a limit under it, and says so: it used to be refused. */
  const shrinkForAttach = (name: string, mimeType: string, bytes: Uint8Array, many = pending.length >= IMAGE_LIMITS.manyImages) => {
    const shrunk = shrinkImage(name, bytes, many);
    if (shrunk === null) return { name, mimeType, bytes };
    toasts.push(
      `shrunk:${name}`,
      "info",
      t("attach.shrunk", { name, from: `${shrunk.from.width}×${shrunk.from.height}`, to: `${shrunk.to.width}×${shrunk.to.height}` }),
      COPY_TOAST_MS,
    );
    return shrunk;
  };

  const pasteImage = () => {
    setFocus("composer");
    // Full: say so, and keep what is attached. Dropping the oldest to make
    // room left its image token in the draft with nothing behind it.
    if (pending.length >= MAX_PENDING_ATTACHMENTS) {
      toasts.push("attach-limit", "warn", t("attach.limit", { max: MAX_PENDING_ATTACHMENTS }), COPY_TOAST_MS);
      return;
    }
    const withRenderer = renderer as unknown as {
      subscribeOsc?: (handler: (sequence: string) => void) => () => void;
    } | null;
    const terminal: TerminalClipboardDeps | null =
      renderer !== null &&
      typeof withRenderer?.subscribeOsc === "function" &&
      process.stdout.isTTY === true
        ? {
            write: (data: string) => {
              process.stdout.write(data);
            },
            subscribe: (handler: (sequence: string) => void) =>
              (withRenderer?.subscribeOsc as (handler: (sequence: string) => void) => () => void)(handler),
          }
        : null;
    void readPastedImage({ env: process.env, terminal }).then((result) => {
      if (result.error !== null) {
        setError(result.error.slice(0, 120));
        return;
      }
      const prepared = shrinkForAttach(clipboardFileName(result.mimeType), result.mimeType, result.bytes);
      const built = attachmentFromBytes(prepared.name, prepared.mimeType, prepared.bytes);
      if (built.error !== null) {
        setError(built.error.slice(0, 120));
        return;
      }
      // Would it still fit the message (count, and the encoded total)? Said
      // now, at the paste, instead of when the message is sent.
      const imageError = imageSetError([...pending, built.attachment]);
      if (imageError !== null) {
        toasts.push("attach-limit", "warn", t("send.notAttached", { why: tx(imageError) }), COPY_TOAST_MS);
        return;
      }
      // Re-checked here: another paste may have landed while this one read the clipboard.
      setPending((current) => (current.length >= MAX_PENDING_ATTACHMENTS ? current : [...current, built.attachment]));
    });
  };

  const { createThread, startNewThread, pickCreatingProject, submitProjectFolder, openProjectPicker } =
    useThreadCreation({
      client,
      cwd,
      remote,
      selected,
      pending,
      shellProjects: shell.projects,
      creatingProjectId,
      creatingModelSelection,
      creatingRuntimeMode,
      creatingInteractionMode: interaction.stickyMode,
      takeOneOff: interaction.takeOneOff,
      resetDraft,
      prepareImage: shrinkForAttach,
      writePending,
      setCreating,
      setCreatingModelSelection,
      setCreatingRuntimeMode,
      setCreatingProjectId,
      setFocus,
      setOpenThreadId,
      setError,
      setPicker,
      setPickerFilter,
      closePicker,
    });

  useKeyboard((key) => {
    // Esc closes the full-screen image from any pane (the composer's own Esc goes through `escapeComposer`).
    if (key.name === "escape" && focus !== "composer" && !quitConfirmOpen && picker === null && closeImageViewer()) return;
    // The full-size quit confirm owns its keys exactly like a modal does:
    // Enter / Ctrl+C again quits, Esc cancels back to the chat pane.
    if (quitConfirmOpen) {
      if ((key.name === "c" && key.ctrl) || key.name === "return") {
        onQuit();
        return;
      }
      if (key.name === "escape") {
        closeQuitConfirm();
        return;
      }
      return;
    }
    // The picker modal owns its keys (type to filter, arrows, enter, esc);
    // every app binding stays swallowed while it is open so chat actions
    // can't fire mid-pick and keystrokes never reach the composer — it is
    // unfocused for the same reason.
    if (picker !== null) {
      return;
    }
    // The same for the modals opened outside the picker (a side answer,
    // a forge prompt): they own their keys while they are up.
    if (sideQuestion.open || forgePrompt !== null) {
      return;
    }
    // The inline answer and permission panels own their keys exactly like a modal does.
    if (requestPanelVisible) {
      return;
    }
    // While `$EDITOR` owns the terminal the TUI must not act on keys.
    if (editingExternallyRef.current) {
      return;
    }
    // Boot gate: no app bindings until the first snapshots land — the chrome
    // they act on isn't mounted yet. Ctrl+C still falls through to the quit
    // flow below so a stalled boot can always exit.
    if (!bootReady && !(key.name === "c" && key.ctrl)) {
      return;
    }
    // Alt+E opens the draft externally. `meta` is Alt; ctrl+E stays free for
    // the textarea's own Emacs line-end binding. When the composer itself is
    // focused the textarea's `onKeyDown` owns this chord instead (this
    // handler returns early for `focus === "composer"` below).
    if ((key.name === "e" || key.name === "E") && key.meta === true && key.ctrl !== true) {
      editDraftExternally();
      return;
    }
    // Ctrl+O does the same and is the Mac-reliable chord: macOS terminals
    // don't send Option-as-Meta by default (Option+E types ´ instead), while
    // Ctrl+O arrives everywhere and is free in the textarea's own bindings,
    // so this fires from the composer too with no extra wiring.
    if ((key.name === "o" || key.name === "O") && key.ctrl === true && key.meta !== true) {
      editDraftExternally();
      return;
    }
    // Ctrl+P / Alt+P opens the command palette from any pane. `p` is free
    // in the textarea's own bindings, so this fires even with the composer
    // focused; plain `p` (no modifier) must never trigger it.
    if ((key.name === "p" || key.name === "P") && (key.ctrl || key.meta)) {
      openCommandPalette();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      // Escalating flow: every press clears the prompt; a 2nd press inside
      // the window opens the close menu; a 3rd (in the menu) quits via the
      // confirm branch above. An empty prompt jumps straight to the menu.
      const shouldOpenMenu = registerCtrlCPress();
      if (openThreadId !== null) {
        resetDraft(openThreadId);
        // The prompt's pasted images are part of it: clearing the text left the chips behind.
        writePending(openThreadId, []);
      }
      if (draft.trim().length === 0 || shouldOpenMenu) {
        toasts.dismiss("ctrl-c");
        openQuitConfirm();
      } else {
        toasts.push("ctrl-c", "info", t("toast.ctrlCAgain"), 2_000);
      }
      return;
    }
    if ((key.name === "v" || key.name === "V") && (key.ctrl || key.meta)) {
      pasteImage();
      return;
    }
    if (key.name === "t" && key.ctrl) {
      toggleTasksVisible();
      return;
    }
    if (focus === "composer") {
      // Submit is owned by the textarea (enter sends, shift+enter newline);
      // escape only leaves the composer — stopping a turn is the composer's
      // own stop button, never a mistyped escape.
      if (key.name === "escape") escapeComposer();
      return;
    }
    if (focus === "search") {
      // The sidebar's search takes what is typed; other keys (Ctrl+P and
      // the rest above) still work from it.
      sidebarSearch.handleKey(key, { onOpen: openThreadFromSidebar, onLeave: () => setFocus("chat") });
      return;
    }
    if (focus === "diff") {
      // Escape always closes the side panel, even mid-turn: it must never
      // stop the thread as a side effect. Stopping a turn is UI-only now (the
      // composer's stop button), never a key.
      if (key.name === "escape") {
        closeSidePanel();
        return;
      }
      scrollPane(sidePanel.tab === "diff" && diffPanel.expandedTurn !== null ? diffScrollRef.current : sidePanel.scrollRef.current, key.name);
      return;
    }
    // Escape in the chat pane never kills a running turn; it only closes
    // a subagent's conversation, back to its thread.
    // An opened search result leaves its query listed; escape here clears it.
    if (key.name === "escape") {
      if (subagentView.target !== null) subagentView.close();
      else sidebarSearch.clear();
      return;
    }
    // `/` searches the sidebar's threads (Cmd+P stays the global search).
    if (key.sequence === "/" && key.ctrl !== true && key.meta !== true) {
      setFocus("search");
      return;
    }
    if (key.name === "i") {
      setFocus("composer");
      return;
    }
    // No `d` binding: the diff opens from a timeline "diff …" row or the
    // diff panel's own header — never a mistyped single key.
    if (key.name === "s") {
      cycleSidebarMode();
      return;
    }
    if (key.name === "[") {
      if (sidebarMode !== "project") {
        setSidebarMode("project");
        return;
      }
      cycleSidebarProject(-1);
      return;
    }
    if (key.name === "]") {
      if (sidebarMode !== "project") {
        setSidebarMode("project");
        return;
      }
      cycleSidebarProject(1);
      return;
    }
    scrollPane(chatScrollRef.current, key.name);
  });

  // Stopped by a plan usage limit: a banner over the composer says when it
  // resets and offers (or shows) the continue for then.
  const usageBanner = useUsageLimitBanner({ client, threadState, openThreadId, now, setError, openThread: setOpenThreadId });
  const queued = useQueuedPanel({ client, threadState, threadId: openThreadId, setError });
  const sideQuestion = useSideQuestion(client, openThreadId);
  // Tasks and Queued share the slot over the composer and page like the
  // notices below them, rather than stacking and eating the chat's rows.
  // Queued comes first: the pager resets to the first pane whenever the set
  // changes, so queueing a message shows it rather than staying on Tasks.
  const dockPanes = [
    ...(queued.items.length > 0 ? (["queued"] as const) : []),
    ...(tasksVisibleNow && plan !== null ? (["tasks"] as const) : []),
  ];
  const dockPager = useNoticePager(dockPanes);
  const dockPane = dockPanes[Math.min(dockPager.index, dockPanes.length - 1)] ?? null;
  const dockPagerControl =
    dockPanes.length > 1 ? (
      <Pager position={dockPanes.indexOf(dockPane!)} count={dockPanes.length} onPage={dockPager.setIndex} />
    ) : undefined;
  const session = threadState.session;
  const sessionRunning = session?.status === "running" || session?.status === "starting";
  sessionRunningRef.current = sessionRunning;

  // Mirrors the chat pane's own live indicator into the terminal's window
  // title, so the thread and its progress stay visible even when the
  // terminal isn't focused. Ticks on the same `now` as the chat pane — no
  // extra timer.
  useEffect(() => {
    if (setTerminalTitle === undefined) return;
    const threadTitleText = selected?.title !== undefined && selected.title.length > 0 ? String(selected.title) : "Moxen";
    if (!sessionRunning) {
      setTerminalTitle(threadTitleText);
      return;
    }
    const anchor = selected?.latestTurn?.startedAt ?? selected?.latestTurn?.requestedAt ?? null;
    const started = anchor === null ? Number.NaN : Date.parse(anchor);
    const elapsedMs = Number.isNaN(started) ? 0 : Math.max(0, now - started);
    const frame = SPINNER[Math.floor(elapsedMs / 1000) % SPINNER.length] ?? "◐";
    setTerminalTitle(t("title.working", { frame, title: threadTitleText, time: formatDuration(elapsedMs) }));
  }, [setTerminalTitle, selected?.title, selected?.latestTurn, sessionRunning, now]);

  /**
   * Stop the open thread's in-flight turn, mirroring `moxen threads
   * interrupt`. Fire-and-forget: the thread subscription projects the
   * interruption once the server accepts it. Returns whether a turn was
   * running. Only the composer's stop button reaches this — escape paths
   * never do.
   */
  const interruptTurn = (): boolean => {
    if (openThreadId === null || !sessionRunning) return false;
    const nowMs = Date.now();
    if (nowMs - lastInterruptRef.current < 1_000) return true;
    lastInterruptRef.current = nowMs;
    void client
      .dispatch({
        type: "thread.turn.interrupt",
        threadId: openThreadId,
      })
      .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
    return true;
  };

  /** Stops one background task; shared by the command palette and the background-tasks browser. */
  const stopBackgroundTask = (task: BackgroundTaskRow): void => {
    const threadId = selected?.id;
    if (!threadId) return;
    void client
      .dispatch({ type: "thread.background.stop", threadId, taskId: task.taskId })
      .then(() => toasts.push("background-stop", "info", t("bg.stopped", { title: backgroundTaskTitle(task) }), COPY_TOAST_MS))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  /** Whether the open thread's provider can stop one native subagent on its own (the OpenCode and harness drivers can; Claude's run inside the turn). */
  const canStopSubagent = selected?.modelSelection?.instanceId.startsWith("opencode") === true || selected?.modelSelection?.instanceId.startsWith("harness/") === true;
  const stopSubagent = (agentId: string): void => {
    if (openThreadId === null) return;
    void client
      .dispatch({ type: "thread.background.stop", threadId: openThreadId, taskId: agentId })
      .then(() => toasts.push("subagent-stop", "info", t("app.subagent_stopped_a328"), COPY_TOAST_MS))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  /** Opens the command palette, remembering where esc should return focus. */
  const openCommandPalette = () => {
    // Drafting a new thread, it opens too, with only what applies before
    // a thread exists (search, a project, servers).
    remoteAccess.refresh();
    setPaletteReturnFocus(focus === "search" ? "chat" : focus);
    setDeleteArmed(false);
    setPickerFilter("");
    setPicker("command");
  };

  const {
    providers,
    providersError,
    model,
    effort,
    permission,
    permissionChoices,
    modelColor,
    labelFor,
    openModelPicker,
    openEffortPicker,
    openPermissionPicker,
    pickModel,
    pickEffort,
    setThreadRuntimeMode,
  } = useProviderCatalog({
    client,
    reconnects,
    selected,
    openThreadId,
    creating,
    effectiveModelSelection,
    effectiveRuntimeMode,
    setCreatingModelSelection,
    setCreatingRuntimeMode,
    setPicker,
    setPickerFilter,
    setFocus,
    setError,
    closePicker,
    settingsChanges,
  });
  /** The model's own scene behind the new-thread view (and the sidebar's
      window onto it), or null for the monitoring texture. */
  const creatingScene = creating && ui?.modelScenes !== false ? sceneForModel(model) : null;

  // A 1s tick while a turn is in flight drives the thinking/working elapsed
  // counter; the 30s tick above is enough for sidebar ages when idle.
  // Not while the terminal is hidden: nothing is painted, and `now` is current again the moment it is not.
  const terminalVisible = useTerminalVisible();
  useEffect(() => {
    if (!sessionRunning || !terminalVisible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sessionRunning, terminalVisible]);
  const contextUsageDisplay = threadState.contextUsage === null ? null : formatContextUsage(threadState.contextUsage);

  // -- side panel (Diff / Agents / Context / Background) --------------------
  const sidePanelOpen = sidePanel.tab !== null && !creating;
  const turnKey = `${selected?.latestTurn?.turnId ?? ""}:${selected?.latestTurn?.state ?? ""}`;
  const currentProvider = providers?.find((candidate) => candidate.instanceId === effectiveModelSelection?.instanceId) ?? null;
  const [planUsageRead, setPlanUsageRead] = useState(false);
  const planUsage = usePlanUsage(
    client,
    `${turnKey}:${reconnects}`,
    ui?.usageRefreshSeconds === undefined ? undefined : ui.usageRefreshSeconds * 1000,
    () => setPlanUsageRead(true),
  );
  // What the composer's footer is drawn from (model names, usage gauges, the layout they pick) is read before
  // the first frame, so it does not redraw when the answers land. A read that failed counts: the boot screen
  // names the stalled leg rather than hold the app on a server that cannot answer it.
  const providersReady = (providers !== null || providersError !== null) && planUsageRead;
  useEffect(() => {
    if (!booted && isBootReady(shell, openThreadId, threadState, providersReady)) setBooted(true);
  }, [booted, shell, openThreadId, threadState, providersReady]);
  const threadUsageLimits = currentProvider === null ? null : (planUsage[currentProvider.driver] ?? currentProvider.usageLimits);
  const planGauges = planUsageGauges(threadUsageLimits);
  const contextBreakdown = useContextBreakdown(
    client,
    openThreadId,
    sidePanelOpen && sidePanel.tab === "context",
    turnKey,
    ui?.contextRefreshSeconds === undefined ? undefined : ui.contextRefreshSeconds * 1000,
  );
  // A total-only reading (Claude's summary without categories, or no live
  // session) still shows what fills the window: the transcript estimate.
  const effectiveBreakdown = useMemo(
    () => effectiveContextBreakdown(contextBreakdown.breakdown, threadState.contextUsage, threadState.messages, threadState.activities),
    [contextBreakdown.breakdown, threadState.contextUsage, threadState.messages, threadState.activities],
  );
  const contextLive = contextBreakdown.live && (contextBreakdown.breakdown?.categories.length ?? 0) > 0;
  // Delegated tasks name their model as `instance/model`; the catalog turns
  // that into the name and brand colour the composer footer uses.
  const modelLabelOf = (reference: string) => {
    const slash = reference.indexOf("/");
    return slash < 0 ? { name: reference, color: null } : labelFor({ instanceId: reference.slice(0, slash), model: reference.slice(slash + 1) });
  };
  const agentRows = useMemo(
    () => agentThreads(shell.threads, openThreadId, now, (instanceId, model) => labelFor({ instanceId, model }).name),
    // `labelFor` reads the provider catalog; recompute when it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shell.threads, openThreadId, now, providers],
  );
  const subagentRows = useMemo(() => nativeSubagents(threadState.activities), [threadState.activities]);
  // A delegated thread has no agents of its own to list; its tab tells about the task instead.
  const delegatedInfo = useMemo((): DelegatedInfo | null => {
    const parentId = selected?.parentThreadId;
    if (selected === null || parentId === undefined) return null;
    const parent = shell.threads.find((thread) => thread.id === parentId);
    const turn = selected.latestTurn ?? null;
    const first = threadState.messages.find((message) => message.role === "user");
    return {
      task: first?.text.trim() || null,
      parent: parent === undefined ? null : { threadId: parent.id, title: String(parent.title ?? parent.id) },
      status: threadStatus(selected, now),
      outcome: turn === null || turn.state === "running" ? null : turn.state,
      startedAt: turn?.startedAt ?? turn?.requestedAt ?? null,
      model: selected.modelSelection ? labelFor(selected.modelSelection).name : null,
      branch: selected.branch ?? null,
      worktreePath: withHomeAsTilde(selected.worktreePath ?? null),
    };
  }, [selected, shell.threads, threadState.messages, now, providers]); // eslint-disable-line react-hooks/exhaustive-deps
  const diffTurns = threadState.checkpoints.filter((row) => row.files.length > 0);
  const runningAgents = agentRows.filter((agent) => agent.status === "running").length + subagentRows.filter((agent) => agent.running).length;
  const sideBadges: Partial<Record<SideTab, string | null>> = {
    diff: diffTurns.length > 0 ? String(diffTurns.length) : null,
    agents: delegatedInfo !== null ? null : runningAgents > 0 ? String(runningAgents) : agentRows.length + subagentRows.length > 0 ? String(agentRows.length + subagentRows.length) : null,
    context: contextUsageDisplay?.percent == null ? null : `${contextUsageDisplay.percent}%`,
    background: background.length > 0 ? String(background.length) : null,
  };
  /**
   * One tab at a time: leaving Diff closes the open diff (so a later diff-row
   * click opens rather than toggles a hidden one), and the Diff tab with
   * nothing open shows the latest turn that changed files. Also remembers
   * the tab for the timeline's reopen button (which is how the Agents tab —
   * the only one with no other opener — gets opened).
   */
  const [lastSideTab, setLastSideTab] = useState<SideTab>(ui?.defaultSidePanel ?? "context");
  const showSideTab = (tab: SideTab) => {
    markModalDismissed();
    setLastSideTab(tab);
    if (tab === "diff") {
      if (diffPanel.expandedTurn === null) {
        const latest = diffTurns.reduce((max, row) => Math.max(max, row.checkpointTurnCount), -1);
        if (latest >= 0) {
          diffPanel.openDiff(latest);
          return;
        }
      }
      sidePanel.open("diff");
      setFocus("diff");
      return;
    }
    if (diffPanel.expandedTurn !== null) diffPanel.closeDiff();
    sidePanel.open(tab);
    setFocus("diff");
  };
  const closeSidePanel = () => {
    markModalDismissed();
    if (diffPanel.expandedTurn !== null) diffPanel.closeDiff();
    sidePanel.close();
    setFocus("chat");
  };
  // The new-thread view starts clean: whatever panel the last thread had
  // open closes rather than coming back over the thread this one creates.
  useEffect(() => {
    if (!creating) return;
    if (diffPanel.expandedTurn !== null) diffPanel.closeDiff();
    sidePanel.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating]);
  const toggleSideTab = (tab: SideTab) => {
    if (sidePanelOpen && sidePanel.tab === tab) closeSidePanel();
    else showSideTab(tab);
  };
  const openThreadFromPanel = (threadId: string) => {
    setCreating(false);
    setPicker(null);
    setPickerFilter("");
    setOpenThreadId(threadId);
  };

  // Pane-OUTER width (borders included): the composer, tasks, and answer
  // panels fill this exact slot edge-to-edge. Inner text budgets subtract
  // their own chrome from it below — never shrink the slot itself, or the
  // raised panels end short of the pane edge.
  const chatWidth = Math.max(
    20,
    width - SIDEBAR_WIDTH - (sidePanelOpen ? diffPanel.diffWidth : 0) - CHAT_GUTTER * 2,
  );
  /** Toasts stay entirely inside one pane's own bounds, with a 1-col margin:
      the side panel's while it is open, the chat/timeline pane's otherwise —
      never floating over the sidebar or straddling panes. */
  const toastGeometry = useMemo(() => {
    const chatLeft = SIDEBAR_WIDTH + CHAT_GUTTER;
    const diffLeft = sidePanelOpen ? chatLeft + chatWidth : null;
    const paneLeft = diffLeft ?? chatLeft;
    const paneWidth = diffLeft === null ? chatWidth : diffPanel.diffWidth;
    const paneRight = paneLeft + paneWidth;
    const toastWidth = Math.min(60, Math.max(24, paneWidth - TOAST_INSET * 2));
    return {
      left: Math.max(paneLeft + TOAST_INSET, paneRight - TOAST_INSET - toastWidth),
      width: toastWidth,
    };
  }, [chatWidth, diffPanel.diffWidth, sidePanelOpen]);
  const draftingWithoutProject =
    effectiveProjectId === NO_PROJECT ||
    shell.projects.some((project) => project.id === effectiveProjectId && project.scratch === true);
  const projectTitle =
    effectiveProjectId === NO_PROJECT
      ? t("app.no_project_f0f6")
      : (shell.projects.find((project) => project.id === effectiveProjectId)?.title ?? t("app.this_project_e910"));

  /** "Resume with less context" — same trigger as the desktop banner: a
      Claude snapshot holding >= 100k tokens that hasn't refreshed in >= 70
      minutes (see `shouldOfferResumeCompaction`). Keyed per (thread,
      snapshot) so only a fresh snapshot reopens it after dismissal. */
  const resumeKey = resumeCompactionKey(threadState);
  const resumeBanner =
    creating ||
    resumeKey === null ||
    resumeKey === dismissedResumeKey ||
    !shouldOfferResumeCompaction(threadState, effectiveModelSelection?.instanceId, now)
      ? null
      : { key: resumeKey, usedTokens: threadState.contextUsage?.usedTokens ?? 0 };
  /** Past its hand-off line the thread should move to a fresh one (MXN-22); the same rule the server acts on (`longThreadPolicy`). */
  const longThread = longThreadPolicy(longThreadConfig, effectiveModelSelection?.instanceId, effectiveModelSelection?.model);
  const handoffState =
    creating || openThreadId === null
      ? null
      : autoHandoffState({
          mode: longThread.handoff.mode,
          ...lineInput(longThread.handoff.line),
          usedTokens: threadState.contextUsage?.usedTokens ?? null,
          maxTokens: threadState.contextUsage?.maxTokens ?? null,
          hasReply: lastAssistantMessage !== null,
          turnRunning: sessionRunning,
          runningSubthreads: runningAgents,
          runningBackgroundTasks: background.length,
          queuedMessages: queued.items.length,
        });
  const handoffReady = handoffState !== null && handoffState.blockers.length === 0;
  /** The provider's own compaction is off: past the line, Moxen asks, or sends /compact itself. */
  const compact = longThread.compact;
  const compactState =
    creating || openThreadId === null || compact === null
      ? null
      : autoHandoffState({
          mode: compact.mode,
          ...lineInput(compact.line),
          usedTokens: threadState.contextUsage?.usedTokens ?? null,
          maxTokens: threadState.contextUsage?.maxTokens ?? null,
          hasReply: lastAssistantMessage !== null,
          turnRunning: sessionRunning,
          runningSubthreads: 0,
          runningBackgroundTasks: 0,
          queuedMessages: 0,
        });
  const compactReady = compactState !== null && compactState.blockers.length === 0;
  const compactKey = openThreadId === null || threadState.contextUsage === null ? null : `compact:${openThreadId}:${threadState.contextUsage.usedTokens}`;
  const [dismissedCompactKey, setDismissedCompactKey] = useState<string | null>(null);
  const handoffKey = openThreadId === null ? null : `handoff:${openThreadId}`;
  const [dismissedHandoffKey, setDismissedHandoffKey] = useState<string | null>(null);
  // "Automatic" is the server's to do (`actOnLongThread`, after every turn), so a thread no client has open is
  // handed off or compacted too. What is left here is following an automatic hand-off of the thread on screen.
  const followedSince = useRef<{ threadId: string | null; since: string }>({ threadId: null, since: new Date().toISOString() });
  if (followedSince.current.threadId !== openThreadId) followedSince.current = { threadId: openThreadId, since: new Date().toISOString() };
  const automaticContinuation = useMemo(() => {
    const row = [...threadState.activities].reverse().find((activity) => activity.kind === "thread.continued");
    const payload = row?.payload as { threadId?: unknown; automatic?: unknown } | undefined;
    return row !== undefined && payload?.automatic === true && typeof payload.threadId === "string" && row.createdAt >= followedSince.current.since ? payload.threadId : null;
  }, [threadState.activities]);
  useEffect(() => {
    if (automaticContinuation !== null) setOpenThreadId(automaticContinuation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automaticContinuation]);
  // A server that stops answering (gone, frozen, its machine asleep): said
  // first, over everything else, until the connection is back.
  const linkText = serverLink.status === "connected" ? null : linkNoticeText(serverLink, server, Date.now());
  // No way out offered here: this server's threads and projects are its own,
  // and another server's are not a substitute (switching is in the palette).
  const linkNotice: Notice | null =
    linkText === null
      ? null
      : {
          key: "server-link",
          glyph: "◌",
          glyphColor: linkText.tone === "danger" ? COLOR.danger : COLOR.warn,
          title: linkText.title,
          ...(linkText.tone === "warn" ? { tags: [{ text: "reconnecting", color: COLOR.warn }] } : {}),
          detail: <text fg={COLOR.dim} selectable={false}>{`  ${linkText.detail}`}</text>,
          actions: [],
        };
  /** What waits over the composer, most urgent first; the banner pages between them. */
  const notices: Notice[] = linkNotice === null ? [] : [linkNotice];
  if (usageBanner.banner !== null) {
    const banner = usageBanner.banner;
    notices.push({
      key: "usage",
      glyph: "◔",
      glyphColor: banner.wrapUp ? COLOR.warn : COLOR.danger,
      title: t("app.usage_limit_reached_301b"),
      tags: [
        ...(banner.wrapUp ? [{ text: t("app.wrapping_up_8d20"), color: COLOR.warn }] : []),
        ...(banner.windowLabel === null ? [] : [{ text: t("usage.windowLimit", { window: banner.windowLabel }), color: COLOR.dim }]),
      ],
      detail:
        banner.continueAt !== null ? (
          <>
            <text fg={COLOR.dim} selectable={false}>{t("app.continues_at_65a6")}</text>
            <text fg={COLOR.warn} selectable={false}>{clock(banner.continueAt)}</text>
            <text fg={COLOR.faint} selectable={false}>{` (${untilLabel(new Date(banner.continueAt), now)})`}</text>
            <text fg={COLOR.dim} selectable={false}>{t("app.once_the_limit_has_e1dc")}</text>
          </>
        ) : banner.resetsAt === null ? (
          <text fg={COLOR.dim} selectable={false}>{t("app.resets_when_the_provider_8348")}</text>
        ) : (
          <>
            <text fg={COLOR.dim} selectable={false}>{t("app.resets_at_6538")}</text>
            <text fg={COLOR.warn} selectable={false}>{clock(banner.resetsAt.toISOString())}</text>
            <text fg={COLOR.faint} selectable={false}>{` (${untilLabel(banner.resetsAt, now)})`}</text>
          </>
        ),
      actions:
        banner.continueAt !== null
          ? [{ label: t("app.cancel_continue_07e6"), fg: COLOR.dim, hoverFg: COLOR.text, onClick: usageBanner.cancelContinue }]
          : [
              // Short labels on purpose: the three actions share one row with
              // the title, and a longer pair pushed Dismiss off the edge.
              // Read together: continue [at reset | in a new thread].
              ...(banner.resetsAt === null ? [] : [{ label: t("app.continue_at_reset_681f"), fg: COLOR.accent, onClick: usageBanner.scheduleContinue }]),
              // A fresh context instead of resuming a long one: the handoff
              // carries the work, and waits for the reset if it has not come.
              // Only once the assistant has said something to hand over.
              ...(lastAssistantMessage === null ? [] : [{ label: t("app.in_a_new_thread_b710"), fg: COLOR.accent, onClick: usageBanner.continueInNewThread }]),
              { label: t("action.dismiss"), fg: COLOR.dim, hoverFg: COLOR.text, onClick: usageBanner.dismiss },
            ],
    });
  }
  if (resumeBanner !== null) {
    notices.push({
      key: "resume",
      glyph: "◈",
      glyphColor: COLOR.warn,
      title: t("app.resume_with_less_context_2d5c"),
      detail: <text fg={COLOR.dim} selectable={false}>{t("resume.tokensEarlier", { count: formatTokenCount(resumeBanner.usedTokens) })}</text>,
      actions: [
        { label: t("action.compact"), fg: COLOR.accent, onClick: () => compactSession(() => setDismissedResumeKey(resumeBanner.key)) },
        { label: t("app.keep_full_history_79fc"), fg: COLOR.dim, hoverFg: COLOR.text, onClick: () => setDismissedResumeKey(resumeBanner.key) },
      ],
    });
  }
  if (handoffState !== null && handoffKey !== null && handoffKey !== dismissedHandoffKey && !(longThread.handoff.mode === "auto" && handoffReady)) {
    notices.push({
      key: handoffKey,
      glyph: "◈",
      glyphColor: COLOR.warn,
      title: handoffState.usedPercent === null ? t("ctx.at", { tokens: handoffState.usedTokens.toLocaleString(currentLanguage()) }) : t("ctx.atPercent", { tokens: handoffState.usedTokens.toLocaleString(currentLanguage()), percent: handoffState.usedPercent }),
      detail: (
        <text fg={COLOR.dim} selectable={false}>
          {handoffState.blockers.length === 0
            ? t("app.tool_calls_get_less_ab60")
            : t(longThread.handoff.mode === "auto" ? "ctx.handingOffOnce" : "ctx.waitingFor", { blockers: handoffState.blockers.map(tx).join(", ") })}
        </text>
      ),
      actions: [
        { label: t("action.handOff"), fg: COLOR.accent, onClick: usageBanner.continueInNewThread },
        { label: t("action.notNow"), fg: COLOR.dim, hoverFg: COLOR.text, onClick: () => setDismissedHandoffKey(handoffKey) },
      ],
    });
  }
  if (compactState !== null && compactKey !== null && compactKey !== dismissedCompactKey && !(compact?.mode === "auto" && compactReady)) {
    notices.push({
      key: compactKey,
      glyph: "◈",
      glyphColor: COLOR.warn,
      title: compactState.usedPercent === null ? t("ctx.at", { tokens: compactState.usedTokens.toLocaleString(currentLanguage()) }) : t("ctx.atPercent", { tokens: compactState.usedTokens.toLocaleString(currentLanguage()), percent: compactState.usedPercent }),
      detail: (
        <text fg={COLOR.dim} selectable={false}>
          {compactState.blockers.length === 0 ? t("app.compact_it_to_make_023e") : t(compact?.mode === "auto" ? "ctx.compactingOnce" : "ctx.waitingFor", { blockers: compactState.blockers.map(tx).join(", ") })}
        </text>
      ),
      actions: [
        { label: t("action.compact"), fg: COLOR.accent, onClick: () => compactSession(() => setDismissedCompactKey(compactKey)) },
        { label: t("action.notNow"), fg: COLOR.dim, hoverFg: COLOR.text, onClick: () => setDismissedCompactKey(compactKey) },
      ],
    });
  }
  // The lower line is offered first: a compaction set below the hand-off line goes ahead of the hand-off card.
  if (compactsFirst(longThread, threadState.contextUsage?.maxTokens ?? null)) {
    const at = notices.findIndex((notice) => notice.key === handoffKey);
    const card = notices.findIndex((notice) => notice.key === compactKey);
    if (at >= 0 && card > at) notices.splice(at, 0, ...notices.splice(card, 1));
  }
  const noticePager = useNoticePager(notices.map((notice) => notice.key));

  /**
   * Modal bodies: the model list across providers plus a provider shortcut
   * section, one section per effort descriptor of the current model, every
   * turn that produced file changes for the diff-turn picker, or the
   * command palette's copy/thread/export/jump sections.
   */
  const threadSearch = useThreadSearch(client, picker === "search", pickerFilter);
  const pickerBody: PickerBody = useMemo(() => {
    if (picker === null) return { kind: "list", sections: [] };
    // Thread search: what the server found, active threads above settled ones.
    if (picker === "search") {
      if (threadSearch.kind === "idle") return { kind: "list", sections: [] };
      if (threadSearch.kind === "loading") return { kind: "loading" };
      if (threadSearch.kind === "error") return { kind: "error", message: threadSearch.message };
      const rowOf = (entry: (typeof threadSearch.found.threads)[number]) => {
        const hit = entry.hits[0];
        const where = hit === undefined || hit.kind === "title" ? t("search.where.title") : hit.kind === "tool" ? (hit.source ?? t("search.where.tool")) : hit.kind === "message" ? (hit.source ?? t("search.where.message")) : hit.kind;
        const more = entry.hitCount > 1 ? t("search.more", { count: entry.hitCount - 1 }) : "";
        return {
          key: `search:${entry.threadId}`,
          label: entry.title,
          meta: hit === undefined ? "" : `${where}: ${hit.snippet}${more}`,
          onPick: () => {
            closePicker("composer");
            setCreating(false);
            setOpenThreadId(entry.threadId);
          },
        };
      };
      const found = threadSearch.found.threads;
      const active = found.filter((entry) => entry.status !== "settled").map(rowOf);
      const settled = found.filter((entry) => entry.status === "settled").map(rowOf);
      return {
        kind: "list",
        sections: [
          ...(active.length > 0 ? [{ header: t("search.active"), rows: active }] : []),
          ...(settled.length > 0 ? [{ header: t("search.settled"), headerColor: COLOR.faint, rows: settled }] : []),
        ],
      };
    }
    // Message actions need no catalog either: copy plus a checkpoint-backed
    // history revert for the clicked user turn (assistant clicks copy
    // directly and never reach this modal).
    if (picker === "message") {
      if (messageActionEntry === null) return { kind: "list", sections: [] };
      const entry = messageActionEntry;
      const checkpoint = threadState.checkpoints.find((row) => row.turnId === entry.turnId) ?? null;
      const revertTarget = checkpoint === null ? null : checkpoint.checkpointTurnCount - 1;
      // A missing checkpoint on the latest turn of a running session means
      // "not created yet" — say so instead of the cryptic stock reason.
      const isLatestTurn =
        entry.turnId !== null && groups.length > 0 && groups[groups.length - 1]?.turnId === entry.turnId;
      const revertMissingMeta = sessionRunning && isLatestTurn ? t("app.turn_still_running_9163") : t("app.no_checkpoint_for_this_2cc0");
      return {
        kind: "list",
        sections: [
          {
            rows: [
              {
                key: "message:copy",
                label: t("action.copy"),
                meta: t("chars", { count: entry.text.length }),
                onPick: () => {
                  closePicker("chat");
                  copyMessage(entry);
                },
              },
              // A message still waiting can be taken back before it runs.
              ...(entry.queued !== undefined && entry.turnId !== null && openThreadId !== null
                ? [
                    {
                      key: "message:cancel",
                      label: entry.queued.scheduledFor === null ? t("app.cancel_queued_message_cd3f") : t("app.cancel_scheduled_message_b5ee"),
                      onPick: () => {
                        closePicker("chat");
                        const turnId = entry.turnId!;
                        void client
                          .dispatch({ type: "thread.turn.interrupt", threadId: openThreadId, turnId })
                          .then(() => toasts.push("queued-cancel", "info", t("app.message_cancelled_c940"), 2500))
                          .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
                      },
                    },
                  ]
                : []),
              // Only a user prompt is a revert point: an agent reply belongs to the turn its prompt opened.
              ...(entry.kind !== "user"
                ? []
                : [
              revertTarget === null
                ? {
                    key: "message:revert",
                    label: t("app.revert_to_before_this_212f"),
                    meta: revertMissingMeta,
                    disabled: true,
                    onPick: () => {},
                  }
                : {
                    key: "message:revert",
                    label: revertArmed === "conversation" ? t("app.confirm_revert_777b") : t("app.revert_to_before_this_212f"),
                    meta: revertArmed === "conversation" ? t("app.enter_again_to_confirm_7cde") : t("app.conversation_only_9d33"),
                    onPick: () => revertMessageTurn(entry, revertTarget, "conversation"),
                  },
              // The files too, from the snapshot taken before this turn ran.
              revertTarget === null || checkpoint?.status !== "available"
                ? {
                    key: "message:revert-files",
                    label: t("app.revert_conversation_and_files_1442"),
                    meta: revertTarget === null ? revertMissingMeta : t("app.no_file_snapshot_for_1fd3"),
                    disabled: true,
                    onPick: () => {},
                  }
                : {
                    key: "message:revert-files",
                    label: revertArmed === "files" ? t("app.confirm_revert_with_files_87bc") : t("app.revert_conversation_and_files_1442"),
                    meta:
                      revertArmed === "files"
                        ? t("app.enter_again_to_confirm_4ce2")
                        : t("app.files_back_to_before_d13a"),
                    onPick: () => revertMessageTurn(entry, revertTarget, "files"),
                  },
                  ]),
            ],
          },
        ],
      };
    }
    // The command palette needs no provider catalog either: only thread,
    // shell, and transcript state the app already holds.
    if (picker === "remote-servers") return serversBody(remoteAccess, server, () => setPicker(null));
    if (picker === "remote-devices") return devicesBody(remoteAccess);
    const remoteSection = () =>
      remotePaletteSection(remoteAccess, server, {
        open: (next) => {
          setPickerFilter("");
          setPicker(next);
        },
        close: () => closePicker(paletteReturnFocus),
      });
    if (picker === "command" && creating) {
      return {
        kind: "list",
        sections: [
          {
            header: t("palette.newThread"),
            rows: [
              {
                key: "thread:search",
                label: t("app.search_threads_c202"),
                meta: t("app.titles_messages_tool_calls_1fcc"),
                onPick: () => {
                  setPickerFilter("");
                  setPicker("search");
                },
              },
              {
                key: "thread:new-project",
                label: t("app.choose_project_d8da"),
                onPick: () => {
                  setPickerFilter("");
                  setPicker("project");
                },
              },
            ],
          },
          remoteSection(),
        ],
      };
    }
    if (picker === "command") {
      const projectPath = shell.projects.find((project) => project.id === selected?.projectId)?.workspaceRoot ?? null;
      const branchName = selected?.branch ?? null;
      const jumpRows = groups.flatMap((group, index) => {
        const first = group.prompts[0];
        if (first === undefined) return [];
        const line = first.text.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, " ").trim() || t("app.empty_prompt_558f");
        return [
          {
            key: `jump:${group.id}`,
            label: line,
            meta: clock(first.at),
            onPick: () => {
              closePicker("chat");
              diffPanel.scrollTimelineToIndex(index);
            },
          },
        ];
      });
      return {
        kind: "list",
        sections: [
          {
            header: t("action.copy"),
            rows: [
              {
                key: "copy:path",
                label: t("app.copy_project_path_a959"),
                onPick: () => copyPaletteText(projectPath, t("app.no_project_path_for_81f2")),
              },
              {
                key: "copy:branch",
                label: t("app.copy_branch_6806"),
                ...(branchName === null ? {} : { meta: branchName }),
                onPick: () => copyPaletteText(branchName, t("app.this_thread_has_no_b556")),
              },
              {
                key: "copy:thread",
                label: t("app.copy_thread_id_ed70"),
                ...(openThreadId === null ? {} : { meta: `${openThreadId.slice(0, 8)}…` }),
                onPick: () => copyPaletteText(openThreadId, t("app.no_open_thread_b43f")),
              },
              {
                key: "copy:last",
                label: t("app.copy_last_assistant_message_7b49"),
                ...(lastAssistantMessage === null ? {} : { meta: t("chars", { count: lastAssistantMessage.length }) }),
                onPick: () => copyPaletteText(lastAssistantMessage, t("app.no_assistant_message_yet_de11")),
              },
            ],
          },
          {
            header: t("palette.thread"),
            rows: [
              {
                key: "thread:search",
                label: t("app.search_threads_c202"),
                meta: t("app.titles_messages_tool_calls_1fcc"),
                onPick: () => {
                  setPickerFilter("");
                  setPicker("search");
                },
              },
              {
                key: "thread:new",
                label: t("palette.newThread"),
                ...(selected === null ? {} : { meta: projectTitle }),
                onPick: () => {
                  startNewThread();
                  closePicker("composer");
                },
              },
              {
                key: "thread:new-project",
                label: t("app.new_thread_in_project_d0c3"),
                onPick: () => {
                  if (!creating) {
                    setCreatingModelSelection(null);
                    setCreatingRuntimeMode(null);
                    setCreatingProjectId(null);
                    setCreating(true);
                  }
                  setPickerFilter("");
                  setPicker("project");
                },
              },
              // Over a native subagent's transcript, settling means that subagent —
              // never the thread it belongs to. A subagent is not a thread of its
              // own, so settling is stopping it while it runs, and closing it after.
              subagentView.target !== null
                ? (() => {
                    const agentId = subagentView.target.agentId;
                    const running = subagentRows.find((row) => row.agentId === agentId)?.running === true;
                    return running && canStopSubagent
                      ? {
                          key: "thread:settle",
                          label: t("app.settle_subagent_f72d"),
                          meta: t("app.stops_it_36c8"),
                          onPick: () => {
                            stopSubagent(agentId);
                            subagentView.close();
                            closePicker("chat");
                          },
                        }
                      : {
                          key: "thread:settle",
                          // A running one this provider cannot stop alone only has its view closed.
                          label: running ? t("app.close_subagent_1f6d") : t("app.settle_subagent_f72d"),
                          meta: running ? t("app.keeps_running_afe9") : t("app.closes_it_1286"),
                          onPick: () => {
                            subagentView.close();
                            closePicker("chat");
                          },
                        };
                  })()
                : {
                    key: "thread:settle",
                    label: selected !== null && threadStatus(selected, Date.now()) === "settled" ? t("app.unsettle_thread_8bf3") : t("app.settle_thread_7401"),
                    onPick: toggleSettleThread,
                  },
              {
                key: "thread:regenerate-title",
                label: t("app.regenerate_title_ac4c"),
                onPick: regenerateThreadTitle,
              },
              {
                key: "thread:rename",
                label: t("app.rename_thread_979d"),
                onPick: () => {
                  setPickerFilter("");
                  setPicker("rename");
                },
              },
              {
                key: "thread:archive",
                label: t("app.archive_thread_1c8a"),
                onPick: archiveThread,
              },
              {
                key: "message:schedule",
                label: t("app.schedule_message_cbae"),
                // What is in the composer goes, at a time asked for next.
                ...(draft.trim().length === 0
                  ? { meta: t("app.write_it_in_the_589e"), disabled: true, onPick: () => {} }
                  : {
                      meta: truncate(draft.trim().replace(/\s+/gu, " "), 32),
                      onPick: () => {
                        setPickerFilter("");
                        setPicker("schedule");
                      },
                    }),
              },
              {
                key: "thread:compact",
                label: t("app.compact_session_4ad9"),
                ...(entries.length === 0
                  ? { meta: t("app.no_turns_yet_c9d5"), disabled: true, onPick: () => {} }
                  : { onPick: compactSession }),
              },
              ...(background.length === 0
                ? []
                : [
                    {
                      key: "background:browse",
                      label: t("app.view_background_tasks_ca11"),
                      meta: t("bg.runningCount", { count: background.length }),
                      onPick: () => setPicker("background-tasks"),
                    },
                  ]),
              // One row per background task running in the session.
              ...background.map((task) => ({
                key: `background:stop:${task.taskId}`,
                label: t("bg.stop", { title: backgroundTaskTitle(task) }),
                meta: task.taskType === "local_agent" ? "agent" : "shell",
                onPick: () => {
                  closePicker("chat");
                  stopBackgroundTask(task);
                },
              })),
              deleteSupported
                ? {
                    key: "thread:delete",
                    label: deleteArmed ? t("app.confirm_delete_thread_abe2") : t("app.delete_thread_6bd4"),
                    meta: deleteArmed ? t("app.enter_again_to_confirm_8742") : "irreversible",
                    onPick: deleteThread,
                  }
                : {
                    key: "thread:delete",
                    label: t("app.delete_thread_6bd4"),
                    meta: t("app.not_supported_by_server_91b2"),
                    disabled: true,
                    onPick: () => {},
                  },
            ],
          },
          {
            header: t("palette.panels"),
            rows: (["diff", "git", "context", "agents", "background"] as const).map((tab) => ({
              key: `panel:${tab}`,
              label: t(sidePanelOpen && sidePanel.tab === tab ? "panel.hide" : "panel.show", { name: tab === "agents" && delegatedInfo !== null ? t("tab.info") : tabLabel(tab) }),
              ...(sideBadges[tab] == null ? {} : { meta: sideBadges[tab]! }),
              onPick: () => {
                closePicker("chat");
                toggleSideTab(tab);
              },
            })),
          },
          {
            header: t("palette.export"),
            rows: [
              {
                key: "thread:export",
                label: t("app.export_thread_to_markdown_34f7"),
                // A prompt alone (sent, then stopped by a limit) is not a
                // thread worth exporting: the assistant has to have said something.
                ...(lastAssistantMessage === null
                  ? { meta: entries.length === 0 ? t("app.no_turns_yet_c9d5") : t("app.no_reply_yet_f40d"), disabled: true, onPick: () => {} }
                  : { meta: t("turns", { count: groups.length }), onPick: exportThread }),
              },
              {
                key: "thread:continue",
                label: t("app.continue_in_a_new_6599"),
                // Same project, model and checkout; a handoff written from
                // this thread. Held for the reset while a usage limit stands.
                // Nothing to hand over until the assistant has replied.
                ...(lastAssistantMessage === null
                  ? { meta: entries.length === 0 ? t("app.no_turns_yet_c9d5") : t("app.no_reply_yet_f40d"), disabled: true, onPick: () => {} }
                  : {
                      meta: usageBanner.banner?.resetsAt ? t("app.after_the_reset_2abf") : t("app.fresh_context_a387"),
                      onPick: () => {
                        closePicker("chat");
                        usageBanner.continueInNewThread();
                      },
                    }),
              },
            ],
          },
          {
            header: t("palette.memory"),
            rows: [
              {
                key: "memory:import-claude",
                label: t("app.import_claude_code_memory_1bf9"),
                // Only ever on request: Moxen keeps its own memory, and Claude's stays where it is.
                ...(selected === null
                  ? { meta: t("app.open_a_thread_first_cf50"), disabled: true, onPick: () => {} }
                  : {
                      meta: t("app.into_this_project_147f"),
                      onPick: () => {
                        closePicker("chat");
                        void client
                          .dispatch({ type: "memory.import-claude", threadId: selected.id })
                          .then((result) =>
                            toasts.push(
                              "memory-import",
                              "info",
                              result.imported.length === 0 ? t("app.no_claude_code_memories_ff18") : t("memory.imported", { count: result.imported.length }),
                              COPY_TOAST_MS,
                            ),
                          )
                          .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
                      },
                    }),
              },
            ],
          },
          {
            header: t("palette.providers"),
            rows: [
              {
                key: "update:claude",
                label: t("app.update_claude_code_fc8f"),
                meta: "claude update",
                onPick: () => {
                  closePicker("chat");
                  providerUpdates.update("claude");
                },
              },
              {
                key: "update:opencode",
                label: t("app.update_opencode_7246"),
                meta: "opencode upgrade",
                onPick: () => {
                  closePicker("chat");
                  providerUpdates.update("opencode");
                },
              },
            ],
          },
          remoteSection(),
          ...(jumpRows.length === 0 ? [] : [{ header: t("app.jump_to_message_b628"), rows: jumpRows }]),
        ],
      };
    }
    // Answering the open agent question: one picker page per question,
    // options as rows (single-select picks advance immediately, multi-select
    // toggles until Continue), plus a custom-answer row unless disallowed.
    // The diff-turn list needs no provider catalog either.
    if (picker === "diff-turn") {
      const turns = threadState.checkpoints
        .filter((row) => row.files.length > 0)
        .slice()
        .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);
      return {
        kind: "list",
        sections: [
          {
            rows: turns.map((row) => {
              const added = row.files.reduce((total, file) => total + file.additions, 0);
              const removed = row.files.reduce((total, file) => total + file.deletions, 0);
              return {
                key: `turn:${row.checkpointTurnCount}`,
                label: t("turn.n", { n: row.checkpointTurnCount }),
                meta: t("diff.filesChanged", { count: row.files.length, added, removed }),
                selected: row.checkpointTurnCount === diffPanel.expandedTurn,
                onPick: () => pickDiffTurn(row.checkpointTurnCount),
              };
            }),
          },
        ],
      };
    }
    // The new-thread project list needs no provider catalog either: every
    // known project, with the effective (picked or inherited) one marked,
    // led by a row that creates a project from a local folder.
    if (picker === "project") {
      return {
        kind: "list",
        sections: [
          {
            rows: [
              {
                key: "project:new",
                label: t("app.new_project_from_local_c36e"),
                onPick: () => {
                  setPickerFilter("");
                  setPicker("project-new");
                },
              },
              {
                key: "project:none",
                label: t("app.no_project_3556"),
                meta: t("app.scratch_folder_f83f"),
                selected:
                  effectiveProjectId === NO_PROJECT ||
                  shell.projects.some((project) => project.id === effectiveProjectId && project.scratch === true),
                onPick: () => pickCreatingProject(NO_PROJECT),
              },
              ...shell.projects.filter((project) => project.scratch !== true).map((project) => {
                const root = typeof project.workspaceRoot === "string" ? project.workspaceRoot : "";
                const shortRoot = root.replace(/\\/g, "/").split("/").pop() ?? null;
                return {
                  key: `project:${project.id}`,
                  label: String(project.title ?? project.id),
                  ...(shortRoot === null || shortRoot.length === 0 ? {} : { meta: shortRoot }),
                  selected: project.id === effectiveProjectId,
                  onPick: () => pickCreatingProject(project.id),
                };
              }),
            ],
          },
        ],
      };
    }
    // Permission levels need no provider catalog: the choices derive from
    // the open thread's provider snapshot (or every known mode until it
    // loads), so this branch sits above the catalog loading gate.
    if (picker === "permission") {
      const shown = compatibleRuntimeMode(effectiveRuntimeMode ?? "full-access", permissionChoices);
      return {
        kind: "list",
        sections: [
          {
            rows: permissionChoices.map((choice) => ({
              key: `permission:${choice.mode}`,
              label: tx(choice.label),
              meta: tx(choice.description),
              selected: shown === choice.mode,
              onPick: () => setThreadRuntimeMode(choice.mode),
            })),
          },
        ],
      };
    }
    if (providers === null) {
      if (providersError !== null) return { kind: "error", message: providersError };
      return { kind: "loading" };
    }
    if (picker === "effort") {
      const current = effectiveModelSelection;
      const catalogModel = providers
        .find((provider) => provider.instanceId === current?.instanceId)
        ?.models.find((model) => model.slug === current?.model);
      const descriptors = catalogModel?.efforts ?? [];
      return {
        kind: "sliders",
        sliders: descriptors.map((descriptor) => {
          const picked =
            (current?.options ?? []).find((option) => option.id === descriptor.id)?.value ?? descriptor.currentValue;
          const fallbackId = isEffortDescriptor(descriptor.id) ? defaultEffortId(descriptor.choices) : descriptor.choices.find((choice) => choice.isDefault === true)?.id;
          const slider: PickerSlider = {
            key: descriptor.id,
            header: tx(descriptor.label),
            stops: descriptor.choices.map((choice) => ({
              key: choice.id,
              label: tx(choice.label),
              isDefault: choice.id === fallbackId,
              ...(isEffortDescriptor(descriptor.id) ? { description: describeEffort(choice.id, choice.id === fallbackId) } : {}),
            })),
            current: typeof picked === "string" ? picked : null,
            // Reasoning levels run from quick to thorough; any other knob is just a row of choices.
            ...(isEffortDescriptor(descriptor.id) ? { ends: { low: t("settings.faster"), high: t("settings.smarter") }, effort: true, defaultCaption: t("effort.defaultCaption", { what: tx(descriptor.label).toLowerCase() }) } : {}),
            onPick: (choiceId: string) => pickEffort(descriptor.id, choiceId),
          };
          return slider;
        }),
      };
    }
    const current = effectiveModelSelection;
    // A thread that hasn't started yet has no provider to lock to — offer
    // every *enabled* provider, grouped into sections so browsing them stays
    // sane. Disabled instances still report their models over getConfig, but
    // selecting them fails, so they are hidden (same as the desktop picker).
    // Hidden models (`providerModelPreferences`) are skipped except the
    // current one, which stays marked so a since-hidden selection still reads.
    if (creating) {
      return {
        kind: "list",
        sections: offerableProviders(providers)
          .map((provider) => ({
            provider,
            models: offerableModels(
              provider,
              provider.instanceId === current?.instanceId ? current?.model : undefined,
            ),
          }))
          .filter(({ models }) => models.length > 0)
          .map(({ provider, models }) => {
            // "default" marks what a new thread starts on: the settings' choice when it names one of these models, else the catalog's.
            const configured = configuredDefaultModel(settings.snapshot?.settings ?? [], provider.instanceId);
            const pinned = configured !== undefined && models.some((model) => model.slug === configured) ? configured : undefined;
            return { provider, models, pinned };
          })
          .map(({ provider, models, pinned }) => ({
            header: provider.displayName ?? provider.instanceId,
            rows: models.map((model) => ({
              key: `${provider.instanceId}:${model.slug}`,
              label: model.name,
              ...modelRowDetail(model, pinned === undefined ? model.isDefault === true : model.slug === pinned),
              selected: current?.instanceId === provider.instanceId && current?.model === model.slug,
              onPick: () => pickModel({ instanceId: provider.instanceId, model: model.slug }),
            })),
          })),
      };
    }
    // An open thread already has a live session on one provider — there is
    // no in-picker provider switch, so only that provider's models are offered
    // (even when the instance has since been disabled — the thread is already
    // on it). Hidden models are skipped except the current one.
    const provider = providers.find((candidate) => candidate.instanceId === current?.instanceId);
    const offered = provider === undefined ? [] : offerableModels(provider, current?.model);
    return {
      kind: "list",
      sections: [
        {
          rows: offered.map((model) => ({
            key: `${provider?.instanceId}:${model.slug}`,
            label: model.name,
            ...modelRowDetail(model),
            selected: current?.model === model.slug,
            onPick: () => pickModel({ instanceId: provider!.instanceId, model: model.slug }),
          })),
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, providers, providersError, settings.snapshot, effectiveModelSelection, effectiveRuntimeMode, permissionChoices, creating, deleteArmed, deleteSupported, revertArmed, answerDraft, background, threadSearch, remoteAccess.status, remoteAccess.servers, remoteAccess.devices, remoteAccess.revokeArmed, server]);

  /** Wider and taller than a picker: the task browser shows commands and live output. */
  /**
   * The Git tab's write prompts. A forge write is outward-facing, so the
   * tab never dispatches one directly — it asks for this, and the answer
   * is what gets sent.
   */
  const [forgePrompt, setForgePrompt] = useState<{ kind: "create"; draft: boolean } | { kind: "comment"; number: number } | null>(null);
  // Local history and the forge, read only while the Git tab is showing.
  const gitPanel = useGitPanel(client, selected?.id ?? null, sidePanel.tab === "git");
  /**
   * Who opens a pull request when asked: the thread's own agent, which
   * knows the work — or, while its provider is at a usage limit, another
   * provider with usage left, delegated the task in this checkout (it starts
   * cold, so its prompt says to read the branch first). Moxen drives agents;
   * the user only types a title when they choose to open it by hand.
   */
  const threadLimited = usageBanner.banner !== null;
  const handOff = threadLimited ? handOffTarget(providers, currentProvider?.instanceId ?? null, planUsage) : null;
  const requestOpener = { label: !threadLimited ? t("app.the_agent_4988") : (handOff?.label ?? null) };
  const agentOpenRequest = (draft: boolean) => {
    if (selected === null) return;
    const kind = gitPanel.forge?.kind ?? null;
    const noun = requestNoun(kind);
    const branch = gitPanel.overview?.status?.branch ?? null;
    const base = gitPanel.base;
    if (!threadLimited) {
      send(openRequestPrompt({ kind, draft, branch, base, cold: false }), "queue");
      toasts.push("forge-agent", "info", t(draft ? "forge.askedDraft" : "forge.asked", { what: noun.short }), COPY_TOAST_MS);
      return;
    }
    if (handOff === null) return;
    void client
      .dispatch({
        type: "thread.delegate",
        parentThreadId: selected.id,
        task: openRequestPrompt({ kind, draft, branch, base, cold: true }),
        // i18n-exempt: a thread title stored on the server, as the agent is told it
        title: `Open a ${draft ? "draft " : ""}${noun.short}${base === null ? "" : ` into ${base}`}`,
        provider: handOff.instanceId,
        model: handOff.model,
        wait: false,
        isolation: "shared",
      })
      .then(() => toasts.push("forge-agent", "info", t("forge.opening", { who: handOff.label, what: noun.short }), COPY_TOAST_MS))
      .catch((cause: unknown) => setError(String(cause).slice(0, 120)));
  };
  const backgroundGeometry = useMemo(() => {
    const panelWidth = Math.min(100, Math.max(30, width - 8));
    const panelHeight = Math.min(32, Math.max(10, height - 4));
    return {
      width: panelWidth,
      height: panelHeight,
      left: Math.max(0, Math.floor((width - panelWidth) / 2)),
      top: Math.max(0, Math.floor((height - panelHeight) / 2)),
    };
  }, [width, height]);
  /** The effort picker is a slider or two, not a list: a small panel sized to them. */
  const effortGeometry = useMemo(() => {
    const panelWidth = Math.min(72, Math.max(40, width - 6));
    const sliders = pickerBody.kind === "sliders" ? Math.max(1, pickerBody.sliders.length) : 1;
    const panelHeight = Math.min(Math.max(10, height - 6), 6 + 11 * sliders);
    return {
      width: panelWidth,
      height: panelHeight,
      left: Math.max(0, Math.floor((width - panelWidth) / 2)),
      top: Math.max(0, Math.floor((height - panelHeight) / 2)),
    };
  }, [width, height, pickerBody]);
  const pickerGeometry = useMemo(() => {
    const panelWidth = Math.min(64, Math.max(30, width - 6));
    const panelHeight = Math.min(24, Math.max(10, height - 6));
    return {
      width: panelWidth,
      height: panelHeight,
      left: Math.max(0, Math.floor((width - panelWidth) / 2)),
      top: Math.max(0, Math.floor((height - panelHeight) / 2)),
    };
  }, [width, height]);

  /** Small centered prompt for the rename modal: title + input + hint. */
  const renameGeometry = useMemo(() => {    const panelWidth = Math.min(64, Math.max(30, width - 6));
    const panelHeight = 7;
    return {
      width: panelWidth,
      height: panelHeight,
      left: Math.max(0, Math.floor((width - panelWidth) / 2)),
      top: Math.max(0, Math.floor((height - panelHeight) / 2)),
    };
  }, [width, height]);
  /**
   * Ctrl+C confirm geometry: full-size (`width - 4 × height - 4`, 2-col
   * margin) so the quit decision reads as a terminal-level interrupt, not
   * another small picker.
   */
  const quitGeometry = useMemo(() => {
    const panelWidth = Math.min(70, Math.max(30, width - 6));
    const panelHeight = Math.min(10, Math.max(8, height - 4));
    return {
      width: panelWidth,
      height: panelHeight,
      left: Math.max(0, Math.floor((width - panelWidth) / 2)),
      top: Math.max(0, Math.floor((height - panelHeight) / 2)),
    };
  }, [width, height]);

  /**
   * Message-actions modal sized to its content (title + search + rows +
   * hint), not the full picker frame — two rows shouldn't float in twenty.
   */
  const messageGeometry = useMemo(() => {
    const panelWidth = Math.min(64, Math.max(30, width - 6));
    const rows = pickerBody.kind === "list" ? pickerBody.sections.reduce((total, section) => total + section.rows.length, 0) : 0;
    const panelHeight = Math.min(24, 8 + rows);
    return {
      width: panelWidth,
      height: panelHeight,
      left: Math.max(0, Math.floor((width - panelWidth) / 2)),
      top: Math.max(0, Math.floor((height - panelHeight) / 2)),
    };
  }, [width, height, pickerBody]);

  const submitComposer = () => {
    if (editingExternallyRef.current) return;
    // `/research`, `/orchestrate`: this prompt runs in that mode and the thread keeps its own; alone, the mode is held for the next prompt.
    if (interaction.isModeCommand(draft)) {
      // While a turn runs the mode is fixed, and the draft stays as it was rather than go out as text.
      if (interaction.refuseWhileRunning()) return;
      // The composer's draft key (`useComposer`): the open thread's, or the one a first thread is drafted under.
      resetDraft(openThreadId ?? "__creating__");
      const rest = interaction.takeCommand(draft);
      if (rest === null || rest.length === 0) return;
      if (creating) createThread(rest);
      else send(rest);
      return;
    }
    if (creating) createThread(draft);
    else send(draft);
  };
  const escapeComposer = () => {
    // The full-screen image is the top layer: Esc closes it before anything else.
    if (closeImageViewer()) return;
    if (creating) {
      // Zero-thread workspace: there is no transcript to cancel back to,
      // so esc stays in the creating view instead of stranding the UI.
      if (selected === null) {
        setFocus("chat");
        return;
      }
      setCreating(false);
      setCreatingModelSelection(null);
      setCreatingRuntimeMode(null);
      setCreatingProjectId(null);
      setFocus("chat");
      return;
    }
    // Escape only unfocuses back to the chat pane — it never stops a running
    // turn (that's the composer's stop button now).
    setFocus("chat");
  };
  const composerPlaceholder = editingExternally
    ? t("app.editing_in_external_editor_da08")
    : creating
      ? t("app.ask_for_changes_send_9b33")
      : t("app.message_the_agent_imgpng_edc1");
  /**
   * The composer holds keyboard focus only when no modal is open: an open
   * picker owns all keystrokes (type to filter), so a still-focused textarea
   * would swallow them into the draft and keep blinking. Closing restores
   * focus via closePicker's explicit target.
   */
  const composerFocused =
    focus === "composer" && picker === null && !quitConfirmOpen && !sideQuestion.open && forgePrompt === null;
  /**
   * Inline answer panel for the pending agent question, rendered in place
   * of the composer (both slots below). Render-time closures, so picks and
   * toggles always read fresh draft state.
   */
  const renderRequestPanel = (panelWidth: number) => {
    if (permissionShown && activePermission !== null) {
      return (
        <PermissionPanel
          key={activePermission.requestId}
          request={activePermission}
          width={panelWidth}
          suspended={picker !== null}
          onDecide={respondToPermission}
        />
      );
    }
    return renderAnswerPanel(panelWidth);
  };

  const renderAnswerPanel = (panelWidth: number) => {
    if (answerDraft === null || activeAnswerRequest === null || activeAnswerQuestion === null) return null;
    const draft = answerDraft;
    const question = activeAnswerQuestion;
    return (
      <AnswerPanel
        key={`${draft.requestId}:${draft.index}`}
        question={question}
        position={draft.index}
        total={activeAnswerRequest.questions.length}
        width={panelWidth}
        suspended={picker === "answer-custom"}
        pickedValues={draft.selected[question.id] ?? []}
        {...(draft.custom[question.id] === undefined ? {} : { customValue: draft.custom[question.id]! })}
        tabs={activeAnswerRequest.questions.map((entry) => ({
          header: entry.header,
          answered: resolveAnswerQuestion(entry, draft) !== null,
        }))}
        onGoto={goToQuestion}
        onToggleOption={(value) => toggleAnswerOption(draft, question.id, value)}
        onPickOption={(value) => answerCurrentQuestion(question.id, { selected: [value] })}
        onCustom={() => setPicker("answer-custom")}
        onContinue={() => {
          const resolved = resolveAnswerQuestion(question, draft);
          if (resolved === null) {
            setError(t("app.pick_at_least_one_611e"));
            return;
          }
          answerCurrentQuestion(question.id, {});
        }}
        onDismiss={dismissAnswerRequest}
      />
    );
  };

  /**
   * The new-thread view's one column: a centred card, never the full pane,
   * and never narrower than a composer can usefully be.
   */
  const creatingWidth = Math.min(76, Math.max(40, width - SIDEBAR_WIDTH - 8));

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, backgroundColor: SURFACE.base }}>
      {/* Boot gate: sidebar + transcript stay hidden until both snapshots
          land — an empty shell is otherwise indistinguishable from "no
          threads". Toasts, the quit confirm, and pickers below stay mounted
          so boot errors and ctrl+c still surface over the loading screen. */}
      {bootReady ? (
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <Sidebar
          sections={sections}
          {...(server === null ? {} : { serverName: server.name })}
          openThreadId={openThreadId}
          markedThreadIds={markedThreadIds}
          settledExpanded={settledExpanded}
          width={SIDEBAR_WIDTH}
          now={now}
          height={height}
          screenWidth={width}
          backdrop={ui?.backdrop === "off" ? "off" : ui?.backdrop === "static" ? "static" : "animated"}
          openSubagentId={subagentView.target?.agentId ?? null}
          onOpenThread={openThreadFromSidebar}
          search={sidebarSearch.view}
          searchFocused={focus === "search"}
          onFocusSearch={() => setFocus("search")}
          onOpenSubagents={(threadId, agentId) => {
            setFocus("chat");
            setCreating(false);
            setPicker(null);
            setPickerFilter("");
            setOpenThreadId(threadId);
            subagentView.open(threadId, agentId);
          }}
          onToggleSettled={toggleSettledExpanded}
          onShowMore={showMoreSettled}
          onSelectMode={setSidebarMode}
          onToggleProject={toggleSidebarProject}
          onCycleProject={cycleSidebarProject}
          onNewThread={startNewThread}
          panelsOpen={sidePanelOpen}
          onTogglePanels={() => {
            // The new-thread view has no panels to show.
            if (creating) return;
            if (sidePanelOpen) closeSidePanel();
            else showSideTab(lastSideTab);
          }}
          onOpenSettings={() => {
            setPickerFilter("");
            setPicker("settings");
          }}
          onOpenStats={() => {
            setPickerFilter("");
            setPicker("stats");
          }}
        />
        {creating ? (
          <box
            style={{
              flexDirection: "column",
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: SURFACE.base,
            }}
          >
            {/* Behind the empty state only, unmounted (zero cost) in
                thread view: the selected model's scene when it has one
                (`ui/scenes/`, a reading well dimmed under the composer),
                else the faint control-plane texture — grid + drifting
                status dots, zinc palette — easing between them as the
                model changes. offsetX is the pane's raw terminal
                origin (the builder mods it) and the field spans the whole
                screen with the sidebar's — one lattice, one swarm.
                Foreground column sits above at zIndex 1 with its own opaque
                surfaces so text never seams. */}
            {ui?.backdrop === "off" ? null : (
              <SceneBackdrop
                scene={creatingScene ?? "grid"}
                width={Math.max(0, width - SIDEBAR_WIDTH)}
                height={height}
                well
                motion={ui?.backdrop === "static" ? "static" : "animated"}
              />
            )}
            {/* Explicit max-width column: alignItems:center shrink-wraps
                children, so the composer needs its own width instead of
                stretching like it does in the thread view. */}
            <box
              style={{
                flexDirection: "column",
                flexShrink: 0,
                width: creatingWidth,
                zIndex: 1,
              }}
            >
              <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "center" }}>
                {draftingWithoutProject ? (
                  <text fg={COLOR.bright} selectable={false} onMouseDown={openProjectPicker}>{t("app.what_should_we_build_7785")}</text>
                ) : (
                  <>
                    <text fg={COLOR.bright} selectable={false} onMouseDown={openProjectPicker}>{t("home.buildIn")}</text>
                    <text
                      fg={COLOR.bright}
                      attributes={TextAttributes.BOLD | TextAttributes.UNDERLINE}
                      selectable={false}
                      onMouseDown={openProjectPicker}
                    >{projectTitle}</text>
                    <text fg={COLOR.bright} selectable={false} onMouseDown={openProjectPicker}>{"?"}</text>
                  </>
                )}
              </box>
              {requestPanelVisible ? (
                // A request panel takes the composer's slot; the server
                // notice still stands above it, as a card of its own in the
                // same vocabulary (left spine, raised surface) rather than a
                // slab over the scene.
                <box style={{ flexDirection: "column", flexShrink: 0, width: creatingWidth }}>
                  {linkNotice === null ? null : (
                    <box
                      border={["left"]}
                      borderStyle="heavy"
                      borderColor={linkNotice.glyphColor}
                      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingTop: 1, paddingBottom: 1, backgroundColor: SURFACE.raised }}
                    >
                      <NoticeBanner notices={[linkNotice]} index={0} onPage={() => undefined} width={creatingWidth - 3} flushTop tight />
                    </box>
                  )}
                  {renderRequestPanel(creatingWidth)}
                </box>
              ) : (
              <Composer
                draft={draft}
                resetKey={composerResetKey}
                onInput={setDraft}
                onSubmit={submitComposer}
                onEscape={escapeComposer}
                onFocus={() => setFocus("composer")}
                focused={composerFocused}
                placeholder={composerPlaceholder}
                model={model}
                modelColor={modelColor}
                effort={effort === null || effort === undefined ? effort : tx(effort)}
                permission={permission}
                attachments={pending.map((attachment) => attachment.name)}
                attachmentDataUrl={(name) => pending.find((attachment) => attachment.name === name)?.dataUrl}
                onAttachmentRemoved={detachImage}
                onClaimPaste={claimPaste}
                submitVerb="creates"
                running={false}
                width={creatingWidth}
                hideHint
                // Inside the card rather than over the pane: a banner here
                // would be an opaque box floating on the scene.
                {...(linkNotice === null
                  ? {}
                  : {
                      notice: (
                        <NoticeBanner
                          notices={[linkNotice]}
                          index={0}
                          onPage={() => undefined}
                          width={creatingWidth - 3}
                          inset={0}
                          flushTop
                          tight
                        />
                      ),
                    })}
                onModelClick={openModelPicker}
                onEffortClick={openEffortPicker}
                onPermissionClick={openPermissionPicker}
                onCopyClick={copyDraft}
                onExternalEditClick={editDraftExternally}
                editingExternally={editingExternally}
                skills={pickerSkills}
                onSkillsOpen={refreshSkills}
                // The account's plan usage for the provider picked here: the one metric a thread-less draft has.
                planUsage={planGauges}
                mode={interaction.mode}
                onCycleMode={interaction.cycleMode}
              />
              )}
              <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "center", marginTop: 1 }}>
                <text fg={COLOR.dim} selectable={false}>{draftingWithoutProject
                  ? t("app.enter_creates_click_title_f018")
                  : t("app.enter_creates_click_project_ce6d")}</text>
              </box>
            </box>
          </box>
        ) : (
        // One breathing column on each side of the chat stack: the pane
        // sits off the sidebar and the terminal edge. Inner breathing
        // comes from the scrollbox/composer padding instead.
        <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: CHAT_GUTTER, paddingRight: CHAT_GUTTER }}>
          {/* Post-boot thread switches (and resyncs) reset `threadState`
              before the new snapshot lands — hold a loading row instead of
              flashing an empty transcript that reads as "no messages". */}
          {viewedImage !== null ? (
            <ImageViewer image={viewedImage} onClose={closeImageViewer} onOpenExternally={openViewedImage} />
          ) : threadState.synchronized ? (
          <Timeline
            groups={subagentView.target === null ? groups : subagentView.groups}
            title={
              subagentView.target !== null
                ? `◇ ${subagentTitle(subagentView.transcript, subagentRows.find((row) => row.agentId === subagentView.target?.agentId)?.agentType ?? null)}`
                : selected === null
                  ? t("app.no_thread_888a")
                  : String(selected.title ?? selected.id)
            }
            subtitle={subagentView.target !== null ? t("subagent.word") : sessionStatusLabel(session?.status ?? "idle")}
            modelForTurn={(turnId) =>
              labelFor(
                turnModelSelection(
                  {
                    modelSelection: selected?.modelSelection,
                    turnModelSelections: threadState.thread?.turnModelSelections ?? selected?.turnModelSelections,
                  },
                  turnId,
                ),
              )
            }
            modelLabel={modelLabelOf}
            homeDir={homeDir}
            readAttachment={readAttachment}
            expandedTurn={diffPanel.expandedTurn}
            expandedWork={diffPanel.expandedWork}
            onToggleWork={diffPanel.toggleWork}
            scrollRef={chatScrollRef}
            focused={focus === "chat"}
            onFocus={() => setFocus("chat")}
            onOpenDiff={diffPanel.openDiff}
            onOpenMessageActions={openMessageActions}
            onOpenUrl={openFetchedUrl}
            turnFileDiffs={diffPanel.turnPatchCache.current}
            gitFiles={diffPanel.gitPatchCache.current}
            width={chatWidth}
            // A subagent's transcript is its own run: whether it is still working, and since when, is the
            // subagent's — the thread's idle parent would have its last group read "Worked" under a bar that says running.
            sessionStatus={subagentView.target !== null ? subagentRun(subagentView.transcript).status : (session?.status ?? "idle")}
            now={now}
            turnStartedAt={
              subagentView.target !== null
                ? subagentRun(subagentView.transcript).startedAt
                : (selected?.latestTurn?.startedAt ?? selected?.latestTurn?.requestedAt ?? null)
            }
          />
          ) : (
            <box style={{ flexDirection: "column", flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
              <text fg={COLOR.dim} selectable={false}>{t("app.loading_transcript_4aac")}</text>
            </box>
          )}
          {/* One blank row between the timeline frame and the tasks header;
              below, the last task row sits flush onto the notice rule. The
              composer always keeps its blank row above — a bordered frame
              needs air, unlike the thin rule. With tasks hidden the notice
              drops its rule — the frame's own border is separator enough —
              but keeps the blank row. */}
          {dockPane === "tasks" && plan !== null ? (
            <TasksPanel plan={plan} width={chatWidth} {...(dockPagerControl ? { pager: dockPagerControl } : {})} />
          ) : dockPane === "queued" ? (
            <QueuedPanel
              items={queued.items}
              width={chatWidth}
              now={now}
              onCancel={queued.cancel}
              {...(dockPagerControl ? { pager: dockPagerControl } : {})}
            />
          ) : null}
          <NoticeBanner
            notices={notices}
            index={noticePager.index}
            onPage={noticePager.setIndex}
            width={chatWidth}
            {...(dockPane !== null ? { flushTop: true } : { tight: true })}
          />
          {subagentView.target !== null ? (
            <SubagentBar
              title={subagentTitle(subagentView.transcript, subagentRows.find((row) => row.agentId === subagentView.target?.agentId)?.agentType ?? null)}
              state={subagentState(subagentView.transcript, now)}
              width={chatWidth}
              onBack={subagentView.close}
            />
          ) : requestPanelVisible ? (
            renderRequestPanel(chatWidth)
          ) : (
          <Composer
            draft={draft}
            resetKey={composerResetKey}
            onInput={setDraft}
            onSubmit={submitComposer}
            onEscape={escapeComposer}
            onFocus={() => setFocus("composer")}
            focused={composerFocused}
            placeholder={composerPlaceholder}
            suggestion={suggestedPrompt}
            model={model}
            modelColor={modelColor}
            effort={effort === null || effort === undefined ? effort : tx(effort)}
            permission={permission}
            attachments={pending.map((attachment) => attachment.name)}
                attachmentDataUrl={(name) => pending.find((attachment) => attachment.name === name)?.dataUrl}
            onAttachmentRemoved={detachImage}
                onClaimPaste={claimPaste}
            submitVerb="sends"
            running={sessionRunning}
            waitingOutLimit={!sessionRunning && usageBanner.banner?.continueAt != null}
            width={chatWidth}
            onModelClick={openModelPicker}
            onEffortClick={openEffortPicker}
            onPermissionClick={openPermissionPicker}
            onStopClick={interruptTurn}
            onQueue={() => {
              if (!editingExternallyRef.current) send(draft, "queue");
            }}
            onCopyClick={copyDraft}
            onExternalEditClick={editDraftExternally}
            editingExternally={editingExternally}
            skills={pickerSkills}
            onSkillsOpen={refreshSkills}
            contextUsage={contextUsageDisplay}
            onContextUsageClick={() => toggleSideTab("context")}
            backgroundSummary={backgroundSummaryLabel(background)}
            onBackgroundClick={() => toggleSideTab("background")}
            planUsage={planGauges}
            onPlanUsageClick={() => toggleSideTab("context")}
            mode={interaction.mode}
            onCycleMode={interaction.cycleMode}
          />
          )}
        </box>
        )}
        {!sidePanelOpen || sidePanel.tab === null ? null : (
          <box style={{ width: diffPanel.diffWidth, flexDirection: "column", flexShrink: 0 }}>
            {/* Tabs sit in the frame's own top line (cutting it, with spacing)
                so Threads / chat / side frames stay continuous instead of the
                side frame starting one row lower. */}
            {/* Tabs sit in the frame's own top line (cutting it, with spacing)
                so Threads / chat / side frames stay continuous instead of the
                side frame starting one row lower. */}
            <SideTabBar
              tab={sidePanel.tab}
              badges={sideBadges}
              onTab={showSideTab}
              onClose={closeSidePanel}
              focused={focus === "diff"}
              {...(delegatedInfo === null ? {} : { agentsLabel: t("tab.info") })}
              left={2}
              width={Math.max(10, diffPanel.diffWidth - 4)}
            />
            {sidePanel.tab === "diff" && diffPanel.expandedTurn !== null ? (
              <box style={{ flexDirection: "row", flexGrow: 1 }}>
                <DiffPanel
                  files={diffPanel.patchFiles}
                  loading={diffPanel.patch === null}
                  fileIndex={diffPanel.diffFileIndex}
                  collapsed={diffPanel.collapsedFiles}
                  width={diffPanel.diffWidth}
                  height={height}
                  turnCount={diffPanel.expandedTurn}
                  turnTotal={diffTurns.length}
                  focused={focus === "diff"}
                  scrollRef={diffScrollRef}
                  onToggleFile={diffPanel.toggleDiffFile}
                  onFocus={() => setFocus("diff")}
                  onHeaderClick={openDiffTurnPicker}
                />
              </box>
            ) : (
              <SidePanelFrame
                width={diffPanel.diffWidth}
                height={height}
                focused={focus === "diff"}
                scrollRef={sidePanel.scrollRef}
                onFocus={() => setFocus("diff")}
                footer={
                  sidePanel.tab === "git" ? (
                    <GitFooter overview={gitPanel.overview} forge={gitPanel.forge} width={diffPanel.diffWidth} />
                  ) : sidePanel.tab === "agents" && delegatedInfo !== null ? null : sidePanel.tab === "agents" ? (
                    <text fg={COLOR.dim} selectable={false}>{t("agents.summary", { delegated: agentRows.length, subagents: subagentRows.length })}</text>
                  ) : sidePanel.tab === "context" && effectiveBreakdown !== null ? (
                    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.panel}>
                      <ActionText label={t("app.compact_now_08f8")} onClick={() => compactSession(() => undefined)} />
                      <text fg={COLOR.faint} bg={SURFACE.panel} selectable={false}>{t("app.frees_the_window_3f92")}</text>
                    </box>
                  ) : sidePanel.tab === "background" ? (
                    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.panel}>
                      <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{t("bg.running", { count: background.length })}</text>
                      <ActionText label={t("app.view_all_0b4d")} onClick={() => setPicker("background-tasks")} />
                    </box>
                  ) : sidePanel.tab === "diff" && diffTurns.length > 0 ? (
                    <text fg={COLOR.dim} selectable={false}>{t("diff.turnsWithChanges", { count: diffTurns.length })}</text>
                  ) : null
                }
              >
                {sidePanel.tab === "diff" ? (
                  <DiffEmptyTab turns={diffTurns.length} onPick={openDiffTurnPicker} />
                ) : sidePanel.tab === "git" ? (
                  <GitTab
                    overview={gitPanel.overview}
                    forge={gitPanel.forge}
                    requests={gitPanel.requests}
                    status={gitPanel.status}
                    commitChecks={gitPanel.commitChecks}
                    commit={gitPanel.commit}
                    opener={requestOpener}
                    base={gitPanel.base}
                    baseChoices={gitPanel.baseChoices}
                    onPickBase={gitPanel.pickBase}
                    onAgentOpen={agentOpenRequest}
                    onOpenCommit={gitPanel.openCommit}
                    onCloseCommit={gitPanel.closeCommit}
                    onOpenUrl={openFetchedUrl}
                    loadingGit={gitPanel.loadingGit}
                    loadingForge={gitPanel.loadingForge}
                    error={gitPanel.error}
                    busy={gitPanel.busy}
                    selectedBranch={gitPanel.branch}
                    now={now}
                    onSelectBranch={gitPanel.selectBranch}
                    onRefresh={gitPanel.refresh}
                    onCreate={(draft) => setForgePrompt({ kind: "create", draft })}
                    onComment={(request) => setForgePrompt({ kind: "comment", number: request.number })}
                    onMerge={(request, strategy) => {
                      void gitPanel
                        .merge(request.number, strategy, false)
                        .then(() => toasts.push("forge-merge", "info", t("forge.merged", { n: request.number })))
                        .catch(() => undefined);
                    }}
                  />
                ) : sidePanel.tab === "agents" && delegatedInfo !== null ? (
                  <InfoTab info={delegatedInfo} now={now} onOpen={openThreadFromPanel} />
                ) : sidePanel.tab === "agents" ? (
                  <AgentsTab
                    threads={agentRows}
                    subagents={subagentRows}
                    onOpenSubagent={(agentId) => {
                      if (openThreadId === null) return;
                      setFocus("chat");
                      subagentView.open(openThreadId, agentId);
                    }}
                    {...(canStopSubagent ? { onStopSubagent: stopSubagent } : {})}
                    now={now}
                    onOpen={openThreadFromPanel}
                  />
                ) : sidePanel.tab === "context" ? (
                  <ContextTab
                    breakdown={effectiveBreakdown}
                    fallback={threadState.contextUsage}
                    live={contextLive}
                    usageLimits={threadUsageLimits}
                    providerName={currentProvider?.displayName ?? null}
                    width={diffPanel.diffWidth}
                    now={now}
                  />
                ) : (
                  <BackgroundTab
                    tasks={background}
                    width={diffPanel.diffWidth}
                    now={now}
                    onOpen={() => setPicker("background-tasks")}
                    onStop={(taskId) => {
                      const task = background.find((row) => row.taskId === taskId);
                      if (task !== undefined) stopBackgroundTask(task);
                    }}
                  />
                )}
              </SidePanelFrame>
            )}
          </box>
        )}
      </box>
      ) : (
        <LoadingScreen stage={bootLoadingStage(shell, providersReady)} />
      )}
      {toasts.toasts.map((toast, index) => (
        <box
          key={toast.id}
          style={{
            position: "absolute",
            top: 1 + index * TOAST_STEP,
            left: toastGeometry.left,
            width: toastGeometry.width,
            flexDirection: "column",
            flexShrink: 0,
            paddingLeft: 2,
            paddingRight: 2,
            // Single-row while over the side panel: the tab strip already
            // owns row 0, so a padded toast would cover the first content
            // rows (the frame tabs start at row 1 with no spacer). In the
            // chat pane the breathing room stays.
            paddingTop: sidePanelOpen ? 0 : 1,
            paddingBottom: sidePanelOpen ? 0 : 1,
            // Above every modal layer, so errors fired from inside a modal
            // (copy/dispatch failures) stay visible instead of hiding behind it.
            zIndex: 35,
          }}
          border={["left"]}
          borderStyle="heavy"
          borderColor={
            toast.tone === "danger" ? pulseColor(now, TOAST_COLOR.danger, COLOR.bright, 1600) : TOAST_COLOR[toast.tone]
          }
          backgroundColor={SURFACE.raised}
        >
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
            <text fg={TOAST_COLOR[toast.tone]} bg={SURFACE.raised} selectable={false}>
              {truncate(toast.text, Math.max(10, toastGeometry.width - 8 - (toast.action === null ? 0 : toast.action.label.length + 3)))}
            </text>
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
              {toast.action === null ? null : (
                <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false} onMouseDown={toast.action.onClick}>
                  {` ${toast.action.label} `}
                </text>
              )}
              <text
                fg={COLOR.faint}
                bg={SURFACE.raised}
                selectable={false}
                onMouseDown={() => {
                  // Manual dismiss removes the overlay on mouse-down while the
                  // matching mouse-up lands on whatever timeline row sits
                  // underneath the × — same swallow window as a modal dismiss
                  // so it doesn't instantly act on it (message actions).
                  markModalDismissed();
                  toasts.dismiss(toast.id);
                }}
              >
                {" ×"}
              </text>
            </box>
          </box>
        </box>
      ))}
      {/* Outside the picker chain below: the Git tab asks for these
          without opening a picker, so nested under it they never showed. */}
      {forgePrompt !== null ? (
        <RenameModal
          initialTitle=""
          title={
            forgePrompt.kind === "create"
              ? t(forgePrompt.draft ? "forge.openDraft" : "forge.open", { what: requestNoun(gitPanel.forge?.kind ?? null).long })
              : t("forge.commentOn", { n: forgePrompt.number })
          }
          placeholder={forgePrompt.kind === "create" ? t("forge.titleField") : t("forge.commentField")}
          hint={
            forgePrompt.kind === "create"
              ? t("app.enter_opens_it_on_198d")
              : t("app.enter_posts_the_comment_a64c")
          }
          maxLength={forgePrompt.kind === "create" ? 120 : 2000}
          screenWidth={width}
          screenHeight={height}
          left={renameGeometry.left}
          top={renameGeometry.top}
          width={renameGeometry.width}
          height={renameGeometry.height}
          onSubmit={(value) => {
            const text = value.trim();
            const prompt = forgePrompt;
            setForgePrompt(null);
            if (text.length === 0 || prompt === null) return;
            if (prompt.kind === "create") {
              void gitPanel
                .createRequest({ title: text, draft: prompt.draft })
                .then((url) => toasts.push("forge-create", "info", url ?? t("app.request_opened_3e0b")))
                .catch(() => undefined);
              return;
            }
            void gitPanel
              .commentOn(prompt.number, text)
              .then(() => toasts.push("forge-comment", "info", t("forge.commented", { n: prompt.number })))
              .catch(() => undefined);
          }}
          onClose={() => setForgePrompt(null)}
        />
      ) : null}
      {sideQuestion.open && sideQuestion.current !== null ? (
        <SideQuestionModal
          entry={sideQuestion.current}
          onCopy={(text) => {
            void clipboard.copyText(text).then((ok) => toasts.push("btw-copy", "info", ok ? t("app.answer_copied_5124") : t("app.could_not_copy_fa4b"), COPY_TOAST_MS));
          }}
          screenWidth={width}
          screenHeight={height}
          left={backgroundGeometry.left}
          top={backgroundGeometry.top}
          width={backgroundGeometry.width}
          height={backgroundGeometry.height}
          onClose={sideQuestion.close}
        />
      ) : null}
      {picker === null ? null : picker === "rename" ? (
        <RenameModal
          initialTitle={selected === null ? "" : String(selected.title ?? "")}
          screenWidth={width}
          screenHeight={height}
          left={renameGeometry.left}
          top={renameGeometry.top}
          width={renameGeometry.width}
          height={renameGeometry.height}
          onSubmit={submitRename}
          onClose={() => closePicker(paletteReturnFocus)}
        />
      ) : picker === "answer-custom" ? (
        <RenameModal
          initialTitle=""
          title={t("app.custom_answer_4461")}
          placeholder={t("app.type_an_answer_7f9c")}
          hint={t("app.enter_submits_esc_back_a9c6")}
          maxLength={500}
          screenWidth={width}
          screenHeight={height}
          left={renameGeometry.left}
          top={renameGeometry.top}
          width={renameGeometry.width}
          height={renameGeometry.height}
          onSubmit={submitCustomAnswer}
          onClose={() => setPicker(null)}
        />
      ) : picker === "project-new" ? (
        <RenameModal
          initialTitle={remote ? "" : process.cwd()}
          title={remote ? t("project.newOnServer", { server: server.name }) : t("app.new_project_from_local_658f")}
          placeholder={remote ? t("app.folder_path_on_the_9c48") : t("app.folder_path_fdde")}
          hint={t("app.enter_creates_esc_back_1830")}
          maxLength={500}
          screenWidth={width}
          screenHeight={height}
          left={pickerGeometry.left}
          top={pickerGeometry.top}
          width={pickerGeometry.width}
          height={pickerGeometry.height}
          onSubmit={submitProjectFolder}
          onClose={() => {
            setPickerFilter("");
            setPicker("project");
          }}
        />
      ) : picker === "remote-pair-address" ? (
        <RenameModal
          initialTitle={remoteAccess.pairAddress}
          title={t("app.pair_with_a_server_b674")}
          placeholder={t("app.its_address_eg_19216812047317_d9d2")}
          hint={t("app.enter_next_esc_cancels_b9b2")}
          maxLength={200}
          screenWidth={width}
          screenHeight={height}
          left={renameGeometry.left}
          top={renameGeometry.top}
          width={renameGeometry.width}
          height={renameGeometry.height}
          onSubmit={(address) => {
            if (address.trim().length === 0) return;
            remoteAccess.setPairAddress(address.trim());
            setPicker("remote-pair-code");
          }}
          onClose={() => closePicker(paletteReturnFocus)}
        />
      ) : picker === "remote-pair-code" ? (
        <RenameModal
          initialTitle=""
          title={t("pair.step2", { address: remoteAccess.pairAddress })}
          placeholder={t("app.the_code_it_shows_d137")}
          hint={t("app.enter_pairs_and_connects_e584")}
          maxLength={20}
          screenWidth={width}
          screenHeight={height}
          left={renameGeometry.left}
          top={renameGeometry.top}
          width={renameGeometry.width}
          height={renameGeometry.height}
          onSubmit={(code) => {
            if (code.trim().length === 0) return;
            closePicker(paletteReturnFocus);
            remoteAccess.pair(code.trim());
          }}
          onClose={() => closePicker(paletteReturnFocus)}
        />
      ) : picker === "remote-code" && remoteAccess.pairing !== null ? (
        <PairingCodeModal
          pairing={remoteAccess.pairing}
          serverName={server?.name ?? null}
          screenWidth={width}
          screenHeight={height}
          left={Math.max(0, Math.floor((width - Math.min(76, Math.max(30, width - 6))) / 2))}
          top={Math.max(0, Math.floor((height - PAIRING_PANEL_HEIGHT) / 2))}
          width={Math.min(76, Math.max(30, width - 6))}
          height={PAIRING_PANEL_HEIGHT}
          onClose={() => {
            remoteAccess.closePairing();
            closePicker(paletteReturnFocus);
          }}
        />
      ) : picker === "schedule" ? (
        <DateTimeModal
          screenWidth={width}
          screenHeight={height}
          left={renameGeometry.left}
          top={Math.max(0, Math.floor((height - SCHEDULE_PANEL_HEIGHT) / 2))}
          width={renameGeometry.width}
          height={SCHEDULE_PANEL_HEIGHT}
          onSubmit={(at) => {
            closePicker("composer");
            send(draft, "queue", at);
          }}
          onClose={() => closePicker("composer")}
        />
      ) : picker === "settings" ? (
        <SettingsModal
          snapshot={settings.snapshot}
          loading={settings.loading}
          saving={settings.saving}
          error={settings.error}
          onSet={settings.set}
          onDuplicate={settings.duplicate}
          run={settings.run}
          onTest={settings.test}
          onTestMcp={settings.testMcp}
          onProbe={settings.probe}
          onDiscover={settings.discover}
          onExport={settings.exportProfile}
          onImport={settings.importProfile}
          notice={settings.notice}
          versions={providerVersions.versions}
          latest={providerVersions.latest}
          updating={providerUpdates.updating}
          onUpdate={providerUpdates.update}
          providers={providers}
          screenWidth={width}
          screenHeight={height}
          left={backgroundGeometry.left}
          top={backgroundGeometry.top}
          width={backgroundGeometry.width}
          height={backgroundGeometry.height}
          onClose={() => setPicker(null)}
        />
      ) : picker === "stats" ? (
        <StatsModal
          client={client}
          providers={providers}
          screenWidth={width}
          screenHeight={height}
          left={backgroundGeometry.left}
          top={backgroundGeometry.top}
          width={backgroundGeometry.width}
          height={backgroundGeometry.height}
          onClose={() => setPicker(null)}
          onCopyCard={copyStatsCard}
        />
      ) : picker === "background-tasks" && selected !== null ? (
        <BackgroundTasksModal
          tasks={background}
          client={client}
          threadId={selected.id}
          screenWidth={width}
          screenHeight={height}
          left={backgroundGeometry.left}
          top={backgroundGeometry.top}
          width={backgroundGeometry.width}
          height={backgroundGeometry.height}
          onClose={() => setPicker(null)}
          onStop={stopBackgroundTask}
        />
      ) : (
        <PickerModal
          key={picker}
          title={
            picker === "model"
              ? creating
                ? t("app.select_model_8631")
                : t("picker.selectModelOf", { provider: 
                    providers?.find((candidate) => candidate.instanceId === effectiveModelSelection?.instanceId)
                      ?.displayName ?? t("app.current_provider_8fb0")
                  })
              : picker === "effort"
                ? t("app.select_effort_bd9e")
                : picker === "permission"
                  ? t("app.select_permission_a040")
                  : picker === "diff-turn"
                  ? t("app.select_diff_turn_4e9d")
                  : picker === "command"
                    ? t("app.command_palette_f8f1")
                    : picker === "search"
                      ? t("app.search_threads_c202")
                    : picker === "project"
                      ? t("app.select_project_74f5")
                      : picker === "remote-servers"
                        ? t("app.switch_server_5f7e")
                        : picker === "remote-devices"
                          ? t("paired.title", { server: server?.name ?? t("paired.thisMachine") })
                          : t("app.message_actions_c02b")
          }
          body={pickerBody}
          filter={pickerFilter}
          onFilterChange={setPickerFilter}
          filterable={picker === "model" || picker === "command" || picker === "message" || picker === "project" || picker === "search"}
          prefiltered={picker === "search"}
          emptyLabel={
            picker === "model"
              ? pickerFilter.trim().length > 0
                ? t("app.no_matching_models_74d5")
                : t("app.no_models_reported_by_5ee3")
              : picker === "effort"
                ? t("app.no_effort_options_for_3666")
                : picker === "permission"
                  ? t("app.no_permission_levels_for_3b4a")
                  : picker === "diff-turn"
                  ? t("app.no_turns_with_changes_8d93")
                  : picker === "command"
                    ? t("app.no_matching_commands_fad4")
                    : picker === "search"
                      ? pickerFilter.trim().length === 0
                        ? t("app.type_to_search_titles_d943")
                        : t("app.no_threads_match_75a6")
                    : picker === "project"
                      ? t("app.no_projects_reported_by_55f1")
                      : picker === "remote-devices"
                        ? t("app.no_paired_devices_be24")
                        : t("app.no_actions_b08d")
          }
          screenWidth={width}
          screenHeight={height}
          left={(picker === "message" ? messageGeometry : picker === "effort" ? effortGeometry : pickerGeometry).left}
          top={(picker === "message" ? messageGeometry : picker === "effort" ? effortGeometry : pickerGeometry).top}
          width={(picker === "message" ? messageGeometry : picker === "effort" ? effortGeometry : pickerGeometry).width}
          height={(picker === "message" ? messageGeometry : picker === "effort" ? effortGeometry : pickerGeometry).height}
            onClose={() =>
              closePicker(
                picker === "diff-turn" ? "diff" : picker === "message" ? "chat" : picker === "command" || picker.startsWith("remote-") ? paletteReturnFocus : "composer",
              )
            }
          />
        )}
      {quitConfirmOpen ? (
        <ModalShell
          screenWidth={width}
          screenHeight={height}
          left={quitGeometry.left}
          top={quitGeometry.top}
          width={quitGeometry.width}
          height={quitGeometry.height}
          onClose={closeQuitConfirm}
        >
          <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <text fg={COLOR.bright} selectable={false}>{t("quit.title")}</text>
            <box style={{ height: 1, flexShrink: 0 }} />
            <text fg={COLOR.dim} selectable={false}>
              {selected === null
                ? t("quit.noThread")
                : t("quit.openThread", { title: truncate(String(selected.title ?? selected.id), Math.max(10, quitGeometry.width - 4)) })}
            </text>
            <text fg={COLOR.dim} selectable={false}>{t("quit.promptCleared")}</text>
            <box style={{ flexGrow: 1 }} />
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "flex-end" }}>
              <text
                fg={COLOR.dim}
                bg={quitCancelHover.hovered ? SURFACE.hover : SURFACE.raised}
                selectable={false}
                onMouseDown={closeQuitConfirm}
                {...quitCancelHover.handlers}
              >
                {t("quit.cancel")}
              </text>
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{"  "}</text>
              <text
                fg={COLOR.danger}
                bg={quitConfirmHover.hovered ? SURFACE.hover : SURFACE.raised}
                selectable={false}
                onMouseDown={onQuit}
                {...quitConfirmHover.handlers}
              >
                {t("quit.confirm")}
              </text>
            </box>
          </box>
        </ModalShell>
      ) : null}
      {editingExternally ? (
        // The external editor owns the terminal now: keep rendering the app
        // underneath, but swallow every mouse event behind this invisible
        // catcher so nothing clickable fires until the editor closes. Keys
        // are already gated via `editingExternally`. The state itself is
        // shown by the composer's own centered overlay — this shield carries
        // no message of its own.
        <box
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width,
            height,
            flexDirection: "column",
            zIndex: 40,
          }}
          selectable={false}
          onMouseDown={() => {}}
        />
      ) : null}
      <ImageViewerDim screenWidth={width} screenHeight={height} />
      <ImagePreviewLayer screenWidth={width} screenHeight={height} />
    </box>
  );
}

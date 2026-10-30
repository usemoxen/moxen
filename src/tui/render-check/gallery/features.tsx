import { AnswerPanel } from "../../features/answerpanel/answerpanel.js";
import { SideQuestionModal } from "../../features/btw/sidequestionmodal.js";
import type { SideQuestion } from "../../features/btw/useSideQuestion.js";
import { Composer } from "../../features/composer/composer.js";
import { ImagePreviewLayer } from "../../features/timeline/imagepreview.js";
import { PathChips } from "../../features/composer/pathchips.js";
import { closeImageViewer, ImageViewer, ImageViewerDim, openImageViewer } from "../../features/timeline/imageviewer.js";
import { AttachmentReaderContext, AttachmentRow, type AttachmentReader } from "../../features/timeline/attachmentrow.js";
import { solidPng } from "../png.js";
import { SURFACE } from "../../theme.js";
import { PermissionPanel } from "../../features/permissionpanel/permissionpanel.js";
import { QueuedPanel } from "../../features/queuedpanel/queuedpanel.js";
import { PAIRING_PANEL_HEIGHT, PairingCodeModal } from "../../features/remote/codemodal.js";
import { SubagentBar } from "../../features/subagentview/subagentbar.js";
import { BackgroundTasksModal } from "../../features/taskspanel/backgroundtasksmodal.js";
import { StatsModal } from "../../features/stats/statsmodal.js";
import type { UsageStats } from "../../model/stats.js";
import { PickerModal, type PickerBody } from "../../features/pickers/pickermodal.js";
import { SkillPicker } from "../../features/composer/skillpicker.js";
import { MinSizeGate } from "../../ui/terminalgate.js";
import type { SkillSummary } from "../../../core/catalog/summary.js";
import type { ClientApi } from "../../../server/api.js";
import type { BackgroundTaskRow } from "../../model/thread.js";
import { TasksPanel } from "../../features/taskspanel/taskspanel.js";
import type { InteractionMode } from "../../../core/types.js";
import type { QueuedMessage } from "../../model/thread.js";
import { Pager } from "../../ui/noticebanner.js";
import { act } from "react";
import { Caption, Stage, type GalleryEntry } from "./registry.js";

const noop = (): void => {};
const GALLERY_PNG = solidPng(240, 120, [64, 140, 220, 255]);
const GALLERY_IMAGE_READER: AttachmentReader = async () => ({ mimeType: "image/png", dataUrl: `data:image/png;base64,${GALLERY_PNG.toString("base64")}` });
const SCROLL = { current: null };
const skill = (name: string, description: string | null, overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  name,
  description,
  displayName: null,
  shortDescription: null,
  enabled: true,
  userInvocationOnly: false,
  userInvocable: true,
  ...overrides,
});
const SKILLS = [
  skill("review", "Review the current diff for correctness bugs and say what you would change before it merges."),
  skill("simplify", "Review the changed code for reuse, simplification and efficiency, then apply the fixes."),
  skill("run", null),
  skill("security-review", "Complete a security review of the pending changes on the current branch", { userInvocationOnly: true }),
];

const TASKS: readonly BackgroundTaskRow[] = [
  { taskId: "b1", taskType: "local_bash", description: "Dev server", toolName: "Bash", command: "bun run dev --port 4000", startedAt: "2026-09-26T09:48:00.000Z" },
  { taskId: "b2", taskType: "local_bash", description: "Watch the build for errors", toolName: "Monitor", command: null, startedAt: "2026-09-26T09:59:00.000Z" },
  { taskId: "b3", taskType: "local_agent", description: "Explore: where the themes are applied", toolName: "Agent", command: null, startedAt: null },
];
const TASK_CLIENT = { query: async () => ({ available: true, lines: ["$ bun run dev --port 4000", "listening on http://localhost:4000", "GET / 200 4ms"] }) } as unknown as Pick<ClientApi, "query">;

const STATS_NOW = new Date(2026, 9, 29, 12, 0, 0);
const STATS_DAILY: UsageStats["daily"] = Array.from({ length: 40 }, (_, index) => {
  const date = new Date(2026, 9, 29 - (39 - index));
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const busy = (index * 7) % 5 === 0 ? 0 : 1 + ((index * 3) % 6);
  const opus = busy * 90_000_000;
  const sonnet = (index % 3) * 40_000_000;
  return { day, tokens: opus + sonnet, byModel: { "claude-opus-5-5": opus, "claude-sonnet-5": sonnet }, byProvider: { claudeAgent: opus + sonnet } };
}).filter((entry) => entry.tokens > 0);
const bucket = (key: string, tokens: number, share: number, costUsd: number | null, sessions: number): UsageStats["byModel"][number] => ({
  key,
  usage: { input: Math.round(tokens * 0.01), cacheRead: Math.round(tokens * 0.9), cacheCreate: Math.round(tokens * 0.05), output: Math.round(tokens * 0.03), thinking: Math.round(tokens * 0.01), turns: sessions * 3 },
  tokens,
  share,
  sessions,
  costUsd,
  unpricedTurns: costUsd === null ? sessions * 3 : 0,
});
const STATS: UsageStats = {
  range: "all",
  sessions: 113,
  messages: 37_853,
  turns: 684,
  totals: { input: 1_200_000, cacheRead: 5_640_000_000, cacheCreate: 19_700_000, output: 17_900_000, thinking: 2_000_000, turns: 684 },
  totalTokens: 5_800_000_000,
  costUsd: 467.93,
  unpricedTurns: 12,
  activeDays: STATS_DAILY.length,
  bestStreak: 8,
  peakHour: 5,
  favoriteModel: "claude-opus-5-5",
  byProvider: [bucket("claudeAgent", 1_400_000_000, 0.241, 467.93, 69), bucket("opencode", 4_400_000_000, 0.758, null, 207), bucket("harness/colab", 3_360_000, 0.001, null, 1)],
  byModel: [bucket("claude-opus-5-5", 754_000_000, 0.55, 261.59, 40), bucket("claude-sonnet-5", 443_000_000, 0.32, 107.93, 29), bucket("opencode/space-bunny-free", 2_620_000_000, 0.13, null, 150)],
  daily: STATS_DAILY,
};
const STATS_CLIENT = { query: async () => STATS } as unknown as Pick<ClientApi, "query">;
const STATS_WEEK_CLIENT = { query: async (query: { range?: string }) => (query.range === "7d" ? { ...STATS, range: "7d", daily: STATS_DAILY.slice(-5), sessions: 9, turns: 40, totalTokens: 900_000_000 } : STATS) } as unknown as Pick<ClientApi, "query">;
const STATS_EMPTY_CLIENT = { query: async () => ({ ...STATS, sessions: 0, turns: 0, totalTokens: 0, daily: [], byModel: [], byProvider: [] }) } as unknown as Pick<ClientApi, "query">;
const statsModal = (client: Pick<ClientApi, "query">) => (
  <Stage width={100} height={34}>
    <StatsModal client={client} providers={null} screenWidth={100} screenHeight={34} left={2} top={1} width={96} height={32} now={STATS_NOW} onClose={noop} onCopyCard={noop} />
  </Stage>
);
const afterLoad = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

const picker = (id: string, title: string, body: PickerBody, filter = "", height = 16, filterable = true): GalleryEntry => ({
  id,
  group: "pickers",
  title,
  width: 80,
  height: height + 4,
  settleMs: 250,
  element: () => (
    <Stage width={80} height={height + 4}>
      <PickerModal title="Pick a model" body={body} filter={filter} onFilterChange={noop} filterable={filterable} emptyLabel="Nothing matches" screenWidth={80} screenHeight={height + 4} left={8} top={2} width={64} height={height} onClose={noop} />
    </Stage>
  ),
});

const NOW = Date.parse("2026-09-26T10:00:00.000Z");

const QUEUED: readonly QueuedMessage[] = [
  { turnId: "t1", messageId: "m1", text: "Also update the changelog", attachments: 0, scheduledFor: null, reason: null },
  { turnId: "t2", messageId: "m2", text: "Run the full suite after", attachments: 1, scheduledFor: "2026-09-26T12:00:00.000Z", reason: "user" },
  { turnId: "t3", messageId: "m3", text: "Then open the PR", attachments: 0, scheduledFor: "2026-09-26T15:01:00.000Z", reason: "usage-hold" },
];

const side = (overrides: Partial<SideQuestion>): SideQuestion => ({
  id: 1,
  threadId: "t",
  question: "Which auth scheme did we settle on?",
  status: "answered",
  answer: "JWTs, verified in `src/auth.ts`. Sessions expire after **12 hours**.",
  error: null,
  withContext: true,
  ...overrides,
});

const composer = (width: number, mode: InteractionMode, draft: string, running: boolean) => (
  <Composer
    draft={draft}
    resetKey={`${mode}-${draft}-${running}`}
    onInput={noop}
    onSubmit={noop}
    onEscape={noop}
    onFocus={noop}
    focused
    placeholder="Message the agent"
    model="Claude Opus 5"
    permission="Full access"
    submitVerb="sends"
    running={running}
    width={width}
    mode={mode}
    onCycleMode={noop}
  />
);

export const FEATURE_GALLERY: GalleryEntry[] = [
  {
    id: "composer-modes",
    group: "composer",
    title: "Composer, one per mode",
    width: 100,
    height: 34,
    element: () => (
      <Stage width={100} height={34}>
        {composer(100, "default", "", false)}
        {composer(100, "research", "How does the diff panel decide which file to open?", false)}
        {composer(100, "orchestrate", "Split the migration across three agents", true)}
      </Stage>
    ),
  },
  {
    id: "tasks-panel",
    group: "taskspanel",
    title: "TasksPanel",
    width: 90,
    height: 8,
    element: () => (
      <Stage width={90} height={8}>
        <TasksPanel
          plan={{
            items: [
              { content: "Collapse tool rows", status: "completed" },
              { content: "Render unified diffs", status: "inProgress" },
              { content: "Verify with render check", status: "pending" },
            ],
            at: "2026-09-25T10:00:00.000Z",
          }}
          width={90}
        />
      </Stage>
    ),
  },
  {
    id: "queued-panel",
    group: "queuedpanel",
    title: "QueuedPanel",
    width: 90,
    height: 8,
    element: () => (
      <Stage width={90} height={8}>
        <QueuedPanel items={QUEUED} width={90} now={NOW} onCancel={noop} pager={<Pager position={0} count={2} onPage={noop} />} />
      </Stage>
    ),
  },
  {
    id: "permission-panel",
    group: "permissionpanel",
    title: "PermissionPanel",
    width: 90,
    height: 12,
    element: () => (
      <Stage width={90} height={12}>
        <PermissionPanel
          request={{ requestId: "r1", toolName: "Bash", classification: "Shell", detail: "bun run check", description: "Run the project's full check" }}
          width={90}
          suspended={false}
          onDecide={noop}
        />
      </Stage>
    ),
  },
  {
    id: "answer-panel",
    group: "answerpanel",
    title: "AnswerPanel",
    width: 90,
    height: 16,
    element: () => (
      <Stage width={90} height={16}>
        <AnswerPanel
          question={{
            id: "q1",
            header: "Theme",
            question: "Which theme should ship first?",
            options: [
              { label: "Catppuccin Mocha", description: "The most requested dark flavour", value: "mocha", preview: null },
              { label: "Dracula", description: "High contrast, purple accent", value: "dracula", preview: null },
              { label: "Nord", description: null, value: "nord", preview: null },
            ],
            multiSelect: false,
            allowCustomAnswer: true,
          }}
          position={0}
          total={2}
          width={90}
          suspended={false}
          pickedValues={[]}
          tabs={[
            { header: "Theme", answered: false },
            { header: "Scope", answered: true },
          ]}
          onGoto={noop}
          onToggleOption={noop}
          onPickOption={noop}
          onCustom={noop}
          onContinue={noop}
          onDismiss={noop}
        />
      </Stage>
    ),
  },
  {
    id: "subagent-bar",
    group: "subagentview",
    title: "SubagentBar",
    width: 100,
    height: 6,
    element: () => (
      <Stage width={100} height={6}>
        <SubagentBar title="Explore: where the themes are applied" state="finished in 13s" width={100} onBack={noop} />
        <Caption text="narrow" />
        <SubagentBar title="Explore: where the themes are applied" state="running" width={44} onBack={noop} />
      </Stage>
    ),
  },
  {
    id: "side-question-modal",
    group: "btw",
    title: "SideQuestionModal",
    width: 80,
    height: 20,
    settleMs: 250,
    element: () => (
      <Stage width={80} height={20}>
        <SideQuestionModal entry={side({})} onCopy={noop} screenWidth={80} screenHeight={20} left={4} top={2} width={72} height={16} onClose={noop} />
      </Stage>
    ),
  },
  {
    id: "side-question-asking",
    group: "btw",
    title: "SideQuestionModal, still asking",
    width: 80,
    height: 12,
    settleMs: 250,
    element: () => (
      <Stage width={80} height={12}>
        <SideQuestionModal entry={side({ status: "asking", answer: null })} onCopy={noop} screenWidth={80} screenHeight={12} left={4} top={1} width={72} height={10} onClose={noop} />
      </Stage>
    ),
  },
  {
    id: "side-question-failed",
    group: "btw",
    title: "SideQuestionModal, failed",
    width: 80,
    height: 12,
    settleMs: 250,
    element: () => (
      <Stage width={80} height={12}>
        <SideQuestionModal entry={side({ status: "failed", answer: null, error: "The provider is not running." })} onCopy={noop} screenWidth={80} screenHeight={12} left={4} top={1} width={72} height={10} onClose={noop} />
      </Stage>
    ),
  },
  {
    id: "pairing-code-modal",
    group: "remote",
    title: "PairingCodeModal",
    width: 90,
    height: 24,
    settleMs: 250,
    element: () => (
      <Stage width={90} height={24}>
        <PairingCodeModal
          pairing={{ code: "ABCD-EFGH", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), addresses: ["192.168.1.236:47317"], fingerprint: "AB:CD:EF:01:23:45:67:89" }}
          serverName={null}
          screenWidth={90}
          screenHeight={24}
          left={7}
          top={3}
          width={76}
          height={PAIRING_PANEL_HEIGHT}
          onClose={noop}
        />
      </Stage>
    ),
  },
  picker("picker-modal-list", "PickerModal, a list", {
    kind: "list",
    sections: [
      { header: "Claude", rows: [
        { key: "o", label: "Claude Opus 5", meta: "The most capable model, for hard problems", badge: "default", selected: true, onPick: noop },
        { key: "s", label: "Claude Sonnet 5.5", meta: "Fast and capable", onPick: noop },
        { key: "r", label: "Claude Retired 3", meta: "No longer offered", disabled: true, onPick: noop },
      ] },
      { header: "OpenCode", headerColor: "#c0c0c0", rows: [{ key: "g", label: "GPT-5.5", onPick: noop }, { key: "k", label: "Kimi K3", onPick: noop }] },
    ],
  }),
  picker("picker-modal-filtered", "PickerModal, filtered to nothing", { kind: "list", sections: [{ rows: [] }] }, "zzz", 10),
  picker("picker-modal-loading", "PickerModal, loading", { kind: "loading" }, "", 8, false),
  picker("picker-modal-error", "PickerModal, error", { kind: "error", message: "The provider is not running." }, "", 8, false),
  picker("picker-modal-sliders", "PickerModal, sliders", {
    kind: "sliders",
    sliders: [{
      key: "effort",
      header: "Reasoning effort",
      effort: true,
      current: "high",
      stops: [{ key: "low", label: "low" }, { key: "medium", label: "medium", isDefault: true }, { key: "high", label: "high" }, { key: "max", label: "max" }],
      onPick: noop,
    }],
  }, "", 14, false),
  {
    id: "skill-picker",
    group: "composer",
    title: "SkillPicker, matches / none / no catalog",
    width: 80,
    height: 20,
    element: () => (
      <Stage width={80} height={20}>
        <SkillPicker matches={SKILLS} query="" activeIndex={1} marqueeTick={0} width={78} rows={4} hasCatalog scrollRef={SCROLL} onPick={noop} onHover={noop} />
        <Caption text="query" />
        <SkillPicker matches={[SKILLS[1]!]} query="simp" activeIndex={0} marqueeTick={0} width={78} rows={1} hasCatalog scrollRef={SCROLL} onPick={noop} onHover={noop} />
        <Caption text="nothing matches" />
        <SkillPicker matches={[]} query="zzz" activeIndex={-1} marqueeTick={0} width={78} rows={0} hasCatalog scrollRef={SCROLL} onPick={noop} onHover={noop} />
        <Caption text="no skills at all" />
        <SkillPicker matches={[]} query="" activeIndex={-1} marqueeTick={0} width={78} rows={0} hasCatalog={false} scrollRef={SCROLL} onPick={noop} onHover={noop} />
      </Stage>
    ),
  },
  {
    id: "background-tasks-modal",
    group: "taskspanel",
    title: "BackgroundTasksModal",
    width: 90,
    height: 20,
    settleMs: 250,
    element: () => (
      <Stage width={90} height={20}>
        <BackgroundTasksModal tasks={TASKS} client={TASK_CLIENT} threadId="t" screenWidth={90} screenHeight={20} left={5} top={2} width={80} height={16} onClose={noop} onStop={noop} />
      </Stage>
    ),
  },
  {
    id: "stats-overview",
    group: "stats",
    title: "StatsModal, overview",
    width: 100,
    height: 34,
    settleMs: 400,
    element: () => statsModal(STATS_CLIENT),
  },
  {
    id: "stats-models",
    group: "stats",
    title: "StatsModal, models",
    width: 100,
    height: 34,
    settleMs: 400,
    element: () => statsModal(STATS_CLIENT),
    drive: async (setup) => {
      await act(async () => setup.mockInput.pressTab());
      await afterLoad();
      await setup.flush();
    },
  },
  {
    id: "stats-week",
    group: "stats",
    title: "StatsModal, 7d: earlier days stay in grey",
    width: 100,
    height: 34,
    settleMs: 400,
    element: () => statsModal(STATS_WEEK_CLIENT),
    drive: async (setup) => {
      await act(async () => setup.mockInput.pressKey("r"));
      await act(async () => setup.mockInput.pressKey("r"));
      await afterLoad();
      await setup.flush();
    },
  },
  {
    id: "stats-empty",
    group: "stats",
    title: "StatsModal, no usage yet",
    width: 100,
    height: 34,
    settleMs: 400,
    element: () => statsModal(STATS_EMPTY_CLIENT),
  },
  {
    id: "min-size-gate",
    group: "ui",
    title: "MinSizeGate, terminal too small",
    width: 60,
    height: 10,
    element: () => (
      <Stage width={60} height={10}>
        <MinSizeGate onQuit={noop}>
          <text>The app, underneath.</text>
        </MinSizeGate>
      </Stage>
    ),
  },
  {
    id: "attachment-rows",
    group: "timeline",
    title: "AttachmentRow, an attached image is a name row",
    width: 60,
    height: 4,
    element: () => (
      <Stage width={60} height={4}>
        <AttachmentRow attachmentId="a" label="clipboard-1793333172202.png" sizeBytes={1048576} background={SURFACE.base} />
        <AttachmentRow attachmentId={null} label="screenshot.png" sizeBytes={null} background={SURFACE.base} />
      </Stage>
    ),
  },
  {
    id: "image-preview",
    group: "timeline",
    title: "ImagePreviewLayer, hovering an attachment shows the image beside it",
    width: 80,
    height: 30,
    element: () => (
      <AttachmentReaderContext.Provider value={GALLERY_IMAGE_READER}>
        <Stage width={80} height={30}>
          <box style={{ height: 12, flexShrink: 0 }} />
          <AttachmentRow attachmentId="a" label="clipboard-1793333172202.png" sizeBytes={1048576} background={SURFACE.base} />
        </Stage>
        <ImagePreviewLayer screenWidth={80} screenHeight={30} />
      </AttachmentReaderContext.Provider>
    ),
    drive: async (setup) => {
      closeImageViewer(); // the viewer entry's open image would hide this preview
      await act(async () => {
        await setup.mockMouse.moveTo(4, 12);
        for (let waited = 0; waited < 500; waited += 25) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          await setup.flush();
        }
      });
    },
  },
  {
    id: "image-viewer",
    group: "timeline",
    title: "ImageViewer, a sent image full screen in place of the transcript",
    width: 80,
    height: 24,
    element: () => {
      const image = { mimeType: "image/png", bytes: new Uint8Array(GALLERY_PNG), size: { width: 240, height: 120 }, label: "clipboard-1793333172202.png", sizeBytes: 1048576 };
      return (
        <>
          <Stage width={80} height={24}>
            <text>{"the thread, dimmed around the viewer"}</text>
            <box style={{ flexGrow: 1, paddingLeft: 6, paddingRight: 6 }}>
              <ImageViewer image={image} onClose={noop} onOpenExternally={noop} />
            </box>
            <text>{"the composer, kept bright"}</text>
          </Stage>
          <ImageViewerDim screenWidth={80} screenHeight={24} />
        </>
      );
    },
    drive: async () => {
      openImageViewer({ mimeType: "image/png", bytes: new Uint8Array(GALLERY_PNG), size: { width: 240, height: 120 }, label: "clipboard-1793333172202.png", sizeBytes: 1048576 });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    },
  },
  {
    id: "path-chips",
    group: "composer",
    title: "PathChips, files and folders attached to the next message",
    width: 70,
    height: 3,
    element: () => (
      <Stage width={70} height={3}>
        <PathChips
          items={[
            { path: "/Users/me/My Docs/report-final-v2.pdf", kind: "file" },
            { path: "/Users/me/projects/moxen/src", kind: "folder" },
            { path: "/Users/me/a-file-with-a-really-long-name-that-has-to-be-cut-short.txt", kind: "file" },
          ]}
          onRemove={noop}
          width={70}
        />
      </Stage>
    ),
  },
];

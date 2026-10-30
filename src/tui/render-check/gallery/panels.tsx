import type { ForgeRequest, ForgeRequestStatus } from "../../../core/forge/forge.js";
import type { GitOverview } from "../../../core/git/history.js";
import type { ProjectEnvelope, ThreadEnvelope } from "../../../core/types.js";
import { DiffPanel } from "../../features/diffpanel/diffpanel.js";
import { GitTab } from "../../features/gitpanel/gitpanel.js";
import { Sidebar } from "../../features/sidebar/sidebar.js";
import { Timeline } from "../../features/timeline/timeline.js";
import { buildSidebarSections } from "../../model/sidebar.js";
import type { PatchFile } from "../../model/patch.js";
import type { TimelineEntry } from "../../model/thread.js";
import { groupTurns } from "../../model/turns.js";
import { Stage, type GalleryEntry } from "./registry.js";

/** The big panes: the diff, the Git tab, the sidebar and the transcript, each with fixed content. */

const noop = (): void => {};
const NOW = Date.parse("2026-09-26T10:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const SCROLL = { current: null };

// -- Diff ---------------------------------------------------------------------

const patch = (path: string, additions: number, deletions: number): PatchFile => ({
  path,
  filetype: "typescript",
  additions,
  deletions,
  binary: false,
  patch: [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,4 @@",
    " export const A = 1;",
    "-export const B = 2;",
    "+export const B = 3;",
    "+export const C = 4;",
    " export const D = 5;",
    "",
  ].join("\n"),
});

const diffPanel = (files: readonly PatchFile[], loading: boolean, collapsed: ReadonlySet<string>) => (
  <DiffPanel files={files} loading={loading} fileIndex={0} collapsed={collapsed} width={64} turnCount={3} turnTotal={4} height={26} focused scrollRef={SCROLL} onToggleFile={noop} onFocus={noop} onHeaderClick={noop} />
);

// -- Git ----------------------------------------------------------------------

const OVERVIEW: GitOverview = {
  isRepository: true,
  root: "/work/moxen",
  status: { branch: "feature/gallery", detached: false, staged: 1, unstaged: 3, untracked: 2, conflicted: 0 },
  branches: [
    { name: "feature/gallery", current: true, remote: false, upstream: "origin/feature/gallery", ahead: 2, behind: 0, lastCommitDate: ago(20 * MIN), lastCommitSubject: "Gallery entries for the side panel" },
    { name: "main", current: false, remote: false, upstream: "origin/main", ahead: 0, behind: 3, lastCommitDate: ago(5 * HOUR), lastCommitSubject: "AGENTS.md: general guidance" },
    { name: "origin/main", current: false, remote: true, upstream: null, ahead: null, behind: null, lastCommitDate: ago(HOUR), lastCommitSubject: "Show the full task command" },
  ],
  commits: [
    { sha: "a".repeat(40), shortSha: "aaaaaaa", author: "Aaron", authorEmail: "a@example.test", date: ago(20 * MIN), subject: "Gallery entries for the side panel", refs: ["HEAD -> feature/gallery"] },
    { sha: "b".repeat(40), shortSha: "bbbbbbb", author: "Aaron", authorEmail: "a@example.test", date: ago(3 * HOUR), subject: "Component gallery for the visual harness, one sheet per component and theme", refs: [] },
    { sha: "c".repeat(40), shortSha: "ccccccc", author: "Someone Else", authorEmail: "s@example.test", date: ago(30 * HOUR), subject: "Tests: derive the Claude memory folder from the resolved path", refs: ["tag: v0.9.0"] },
  ],
  branch: "feature/gallery",
  defaultBranch: "main",
};

const FORGE = { kind: "github", remoteUrl: "git@github.com:moxen/moxen.git", host: "github.com", slug: "moxen/moxen", cli: "gh", installed: true, authenticated: true, reason: null } as const;

const REQUEST: ForgeRequest = {
  number: 42,
  title: "Component gallery for the visual harness",
  state: "open",
  author: "aaron",
  sourceBranch: "feature/gallery",
  targetBranch: "main",
  url: "https://github.com/moxen/moxen/pull/42",
  createdAt: ago(2 * HOUR),
  updatedAt: ago(10 * MIN),
  reviewDecision: "APPROVED",
  checks: { passed: 5, failed: 1, pending: 1 },
};

const REQUEST_STATUS: ForgeRequestStatus = {
  ...REQUEST,
  runs: [
    { name: "typecheck", state: "passed", url: null },
    { name: "test (ubuntu)", state: "passed", url: null },
    { name: "test (windows)", state: "failed", url: null },
    { name: "visual harness", state: "pending", url: null },
  ],
  mergeable: "mergeable",
  additions: 812,
  deletions: 64,
  changedFiles: 14,
};

const gitTab = (overrides: Partial<Parameters<typeof GitTab>[0]>) => (
  <GitTab
    overview={OVERVIEW}
    forge={FORGE}
    requests={[REQUEST]}
    status={REQUEST_STATUS}
    commitChecks={{}}
    commit={null}
    loadingGit={false}
    loadingForge={false}
    error={null}
    busy={null}
    selectedBranch={null}
    now={NOW}
    opener={{ label: "the agent" }}
    base="main"
    baseChoices={["main", "develop"]}
    onPickBase={noop}
    onSelectBranch={noop}
    onRefresh={noop}
    onAgentOpen={noop}
    onCreate={noop}
    onComment={noop}
    onMerge={noop}
    onOpenCommit={noop}
    onCloseCommit={noop}
    onOpenUrl={noop}
    {...overrides}
  />
);

// -- Sidebar ------------------------------------------------------------------

const project = (id: string, title: string): ProjectEnvelope => ({ id, title, workspaceRoot: `/work/${id}`, defaultModelSelection: null });
const thread = (id: string, projectId: string, title: string, ageMs: number, extra: Partial<ThreadEnvelope> = {}): ThreadEnvelope => ({
  id,
  projectId,
  title,
  archivedAt: null,
  branch: "main",
  updatedAt: ago(ageMs),
  latestUserMessageAt: ago(ageMs),
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  session: { status: "idle", lastError: null },
  ...extra,
} as ThreadEnvelope);

const SHELL = {
  snapshotSequence: 1,
  synchronized: true,
  unhandled: {},
  projects: [project("p1", "moxen"), project("p2", "Xash3D RT Streamline"), project("p3", "vibecheck")],
  threads: [
    thread("a", "p1", "Message delay and scheduling", 14 * MIN),
    thread("b", "p2", "Neural Radiance Cache viability", 4 * HOUR, { hasPendingUserInput: true }),
    thread("c", "p3", "Build VibeCheck backend", 8 * HOUR, { session: { status: "stopped", lastError: "Claude usage limit reached." } as never }),
    thread("d", "p1", "A thread title that is much too long to fit the sidebar at its width", 20 * HOUR, { settledOverride: "settled" }),
    thread("e", "p1", "Ping pong test", 22 * HOUR, { settledOverride: "settled" }),
  ],
};

const sidebar = (mode: "flat" | "grouped", search?: { query: string }) => (
  <Sidebar
    sections={buildSidebarSections(SHELL, { settledExpanded: true, settledLimit: 5, now: NOW, mode })}
    openThreadId="a"
    markedThreadIds={new Set()}
    settledExpanded
    width={36}
    now={NOW}
    height={28}
    screenWidth={100}
    backdrop="static"
    onOpenThread={noop}
    onToggleSettled={noop}
    onShowMore={noop}
    onSelectMode={noop}
    onToggleProject={noop}
    onCycleProject={noop}
    onNewThread={noop}
    panelsOpen
    onTogglePanels={noop}
    onOpenSettings={noop}
    {...(search === undefined ? {} : { search: { query: search.query, results: [], loading: false } as never })}
  />
);

// -- Timeline -----------------------------------------------------------------

const entry = (id: string, kind: TimelineEntry["kind"], text: string, at: number, turnId = "turn-1"): TimelineEntry => ({
  id,
  at: ago(at),
  turnId,
  kind,
  text,
  streaming: false,
  tone: null,
  activityKind: null,
  message: null,
  activity: null,
  checkpoint: null,
  editStats: null,
  proposedPlan: null,
});

const ENTRIES: TimelineEntry[] = [
  entry("u1", "user", "Where are the themes applied, and can the harness show a component alone?", 5 * MIN),
  entry("a1", "assistant", "Themes are applied in `src/tui/theme.ts`.\n\n- `COLOR` holds the text colours\n- `SURFACE` holds the grounds\n\nA component can be drawn alone with the **gallery**.", 4 * MIN),
  entry("u2", "user", "Add the remaining entries.", MIN, "turn-2"),
];

export const PANEL_GALLERY: GalleryEntry[] = [
  {
    id: "diff-panel",
    group: "diffpanel",
    title: "DiffPanel, files / collapsed / loading / none",
    width: 64,
    height: 26,
    element: () => (
      <Stage width={64} height={26}>
        {diffPanel([patch("src/tui/theme.ts", 2, 1), patch("src/tui/features/sidepanel/sidepanel.tsx", 14, 3)], false, new Set(["src/tui/features/sidepanel/sidepanel.tsx"]))}
      </Stage>
    ),
  },
  {
    id: "diff-panel-loading",
    group: "diffpanel",
    title: "DiffPanel, loading",
    width: 64,
    height: 10,
    element: () => <Stage width={64} height={10}>{diffPanel([], true, new Set())}</Stage>,
  },
  {
    id: "diff-panel-empty",
    group: "diffpanel",
    title: "DiffPanel, no files",
    width: 64,
    height: 10,
    element: () => <Stage width={64} height={10}>{diffPanel([], false, new Set())}</Stage>,
  },
  {
    id: "git-tab",
    group: "gitpanel",
    title: "GitTab, with a request",
    width: 60,
    height: 40,
    element: () => <Stage width={60} height={40}>{gitTab({})}</Stage>,
  },
  {
    id: "git-tab-no-forge",
    group: "gitpanel",
    title: "GitTab, no forge, loading and an error",
    width: 60,
    height: 30,
    element: () => <Stage width={60} height={30}>{gitTab({ forge: null, requests: [], status: null, error: "gh: not logged in" })}</Stage>,
  },
  {
    id: "git-tab-loading",
    group: "gitpanel",
    title: "GitTab, loading",
    width: 60,
    height: 12,
    element: () => <Stage width={60} height={12}>{gitTab({ overview: null, loadingGit: true, loadingForge: true, requests: [], status: null })}</Stage>,
  },
  {
    id: "sidebar-flat",
    group: "sidebar",
    title: "Sidebar, flat",
    width: 36,
    height: 28,
    element: () => <Stage width={36} height={28}>{sidebar("flat")}</Stage>,
  },
  {
    id: "sidebar-grouped",
    group: "sidebar",
    title: "Sidebar, grouped by project",
    width: 36,
    height: 28,
    element: () => <Stage width={36} height={28}>{sidebar("grouped")}</Stage>,
  },
  {
    id: "timeline",
    group: "timeline",
    title: "Timeline, a short thread",
    width: 90,
    height: 26,
    settleMs: 600,
    element: () => (
      <Stage width={90} height={26}>
        <Timeline
          groups={groupTurns(ENTRIES)}
          title="Visual harness"
          subtitle="moxen · main"
          modelForTurn={() => ({ name: "Claude Opus 5", color: null })}
          modelLabel={(model) => ({ name: model, color: null })}
          homeDir="/home/dev"
          expandedTurn={null}
          expandedWork={new Map()}
          scrollRef={SCROLL}
          onFocus={noop}
          onOpenDiff={noop}
          onToggleWork={noop}
          onOpenMessageActions={noop}
          onOpenUrl={noop}
          focused
          width={90}
          sessionStatus="running"
          now={NOW}
          turnStartedAt={ago(MIN)}
          turnFileDiffs={new Map()}
          gitFiles={[]}
        />
      </Stage>
    ),
  },
];

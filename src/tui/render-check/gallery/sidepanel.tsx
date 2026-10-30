import { FileSection } from "../../features/diffpanel/diffpanel.js";
import { GitFooter } from "../../features/gitpanel/gitpanel.js";
import { ActionText, AgentsTab, BackgroundTab, ContextTab, DiffEmptyTab, Heading, InfoTab, SidePanelFrame } from "../../features/sidepanel/sidepanel.js";
import type { ProviderUsageLimits } from "../../../core/catalog/summary.js";
import type { ContextBreakdown } from "../../model/sidepanel.js";
import type { ForgeDetection } from "../../../core/forge/forge.js";
import type { GitOverview } from "../../../core/git/history.js";
import type { BackgroundTaskRow } from "../../model/thread.js";
import type { PatchFile } from "../../model/patch.js";
import { Caption, Stage, type GalleryEntry } from "./registry.js";

const noop = (): void => {};
const NOW = Date.parse("2026-09-26T10:00:00.000Z");
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
const SCROLL = { current: null };

const BREAKDOWN: ContextBreakdown = {
  usedTokens: 84_000,
  maxTokens: 200_000,
  cachedInputTokens: 61_000,
  autoCompactThreshold: 160_000,
  compactsAutomatically: true,
  costUsd: 1.37,
  estimated: false,
  categories: [
    { name: "System prompt & tools", tokens: 18_000, kind: "used" },
    { name: "User messages", tokens: 9_000, kind: "used" },
    { name: "Assistant messages", tokens: 21_000, kind: "used" },
    { name: "Reasoning", tokens: 6_000, kind: "used" },
    { name: "Tool calls", tokens: 30_000, kind: "used" },
    { name: "Free space", tokens: 116_000, kind: "free" },
  ],
  tools: [
    { name: "Read", tokens: 14_000 },
    { name: "Bash", tokens: 9_000 },
    { name: "Edit", tokens: 7_000 },
  ],
};

const LIMITS: ProviderUsageLimits = {
  checkedAt: ago(30),
  unavailable: null,
  windows: [
    { id: "s", kind: "session", label: "Session", usedPercent: 38, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
    { id: "w", kind: "weekly", label: "Weekly", usedPercent: 91, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  ],
};

const TASKS: readonly BackgroundTaskRow[] = [
  { taskId: "b1", taskType: "local_bash", description: "Dev server", toolName: "Bash", command: "bun run dev --port 4000", startedAt: ago(754) },
  { taskId: "b2", taskType: "local_bash", description: "Watch the build for the word “error” and tell me when it appears in the output", toolName: "Monitor", command: null, startedAt: ago(48) },
  { taskId: "b3", taskType: "local_agent", description: "Explore: where the themes are applied", toolName: "Agent", command: null, startedAt: null },
];

const overview = (staged: number, unstaged: number, untracked: number): GitOverview => ({
  isRepository: true,
  root: "/work/moxen",
  status: { branch: "feature/gallery-entries-for-the-side-panel", detached: false, staged, unstaged, untracked, conflicted: 0 },
  branches: [],
  commits: [],
  branch: "main",
  defaultBranch: "main",
});

const FORGE: ForgeDetection = { kind: "github", remoteUrl: "git@github.com:moxen/moxen.git", host: "github.com", slug: "moxen/moxen", cli: "gh", installed: true, authenticated: true, reason: null };

const PATCH = [
  "--- a/src/tui/theme.ts",
  "+++ b/src/tui/theme.ts",
  "@@ -1,3 +1,4 @@",
  " export const A = 1;",
  "-export const B = 2;",
  "+export const B = 3;",
  "+export const C = 4;",
  " export const D = 5;",
  "",
].join("\n");

const file = (overrides: Partial<PatchFile>): PatchFile => ({
  path: "src/tui/theme.ts",
  filetype: "typescript",
  patch: PATCH,
  additions: 2,
  deletions: 1,
  binary: false,
  ...overrides,
});

export const SIDEPANEL_GALLERY: GalleryEntry[] = [
  {
    id: "sidepanel-heading",
    group: "sidepanel",
    title: "Heading and ActionText",
    width: 44,
    height: 9,
    element: () => (
      <Stage width={44} height={9}>
        <Heading text="Context" />
        <Heading text="Delegated task" meta="running 12s" />
        <Heading text="A heading that is longer than the panel" meta="a long meta" />
        <Caption text="ActionText" />
        <ActionText label="Pick a turn" onClick={noop} />
      </Stage>
    ),
  },
  {
    id: "diff-empty-tab",
    group: "sidepanel",
    title: "DiffEmptyTab",
    width: 54,
    height: 8,
    element: () => (
      <Stage width={54} height={8}>
        <DiffEmptyTab turns={0} onPick={noop} />
        <DiffEmptyTab turns={3} onPick={noop} />
      </Stage>
    ),
  },
  {
    id: "git-footer",
    group: "gitpanel",
    title: "GitFooter",
    width: 44,
    height: 12,
    element: () => (
      <Stage width={44} height={12}>
        <GitFooter overview={overview(0, 0, 0)} forge={FORGE} width={44} />
        <Caption text="dirty, long branch" />
        <GitFooter overview={overview(2, 5, 1)} forge={FORGE} width={44} />
        <Caption text="no remote, not a repository" />
        <GitFooter overview={{ ...overview(0, 0, 0), isRepository: false, status: null }} forge={null} width={44} />
      </Stage>
    ),
  },
  {
    id: "diff-file-section",
    group: "diffpanel",
    title: "FileSection",
    width: 60,
    height: 24,
    element: () => (
      <Stage width={60} height={24}>
        <FileSection file={file({})} width={60} selected collapsed={false} onToggle={noop} />
        <FileSection file={file({ path: "src/tui/features/settings/very/deeply/nested/folder/listeditor.tsx" })} width={60} selected={false} collapsed onToggle={noop} />
        <FileSection file={file({ path: "assets/logo.png", binary: true, additions: 0, deletions: 0 })} width={60} selected={false} collapsed={false} onToggle={noop} />
      </Stage>
    ),
  },
  {
    id: "agents-tab",
    group: "sidepanel",
    title: "AgentsTab",
    width: 54,
    height: 30,
    element: () => (
      <Stage width={54} height={30}>
        <AgentsTab
          now={NOW}
          onOpen={noop}
          onOpenSubagent={noop}
          onStopSubagent={noop}
          threads={[
            { threadId: "a", title: "Port the theme loader to the new schema", status: "running", model: "Claude Opus 5", startedAt: ago(95), outcome: null },
            { threadId: "b", title: "Audit the settings table", status: "settled", model: "Claude Sonnet 5.5", startedAt: ago(600), outcome: "completed" },
            { threadId: "c", title: "Migrate the golden files", status: "settled", model: null, startedAt: ago(900), outcome: "error" },
          ]}
          subagents={[
            { agentId: "s1", agentType: "Explore", description: "Where the themes are applied", running: true, lastMessage: "Reading src/tui/theme.ts", at: ago(40), stoppedAt: null },
            { agentId: "s2", agentType: "general-purpose", description: null, running: false, lastMessage: "Done: 3 call sites found.", at: ago(300), stoppedAt: ago(250) },
          ]}
        />
        <AgentsTab now={NOW} onOpen={noop} threads={[]} subagents={[]} />
      </Stage>
    ),
  },
  {
    id: "info-tab",
    group: "sidepanel",
    title: "InfoTab",
    width: 54,
    height: 26,
    element: () => (
      <Stage width={54} height={26}>
        <InfoTab
          now={NOW}
          onOpen={noop}
          info={{
            task: "Port the theme loader",
            parent: { threadId: "p", title: "Visual harness" },
            status: "running",
            outcome: null,
            startedAt: ago(95),
            model: "Claude Opus 5",
            branch: "moxen/port-theme-loader",
            worktreePath: "/Users/someone/.moxen/worktrees/moxen-port-theme-loader-0123456789abcdef",
          }}
        />
        <InfoTab now={NOW} onOpen={noop} info={{ task: null, parent: null, status: "settled", outcome: "error", startedAt: null, model: null, branch: null, worktreePath: null }} />
      </Stage>
    ),
  },
  {
    id: "context-tab",
    group: "sidepanel",
    title: "ContextTab",
    width: 54,
    height: 34,
    element: () => (
      <Stage width={54} height={34}>
        <ContextTab breakdown={BREAKDOWN} fallback={null} live usageLimits={LIMITS} providerName="Claude" width={54} now={NOW} />
        <ContextTab breakdown={null} fallback={null} live={false} usageLimits={null} providerName={null} width={54} now={NOW} />
      </Stage>
    ),
  },
  {
    id: "background-tab",
    group: "sidepanel",
    title: "BackgroundTab",
    width: 54,
    height: 20,
    element: () => (
      <Stage width={54} height={20}>
        <BackgroundTab tasks={TASKS} width={54} now={NOW} onOpen={noop} onStop={noop} />
        <BackgroundTab tasks={[]} width={54} now={NOW} onOpen={noop} onStop={noop} />
      </Stage>
    ),
  },
  {
    id: "side-panel-frame",
    group: "sidepanel",
    title: "SidePanelFrame",
    width: 46,
    height: 14,
    element: () => (
      <Stage width={46} height={14}>
        <SidePanelFrame width={46} height={14} focused scrollRef={SCROLL} onFocus={noop} footer={<text fg="#888888">3 files · +12 −4</text>}>
          <Heading text="Frame" meta="focused" />
          <text>Its border, padding, scrollbar and pinned footer.</text>
        </SidePanelFrame>
      </Stage>
    ),
  },
];

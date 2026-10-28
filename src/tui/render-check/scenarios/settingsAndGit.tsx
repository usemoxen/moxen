import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";

import { GitFooter, GitTab, type RequestOpener } from "../../features/gitpanel/gitpanel.js";
import type { OpenCommit } from "../../features/gitpanel/useGitPanel.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { SidePanelFrame, SideTabBar } from "../../features/sidepanel/sidepanel.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";
import type { ForgeDetection, ForgeRequest, ForgeRequestStatus, GitOverview, MergeStrategy } from "../../../server/api.js";
import { baseChoices, resolveBase } from "../../model/gitpanel.js";
import type { SideTab } from "../../model/sidepanel.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { fail } from "../helpers.js";

/**
 * The settings page and the Git tab.
 *
 * The settings assertions deliberately name labels that come from the
 * core schema table rather than from this file: if a descriptor loses its
 * label, or a section stops being rendered, the scenario fails here
 * rather than silently drawing a blank page.
 */
export async function runSettingsAndGit(): Promise<void> {
  await runSettings();
  await runGit();
}

const PROVIDERS: ProviderSummary[] = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: null,
    authStatus: null,
    models: [{ slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false, isDefault: true, isHidden: false, efforts: [] }],
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  },
];

async function runSettings(): Promise<void> {
  const written: Array<{ key: string; value: string }> = [];
  const updated: string[] = [];
  const snapshot = {
    path: "/home/dev/.moxen/config.json",
    exists: true,
    settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK),
  };
  function Harness() {
    return (
      <SettingsModal
        snapshot={snapshot}
        loading={false}
        saving={null}
        error={null}
        onSet={(key, value) => written.push({ key, value })}
        onDuplicate={() => {}}
        run={null}
        onTest={() => {}}
      onTestMcp={() => {}}
        onProbe={() => {}}
        onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
        onExport={() => {}}
        onImport={() => {}}
        notice={null}
        // Claude Code older than the floor, OpenCode current: both statuses show.
        versions={{
          claude: { ok: false, installed: true, version: "2.1.280 (Claude Code)", login: "inherit", minVersion: "2.1.292" },
          opencode: { ok: true, installed: true, version: "opencode v2.0.22", login: "inherit", minVersion: "2.0.0" },
        }}
        // What the registry says: Claude Code at 2.1.293, OpenCode at 2.0.24 (the installed one is behind it).
        latest={{ enabled: true, claude: { latest: "2.1.293", channel: "latest" }, opencode: { latest: "2.0.24", channel: null } }}
        updating={new Set()}
        onUpdate={(provider) => updated.push(provider)}
        providers={PROVIDERS}
        screenWidth={80}
        screenHeight={34}
        left={2}
        top={1}
        width={76}
        height={32}
        onClose={() => {}}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 80, height: 34, exitOnCtrlC: false });
  await setup.flush();
  // ModalShell fades in over ~150ms; capture after it, or the frame is
  // the backdrop at zero opacity and every assertion below misses.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const frame = setup.captureCharFrame();
  console.log("--- settings page ---");
  console.log(frame);
  // Every section is a tab down the left; the first one's settings show.
  for (const expected of ["Settings", "config.json", "General", "Defaults", "Sessions", "Long threads", "Agent context", "Git and forges", "Claude Code", "Unknown folders"]) {
    if (!frame.includes(expected)) fail(`settings page is missing "${expected}"`);
  }
  if (frame.includes("Idle session lifetime")) fail("settings page shows another section's settings under General");
  // The sidebar opens on its first category's heading, so the first setting sits on that row and its tab one below.
  if (!frame.includes("MOXEN") || !frame.includes("PROVIDERS") || !frame.includes("INTEGRATIONS")) fail("settings sidebar is missing its category headings");
  const generalRows = frame.split("\n");
  const tabRow = generalRows.findIndex((row) => /^\s*▌?\s*General\s/.test(row) && row.includes("│"));
  const firstRow = generalRows.findIndex((row) => row.includes("Unknown folders"));
  if (tabRow < 0 || firstRow !== tabRow - 1) fail(`the first setting is on row ${firstRow}, its tab on row ${tabRow}: the tab should sit one row below, under the category heading`);

  // Tab moves to the next section: Defaults. A model belongs to one provider: with no global Provider the global Model says it waits for one.
  await act(async () => setup.mockInput.pressTab());
  await setup.flush();
  const newThreads = setup.captureCharFrame();
  console.log("--- settings page, Defaults tab ---");
  console.log(newThreads);
  if (!newThreads.replace(/[│\s]+/g, " ").includes("Applies once Provider above names one")) fail("the global Model does not say it waits for a Provider");

  // Then Sessions.
  await act(async () => setup.mockInput.pressTab());
  await setup.flush();
  const turns = setup.captureCharFrame();
  console.log("--- settings page, Sessions tab ---");
  console.log(turns);
  if (!turns.includes("Idle session lifetime") || turns.includes("Unknown folders")) fail("tab did not switch the settings page to the Sessions section");

  // A duration is picked from its presets, never typed.
  const turnRows = turns.split("\n");
  const ttlRow = turnRows.findIndex((row) => row.includes("Idle session lifetime"));
  if (ttlRow < 0) fail("the Sessions tab has no idle session lifetime row");
  await act(async () => setup.mockMouse.click(turnRows[ttlRow]!.indexOf("Idle") + 1, ttlRow));
  await setup.flush();
  const ttl = setup.captureCharFrame();
  console.log("--- settings page, duration choices ---");
  console.log(ttl);
  if (!ttl.includes("5m") || !ttl.includes("2m") || !ttl.includes("◆")) fail("a duration setting did not open its presets with the current one marked");
  // The choices view has a way back that can be clicked, not only esc.
  const ttlRows = ttl.split("\n");
  const backRow = ttlRows.findIndex((row) => row.includes("← back"));
  if (backRow < 0) fail("the choices view has no back button");
  await act(async () => setup.mockMouse.click(ttlRows[backRow]!.indexOf("← back") + 1, backRow));
  await setup.flush();
  const backed = setup.captureCharFrame();
  if (backed.includes("← back") || !backed.includes("Idle session lifetime")) fail("clicking back did not return to the settings list");
  const reopened = backed.split("\n");
  const reopenRow = reopened.findIndex((row) => row.includes("Idle session lifetime"));
  await act(async () => setup.mockMouse.click(reopened[reopenRow]!.indexOf("Idle") + 1, reopenRow));
  await setup.flush();
  await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  // The default is an hour; the next preset up is two.
  if (written.at(-1)?.key !== "sessionTtl" || written.at(-1)?.value !== "2h") fail(`picking a preset wrote ${JSON.stringify(written)}`);

  // Free text: a box that wraps and grows, with its keys and what empty means said under it.
  // Past Long threads to Agent context, which opens on the extra instructions.
  for (let step = 0; step < 2; step += 1) await act(async () => setup.mockInput.pressTab());
  await setup.flush();
  if (!setup.captureCharFrame().includes("Extra instructions")) fail("Agent context does not hold the extra instructions");
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await setup.flush();
  await act(async () => setup.mockInput.typeText("Prefer small commits. Never touch the lockfile unless asked, and say so when a test is skipped."));
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const typedFrame = setup.captureCharFrame();
  console.log("--- settings page, text input ---");
  console.log(typedFrame);
  for (const expected of ["Prefer small commits", "shift+enter new line", "ctrl+u clear", "Left empty: unset", "chars"]) {
    if (!typedFrame.includes(expected)) fail(`the text input does not show "${expected}"`);
  }
  await act(async () => setup.mockInput.pressKey("u", { ctrl: true }));
  await setup.flush();
  if (setup.captureCharFrame().includes("Prefer small commits")) fail("ctrl+u did not clear the text input");
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();

  // The later sections: a restart-only setting says so, and a boolean
  // flips in place on click.
  for (let step = 0; step < 3; step += 1) await act(async () => setup.mockInput.pressTab());
  await setup.flush();
  const claude = setup.captureCharFrame();
  console.log("--- settings page, Claude Code tab ---");
  console.log(claude);
  if (!claude.includes("Permissions") || !claude.includes("Effort")) fail("the Claude Code tab does not lead with its thread defaults");
  // The update card: the version, where it stands against the floor, and the button.
  if (!claude.includes("2.1.280") || !claude.includes("Older than the 2.1.292")) fail("the Claude Code tab does not say its install is older than the floor");
  if (!claude.includes("[ Update ]") || !claude.includes("claude update")) fail("the Claude Code tab has no update button naming what it runs");
  await act(async () => setup.mockInput.pressKey("u"));
  await setup.flush();
  if (updated.join() !== "claude") fail(`pressing u on the Claude Code tab updated ${JSON.stringify(updated)}`);

  // A provider's Model lists that provider's catalog rather than asking for a slug.
  const claudeRows = setup.captureCharFrame().split("\n");
  const modelRow = claudeRows.findIndex((row) => /│\s+Model\s/.test(row));
  if (modelRow < 0) fail("the Claude Code tab has no model row");
  // The pane's "Model", not the sidebar's "Model servers" when they share a row.
  await act(async () => setup.mockMouse.click(claudeRows[modelRow]!.lastIndexOf("Model") + 1, modelRow));
  await setup.flush();
  const models = setup.captureCharFrame();
  console.log("--- settings page, model choices ---");
  console.log(models);
  if (!models.includes("Claude Opus 5") || !models.includes("Provider's default")) fail("the default model is not picked from the catalog");
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();

  // The page runs Defaults, Tools, Long threads, Sessions, Setup, Output, Ultracode: walk the whole of it.
  const claudeFrames: string[] = [];
  for (let step = 0; step < 20; step += 1) {
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await setup.flush();
    claudeFrames.push(setup.captureCharFrame());
  }
  const seenOn = (text: string) => claudeFrames.findIndex((frame) => frame.includes(text));
  console.log("--- settings page, Claude Code tab, last row ---");
  console.log(claudeFrames.at(-1));
  for (const expected of ["Claude executable", "next server start", "Compaction", "Hand off at", "Long threads", "Setup"]) {
    if (seenOn(expected) < 0) fail(`the Claude Code tab never shows "${expected}"`);
  }
  if (!claudeFrames.some((frame) => frame.split("\n").some((row) => row.includes("Compaction") && row.includes("Default (Moxen asks)")))) fail("the Claude Code tab does not say who compacts");
  if (!claudeFrames.some((frame) => frame.split("\n").some((row) => row.includes("Compact at") && row.includes("Default (80% of the window)")))) fail("the Claude Code tab does not say where it compacts");
  if (seenOn("Moxen's skills") >= 0) fail("the Claude Code tab still offers Moxen's skills, which Moxen no longer ships");
  // Under the same headings, in the same order, as the other providers: Long threads before Setup.
  if (!(seenOn("Long threads") <= seenOn("Setup"))) fail("the Claude Code tab files Setup before Long threads");

  // OpenCode has its own pane now, with the same card.
  await act(async () => setup.mockInput.pressTab());
  await setup.flush();
  const opencode = setup.captureCharFrame();
  console.log("--- settings page, OpenCode tab ---");
  console.log(opencode);
  if (!opencode.includes("Permissions")) fail("the OpenCode tab does not show its settings");
  if (!opencode.includes("2.0.22")) fail("the OpenCode tab does not show its installed version");
  // Behind the registry's newest: it says so, and the button names the version it goes to.
  if (!opencode.includes("2.0.24 is available")) fail("the OpenCode tab does not say a newer version is available");
  if (!opencode.includes("[ Update to 2.0.24 ]")) fail("the OpenCode update button does not name the version it updates to");
  let sawExecutable = false;
  // A choice with no default of its own reads as what applies (OpenCode compacts by itself unless told otherwise).
  let sawDefaultOn = false;
  for (let step = 0; step < 24 && !sawExecutable; step += 1) {
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await setup.flush();
    const frame = setup.captureCharFrame();
    sawExecutable = frame.includes("OpenCode executable");
    sawDefaultOn ||= frame.split("\n").some((row) => row.includes("Compaction") && row.includes("Default (OpenCode)"));
  }
  if (!sawExecutable) fail("the OpenCode tab does not show its executable");
  if (!sawDefaultOn) fail("the OpenCode tab does not read an unset 'Compaction' as Default (OpenCode)");
  await act(async () => setup.mockInput.pressTab({ shift: true }));
  await setup.flush();
  await act(async () => setup.mockInput.pressTab({ shift: true }));
  await setup.flush();
  const rows = setup.captureCharFrame().split("\n");
  const forgeRow = rows.findIndex((row) => row.includes("Forge integration"));
  if (forgeRow < 0) fail("settings page has no forge row to click");
  const before = written.length;
  await act(async () => setup.mockMouse.click(rows[forgeRow]!.indexOf("Forge") + 1, forgeRow));
  await setup.flush();
  const last = written.at(-1);
  if (written.length !== before + 1 || last?.key !== "forge.enabled" || last?.value !== "false") {
    fail(`clicking a boolean setting wrote ${JSON.stringify(written)}`);
  }
}

const OVERVIEW: GitOverview = {
  isRepository: true,
  root: "/work/moxen",
  branch: "feature/git-panel",
  defaultBranch: "main",
  status: { branch: "feature/git-panel", detached: false, staged: 1, unstaged: 3, untracked: 2, conflicted: 0 },
  branches: [
    {
      name: "feature/git-panel",
      current: true,
      remote: false,
      upstream: "origin/feature/git-panel",
      ahead: 2,
      behind: 0,
      lastCommitDate: "2026-09-25T09:00:00.000Z",
      lastCommitSubject: "Add the Git tab",
    },
    {
      name: "main",
      current: false,
      remote: false,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      lastCommitDate: "2026-09-24T09:00:00.000Z",
      lastCommitSubject: "Re-layer into core",
    },
    {
      name: "opencode-v2",
      current: false,
      remote: false,
      upstream: null,
      ahead: null,
      behind: null,
      lastCommitDate: "2026-09-23T09:00:00.000Z",
      lastCommitSubject: "Move the OpenCode driver to v2",
    },
  ],
  commits: [
    {
      sha: "a".repeat(40),
      shortSha: "a1b2c3d",
      author: "Aaron",
      authorEmail: "dev@example.com",
      date: "2026-09-25T09:00:00.000Z",
      subject: "Add the Git tab",
      refs: ["feature/git-panel"],
    },
    {
      sha: "b".repeat(40),
      shortSha: "e4f5a6b",
      author: "Aaron",
      authorEmail: "dev@example.com",
      date: "2026-09-24T09:00:00.000Z",
      subject: "Read branches and history",
      refs: [],
    },
    // A long tail with subjects wider than the panel: the list caps behind
    // "Show more", and truncated subjects must keep the gap after the sha
    // and leave the ages flush right.
    ...Array.from({ length: 14 }, (_, index) => ({
      sha: `${index}`.padStart(40, "c"),
      shortSha: `c${String(index).padStart(6, "0")}`,
      author: "Aaron",
      authorEmail: "dev@example.com",
      date: new Date(Date.parse("2026-09-23T09:00:00.000Z") - index * 86_400_000).toISOString(),
      subject: `Stage ${index}: a subject long enough that it cannot possibly fit beside its sha and age`,
      refs: [],
    })),
  ],
};

const FORGE: ForgeDetection = {
  kind: "github",
  remoteUrl: "https://github.com/arrrnmp/moxen.git",
  host: "github.com",
  slug: "arrrnmp/moxen",
  cli: "gh",
  installed: true,
  authenticated: true,
  reason: null,
};

const REQUESTS: readonly ForgeRequest[] = [
  {
    number: 41,
    title: "Add the Git side panel",
    state: "open",
    author: "arrrnmp",
    sourceBranch: "feature/git-panel",
    targetBranch: "main",
    url: "https://github.com/arrrnmp/moxen/pull/41",
    createdAt: "2026-09-25T08:00:00.000Z",
    updatedAt: "2026-09-25T09:30:00.000Z",
    reviewDecision: "APPROVED",
    checks: { passed: 7, failed: 0, pending: 0 },
  },
];

const STATUS: ForgeRequestStatus = {
  ...REQUESTS[0]!,
  checks: { passed: 6, failed: 1, pending: 0 },
  runs: [
    { name: "build", state: "passed", url: null },
    { name: "typecheck", state: "passed", url: null },
    { name: "lint", state: "failed", url: "https://ci.example/lint" },
  ],
  mergeable: "mergeable",
  additions: 120,
  deletions: 30,
  changedFiles: 8,
};

const OPEN_COMMIT: OpenCommit = {
  sha: "a".repeat(40),
  loading: false,
  runs: [{ name: "build", state: "passed", url: null }],
  detail: {
    ...OVERVIEW.commits[0]!,
    body: "Branches, history and requests in one side tab.",
    committer: "GitHub",
    committerEmail: "noreply@github.com",
    committerDate: "2026-09-25T09:05:00.000Z",
    parents: ["b".repeat(40)],
    files: [{ path: "src/tui/gitpanel.tsx", added: 2, removed: 1 }],
    diff: [
      "diff --git a/src/tui/gitpanel.tsx b/src/tui/gitpanel.tsx",
      "--- a/src/tui/gitpanel.tsx",
      "+++ b/src/tui/gitpanel.tsx",
      "@@ -1,2 +1,3 @@",
      " export const one = 1;",
      "-export const two = 3;",
      "+export const two = 2;",
      "+export const three = 3;",
      "",
    ].join("\n"),
  },
};

async function runGit(): Promise<void> {
  const now = Date.parse("2026-09-25T10:00:00.000Z");
  // Typed as mutable lists so the length checks below are not narrowed
  // away by TypeScript inferring an always-empty tuple.
  const merged: { number: number; strategy: MergeStrategy }[] = [];
  const opened: string[] = [];
  const asked: boolean[] = [];
  const picked: string[] = [];
  let setStatus: ((next: ForgeRequestStatus | null) => void) | null = null;
  let setOpener: ((next: RequestOpener) => void) | null = null;
  function Harness() {
    const [tab, setTab] = useState<SideTab>("git");
    const [status, changeStatus] = useState<ForgeRequestStatus | null>(STATUS);
    const [opener, changeOpener] = useState<RequestOpener>({ label: "the agent" });
    const [commit, setCommit] = useState<OpenCommit | null>(null);
    const [pickedBase, setPickedBase] = useState<string | null>(null);
    const choices = baseChoices(OVERVIEW);
    setStatus = changeStatus;
    setOpener = changeOpener;
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <box style={{ width: 60, height: 58, flexDirection: "column" }}>
        <SideTabBar tab={tab} badges={{}} onTab={setTab} onClose={() => {}} />
        <SidePanelFrame width={60} focused scrollRef={scrollRef} onFocus={() => {}} footer={<GitFooter overview={OVERVIEW} forge={FORGE} width={60} />}>
          <GitTab
            overview={OVERVIEW}
            forge={FORGE}
            requests={REQUESTS}
            status={status}
            commitChecks={{ [OVERVIEW.commits[0]!.sha]: { passed: 18, failed: 0, pending: 0 } }}
            commit={commit}
            loadingGit={false}
            loadingForge={false}
            error={null}
            busy={null}
            selectedBranch={null}
            now={now}
            opener={opener}
            base={resolveBase(pickedBase, choices)}
            baseChoices={choices}
            onPickBase={(next) => {
              picked.push(next);
              setPickedBase(next);
            }}
            onSelectBranch={() => {}}
            onRefresh={() => {}}
            onAgentOpen={(draft) => asked.push(draft)}
            onCreate={() => {}}
            onComment={() => {}}
            onMerge={(request, strategy) => merged.push({ number: request.number, strategy })}
            onOpenCommit={(sha) => {
              opened.push(sha);
              setCommit(OPEN_COMMIT);
            }}
            onCloseCommit={() => setCommit(null)}
            onOpenUrl={() => {}}
          />
        </SidePanelFrame>
      </box>
    );
  }
  const setup = await testRender(<Harness />, { width: 62, height: 60, exitOnCtrlC: false });
  await setup.flush();
  const frame = setup.captureCharFrame();
  console.log("--- side panel: git tab ---");
  console.log(frame);
  for (const expected of [
    "feature/git-panel",
    "3 changed",
    "Pull request",
    "#41",
    "Add the Git side panel",
    "Open",
    "approved",
    "+120",
    "8 files",
    "✗ 6/7",
    "lint",
    "open ↗",
    "merge…",
    "Branches",
    "↑2",
    "Commits",
    "a1b2c3d",
    "Add the Git tab",
    "Aaron · 1 hour ago",
    "✓ 18/18",
  ]) {
    if (!frame.includes(expected)) fail(`git tab is missing "${expected}"`);
  }
  // The failing run leads the list: it is why the PR is red.
  const rows = frame.split("\n");
  const lintRow = rows.findIndex((row) => row.includes("✗ lint"));
  const buildRow = rows.findIndex((row) => row.includes("✓ build"));
  if (lintRow < 0 || buildRow < 0 || lintRow > buildRow) fail("CI runs do not list failures first");

  // Merge arms before it fires: one click offers the strategies, and only
  // the second actually merges. A single misclick must never merge.
  const actionRow = rows.findIndex((row) => row.includes("merge…"));
  if (actionRow < 0) fail("git tab has no merge control");
  await act(async () => setup.mockMouse.click(rows[actionRow]!.indexOf("merge…") + 1, actionRow));
  await setup.flush();
  if ((merged as ReadonlyArray<unknown>).length !== 0) fail("the first merge click merged instead of arming");
  const armed = setup.captureCharFrame();
  for (const expected of ["squash", "merge commit", "cancel"]) {
    if (!armed.includes(expected)) fail(`armed merge is missing "${expected}"`);
  }
  const armedRows = armed.split("\n");
  const squashRow = armedRows.findIndex((row) => row.includes("squash"));
  await act(async () => setup.mockMouse.click(armedRows[squashRow]!.indexOf("squash") + 1, squashRow));
  await setup.flush();
  if (merged.length !== 1 || merged[0]?.number !== 41 || merged[0]?.strategy !== "squash") {
    fail(`confirming the merge sent ${JSON.stringify(merged)}`);
  }

  // A commit opens in the tab: message, people, CI and the patch.
  const commitRows = setup.captureCharFrame().split("\n");
  const commitRow = commitRows.findIndex((row) => row.includes("Add the Git tab"));
  await act(async () => setup.mockMouse.click(commitRows[commitRow]!.indexOf("Add the Git tab") + 1, commitRow));
  await setup.flush();
  const detail = setup.captureCharFrame();
  console.log("--- side panel: git tab, a commit ---");
  console.log(detail);
  if (opened[0] !== OVERVIEW.commits[0]!.sha) fail("clicking a commit did not open it");
  for (const expected of ["‹ Commits", "Branches, history and requests", "Aaron authored", "GitHub committed", "Checks", "gitpanel.tsx", "export const three"]) {
    if (!detail.includes(expected)) fail(`the commit view is missing "${expected}"`);
  }
  const detailRows = detail.split("\n");
  const back = detailRows.findIndex((row) => row.includes("‹ Commits"));
  await act(async () => setup.mockMouse.click(detailRows[back]!.indexOf("‹") + 1, back));
  await setup.flush();
  if (!setup.captureCharFrame().includes("Branches")) fail("‹ Commits did not go back to the overview");

  // No request for the branch: an agent is asked to open one (a draft by default).
  await act(async () => setStatus?.(null));
  await setup.flush();
  const none = setup.captureCharFrame();
  console.log("--- side panel: git tab, no PR yet ---");
  console.log(none);
  if (!none.includes("No PR for feature/git-panel yet.")) fail("git tab does not say the branch has no PR");
  // Where it merges is asked, the repository's default first: pick another.
  const baseRows = none.split("\n");
  const intoRow = baseRows.findIndex((row) => row.includes("into main ▾"));
  if (intoRow < 0) fail("git tab does not show the base branch, defaulting to main");
  await act(async () => setup.mockMouse.click(baseRows[intoRow]!.indexOf("main"), intoRow));
  await setup.flush();
  const choosing = setup.captureCharFrame();
  console.log("--- side panel: git tab, choosing the base ---");
  console.log(choosing);
  const choiceRows = choosing.split("\n");
  const v2Row = choiceRows.findIndex((row) => row.includes("  opencode-v2") && !row.includes("Move the"));
  if (v2Row < 0 || !choosing.includes("● main")) fail("git tab does not list the bases to choose from");
  await act(async () => setup.mockMouse.click(choiceRows[v2Row]!.indexOf("opencode-v2"), v2Row));
  await setup.flush();
  if (picked.join(",") !== "opencode-v2" || !setup.captureCharFrame().includes("into opencode-v2 ▾")) fail(`picking a base sent ${JSON.stringify(picked)}`);
  const noneRows = setup.captureCharFrame().split("\n");
  const draftRow = noneRows.findIndex((row) => row.includes("open a draft PR") && row.includes("Have the agent"));
  if (draftRow < 0) fail("git tab does not offer to have the agent open a draft PR");
  await act(async () => setup.mockMouse.click(noneRows[draftRow]!.indexOf("Have") + 1, draftRow));
  await setup.flush();
  if (asked.join(",") !== "true") fail(`asking the agent sent ${JSON.stringify(asked)}`);
  await act(async () => setOpener?.({ label: null }));
  await setup.flush();
  if (!setup.captureCharFrame().includes("No agent has usage left")) fail("git tab offers an agent when none has usage left");

  // A checkout with no forge still shows history, and says why the
  // requests section is empty rather than showing nothing at all.
  function NoForge() {
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <box style={{ width: 60, height: 30, flexDirection: "column" }}>
        <SidePanelFrame width={60} focused scrollRef={scrollRef} onFocus={() => {}}>
          <GitTab
            overview={OVERVIEW}
            forge={{ ...FORGE, kind: null, installed: false, authenticated: false, reason: "gh is not installed." }}
            base="main"
            baseChoices={["main"]}
            onPickBase={() => {}}
            requests={[]}
            status={null}
            commitChecks={{}}
            commit={null}
            loadingGit={false}
            loadingForge={false}
            error={null}
            busy={null}
            selectedBranch={null}
            now={now}
            opener={{ label: "the agent" }}
            onSelectBranch={() => {}}
            onRefresh={() => {}}
            onAgentOpen={() => {}}
            onCreate={() => {}}
            onComment={() => {}}
            onMerge={() => {}}
            onOpenCommit={() => {}}
            onCloseCommit={() => {}}
            onOpenUrl={() => {}}
          />
        </SidePanelFrame>
      </box>
    );
  }
  const plain = await testRender(<NoForge />, { width: 62, height: 32, exitOnCtrlC: false });
  await plain.flush();
  const plainFrame = plain.captureCharFrame();
  console.log("--- side panel: git tab, no forge ---");
  console.log(plainFrame);
  if (!plainFrame.includes("gh is not installed.")) fail("git tab does not explain a missing forge CLI");
  if (!plainFrame.includes("Add the Git tab")) fail("git tab dropped local history when the forge was unavailable");
}

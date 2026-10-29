import { testRender } from "@opentui/react/test-utils";

import { App, client } from "./render-check/fixtures.js";
import { runBootGate } from "./render-check/scenarios/bootGate.js";
import { runSidebarAndQuit } from "./render-check/scenarios/sidebarAndQuit.js";
import { runModelPicker } from "./render-check/scenarios/modelPicker.js";
import { runSidebarStability } from "./render-check/scenarios/sidebarStability.js";
import { runPermissions } from "./render-check/scenarios/permissions.js";
import { runDiffPanel } from "./render-check/scenarios/diffPanel.js";
import { runCommandPalette } from "./render-check/scenarios/commandPalette.js";
import { runThreadSearch } from "./render-check/scenarios/threadSearch.js";
import { runMessageActions } from "./render-check/scenarios/messageActions.js";
import { runTimelineAndAnswers } from "./render-check/scenarios/timelineAndAnswers.js";
import { runToolApprovals } from "./render-check/scenarios/toolApprovals.js";
import { runWorkFoldGuards } from "./render-check/scenarios/workFoldGuards.js";
import { runSkillsAndContext } from "./render-check/scenarios/skillsAndContext.js";
import { runSidePanelButton } from "./render-check/scenarios/sidePanelButton.js";
import { runActivityRows } from "./render-check/scenarios/activityRows.js";
import { runLifecycleRows } from "./render-check/scenarios/lifecycleRows.js";
import { runTurnModels } from "./render-check/scenarios/turnModels.js";
import { runBackgroundWork } from "./render-check/scenarios/backgroundWork.js";
import { runProviderInterruptions } from "./render-check/scenarios/providerInterruptions.js";
import { runQuestionPreview } from "./render-check/scenarios/questionPreview.js";
import { runComposerScrollbar } from "./render-check/scenarios/composerScrollbar.js";
import { runTasksPanel } from "./render-check/scenarios/tasksPanel.js";
import { runScheduleModal } from "./render-check/scenarios/scheduleModal.js";
import { runSidePanelTabs } from "./render-check/scenarios/sidePanelTabs.js";
import { runNoticeBanner } from "./render-check/scenarios/noticeBanner.js";
import { runImageTokens } from "./render-check/scenarios/imageTokens.js";
import { runComposerSlots } from "./render-check/scenarios/composerSlots.js";
import { runInteractionModes } from "./render-check/scenarios/interactionModes.js";
import { runSettingsAndGit } from "./render-check/scenarios/settingsAndGit.js";
import { runSettingsModelList, runSettingsSlider } from "./render-check/scenarios/settingsSlider.js";
import { runHarnessProfiles } from "./render-check/scenarios/harnessProfiles.js";
import { runMcpAccess } from "./render-check/scenarios/mcpAccess.js";
import { runHandoffModels } from "./render-check/scenarios/handoffModels.js";
import { runSettingsSidebarScroll } from "./render-check/scenarios/settingsSidebarScroll.js";
import { runQueueAndSide } from "./render-check/scenarios/queueAndSide.js";
import { runSidebarTree } from "./render-check/scenarios/sidebarTree.js";
import { runSidebarSearch } from "./render-check/scenarios/sidebarSearch.js";
import { runRemoteAccess } from "./render-check/scenarios/remoteAccess.js";
import { runServerLink } from "./render-check/scenarios/serverLink.js";
import { registerSyntaxParsers } from "../core/syntax/register.js";

/**
 * Snapshot harness: drives the app with a mock client, scripts input,
 * captures char frames. No live terminal needed.
 *
 * This is one continuous scripted walkthrough against a single shared
 * `setup` — every step depends on state left behind by the previous one, not
 * an independent test case — so it stays a strict sequence of `await`s in
 * original order, just split into feature-scoped scenario functions instead
 * of one 1300-line script. `bun src/tui/render-check.tsx` runs it.
 */

// Same vendored grammars the app registers in `index.tsx`, and for the same
// reason: before the first render, or command rows render unhighlighted.
await registerSyntaxParsers();

// `exitOnCtrlC` defaults true on the renderer itself (harmless in the real
// app, which passes `false` in `index.tsx` so its own quit-confirm modal
// gets the keypress) — without it here, the harness's own renderer would
// tear itself down on the ctrl+c scenario below before the app ever saw it.
const setup = await testRender(<App client={client} onQuit={() => {}} launchView="thread" />, {
  width: 140,
  // One row more than the composer's older, shorter footer needed: the composer is a row taller now.
  height: 27,
  exitOnCtrlC: false,
});

await runSidebarAndQuit(setup);
await runModelPicker(setup);
await runSidebarStability(setup);
await runPermissions(setup);
await runDiffPanel(setup);
await runThreadSearch(setup);
await runCommandPalette(setup);
await runMessageActions(setup);
await runTimelineAndAnswers(setup);
await runToolApprovals(setup);
await runWorkFoldGuards(setup);
await runSkillsAndContext(setup);
await runSidePanelButton(setup);
await runActivityRows(setup);
await runLifecycleRows(setup);
await runBackgroundWork(setup);
await runProviderInterruptions(setup);
// Independent render with its own deferred client (not part of the shared
// walkthrough above): runs last so its extra renderer cannot perturb the
// timing-sensitive assertions of the shared scenarios.
await runBootGate();
await runTurnModels();
await runQuestionPreview();
await runComposerScrollbar();
await runTasksPanel();
await runSidePanelTabs();
await runScheduleModal();
await runSettingsAndGit();
await runSettingsSlider();
await runSettingsModelList();
await runHarnessProfiles();
await runMcpAccess();
await runHandoffModels();
await runSettingsSidebarScroll();
await runQueueAndSide();
await runNoticeBanner();
await runImageTokens();
await runInteractionModes();
await runComposerSlots();
await runSidebarTree();
await runSidebarSearch();
await runRemoteAccess();
await runServerLink();

process.exit(0);

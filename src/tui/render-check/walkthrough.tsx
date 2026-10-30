import { testRender } from "./testrender.js";

import { App, client } from "./fixtures.js";
import { runBootGate } from "./scenarios/bootGate.js";
import { runSidebarAndQuit } from "./scenarios/sidebarAndQuit.js";
import { runModelPicker } from "./scenarios/modelPicker.js";
import { runSidebarStability } from "./scenarios/sidebarStability.js";
import { runPermissions } from "./scenarios/permissions.js";
import { runDiffPanel } from "./scenarios/diffPanel.js";
import { runCommandPalette } from "./scenarios/commandPalette.js";
import { runThreadSearch } from "./scenarios/threadSearch.js";
import { runMessageActions } from "./scenarios/messageActions.js";
import { runTimelineAndAnswers } from "./scenarios/timelineAndAnswers.js";
import { runToolApprovals } from "./scenarios/toolApprovals.js";
import { runWorkFoldGuards } from "./scenarios/workFoldGuards.js";
import { runSkillsAndContext } from "./scenarios/skillsAndContext.js";
import { runSidePanelButton } from "./scenarios/sidePanelButton.js";
import { runStatsModal } from "./scenarios/statsModal.js";
import { runActivityRows } from "./scenarios/activityRows.js";
import { runLifecycleRows } from "./scenarios/lifecycleRows.js";
import { runTurnModels } from "./scenarios/turnModels.js";
import { runBackgroundWork } from "./scenarios/backgroundWork.js";
import { runProviderInterruptions } from "./scenarios/providerInterruptions.js";
import { runQuestionPreview } from "./scenarios/questionPreview.js";
import { runComposerScrollbar } from "./scenarios/composerScrollbar.js";
import { runTasksPanel } from "./scenarios/tasksPanel.js";
import { runScheduleModal } from "./scenarios/scheduleModal.js";
import { runSidePanelTabs } from "./scenarios/sidePanelTabs.js";
import { runNoticeBanner } from "./scenarios/noticeBanner.js";
import { runImageThumbs } from "./scenarios/imageThumbs.js";
import { runPathChips } from "./scenarios/pathChips.js";
import { runTerminalVisibility } from "./scenarios/terminalVisibility.js";
import { runImageTokens } from "./scenarios/imageTokens.js";
import { runComposerSlots } from "./scenarios/composerSlots.js";
import { runInteractionModes } from "./scenarios/interactionModes.js";
import { runSettingsCoverage } from "./scenarios/settingsCoverage.js";
import { runSettingsAndGit } from "./scenarios/settingsAndGit.js";
import { runSettingsModelList, runSettingsSlider } from "./scenarios/settingsSlider.js";
import { runHarnessProfiles } from "./scenarios/harnessProfiles.js";
import { runMcpAccess } from "./scenarios/mcpAccess.js";
import { runHandoffModels } from "./scenarios/handoffModels.js";
import { runSettingsSidebarScroll } from "./scenarios/settingsSidebarScroll.js";
import { runQueueAndSide } from "./scenarios/queueAndSide.js";
import { runSidebarTree } from "./scenarios/sidebarTree.js";
import { runSidebarSearch } from "./scenarios/sidebarSearch.js";
import { runRemoteAccess } from "./scenarios/remoteAccess.js";
import { runServerLink } from "./scenarios/serverLink.js";
import { runSpanish, runSpanishSettings } from "./scenarios/spanish.js";
import { registerSyntaxParsers } from "../../core/syntax/register.js";

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
export async function runWalkthrough(): Promise<void> {
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
  await runStatsModal(setup);
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
  await runImageThumbs();
  await runTerminalVisibility();
  await runPathChips();
  await runInteractionModes();
  await runComposerSlots();
  await runSidebarTree();
  await runSidebarSearch();
  await runRemoteAccess();
  await runSpanish();
  await runSpanishSettings();
  await runServerLink();
  await runSettingsCoverage();

}

import { act } from "react";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { summarizeProviderAccounts } from "../../../core/providers/accounts.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/**
 * The add-provider wizard's home step for Antigravity (LOCAL-014).
 *
 * While `providers.antigravity.allowUnsupportedUse` is off (the default),
 * a new Antigravity account gets no Moxen-managed isolated home: the step
 * starts empty and says the account signs in on the host `agy` login, and a
 * second account is told it stays disabled until the setting is on. Once the
 * setting is on, the managed folder is pre-filled exactly as before.
 */
export async function runAddProviderWizard(): Promise<void> {
  await runWizardFor(false, "the host agy login while off");
  await runWizardFor(true, "the managed home once on");
}

async function runWizardFor(allow: boolean, label: string): Promise<void> {
  const config = {
    ...DEFAULTS_FOR_RENDER_CHECK,
    providers: {
      ...DEFAULTS_FOR_RENDER_CHECK.providers,
      antigravity: {
        // One configured account on the host `agy` login, so adding another
        // Antigravity account is the gated second-account case while off.
        ...(allow ? { allowUnsupportedUse: true } : {}),
        accounts: [{ id: "personal", label: "Personal" }],
      },
    },
  };
  const snapshot = {
    path: "/home/dev/.moxen/config.json",
    exists: true,
    settings: describeSettings(config),
  };
  const accounts = summarizeProviderAccounts(config.providers);
  function Harness() {
    return (
      <SettingsModal
        snapshot={snapshot}
        accounts={accounts}
        loading={false}
        saving={null}
        error={null}
        onSet={() => {}}
        onDuplicate={() => {}}
        run={null}
        onTest={() => {}}
        onTestMcp={() => {}}
        onProbe={() => {}}
        onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
        onExport={() => {}}
        onImport={() => {}}
        notice={null}
        versions={null}
        latest={{ enabled: false, claude: { latest: "2.1.0", channel: null }, opencode: { latest: "2.0.0", channel: null } }}
        updating={new Set()}
        onUpdate={() => {}}
        providers={[]}
        screenWidth={90}
        screenHeight={32}
        left={2}
        top={1}
        width={86}
        height={30}
        onClose={() => {}}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 90, height: 32, exitOnCtrlC: false });
  await setup.flush();
  // ModalShell fades in over ~150ms; wait for a drawn setting rather than a delay.
  for (let attempt = 0; !setup.captureCharFrame().includes("Unknown folders"); attempt += 1) {
    if (attempt > 100) fail(`add provider wizard (${label}): Settings did not open`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
  const rows = setup.captureCharFrame().split("\n");
  const overviewRow = rows.findIndex((row) => row.includes("Overview") && row.indexOf("Overview") < 28);
  if (overviewRow < 0) fail(`add provider wizard (${label}): the sidebar has no Providers Overview tab`);
  await act(async () => setup.mockMouse.click(rows[overviewRow]!.indexOf("Overview") + 1, overviewRow));
  await setup.flush();
  const overview = setup.captureCharFrame();
  if (!overview.includes("+ Add provider")) fail(`add provider wizard (${label}): the Providers Overview does not show its add row`);
  // The hint says "a add": the wizard opens from the keyboard, not a click.
  await act(async () => setup.mockInput.pressKey("a"));
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const kindStep = setup.captureCharFrame();
  if (!kindStep.replace(/[│\s]+/g, " ").includes("Choose which provider to add a login for")) fail(`add provider wizard (${label}): the kind step did not open`);
  const kindRows = kindStep.split("\n");
  // The sidebar's account tab says "Antigravity · …" too: the kind list lives in the body pane.
  const antigravityRow = kindRows.findIndex((row) => row.includes("Antigravity") && row.indexOf("Antigravity") > 28);
  if (antigravityRow < 0) fail(`add provider wizard (${label}): the kind step does not offer Antigravity`);
  await act(async () => setup.mockMouse.click(kindRows[antigravityRow]!.indexOf("Antigravity") + 1, antigravityRow));
  await setup.flush();
  await act(async () => setup.mockInput.typeText("team"));
  await setup.flush();
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  // The label step: an empty answer falls back to the id.
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();
  const homeStep = setup.captureCharFrame();
  console.log(`--- add provider wizard home step, ${label} ---`);
  console.log(homeStep);
  if (allow) {
    if (!homeStep.includes("~/.moxen/accounts/antigravity/team")) fail(`add provider wizard (${label}): the managed home is not pre-filled once the setting is on`);
    if (homeStep.replace(/[│\s]+/g, " ").includes("host agy login")) fail(`add provider wizard (${label}): the shared-login hint shows while the setting is on`);
  } else {
    if (homeStep.replace(/[│\s]+/g, " ").includes("accounts/antigravity/team")) fail(`add provider wizard (${label}): the home step pre-fills a managed home while the setting is off`);
    if (!homeStep.replace(/[│\s]+/g, " ").includes("host agy login")) fail(`add provider wizard (${label}): the home step does not say the account shares the host agy login`);
    if (!homeStep.replace(/[│\s]+/g, " ").includes("at most one account")) fail(`add provider wizard (${label}): a second Antigravity account is not explained up front`);
  }
}

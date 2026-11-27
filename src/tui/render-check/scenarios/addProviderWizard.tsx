import { act } from "react";

import type { ClientApi } from "../../../server/api.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { summarizeProviderAccounts } from "../../../core/providers/accounts.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/**
 * The add-provider flow for Antigravity (LOCAL-037):
 *
 * Antigravity is a single host-login provider (no multi-account id/label/home
 * wizard). Picking Antigravity when none is configured saves the single
 * `antigravity/default` host entry directly without opening an id prompt, and
 * once configured Antigravity is no longer offered in `+ Add provider`.
 */
export async function runAddProviderWizard(): Promise<void> {
  await runAddAntigravityDirectly();
  await runAntigravityHiddenOnceConfigured();
}

async function runAddAntigravityDirectly(): Promise<void> {
  const config = {
    ...DEFAULTS_FOR_RENDER_CHECK,
    providers: {
      ...DEFAULTS_FOR_RENDER_CHECK.providers,
      antigravity: {},
    },
  };
  const snapshot = {
    path: "/home/dev/.moxen/config.json",
    exists: true,
    settings: describeSettings(config),
  };
  const accounts = summarizeProviderAccounts(config.providers);
  const saved: Array<Record<string, unknown>> = [];
  const client = {
    query: async (q: { readonly type: string }) => (q.type === "providers.accounts" ? { accounts } : {}),
    dispatch: async (cmd: Record<string, unknown>) => {
      if (cmd.type === "provider.account.save") saved.push(cmd);
      return { accepted: true };
    },
  } as unknown as ClientApi;
  function Harness() {
    return (
      <SettingsModal
        client={client}
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
  for (let attempt = 0; !setup.captureCharFrame().includes("Unknown folders"); attempt += 1) {
    if (attempt > 100) fail("add provider wizard (single-account antigravity): Settings did not open");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
  const rows = setup.captureCharFrame().split("\n");
  const overviewRow = rows.findIndex((row) => row.includes("Overview") && row.indexOf("Overview") < 28);
  if (overviewRow < 0) fail("add provider wizard (single-account antigravity): no Overview tab");
  await act(async () => setup.mockMouse.click(rows[overviewRow]!.indexOf("Overview") + 1, overviewRow));
  await setup.flush();
  await act(async () => setup.mockInput.pressKey("a"));
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const kindStep = setup.captureCharFrame();
  const kindRows = kindStep.split("\n");
  const antigravityRow = kindRows.findIndex((row) => row.includes("Antigravity") && row.indexOf("Antigravity") > 28);
  if (antigravityRow < 0) fail("add provider wizard (single-account antigravity): Antigravity not offered when unconfigured");
  await act(async () => setup.mockMouse.click(kindRows[antigravityRow]!.indexOf("Antigravity") + 1, antigravityRow));
  await setup.flush();
  const after = setup.captureCharFrame();
  console.log("--- add provider wizard (single-account antigravity) ---");
  console.log(after);
  if (after.includes("Account id")) fail("add provider wizard (single-account antigravity): unexpectedly opened account id wizard");
  if (saved.length !== 1 || saved[0]?.kind !== "antigravity" || saved[0]?.id !== "default" || saved[0]?.homePath !== undefined) {
    fail(`add provider wizard (single-account antigravity): unexpected save payload ${JSON.stringify(saved)}`);
  }
}

async function runAntigravityHiddenOnceConfigured(): Promise<void> {
  const config = {
    ...DEFAULTS_FOR_RENDER_CHECK,
    providers: {
      ...DEFAULTS_FOR_RENDER_CHECK.providers,
      antigravity: {
        accounts: [{ id: "default", label: "Default" }],
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
  for (let attempt = 0; !setup.captureCharFrame().includes("Unknown folders"); attempt += 1) {
    if (attempt > 100) fail("add provider wizard (configured antigravity): Settings did not open");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
  const rows = setup.captureCharFrame().split("\n");
  const overviewRow = rows.findIndex((row) => row.includes("Overview") && row.indexOf("Overview") < 28);
  await act(async () => setup.mockMouse.click(rows[overviewRow]!.indexOf("Overview") + 1, overviewRow));
  await setup.flush();
  await act(async () => setup.mockInput.pressKey("a"));
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();
  const kindStep = setup.captureCharFrame();
  const antigravityRow = kindStep.split("\n").findIndex((row) => row.includes("Antigravity") && row.indexOf("Antigravity") > 28);
  if (antigravityRow >= 0) fail("add provider wizard (configured antigravity): Antigravity should not be offered a second time");
}

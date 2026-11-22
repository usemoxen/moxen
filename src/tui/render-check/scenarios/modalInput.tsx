import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import type { ClientApi } from "../../../server/api.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { App, client, emitLiveRef, permissionRequestedFrame, userInputRequestedFrame } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";

async function clickText(setup: TestRendererSetup, text: string): Promise<void> {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  if (y < 0) fail(`modal input: missing ${text}`);
  await act(async () => setup.mockMouse.click(rows[y]!.indexOf(text), y));
  await setup.flush();
}

/** Settings must not answer a question, approve a tool, or change the draft beneath it. */
export async function runModalInput(): Promise<void> {
  for (const kind of ["question", "permission", "composer"] as const) {
    const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
    const isolated: ClientApi = {
      ...client,
      dispatch(command) {
        commands.push(command);
        return client.dispatch(command);
      },
      query: (async (query) => query.type === "settings.read"
        ? { path: "config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) }
        : client.query(query)) as ClientApi["query"],
    };
    const setup = await testRender(<App client={isolated} onQuit={() => {}} launchView="thread" />, {
      width: 140,
      height: 40,
      exitOnCtrlC: false,
    });
    try {
      await setup.flush();
      if (kind === "composer") {
        await act(async () => setup.mockInput.pressKey("i"));
        await act(async () => setup.mockInput.typeText("preserved draft"));
      } else {
        await act(async () => emitLiveRef.current?.(kind === "question"
          ? userInputRequestedFrame("modal-question")
          : permissionRequestedFrame("modal-permission")));
      }
      await setup.flush();
      const expected = kind === "question" ? "1. Forward" : kind === "permission" ? "Do you want to proceed?" : "preserved draft";
      if (!setup.captureCharFrame().includes(expected)) fail(`modal input: ${kind} did not open`);
      await clickText(setup, "⚙ settings");
      // Wait for the modal's fade, not a platform-dependent fixed delay.
      for (let attempt = 0; !setup.captureCharFrame().includes("Unknown folders"); attempt += 1) {
        if (attempt === 100) fail("modal input: Settings did not open");
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
        await setup.flush();
      }
      const before = commands.length;
      for (const key of ["1", "2", "3", "DOWN", "UP", "DOWN"]) {
        await act(async () => setup.mockInput.pressKey(key));
        await setup.flush();
      }
      await act(async () => setup.mockInput.typeText("leaked"));
      await act(async () => setup.mockInput.pressEnter());
      await setup.flush();
      const responses = () => commands.slice(before).filter((command) =>
        command.type === "thread.user-input.respond" || command.type === "thread.permission.respond" || command.type === "thread.turn.start");
      if (responses().length !== 0) fail(`modal input: Settings submitted the ${kind} beneath it`);
      console.log(`--- modal input: Settings over ${kind} ---`);
      console.log(setup.captureCharFrame());

      // Clicking outside closes the whole page even if Enter opened a setting editor.
      await act(async () => setup.mockMouse.click(139, 0));
      await setup.flush();
      const closed = setup.captureCharFrame();
      if (closed.includes("Settings") || !closed.includes(expected)) fail(`modal input: closing Settings lost the ${kind}`);
      if (closed.includes("leaked")) fail("modal input: Settings typed into the composer beneath it");
      await act(async () => setup.mockInput.pressEnter());
      await setup.flush();
      const response = responses()[0];
      if (responses().length !== 1) fail(`modal input: ${kind} did not regain input after closing Settings`);
      if (kind === "question" && (response?.type !== "thread.user-input.respond" || !JSON.stringify(response.answers).includes("Forward"))) {
        fail("modal input: Settings changed the question's highlighted answer");
      }
      if (kind === "permission" && (response?.type !== "thread.permission.respond" || response.decision !== "accept")) {
        fail("modal input: Settings changed the highlighted permission decision");
      }
      if (kind === "composer" && (response?.type !== "thread.turn.start" || response.message.text !== "preserved draft")) {
        fail("modal input: Settings changed the draft");
      }
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // Nested TextField inside ProfileAccountHeader (Antigravity code-paste login) must capture
  // typing, Tab, Enter, and Escape without leaking into SettingsModal's setting rows or closing it.
  const submittedCodes: string[] = [];
  let cancelledLogins = 0;
  let modalClosed = false;
  let updatesTriggered = 0;
  const accountClient: ClientApi = {
    ...client,
    query: (async (query) => {
      if (query.type === "providers.accounts") {
        return {
          accounts: [
            {
              kind: "antigravity",
              id: "default",
              instanceId: "antigravity/default",
              label: "Default",
              enabled: true,
              homePath: "~/.moxen/accounts/antigravity/default",
              binaryPath: null,
              launchArgs: null,
              env: {},
              model: null,
              thinkingEffort: null,
              email: null,
              workspaceName: null,
              planType: null,
              signedIn: false,
              codexHomePath: null,
              codexBinaryPath: null,
              codexLaunchArgs: null,
              codexVerified: false,
            },
          ],
        };
      }
      if (query.type === "settings.read") {
        return { path: "config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) };
      }
      return client.query(query);
    }) as ClientApi["query"],
    dispatch: (async (command) => {
      if (command.type === "provider.account.login.start") {
        return {
          sessionId: "sess-agy-1",
          kind: "antigravity",
          accountId: "default",
          homePath: "~/.moxen/accounts/antigravity/default",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test-long-url",
          openBrowser: false,
          needsCodeInput: true,
          message: "Sign in with Google in your browser (saved to ~/.moxen/accounts/antigravity/default), then paste the authorization code below.",
        };
      }
      if (command.type === "provider.account.login.complete") {
        submittedCodes.push((command as { readonly code?: string }).code ?? "");
        return { kind: "antigravity", accountId: "default", homePath: "~/.moxen/accounts/antigravity/default" };
      }
      if (command.type === "provider.account.login.cancel") {
        cancelledLogins += 1;
        return { cancelled: true };
      }
      return client.dispatch(command);
    }) as ClientApi["dispatch"],
  };
  const nested = await testRender(
    <SettingsModal
      snapshot={{ path: "config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) }}
      loading={false}
      saving={null}
      error={null}
      providers={null}
      versions={{
        claude: { ok: true, installed: true, version: "2.1.330", login: "inherit", minVersion: "2.1.0" },
        opencode: { ok: true, installed: true, version: "2.3.2", login: "inherit", minVersion: "2.0.0" },
        antigravity: { ok: true, installed: true, version: "1.5.14", login: "inherit", minVersion: "1.0.0" },
      }}
      latest={null}
      updating={new Set()}
      client={accountClient}
      accounts={[
        {
          kind: "antigravity",
          id: "default",
          instanceId: "antigravity/default",
          label: "Default",
          enabled: true,
          homePath: "~/.moxen/accounts/antigravity/default",
          binaryPath: null,
          launchArgs: null,
          env: {},
          model: null,
          thinkingEffort: null,
          email: null,
          workspaceName: null,
          planType: null,
          signedIn: false,
          codexHomePath: null,
          codexBinaryPath: null,
          codexLaunchArgs: null,
          codexVerified: false,
        },
      ]}
      initialSection="provider:antigravity"
      run={null}
      notice={null}
      screenWidth={130}
      screenHeight={38}
      left={4}
      top={1}
      width={122}
      height={36}
      onSet={() => undefined}
      onDuplicate={() => undefined}
      onTest={() => undefined}
      onTestMcp={() => undefined}
      onProbe={() => undefined}
      onDiscover={() => Promise.resolve({ ok: true, models: [], host: "" })}
      onExport={() => undefined}
      onImport={() => undefined}
      onUpdate={() => { updatesTriggered += 1; }}
      onClose={() => { modalClosed = true; }}
    />,
    { width: 130, height: 38, exitOnCtrlC: false },
  );
  try {
    for (let attempt = 0; !nested.captureCharFrame().includes("Antigravity · Default"); attempt += 1) {
      if (attempt === 60) fail("modal input: Settings sidebar did not render Antigravity · Default");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
      await nested.flush();
    }
    await clickText(nested, "Antigravity · Default");
    for (let attempt = 0; !nested.captureCharFrame().includes("[ Sign in ]"); attempt += 1) {
      if (attempt === 60) fail("modal input: Antigravity profile header did not render [ Sign in ]");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
      await nested.flush();
    }
    await clickText(nested, "[ Sign in ]");
    for (let attempt = 0; !nested.captureCharFrame().includes("Paste authorization code"); attempt += 1) {
      if (attempt === 60) fail("modal input: Antigravity code TextField did not appear");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
      await nested.flush();
    }
    // Type characters that are normally SettingsModal shortcuts (u, j, k), press Tab, then Enter.
    await act(async () => nested.mockInput.typeText("code-ujk-42"));
    await nested.flush();
    await act(async () => nested.mockInput.pressKey("TAB"));
    await nested.flush();
    await act(async () => nested.mockInput.pressEnter());
    await nested.flush();
    for (let attempt = 0; submittedCodes.length === 0; attempt += 1) {
      if (attempt === 60) fail("modal input: Enter inside ProfileAccountHeader TextField did not submit code");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      await nested.flush();
    }
    const afterSubmit = nested.captureCharFrame();
    if (submittedCodes[0] !== "code-ujk-42") fail(`modal input: unexpected submitted code ${JSON.stringify(submittedCodes)}`);
    if (updatesTriggered !== 0) fail("modal input: typing 'u' in TextField leaked to SettingsModal onUpdate");
    if (modalClosed) fail("modal input: Enter in TextField closed SettingsModal");
    if (afterSubmit.includes("← Back") || afterSubmit.includes("Choose an option")) {
      fail("modal input: Enter in ProfileAccountHeader TextField leaked to SettingsModal and opened a setting picker");
    }

    // Re-open sign-in and press Escape: should cancel ONLY the login TextField, keeping SettingsModal open.
    await clickText(nested, "[ Sign in ]");
    for (let attempt = 0; !nested.captureCharFrame().includes("Paste authorization code"); attempt += 1) {
      if (attempt === 60) fail("modal input: Antigravity code TextField did not re-open");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
      await nested.flush();
    }
    await act(async () => nested.mockInput.pressEscape());
    await nested.flush();
    for (let attempt = 0; cancelledLogins === 0; attempt += 1) {
      if (attempt === 60) fail("modal input: Escape inside TextField did not cancel login");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      await nested.flush();
    }
    if (modalClosed) fail("modal input: Escape inside ProfileAccountHeader TextField leaked and closed SettingsModal");
  } finally {
    await act(async () => nested.renderer.destroy());
  }
}

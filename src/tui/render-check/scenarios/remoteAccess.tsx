import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";

import { App } from "../../app/app.js";
import type { ClientApi } from "../../../server/api.js";
import { PairedServers } from "../../../server/transport/servers.js";
import { client } from "../fixtures.js";
import { fail } from "../helpers.js";

const FINGERPRINT = "D8:A1:CA:F7:20:54:F1:61:36:D5:5C:65:12:DA:4D:5C:59:07:C9:20:1B:2D:71:AC:F2:16:BC:20:B9:1B:2A:8D";

async function typeText(setup: TestRendererSetup, text: string): Promise<void> {
  for (const char of text) {
    await act(async () => setup.mockInput.pressKey(char));
    await setup.flush();
  }
}

async function escape(setup: TestRendererSetup): Promise<void> {
  // A lone escape waits out the key parser's timeout before it is a key.
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await setup.flush();
}

async function palette(setup: TestRendererSetup, filter: string): Promise<string> {
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await setup.flush();
  await typeText(setup, filter);
  // Past the modal's fade-in, so the backdrop no longer shows through.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await setup.flush();
  return setup.captureCharFrame();
}

/**
 * Remote access from the TUI, on its own render: connected to a paired
 * server (named in the sidebar title), drafting a new thread. The palette
 * opens there with only what applies before a thread exists; its Remote
 * section shows a pairing code for the connected server, switches servers,
 * and revokes a device on the second pick.
 */
export async function runRemoteAccess(): Promise<void> {
  const dispatched: string[] = [];
  const switched: Array<string | null> = [];
  const remoteClient: ClientApi = {
    ...client,
    dispatch: (async (command: { type: string; deviceId?: string }) => {
      dispatched.push(command.deviceId ? `${command.type}:${command.deviceId}` : command.type);
      if (command.type === "remote.pairing.start") {
        return { code: "XGQ6-W9H9", expiresAt: new Date(Date.now() + 299_000).toISOString(), addresses: ["192.168.1.236:47317"], fingerprint: FINGERPRINT };
      }
      return { accepted: true };
    }) as unknown as ClientApi["dispatch"],
    query: (async (query: { type: string }) => {
      if (query.type === "remote.status") {
        return {
          available: true,
          enabled: true,
          interfaces: "lan",
          port: 47317,
          listening: [{ address: "192.168.1.236", family: "IPv4", kind: "lan", interface: "Ethernet" }],
          fingerprint: FINGERPRINT,
        };
      }
      if (query.type === "remote.devices") {
        return { devices: [{ id: "dev-1", name: "laptop", pairedAt: "2026-10-28T00:39:39.000Z", connections: 1 }] };
      }
      return await client.query(query as never);
    }) as unknown as ClientApi["query"],
  };
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "moxen-render-servers-")), "servers.json");
  await writeFile(
    file,
    JSON.stringify({
      servers: [
        { name: "testvm", host: "192.168.1.236", port: 47317, fingerprint: FINGERPRINT, deviceId: "d-1", pairedAt: "2026-10-28T00:00:00.000Z" },
        { name: "winbox", host: "10.0.0.7", port: 47317, fingerprint: FINGERPRINT, deviceId: "d-2", pairedAt: "2026-10-28T00:00:00.000Z" },
      ],
    }),
  );

  const setup = await testRender(
    <App
      client={remoteClient}
      onQuit={() => {}}
      launchView="create"
      server={{ name: "testvm", host: "192.168.1.236", port: 47317 }}
      onSwitchServer={async (target) => {
        switched.push(target);
      }}
      pairedServers={new PairedServers({ file, tokens: { read: async () => null, write: async () => {} } })}
    />,
    { width: 140, height: 34, exitOnCtrlC: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await setup.flush();

  const first = setup.captureCharFrame();
  console.log("--- remote: connected to a paired server ---");
  console.log(first);
  if (!first.includes("Threads · testvm")) fail("the sidebar does not name the paired server it is connected to");

  // Drafting a new thread, the palette opens with only what applies before a thread exists.
  const reduced = await palette(setup, "");
  console.log("--- remote: palette while drafting ---");
  console.log(reduced);
  for (const expected of ["Search threads", "Choose project", "Remote", "Switch server", "Pair with a server", "Turn remote access off"]) {
    if (!reduced.includes(expected)) fail(`the new-thread palette is missing "${expected}"`);
  }
  for (const absent of ["Delete thread", "Rename thread", "Copy branch"]) {
    if (reduced.includes(absent)) fail(`the new-thread palette offers "${absent}", which needs a thread`);
  }
  await escape(setup);

  // A pairing code for the connected server.
  await palette(setup, "pairing code");
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  await setup.flush();
  const code = setup.captureCharFrame();
  console.log("--- remote: pairing code ---");
  console.log(code);
  for (const expected of ["Pair a device with testvm", "XGQ6-W9H9", "moxen remote pair 192.168.1.236:47317 XGQ6-W9H9", "D8:A1:CA:F7", "single use"]) {
    if (!code.includes(expected)) fail(`the pairing code dialog is missing "${expected}"`);
  }
  if (!dispatched.includes("remote.pairing.start")) fail("showing a code did not ask the server for one");
  await escape(setup);

  // Switching lists this machine and every paired server, the current one marked.
  await palette(setup, "switch");
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await setup.flush();
  const servers = setup.captureCharFrame();
  console.log("--- remote: switch server ---");
  console.log(servers);
  for (const expected of ["Switch server", "This machine", "testvm", "winbox", "10.0.0.7:47317"]) {
    if (!servers.includes(expected)) fail(`the server list is missing "${expected}"`);
  }
  // The list opens on the first row, this machine: picking it switches back.
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  await setup.flush();
  if (switched[0] !== null) fail(`picking This machine switched to ${String(switched[0])}`);

  // Devices: the first pick arms, the second revokes.
  await palette(setup, "devices");
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await setup.flush();
  const devices = setup.captureCharFrame();
  console.log("--- remote: devices ---");
  console.log(devices);
  if (!devices.includes("laptop") || !devices.includes("1 connected")) fail("the devices list does not show the paired laptop");
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const armed = setup.captureCharFrame();
  if (!armed.includes("Confirm revoke laptop")) fail("the first pick did not arm the revoke");
  await act(async () => setup.mockInput.pressEnter());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  await setup.flush();
  if (!dispatched.includes("remote.device.revoke:dev-1")) fail("the second pick did not revoke the device");
  console.log("--- remote: device revoked ---");
  console.log(setup.captureCharFrame());
  // No renderer.destroy(), as in the other standalone scenarios: the process exits after the last one.
}

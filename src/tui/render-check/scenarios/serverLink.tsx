import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../../app/app.js";
import type { ClientApi } from "../../../server/api.js";
import type { LinkState } from "../../../server/transport/remote.js";
import { client } from "../fixtures.js";
import { fail } from "../helpers.js";

/** The fixture client, plus the link state a `RemoteConnection` reports, set by hand. */
function linkedClient(initial: LinkState): { client: ClientApi; set: (state: LinkState) => void } {
  let state = initial;
  const listeners = new Set<(next: LinkState) => void>();
  // Defined, not assigned: `Object.assign` would copy the getter's value once.
  const linked = Object.create(client, {
    linkState: { get: () => state },
    onLinkState: {
      value: (listener: (next: LinkState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  }) as ClientApi;
  return {
    client: linked,
    set: (next) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>, ms = 300): Promise<string> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await setup.flush();
  return setup.captureCharFrame();
}

/**
 * A TUI whose server stops answering: the notice over the composer says so
 * in plain words (on the new-thread screen and in a thread) — never the raw
 * error, its socket path or an attempt count — and goes once the connection
 * is back; a refusal no retry fixes reads as disconnected. It offers no
 * other server: that one's threads are not this one's.
 */
export async function runServerLink(): Promise<void> {
  const reconnecting: LinkState = { status: "reconnecting", since: Date.now(), attempts: 0, reason: "no reply for 15s" };

  const drafting = linkedClient(reconnecting);
  const create = await testRender(<App client={drafting.client} onQuit={() => {}} launchView="create" />, { width: 140, height: 34, exitOnCtrlC: false });
  const lost = await settle(create);
  console.log("--- server link: lost, drafting a new thread ---");
  console.log(lost);
  for (const expected of ["Can't reach the moxen server", "reconnecting", "It is running but not answering"]) {
    if (!lost.includes(expected)) fail(`the new-thread screen's server notice is missing "${expected}"`);
  }
  if (lost.includes("Switch server")) fail("the server notice offers another server");
  await act(async () => drafting.set({ ...reconnecting, attempts: 2, reason: "No moxen server is listening at /tmp/s.sock." }));
  const retrying = await settle(create, 50);
  console.log("--- server link: gone ---");
  console.log(retrying);
  if (!retrying.includes("It stopped or is restarting")) fail("the notice does not say the server went away");
  for (const raw of ["/tmp/s.sock", "attempt", "listening at"]) {
    if (retrying.includes(raw)) fail(`the notice shows the raw error ("${raw}")`);
  }
  await act(async () => drafting.set({ status: "connected" }));
  const back = await settle(create, 50);
  console.log("--- server link: back ---");
  console.log(back);
  if (back.includes("Can't reach")) fail("the notice stays after the connection is back");

  const threaded = linkedClient({ status: "failed", reason: "This device is not paired with the moxen server, or was revoked. Pair it again.", code: "REMOTE_DEVICE_REFUSED" });
  const thread = await testRender(
    <App client={threaded.client} onQuit={() => {}} launchView="thread" server={{ name: "testvm", host: "192.168.1.236", port: 47317 }} onSwitchServer={async () => {}} />,
    { width: 140, height: 34, exitOnCtrlC: false },
  );
  const failed = await settle(thread);
  console.log("--- server link: refused, in a thread ---");
  console.log(failed);
  for (const expected of ["Disconnected from testvm", "no longer paired there"]) {
    if (!failed.includes(expected)) fail(`the thread view's server notice is missing "${expected}"`);
  }
  if (failed.includes("Switch server")) fail("the server notice offers another server");

  // Started while the server was being replaced: the catalog cannot be read
  // (the footer falls back to raw ids and loses its usage gauge) until the
  // connection is back — then it is read again, without waiting for a retry.
  let up = false;
  let served = 0;
  const swapping = linkedClient({ status: "reconnecting", since: Date.now(), attempts: 0, reason: "the connection closed" });
  const flaky = Object.create(swapping.client, {
    getConfig: {
      value: async () => {
        if (!up) throw new Error("The moxen server went away before answering.");
        served += 1;
        return await client.getConfig();
      },
    },
  }) as ClientApi;
  await testRender(<App client={flaky} onQuit={() => {}} launchView="thread" />, { width: 140, height: 34, exitOnCtrlC: false });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  up = true;
  await act(async () => swapping.set({ status: "connected" }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  if (served === 0) fail("the model catalog was not read again once the connection came back");
  // No renderer.destroy(), as in the other standalone scenarios: the process exits after the last one.
}

/**
 * `moxen remote …`: remote access, from both ends.
 *
 * This machine as a client: `pair`, `servers`, `forget` keep the list of
 * paired servers (`server/transport/servers.ts`) and need no server at all.
 * This machine's server: `status`, `enable`, `disable`, `code`, `devices`,
 * `revoke` go through `ClientApi` like every other command — so with
 * `--server` they manage that server instead.
 *
 * No envelope here ever holds a token. The pairing code `code` prints is
 * meant to be read out; it is single-use and short-lived.
 */
import type { CliConfig, RemoteInterfaces } from "../core/types.js";
import { CliError } from "../core/errors.js";
import { PairedServers } from "../server/transport/servers.js";
import { cliClient } from "./infra/client.js";

const INTERFACES: readonly RemoteInterfaces[] = ["lan", "tailscale", "both"];

export async function pairServer(options: { address: string; code: string; name?: string }) {
  const server = await new PairedServers().pair({ address: options.address, code: options.code, ...(options.name ? { name: options.name } : {}) });
  return { server };
}

export async function listServers() {
  return { servers: await new PairedServers().list() };
}

export async function forgetServer(nameOrAddress: string) {
  return { forgotten: await new PairedServers().forget(nameOrAddress) };
}

export async function remoteStatus(config: CliConfig) {
  return await (await cliClient(config)).query({ type: "remote.status" });
}

export async function enableRemote(config: CliConfig, options: { interfaces?: string; port?: string }) {
  const client = await cliClient(config);
  if (options.interfaces !== undefined) {
    if (!INTERFACES.includes(options.interfaces as RemoteInterfaces)) {
      throw new CliError("INVALID_OPTION", `--interfaces must be lan, tailscale or both (got "${options.interfaces}").`, { exitCode: 2 });
    }
    await client.dispatch({ type: "settings.set", key: "remote.interfaces", value: options.interfaces });
  }
  if (options.port !== undefined) await client.dispatch({ type: "settings.set", key: "remote.port", value: options.port });
  await client.dispatch({ type: "settings.set", key: "remote.enabled", value: "true" });
  return await client.query({ type: "remote.status" });
}

export async function disableRemote(config: CliConfig) {
  const client = await cliClient(config);
  await client.dispatch({ type: "settings.set", key: "remote.enabled", value: "false" });
  return await client.query({ type: "remote.status" });
}

export async function pairingCode(config: CliConfig) {
  return await (await cliClient(config)).dispatch({ type: "remote.pairing.start" });
}

export async function listDevices(config: CliConfig) {
  return await (await cliClient(config)).query({ type: "remote.devices" });
}

export async function revokeDevice(config: CliConfig, deviceId: string) {
  await (await cliClient(config)).dispatch({ type: "remote.device.revoke", deviceId });
  return { revoked: deviceId };
}

/** One line for a status: what listens where, or why not. */
export function describeStatus(status: Awaited<ReturnType<typeof remoteStatus>>): string {
  if (!status.enabled) return "Remote access is off: the moxen server listens on this machine only.";
  if (!status.available) return "Remote access is on, and takes effect when the moxen server runs (moxen server start).";
  if (status.listening.length === 0) return `Remote access is on but not listening${status.error ? `: ${status.error}` : "."}`;
  const addresses = status.listening.map((entry) => (entry.family === "IPv6" ? `[${entry.address}]` : entry.address) + `:${status.port}`);
  return `Remote access is listening on ${addresses.join(", ")}.\nKey fingerprint: ${status.fingerprint ?? "unknown"}`;
}

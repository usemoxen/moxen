import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_REMOTE_PORT } from "../../../core/configschema.js";
import { testHarness } from "../../../core/testing/harness.js";
import { connectPairedServer } from "../../client.js";
import { DirectConnection } from "../../connection.js";
import { remoteServerName, serverMode } from "../../servermode.js";
import { createTlsKey, tlsIdentity } from "../certificate.js";
import { DeviceRegistry, type TokenStore } from "../devices.js";
import { RemoteAccess, type RemoteAddress } from "../remoteaccess.js";
import { RemoteConnection } from "../remote.js";
import { PairedServers, parseServerAddress, serverTokenName } from "../servers.js";

const teardown: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step().catch(() => undefined);
});

const LOOPBACK: RemoteAddress = { address: "127.0.0.1", family: "IPv4", kind: "lan", interface: "lo" };

function memoryTokens(): TokenStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => void (value === "" ? values.delete(name) : values.set(name, value)),
  };
}

async function tempFile(name: string): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "moxen-servers-")), name);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A server with remote access on loopback, and a client-side list of paired servers. */
async function setup() {
  const harness = await testHarness();
  const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const remote = new RemoteAccess({
    api,
    identity: async () => tlsIdentity(createTlsKey()),
    addresses: () => [LOOPBACK],
    devices: new DeviceRegistry({ file: await tempFile("devices.json"), tokens: memoryTokens() }),
  });
  teardown.push(() => api.close(), () => remote.close());
  const port = await freePort();
  await remote.apply({ enabled: true, port });
  const tokens = memoryTokens();
  const file = await tempFile("servers.json");
  return { remote, port, servers: new PairedServers({ file, tokens }), tokens, file };
}

describe("server addresses", () => {
  it("parses host, host:port and bracketed IPv6, defaulting the port", () => {
    expect(parseServerAddress("192.168.1.20")).toEqual({ host: "192.168.1.20", port: DEFAULT_REMOTE_PORT });
    expect(parseServerAddress("winbox.local:4000")).toEqual({ host: "winbox.local", port: 4000 });
    expect(parseServerAddress("[fd7a:115c:a1e0::9]:4000")).toEqual({ host: "fd7a:115c:a1e0::9", port: 4000 });
    expect(parseServerAddress("fd7a:115c:a1e0::9")).toEqual({ host: "fd7a:115c:a1e0::9", port: DEFAULT_REMOTE_PORT });
    for (const bad of ["", "http://x", "host:0", "host:99999", "a b"]) {
      expect(() => parseServerAddress(bad)).toThrow(expect.objectContaining({ code: "INVALID_ADDRESS" }));
    }
  });
});

describe("MOXEN_SERVER", () => {
  it("means this machine's server, or else names a paired one; direct is refused", () => {
    expect(serverMode({})).toBe("daemon");
    expect(serverMode({ MOXEN_SERVER: "Auto" })).toBe("daemon");
    expect(serverMode({ MOXEN_SERVER: "winbox" })).toBe("daemon");
    expect(() => serverMode({ MOXEN_SERVER: "direct" })).toThrow(/no longer supported/);
    expect(remoteServerName({ MOXEN_SERVER: "daemon" })).toBeNull();
    expect(remoteServerName({ MOXEN_SERVER: "direct" })).toBeNull();
    expect(remoteServerName({ MOXEN_SERVER: " winbox " })).toBe("winbox");
  });
});

describe("paired servers", () => {
  it("pairs, saves no token in the list, and connects again with the token alone", async () => {
    const { remote, port, servers, tokens, file } = await setup();
    const { code, fingerprint } = remote.startPairing();

    const paired = await servers.pair({ address: `127.0.0.1:${port}`, code, name: "winbox", deviceName: "mac" });
    expect(paired).toMatchObject({ name: "winbox", host: "127.0.0.1", port, fingerprint });
    const token = tokens.values.get(serverTokenName(paired.deviceId));
    expect(token).toEqual(expect.any(String));
    expect(await readFile(file, "utf8")).not.toContain(token);
    expect(await remote.listDevices()).toEqual([expect.objectContaining({ id: paired.deviceId, name: "mac" })]);

    const connection = await connectPairedServer("WINBOX", servers);
    teardown.push(() => connection.close());
    expect(connection.pairedServer.name).toBe("winbox");
    await expect(connection.query({ type: "projects.list" })).resolves.toHaveProperty("projects");
    await expect(connection.shutdownServer()).rejects.toMatchObject({ code: "REMOTE_SHUTDOWN_REFUSED" });
    // Found by address too.
    expect((await servers.find(`127.0.0.1:${port}`))?.name).toBe("winbox");
  });

  it("refuses a server whose key is not the pinned one, before sending the token", async () => {
    const { remote, port, servers, file } = await setup();
    const paired = await servers.pair({ address: `127.0.0.1:${port}`, code: remote.startPairing().code, name: "winbox" });
    const forged = { ...paired, fingerprint: tlsIdentity(createTlsKey()).fingerprint };
    await writeFile(file, JSON.stringify({ servers: [forged] }), "utf8");
    const before = (await remote.listDevices())[0]?.lastSeenAt;

    await expect(connectPairedServer("winbox", servers)).rejects.toMatchObject({ code: "REMOTE_KEY_MISMATCH" });
    // The server never saw a hello from it.
    expect((await remote.listDevices())[0]?.lastSeenAt).toBe(before);
  });

  it("stops reconnecting, and tells subscribers, once the device is revoked", async () => {
    const { remote, port, servers } = await setup();
    const paired = await servers.pair({ address: `127.0.0.1:${port}`, code: remote.startPairing().code, name: "winbox" });
    const connection = await connectPairedServer("winbox", servers);
    teardown.push(() => connection.close());
    const errors: unknown[] = [];
    connection.subscribeShell({}, () => undefined, (error) => errors.push(error));

    await remote.revoke(paired.deviceId);
    const deadline = Date.now() + 10_000;
    while (errors.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors[0]).toMatchObject({ code: "REMOTE_DEVICE_REFUSED" });
  });

  it("refuses a wrong code, and forgets a server with its token", async () => {
    const { remote, port, servers, tokens } = await setup();
    remote.startPairing();
    await expect(servers.pair({ address: `127.0.0.1:${port}`, code: "AAAA-AAAA" })).rejects.toMatchObject({ code: "REMOTE_PAIRING_REFUSED" });
    expect(await servers.list()).toEqual([]);

    const paired = await servers.pair({ address: `127.0.0.1:${port}`, code: remote.startPairing().code });
    expect(paired.name).toBe(os.hostname().slice(0, 64));
    await servers.forget(paired.name);
    expect(await servers.list()).toEqual([]);
    expect(tokens.values.size).toBe(0);
    await expect(connectPairedServer(paired.name, servers)).rejects.toMatchObject({ code: "REMOTE_SERVER_UNKNOWN" });
  });

  it("re-pairing at the same address replaces the old entry and its token", async () => {
    const { remote, port, servers, tokens } = await setup();
    const first = await servers.pair({ address: `127.0.0.1:${port}`, code: remote.startPairing().code, name: "one" });
    const second = await servers.pair({ address: `127.0.0.1:${port}`, code: remote.startPairing().code, name: "two" });
    expect((await servers.list()).map((entry) => entry.name)).toEqual(["two"]);
    expect(tokens.values.has(serverTokenName(first.deviceId))).toBe(false);
    expect(tokens.values.has(serverTokenName(second.deviceId))).toBe(true);
  });

  it("reports an unreachable server plainly", async () => {
    await expect(
      RemoteConnection.connect("127.0.0.1:1", { reconnect: false, tls: { host: "127.0.0.1", port: 1 } }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  });
});

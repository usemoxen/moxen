import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { testHarness } from "../../../core/testing/harness.js";
import { DirectConnection } from "../../connection.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTlsKey, keyFingerprint, tlsIdentity } from "../certificate.js";
import { DeviceRegistry, type TokenStore } from "../devices.js";
import { classifyAddress, RemoteAccess, remoteAddresses, type RemoteAddress } from "../remoteaccess.js";
import { RemoteConnection } from "../remote.js";
import { serve } from "../serve.js";
import { encode, LineReader, PROTOCOL_VERSION } from "../wire.js";
import { testEndpoint } from "./endpoint.js";

const teardown: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step().catch(() => undefined);
});

const LOOPBACK: RemoteAddress = { address: "127.0.0.1", family: "IPv4", kind: "lan", interface: "lo" };

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function devices(): Promise<DeviceRegistry> {
  const values = new Map<string, string>();
  const tokens: TokenStore = {
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => void (value === "" ? values.delete(name) : values.set(name, value)),
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-remote-"));
  return new DeviceRegistry({ file: path.join(dir, "devices.json"), tokens });
}

async function remoteAccess(): Promise<{ remote: RemoteAccess; fingerprint: string }> {
  const harness = await testHarness();
  const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  const identity = tlsIdentity(createTlsKey());
  const remote = new RemoteAccess({ api, identity: async () => identity, addresses: () => [LOOPBACK], devices: await devices() });
  teardown.push(() => api.close(), () => remote.close());
  return { remote, fingerprint: identity.fingerprint };
}

const hello = (extra: object = {}) => ({ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION, ...extra } });

/** Pair a device through a real remote hello; its id and token. */
async function paired(remote: RemoteAccess, port: number, fingerprint: string): Promise<{ id: string; token: string }> {
  const { code } = remote.startPairing();
  const { replies, socket } = await exchange(port, fingerprint, [hello({ pair: { code, deviceName: "test laptop" } })]);
  socket.destroy();
  const result = replies[0]?.result as { deviceId: string; token: string };
  return { id: result.deviceId, token: result.token };
}

/** A TLS client that trusts nothing but the pin, sending `lines` and collecting replies. */
async function exchange(port: number, fingerprint: string, lines: object[]): Promise<{ replies: Array<Record<string, unknown>>; socket: tls.TLSSocket }> {
  const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
  socket.setEncoding("utf8");
  const reader = new LineReader();
  const replies: Array<Record<string, unknown>> = [];
  socket.on("data", (chunk: string) => {
    for (const line of reader.push(chunk)) replies.push(JSON.parse(line) as Record<string, unknown>);
  });
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  expect(keyFingerprint(socket.getPeerCertificate(true).raw)).toBe(fingerprint);
  for (const line of lines) socket.write(encode(line as never));
  const deadline = Date.now() + 10_000;
  while (replies.length < lines.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  teardown.push(async () => socket.destroy());
  return { replies, socket };
}

describe("certificate", () => {
  it("rebuilds a loadable certificate from the key, with the same pin every time", () => {
    const key = createTlsKey();
    const first = tlsIdentity(key, "moxen@test");
    const second = tlsIdentity(key, "moxen@test");
    expect(first.cert).not.toBe(second.cert);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(keyFingerprint(first.cert)).toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const parsed = new X509Certificate(first.cert);
    expect(parsed.subject).toBe("CN=moxen@test");
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(new Date(parsed.validTo).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 15);
  });

  it("gives a different key a different pin", () => {
    expect(tlsIdentity(createTlsKey()).fingerprint).not.toBe(tlsIdentity(createTlsKey()).fingerprint);
  });
});

describe("remote addresses", () => {
  it("classifies private LAN and Tailscale addresses, and nothing else", () => {
    expect(classifyAddress("192.168.1.236", "IPv4")).toBe("lan");
    expect(classifyAddress("10.0.0.4", "IPv4")).toBe("lan");
    expect(classifyAddress("172.20.1.1", "IPv4")).toBe("lan");
    expect(classifyAddress("100.101.102.103", "IPv4")).toBe("tailscale");
    expect(classifyAddress("fd7a:115c:a1e0::1", "IPv6")).toBe("tailscale");
    expect(classifyAddress("fd12:3456::1", "IPv6")).toBe("lan");
    for (const address of ["127.0.0.1", "8.8.8.8", "172.32.0.1", "169.254.1.1", "100.128.0.1"]) {
      expect(classifyAddress(address, "IPv4")).toBeNull();
    }
    for (const address of ["::1", "fe80::1%en0", "2001:db8::1"]) expect(classifyAddress(address, "IPv6")).toBeNull();
  });

  it("selects by the configured interfaces, IPv4 first", () => {
    const entry = (address: string, family: "IPv4" | "IPv6", internal = false) =>
      ({ address, family, internal, netmask: "", mac: "", cidr: null }) as never;
    const network = {
      lo0: [entry("127.0.0.1", "IPv4", true)],
      en0: [entry("fd12:3456::1", "IPv6"), entry("192.168.1.20", "IPv4"), entry("8.8.8.8", "IPv4")],
      utun4: [entry("100.90.1.2", "IPv4"), entry("fd7a:115c:a1e0::9", "IPv6")],
    };
    expect(remoteAddresses("lan", network).map((a) => a.address)).toEqual(["192.168.1.20", "fd12:3456::1"]);
    expect(remoteAddresses("tailscale", network).map((a) => a.address)).toEqual(["100.90.1.2", "fd7a:115c:a1e0::9"]);
    expect(remoteAddresses("both", network).map((a) => a.kind)).toEqual(["lan", "tailscale", "lan", "tailscale"]);
  });
});

describe("remote access listener", () => {
  it("listens only while enabled, and drops remote sockets when turned off", async () => {
    const { remote, fingerprint } = await remoteAccess();
    const port = await freePort();

    expect((await remote.apply(undefined)).listening).toEqual([]);

    const status = await remote.apply({ enabled: true, interfaces: "lan", port });
    expect(status).toMatchObject({ enabled: true, port, fingerprint, listening: [LOOPBACK] });

    const device = await paired(remote, port, fingerprint);
    const { replies, socket } = await exchange(port, fingerprint, [hello({ device })]);
    expect(replies[0]).toMatchObject({ id: 1, result: { protocol: PROTOCOL_VERSION, deviceId: device.id } });

    const closed = new Promise((resolve) => socket.once("close", resolve));
    expect((await remote.apply({ enabled: false, port })).listening).toEqual([]);
    expect(() => remote.startPairing()).toThrow(expect.objectContaining({ code: "REMOTE_DISABLED" }));
    // Dropped a moment later, not at once: a client that turned it off through
    // this socket gets its answer first.
    expect(socket.destroyed).toBe(false);
    await closed;
    await expect(
      new Promise((resolve, reject) => {
        const again = net.connect(port, "127.0.0.1");
        again.once("connect", () => {
          again.destroy();
          resolve("connected");
        });
        again.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("refuses a remote hello that is neither a pairing nor a paired device", async () => {
    const { remote, fingerprint } = await remoteAccess();
    const port = await freePort();
    await remote.apply({ enabled: true, port });
    const { replies } = await exchange(port, fingerprint, [
      { id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION } },
      { id: 2, method: "query", params: { type: "projects.list" } },
    ]);
    expect(replies.find((reply) => reply.id === 1)).toMatchObject({ error: { code: "REMOTE_NOT_PAIRED" } });
    const wrong = await exchange(port, fingerprint, [hello({ device: { id: "nobody", token: "nothing" } })]);
    expect(wrong.replies[0]).toMatchObject({ error: { code: "REMOTE_DEVICE_REFUSED" } });
    expect(replies.find((reply) => reply.id === 2)).toMatchObject({ error: { code: "PROTOCOL_HELLO_REQUIRED" } });
  });

  it("pairs with a code once, then admits the device by its token alone", async () => {
    const { remote, fingerprint } = await remoteAccess();
    const port = await freePort();
    await remote.apply({ enabled: true, port });
    const pairing = remote.startPairing();
    expect(pairing).toMatchObject({ addresses: [`127.0.0.1:${port}`], fingerprint });

    const first = await exchange(port, fingerprint, [hello({ pair: { code: pairing.code, deviceName: "laptop" } })]);
    const result = first.replies[0]?.result as Record<string, unknown>;
    expect(result).toMatchObject({ serverName: os.hostname(), deviceId: expect.any(String), token: expect.any(String) });

    const reused = await exchange(port, fingerprint, [hello({ pair: { code: pairing.code, deviceName: "thief" } })]);
    expect(reused.replies[0]).toMatchObject({ error: { code: "REMOTE_PAIRING_REFUSED" } });

    const again = await exchange(port, fingerprint, [hello({ device: { id: result.deviceId, token: result.token } })]);
    expect(again.replies[0]?.result).not.toHaveProperty("token");
    expect(await remote.listDevices()).toEqual([expect.objectContaining({ id: result.deviceId, name: "laptop", connections: 2 })]);
  });

  it("revoking a device drops its sockets and refuses it after", async () => {
    const { remote, fingerprint } = await remoteAccess();
    const port = await freePort();
    await remote.apply({ enabled: true, port });
    const device = await paired(remote, port, fingerprint);
    const { socket } = await exchange(port, fingerprint, [hello({ device })]);
    const closed = new Promise((resolve) => socket.once("close", resolve));

    await remote.revoke(device.id);
    await closed;
    expect(await remote.listDevices()).toEqual([]);
    const after = await exchange(port, fingerprint, [hello({ device })]);
    expect(after.replies[0]).toMatchObject({ error: { code: "REMOTE_DEVICE_REFUSED" } });
    await expect(remote.revoke(device.id)).rejects.toMatchObject({ code: "REMOTE_DEVICE_NOT_FOUND" });
  });

  it("serves a paired device everything but shutdown", async () => {
    const { remote, fingerprint } = await remoteAccess();
    const port = await freePort();
    await remote.apply({ enabled: true, port });
    const device = await paired(remote, port, fingerprint);
    const { replies } = await exchange(port, fingerprint, [
      hello({ device }),
      { id: 2, method: "query", params: { type: "projects.list" } },
      { id: 3, method: "shutdown" },
    ]);
    expect(replies.find((reply) => reply.id === 2)).toHaveProperty("result");
    expect(replies.find((reply) => reply.id === 3)).toMatchObject({ error: { code: "REMOTE_SHUTDOWN_REFUSED" } });
    // Still listening: the refused shutdown stopped nothing.
    expect(remote.status().listening).toEqual([LOOPBACK]);
  });

  it("fails clearly when there is nothing to bind, leaving nothing listening", async () => {
    const harness = await testHarness();
    const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const remote = new RemoteAccess({ api, identity: async () => tlsIdentity(createTlsKey()), addresses: () => [] });
    teardown.push(() => api.close(), () => remote.close());
    await expect(remote.apply({ enabled: true, interfaces: "tailscale" })).rejects.toMatchObject({ code: "REMOTE_NO_ADDRESS" });
    expect(remote.status()).toMatchObject({ listening: [], error: expect.stringContaining("Tailscale") });
  });

  it("leaves the local endpoint as it was", async () => {
    const harness = await testHarness();
    const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const endpoint = testEndpoint();
    const handle = await serve({ endpoint, api, onClose: () => api.close() });
    teardown.push(() => handle.close());
    const remote = new RemoteAccess({ api, identity: async () => tlsIdentity(createTlsKey()), addresses: () => [LOOPBACK] });
    teardown.push(() => remote.close());
    const port = await freePort();
    await remote.apply({ enabled: true, port });
    await remote.apply({ enabled: false });

    const local = await RemoteConnection.connect(endpoint, { reconnect: false });
    teardown.push(() => local.close());
    await expect(local.query({ type: "projects.list" })).resolves.toBeDefined();
  });
});

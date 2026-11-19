import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { openClient } from "../client.js";
import { desktopConnection } from "../desktop.js";
import { DirectConnection } from "../connection.js";
import { testHarness } from "../../core/testing/harness.js";
import { defaultEndpoint, isNamedPipe, namedPipe, probe, validateEndpoint } from "../transport/endpoint.js";
import { encode, PROTOCOL_VERSION } from "../transport/wire.js";

it("keeps a paired name on stdio and forwards the same hello, query and subscription contract", async () => {
  const harness = await testHarness();
  const direct = new DirectConnection({ storeRoot: harness.root, config: async () => harness.config, drivers: harness.drivers });
  const input = new PassThrough();
  const output = new PassThrough();
  const connect = vi.fn(async () => Object.assign(direct, { pairedServer: {
    name: "Studio Mac", host: "studio.local", port: 47317, fingerprint: "fixture", deviceId: "fixture", pairedAt: "2026-11-18",
  } }));
  let captured = "";
  const until = (match: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const check = () => captured.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).find(match);
    const found = check();
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const handle = () => {
        const found = check();
        if (!found) return;
        output.off("data", handle);
        resolve(found);
      };
      output.on("data", handle);
    });
  };
  output.on("data", (chunk: Buffer) => { captured += chunk.toString(); });
  const done = desktopConnection(input, output, "Studio Mac", connect);
  try {
    expect(await until((value) => value.status === "ready")).toEqual({ status: "ready" });
    expect(connect).toHaveBeenCalledWith({ server: "Studio Mac", reconnect: false, onStarting: expect.any(Function) });
    input.write(encode({ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION, build: "moxen-desktop", buildDisplay: "Moxen Agent desktop" } }));
    const hello = await until((value) => value.id === 1);
    expect(hello.result).toMatchObject({ protocol: PROTOCOL_VERSION, pairedName: "Studio Mac", restartRequired: false });
    expect(hello.result).not.toHaveProperty("token");
    input.write(encode({ id: 2, method: "query", params: { type: "experience.read" } }));
    expect((await until((value) => value.id === 2)).result).toMatchObject({ onboardingCompleted: false });
    input.write(encode({ id: 3, method: "subscribeShell", params: {} }));
    expect(await until((value) => value.id === 3)).toEqual({ id: 3, result: { subscription: 3 } });
    expect(await until((value) => value.subscription === 3)).toMatchObject({ item: { kind: "snapshot" } });
    input.write(encode({ id: 4, method: "shutdown" }));
    expect(await until((value) => value.id === 4)).toMatchObject({ error: { code: "REMOTE_SHUTDOWN_REFUSED" } });
  } finally {
    input.end();
    await done;
  }
});

it("reports a missing local listener before attempting any daemon launch", async () => {
  const endpoint = process.platform === "win32" ? namedPipe(`moxen-test-${randomUUID()}`) : path.join(os.tmpdir(), `mx-test-${process.pid}.sock`);
  const abort = new Error("test intercepted the startup before spawning anything");
  const starting = vi.fn(() => { throw abort; });
  await expect(openClient({ endpoint, mode: "daemon", onStarting: starting })).rejects.toBe(abort);
  expect(starting).toHaveBeenCalledTimes(1);
  expect(defaultEndpoint({ MOXEN_SERVER_ENDPOINT: ` ${endpoint} ` })).toBe(endpoint);
});

it("selects the real platform endpoint and ignores a blank override", () => {
  const endpoint = defaultEndpoint({ MOXEN_SERVER_ENDPOINT: " " });
  const user = (os.userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
  expect(endpoint).toBe(process.platform === "win32" ? namedPipe(`moxen-${user}`) : path.join(os.homedir(), ".moxen", "server.sock"));
  expect(isNamedPipe(endpoint)).toBe(process.platform === "win32");
  expect(isNamedPipe(namedPipe("moxen-A_B"))).toBe(true);
});

it.each([
  ["darwin", 103],
  ["freebsd", 103],
  ["linux", 107],
  ["android", 107],
  ["sunos", 107],
] as const)("rejects Unix socket paths over the %s byte limit", (platform, limit) => {
  const atLimit = "a".repeat(limit - ".sock".length) + ".sock";
  const overLimit = `a${atLimit}`;
  const multibyte = `é${atLimit.slice(1)}`;
  expect(() => validateEndpoint(atLimit, platform)).not.toThrow();
  for (const endpoint of [overLimit, multibyte]) {
    expect(() => validateEndpoint(endpoint, platform)).toThrow(
      `Unix socket path "${endpoint}" is ${limit + 1} bytes; the limit is ${limit} bytes.`,
    );
  }
});

it("does not apply the Unix socket byte limit to Windows named pipes", () => {
  const endpoint = namedPipe("a".repeat(120));
  expect(() => validateEndpoint(endpoint, "win32")).not.toThrow();
  expect(() => validateEndpoint(endpoint, "darwin")).not.toThrow();
});

it.skipIf(process.platform === "win32")("refuses an over-long socket path before connecting", async () => {
  const endpoint = path.join(os.tmpdir(), "a".repeat(120), "server.sock");
  await expect(probe(endpoint)).rejects.toMatchObject({ code: "SERVER_SOCKET_PATH_TOO_LONG" });
});

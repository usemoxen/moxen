import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DeviceRegistry, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, tokenName, type TokenStore } from "../devices.js";

function memoryTokens(): TokenStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => {
      if (value === "") values.delete(name);
      else values.set(name, value);
    },
  };
}

async function registry(now = { at: Date.parse("2026-10-28T10:00:00Z") }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-devices-"));
  const tokens = memoryTokens();
  const file = path.join(dir, "remote", "devices.json");
  return { devices: new DeviceRegistry({ file, tokens, now: () => now.at }), tokens, file, now };
}

describe("DeviceRegistry", () => {
  it("pairs a device with a code typed loosely, once", async () => {
    const { devices, tokens } = await registry();
    const { code } = devices.startPairing();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const { device, token } = await devices.pair(` ${code.toLowerCase().replace("-", " ")} `, "Aaron's Mac");
    expect(device.name).toBe("Aaron's Mac");
    expect(tokens.values.get(tokenName(device.id))).toBe(token);
    expect(await devices.list()).toEqual([device]);

    await expect(devices.pair(code, "again")).rejects.toMatchObject({ code: "REMOTE_PAIRING_REFUSED" });
  });

  it("refuses an expired code", async () => {
    const { devices, now } = await registry();
    const { code } = devices.startPairing();
    now.at += PAIRING_TTL_MS;
    expect(devices.openPairing()).toBeNull();
    await expect(devices.pair(code, "late")).rejects.toMatchObject({ code: "REMOTE_PAIRING_REFUSED" });
  });

  it("kills the code after too many wrong guesses", async () => {
    const { devices } = await registry();
    const { code } = devices.startPairing();
    for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt += 1) {
      await expect(devices.pair("WRONG-CODE", "guesser")).rejects.toMatchObject({ code: "REMOTE_PAIRING_REFUSED" });
    }
    await expect(devices.pair(code, "too late")).rejects.toMatchObject({ code: "REMOTE_PAIRING_REFUSED" });
  });

  it("authenticates by id and token, and forgets a revoked device", async () => {
    const { devices, tokens } = await registry();
    const { code } = devices.startPairing();
    const { device, token } = await devices.pair(code, "laptop");

    await expect(devices.authenticate(device.id, token)).resolves.toMatchObject({ id: device.id, lastSeenAt: expect.any(String) });
    await expect(devices.authenticate(device.id, `${token}x`)).rejects.toMatchObject({ code: "REMOTE_DEVICE_REFUSED" });
    await expect(devices.authenticate("someone-else", token)).rejects.toMatchObject({ code: "REMOTE_DEVICE_REFUSED" });

    expect(await devices.revoke(device.id)).toBe(true);
    expect(tokens.values.has(tokenName(device.id))).toBe(false);
    await expect(devices.authenticate(device.id, token)).rejects.toMatchObject({ code: "REMOTE_DEVICE_REFUSED" });
    expect(await devices.revoke(device.id)).toBe(false);
  });

  it("keeps no token in the device list file", async () => {
    const { devices, file } = await registry();
    const { code } = devices.startPairing();
    const { token } = await devices.pair(code, "laptop");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(token);
    expect(Object.keys((JSON.parse(text) as { devices: object[] }).devices[0]!).sort()).toEqual(["id", "name", "pairedAt"]);
  });

  it("strips control characters from a device's name and bounds its length", async () => {
    const { devices } = await registry();
    const { device } = await devices.pair(devices.startPairing().code, `evil\u001b[2Jname${"x".repeat(100)}`);
    expect(device.name.startsWith("evil[2Jname")).toBe(true);
    expect(device.name.length).toBe(64);
  });
});

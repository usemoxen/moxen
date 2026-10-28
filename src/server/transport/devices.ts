/**
 * Who may use remote access: paired devices, and the pairing code that
 * makes one.
 *
 * A pairing code is short-lived (`PAIRING_TTL_MS`), single-use, and dies
 * after `PAIRING_MAX_ATTEMPTS` wrong guesses; there is at most one at a
 * time. A device that presents it gets an id and a long-lived token, and
 * from then on connects with those alone.
 *
 * Tokens are credentials, so they live only in the OS keychain (one entry
 * per device, `remote-device-<id>`). The device list beside them — id,
 * name, when it paired and was last seen — is not, and lives in
 * `~/.moxen/remote/devices.json`: listing devices must not need the
 * keychain. A device whose list entry is gone is revoked even if its
 * keychain entry lingers.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { appHomeDir } from "../../core/config.js";
import { CliError } from "../../core/errors.js";
import { readSecretStrict, writeSecret } from "../../core/secrets.js";

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;
/** `lastSeenAt` is written at most this often per device. */
const LAST_SEEN_WRITE_MS = 60_000;
const DEVICE_NAME_MAX = 64;

/** Crockford-style: no 0/O, 1/I/L, U — easy to read out and type. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: string;
  readonly lastSeenAt?: string;
}

export interface PairingCode {
  /** As shown: `ABCD-EFGH`. Typed with or without the dash, in any case. */
  readonly code: string;
  readonly expiresAt: string;
}

/** The keychain, as far as devices need it. Tests pass a map. */
export interface TokenStore {
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
}

const keychainTokens: TokenStore = {
  read: (name) => readSecretStrict(name),
  write: (name, value) => writeSecret(name, value),
};

export interface DeviceRegistryOptions {
  /** The device list file; `~/.moxen/remote/devices.json` by default. */
  readonly file?: string;
  readonly tokens?: TokenStore;
  readonly now?: () => number;
}

export class DeviceRegistry {
  private readonly file: string;
  private readonly tokens: TokenStore;
  private readonly now: () => number;
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null;
  /** Writes to the list run one at a time. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(options: DeviceRegistryOptions = {}) {
    this.file = options.file ?? path.join(appHomeDir(), "remote", "devices.json");
    this.tokens = options.tokens ?? keychainTokens;
    this.now = options.now ?? Date.now;
  }

  /** A new pairing code, replacing any earlier one. */
  startPairing(): PairingCode {
    const bytes = randomBytes(CODE_LENGTH);
    const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pairing = { code, expiresAt, attempts: 0 };
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  /** The code still open, if any (the TUI re-shows it). */
  openPairing(): PairingCode | null {
    const pairing = this.pairing;
    if (pairing === null || this.now() >= pairing.expiresAt) return null;
    return { code: `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`, expiresAt: new Date(pairing.expiresAt).toISOString() };
  }

  /**
   * Trade the code for a device. Every failure looks the same from outside
   * (no code open, expired, wrong, used up), so a guesser learns nothing.
   */
  async pair(code: unknown, name: unknown): Promise<{ device: PairedDevice; token: string }> {
    const pairing = this.pairing;
    const typed = typeof code === "string" ? code.toUpperCase().replace(/[\s-]/g, "") : "";
    if (pairing === null || this.now() >= pairing.expiresAt) {
      this.pairing = null;
      throw refusedCode();
    }
    if (!sameText(typed, pairing.code)) {
      pairing.attempts += 1;
      if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) this.pairing = null;
      throw refusedCode();
    }
    this.pairing = null; // single use
    const device: PairedDevice = { id: randomUUID(), name: deviceName(name), pairedAt: new Date(this.now()).toISOString() };
    const token = randomBytes(32).toString("base64url");
    await this.tokens.write(tokenName(device.id), token);
    await this.update((devices) => [...devices, device]);
    return { device, token };
  }

  /** The device `id` and `token` name, or a refusal. */
  async authenticate(id: unknown, token: unknown): Promise<PairedDevice> {
    if (typeof id !== "string" || typeof token !== "string" || id === "" || token === "") throw refusedDevice();
    const device = (await this.list()).find((candidate) => candidate.id === id);
    if (!device) throw refusedDevice();
    let stored: string | null;
    try {
      stored = await this.tokens.read(tokenName(id));
    } catch (cause) {
      throw new CliError("REMOTE_KEYCHAIN_UNAVAILABLE", `The server could not read its keychain to check this device: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (stored === null || !sameText(token, stored)) throw refusedDevice();
    const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (this.now() - seen >= LAST_SEEN_WRITE_MS) {
      const lastSeenAt = new Date(this.now()).toISOString();
      await this.update((devices) => devices.map((entry) => (entry.id === id ? { ...entry, lastSeenAt } : entry))).catch(() => undefined);
      return { ...device, lastSeenAt };
    }
    return device;
  }

  async list(): Promise<PairedDevice[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as { devices?: unknown };
      return Array.isArray(parsed.devices) ? parsed.devices.filter(isDevice) : [];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  /** Forget a device: its list entry and its token. False when there was none. */
  async revoke(id: string): Promise<boolean> {
    let found = false;
    await this.update((devices) => {
      found = devices.some((device) => device.id === id);
      return devices.filter((device) => device.id !== id);
    });
    // The list entry is what authenticates; the token goes too, best effort.
    await this.tokens.write(tokenName(id), "").catch(() => undefined);
    return found;
  }

  private update(change: (devices: PairedDevice[]) => PairedDevice[]): Promise<void> {
    const run = this.writes.then(async () => {
      const next = change(await this.list());
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ devices: next }, null, 2)}\n`, "utf8");
      await rename(temporary, this.file);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}

export const tokenName = (deviceId: string): string => `remote-device-${deviceId}`;

function deviceName(name: unknown): string {
  const text = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
  return (text || "Unnamed device").slice(0, DEVICE_NAME_MAX);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isDevice(value: unknown): value is PairedDevice {
  const record = value as Record<string, unknown> | null;
  return typeof record?.id === "string" && typeof record.name === "string" && typeof record.pairedAt === "string";
}

function refusedCode(): CliError {
  return new CliError("REMOTE_PAIRING_REFUSED", "That pairing code is wrong or has expired. Show a new one on the server and try again.");
}

function refusedDevice(): CliError {
  return new CliError("REMOTE_DEVICE_REFUSED", "This device is not paired with the moxen server, or was revoked. Pair it again.");
}

/**
 * The servers this machine has paired with: the client side of remote
 * access (`./remoteaccess.ts` and `./devices.ts` are the server side).
 *
 * Each entry names a server, where it is, the pin of its key, and the
 * device id this machine was given. The token that goes with the id is a
 * credential and lives only in the OS keychain (`remote-server-<deviceId>`);
 * the list itself, `~/.moxen/remote/servers.json`, holds nothing secret.
 *
 * `pairWithServer` is the one time a connection is made without a pin: the
 * pairing code the server showed vouches for it, and the pin it presents
 * is then remembered. Every later connection must present the same key.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appHomeDir } from "../../core/config.js";
import { DEFAULT_REMOTE_PORT } from "../../core/configschema.js";
import { CliError } from "../../core/errors.js";
import { readSecretStrict, writeSecret } from "../../core/secrets.js";
import { RemoteConnection, type RemoteConnectionOptions } from "./remote.js";
import type { TokenStore } from "./devices.js";

export interface PairedServer {
  /** What `--server` and `MOXEN_SERVER` name it by: the server's host name unless chosen. */
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** The pin of the server's key (`keyFingerprint`). */
  readonly fingerprint: string;
  /** This machine, as the server knows it. */
  readonly deviceId: string;
  readonly pairedAt: string;
}

export interface PairedServersOptions {
  /** The list file; `~/.moxen/remote/servers.json` by default. */
  readonly file?: string;
  readonly tokens?: TokenStore;
}

const keychainTokens: TokenStore = {
  read: (name) => readSecretStrict(name),
  write: (name, value) => writeSecret(name, value),
};

export const serverTokenName = (deviceId: string): string => `remote-server-${deviceId}`;

export class PairedServers {
  private readonly file: string;
  private readonly tokens: TokenStore;

  constructor(options: PairedServersOptions = {}) {
    this.file = options.file ?? path.join(appHomeDir(), "remote", "servers.json");
    this.tokens = options.tokens ?? keychainTokens;
  }

  async list(): Promise<PairedServer[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as { servers?: unknown };
      return Array.isArray(parsed.servers) ? parsed.servers.filter(isServer) : [];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  /** A saved server by name, or by the address it was paired at. */
  async find(nameOrAddress: string): Promise<PairedServer | null> {
    const servers = await this.list();
    const byName = servers.find((server) => server.name.toLowerCase() === nameOrAddress.toLowerCase());
    if (byName) return byName;
    const address = tryParseAddress(nameOrAddress);
    return address ? (servers.find((server) => server.host === address.host && server.port === address.port) ?? null) : null;
  }

  /**
   * Pair with the server at `address` using the code it showed. Replaces an
   * earlier pairing with the same name or address, forgetting its token.
   */
  async pair(options: { address: string; code: string; name?: string; deviceName?: string }): Promise<PairedServer> {
    const { host, port } = parseServerAddress(options.address);
    const connection = await RemoteConnection.connect(`${formatHost(host)}:${port}`, {
      reconnect: false,
      tls: { host, port },
      hello: { pair: { code: options.code, deviceName: options.deviceName ?? os.hostname() } },
    });
    const hello = connection.helloResult;
    const fingerprint = connection.peerFingerprint;
    await connection.close();
    if (!hello?.deviceId || !hello.token || !fingerprint) {
      throw new CliError("REMOTE_PAIRING_FAILED", "The server accepted the code but sent no device credentials. Is it the same moxen version?");
    }
    const name = (options.name?.trim() || hello.serverName || host).slice(0, 64);
    const server: PairedServer = { name, host, port, fingerprint, deviceId: hello.deviceId, pairedAt: new Date().toISOString() };
    await this.tokens.write(serverTokenName(server.deviceId), hello.token);
    const existing = await this.list();
    const replaced = new Set(existing.filter((entry) => entry.name.toLowerCase() === name.toLowerCase() || (entry.host === host && entry.port === port)).map((entry) => entry.deviceId));
    for (const deviceId of replaced) await this.tokens.write(serverTokenName(deviceId), "").catch(() => undefined);
    await this.save([...existing.filter((entry) => !replaced.has(entry.deviceId)), server]);
    return server;
  }

  /** Forget a server: its entry and its token. The server still lists this device until revoked there. */
  async forget(nameOrAddress: string): Promise<PairedServer> {
    const server = await this.find(nameOrAddress);
    if (!server) throw notPaired(nameOrAddress);
    await this.save((await this.list()).filter((entry) => entry.deviceId !== server.deviceId));
    await this.tokens.write(serverTokenName(server.deviceId), "").catch(() => undefined);
    return server;
  }

  /** How to open a `RemoteConnection` to a saved server: TLS, the pin, and this device's token. */
  async connectionOptions(server: PairedServer): Promise<RemoteConnectionOptions & { endpoint: string }> {
    let token: string | null;
    try {
      token = await this.tokens.read(serverTokenName(server.deviceId));
    } catch (cause) {
      throw new CliError("REMOTE_KEYCHAIN_UNAVAILABLE", `Could not read this device's token for ${server.name} from the keychain: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (token === null) {
      throw new CliError("REMOTE_DEVICE_REFUSED", `The keychain has no token for ${server.name}. Pair with it again.`, { details: { server: server.name } });
    }
    return {
      endpoint: `${formatHost(server.host)}:${server.port}`,
      tls: { host: server.host, port: server.port, fingerprint: server.fingerprint },
      hello: { device: { id: server.deviceId, token } },
    };
  }

  private async save(servers: PairedServer[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}

/** `host`, `host:port`, `[ipv6]` or `[ipv6]:port`; the port defaults to remote access's. */
export function parseServerAddress(address: string): { host: string; port: number } {
  const parsed = tryParseAddress(address);
  if (!parsed) {
    throw new CliError("INVALID_ADDRESS", `"${address}" is not a server address. Use host or host:port, e.g. 192.168.1.20:${DEFAULT_REMOTE_PORT}.`, { exitCode: 2 });
  }
  return parsed;
}

function tryParseAddress(address: string): { host: string; port: number } | null {
  const text = address.trim();
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(text);
  const plain = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(text);
  const bareIpv6 = /^[0-9a-fA-F]*:[0-9a-fA-F:]+$/.test(text) && text.split(":").length > 2 ? [text, text, undefined] : null;
  const match = bracketed ?? plain ?? bareIpv6;
  if (!match || !match[1]) return null;
  const port = match[2] === undefined ? DEFAULT_REMOTE_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function notPaired(nameOrAddress: string): CliError {
  return new CliError("REMOTE_SERVER_UNKNOWN", `No paired server named ${nameOrAddress}. Pair with it first: moxen remote pair <address> <code>.`, {
    exitCode: 2,
    details: { server: nameOrAddress },
  });
}

function isServer(value: unknown): value is PairedServer {
  const record = value as Record<string, unknown> | null;
  return (
    typeof record?.name === "string" &&
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    typeof record.fingerprint === "string" &&
    typeof record.deviceId === "string"
  );
}

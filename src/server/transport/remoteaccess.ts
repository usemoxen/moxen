/**
 * Remote access: the server, reached from another machine.
 *
 * Beside the local endpoint (`./endpoint.ts`, always on) the server can
 * listen on TCP over TLS, carrying the same wire (`./wire.ts`) to the same
 * socket handler (`./serve.ts`). It is off by default and, when on, binds
 * only the addresses `remote.interfaces` names — the machine's private LAN
 * addresses, its Tailscale address, or both — never every address at once.
 * Turning it off closes the listeners and drops every remote socket, so
 * nothing listens beyond this machine.
 *
 * The TLS identity is a P-256 key kept in the OS keychain and a certificate
 * rebuilt from it on each start (`./certificate.ts`); clients pin the key.
 * Nothing about it is written to disk.
 */
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

import { DEFAULT_REMOTE_PORT } from "../../core/configschema.js";
import { CliError } from "../../core/errors.js";
import { readSecretStrict, writeSecret } from "../../core/secrets.js";
import type { RemoteConfig, RemoteInterfaces } from "../../core/types.js";
import type { ClientApi } from "../api.js";
import { createTlsKey, tlsIdentity, type TlsIdentity } from "./certificate.js";
import { handleSocket, type SocketContext } from "./serve.js";

/** The keychain entry holding the listener's private key. */
export const REMOTE_TLS_KEY_SECRET = "remote-tls-key";

export type RemoteAddressKind = "lan" | "tailscale";

export interface RemoteAddress {
  readonly address: string;
  readonly family: "IPv4" | "IPv6";
  readonly kind: RemoteAddressKind;
  /** The network interface it belongs to (`en0`, `Tailscale`, …). */
  readonly interface: string;
}

export interface RemoteAccessStatus {
  readonly enabled: boolean;
  readonly interfaces: RemoteInterfaces;
  readonly port: number;
  /** What is listening right now: empty when off. */
  readonly listening: readonly RemoteAddress[];
  /** The pin clients check, once the identity has been loaded. */
  readonly fingerprint?: string;
  /** Why the last apply left nothing listening although enabled. */
  readonly error?: string;
}

/** A remote socket's admission check (pairing and device tokens). */
export type RemoteAdmit = NonNullable<SocketContext["admit"]>;

export interface RemoteAccessOptions {
  readonly api: ClientApi;
  readonly admit?: RemoteAdmit;
  /** The identity source; the keychain by default. Tests pass a fixed one. */
  readonly identity?: () => Promise<TlsIdentity>;
  /** The addresses to bind; this machine's, by `remoteAddresses`, by default. Tests bind loopback. */
  readonly addresses?: (interfaces: RemoteInterfaces) => RemoteAddress[];
}

export class RemoteAccess {
  private servers: tls.Server[] = [];
  private readonly sockets = new Set<net.Socket>();
  private current: RemoteAccessStatus = { enabled: false, interfaces: "both", port: DEFAULT_REMOTE_PORT, listening: [] };
  private identity: TlsIdentity | null = null;
  /** Applies run one at a time: a toggle racing a toggle must not leak a listener. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RemoteAccessOptions) {}

  status(): RemoteAccessStatus {
    return this.current;
  }

  /**
   * Make the listeners match `config`: off closes everything; on (re)binds
   * the chosen addresses. Throws when on but nothing could be bound, after
   * closing what was open — a half-applied "on" is not left behind.
   */
  apply(config: RemoteConfig | undefined): Promise<RemoteAccessStatus> {
    const run = this.queue.then(() =>
      this.applyNow(config).catch((cause: unknown) => {
        this.current = { ...this.current, listening: [], error: cause instanceof Error ? cause.message : String(cause) };
        throw cause;
      }),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Close every listener and remote socket. */
  close(): Promise<RemoteAccessStatus> {
    return this.apply({ enabled: false });
  }

  private async applyNow(config: RemoteConfig | undefined): Promise<RemoteAccessStatus> {
    const enabled = config?.enabled === true;
    const interfaces = config?.interfaces ?? "both";
    const port = config?.port ?? DEFAULT_REMOTE_PORT;
    await this.stop();
    this.current = { enabled, interfaces, port, listening: [], ...(this.identity ? { fingerprint: this.identity.fingerprint } : {}) };
    if (!enabled) return this.current;

    const addresses = this.options.addresses?.(interfaces) ?? remoteAddresses(interfaces, os.networkInterfaces());
    if (addresses.length === 0) {
      throw new CliError("REMOTE_NO_ADDRESS", noAddressMessage(interfaces), { details: { interfaces } });
    }
    this.identity ??= await (this.options.identity ?? loadTlsIdentity)();
    const listening: RemoteAddress[] = [];
    const failures: string[] = [];
    for (const address of addresses) {
      try {
        this.servers.push(await this.listen(address, port, this.identity));
        listening.push(address);
      } catch (cause) {
        failures.push(`${address.address}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (listening.length === 0) {
      throw new CliError("REMOTE_LISTEN_FAILED", `Remote access could not listen on port ${port}. ${failures.join("; ")}`, {
        details: { port, failures },
      });
    }
    this.current = { enabled, interfaces, port, listening, fingerprint: this.identity.fingerprint };
    return this.current;
  }

  private async listen(address: RemoteAddress, port: number, identity: TlsIdentity): Promise<tls.Server> {
    const server = tls.createServer({ cert: identity.cert, key: identity.key, minVersion: "TLSv1.3" }, (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      handleSocket(socket, this.options.api, {
        remote: true,
        shutdown: () => undefined,
        ...(this.options.admit ? { admit: this.options.admit } : {}),
      });
    });
    // A failed handshake (a port scanner, a client that refused our key)
    // is that client's problem, not the server's.
    server.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: address.address, port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", () => undefined);
    return server;
  }

  private async stop(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

/**
 * The listener's identity from the keychain, creating the key on first use.
 * A keychain that cannot answer is an error, never "no key": replacing the
 * key would unpair every device.
 */
export async function loadTlsIdentity(): Promise<TlsIdentity> {
  let key: string | null;
  try {
    key = await readSecretStrict(REMOTE_TLS_KEY_SECRET);
  } catch (cause) {
    throw keychainError(cause);
  }
  if (key === null) {
    key = createTlsKey();
    try {
      await writeSecret(REMOTE_TLS_KEY_SECRET, key);
    } catch (cause) {
      throw keychainError(cause);
    }
  }
  return tlsIdentity(key, `moxen@${os.hostname()}`);
}

function keychainError(cause: unknown): CliError {
  return new CliError(
    "REMOTE_KEYCHAIN_UNAVAILABLE",
    `Remote access keeps its TLS key in the OS keychain, which could not be reached: ${cause instanceof Error ? cause.message : String(cause)}. On Windows, a server started from an SSH session has no Credential Manager; start it from a desktop session.`,
  );
}

function noAddressMessage(interfaces: RemoteInterfaces): string {
  if (interfaces === "tailscale") return "This machine has no Tailscale address. Start Tailscale, or listen on the local network instead.";
  if (interfaces === "lan") return "This machine has no private local-network address to listen on.";
  return "This machine has neither a private local-network address nor a Tailscale address to listen on.";
}

/**
 * The addresses `interfaces` selects, from `os.networkInterfaces()`.
 *
 * Tailscale: 100.64.0.0/10 and fd7a:115c:a1e0::/48, the ranges it assigns.
 * LAN: the private IPv4 ranges and IPv6 unique-local addresses (outside
 * Tailscale's). Loopback, link-local and public addresses never qualify —
 * a public address would put the server on the internet.
 */
export function remoteAddresses(interfaces: RemoteInterfaces, network: NodeJS.Dict<os.NetworkInterfaceInfo[]>): RemoteAddress[] {
  const wanted = (kind: RemoteAddressKind): boolean => interfaces === "both" || interfaces === kind;
  const found: RemoteAddress[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(network)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const family = entry.family === "IPv6" || (entry.family as unknown) === 6 ? "IPv6" : "IPv4";
      const kind = classifyAddress(entry.address, family);
      if (kind === null || !wanted(kind) || seen.has(entry.address)) continue;
      seen.add(entry.address);
      found.push({ address: entry.address, family, kind, interface: name });
    }
  }
  // IPv4 first: it is what a person reads out and types on the other machine.
  return found.sort((a, b) => (a.family === b.family ? 0 : a.family === "IPv4" ? -1 : 1));
}

export function classifyAddress(address: string, family: "IPv4" | "IPv6"): RemoteAddressKind | null {
  if (family === "IPv4") {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const [a = 0, b = 0] = octets;
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
    return null;
  }
  const lower = address.toLowerCase();
  if (lower.includes("%")) return null; // scoped, i.e. link-local
  if (lower.startsWith("fd7a:115c:a1e0:")) return "tailscale";
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return "lan";
  return null;
}

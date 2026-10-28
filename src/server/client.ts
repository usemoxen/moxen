/**
 * How a frontend gets its `ClientApi`: the one factory both clients call.
 *
 * - `direct`  — in-process `DirectConnection`. The client owns its drivers;
 *               what it starts lives and dies with it.
 * - `auto`    — a running moxen server if there is one, else `direct`.
 *               The default: nothing changes until a server is started.
 * - `daemon`  — a moxen server, started detached if none is running. Turns
 *               outlive the client that started them, and every client
 *               sees (and can act on) every live session.
 *
 * Chosen by `MOXEN_SERVER`; `auto` when unset. Any other value names a
 * paired server on another machine (`./transport/servers.ts`), as
 * `--server` does: that one is used over TLS, never started, and never
 * silently swapped for a local connection when it cannot be reached.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CliError } from "../core/errors.js";
import type { CliConfig } from "../core/types.js";
import type { ClientApi } from "./api.js";
import { DirectConnection, type TurnDriverFactories } from "./connection.js";
import { defaultEndpoint, probe } from "./transport/endpoint.js";
import { RemoteConnection } from "./transport/remote.js";
import { notPaired, PairedServers, type PairedServer } from "./transport/servers.js";
import { remoteServerName, serverMode, type ServerMode } from "./servermode.js";

export { remoteServerName, serverMode, type ServerMode } from "./servermode.js";

/** A `ClientApi` its owner can release. */
export type ClientConnection = ClientApi & { close(): Promise<void> };


export interface OpenClientOptions {
  readonly mode?: ServerMode;
  /** A paired server by name or address (`--server`); wins over `mode` and `MOXEN_SERVER`. */
  readonly server?: string;
  readonly endpoint?: string;
  /**
   * In-process only: a fixed config, for one-shot callers (the CLI) and
   * tests. A long-lived client must pass `configPath` instead — a fixed
   * object is frozen at launch, so edits made while it runs (the settings
   * page) would never be seen and each write would clobber the last.
   */
  readonly config?: CliConfig;
  /** In-process only: the file to re-read per operation. */
  readonly configPath?: string;
  /** In-process only: driver factories (tests). */
  readonly drivers?: TurnDriverFactories;
}

const AUTOSTART_TIMEOUT_MS = 10_000;

export async function openClient(options: OpenClientOptions = {}): Promise<ClientConnection> {
  const remote = options.server ?? (options.mode === undefined ? remoteServerName() : null);
  if (remote) return await connectPairedServer(remote);
  const mode = options.mode ?? serverMode();
  const endpoint = options.endpoint ?? defaultEndpoint();
  const direct = (): ClientConnection =>
    new DirectConnection({
      ...(options.config ? { config: async () => options.config! } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.drivers ? { drivers: options.drivers } : {}),
    });
  if (mode === "direct") return direct();
  if (await probe(endpoint)) return await RemoteConnection.connect(endpoint);
  if (mode === "auto") return direct();
  await startDaemon(endpoint);
  return await RemoteConnection.connect(endpoint);
}

/** A connection to a paired server on another machine. Its `pairedServer` says which. */
export async function connectPairedServer(nameOrAddress: string, servers = new PairedServers()): Promise<RemoteConnection & { readonly pairedServer: PairedServer }> {
  const server = await servers.find(nameOrAddress);
  if (!server) throw notPaired(nameOrAddress);
  const { endpoint, ...options } = await servers.connectionOptions(server);
  const connection = await RemoteConnection.connect(endpoint, options);
  return Object.assign(connection, { pairedServer: server });
}

/**
 * The server entry: `./daemon.ts` in the source tree, `server/daemon.js` beside
 * `cli/` in the bundle (where this code lives in a chunk under `chunks/`).
 */
function serverEntry(): string {
  const source = fileURLToPath(new URL("./daemon.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("../server/daemon.js", import.meta.url));
}

/** Start the server entry detached and wait until it accepts connections. */
async function startDaemon(endpoint: string): Promise<void> {
  const entry = serverEntry();
  // The server is Bun: this runtime when it is Bun, else `bun` from PATH —
  // e.g. when the caller runs under Node.
  const runtime = process.versions.bun ? process.execPath : "bun";
  const child = spawn(runtime, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, MOXEN_SERVER_ENDPOINT: endpoint },
  });
  child.unref();
  const deadline = Date.now() + AUTOSTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new CliError("SERVER_START_FAILED", `Started a moxen server but it never listened at ${endpoint}.`, {
    details: { endpoint, pid: child.pid ?? null },
  });
}

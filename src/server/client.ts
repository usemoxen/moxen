/**
 * How a frontend gets its `ClientApi`: the one factory every client calls.
 *
 * Clients never run moxen themselves: every change goes through a moxen
 * server. By default that is this machine's, started detached when none is
 * running (`./daemon.ts`), so turns outlive the client that started them
 * and every client sees every live session.
 *
 * `--server <name>` or `MOXEN_SERVER=<name>` names a paired server on
 * another machine (`./transport/servers.ts`) instead: used over TLS, never
 * started, and never silently swapped for a local one when it cannot be
 * reached. `MOXEN_SERVER=auto|daemon` still mean this machine's server, as
 * before; `direct` is refused.
 *
 * In-process (`mode: "direct"`) is for the server itself and for tests,
 * which pass their own drivers; nothing a user can choose.
 *
 * The server runs on its own config file. A client that asked for one
 * (`MOXEN_CONFIG`, which `--config` sets) has it passed to a server it
 * starts, and refuses a running server on another file rather than
 * quietly using that one.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appEnv, defaultConfigPath } from "../core/config.js";
import { CliError } from "../core/errors.js";
import { workspaceRootsEqual } from "../core/projects/projects.js";
import { resolveOnPath } from "../core/infra/process.js";
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
  /** `direct`: in-process, for the server and tests only. Default: this machine's server. */
  readonly mode?: ServerMode;
  /** A paired server by name or address (`--server`); wins over `mode` and `MOXEN_SERVER`. */
  readonly server?: string;
  readonly endpoint?: string;
  /**
   * In-process only: a fixed config, for tests. A long-lived caller must
   * pass `configPath` instead — a fixed object is frozen at launch, so
   * edits made while it runs would never be seen and each write would
   * clobber the last.
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
  if (mode === "direct") {
    return new DirectConnection({
      ...(options.config ? { config: async () => options.config! } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.drivers ? { drivers: options.drivers } : {}),
    });
  }
  const endpoint = options.endpoint ?? defaultEndpoint();
  if (!(await probe(endpoint))) await startDaemon(endpoint);
  const connection = await RemoteConnection.connect(endpoint);
  const wanted = appEnv("CONFIG") ? defaultConfigPath() : null;
  // A server too old to say which file it runs on is refused too: going
  // ahead would read and write a config nobody asked for.
  const running = connection.helloResult?.configPath ?? null;
  // Compared as paths: the same file can be spelled `c:\` or `C:\` on Windows.
  if (wanted !== null && (running === null || !workspaceRootsEqual(running, wanted))) {
    await connection.close();
    throw new CliError(
      "SERVER_CONFIG_MISMATCH",
      `The moxen server at ${endpoint} runs on ${running ?? "a config it does not report (an older build)"}, not ${wanted}. Stop it (moxen server stop) so one starts on ${wanted}, or drop --config / MOXEN_CONFIG to use it as it is.`,
      { exitCode: 2, details: { endpoint, running, wanted } },
    );
  }
  return connection;
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
  let runtime = process.versions.bun ? process.execPath : "bun";
  // Bun installed through npm is a `bun.cmd` shim on Windows, which only the shell can start.
  if (runtime === "bun" && process.platform === "win32") runtime = resolveOnPath("bun") ?? runtime;
  const shim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(runtime);
  const child = spawn(shim ? `"${runtime}"` : runtime, [shim ? `"${entry}"` : entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: shim,
    env: { ...process.env, MOXEN_SERVER_ENDPOINT: endpoint },
  });
  let failed: Error | null = null;
  child.once("error", (cause) => {
    failed = cause;
  });
  child.unref();
  const deadline = Date.now() + AUTOSTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(endpoint)) return;
    if (failed !== null) {
      throw new CliError("SERVER_START_FAILED", `Could not start a moxen server: ${runtime} would not run (${(failed as Error).message}). The server needs Bun on PATH.`, {
        cause: failed,
        details: { endpoint, runtime },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new CliError("SERVER_START_FAILED", `Started a moxen server but it never listened at ${endpoint}.`, {
    details: { endpoint, pid: child.pid ?? null },
  });
}

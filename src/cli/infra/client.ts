/**
 * The CLI's `ClientApi`. Every command talks to the server through this,
 * the same contract the TUI uses: a running moxen server when there is one
 * (`MOXEN_SERVER`, see `server/client.ts`), the in-process connection
 * otherwise.
 *
 * Not closed after a command: closing an in-process connection stops its
 * drivers, which would end the run a `--no-wait` command just started.
 * The process exit ends them. (Over a server, the run lives on there.)
 */
import type { ClientApi } from "../../server/api.js";
import { CliError } from "../../core/errors.js";
import { openClient, remoteServerName, type ClientConnection } from "../../server/client.js";
import type { TurnDriverFactories } from "../../server/connection.js";
import type { CliConfig } from "../../core/types.js";

export type { TurnDriverFactories } from "../../server/connection.js";

let factory: ((config: CliConfig) => Promise<ClientConnection>) | null = null;
let forceDirect = false;
let remoteFlag: string | null = null;
/** One TLS connection per invocation: each opens a handshake and reads the keychain. */
let remoteClient: Promise<ClientConnection> | null = null;

/** `--server <name|address>`: a paired server on another machine, for this invocation. */
export function useRemoteServer(nameOrAddress: string | null): void {
  remoteFlag = nameOrAddress;
  remoteClient = null;
}

/** The paired server this invocation talks to (`--server`, else `MOXEN_SERVER`), or null for this machine's. */
export function activeRemoteServer(): string | null {
  return remoteFlag ?? remoteServerName();
}

/**
 * The folder to send as a command's `cwd`. On this machine, the given one
 * or the current one. On a remote server the current folder means nothing
 * there, so only an explicit one (a path on the server) is sent; a command
 * that needs one says so. `scratch` threads ignore it, so they need none.
 */
export function serverCwd(explicit: string | undefined, options: { scratch?: boolean } = {}): string {
  if (activeRemoteServer() === null) return explicit ?? process.cwd();
  if (explicit !== undefined) return explicit;
  if (options.scratch) return ".";
  throw new CliError(
    "REMOTE_CWD_REQUIRED",
    `The moxen server is on another machine (${activeRemoteServer()}), where this folder does not exist. Pass --cwd with a folder on the server (moxen projects list shows them), or --no-project for a scratch thread.`,
    { exitCode: 2 },
  );
}

/** Tests: route every command through a given client (e.g. over the wire). */
export function setClientFactory(next: ((config: CliConfig) => Promise<ClientConnection>) | null): void {
  factory = next;
}

/**
 * An explicit `--config` file applies to this invocation only; a running
 * server resolves defaults from its own config, so such a command stays
 * in-process rather than silently ignoring the flag.
 */
export function preferDirectClient(value: boolean): void {
  forceDirect = value;
}

export async function cliClient(config: CliConfig, drivers?: TurnDriverFactories, configPath?: string): Promise<ClientApi> {
  if (factory) return await factory(config);
  const remote = activeRemoteServer();
  if (remote !== null && !drivers) {
    if (forceDirect) {
      throw new CliError("REMOTE_CONFIG_CONFLICT", "--config applies to this machine; a remote server uses its own settings. Drop one of --config and --server.", { exitCode: 2 });
    }
    remoteClient ??= openClient({ server: remote });
    return await remoteClient;
  }
  return await openClient({
    // A command that reads back what it just wrote (the harness profile editor) passes the file, not the launch-time object.
    ...(configPath ? { configPath } : { config }),
    ...(drivers ? { drivers, mode: "direct" as const } : forceDirect ? { mode: "direct" as const } : {}),
  });
}

/**
 * Block until a turn settles. A one-shot CLI is often the only process
 * running the turn, so returning early would strand it `running`; Ctrl-C
 * interrupts the turn (keeping the thread) and exits 130.
 */
export async function awaitTurn(client: ClientApi, threadId: string, turnId: string): Promise<void> {
  const onSigint = (): void => {
    void client
      .dispatch({ type: "thread.turn.interrupt", threadId })
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  try {
    await client.query({ type: "thread.turn.await", threadId, turnId });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

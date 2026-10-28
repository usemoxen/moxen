/**
 * The CLI's `ClientApi`. Every command talks to a moxen server through
 * this, the same contract the TUI uses: this machine's, started when none
 * is running, or a paired one (`server/client.ts`). The CLI never runs
 * moxen in-process; a run a `--no-wait` command starts lives on in the
 * server after the command exits.
 */
import type { ClientApi } from "../../server/api.js";
import { CliError } from "../../core/errors.js";
import type { ClientConnection, OpenClientOptions } from "../../server/client.js";
import { remoteServerName } from "../../server/servermode.js";
import type { TurnDriverFactories } from "../../server/connection.js";
import type { CliConfig } from "../../core/types.js";

export type { TurnDriverFactories } from "../../server/connection.js";

let factory: ((config: CliConfig) => Promise<ClientConnection>) | null = null;

/**
 * The client factory, loaded on first use: it pulls in the whole server
 * side (the in-process connection, every driver), which a command that
 * never opens a client — and every test file that only sets a default — has
 * no reason to load.
 */
async function openClient(options?: OpenClientOptions): Promise<ClientConnection> {
  return await (await import("../../server/client.js")).openClient(options);
}
type TestClient = (config: CliConfig, configPath?: string, drivers?: TurnDriverFactories) => Promise<ClientConnection>;
/** Tests: what every command gets when a test set no `factory` (`src/cli/tests/setup.ts`). */
let testDefault: TestClient | null = null;
let configFlag = false;
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

/** Tests only: the client every command gets when no test set its own — in-process, never a real server. */
export function setTestClientDefault(next: TestClient | null): void {
  testDefault = next;
}

/**
 * `--config` was given. It names the config of this machine's server (it
 * sets `MOXEN_CONFIG`, which `server/client.ts` checks the running server
 * against); a paired server runs on its own, so the two together are a mistake.
 */
export function configFlagGiven(value: boolean): void {
  configFlag = value;
}

/** Always a server; `drivers` are a test's, which only the test default (in-process) can take. */
export async function cliClient(config: CliConfig, drivers?: TurnDriverFactories, configPath?: string): Promise<ClientApi> {
  if (factory) return await factory(config);
  if (testDefault) return await testDefault(config, configPath, drivers);
  if (drivers) throw new CliError("INTERNAL", "Driver factories are for tests, which run with a test client default.");
  const remote = activeRemoteServer();
  if (remote !== null) {
    if (configFlag) {
      throw new CliError("REMOTE_CONFIG_CONFLICT", "--config applies to this machine; a remote server uses its own settings. Drop one of --config and --server.", { exitCode: 2 });
    }
    remoteClient ??= openClient({ server: remote });
    return await remoteClient;
  }
  return await openClient();
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

/**
 * The moxen server process: one `DirectConnection` — the store, the
 * drivers, every live provider session — served over the local endpoint
 * to any number of clients.
 *
 * Run it in the foreground with `moxen server start`, or let a client
 * start it (`MOXEN_SERVER=daemon`, see `./client.ts`), which runs this
 * file detached.
 */
import { defaultConfigPath, migrateLegacyConfig } from "../core/config.js";
import { buildIdentity } from "../core/build.js";
import { CliError } from "../core/errors.js";
import { resolveStoreRoot } from "../core/threads/store.js";
import type { CliConfig } from "../core/types.js";
import { DirectConnection, storeLockGone } from "./connection.js";
import { defaultEndpoint } from "./transport/endpoint.js";
import { RemoteAccess } from "./transport/remoteaccess.js";
import { serve, type ServerHandle } from "./transport/serve.js";

export interface RunServerOptions {
  readonly endpoint?: string;
  /** Config source; defaults to re-reading the user's config per operation. */
  readonly config?: () => Promise<CliConfig>;
}

/**
 * How long a starting server waits for a stopping one's store lock to
 * clear before refusing: `shutdown` is acknowledged before the drivers
 * drain and the lock is released, so an immediate restart would otherwise
 * meet a live lock and need a manual retry.
 */
const STORE_RETRY_WAIT_MS = 10_000;
const STORE_RETRY_POLL_MS = 100;

export async function runServer(options: RunServerOptions = {}): Promise<ServerHandle> {
  // The server owns the config file, so it is the one to bring an old one over.
  if (!options.config) migrateLegacyConfig();
  const connection = new DirectConnection(options.config ? { config: options.config } : {});
  // The greeting is read per hello: an update lands while the server runs,
  // and clients connecting after it must hear that a restart is due.
  const own = buildIdentity();
  const greeting = (): { configPath?: string; build: string; buildDisplay: string; restartRequired: boolean } => ({
    // Re-read per operation from this file, unless the caller fixed the config itself.
    ...(options.config ? {} : { configPath: defaultConfigPath() }),
    build: own.id,
    buildDisplay: own.display,
    restartRequired: connection.serverRestartRequired,
  });
  let handle: ServerHandle;
  try {
    // The store has one owner: a second server on it is refused before it
    // listens, not on the first client request. A lock from a crashed
    // server is taken over. A stopping server still holds a live lock just
    // after it acknowledged shutdown, so on STORE_OWNED wait for it to
    // clear and try once more before surfacing the error.
    try {
      await connection.claimStore();
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "STORE_OWNED") throw cause;
      const root = resolveStoreRoot();
      const deadline = Date.now() + STORE_RETRY_WAIT_MS;
      while (!(await storeLockGone(root))) {
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, STORE_RETRY_POLL_MS));
      }
      await connection.claimStore();
    }
    handle = await serve({
      endpoint: options.endpoint ?? defaultEndpoint(),
      api: connection,
      // Stops every driver: provider processes end with the server.
      onClose: () => connection.close(),
      greeting,
    });
    // The server owns every session, so it runs scheduled turns too — with
    // or without a client attached.
    connection.startScheduling();
    // Off unless `remote.enabled`; closed with the connection.
    await connection.attachRemoteAccess(new RemoteAccess({ api: connection }));
    return handle;
  } catch (cause) {
    await connection.close();
    throw cause;
  }
}

/** Stop on the usual signals, releasing the drivers first. */
export function closeOnSignals(handle: ServerHandle): void {
  const stop = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// `import.meta.main` only holds in the file Bun was asked to run, which a
// bundle's chunking can move away from: the bundle runs `./daemon.ts` instead.
if (import.meta.main) await import("./daemon.js");

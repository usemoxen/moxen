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
import type { CliConfig } from "../core/types.js";
import { DirectConnection } from "./connection.js";
import { defaultEndpoint } from "./transport/endpoint.js";
import { RemoteAccess } from "./transport/remoteaccess.js";
import { serve, type ServerHandle } from "./transport/serve.js";

export interface RunServerOptions {
  readonly endpoint?: string;
  /** Config source; defaults to re-reading the user's config per operation. */
  readonly config?: () => Promise<CliConfig>;
}

export async function runServer(options: RunServerOptions = {}): Promise<ServerHandle> {
  // The server owns the config file, so it is the one to bring an old one over.
  if (!options.config) migrateLegacyConfig();
  const connection = new DirectConnection(options.config ? { config: options.config } : {});
  try {
    const handle = await serve({
      endpoint: options.endpoint ?? defaultEndpoint(),
      api: connection,
      // Stops every driver: provider processes end with the server.
      onClose: () => connection.close(),
      // Re-read per operation from this file, unless the caller fixed the config itself.
      ...(options.config ? {} : { greeting: { configPath: defaultConfigPath() } }),
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

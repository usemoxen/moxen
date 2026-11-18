/** A private stdio transport for the native desktop, through the same client factory as the TUI.
 * The paired keychain token and TLS checks stay here, never in the desktop process.
 */
import { Duplex, type Readable, type Writable } from "node:stream";
import { openClient } from "./client.js";
import { RemoteConnection } from "./transport/remote.js";
import { handleSocket } from "./transport/serve.js";
import { toWireError } from "./transport/wire.js";

export async function runDesktopBridge(server?: string): Promise<void> {
  if (!(await desktopConnection(process.stdin, process.stdout, server))) process.exitCode = 2;
}

export async function desktopConnection(input: Readable, output: Writable, server?: string, connect = openClient): Promise<boolean> {
  const status = (value: object): void => { output.write(`${JSON.stringify(value)}\n`); };
  try {
    const client = await connect({
      ...(server === undefined ? {} : { server }),
      onStarting: () => status({ status: "starting" }),
      reconnect: false,
    });
    try {
      const socket = Duplex.from({ readable: input, writable: output });
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.once("end", () => socket.destroy());
      const remote = client instanceof RemoteConnection ? client : null;
      const stopListening = remote?.onLinkState((link) => {
        if (link.status === "failed") socket.destroy();
      });
      handleSocket(socket, client, {
        remote: false, // The upstream connection enforces its own remote restrictions.
        greeting: {
          build: "moxen-desktop",
          buildDisplay: "Moxen Agent desktop",
          restartRequired: remote?.helloResult?.restartRequired ?? false,
          clientLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
          ...(client.pairedServer ? { pairedName: client.pairedServer.name } : {}),
        },
      });
      status({ status: "ready" });
      await closed;
      stopListening?.();
    } finally {
      await client.close();
    }
    return true;
  } catch (cause) {
    await new Promise<void>((resolve) => {
      output.write(`${JSON.stringify({ status: "failed", error: toWireError(cause) })}\n`, () => resolve());
    });
    return false;
  }
}

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { CliError } from "../core/errors.js";
import type { CliConfig } from "../core/types.js";
import { App } from "./app/app.js";
import { openClient, type ClientConnection } from "../server/client.js";
import type { PairedServer } from "../server/transport/servers.js";
import type { ActiveServer } from "./features/remote/server.js";
import { registerSyntaxParsers } from "../core/syntax/register.js";
import { SURFACE } from "./theme.js";
import { MinSizeGate } from "./ui/terminalgate.js";

export async function runTui(config: CliConfig, configPath: string, server?: string): Promise<void> {
  // Fail fast when there is no pty at all (piped output, `ssh` without
  // `-t`): the renderer cannot size or restore the screen, so a plain
  // error beats a garbled one. Real resizes — local, tmux, or over SSH —
  // are handled live inside the app by `MinSizeGate` via SIGWINCH.
  if (process.stdout.isTTY !== true) {
    throw new CliError("TERMINAL_REQUIRED", "moxen tui needs an interactive terminal (over SSH, connect with ssh -t).", {
      exitCode: 2,
    });
  }

  // Before the first render so the global tree-sitter client picks them up.
  await registerSyntaxParsers();
  // In-process unless a moxen server is running (or MOXEN_SERVER says
  // otherwise): with one, closing the TUI no longer ends its turns.
  // The path, not the loaded object: the TUI outlives any one edit, and
  // the connection re-reads the file per operation so the settings page
  // (and anything else that changes it) takes effect without a restart.
  // `--server`: a paired server on another machine, whose own config rules there.
  // The palette can switch to another one (or back to this machine's) while
  // the TUI runs: the new connection is opened first, and only then is the
  // app remounted on it — a server that cannot be reached leaves this one.
  // This machine's connection is kept while away and reused on the way
  // back: in-process, it owns the turns it started, and closing it would end them.
  const kept: { local: ClientConnection | null } = { local: null };
  const connect = async (target: string | null): Promise<ClientConnection> => {
    if (target !== null) return await openClient({ server: target });
    kept.local ??= await openClient({ configPath });
    return kept.local;
  };
  let connection = await connect(server ?? null);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: SURFACE.base });
  const root = createRoot(renderer);

  try {
    for (let generation = 0; ; generation += 1) {
      const next = await new Promise<ClientConnection | null>((resolve) => {
        const onSwitchServer = async (target: string | null): Promise<void> => {
          resolve(await connect(target));
        };
        root.render(
        <MinSizeGate onQuit={() => resolve(null)}>
          <App
            key={generation}
            client={connection}
            server={activeServer(connection)}
            onSwitchServer={onSwitchServer}
            onQuit={() => resolve(null)}
            cwd={process.cwd()}
            setTerminalTitle={(title) => renderer.setTerminalTitle(title)}
            {...(config.ui ? { ui: config.ui } : {})}
            {...(config.providers ? { providers: config.providers } : {})}
            {...(config.longThreads ? { longThreads: config.longThreads } : {})}
          />
        </MinSizeGate>,
        );
      });
      if (next === null) break;
      const previous = connection;
      connection = next;
      if (previous !== kept.local && previous !== next) await previous.close().catch(() => undefined);
    }
  } finally {
    root.unmount();
    renderer.destroy();
    if (connection !== kept.local) await connection.close();
    await kept.local?.close();
  }
}

function activeServer(connection: ClientConnection): ActiveServer | null {
  const paired = (connection as { pairedServer?: PairedServer }).pairedServer;
  return paired ? { name: paired.name, host: paired.host, port: paired.port } : null;
}

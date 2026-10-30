import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { CliError } from "../core/errors.js";
import type { CliConfig } from "../core/types.js";
import { App } from "./app/app.js";
import { openClient, type ClientConnection } from "../server/client.js";
import type { LinkState, RemoteConnection } from "../server/transport/remote.js";
import type { PairedServer } from "../server/transport/servers.js";
import type { ActiveServer } from "./features/remote/server.js";
import { registerSyntaxParsers } from "../core/syntax/register.js";
import { applyLanguage } from "./i18n/index.js";
import { watchTerminalVisibility } from "./model/terminalVisibility.js";
import { SURFACE, applyTheme } from "./theme.js";
import { MinSizeGate } from "./ui/terminalgate.js";

export async function runTui(server?: string): Promise<void> {
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
  // Always through a moxen server — this machine's, started if none is
  // running, so closing the TUI never ends its turns — or `--server`, a
  // paired one on another machine, whose own config rules there.
  // The palette can switch to another one (or back to this machine's) while
  // the TUI runs: the new connection is opened first, and only then is the
  // app remounted on it — a server that cannot be reached leaves this one.
  // This machine's connection is kept while away and reused on the way back.
  const kept: { local: ClientConnection | null } = { local: null };
  const connect = async (target: string | null): Promise<ClientConnection> => {
    if (target !== null) return await openClient({ server: target });
    kept.local ??= await openClient();
    return kept.local;
  };
  let connection = await connect(server ?? null);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: SURFACE.base });
  const root = createRoot(renderer);
  // Stops painting while the terminal says it is hidden (a background tab); a terminal that cannot say is never hidden.
  const unwatchVisibility = process.stdout.isTTY === true ? watchTerminalVisibility(renderer, (data) => process.stdout.write(data)) : () => {};

  try {
    for (let generation = 0; ; generation += 1) {
      const current = connection;
      const next = await new Promise<ClientConnection | null>((resolve) => {
        // The server can be replaced under a running TUI (another launch
        // restarts it): once the connection is back, take the new one's
        // settings — same key, so the app keeps its state.
        let lost = false;
        const stopWatching = watchLink(current, (status) => {
          if (status !== "connected") lost = true;
          else if (lost) {
            lost = false;
            void serverConfig(current).then(draw);
          }
        });
        const finish = (value: ClientConnection | null): void => {
          stopWatching();
          resolve(value);
        };
        const onSwitchServer = async (target: string | null): Promise<void> => {
          finish(await connect(target));
        };
        const draw = (config: CliConfig): void => {
          applyLanguage(config.ui?.language);
          if (applyTheme(config.ui?.theme)) renderer.setBackgroundColor(SURFACE.base);
          root.render(
            <MinSizeGate onQuit={() => finish(null)}>
              <App
                key={generation}
                client={current}
                server={activeServer(current)}
                onSwitchServer={onSwitchServer}
                onQuit={() => finish(null)}
                cwd={process.cwd()}
                setTerminalTitle={(title) => renderer.setTerminalTitle(title)}
                {...(config.ui ? { ui: config.ui } : {})}
                {...(config.providers ? { providers: config.providers } : {})}
                {...(config.longThreads ? { longThreads: config.longThreads } : {})}
              />
            </MinSizeGate>,
          );
        };
        void serverConfig(current).then(draw);
      });
      if (next === null) break;
      const previous = connection;
      connection = next;
      if (previous !== kept.local && previous !== next) await previous.close().catch(() => undefined);
    }
  } finally {
    unwatchVisibility();
    root.unmount();
    renderer.destroy();
    if (connection !== kept.local) await connection.close();
    await kept.local?.close();
  }
}

/**
 * The display settings the app opens with: the connected server's, which
 * owns the config (a paired server's, when on one). A server too old to
 * answer leaves the defaults.
 */
async function serverConfig(connection: ClientConnection): Promise<CliConfig> {
  return await connection.query({ type: "config.read" }).then((read) => read.config, () => ({}) as CliConfig);
}

/** Hear a connection's link state, when it has one (a server connection); returns the unsubscribe. */
function watchLink(connection: ClientConnection, listener: (status: LinkState["status"]) => void): () => void {
  const watchable = connection as Partial<Pick<RemoteConnection, "onLinkState">>;
  return typeof watchable.onLinkState === "function" ? watchable.onLinkState((state) => listener(state.status)) : () => undefined;
}

function activeServer(connection: ClientConnection): ActiveServer | null {
  const paired = (connection as { pairedServer?: PairedServer }).pairedServer;
  return paired ? { name: paired.name, host: paired.host, port: paired.port } : null;
}

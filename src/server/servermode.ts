/**
 * What `MOXEN_SERVER` asks for: this machine's server, or — for any value
 * but the old mode names — a paired server on another machine. Apart from
 * `./client.ts` so the server process can read it too, without importing
 * the client factory.
 */
import { appEnv } from "../core/config.js";
import { CliError } from "../core/errors.js";

/** `direct` is in-process: the server's own and tests', never chosen by `MOXEN_SERVER`. */
export type ServerMode = "direct" | "daemon";

/** Values that name this machine's server rather than a paired one: the modes clients once had. */
const LOCAL = ["auto", "daemon", "direct"];

/**
 * The mode a client opens by default: always this machine's server.
 * `MOXEN_SERVER=direct` used to keep a client in-process; that is refused,
 * not quietly ignored, so a script relying on it hears why.
 */
export function serverMode(env: NodeJS.ProcessEnv = process.env): "daemon" {
  if (appEnv("SERVER", env)?.trim().toLowerCase() === "direct") {
    throw new CliError(
      "SERVER_MODE_REMOVED",
      "MOXEN_SERVER=direct is no longer supported: every client goes through a moxen server, started when none is running. Unset it.",
      { exitCode: 2 },
    );
  }
  return "daemon";
}

/** The paired server `MOXEN_SERVER` names, or null when it names this machine's or nothing. */
export function remoteServerName(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = appEnv("SERVER", env)?.trim();
  if (raw === undefined || raw === "" || LOCAL.includes(raw.toLowerCase())) return null;
  return raw;
}

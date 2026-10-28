/**
 * What `MOXEN_SERVER` asks for: a mode (`./client.ts` explains them) or,
 * for any other value, the name of a paired server on another machine.
 * Apart from `./client.ts` so the server process can read it too, without
 * importing the client factory.
 */
import { appEnv } from "../core/config.js";

export type ServerMode = "direct" | "auto" | "daemon";

const MODES: readonly string[] = ["direct", "auto", "daemon"];

/** The mode `MOXEN_SERVER` names; `auto` when it is unset or names a paired server instead. */
export function serverMode(env: NodeJS.ProcessEnv = process.env): ServerMode {
  const raw = appEnv("SERVER", env)?.trim().toLowerCase();
  return raw !== undefined && MODES.includes(raw) ? (raw as ServerMode) : "auto";
}

/** The paired server `MOXEN_SERVER` names, or null when it names a mode or nothing. */
export function remoteServerName(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = appEnv("SERVER", env)?.trim();
  if (raw === undefined || raw === "" || MODES.includes(raw.toLowerCase())) return null;
  return raw;
}

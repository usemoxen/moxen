import { t, type MessageKey } from "./index.js";

const KEYS: Readonly<Record<string, MessageKey>> = {
  idle: "status.idle",
  running: "status.running",
  starting: "status.starting",
  ready: "status.ready",
  stopped: "status.stopped",
  error: "status.error",
  interrupted: "status.interrupted",
  connecting: "status.connecting",
};

/** A provider session's status word in the current language; one it does not know is shown as it came. */
export function sessionStatusLabel(status: string): string {
  const key = KEYS[status];
  return key === undefined ? status : t(key);
}

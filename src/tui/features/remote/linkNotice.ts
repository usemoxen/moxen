import type { LinkState } from "../../../server/transport/remote.js";
import type { ActiveServer } from "./server.js";

export interface LinkNoticeText {
  readonly title: string;
  /** Still trying (warn) or given up (danger). */
  readonly tone: "warn" | "danger";
  /** One short line: what is going on and what happens next. No raw error text, no paths. */
  readonly detail: string;
}

/** Past this, this machine's server is not restarting: it is down, and the notice says how to start it. */
const RESTART_GRACE_MS = 20_000;

/**
 * What the notice over the composer says while the server is not
 * answering. The connection's own reason is an error message meant for
 * logs (an endpoint path, a socket error); this says it the way a person
 * would, from what kind of failure it is.
 */
export function linkNoticeText(link: Exclude<LinkState, { status: "connected" }>, server: ActiveServer | null, now: number = Date.now()): LinkNoticeText {
  const name = server?.name ?? null;
  if (link.status === "failed") {
    const title = name === null ? "Disconnected from the moxen server" : `Disconnected from ${name}`;
    switch (link.code) {
      case "REMOTE_DEVICE_REFUSED":
      case "REMOTE_NOT_PAIRED":
        return { title, tone: "danger", detail: "This device is no longer paired there. Pair it again to reconnect." };
      case "REMOTE_KEY_MISMATCH":
        return { title, tone: "danger", detail: "Its key changed since pairing. Pair again only if you know why." };
      case "PROTOCOL_MISMATCH":
        return { title, tone: "danger", detail: "It runs another moxen version. Restart it so both match." };
      default:
        return { title, tone: "danger", detail: "It refused this connection." };
    }
  }
  const title = name === null ? "Can't reach the moxen server" : `Can't reach ${name}`;
  const reason = link.reason;
  const next = "Reconnecting as soon as it's back.";
  if (/no reply|did not answer|stopped answering/i.test(reason)) {
    return { title, tone: "warn", detail: `It is running but not answering. ${next}` };
  }
  if (name !== null) {
    return { title, tone: "warn", detail: `No answer from ${server?.host}:${server?.port}. ${next}` };
  }
  if (now - link.since > RESTART_GRACE_MS) {
    return { title, tone: "warn", detail: "It isn't running. Start it (moxen server start) to reconnect." };
  }
  return { title, tone: "warn", detail: `It stopped or is restarting. ${next}` };
}

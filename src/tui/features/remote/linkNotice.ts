import { t } from "../../i18n/index.js";
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
    const title = name === null ? t("link.disconnected_from_the_moxen_8207") : t("link.disconnectedFrom", { name });
    switch (link.code) {
      case "REMOTE_DEVICE_REFUSED":
      case "REMOTE_NOT_PAIRED":
        return { title, tone: "danger", detail: t("link.this_device_is_no_1170") };
      case "REMOTE_KEY_MISMATCH":
        return { title, tone: "danger", detail: t("link.its_key_changed_since_3aae") };
      case "PROTOCOL_MISMATCH":
        return { title, tone: "danger", detail: t("link.it_runs_another_moxen_9b67") };
      default:
        return { title, tone: "danger", detail: t("link.it_refused_this_connection_35f8") };
    }
  }
  const title = name === null ? t("link.cant_reach_the_moxen_4770") : t("link.cantReach", { name });
  const reason = link.reason;
  const next = t("link.reconnecting_as_soon_as_df02");
  if (/no reply|did not answer|stopped answering/i.test(reason)) {
    return { title, tone: "warn", detail: t("link.notAnswering", { next }) };
  }
  if (name !== null) {
    return { title, tone: "warn", detail: t("link.noAnswerFrom", { address: `${server?.host}:${server?.port}`, next }) };
  }
  if (now - link.since > RESTART_GRACE_MS) {
    return { title, tone: "warn", detail: t("link.it_isnt_running_start_3abe") };
  }
  return { title, tone: "warn", detail: t("link.stopped", { next }) };
}

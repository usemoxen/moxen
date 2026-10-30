import { t } from "../../i18n/index.js";
import type { PickerBody, PickerSection } from "../pickers/pickermodal.js";
import type { ActiveServer } from "./server.js";
import type { RemoteControls } from "./useRemote.js";

export type RemotePicker = "remote-servers" | "remote-devices" | "remote-pair-address" | "remote-pair-code" | "remote-code";

interface Nav {
  open: (picker: RemotePicker) => void;
  close: () => void;
}

/**
 * The command palette's Remote section. The first rows are about this
 * machine as a client (switch, pair); the rest manage the server the TUI is
 * connected to, which is named when it is a paired one.
 */
export function remotePaletteSection(remote: RemoteControls, server: ActiveServer | null, nav: Nav): PickerSection {
  const where = server === null ? t("paired.thisMachine") : server.name;
  const status = remote.status;
  const listening = status?.listening ?? [];
  const toggleMeta =
    status === null
      ? where
      : !status.enabled
        ? t("remote.metaOff", { where })
        : listening.length > 0
          ? t("remote.metaOn", { addresses: listening.map((entry) => entry.address).join(", ") })
          : status.available
            ? status.error ? t("remote.metaNotListeningWhy", { why: status.error }) : t("remote.metaNotListening")
            : t("remote.on_starts_with_the_9f18");
  return {
    header: t("remote.remote_f850"),
    rows: [
      {
        key: "remote:switch",
        label: t("remote.switch_server_d047"),
        meta: remote.canSwitch ? t("remote.connectedTo", { where }) : t("remote.not_available_here_2758"),
        ...(remote.canSwitch ? {} : { disabled: true }),
        onPick: () => (remote.canSwitch ? nav.open("remote-servers") : undefined),
      },
      {
        key: "remote:pair",
        label: t("remote.pair_with_a_server_e137"),
        meta: t("remote.address_and_the_code_15c2"),
        ...(remote.canSwitch ? {} : { disabled: true }),
        onPick: () => {
          remote.setPairAddress("");
          nav.open("remote-pair-address");
        },
      },
      {
        key: "remote:toggle",
        label: status?.enabled ? t("remote.turn_remote_access_off_bbaa") : t("remote.turn_remote_access_on_7134"),
        // Off on the server this TUI reaches through it cuts this TUI off too.
        meta: status?.enabled && server !== null ? t("remote.disconnectsThis", { meta: toggleMeta }) : toggleMeta,
        onPick: () => {
          nav.close();
          void remote.setEnabled(!(status?.enabled ?? false));
        },
      },
      {
        key: "remote:code",
        label: t("remote.show_pairing_code_1dba"),
        ...(listening.length > 0
          ? {
              meta: t("remote.forNewDevice", { where }),
              onPick: () => {
                void remote.startPairing().then((ok) => (ok ? nav.open("remote-code") : nav.close()));
              },
            }
          : { meta: t("remote.turn_remote_access_on_5712"), disabled: true, onPick: () => {} }),
      },
      {
        key: "remote:devices",
        label: t("remote.paired_devices_3d65"),
        meta: t("remote.listRevoke", { where }),
        onPick: () => {
          remote.loadDevices();
          nav.open("remote-devices");
        },
      },
    ],
  };
}

/** The switch list: this machine, then every paired server. */
export function serversBody(remote: RemoteControls, server: ActiveServer | null, close: () => void): PickerBody {
  const current = server?.name ?? null;
  const pick = (target: string | null) => () => {
    close();
    if (target !== current) remote.switchTo(target);
  };
  return {
    kind: "list",
    sections: [
      {
        rows: [
          { key: "server:local", label: t("remote.this_machine_b584"), meta: t("remote.its_own_moxen_server_956f"), selected: current === null, onPick: pick(null) },
          ...remote.servers.map((entry) => ({
            key: `server:${entry.deviceId}`,
            label: entry.name,
            meta: `${entry.host.includes(":") ? `[${entry.host}]` : entry.host}:${entry.port}`,
            selected: entry.name === current,
            onPick: pick(entry.name),
          })),
        ],
      },
    ],
  };
}

/** The devices list: pick once to arm, again to revoke. */
export function devicesBody(remote: RemoteControls): PickerBody {
  if (remote.devices === null) return { kind: "loading" };
  return {
    kind: "list",
    sections: [
      {
        rows: remote.devices.map((device) => {
          const armed = remote.revokeArmed === device.id;
          const seen = device.connections > 0 ? t("remote.connections", { count: device.connections }) : device.lastSeenAt ? t("remote.seen", { at: device.lastSeenAt.slice(0, 16).replace("T", " ") }) : t("remote.paired", { at: device.pairedAt.slice(0, 10) });
          return {
            key: `device:${device.id}`,
            label: armed ? t("remote.confirmRevoke", { name: device.name }) : device.name,
            meta: armed ? t("remote.enter_again_disconnects_it_c624") : seen,
            onPick: () => remote.revoke(device),
          };
        }),
      },
    ],
  };
}

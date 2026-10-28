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
  const where = server === null ? "this machine" : server.name;
  const status = remote.status;
  const listening = status?.listening ?? [];
  const toggleMeta =
    status === null
      ? where
      : !status.enabled
        ? `off · ${where}`
        : listening.length > 0
          ? `on · ${listening.map((entry) => entry.address).join(", ")}`
          : status.available
            ? `on, not listening${status.error ? ` · ${status.error}` : ""}`
            : "on · starts with the moxen server";
  return {
    header: "Remote",
    rows: [
      {
        key: "remote:switch",
        label: "Switch server…",
        meta: remote.canSwitch ? `connected to ${where}` : "not available here",
        ...(remote.canSwitch ? {} : { disabled: true }),
        onPick: () => (remote.canSwitch ? nav.open("remote-servers") : undefined),
      },
      {
        key: "remote:pair",
        label: "Pair with a server…",
        meta: "address and the code it shows",
        ...(remote.canSwitch ? {} : { disabled: true }),
        onPick: () => {
          remote.setPairAddress("");
          nav.open("remote-pair-address");
        },
      },
      {
        key: "remote:toggle",
        label: status?.enabled ? "Turn remote access off" : "Turn remote access on",
        meta: toggleMeta,
        onPick: () => {
          nav.close();
          void remote.setEnabled(!(status?.enabled ?? false));
        },
      },
      {
        key: "remote:code",
        label: "Show pairing code",
        ...(listening.length > 0
          ? {
              meta: `for a new device · ${where}`,
              onPick: () => {
                void remote.startPairing().then((ok) => (ok ? nav.open("remote-code") : nav.close()));
              },
            }
          : { meta: "turn remote access on first", disabled: true, onPick: () => {} }),
      },
      {
        key: "remote:devices",
        label: "Paired devices…",
        meta: `list and revoke · ${where}`,
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
          { key: "server:local", label: "This machine", meta: "its own moxen server", selected: current === null, onPick: pick(null) },
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
          const seen = device.connections > 0 ? `${device.connections} connected` : device.lastSeenAt ? `seen ${device.lastSeenAt.slice(0, 16).replace("T", " ")}` : `paired ${device.pairedAt.slice(0, 10)}`;
          return {
            key: `device:${device.id}`,
            label: armed ? `Confirm revoke ${device.name}` : device.name,
            meta: armed ? "enter again · disconnects it now" : seen,
            onPick: () => remote.revoke(device),
          };
        }),
      },
    ],
  };
}

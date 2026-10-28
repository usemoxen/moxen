import { useCallback, useRef, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import type { QueryResult } from "../../../server/protocol.js";
import type { RemoteDevice, RemotePairing } from "../../../server/transport/remoteaccess.js";
import { PairedServers, type PairedServer } from "../../../server/transport/servers.js";
import type { ActiveServer } from "./server.js";

export type RemoteStatus = QueryResult<"remote.status">;

type Push = (id: string, tone: "info" | "danger", text: string, ms?: number) => void;

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Remote access from the TUI, behind the command palette's Remote section.
 *
 * Two ends, as in `moxen remote`: the server this TUI is connected to (turn
 * its remote access on or off, show a pairing code, list and revoke its
 * devices), and this machine as a client (pair with another server, switch
 * between this machine's server and paired ones). Connected to a paired
 * server, the first set manages that server, as `--server` does on the CLI.
 */
export function useRemote(params: {
  client: ClientApi;
  server: ActiveServer | null;
  onSwitchServer?: ((target: string | null) => Promise<void>) | undefined;
  push: Push;
  /** Tests: the paired-server list; the user's by default. */
  pairedServers?: PairedServers;
}) {
  const { client, server, onSwitchServer, push } = params;
  const store = useRef(params.pairedServers ?? new PairedServers()).current;
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [servers, setServers] = useState<PairedServer[]>([]);
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [revokeArmed, setRevokeArmed] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  /** The address typed in the first pairing step, waiting for the code. */
  const [pairAddress, setPairAddress] = useState("");

  /** What the palette shows: the server's remote access, and the servers paired here. Never throws. */
  const refresh = useCallback(() => {
    void client.query({ type: "remote.status" }).then(setStatus, () => setStatus(null));
    void store.list().then(setServers, () => setServers([]));
  }, [client, store]);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        await client.dispatch({ type: "settings.set", key: "remote.enabled", value: enabled ? "true" : "false" });
        const next = await client.query({ type: "remote.status" });
        setStatus(next);
        const where = server ? ` on ${server.name}` : "";
        push(
          "remote",
          "info",
          !enabled
            ? `Remote access off${where}`
            : next.available
              ? `Remote access on${where}: ${next.listening.map((entry) => entry.address).join(", ")}`
              : "Remote access on: it starts with the moxen server (moxen server start)",
          4_000,
        );
      } catch (cause) {
        push("remote", "danger", `Remote access: ${errorText(cause)}`, 8_000);
      }
    },
    [client, server, push],
  );

  /** A fresh pairing code; true when there is one to show. */
  const startPairing = useCallback(async (): Promise<boolean> => {
    try {
      setPairing(await client.dispatch({ type: "remote.pairing.start" }));
      return true;
    } catch (cause) {
      push("remote", "danger", `Pairing: ${errorText(cause)}`, 8_000);
      return false;
    }
  }, [client, push]);

  const loadDevices = useCallback(() => {
    setDevices(null);
    setRevokeArmed(null);
    void client.query({ type: "remote.devices" }).then(
      (result) => setDevices([...result.devices]),
      (cause: unknown) => {
        setDevices([]);
        push("remote", "danger", `Devices: ${errorText(cause)}`, 8_000);
      },
    );
  }, [client, push]);

  /** First pick arms, the second revokes, as deleting a thread does. */
  const revoke = useCallback(
    (device: RemoteDevice) => {
      if (revokeArmed !== device.id) {
        setRevokeArmed(device.id);
        return;
      }
      setRevokeArmed(null);
      void client.dispatch({ type: "remote.device.revoke", deviceId: device.id }).then(
        () => {
          push("remote", "info", `Revoked ${device.name}`, 4_000);
          setDevices((current) => current?.filter((entry) => entry.id !== device.id) ?? null);
        },
        (cause: unknown) => push("remote", "danger", `Revoke: ${errorText(cause)}`, 8_000),
      );
    },
    [client, push, revokeArmed],
  );

  /** Reconnect the app; on failure it stays where it is and says why. */
  const switchTo = useCallback(
    (target: string | null) => {
      if (!onSwitchServer) return;
      setSwitching(target ?? "this machine");
      onSwitchServer(target).catch((cause: unknown) => {
        setSwitching(null);
        push("remote", "danger", `Could not connect: ${errorText(cause)}`, 10_000);
      });
    },
    [onSwitchServer, push],
  );

  /** Pair with the code shown on the other machine, then connect to it. */
  const pair = useCallback(
    (code: string) => {
      const address = pairAddress;
      push("remote", "info", `Pairing with ${address}…`, 10_000);
      void store.pair({ address, code }).then(
        (paired) => {
          push("remote", "info", `Paired with ${paired.name}. Key ${paired.fingerprint.slice(0, 23)}… — connecting`, 6_000);
          switchTo(paired.name);
        },
        (cause: unknown) => push("remote", "danger", `Pairing failed: ${errorText(cause)}`, 10_000),
      );
    },
    [pairAddress, push, store, switchTo],
  );

  return {
    status,
    servers,
    devices,
    pairing,
    revokeArmed,
    switching,
    canSwitch: onSwitchServer !== undefined,
    refresh,
    setEnabled,
    startPairing,
    closePairing: () => setPairing(null),
    loadDevices,
    revoke,
    switchTo,
    pairAddress,
    setPairAddress,
    pair,
  };
}

export type RemoteControls = ReturnType<typeof useRemote>;

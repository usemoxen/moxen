import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";

import type { RemotePairing } from "../../../server/transport/remoteaccess.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { COLOR } from "../../theme.js";
import { ModalShell } from "../../ui/modalshell.js";

/** Lines the dialog needs at its widest; the app centres a panel this tall. */
export const PAIRING_PANEL_HEIGHT = 18;

/**
 * A pairing code, shown so it can be read out or typed on the other
 * machine, with where to reach this server and the pin its key will be
 * remembered by. Closing leaves the code valid until it expires: the other
 * machine is often typed into after this has been dismissed.
 */
export function PairingCodeModal({
  pairing,
  serverName,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
}: {
  pairing: RemotePairing;
  /** The paired server it is for, when the TUI is connected to one; null for this machine's. */
  serverName: string | null;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
}) {
  // Its own second hand: the app's clock ticks too slowly for a countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc" || key.name === "return" || key.name === "enter") {
      markModalDismissed();
      onClose();
    }
  });
  const left_ms = Date.parse(pairing.expiresAt) - now;
  const expired = left_ms <= 0;
  const minutes = Math.max(0, Math.floor(left_ms / 60_000));
  const seconds = Math.max(0, Math.floor((left_ms % 60_000) / 1000));
  const address = pairing.addresses[0] ?? "<address>";
  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={COLOR.bright} selectable={false}>{serverName === null ? "Pair a device with this machine" : `Pair a device with ${serverName}`}</text>
          <box style={{ flexGrow: 1 }} />
          <text fg={COLOR.faint} selectable={false}>{"esc"}</text>
        </box>
        <box style={{ height: 1, flexShrink: 0 }} />
        <text fg={expired ? COLOR.faint : COLOR.accent}>{`  ${pairing.code}`}</text>
        <text fg={COLOR.dim} selectable={false}>
          {expired ? "  expired — show a new one" : `  single use · valid ${minutes}:${String(seconds).padStart(2, "0")} more`}
        </text>
        <box style={{ height: 1, flexShrink: 0 }} />
        <text fg={COLOR.dim} selectable={false}>{"On the other machine, Command palette › Pair with a server, or:"}</text>
        <text fg={COLOR.bright}>{`  moxen remote pair ${address} ${pairing.code}`}</text>
        <box style={{ height: 1, flexShrink: 0 }} />
        <text fg={COLOR.dim} selectable={false}>{pairing.addresses.length > 1 ? "Addresses:" : "Address:"}</text>
        <text fg={COLOR.bright}>{`  ${pairing.addresses.join("  ")}`}</text>
        <text fg={COLOR.dim} selectable={false}>{"Key fingerprint (the other machine shows it after pairing):"}</text>
        <text fg={COLOR.faint}>{`  ${pairing.fingerprint}`}</text>
      </box>
    </ModalShell>
  );
}

import { t } from "../i18n/index.js";
import { useState } from "react";

import { useAnimTick } from "../hooks/useAnimTick.js";
import type { BootStage } from "../model/readiness.js";
import { COLOR, pulseColor, SPINNER_FRAMES, SURFACE } from "../theme.js";

/**
 * Full-screen boot gate: shown instead of the app chrome until the shell and
 * initial thread snapshots land (see `isBootReady`). Mounted only while
 * booting, so its 100ms spinner clock costs nothing afterwards. Subscription
 * errors still surface as toasts above it — this screen names the stalled
 * leg, it never swallows failures.
 */

const SLOW_MS = 10_000;

export function LoadingScreen({ stage }: { stage: BootStage }) {
  const [mountedAt] = useState(() => Date.now());
  const tick = useAnimTick(true, 100);
  const frame = SPINNER_FRAMES[Math.floor(tick / 100) % SPINNER_FRAMES.length] ?? "⠋";
  return (
    <box
      style={{ flexDirection: "column", flexGrow: 1, alignItems: "center", justifyContent: "center" }}
      backgroundColor={SURFACE.base}
      selectable={false}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} selectable={false}>
        <text fg={pulseColor(tick, COLOR.dim, COLOR.accent, 2400)} bg={SURFACE.base} selectable={false}>
          {t(stage === "threads" ? "loading.threads" : stage === "providers" ? "loading.providers" : "loading.transcript", { frame })}
        </text>
      </box>
      <box style={{ height: 1, flexShrink: 0 }} selectable={false}>
        <text fg={COLOR.faint} bg={SURFACE.base} selectable={false}>
          {t("ui.waiting_for_the_moxen_8e31")}
        </text>
      </box>
      {tick - mountedAt < SLOW_MS ? null : (
        <box style={{ height: 1, flexShrink: 0 }} selectable={false}>
          <text fg={COLOR.warn} bg={SURFACE.base} selectable={false}>
            {t("ui.still_waiting_is_moxen_83a6")}
          </text>
        </box>
      )}
    </box>
  );
}

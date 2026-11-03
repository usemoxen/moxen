import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ClientApi, QueryResult } from "../../../server/api.js";
import { t, tx } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { HoverButton } from "../../ui/hoverbutton.js";

type Status = QueryResult<"memory.embeddings.status">;

/** Read-only polling; showing this panel never provisions or enables a model. */
export function useMemoryRuntime(client: ClientApi | undefined, visible: boolean) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!client || !visible) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const next = await client.query({ type: "memory.embeddings.status" }); if (active) setStatus(next); }
      catch { /* An older paired server can still run ordinary memory. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 350);
    return () => { active = false; clearInterval(timer); };
  }, [client, visible]);
  return status;
}

export function MemoryRuntimePanel({ status, saving = false, onSetup, onCancel, onKeyword }: {
  status: Status | null;
  saving?: boolean;
  onSetup: () => void;
  onCancel: () => void;
  onKeyword: () => void;
}) {
  const busy = saving || status?.busy === true;
  const failed = status?.state === "failed";
  const phase = status?.phase ?? "idle";
  const phases = { idle: "memory.phase.idle", installing: "memory.phase.installing", downloading: "memory.phase.downloading", validating: "memory.phase.validating", indexing: "memory.phase.indexing" } as const;
  const line = failed ? t("memory.setupFailed") : busy ? t(phases[phase]) : status?.state === "loading" ? t("memory.loading") : status?.validation ? t(status.state === "ready" ? "memory.validated" : "memory.unloaded") : t("memory.notValidated");
  const tone = failed ? COLOR.removed : busy ? COLOR.accent : status?.state === "ready" && status.validation ? COLOR.added : COLOR.dim;
  useKeyboard((key) => {
    if (key.ctrl || key.meta) return;
    if (busy && key.name === "c") { key.preventDefault(); onCancel(); }
    else if (!busy && key.name === "r") { key.preventDefault(); onSetup(); }
  });
  return <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 1 }} backgroundColor={SURFACE.panel} selectable={false}>
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.panel}>
      <box style={{ flexDirection: "row" }} backgroundColor={SURFACE.panel}>
        <text fg={COLOR.bright} bg={SURFACE.panel} selectable={false}>{t("memory.title")}</text>
        {status?.device ? <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{`  ${status.device}`}</text> : null}
      </box>
      <HoverButton label={` ${t(busy ? "memory.cancel" : status?.validation ? "memory.recheck" : "memory.setup")} `}
        fg={SURFACE.base} hoverBg={COLOR.bright} bg={COLOR.accent} onClick={busy ? onCancel : onSetup} />
    </box>
    <text fg={tone} bg={SURFACE.panel} wrapMode="word" selectable={false}>{line}</text>
    {busy && status?.file ? <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>{`${status.file}${status.percent === null ? "" : ` · ${Math.round(status.percent)}%`}`}</text> : null}
    {status?.validation ? <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>{t("memory.measurements", { device: status.validation.device, correct: status.validation.correct, total: status.validation.total, ms: Math.round(status.validation.queryP95Ms) })}</text> : null}
    {failed && status?.message ? <text fg={COLOR.removed} bg={SURFACE.panel} wrapMode="word" selectable={false}>{tx(status.message)}</text> : null}
    {busy ? null : <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={SURFACE.panel}>
      <HoverButton label={t("memory.keyword")} fg={COLOR.dim} hoverFg={COLOR.bright} bg={SURFACE.panel} onClick={onKeyword} />
    </box>}
  </box>;
}

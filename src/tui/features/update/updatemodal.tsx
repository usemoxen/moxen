import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";

import type { UpdateCheck, UpdateProgress, UpdateStage } from "../../../core/selfupdate/vocabulary.js";
import { t } from "../../i18n/index.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { downloadFraction, formatMebibytes, stageRows, updateActions, type UpdateView } from "../../model/update.js";
import { COLOR, markdownSyntaxStyle, SURFACE } from "../../theme.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { ModalShell } from "../../ui/modalshell.js";

function stageLabel(stage: UpdateStage): string {
  switch (stage) {
    case "checking": return t("update.stage.checking");
    case "downloading": return t("update.stage.downloading");
    case "verifying": return t("update.stage.verifying");
    case "unpacking": return t("update.stage.unpacking");
    case "testing": return t("update.stage.testing");
    case "switching": return t("update.stage.switching");
    case "done": return t("update.stage.done");
  }
}

/**
 * The update screen: the installed and the available version with the release's notes, what an update does to
 * running work, each stage while one runs, and the restart it asks for. It draws the state the app holds
 * (`useAppUpdate`) and offers only what `updateActions` allows, so a source checkout or a paired server has no
 * install button. Closing it never cancels an update.
 */
export function UpdateModal({ view, serverName, screenWidth, screenHeight, onInstall, onRollback, onCheck, onClose }: {
  view: UpdateView; serverName: string | null; screenWidth: number; screenHeight: number;
  onInstall: () => void; onRollback: () => void; onCheck: () => void; onClose: () => void;
}) {
  const width = Math.min(96, screenWidth - 6);
  const height = Math.min(34, screenHeight - 4);
  const inner = width - 4;
  const remote = serverName !== null;
  const actions = updateActions(view, { remote });
  const check: UpdateCheck | null = view.phase === "ready" || view.phase === "running" || view.phase === "finished" || view.phase === "failed" || view.phase === "lost" ? view.check : null;
  const [armed, setArmed] = useState(false);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  // Going back is asked for twice: the first press says what it does. Any change of state disarms it.
  useEffect(() => setArmed(false), [view.phase]);
  const rollback = () => {
    if (!actions.includes("rollback")) return;
    if (armed) { setArmed(false); onRollback(); } else setArmed(true);
  };
  const install = () => { if (actions.includes("install")) onInstall(); };
  const again = () => { if (actions.includes("check")) onCheck(); };
  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { markModalDismissed(); onClose(); return; }
    if (key.name === "u") install();
    if (key.name === "c") again();
    if (key.name === "r") rollback();
    if (key.name === "return") { if (actions.includes("install")) install(); else if (actions.includes("check")) again(); }
    if (key.name === "pagedown") scroll.current?.scrollBy(8);
    if (key.name === "pageup") scroll.current?.scrollBy(-8);
    if (key.name === "down") scroll.current?.scrollBy(1);
    if (key.name === "up") scroll.current?.scrollBy(-1);
  });

  const latest = check?.latest ?? null;
  const showNotes = latest !== null && latest.notes.trim() !== "" && check !== null && check.status === "available" && (view.phase === "ready" || view.phase === "failed");
  const installing = actions.includes("install");
  return <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={Math.floor((screenWidth - width) / 2)} top={Math.floor((screenHeight - height) / 2)} width={width} height={height} onClose={onClose}>
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", flexShrink: 0 }}>
      <text fg={COLOR.bright} attributes={TextAttributes.BOLD} selectable={false}>{t("update.title")}</text>
      <text fg={COLOR.faint} selectable={false}>{"esc"}</text>
    </box>
    <box style={{ flexDirection: "column", marginTop: 1, flexShrink: 0 }}>
      {serverName === null ? null : <Row label={t("update.server")} value={serverName} />}
      <Row label={t("update.installed")} value={view.phase === "finished" ? view.result.version : check === null ? "…" : check.install.version} note={check === null ? undefined : check.install.kind === "release" ? t("update.kind.release") : t("update.kind.source")} />
      <Row label={t("update.available")} value={availableText(view, check)} tone={check?.status === "available" ? "accent" : "plain"} />
    </box>
    <box style={{ flexDirection: "column", marginTop: 1, flexShrink: 0 }}>{statusBody(view, check, inner, serverName)}</box>
    {showNotes
      ? <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, marginTop: 1, minHeight: 4 }}>
        <text fg={COLOR.dim} selectable={false} style={{ height: 1, flexShrink: 0 }}>{t("update.notes")}</text>
        <scrollbox ref={scroll} id="update-notes" style={{ flexGrow: 1, flexShrink: 1, minHeight: 2 }} contentOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
          <markdown content={latest.notes} fg={COLOR.text} syntaxStyle={markdownSyntaxStyle()} selectable />
        </scrollbox>
      </box>
      : <box style={{ flexGrow: 1 }} />}
    {installing ? <text fg={COLOR.dim} style={{ marginTop: 1, flexShrink: 0 }} wrapMode="word">{t("update.beforeInstall")}</text> : null}
    {armed ? <text fg={COLOR.warn} style={{ marginTop: 1, flexShrink: 0 }} wrapMode="word">{t("update.rollbackConfirm")}</text> : null}
    <box style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 2, marginTop: 1, flexShrink: 0 }}>
      {actions.includes("install") ? <HoverButton label={` ${t("update.install", { version: latest?.version ?? "" })} `} fg={SURFACE.base} hoverFg={SURFACE.base} bg={COLOR.accent} hoverBg={COLOR.bright} onClick={install} /> : null}
      {actions.includes("rollback") ? <HoverButton label={armed ? t("update.rollbackSure") : t("update.rollback")} fg={armed ? COLOR.warn : COLOR.dim} hoverFg={COLOR.bright} onClick={rollback} /> : null}
      {actions.includes("check") ? <HoverButton label={t("update.check")} fg={COLOR.dim} hoverFg={COLOR.bright} onClick={again} /> : null}
      <HoverButton label={view.phase === "running" ? t("update.closeKeepsGoing") : t("update.close")} fg={COLOR.dim} hoverFg={COLOR.bright} onClick={() => { markModalDismissed(); onClose(); }} />
    </box>
  </ModalShell>;
}

function availableText(view: UpdateView, check: UpdateCheck | null): string {
  if (view.phase === "checking" || view.phase === "idle") return "…";
  if (check === null) return "—";
  if (check.status === "no-release" || check.latest === null) return "—";
  return check.latest.version;
}

function Row({ label, value, note, tone = "plain" }: { label: string; value: string; note?: string | undefined; tone?: "plain" | "accent" }) {
  return <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
    <text fg={COLOR.dim} style={{ width: 12 }} selectable={false}>{label}</text>
    <text fg={tone === "accent" ? COLOR.accent : COLOR.bright}>{value}</text>
    {note === undefined ? null : <text fg={COLOR.dim} selectable={false}>{`  ${note}`}</text>}
  </box>;
}

function Line({ children, tone = "text" }: { children: ReactNode; tone?: "text" | "dim" | "good" | "bad" | "warn" | "accent" }) {
  const fg = tone === "dim" ? COLOR.dim : tone === "good" ? COLOR.added : tone === "bad" ? COLOR.danger : tone === "warn" ? COLOR.warn : tone === "accent" ? COLOR.accent : COLOR.text;
  return <text fg={fg} wrapMode="word" style={{ flexShrink: 0 }}>{children}</text>;
}

function statusBody(view: UpdateView, check: UpdateCheck | null, inner: number, serverName: string | null): ReactNode {
  switch (view.phase) {
    case "idle":
    case "checking":
      return <Line tone="dim">{t("update.checking")}</Line>;
    case "unreachable":
      return <Line tone="bad">{t("update.unreachable", { message: view.message })}</Line>;
    case "running":
      return <Running op={view.op} progress={view.progress} inner={inner} />;
    case "finished":
      return <box style={{ flexDirection: "column" }}>
        <Line tone="good">{view.op === "apply" && view.result.action === "already-current" ? t("update.alreadyCurrent", { version: view.result.version }) : view.op === "apply" ? t("update.installedNow", { version: view.result.version }) : t("update.rolledBack", { version: view.result.version, from: view.result.from ?? "" })}</Line>
        {view.op === "apply" && view.result.action === "already-current" ? null : <Line>{t("update.restartNote")}</Line>}
        {view.result.warnings.map((warning) => <Line key={warning} tone="warn">{t("update.warning", { warning })}</Line>)}
      </box>;
    case "failed":
      return <box style={{ flexDirection: "column" }}>
        <Line tone="bad">{view.message}</Line>
        <Line>{t("update.untouched")}</Line>
      </box>;
    case "lost":
      return <box style={{ flexDirection: "column" }}>
        <Line tone="warn">{t("update.lost")}</Line>
        <Line tone="dim">{t("update.lostHint")}</Line>
      </box>;
    case "ready":
      return readyBody(view.check, serverName);
  }
}

function readyBody(check: UpdateCheck, serverName: string | null): ReactNode {
  switch (check.status) {
    case "up-to-date":
      return <Line tone="good">{t("update.upToDate")}</Line>;
    case "no-release":
      return <Line tone="dim">{t("update.noRelease")}</Line>;
    case "unavailable":
      return <Line tone="warn">{t("update.unavailable", { reason: check.reason ?? t("update.unknownReason") })}</Line>;
    case "available":
      if (check.updatable && serverName === null) return <Line tone="accent">{t("update.availableNow")}</Line>;
      return <box style={{ flexDirection: "column" }}>
        <Line tone="warn">{t("update.availableNow")}</Line>
        <Line>{serverName !== null ? t("update.remoteNote", { server: serverName }) : check.install.kind === "source" ? t("update.sourceNote") : t("update.noArchive")}</Line>
      </box>;
  }
}

function Running({ op, progress, inner }: { op: "apply" | "rollback"; progress: UpdateProgress | null; inner: number }) {
  const fraction = downloadFraction(progress);
  const barWidth = Math.max(10, Math.min(40, inner - 30));
  return <box style={{ flexDirection: "column" }}>
    <Line>{op === "apply" ? t("update.running") : t("update.runningRollback")}</Line>
    <box style={{ flexDirection: "column", marginTop: 1 }}>
      {stageRows(op, progress).map(({ stage, state }) => <box key={stage} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <text fg={state === "done" ? COLOR.added : state === "current" ? COLOR.accent : COLOR.faint} selectable={false}>{state === "done" ? "✓ " : state === "current" ? "● " : "○ "}</text>
        <text fg={state === "pending" ? COLOR.faint : state === "current" ? COLOR.bright : COLOR.dim} selectable={false}>{stageLabel(stage)}</text>
        {state === "current" && stage === "downloading" && progress?.bytes !== undefined
          ? <box style={{ flexDirection: "row", marginLeft: 2, flexShrink: 0 }}>
            {fraction === null ? null : <text fg={COLOR.accent} selectable={false}>{"█".repeat(Math.round(fraction * barWidth))}</text>}
            {fraction === null ? null : <text fg={COLOR.faint} selectable={false}>{"█".repeat(barWidth - Math.round(fraction * barWidth))}</text>}
            <text fg={COLOR.dim} selectable={false}>{fraction === null ? formatMebibytes(progress.bytes) : `  ${formatMebibytes(progress.bytes)} / ${formatMebibytes(progress.total ?? 0)}`}</text>
          </box>
          : null}
      </box>)}
    </box>
    <box style={{ marginTop: 1 }}><Line tone="dim">{t("update.keepsGoing")}</Line></box>
  </box>;
}

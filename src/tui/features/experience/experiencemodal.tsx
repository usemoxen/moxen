import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";

import type { ExperienceSnapshot, ReleaseText } from "../../../server/api.js";
import type { SettingSection } from "../../../core/configschema.js";
import { currentLanguage, t } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { useHover } from "../../hooks/useHover.js";
import { ModalShell } from "../../ui/modalshell.js";

interface Control { id: string; run: () => void }

/**
 * One release per page: its highlights as plain sections, then the full notes.
 * The release history opens only on request (`h`) and replaces the page.
 */
export function ChangelogModal({ snapshot, error, saving, screenWidth, screenHeight, onSettings, onRead, onGuide, onClose }: {
  snapshot: ExperienceSnapshot | null; error: string | null; saving: boolean; screenWidth: number; screenHeight: number;
  onSettings: (section: SettingSection) => void; onRead: (version: string) => void; onGuide: () => void; onClose: () => void;
}) {
  const [releaseIndex, setReleaseIndex] = useState(0);
  const [history, setHistory] = useState(false);
  // The primary action starts focused, so Enter marks the release read.
  const [focus, setFocus] = useState("read");
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const width = Math.min(96, Math.max(0, screenWidth - 10));
  const height = Math.min(34, Math.max(0, screenHeight - 4));
  const inner = Math.max(0, width - 4);
  const textWidth = Math.max(0, inner - 3);
  const releases = snapshot?.releases ?? [];
  const release = releases[releaseIndex];
  const seen = (version: string) => snapshot?.seenReleases.includes(version) ?? false;
  const unread = release !== undefined && !seen(release.version);
  const words = (value: ReleaseText) => value[currentLanguage() === "es-ES" ? "es" : "en"];
  const controls: Control[] = [];
  const action = (id: string, label: string, run: () => void, options: { tone?: "quiet" | "link" | "primary"; width?: number; badge?: string } = {}) => {
    controls.push({ id, run });
    return <ReleaseButton key={id} id={`release-control-${id}`} label={label} badge={options.badge} focused={focus === id} tone={options.tone ?? "quiet"} width={options.width}
      onPress={() => { setFocus(id); if (!saving) run(); }} />;
  };
  const browse = (delta: number) => setReleaseIndex((at) => Math.max(0, Math.min(at + delta, releases.length - 1)));
  const open = (index: number) => { setReleaseIndex(index); setHistory(false); setFocus("read"); };
  useEffect(() => { scroll.current?.scrollTo(0); }, [releaseIndex, history]);
  useEffect(() => { scroll.current?.scrollChildIntoView(`release-control-${focus}`); }, [focus]);
  useKeyboard((key) => {
    if (saving) return;
    if (key.ctrl && key.name === "c") { onClose(); return; }
    if (key.name === "escape") { if (history) setHistory(false); else onClose(); return; }
    if (key.name === "h") { setHistory((was) => !was); setFocus(history ? "read" : `history-${releaseIndex}`); return; }
    if (!history && key.name === "left") browse(-1);
    if (!history && key.name === "right") browse(1);
    if (key.name === "tab" || key.name === "up" || key.name === "down") {
      const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1;
      const at = Math.max(0, controls.findIndex((control) => control.id === focus));
      setFocus(controls[(at + delta + controls.length) % controls.length]?.id ?? "read");
    }
    if (key.name === "return") (controls.find((control) => control.id === focus) ?? controls[controls.length - 1])?.run();
    if (key.name === "pagedown") scroll.current?.scrollBy(8);
    if (key.name === "pageup") scroll.current?.scrollBy(-8);
  });

  const notes = release === undefined ? null : <>
    {release.highlights.map((highlight, index) => <box key={`highlight-${index}`} style={{ flexDirection: "column", marginBottom: 1, flexShrink: 0 }}>
      <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{words(highlight.title)}</text>
      <text fg={COLOR.text}>{words(highlight.body)}</text>
      {highlight.action ? <box style={{ flexDirection: "row" }}>
        {action(`try-${index}`, t("guide.tryFeature"), highlight.action === "onboarding" ? onGuide : () => onSettings(highlight.action === "memory" ? "memory" : "mcp"), { tone: "link" })}
      </box> : null}
    </box>)}
    {release.sections?.length ? <>
      {release.highlights.length ? <text fg={COLOR.dim} style={{ marginBottom: 1, marginTop: 1 }}>{t("guide.allChangesHeading")}</text> : null}
      {release.sections.map((section, index) => <box key={`section-${index}`} style={{ flexDirection: "column", marginBottom: 1, flexShrink: 0 }}>
        <text fg={COLOR.accent} attributes={TextAttributes.BOLD}>{words(section.title)}</text>
        {section.entries.map((entry, at) => <box key={at} style={{ flexDirection: "row", flexShrink: 0 }}>
          <text fg={COLOR.dim} wrapMode="none" style={{ width: 3, flexShrink: 0 }}>{"•"}</text><text fg={COLOR.text} style={{ flexGrow: 1, flexShrink: 1 }}>{words(entry)}</text>
        </box>)}
      </box>)}
    </> : release.highlights.length ? null : <text fg={COLOR.dim}>{t("guide.noDetailedNotes")}</text>}
  </>;

  return <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={Math.floor((screenWidth - width) / 2)} top={Math.floor((screenHeight - height) / 2)} width={width} height={height} onClose={() => { if (!saving) onClose(); }}>
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", flexShrink: 0 }}>
      <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{history ? t("guide.releaseHistory") : t("guide.changelog")}</text>
      {history || release === undefined ? null : <box style={{ flexDirection: "row", gap: 1 }}>
        <ReleaseButton id="release-previous" label="←" focused={false} tone={releaseIndex > 0 ? "quiet" : "off"} onPress={() => { if (!saving) browse(-1); }} />
        <text fg={COLOR.text}>{release.version}</text>
        <text fg={unread ? COLOR.accent : COLOR.added}>{unread ? "●" : "✓"}</text>
        <text fg={COLOR.dim}>{`·  ${t("guide.releasePosition", { n: releaseIndex + 1, total: releases.length })}`}</text>
        <ReleaseButton id="release-next" label="→" focused={false} tone={releaseIndex < releases.length - 1 ? "quiet" : "off"} onPress={() => { if (!saving) browse(1); }} />
      </box>}
    </box>
    {history ? null : <text fg={COLOR.bright} attributes={TextAttributes.BOLD} style={{ marginTop: 1, flexShrink: 0 }}>{release ? words(release.title) : t("guide.unavailable")}</text>}
    <scrollbox ref={scroll} style={{ flexGrow: 1, flexShrink: 1, marginTop: 1, minHeight: 3 }} contentOptions={{ paddingRight: 2 }}
      verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
      <box style={{ width: textWidth, flexDirection: "column", flexShrink: 0 }}>
        {history
          ? releases.map((entry, index) => <box key={entry.version} style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
            {action(`history-${index}`, `${entry.version}  ·  ${words(entry.title)}`, () => open(index), { width: textWidth, badge: seen(entry.version) ? "✓" : "●" })}
          </box>)
          : notes}
      </box>
    </scrollbox>
    {error ? <text fg={COLOR.danger} style={{ flexShrink: 0 }}>{error}</text> : null}
    <box style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 1, flexShrink: 0 }}>
      <text fg={COLOR.dim}>{t(history ? "guide.historyKeys" : "guide.changelogKeys")}</text>
      <box style={{ flexDirection: "row", gap: 2 }}>
        {action("later", t("guide.later"), onClose)}
        {action("read", t("guide.markRead"), () => { if (release) onRead(release.version); }, { tone: "primary" })}
      </box>
    </box>
  </ModalShell>;
}

/** Quiet until hovered or focused; "primary" is filled, "link" is an inline action, "off" cannot be pressed. */
function ReleaseButton({ id, label, badge, focused, tone, width, onPress }: {
  id: string; label: string; badge?: string | undefined; focused: boolean;
  tone: "quiet" | "link" | "primary" | "off"; width?: number | undefined; onPress: () => void;
}) {
  const { hovered, handlers } = useHover();
  const lit = focused || (hovered && tone !== "off");
  const primary = tone === "primary";
  const bg = primary ? (lit ? COLOR.bright : COLOR.accent) : lit ? SURFACE.hover : undefined;
  const fg = primary ? SURFACE.base : tone === "off" ? COLOR.dim : tone === "link" ? COLOR.accent : lit ? COLOR.bright : COLOR.dim;
  return <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: tone === "link" ? 0 : 1, paddingRight: tone === "link" ? 0 : 1, ...(width === undefined ? {} : { width, justifyContent: "space-between" as const }) }}
    {...(bg === undefined ? {} : { backgroundColor: bg })} onMouseDown={() => { if (tone !== "off") onPress(); }} selectable={false} {...handlers}>
    <text fg={fg} {...(bg === undefined ? {} : { bg })} wrapMode="none" selectable={false} attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}>{label}</text>
    {badge === undefined ? null : <text fg={badge === "✓" ? COLOR.added : COLOR.accent} {...(bg === undefined ? {} : { bg })} selectable={false}>{badge}</text>}
  </box>;
}

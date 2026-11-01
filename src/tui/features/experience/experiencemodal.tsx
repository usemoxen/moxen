import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";

import type { ExperienceSnapshot, ReleaseText } from "../../../server/api.js";
import type { SettingSection } from "../../../core/configschema.js";
import { currentLanguage, t } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { useHover } from "../../hooks/useHover.js";
import { ModalShell } from "../../ui/modalshell.js";

/** Release content is supplied by the server; highlights and complete notes are separate views. */
export function ChangelogModal({ snapshot, error, saving, screenWidth, screenHeight, onSettings, onRead, onGuide, onClose }: {
  snapshot: ExperienceSnapshot | null; error: string | null; saving: boolean; screenWidth: number; screenHeight: number;
  onSettings: (section: SettingSection) => void; onRead: (version: string) => void; onGuide: () => void; onClose: () => void;
}) {
  const [releaseIndex, setReleaseIndex] = useState(0);
  const [tab, setTab] = useState<"highlights" | "details">("highlights");
  const [focus, setFocus] = useState(0);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const history = useRef<ScrollBoxRenderable | null>(null);
  const width = Math.min(104, screenWidth - 10);
  const height = Math.min(30, screenHeight - 6);
  const historyWidth = 22;
  const contentWidth = Math.max(0, width - 4 - historyWidth - 4);
  const release = snapshot?.releases[releaseIndex];
  const showDetails = tab === "details" || release?.highlights.length === 0;
  const unread = release !== undefined && snapshot !== null && !snapshot.seenReleases.includes(release.version);
  const words = (value: ReleaseText) => value[currentLanguage() === "es-ES" ? "es" : "en"];
  const controls: Array<() => void> = [];
  const action = (label: string, run: () => void, options: { chosen?: boolean; badge?: string; tone?: "quiet" | "tab" | "link" | "primary"; width?: number } = {}) => {
    const at = controls.push(run) - 1;
    return <ChangelogButton key={`${label}:${at}`} id={`release-control-${at}`} label={label} badge={options.badge} chosen={options.chosen ?? false}
      focused={focus === at} tone={options.tone ?? "quiet"} width={options.width} onPress={() => { setFocus(at); if (!saving) run(); }} />;
  };
  const browse = (delta: number) => setReleaseIndex((at) => Math.max(0, Math.min(at + delta, (snapshot?.releases.length ?? 1) - 1)));
  useEffect(() => { scroll.current?.scrollTo(0); }, [releaseIndex, tab]);
  useEffect(() => {
    scroll.current?.scrollChildIntoView(`release-control-${focus}`);
    history.current?.scrollChildIntoView(`release-control-${focus}`);
  }, [focus]);
  useKeyboard((key) => {
    if (saving) return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) onClose();
    if (key.name === "left") browse(-1);
    if (key.name === "right") browse(1);
    if (key.name === "tab" || key.name === "up" || key.name === "down") {
      const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1;
      setFocus((at) => (at + delta + controls.length) % controls.length);
    }
    if (key.name === "return") controls[Math.min(focus, controls.length - 1)]?.();
    if (key.name === "pagedown") scroll.current?.scrollBy(8);
    if (key.name === "pageup") scroll.current?.scrollBy(-8);
    if (key.name === "d") setTab((at) => at === "details" ? "highlights" : "details");
  });
  return <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={Math.floor((screenWidth - width) / 2)} top={Math.floor((screenHeight - height) / 2)} width={width} height={height} onClose={() => { if (!saving) onClose(); }}>
    <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between", flexShrink: 0 }}>
      <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{t("guide.changelog")}</text>
      <box style={{ flexDirection: "row", gap: 2 }}>
        <text fg={COLOR.dim}>{t("guide.releaseVersion", { version: release?.version ?? snapshot?.version ?? "…" })}</text>
        {release === undefined ? null : <text fg={unread ? COLOR.accent : COLOR.added}>{unread ? "●" : "✓"}</text>}
      </box>
    </box>
    <box style={{ flexDirection: "row", flexGrow: 1, gap: 4, marginTop: 1 }}>
      <box style={{ width: historyWidth, flexDirection: "column", flexShrink: 0 }}>
        <text fg={COLOR.dim} style={{ marginBottom: 1 }}>{t("guide.releaseHistory")}</text>
        <scrollbox ref={history} style={{ flexGrow: 1 }} contentOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
          {(snapshot?.releases ?? []).map((entry, index) => <box key={entry.version} style={{ flexDirection: "column", marginBottom: 1, flexShrink: 0 }}>
            {action(entry.version, () => setReleaseIndex(index), { chosen: index === releaseIndex, badge: snapshot?.seenReleases.includes(entry.version) ? "✓" : "●", width: historyWidth - 1 })}
          </box>)}
        </scrollbox>
      </box>
      <box style={{ flexDirection: "column", width: contentWidth, paddingRight: 2 }}>
        <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{release ? words(release.title) : t("guide.unavailable")}</text>
        <box style={{ flexDirection: "row", gap: 2, marginTop: 1, marginBottom: 1, flexShrink: 0 }}>
          {release?.highlights.length ? action(t("guide.highlights"), () => setTab("highlights"), { chosen: !showDetails, tone: "tab" }) : null}
          {action(t("guide.allChanges"), () => setTab("details"), { chosen: showDetails, tone: "tab" })}
        </box>
        <scrollbox ref={scroll} style={{ flexGrow: 1 }} contentOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
          {!showDetails ? release?.highlights.map((highlight, index) => <box key={index} style={{ flexDirection: "column", padding: 1, marginBottom: 1, flexShrink: 0 }} backgroundColor={SURFACE.panel} border={["left"]} borderColor={COLOR.accent}>
            <text fg={COLOR.bright} attributes={TextAttributes.BOLD}>{words(highlight.title)}</text>
            <text fg={COLOR.text} style={{ marginTop: 1 }}>{words(highlight.body)}</text>
            {highlight.action ? <box style={{ flexDirection: "row", marginTop: 1 }}>
              {action(t("guide.tryFeature"), highlight.action === "onboarding" ? onGuide : () => onSettings(highlight.action === "memory" ? "memory" : "mcp"), { tone: "link" })}
            </box> : null}
          </box>) : release?.sections?.length ? release.sections.map((section, index) => <box key={index} style={{ flexDirection: "column", marginBottom: 1, flexShrink: 0 }}>
            <text fg={COLOR.accent} attributes={TextAttributes.BOLD}>{words(section.title)}</text>
            {section.entries.map((entry, at) => <box key={at} style={{ flexDirection: "row", gap: 2, flexShrink: 0 }}>
              <text fg={COLOR.dim}>{"•"}</text><text fg={COLOR.text} style={{ flexShrink: 1 }}>{words(entry)}</text>
            </box>)}
          </box>) : <text fg={COLOR.dim}>{t("guide.noDetailedNotes")}</text>}
        </scrollbox>
      </box>
    </box>
    {error ? <text fg={COLOR.danger}>{error}</text> : null}
    <box style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 1, flexShrink: 0 }}>
      <text fg={COLOR.dim}>{t("guide.changelogKeys")}</text>
      <box style={{ flexDirection: "row", gap: 2 }}>
        {action(t("guide.later"), onClose)}
        {action(t("guide.markRead"), () => { if (release) onRead(release.version); }, { tone: "primary" })}
      </box>
    </box>
  </ModalShell>;
}

/** One row in the release viewer: quiet until hovered or focused, filled when it is the primary action. */
function ChangelogButton({ id, label, badge, chosen, focused, tone, width, onPress }: {
  id: string; label: string; badge?: string | undefined; chosen: boolean; focused: boolean;
  tone: "quiet" | "tab" | "link" | "primary"; width?: number | undefined; onPress: () => void;
}) {
  const { hovered, handlers } = useHover();
  const primary = tone === "primary";
  const bg = primary
    ? focused || hovered ? COLOR.bright : COLOR.accent
    : tone === "link" ? focused || hovered ? SURFACE.hover : SURFACE.panel : chosen || focused || hovered ? SURFACE.hover : SURFACE.raised;
  const fg = primary ? SURFACE.base : tone === "link" ? COLOR.accent : chosen ? COLOR.accent : focused || hovered ? COLOR.bright : COLOR.dim;
  return <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, ...(tone === "tab" ? {} : { border: ["left"] as const }), ...(width === undefined ? {} : { width }), ...(badge === undefined ? {} : { justifyContent: "space-between" as const }), ...(tone === "tab" ? { paddingLeft: 1, paddingRight: 1 } : primary || badge !== undefined ? { paddingLeft: 1, paddingRight: primary ? 2 : 1 } : {}) }}
    borderColor={focused ? (primary ? COLOR.bright : COLOR.accent) : bg}
    backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
    <text fg={fg} bg={bg} wrapMode="none" selectable={false} attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}>{label}</text>
    {badge === undefined ? null : <text fg={chosen ? COLOR.accent : COLOR.added} bg={bg} selectable={false}>{badge}</text>}
  </box>;
}

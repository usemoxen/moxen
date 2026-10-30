import { t, tx } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import type { McpAccessEntry } from "../../model/settings.js";

/**
 * Which MCP servers one provider gets: every configured server as a checkbox.
 * A tick is applied at once (the setting holds the names switched OFF, so a
 * server added later is on by default); a server that stays out for another
 * reason says why and cannot be ticked here. The provider's own tools use the
 * same editor (`noun: "tools"`): the setting holds the names switched off.
 */
export function McpAccessEditor({
  title,
  description,
  servers,
  excluded,
  width,
  noun = "servers",
  onChange,
  onExit,
}: {
  title: string;
  description: string;
  servers: readonly McpAccessEntry[];
  excluded: readonly string[];
  width: number;
  /** What the rows are: "servers" (the MCP servers) or "tools" (the provider's own). */
  noun?: "servers" | "tools";
  /** The names now switched off, comma-separated; empty puts the setting back to unset. */
  onChange: (excluded: string) => void;
  onExit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, servers.length - 1));
  const off = new Set(excluded);

  const write = (names: ReadonlySet<string>) => onChange(servers.map((server) => server.name).filter((name) => names.has(name)).concat([...names].filter((name) => !servers.some((server) => server.name === name))).join(","));
  const toggle = (server: McpAccessEntry | undefined) => {
    if (server === undefined || server.locked !== null) return;
    const next = new Set(off);
    if (next.has(server.name)) next.delete(server.name);
    else next.add(server.name);
    write(next);
  };
  const setAll = (on: boolean) => write(on ? new Set([...off].filter((name) => !servers.some((server) => server.name === name && server.locked === null))) : new Set([...off, ...servers.filter((server) => server.locked === null).map((server) => server.name)]));

  useKeyboard((key) => {
    // Claimed, so the page behind does not also read this esc or arrow.
    key.preventDefault();
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    if (escape || key.name === "left") return onExit();
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) return setCursor(Math.min(at + 1, Math.max(0, servers.length - 1)));
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) return setCursor(Math.max(at - 1, 0));
    if (enter || key.name === "space" || key.name === "right") return toggle(servers[at]);
    if (!key.ctrl && !key.meta && key.name === "a") return setAll(true);
    if (!key.ctrl && !key.meta && key.name === "n") return setAll(false);
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(`mcp-access-${at}`), 0);
    return () => clearTimeout(timer);
  }, [at]);

  const on = servers.filter((server) => server.locked === null && !off.has(server.name)).length;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <Back onBack={onExit} />
      <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{title}</text>
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{description}</text>
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
        {servers.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{noun === "tools" ? t("ma.noTools") : t("ma.noServers")}</text> : null}
        {servers.map((server, index) => (
          <Row key={server.name} id={`mcp-access-${index}`} server={server} checked={server.locked === null && !off.has(server.name)} active={index === at} width={width} onPress={() => { setCursor(index); toggle(server); }} />
        ))}
      </scrollbox>
      <box style={{ flexDirection: "row", flexShrink: 0, height: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(servers.length === 0 ? t("ho.escBack") : t("ma.footer", { on, total: servers.length }), width)}</text>
      </box>
    </box>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} onMouseDown={onBack} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("ui.back")}</text>
    </box>
  );
}

function Row({ id, server, checked, active, width, onPress }: { id: string; server: McpAccessEntry; checked: boolean; active: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const locked = server.locked !== null;
  const left = `${active ? "▌ " : "  "}${checked ? "☑" : "☐"} ${server.name}`;
  const right = locked ? `· ${tx(server.locked ?? "")}` : server.summary;
  const rightWidth = Math.max(0, width - left.length - 4);
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={locked ? COLOR.faint : active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(left, Math.max(8, width - 4))}</text>
      {rightWidth < 6 ? null : <text fg={locked ? COLOR.warn : COLOR.dim} bg={bg} selectable={false}>{truncate(right, rightWidth)}</text>}
    </box>
  );
}

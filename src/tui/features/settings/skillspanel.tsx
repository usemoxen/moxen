import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ClientApi, QueryResult } from "../../../server/api.js";
import { t } from "../../i18n/index.js";
import { useToasts } from "../../hooks/useToasts.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { TextField } from "./textfield.js";

type Inventory = QueryResult<"skills.manage.list">;
type Skill = Inventory["skills"][number];
type Source = Skill["source"];
const SOURCES: readonly Source[] = ["agents", "claude"];

/** User-owned packages; the server chooses paths and applies every mutation. */
export function SkillsPanel({ client, width, onClose, showHint = true }: { client?: ClientApi | undefined; width: number; onClose?: () => void; showHint?: boolean }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [projects, setProjects] = useState<QueryResult<"projects.list">["projects"]>([]);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [chooseScope, setChooseScope] = useState(false);
  const [scopeAt, setScopeAt] = useState(0);
  const [source, setSource] = useState<Source>("agents");
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [editing, setEditing] = useState<"import" | "text" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const { toasts, push } = useToasts();
  const generation = useRef(0);
  const listRef = useRef<ScrollBoxRenderable | null>(null);
  const error = useCallback((failure: unknown) => push("skills", "danger", t("skills.failed", { message: failure instanceof Error ? failure.message : String(failure) })), [push]);
  const refresh = useCallback(async () => {
    if (!client) { setLoading(false); return; }
    const version = ++generation.current;
    setLoading(true);
    try {
      const result = await client.query({ type: "skills.manage.list", ...(projectId ? { projectId } : {}) });
      if (version === generation.current) { setInventory(result); setSelected((at) => Math.max(0, Math.min(at, result.skills.length - 1))); }
    }
    catch (failure) { if (version === generation.current) error(failure); }
    finally { if (version === generation.current) setLoading(false); }
  }, [client, projectId, error]);
  useEffect(() => {
    setInventory(null); setSelected(0); setEditing(null); setConfirm(false);
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.query({ type: "projects.list" }).then((result) => { if (active) setProjects(result.projects.filter((project) => !project.scratch && project.deletedAt === null)); }, error);
    return () => { active = false; };
  }, [client, error]);
  const skills = inventory?.skills ?? [];
  const skill = skills[Math.min(selected, Math.max(0, skills.length - 1))];
  useEffect(() => { listRef.current?.scrollChildIntoView(`managed-skill-${selected}`); }, [selected]);
  useEffect(() => {
    setText(null); setConfirm(false);
    if (!client || !skill) return;
    let active = true;
    void client.query({ type: "skills.manage.read", source: skill.source, folder: skill.folder, ...(projectId ? { projectId } : {}) }).then((result) => { if (active) setText(result.text); }, (failure) => { if (active) error(failure); });
    return () => { active = false; };
  }, [client, skill, projectId, error]);
  const mutate = async (action: () => Promise<unknown>, message: string) => {
    if (busy || !client) return;
    setBusy(true);
    try { await action(); setEditing(null); setConfirm(false); await refresh(); push("skills", "info", message, 6000); }
    catch (failure) { error(failure); }
    finally { setBusy(false); }
  };
  const address = skill ? { source: skill.source, folder: skill.folder, ...(projectId ? { projectId } : {}) } : null;
  const toggle = () => {
    if (client && skill?.editable && address) void mutate(() => client.dispatch({ type: "skills.enabled.set", ...address, enabled: !skill.enabled }), t("skills.changed"));
  };
  const edit = () => { if (!busy && skill?.editable && text !== null) setEditing("text"); };
  const remove = () => {
    if (!client || !address || !skill?.editable) return;
    void mutate(async () => {
      const result = await client.dispatch({ type: "skills.remove", ...address });
      push("skills-recovery", "info", t("skills.removedTo", { path: result.movedTo }));
    }, t("skills.removed"));
  };
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") {
      if (editing !== null || confirm || chooseScope) { key.preventDefault(); setEditing(null); setConfirm(false); setChooseScope(false); }
      else { key.preventDefault(); onClose?.(); }
      return;
    }
    if (editing === "import" && key.ctrl && key.name === "o" && !busy) { key.preventDefault(); setSource(SOURCES[(SOURCES.indexOf(source) + 1) % SOURCES.length]!); return; }
    if (key.defaultPrevented || key.name === "tab" || key.ctrl || key.meta || busy) return;
    if (chooseScope) {
      if (key.name === "up" || key.name === "k") { key.preventDefault(); setScopeAt((at) => Math.max(0, at - 1)); }
      else if (key.name === "down" || key.name === "j") { key.preventDefault(); setScopeAt((at) => Math.min(projects.length, at + 1)); }
      else if (key.name === "return" || key.name === "enter") { key.preventDefault(); setProjectId(scopeAt === 0 ? undefined : projects[scopeAt - 1]?.id); setChooseScope(false); }
      return;
    }
    if (editing !== null) return;
    if (confirm) {
      if (key.name === "y") { key.preventDefault(); remove(); }
      else if (key.name === "n") { key.preventDefault(); setConfirm(false); }
      return;
    }
    if (key.name === "up" || key.name === "k") { key.preventDefault(); setSelected((at) => Math.max(0, at - 1)); }
    else if (key.name === "down" || key.name === "j") { key.preventDefault(); setSelected((at) => Math.min(skills.length - 1, at + 1)); }
    else if (key.name === "e" || key.name === "return") { key.preventDefault(); edit(); }
    else if (key.name === "space") { key.preventDefault(); toggle(); }
    else if (key.name === "a") { key.preventDefault(); setEditing("import"); }
    else if (key.name === "s") { key.preventDefault(); setScopeAt(Math.max(0, projects.findIndex((project) => project.id === projectId) + 1)); setChooseScope(true); }
    else if (key.name === "r") { key.preventDefault(); void refresh(); }
    else if (key.name === "d" && skill?.editable) { key.preventDefault(); setConfirm(true); }
  });
  const button = (label: string, action: () => void) => <HoverButton label={`[ ${label} ] `} fg={busy ? COLOR.faint : COLOR.accent} hoverFg={COLOR.bright} bg={SURFACE.raised} onClick={() => { if (!busy) action(); }} />;
  return <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
    <text style={{ flexShrink: 0 }} fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("skills.title")}</text>
    <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.description")}</text>
    <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1, flexShrink: 0 }}>
      {button(projects.find((project) => project.id === projectId)?.title ?? t("skills.global"), () => { setChooseScope(!chooseScope); setEditing(null); })}
      {button(t("skills.import"), () => { setEditing("import"); setChooseScope(false); })}
      {button(t("skills.refresh"), () => { void refresh(); })}
    </box>
    {chooseScope ? <scrollbox style={{ flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      {button(`${scopeAt === 0 ? "▸ " : "  "}${t("skills.global")}`, () => { setProjectId(undefined); setChooseScope(false); })}
      {projects.map((project, at) => <HoverButton key={project.id} label={`${scopeAt === at + 1 ? "▸ " : "  "}${project.title}`} fg={COLOR.text} hoverFg={COLOR.bright} bg={SURFACE.raised} onClick={() => { if (!busy) { setProjectId(project.id); setChooseScope(false); } }} />)}
    </scrollbox> : editing === "import" ? <box style={{ flexDirection: "column", marginTop: 1 }}>
      {button(t("skills.destination", { source }), () => setSource(SOURCES[(SOURCES.indexOf(source) + 1) % SOURCES.length]!))}
      {inventory ? <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(inventory.roots[source], width)}</text> : null}
      <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.importHelp")}</text>
      <TextField initial="" width={width} placeholder={t("skills.folderPath")} onSubmit={(from) => { if (client) void mutate(() => client.dispatch({ type: "skills.import", source, from, ...(projectId ? { projectId } : {}) }), t("skills.imported")); }} />
    </box> : editing === "text" && text !== null ? <TextField key={skill?.path} initial={text} multiline width={width} onSubmit={(next) => { if (client && address) void mutate(() => client.dispatch({ type: "skills.save", ...address, text: next, previous: text }), t("skills.changed")); }} /> : <>
      <scrollbox ref={listRef} style={{ height: Math.max(3, Math.min(9, skills.length + 1)), flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        {loading ? <text fg={COLOR.dim} bg={SURFACE.raised}>{t("skills.loading")}</text> : skills.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised}>{t("skills.empty")}</text> : skills.map((entry, at) => <box id={`managed-skill-${at}`} key={`${entry.source}/${entry.folder}`} style={{ height: 1, flexShrink: 0 }}><HoverButton label={truncate(`${at === selected ? "▸ " : "  "}${entry.name} · ${entry.source} · ${t(entry.enabled ? "skills.enabled" : "skills.disabled")}`, width)} fg={at === selected ? COLOR.bright : COLOR.text} hoverFg={COLOR.bright} bg={SURFACE.raised} onClick={() => { if (!busy) setSelected(at); }} /></box>)}
      </scrollbox>
      {skill ? <>
        <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(skill.path, width)}</text>
        <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word">{skill.description}</text>
        {skill.editable ? <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1, flexShrink: 0 }}>
          {button(t("skills.edit"), edit)}
          {button(t(skill.enabled ? "skills.disable" : "skills.enable"), toggle)}
          {button(t("skills.remove"), () => setConfirm(true))}
        </box> : <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.linked")}</text>}
        {confirm ? <box style={{ flexDirection: "column", marginTop: 1, flexShrink: 0 }}>
          <text fg={COLOR.warn} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.confirmRemove", { name: skill.name })}</text>
          <box style={{ flexDirection: "row" }}>{button(t("skills.confirm"), remove)}{button(t("skills.cancel"), () => setConfirm(false))}</box>
        </box> : <scrollbox style={{ flexGrow: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}><text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word">{text ?? ""}</text></scrollbox>}
      </> : null}
    </>}
    {toasts.map((toast) => <text key={toast.id} fg={toast.tone === "danger" ? COLOR.removed : COLOR.added} bg={SURFACE.raised} wrapMode="word" selectable={false}>{toast.text}</text>)}
    {showHint || busy ? <text style={{ flexShrink: 0 }} fg={COLOR.faint} bg={SURFACE.raised} wrapMode="word" selectable={false}>{busy ? t("skills.saving") : t("skills.hint")}</text> : null}
  </box>;
}

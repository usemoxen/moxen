import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ClientApi, QueryResult } from "../../../server/api.js";
import { t } from "../../i18n/index.js";
import { useToasts } from "../../hooks/useToasts.js";
import { Chip } from "../../ui/chip.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import type { McpProviderKind } from "../../../core/mcp.js";
import { Line } from "./listeditor.js";
import { McpAccessEditor } from "./mcpaccess.js";
import { TextField } from "./textfield.js";

type Inventory = QueryResult<"skills.manage.list">;
type Skill = Inventory["skills"][number];
type Source = Skill["source"];
const SOURCES: readonly Source[] = ["agents", "claude"];
/** The providers a skill can go to, named as Settings names them. */
const PROVIDERS: readonly { readonly kind: McpProviderKind; readonly name: string }[] = [
  { kind: "claude", name: "Claude Code" },
  { kind: "codex", name: "Codex" },
  { kind: "opencode", name: "OpenCode" },
  { kind: "harness", name: "Moxen Harness" },
];
const providerNames = (kinds: readonly McpProviderKind[] | undefined): string => PROVIDERS.filter((provider) => kinds?.includes(provider.kind)).map((provider) => provider.name).join(", ");

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
  const [choosingProviders, setChoosingProviders] = useState(false);
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
    setInventory(null); setSelected(0); setEditing(null); setConfirm(false); setChoosingProviders(false);
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
  const chooseProviders = () => { if (!busy && skill?.editable) { setEditing(null); setConfirm(false); setChooseScope(false); setChoosingProviders(true); } };
  /** Applied at once. The list the server takes is the providers that stay on; empty would mean every provider, so a tick that leaves none is refused. */
  const setProviders = (excluded: string) => {
    if (!client || !address) return;
    const off = new Set(excluded.split(",").filter((name) => name !== ""));
    const on = PROVIDERS.filter((provider) => !off.has(provider.kind)).map((provider) => provider.kind);
    if (on.length === 0) { push("skills", "danger", t("skills.providersNone")); return; }
    void client.dispatch({ type: "skills.providers.set", ...address, providers: on.length === PROVIDERS.length ? [] : on }).then(refresh, error);
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
    // The provider choice reads its own keys, esc included.
    if (choosingProviders) return;
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
    else if (key.name === "p") { key.preventDefault(); chooseProviders(); }
    else if (key.name === "a") { key.preventDefault(); setEditing("import"); }
    else if (key.name === "s") { key.preventDefault(); setScopeAt(Math.max(0, projects.findIndex((project) => project.id === projectId) + 1)); setChooseScope(true); }
    else if (key.name === "r") { key.preventDefault(); void refresh(); }
    else if (key.name === "d" && skill?.editable) { key.preventDefault(); setConfirm(true); }
  });
  /** A plain action, as on the other Settings pages: a label and its key. */
  const action = (label: string, keyHint: string, run: () => void, extra: { danger?: boolean } = {}) => <Chip label={label} keyHint={keyHint} onPress={() => { if (!busy) run(); }} disabled={busy} {...extra} />;
  const toasting = toasts.map((toast) => <text key={toast.id} fg={toast.tone === "danger" ? COLOR.removed : COLOR.added} bg={SURFACE.raised} wrapMode="word" selectable={false}>{toast.text}</text>);
  if (choosingProviders && skill) {
    const off = PROVIDERS.filter((provider) => skill.providers !== undefined && skill.providers.length > 0 && !skill.providers.includes(provider.kind)).map((provider) => provider.kind);
    return <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <McpAccessEditor title={t("skills.providersTitle", { name: skill.name })} description={t("skills.providersHelp")} servers={PROVIDERS.map((provider) => ({ name: provider.kind, label: provider.name, summary: "", locked: null }))} excluded={off} width={width} onChange={setProviders} onExit={() => setChoosingProviders(false)} />
      {toasting}
    </box>;
  }
  const scopeTitle = projects.find((project) => project.id === projectId)?.title ?? t("skills.global");
  const offered = skill?.providers !== undefined && skill.providers.length > 0 ? providerNames(skill.providers) : t("skills.allProviders");
  return <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
    <text style={{ flexShrink: 0 }} fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("skills.title")}</text>
    <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.description")}</text>
    <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1, flexShrink: 0 }}>
      <Chip label={scopeTitle} keyHint="s" accent onPress={() => { if (!busy) { setChooseScope(!chooseScope); setEditing(null); } }} disabled={busy} />
      {action(t("skills.import"), "a", () => { setEditing("import"); setChooseScope(false); })}
      {action(t("skills.refresh"), "r", () => { void refresh(); })}
    </box>
    {chooseScope ? <scrollbox style={{ flexGrow: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
      <Line id="skill-scope-0" left={`${scopeAt === 0 ? "▌ " : "  "}${t("skills.global")}`} right="" active={scopeAt === 0} width={width} onPress={() => { if (!busy) { setProjectId(undefined); setChooseScope(false); } }} />
      {projects.map((project, at) => <Line key={project.id} id={`skill-scope-${at + 1}`} left={`${scopeAt === at + 1 ? "▌ " : "  "}${project.title}`} right="" active={scopeAt === at + 1} width={width} onPress={() => { if (!busy) { setProjectId(project.id); setChooseScope(false); } }} />)}
    </scrollbox> : editing === "import" ? <box style={{ flexDirection: "column", marginTop: 1 }}>
      <box style={{ flexDirection: "row", flexShrink: 0 }}>{action(t("skills.destination", { source }), "ctrl+o", () => setSource(SOURCES[(SOURCES.indexOf(source) + 1) % SOURCES.length]!))}</box>
      {inventory ? <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(inventory.roots[source], width)}</text> : null}
      <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.importHelp")}</text>
      <TextField initial="" width={width} placeholder={t("skills.folderPath")} onSubmit={(from) => { if (client) void mutate(() => client.dispatch({ type: "skills.import", source, from, ...(projectId ? { projectId } : {}) }), t("skills.imported")); }} />
    </box> : editing === "text" && text !== null ? <TextField key={skill?.path} initial={text} multiline width={width} onSubmit={(next) => { if (client && address) void mutate(() => client.dispatch({ type: "skills.save", ...address, text: next, previous: text }), t("skills.changed")); }} /> : <>
      <scrollbox ref={listRef} style={{ height: Math.max(3, Math.min(9, skills.length + 1)), flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        {loading ? <text fg={COLOR.dim} bg={SURFACE.raised}>{t("skills.loading")}</text> : skills.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised}>{t("skills.empty")}</text> : skills.map((entry, at) => (
          <Line key={`${entry.source}/${entry.folder}`} id={`managed-skill-${at}`} left={`${at === selected ? "▌ " : "  "}${entry.name}`} right={[entry.source, t(entry.enabled ? "skills.enabled" : "skills.disabled"), ...(entry.providers !== undefined && entry.providers.length > 0 ? [providerNames(entry.providers)] : [])].join(" · ")} active={at === selected} width={width} onPress={() => { if (!busy) setSelected(at); }} />
        ))}
      </scrollbox>
      {skill ? <>
        <text style={{ flexShrink: 0, marginTop: 1 }} fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(skill.path, width)}</text>
        <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word">{skill.description}</text>
        <text style={{ flexShrink: 0 }} fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(t("skills.offeredTo", { providers: offered }), width)}</text>
        {skill.editable ? <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1, flexShrink: 0 }}>
          {action(t("skills.edit"), "e", edit)}
          {action(t(skill.enabled ? "skills.disable" : "skills.enable"), t("skills.spaceKey"), toggle)}
          {action(t("skills.providers"), "p", chooseProviders)}
          {action(t("skills.remove"), "d", () => setConfirm(true), { danger: true })}
        </box> : <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.linked")}</text>}
        {confirm ? <box style={{ flexDirection: "column", marginTop: 1, flexShrink: 0 }}>
          <text fg={COLOR.warn} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("skills.confirmRemove", { name: skill.name })}</text>
          <box style={{ flexDirection: "row" }}>{action(t("skills.confirm"), "y", remove, { danger: true })}{action(t("skills.cancel"), "n", () => setConfirm(false))}</box>
        </box> : <scrollbox style={{ flexGrow: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}><text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word">{text ?? ""}</text></scrollbox>}
      </> : null}
    </>}
    {toasting}
    {showHint || busy ? <text style={{ flexShrink: 0 }} fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{busy ? t("skills.saving") : t("skills.hint")}</text> : null}
  </box>;
}

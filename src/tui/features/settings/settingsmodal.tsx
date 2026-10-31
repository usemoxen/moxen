import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { StyledText, TextAttributes, fg } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { ListEditor, type Screen as EditorScreen } from "./listeditor.js";
import { itemRows } from "../../model/listeditor.js";
import { McpAccessEditor } from "./mcpaccess.js";
import { WebOrderEditor } from "./weborder.js";
import { HandoffModelsEditor } from "./handoffmodels.js";
import { TextField } from "./textfield.js";
import type { HarnessRun } from "./useSettings.js";
import { APPLIES_AT_TEXT, type ListItemView } from "../../../core/configschema.js";
import { currentLanguage, t, tx } from "../../i18n/index.js";
import { localizeSnapshot } from "../../i18n/settingsview.js";
import type { DiscoverResult } from "../../../core/types.js";
import type { HarnessApiFormat } from "../../../core/types.js";
import { ModalShell } from "../../ui/modalshell.js";
import { Slider, SliderDefault } from "../../ui/slider.js";
import { effortTones, sliderLayout } from "../../model/slider.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { splitInlineCode } from "../../model/inlinecode.js";
import { nextToggleValue, providerVersionLine, settingControl, withModelOverride, MODEL_OVERRIDE_KEY, settingValueLabel, updatableProviderOf, type LatestView, type ProviderCheckView, type SettingControl, type SettingOption } from "../../model/settings.js";
import type { LatestVersions, UpdatableProvider } from "../../../core/catalog/update.js";
import {
  SECTION_LABEL,
  SETTING_SECTIONS,
  type SettingDescriptor,
  type SettingSection,
  type SettingValue,
} from "../../../core/configschema.js";
import { driverKindOfInstance } from "../../../core/types.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import type { SettingsSnapshot } from "../../../server/api.js";
import type { McpRunner } from "../../../core/providers/harness/presets.js";

/**
 * The settings page: one tab per schema section down the left, a rule, and
 * that section's settings on the right.
 *
 * Every row is generated from the core schema table rather than written
 * here, which is the whole point: a setting added to `core/configschema.ts`
 * shows up in this page and in `moxen config set` at the same time, with
 * the same label, the same choices and the same validation. There is no
 * list of keys in this file.
 *
 * Nothing is typed that can be picked (`model/settings.ts` decides): a
 * boolean flips in place, everything with a known set of values — enums,
 * presets, the provider catalog's providers, models and efforts — opens a
 * list in the right pane, and only what only the user knows (a path, extra
 * instructions) swaps the row for an input. Nothing is optimistic — see
 * `useSettings` — so a refused value visibly stays refused.
 */

interface SettingItem {
  readonly descriptor: SettingDescriptor;
  readonly value: SettingValue;
  readonly explicit: boolean;
  readonly control: SettingControl;
  /** The entries of a list setting. */
  readonly entries?: readonly ListItemView[];
  /** Why the setting can do nothing right now: the card is greyed out and says so. */
  readonly unavailable?: string;
  /** What the setting amounts to with everything else taken into account (`SettingView.inForce`). */
  readonly inForce?: string;
}

/** The left column: section labels plus the selection bar and a gap. */
const TAB_WIDTH = 25;

/** The sidebar's categories, top to bottom: each names the sections filed under it. */
const SECTION_CATEGORY: Record<SettingSection, string> = {
  general: "Moxen",
  defaults: "Moxen",
  sessions: "Moxen",
  "long-threads": "Moxen",
  agent: "Moxen",
  interface: "Moxen",
  git: "Moxen",
  "provider:codex": "Providers",
  "provider:claude": "Providers",
  "provider:opencode": "Providers",
  "provider:harness": "Moxen Harness",
  mcp: "Integrations",
};

/** Sections long enough to be split in the sidebar, one entry per heading on the page. */
const PAGED_SECTIONS: ReadonlySet<SettingSection> = new Set<SettingSection>(["provider:harness"]);

/** One row of the sidebar: a section, or one heading of a paged section. */
interface SidebarEntry {
  readonly section: SettingSection;
  readonly group: string | null;
  readonly label: string;
  /** The tree drawing before the label: `├ `, `│ └ `… */
  readonly prefix: string;
  /** An entry of a nested list (a model-server profile, an MCP server) under its heading, and one of that entry's own headings. */
  readonly profile?: string;
  /** The nested list setting `profile` belongs to. */
  readonly list?: string;
  /** Set on a heading of the model open inside `profile`, so clicking it narrows that model's editor. */
  readonly model?: string;
  readonly heading?: string;
  /** The way back out of a profile to the list of them. */
  readonly back?: true;
}

/** The list settings whose entries nest in the sidebar (model-server profiles, MCP servers), and open into a view of their own. */
const NESTED_LISTS: readonly string[] = ["providers.harness.profiles", "mcpServers"];

export function SettingsModal({
  snapshot: rawSnapshot,
  loading,
  saving,
  error,
  onSet,
  onDuplicate,
  run,
  onTest,
  onTestMcp,
  onProbe,
  onDiscover,
  onExport,
  onImport,
  notice,
  versions,
  latest,
  updating,
  onUpdate,
  providers,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
}: {
  snapshot: SettingsSnapshot | null;
  loading: boolean;
  saving: string | null;
  error: string | null;
  onSet: (key: string, value: string) => unknown;
  onDuplicate: (key: string, id: string, newId: string) => void;
  /** The last test or probe of a harness profile, while it runs and after. */
  run: HarnessRun | null;
  onTest: (profileId: string, model?: string) => void;
  /** Start an MCP server and list its tools. */
  onTestMcp: (name: string) => void;
  onProbe: (profileId: string, model?: string) => void;
  onDiscover: (baseUrl: string, apiFormat: HarnessApiFormat, apiKeyEnv?: string) => Promise<DiscoverResult>;
  onExport: (profileId: string, file: string) => void;
  onImport: (file: string) => void;
  notice: { readonly text: string; readonly error: boolean } | null;
  /** Each updatable provider's install, from the doctor query; null until it answers. */
  versions: { readonly codex?: ProviderCheckView; readonly claude: ProviderCheckView; readonly opencode: ProviderCheckView } | null;
  /** The newest release of each, from the registry; null until it answers. */
  latest: LatestVersions | null;
  /** The providers whose updater is running now. */
  updating: ReadonlySet<UpdatableProvider>;
  onUpdate: (provider: UpdatableProvider) => void;
  /** The provider catalog: what the model defaults offer. Null while it loads. */
  providers: readonly ProviderSummary[] | null;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const language = currentLanguage();
  // The page draws the snapshot in the current language; what it writes back is by key and value, which stay as they were.
  const snapshot = useMemo(() => localizeSnapshot(rawSnapshot), [rawSnapshot, language]);
  const inner = Math.max(40, width - 4);
  const paneWidth = Math.max(24, inner - TAB_WIDTH - 3);
  const [tab, setTab] = useState<SettingSection>(SETTING_SECTIONS[0]);
  /** The heading the open page is narrowed to, in a paged section; null shows the whole section. */
  const [pageGroup, setPageGroup] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // A heading is kept by its words, so a page open on one starts over when the language changes under it.
  useEffect(() => setPageGroup(null), [language]);
  const [editing, setEditing] = useState<string | null>(null);
  /** The setting whose list is open in the right pane, and the highlighted option. */
  const [picking, setPicking] = useState<{ key: string; index: number } | null>(null);
  /** The list setting whose editor fills the right pane. */
  const [listOpen, setListOpen] = useState<string | null>(null);
  /** Which profile (and model) the list editor has open, and the heading it is narrowed to; the sidebar shows and changes both. */
  const [editorScreen, setEditorScreen] = useState<EditorScreen>({ profile: null, model: null });
  const [editorHeading, setEditorHeading] = useState<string | null>(null);
  /** The MCP access setting whose checklist fills the right pane. */
  const [accessOpen, setAccessOpen] = useState<string | null>(null);
  /** The per-model hand-off setting whose editor fills the right pane. */
  const [handoffOpen, setHandoffOpen] = useState<string | null>(null);

  const sections = useMemo(
    () => SETTING_SECTIONS.filter((section) => snapshot?.settings.some((view) => view.descriptor.section === section && view.descriptor.hidden !== true) === true),
    [snapshot],
  );
  const items = useMemo<readonly SettingItem[]>(() => {
    if (!snapshot) return [];
    const valueOf = (key: string): string => {
      const view = snapshot.settings.find((entry) => entry.descriptor.key === key);
      return view?.value === undefined ? "" : String(view.value);
    };
    return snapshot.settings
      .filter((view) => view.descriptor.section === tab && view.descriptor.hidden !== true && (pageGroup === null || view.descriptor.group === pageGroup))
      .filter((view) => view.descriptor.visibleWhen === undefined || view.descriptor.visibleWhen.in.includes(valueOf(view.descriptor.visibleWhen.key)))
      .map((view) => ({
        descriptor: view.descriptor,
        value: view.value,
        explicit: view.explicit,
        control: settingControl(view.descriptor, view.value, snapshot.settings, providers),
        ...(view.items ? { entries: view.items } : {}),
        ...(view.unavailable ? { unavailable: view.unavailable } : {}),
        ...(view.inForce ? { inForce: view.inForce } : {}),
      }));
  }, [snapshot, tab, pageGroup, providers]);

  /** The provider the open tab is about, when it can be updated from here. */
  const updatable = updatableProviderOf(tab);

  const safe = items.length === 0 ? -1 : Math.min(index, items.length - 1);
  const current = safe >= 0 ? items[safe] : undefined;
  const pickItem = picking === null ? undefined : items.find((item) => item.descriptor.key === picking.key);
  const pickControl = pickItem?.control.kind === "pick" ? pickItem.control : undefined;
  const [query, setQuery] = useState("");
  /** A slider needs room for every label; narrower than that the choices are a list. */
  const sliding = pickControl !== undefined && slidesIn(pickControl, paneWidth - 2);
  const resetOption = sliding ? pickControl.options.find((entry) => entry.value === "") : undefined;
  const pickOptions = useMemo(() => {
    const all = sliding ? (pickControl?.options ?? []).filter((entry) => entry.value !== "") : (pickControl?.options ?? []);
    const needle = query.trim().toLowerCase();
    if (!pickControl?.searchable || needle === "") return all;
    return all.filter((entry) => `${entry.label} ${entry.value} ${entry.group ?? ""} ${entry.description ?? ""}`.toLowerCase().includes(needle));
  }, [pickControl, query, sliding]);
  /** A list whose rows carry a tag lines the tag and the detail up in columns. */
  const columns = pickOptions.some((entry) => entry.badge !== undefined)
    ? { badge: Math.max(...pickOptions.map((entry) => entry.badge?.length ?? 0)), detail: Math.max(...pickOptions.map((entry) => entry.description?.length ?? 0)) }
    : undefined;

  // Leaving a row abandons an edit in progress rather than carrying the
  // half-typed text onto the next setting.
  useEffect(() => setEditing(null), [safe, tab]);

  const listView = (key: string) => snapshot?.settings.find((entry) => entry.descriptor.key === key);
  /** One entry's headings, as the editor narrows to them. */
  const headingsOf = (listKey: string, entryId: string): string[] => {
    const view = listView(listKey);
    const item = view?.items?.find((entry) => entry.id === entryId);
    if (view === undefined || item === undefined || view.descriptor.kind.type !== "list") return [];
    return itemRows(view.descriptor.kind.fields, item).flatMap((row) => (row.kind === "heading" ? [row.label] : []));
  };
  /** A model's headings inside an entry (a profile's model), when the editor has one open. */
  const modelHeadingsOf = (listKey: string, entryId: string, modelId: string): string[] => {
    const view = listView(listKey);
    const item = view?.items?.find((entry) => entry.id === entryId);
    if (view === undefined || item === undefined || view.descriptor.kind.type !== "list") return [];
    const fields = view.descriptor.kind.fields.find((field) => field.path === "models")?.kind;
    const model = item.fields.find((field) => field.path === "models")?.items?.find((entry) => entry.id === modelId);
    if (fields?.type !== "list" || model === undefined) return [];
    return itemRows(fields.fields, model).flatMap((row) => (row.kind === "heading" ? [row.label] : []));
  };
  /** The headings the sidebar lists under an open entry: its model's while one is open, else its own. */
  const openHeadings = (listKey: string, entryId: string): string[] =>
    editorScreen.model !== null ? modelHeadingsOf(listKey, entryId, editorScreen.model) : headingsOf(listKey, entryId);
  /** The heading an entry opens on: the one asked for, else its first. There is no view of everything at once. */
  const shownHeading = (listKey: string, entryId: string, wanted: string | null): string | null => {
    const headings = headingsOf(listKey, entryId);
    return wanted !== null && headings.includes(wanted) ? wanted : (headings[0] ?? null);
  };
  /** The nested list open in the editor with one of its entries open, which narrows the sidebar to that list. */
  const focusedList = listOpen !== null && NESTED_LISTS.includes(listOpen) && editorScreen.profile !== null ? listOpen : null;
  /** A page that holds nothing but one list is not shown: the list is. */
  const onlyList = (section: SettingSection, group: string | null): string | null => {
    const shown = (snapshot?.settings ?? []).filter((view) => view.descriptor.section === section && view.descriptor.hidden !== true && (group === null || view.descriptor.group === group));
    return shown.length === 1 && shown[0]!.descriptor.kind.type === "list" ? shown[0]!.descriptor.key : null;
  };

  /** The sidebar top to bottom: each section, under a paged one its headings, and under a list's heading its entries. */
  const entries = useMemo<readonly SidebarEntry[]>(() => {
    const out: SidebarEntry[] = [];
    const nested = NESTED_LISTS.flatMap((key) => {
      const view = listView(key);
      return view === undefined ? [] : [{ key, section: view.descriptor.section, group: view.descriptor.group ?? null, items: view.items ?? [] }];
    });
    const focus = nested.find((list) => list.key === focusedList);
    if (focus !== undefined) {
      // Inside an entry only what leads to it stays: the list, its siblings and its own headings.
      out.push({ section: focus.section, group: focus.group, label: `← ${focus.group ?? tx(SECTION_LABEL[focus.section])}`, prefix: "", back: true });
      focus.items.forEach((item, at) => {
        const last = at === focus.items.length - 1;
        out.push({ section: focus.section, group: focus.group, label: item.title, prefix: last ? "└ " : "├ ", profile: item.id, list: focus.key });
        if (item.id !== editorScreen.profile) return;
        const headings = openHeadings(focus.key, item.id);
        if (headings.length < 2) return;
        headings.forEach((heading, index) => {
          out.push({ section: focus.section, group: focus.group, label: heading, prefix: `${last ? "  " : "│ "}${index === headings.length - 1 ? "└ " : "├ "}`, profile: item.id, list: focus.key, heading, ...(editorScreen.model === null ? {} : { model: editorScreen.model }) });
        });
      });
      return out;
    }
    const pushEntries = (list: (typeof nested)[number], indent: string) =>
      list.items.forEach((item, at) => out.push({ section: list.section, group: list.group, label: item.title, prefix: `${indent}${at === list.items.length - 1 ? "└ " : "├ "}`, profile: item.id, list: list.key }));
    for (const section of sections) {
      // A paged section is a category of its own: its pages sit directly under the category heading, with no row for the section.
      if (!PAGED_SECTIONS.has(section)) out.push({ section, group: null, label: tx(SECTION_LABEL[section]), prefix: "" });
      if (!snapshot) continue;
      if (!PAGED_SECTIONS.has(section)) {
        for (const list of nested) if (list.section === section && list.group === null) pushEntries(list, "");
        continue;
      }
      const seen: string[] = [];
      // Until a model server is added the Moxen Harness has nothing to configure but where its models come from.
      const serverList = section === "provider:harness" ? nested.find((list) => list.section === section) : undefined;
      const bare = serverList !== undefined && serverList.items.length === 0;
      for (const setting of snapshot.settings) {
        const group = setting.descriptor.group;
        if (setting.descriptor.section !== section || setting.descriptor.hidden === true || group === undefined || seen.includes(group)) continue;
        if (bare && group !== serverList.group) continue;
        seen.push(group);
      }
      seen.forEach((group, index) => {
        out.push({ section, group, label: group, prefix: "" });
        for (const list of nested) if (list.section === section && list.group === group) pushEntries(list, "");
      });
    }
    return out;
  }, [sections, snapshot, focusedList, editorScreen.profile, editorScreen.model]);

  /** Open an entry of a nested list in its editor, on one of its headings (the first when none is asked for). */
  const openEntry = (listKey: string, entryId: string, heading: string | null) => {
    const view = listView(listKey);
    if (view === undefined) return;
    setTab(view.descriptor.section);
    setPageGroup(view.descriptor.group ?? null);
    setPicking(null);
    setAccessOpen(null);
    setHandoffOpen(null);
    setListOpen(listKey);
    setEditorScreen({ profile: entryId, model: null });
    setEditorHeading(shownHeading(listKey, entryId, heading));
  };
  const selectEntry = (entry: SidebarEntry) => {
    if (entry.back === true) {
      setEditorScreen({ profile: null, model: null });
      setEditorHeading(null);
    } else if (entry.model !== undefined && entry.heading !== undefined) setEditorHeading(entry.heading);
    else if (entry.profile !== undefined && entry.list !== undefined) openEntry(entry.list, entry.profile, entry.heading ?? null);
    else switchTab(entry.section, entry.group);
  };
  const entryActive = (entry: SidebarEntry): boolean => {
    if (entry.back === true) return false;
    if (focusedList !== null) {
      if (entry.profile !== editorScreen.profile) return false;
      // Where you are is the heading shown, or the entry itself when it has too few headings to list.
      const headings = entry.list === undefined || entry.profile === undefined ? [] : openHeadings(entry.list, entry.profile);
      const shown = headings.includes(editorHeading ?? "") ? editorHeading : (headings[0] ?? null);
      return headings.length < 2 ? entry.heading === undefined : entry.heading === shown;
    }
    if (PAGED_SECTIONS.has(entry.section) && entry.group === null) return false;
    return entry.profile === undefined && entry.section === tab && entry.group === pageGroup;
  };

  const switchTab = (next: SettingSection, group: string | null = null) => {
    setTab(next);
    setPageGroup(group);
    setIndex(0);
    setPicking(null);
    setAccessOpen(null);
    setHandoffOpen(null);
    setEditorScreen({ profile: null, model: null });
    setEditorHeading(null);
    // A page that is only a list opens on the list.
    setListOpen(onlyList(next, group));
  };
  const stepTab = (delta: number) => {
    // Entries and their headings are reached by click or from the list; stepping goes page to page.
    const pages = entries.filter((entry) => entry.profile === undefined && entry.back !== true && !(PAGED_SECTIONS.has(entry.section) && entry.group === null));
    if (pages.length === 0) return;
    const at = Math.max(0, pages.findIndex((entry) => entry.section === tab && entry.group === pageGroup));
    const next = pages[(at + delta + pages.length) % pages.length]!;
    switchTab(next.section, next.group);
  };

  const activate = (item: SettingItem) => {
    if (item.unavailable !== undefined) return;
    if (item.control.kind === "list") {
      setListOpen(item.descriptor.key);
      return;
    }
    if (item.control.kind === "servers" || item.control.kind === "tools" || item.control.kind === "order") {
      setAccessOpen(item.descriptor.key);
      return;
    }
    if (item.control.kind === "handoff") {
      setHandoffOpen(item.descriptor.key);
      return;
    }
    if (item.control.kind === "toggle") {
      onSet(item.descriptor.key, nextToggleValue(item.control, item.value));
      return;
    }
    if (item.control.kind === "text" || item.control.kind === "secret") {
      setEditing(item.descriptor.key);
      return;
    }
    const currentValue = item.value === undefined ? "" : String(item.value);
    if (item.control.kind !== "pick") return;
    setQuery("");
    if (slidesIn(item.control, paneWidth - 2)) {
      const stops = item.control.options.filter((entry) => entry.value !== "");
      // Unset starts on what applies by default, so the slider opens on what the thread would use.
      const at = stops.findIndex((entry) => entry.value === currentValue);
      setPicking({ key: item.descriptor.key, index: Math.max(0, at >= 0 ? at : stops.findIndex((entry) => entry.isDefault === true)) });
      return;
    }
    setPicking({ key: item.descriptor.key, index: Math.max(0, item.control.options.findIndex((entry) => entry.value === currentValue)) });
  };
  const choose = (key: string, value: string) => {
    setPicking(null);
    setQuery("");
    onSet(key, value);
    // A new provider or model may not take what is saved beside it: unset that rather than keep a value it refuses.
    if (providers === null) return;
    const saved = (name: string) => {
      const found = snapshot?.settings.find((view) => view.descriptor.key === name)?.value;
      return typeof found === "string" && found !== "" ? found : undefined;
    };
    const modelsOf = (instance: string | undefined, kind: string | undefined) =>
      providers.filter((provider) => (instance !== undefined ? provider.instanceId === instance : kind === undefined || driverKindOfInstance(provider.instanceId) === kind)).flatMap((provider) => provider.models);
    const takesEffort = (models: readonly (typeof providers)[number]["models"][number][], effort: string) =>
      models.some((model) => model.efforts.some((descriptor) => descriptor.choices.some((entry) => entry.id === effort)));
    if (key === "provider") {
      // The global model and effort follow the default provider; an empty choice leaves every provider in play.
      const model = saved("model");
      const pool = modelsOf(value === "" ? undefined : value, undefined);
      if (model !== undefined && value !== "" && !pool.some((entry) => entry.slug === model)) onSet("model", "");
      const effort = saved("thinkingEffort");
      const kept = model === undefined ? pool : pool.filter((entry) => entry.slug === model);
      if (effort !== undefined && value !== "" && !takesEffort(kept, effort)) onSet("thinkingEffort", "");
      return;
    }
    const modelKey = /^(providers\.[a-z]+\.)?model$/.exec(key);
    if (modelKey === null || value === "") return;
    const effortKey = `${modelKey[1] ?? ""}thinkingEffort`;
    const effort = saved(effortKey);
    const kind = modelKey[1]?.split(".")[1];
    if (effort !== undefined && !takesEffort(modelsOf(undefined, kind).filter((entry) => entry.slug === value), effort)) onSet(effortKey, "");
  };

  const listItem = listOpen === null ? undefined : items.find((item) => item.descriptor.key === listOpen);
  const accessItem = accessOpen === null ? undefined : items.find((item) => item.descriptor.key === accessOpen);
  const handoffItem = handoffOpen === null ? undefined : items.find((item) => item.descriptor.key === handoffOpen);

  useKeyboard((key) => {
    // The list editor owns every key while it is open, and one it has already acted on is not ours.
    if (listOpen !== null || accessOpen !== null || handoffOpen !== null || key.defaultPrevented) return;
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    if (editing !== null) {
      // The input owns its own keys; only escape is taken back, so a
      // half-typed value can be abandoned without closing the page.
      if (escape) setEditing(null);
      return;
    }
    if (picking !== null) {
      const row = sliding;
      const searching = pickControl?.searchable === true;
      const last = Math.max(0, pickOptions.length - 1);
      const step = (delta: number) => setPicking({ ...picking, index: Math.max(0, Math.min(picking.index + delta, last)) });
      if (escape) {
        if (searching && query !== "") setQuery("");
        else setPicking(null);
      } else if (sliding && resetOption !== undefined && (key.name === "d" || key.name === "backspace" || key.name === "delete")) choose(picking.key, "");
      else if (sliding && (key.name === "home" || key.name === "end")) setPicking({ ...picking, index: key.name === "home" ? 0 : last }); else if (key.name === "left" && !row) {
        if (!searching || query === "") setPicking(null);
      } else if (key.name === "left" || key.name === "up" || (!searching && key.name === "k" && !key.ctrl)) step(-1);
      else if (key.name === "right" && !row) return;
      else if (key.name === "right" || key.name === "down" || (!searching && key.name === "j" && !key.ctrl)) step(1);
      else if (enter || (key.name === "space" && !searching)) {
        const option = pickOptions[picking.index];
        if (option !== undefined) choose(picking.key, option.value);
      } else if (searching && (key.name === "backspace" || key.name === "delete")) {
        setQuery((text) => text.slice(0, -1));
        setPicking({ ...picking, index: 0 });
      } else if (searching && !key.ctrl && !key.meta && key.sequence !== undefined && key.sequence.length === 1 && key.sequence >= " ") {
        setQuery((text) => text + key.sequence);
        setPicking({ ...picking, index: 0 });
      }
      return;
    }
    if (escape) {
      markModalDismissed();
      onClose();
      return;
    }
    if (key.name === "u" && !key.ctrl && !key.meta && updatable !== null) {
      onUpdate(updatable);
      return;
    }
    if (key.name === "tab") {
      stepTab(key.shift ? -1 : 1);
      return;
    }
    if (key.name === "left" || key.name === "right") {
      stepTab(key.name === "left" ? -1 : 1);
      return;
    }
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) {
      setIndex((at) => Math.min(at + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) {
      setIndex((at) => Math.max(at - 1, 0));
      return;
    }
    if ((enter || key.name === "space") && current !== undefined) activate(current);
  });

  // Keep the selected setting (or option) in view. Cards wrap their
  // descriptions, so their heights are the layout's to know, not ours.
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollTarget = picking !== null ? `settings-option-${picking.index}` : current === undefined ? null : editing !== null ? `settings-edit-${editing}` : `settings-row-${current.descriptor.key}`;
  useEffect(() => {
    if (scrollTarget === null) return;
    // An opening editor changes the card's height after this render, so it gets a moment to lay out.
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(scrollTarget), scrollTarget.startsWith("settings-edit-") ? 120 : 0);
    return () => clearTimeout(timer);
  }, [scrollTarget]);
  // Keep the sidebar's active entry in view (tab steps through it, and an opened list nests more entries under it).
  const sideRef = useRef<ScrollBoxRenderable | null>(null);
  const sideActive = entries.findIndex((entry) => entryActive(entry));
  useEffect(() => {
    if (sideActive < 0) return;
    const timer = setTimeout(() => sideRef.current?.scrollChildIntoView(`settings-side-${sideActive}`), 0);
    return () => clearTimeout(timer);
  }, [sideActive, entries.length]);
  // Coming back from a list editor shows the page again in a new scroll box, still at the top: scroll to the row we left from.
  const showingPage = listOpen === null && handoffOpen === null;
  useEffect(() => {
    if (!showingPage || scrollTarget === null) return;
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(scrollTarget), 40);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingPage]);


  const base =
    picking !== null
      ? sliding
        ? t("settings.hint.slide", { reset: resetOption === undefined ? "" : t("settings.hint.reset") })
        : pickControl?.searchable === true
          ? t("settings.hint.filter")
          : t("settings.hint.choose")
      : current?.control.kind === "text" || current?.control.kind === "secret"
        ? t("settings.hint.edit")
        : current?.control.kind === "toggle"
          ? t("settings.hint.toggle")
          : t("settings.hint.open");
  const hint = listOpen !== null || handoffOpen !== null ? "" : picking === null && updatable !== null ? t("settings.hint.update", { hint: base }) : base;

  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("settings.title")}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"esc"}</text>
      </box>
      {snapshot === null ? (
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <text fg={COLOR.dim} bg={SURFACE.raised}>{loading ? t("settings.reading") : (error ?? t("settings.none"))}</text>
        </box>
      ) : (
        <>
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <text fg={COLOR.faint} bg={SURFACE.raised}>
              {truncate(snapshot.exists ? snapshot.path : t("settings.notCreated", { path: snapshot.path }), inner)}
            </text>
          </box>
          <box style={{ flexDirection: "row", flexGrow: 1, marginTop: 1 }}>
            {/* Taller than the window once the Harness and MCP servers nest their entries: it scrolls, so it never runs over the hint. */}
            <scrollbox
              ref={sideRef}
              style={{ width: TAB_WIDTH, flexShrink: 0 }}
              stickyStart="top"
              backgroundColor={SURFACE.raised}
              verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}
            >
              {entries.map((entry, at) => {
                // A category heads its first section; inside an open entry the sidebar is only the way back, so none shows.
                const category = SECTION_CATEGORY[entry.section];
                const top = entry.prefix === "" && entry.profile === undefined && entry.back !== true;
                const before = entries.slice(0, at).findLast((candidate) => candidate.prefix === "" && candidate.profile === undefined);
                const heads = top && focusedList === null && (before === undefined || SECTION_CATEGORY[before.section] !== category);
                return (
                  <Fragment key={`${entry.section}#${entry.group ?? ""}#${entry.profile ?? ""}#${entry.heading ?? ""}${entry.back === true ? "#back" : ""}`}>
                    {heads ? <CategoryHeading label={tx(category)} first={at === 0} width={TAB_WIDTH} /> : null}
                    <SectionTab
                      id={`settings-side-${at}`}
                      label={entry.label}
                      prefix={entry.prefix}
                      active={entryActive(entry)}
                      width={TAB_WIDTH}
                      onSelect={() => selectEntry(entry)}
                    />
                  </Fragment>
                );
              })}
            </scrollbox>
            <box
              style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2 }}
              border={["left"]}
              borderColor={SURFACE.border}
              backgroundColor={SURFACE.raised}
            >
              {handoffItem !== undefined && handoffItem.control.kind === "handoff" ? (
                <HandoffModelsEditor
                  title={handoffItem.descriptor.label}
                  description={handoffItem.descriptor.description}
                  compaction={handoffItem.control.compaction}
                  models={handoffItem.control.models}
                  width={paneWidth}
                  catalogReady={providers !== null}
                  onChange={(field, slug, next) => {
                    // Each field has its own key beside the row's (`providers.<kind>.compactAtModels`, …).
                    const key = `${handoffItem.descriptor.key.slice(0, handoffItem.descriptor.key.lastIndexOf(".") + 1)}${MODEL_OVERRIDE_KEY[field]}`;
                    const current = snapshot.settings.find((view) => view.descriptor.key === key)?.value;
                    void onSet(key, withModelOverride(field, current, slug, next));
                  }}
                  onExit={() => setHandoffOpen(null)}
                />
              ) : accessItem !== undefined && accessItem.control.kind === "order" ? (
                <WebOrderEditor
                  title={accessItem.descriptor.label}
                  description={accessItem.descriptor.description}
                  rows={accessItem.control.rows}
                  width={paneWidth}
                  onChange={(order) => onSet(accessItem.descriptor.key, order)}
                  onExit={() => setAccessOpen(null)}
                />
              ) : accessItem !== undefined && (accessItem.control.kind === "servers" || accessItem.control.kind === "tools") ? (
                <McpAccessEditor
                  title={accessItem.descriptor.label}
                  description={accessItem.descriptor.description}
                  noun={accessItem.control.kind}
                  servers={accessItem.control.kind === "tools" ? accessItem.control.tools : accessItem.control.servers}
                  excluded={accessItem.control.excluded}
                  width={paneWidth}
                  onChange={(excluded) => onSet(accessItem.descriptor.key, excluded)}
                  onExit={() => setAccessOpen(null)}
                />
              ) : listItem !== undefined && listOpen !== null ? (
                <ListEditor
                  // Its overlay, cursor and confirm belong to one list: another list gets a fresh editor, not the last one's half-open picker.
                  key={listItem.descriptor.key}
                  descriptor={listItem.descriptor}
                  items={listItem.entries ?? []}
                  screen={editorScreen}
                  onScreen={setEditorScreen}
                  heading={editorHeading}
                  onHeading={setEditorHeading}
                  saving={saving}
                  onSet={onSet}
                  onDuplicate={(id, newId) => onDuplicate(listItem.descriptor.key, id, newId)}
                  run={run}
                  onTest={(id, model) => (listItem.descriptor.key === "mcpServers" ? onTestMcp(id) : onTest(id, model))}
                  onProbe={onProbe}
                  onDiscover={onDiscover}
                  onExport={onExport}
                  onImport={onImport}
                  notice={notice}
                  width={paneWidth}
                  canLeave={onlyList(tab, pageGroup) !== listOpen}
                  mcpRunner={mcpRunnerOf(snapshot?.settings)}
                  onExit={(viaEscape) => {
                    // A list that is its page's only content has no page to fall back to: esc closes, going back does nothing.
                    if (onlyList(tab, pageGroup) === listOpen) {
                      if (viaEscape) {
                        markModalDismissed();
                        onClose();
                      }
                      return;
                    }
                    setListOpen(null);
                    setEditorScreen({ profile: null, model: null });
                    setEditorHeading(null);
                  }}
                />
              ) : pickItem !== undefined && picking !== null ? (
                <>
                  <BackButton onBack={() => setPicking(null)} />
                  <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }}>
                    <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{pickItem.descriptor.label}</text>
                    <text content={prose(pickItem.descriptor.description, COLOR.dim)} bg={SURFACE.raised} wrapMode="word" />
                  </box>
                  <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
                    {pickOptions.length <= 1 && pickItem.descriptor.kind.type === "string" && providers === null ? (
                      <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.loadingCatalog")}</text>
                    ) : null}
                    {pickControl?.searchable === true ? (
                      <SearchField query={query} width={paneWidth} hint={pickItem.descriptor.kind.type === "string" && pickItem.descriptor.kind.source !== undefined ? t("settings.search") : t("settings.searchGeneric")} />
                    ) : null}
                    {sliding ? (
                      <>
                        <Slider
                          idPrefix="settings-option"
                          stops={pickOptions.map((entry) => entry.short ?? entry.label)}
                          active={picking.index}
                          chosen={pickOptions.findIndex((entry) => entry.value === (pickItem.value === undefined ? "" : String(pickItem.value)))}
                          width={paneWidth - 2}
                          {...(pickControl?.ends === undefined ? {} : { ends: pickControl.ends })}
                          {...(pickControl?.scale === "effort" ? { tones: effortTones(pickOptions.map((entry) => entry.value)) } : {})}
                          caption={pickOptions[picking.index]?.description}
                          onMove={(at) => setPicking({ ...picking, index: at })}
                          onPick={(at) => choose(pickItem.descriptor.key, pickOptions[at]!.value)}
                        />
                        {resetOption === undefined ? null : (
                          <SliderDefault
                            id="settings-option-reset"
                            unset={pickItem.value === undefined || pickItem.value === ""}
                            defaultLabel={pickOptions.find((entry) => entry.isDefault === true)?.label}
                            onReset={() => choose(pickItem.descriptor.key, "")}
                          />
                        )}
                      </>
                    ) : (
                      pickOptions.map((option, optionIndex) => (
                        <Fragment key={`${option.value}:${optionIndex}`}>
                          {option.group !== undefined && option.group !== pickOptions[optionIndex - 1]?.group ? <GroupHeading label={option.group} width={paneWidth} /> : null}
                          <OptionRow
                            id={`settings-option-${optionIndex}`}
                            label={option.label}
                            description={option.description}
                            badge={option.badge}
                            columns={columns}
                            chosen={option.value === (pickItem.value === undefined ? "" : String(pickItem.value))}
                            active={optionIndex === picking.index}
                            width={paneWidth}
                            onPick={() => choose(pickItem.descriptor.key, option.value)}
                          />
                        </Fragment>
                      ))
                    )}
                    {sliding ? null : <FullDescription option={pickOptions[picking.index]} width={paneWidth} />}
                    {pickControl?.searchable === true && pickOptions.length === 0 ? (
                      <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.nothingMatches")}</text>
                    ) : null}
                  </scrollbox>
                </>
              ) : (
                <>
                  {updatable === null ? null : (
                    <ProviderUpdateCard
                      provider={updatable}
                      check={versions?.[updatable]}
                      latest={latest === null ? undefined : { enabled: latest.enabled, latest: null, channel: null, ...latest[updatable] }}
                      updating={updating.has(updatable)}
                      width={paneWidth}
                      onUpdate={() => onUpdate(updatable)}
                    />
                  )}
                <scrollbox ref={scrollRef} style={{ flexGrow: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
                  {items.map((item, itemIndex) => {
                    const group = item.descriptor.group;
                    const startsGroup = group !== undefined && group !== items[itemIndex - 1]?.descriptor.group;
                    return (
                    <Fragment key={item.descriptor.key}>
                    {startsGroup ? (
                      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: itemIndex === 0 ? 0 : 2, paddingLeft: 1 }} backgroundColor={SURFACE.raised}>
                        <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{`${truncate(group ?? "", paneWidth - 4)} `}</text>
                        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"─".repeat(Math.max(0, paneWidth - (group ?? "").length - 4))}</text>
                      </box>
                    ) : null}
                    <SettingCard
                      item={item}
                      first={itemIndex === 0 || startsGroup}
                      active={itemIndex === safe}
                      editing={editing === item.descriptor.key}
                      pending={saving === item.descriptor.key}
                      width={paneWidth}
                      onGrow={() => scrollRef.current?.scrollChildIntoView(`settings-edit-${item.descriptor.key}`)}
                      onActivate={() => {
                        setIndex(itemIndex);
                        activate(item);
                      }}
                      onSubmit={(text) => {
                        setEditing(null);
                        onSet(item.descriptor.key, text);
                      }}
                    />
                    </Fragment>
                    );
                  })}
                </scrollbox>
                </>
              )}
            </box>
          </box>
          <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
            {error === null ? null : (
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={COLOR.danger} bg={SURFACE.raised}>{truncate(error, inner)}</text>
              </box>
            )}
            <box style={{ flexDirection: "row", height: 1 }}>
              <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(hint, inner)}</text>
            </box>
          </box>
        </>
      )}
    </ModalShell>
  );
}

/** Prose whose `backticked` parts read as code: a colour of their own, and no backticks printed. */
function prose(text: string, base: string): StyledText {
  return new StyledText(splitInlineCode(text).map((segment) => fg(segment.code ? COLOR.command : base)(segment.text)));
}

/** Back out of a setting's choices to the list: the click twin of esc and the left arrow. */
function BackButton({ onBack }: { onBack: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} onMouseDown={onBack} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("ui.back")}</text>
    </box>
  );
}

const PROVIDER_NAME: Record<UpdatableProvider, string> = { claude: "Claude Code", opencode: "OpenCode", codex: "Codex" };
const PROVIDER_UPDATER: Record<UpdatableProvider, string> = { claude: "claude update", opencode: "opencode upgrade", codex: "codex update" };

/**
 * Where a provider's install stands, and the button that runs its own updater
 * (`claude update`, `opencode upgrade`): the version, whether it meets what
 * Moxen needs, and what pressing it does. Sessions already running are never
 * restarted; the result lands in a toast.
 */
function ProviderUpdateCard({
  provider,
  check,
  latest,
  updating,
  width,
  onUpdate,
}: {
  provider: UpdatableProvider;
  check: ProviderCheckView | undefined;
  latest: LatestView | undefined;
  updating: boolean;
  width: number;
  onUpdate: () => void;
}) {
  const { hovered, handlers } = useHover();
  const line = providerVersionLine(check, latest);
  const tone = line.tone === "warn" ? COLOR.warn : line.tone === "update" ? COLOR.accent : line.tone === "ok" ? COLOR.added : COLOR.dim;
  const button = updating ? t("settings.update.updating") : line.button;
  // Nothing newer to go to: the button says so and steps back, though pressing it still runs the updater.
  const buttonColor = updating || line.settled ? COLOR.dim : hovered ? COLOR.bright : COLOR.accent;
  return (
    <box
      style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, width }}
      backgroundColor={SURFACE.panel}
      selectable={false}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.panel}>
        <box style={{ flexDirection: "row" }} backgroundColor={SURFACE.panel}>
          <text fg={COLOR.bright} bg={SURFACE.panel} selectable={false}>{PROVIDER_NAME[provider]}</text>
          <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{`  ${line.version ?? "—"}`}</text>
        </box>
        <box {...(updating ? {} : { onMouseDown: onUpdate, ...handlers })} backgroundColor={SURFACE.panel}>
          <text fg={buttonColor} bg={SURFACE.panel} selectable={false}>{button}</text>
        </box>
      </box>
      <text fg={tone} bg={SURFACE.panel} wrapMode="word" selectable={false}>{line.status}</text>
      <text content={prose(t("settings.update.note", { command: PROVIDER_UPDATER[provider] }), COLOR.dim)} bg={SURFACE.panel} wrapMode="word" selectable={false} />
    </box>
  );
}

/** A category of the sidebar: a small bold label over its sections, spaced from the category above. */
function CategoryHeading({ label, first, width }: { label: string; first: boolean; width: number }) {
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: first ? 0 : 1, marginBottom: 0, paddingLeft: 2 }} backgroundColor={SURFACE.raised} selectable={false}>
      <text fg={COLOR.faint} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{truncate(label.toUpperCase(), width - 3)}</text>
    </box>
  );
}

function SectionTab({ id, label, prefix, active, width, onSelect }: { id: string; label: string; prefix: string; active: boolean; width: number; onSelect: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, marginRight: 1 }} backgroundColor={bg} onMouseDown={onSelect} selectable={false} {...handlers}>
      <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>{active ? "▌ " : "  "}</text>
      {prefix === "" ? null : <text fg={COLOR.faint} bg={bg} selectable={false}>{prefix}</text>}
      <text fg={active ? COLOR.bright : hovered ? COLOR.text : COLOR.dim} bg={bg} selectable={false}>{truncate(label, width - 4 - prefix.length)}</text>
    </box>
  );
}

/** The value side of a card: a switch, a list to open, or text to edit. */
function valueText(item: SettingItem): string {
  const label = settingValueLabel(item.descriptor, item.value, item.control, item.entries?.length);
  if (item.control.kind === "list") return `${label}  ›`;
  if (item.control.kind === "toggle") return item.value === true ? `● ${t("settings.on")}` : item.value === undefined && item.control.tristate === true ? `◌ ${label}` : `○ ${t("settings.off")}`;
  if (item.control.kind === "pick" || item.control.kind === "handoff" || item.control.kind === "order") return `${label}  ›`;
  return label;
}

function SettingCard({
  item,
  first,
  active,
  editing,
  pending,
  width,
  onActivate,
  onGrow,
  onSubmit,
}: {
  item: SettingItem;
  /** The top card sits flush with the first tab beside it; the others are spaced from the one above. */
  first: boolean;
  active: boolean;
  editing: boolean;
  pending: boolean;
  width: number;
  onActivate: () => void;
  onGrow: () => void;
  onSubmit: (text: string) => void;
}) {
  const { hovered, handlers } = useHover();
  const { descriptor, value, explicit } = item;
  const secret = descriptor.kind.type === "secret";
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  // The label keeps its room and two spaces before the value; a value too long for the rest (a long Default) is the one shortened.
  const room = width - 4;
  const fullValue = `${pending ? "· " : ""}${valueText(item)}`;
  const shown = truncate(fullValue, Math.max(12, room - descriptor.label.length - 2));
  // When a change applies sits beside the label if both fit, else on a line of its own, so the label is never cut for it.
  const tag = descriptor.appliesAt === undefined || descriptor.appliesAt === "now" ? "" : `  ${tx(APPLIES_AT_TEXT[descriptor.appliesAt].tag)}`;
  const inline = tag !== "" && descriptor.label.length + tag.length <= room - shown.length - 2;
  const note = inline ? tag : "";
  const labelWidth = Math.max(8, room - shown.length - note.length - 2);
  const valueColor = item.unavailable !== undefined
    ? COLOR.faint
    : pending
    ? COLOR.faint
    : item.control.kind === "toggle"
      ? value === true
        ? COLOR.added
        : value === undefined && item.control.tristate === true
          ? COLOR.text
          : COLOR.dim
      : explicit
        ? COLOR.accent
        : COLOR.text;

  return (
    <box
      id={`settings-row-${descriptor.key}`}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: first ? 0 : 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      {...(editing ? {} : { onMouseDown: onActivate })}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 1 }} backgroundColor={bg}>
          <text fg={item.unavailable !== undefined ? COLOR.faint : active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(descriptor.label, labelWidth)}</text>
          {note === "" ? null : <text fg={COLOR.faint} bg={bg} selectable={false}>{note}</text>}
        </box>
        {editing ? null : <text fg={valueColor} bg={bg} style={{ marginLeft: 2, flexShrink: 0 }} selectable={false}>{shown}</text>}
      </box>
      {editing ? (
        <TextField
          id={`settings-edit-${descriptor.key}`}
          initial={secret || value === undefined ? "" : String(value)}
          placeholder={secret ? t("le.pasteKey") : descriptor.kind.type === "string" ? (descriptor.kind.placeholder ?? "") : ""}
          multiline={descriptor.kind.type === "string" && descriptor.kind.multiline === true}
          secret={secret}
          fallback={secret ? t("le.removesKey") : descriptor.defaultValue === undefined || descriptor.defaultValue === "" ? t("le.unset") : t("le.theDefaultValue", { value: String(descriptor.defaultValue) })}
          width={width}
          onGrow={onGrow}
          onSubmit={onSubmit}
        />
      ) : null}
      <text content={prose(descriptor.description, item.unavailable !== undefined ? COLOR.faint : COLOR.dim)} bg={bg} wrapMode="word" selectable={false} />
      {tag !== "" && !inline ? <text fg={COLOR.faint} bg={bg} selectable={false}>{t("settings.applies", { when: tag.trim() })}</text> : null}
      {item.inForce !== undefined ? <text fg={COLOR.dim} bg={bg} wrapMode="word" selectable={false}>{item.inForce}</text> : null}
      {item.unavailable !== undefined ? <text fg={COLOR.warn} bg={bg} wrapMode="word" selectable={false}>{item.unavailable}</text> : null}
      {item.unavailable === undefined && (item.control.kind === "pick" || item.control.kind === "order") && item.control.warning !== undefined ? <text fg={COLOR.warn} bg={bg} wrapMode="word" selectable={false}>{item.control.warning}</text> : null}
    </box>
  );
}

/** The choices fit along a slider of this width (and are the kind a slider is for). */
function slidesIn(control: Extract<SettingControl, { kind: "pick" }>, width: number): boolean {
  if (control.layout !== "slider") return false;
  return sliderLayout(control.options.filter((entry) => entry.value !== "").map((entry) => entry.short ?? entry.label), width).fits;
}

function OptionRow({
  id,
  label,
  description,
  badge,
  columns,
  chosen,
  active,
  width,
  onPick,
}: {
  id: string;
  label: string;
  description: string | undefined;
  badge?: string | undefined;
  /** Widths of the badge and detail columns, when the whole list lines them up. */
  columns?: { readonly badge: number; readonly detail: number } | undefined;
  chosen: boolean;
  active: boolean;
  width: number;
  onPick: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const room = Math.max(0, width - label.length - 8 - (badge === undefined ? 0 : badge.length + 2));
  const detail = description === undefined ? "" : truncate(description, room);
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPick} selectable={false} {...handlers}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg}>
        <text fg={chosen ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>{chosen ? "● " : "○ "}</text>
        <text fg={active || chosen ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{label}</text>
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg}>
        {columns !== undefined ? (
          <>
            <text fg={COLOR.accent} bg={bg} selectable={false}>{(badge ?? "").padEnd(columns.badge + 2)}</text>
            <text fg={COLOR.dim} bg={bg} selectable={false}>{detail.padEnd(columns.detail)}</text>
          </>
        ) : (
          <>
            {badge === undefined ? null : <text fg={COLOR.accent} bg={bg} selectable={false}>{detail === "" ? badge : `${badge}  `}</text>}
            {detail === "" ? null : <text fg={COLOR.dim} bg={bg} selectable={false}>{detail}</text>}
          </>
        )}
      </box>
    </box>
  );
}

/** The search line over a long list: always drawn, so it is plain that typing narrows it. */
function SearchField({ query, width, hint }: { query: string; width: number; hint: string }) {
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, width, paddingLeft: 1, marginBottom: 1 }} backgroundColor={SURFACE.hover} selectable={false}>
      <text fg={COLOR.dim} bg={SURFACE.hover} selectable={false}>{"⌕  "}</text>
      {query === "" ? (
        <text fg={COLOR.dim} bg={SURFACE.hover} selectable={false}>{hint}</text>
      ) : (
        <text fg={COLOR.bright} bg={SURFACE.hover} selectable={false}>{`${query}▏`}</text>
      )}
    </box>
  );
}

/** A provider's name over its models, with a rule running out to the edge. */
function GroupHeading({ label, width }: { label: string; width: number }) {
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }} backgroundColor={SURFACE.raised} selectable={false}>
      <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{" "}</text>
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{`${label} `}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"─".repeat(Math.max(0, width - label.length - 4))}</text>
      </box>
    </box>
  );
}

/** The runner chosen for well-known MCP servers, from a snapshot. */
function mcpRunnerOf(settings: SettingsSnapshot["settings"] | undefined): McpRunner {
  const value = settings?.find((view) => view.descriptor.key === "mcpRunner")?.value;
  return value === "bunx" || value === "pnpm" || value === "yarn" ? value : "npx";
}

/** What a row's one line cut short: the highlighted option's whole description, wrapped under the list. */
function FullDescription({ option, width }: { option: SettingOption | undefined; width: number }) {
  const description = option?.description;
  if (option === undefined || description === undefined) return null;
  const room = Math.max(0, width - option.label.length - 8 - (option.badge === undefined ? 0 : option.badge.length + 2));
  if (description.length <= room) return null;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }} backgroundColor={SURFACE.raised}>
      <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{description}</text>
    </box>
  );
}

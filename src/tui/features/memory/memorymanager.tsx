import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyLayer } from "../../hooks/useKeyLayer.js";

import type { ClientApi, QueryResult } from "../../../server/api.js";
import { t } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { ModalShell } from "../../ui/modalshell.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { prose } from "../../ui/prose.js";
import { SearchField } from "../../ui/searchfield.js";
import { overflowColumns } from "../../model/textoverflow.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { PICK_BG, PICK_FG } from "../pickers/pickermodal.js";
import { TextField } from "../settings/textfield.js";
import {
  checkRenameTarget,
  commitRename,
  errorCodeOf,
  memoryChanged,
  verifyTargetSave,
  type MemoryAddress,
  type MemoryBody,
  type MemoryKey,
  type MemoryScope,
  type MemoryType,
  type StoredMemory,
} from "./operations.js";

type Listed = QueryResult<"memory.list">["memories"][number];
type Searched = QueryResult<"memory.search">["memories"][number];

/** One row of the list: from the list (grouped by scope) or from a search (ranked, with an excerpt). */
interface Row {
  readonly name: string;
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly description: string;
  readonly excerpt?: string;
}

type Screen =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly key: MemoryKey }
  | { readonly kind: "form"; readonly editing: MemoryKey | null }
  | { readonly kind: "deleteConfirm"; readonly key: MemoryKey }
  | { readonly kind: "replaceConfirm" }
  | { readonly kind: "conflict"; readonly fresh: StoredMemory; readonly forTarget: boolean };

/** The list's one selected row: a memory by its place among them, a runtime row by id. */
type Focus = { readonly kind: "row"; readonly at: number } | { readonly kind: "extra"; readonly id: string } | null;

/** The memory types a form offers, in the order the server documents them. */
const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];
const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global"];

const typeLabel = (type: MemoryType): string =>
  ({ user: t("mem.type.user"), feedback: t("mem.type.feedback"), project: t("mem.type.project"), reference: t("mem.type.reference") })[type];

const scopeLabel = (scope: MemoryScope): string => (scope === "project" ? t("mem.scope.project") : t("mem.scope.global"));

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The memory manager: the user's own view over what agents save — list
 * (global, then this project), full read, create, edit, delete and the same
 * search agents use. Everything goes through the server, so a paired client
 * sees the same memories; nothing here touches the store directly. The modal
 * is one shell over it (the command palette's); Settings' Memory page is
 * another, with the runtime settings riding in its footer.
 */
export function MemoryManagerModal({
  client,
  threadId,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
}: {
  client: ClientApi;
  /** The open thread: its project is "this project". Null shows the global scope alone. */
  threadId: string | null;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const inner = Math.max(20, width - 4);
  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <MemoryManager client={client} threadId={threadId} width={inner} onEscapeList={onClose} />
    </ModalShell>
  );
}

/** One row of the page's section below the memories, e.g. a setting. Enter or a click runs `onActivate`. */
export interface MemoryFooterRow {
  /** The row's own id, for keeping it in view and clicking it. */
  readonly id: string;
  readonly label: string;
  readonly value: string;
  /** Prose under the row (a setting's schema description). */
  readonly description?: string | undefined;
  /** Absent where the row shows something it cannot change from here. */
  readonly onActivate?: (() => void) | undefined;
}

/** The Settings Memory page's section under the memories: the runtime panel and its setting rows. */
export interface MemoryFooter {
  readonly heading: string;
  readonly node: ReactNode;
  readonly rows: readonly MemoryFooterRow[];
}

export function MemoryManager({
  client,
  threadId,
  width,
  onEscapeList,
  footer,
  memorySwitch,
  tabLeavesList,
  escClearsFilter,
}: {
  client: ClientApi;
  /** The open thread: its project is "this project". Null shows the global scope alone. */
  threadId: string | null;
  /** The content's whole width; the modal passes what its shell leaves, the page its pane. */
  width: number;
  /** Escape on the list: the modal closes, the page closes the settings screen. */
  onEscapeList: () => void;
  /** The page's runtime section, on the list under the memories; absent in the modal. */
  footer?: MemoryFooter;
  /**
   * The memory switch as the enclosing Settings screen sees it right now, so a
   * runtime row flipped under the list stands the writes down at once.
   * Absent (the modal and the page without a snapshot), the manager reads it
   * from the server itself.
   */
  readonly memorySwitch?: boolean | undefined;
  /**
   * Whether the tab key leaves the list view to the screen around it (the
   * settings sidebar). The standalone modal keeps the key: it has nowhere to go.
   */
  readonly tabLeavesList?: boolean | undefined;
  /**
   * Whether escape drops what was typed before it leaves the list. The Settings
   * page sets it; the standalone modal closes on the first press, as it always
   * did.
   */
  readonly escClearsFilter?: boolean | undefined;
}) {
  const inner = Math.max(20, width);
  const rowWidth = Math.max(10, inner - 2);

  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [query, setQuery] = useState("");
  /**
   * The list's selected row. A memory row by its place, a runtime row by its
   * id: what the arrows put on and Enter acts on is exactly what the user put
   * it on, and when that row goes away the selection goes with it — a change
   * in the rows never moves it onto a setting (an action that just finished
   * never leaves Enter pointing at the next one). Null until something is
   * navigated or hovered onto: the first memory is then selected, if any.
   */
  const [focus, setFocus] = useState<Focus>(null);
  const [listed, setListed] = useState<readonly Listed[] | null>(null);
  const [searched, setSearched] = useState<readonly Searched[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [semanticNote, setSemanticNote] = useState<string | null>(null);
  const [memoryOffOnServer, setMemoryOffOnServer] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  /** How many memories one scope holds, as the server enforces it; null until it loads, or an older paired server never says. */
  const [cap, setCap] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [opened, setOpened] = useState<StoredMemory | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [draft, setDraft] = useState<MemoryBody | null>(null);
  /** The memory the form edits: null for a new one. Kept while confirms come and go. */
  const [formKey, setFormKey] = useState<MemoryKey | null>(null);
  /** The target key a replace confirm was given for: consent never carries to another name. A ref, not state: confirms set it in the same tick they save. */
  const replaceConsentedKey = useRef<MemoryKey | null>(null);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editingField, setEditingField] = useState<"name" | "description" | "body" | null>(null);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmIndex, setConfirmIndex] = useState(0);
  /** What the last delete removed: shown on the list until the next action. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The thread the open detail or form belongs to: mutations use this, never the live prop. */
  const [opAddress, setOpAddress] = useState<MemoryAddress>({});
  /** The project the list answers for: null until it loads, or when there is none. */
  const [listProjectId, setListProjectId] = useState<string | null>(null);

  const addressOf = (id: string | null): MemoryAddress => (id === null ? {} : { threadId: id });
  const via = addressOf(threadId);
  /** Memory off as this view knows it now: the page passes the live switch, the modal what it asked the server (see above). */
  const memoryOff = memorySwitch === undefined ? memoryOffOnServer : !memorySwitch;
  /** Writes are allowed while memory is on; viewing works either way. */
  const canWrite = !memoryOff;
  const hasProject = listProjectId !== null;

  // The list, the project it answers for, and whether memory is off (viewing still works then).
  useEffect(() => {
    let cancelled = false;
    setListed(null);
    setListProjectId(null);
    setListError(null);
    void client
      .query({ type: "memory.list", ...via })
      .then((result) => {
        if (cancelled) return;
        setListed(result.memories);
        setListProjectId(result.projectId);
        setCap(typeof result.cap === "number" ? result.cap : null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setListError(messageOf(cause));
      });
    // Where the live switch is handed in (the Settings page), it is never asked
    // for: what this view reads is what it shows while the page's rows change it.
    if (memorySwitch === undefined) {
      void client
        .query({ type: "settings.read" })
        .then((snapshot) => {
          if (!cancelled) setMemoryOffOnServer(snapshot.settings.some((view) => view.descriptor.key === "memory" && view.value === false));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, threadId, reloadToken]);

  // A thread switch mid-modal would otherwise write into the new thread's
  // project: fall back to the list, which follows the live thread.
  useEffect(() => {
    setScreen({ kind: "list" });
    setQuery("");
    setOpened(null);
    setDraft(null);
    setFormKey(null);
    replaceConsentedKey.current = null;
    setOpAddress(addressOf(threadId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Searching goes through the same server search agents use (keyword, or semantic when set up).
  useEffect(() => {
    const needle = query.trim();
    if (needle === "") {
      setSearched(null);
      setSearching(false);
      setSemanticNote(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void client
        .query({ type: "memory.search", query: needle, limit: 30, ...via })
        .then((result) => {
          setSearched(result.memories);
          setSemanticNote(result.semantic?.state === "unavailable" ? (result.semantic.message ?? null) : null);
          setSearching(false);
          setFocus(null);
        })
        .catch((cause: unknown) => {
          setSearched([]);
          setListError(messageOf(cause));
          setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, threadId, query, reloadToken]);

  const searchingView = query.trim() !== "";
  const rows: readonly Row[] = useMemo(() => {
    if (searchingView) return (searched ?? []).map((entry) => ({ name: entry.name, scope: entry.scope, type: entry.type, description: entry.description, excerpt: entry.excerpt }));
    return (listed ?? []).map((entry) => ({ name: entry.name, scope: entry.scope, type: entry.type, description: entry.description }));
  }, [searchingView, searched, listed]);
  const globalRows = useMemo(() => rows.filter((row) => row.scope === "global"), [rows]);
  const projectRows = useMemo(() => rows.filter((row) => row.scope === "project"), [rows]);
  /** A scope's header count: how much of what the server allows one scope to hold is in use. The search narrows rows, not this. */
  const scopeCount = (scope: MemoryScope): string | undefined => {
    if (listed === null) return undefined;
    const used = listed.filter((entry) => entry.scope === scope).length;
    return cap === null ? String(used) : `${used}/${cap}`;
  };
  // Grouped order is the navigation order, so ↑/↓ walks rows as drawn; the page's
  // section follows the memories, so its rows are reachable on the same walk.
  const ordered = searchingView ? rows : [...globalRows, ...projectRows];
  // The section is reachable only once the page is about something of its own:
  // a search is about its results, and until the list answers, the memories it
  // is loading may yet fill the walk — its actions never take the step over.
  const extraRows = footer === undefined || searchingView || listed === null ? [] : footer.rows;
  const focusCount = ordered.length + extraRows.length;
  /**
   * Where the selection sits now. A memory row is the safe default (Enter only
   * opens it), so with no selection, or one whose runtime row went away, the
   * first memory takes it, and a memory selection past the end moves to the
   * last. A runtime row is selected only when navigated or hovered onto, and
   * with no memories the list answers -1: Enter does nothing.
   */
  const defaultAt = ordered.length > 0 ? 0 : -1;
  const focusAt = focus === null
    ? defaultAt
    : focus.kind === "row"
      ? ordered.length > 0
        ? Math.min(focus.at, ordered.length - 1)
        : -1
      : (() => {
          const at = extraRows.findIndex((row) => row.id === focus.id);
          return at === -1 ? defaultAt : ordered.length + at;
        })();

  const openDetail = (key: MemoryKey) => {
    setNotice(null);
    setOpAddress(addressOf(threadId));
    setScreen({ kind: "detail", key });
    setOpened(null);
    setDetailError(null);
    void client
      .query({ type: "memory.read", name: key.name, scope: key.scope, ...addressOf(threadId) })
      .then(setOpened)
      .catch((cause: unknown) => setDetailError(messageOf(cause)));
  };

  const openCreate = () => {
    setNotice(null);
    setOpAddress(addressOf(threadId));
    setDraft({ name: "", description: "", type: "project", body: "", scope: hasProject ? "project" : "global" });
    setFormKey(null);
    replaceConsentedKey.current = null;
    setFieldIndex(0);
    setEditingField(null);
    setReplaceConfirmed(false);
    setOverwriteConfirmed(false);
    setFormError(null);
    setScreen({ kind: "form", editing: null });
  };

  const openEdit = (memory: StoredMemory) => {
    setOpAddress(addressOf(threadId));
    setDraft({ name: memory.name, description: memory.description, type: memory.type, body: memory.body, scope: memory.scope });
    setFormKey({ name: memory.name, scope: memory.scope });
    replaceConsentedKey.current = null;
    setFieldIndex(0);
    setEditingField(null);
    setReplaceConfirmed(false);
    setOverwriteConfirmed(false);
    setFormError(null);
    setScreen({ kind: "form", editing: { name: memory.name, scope: memory.scope } });
  };

  /** One memory, or null when the scope holds no such name. Anything else propagates. */
  const readTarget = async (key: MemoryKey): Promise<StoredMemory | null> => {
    try {
      return await client.query({ type: "memory.read", name: key.name, scope: key.scope, ...opAddress });
    } catch (cause) {
      if (errorCodeOf(cause) === "MEMORY_NOT_FOUND") return null;
      throw cause;
    }
  };

  const saveForm = (editing: MemoryKey | null, flags: { replace: boolean; overwrite: boolean }) => {
    if (draft === null || saving) return;
    setSaving(true);
    setFormError(null);
    const attempt = async (): Promise<void> => {
      const snapshot = { ...draft };
      const from = editing;
      const targetKey = { name: snapshot.name, scope: snapshot.scope };
      const renamed = from === null || snapshot.name !== from.name || snapshot.scope !== from.scope;
      // Never silently overwrite the source: what changed underneath is shown first.
      if (from !== null && !flags.overwrite && opened !== null && opened.name === from.name && opened.scope === from.scope) {
        const fresh = await client.query({ type: "memory.read", name: from.name, scope: from.scope, ...opAddress });
        if (memoryChanged(opened, fresh)) {
          setConfirmIndex(0);
          setScreen({ kind: "conflict", fresh, forTarget: false });
          return;
        }
      }
      // Consent for the target, then a last-instant re-read against what was agreed.
      const chk = await checkRenameTarget(client, opAddress, from, snapshot, { replaceConfirmed: flags.replace });
      if ("needsReplaceConfirm" in chk) {
        setConfirmIndex(0);
        setScreen({ kind: "replaceConfirm" });
        return;
      }
      if (renamed) {
        const now = await readTarget(targetKey);
        const agreed = flags.replace && chk.existing !== null && chk.existing.name === targetKey.name && chk.existing.scope === targetKey.scope
          ? chk.existing
          : null;
        const consentedKey = replaceConsentedKey.current;
        const consented = flags.replace && consentedKey !== null && consentedKey.name === targetKey.name && consentedKey.scope === targetKey.scope;
        const decision = verifyTargetSave({ isCreate: from === null, replaceEffective: consented, basis: agreed, now });
        if (decision === "replaceConfirm") {
          setConfirmIndex(0);
          setScreen({ kind: "replaceConfirm" });
          return;
        }
        if (decision === "conflict") {
          setConfirmIndex(0);
          setScreen({ kind: "conflict", fresh: now!, forTarget: true });
          return;
        }
      }
      await commitRename(client, opAddress, from, snapshot);
      setReplaceConfirmed(false);
      setOverwriteConfirmed(false);
      replaceConsentedKey.current = null;
      setReloadToken((token) => token + 1);
      openDetail(targetKey);
    };
    void attempt()
      .catch((cause: unknown) => setFormError(messageOf(cause)))
      .finally(() => setSaving(false));
  };

  const deleteOpened = (key: MemoryKey) => {
    setDetailError(null);
    void client
      .dispatch({ type: "memory.delete", name: key.name, scope: key.scope, ...opAddress })
      .then(() => {
        setReloadToken((token) => token + 1);
        setNotice(t("mem.deleted", { name: key.name }));
        setScreen({ kind: "list" });
      })
      .catch((cause: unknown) => {
        // The confirm screen stays: the memory is still there to decide over.
        setScreen({ kind: "detail", key });
        setDetailError(messageOf(cause));
      });
  };

  const FIELDS = ["name", "description", "type", "scope", "body", "save", "cancel"] as const;
  type Field = (typeof FIELDS)[number];
  const activeField: Field = FIELDS[Math.min(fieldIndex, FIELDS.length - 1)]!;

  useKeyLayer((key) => {
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      if (editingField !== null) {
        setEditingField(null);
        return;
      }
      if (screen.kind === "list") {
        // The Settings page leaves what was typed first: a filter gone, then
        // the screen under it. The standalone modal has nothing under it, so
        // esc closes on the first press, filter or not.
        if (query !== "" && escClearsFilter === true) {
          setQuery("");
          setNotice(null);
          return;
        }
        onEscapeList();
        return;
      }
      if (screen.kind === "detail") {
        setScreen({ kind: "list" });
        return;
      }
      if (screen.kind === "form") {
        const back = formKey === null || opened === null ? { kind: "list" as const } : { kind: "detail" as const, key: { name: opened.name, scope: opened.scope } };
        setScreen(back);
        return;
      }
      if (screen.kind === "deleteConfirm" || screen.kind === "replaceConfirm") {
        setScreen(screen.kind === "deleteConfirm" ? { kind: "detail", key: screen.key } : { kind: "form", editing: formKey });
        return;
      }
      if (screen.kind === "conflict") {
        if (screen.forTarget) setScreen({ kind: "form", editing: formKey });
        else {
          setOpened(screen.fresh);
          setScreen({ kind: "detail", key: { name: screen.fresh.name, scope: screen.fresh.scope } });
        }
        return;
      }
      return;
    }
    // A text box owns every other key while it is open.
    if (editingField !== null) return;
    if (screen.kind === "list") {
      if (key.name === "up" || key.name === "down") {
        if (focusCount === 0) return;
        // Nothing selected is where down starts; a selection the rows no longer
        // hold starts over rather than landing wherever the count now reaches.
        const next = focusAt < 0 ? 0 : key.name === "down" ? (focusAt + 1) % focusCount : (focusAt - 1 + focusCount) % focusCount;
        setFocus(next < ordered.length ? { kind: "row", at: next } : { kind: "extra", id: extraRows[next - ordered.length]!.id });
        return;
      }
      if (key.name === "return" || key.name === "kpenter") {
        // Enter acts on exactly what is selected, never on what sits where a
        // gone selection used to: an unselected list answers with nothing.
        if (focusAt < 0) return;
        if (focusAt < ordered.length) {
          const row = ordered[focusAt];
          if (row !== undefined) openDetail({ name: row.name, scope: row.scope });
        } else {
          extraRows[focusAt - ordered.length]?.onActivate?.();
        }
        return;
      }
      if (key.name === "n" && key.ctrl === true && key.meta !== true) {
        if (canWrite) openCreate();
        return;
      }
      if (key.name === "backspace") {
        setNotice(null);
        setQuery((text) => text.slice(0, -1));
        setFocus(null);
        return;
      }
      if (key.ctrl === true || key.meta === true) return;
      const sequence = key.sequence;
      if (typeof sequence === "string" && sequence.length === 1 && sequence >= " ") {
        setNotice(null);
        setQuery((text) => `${text}${sequence}`);
        setFocus(null);
      }
      return;
    }
    if (screen.kind === "detail") {
      if (key.name === "left" || key.name === "backspace") {
        setScreen({ kind: "list" });
        return;
      }
      if (!canWrite) return;
      if (key.sequence === "e" && !key.ctrl && !key.meta && opened !== null) {
        openEdit(opened);
        return;
      }
      if (key.sequence === "x" && !key.ctrl && !key.meta && opened !== null) {
        setConfirmIndex(0);
        setScreen({ kind: "deleteConfirm", key: { name: opened.name, scope: opened.scope } });
      }
      return;
    }
    if (screen.kind === "form" && draft !== null) {
      if (key.name === "up" || (key.name === "k" && !key.ctrl)) {
        setFieldIndex((current) => (current - 1 + FIELDS.length) % FIELDS.length);
        return;
      }
      if (key.name === "down" || (key.name === "j" && !key.ctrl)) {
        setFieldIndex((current) => (current + 1) % FIELDS.length);
        return;
      }
      if (activeField === "type" || activeField === "scope") {
        if (key.name === "left" || key.name === "right" || key.name === "space") {
          const delta = key.name === "left" ? -1 : 1;
          if (activeField === "type") {
            const at = MEMORY_TYPES.indexOf(draft.type);
            setDraft({ ...draft, type: MEMORY_TYPES[(at + delta + MEMORY_TYPES.length) % MEMORY_TYPES.length]! });
          } else if (hasProject) {
            const at = MEMORY_SCOPES.indexOf(draft.scope);
            setDraft({ ...draft, scope: MEMORY_SCOPES[(at + delta + MEMORY_SCOPES.length) % MEMORY_SCOPES.length]! });
          }
          return;
        }
      }
      if (key.name === "return" || key.name === "kpenter" || key.name === "space") {
        if (activeField === "name" || activeField === "description" || activeField === "body") setEditingField(activeField);
        else if (activeField === "save") {
          if (canWrite) saveForm(formKey, { replace: replaceConfirmed, overwrite: overwriteConfirmed });
        } else if (activeField === "cancel") setScreen(formKey === null ? { kind: "list" } : opened === null ? { kind: "list" } : { kind: "detail", key: { name: opened.name, scope: opened.scope } });
      }
      return;
    }
    if (screen.kind === "deleteConfirm" || screen.kind === "replaceConfirm" || screen.kind === "conflict") {
      if (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") {
        setConfirmIndex((current) => (current + 1) % 2);
        return;
      }
      if (key.name === "return" || key.name === "kpenter" || key.name === "space") {
        if (screen.kind === "deleteConfirm") {
          if (confirmIndex === 0) deleteOpened(screen.key);
          else setScreen({ kind: "detail", key: screen.key });
        } else if (screen.kind === "replaceConfirm") {
          if (confirmIndex === 0) {
            if (draft !== null) replaceConsentedKey.current = { name: draft.name, scope: draft.scope };
            setReplaceConfirmed(true);
            setConfirmIndex(0);
            setScreen({ kind: "form", editing: formKey });
            saveForm(formKey, { replace: true, overwrite: overwriteConfirmed });
          } else setScreen({ kind: "form", editing: formKey });
        } else if (screen.forTarget) {
          if (confirmIndex === 0) {
            if (draft !== null) replaceConsentedKey.current = { name: draft.name, scope: draft.scope };
            setOverwriteConfirmed(true);
            setReplaceConfirmed(true);
            setConfirmIndex(0);
            setScreen({ kind: "form", editing: formKey });
            saveForm(formKey, { replace: true, overwrite: true });
          } else setScreen({ kind: "form", editing: formKey });
        } else {
          if (confirmIndex === 0) {
            setOverwriteConfirmed(true);
            setConfirmIndex(0);
            setScreen({ kind: "form", editing: formKey });
            saveForm(formKey, { replace: replaceConfirmed, overwrite: true });
          } else {
            setOpened(screen.fresh);
            setScreen({ kind: "detail", key: { name: screen.fresh.name, scope: screen.fresh.scope } });
          }
        }
      }
    }
  }, {
    // From the page's list the tab key is the settings sidebar's way sideways;
    // everywhere else (the standalone modal, an open memory, a form) this view
    // is the whole screen, so it keeps the key.
    capture: (key: KeyEvent) => !(tabLeavesList === true && key.name === "tab" && screen.kind === "list"),
  });

  const formTitle = formKey !== null ? t("mem.edit") : t("mem.new");

  // Keep the highlighted row in view: the list can hold hundreds of memories.
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (screen.kind !== "list" || focus === null || focusAt < 0) return;
    const id = focus.kind === "row" ? `memory-row-${focus.at}` : focus.id;
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(id), 0);
    return () => clearTimeout(timer);
  }, [screen.kind, focus, focusCount]);

  const hint =
    screen.kind === "list"
      ? t("mem.hintList")
      : screen.kind === "detail"
        ? t("mem.hintDetail")
        : screen.kind === "form"
          ? t("mem.hintForm")
          : t("mem.hintConfirm");

  return (
    <>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between", width: inner }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{screen.kind === "form" ? formTitle : t("mem.title")}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"esc"}</text>
      </box>
      {memoryOff ? <text fg={COLOR.warn} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("mem.off")}</text> : null}
      {screen.kind === "list" ? (
        <>
          <SearchField query={query} active={query.length > 0} />
          {notice === null ? null : <text fg={COLOR.added} bg={SURFACE.raised} selectable={false}>{notice}</text>}
          {listError === null || listed === null ? null : <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word">{listError}</text>}
          {semanticNote === null ? null : <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{semanticNote}</text>}
          <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
            {listError !== null && listed === null ? (
              <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word">{listError}</text>
            ) : listed === null && !searchingView ? (
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("mem.loading")}</text>
            ) : searchingView && searching ? (
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("mem.loading")}</text>
            ) : ordered.length === 0 ? (
              <box style={{ flexDirection: "column", flexGrow: 1, justifyContent: "center", alignItems: "center", width: inner }} backgroundColor={SURFACE.raised}>
                <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{searchingView ? t("mem.noMatch") : t("mem.empty")}</text>
                {!searchingView && listed !== null && !hasProject ? <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{threadId === null ? t("mem.noProject") : t("mem.noProjectThread")}</text> : null}
              </box>
            ) : searchingView ? (
              ordered.map((row, rowIndex) => (
                <MemoryRow key={`${row.scope}:${row.name}`} id={`memory-row-${rowIndex}`} row={row} active={rowIndex === focusAt} rowWidth={rowWidth} onHover={() => setFocus({ kind: "row", at: rowIndex })} onOpen={() => openDetail({ name: row.name, scope: row.scope })} />
              ))
            ) : (
              <Fragment>
                {globalRows.length === 0 ? null : (
                  <Fragment>
                    <SectionHeader label={t("mem.global")} count={scopeCount("global")} width={rowWidth} />
                    {globalRows.map((row) => {
                      const rowIndex = ordered.indexOf(row);
                      return <MemoryRow key={`global:${row.name}`} id={`memory-row-${rowIndex}`} row={row} active={rowIndex === focusAt} rowWidth={rowWidth} onHover={() => setFocus({ kind: "row", at: rowIndex })} onOpen={() => openDetail({ name: row.name, scope: row.scope })} />;
                    })}
                  </Fragment>
                )}
                {projectRows.length === 0 ? null : (
                  <Fragment>
                    <SectionHeader label={t("mem.project")} count={scopeCount("project")} width={rowWidth} />
                    {projectRows.map((row) => {
                      const rowIndex = ordered.indexOf(row);
                      return <MemoryRow key={`project:${row.name}`} id={`memory-row-${rowIndex}`} row={row} active={rowIndex === focusAt} rowWidth={rowWidth} onHover={() => setFocus({ kind: "row", at: rowIndex })} onOpen={() => openDetail({ name: row.name, scope: row.scope })} />;
                    })}
                  </Fragment>
                )}
                {listed === null || hasProject ? null : <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{threadId === null ? t("mem.noProject") : t("mem.noProjectThread")}</text>}
              </Fragment>
            )}
            {footer === undefined ? null : (
              <box style={{ flexDirection: "column", width: rowWidth, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
                <SectionHeader label={footer.heading} width={rowWidth} />
                {footer.node}
                {footer.rows.map((row, extraIndex) => (
                  <FooterRow
                    key={row.id}
                    id={row.id}
                    row={row}
                    active={!searchingView && focus?.kind === "extra" && focus.id === row.id}
                    rowWidth={rowWidth}
                    onHover={() => {
                      // A row the search or the still-loading list has out of
                      // the walk must not take the highlight from a result.
                      if (!searchingView) setFocus({ kind: "extra", id: row.id });
                    }}
                  />
                ))}
              </box>
            )}
          </scrollbox>
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "space-between", width: inner }} backgroundColor={SURFACE.raised}>
            <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={Math.max(0, inner - 8)}>{hint}</OverflowText>
            {canWrite ? <HoverButton label={t("mem.new")} fg={COLOR.accent} hoverFg={COLOR.bright} onClick={openCreate} /> : <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{t("mem.new")}</text>}
          </box>
        </>
      ) : screen.kind === "detail" ? (
        opened === null ? (
          <box style={{ flexDirection: "column", flexGrow: 1, justifyContent: "center", alignItems: "center", width: inner }} backgroundColor={SURFACE.raised}>
            <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{detailError ?? t("mem.loading")}</text>
          </box>
        ) : (
          <>
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, width: inner }} backgroundColor={SURFACE.raised}>
              <HoverButton label="← " fg={COLOR.dim} hoverFg={COLOR.bright} onClick={() => setScreen({ kind: "list" })} />
              <OverflowText fg={COLOR.bright} bg={SURFACE.raised} selectable={false} width={Math.max(4, inner - 4)}>{opened.name}</OverflowText>
            </box>
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0, width: inner }} backgroundColor={SURFACE.raised}>
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{`${scopeLabel(opened.scope)} · ${typeLabel(opened.type)}`}</text>
            </box>
            <text fg={COLOR.text} bg={SURFACE.raised} wrapMode="word">{opened.description}</text>
            <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
              {opened.body.split("\n").map((line, lineIndex) => (
                <text key={lineIndex} fg={COLOR.text} bg={SURFACE.raised} wrapMode="word">{line === "" ? " " : line}</text>
              ))}
            </scrollbox>
            {detailError === null ? null : <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word">{detailError}</text>}
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "space-between", width: inner }} backgroundColor={SURFACE.raised}>
              <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={Math.max(0, inner - 20)}>{hint}</OverflowText>
              <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={SURFACE.raised}>
                {canWrite ? <HoverButton label={` ${t("mem.edit")} `} fg={COLOR.accent} hoverFg={COLOR.bright} onClick={() => openEdit(opened)} /> : <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{` ${t("mem.edit")} `}</text>}
                {canWrite ? <HoverButton label={` ${t("mem.delete")} `} fg={COLOR.danger} hoverFg={COLOR.bright} onClick={() => { setConfirmIndex(0); setScreen({ kind: "deleteConfirm", key: { name: opened.name, scope: opened.scope } }); }} /> : <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{` ${t("mem.delete")} `}</text>}
              </box>
            </box>
          </>
        )
      ) : screen.kind === "form" && draft !== null ? (
        <>
          <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
            <FormField id="memory-field-0" label={t("mem.field.name")} value={draft.name} active={activeField === "name"} editing={editingField === "name"} width={inner}
              onActivate={() => { setFieldIndex(0); setEditingField("name"); }} onHover={() => setFieldIndex(0)} />
            {editingField === "name" ? (
              <TextField key={`name:${formKey?.name ?? "new"}`} initial={draft.name} width={inner}
                onCancel={() => setEditingField(null)}
                onSubmit={(text) => { setDraft({ ...draft, name: text }); setEditingField(null); }} />
            ) : null}
            <FormField id="memory-field-1" label={t("mem.field.description")} value={draft.description} active={activeField === "description"} editing={editingField === "description"} width={inner}
              onActivate={() => { setFieldIndex(1); setEditingField("description"); }} onHover={() => setFieldIndex(1)} />
            {editingField === "description" ? (
              <TextField key={`description:${formKey?.name ?? "new"}`} initial={draft.description} width={inner}
                onCancel={() => setEditingField(null)}
                onSubmit={(text) => { setDraft({ ...draft, description: text }); setEditingField(null); }} />
            ) : null}
            <FormField id="memory-field-2" label={t("mem.field.type")} value={typeLabel(draft.type)} active={activeField === "type"} editing={false} width={inner}
              onActivate={() => { setFieldIndex(2); const at = MEMORY_TYPES.indexOf(draft.type); setDraft({ ...draft, type: MEMORY_TYPES[(at + 1) % MEMORY_TYPES.length]! }); }} onHover={() => setFieldIndex(2)} />
            <FormField id="memory-field-3" label={t("mem.field.scope")} value={scopeLabel(draft.scope)} active={activeField === "scope"} editing={false} width={inner}
              onActivate={() => {
                setFieldIndex(3);
                if (threadId === null) return;
                const at = MEMORY_SCOPES.indexOf(draft.scope);
                setDraft({ ...draft, scope: MEMORY_SCOPES[(at + 1) % MEMORY_SCOPES.length]! });
              }} onHover={() => setFieldIndex(3)} />
            <FormField id="memory-field-4" label={t("mem.field.body")} value={draft.body.split("\n")[0] ?? ""} active={activeField === "body"} editing={editingField === "body"} width={inner}
              onActivate={() => { setFieldIndex(4); setEditingField("body"); }} onHover={() => setFieldIndex(4)} />
            {editingField === "body" ? (
              <TextField key={`body:${formKey?.name ?? "new"}`} initial={draft.body} multiline width={inner}
                onCancel={() => setEditingField(null)}
                onSubmit={(text) => { setDraft({ ...draft, body: text }); setEditingField(null); }} />
            ) : null}
            <box style={{ flexDirection: "row", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
              {canWrite ? <HoverButton label={saving ? ` ${t("mem.saving")} ` : ` ${t("mem.save")} `} fg={SURFACE.base} hoverBg={COLOR.bright} bg={COLOR.accent} onClick={() => saveForm(formKey, { replace: replaceConfirmed, overwrite: overwriteConfirmed })} /> : <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{` ${t("mem.save")} `}</text>}
              <HoverButton label={` ${t("mem.cancel")} `} fg={COLOR.dim} hoverFg={COLOR.bright} onClick={() => setScreen(formKey === null ? { kind: "list" } : opened === null ? { kind: "list" } : { kind: "detail", key: { name: opened.name, scope: opened.scope } })} />
            </box>
          </scrollbox>
          {formError === null ? null : <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word">{formError}</text>}
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, width: inner }} backgroundColor={SURFACE.raised}>
            <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={inner}>{hint}</OverflowText>
          </box>
        </>
      ) : screen.kind === "deleteConfirm" ? (
        <ConfirmBody title={t("mem.deleteTitle")} detail={`${screen.key.name} · ${scopeLabel(screen.key.scope)}`} confirmLabel={t("mem.delete")} danger index={confirmIndex} width={inner}
          onHover={setConfirmIndex} onConfirm={() => deleteOpened(screen.key)} onBack={() => setScreen({ kind: "detail", key: screen.key })} />
      ) : screen.kind === "replaceConfirm" && draft !== null ? (
        <ConfirmBody title={t("mem.replaceTitle")} detail={t("mem.replaceBody", { name: draft.name, scope: scopeLabel(draft.scope) })} confirmLabel={t("mem.replace")} danger={false} index={confirmIndex} width={inner}
          onHover={setConfirmIndex}
          onConfirm={() => { replaceConsentedKey.current = { name: draft.name, scope: draft.scope }; setReplaceConfirmed(true); setConfirmIndex(0); setScreen({ kind: "form", editing: formKey }); saveForm(formKey, { replace: true, overwrite: overwriteConfirmed }); }}
          onBack={() => setScreen({ kind: "form", editing: formKey })} />
      ) : screen.kind === "conflict" ? (
        <ConfirmBody title={t("mem.conflictTitle")} detail={screen.forTarget && draft !== null ? t("mem.conflictBodyTarget", { name: draft.name }) : t("mem.conflictBody")} confirmLabel={t("mem.overwrite")} danger index={confirmIndex} width={inner}
          onHover={setConfirmIndex}
          onConfirm={() => {
            if (screen.forTarget && draft !== null) {
              replaceConsentedKey.current = { name: draft.name, scope: draft.scope };
              setOverwriteConfirmed(true);
              setReplaceConfirmed(true);
              setConfirmIndex(0);
              setScreen({ kind: "form", editing: formKey });
              saveForm(formKey, { replace: true, overwrite: true });
            } else {
              setOverwriteConfirmed(true);
              setConfirmIndex(0);
              setScreen({ kind: "form", editing: formKey });
              saveForm(formKey, { replace: replaceConfirmed, overwrite: true });
            }
          }}
          onBack={() => {
            if (screen.forTarget) setScreen({ kind: "form", editing: formKey });
            else {
              setOpened(screen.fresh);
              setScreen({ kind: "detail", key: { name: screen.fresh.name, scope: screen.fresh.scope } });
            }
          }} />
      ) : null}
    </>
  );
}

/** A scope's heading, with its rule drawn to the width; a count, when the scope holds any, reads on the right. */
function SectionHeader({ label, count, width }: { label: string; count?: string | undefined; width: number }) {
  const rule = "─".repeat(Math.max(0, width - label.length - 2 - (count === undefined ? 0 : count.length + 1)));
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "space-between", width }} backgroundColor={SURFACE.raised}>
      <box style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{`${label} `}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{rule}</text>
      </box>
      {count === undefined ? null : <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{count}</text>}
    </box>
  );
}

function MemoryRow({ id, row, active, rowWidth, onHover, onOpen }: {
  id: string;
  row: Row;
  active: boolean;
  rowWidth: number;
  onHover: () => void;
  onOpen: () => void;
}) {
  const rowBg = active ? PICK_BG : SURFACE.raised;
  const labelFg = active ? PICK_FG : COLOR.text;
  const metaFg = active ? PICK_FG : COLOR.faint;
  const label = row.name;
  const meta = `${typeLabel(row.type)} · ${row.description}`;
  const columns = overflowColumns(label, meta, rowWidth);
  return (
    <box id={id} style={{ width: rowWidth, flexDirection: "column", flexShrink: 0 }} backgroundColor={rowBg} onMouseDown={onOpen} onMouseOver={onHover}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={rowBg}>
        <OverflowText fg={labelFg} bg={rowBg} selectable={false} width={columns.label} active={active}>{label}</OverflowText>
        <OverflowText fg={metaFg} bg={rowBg} selectable={false} width={columns.detail} active={active}>{meta}</OverflowText>
      </box>
      {row.excerpt === undefined ? null : (
        <OverflowText fg={metaFg} bg={rowBg} selectable={false} width={rowWidth - 2} active={active}>{row.excerpt}</OverflowText>
      )}
    </box>
  );
}

/** One row of the page's section under the memories: a setting to flip, cycle, or act on. */
function FooterRow({ id, row, active, rowWidth, onHover }: {
  id: string;
  row: MemoryFooterRow;
  active: boolean;
  rowWidth: number;
  onHover: () => void;
}) {
  const rowBg = active ? PICK_BG : SURFACE.raised;
  const labelFg = active ? PICK_FG : COLOR.dim;
  const valueFg = active ? PICK_FG : COLOR.text;
  const label = `${active ? "❯ " : "  "}${row.label}: `;
  const columns = overflowColumns(label, row.value, rowWidth);
  return (
    <box id={id} style={{ width: rowWidth, flexDirection: "column", flexShrink: 0 }} backgroundColor={rowBg} {...(row.onActivate === undefined ? {} : { onMouseDown: row.onActivate })} onMouseOver={onHover}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={rowBg}>
        <OverflowText fg={labelFg} bg={rowBg} selectable={false} width={columns.label} active={active}>{label}</OverflowText>
        <OverflowText fg={valueFg} bg={rowBg} selectable={false} width={columns.detail} active={active}>{row.value}</OverflowText>
      </box>
      {row.description === undefined ? null : (
        <text content={prose(row.description, COLOR.dim)} bg={rowBg} wrapMode="word" selectable={false} />
      )}
    </box>
  );
}

function FormField({ id, label, value, active, editing, width, onActivate, onHover }: {
  id: string;
  label: string;
  value: string;
  active: boolean;
  editing: boolean;
  width: number;
  onActivate: () => void;
  onHover: () => void;
}) {
  const bg = active && !editing ? PICK_BG : SURFACE.raised;
  const labelFg = active && !editing ? PICK_FG : COLOR.dim;
  const valueFg = active && !editing ? PICK_FG : COLOR.text;
  return (
    <box id={id} style={{ width: Math.max(10, width - 2), flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg} onMouseDown={onActivate} onMouseOver={onHover}>
      <text fg={labelFg} bg={bg} selectable={false}>{`${active ? "❯ " : "  "}${label}: `}</text>
      <OverflowText fg={valueFg} bg={bg} selectable={false} width={Math.max(4, width - label.length - 8)} active={active}>{value === "" ? "—" : value}</OverflowText>
    </box>
  );
}

function ConfirmBody({ title, detail, confirmLabel, danger, index, width, onHover, onConfirm, onBack }: {
  title: string;
  detail: string;
  confirmLabel: string;
  danger: boolean;
  index: number;
  width: number;
  onHover: (index: number) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const options = [
    { label: confirmLabel, danger, action: onConfirm },
    { label: t("mem.goBack"), danger: false, action: onBack },
  ];
  return (
    <>
      <box style={{ flexDirection: "column", flexGrow: 1, justifyContent: "center", alignItems: "center", width }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{title}</text>
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{detail}</text>
        <box style={{ flexDirection: "row", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          {options.map((option, at) => (
            <ConfirmOption key={option.label} label={option.label} active={at === index} danger={option.danger} onHover={() => onHover(at)} onPick={option.action} />
          ))}
        </box>
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, width }} backgroundColor={SURFACE.raised}>
        <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={width}>{t("mem.hintConfirm")}</OverflowText>
      </box>
    </>
  );
}

function ConfirmOption({ label, active, danger, onHover, onPick }: {
  label: string;
  active: boolean;
  danger: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const rowBg = active ? PICK_BG : SURFACE.raised;
  const fg = active ? PICK_FG : danger ? COLOR.danger : COLOR.dim;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 2, paddingRight: 2 }} backgroundColor={rowBg} onMouseDown={onPick} onMouseOver={onHover}>
      <text fg={fg} bg={rowBg} selectable={false}>{label}</text>
    </box>
  );
}

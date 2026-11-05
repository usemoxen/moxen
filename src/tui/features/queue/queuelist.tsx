import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { t } from "../../i18n/index.js";
import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE } from "../../theme.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { textWidth } from "../../model/textoverflow.js";
import { providerName, queueActions, queueDescription, queueDetails, queueEntryState, queueMoveSteps, type QueueAction, type QueueGroups } from "../../model/workqueue.js";
import { KeyButton, useKeepInView, type KeyHint } from "./parts.js";
import type { QueueEntry } from "./useWorkQueue.js";

/** A row you can focus: an entry, or the line that opens the removed ones. */
export type QueueRow = { readonly kind: "entry"; readonly entry: QueueEntry; readonly position: number | null } | { readonly kind: "removed" };
export const rowId = (row: QueueRow): string => row.kind === "entry" ? row.entry.turnId : "removed";

/** What the list asks of the modal; every action is reachable by key and by click. */
export interface QueueHandlers {
  readonly focus: (id: string) => void;
  readonly act: (action: QueueAction) => void;
  readonly move: (direction: "up" | "down") => void;
  readonly toggleSelect: (id: string) => void;
  readonly selectAll: () => void;
  readonly toggleRemoved: () => void;
  readonly add: () => void;
  readonly close: () => void;
  readonly clearSelection: () => void;
}

/** The focusable rows in the order they are drawn: running, up next, on hold, then the removed ones when open. */
export function queueRows(groups: QueueGroups, showRemoved: boolean): QueueRow[] {
  const waiting = [...groups.upNext, ...groups.held];
  return [
    ...groups.running.map((entry): QueueRow => ({ kind: "entry", entry, position: null })),
    ...waiting.map((entry, at): QueueRow => ({ kind: "entry", entry, position: at + 1 })),
    ...(groups.removed.length ? [{ kind: "removed" } as const] : []),
    ...(showRemoved ? groups.removed.map((entry): QueueRow => ({ kind: "entry", entry, position: null })) : []),
  ];
}

const KEY_OF: Record<QueueAction, string> = { hold: "h", release: "h", conditions: "c", options: "o", remove: "x", restore: "r" };
const LABEL_OF: Record<QueueAction, Parameters<typeof t>[0]> = {
  hold: "queue.action.hold", release: "queue.action.release", conditions: "queue.action.conditions", options: "queue.action.options", remove: "queue.action.remove", restore: "queue.action.restore",
};
export const actionOfKey = (name: string): QueueAction | null => name === "h" ? "hold" : name === "c" ? "conditions" : name === "o" ? "options" : name === "x" ? "remove" : name === "r" ? "restore" : null;

interface Line { readonly key: string; readonly node: ReactNode; readonly focus?: boolean }

function Section({ label, first }: { label: string; first: boolean }) {
  return <box style={{ height: 1, flexShrink: 0, marginTop: first ? 0 : 1 }}><text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{label}</text></box>;
}

/** The row of one entry: its place, title, provider and where it stands. Only the focused one opens up below. */
function EntryHead({ row, focused, checked, widths, now, onPick }: { row: Extract<QueueRow, { kind: "entry" }>; focused: boolean; checked: boolean | null | undefined; widths: { title: number; state: number }; now: number; onPick: () => void }) {
  const hover = useHover();
  const { entry } = row;
  const bg = focused || hover.hovered ? SURFACE.hover : SURFACE.raised;
  const dim = entry.policy.removed === true;
  const place = entry.status === "running" ? "●" : row.position === null ? "·" : String(row.position);
  const state = queueEntryState(entry, now);
  return <box {...hover.handlers} onMouseDown={onPick} style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg}>
    <text fg={COLOR.accent} bg={bg} selectable={false}>{focused ? "▌ " : "  "}</text>
    {checked === undefined ? null : <text fg={checked ? COLOR.accent : COLOR.dim} bg={bg} selectable={false}>{checked === null ? "  " : checked ? "☑ " : "☐ "}</text>}
    <text fg={entry.status === "running" ? COLOR.accent : COLOR.dim} bg={bg} selectable={false}>{place.padStart(2)}</text>
    <text bg={bg} selectable={false}>{"  "}</text>
    <OverflowText fg={dim ? COLOR.dim : focused ? COLOR.bright : COLOR.text} bg={bg} selectable={false} width={widths.title} padToWidth active={focused}>{entry.title}</OverflowText>
    <OverflowText fg={COLOR.dim} bg={bg} selectable={false} width={9} padToWidth prefix=" ">{providerName(entry.provider)}</OverflowText>
    <OverflowText fg={entry.status === "running" ? COLOR.accent : COLOR.faint} bg={bg} selectable={false} width={widths.state}>{state}</OverflowText>
  </box>;
}

function RemovedHead({ focused, open, count, onPick }: { focused: boolean; open: boolean; count: number; onPick: () => void }) {
  const hover = useHover();
  const bg = focused || hover.hovered ? SURFACE.hover : SURFACE.raised;
  return <box {...hover.handlers} onMouseDown={onPick} style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg}>
    <text fg={COLOR.accent} bg={bg} selectable={false}>{focused ? "▌ " : "  "}</text>
    <text fg={focused ? COLOR.bright : COLOR.dim} bg={bg} selectable={false}>{t(open ? "queue.removedHide" : "queue.removedShow", { count })}</text>
  </box>;
}

/**
 * The one list: running work, what is up next, what is on hold, then a line for the removed or stopped
 * entries. The focused entry opens to say what it will do, what it waits for and which keys act on it.
 */
export function QueueList({ groups, rows, focusId, selection, showRemoved, entries, threads, now, width, height, handlers }: {
  groups: QueueGroups;
  rows: readonly QueueRow[];
  focusId: string;
  selection: readonly string[] | null;
  showRemoved: boolean;
  entries: readonly QueueEntry[];
  threads: readonly { id: string; title: string }[];
  now: number;
  width: number;
  height: number;
  handlers: QueueHandlers;
}) {
  const at = Math.max(0, rows.findIndex((row) => rowId(row) === focusId));
  const focusRow = rows[at];
  const selected = selection ? entries.filter((entry) => selection.includes(entry.turnId)) : [];
  const moveTo = (to: number) => { const row = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (row) handlers.focus(rowId(row)); };
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") { if (selection) handlers.clearSelection(); else handlers.close(); return; }
    if (key.ctrl && key.name === "a") { handlers.selectAll(); return; }
    if (key.ctrl && (key.name === "up" || key.name === "down")) { handlers.move(key.name); return; }
    if (key.ctrl || key.meta) return;
    if (key.name === "down") moveTo(at + 1);
    else if (key.name === "up") moveTo(at - 1);
    else if (key.name === "space") { if (focusRow?.kind === "entry") handlers.toggleSelect(focusRow.entry.turnId); }
    else if (key.name === "return" || key.name === "kpenter") { if (focusRow?.kind === "removed") handlers.toggleRemoved(); }
    else if (key.name === "a" && !selection) handlers.add();
    else {
      const action = actionOfKey(key.name);
      if (action) handlers.act(action);
    }
  });

  const waitingCount = groups.upNext.length + groups.held.length;
  const stateWidth = Math.min(24, Math.max(10, ...rows.flatMap((row) => row.kind === "entry" ? [textWidth(queueEntryState(row.entry, now))] : [])));
  const prefix = 2 + (selection ? 2 : 0) + 2 + 2;
  const widths = { title: Math.max(8, width - 1 - prefix - 9 - stateWidth), state: stateWidth };
  const indent = prefix;
  const lines: Line[] = [];
  let sectionCount = 0;
  const section = (label: string) => lines.push({ key: `section:${label}`, node: <Section label={label} first={sectionCount++ === 0} /> });
  const entryLines = (row: Extract<QueueRow, { kind: "entry" }>) => {
    const { entry } = row;
    const focused = rowId(row) === focusId;
    lines.push({ key: entry.turnId, focus: focused, node: <EntryHead row={row} focused={focused} checked={selection ? entry.status === "running" ? null : selection.includes(entry.turnId) : undefined} widths={widths} now={now} onPick={() => handlers.focus(entry.turnId)} /> });
    if (!focused) return;
    const text = (key: string, value: string, fg: string) => lines.push({ key: `${entry.turnId}:${key}`, focus: true, node: <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}><text fg={fg} bg={SURFACE.raised} selectable={false}>{" ".repeat(indent)}</text><OverflowText fg={fg} bg={SURFACE.raised} selectable={false} width={Math.max(8, width - 1 - indent)}>{value}</OverflowText></box> });
    text("about", queueDescription(entry, now), COLOR.dim);
    for (const [i, detail] of queueDetails(entry, threads, entries, now).entries()) text(`d${i}`, `· ${detail}`, entry.policy.removed || entry.blocked.length ? COLOR.text : COLOR.dim);
    if (selected.length > 1) text("scope", t("queue.selected", { count: selected.length }), COLOR.accent);
    const actions = queueActions(entry, selected);
    const hints: KeyHint[] = actions.map((action) => ({ key: KEY_OF[action], label: t(LABEL_OF[action]), onClick: () => handlers.act(action) }));
    if (entry.status === "queued" && !entry.policy.removed && selected.length < 2) {
      if (queueMoveSteps(entries, entry, "up") > 0) hints.push({ key: "ctrl+↑", label: t("queue.action.earlier"), onClick: () => handlers.move("up") });
      if (queueMoveSteps(entries, entry, "down") > 0) hints.push({ key: "ctrl+↓", label: t("queue.action.later"), onClick: () => handlers.move("down") });
    }
    if (hints.length) lines.push({ key: `${entry.turnId}:actions`, focus: true, node: <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 3, flexShrink: 0, marginLeft: indent, width: width - 1 - indent }}>{hints.map((hint) => <KeyButton key={hint.key} hint={hint} tone={hint.key === "x" ? "danger" : "dim"} />)}</box> });
  };
  const group = (label: string, list: readonly QueueEntry[]) => {
    if (!list.length) return;
    section(label);
    for (const entry of list) { const row = rows.find((candidate) => candidate.kind === "entry" && candidate.entry.turnId === entry.turnId); if (row?.kind === "entry") entryLines(row); }
  };
  group(t("queue.section.running"), groups.running);
  group(t("queue.section.upNext"), groups.upNext);
  group(t("queue.section.held"), groups.held);
  if (!waitingCount && !groups.running.length) lines.push({ key: "empty", node: <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("queue.empty")}</text> });
  if (groups.removed.length) {
    lines.push({ key: "removed-gap", node: <box style={{ height: 1, flexShrink: 0 }} /> });
    lines.push({ key: "removed", focus: focusId === "removed", node: <RemovedHead focused={focusId === "removed"} open={showRemoved} count={groups.removed.length} onPick={handlers.toggleRemoved} /> });
    if (showRemoved) for (const entry of groups.removed) { const row = rows.find((candidate) => candidate.kind === "entry" && candidate.entry.turnId === entry.turnId); if (row?.kind === "entry") entryLines(row); }
  }
  const focused = lines.flatMap((line, i) => line.focus ? [i] : []);
  const first = focused[0] ?? 0;
  const ref = useKeepInView(Math.max(0, first - (lines[first - 1]?.key.startsWith("section:") ? 1 : 0)), focused.at(-1) ?? 0, height);
  return <scrollbox ref={ref} style={{ flexGrow: 1 }} stickyStart="top" verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}>
    {lines.map((line) => <box key={line.key} style={{ flexShrink: 0 }}>{line.node}</box>)}
  </scrollbox>;
}

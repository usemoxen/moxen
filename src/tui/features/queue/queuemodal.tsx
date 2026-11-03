import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ClientApi } from "../../../server/api.js";
import { t, type MessageKey } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { useHover } from "../../hooks/useHover.js";
import { ModalShell } from "../../ui/modalshell.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { DateTimeModal } from "../../ui/datetimemodal.js";
import { useWorkQueue, type QueueCondition, type QueueEntry, type QueuePolicy } from "./useWorkQueue.js";
import {
  editableQueueSelection, queueActions, queueConditionText, queueDescription, queueEntryState, queueHeadline, queueProviders, queueReasons, queueWindows,
  type QueueAction, type QueueWindow,
} from "../../model/workqueue.js";

function EntryRow({ entry, position, active, checked, width, onPick }: { entry: QueueEntry; position: number | null; active: boolean; checked: boolean | null; width: number; onPick: () => void }) {
  const hover = useHover();
  const mark = checked === null ? "" : checked ? "☑ " : "☐ ";
  const dim = entry.policy.removed;
  return <box {...hover.handlers} onMouseDown={onPick} style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1, height: 2, flexShrink: 0 }} backgroundColor={active || hover.hovered ? SURFACE.hover : SURFACE.raised}>
    <OverflowText fg={dim ? COLOR.dim : active ? COLOR.bright : COLOR.text} bg={active || hover.hovered ? SURFACE.hover : SURFACE.raised} width={width - 2}>{`${mark}${position === null ? "" : `${position}. `}${entry.title}`}</OverflowText>
    <OverflowText fg={COLOR.dim} bg={active || hover.hovered ? SURFACE.hover : SURFACE.raised} width={width - 2}>{`${checked === null ? "" : "  "}${entry.provider} · ${queueEntryState(entry)}`}</OverflowText>
  </box>;
}

const ACTION_LABEL: Record<QueueAction, MessageKey> = {
  first: "protection.first", last: "protection.last", up: "queue.up", down: "queue.down",
  hold: "queue.hold", release: "queue.release", remove: "queue.remove", restore: "queue.restore",
};

export function WorkQueueModal({ client, threads, screenWidth, screenHeight, onClose, onSchedule }: {
  client: ClientApi;
  threads: readonly { id: string; title: string }[];
  screenWidth: number; screenHeight: number;
  onClose: () => void;
  onSchedule?: (policy: QueuePolicy) => void;
}) {
  const queue = useWorkQueue(client);
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [showRemoved, setShowRemoved] = useState(false);
  const [draft, setDraft] = useState<QueuePolicy>({ conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread" });
  const [type, setType] = useState<QueueCondition["type"]>("reset");
  const [provider, setProvider] = useState("codex");
  const [window, setWindow] = useState<QueueWindow>("session");
  const [minimum, setMinimum] = useState("10");
  const [after, setAfter] = useState(true);
  const [protectedState, setProtectedState] = useState(false);
  const [targetIndex, setTargetIndex] = useState(0);
  const [datePicker, setDatePicker] = useState(false);
  const [adding, setAdding] = useState(false);
  const now = Date.now();
  const live = queue.entries.filter((entry) => !entry.policy.removed);
  const removed = queue.entries.filter((entry) => entry.policy.removed);
  const rows = [...live, ...(showRemoved ? removed : [])];
  const active = rows[Math.min(index, Math.max(0, rows.length - 1))];
  const activeLive = active === undefined ? -1 : live.findIndex((entry) => entry.turnId === active.turnId);
  const multi = live.length > 1;
  const selected = multi ? rows.filter((entry) => checked.includes(entry.turnId)) : [];
  const targets = editableQueueSelection(rows, selected.length ? checked : [], active?.turnId);
  const policy = onSchedule ? draft : active?.status === "running" ? undefined : active?.policy;
  const width = Math.min(112, Math.max(36, screenWidth - 4));
  const height = Math.max(12, Math.min(36, screenHeight - 2));
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(0, Math.floor((screenHeight - height) / 2));
  const wide = width >= 82 && !onSchedule;
  const listWidth = wide ? 38 : width - 4;
  const inner = Math.max(10, width - 4);
  const change = (fn: (value: QueuePolicy) => QueuePolicy) => onSchedule ? setDraft(fn) : void queue.edit(targets, "edit", fn);
  const addCondition = (condition: QueueCondition) => { change((value) => ({ ...value, conditions: [...value.conditions, condition] })); setAdding(false); };
  const types: readonly QueueCondition["type"][] = ["reset", "usage", "provider", "thread", "entry", "at"];
  const providers = queueProviders(queue.limits);
  const chosenProvider = providers.includes(provider) ? provider : providers[0]!;
  const windows = queueWindows(queue.limits, chosenProvider);
  const chosenWindow = windows.includes(window) ? window : windows[0]!;
  const dependencies = threads.filter((thread) => onSchedule || thread.id !== active?.threadId);
  const dependency = dependencies[targetIndex % Math.max(1, dependencies.length)];
  const addTarget = threads[targetIndex % Math.max(1, threads.length)];
  const entryDependencies = queue.entries.filter((entry) => entry.turnId !== active?.turnId);
  const entryDependency = entryDependencies[targetIndex % Math.max(1, entryDependencies.length)];
  useKeyboard((key) => {
    if (datePicker) return;
    if (key.name === "escape" || key.name === "esc") { onClose(); return; }
    if (onSchedule) return;
    if (key.ctrl && (key.name === "up" || key.name === "down")) { void queue.edit(key.name === "down" ? [...targets].reverse() : targets, key.name); return; }
    if (key.name === "down") setIndex((value) => Math.max(0, Math.min(value + 1, rows.length - 1)));
    if (key.name === "up") setIndex((value) => Math.max(0, value - 1));
    if (key.name === "space" && active && multi) setChecked((value) => value.includes(active.turnId) ? value.filter((id) => id !== active.turnId) : [...value, active.turnId]);
  });
  if (datePicker) return <DateTimeModal screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={12} onClose={() => setDatePicker(false)} onSubmit={(at) => { addCondition({ type: "at", at: at.toISOString() }); setDatePicker(false); }} />;
  const button = (label: string, onClick: () => void, dim = false) => <HoverButton label={label} fg={dim ? COLOR.dim : COLOR.accent} onClick={onClick} />;
  const run = (action: QueueAction) => {
    if (action === "first" || action === "down") void queue.edit([...targets].reverse(), action);
    else void queue.edit(targets, action);
  };
  const resetSelection = () => { setIndex(0); setChecked([]); };
  const continuation = policy?.continuation ?? "same-thread";
  const header = <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1, flexShrink: 0 }}>
    <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t(onSchedule ? "queue.schedule" : "queue.title")}</text>
    <HoverButton label={t("queue.close")} fg={COLOR.faint} onClick={onClose} />
  </box>;
  const hint = onSchedule ? t("queue.scheduleHint") : t(multi ? "queue.hintMany" : "queue.hint");

  const list = !onSchedule ? <box style={{ width: wide ? listWidth : "100%", height: wide ? "100%" : 9, flexDirection: "column", flexShrink: 0 }}>
    {multi ? <box style={{ flexDirection: "row", gap: 2, height: 1, flexShrink: 0, marginBottom: 1 }}>
      {button(t("queue.selectAll"), () => setChecked(live.map((entry) => entry.turnId)))}
      {checked.length ? button(t("queue.clearSelection"), () => setChecked([]), true) : null}
    </box> : null}
    <scrollbox style={{ flexGrow: 1 }}>
      {live.length ? live.map((entry, i) => <EntryRow key={entry.turnId} entry={entry} position={i + 1} active={entry.turnId === active?.turnId} checked={multi ? checked.includes(entry.turnId) : null} width={listWidth} onPick={() => setIndex(i)} />) : <text fg={COLOR.dim}>{t("queue.empty")}</text>}
      {removed.length ? <box style={{ height: 1, flexShrink: 0, marginTop: 1 }}>{button(t(showRemoved ? "queue.removedHide" : "queue.removedShow", { count: removed.length }), () => { setShowRemoved(!showRemoved); resetSelection(); }, true)}</box> : null}
      {showRemoved ? removed.map((entry, i) => <EntryRow key={entry.turnId} entry={entry} position={null} active={entry.turnId === active?.turnId} checked={null} width={listWidth} onPick={() => setIndex(live.length + i)} />) : null}
    </scrollbox>
  </box> : null;

  const actions = !onSchedule && active ? queueActions(active, activeLive, live.length, selected) : [];
  const editor = <box style={{ flexDirection: "column", gap: 1, marginTop: 1 }}>
    {button(t(`queue.condition.${type}`), () => setType(types[(types.indexOf(type) + 1) % types.length]!))}
    {type === "reset" || type === "usage" || type === "provider" ? <box style={{ flexDirection: "row", gap: 2 }}>
      {button(`${chosenProvider} ›`, () => setProvider(providers[(providers.indexOf(chosenProvider) + 1) % providers.length]!))}
      {type !== "provider"
        ? button(t(chosenWindow === "session" ? "queue.session" : chosenWindow === "weekly" ? "queue.weekly" : "queue.allWindows"), () => setWindow(windows[(windows.indexOf(chosenWindow) + 1) % windows.length]!))
        : <>{button(t(after ? "queue.after" : "queue.while"), () => setAfter(!after))}{button(t(protectedState ? "queue.protected" : "queue.exhausted"), () => setProtectedState(!protectedState))}</>}
    </box> : null}
    {type === "usage" ? <box style={{ flexDirection: "row", gap: 1 }}><text fg={COLOR.dim}>{t("queue.minimum")}</text><input width={6} value={minimum} onInput={setMinimum} focused backgroundColor={SURFACE.hover} textColor={COLOR.text} /><text fg={COLOR.dim}>%</text></box> : null}
    {type === "thread" ? button(dependency?.title ?? t("queue.chooseThread"), () => setTargetIndex((value) => value + 1)) : null}
    {type === "entry" ? button(entryDependency?.title ?? t("queue.chooseEntry"), () => setTargetIndex((value) => value + 1)) : null}
    <box style={{ flexDirection: "row", gap: 2 }}>
      {button(t("queue.addCondition"), () => {
        if (type === "at") setDatePicker(true);
        else if (type === "reset") addCondition({ type, provider: chosenProvider, window: chosenWindow, resetsAt: null });
        else if (type === "usage" && /^\d{1,3}$/.test(minimum) && Number(minimum) <= 100) addCondition({ type, provider: chosenProvider, window: chosenWindow, minimum: Number(minimum) });
        else if (type === "provider") addCondition({ type, provider: chosenProvider, state: protectedState ? "protected" : "exhausted", mode: after ? "after" : "while" });
        else if (type === "thread" && dependency) addCondition({ type, threadId: dependency.id });
        else if (type === "entry" && entryDependency) addCondition({ type, threadId: entryDependency.threadId, turnId: entryDependency.turnId });
      })}
      {!onSchedule ? button(t("queue.cancelAdd"), () => setAdding(false), true) : null}
    </box>
  </box>;

  const detail = <scrollbox style={{ flexGrow: 1 }}>
    {!onSchedule && active ? <>
      <text fg={COLOR.bright}>{active.title}</text>
      <text fg={COLOR.dim} wrapMode="word">{queueDescription(active, now)}</text>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {queueReasons(active, now).map((reason, i) => <text key={i} fg={active.status === "running" || !active.blocked.length ? COLOR.dim : COLOR.warn} wrapMode="word">{reason}</text>)}
      </box>
      {selected.length ? <text fg={COLOR.dim} style={{ marginTop: 1 }}>{t("queue.scope", { count: selected.length })}</text> : null}
      {actions.length ? <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginTop: 1 }}>{actions.map((action) => button(t(ACTION_LABEL[action]), () => run(action), action === "remove"))}</box> : null}
    </> : null}
    {policy ? <>
      {!onSchedule ? <text fg={COLOR.bright} style={{ marginTop: 1 }}>{t("queue.how")}</text> : null}
      <box style={{ flexDirection: "column" }}>
        <text fg={COLOR.text} wrapMode="word">{t(policy.sequential ? "queue.sequential" : "queue.parallel")}</text>
        {button(t(policy.sequential ? "queue.changeParallel" : "queue.changeSequential"), () => change((value) => ({ ...value, sequential: !policy.sequential })))}
        <text fg={COLOR.text} wrapMode="word" style={{ marginTop: 1 }}>{t(continuation === "same-thread" ? "queue.same" : continuation === "stored" ? "queue.stored" : "queue.model")}</text>
        {button(t(continuation === "same-thread" ? "queue.changeStored" : continuation === "stored" ? "queue.changeModel" : "queue.changeSame"), () => change((value) => ({ ...value, continuation: continuation === "same-thread" ? "stored" : continuation === "stored" ? "model" : "same-thread" })))}
      </box>
      <text fg={COLOR.bright} style={{ marginTop: 1 }}>{t("queue.conditions")}</text>
      {!policy.conditions.length ? <text fg={COLOR.dim}>{t("queue.noConditions")}</text> : policy.conditions.map((condition, i) => <box key={i} style={{ flexDirection: "row", gap: 1 }}><text fg={COLOR.text} style={{ flexGrow: 1 }} wrapMode="word">{queueConditionText(condition, threads, queue.entries, now)}</text>{button("×", () => change((value) => ({ ...value, conditions: value.conditions.filter((other) => JSON.stringify(other) !== JSON.stringify(condition)) })), true)}</box>)}
      {onSchedule || adding ? editor : <box style={{ marginTop: 1 }}>{button(t("queue.addOpen"), () => setAdding(true))}</box>}
      {onSchedule ? <box style={{ marginTop: 1 }}>{button(t("queue.submit"), () => onSchedule(draft))}</box> : null}
    </> : null}
  </scrollbox>;

  return <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
    {header}
    {!onSchedule ? <OverflowText fg={COLOR.dim} bg={SURFACE.raised} width={inner}>{queueHeadline(queue.entries, now)}</OverflowText> : null}
    {queue.error ? <text fg={COLOR.danger}>{queue.error}</text> : null}
    <box style={{ flexDirection: wide ? "row" : "column", flexGrow: 1, marginTop: 1, gap: wide ? 2 : 1 }}>
      {list}
      {detail}
    </box>
    {!onSchedule && threads.length ? <box style={{ flexDirection: "row", gap: 2, height: 1, flexShrink: 0, marginTop: 1 }}>
      <text fg={COLOR.dim} selectable={false}>{t("queue.addLabel")}</text>
      <HoverButton label={`${addTarget?.title ?? t("queue.chooseThread")} ›`} width={Math.min(28, inner - 30)} fg={COLOR.accent} onClick={() => setTargetIndex((value) => value + 1)} />
      {button(t("queue.addThread"), () => { if (addTarget) void queue.add(addTarget.id, t("queue.resumePrompt")); })}
    </box> : null}
    <box style={{ height: 1, flexShrink: 0, marginTop: 1 }}>
      {queue.saving ? <text fg={COLOR.dim} selectable={false}>{t("queue.saving")}</text> : <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={inner}>{hint}</OverflowText>}
    </box>
  </ModalShell>;
}

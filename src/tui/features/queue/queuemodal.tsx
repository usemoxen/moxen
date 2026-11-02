import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ClientApi } from "../../../server/api.js";
import { t, tx } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { useHover } from "../../hooks/useHover.js";
import { ModalShell } from "../../ui/modalshell.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { DateTimeModal } from "../../ui/datetimemodal.js";
import { useWorkQueue, type QueueCondition, type QueueEntry, type QueuePolicy } from "./useWorkQueue.js";
import { editableQueueSelection, queueConditionText } from "../../model/workqueue.js";

function EntryRow({ entry, position, active, checked, onPick }: { entry: QueueEntry; position: number; active: boolean; checked: boolean; onPick: () => void }) {
  const hover = useHover();
  return <box {...hover.handlers} onMouseDown={onPick} style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1, height: 3, flexShrink: 0 }} backgroundColor={active || hover.hovered ? SURFACE.hover : SURFACE.raised}>
    <text fg={active ? COLOR.bright : COLOR.text} selectable={false}>{`${checked ? "☑" : "☐"} ${position}. ${entry.title}`}</text>
    <text fg={COLOR.dim} selectable={false}>{`${entry.provider} · ${entry.policy.removed ? t("queue.removed") : entry.policy.held ? t("queue.onHold") : entry.status === "running" ? t("queue.running") : entry.blocked.length ? t("queue.waiting") : t("queue.ready")}`}</text>
  </box>;
}

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
  const [window, setWindow] = useState<"session" | "weekly">("session");
  const [minimum, setMinimum] = useState("10");
  const [after, setAfter] = useState(true);
  const [protectedState, setProtectedState] = useState(false);
  const [targetIndex, setTargetIndex] = useState(0);
  const [datePicker, setDatePicker] = useState(false);
  const visibleEntries = queue.entries.filter((entry) => showRemoved ? entry.policy.removed : !entry.policy.removed);
  const active = visibleEntries[Math.min(index, Math.max(0, visibleEntries.length - 1))];
  const targets = editableQueueSelection(visibleEntries, checked, active?.turnId);
  const policy = onSchedule ? draft : active?.policy;
  const width = Math.min(112, Math.max(36, screenWidth - 4));
  const height = Math.max(12, Math.min(36, screenHeight - 2));
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(0, Math.floor((screenHeight - height) / 2));
  const change = (fn: (value: QueuePolicy) => QueuePolicy) => onSchedule ? setDraft(fn) : void queue.edit(targets, "edit", fn);
  const addCondition = (condition: QueueCondition) => change((value) => ({ ...value, conditions: [...value.conditions, condition] }));
  const types: readonly QueueCondition["type"][] = ["reset", "usage", "provider", "thread", "entry", "at"];
  const providers = [...new Set(["claude", "codex", "opencode", "harness", ...queue.entries.map((entry) => entry.provider)])];
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
    if (key.name === "down") setIndex((value) => Math.max(0, Math.min(value + 1, visibleEntries.length - 1)));
    if (key.name === "up") setIndex((value) => Math.max(0, value - 1));
    if (key.name === "space" && active) setChecked((value) => value.includes(active.turnId) ? value.filter((id) => id !== active.turnId) : [...value, active.turnId]);
  });
  if (datePicker) return <DateTimeModal screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={12} onClose={() => setDatePicker(false)} onSubmit={(at) => { addCondition({ type: "at", at: at.toISOString() }); setDatePicker(false); }} />;
  const button = (label: string, onClick: () => void, dim = false) => <HoverButton label={label} fg={dim ? COLOR.dim : COLOR.accent} onClick={onClick} />;
  return <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
    <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1, flexShrink: 0 }}><text fg={COLOR.bright}>{t(onSchedule ? "queue.schedule" : "queue.title")}</text>{button(t("queue.close"), onClose, true)}</box>
    <text fg={COLOR.dim} selectable={false}>{t(onSchedule ? "queue.scheduleHint" : "queue.hint")}</text>
    {queue.error ? <text fg={COLOR.danger}>{queue.error}</text> : null}
    <box style={{ flexDirection: width >= 82 && !onSchedule ? "row" : "column", flexGrow: 1, marginTop: 1, gap: 2 }}>
      {!onSchedule ? <box style={{ width: width >= 82 ? 36 : "100%", height: width >= 82 ? "100%" : 7, flexDirection: "column", flexShrink: 0 }}>
        <box style={{ height: 1, flexShrink: 0 }}>{button(t(showRemoved ? "queue.activeTab" : "queue.removedTab", { count: queue.entries.filter((entry) => entry.policy.removed).length }), () => { setShowRemoved(!showRemoved); setIndex(0); setChecked([]); })}</box>
        <box style={{ flexDirection: "row", gap: 2, height: 1, flexShrink: 0 }}>{button(t("queue.selectAll"), () => setChecked(visibleEntries.map((e) => e.turnId)))}{button(t("queue.clearSelection"), () => setChecked([]), true)}</box>
        <scrollbox style={{ flexGrow: 1 }}>
          {visibleEntries.length ? visibleEntries.map((entry, i) => <EntryRow key={entry.turnId} entry={entry} position={i + 1} active={entry.turnId === active?.turnId} checked={checked.includes(entry.turnId)} onPick={() => setIndex(i)} />) : <text fg={COLOR.dim}>{t("queue.empty")}</text>}
        </scrollbox>
        <box style={{ flexDirection: "row", gap: 2, height: 1, flexShrink: 0 }}><HoverButton label={addTarget?.title ?? t("queue.chooseThread")} width={18} fg={COLOR.accent} onClick={() => setTargetIndex((value) => value + 1)} />{button(t("queue.addThread"), () => { if (addTarget) void queue.add(addTarget.id, t("queue.resumePrompt")); })}</box>
      </box> : null}
      <scrollbox style={{ flexGrow: 1 }}>
        {!onSchedule && active ? <>
          <text fg={COLOR.bright}>{active.title}</text>
          <text fg={COLOR.dim}>{active.prompt.slice(0, 240)}</text>
          <text fg={active.blocked.length ? COLOR.warn : COLOR.dim}>{active.blocked.map(tx).join(" · ") || t("queue.ready")}</text>
          <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginTop: 1 }}>
            {button(t("protection.first"), () => void queue.edit([...targets].reverse(), "first"))}
            {button(t("protection.last"), () => void queue.edit(targets, "last"))}
            {button(t("queue.up"), () => void queue.edit(targets, "up"))}
            {button(t("queue.down"), () => void queue.edit([...targets].reverse(), "down"))}
            {button(t("queue.hold"), () => void queue.edit(targets, "hold"))}
            {button(t("queue.release"), () => void queue.edit(targets, "release"))}
            {button(t("queue.remove"), () => void queue.edit(targets, "remove"), true)}
            {active.policy.removed ? button(t("queue.restore"), () => void queue.edit(targets, "restore")) : null}
          </box>
        </> : null}
        {policy ? <>
          <text fg={COLOR.dim}>{t("queue.scope", { count: onSchedule ? 1 : targets.length })}</text>
          <box style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginTop: 1 }}>
            {button(t(policy.sequential ? "queue.sequential" : "queue.parallel"), () => change((value) => ({ ...value, sequential: !policy.sequential })))}
            {button(t(policy.continuation === "same-thread" ? "queue.same" : policy.continuation === "stored" ? "queue.stored" : "queue.model"), () => change((value) => ({ ...value, continuation: policy.continuation === "same-thread" ? "stored" : policy.continuation === "stored" ? "model" : "same-thread" })))}
          </box>
          <text fg={COLOR.dim}>{t("queue.summaryHint")}</text>
          <text fg={COLOR.bright}>{t("queue.conditions")}</text>
          {!policy.conditions.length ? <text fg={COLOR.dim}>{t("queue.noConditions")}</text> : policy.conditions.map((condition, i) => <box key={i} style={{ flexDirection: "row", gap: 1 }}><text fg={COLOR.text} style={{ flexGrow: 1 }}>{queueConditionText(condition, threads, queue.entries)}</text>{button("×", () => change((value) => ({ ...value, conditions: value.conditions.filter((other) => JSON.stringify(other) !== JSON.stringify(condition)) })), true)}</box>)}
          <box style={{ flexDirection: "column", gap: 1, marginTop: 1 }}>
            {button(t(`queue.condition.${type}`), () => setType(types[(types.indexOf(type) + 1) % types.length]!))}
            {type === "reset" || type === "usage" || type === "provider" ? <box style={{ flexDirection: "row", gap: 2 }}>{button(provider, () => setProvider(providers[(providers.indexOf(provider) + 1) % providers.length]!))}{type !== "provider" ? button(t(window === "session" ? "queue.session" : "queue.weekly"), () => setWindow((value) => value === "session" ? "weekly" : "session")) : <>{button(t(after ? "queue.after" : "queue.while"), () => setAfter(!after))}{button(t(protectedState ? "queue.protected" : "queue.exhausted"), () => setProtectedState(!protectedState))}</>}</box> : null}
            {type === "usage" ? <box style={{ flexDirection: "row", gap: 1 }}><text fg={COLOR.dim}>{t("queue.minimum")}</text><input width={6} value={minimum} onInput={setMinimum} focused backgroundColor={SURFACE.hover} textColor={COLOR.text} /><text fg={COLOR.dim}>%</text></box> : null}
            {type === "thread" ? button(dependency?.title ?? t("queue.chooseThread"), () => setTargetIndex((value) => value + 1)) : null}
            {type === "entry" ? button(entryDependency?.title ?? t("queue.chooseEntry"), () => setTargetIndex((value) => value + 1)) : null}
            {button(t("queue.addCondition"), () => {
              if (type === "at") setDatePicker(true);
              else if (type === "reset") addCondition({ type, provider, window, resetsAt: null });
              else if (type === "usage" && /^\d{1,3}$/.test(minimum) && Number(minimum) <= 100) addCondition({ type, provider, window, minimum: Number(minimum) });
              else if (type === "provider") addCondition({ type, provider, state: protectedState ? "protected" : "exhausted", mode: after ? "after" : "while" });
              else if (type === "thread" && dependency) addCondition({ type, threadId: dependency.id });
              else if (type === "entry" && entryDependency) addCondition({ type, threadId: entryDependency.threadId, turnId: entryDependency.turnId });
            })}
          </box>
          {onSchedule ? <box style={{ marginTop: 1 }}>{button(t("queue.submit"), () => onSchedule(draft))}</box> : null}
        </> : null}
      </scrollbox>
    </box>
    {queue.saving ? <text fg={COLOR.dim}>{t("queue.saving")}</text> : null}
  </ModalShell>;
}

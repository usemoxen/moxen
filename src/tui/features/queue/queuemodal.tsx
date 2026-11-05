import { useEffect, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { ClientApi } from "../../../server/api.js";
import { t, type MessageKey } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { ModalShell } from "../../ui/modalshell.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { DateTimeModal } from "../../ui/datetimemodal.js";
import { PickerModal } from "../pickers/pickermodal.js";
import { useWorkQueue, type QueueCondition, type QueueEntry, type QueuePolicy } from "./useWorkQueue.js";
import { ChoiceList, KeyHints, type Choice, type KeyHint } from "./parts.js";
import { QueueList, queueRows, rowId, type QueueHandlers } from "./queuelist.js";
import {
  editableQueueSelection, providerName, queueConditionText, queueGroups, queueHeadline, queueMoveSteps, queueProviders, queueWindows,
  type QueueAction, type QueueWindow,
} from "../../model/workqueue.js";

/** The steps of choosing a condition, and the other screens the modal opens over the list. */
type Screen =
  | { readonly name: "conditions" }
  | { readonly name: "options" }
  | { readonly name: "provider"; readonly kind: "reset" | "usage" | "provider" }
  | { readonly name: "window"; readonly kind: "reset" | "usage"; readonly provider: string }
  | { readonly name: "minimum"; readonly provider: string; readonly window: QueueWindow }
  | { readonly name: "state"; readonly provider: string }
  | { readonly name: "mode"; readonly provider: string; readonly state: "exhausted" | "protected" }
  | { readonly name: "thread" }
  | { readonly name: "entry" }
  | { readonly name: "date" }
  | { readonly name: "add" };

const DEFAULT_POLICY: QueuePolicy = { conditions: [], held: false, order: 0, sequential: true, continuation: "same-thread" };

/** "At least [ 10 ] %": a number from 0 to 100, enter adds the condition. */
function MinimumStep({ onSubmit }: { onSubmit: (minimum: number) => void }) {
  const [text, setText] = useState("10");
  const valid = /^\d{1,3}$/u.test(text) && Number(text) <= 100;
  useKeyboard((key) => { if (key.name === "return" || key.name === "kpenter") { if (valid) onSubmit(Number(text)); } });
  return <box style={{ flexDirection: "column", flexGrow: 1 }}>
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, gap: 1 }}>
      <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("queue.minimum")}</text>
      <input width={4} focused value={text} maxLength={3} onInput={setText} backgroundColor={SURFACE.hover} focusedBackgroundColor={SURFACE.hover} textColor={COLOR.text} focusedTextColor={COLOR.bright} />
      <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{"%"}</text>
    </box>
    {valid ? null : <text fg={COLOR.danger} bg={SURFACE.raised} selectable={false}>{t("queue.minimumInvalid")}</text>}
    <box style={{ height: 1, flexShrink: 0, marginTop: 1 }}><HoverButton label={t("queue.cond.add")} fg={valid ? COLOR.accent : COLOR.faint} onClick={() => { if (valid) onSubmit(Number(text)); }} /></box>
  </box>;
}

export function WorkQueueModal({ client, threads, screenWidth, screenHeight, onClose, onSchedule }: {
  client: ClientApi;
  threads: readonly { id: string; title: string }[];
  screenWidth: number; screenHeight: number;
  onClose: () => void;
  /** Schedule work instead of managing the queue: the page collects a policy and hands it back. */
  onSchedule?: (policy: QueuePolicy) => void;
}) {
  const queue = useWorkQueue(client);
  const [focusId, setFocusId] = useState("");
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [stack, setStack] = useState<readonly Screen[]>([]);
  const [draft, setDraft] = useState<QueuePolicy>({ ...DEFAULT_POLICY, order: Date.now() });
  const [filter, setFilter] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const screen = stack.at(-1) ?? null;
  const push = (next: Screen) => { setFilter(""); setStack((value) => [...value, next]); };
  const pop = () => { setFilter(""); setStack((value) => value.slice(0, -1)); };
  const home = () => { setFilter(""); setStack([]); };
  const close = () => { markModalDismissed(); onClose(); };

  const groups = queueGroups(queue.entries);
  const rows = queueRows(groups, showRemoved);
  // Nothing focused yet: start on the first entry that is not running, the one you are most likely to change.
  const focusRow = rows.find((row) => rowId(row) === focusId) ?? rows.find((row) => row.kind === "entry" && row.entry.status !== "running") ?? rows[0];
  const focus = focusRow?.kind === "entry" ? focusRow.entry : undefined;
  const targets = onSchedule ? [] : editableQueueSelection(queue.entries, selection ?? [], focus?.turnId);
  const subject = onSchedule ? null : targets.length > 1 ? t("queue.cond.titleMany", { count: targets.length }) : focus ? t("queue.cond.title", { title: focus.title }) : null;

  const width = Math.min(100, Math.max(40, screenWidth - 4));
  const height = Math.max(14, Math.min(36, screenHeight - 2));
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(0, Math.floor((screenHeight - height) / 2));
  const inner = Math.max(10, width - 4);
  const bodyHeight = Math.max(3, height - 7 - (queue.error ? 1 : 0));

  const policy = onSchedule ? draft : focus?.policy ?? DEFAULT_POLICY;
  const change = (fn: (value: QueuePolicy) => QueuePolicy) => { if (onSchedule) setDraft(fn); else void queue.edit(targets, "edit", fn); };
  const addCondition = (condition: QueueCondition) => { change((value) => ({ ...value, conditions: [...value.conditions, condition] })); home(); };
  const providers = queueProviders(queue.limits);
  const conditionThreads = threads.filter((thread) => onSchedule || !targets.some((target) => target.threadId === thread.id));
  const conditionEntries = queue.entries.filter((entry) => !targets.some((target) => target.turnId === entry.turnId));

  // What the keys and clicks on the list do. A selection acts as a whole; otherwise the focused entry does.
  const act = (action: QueueAction) => {
    if (action === "conditions" || action === "options") { if (targets.length) push({ name: action }); return; }
    const live = targets.filter((target) => !target.policy.removed);
    if (action === "restore") { const removed = targets.filter((target) => target.policy.removed); if (removed.length) void queue.edit(removed, "restore"); }
    else if (action === "remove") {
      if (!live.length) return;
      // Start from the row that is drawn focused: before any arrow, that is the fallback row, not focusId.
      const at = rows.findIndex((row) => row === focusRow);
      const next = rows.slice(at + 1).concat(rows.slice(0, at).reverse()).find((row) => row.kind === "entry" && !live.some((target) => target.turnId === row.entry.turnId));
      if (next) setFocusId(rowId(next));
      setSelection(null);
      void queue.edit(live, "remove");
    } else if (live.length) {
      const hold = live.some((target) => !target.policy.held);
      void queue.edit(hold ? live.filter((target) => !target.policy.held) : live, hold ? "hold" : "release");
    }
  };
  const handlers: QueueHandlers = {
    focus: setFocusId,
    act,
    move: (direction) => { if (focus) void queue.edit(Array.from({ length: queueMoveSteps(queue.entries, focus, direction) }, () => focus), direction); },
    toggleSelect: (id) => setSelection((value) => value === null ? [id] : value.includes(id) ? value.filter((other) => other !== id) : [...value, id]),
    selectAll: () => setSelection(queue.entries.filter((entry) => entry.status !== "running" && (showRemoved || !entry.policy.removed)).map((entry) => entry.turnId)),
    toggleRemoved: () => setShowRemoved((value) => !value),
    add: () => push({ name: "add" }),
    close,
    clearSelection: () => setSelection(null),
  };

  const pickerGeometry = { screenWidth, screenHeight, left, top, width, height };
  if (screen?.name === "date") return <DateTimeModal title={t("queue.cond.at.title")} screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={12} onClose={pop} onSubmit={(at) => addCondition({ type: "at", at: at.toISOString() })} />;
  if (screen?.name === "add" || screen?.name === "thread") {
    const adding = screen.name === "add";
    const rowsOf = (adding ? threads : conditionThreads).map((thread) => ({ key: thread.id, label: thread.title, onPick: () => { if (adding) { void queue.add(thread.id, t("queue.resumePrompt")); home(); } else addCondition({ type: "thread", threadId: thread.id }); } }));
    return <PickerModal title={t(adding ? "queue.add.title" : "queue.ask.thread")} body={{ kind: "list", sections: [{ rows: rowsOf }] }} filter={filter} onFilterChange={setFilter} filterable emptyLabel={t("queue.threads.none")} {...pickerGeometry} onClose={pop} />;
  }

  // The screens that share the modal's frame: each is a plain list, or the one number to type.
  const windowChoice = (window: QueueWindow): string => t(window === "session" ? "queue.window.session" : window === "weekly" ? "queue.window.weekly" : "queue.window.all");
  let heading = t(onSchedule ? "queue.schedule" : "queue.title");
  let sub: string | null = null;
  let hints: KeyHint[] = [];
  let body: ReactNode = null;
  const choose = (name: MessageKey): KeyHint[] => [{ key: "↑↓", label: t("queue.key.choose") }, { key: "enter", label: t(name) }, { key: "esc", label: t("queue.key.back"), onClick: pop }];
  const list = (choices: Choice[], empty?: string) => <ChoiceList choices={choices} width={inner} height={bodyHeight} onBack={pop} {...(empty ? { emptyText: empty } : {})} />;
  const remove = (condition: QueueCondition): Choice => ({ key: `remove:${JSON.stringify(condition)}`, label: queueConditionText(condition, threads, queue.entries, now), detail: t("queue.cond.removeDetail"), onPick: () => { change((value) => ({ ...value, conditions: value.conditions.filter((other) => JSON.stringify(other) !== JSON.stringify(condition)) })); } });
  const conditionKinds = (): Choice[] => [
    { key: "reset", label: t("queue.cond.reset"), onPick: () => push({ name: "provider", kind: "reset" }) },
    { key: "usage", label: t("queue.cond.usage"), onPick: () => push({ name: "provider", kind: "usage" }) },
    { key: "at", label: t("queue.cond.at"), onPick: () => push({ name: "date" }) },
    { key: "thread", label: t("queue.cond.thread"), onPick: () => push({ name: "thread" }) },
    { key: "entry", label: t("queue.cond.entry"), onPick: () => push({ name: "entry" }) },
    { key: "provider", label: t("queue.cond.provider"), onPick: () => push({ name: "provider", kind: "provider" }) },
  ];
  const currentConditions = targets.length > 1 ? [] : policy.conditions;
  const optionRow = (key: string, label: string, detail: string | undefined, current: boolean, apply: (value: QueuePolicy) => QueuePolicy): Choice => ({ key, label, current, ...(detail ? { detail } : {}), onPick: () => change(apply) });

  if (screen === null && onSchedule) {
    sub = t("queue.scheduleHint");
    hints = [{ key: "↑↓", label: t("queue.key.choose") }, { key: "enter", label: t("queue.key.pick") }, { key: "esc", label: t("queue.key.close"), onClick: close }];
    body = <ChoiceList width={inner} height={bodyHeight} onBack={close} choices={[
      { key: "add", label: t("queue.schedule.add"), onPick: () => push({ name: "conditions" }) },
      { key: "options", label: t("queue.schedule.options"), onPick: () => push({ name: "options" }) },
      ...(draft.conditions.length ? [{ key: "h", label: t("queue.cond.remove"), header: true }, ...draft.conditions.map(remove)] : []),
      { key: "submit", label: t("queue.submit"), onPick: () => onSchedule(draft) },
    ]} />;
  } else if (screen === null) {
    sub = queueHeadline(queue.entries, now);
    hints = selection
      ? [{ key: "↑↓", label: t("queue.key.choose") }, { key: "space", label: t("queue.key.toggle"), onClick: () => focus && handlers.toggleSelect(focus.turnId) }, { key: "ctrl+a", label: t("queue.key.all"), onClick: handlers.selectAll }, { key: "esc", label: t("queue.key.done"), onClick: handlers.clearSelection }]
      : [{ key: "↑↓", label: t("queue.key.choose") }, { key: "ctrl+↑↓", label: t("queue.key.move") }, { key: "space", label: t("queue.key.select"), onClick: () => focus && handlers.toggleSelect(focus.turnId) }, { key: "a", label: t("queue.key.add"), onClick: handlers.add }, { key: "esc", label: t("queue.key.close"), onClick: close }];
    body = <QueueList groups={groups} rows={rows} focusId={focusRow ? rowId(focusRow) : ""} selection={selection} showRemoved={showRemoved} entries={queue.entries} threads={threads} now={now} width={inner} height={bodyHeight} handlers={handlers} />;
  } else if (screen.name === "conditions") {
    heading = subject ?? t("queue.schedule");
    hints = choose("queue.key.next");
    body = list([...conditionKinds(), ...(currentConditions.length ? [{ key: "h", label: t("queue.cond.remove"), header: true }, ...currentConditions.map(remove)] : [])]);
  } else if (screen.name === "options") {
    heading = onSchedule ? t("queue.schedule") : targets.length > 1 ? t("queue.options.titleMany", { count: targets.length }) : t("queue.options.title", { title: focus?.title ?? "" });
    hints = choose("queue.key.pick");
    body = list([
      { key: "h1", label: t("queue.options.concurrency"), header: true },
      optionRow("sequential", t("queue.options.sequential"), undefined, policy.sequential, (value) => ({ ...value, sequential: true })),
      optionRow("parallel", t("queue.options.parallel"), undefined, !policy.sequential, (value) => ({ ...value, sequential: false })),
      { key: "h2", label: t("queue.options.continues"), header: true },
      optionRow("same", t("queue.options.same"), undefined, policy.continuation === "same-thread", (value) => ({ ...value, continuation: "same-thread" })),
      optionRow("stored", t("queue.options.stored"), t("queue.options.storedDetail"), policy.continuation === "stored", (value) => ({ ...value, continuation: "stored" })),
      optionRow("model", t("queue.options.model"), t("queue.options.modelDetail"), policy.continuation === "model", (value) => ({ ...value, continuation: "model" })),
    ]);
  } else {
    heading = t(`queue.cond.${screen.name === "provider" ? screen.kind : screen.name === "window" ? screen.kind : screen.name === "minimum" ? "usage" : screen.name === "state" || screen.name === "mode" ? "provider" : "entry"}`);
    hints = choose("queue.key.next");
    if (screen.name === "provider") {
      sub = t("queue.ask.provider");
      body = list(providers.map((provider) => ({ key: provider, label: providerName(provider), onPick: () => push(screen.kind === "provider" ? { name: "state", provider } : { name: "window", kind: screen.kind, provider }) })));
    } else if (screen.name === "window") {
      sub = t("queue.ask.window", { provider: providerName(screen.provider) });
      body = list(queueWindows(queue.limits, screen.provider).map((window) => ({ key: window, label: windowChoice(window), onPick: () => {
        if (screen.kind === "usage") push({ name: "minimum", provider: screen.provider, window });
        else addCondition({ type: "reset", provider: screen.provider, window, resetsAt: null });
      } })));
    } else if (screen.name === "minimum") {
      sub = t("queue.ask.minimum", { provider: providerName(screen.provider), window: windowChoice(screen.window).toLowerCase() });
      hints = [{ key: "enter", label: t("queue.cond.add") }, { key: "esc", label: t("queue.key.back"), onClick: pop }];
      body = <MinimumStep onSubmit={(minimum) => addCondition({ type: "usage", provider: screen.provider, window: screen.window, minimum })} />;
    } else if (screen.name === "state") {
      sub = t("queue.ask.state", { provider: providerName(screen.provider) });
      body = list((["exhausted", "protected"] as const).map((state) => ({ key: state, label: t(state === "exhausted" ? "queue.pick.exhausted" : "queue.pick.protected"), onPick: () => push({ name: "mode", provider: screen.provider, state }) })));
    } else if (screen.name === "mode") {
      sub = t("queue.ask.mode");
      body = list((["after", "while"] as const).map((mode) => ({ key: mode, label: t(mode === "after" ? "queue.mode.after" : "queue.mode.while"), detail: t(mode === "after" ? "queue.mode.afterDetail" : "queue.mode.whileDetail"), onPick: () => addCondition({ type: "provider", provider: screen.provider, state: screen.state, mode }) })));
    } else {
      sub = t("queue.ask.entry");
      body = list(conditionEntries.map((entry: QueueEntry) => ({ key: entry.turnId, label: entry.title, detail: providerName(entry.provider), onPick: () => addCondition({ type: "entry", threadId: entry.threadId, turnId: entry.turnId }) })), t("queue.entries.none"));
    }
  }

  return <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={close}>
    <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1, flexShrink: 0 }}>
      <OverflowText fg={COLOR.bright} bg={SURFACE.raised} selectable={false} width={inner - 11}>{heading}</OverflowText>
      <HoverButton label={t(screen === null ? "queue.close" : "queue.back")} fg={COLOR.faint} onClick={screen === null ? close : pop} />
    </box>
    <box style={{ height: 1, flexShrink: 0 }}>{sub ? <OverflowText fg={COLOR.dim} bg={SURFACE.raised} selectable={false} width={inner}>{sub}</OverflowText> : null}</box>
    {/* A key per screen: each list starts with its own first row focused, not the last list's. */}
    <box key={JSON.stringify(screen)} style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>{body}</box>
    {queue.error ? <OverflowText fg={COLOR.danger} bg={SURFACE.raised} selectable={false} width={inner}>{queue.error}</OverflowText> : null}
    <box style={{ height: 1, flexShrink: 0, marginTop: 1 }}>
      {queue.saving ? <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("queue.saving")}</text> : <KeyHints hints={hints} />}
    </box>
  </ModalShell>;
}

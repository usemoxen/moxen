import { t } from "../../i18n/index.js";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";

import type { ClientApi } from "../../../server/api.js";
import {
  backgroundSummaryLabel,
  backgroundTaskKind,
  backgroundTaskTitle,
  type BackgroundTaskKind,
  type BackgroundTaskRow,
} from "../../model/thread.js";
import { formatDuration } from "../../model/turns.js";
import { ModalShell } from "../../ui/modalshell.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { useAnimTick } from "../../hooks/useAnimTick.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { PICK_BG, PICK_FG } from "../pickers/pickermodal.js";

const OUTPUT_POLL_MS = 2000;
/** Rows of command text the details view shows at once; longer commands scroll. */
const COMMAND_ROWS = 8;

const KIND_ORDER: readonly BackgroundTaskKind[] = ["shell", "monitor", "agent", "task"];
const KIND_SECTION = (): Record<BackgroundTaskKind, string> => ({ shell: t("bgm.shells_b835"), monitor: t("bgm.monitors_8c22"), agent: t("tab.agents"), task: t("bgm.tasks_ef61") });
const KIND_TITLE = (): Record<BackgroundTaskKind, string> => ({ shell: t("bgm.shell_ea89"), monitor: t("bgm.monitor_d298"), agent: t("bgm.agent_7446"), task: t("bgm.task_eaeb") });
const KIND_SOURCE = (): Record<BackgroundTaskKind, string> => ({ shell: t("bgm.command_ee97"), monitor: t("bgm.script_f907"), agent: t("bgm.prompt_45d7"), task: t("bgm.command_ee97") });

function runtimeOf(task: BackgroundTaskRow | null, now: number): string | null {
  if (task?.startedAt === null || task?.startedAt === undefined) return null;
  const startedMs = Date.parse(task.startedAt);
  return Number.isFinite(startedMs) ? formatDuration(Math.max(0, now - startedMs)) : null;
}

/** Hard-wraps text to `width` columns, keeping every line of a multi-line command. */
function wrapRows(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (let at = 0; at < Math.max(1, line.length); at += width) out.push(line.slice(at, at + width));
  }
  return out;
}

/**
 * Claude Code-style background work browser, opened from the composer's
 * background footer segment or the palette. The list groups what's running
 * by kind (shells, monitors, agents), each task a two-row entry — its name
 * and live runtime, then the command it runs — and drills into one task:
 * status, runtime, the full command, and its output tailing live. A task
 * that finishes while its details are open stays readable, marked finished.
 */
export function BackgroundTasksModal({
  tasks,
  client,
  threadId,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
  onStop,
}: {
  tasks: readonly BackgroundTaskRow[];
  client: Pick<ClientApi, "query">;
  threadId: string;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
  onStop: (task: BackgroundTaskRow) => void;
}) {
  // Grouped order is the navigation order, so ↑/↓ walks rows as drawn.
  const ordered = KIND_ORDER.flatMap((kind) => tasks.filter((task) => backgroundTaskKind(task) === kind));
  const [index, setIndex] = useState(0);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  // Remembered so a task that finishes while its details are open keeps its
  // name and command instead of the view going blank.
  const [detailSnapshot, setDetailSnapshot] = useState<BackgroundTaskRow | null>(null);
  const safeIndex = ordered.length === 0 ? -1 : Math.min(index, ordered.length - 1);
  const liveDetail = detailTaskId === null ? null : (ordered.find((task) => task.taskId === detailTaskId) ?? null);
  const detailTask = liveDetail ?? detailSnapshot;
  const detailFinished = detailTaskId !== null && liveDetail === null;

  const openDetail = (task: BackgroundTaskRow) => {
    setDetailSnapshot(task);
    setDetailTaskId(task.taskId);
  };
  const closeDetail = () => setDetailTaskId(null);
  useEffect(() => {
    if (liveDetail !== null) setDetailSnapshot(liveDetail);
  }, [liveDetail]);

  const [output, setOutput] = useState<{ taskId: string; lines: readonly string[]; available: boolean } | null>(null);
  useEffect(() => {
    if (detailTaskId === null) return;
    let cancelled = false;
    const fetchOutput = () => {
      void client
        .query({ type: "thread.background.output", threadId, taskId: detailTaskId })
        .then((result) => {
          if (!cancelled) setOutput({ taskId: detailTaskId, lines: result.lines, available: result.available });
        })
        .catch(() => undefined);
    };
    fetchOutput();
    if (detailFinished) return;
    const timer = setInterval(fetchOutput, OUTPUT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, detailTaskId, detailFinished, threadId]);

  // Runtimes tick while anything shown is still running.
  const now = useAnimTick(detailTaskId === null ? ordered.length > 0 : !detailFinished, 1000);

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      if (detailTaskId !== null) closeDetail();
      else onClose();
      return;
    }
    if (key.sequence === "x") {
      const target = detailTaskId !== null ? liveDetail : ordered[safeIndex];
      if (target) onStop(target);
      return;
    }
    if (detailTaskId !== null) {
      if (key.name === "left" || key.name === "backspace") closeDetail();
      else if (key.name === "return" || key.name === "kpenter" || key.name === "space") onClose();
      return;
    }
    if (key.name === "return" || key.name === "kpenter" || key.name === "right") {
      const target = ordered[safeIndex];
      if (target) openDetail(target);
      return;
    }
    if (key.name === "up" || key.name === "k") {
      setIndex((current) => (ordered.length === 0 ? 0 : (current - 1 + ordered.length) % ordered.length));
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setIndex((current) => (ordered.length === 0 ? 0 : (current + 1) % ordered.length));
    }
  });

  const inner = Math.max(20, width - 4);
  const shell = (children: ReactNode) => (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      {children}
    </ModalShell>
  );

  if (detailTaskId !== null && detailTask !== null) {
    const kind = backgroundTaskKind(detailTask);
    const title = backgroundTaskTitle(detailTask);
    const statusLabel = detailFinished ? t("bgm.finished_e3e2") : t("bgm.running_7f32");
    const runtime = detailFinished ? null : runtimeOf(detailTask, now);
    const command = detailTask.command?.trim() || null;
    const showCommand = command !== null && command !== title;
    const commandRows = showCommand ? wrapRows(command, inner - 2) : [];
    const outputLines = output && output.taskId === detailTaskId ? output.lines : [];
    const lineCountLabel = t("bgm.lines", { count: outputLines.length });
    const heading = `${KIND_TITLE()[kind]} · `;
    return shell(
      <>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <HoverButton label="← " fg={COLOR.dim} hoverFg={COLOR.bright} onClick={closeDetail} />
            <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{heading}</text>
            <text fg={COLOR.bright} bg={SURFACE.raised}>
              {truncate(title, Math.max(4, inner - heading.length - statusLabel.length - 4))}
            </text>
          </box>
          <text fg={detailFinished ? COLOR.added : COLOR.accent} bg={SURFACE.raised} selectable={false}>{statusLabel}</text>
        </box>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }}>
          {runtime === null ? null : (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("bgm.runtime_cfb5")}</text>
              <text fg={COLOR.text} bg={SURFACE.raised} selectable={false}>{runtime}</text>
              <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"  ·  "}</text>
            </>
          )}
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("bgm.task_069e")}</text>
          <text fg={COLOR.text} bg={SURFACE.raised}>{detailTask.taskId}</text>
        </box>
        {showCommand ? (
          <>
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }}>
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{KIND_SOURCE()[kind]}</text>
            </box>
            <box
              style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, height: Math.min(commandRows.length, COMMAND_ROWS) }}
              border={["left"]}
              borderColor={SURFACE.border}
              backgroundColor={SURFACE.raised}
            >
              {/* The whole command, scrollable once it outgrows the box. */}
              <scrollbox style={{ flexGrow: 1 }}>
                {commandRows.map((row, rowIndex) => (
                  <text key={rowIndex} fg={COLOR.command} bg={SURFACE.raised}>{row}</text>
                ))}
              </scrollbox>
            </box>
          </>
        ) : null}
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "space-between" }}>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("bgm.output_29c2")}</text>
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
            {output?.available ? (detailFinished ? lineCountLabel : t("bgm.live", { lines: lineCountLabel })) : ""}
          </text>
        </box>
        <box
          style={{ flexDirection: "column", flexGrow: 1, borderStyle: "rounded", paddingLeft: 1, paddingRight: 1 }}
          borderColor={SURFACE.border}
          backgroundColor={SURFACE.raised}
        >
          {output === null || output.taskId !== detailTaskId ? (
            <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{t("bgm.waiting_for_output_2faa")}</text>
          ) : !output.available ? (
            <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{t("bgm.no_output_yet_b7d2")}</text>
          ) : outputLines.length === 0 ? (
            <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{t("bgm.empty_9e65")}</text>
          ) : (
            // Every line scrolls; the view sticks to the newest while it tails.
            <scrollbox style={{ flexGrow: 1 }} stickyScroll stickyStart="bottom">
              {outputLines.map((line, lineIndex) => (
                <text key={lineIndex} fg={COLOR.text} bg={SURFACE.raised}>{truncate(line, Math.max(0, inner - 5))}</text>
              ))}
            </scrollbox>
          )}
        </box>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "space-between" }}>
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
            {truncate(detailFinished ? t("bgm.back_esc_close_d83a") : t("bgm.back_x_stop_esc_be25"), Math.max(0, inner - 8))}
          </text>
          {detailFinished || liveDetail === null ? null : (
            <HoverButton label={t("bgm.stop_ec99")} fg={COLOR.danger} hoverFg={COLOR.bright} onClick={() => onStop(liveDetail)} />
          )}
        </box>
      </>,
    );
  }

  const summary = backgroundSummaryLabel(ordered);
  const titleWidth = inner - 12;
  return shell(
    <>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("bgm.background_work_7ae0")}</text>
        <HoverButton label="esc" fg={COLOR.faint} hoverFg={COLOR.text} onClick={onClose} />
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
          {summary === null ? t("bgm.nothing_running_2489") : t("bgm.runningSummary", { count: ordered.length, summary })}
        </text>
      </box>
      {ordered.length === 0 ? (
        <box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1, justifyContent: "center", alignItems: "center" }}>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("bgm.nothing_running_in_the_f068")}</text>
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
            {truncate(t("bgm.shells_monitors_and_background_02e7"), inner)}
          </text>
        </box>
      ) : (
        <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top">
          {KIND_ORDER.map((kind) => {
            const group = ordered.filter((task) => backgroundTaskKind(task) === kind);
            if (group.length === 0) return null;
            return (
              <Fragment key={kind}>
                <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                  <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{`${KIND_SECTION()[kind]} (${group.length})`}</text>
                </box>
                {group.map((task) => {
                  const taskIndex = ordered.indexOf(task);
                  const active = taskIndex === safeIndex;
                  const rowBg = active ? PICK_BG : SURFACE.raised;
                  const title = backgroundTaskTitle(task);
                  const command = task.command?.trim().split("\n")[0] ?? "";
                  const runtime = runtimeOf(task, now);
                  return (
                    <box
                      key={task.taskId}
                      style={{ width: inner, flexDirection: "column", flexShrink: 0, marginBottom: 1 }}
                      backgroundColor={rowBg}
                      onMouseDown={() => openDetail(task)}
                      onMouseOver={() => setIndex(taskIndex)}
                    >
                      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
                        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                          <text fg={active ? PICK_FG : COLOR.faint} bg={rowBg} selectable={false}>{active ? "❯ " : "  "}</text>
                          <text fg={COLOR.accent} bg={rowBg} selectable={false}>{"● "}</text>
                          <text fg={active ? PICK_FG : COLOR.bright} bg={rowBg} selectable={false}>{truncate(title, titleWidth)}</text>
                        </box>
                        <text fg={active ? PICK_FG : COLOR.dim} bg={rowBg} selectable={false}>{runtime === null ? t("bgm.running_b3be") : `${runtime} `}</text>
                      </box>
                      {command && command !== title ? (
                        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                          <text fg={active ? PICK_FG : COLOR.dim} bg={rowBg} selectable={false}>{truncate(`    ${command}`, inner - 1)}</text>
                        </box>
                      ) : null}
                    </box>
                  );
                })}
              </Fragment>
            );
          })}
        </scrollbox>
      )}
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }}>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
          {truncate(ordered.length === 0 ? t("bgm.esc_close_dcf7") : t("bgm.select_enter_view_x_2458"), inner)}
        </text>
      </box>
    </>,
  );
}

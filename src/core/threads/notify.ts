/**
 * Telling a parent thread its delegated tasks finished.
 *
 * Without this a parent had to poll `task_status` (or run the orchestrate
 * skill's signal-file listener) to learn a child was done. Now the process
 * that runs the child sends the parent one message when it settles — a
 * steer into the parent's running turn where the provider takes one, else a
 * turn of its own. Tasks settling within a moment of each other share one
 * message, so a fan-out does not wake the parent once per child.
 *
 * The message carries the facts twice: as text the model reads, and as
 * structured `notification` data the TUI draws as a card.
 */
import type { DelegatedTaskStatus } from "./views.js";

export interface TaskNotification {
  readonly taskId: string;
  readonly title: string;
  readonly status: DelegatedTaskStatus;
  /** How long the task's turn ran; null when it never recorded both ends. */
  readonly durationMs: number | null;
  /** `instance/model` it ran on. */
  readonly model: string | null;
  /** The branch holding its work, for a task in its own worktree. */
  readonly branch: string | null;
  /** The first line of its report — delegated threads are asked to lead with one. */
  readonly headline: string | null;
  /** What it changed, from its checkpoint; null when unknown. */
  readonly filesChanged: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  /** The task id the parent delegated, when this task carried on in a new thread after a handoff. */
  readonly continuedFrom?: string;
  /** Background work still running when the task's turn ended (its own description, command and start). */
  readonly background: readonly BackgroundWorkNote[];
  /** True when Moxen could not check for background work, so more may still be running. */
  readonly backgroundUnknown: boolean;
}

/** One background task still running when a delegated task's turn ended. */
export interface BackgroundWorkNote {
  readonly taskId: string;
  readonly description: string;
  readonly command: string | null;
  /** When it started, ISO; null when the provider never said. */
  readonly startedAt: string | null;
}

/** The first line of a report, as its headline (markdown emphasis and heading marks dropped). */
export function reportHeadline(report: string | null): string | null {
  const line = report
    ?.split(/\r?\n/u)
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  if (!line) return null;
  const plain = line.replace(/^#+\s*/u, "").replace(/\*\*/gu, "").trim();
  return plain.length <= 200 ? plain : `${plain.slice(0, 199)}…`;
}

/** "3m 12s" / "45s" / "1h 5m". */
export function formatTaskDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const VERB: Record<DelegatedTaskStatus, string> = {
  running: "is still running",
  completed: "finished",
  failed: "failed",
  interrupted: "was stopped",
};

/** The message the parent's agent reads. A task whose turn ended with
 * background work still running is not finished: the message says so and
 * names the work, so the parent reads it as "not finished". */
export function taskNotificationText(tasks: readonly TaskNotification[], nowMs: number = Date.now()): string {
  const lines = tasks.map((task) => {
    const facts = [
      task.durationMs === null ? null : formatTaskDuration(task.durationMs),
      task.model,
      task.branch === null ? null : `branch ${task.branch}`,
      task.filesChanged === null || task.filesChanged === 0 ? null : `${task.filesChanged} file${task.filesChanged === 1 ? "" : "s"} changed (+${task.additions ?? 0} −${task.deletions ?? 0})`,
    ].filter((fact): fact is string => fact !== null);
    return [
      `- Task "${task.title}" (taskId ${task.taskId}${task.continuedFrom ? `, continued from taskId ${task.continuedFrom}` : ""}) ${VERB[task.status]}${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}.`,
      task.headline === null ? null : `  Headline: ${task.headline}`,
      ...backgroundLines(task, nowMs),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  });
  const unfinished = tasks.some((task) => task.background.length > 0 || task.backgroundUnknown);
  const head =
    tasks.length === 1 && !unfinished
      ? "A task you delegated has settled."
      : tasks.length === 1
        ? "A task you delegated ended its turn with background work still running. It is not finished: do not treat its report as complete."
        : unfinished
          ? "Tasks you delegated ended their turns with background work still running. They are not finished: do not treat their reports as complete."
          : `${tasks.length} tasks you delegated have settled.`;
  return [
    "<task-notification>",
    head,
    ...lines,
    "Call task_status with a taskId for the full report.",
    "</task-notification>",
  ].join("\n");
}

/** What a background task has been doing, and for how long: "bun run check (4m)". Unknown start: no age. */
export function backgroundWorkLabel(note: Pick<BackgroundWorkNote, "description" | "command" | "startedAt">, nowMs: number = Date.now()): string {
  const what = note.command ?? note.description;
  if (note.startedAt === null) return what;
  const ageMs = nowMs - Date.parse(note.startedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return what;
  return `${what} (${formatTaskDuration(ageMs)})`;
}

function backgroundLines(task: TaskNotification, nowMs: number): readonly (string | null)[] {
  const running =
    task.background.length === 0
      ? null
      : `  Background work still running: ${task.background.map((note) => backgroundWorkLabel(note, nowMs)).join("; ")}.`;
  const unknown = !task.backgroundUnknown
    ? null
    : "  Moxen could not check for more background work, so more may still be running beyond what is named above.";
  return [running, unknown];
}

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
import type { InteractionMode } from "../types.js";
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
  /**
   * Review tasks only (a child in Review mode): the verdict the report ends
   * with, whether the reviewer shares the parent's model, and the report
   * itself. Absent for every other task, so their notifications read as
   * they always did.
   */
  readonly review?: {
    readonly verdict: ReviewVerdict | null;
    /** True when the reviewer runs on the same model as the parent thread; null when either is unknown. */
    readonly sameModel: boolean | null;
    /** What is visibly wrong (no verdict on a finished review, a shared model): null when the review reads clean. */
    readonly note: string | null;
    /** The reviewer's final message, verbatim; null when it said nothing. */
    readonly report: string | null;
  };
}

/** The trailing verdict a review report must end with. */
export type ReviewVerdict = "MERGE" | "FIX FIRST";

/**
 * The verdict a review report ends with: `VERDICT: MERGE` or
 * `VERDICT: FIX FIRST` on the report's last non-empty line, and nothing
 * else. A verdict line followed by more prose — or quoted target content
 * landing after the reviewer's own verdict — is no verdict at all. Null
 * when the final message holds none: the past failure was a report whose
 * last word was "the full report is delivered above", so the report held
 * nothing.
 */
export function reviewVerdictOf(report: string | null): ReviewVerdict | null {
  if (report === null) return null;
  const lines = report.split(/\r?\n/u);
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!.trim();
    if (line === "") continue;
    return line === "VERDICT: MERGE" ? "MERGE" : line === "VERDICT: FIX FIRST" ? "FIX FIRST" : null;
  }
  return null;
}

export interface ReviewFacts {
  readonly verdict: ReviewVerdict | null;
  readonly sameModel: boolean | null;
  readonly note: string | null;
}

/**
 * What the parent is told about a review task beyond the generic facts.
 * Null for any task not in Review mode. `finished` matters: a running
 * review owes no verdict yet, but a finished one without a `VERDICT` line
 * is not a finished review, and the note says so visibly instead of
 * passing it on as one. Models compare as `instance/model`; a shared one
 * is a warning, never a refusal.
 */
export function reviewFactsOf(input: {
  readonly finished: boolean;
  readonly interactionMode: InteractionMode | undefined;
  readonly report: string | null;
  /** `instance/model` the reviewer ran on; null when unknown. */
  readonly childModel: string | null;
  /** `instance/model` the parent thread runs on; null when unknown. */
  readonly parentModel: string | null;
}): ReviewFacts | null {
  if (input.interactionMode !== "review") return null;
  const verdict = reviewVerdictOf(input.report);
  const sameModel =
    input.childModel !== null && input.parentModel !== null ? input.childModel === input.parentModel : null;
  const notes: string[] = [];
  if (input.finished && verdict === null) {
    notes.push(
      "the reviewer's final message has no VERDICT: MERGE or VERDICT: FIX FIRST line, so this is not a finished review. " +
        "Read the report below and, when it holds nothing usable, delegate the review again with the target and the questions stated in full",
    );
  }
  if (sameModel === true) {
    notes.push(
      `the reviewer runs on ${input.childModel}, the same model as this thread: it may share the author's blind spots, ` +
        "so verify the load-bearing findings independently",
    );
  }
  return { verdict, sameModel, note: notes.length > 0 ? notes.join("; ") : null };
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

/** The message the parent's agent reads. */
export function taskNotificationText(tasks: readonly TaskNotification[]): string {
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
      ...(task.review === undefined ? [] : reviewLines(task.review)),
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  });
  const head = tasks.length === 1 ? "A task you delegated has settled." : `${tasks.length} tasks you delegated have settled.`;
  return [
    "<task-notification>",
    head,
    ...lines,
    "Call task_status with a taskId for the full report.",
    "</task-notification>",
  ].join("\n");
}

/**
 * A review task's verdict, warnings and report, inline: the verdict and
 * the findings must reach the parent here, not only behind `task_status`.
 * A finished review with no `VERDICT` line is called out instead of being
 * passed on as a finished review.
 */
function reviewLines(review: NonNullable<TaskNotification["review"]>): string[] {
  const verdict =
    review.verdict === null
      ? review.note === null
        ? "  Review verdict: pending"
        : "  Review verdict: none — this is not a finished review"
      : `  Review verdict: ${review.verdict}`;
  return [
    verdict,
    review.note === null ? null : `  Review note: ${review.note}`,
    review.report === null || review.report.trim() === "" ? null : `  Report:\n${review.report}`,
  ].filter((line): line is string => line !== null);
}

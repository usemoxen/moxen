import type { RollbackResult, UpdateCheck, UpdateProgress, UpdateResult, UpdateStage } from "../../core/selfupdate/vocabulary.js";

/**
 * Where the update screen is. It lives above the screen (in the app), so closing the screen neither cancels an
 * update nor loses it: coming back shows the same state.
 */
export type UpdateOperation = "apply" | "rollback";

export type UpdateView =
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "ready"; readonly check: UpdateCheck }
  /** The question itself got no answer (the server is not there); `unavailable` is GitHub that did not answer. */
  | { readonly phase: "unreachable"; readonly message: string }
  | { readonly phase: "running"; readonly op: UpdateOperation; readonly commandId: string; readonly progress: UpdateProgress | null; readonly check: UpdateCheck | null }
  | { readonly phase: "finished"; readonly op: UpdateOperation; readonly result: UpdateResult | RollbackResult; readonly check: UpdateCheck | null }
  | { readonly phase: "failed"; readonly op: UpdateOperation; readonly code: string | null; readonly message: string; readonly check: UpdateCheck | null }
  /** The connection dropped while an update ran: the server may have finished it, and this client cannot tell. */
  | { readonly phase: "lost"; readonly op: UpdateOperation; readonly commandId: string; readonly check: UpdateCheck | null };

export type UpdateEvent =
  | { readonly type: "check-start" }
  | { readonly type: "check-done"; readonly check: UpdateCheck }
  | { readonly type: "check-failed"; readonly message: string }
  | { readonly type: "run-start"; readonly op: UpdateOperation; readonly commandId: string }
  | { readonly type: "progress"; readonly commandId: string | null; readonly progress: UpdateProgress }
  | { readonly type: "run-done"; readonly commandId: string; readonly result: UpdateResult | RollbackResult }
  | { readonly type: "run-failed"; readonly commandId: string; readonly code: string | null; readonly message: string }
  | { readonly type: "link-lost" };

export const IDLE: UpdateView = { phase: "idle" };

function checkOf(view: UpdateView): UpdateCheck | null {
  return view.phase === "ready" || view.phase === "running" || view.phase === "finished" || view.phase === "failed" || view.phase === "lost" ? view.check : null;
}

export function reduceUpdate(view: UpdateView, event: UpdateEvent): UpdateView {
  switch (event.type) {
    case "check-start":
      // A check never replaces a run that is under way: that run is what the screen has to keep showing.
      return view.phase === "running" || view.phase === "checking" ? view : { phase: "checking" };
    case "check-done":
      return view.phase === "checking" ? { phase: "ready", check: event.check } : view;
    case "check-failed":
      return view.phase === "checking" ? { phase: "unreachable", message: event.message } : view;
    case "run-start":
      // One update at a time: a second request while one runs changes nothing.
      return view.phase === "running" ? view : { phase: "running", op: event.op, commandId: event.commandId, progress: null, check: checkOf(view) };
    case "progress":
      // Another client's update (or the CLI's) reports on the same subscription; only our own command counts.
      return view.phase === "running" && view.commandId === event.commandId ? { ...view, progress: event.progress } : view;
    case "run-done":
      return (view.phase === "running" || view.phase === "lost") && view.commandId === event.commandId ? { phase: "finished", op: view.op, result: event.result, check: view.check } : view;
    case "run-failed":
      return (view.phase === "running" || view.phase === "lost") && view.commandId === event.commandId ? { phase: "failed", op: view.op, code: event.code, message: event.message, check: view.check } : view;
    case "link-lost":
      return view.phase === "running" ? { phase: "lost", op: view.op, commandId: view.commandId, check: view.check } : view;
  }
}

/** The update event a shell frame carries, or null for any other frame. */
export function updateEventFromFrame(frame: unknown): Extract<UpdateEvent, { type: "progress" }> | null {
  if (frame === null || typeof frame !== "object") return null;
  const record = frame as { kind?: unknown; event?: unknown };
  if (record.kind !== "event" || record.event === null || typeof record.event !== "object") return null;
  const event = record.event as { type?: unknown; payload?: unknown };
  if (event.type !== "app.update-progress" || event.payload === null || typeof event.payload !== "object") return null;
  const payload = event.payload as { commandId?: unknown; progress?: unknown };
  const progress = payload.progress as Partial<UpdateProgress> | null | undefined;
  if (progress === null || progress === undefined || typeof progress.stage !== "string") return null;
  return { type: "progress", commandId: typeof payload.commandId === "string" ? payload.commandId : null, progress: progress as UpdateProgress };
}

export type UpdateAction = "install" | "rollback" | "check";

/**
 * What the screen may offer. Installing and rolling back act on this machine's own app folder, so they are
 * offered to a client of this machine's server only, and only for a release install: a source checkout is
 * updated with git, and a paired server's versions are shown without a way to change them. Nothing is offered
 * while a check or an update runs.
 */
export function updateActions(view: UpdateView, context: { readonly remote: boolean }): readonly UpdateAction[] {
  const check = checkOf(view);
  const local = !context.remote && check !== null && check.install.kind === "release";
  switch (view.phase) {
    case "idle":
    case "checking":
    case "running":
      return [];
    case "unreachable":
    case "lost":
      return ["check"];
    case "ready":
      return [...(local && view.check.updatable ? (["install"] as const) : []), ...(local ? (["rollback"] as const) : []), "check"];
    case "finished":
      return [...(local ? (["rollback"] as const) : []), "check"];
    case "failed":
      return [...(local && view.op === "apply" && check?.updatable === true && view.code !== "SELF_UPDATE_BUSY" ? (["install"] as const) : []), "check"];
  }
}

const APPLY_STAGES: readonly UpdateStage[] = ["checking", "downloading", "verifying", "unpacking", "testing", "switching"];
const ROLLBACK_STAGES: readonly UpdateStage[] = ["testing", "switching"];

export type StageState = "done" | "current" | "pending";

/** The stages of an operation in order, each marked done, current or pending by the last progress report. */
export function stageRows(op: UpdateOperation, progress: UpdateProgress | null): ReadonlyArray<{ readonly stage: UpdateStage; readonly state: StageState }> {
  const stages = op === "apply" ? APPLY_STAGES : ROLLBACK_STAGES;
  // Before the first report the first stage is the one the server is in.
  const at = progress === null ? 0 : progress.stage === "done" ? stages.length : Math.max(0, stages.indexOf(progress.stage));
  return stages.map((stage, index) => ({ stage, state: index < at ? "done" : index === at ? "current" : "pending" }));
}

/** 0 to 1 when the download reports a total; null when the size is not known. */
export function downloadFraction(progress: UpdateProgress | null): number | null {
  if (progress?.stage !== "downloading" || progress.total == null || progress.total <= 0 || progress.bytes === undefined) return null;
  return Math.max(0, Math.min(1, progress.bytes / progress.total));
}

export function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A failure's code as it arrives from the client (`CliError.code`), or null. */
export function errorCode(cause: unknown): string | null {
  const code = cause !== null && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

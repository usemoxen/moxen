import { basename, resolve } from "node:path";

import { buildImageAttachments, extractMentions } from "../../../core/attachments.js";
import { dispatchErrorMessage } from "../../../core/errors.js";
import type { InteractionMode, ModelSelection, RuntimeMode, ProjectEnvelope, ThreadEnvelope } from "../../../core/types.js";
import type { ImageAttachmentUpload } from "../../../core/attachments.js";
import type { ClientApi } from "../../../server/api.js";
import type { PickerName } from "../../features/pickers/pickerTypes.js";
import { threadTitle } from "../utils.js";

/** The draft's project when "No project" is picked: the server starts the thread in a scratch directory. */
export const NO_PROJECT = "__no-project__";

/**
 * New-thread draft flow: handlers for starting a draft, picking or creating
 * its target project, and sending it as `thread.create` + `thread.turn.start`.
 * The `creating`/`creatingModelSelection`/`creatingRuntimeMode`/
 * `creatingProjectId` state itself stays in `App` — it's read from ~20
 * unrelated sites throughout the component (the JSX render fork, every
 * picker, the resume banner, ...), so only the handlers that *write* it move
 * here; the state stays where all those readers already look for it.
 */
export function useThreadCreation(params: {
  client: ClientApi;
  cwd: string | undefined;
  /** The server is on another machine: a typed folder is its path, sent as typed. */
  remote?: boolean;
  selected: ThreadEnvelope | null;
  pending: ImageAttachmentUpload[];
  shellProjects: ProjectEnvelope[];
  creatingProjectId: string | null;
  creatingModelSelection: ModelSelection | null;
  creatingRuntimeMode: RuntimeMode | null;
  /** The mode the draft starts in (`useInteractionMode`): Build unless picked while drafting. */
  creatingInteractionMode: InteractionMode;
  /** The `/research` or `/orchestrate` armed for the first prompt, cleared by taking it. */
  takeOneOff: () => InteractionMode | undefined;
  resetDraft: (id: string) => void;
  writePending: (id: string, next: ImageAttachmentUpload[]) => void;
  setCreating: (creating: boolean) => void;
  setCreatingModelSelection: (selection: ModelSelection | null) => void;
  setCreatingRuntimeMode: (mode: RuntimeMode | null) => void;
  setCreatingProjectId: (id: string | null) => void;
  setFocus: (focus: "chat" | "composer") => void;
  setOpenThreadId: (id: string) => void;
  setError: (message: string) => void;
  setPicker: (picker: PickerName) => void;
  setPickerFilter: (filter: string) => void;
  closePicker: (returnFocus?: "composer" | "chat" | "diff") => void;
}) {
  const {
    client,
    cwd,
    remote = false,
    selected,
    pending,
    shellProjects,
    creatingProjectId,
    creatingModelSelection,
    creatingRuntimeMode,
    creatingInteractionMode,
    takeOneOff,
    resetDraft,
    writePending,
    setCreating,
    setCreatingModelSelection,
    setCreatingRuntimeMode,
    setCreatingProjectId,
    setFocus,
    setOpenThreadId,
    setError,
    setPicker,
    setPickerFilter,
    closePicker,
  } = params;

  /**
   * New thread in the effective project (the picked override, else the open
   * thread's, else the first known project for a zero-thread workspace),
   * inheriting the source's model and modes when there is a source. The id is
   * client-generated so the thread can open immediately; the subscription
   * fills it in once the server projects both commands.
   */
  const createThread = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Zero threads (fresh install): no source to inherit from — the picked
    // project/model/modes (or the workspace fallbacks below) are the whole
    // selection.
    const source = selected;
    const draftKey = source?.id ?? "__creating__";
    // The picked project wins over the source thread's — that is the whole
    // point of `creatingProjectId`. Without a resolvable project there is
    // nothing to create under.
    const projectId = creatingProjectId ?? source?.projectId ?? shellProjects[0]?.id ?? null;
    if (projectId === undefined || projectId === null) {
      setError("pick a project for the new thread first");
      return;
    }
    const parsed = extractMentions(trimmed);
    void buildImageAttachments(parsed.paths, cwd ?? process.cwd()).then((built) => {
      if (built.error !== null) {
        setError(built.error.slice(0, 120));
        return;
      }
      const threadId = crypto.randomUUID();
      const title = threadTitle(parsed.text);
      const interactionMode = creatingInteractionMode;
      // The local override picked while drafting wins over whatever the
      // source thread carries — that's the whole point of `creatingModelSelection`.
      // With no source thread the override (or nothing, letting the server
      // fall back to the project default) is the whole selection.
      const modelSelection = creatingModelSelection ?? source?.modelSelection;
      // Left out when nothing chose one: the server starts the thread in its provider's default mode.
      const runtimeMode = creatingRuntimeMode ?? source?.runtimeMode;
      const scratch = projectId === NO_PROJECT || shellProjects.some((p) => p.id === projectId && p.scratch === true);
      const create = {
        type: "thread.create",
        threadId,
        ...(scratch ? { scratch: true } : { projectId }),
        title,
        ...(modelSelection === undefined ? {} : { modelSelection }),
        ...(runtimeMode === undefined ? {} : { runtimeMode }),
        interactionMode,
        ...(scratch ? {} : { branch: source?.branch ?? null }),
      } as const;
      const oneOff = takeOneOff();
      const start = {
        type: "thread.turn.start",
        threadId,
        message: { text: parsed.text, attachments: [...pending, ...built.attachments] },
        ...(modelSelection === undefined ? {} : { modelSelection }),
        ...(oneOff === undefined ? {} : { interactionMode: oneOff }),
      } as const;
      void (async () => {
        try {
          await client.dispatch(create);
          await client.dispatch(start);
        } catch (cause: unknown) {
          setError(String(cause).slice(0, 120));
          return;
        }
        resetDraft(draftKey);
        writePending(draftKey, []);
        setCreating(false);
        setCreatingModelSelection(null);
        setCreatingRuntimeMode(null);
        setCreatingProjectId(null);
        setFocus("chat");
        setOpenThreadId(threadId);
      })();
    });
  };

  /** Starts drafting a new thread in the open thread's project (or, with no
      open thread, in the picked/first project). Reachable from the sidebar's
      "+" button — no keybinding. */
  const startNewThread = () => {
    // No source thread (zero-thread workspace): already drafting from
    // scratch — just reset the overrides so the button stays idempotent
    // instead of erroring.
    setCreatingModelSelection(null);
    setCreatingRuntimeMode(null);
    setCreatingProjectId(null);
    setCreating(true);
    setFocus("composer");
  };

  /** Points the draft at another project; the new thread is created there. */
  const pickCreatingProject = (projectId: string) => {
    setCreatingProjectId(projectId);
    closePicker("composer");
  };

  /** Creates a project from a local folder and points the draft at it. An
      already-known folder just selects its project (same as the CLI's
      `projects ensure`). Shape mirrors the CLI's `buildProjectCreateCommand`
      (`src/cli/projects/projects.ts`) — the server fills in the rest. */
  const submitProjectFolder = (rawPath: string) => {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      setError("enter a folder path for the new project");
      return;
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (remote && (trimmed === "~" || trimmed.startsWith("~/") || !isAbsoluteAnywhere(trimmed))) {
      // This machine's home and working folder mean nothing on the server.
      setError("enter the folder's full path on the server");
      return;
    }
    if ((trimmed === "~" || trimmed.startsWith("~/")) && home.length === 0) {
      setError("could not resolve ~ — enter a full path");
      return;
    }
    const workspaceRoot = remote ? trimmed : resolve(trimmed === "~" || trimmed.startsWith("~/") ? home + trimmed.slice(1) : trimmed);
    const normalized = workspaceRoot.replace(/[/\\]+$/, "");
    const existing = shellProjects.find(
      (project) =>
        typeof project.workspaceRoot === "string" && project.workspaceRoot.replace(/[/\\]+$/, "") === normalized,
    );
    if (existing !== undefined) {
      pickCreatingProject(existing.id);
      return;
    }
    const projectId = crypto.randomUUID();
    const title = (remote ? workspaceRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() : basename(workspaceRoot)) || "project";
    void client
      .dispatch({
        type: "project.create",
        projectId,
        title,
        workspaceRoot,
      })
      .then(() => pickCreatingProject(projectId))
      .catch((cause: unknown) => setError(dispatchErrorMessage(cause)));
  };

  /** Opens the project picker for the new thread's target project. */
  const openProjectPicker = () => {
    setPickerFilter("");
    setPicker("project");
    setFocus("chat");
  };

  return { createThread, startNewThread, pickCreatingProject, submitProjectFolder, openProjectPicker };
}

/** Absolute on either kind of machine: `/x`, `C:\x` or `C:/x`, or a `\\server\share` path. */
function isAbsoluteAnywhere(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

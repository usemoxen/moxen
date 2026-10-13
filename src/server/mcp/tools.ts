/**
 * The tools moxen gives an agent: delegate a task to another thread — any
 * provider, in a git worktree of its own — then follow it and read its
 * report. Each one is a thin call over `ClientApi`, so a delegated task is
 * an ordinary moxen thread every client can see and steer.
 *
 * Tool calls never block for long: MCP clients cap them (Codex at 60s by
 * default), and a delegated task can run for many minutes. So `delegate`
 * returns as soon as the task is under way, and `task_status` waits at most
 * `MAX_WAIT_MS` for it to finish before answering with where it stands.
 */
import { CliError } from "../../core/errors.js";
import type { DelegatedTaskStatus } from "../../core/threads/views.js";
import type { ClientApi } from "../api.js";

export const MAX_WAIT_MS = 45_000;
/** A checklist is a plan at a glance, not a log: past this it stops being read. */
export const MAX_TODOS = 15;
export const MAX_TODO_CHARS = 160;
const POLL_MS = 1_000;

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** MCP tool annotations: `readOnlyHint` lets a client run the call alongside other read-only ones. */
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

/** Models listed per provider before the rest are only counted: a catalog can run to hundreds. */
export const MAX_MODELS_PER_PROVIDER = 40;

export const MOXEN_TOOLS: readonly McpTool[] = [
  {
    name: "delegate",
    description:
      "Hand a self-contained task to a new subagent thread, which runs in parallel on any provider and model. " +
      "By default it works in its own git worktree, on a new branch cut from yours, and commits there. " +
      "Returns at once with a taskId: follow it with task_status, whose final summary is the subagent's report.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Everything the subagent needs: it sees none of your conversation." },
        title: { type: "string", description: "Short title for the subagent's thread." },
        provider: { type: "string", description: "Provider instance id (claudeAgent, opencode/<provider>…); defaults to yours. The models tool lists them." },
        model: { type: "string", description: "Model slug on that provider; defaults to yours." },
        effort: { type: "string", description: "Reasoning effort for that model (one of its efforts in the models tool); defaults to the model's own." },
        isolation: {
          type: "string",
          enum: ["worktree", "shared"],
          description: "worktree (default): its own checkout and branch. shared: works in your checkout.",
        },
        fork: {
          type: "boolean",
          description:
            "Start the subagent from a copy of your conversation so far (same provider, your checkout) instead of from nothing. " +
            "For side questions that need your context; the task text can then be short.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    description:
      "Where a delegated task stands: running, or finished with the subagent's report and the branch holding its work. " +
      `Waits up to waitMs (max ${MAX_WAIT_MS}) for it to finish first.`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        waitMs: { type: "number", description: `Wait this long for the task to finish (0–${MAX_WAIT_MS}, default ${MAX_WAIT_MS}).` },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "models",
    description:
      "The providers you can delegate to, with each one's models and reasoning efforts — only providers that are set up " +
      "here, and only models the user has not hidden, plus each provider's usage limits (session and weekly windows) when known. " +
      "Pass provider to list just that one.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider instance id to list alone." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "task_cancel",
    description: "Stop a delegated task that is still running. Its thread and worktree are kept.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

/**
 * A checklist for providers with none of their own (OpenCode v2 has no
 * `todowrite`); listed only to those (`McpSessionOptions.checklist`). It
 * becomes the thread's plan, the tasks panel the user watches.
 */
export const TODOS_TOOL: McpTool = {
  name: "todos",
  description:
    "Your task checklist, shown to the user as the thread's Tasks panel. For work of three or more steps. " +
    "Every call sends the whole list (it replaces the last one). Each item is one short, concrete outcome to check off, not an activity. " +
    "Keep exactly one item in_progress while you work. Mark an item completed as soon as it is done and checked, " +
    "and in that same call mark the next one in_progress. Update the list when the plan changes. " +
    `At most ${MAX_TODOS} items, each at most ${MAX_TODO_CHARS} characters.`,
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_TODOS,
        items: {
          type: "object",
          properties: {
            content: { type: "string", maxLength: MAX_TODO_CHARS, description: "One concrete, checkable outcome, imperative and short." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "pending: not started. in_progress: what you are doing now (exactly one). completed: done and checked.",
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
};

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * A checklist worth showing: every item a real, distinct, short outcome, and at
 * most one underway. A list that breaks these is refused with what to change —
 * the model fixes it and resends — instead of landing in the Tasks panel as noise.
 * What is merely unhelpful (nothing marked in progress) is recorded, with a note.
 */
export function checkTodos(raw: readonly unknown[]): { plan: Array<{ step: string; status: string }>; note: string | null } {
  if (raw.length > MAX_TODOS) {
    throw new CliError("INVALID_TOOL_INPUT", `At most ${MAX_TODOS} items: you sent ${raw.length}. Group related steps, or keep only the ones still ahead of you.`);
  }
  const plan = raw.map((entry, index) => {
    const record = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const step = typeof record.content === "string" ? record.content.trim().replace(/\s+/g, " ") : "";
    const status = typeof record.status === "string" ? record.status : "";
    if (step === "") throw new CliError("INVALID_TOOL_INPUT", `Item ${index + 1} has no content. Each item is one short sentence saying what will be done.`);
    if (step.length > MAX_TODO_CHARS) {
      throw new CliError("INVALID_TOOL_INPUT", `Item ${index + 1} is ${step.length} characters; keep it to ${MAX_TODO_CHARS}. Put the detail in your work, not in the checklist.`);
    }
    if (!TODO_STATUSES.has(status)) {
      throw new CliError("INVALID_TOOL_INPUT", `Item ${index + 1} has status "${status}"; use pending, in_progress or completed.`);
    }
    return { step, status };
  });
  const seen = new Set<string>();
  for (const item of plan) {
    const key = item.step.toLowerCase();
    if (seen.has(key)) throw new CliError("INVALID_TOOL_INPUT", `"${item.step}" is listed twice. Each item should be a distinct step.`);
    seen.add(key);
  }
  const underway = plan.filter((item) => item.status === "in_progress");
  if (underway.length > 1) {
    throw new CliError(
      "INVALID_TOOL_INPUT",
      `${underway.length} items are in_progress; exactly one should be. Keep the one you are doing now and mark the rest pending (or completed, if they are done).`,
    );
  }
  const open = plan.filter((item) => item.status !== "completed").length;
  const note =
    open > 0 && underway.length === 0
      ? "No item is in_progress. Mark the step you are starting in_progress, so the Tasks panel shows what you are doing."
      : plan.length > 0 && open === 0
        ? "Every item is completed. If that is the end of the work, no further call is needed; if more steps are ahead, add them."
        : null;
  return { plan, note };
}

const TERMINAL: ReadonlySet<DelegatedTaskStatus> = new Set(["completed", "failed", "interrupted"]);

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

function argString(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new CliError("INVALID_TOOL_INPUT", `${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) throw new CliError("INVALID_TOOL_INPUT", `${key} must be a non-empty string.`);
  return value.trim();
}

/** Run one tool for the agent working in `parentThreadId`. Failures come back as tool errors, never protocol errors. */
export async function callMoxenTool(
  api: ClientApi,
  parentThreadId: string,
  name: string,
  args: Record<string, unknown>,
  options: { readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<ToolResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    switch (name) {
      case "delegate":
        return ok(await delegateTool(api, parentThreadId, args));
      case "task_status":
        return ok(await statusTool(api, parentThreadId, args, sleep));
      case "models":
        return ok(await modelsTool(api, args));
      case "todos": {
        const todos = Array.isArray(args.todos) ? args.todos : null;
        if (todos === null) throw new CliError("INVALID_TOOL_INPUT", "todos must be an array of {content, status}.");
        const { plan, note } = checkTodos(todos);
        const recorded = await api.dispatch({ type: "thread.plan.set", threadId: parentThreadId, plan: plan as never });
        return ok({ recorded: recorded.steps, ...(note === null ? {} : { note }) });
      }
      case "task_cancel": {
        const taskId = argString(args, "taskId", true)!;
        const cancelled = await api.dispatch({ type: "thread.task.cancel", parentThreadId, taskId });
        return ok({ taskId, cancelRequested: cancelled.interruptRequested, status: cancelled.task.status });
      }
      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const code = cause instanceof CliError ? `${cause.code}: ` : "";
    return { text: `${code}${message}`, isError: true };
  }
}

function ok(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2), isError: false };
}

async function delegateTool(api: ClientApi, parentThreadId: string, args: Record<string, unknown>) {
  const task = argString(args, "task", true)!;
  const isolationArg = argString(args, "isolation");
  if (isolationArg !== undefined && isolationArg !== "worktree" && isolationArg !== "shared") {
    throw new CliError("INVALID_TOOL_INPUT", "isolation must be worktree or shared.");
  }
  const fork = args.fork === true;
  const parent = await api.query({ type: "thread.inspect", threadId: parentThreadId });
  // Worktree by default, when there is a branch to cut one from — except a
  // fork, whose copied conversation lives with the parent's checkout.
  const isolation = isolationArg ?? (fork ? "shared" : parent.thread.branch ? "worktree" : "shared");
  const title = argString(args, "title");
  const provider = argString(args, "provider");
  const model = argString(args, "model");
  const effort = argString(args, "effort");
  const delegated = await api.dispatch({
    type: "thread.delegate",
    parentThreadId,
    task,
    wait: false,
    isolation,
    ...(title ? { title } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { thinkingEffort: effort } : {}),
    ...(fork ? { fork: true } : {}),
  });
  return {
    taskId: delegated.task.taskId,
    title: delegated.child.title,
    status: delegated.task.status,
    model: `${delegated.modelSelection.instanceId}/${delegated.modelSelection.model}`,
    isolation,
    ...(delegated.worktree ? { worktree: delegated.worktree.path, branch: delegated.worktree.branch } : {}),
    next: "Call task_status with this taskId to wait for the report.",
  };
}

async function statusTool(
  api: ClientApi,
  parentThreadId: string,
  args: Record<string, unknown>,
  sleep: (ms: number) => Promise<void>,
) {
  const taskId = argString(args, "taskId", true)!;
  const rawWait = args.waitMs;
  const waitMs =
    typeof rawWait === "number" && Number.isFinite(rawWait) ? Math.min(Math.max(0, rawWait), MAX_WAIT_MS) : MAX_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let described = await api.query({ type: "thread.task.status", parentThreadId, taskId });
  while (!TERMINAL.has(described.task.status) && Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    described = await api.query({ type: "thread.task.status", parentThreadId, taskId });
  }
  const finished = TERMINAL.has(described.task.status);
  return {
    taskId,
    status: described.task.status,
    finished,
    ...(described.child.worktreePath ? { worktree: described.child.worktreePath, branch: described.child.branch } : {}),
    ...(finished ? { report: described.task.summary } : { next: "Still running: call task_status again." }),
  };
}

/**
 * The catalog as an agent needs it to route work: enabled providers, their
 * visible models, each model's effort values. Compact on purpose — a full
 * provider catalog (every models.dev entry, capability descriptors) would
 * cost more context than the delegation it serves.
 */
async function modelsTool(api: ClientApi, args: Record<string, unknown>) {
  const only = argString(args, "provider");
  const { providers } = await api.query({ type: "providers.list" });
  const rows = providers
    .filter((provider) => provider.enabled && provider.installed)
    .filter((provider) => only === undefined || provider.instanceId === only)
    .map((provider) => {
      const visible = provider.models.filter((model) => !model.isHidden);
      return {
        provider: provider.instanceId,
        name: provider.displayName ?? provider.instanceId,
        ...(provider.usageLimits ? { usageLimits: provider.usageLimits } : {}),
        models: visible.slice(0, MAX_MODELS_PER_PROVIDER).map((model) => {
          const efforts = model.efforts.find((descriptor) => descriptor.id === "effort")?.choices.map((choice) => choice.id) ?? [];
          return { model: model.slug, name: model.name, ...(efforts.length > 0 ? { efforts } : {}) };
        }),
        ...(visible.length > MAX_MODELS_PER_PROVIDER ? { moreModels: visible.length - MAX_MODELS_PER_PROVIDER } : {}),
      };
    });
  if (only !== undefined && rows.length === 0) {
    throw new CliError("PROVIDER_NOT_FOUND", `No enabled provider "${only}". Call models without provider to see them.`);
  }
  return { providers: rows };
}

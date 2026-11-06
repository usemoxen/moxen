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
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { CliError } from "../../core/errors.js";
import { knowledgeInput, KNOWLEDGE_LIMITS } from "../../core/knowledge/input.js";
import { untrustedContext } from "../../core/untrusted.js";
import { fetchPage } from "../../core/providers/harness/web/fetch.js";
import { webPolicy, type WebPolicy } from "../../core/providers/harness/web/settings.js";
import type { HarnessProviderConfig, WebConfig } from "../../core/types.js";
import type { DelegatedTaskStatus } from "../../core/threads/views.js";
import { isResearchRunActive } from "../../core/threads/operations.js";
import { parseQueuePolicy } from "../../core/threads/queue.js";
import { usageKeyForInstance } from "../../core/usage/limits.js";
import type { ClientApi } from "../api.js";
import { decodeResearchPlan, type CommandResult } from "../protocol.js";

export const MAX_WAIT_MS = 45_000;
/**
 * How long `task_ask` waits for a side answer. The call runs inside the
 * orchestrator's turn, and MCP clients cap a tool call (Codex at 60s), so it
 * must answer with something either way.
 */
export const MAX_ASK_MS = 45_000;
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
/**
 * How long `usage_status` waits for a cheap fresh usage reading before
 * answering from the stored one instead. Covers the slowest cheap probe
 * (OpenCode Go's five-second HTTP read); a slower probe keeps running and
 * freshens the next call through the normal event path.
 */
export const USAGE_REFRESH_TIMEOUT_MS = 8_000;
/**
 * A stored usage reading older than this is flagged stale: older than any
 * live session's reporting rhythm, so it may lag what the provider shows now.
 */
export const USAGE_STALE_AFTER_MS = 5 * 60_000;
export const SUBMIT_HANDOFF_TOOL: McpTool = {
  name: "submit_handoff",
  description: "Submit the handoff summary requested by Moxen. Send only the summary here, using the requestId in the summary request. Acceptance stores it durably; no final-response summary is needed. Moxen owns scheduling and creating the new thread. Unrequested or stale submissions are refused.",
  inputSchema: { type: "object", properties: { requestId: { type: "string" }, summary: { type: "string", minLength: 1, maxLength: 64000 } }, required: ["requestId", "summary"], additionalProperties: false },
};

export const IMAGE_GENERATION_TOOL: McpTool = {
  name: "image_gen",
  description: "Generate or edit an image through Codex's native image tool using the user's paid ChatGPT subscription. Pass prompt and optionally up to five absolute reference-image paths to start a focused Codex task using the newest released Luna model and its lowest supported reasoning effort other than none. The child thread is hidden from thread lists, but its results and cancellation remain available by taskId. Returns at once with taskId; a notification arrives when it settles. Then call image_gen with taskId (and optional waitMs, max 45000) to read the actual generated image paths. Treat an empty images list as failure, regardless of the agent's report. Cancel a running image task with task_cancel. New generations require at least 3% five-hour and 1% weekly Codex usage remaining; Moxen checks this at every invocation.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The image to generate or the changes to make. Do not pass with taskId." },
      references: { type: "array", items: { type: "string" }, maxItems: 5, description: "Absolute paths to reference images on the server machine." },
      taskId: { type: "string", description: "Read a previously started image task instead of starting one." },
      waitMs: { type: "number", description: "Wait up to 45000 ms for a task's result." },
    },
    additionalProperties: false,
  },
};

export const MOXEN_TOOLS: readonly McpTool[] = [
  {
    name: "knowledge_search",
    description: "Search this Moxen server's bundled knowledge base for settings, Harness profiles, MCP servers, models, projects, threads, skills and troubleshooting. Works offline; does not read current configuration. Returns up to six sections with excerpts; use each result's id and section with knowledge_read. No matches: try the command, setting key or a shorter query.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: KNOWLEDGE_LIMITS.query } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "knowledge_read",
    description: "Read a page or section from this Moxen server's shipped knowledge base. Pass an id from knowledge_search and optionally its section ID. Large pages return a section outline instead of truncating content. Reference defaults are not current settings; use the documented inspection commands to check live state. Reading grants no permission to change anything.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: KNOWLEDGE_LIMITS.id }, section: { type: "string", minLength: 1, maxLength: KNOWLEDGE_LIMITS.section } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "delegate",
    description:
      "Hand a self-contained task to a new subagent thread, which runs in parallel on any provider and model. " +
      "Only when the user has asked you to delegate (or put the thread in Research or Orchestrate mode): each subagent starts cold and spends their usage, so by default do the work yourself. " +
      "Research defaults to one researcher. For claims that matter and need an adversarial check, propose a full research run with researchProposal (size and optional per-role models). " +
      "A full run costs a lead, researchers, critics and a finalizer. Only the user's answer starts one; without an answering client or after its answer deadline, it runs one researcher instead. " +
      "By default it works in its own git worktree, on a new branch cut from yours, and commits there. " +
      "The default is always a worktree (except fork: true, which shares your checkout): even when your thread's record names no branch, the worktree is cut from the branch your checkout is on. " +
      "Where there is no branch to cut from, the call fails and tells you to pass isolation shared instead of quietly sharing your checkout. " +
      "One call can start several tasks (at most 20): pass tasks (each with title and task, overriding provider, model, effort or isolation where it differs) beside the shared settings, plus rules for instructions every task gets. " +
      "A task entry takes only task, title, provider, model, effort, isolation and idempotencyKey; anything else is refused. " +
      "An entry on another provider does not inherit the shared model or effort: it names its own model, or its start fails. " +
      "What is bad on its face — a malformed entry, a forked task in a worktree, a provider with no model anywhere — fails the whole call with nothing started. " +
      "Once starting, each task is on its own: one that fails to start is reported as that entry's error while the rest still start. " +
      "A top-level idempotencyKey is derived per entry from the key plus the entry's own title and task, so retrying the whole call — in any order, with entries added or removed — returns each original task instead of starting duplicates; a task's own idempotencyKey wins. " +
      "Each task starts on its own: one that fails to start is reported as that entry's error while the rest still start. " +
      "The result lists every task's taskId and isolation, with one warning when any task shares your checkout. " +
      "A proposal waits at most 45 seconds for the user; otherwise returns at once with a taskId. Do not poll: the subagent's result arrives as a task notification when it settles, so keep working on something else or end your turn and wait.",
    inputSchema: {
      type: "object",
      properties: {
        researchProposal: {
          type: "object",
          description: "Propose a full run, only with mode research. This is not permission to start it. Role models use provider, model and thinkingEffort from models.",
          properties: {
            size: { type: "object", properties: { researchers: { type: "integer", minimum: 1, maximum: 8 }, critics: { type: "integer", enum: [1, 3] } }, required: ["researchers", "critics"], additionalProperties: false },
            models: { type: "object", properties: Object.fromEntries(["researcher", "critic", "finalizer"].map((role) => [role, {
              type: "object", properties: { provider: { type: "string" }, model: { type: "string" }, thinkingEffort: { type: "string" } }, additionalProperties: false,
            }])), additionalProperties: false },
          },
          required: ["size"], additionalProperties: false,
        },
        task: { type: "string", description: "Everything the subagent needs: it sees none of your conversation. Pass this and title for one task, or tasks for several (not both)." },
        title: {
          type: "string",
          description: "Short name for the subagent's thread, a few words (\"fix login redirect\"). It also names its worktree branch, moxen/<name>.",
        },
        tasks: {
          type: "array",
          description: "Several tasks to start in one call, each with its own title and task and able to override provider, model, effort or isolation. Not with task, title or researchProposal.",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "Everything this subagent needs: it sees none of your conversation." },
              title: { type: "string", description: "Short name for this subagent's thread, a few words. It also names its worktree branch, moxen/<name>." },
              provider: { type: "string", description: "Provider instance id for this task; defaults to the shared provider." },
              model: { type: "string", description: "Model slug on that provider for this task; defaults to the shared model." },
              effort: { type: "string", description: "Reasoning effort for this task; defaults to the shared effort." },
              isolation: { type: "string", enum: ["worktree", "shared"], description: "Isolation for this task; defaults to the shared isolation." },
              idempotencyKey: { type: "string", description: "A UUID you generate for this task (one per new task). Wins over a call-level idempotencyKey for this entry." },
            },
            required: ["task", "title"],
            additionalProperties: false,
          },
        },
        rules: { type: "string", description: "Shared instructions appended to every task's prompt under \"Common rules for this task\" (report format, limits on side effects). Only with tasks." },
        idempotencyKey: {
          type: "string",
          description:
            "A UUID you generate for this task (one per new task). If this call fails with a transport error, retry with the SAME key: " +
            "the retry returns the original task instead of starting a duplicate.",
        },
        provider: { type: "string", description: "Provider instance id (claudeAgent, opencode/<provider>…); defaults to yours. The models tool lists them." },
        model: { type: "string", description: "Model slug on that provider; defaults to yours." },
        effort: { type: "string", description: "Reasoning effort for that model (one of its efforts in the models tool); defaults to the model's own." },
        isolation: {
          type: "string",
          enum: ["worktree", "shared"],
          description: "worktree (default, except for a fork): its own checkout and branch. shared: works in your checkout, for read-only work. Omit it for the default: where there is no branch to cut from, omitting it fails plainly instead of sharing your checkout.",
        },
        fork: {
          type: "boolean",
          description:
            "Start the subagent from a copy of your conversation so far (same provider, your checkout) instead of from nothing. " +
            "For side questions that need your context; the task text can then be short.",
        },
        mode: {
          type: "string",
          enum: ["build", "research"],
          description:
            "build (default): the subagent does the task directly. research: the subagent works as a researcher (its own tools, read only) and answers in the research report format. " +
            "A subagent cannot delegate, and Orchestrate is not available to one.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    description:
      "Where a delegated task stands: running, or finished with the subagent's report and the branch holding its work. " +
      "For a full report after a task notification, or one deliberate check on a task taking far longer than expected; never as a polling loop. " +
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
      "here, and only models the user has not hidden, plus each provider's usage limits (session, weekly and monthly windows) when known. " +
      "Those limits can be hours old: usage_status reads them fresh before you decide where there is headroom. " +
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
    name: "context_usage",
    description:
      "How full your own context window is: tokens used, the window size, the percent used, and when that reading was taken. " +
      "It is the same number the user's Moxen screen shows for this thread, taken from the latest reading Moxen recorded. " +
      "Totals only. It never estimates: with no reading yet it says so, and a reading from before a compaction is marked as not current. " +
      "Use it before deciding to compact or hand off instead of guessing. It takes no argument: always your own thread.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "usage_status",
    description:
      "The user's current shared provider usage, for every set-up provider: each window's percent used, reset time and label, when that reading was taken, and whether it is stale. " +
      "Also which provider your own thread runs on, and what usage protection holds or has queued. " +
      "Call it before fanning work out (Orchestrate: after models, before delegate), and whenever you must decide where there is headroom: the usageLimits in models can be hours old, while this tries a cheap fresh reading first and falls back to the stored one with its age. " +
      "A provider with no windows has no data, which is not the same as unlimited. " +
      "Read-only: it never spends provider usage.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "web_fetch",
    description:
      "Reads a web page or file by address and returns it as text: pages become readable text with their links, JSON and text files come back as they are. " +
      "Use it for documentation, an issue, an API response, or a server running on this machine (http://localhost:3000). " +
      "Pages built by scripts, or that turn away plain requests, are retried through a browser when one is installed; set render to true to go straight to it. " +
      "A long page is cut, and the whole text is saved to a file whose path is given. It cannot sign in: use the command line for a service the user is signed in to (gh for GitHub).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full address to fetch." },
        render: { type: "boolean", description: "Load the page in a browser first, for pages built by scripts." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "task_cancel",
    description: "Stop a delegated task that is still running. Its thread and worktree are kept. Pass taskIds (several) to stop more than one: each task's outcome is reported separately, and one bad id does not stop the others.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "One delegated task to stop. Not with taskIds." },
        taskIds: { type: "array", items: { type: "string" }, description: "Several delegated tasks to stop, each reported separately. Not with taskId." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "task_send",
    description:
      "Send a message to a task you delegated, to correct or redirect it without cancelling it. It arrives as a message from you, not from the user. " +
      "The result's outcome says what happened: steered (the running turn received it and reads it at its next step); " +
      "queued (the task is busy and cannot take input mid-turn, so the message waits and runs as its next turn: it has NOT read it yet); " +
      "started (a new turn began on an idle task); not_delivered (recorded but it did not reach the running turn: send it again after the task settles). " +
      "Never assume the task read a message unless the outcome is steered or started. " +
      "A task that has finished or been settled is refused unless you pass wake: true, which starts a new turn on it and spends usage; you then get a task notification when it settles again. " +
      "Only reaches your own tasks, and not a research run's roles or lead.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        message: { type: "string", description: "What the task should know or do. It has none of your conversation: say it in full." },
        wake: { type: "boolean", description: "Allow starting a new turn on a task that has finished or been settled (default false)." },
      },
      required: ["taskId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "task_ask",
    description:
      "Ask a task you delegated a side question, like /btw, without disturbing it: it answers on a copy of its thread, with no tools, and adds nothing to its conversation or its turn, so it works while the task is running. " +
      "Use it to check on a long task's progress or what it decided, when thread_read would cost too much context or show steps instead of meaning. " +
      "The answer cannot run commands or read files, so a limitation it names is the answer's, not the task's. " +
      `Waits at most ${MAX_ASK_MS / 1000} seconds. A provider that cannot answer says so plainly; fall back to thread_read then. ` +
      "Only reaches your own tasks, and not a research run's roles or lead.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        question: { type: "string", description: "What to ask about the task's work. It can only use what is already in the task's thread." },
      },
      required: ["taskId", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "message_queue",
    description:
      "Queue a message on a thread, to run later: your own thread (the default: \"wake me after the usage reset\", \"check back in an hour\") or a task you delegated. " +
      "It goes into the same queue the user's composer uses, so the entry shows in Work queue, where the user can edit or remove it. " +
      "The message arrives as a message from you, not from the user. It is never a steer and never interrupts a turn. " +
      "With no at and no conditions it queues behind the current turn and runs once when that turn ends (on an idle task it starts a turn at once). " +
      "at holds it until a time; conditions hold it until the queue's own conditions are met; with both, it waits for both. " +
      "Returns the entry's turnId, the threadId, and when it is expected to run. On a thread usage protection holds, the message waits behind the hold and does not end it. " +
      "You can queue only on your own thread and tasks you delegated, and not on a research run's roles or lead. " +
      "The message has none of your conversation when it runs: say it in full.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What the thread should do or know when it runs. Say it in full." },
        threadId: { type: "string", description: "A task you delegated. Omit for your own thread." },
        delivery: { type: "string", enum: ["queue"], description: "Always queue: a queued message waits its turn. Steering and restarting are not offered." },
        at: { type: "string", description: "When to run it: an ISO date-time, or HH:MM on the machine's clock (today, or tomorrow once that has passed)." },
        conditions: {
          type: "array",
          maxItems: 16,
          description: "Hold it until all of these are met. Each is an object with a type: " +
            "{type:\"reset\", provider, window:\"session\"|\"weekly\"|\"all\"} (after that allowance resets); " +
            "{type:\"usage\", provider, window, minimum} (at least minimum percent of the allowance left); " +
            "{type:\"thread\", threadId} (after that thread has nothing running or queued); " +
            "{type:\"entry\", threadId, turnId} (after that queue entry has run); " +
            "{type:\"at\", at} (an ISO time); " +
            "{type:\"provider\", provider, state:\"exhausted\"|\"protected\", mode:\"after\"|\"while\"}.",
          items: { type: "object" },
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

/** Finding and reading other threads (MXN-133). Results stay in the caller's context, so each answer is held to a budget. */
export const THREAD_TOOLS: readonly McpTool[] = [
  {
    name: "thread_search",
    description:
      "Find other Moxen threads by what is in them: titles, messages and tool calls, settled threads included. " +
      "Returns up to limit threads (default 10), each with its id, title, project, status, last activity and up to 3 snippets. " +
      'scope "project" (the default) searches this project\'s threads; use "all" only when the work you are looking for may have happened in another project. ' +
      "Then read one with thread_read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words that must all appear in the same message, tool call or title, in any order." },
        scope: { type: "string", enum: ["project", "all"] },
        limit: { type: "number", description: "Threads to return, 1–25 (default 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "thread_read",
    description:
      "Read another Moxen thread a step at a time. With only id: an outline, one line per turn, newest first (before: N goes further back). " +
      'With turns ("12" or "12-14"): what was written in those turns, each tool call shrunk to one line numbered like 12.3. ' +
      "With item (\"12.3\"): that tool call's full input and output. Long answers come in pages: the answer names the offset for the rest. " +
      "Everything returned stays in your context, so read only what you need and never the same range twice. " +
      'scope "project" (the default) reads this project\'s threads; use "all" for a thread thread_search found in another project.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The thread's id, from thread_search." },
        turns: { type: "string" },
        item: { type: "string" },
        offset: { type: "number", description: "Where the previous page of these turns or this item stopped." },
        before: { type: "number", description: "Outline: list turns before this number." },
        scope: { type: "string", enum: ["project", "all"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

/**
 * The tools that reach other threads: handing work to them, and finding and
 * reading them. A delegated task is itself the delegation, so it gets none.
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(["delegate", "task_status", "models", "task_cancel", "task_send", "task_ask", "message_queue", "thread_search", "thread_read", "image_gen"]);

const RESEARCH_ROLE_TOOLS: readonly McpTool[] = [
  {
    name: "research_role_start",
    description: "Start a read-only researcher, critic or finalizer in your research run. " +
      "The chosen researcher count is a total for the run; finished roles do not free slots. " +
      "Each role is a nested thread, not another orchestrator task. Choose its question. " +
      "The run's user-approved role model and effort take precedence over requested overrides.",
    inputSchema: { type: "object", properties: { role: { type: "string", enum: ["researcher", "critic", "finalizer"] }, question: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, effort: { type: "string" } }, required: ["role", "question"] },
  },
  { name: "research_role_report", description: "Read the state and report of one role in your research run.", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "research_role_cancel", description: "Cancel a role in your research run, keeping its thread and report.", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
];

const RESEARCH_MESSAGE_TOOLS: readonly McpTool[] = [
  { name: "research_messages", description: "Read only your research run's recorded hand-offs, researcher reports, critic verdicts and lead follow-ups. The run comes from your calling thread; no target is accepted.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "research_message_submit",
    description: "Submit to your own research run. Researcher reports share a findings revision until a verdict; a report after review starts a new revision. " +
      "Each critic may submit at most three verdicts for the whole run, without resets. The lead publishes follow-ups. Read research_messages first. " +
      "A finalizer requires at least one critic, and every started critic must have a current verdict or have exhausted its three rounds.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
];

/** Moxen memory, as a session has it: every tool, read/search (a delegated task), or none. */
export type MemoryAccess = "write" | "read" | "off";

const MEMORY_SCOPE_ADVICE =
  "global: about the user wherever they work (role, preferences, feedback that holds in every project). project: anything about this codebase or the work on it.";

/** Moxen memory's tools (`core/memory/`): a memory per file, the index written by Moxen. */
export const MEMORY_TOOLS: readonly McpTool[] = [
  {
    name: "memory_read",
    description:
      "Read Moxen's persistent memory. With a name: that memory in full (the project's first, then the global, unless scope says which). " +
      "With no name: the current index, global first, one line each, capped per scope. Use memory_search for topics missing from it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The memory's name, as the index lists it." },
        scope: { type: "string", enum: ["project", "global"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_search",
    description:
      "Search Moxen's persistent memory across names, descriptions and bodies, including memories omitted from the index. " +
      "Searches the current project and global scope, or just the scope given. Case-insensitive, with words split at punctuation; " +
      "any word can match. When local embeddings are enabled and set up, semantic relevance also finds paraphrases; otherwise keywords rank by distinct words, then name and description matches. Returns names, scopes, descriptions and short excerpts. " +
      "Read a result in full with memory_read using its name and scope.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000, description: "Words or a question to find in memory." },
        scope: { type: "string", enum: ["project", "global"] },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results, from 1 to 50 (default 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_save",
    description:
      "Save one fact to Moxen's persistent memory, read by every later session in its scope; saving under an existing name replaces that memory. " +
      "For corrections and guidance on how to work, confirmed approaches, decisions and why, external references, and lessons worth keeping; " +
      "not for what the code, git history or AGENTS.md / CLAUDE.md already record. Moxen updates the index itself. " +
      MEMORY_SCOPE_ADVICE,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short kebab-case slug (\"prefers-bun-test\")." },
        description: { type: "string", description: "One line: what it is about, used to decide when it is relevant." },
        type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "user: who they are. feedback: how they want you to work. project: work, goals, decisions. reference: where to find something." },
        body: { type: "string", description: "The memory: the fact, then why it holds and how to apply it." },
        scope: { type: "string", enum: ["project", "global"], description: MEMORY_SCOPE_ADVICE },
      },
      required: ["name", "description", "type", "body", "scope"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_edit",
    description:
      "Change one piece of a memory that exists, like the file Edit tool: old_string must be in the memory's body exactly once (read it with memory_read first and copy the text), " +
      "and is replaced by new_string. Prefer this to memory_save for a small change: you send only the change, not the whole memory. Moxen updates the index itself.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The memory's name, as the index lists it." },
        scope: { type: "string", enum: ["project", "global"] },
        old_string: { type: "string", description: "The text to replace: exactly as it is in the body, and only once there." },
        new_string: { type: "string", description: "What replaces it; empty removes the text." },
        description: { type: "string", description: "Optional: a new one-line description, when the change makes the old one wrong." },
      },
      required: ["name", "scope", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_append",
    description:
      "Add text to the end of a memory that exists, without reading it first: for one more fact that belongs with what it already says. " +
      "A memory that does not exist is a memory_save. Moxen updates the index itself.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The memory's name, as the index lists it." },
        scope: { type: "string", enum: ["project", "global"] },
        text: { type: "string", description: "What to add after the body: a line or a short paragraph." },
      },
      required: ["name", "scope", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory that turned out to be wrong or no longer holds. Moxen updates the index itself.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["name", "scope"],
      additionalProperties: false,
    },
  },
];

const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set(["memory_save", "memory_edit", "memory_append", "memory_delete"]);

export interface MoxenToolOptions {
  readonly researchMember?: boolean;
  readonly researchLead?: boolean;
  readonly handoff?: boolean;
  readonly imageGeneration?: boolean;
  readonly checklist?: boolean;
  readonly delegated?: boolean;
  readonly webFetch?: boolean;
  /** Absent: write. */
  readonly memory?: MemoryAccess;
}

/** Whether a session with these options may call `name`: hidden tools are refused too, since a client can call a tool it was never shown. */
function offered(name: string, options: MoxenToolOptions): boolean {
  if (options.delegated === true && DELEGATION_TOOLS.has(name)) return false;
  if (options.webFetch === false && name === "web_fetch") return false;
  const memory = options.memory ?? "write";
  if (name.startsWith("memory_") && (memory === "off" || (memory === "read" && MEMORY_WRITE_TOOLS.has(name)))) return false;
  return true;
}

/** The tools one session is offered: all of them, less the delegation ones for a delegated task, plus the checklist where the provider keeps none. */
export function moxenToolsFor(options: MoxenToolOptions): readonly McpTool[] {
  const tools = [...MOXEN_TOOLS, ...THREAD_TOOLS, ...MEMORY_TOOLS].filter((tool) => offered(tool.name, options));
  if (options.researchLead === true) tools.push(...RESEARCH_ROLE_TOOLS);
  if (options.researchMember === true) tools.push(...RESEARCH_MESSAGE_TOOLS);
  if (options.imageGeneration === true && options.delegated !== true) tools.push(IMAGE_GENERATION_TOOL);
  if (options.handoff === true) tools.push(SUBMIT_HANDOFF_TOOL);
  return options.checklist === true ? [...tools, TODOS_TOOL] : tools;
}

export async function availableMoxenTools(api: ClientApi, threadId: string, options: MoxenToolOptions): Promise<readonly McpTool[]> {
  const run = await api.query({ type: "research.run", threadId }).catch(() => null);
  const active = isResearchRunActive(run);
  const researchLead = active && run?.leadThreadId === threadId;
  const imageGeneration = options.delegated !== true && await api.query({ type: "image-generation.availability", threadId }).then((result) => result.available === true, () => false);
  const handoff = await api.query({ type: "handoff.pending", threadId }).then((result) => result?.requestId != null, () => false);
  return moxenToolsFor({ ...options, ...(run && (active || run.leadThreadId !== threadId) ? { delegated: true } : {}), imageGeneration, handoff, researchLead, researchMember: active });
}

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
  options: { readonly sleep?: (ms: number) => Promise<void>; readonly delegated?: boolean; readonly webFetch?: boolean; readonly memory?: MemoryAccess; readonly web?: () => Promise<WebPolicy>; readonly askTimeoutMs?: number; readonly usageRefreshMs?: number } = {},
): Promise<ToolResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Hidden from the list, and refused here too: a client can call a tool it was never shown.
  if (options.delegated === true && DELEGATION_TOOLS.has(name)) return { text: `${name} is not available in a delegated task: do the task yourself.`, isError: true };
  if (options.webFetch === false && name === "web_fetch") return { text: "web_fetch is switched off for this provider.", isError: true };
  if (!offered(name, options) && name.startsWith("memory_")) {
    return { text: options.memory === "read" ? `${name} is not available in a delegated task: put what is worth remembering in your report.` : "Moxen memory is switched off here.", isError: true };
  }
  try {
    switch (name) {
      case "research_messages":
        return ok(await api.query({ type: "research.messages", threadId: parentThreadId }));
      case "research_message_submit":
        return ok(await api.dispatch({ type: "research.message.submit", threadId: parentThreadId, text: argString(args, "text", true)! }));
      case "research_role_start":
        return ok(await api.dispatch({ type: "research.role.start", leadThreadId: parentThreadId, role: argString(args, "role", true)! as "researcher", question: argString(args, "question", true)!, ...(argString(args, "provider") ? { provider: argString(args, "provider")! } : {}), ...(argString(args, "model") ? { model: argString(args, "model")! } : {}), ...(argString(args, "effort") ? { thinkingEffort: argString(args, "effort")! } : {}) }));
      case "research_role_report":
        return ok(await api.query({ type: "research.role.report", leadThreadId: parentThreadId, taskId: argString(args, "taskId", true)! }));
      case "research_role_cancel":
        return ok(await api.dispatch({ type: "research.role.cancel", leadThreadId: parentThreadId, taskId: argString(args, "taskId", true)! }));
      case "submit_handoff":
        return ok(await api.dispatch({ type: "handoff.submit", threadId: parentThreadId, requestId: argString(args, "requestId", true)!, summary: argString(args, "summary", true)! }));
      case "knowledge_search":
        return { text: JSON.stringify(await api.query({ type: "knowledge.search", query: knowledgeInput(args.query, "query") })), isError: false };
      case "knowledge_read":
        return { text: JSON.stringify(await api.query({ type: "knowledge.read", id: knowledgeInput(args.id, "id"), ...(args.section === undefined ? {} : { section: knowledgeInput(args.section, "section") }) })), isError: false };
      case "image_gen": {
        const result = await imageGenerationTool(api, parentThreadId, args, sleep);
        return { ...ok(result), isError: "error" in result };
      }
      case "delegate":
        return ok(await delegateTool(api, parentThreadId, args));
      case "task_status":
        return ok(await statusTool(api, parentThreadId, args, sleep));
      case "models":
        return ok(await modelsTool(api, args));
      case "context_usage":
        return ok(await contextUsageTool(api, parentThreadId));
      case "usage_status":
        return ok(await usageStatusTool(api, parentThreadId, options.usageRefreshMs ?? USAGE_REFRESH_TIMEOUT_MS));
      case "todos": {
        const todos = Array.isArray(args.todos) ? args.todos : null;
        if (todos === null) throw new CliError("INVALID_TOOL_INPUT", "todos must be an array of {content, status}.");
        const { plan, note } = checkTodos(todos);
        const recorded = await api.dispatch({ type: "thread.plan.set", threadId: parentThreadId, plan: plan as never });
        return ok({ recorded: recorded.steps, ...(note === null ? {} : { note }) });
      }
      case "web_fetch":
        return await webFetchTool(args, await (options.web ?? (() => currentWebPolicy(api)))());
      case "thread_search":
        return await threadSearchTool(api, parentThreadId, args);
      case "thread_read": {
        const scope = args.scope === "all" ? "all" : "project";
        const read = await api.query({
          type: "thread.agent-read",
          callerThreadId: parentThreadId,
          threadId: argString(args, "id", true)!,
          scope,
          ...(argString(args, "turns") !== undefined ? { turns: argString(args, "turns")! } : {}),
          ...(argString(args, "item") !== undefined ? { item: argString(args, "item")! } : {}),
          ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
          ...(typeof args.before === "number" ? { before: args.before } : {}),
        });
        return { text: read.text, isError: false };
      }
      case "memory_search": {
        const found = await api.query({
          type: "memory.search",
          threadId: parentThreadId,
          query: argString(args, "query", true)!,
          ...(args.scope !== undefined ? { scope: args.scope as "project" | "global" } : {}),
          ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
        });
        const notice = found.semantic?.state === "unavailable"
          ? `${found.semantic.message ?? "Semantic search is unavailable; using keyword search."}\n\n`
          : "";
        if (found.total === 0) return { text: `${notice}No matching memories.`, isError: false };
        const lines = found.memories.map((memory) =>
          `- ${memory.name} (${memory.scope}, ${memory.type}): ${memory.description}\n  ${memory.excerpt}`);
        return { text: `${notice}${found.total} matching memories; showing ${found.memories.length}.\n\n${lines.join("\n\n")}\n\nRead a memory in full with memory_read(name, scope).`, isError: false };
      }
      case "memory_read": {
        const name = argString(args, "name");
        if (name === undefined) {
          const listed = await api.query({ type: "memory.list", threadId: parentThreadId });
          return { text: listed.index ?? "No memories yet.", isError: false };
        }
        const memory = await api.query({ type: "memory.read", threadId: parentThreadId, name, ...(args.scope !== undefined ? { scope: args.scope as "project" | "global" } : {}) });
        return { text: `${memory.name} (${memory.scope}, ${memory.type}): ${memory.description}\n\n${memory.body}`, isError: false };
      }
      case "memory_save":
        return ok(
          await api.dispatch({
            type: "memory.save",
            threadId: parentThreadId,
            name: argString(args, "name", true)!,
            description: argString(args, "description", true)!,
            memoryType: argString(args, "type", true)! as "user",
            body: argString(args, "body", true)!,
            scope: argString(args, "scope", true)! as "project",
          }),
        );
      case "memory_edit":
        return ok(
          await api.dispatch({
            type: "memory.edit",
            threadId: parentThreadId,
            name: argString(args, "name", true)!,
            scope: argString(args, "scope", true)! as "project",
            oldText: argString(args, "old_string", true)!,
            newText: typeof args.new_string === "string" ? args.new_string : argString(args, "new_string", true)!,
            ...(argString(args, "description") === undefined ? {} : { description: argString(args, "description")! }),
          }),
        );
      case "memory_append":
        return ok(await api.dispatch({ type: "memory.append", threadId: parentThreadId, name: argString(args, "name", true)!, scope: argString(args, "scope", true)! as "project", text: argString(args, "text", true)! }));
      case "memory_delete":
        return ok(await api.dispatch({ type: "memory.delete", threadId: parentThreadId, name: argString(args, "name", true)!, scope: argString(args, "scope", true)! as "project" }));
      case "task_cancel": {
        const ids = cancelIds(args);
        if (args.taskIds === undefined) {
          const cancelled = await cancelOne(api, parentThreadId, ids[0]!);
          return ok({ taskId: ids[0], cancelRequested: cancelled.interruptRequested, status: cancelled.task.status });
        }
        const tasks: Array<Record<string, unknown>> = [];
        let firstFailure: unknown;
        for (const taskId of ids) {
          try {
            const cancelled = await cancelOne(api, parentThreadId, taskId);
            tasks.push({ taskId, cancelRequested: cancelled.interruptRequested, status: cancelled.task.status });
          } catch (cause) {
            firstFailure ??= cause;
            tasks.push({ taskId, error: toolErrorText(cause) });
          }
        }
        await throwIfParentMissing(api, parentThreadId, tasks, firstFailure);
        return ok({ tasks });
      }
      case "task_send": {
        if (args.wake !== undefined && typeof args.wake !== "boolean") throw new CliError("INVALID_TOOL_INPUT", "wake must be true or false.");
        const taskId = argString(args, "taskId", true)!;
        const sent = await api.dispatch({ type: "thread.task.send", parentThreadId, taskId, message: argString(args, "message", true)!, ...(args.wake === true ? { wake: true } : {}) });
        return ok({ taskId, outcome: sent.outcome, status: sent.task.status, woke: sent.woke, note: sent.note });
      }
      case "task_ask":
        return await taskAskTool(api, parentThreadId, args, options.askTimeoutMs ?? MAX_ASK_MS);
      case "message_queue": {
        if (args.delivery !== undefined && args.delivery !== "queue") throw new CliError("INVALID_TOOL_INPUT", "delivery must be \"queue\": a queued message cannot steer, restart or start a turn on its own.");
        if (args.conditions !== undefined && !Array.isArray(args.conditions)) throw new CliError("INVALID_TOOL_INPUT", "conditions must be an array of queue conditions.");
        const queued = await api.dispatch({
          type: "thread.message.queue",
          callerThreadId: parentThreadId,
          message: argString(args, "message", true)!,
          ...(argString(args, "threadId") !== undefined ? { threadId: argString(args, "threadId")! } : {}),
          ...(argString(args, "at") !== undefined ? { at: argString(args, "at")! } : {}),
          ...(Array.isArray(args.conditions) ? { conditions: parseQueuePolicy({ conditions: args.conditions }).conditions } : {}),
        });
        return ok(queued);
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

const SEARCH_SNIPPET_CHARS = 120;

/** `thread_search`: the store's search, scoped to the caller's project unless asked for all, the caller itself left out. */
async function threadSearchTool(api: ClientApi, parentThreadId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const query = argString(args, "query", true)!;
  const scope = args.scope === "all" ? "all" : "project";
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(25, Math.max(1, Math.floor(args.limit))) : 10;
  const projectId = scope === "project" ? (await api.query({ type: "thread.inspect", threadId: parentThreadId })).thread.projectId : undefined;
  const found = await api.query({ type: "threads.search", query, limit: limit + 1, hitsPerThread: 3, ...(projectId ? { projectId } : {}) });
  const threads = found.threads.filter((thread) => thread.threadId !== parentThreadId).slice(0, limit);
  if (threads.length === 0) {
    return { text: `No ${scope === "project" ? "thread in this project" : "thread"} matches "${query}".${scope === "project" ? ' Try scope "all" if it may be in another project.' : ""}`, isError: false };
  }
  const cut = (text: string) => (text.length <= SEARCH_SNIPPET_CHARS ? text : `${text.slice(0, SEARCH_SNIPPET_CHARS - 1)}…`);
  const body = threads
    .map((thread) =>
      [
        `- "${thread.title}" · id ${thread.threadId} · project ${thread.projectId} · ${thread.status} · last activity ${thread.updatedAt ?? "unknown"} · ${thread.hitCount} match${thread.hitCount === 1 ? "" : "es"}`,
        ...thread.hits.map((hit) => `    ${hit.kind}${hit.source ? ` (${hit.source})` : ""}: ${cut(hit.snippet)}`),
      ].join("\n"),
    )
    .join("\n");
  const others = Math.max(0, found.total - (found.threads.some((thread) => thread.threadId === parentThreadId) ? 1 : 0) - threads.length);
  const notes = [
    ...(others > 0 ? [`[Moxen] ${others} more thread${others === 1 ? "" : "s"} matched: narrow the query, or raise limit (at most 25).`] : []),
    `[Moxen] Read one with thread_read(id${scope === "all" ? ', scope: "all"' : ""}): the outline first, then the turns you need.`,
  ];
  return { text: [untrustedContext(body, "moxen:thread_search"), "", ...notes].join("\n"), isError: false };
}

/**
 * The Harness's `web_fetch`, offered to every provider: the same request, the
 * same refusal to reach cloud metadata, and the shared `web` settings for the
 * browser fallback and the local network (`webPolicy`). No approval step of
 * its own — the provider's permission prompt for an MCP tool is the user's say here.
 */
async function webFetchTool(args: Record<string, unknown>, policy: WebPolicy): Promise<ToolResult> {
  const url = argString(args, "url", true)!;
  const result = await fetchPage(
    url,
    { render: args.render === true },
    {
      policy: { allowPrivate: policy.allowPrivate },
      browser: policy.browser,
      env: process.env,
      artifactDir: path.join(os.tmpdir(), "moxen-web"),
      signal: AbortSignal.timeout(60_000),
      acceptsImages: false,
    },
  );
  return { text: result.content, isError: result.isError === true };
}

/**
 * The shared web settings as the server holds them now: read per call through
 * `ClientApi`, so every way a provider reaches these tools (in-process, the
 * loopback HTTP server, the stdio child) follows the same page. If they cannot
 * be read, no browser is started and the local network stays shut.
 */
async function currentWebPolicy(api: ClientApi): Promise<WebPolicy> {
  try {
    const { settings } = await api.query({ type: "settings.read" });
    const value = (key: string) => settings.find((view) => view.descriptor.key === key)?.value;
    const text = (key: string) => (typeof value(key) === "string" && value(key) !== "" ? (value(key) as string) : undefined);
    const flag = (key: string) => (typeof value(key) === "boolean" ? (value(key) as boolean) : undefined);
    const web: WebConfig = {
      ...(text("web.browser") === "off" || text("web.browser") === "auto" ? { browser: text("web.browser") as "auto" | "off" } : {}),
      ...(text("web.browserPath") ? { browserPath: text("web.browserPath")! } : {}),
      ...(flag("web.privateNetwork") !== undefined ? { privateNetwork: flag("web.privateNetwork")! } : {}),
    };
    const harness: HarnessProviderConfig = {
      ...(text("providers.harness.webBrowser") ? { webBrowser: text("providers.harness.webBrowser")! } : {}),
      ...(text("providers.harness.webBrowserPath") ? { webBrowserPath: text("providers.harness.webBrowserPath")! } : {}),
    };
    return webPolicy(web, harness, false);
  } catch {
    return { browser: { mode: "off" }, allowPrivate: false };
  }
}

function ok(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2), isError: false };
}

/**
 * The answer, or `"timeout"`. A side question can take longer than an MCP
 * client allows a tool call, and this runs inside the orchestrator's turn, so
 * the call returns a plain result either way. The work itself is not
 * cancelled: drivers that honor an abort signal would need one the protocol
 * cannot carry over a wire.
 */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `task_ask`: the task's own provider answers on a copy of its thread,
 * through the same `thread.side-question` path as `/btw`. The server enforces
 * that the caller delegated the task (or continued the thread that did).
 */
async function taskAskTool(api: ClientApi, parentThreadId: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
  const taskId = argString(args, "taskId", true)!;
  const question = argString(args, "question", true)!;
  let answered: CommandResult<"thread.task.ask"> | "timeout";
  try {
    answered = await withinDeadline(api.dispatch({ type: "thread.task.ask", parentThreadId, taskId, question }), timeoutMs);
  } catch (cause) {
    // A provider that cannot copy a session is a plain outcome, not a failed
    // call: the orchestrator can go straight to thread_read.
    if (cause instanceof CliError && cause.code === "SIDE_QUESTION_UNSUPPORTED") {
      const provider = (cause.details as { provider?: string } | undefined)?.provider;
      return ok({
        taskId,
        supported: false,
        code: cause.code,
        ...(provider === undefined ? {} : { provider }),
        reason: cause.message,
        next: "This is the provider's limit, not a fault in the task. Read where the task stands with thread_read instead; asking in the task's thread would interrupt it.",
      });
    }
    throw cause;
  }
  if (answered === "timeout") {
    return ok({
      taskId,
      timedOut: true,
      note: `No answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${Math.round(timeoutMs)} ms`}. The task is unchanged and still working. Check on it with task_status, or read its thread with thread_read; asking in the task's thread would interrupt it.`,
    });
  }
  return ok({
    taskId,
    status: answered.status,
    answer: answered.text,
    withContext: answered.withContext,
    provider: answered.provider,
    note: [
      "A side question: answered on a copy of the task's thread, with no tools, and nothing was added to the task or its turn.",
      "If the answer says it cannot run a command or read a file, that is this answer's limit, not a fault in the task.",
      ...(answered.withContext ? [] : ["The task had no session to read its context from, so this answer is not about the task's work."]),
    ].join(" "),
  });
}

async function imageGenerationTool(api: ClientApi, parentThreadId: string, args: Record<string, unknown>, sleep: (ms: number) => Promise<void>) {
  const prompt = argString(args, "prompt");
  const taskId = argString(args, "taskId");
  if ((prompt === undefined) === (taskId === undefined)) throw new CliError("INVALID_TOOL_INPUT", "Pass either prompt to generate an image or taskId to read its result.");
  if (taskId !== undefined) {
    const status = await statusTool(api, parentThreadId, args, sleep);
    // task_status above verifies that this task belongs to the caller before reading its ledger.
    const { thread } = await api.query({ type: "thread.read", threadId: taskId, view: "turn-items", lastTurn: true });
    const images = new Set<string>();
    if (thread.view === "turn-items") {
      const latest = new Map<string, Record<string, unknown>>();
      for (const activity of thread.items) {
        const payload = activity.payload as Record<string, unknown> | undefined;
        if (payload?.itemType === "image_generation" && typeof payload.toolCallId === "string") latest.set(payload.toolCallId, payload);
      }
      for (const payload of latest.values()) {
        const data = payload.data as { state?: { input?: { path?: unknown }; status?: string } } | undefined;
        const file = data?.state?.input?.path;
        if (data?.state?.status === "completed" && typeof file === "string" && path.isAbsolute(file)) images.add(file);
      }
    }
    return { ...status, images: [...images], ...(status.finished && images.size === 0 ? { error: "Codex finished without a successful image-generation result." } : {}) };
  }
  if (args.references !== undefined && (!Array.isArray(args.references) || args.references.length > 5 || !args.references.every((file) => typeof file === "string" && path.isAbsolute(file)))) throw new CliError("INVALID_TOOL_INPUT", "references must contain at most five absolute image paths.");
  const delegated = await api.dispatch({ type: "thread.image.generate", parentThreadId, prompt: prompt!, ...(args.references === undefined ? {} : { references: args.references as string[] }) });
  return { taskId: delegated.task.taskId, status: delegated.task.status, next: "An image task is running. Wait for its notification, then call image_gen with taskId to read generated image paths. Use task_cancel to cancel it." };
}

async function delegateTool(api: ClientApi, parentThreadId: string, args: Record<string, unknown>) {
  const isolationArg = argString(args, "isolation");
  if (isolationArg !== undefined && isolationArg !== "worktree" && isolationArg !== "shared") {
    throw new CliError("INVALID_TOOL_INPUT", "isolation must be worktree or shared.");
  }
  const fork = args.fork === true;
  const modeArg = argString(args, "mode");
  if (modeArg !== undefined && modeArg !== "build" && modeArg !== "research") {
    throw new CliError("INVALID_TOOL_INPUT", "mode must be build or research: a subagent never runs in Orchestrate.");
  }
  const provider = argString(args, "provider");
  const model = argString(args, "model");
  const effort = argString(args, "effort");
  const idempotencyKey = argString(args, "idempotencyKey");
  const rules = argString(args, "rules");
  if (args.tasks !== undefined) return await delegateManyTool(api, parentThreadId, args, { isolationArg: isolationArg === "worktree" || isolationArg === "shared" ? isolationArg : undefined, fork, modeArg, provider, model, effort, idempotencyKey, rules });
  if (rules !== undefined) throw new CliError("INVALID_TOOL_INPUT", "rules needs tasks: it is shared instructions for several tasks.");
  const task = argString(args, "task", true)!;
  const title = argString(args, "title", true)!;
  return await startDelegation(api, parentThreadId, {
    task, title,
    isolation: isolationArg ?? (fork ? "shared" : "worktree"),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(fork ? { fork: true } : {}),
    ...(modeArg === "research" ? { mode: "research" as const } : {}),
    ...(args.researchProposal === undefined ? {} : { researchProposal: args.researchProposal }),
  });
}

/** One `delegate` call starting several tasks: shared settings beside a list of entries, each with its own title and task. */
async function delegateManyTool(
  api: ClientApi,
  parentThreadId: string,
  args: Record<string, unknown>,
  shared: { isolationArg: "worktree" | "shared" | undefined; fork: boolean; modeArg: string | undefined; provider: string | undefined; model: string | undefined; effort: string | undefined; idempotencyKey: string | undefined; rules: string | undefined },
) {
  if (args.task !== undefined || args.title !== undefined) {
    throw new CliError("INVALID_TOOL_INPUT", "Pass either task and title for one task, or tasks for several — not both.");
  }
  if (args.researchProposal !== undefined) {
    throw new CliError("INVALID_TOOL_INPUT", "researchProposal proposes one full run: it cannot be combined with tasks.");
  }
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    throw new CliError("INVALID_TOOL_INPUT", "tasks must be a non-empty array of {task, title}.");
  }
  if (args.tasks.length > MAX_BATCH_TASKS) {
    throw new CliError("INVALID_TOOL_INPUT", `tasks holds at most ${MAX_BATCH_TASKS} entries: split the work across calls.`);
  }
  const entries = args.tasks.map((entry, index) => readBatchEntry(entry, index));
  // A worktree whenever the caller did not ask, except a fork: the server
  // cuts it from the checkout's branch, or refuses plainly where there is none.
  const sharedIsolation = shared.isolationArg ?? (shared.fork ? "shared" : "worktree");
  preflightBatch(entries, shared, sharedIsolation);
  const started: Array<Record<string, unknown>> = [];
  let firstFailure: unknown;
  for (const entry of entries) {
    const crossProvider = entry.provider !== undefined && entry.provider !== shared.provider;
    // A shared model or effort belongs to the shared provider: an entry on
    // another provider takes its own, or the provider's default rules apply.
    const model = crossProvider ? entry.model : (entry.model ?? shared.model);
    const effort = crossProvider ? entry.effort : (entry.effort ?? shared.effort);
    const isolation = entry.isolation ?? sharedIsolation;
    try {
      started.push(await startDelegation(api, parentThreadId, {
        task: shared.rules === undefined ? entry.task : `${entry.task}\n\nCommon rules for this task:\n${shared.rules}`,
        title: entry.title,
        isolation,
        ...((entry.provider ?? shared.provider) ? { provider: (entry.provider ?? shared.provider)! } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...((entry.idempotencyKey ?? (shared.idempotencyKey ? batchEntryKey(shared.idempotencyKey, entry.title, entry.task) : undefined)) ? { idempotencyKey: (entry.idempotencyKey ?? batchEntryKey(shared.idempotencyKey!, entry.title, entry.task))! } : {}),
        ...(shared.fork ? { fork: true } : {}),
        ...(shared.modeArg === "research" ? { mode: "research" as const } : {}),
      }));
    } catch (cause) {
      // One task failing to start never loses the others: its error is that
      // entry's report, and the rest still start on their own keys.
      firstFailure ??= cause;
      started.push({ title: entry.title, error: toolErrorText(cause) });
    }
  }
  await throwIfParentMissing(api, parentThreadId, started, firstFailure);
  const checkout = started.filter((entry) => entry["isolation"] === "shared");
  return {
    tasks: started,
    ...(checkout.length === 0
      ? {}
      : { warning: `${checkout.length === 1 ? "One task runs" : `${checkout.length} tasks run`} in your checkout (isolation "shared"): ${checkout.map((entry) => JSON.stringify(entry["title"])).join(", ")}. Only use shared for read-only work, or when nothing else writes at the same time.` }),
  };
}

interface BatchEntry {
  readonly task: string;
  readonly title: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly isolation?: "worktree" | "shared";
  readonly idempotencyKey?: string;
}

/**
 * One entry's idempotency key: the call's key plus a hash of the entry's own
 * title and task. A retry in any order meets its original entry, a removed
 * entry is simply not met, and a new entry starts — none of which a
 * positional suffix survives.
 */
function batchEntryKey(key: string, title: string, task: string): string {
  const digest = createHash("sha256").update(`moxen-delegate-v1\n${title}\n${task}`, "utf8").digest("hex").slice(0, 16);
  return `${key}#${digest}`;
}

/** One `delegate` call starts this many tasks at most: ten at once is normal use, past this split the work. */
const MAX_BATCH_TASKS = 20;

/** The fields one `tasks` entry takes: anything else is refused, naming the key, with nothing started. */
const BATCH_ENTRY_FIELDS: ReadonlySet<string> = new Set(["task", "title", "provider", "model", "effort", "isolation", "idempotencyKey"]);

/**
 * What is cheap and pure to check before starting any entry: a forked task in
 * a worktree, or a provider with no model anywhere in the call. Either fails
 * the whole call with nothing started. Everything that needs the run itself
 * stays per-entry: partial start is the contract once starting begins.
 */
function preflightBatch(
  entries: readonly BatchEntry[],
  shared: { fork: boolean; provider: string | undefined; model: string | undefined },
  sharedIsolation: "worktree" | "shared",
): void {
  entries.forEach((entry, index) => {
    const nth = `tasks[${index + 1}]`;
    if (shared.fork && (entry.isolation ?? sharedIsolation) === "worktree") {
      throw new CliError("FORK_NEEDS_SHARED", `${nth} asks for a worktree fork: a forked task runs in its parent's checkout — delegate it with isolation "shared".`, {
        exitCode: 2,
        details: { title: entry.title },
      });
    }
    if (entry.provider !== undefined && entry.model === undefined && shared.model === undefined) {
      throw new CliError("INVALID_TOOL_INPUT", `${nth} names provider "${entry.provider}" but no model: name its model too — the call shares none.`);
    }
  });
}

/**
 * Every entry failed: when the parent itself is missing, fail the call with
 * the first entry's error — exactly what the single form answers — rather
 * than N identical entry reports.
 */
async function throwIfParentMissing(api: ClientApi, parentThreadId: string, started: ReadonlyArray<Record<string, unknown>>, firstFailure: unknown): Promise<void> {
  if (firstFailure === undefined || !started.every((entry) => "error" in entry)) return;
  const parent = await api.query({ type: "thread.inspect", threadId: parentThreadId }).catch(() => null);
  if (parent === null) throw firstFailure;
}

/** One entry of a `tasks` list: its own title and task, able to override a shared setting. */
function readBatchEntry(entry: unknown, index: number): BatchEntry {
  const nth = `tasks[${index + 1}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new CliError("INVALID_TOOL_INPUT", `${nth} must be an object with task and title.`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!BATCH_ENTRY_FIELDS.has(key)) {
      throw new CliError("INVALID_TOOL_INPUT", `${nth}: unknown field "${key}". A task entry takes task, title, provider, model, effort, isolation and idempotencyKey.`);
    }
  }
  const field = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new CliError("INVALID_TOOL_INPUT", `${nth}: ${key} must be a non-empty string.`);
    return value.trim();
  };
  const task = field("task");
  if (task === undefined) throw new CliError("INVALID_TOOL_INPUT", `${nth}: task is required.`);
  const title = field("title");
  if (title === undefined) throw new CliError("INVALID_TOOL_INPUT", `${nth}: title is required.`);
  const isolation = field("isolation");
  if (isolation !== undefined && isolation !== "worktree" && isolation !== "shared") {
    throw new CliError("INVALID_TOOL_INPUT", `${nth}: isolation must be worktree or shared.`);
  }
  const provider = field("provider");
  const model = field("model");
  const effort = field("effort");
  const idempotencyKey = field("idempotencyKey");
  return {
    task, title,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(isolation === "worktree" || isolation === "shared" ? { isolation } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** Start one delegation and shape its report: the single-task result, and each entry of a batch. */
async function startDelegation(
  api: ClientApi,
  parentThreadId: string,
  request: { task: string; title: string; isolation: "worktree" | "shared"; provider?: string; model?: string; effort?: string; idempotencyKey?: string; fork?: boolean; mode?: "research"; researchProposal?: unknown },
) {
  const delegated = await api.dispatch({
    type: "thread.delegate",
    parentThreadId,
    task: request.task,
    wait: false,
    isolation: request.isolation,
    title: request.title,
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.effort ? { thinkingEffort: request.effort } : {}),
    ...(request.fork === true ? { fork: true } : {}),
    ...(request.mode === "research" ? { interactionMode: "research" as const } : {}),
    ...(request.researchProposal === undefined ? {} : { researchProposal: decodeResearchPlan(request.researchProposal) }),
  });
  return {
    taskId: delegated.task.taskId,
    title: delegated.child.title,
    status: delegated.task.status,
    model: `${delegated.modelSelection.instanceId}/${delegated.modelSelection.model}`,
    isolation: request.isolation,
    ...(delegated.worktree ? { worktree: delegated.worktree.path, branch: delegated.worktree.branch } : {}),
    next: "Running. Do not poll task_status: a task notification arrives when it settles. Keep working or end your turn.",
  };
}

/** Exactly one of `taskId` (one task) or `taskIds` (several): one bad id never stops the others. */
function cancelIds(args: Record<string, unknown>): string[] {
  const single = argString(args, "taskId");
  const many = args.taskIds;
  if (single !== undefined && many !== undefined) {
    throw new CliError("INVALID_TOOL_INPUT", "Pass either taskId for one task, or taskIds for several — not both.");
  }
  if (many !== undefined) {
    if (!Array.isArray(many) || many.length === 0) throw new CliError("INVALID_TOOL_INPUT", "taskIds must be a non-empty array of task ids.");
    const ids = many.map((id, index) => {
      if (typeof id !== "string" || !id.trim()) throw new CliError("INVALID_TOOL_INPUT", `taskIds[${index + 1}] must be a non-empty string.`);
      return id.trim();
    });
    // A repeated id stops once, in order.
    return [...new Set(ids)];
  }
  if (single === undefined) throw new CliError("INVALID_TOOL_INPUT", "Pass taskId for one task, or taskIds for several.");
  return [single];
}

async function cancelOne(api: ClientApi, parentThreadId: string, taskId: string) {
  return await api.dispatch({ type: "thread.task.cancel", parentThreadId, taskId });
}

/** A failure as a batch entry carries it: the code the handler would have answered with, never a protocol error. */
function toolErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof CliError) return `${cause.code}: ${message}`;
  return `TASK_START_FAILED: ${message}`;
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
    ...(finished ? { report: described.task.summary } : { next: "Still running. Do not call task_status in a loop: a task notification arrives when it settles." }),
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

/**
 * `context_usage`: the calling thread's latest recorded reading
 * (`thread.context-reading`), the same figure the TUI's composer shows.
 * Totals only, never an estimate. A reading from before a compaction is
 * returned with its time and `current: false`, so an old number is not
 * passed off as the one now.
 */
async function contextUsageTool(api: ClientApi, parentThreadId: string) {
  const { reading } = await api.query({ type: "thread.context-reading", threadId: parentThreadId });
  if (reading === null) {
    return { reading: null, note: "No context reading for this thread yet. Moxen records one while a turn runs and as it ends; it never estimates." };
  }
  const percentUsed = reading.maxTokens === null || reading.maxTokens <= 0 ? null : Math.round((reading.usedTokens / reading.maxTokens) * 100);
  return {
    reading: {
      usedTokens: reading.usedTokens,
      maxTokens: reading.maxTokens,
      percentUsed,
      takenAt: reading.takenAt,
      current: !reading.compactedSince,
    },
    ...(reading.compactedSince
      ? { note: "A compaction has happened since this reading, so it is not current. Moxen records a new one when the compaction ends: call context_usage again after that." }
      : {}),
  };
}

/**
 * `usage_status`: the user's current shared provider usage, for an agent
 * deciding where there is headroom. Every enabled, installed provider keeps
 * one row: its windows (percent used, reset time, label), when that reading
 * was taken, and whether it is stale (older than USAGE_STALE_AFTER_MS).
 * A provider with no windows has no data, which is not unlimited. The
 * protection snapshot is the same one `moxen usage status` shows: what
 * usage protection holds or has queued.
 */
async function usageStatusTool(api: ClientApi, parentThreadId: string, timeoutMs: number) {
  const [listed, stored, protection, inspected] = await Promise.all([
    api.query({ type: "providers.list" }),
    api.query({ type: "usage.limits" }),
    api.query({ type: "usage.protection" }),
    api.query({ type: "thread.inspect", threadId: parentThreadId }).catch(() => null),
  ]);
  // A cheap refresh where one exists, bounded: a slow probe costs the
  // answer's freshness, never the answer. The probe keeps running behind
  // the fallback and freshens the next call through the normal event path.
  const refreshed = await withinDeadline(api.query({ type: "usage.refresh" }), timeoutMs).catch(() => "timeout" as const);
  const snapshot = refreshed === "timeout" ? stored.providers : refreshed.providers;
  const now = Date.now();
  const providers = listed.providers
    .filter((provider) => provider.enabled && provider.installed)
    .map((provider) => {
      const usage = snapshot[usageKeyForInstance(provider.instanceId)] ?? snapshot[provider.driver] ?? provider.usageLimits;
      if (!usage || usage.windows.length === 0) {
        return {
          provider: provider.instanceId,
          displayName: provider.displayName ?? provider.instanceId,
          enabled: true,
          checkedAt: usage?.checkedAt ?? null,
          stale: false,
          windows: [],
          note: usage?.unavailable
            ? `Usage cannot be read for this provider (${usage.unavailable.reason}). No data is not the same as unlimited: do not treat it as headroom.`
            : "No usage reported for this provider. No data is not the same as unlimited: do not treat it as headroom.",
        };
      }
      const taken = Date.parse(usage.checkedAt);
      return {
        provider: provider.instanceId,
        displayName: provider.displayName ?? provider.instanceId,
        enabled: true,
        checkedAt: usage.checkedAt,
        stale: !Number.isFinite(taken) || now - taken > USAGE_STALE_AFTER_MS,
        windows: usage.windows.map((window) => ({
          id: window.id,
          kind: window.kind,
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
        })),
        ...(usage.unavailable ? { note: `Usage cannot be read for this provider (${usage.unavailable.reason}).` } : {}),
      };
    });
  return {
    callerProvider: inspected?.thread.modelSelection?.instanceId ?? null,
    providers,
    protection,
  };
}

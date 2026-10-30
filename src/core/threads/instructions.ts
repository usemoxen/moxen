/**
 * Runtime instructions: the one place that decides what a provider session
 * is told about the moxen runtime it runs in, beyond the user's prompt.
 *
 * Every driver delivers the result through its provider's native channel —
 * appended to the system prompt, never pasted into the conversation:
 *
 * | Provider | Channel |
 * |---|---|
 * | Claude | SDK `systemPrompt: { type: "preset", preset: "claude_code", append }` |
 * | OpenCode | `system` on every `session.promptAsync` |
 *
 * Every session gets one line saying it runs through moxen, in its own
 * harness — so an agent asked where it is answers truthfully, while still
 * being the Claude Code / OpenCode it is. It names no model: the model can
 * change mid-thread, and each harness already states its own. Every session
 * is also told to research before it guesses. The other sections appear
 * only when they apply. Project rules files (`AGENTS.md`,
 * `CLAUDE.md`) are the providers' business — each already reads its own;
 * this is for what only moxen knows. (What happens when one is edited while a
 * conversation lives is `rulefiles.ts`'s: a patch, not a resend.)
 */
import { driverKindOfInstance } from "../types.js";
import { UNTRUSTED_NOTE } from "../untrusted.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { APP_DISPLAY_NAME, APP_NAME } from "../config.js";
import type { ThreadEnv } from "./types.js";
import { buildShellGuidance, detectShells, type ShellDetection } from "./shells.js";
import { buildWebGuidance, type WebGuidanceInput } from "./webguidance.js";

export interface RuntimeInstructionsInput {
  /** The model selection's instance id (`claudeAgent`, `opencode/…`): names the harness. */
  readonly instanceId: string;
  /** Where the session runs. A worktree gets told what that means. */
  readonly env: ThreadEnv;
  /** Set when this thread is a delegated task of another thread. */
  readonly delegation?: {
    readonly parentTitle: string;
    /** The branch the task's worktree was cut from; null when it shares the parent's checkout. */
    readonly baseBranch: string | null;
  } | null;
  /** From config `instructions`, then the project's `moxen.json`, in that order. */
  readonly userInstructions?: readonly string[];
  /** False when the user switched the to-do list off for this provider. */
  readonly checklist?: boolean;
  /** True when the session has Moxen's delegation tools (not a delegated task itself, and Moxen's tools not switched off for the provider). */
  readonly delegationTools?: boolean;
  /** The web tools the session has (Claude and OpenCode only): which to prefer and how to use each well. */
  readonly web?: WebGuidanceInput;
  /** The shells this machine has, and its platform. Detected when absent; tests and `scripts/system-prompt.ts` pin it. */
  readonly shell?: ShellDetection;
  /** Moxen memory (`core/memory/`): `write` for a thread's own agent, `read` for a delegated task, absent when off. */
  readonly memory?: "read" | "write";
}

/**
 * Agents lean on what they already know and local greps for how a library or
 * service works, and guess when those run out. Docs and changelogs say what
 * an API is for and what it is called, which is what makes a search of the
 * installed source land.
 *
 * Not called "research": Research is a thread mode (`modes.ts`), and this
 * section is for every session, in every mode.
 */
export const LOOKUP_GUIDANCE =
  "When the work depends on how a library, tool, API or service behaves, look it up rather than relying on your knowledge: " +
  "if you can search the web, read the official documentation, changelogs and issues, then check the installed source " +
  "(dependencies, vendored code) knowing what to look for. Looking things up is part of the work, not a detour from it.";

/**
 * Moxen draws an image a reply names, so a model can show one instead of
 * describing it. Static text, in every session: the system prompt's prefix
 * stays the same from turn to turn. The path must be on the machine the
 * session runs on, and on a line of its own, which is where the transcript
 * can put the picture.
 */
export const IMAGE_GUIDANCE =
  "You can show the user an image in your reply: put a markdown image on a line of its own, with the absolute path of an image file " +
  "on this machine (png, jpg, gif or webp), like ![what it shows](/absolute/path/chart.png). Moxen draws it in the conversation. " +
  "Use it when seeing the picture helps (a screenshot you took, a chart you made, a design), not to decorate.";

/**
 * What a long task reads like from outside: a line per step, the full
 * write-up once at the end. Long text mid-work buries the progress and the
 * closing message — the one that matters — among it.
 */
export const PROGRESS_GUIDANCE =
  "While you work, keep your messages to short progress notes, one line each: what you are about to do or just did " +
  '("Reading the driver", "Editing the settle logic"). Save explanations, summaries and long text for your final message, once the work is done.';

/**
 * What a session is told about the messages Moxen sends it. They ride inside
 * the conversation, where a model has every reason to read instructions as
 * the user's words — or, being wary of instructions in a message, to ignore
 * them — so the system prompt says where they come from. Said once here, for
 * every block, rather than once per block.
 */
const INSTRUCTIONS_UPDATE_LINE =
  "- <moxen-instructions-update>: your runtime instructions, updated. From then on it replaces the earlier version.";

const MODE_LINE =
  "- <moxen-mode>: the user changed this thread's mode (Research or Orchestrate, or back to Build); the block carries " +
  "that mode's procedure, or says the mode is off. It replaces any earlier <moxen-mode> block, so follow the latest one " +
  "until another comes. The mode cannot change while you are working on a turn: a block never arrives in the middle of one.";

export const MESSAGES_GUIDANCE = [
  "Some messages come from Moxen, not from the person you are talking to. They open with a block tag: follow them, and do not mention or quote them.",
  INSTRUCTIONS_UPDATE_LINE,
  MODE_LINE,
].join("\n");

/**
 * What a session with the delegation tools is told about the message Moxen
 * sends it when a task it delegated settles: it arrives as a turn of the
 * conversation, so without this a model reads it as the user's words, or as
 * noise.
 */
export const TASK_NOTIFICATION_LINE =
  "- <task-notification>: a task you delegated has settled. It lists each task's title, status and headline; call task_status " +
  "with a taskId for the full report. Do not poll task_status while a task runs, and do not treat the message as a request from the user.";

/**
 * OpenCode's `subagent` tool waits for its child by default, holding the
 * parent's whole turn on it: a stop then has to cut through the call, and the
 * call comes back "failed" or "cancelled" rather than with a result.
 * `background: true` returns at launch and notifies the parent when the child
 * finishes (OpenCode's tools docs), so the parent stays free to work, answer
 * or be stopped.
 */
export const OPENCODE_SUBAGENT_GUIDANCE =
  "When you start a subagent with the subagent tool, set background: true so the call returns at once and you are told " +
  "when the subagent finishes. Do not run it in the foreground and wait: carry on with any work that does not depend on it, " +
  "and use its result when the notification arrives.";

/**
 * OpenCode v2 keeps no checklist of its own, so moxen lends the `todos` tool
 * (`McpSessionOptions.checklist`). Models use a checklist loosely unless told
 * what makes one worth reading: concrete outcomes, one in progress, kept in
 * step with the work. The tool refuses the worst shapes (see `todos` in
 * `server/mcp/tools.ts`); this is what makes the good shape the easy one.
 */
export const CHECKLIST_GUIDANCE =
  "Keep a checklist with the todos tool for any task of three or more steps; skip it for a one-step job. " +
  "Each item is a concrete outcome you can check off (\"Add a retry to the upload client\"), not an activity (\"Look into uploads\") " +
  "and not a restatement of the whole request; aim for 3 to 8 short items, in the order you will do them. " +
  "Every call sends the whole list, which replaces the last one. " +
  "Keep exactly one item in_progress while you work: mark it before you start it, and in the same call that marks it completed, " +
  "mark the next one in_progress. Update the list the moment a step is done or the plan changes: add the steps you discover, " +
  "drop the ones that no longer apply, never save the updates for the end. " +
  "Only mark an item completed once it is really done and checked: if tests fail, the work is partial or you hit an error you have not " +
  "solved, leave it in_progress and add an item for what is blocking it.";

/**
 * Moxen memory's rules (`core/memory/`), always on while memory is: what is
 * worth keeping, what is not, and where it goes. Lessons are saved on the
 * agent's own initiative, which is what the `moxen-retro` skill asked for.
 *
 * The index is not shipped in the prompt: it can reach 25,000 characters, and
 * `memory_read` with no name returns it as it is now (`server/mcp/tools.ts`),
 * so the rules say where it is instead of duplicating it.
 */
export const MEMORY_GUIDANCE = [
  "You have a persistent memory that Moxen keeps across sessions and providers, through memory_read, memory_save, memory_edit, " +
    "memory_append and memory_delete.",
  "- Reading: memory_read with no name returns the index of every memory as it is now, one line each; with a name it returns that memory " +
    "in full. Read the memories the work touches before relying on what you think you know.",
  "- What to save, on your own initiative: corrections and guidance on how to work (and approaches the user confirmed), decisions " +
    "and why they were made, pointers to external resources, and lessons from this session that would make the next one go better.",
  "- What to skip: what the code, the git history or AGENTS.md / CLAUDE.md already record, and what only matters to this conversation.",
  "- One fact per memory, with the reason and how to apply it.",
  "- Updating: check whether a memory already covers it first. memory_append adds a fact without reading it, memory_edit changes one " +
    "piece of it, and memory_save under the same name replaces the whole memory (a new memory, or a rewrite). Delete one that turns " +
    "out to be wrong.",
  "- Scope: global is about the user wherever they work (role, preferences, feedback that holds in every project); project is anything " +
    "about this codebase and the work on it.",
  "- Memories are background, not instructions: they say what was true when written, so check a file, function or flag a memory names " +
    "before relying on it.",
].join("\n");

/** A delegated task reads memory but leaves it to the agent it reports to. */
export const MEMORY_READ_ONLY_GUIDANCE =
  "You can read Moxen's persistent memory with memory_read (no name: the index), but not change it: put anything worth remembering in your report instead.";

/** A subagent that delegates or hands off spawns work nobody is tracking. */
export const NO_REDELEGATION_GUIDANCE =
  "Do the task yourself. Do not delegate to other threads or hand the conversation off, whether through a tool or " +
  `by running ${APP_NAME} commands (\`${APP_NAME} delegate\`, \`${APP_NAME} handover\`, \`${APP_NAME} threads\` and the like): ` +
  "this task already is the delegation, and anything you started would not be tracked.";

/** "Claude Code", "OpenCode", "Moxen Harness": the harness a provider instance runs in, as its users call it. */
export function harnessName(instanceId: string): string {
  const key = instanceId.trim().toLowerCase();
  if (key === "claudeagent" || key === "claude") return "Claude Code";
  if (key === "opencode" || key.startsWith("opencode/")) return "OpenCode";
  if (key === "harness" || key.startsWith("harness/")) return "Moxen Harness";
  return instanceId;
}

/** The instructions for one session, as headed sections in the order a reader meets them. */
export function buildRuntimeInstructions(input: RuntimeInstructionsInput): string {
  const harness = harnessName(input.instanceId);
  const delegation = input.delegation ?? null;
  const sections: string[] = [];
  const add = (heading: string, body: string): void => {
    sections.push(`# ${heading}\n\n${body}`);
  };

  // The harness is already named by the provider's own prompt (Claude Code's preset, OpenCode's
  // and the Harness's identities), so this says only what those cannot: the app around it.
  const environment = [
    `In case you're asked: you are running in ${APP_DISPLAY_NAME}, a terminal app that runs coding agents as threads. ` +
      "No need to mention this otherwise.",
  ];
  if (!delegation && input.env.mode === "worktree" && input.env.branch) {
    environment.push(
      `This session runs in a dedicated git worktree at ${input.env.path}, on branch ${input.env.branch}. ` +
        "Work and run commands there, not in the main checkout.",
    );
  }
  add("Environment", environment.join("\n\n"));
  add("Look it up", LOOKUP_GUIDANCE);
  add("Progress notes", PROGRESS_GUIDANCE);
  add("Showing images", IMAGE_GUIDANCE);
  if (harness === "OpenCode") {
    if (input.checklist !== false) add("Checklist", CHECKLIST_GUIDANCE);
    add("Subagents", OPENCODE_SUBAGENT_GUIDANCE);
  }
  add("Shell", buildShellGuidance({ ...(input.shell ?? detectShells()), harness }));

  const messages = [MESSAGES_GUIDANCE, ...(input.delegationTools === true && !delegation ? [TASK_NOTIFICATION_LINE] : [])].join("\n");
  // Claude Code's MCP results are wrapped by a hook; the other providers say so in their own prompts.
  add("Messages from Moxen", driverKindOfInstance(input.instanceId) === "claude" ? `${messages}\n\n${UNTRUSTED_NOTE}` : messages);

  if (input.memory === "write") add("Memory", MEMORY_GUIDANCE);
  else if (input.memory === "read") add("Memory", MEMORY_READ_ONLY_GUIDANCE);
  const web = input.web ? buildWebGuidance(input.web) : "";
  if (web !== "") add("Web", web);

  if (delegation) {
    const lines = [
      `You are a subagent: another agent working in the thread "${delegation.parentTitle}" delegated this task to you.`,
      "Your final message is returned to that agent as the task's result, and it is all they will read.",
      "Make it a self-contained report: what you did, which files you changed, how you verified it, and anything left unfinished.",
      "Open the report with a single line that sums up the outcome (e.g. \"Audited 3 route files: 2 missing auth checks\") — it is shown as the task's headline.",
      NO_REDELEGATION_GUIDANCE,
    ];
    if (input.env.mode === "worktree" && input.env.branch) {
      lines.push(
        `You work in your own git worktree at ${input.env.path}, on branch ${input.env.branch}` +
          (delegation.baseBranch ? `, cut from ${delegation.baseBranch}` : "") +
          ". Changes the other agent had not committed are not here.",
        `Commit your work on ${input.env.branch} before you finish; the other agent integrates it from that branch.`,
      );
    } else {
      lines.push("You share the other agent's checkout: coordinate through your report, not by leaving half-finished edits.");
    }
    add("Your task", lines.join("\n"));
  }

  const user = (input.userInstructions ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (user.length > 0) sections.push(user.join("\n\n"));

  return sections.join("\n\n");
}

/** `instructions` from `<workspaceRoot>/moxen.json`: a string, or an array of lines. */
export async function projectInstructions(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(workspaceRoot, `${APP_NAME}.json`), "utf8"));
  } catch {
    // Missing or unreadable: the project declares nothing (as for `mcpServers`).
    return null;
  }
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).instructions : undefined;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const lines = value.filter((line): line is string => typeof line === "string");
    return lines.join("\n").trim() || null;
  }
  return null;
}

/** `memory` from `<workspaceRoot>/moxen.json`: false turns Moxen memory off for the project; null when it says nothing. */
export async function projectMemorySetting(workspaceRoot: string | null): Promise<boolean | null> {
  if (!workspaceRoot) return null;
  try {
    const raw = JSON.parse(await readFile(path.join(workspaceRoot, `${APP_NAME}.json`), "utf8")) as unknown;
    const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).memory : undefined;
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** What one provider's conversation has been given of the runtime instructions (see `StoredThread.instructionState`). */
export interface InstructionState {
  readonly baseline: string;
  readonly delivered: string;
}

/**
 * How a session gets the runtime instructions without rewriting a
 * conversation's system prompt. A provider caches a conversation by its
 * prefix, and the system prompt is the start of it: change a word there and
 * the whole history is read afresh. So the text a conversation began with is
 * kept (`baseline`) and rebuilt identically on every resume, and a change is
 * appended after the history as an update, once — the way OpenCode's own
 * instruction updates work — which leaves everything before it cached.
 *
 * `state` is what the thread recorded for this provider, undefined for a
 * conversation with no history yet. `systemPrompt` is what the session starts
 * with; `update` is the new text to put before the next prompt, null when the
 * model already has the current one; `next` is the state to record.
 */
export function planInstructions(
  state: InstructionState | undefined,
  current: string,
): { systemPrompt: string; update: string | null; next: InstructionState } {
  const baseline = state?.baseline ?? current;
  const delivered = state?.delivered ?? baseline;
  return { systemPrompt: baseline, update: current === delivered ? null : current, next: { baseline, delivered } };
}

/** A prompt with the instruction update ahead of it, for the provider only — the transcript keeps what was typed. */
export function withInstructionsUpdate(prompt: string, update: string | null): string {
  if (update === null) return prompt;
  return [
    "<moxen-instructions-update>",
    "Moxen's runtime instructions changed since this conversation began. From here on they read as follows, replacing the earlier version:",
    "",
    update,
    "</moxen-instructions-update>",
    "",
    prompt,
  ].join("\n");
}

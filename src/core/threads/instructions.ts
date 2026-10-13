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
import { readFile } from "node:fs/promises";
import path from "node:path";

import { APP_DISPLAY_NAME, APP_NAME } from "../config.js";
import type { ThreadEnv } from "./types.js";

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
}

/**
 * Agents lean on memory and local greps for how a library or service works,
 * and guess when those run out. Docs and changelogs say what an API is for
 * and what it is called, which is what makes a search of the installed
 * source land.
 */
export const RESEARCH_GUIDANCE =
  "When the work depends on how a library, tool, API or service behaves, look it up rather than relying on memory: " +
  "if you can search the web, read the official documentation, changelogs and issues, then check the installed source " +
  "(dependencies, vendored code) knowing what to look for. Research is part of the work, not a detour from it.";

/**
 * What a long task reads like from outside: a line per step, the full
 * write-up once at the end. Long text mid-work buries the progress and the
 * closing message — the one that matters — among it.
 */
export const PROGRESS_GUIDANCE =
  "While you work, keep your messages to short progress notes, one line each: what you are about to do or just did " +
  '("Reading the driver", "Editing the settle logic"). Save explanations, summaries and long text for your final message, once the work is done.';

/**
 * What a session is told about the update block (`withInstructionsUpdate`)
 * that can open one of its prompts. It rides inside the user's message, where
 * a model has every reason to read instructions as the user's words — or, being
 * wary of instructions in a message, to ignore them — so the system prompt
 * says where it comes from.
 */
export const INSTRUCTIONS_UPDATE_GUIDANCE =
  "A message may begin with a <moxen-instructions-update> block. It comes from Moxen, not from the person you are talking to: " +
  "it is your runtime instructions, updated, and from then on it replaces the earlier version. Follow it, and do not mention or quote it.";

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

/** A subagent that delegates or hands off spawns work nobody is tracking. */
export const NO_REDELEGATION_GUIDANCE =
  "Do the task yourself. Do not delegate to other threads or hand the conversation off, whether through a tool or " +
  `by running ${APP_NAME} commands (\`${APP_NAME} delegate\`, \`${APP_NAME} handover\`, \`${APP_NAME} threads\` and the like): ` +
  "this task already is the delegation, and anything you started would not be tracked.";

/** "Claude Code", "OpenCode": the harness a provider instance runs in, as its users call it. */
export function harnessName(instanceId: string): string {
  const key = instanceId.trim().toLowerCase();
  if (key === "claudeagent" || key === "claude") return "Claude Code";
  if (key === "opencode" || key.startsWith("opencode/")) return "OpenCode";
  return instanceId;
}

/** The instructions for one session. */
export function buildRuntimeInstructions(input: RuntimeInstructionsInput): string {
  const sections: string[] = [
    `In case you're asked: you are running in ${APP_DISPLAY_NAME}, a terminal app that runs coding agents as threads, ` +
      `through the ${harnessName(input.instanceId)} harness. No need to mention this otherwise.`,
    RESEARCH_GUIDANCE,
    PROGRESS_GUIDANCE,
    INSTRUCTIONS_UPDATE_GUIDANCE,
    ...(harnessName(input.instanceId) === "OpenCode" ? [OPENCODE_SUBAGENT_GUIDANCE, CHECKLIST_GUIDANCE] : []),
  ];
  const delegation = input.delegation ?? null;

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
    sections.push(lines.join("\n"));
  } else if (input.env.mode === "worktree" && input.env.branch) {
    sections.push(
      `This session runs in a dedicated git worktree at ${input.env.path}, on branch ${input.env.branch}. ` +
        "Work and run commands there, not in the main checkout.",
    );
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

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
 * being the Claude Code / OpenCode it is. Claude Code and OpenCode state their
 * own model, so it names none for them. Codex's and the Harness's prompts are
 * Moxen's and state none, so those sessions are told their model and effort
 * here; a change mid-thread reaches them as an update. Every session is also
 * told to research before it guesses. The other sections appear
 * only when they apply. Project rules files (`AGENTS.md`,
 * `CLAUDE.md`) are the providers' business — each already reads its own;
 * this is for what only moxen knows. (What happens when one is edited while a
 * conversation lives is `rulefiles.ts`'s: a patch, not a resend.)
 */
import { driverKindOfInstance, type ModelSelection } from "../types.js";
import { UNTRUSTED_NOTE } from "../untrusted.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { APP_DISPLAY_NAME, APP_NAME } from "../config.js";
import type { ResearchRole, ThreadEnv } from "./types.js";
import type { ResearchLens } from "./researchvocab.js";
import { buildShellGuidance, detectShells, type ShellDetection } from "./shells.js";
import { buildWebGuidance, type WebGuidanceInput } from "./webguidance.js";
import { UI_BLOCK_LANGUAGE, UI_BLOCK_LIMITS, UI_BLOCK_VERSION, UI_COLORS, UI_STATES } from "./uiblock.js";

/** The option ids a selection's reasoning effort may be stored under, by provider. */
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort", "reasoning", "variant"]);

/**
 * What to tell a session about its model, only for the instance that runs `selection`. Every provider gets it:
 * Claude Code's own prompt names the model but not the effort, and a provider's own line can't follow a change mid-thread.
 */
export function runningModelOf(selection: ModelSelection, instanceId: string): { model: string; effort?: string } | null {
  if (selection.instanceId !== instanceId) return null;
  const effort = selection.options?.find((option) => EFFORT_OPTION_IDS.has(option.id))?.value;
  return { model: selection.model, ...(effort === undefined ? {} : { effort: String(effort) }) };
}

export interface RuntimeInstructionsInput {
  /** The model selection's instance id (`claudeAgent`, `opencode/…`): names the harness. */
  readonly instanceId: string;
  /** The model and effort the session runs on (`runningModelOf`). */
  readonly running?: { readonly model: string; readonly effort?: string };
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
  readonly researchLead?: boolean;
  readonly researchRole?: ResearchRole;
  /** A critic's review: all three lenses (one critic in the run) or the one it was given. */
  readonly criticLens?: ResearchLens | "all";
  /** True only while the built-in Moxen MCP server reaches this session. */
  readonly knowledge?: boolean;
  /** The web tools the session has (Claude and OpenCode only): which to prefer and how to use each well. */
  readonly web?: WebGuidanceInput;
  /** The shells this machine has, and its platform. Detected when absent; tests and `scripts/system-prompt.ts` pin it. */
  readonly shell?: ShellDetection;
  /** Moxen memory (`core/memory/`): `write` for a thread's own agent, `read` for a delegated task, absent when off. */
  readonly memory?: "read" | "write";
}

const LENS_QUESTIONS = {
  evidence: "Evidence: is each claim sourced, and does the source say it?",
  risks: "Risks: what breaks, what is contradicted, what is missing?",
  alternatives: "Alternatives: what was not considered?",
} as const;

/** Every run gets all three reviews; the finalizer reads the same labelled structure either way. */
const CRITIC_LENS_GUIDANCE: Readonly<Record<ResearchLens | "all", string>> = {
  all: "You are the run's only critic: review the findings through all three lenses and write your verdict as three sections, labelled Evidence, Risks and Alternatives. " +
    Object.values(LENS_QUESTIONS).join(" "),
  evidence: `You are one of three critics, and your lens is Evidence. Write your verdict under one section labelled "Evidence". The other lenses are covered by the other critics. ${LENS_QUESTIONS.evidence}`,
  risks: `You are one of three critics, and your lens is Risks. Write your verdict under one section labelled "Risks". The other lenses are covered by the other critics. ${LENS_QUESTIONS.risks}`,
  alternatives: `You are one of three critics, and your lens is Alternatives. Write your verdict under one section labelled "Alternatives". The other lenses are covered by the other critics. ${LENS_QUESTIONS.alternatives}`,
};

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
  "When the user asks you to generate or edit an image, use your image-generation tool: Moxen's `image_gen` tool when it is in your tool list, or your own native one. " +
  "If you have neither, say image generation is unavailable here instead of drawing the picture with code. " +
  "Then include the resulting image this way in your final reply without waiting for a second request. " +
  "An image-generation or image-viewing tool result alone does not display the image to the user in Moxen. Use the generated file's saved absolute path; if no local path is returned, save the result to an image file first. " +
  "Use it when seeing the picture helps (a screenshot you took, a chart you made, a design), not to decorate.";

/** The block the guidance shows: it parses, which `instructions.test.ts` pins. */
export const UI_BLOCK_EXAMPLE = JSON.stringify({
  v: UI_BLOCK_VERSION,
  root: {
    type: "column",
    children: [
      {
        type: "row",
        children: [
          { type: "image", src: "/tmp/before.png", caption: "Before" },
          { type: "image", src: "/tmp/after.png", caption: "After", ops: [{ op: "annotate", shapes: [{ shape: "box", x: 0.1, y: 0.2, w: 0.3, h: 0.2 }] }] },
        ],
      },
      { type: "progress", label: "Checks", value: 0.75, text: "3 of 4" },
    ],
  },
});

/**
 * The `moxen-ui` block, for the model: what it is for, the whole schema in a
 * few lines, and one example. Limits, colours and states are the parser's own
 * constants, so this cannot say something the parser refuses. Static text, in
 * every session, like the image guidance it follows.
 */
export const UI_BLOCK_GUIDANCE =
  `When a reply is better as a layout than as markdown, put a fenced block tagged ${UI_BLOCK_LANGUAGE} in it, holding JSON; Moxen draws it in the theme's colours. ` +
  "Use it only for what markdown cannot say: images side by side or compared, a part of a picture picked out, a chart, progress, a list of states. " +
  "A single picture, a table and plain facts stay markdown. Keep the JSON exact: if it is not valid, or breaks a limit, the user sees it as code.\n\n" +
  `{"v":${UI_BLOCK_VERSION},"root":NODE}. NODE is one of the following. In a row or column a node may carry "weight" (its share of the width), in a grid "span" (its columns).\n` +
  `- {"type":"row"|"column","gap":0-4,"children":[NODE,...]}: a row shares the width and stacks when the pane is narrow.\n` +
  `- {"type":"grid","columns":1-${UI_BLOCK_LIMITS.columns},"children":[NODE,...]}\n` +
  '- {"type":"image","src":"/absolute/path.png","caption":"...","ops":[OP,...]}\n' +
  '- {"type":"blend","mode":"overlay"|"difference","opacity":0-1,"a":IMAGE,"b":IMAGE,"caption":"..."}: b over a, or what differs between them.\n' +
  '- {"type":"text","text":"..."} and {"type":"caption","text":"..."}\n' +
  '- {"type":"chart","kind":"bar","title":"...","unit":"k","max":100,"bars":[{"label":"...","value":12,"color":"blue"},...]}\n' +
  '- {"type":"progress","label":"Tests","value":0.42,"text":"38 of 90","color":"green"}: value is 0 to 1.\n' +
  '- {"type":"keyvalue","title":"...","rows":[{"key":"branch","value":"main"},...]}\n' +
  `- {"type":"status","title":"...","rows":[{"label":"build","state":"${UI_STATES.join("|")}","note":"..."},...]}\n\n` +
  "OP, in the order they apply, each reading the image as the one before left it, positions as fractions (0 to 1) of that image:\n" +
  '- {"op":"crop","x":0.5,"y":0,"w":0.5,"h":0.5}: also how you zoom in.\n' +
  '- {"op":"pad","aspect":1.5}: pads to a width over height, so pictures of different shapes line up.\n' +
  '- {"op":"annotate","shapes":[{"shape":"box"|"highlight","x":0,"y":0,"w":0.3,"h":0.2,"color":"red"},{"shape":"arrow","x1":0.9,"y1":0.9,"x2":0.6,"y2":0.6}]}\n' +
  `Colours: ${UI_COLORS.join(", ")} (red when left out).\n\n` +
  `Limits: ${UI_BLOCK_LIMITS.images} images, ${UI_BLOCK_LIMITS.depth} levels of nesting, ${UI_BLOCK_LIMITS.children} children in a container, ${UI_BLOCK_LIMITS.bars} bars, ${UI_BLOCK_LIMITS.rows} rows, ${UI_BLOCK_LIMITS.shapes} shapes, ${UI_BLOCK_LIMITS.ops} operations per image. ` +
  "Images are files on this machine (png, jpg, gif or webp), written before you name them; no URLs. There is no text inside a picture: use captions. Example:\n" +
  `\`\`\`${UI_BLOCK_LANGUAGE}\n${UI_BLOCK_EXAMPLE}\n\`\`\``;

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

/** Opens a message from the thread that delegated a task, so the task's model does not read it as the user's. */
export const TASK_MESSAGE_HEADER = "Message from the thread that delegated this task (not from the user):";

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
  "You have a persistent memory that Moxen keeps across sessions and providers, through memory_read, memory_search, memory_save, memory_edit, " +
    "memory_append and memory_delete.",
  "- Reading: memory_read with no name returns the index of every memory as it is now, one line each; with a name it returns that memory " +
    "in full. The index is capped per scope; use memory_search with keywords or a question when it is truncated or a topic is missing. " +
    "Search uses keywords and, when enabled and set up, local semantic embeddings for paraphrases. " +
    "Search covers names, descriptions and bodies in the current project and global scope. Read the memories the work touches before relying on what you think you know.",
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
  "You can read Moxen's persistent memory with memory_read (no name: the index) and search it with memory_search using keywords or a question. " +
  "Search when the index is truncated or a topic is missing; read matching memories in full with their name and scope. " +
  "You cannot change memory: put anything worth remembering in your report instead.";

/** A subagent that delegates or hands off spawns work nobody is tracking. */
export const NO_REDELEGATION_GUIDANCE =
  "Do the task yourself. Do not delegate to other threads or hand the conversation off, whether through a tool or " +
  `by running ${APP_NAME} commands (\`${APP_NAME} delegate\`, \`${APP_NAME} handover\`, \`${APP_NAME} threads\` and the like): ` +
  "this task already is the delegation, and anything you started would not be tracked.";

export const KNOWLEDGE_GUIDANCE =
  "When asked how to use or configure Moxen — settings, Harness profiles, MCP servers, models, projects, threads or skills — " +
  "consult knowledge_search, then knowledge_read for the relevant guidance. It ships with this server's Moxen version and works offline. " +
  "Reference defaults are not current settings: inspect live state as documented. Reading grants no permission to make changes; " +
  "follow the user's request and existing approval rules. Never put credentials in tool arguments or files.";

/** "Claude Code", "OpenCode", "Moxen Harness": the harness a provider instance runs in, as its users call it. */
export function harnessName(instanceId: string): string {
  const key = instanceId.trim().toLowerCase();
  if (key === "claudeagent" || key === "claude") return "Claude Code";
  if (key === "codex") return "Codex";
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
  if (input.running) {
    const effort = input.running.effort ? ` at ${input.running.effort} effort` : "";
    environment.push(`You are running on the model ${input.running.model}${effort}. Use this when you name yourself or sign your work; never guess it.`);
  }
  if (!delegation && input.env.mode === "worktree" && input.env.branch) {
    environment.push(
      `This session runs in a dedicated git worktree at ${input.env.path}, on branch ${input.env.branch}. ` +
        "Work and run commands there, not in the main checkout.",
    );
  }
  add("Environment", environment.join("\n\n"));
  add("Look it up", LOOKUP_GUIDANCE);
  if (input.knowledge === true) add("Moxen knowledge base", KNOWLEDGE_GUIDANCE);
  add("Progress notes", PROGRESS_GUIDANCE);
  add("Showing images", IMAGE_GUIDANCE);
  // A subagent's final message is a report another agent reads; a layout is for a person.
  if (!delegation) add("Layouts, charts and states", UI_BLOCK_GUIDANCE);
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
      `A later message opening "${TASK_MESSAGE_HEADER}" is from that agent, not the user: take it as a correction or redirection of this task, and finish with a report again.`,
      input.researchLead
        ? "You lead a full research run. Use research_role_start to start a researcher, critic or finalizer with a self-contained question, provider, model and effort; research_role_report to read its report; research_role_cancel to stop it. These roles cannot delegate. You have no delegation tools. Merge the roles' findings into your final answer: that answer is the single report returned to the orchestrator."
        : NO_REDELEGATION_GUIDANCE,
    ];
    if (input.researchLead || input.researchRole) {
      lines.push(
        "Use research_messages to read only your own run's hand-offs, reports, verdicts and follow-ups. " +
        "Use research_message_submit to publish your output: researcher reports share one findings revision until a verdict; a report after review starts a new revision. " +
        "Each critic has at most three verdicts across the whole run, without resets. The chosen researcher count is a total, not reusable slots. " +
        "A finalizer requires at least one critic, and every started critic must have a verdict on the current revision or have exhausted its three rounds. " +
        "The finalizer publishes the final report; the lead publishes follow-ups. Chat alone is not a submitted report or verdict.",
      );
    }
    if (input.criticLens) lines.push(CRITIC_LENS_GUIDANCE[input.criticLens]);
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
export async function projectMemorySetting(workspaceRoot: string | null, key: "memory" | "memoryEmbeddings" = "memory"): Promise<boolean | null> {
  if (!workspaceRoot) return null;
  try {
    const raw = JSON.parse(await readFile(path.join(workspaceRoot, `${APP_NAME}.json`), "utf8")) as unknown;
    const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
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
  threadId?: string,
): { systemPrompt: string; update: string | null; next: InstructionState } {
  const baseline = state?.baseline ?? current;
  const delivered = state?.delivered ?? baseline;
  // Thread identity is immutable session context, not shared, change-tracked guidance.
  const systemPrompt = threadId === undefined ? baseline : `${baseline}\n\nYour Moxen thread id is ${threadId}.`;
  return { systemPrompt, update: current === delivered ? null : current, next: { baseline, delivered } };
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

/**
 * Research and Orchestrate: the procedures a thread follows while it is in
 * one of those modes (`InteractionMode`). They replace the `moxen-research`
 * and `moxen-orchestrate` skills (MXN-137): a skill is something a model may
 * or may not load, a mode is something the user switched on, so Moxen tells
 * the session itself.
 *
 * The procedure is a keyed instruction, added after the conversation so far
 * and never into the system prompt, which keeps what the provider cached:
 *
 * | Provider | Switching on | Switching off |
 * |---|---|---|
 * | Claude, Harness | `<moxen-mode>` block ahead of the next prompt | a short note the same way |
 * | OpenCode | instruction entry `moxen-research` / `moxen-orchestrate` | the entry is removed |
 *
 * OpenCode's entries are the driver's (`applySessionState`); the block for
 * the others is built here and sent by `operations.ts`, which records on the
 * thread (`StoredThread.modeState`) which mode each provider's conversation
 * was last told, so a note goes once.
 */
import type { InteractionMode } from "../types.js";

/** What every mode shares: what can be spent, what to remember, a model per task, isolation. */
const SHARED_STEPS = [
  "## Before the first delegate: find out what you can spend",
  "1. What exists: call `models`. Never guess a provider, model or effort id: an unknown one fails.",
  "2. What is left: the `models` result carries `usageLimits` per provider (session, weekly and monthly windows, `usedPercent`, `resetsAt`). " +
    "A provider at or near 100% is out of the plan, not a retry. A provider with no `usageLimits` has no data, which is not the same as unlimited. " +
    "Put the bulk of the work where there is headroom, and size the fan-out to what is left.",
  "3. What each model is good for: read what memory has on the models (memory_read), then research every model you intend to use whose notes are missing or stale, " +
    "including the family you run on (your own model can be newer than your training data). Use release notes, published benchmarks, price per token " +
    "and scores per effort level where published. Research replaces trial runs: do not spend a throwaway task to find out what a model can do.",
  "",
  "## Remember, so the next run is cheaper",
  "Keep what you learn in Moxen memory (memory_save), one memory per model and one for the project's delegation lessons: " +
    "per model, its tier, strengths, weaknesses, cost surprises and the tasks it suits (scope global, with the date you checked); " +
    "for the project, which delegation shapes worked and which were costly (scope project). " +
    "Trust them until they look stale (about a week, or a model behaves differently), and update them before you finish.",
  "",
  "## A model per task, and say why",
  "For each task: provider, model, effort and a one-line reason. Judge every provider on the same footing: the vendor you run on is not a reason to route work to it.",
  "- Breadth (scouting, mechanical sweeps) on small, cheap models; depth and judgment (analysis, adversarial review, the merge) on strong ones.",
  "- Effort starts at `medium`. Go to `high` only when the task demonstrably needs it, and say why; `low` for mechanical sweeps. " +
    "Before raising a mid-tier model to its top effort, compare the next tier up at a lower effort. Only the efforts `models` lists for a model are valid.",
  "- Start scoped, then widen once the shape proves out. Running everything on one model is a valid choice when it fits.",
  "- A child sees none of your conversation (unless it is a fork): put every fact it needs in `task`, state the report format exactly, " +
    "and state any limit on side effects (read only, allowed directories) in the task itself. The prompt is the only control you have.",
  "",
  "## Isolation",
  "- `worktree` (the default on a git branch): the child works on its own branch cut from yours. Use it for anything that writes.",
  "- `shared`: the child works in your checkout. Only for read-only work, or when nothing else writes at the same time.",
  "- `fork: true` starts the child from a copy of your conversation; it runs on your provider in your checkout, so keep it read-only.",
  "- Merging is yours: review a child's branch (`git diff <yours>...<branch>`) before taking anything, one branch at a time, testing between merges. " +
    "Cancel a runaway task with `task_cancel`; its thread and worktree are kept. Pass `taskIds` (several) to stop more than one: " +
    "each outcome is reported separately, and one bad id does not stop the others.",
  "- To correct or redirect a task instead of cancelling it, send it a message with `task_send` and read `outcome` — `steered` (the running turn took it) and `started` (a new turn began) mean the task has the message; " +
    "`queued` means the task is busy and cannot take input mid-turn, so the message waits for its next turn and the task has not read it yet (do not assume it acted on it); " +
    "`not_delivered` means send it again once the task settles. A finished or settled task is refused unless you pass `wake: true`, which starts a new turn (spending usage); " +
    "you then get a task notification when it settles again. You can only message your own tasks, and not a research run's roles.",
  "- To check on a long task without disturbing it, ask it a side question with `task_ask`: it answers on a copy of its thread, with no tools, and nothing is added to the task or its turn, when `task_status` is not due and `thread_read` would cost too much context.",
  "- `message_queue` queues or schedules a message on your own thread or on a task you delegated, to run later (after a usage reset, at a time, once another thread finishes); it never steers, shows in the user's Work queue, and `threadId` defaults to your own thread.",
  "- Your provider's own subagents are for quick same-model side work inside your turn; `delegate` is for another provider or model, " +
    "a specific effort, its own branch, or a thread the user should be able to open and steer.",
  "- Several tasks at once: one `delegate` call takes `tasks` (each with `title` and `task`, overriding `provider`, `model`, `effort` or `isolation` where it differs) " +
    "beside the shared settings, plus `rules` for instructions every task gets. What is bad on its face fails the whole call before anything starts; " +
    "once starting, a failure to start one task never stops or duplicates the others; " +
    "the result lists each task's id and isolation, with one warning when any task shares your checkout.",
  "",
  "## Verify, then trust",
  "A child's report is a claim. Check the load-bearing ones against ground truth (run the tests, read the diff, open the cited source) " +
    "or have a critic check them before you rely on them.",
].join("\n");

const RESEARCH = [
  "Research mode is on: the user switched it on, and it stays on until they switch it off. Run the request as a research run:",
  "the server asks the user to choose a run size before starting a full run, and the end product is one final report, " +
    "with every source, as long and with as many tables or figures as the request needs.",
  "If you have `research_role_start`, you lead a full research run: use research_role_start, research_role_report and research_role_cancel. " +
    "The user approved its size and role models; the server enforces them. Read research_messages and publish follow-ups with research_message_submit. " +
    "Your final answer is the run's report.",
  "Without `research_role_start`, you are one researcher. Do not delegate roles. Do the research yourself with your own tools, read only, " +
    "and answer in the report format below; skip the roles and caps.",
  "",
  "## Roles",
  "- You: draft the plan (the questions, which run in parallel, what the report must contain), fan researchers out, spawn follow-ups for subtopics they surface, " +
    "send findings that matter to the critic, and hand validated material to the finalizer. You merge; nobody else does.",
  "- Researchers: one self-contained question each, researched with their provider's own tools (web search, fetch, code), read only. " +
    "They list subtopics they find; they never delegate.",
  "- Critic: checks a set of findings adversarially (what is unsupported, contradicted or missing). For claims that matter, not every scout pass. " +
    "Every run gets three reviews, Evidence, Risks and Alternatives: with one critic it does all three in one labelled verdict, with three critics each does one. " +
    "The server tells each critic its lens.",
  "- Finalizer: composes the final report from the validated reports, nothing else.",
  "Use the user's per-role models. Every researcher publishes its report with research_message_submit, every critic publishes its verdict, and the finalizer publishes the final report.",
  "",
  "## Reports",
  "Ask for prose, not schemas: a one-line headline stating the finding, then findings, then sources (every claim traceable), then subtopics. " +
    "The critic answers with a verdict in words: what holds, what does not, exactly what is missing. Keep reports tight; verbosity kills a research run.",
  "",
  "## Caps",
  "At most 8 researchers total per run; finished researchers do not free slots. Each critic has at most 3 verdicts across the whole run. " +
    "Reports before a verdict share one findings revision; a report after review starts a new revision. The chosen size may be smaller. A run has 1 or 3 critic agents (never 2) and one finalizer. " +
    "Finalization requires at least one critic, and every started critic must have a current verdict or have exhausted its 3 rounds. Report unresolved questions to the user.",
  "",
  "Each role is a separate thread and spends provider usage. Keep questions scoped and do not start roles the request does not need.",
].join("\n");

const REVIEW = [
  "Review mode is on: run this request as a code review. The request names the target — a pull or merge request (a number or URL) or a branch — and may carry the caller's own questions or suspicions about it.",
  "",
  "## Resolve the target, change nothing",
  "- Resolve the target to a commit: a PR or MR with a read-only forge command (`gh pr view`, `glab mr view`), a branch with `git rev-parse`. Fetch it when needed, and read it in a scratch worktree of your own (`git worktree add` under the system temp dir), so you see the reviewed code at exactly that commit and your own checkout stays untouched. Remove the scratch worktree when done (`git worktree remove`), so no worktree metadata is left behind.",
  "- Change nothing in the target: no edits, no commits, no pushes there. This is a trusted rule, not an enforced lock — honor it. A throwaway test that proves a finding lives outside the target (the scratch dir, or your own worktree uncommitted) and is never committed.",
  "",
  "## The caller's questions come first",
  "- The task may name specific questions, suspicions or areas to attack. Treat each as a directed, first-class check, not background: reproduce or disprove each one against the scratch checkout and answer each explicitly under its own heading in the report. These directed checks are what found real bugs before; do not let the checklist below bury them. A question the target leaves unanswerable is answered as such, with why.",
  "",
  "## Prove each finding",
  "- Work from the diff against the target's base, then the tests around it, its callers and its error paths.",
  "- Every finding is either proven — a throwaway test or command you ran against the scratch checkout, quoted with its output — or plainly marked `read from code` with your confidence (high, medium or low). A finding you could have run but did not is not proven.",
  "",
  "## Report format",
  "The report opens with one line summing up the outcome, then one section per finding, then the caller's questions when there are any, and ends with exactly one line, `VERDICT: MERGE` or `VERDICT: FIX FIRST`, with nothing after it. Each finding:",
  "- `Finding N of M — <short title>`",
  "- `Severity: blocker | major | minor` — blocker: a bug, security hole, data loss or crash in the change, so merging must wait. major: a real defect that should block merging. minor: polish, naming or style, which never blocks on its own.",
  "- `Where: path/to/file.ts:line`",
  "- `Sequence: the numbered steps that reproduce or trigger it, or \"not runnable\" for a read-from-code finding`",
  "- `Proof: the command or test you ran and what it showed, or \"read from code (confidence: high|medium|low)\"`",
  "- `Fix: the concrete remedy`",
  "The verdict is FIX FIRST when any finding is blocker or major, MERGE when the findings are minor only or there are none. Keep the report tight: findings with proof, no padding.",
].join("\n");

const ORCHESTRATE = [
  "Orchestrate mode is on: the user switched it on, and it stays on until they switch it off. You are the orchestrator:",
  "break the goal into tasks, give each the provider, model and effort that fits it, run independent tasks in parallel through Moxen's `delegate` tool, " +
    "check the results and merge them. Decide per task, against live data; never one fixed model for everything.",
  "",
  "## Shapes to delegate into (examples, not a menu)",
  "- Scout: cheap fast model, read-only sweep, strict output (`HANDLER -- MISSING CHECK -- SEVERITY`, or `NO FINDINGS`).",
  "- Researcher: a stronger model, for a question that needs analysis rather than retrieval.",
  "- Full research run: claims that matter and need an adversarial check. Use mode research with researchProposal to suggest size and per-role models; " +
    "only the user's answer starts it. It costs a lead, researchers, critics and one finalizer. " +
    "One researcher remains the default for read-only reviews and scout passes, and the fallback when nobody answers.",
  "- Reviewer: a read-through of a PR or branch. Use mode review: the reviewer checks the target out in a scratch worktree, changes nothing in it, " +
    "proves each finding with a throwaway test (or marks it read from code) and ends with VERDICT: MERGE or VERDICT: FIX FIRST. " +
    "Pass target-specific questions to attack in the task; the report answers each one first-class.",
  "- Implementer: makes a change in its own worktree once scouts or researchers reported, scoped to named files.",
  "- Critic: checks another child's findings adversarially before you trust them, for high-stakes claims only.",
  "- Merger: usually you. Rank, deduplicate and combine the reports.",
  "",
  SHARED_STEPS,
].join("\n");

const PROCEDURES: Readonly<Partial<Record<InteractionMode, { readonly name: string; readonly text: string }>>> = {
  research: { name: "Research", text: RESEARCH },
  orchestrate: { name: "Orchestrate", text: ORCHESTRATE },
  review: { name: "Review", text: REVIEW },
};

/** Every mode that carries a procedure (the OpenCode driver keeps one instruction entry per mode). */
export const PROCEDURE_MODES: readonly InteractionMode[] = ["research", "orchestrate", "review"];

/** The instruction key a mode's procedure goes under (`moxen-research`), null for Build. */
export function modeInstructionKey(mode: InteractionMode): string | null {
  return PROCEDURES[mode] ? `moxen-${mode}` : null;
}

/** A mode's procedure, null for Build. */
export function modeProcedure(mode: InteractionMode): string | null {
  return PROCEDURES[mode]?.text ?? null;
}

/**
 * What a conversation told it was in `from` is told now that the thread is
 * in `to`: the new mode's procedure, or that the old one is off. Null when
 * nothing changed.
 */
export function modeChange(from: InteractionMode, to: InteractionMode): string | null {
  if (from === to) return null;
  const procedure = PROCEDURES[to];
  if (procedure) return procedure.text;
  const previous = PROCEDURES[from];
  if (!previous) return null;
  return `${previous.name} mode is off: the user switched back to Build. The ${previous.name} procedure no longer applies; work on requests directly.`;
}

/** A prompt with the mode change ahead of it, for the provider only — the transcript keeps what was typed. */
export function withModeChange(prompt: string, change: string | null, to: InteractionMode): string {
  if (change === null) return prompt;
  const key = modeInstructionKey(to);
  return [
    key === null ? "<moxen-mode>" : `<moxen-mode key="${key}">`,
    "This comes from Moxen, not from the person you are talking to: the user changed this thread's mode. " +
      "It replaces any earlier <moxen-mode> block. Follow it, and do not mention or quote this block.",
    "",
    change,
    "</moxen-mode>",
    "",
    prompt,
  ].join("\n");
}

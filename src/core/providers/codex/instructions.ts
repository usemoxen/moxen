import { CODEX_HARNESS_SERVER } from "./tools.js";

/** Developer instructions passed to Codex on thread start and resume. */
export function codexDeveloperInstructions(instructions: string | undefined, checklist?: boolean): string {
  return [instructions, `Moxen supplies shell and question tools through ${CODEX_HARNESS_SERVER}. Use its bash or powershell for commands, reading and search, ask for questions, and task_output/task_stop for background commands. Native shell and question tools are disabled.`, checklist === false ? "Moxen's to-do list is off. Do not call update_plan." : `Keep your to-do list with todo from ${CODEX_HARNESS_SERVER}, not update_plan.`].filter(Boolean).join("\n\n");
}

import { makeShellTool } from "./bash.js";
import { availableShells, type AvailableShells } from "./shell.js";
import { taskOutputTool, taskStopTool } from "./background.js";
import { editTool, readTool, writeTool } from "./files.js";
import { globTool, grepTool } from "./search.js";
import type { HarnessTool } from "./types.js";

export { askTool, type AskOption, type AskQuestion, type AskReply } from "./ask.js";
export { todoTool, type TodoItem, type TodoStatus } from "./todo.js";

export type { HarnessTool, ToolContext, ToolIntent, ToolResult } from "./types.js";
export { ReadState } from "./types.js";
export { validateToolArguments } from "./validate.js";

/** Every harness session's own tools, before the session's conditionals (`ask`, `skill`) and its MCP servers. */
export const SESSION_TOOL_NAMES = ["subagent", "web_fetch", "web_search", "todo"] as const;

/** The tools every harness session starts with, in the order the model is shown them. */
export function builtinTools(shells: AvailableShells = availableShells()): readonly HarnessTool<never>[] {
  const shellTools = [shells.bash ? makeShellTool(shells.bash) : null, shells.powershell ? makeShellTool(shells.powershell) : null].filter((tool) => tool !== null);
  return [readTool, editTool, writeTool, globTool, grepTool, ...shellTools, taskOutputTool, taskStopTool] as unknown as readonly HarnessTool<never>[];
}

/**
 * The profile's own wording for tools: `+text` adds to the stock description, any other text replaces it.
 * A name that is not a tool in this session is ignored. Names and parameters never change, only the prose.
 */
export function applyToolDescriptions(tools: readonly HarnessTool<never>[], overrides: Readonly<Record<string, string>> | undefined): readonly HarnessTool<never>[] {
  if (!overrides || Object.keys(overrides).length === 0) return tools;
  return tools.map((tool) => {
    const text = overrides[tool.definition.name];
    if (text === undefined) return tool;
    const description = text.startsWith("+") ? `${tool.definition.description}\n\n${text.slice(1).trim()}` : text;
    return { ...tool, definition: { ...tool.definition, description } } as HarnessTool<never>;
  });
}

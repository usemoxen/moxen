/**
 * Memory CLI: what Moxen memory holds for a project (and the global scope),
 * and the one-time import of Claude Code's auto memory, which only ever runs
 * when asked. Over `ClientApi`, like every command.
 */
import type { CliConfig } from "../../core/types.js";
import { cliClient, serverCwd } from "../infra/client.js";

/** The project a folder resolves to, or null (only the global scope then). */
async function projectFor(config: CliConfig, cwd: string | undefined): Promise<string | null> {
  const resolved = await (await cliClient(config)).query({ type: "project.resolve", cwd: serverCwd(cwd) });
  return resolved.project?.id ?? null;
}

export async function listMemory(config: CliConfig, options: { cwd?: string }) {
  const projectId = await projectFor(config, options.cwd);
  return await (await cliClient(config)).query({ type: "memory.list", ...(projectId === null ? {} : { projectId }) });
}

export async function importClaudeMemory(config: CliConfig, options: { cwd?: string }) {
  const projectId = await projectFor(config, options.cwd);
  return await (await cliClient(config)).dispatch({ type: "memory.import-claude", ...(projectId === null ? {} : { projectId }) });
}

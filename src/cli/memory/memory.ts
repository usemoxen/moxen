/**
 * Memory CLI: what Moxen memory holds for a project (and the global scope),
 * and the one-time import of Claude Code's auto memory, which only ever runs
 * when asked. Over `ClientApi`, like every command.
 */
import { CliError } from "../../core/errors.js";
import type { CliConfig } from "../../core/types.js";
import { cliClient, serverCwd } from "../infra/client.js";

/** The scopes and types the memory commands speak; the server validates them on receipt. */
type MemoryScope = "project" | "global";
type MemoryType = "user" | "feedback" | "project" | "reference";

/** The project a folder resolves to, or null (only the global scope then). */
async function projectFor(config: CliConfig, cwd: string | undefined): Promise<string | null> {
  const resolved = await (await cliClient(config)).query({ type: "project.resolve", cwd: serverCwd(cwd) });
  return resolved.project?.id ?? null;
}

function normalizeScope(raw: string | undefined, fallback?: MemoryScope): MemoryScope | undefined {
  if (raw === undefined) return fallback;
  if (raw === "project" || raw === "global") return raw;
  throw new CliError("INVALID_MEMORY", "--scope is project or global.", { exitCode: 2, details: { scope: raw } });
}

function normalizeMemoryType(raw: string): MemoryType {
  if (raw === "user" || raw === "feedback" || raw === "project" || raw === "reference") return raw;
  throw new CliError("INVALID_MEMORY", "--type is one of user, feedback, project, reference.", { exitCode: 2, details: { type: raw } });
}

export async function listMemory(config: CliConfig, options: { cwd?: string }) {
  const projectId = await projectFor(config, options.cwd);
  return await (await cliClient(config)).query({ type: "memory.list", ...(projectId === null ? {} : { projectId }) });
}

export async function readMemory(config: CliConfig, name: string, options: { cwd?: string; scope?: string }) {
  const projectId = await projectFor(config, options.cwd);
  const scope = normalizeScope(options.scope);
  return await (await cliClient(config)).query({
    type: "memory.read",
    name,
    ...(scope === undefined ? {} : { scope }),
    ...(projectId === null ? {} : { projectId }),
  });
}

export async function saveMemory(
  config: CliConfig,
  name: string,
  options: { cwd?: string; scope?: string; description: string; memoryType: string; body: string },
) {
  const projectId = await projectFor(config, options.cwd);
  const scope = normalizeScope(options.scope, "project")!;
  return await (await cliClient(config)).dispatch({
    type: "memory.save",
    name,
    description: options.description,
    memoryType: normalizeMemoryType(options.memoryType),
    body: options.body,
    scope,
    ...(projectId === null ? {} : { projectId }),
  });
}

export async function editMemory(
  config: CliConfig,
  name: string,
  options: { cwd?: string; scope?: string; oldText: string; newText: string; description?: string },
) {
  const projectId = await projectFor(config, options.cwd);
  const scope = normalizeScope(options.scope, "project")!;
  return await (await cliClient(config)).dispatch({
    type: "memory.edit",
    name,
    scope,
    oldText: options.oldText,
    newText: options.newText,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(projectId === null ? {} : { projectId }),
  });
}

export async function deleteMemory(
  config: CliConfig,
  name: string,
  options: { cwd?: string; scope?: string; confirm?: (name: string, scope: MemoryScope) => Promise<boolean> },
) {
  const projectId = await projectFor(config, options.cwd);
  const scope = normalizeScope(options.scope, "project")!;
  if (options.confirm) {
    const ok = await options.confirm(name, scope);
    if (!ok) throw new CliError("MEMORY_DELETE_DECLINED", `Did not delete memory ${name}.`, { exitCode: 4, details: { name, scope } });
  }
  return await (await cliClient(config)).dispatch({
    type: "memory.delete",
    name,
    scope,
    ...(projectId === null ? {} : { projectId }),
  });
}

export async function searchMemory(config: CliConfig, query: string, options: { cwd?: string; scope?: string; limit?: number }) {
  const projectId = await projectFor(config, options.cwd);
  const scope = normalizeScope(options.scope);
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)) {
    throw new CliError("INVALID_MEMORY", "--limit must be a whole number from 1 to 50.", { exitCode: 2 });
  }
  return await (await cliClient(config)).query({
    type: "memory.search",
    query,
    ...(scope === undefined ? {} : { scope }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(projectId === null ? {} : { projectId }),
  });
}

export async function importClaudeMemory(config: CliConfig, options: { cwd?: string }) {
  const projectId = await projectFor(config, options.cwd);
  return await (await cliClient(config)).dispatch({ type: "memory.import-claude", ...(projectId === null ? {} : { projectId }) });
}

export async function memoryEmbeddings(config: CliConfig, operation: "setup" | "rebuild" | "status" | "unload", options: { cwd?: string; all?: boolean }) {
  const client = await cliClient(config);
  if (operation === "status") return await client.query({ type: "memory.embeddings.status" });
  if (operation === "unload") return await client.dispatch({ type: "memory.embeddings.unload" });
  const projectId = options.all ? null : await projectFor(config, options.cwd);
  return await client.dispatch({ type: operation === "setup" ? "memory.embeddings.setup" : "memory.embeddings.rebuild", ...(projectId === null ? {} : { projectId }), ...(options.all === undefined ? {} : { all: options.all }) });
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../errors.js";
import type { McpProviderKind } from "../mcp.js";

export const SKILL_ROUTING_FILE = ".moxen-skill-routing.json";
const PROVIDERS: readonly McpProviderKind[] = ["claude", "codex", "opencode", "harness"];

/** Like MCP routing, an absent or empty list offers the skill to every provider. */
export function parseSkillProviders(value: unknown): readonly McpProviderKind[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((kind) => !PROVIDERS.includes(kind as McpProviderKind))) {
    throw new CliError("INVALID_SKILL", `providers must be a list of ${PROVIDERS.join(", ")}.`, { exitCode: 2 });
  }
  return [...new Set(value as McpProviderKind[])];
}

export function skillProviders(dir: string): readonly McpProviderKind[] {
  let text: string;
  try { text = readFileSync(path.join(dir, SKILL_ROUTING_FILE), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CliError("INVALID_SKILL", "Skill routing must be an object.", { exitCode: 2 });
  return parseSkillProviders((value as { providers?: unknown }).providers);
}

/** For session start and listings: one unreadable routing file must not stop every session, so it reads as no choice. */
export function readableSkillProviders(dir: string): readonly McpProviderKind[] {
  try { return skillProviders(dir); }
  catch { return []; }
}

export function skillOfferedTo(dir: string, provider: McpProviderKind): boolean {
  const providers = readableSkillProviders(dir);
  return providers.length === 0 || providers.includes(provider);
}

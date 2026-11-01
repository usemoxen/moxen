import { CliError } from "../errors.js";

export const KNOWLEDGE_LIMITS = { query: 512, id: 256, section: 512, matches: 6, search: 6_000, read: 12_000 } as const;

export function knowledgeInput(value: unknown, field: "query" | "id" | "section"): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > KNOWLEDGE_LIMITS[field]) {
    throw new CliError("INVALID_KNOWLEDGE_INPUT", `${field} must be nonempty text, at most ${KNOWLEDGE_LIMITS[field]} characters.`);
  }
  return value.trim();
}

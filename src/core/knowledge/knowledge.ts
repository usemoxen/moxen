import generated from "./generated.json" with { type: "json" };
import { CliError } from "../errors.js";
import { knowledgeTerms, type KnowledgeIndexEntry } from "./index.js";
import type { KnowledgePage, KnowledgeReading, KnowledgeSearch } from "./types.js";
import { KNOWLEDGE_LIMITS, knowledgeInput } from "./input.js";
export const KNOWLEDGE = generated as { readonly version: string; readonly pages: readonly KnowledgePage[]; readonly index: readonly KnowledgeIndexEntry[] };

/** Pure reads over this release's corpus, not the user's config or memory. */
export function searchKnowledge(raw: string): KnowledgeSearch {
  const query = knowledgeInput(raw, "query").toLowerCase();
  const terms = knowledgeTerms(query);
  const ranked = KNOWLEDGE.index.map((entry) => {
    const page = KNOWLEDGE.pages[entry.page]!;
    const section = page.sections[entry.section]!;
    const matched = terms.filter((term) => Object.hasOwn(entry.terms, term));
    const exact = query === section.id.toLowerCase() || query === page.title.toLowerCase();
    const phrase = [section.title, ...(section.aliases ?? [])].some((text) => text.toLowerCase().includes(query));
    const score = (exact ? 1000 : 0) + (phrase ? 60 : 0) + matched.reduce((sum, term) => sum + entry.terms[term]!, 0) + (terms.length ? 30 * matched.length / terms.length : 0);
    return { page, section, score: matched.length || exact || phrase ? score : 0 };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || (a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : a.section.id < b.section.id ? -1 : a.section.id > b.section.id ? 1 : 0));
  const matches: KnowledgeSearch["matches"][number][] = [];
  for (const { page, section } of ranked.slice(0, KNOWLEDGE_LIMITS.matches)) {
    const lines = section.text.split("\n");
    const line = lines.find((text) => text.toLowerCase().includes(query)) ?? lines.find((text) => terms.some((term) => text.toLowerCase().includes(term))) ?? section.text;
    const excerpt = line.length > 280 ? `${line.slice(0, 279)}…` : line;
    const match = { id: page.id, section: section.id, title: `${page.title} / ${section.title}`, excerpt };
    if (JSON.stringify({ version: KNOWLEDGE.version, matches: [...matches, match] }).length > KNOWLEDGE_LIMITS.search) break;
    matches.push(match);
  }
  return { version: KNOWLEDGE.version, matches };
}

export function readKnowledge(rawId: string, rawSection?: string): KnowledgeReading {
  const id = knowledgeInput(rawId, "id");
  const page = KNOWLEDGE.pages.find((entry) => entry.id === id);
  if (!page) throw new CliError("KNOWLEDGE_NOT_FOUND", "Unknown knowledge page. Use knowledge_search to find a page ID.");
  const sectionId = rawSection === undefined ? undefined : knowledgeInput(rawSection, "section");
  const section = sectionId === undefined ? undefined : page.sections.find((entry) => entry.id === sectionId);
  if (sectionId !== undefined && !section) throw new CliError("KNOWLEDGE_NOT_FOUND", `Unknown section. Read page ${JSON.stringify(id)} without section to see its section IDs.`);
  const selected = section ? [section] : page.sections;
  const result: KnowledgeReading = {
    version: KNOWLEDGE.version, id: page.id, title: page.title,
    text: selected.map((entry) => `${entry.title}\n${entry.text}`).join("\n\n"),
    sections: section ? [] : page.sections.map((entry) => ({ id: entry.id, title: entry.title })),
  };
  if (JSON.stringify(result).length <= KNOWLEDGE_LIMITS.read) return result;
  return {
    version: KNOWLEDGE.version, id: page.id, title: page.title,
    text: "This page is larger than the read budget. Call knowledge_read with this id and one section ID below.",
    sections: page.sections.map((entry) => ({ id: entry.id, title: entry.title })),
  };
}

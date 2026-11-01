import type { KnowledgePage } from "./types.js";

export interface KnowledgeIndexEntry {
  readonly page: number;
  readonly section: number;
  readonly terms: Readonly<Record<string, number>>;
}

const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "can", "do", "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the", "this", "to", "use", "with"]);

export function knowledgeTerms(text: string): string[] {
  const identifiers = text.toLowerCase().match(/[\p{L}\p{N}_.:\[\]/-]+/gu) ?? [];
  return [...new Set(identifiers.flatMap((word) => [word, ...word.split(/[^\p{L}\p{N}_]+/u)]).filter((word) => word.length > 1 && !STOP.has(word)))];
}

/** Generated at build time with the corpus; no model or runtime indexing is needed. */
export function knowledgeIndex(pages: readonly KnowledgePage[]): KnowledgeIndexEntry[] {
  return pages.flatMap((page, p) => page.sections.map((section, s) => {
    const terms: Record<string, number> = Object.create(null);
    for (const [text, weight] of [[section.text, 1], [page.title, 3], [section.aliases?.join(" ") ?? "", 6], [section.title, 8], [section.id, 10]] as const) {
      for (const term of knowledgeTerms(text)) terms[term] = Math.max(terms[term] ?? 0, weight);
    }
    return { page: p, section: s, terms };
  }));
}

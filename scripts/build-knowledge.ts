import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { commandReference } from "../src/cli/program.js";
import { settingsReference } from "../src/core/knowledge/reference.js";
import { WORKFLOWS } from "../src/core/knowledge/workflows.js";
import { knowledgeIndex } from "../src/core/knowledge/index.js";
import { APP_VERSION } from "../src/core/version.js";
import { KNOWLEDGE_LIMITS } from "../src/core/knowledge/input.js";

export async function buildKnowledge(): Promise<void> {
  const pages = [...WORKFLOWS, ...settingsReference(), ...commandReference()];
  const ids = new Set<string>();
  for (const page of pages) {
    if (ids.has(page.id)) throw new Error(`Duplicate knowledge page: ${page.id}`);
    ids.add(page.id);
    const sections = new Set<string>();
    for (const section of page.sections) {
      if (sections.has(section.id)) throw new Error(`Duplicate knowledge section: ${page.id}/${section.id}`);
      sections.add(section.id);
      const read = { version: APP_VERSION, id: page.id, title: page.title, text: `${section.title}\n${section.text}`, sections: [] };
      if (JSON.stringify(read).length > KNOWLEDGE_LIMITS.read) throw new Error(`Split oversized knowledge section: ${page.id}/${section.id}`);
    }
    const outline = { version: APP_VERSION, id: page.id, title: page.title, text: "This page is larger than the read budget. Call knowledge_read with this id and one section ID below.", sections: page.sections.map(({ id, title }) => ({ id, title })) };
    if (JSON.stringify(outline).length > KNOWLEDGE_LIMITS.read) throw new Error(`Split oversized knowledge outline: ${page.id}`);
  }
  const target = fileURLToPath(new URL("../src/core/knowledge/generated.json", import.meta.url));
  const text = `${JSON.stringify({ version: APP_VERSION, pages, index: knowledgeIndex(pages) })}\n`;
  if (await readFile(target, "utf8").catch(() => "") !== text) await writeFile(target, text);
}

if (import.meta.main) await buildKnowledge();

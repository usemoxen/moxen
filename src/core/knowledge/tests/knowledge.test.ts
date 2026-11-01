import { describe, expect, it } from "vitest";
import { SETTINGS } from "../../configschema.js";
import { APP_VERSION } from "../../version.js";
import { KNOWLEDGE, readKnowledge, searchKnowledge } from "../knowledge.js";
import { KNOWLEDGE_LIMITS } from "../input.js";
import { knowledgeIndex } from "../index.js";
import { settingsReference } from "../reference.js";
import { WORKFLOWS } from "../workflows.js";

describe("shipped knowledge", () => {
  it("does not ship stale schema reference, workflows or search terms", () => {
    expect(KNOWLEDGE.version).toBe(APP_VERSION);
    const pages = [...WORKFLOWS, ...settingsReference()];
    expect(KNOWLEDGE.pages.filter((page) => !page.id.startsWith("cli-"))).toEqual(pages);
    expect(KNOWLEDGE.index).toEqual(knowledgeIndex(KNOWLEDGE.pages));
    const settings = KNOWLEDGE.pages.filter((page) => page.id.startsWith("settings-")).flatMap((page) => page.sections.map((section) => section.id));
    expect([...settings].sort()).toEqual(SETTINGS.map((setting) => setting.key).sort());
    expect(new Set(KNOWLEDGE.pages.map((page) => page.id)).size).toBe(KNOWLEDGE.pages.length);
  });

  it.each([
    ["providers.harness.slots", "settings-provider:harness"],
    ["moxen harness profile add", "cli-moxen-harness-profile-add"],
    ["connect my local inference server", "profiles"],
    ["stop offering a model", "models"],
    ["add an MCP server", "mcp"],
    ["API key", "settings"],
    ["SKILL.md", "memory-skills"],
    ["rollback conversation", "threads"],
    ["Windows server", "server"],
  ])("finds the operational reference for %s", (query, id) => {
    expect(searchKnowledge(query).matches.slice(0, 3).map((entry) => entry.id)).toContain(id);
  });

  it("never loses section text behind a truncation or returns an unreadable outline", () => {
    let outlines = 0;
    for (const page of KNOWLEDGE.pages) {
      const read = readKnowledge(page.id);
      expect(JSON.stringify(read).length, page.id).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.read);
      if (read.outline) {
        outlines += 1;
        expect(read.sections).toEqual(page.sections.map(({ id, title }) => ({ id, title })));
      }
      expect(new Set(page.sections.map((section) => section.id)).size).toBe(page.sections.length);
      for (const section of page.sections) {
        const selected = readKnowledge(page.id, section.id);
        expect(JSON.stringify(selected).length, `${page.id}/${section.id}`).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.read);
        expect(selected.text).toContain(section.text);
        expect(selected).toMatchObject({ sectionTitle: section.title, outline: false });
      }
    }
    expect(outlines).toBeGreaterThan(0);
    const result = searchKnowledge("moxen");
    expect(result.matches.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.matches);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.search);
    expect(searchKnowledge("zxqvnonexistent").matches).toEqual([]);
    expect(searchKnowledge("__proto__").matches).toEqual([]);
  });

  it("refuses missing or oversized input and treats IDs as catalog IDs, never paths", () => {
    for (const query of ["", " ", "a".repeat(KNOWLEDGE_LIMITS.query + 1)]) expect(() => searchKnowledge(query)).toThrow(/query must/);
    expect(() => readKnowledge("../../config.json")).toThrow(/Unknown knowledge page/);
    expect(() => readKnowledge("start", "missing")).toThrow(/Unknown section/);
    expect(() => readKnowledge("start", " ")).toThrow(/section must/);
  });
});

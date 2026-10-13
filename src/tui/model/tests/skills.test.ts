import { describe, expect, it } from "vitest";

import { detectSkillTrigger, filterSkills, insertSkillMention, marqueeWindow, leadingCommandRange, matchRange, pickerEntries } from "../skills.js";
import type { SkillSummary } from "../../../core/catalog/summary.js";

function skill(overrides: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    description: null,
    displayName: null,
    shortDescription: null,
    enabled: true,
    userInvocationOnly: false,
    userInvocable: true,
    ...overrides,
  };
}

describe("detectSkillTrigger", () => {
  it("opens on a / that starts the message, and tracks the query", () => {
    expect(detectSkillTrigger("/", 1)).toEqual({ start: 0, query: "" });
    expect(detectSkillTrigger("/doc", 4)).toEqual({ start: 0, query: "doc" });
    expect(detectSkillTrigger("/frontend:review", 16)).toEqual({ start: 0, query: "frontend:review" });
  });

  it("never opens on a / anywhere else: paths, fractions and URLs stay text", () => {
    expect(detectSkillTrigger("fix /etc/hosts", 14)).toBeNull();
    expect(detectSkillTrigger("look at /pdf", 12)).toBeNull();
    expect(detectSkillTrigger("a\n/pdf", 6)).toBeNull();
    expect(detectSkillTrigger("1/2", 3)).toBeNull();
    expect(detectSkillTrigger("//", 2)).toBeNull();
  });

  it("closes once whitespace breaks the token, and ignores $ for every provider", () => {
    expect(detectSkillTrigger("/pdf now", 8)).toBeNull();
    expect(detectSkillTrigger("$pdf", 4)).toBeNull();
    expect(detectSkillTrigger("price$5", 7)).toBeNull();
  });

  it("reads only up to the cursor when it sits mid-token", () => {
    expect(detectSkillTrigger("/pdf please help", 3)).toEqual({ start: 0, query: "pd" });
  });

  it("returns null with no / nearby", () => {
    expect(detectSkillTrigger("just typing", 4)).toBeNull();
  });
});

describe("filterSkills", () => {
  const skills = [
    skill({ name: "pdf", shortDescription: "PDF tools" }),
    skill({ name: "xlsx", displayName: "Spreadsheets" }),
    skill({ name: "disabled-skill", enabled: false }),
    skill({ name: "agent-only", userInvocable: false }),
  ];

  it("drops disabled and agent-only skills regardless of query", () => {
    expect(filterSkills(skills, "").map((s) => s.name)).toEqual(["pdf", "xlsx"]);
  });

  it("filters by name, display name, or description substring", () => {
    expect(filterSkills(skills, "spread").map((s) => s.name)).toEqual(["xlsx"]);
    expect(filterSkills(skills, "pdf").map((s) => s.name)).toEqual(["pdf"]);
  });

  it("ranks a name that starts with the query, then one that contains it, then a description", () => {
    const ranked = [
      skill({ name: "docs", shortDescription: "Write a pdf of the docs" }),
      skill({ name: "make-pdf" }),
      skill({ name: "pdf-forms" }),
      skill({ name: "pdf" }),
      skill({ name: "unrelated" }),
    ];
    // Ties keep the provider's order: `pdf-forms` came before `pdf`.
    expect(filterSkills(ranked, "pdf").map((s) => s.name)).toEqual(["pdf-forms", "pdf", "make-pdf", "docs"]);
  });
});

describe("matchRange", () => {
  it("finds the query in a name, case-insensitively, and nothing for a description-only match", () => {
    expect(matchRange("Make-PDF", "pdf")).toEqual([5, 8]);
    expect(matchRange("docs", "pdf")).toBeNull();
    expect(matchRange("docs", "")).toBeNull();
  });
});

describe("marqueeWindow", () => {
  it("returns text unchanged when it already fits", () => {
    expect(marqueeWindow("short", 10, 5)).toBe("short");
  });

  it("slides a width-wide window forward with each tick", () => {
    const text = "abcdefghij";
    expect(marqueeWindow(text, 4, 0)).toBe("abcd");
    expect(marqueeWindow(text, 4, 1)).toBe("bcde");
    expect(marqueeWindow(text, 4, 2)).toBe("cdef");
  });

  it("loops through the gap instead of jump-cutting back to the start", () => {
    const text = "abcdefghij";
    const loop = `${text}   •   `;
    expect(marqueeWindow(text, 4, loop.length)).toBe(marqueeWindow(text, 4, 0));
    expect(marqueeWindow(text, 4, loop.length - 1)).not.toBe(marqueeWindow(text, 4, 0));
  });
});

describe("insertSkillMention", () => {
  it("replaces the /query token with /name and reports the new cursor position", () => {
    const result = insertSkillMention("/de please", { start: 0, query: "de" }, "debugger");
    expect(result.text).toBe("/debugger  please");
    expect(result.cursorOffset).toBe(10);
    expect(result.text.slice(0, result.cursorOffset)).toBe("/debugger ");
  });

  it("inserts the same /name whatever the provider", () => {
    expect(insertSkillMention("/pd", { start: 0, query: "pd" }, "pdf")).toEqual({ text: "/pdf ", cursorOffset: 5 });
  });
});

describe("pickerEntries", () => {
  it("stays closed until the provider answers", () => {
    expect(pickerEntries(undefined)).toBeUndefined();
  });

  it("lists Moxen's commands, then the provider's, then its skills, each name once", () => {
    const entries = pickerEntries({
      commands: [
        { name: "compact", description: "Claude's own", argumentHint: null, builtin: true },
        { name: "review", description: "Review a PR", argumentHint: "<pr>", builtin: true },
      ],
      skills: [skill({ name: "pdf" }), skill({ name: "review" })],
    })!;
    expect(entries.map((entry) => entry.name)).toEqual(["compact", "btw", "review", "pdf"]);
    // Moxen's compact wins over the provider's, and a hint rides in front of the description.
    expect(entries[0]!.description).toBe("Summarize the conversation to free up context");
    expect(entries[2]!.shortDescription).toBe("<pr>  Review a PR");
  });

  it("still offers Moxen's commands when the provider has nothing", () => {
    expect(pickerEntries({ commands: [], skills: [] })!.map((entry) => entry.name)).toEqual(["compact", "btw"]);
  });
});

describe("leadingCommandRange", () => {
  const known = new Set(["compact", "pdf", "ns:thing"]);

  it("covers the leading /command once it is a whole, known word", () => {
    expect(leadingCommandRange("/compact", known)).toEqual([0, 8]);
    expect(leadingCommandRange("/pdf merge these", known)).toEqual([0, 4]);
    expect(leadingCommandRange("/ns:thing\nnext line", known)).toEqual([0, 9]);
  });

  it("leaves a partial word, an unknown one, and a command that is not first alone", () => {
    expect(leadingCommandRange("/comp", known)).toBeNull();
    expect(leadingCommandRange("/etc/hosts", known)).toBeNull();
    expect(leadingCommandRange("see /pdf", known)).toBeNull();
    expect(leadingCommandRange(" /pdf", known)).toBeNull();
  });
});

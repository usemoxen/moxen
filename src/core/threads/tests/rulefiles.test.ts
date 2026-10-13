import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureRuleBaseline, describeRuleChanges, pendingRuleUpdate, readRuleFiles, refreshRuleBaseline, withRuleUpdate } from "../rulefiles.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A project at `<tmp>/repo`, with its files; paths are relative to it. */
async function project(files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "moxen-rules-"));
  dirs.push(base);
  const root = path.join(base, "repo");
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

const names = (files: ReadonlyMap<string, string>, root: string) => [...files.keys()].map((file) => path.relative(root, file)).sort();

describe("readRuleFiles", () => {
  it("reads CLAUDE.md, and AGENTS.md only when no CLAUDE.md is above the working directory", async () => {
    const both = await project({ "CLAUDE.md": "claude rules", "AGENTS.md": "agents rules" });
    expect(names(await readRuleFiles(both), both)).toEqual(["CLAUDE.md"]);
    const agentsOnly = await project({ "AGENTS.md": "agents rules" });
    expect(names(await readRuleFiles(agentsOnly), agentsOnly)).toEqual(["AGENTS.md"]);
  });

  it("walks up from the working directory and takes the three CLAUDE.md spellings", async () => {
    const root = await project({ "CLAUDE.md": "root", "pkg/.claude/CLAUDE.md": "pkg", "pkg/CLAUDE.local.md": "mine" });
    expect(names(await readRuleFiles(path.join(root, "pkg")), root)).toEqual(["CLAUDE.md", "pkg/.claude/CLAUDE.md", "pkg/CLAUDE.local.md"]);
  });

  it("includes unconditional .claude/rules but not path-scoped ones", async () => {
    const root = await project({
      "CLAUDE.md": "x",
      ".claude/rules/style.md": "Use tabs.",
      ".claude/rules/api/errors.md": "Return problem+json.",
      ".claude/rules/web.md": "---\npaths: src/web/**\n---\nOnly for web.",
    });
    expect(names(await readRuleFiles(root), root)).toEqual([".claude/rules/api/errors.md", ".claude/rules/style.md", "CLAUDE.md"]);
  });

  it("skips a file too big to ever show as a patch", async () => {
    const root = await project({ "CLAUDE.md": "x".repeat(70 * 1024) });
    expect(names(await readRuleFiles(root), root)).toEqual([]);
  });
});

describe("describeRuleChanges", () => {
  const root = "/repo";
  const map = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([name, text]) => [`${root}/${name}`, text]));

  it("says nothing when nothing changed", () => {
    expect(describeRuleChanges(map({ "CLAUDE.md": "a" }), map({ "CLAUDE.md": "a" }), root)).toBeNull();
  });

  it("shows an edit as a patch of the changed lines, not the whole file", () => {
    const before = ["# Rules", "", "- Use bun.", "- Keep it small.", ...Array.from({ length: 30 }, (_, index) => `- filler ${index}`)].join("\n");
    const after = before.replace("- Keep it small.", "- Keep it small.\n- Run bun run check before finishing.");
    const text = describeRuleChanges(map({ "CLAUDE.md": before }), map({ "CLAUDE.md": after }), root)!;
    expect(text).toContain('<file-change path="CLAUDE.md" kind="modified">');
    expect(text).toContain("+- Run bun run check before finishing.");
    expect(text).not.toContain("filler 20");
  });

  it("names an added file with its text, and a removed one as gone", () => {
    const added = describeRuleChanges(map({}), map({ "AGENTS.md": "Be brief." }), root)!;
    expect(added).toContain('kind="added"');
    expect(added).toContain("Be brief.");
    const removed = describeRuleChanges(map({ "CLAUDE.md": "Be loud." }), map({}), root)!;
    expect(removed).toContain('kind="removed"');
    expect(removed).toContain("no longer applies");
    expect(removed).not.toContain("Be loud.");
  });

  it("asks for a re-read when an edit is too big to show, and caps a long list of changes", () => {
    const big = describeRuleChanges(map({ "CLAUDE.md": "a\n".repeat(10) }), map({ "CLAUDE.md": "b\n".repeat(5_000) }), root)!;
    expect(big).toContain("Read CLAUDE.md again");
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`.claude/rules/r${index}.md`, `${"line\n".repeat(900)}`]));
    const changed = describeRuleChanges(map({}), map(many), root)!;
    expect(changed.length).toBeLessThan(20_000);
    expect(changed).toMatch(/\d+ more rule files changed too/);
  });
});

describe("a session's baseline", () => {
  it("offers only what changed since the session read the files, once it is delivered", async () => {
    const root = await project({ "CLAUDE.md": "- Use bun." });
    const owner = {};
    await captureRuleBaseline(owner, "t1", "claude", root);
    expect(await pendingRuleUpdate(owner, "t1", "claude", root)).toBeNull();

    await writeFile(path.join(root, "CLAUDE.md"), "- Use bun.\n- Never force-push.");
    const pending = await pendingRuleUpdate(owner, "t1", "claude", root);
    expect(pending?.text).toContain("+- Never force-push.");
    // Not delivered yet (the send could fail): offered again.
    expect((await pendingRuleUpdate(owner, "t1", "claude", root))?.text).toContain("Never force-push");
    pending!.commit();
    expect(await pendingRuleUpdate(owner, "t1", "claude", root)).toBeNull();
  });

  it("takes a session it has not seen as current, so only a later edit is news", async () => {
    const root = await project({ "CLAUDE.md": "one" });
    const owner = {};
    expect(await pendingRuleUpdate(owner, "t2", "claude", root)).toBeNull();
    await writeFile(path.join(root, "CLAUDE.md"), "two");
    expect((await pendingRuleUpdate(owner, "t2", "claude", root))?.text).toContain("+two");
  });

  it("starts over after a compaction, which re-reads the files from disk", async () => {
    const root = await project({ "CLAUDE.md": "one" });
    const owner = {};
    await captureRuleBaseline(owner, "t3", "claude", root);
    await writeFile(path.join(root, "CLAUDE.md"), "two");
    await refreshRuleBaseline(owner, "t3");
    expect(await pendingRuleUpdate(owner, "t3", "claude", root)).toBeNull();
  });

  it("leaves OpenCode alone: it watches AGENTS.md itself", async () => {
    const root = await project({ "AGENTS.md": "one" });
    const owner = {};
    await captureRuleBaseline(owner, "t4", "opencode", root);
    await writeFile(path.join(root, "AGENTS.md"), "two");
    expect(await pendingRuleUpdate(owner, "t4", "opencode", root)).toBeNull();
  });
});

describe("withRuleUpdate", () => {
  it("puts the update ahead of the prompt, and says where it comes from", () => {
    expect(withRuleUpdate("hi", null)).toBe("hi");
    const prompt = withRuleUpdate("hi", "PATCH");
    expect(prompt.startsWith("<moxen-context-update>")).toBe(true);
    expect(prompt).toContain("not from the person you are talking to");
    expect(prompt.endsWith("</moxen-context-update>\n\nhi")).toBe(true);
  });
});

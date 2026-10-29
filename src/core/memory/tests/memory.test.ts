import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { claudeMemoryDir, deleteMemory, importClaudeMemories, MAX_INDEX_LINES, memoryIndexText, readMemory, saveMemory } from "../memory.js";

async function location(projectId: string | null = "p1") {
  return { storeRoot: await mkdtemp(path.join(os.tmpdir(), "moxen-memory-")), projectId };
}

const fact = { description: "Tests run with bun", type: "feedback", body: "Use bun test.\n**Why:** the repo pins it." };

describe("Moxen memory", () => {
  it("writes the index itself, one line per memory, and keeps it in step with saves and deletes", async () => {
    const where = await location();
    await saveMemory(where, { ...fact, name: "bun-tests", scope: "project" });
    await saveMemory(where, { ...fact, name: "bun-tests", description: "Tests  run\nwith bun test", scope: "project" });
    await saveMemory(where, { ...fact, name: "terse-replies", type: "user", description: "Likes short answers", scope: "global" });
    const projectIndex = await readFile(path.join(where.storeRoot, "memory", "projects", "p1", "MEMORY.md"), "utf8");
    // Saving under the same name replaces it; a description is one line, whatever was sent.
    expect(projectIndex).toBe("- [bun-tests](bun-tests.md) — Tests run with bun test\n");
    expect(await memoryIndexText(where)).toBe(
      "Global memory (about the user, for every project):\n- [terse-replies](terse-replies.md) — Likes short answers\n\n" +
        "Project memory (this codebase and its work):\n- [bun-tests](bun-tests.md) — Tests run with bun test",
    );
    await deleteMemory(where, "bun-tests", "project");
    expect(await memoryIndexText(where)).not.toContain("bun-tests");
    await expect(readMemory(where, "bun-tests")).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    expect((await readMemory(where, "terse-replies")).scope).toBe("global");
  });

  it.each([
    ["a name that is not a slug", { name: "../escape", scope: "project" }, "INVALID_MEMORY"],
    ["a project memory on a thread without a project", { name: "x", scope: "project", projectId: null }, "MEMORY_PROJECT_REQUIRED"],
    ["an empty body", { name: "x", scope: "global", body: "" }, "INVALID_MEMORY"],
  ])("refuses %s", async (_label, input, code) => {
    const where = await location("projectId" in input ? (input.projectId as null) : "p1");
    await expect(saveMemory(where, { ...fact, ...input })).rejects.toMatchObject({ code });
  });

  it("caps the index a session reads, saying what was left out", async () => {
    const where = await location();
    await Promise.all(
      Array.from({ length: MAX_INDEX_LINES + 2 }, (_, index) => index).map(async (index) => {
        const dir = path.join(where.storeRoot, "memory", "global");
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `m-${String(index).padStart(3, "0")}.md`), `---\nname: m-${index}\ndescription: Memory ${index}\ntype: user\n---\n\nBody.\n`);
      }),
    );
    const text = (await memoryIndexText(where))!;
    expect(text.split("\n").filter((line) => line.startsWith("- [")).length).toBe(MAX_INDEX_LINES);
    expect(text).toContain("(2 more not listed: call memory_read with no name for the whole index.)");
  });

  it("imports Claude Code's memories as it writes them, user ones to the global scope, keeping what Moxen already has", async () => {
    const where = await location();
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "claude-home-"));
    const workspace = path.resolve("/Users/someone/code/app");
    const from = claudeMemoryDir(claudeHome, workspace);
    // Claude Code names the folder after the workspace path with every non-alphanumeric as "-";
    // on Windows the resolved path carries a drive ("C:\Users\…" → "C--Users-…").
    expect(from).toBe(path.join(claudeHome, "projects", workspace.replace(/[^A-Za-z0-9]/gu, "-"), "memory"));
    await mkdir(from, { recursive: true });
    await writeFile(path.join(from, "MEMORY.md"), "- [Role](user_role.md) — senior engineer\n");
    await writeFile(path.join(from, "user_role.md"), "---\nname: user-role\ndescription: Senior engineer\nmetadata:\n  type: user\n---\n\nSenior engineer.\n");
    await writeFile(path.join(from, "project_queue.md"), "---\nname: queue-work\ndescription: Queue feature requests\nmetadata:\n  type: project\n---\n\nQueue notes.\n");
    await saveMemory(where, { ...fact, name: "queue-work", scope: "project", body: "Moxen's own." });
    const result = await importClaudeMemories(where, from);
    expect(result).toMatchObject({ imported: ["user-role"], skipped: ["queue-work"] });
    expect(await readMemory(where, "user-role")).toMatchObject({ scope: "global", type: "user", body: "Senior engineer." });
    expect((await readMemory(where, "queue-work")).body).toBe("Moxen's own.");
  });
});

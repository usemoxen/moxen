import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../../core/projects/projects.js";
import { testHarness } from "../../../core/testing/harness.js";
import { deleteMemory, editMemory, readMemory, saveMemory, searchMemory } from "../memory.js";

function storeRoot(): string {
  return process.env.MOXEN_STORE_ROOT!;
}

async function seededCwd() {
  const harness = await testHarness();
  const workspaceRoot = await realpath(harness.work);
  await ensureStoredProject(storeRoot(), {
    id: "project-existing",
    title: "Existing project",
    workspaceRoot,
    defaultModelSelection: { instanceId: "opencode", model: "gpt-5.6-sol" },
  });
  return { harness, cwd: harness.work };
}

describe("memory save and read", () => {
  it("round-trips a project memory through save and read", async () => {
    const { harness, cwd } = await seededCwd();
    const saved = await saveMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      description: "How deploys go out",
      memoryType: "project",
      body: "Ship on Fridays.",
    });
    expect(saved).toMatchObject({ name: "deploy-notes", scope: "project", replaced: false, total: 1 });
    const read = await readMemory(harness.config, "deploy-notes", { cwd });
    expect(read).toMatchObject({ name: "deploy-notes", scope: "project", description: "How deploys go out", type: "project", body: "Ship on Fridays." });
  });

  it("reads a global memory without a scope", async () => {
    const { harness, cwd } = await seededCwd();
    await saveMemory(harness.config, "editor-font", {
      cwd,
      scope: "global",
      description: "Preferred font",
      memoryType: "user",
      body: "JetBrains Mono.",
    });
    const read = await readMemory(harness.config, "editor-font", { cwd });
    expect(read.scope).toBe("global");
  });

  it("rejects an unknown scope with exit 2", async () => {
    const { harness, cwd } = await seededCwd();
    await expect(readMemory(harness.config, "whatever", { cwd, scope: "team" })).rejects.toMatchObject({
      code: "INVALID_MEMORY",
      exitCode: 2,
    });
  });
});

describe("memory edit", () => {
  it("replaces one piece of the body and the description", async () => {
    const { harness, cwd } = await seededCwd();
    await saveMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      description: "How deploys go out",
      memoryType: "project",
      body: "Ship on Fridays. Never on Mondays.",
    });
    const edited = await editMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      oldText: "Fridays",
      newText: "Thursdays",
      description: "Updated deploy days",
    });
    expect(edited).toMatchObject({ name: "deploy-notes", scope: "project" });
    const read = await readMemory(harness.config, "deploy-notes", { cwd, scope: "project" });
    expect(read.body).toBe("Ship on Thursdays. Never on Mondays.");
    expect(read.description).toBe("Updated deploy days");
  });

  it("refuses an old string that is not in the memory", async () => {
    const { harness, cwd } = await seededCwd();
    await saveMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      description: "How deploys go out",
      memoryType: "project",
      body: "Ship on Fridays.",
    });
    await expect(
      editMemory(harness.config, "deploy-notes", { cwd, scope: "project", oldText: "Saturdays", newText: "Sundays" }),
    ).rejects.toMatchObject({ code: "MEMORY_EDIT_NOT_FOUND" });
  });
});

describe("memory delete", () => {
  it("deletes without asking when confirmed (--yes)", async () => {
    const { harness, cwd } = await seededCwd();
    await saveMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      description: "How deploys go out",
      memoryType: "project",
      body: "Ship on Fridays.",
    });
    const deleted = await deleteMemory(harness.config, "deploy-notes", { cwd, scope: "project" });
    expect(deleted).toMatchObject({ name: "deploy-notes", scope: "project", total: 0 });
    await expect(readMemory(harness.config, "deploy-notes", { cwd, scope: "project" })).rejects.toMatchObject({
      code: "MEMORY_NOT_FOUND",
    });
  });

  it("keeps the memory when the confirmation is declined", async () => {
    const { harness, cwd } = await seededCwd();
    await saveMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      description: "How deploys go out",
      memoryType: "project",
      body: "Ship on Fridays.",
    });
    await expect(
      deleteMemory(harness.config, "deploy-notes", { cwd, scope: "project", confirm: async () => false }),
    ).rejects.toMatchObject({ code: "MEMORY_DELETE_DECLINED", exitCode: 4 });
    const kept = await readMemory(harness.config, "deploy-notes", { cwd, scope: "project" });
    expect(kept.body).toBe("Ship on Fridays.");
  });
});

describe("memory search", () => {
  it("finds memories by keyword with excerpts", async () => {
    const { harness, cwd } = await seededCwd();
    await saveMemory(harness.config, "deploy-notes", {
      cwd,
      scope: "project",
      description: "How deploys go out",
      memoryType: "project",
      body: "Ship on Fridays after the canary bakes.",
    });
    const found = await searchMemory(harness.config, "canary", { cwd });
    expect(found.total).toBe(1);
    expect(found.memories[0]).toMatchObject({ name: "deploy-notes", scope: "project" });
    expect(found.memories[0]!.excerpt).toContain("canary");
  });

  it("rejects a limit outside 1-50 with exit 2", async () => {
    const { harness, cwd } = await seededCwd();
    await expect(searchMemory(harness.config, "canary", { cwd, limit: 51 })).rejects.toMatchObject({
      code: "INVALID_MEMORY",
      exitCode: 2,
    });
  });
});

describe("memory writes while memory is off", () => {
  it("refuses saves, edits and deletes early, and still reads", async () => {
    const { harness, cwd } = await seededCwd();
    // In-process the server runs on this config, so this is the config it refuses by.
    const off = { ...harness.config, memory: false as const };
    await expect(
      saveMemory(off, "deploy-notes", { cwd, scope: "project", description: "How deploys go out", memoryType: "project", body: "Ship on Fridays." }),
    ).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await expect(
      editMemory(off, "deploy-notes", { cwd, scope: "project", oldText: "Fridays", newText: "Thursdays" }),
    ).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await expect(deleteMemory(off, "deploy-notes", { cwd, scope: "project" })).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    // Nothing was written, and reads stay allowed either way.
    await expect(readMemory(off, "deploy-notes", { cwd, scope: "project" })).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    const found = await searchMemory(off, "deploys", { cwd });
    expect(found.total).toBe(0);
  });
});

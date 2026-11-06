import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { tempDir } from "../../core/testing/tmp.js";
import { ensureStoredProject } from "../../core/projects/projects.js";
import { DirectConnection } from "../connection.js";

const save = { type: "memory.save" as const, name: "notes", description: "Notes", memoryType: "project" as const, body: "Body.", scope: "project" as const };

it("refuses every memory write while memory is off, and still reads", async () => {
  const storeRoot = tempDir("moxen-memory-off-");
  const off = new DirectConnection({ storeRoot, config: async () => ({ ...DEFAULT_CONFIG, memory: false }) });
  const on = new DirectConnection({ storeRoot, config: async () => ({ ...DEFAULT_CONFIG }) });
  try {
    await expect(off.dispatch({ ...save })).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await expect(off.dispatch({ type: "memory.edit", name: "notes", scope: "project", oldText: "Body.", newText: "Other." })).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await expect(off.dispatch({ type: "memory.append", name: "notes", scope: "project", text: "More." })).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await expect(off.dispatch({ type: "memory.delete", name: "notes", scope: "project" })).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    // Reads stay allowed either way: nothing was written, so there is nothing to find.
    await expect(off.query({ type: "memory.read", name: "notes", scope: "global" })).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    await on.dispatch({ ...save, scope: "global" });
    expect((await off.query({ type: "memory.read", name: "notes", scope: "global" })).body).toBe("Body.");
  } finally {
    await off.close();
    await on.close();
  }
});

it("refuses project-scope writes for a project that opted out, and allows global ones", async () => {
  const storeRoot = tempDir("moxen-memory-project-off-");
  const workspaceRoot = tempDir("moxen-memory-project-work-");
  const { project } = await ensureStoredProject(storeRoot, { workspaceRoot });
  await writeFile(path.join(workspaceRoot, "moxen.json"), JSON.stringify({ memory: false }));
  const connection = new DirectConnection({ storeRoot, config: async () => ({ ...DEFAULT_CONFIG }) });
  try {
    await expect(connection.dispatch({ ...save, projectId: project.id })).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await connection.dispatch({ ...save, scope: "global" });
    expect((await connection.query({ type: "memory.read", name: "notes", scope: "global" })).body).toBe("Body.");
  } finally {
    await connection.close();
  }
});

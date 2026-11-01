import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SemanticMemory } from "../semantic.js";
import { deleteMemory, listMemories, memoryDir, saveMemory, searchMemories, type MemoryLocation } from "../memory.js";
import { EMBEDDING_DIMENSIONS } from "../embedding-cache.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function location(): Promise<MemoryLocation> {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), "moxen-semantic-"));
  roots.push(storeRoot);
  return { storeRoot, projectId: "project-one" };
}
const vector = (axis: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === axis ? 1 : 0);
const save = (where: MemoryLocation, name: string, body: string, scope = "project") => saveMemory(where, { name, body, scope, description: name, type: "project" });

describe("semantic memory invariants", () => {
  it("keeps keyword search responsive during indexing and cancels queued indexing without publishing stale work", async () => {
    const where = await location();
    await save(where, "paths", "directory separators");
    let started: () => void = () => {};
    const encoding = new Promise<void>((resolve) => { started = resolve; });
    const service = new SemanticMemory({
      encode: async (_texts, signal) => {
        started();
        return await new Promise<readonly (readonly number[])[]>((_, reject) => { signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
      }, close() {},
    });
    const indexing = service.backfill(where);
    const rejected = expect(indexing).rejects.toThrow("cancelled");
    await encoding;
    const result = await searchMemories(where, { query: "paths" }, (memories) => service.scores(where, "paths", memories));
    expect(result.semantic?.state).toBe("unavailable");
    expect(result.memories[0]?.name).toBe("paths");
    service.cancel();
    await rejected;
  });

  it("bounds repair work during a search while retaining compatible vectors across queries", async () => {
    const where = await location();
    for (let index = 0; index < 10; index++) await save(where, `record-${index}`, "A document");
    let calls = 0;
    const service = new SemanticMemory({ encode: async (texts) => { calls++; return texts.map(() => vector(0)); }, close() {} });
    const memories = await listMemories(where);
    expect((await service.scores(where, "question", memories)).size).toBe(8);
    expect(calls).toBe(9);
    expect((await service.scores(where, "question", memories)).size).toBe(10);
    expect(calls).toBe(12);
  });

  it("repairs corrupt cache, rejects edited vectors and prunes deleted entries without touching other projects", async () => {
    const where = await location();
    const other = { ...where, projectId: "project-two" };
    await save(where, "paths", "directory separators");
    await save(where, "paths", "global guidance", "global");
    await save(other, "private", "other project only");
    let calls = 0;
    const service = new SemanticMemory({ encode: async (texts) => { calls++; return texts.map(() => vector(0)); }, close() {} });
    expect(await service.backfill(where)).toBe(2);
    expect(calls).toBe(2);
    expect(await service.backfill(where)).toBe(2);
    expect(calls).toBe(2);
    await save(where, "paths", "edited content");
    await service.backfill(where);
    expect(calls).toBe(3);
    const dir = path.join(memoryDir(where.storeRoot, "project", where.projectId), ".embeddings");
    await writeFile(path.join(dir, "paths.json"), "{corrupt");
    await service.backfill(where);
    expect(calls).toBe(4);
    await deleteMemory(where, "paths", "project");
    await service.backfill(where);
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(memoryDir(other.storeRoot, "project", other.projectId))).toEqual(["MEMORY.md", "private.md"]);
  });

  it("does not publish an encoding when a memory changes or disappears during inference", async () => {
    const where = await location();
    await save(where, "race", "old fact");
    const service = new SemanticMemory({ encode: async () => { await deleteMemory(where, "race", "project"); return [vector(0)]; }, close() {} });
    expect(await service.backfill(where)).toBe(0);
    expect(await listMemories(where)).toEqual([]);
  });

  it("fuses paraphrases while preserving exact slugs, scope, excerpts and keyword fallback", async () => {
    const where = await location();
    await save(where, "paths", "Use node:path for directory separators.");
    await save(where, "language", "Spanish from Spain.");
    await save(where, "paths", "Global unrelated text", "global");
    const encode = async (texts: readonly string[]) => texts.map((text) => vector(text.includes("directory") || text.includes("carpetas") ? 0 : 1));
    const service = new SemanticMemory({ encode, close() {} });
    const input = { query: "carpetas", scope: "project" as const, limit: 1 };
    const result = await searchMemories(where, input, (memories) => service.scores(where, input.query, memories));
    expect(result.memories[0]?.name).toBe("paths");
    expect(result.memories[0]?.scope).toBe("project");
    expect(result.memories[0]?.excerpt).toContain("node:path");
    expect(result.semantic?.state).toBe("ready");
    const exact = await searchMemories(where, { query: "language" }, async () => new Map([["project:paths", 1], ["project:language", 0]]));
    expect(exact.memories[0]?.name).toBe("language");
    const keyword = await searchMemories(where, { query: "node:path" });
    const fallback = await searchMemories(where, { query: "node:path" }, async () => { throw new Error("backend died"); });
    expect(fallback.memories).toEqual(keyword.memories);
    expect(fallback.semantic?.state).toBe("unavailable");
  });
});

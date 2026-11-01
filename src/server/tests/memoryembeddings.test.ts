import { afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../core/config.js";
import { tempDir } from "../../core/testing/tmp.js";
import { EmbeddingRuntime } from "../../core/memory/embedding-runtime.js";
import { saveMemory } from "../../core/memory/memory.js";
import { ensureStoredProject } from "../../core/projects/projects.js";
import { DirectConnection } from "../connection.js";
import { EMBEDDING_VERSION } from "../../core/memory/embedding-cache.js";

const validation = { version: EMBEDDING_VERSION, platform: process.platform, arch: process.arch, device: "cpu", correct: 6, total: 6, queryP95Ms: 20, documentMs: 100, checkedAt: "2026-11-01" };

afterEach(() => vi.restoreAllMocks());
const encode = () => vi.spyOn(EmbeddingRuntime.prototype, "encode").mockImplementation(async (texts) => texts.map(() => [1, ...Array<number>(767).fill(0)]));

it("honors project semantic overrides and memory off, without provisioning during search", async () => {
  const storeRoot = tempDir("moxen-semantic-server-");
  const workspaceRoot = tempDir("moxen-semantic-project-");
  const { project } = await ensureStoredProject(storeRoot, { workspaceRoot });
  const location = { storeRoot, projectId: project.id };
  await saveMemory(location, { name: "paths", description: "paths", body: "node:path", type: "project", scope: "project" });
  const encoder = encode();
  const setup = vi.spyOn(EmbeddingRuntime.prototype, "setup");
  const connection = new DirectConnection({ storeRoot, config: async () => ({ ...DEFAULT_CONFIG, memoryEmbeddings: false }) });
  try {
    const query = { type: "memory.search" as const, query: "paths", projectId: project.id };
    expect((await connection.query(query)).semantic).toBeUndefined();
    expect(encoder).not.toHaveBeenCalled();
    await writeFile(path.join(workspaceRoot, "moxen.json"), JSON.stringify({ memoryEmbeddings: true }));
    expect((await connection.query(query)).semantic?.state).toBe("ready");
    const calls = encoder.mock.calls.length;
    await writeFile(path.join(workspaceRoot, "moxen.json"), JSON.stringify({ memory: false, memoryEmbeddings: true }));
    expect((await connection.query(query)).semantic).toBeUndefined();
    expect(encoder).toHaveBeenCalledTimes(calls);
    await expect(connection.dispatch({ type: "memory.embeddings.setup", projectId: project.id })).rejects.toThrow("turned off");
    expect(setup).not.toHaveBeenCalled();
  } finally { await connection.close(); }
});

it("shares setup while backfilling each caller's scope, and refreshes sidecars after writes and deletes", async () => {
  const storeRoot = tempDir("moxen-semantic-refresh-");
  const encoder = encode();
  const setup = vi.spyOn(EmbeddingRuntime.prototype, "setup").mockImplementation(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  vi.spyOn(EmbeddingRuntime.prototype, "validate").mockResolvedValue(validation);
  const projectId = "first";
  for (const id of [projectId, "second"]) await saveMemory({ storeRoot, projectId: id }, { name: "paths", description: "paths", body: "original", type: "project", scope: "project" });
  let enabled = false;
  const connection = new DirectConnection({ storeRoot, config: async () => ({ ...DEFAULT_CONFIG, memoryEmbeddings: enabled }) });
  try {
    expect(await Promise.all([projectId, "second"].map((id) => connection.dispatch({ type: "memory.embeddings.setup", projectId: id })))).toEqual([{ indexed: 1 }, { indexed: 1 }]);
    expect(setup).toHaveBeenCalledTimes(1);
    enabled = true;
    const file = path.join(storeRoot, "memory", "projects", projectId, ".embeddings", "paths.json");
    const old = await readFile(file, "utf8");
    await connection.dispatch({ type: "memory.append", projectId, name: "paths", scope: "project", text: "new fact" });
    await vi.waitFor(async () => { expect(await readFile(file, "utf8")).not.toBe(old); });
    expect(encoder.mock.calls.some(([texts]) => texts.some((text) => text.includes("new fact")))).toBe(true);
    await connection.dispatch({ type: "memory.delete", projectId, name: "paths", scope: "project" });
    await vi.waitFor(async () => { await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" }); });
  } finally { await connection.close(); }
});

it("activates only after validation and backfill, preserves concurrent config edits, and keeps failed setup disabled", async () => {
  const storeRoot = tempDir("moxen-memory-enable-");
  const configPath = path.join(storeRoot, "config.json");
  await writeFile(configPath, JSON.stringify({ memoryEmbeddings: false, model: "before" }));
  let release: () => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(EmbeddingRuntime.prototype, "setup").mockImplementation(async () => { started(); await gate; });
  const validate = vi.spyOn(EmbeddingRuntime.prototype, "validate").mockResolvedValue(validation);
  const connection = new DirectConnection({ storeRoot, configPath });
  try {
    const enabling = connection.dispatch({ type: "settings.set", key: "memoryEmbeddings", value: "true" });
    await entered;
    expect(JSON.parse(await readFile(configPath, "utf8")).memoryEmbeddings).toBe(false);
    await connection.dispatch({ type: "settings.set", key: "model", value: "changed-while-downloading" });
    release();
    await enabling;
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ memoryEmbeddings: true, model: "changed-while-downloading" });
    validate.mockRejectedValueOnce(new Error("readiness failed"));
    await expect(connection.dispatch({ type: "settings.set", key: "memoryEmbeddings", value: "true" })).rejects.toThrow("readiness failed");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ memoryEmbeddings: false, model: "changed-while-downloading" });
  } finally { await connection.close(); }
});

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameReplacing } from "../infra/atomic.js";
import { cachedVector, embeddingKey, validEmbedding } from "./embedding-cache.js";
import { type EmbeddingEncoder } from "./embedding-runtime.js";
import { listMemories, memoryDir, readMemory, type Memory, type MemoryLocation } from "./memory.js";

export function embeddingDocument(memory: Memory): string {
  return `title: ${memory.name} | text: ${memory.description}\n${memory.body}`;
}

/** Rebuildable per-scope sidecars; only fresh authoritative files reach ranking. */
export class SemanticMemory {
  private tail: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private queued = 0;
  constructor(private readonly encoder: EmbeddingEncoder) {}

  cancel(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  private cacheDir(location: MemoryLocation, memory: Memory): string {
    return path.join(memoryDir(location.storeRoot, memory.scope, location.projectId), ".embeddings");
  }

  private serial<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.queued >= 32) return Promise.reject(new Error("Memory embedding queue is full"));
    this.queued++;
    const signal = this.controller.signal;
    const result = this.tail.then(() => { signal.throwIfAborted(); return operation(signal); }).finally(() => { this.queued--; });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async synchronize(location: MemoryLocation, memories: readonly Memory[], signal: AbortSignal, maxRepairs = Infinity): Promise<Map<string, readonly number[]>> {
    const vectors = new Map<string, readonly number[]>();
    let repairs = 0;
    for (const scope of location.projectId ? ["global", "project"] as const : ["global"] as const) {
      const dir = path.join(memoryDir(location.storeRoot, scope, location.projectId), ".embeddings");
      const live = new Set(memories.filter((memory) => memory.scope === scope).map((memory) => `${memory.name}.json`));
      for (const file of await readdir(dir).catch((): string[] => [])) {
        if (file.endsWith(".json") && !live.has(file)) await rm(path.join(dir, file), { force: true });
      }
    }
    for (const memory of memories) {
      signal.throwIfAborted();
      const document = embeddingDocument(memory);
      const dir = this.cacheDir(location, memory);
      const file = path.join(dir, `${memory.name}.json`);
      const record: unknown = await readFile(file, "utf8").then((text) => JSON.parse(text) as unknown).catch(() => null);
      let vector = cachedVector(record, document);
      if (!vector) {
        if (repairs >= maxRepairs) continue;
        repairs++;
        vector = (await this.encoder.encode([document], signal))[0] ?? null;
        signal.throwIfAborted();
        if (!validEmbedding(vector)) throw new Error("Invalid memory embedding");
        // A save/delete may have raced native encoding. Never publish its old
        // result, even if the caller supplied a previously current snapshot.
        const current = await readMemory(location, memory.name, memory.scope).catch(() => null);
        if (!current || embeddingDocument(current) !== document) continue;
        await mkdir(dir, { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify({ key: embeddingKey(document), vector }));
          await renameReplacing(tmp, file);
        } finally { await rm(tmp, { force: true }); }
      }
      vectors.set(`${memory.scope}:${memory.name}`, vector);
    }
    return vectors;
  }

  backfill(location: MemoryLocation): Promise<number> {
    return this.serial(async (signal) => (await this.synchronize(location, await listMemories(location), signal)).size);
  }

  scores(location: MemoryLocation, query: string, memories: readonly Memory[]): Promise<ReadonlyMap<string, number>> {
    // Indexing must not make interactive callers wait behind a whole library.
    // Keyword ranking remains complete while a rebuild owns the encoder.
    if (this.queued > 0) return Promise.reject(new Error("Memory indexing is busy"));
    return this.serial(async (signal) => {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      // Always sync the complete visible scope, even for a filtered search:
      // pruning a project search must not remove the global cache.
      const vectors = await this.synchronize(location, await listMemories(location), requestSignal, 8);
      if (!memories.length) return new Map();
      const queryVector = (await this.encoder.encode([`task: search result | query: ${query}`], requestSignal))[0];
      if (!validEmbedding(queryVector)) throw new Error("Invalid query embedding");
      const current = new Map((await listMemories(location)).map((memory) => [`${memory.scope}:${memory.name}`, embeddingDocument(memory)]));
      return new Map(memories.flatMap((memory) => {
        const key = `${memory.scope}:${memory.name}`;
        const vector = vectors.get(key);
        if (!vector || current.get(key) !== embeddingDocument(memory)) return [];
        const score = vector.reduce((sum, value, index) => sum + value * queryVector[index]!, 0);
        return [[key, score] as const];
      }));
    });
  }
}

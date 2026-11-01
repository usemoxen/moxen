import { createHash } from "node:crypto";

/** Bump this when model, dimensions, precision or document formatting changes. */
export const EMBEDDING_VERSION = "embeddinggemma-2:daa72c51243991dfcaf9f9137d2c573d8f7790c0:q4:768:transformers-4.3.2:2048:document-v2";
export const EMBEDDING_DIMENSIONS = 768;

export interface CachedEmbedding {
  readonly key: string;
  readonly vector: readonly number[];
}

/** Memory files remain authoritative; a changed document cannot reuse its old vector. */
export function embeddingKey(document: string): string {
  return createHash("sha256").update(EMBEDDING_VERSION).update("\0").update(document).digest("hex");
}

export function validEmbedding(vector: unknown): vector is number[] {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) return false;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Math.abs(norm - 1) <= 0.01;
}

/** Reject incompatible, malformed and stale records before using them in search. */
export function cachedVector(record: unknown, document: string): readonly number[] | null {
  if (!record || typeof record !== "object") return null;
  const entry = record as Partial<CachedEmbedding>;
  return entry.key === embeddingKey(document) && validEmbedding(entry.vector) ? entry.vector : null;
}
